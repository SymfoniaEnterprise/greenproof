/**
 * ScmPort na LOKALNYM repo git. Wszystko przez plumbing i tymczasowy indeks
 * (GIT_INDEX_FILE) - checkout ani worktree użytkownika nie są dotykane.
 */
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Clock, FileChange, ScmPort } from '@greenproof/core';
import { assertSafeKey, hasErrnoCode } from './internal.js';

export interface FsScmOptions {
  /** Katalog repo; cwd wszystkich komend gita. */
  repoDir: string;
  /** Katalog na pull requesty (JSON). */
  prDir: string;
  clock?: Clock | undefined;
}

interface GitResult {
  code: number;
  stdout: Buffer;
  stderr: string;
}

interface GitOptions {
  /** Dane na stdin (np. dla `hash-object --stdin`). */
  input?: string | undefined;
  /** Dodatkowe zmienne środowiskowe (np. GIT_INDEX_FILE). */
  env?: Record<string, string> | undefined;
}

const DEFAULT_FILE_MODE = '100644';

export class FsScm implements ScmPort {
  private readonly repoDir: string;
  private readonly prDir: string;
  private readonly clock: Clock;
  /** Tożsamość commitera, gdy repo/global config jej nie ma. */
  private identityEnv: Record<string, string> | null = null;

  constructor(options: FsScmOptions) {
    this.repoDir = options.repoDir;
    this.prDir = options.prDir;
    this.clock = options.clock ?? { now: () => new Date() };
  }

  async ensureBranch(name: string, fromRef: string): Promise<void> {
    const exists = await this.git(['show-ref', '--verify', '--quiet', `refs/heads/${name}`]);
    if (exists.code === 0) return;
    const created = await this.git(['branch', name, fromRef]);
    if (created.code !== 0) {
      // Wyścig dwóch runnerów: branch mógł powstać w międzyczasie - to sukces.
      if (/already exists/i.test(created.stderr)) return;
      throw new Error(`git branch ${name} ${fromRef} failed: ${created.stderr.trim()}`);
    }
  }

  async deleteBranch(name: string): Promise<void> {
    // Git nie usunie aktualnego brancha - odczepiamy HEAD; praca zostaje w commitach.
    const head = await this.git(['symbolic-ref', '--quiet', '--short', 'HEAD']);
    if (head.code === 0 && head.stdout.toString('utf8').trim() === name) {
      await this.gitOk(['checkout', '--detach']);
    }
    const deleted = await this.git(['branch', '-D', name]);
    if (deleted.code !== 0) {
      // Brak brancha = no-op (clean może być ponawiany).
      if (/not found/i.test(deleted.stderr)) return;
      throw new Error(`git branch -D ${name} failed: ${deleted.stderr.trim()}`);
    }
  }

  async listBranches(prefix: string): Promise<string[]> {
    const out = await this.gitText([
      'for-each-ref',
      '--format=%(refname:short)',
      `refs/heads/${prefix}`,
    ]);
    return out.length === 0 ? [] : out.split('\n');
  }

  async commitFiles(
    branch: string,
    files: FileChange[],
    message: string,
  ): Promise<{ sha: string }> {
    const oldSha = await this.resolveBranchSha(branch);
    const indexDir = await mkdtemp(join(tmpdir(), 'greenproof-index-'));
    const env = { GIT_INDEX_FILE: join(indexDir, 'index') };
    let newTree: string;
    let oldTree: string;
    try {
      oldTree = await this.gitText(['rev-parse', `${oldSha}^{tree}`]);
      await this.gitOk(['read-tree', oldTree], { env });
      for (const change of files) {
        const path = assertSafeKey(change.path, 'file path');
        if (change.content === null) {
          await this.gitOk(['update-index', '--force-remove', '--', path], { env });
          continue;
        }
        // -w zapisuje blob do obiektowej bazy; indeks dostaje tylko sha.
        const blob = await this.gitText(['hash-object', '-w', '--stdin'], {
          input: change.content,
        });
        const mode = await this.existingMode(path, env);
        await this.gitOk(['update-index', '--add', '--cacheinfo', `${mode},${blob},${path}`], {
          env,
        });
      }
      newTree = await this.gitText(['write-tree'], { env });
    } finally {
      await rm(indexDir, { recursive: true, force: true });
    }

    // Brak zmiany treści = brak pustego commita (idempotentne).
    if (newTree === oldTree) return { sha: oldSha };

    const newSha = await this.gitText(
      ['commit-tree', newTree, '-p', oldSha, '-m', message],
      { env: await this.commitIdentityEnv() },
    );

    await this.beforeUpdateRef(branch);

    // CAS: ref musi wciąż wskazywać na sha odczytane na wejściu.
    const updated = await this.git([
      'update-ref',
      `refs/heads/${branch}`,
      newSha,
      oldSha,
    ]);
    if (updated.code !== 0) {
      throw new Error(
        `Branch ${branch} was modified concurrently (expected ${oldSha}): ${updated.stderr.trim()}`,
      );
    }
    return { sha: newSha };
  }

  async readFile(ref: string, path: string): Promise<string | null> {
    await this.assertRefExists(ref);
    const safePath = assertSafeKey(path, 'file path');
    // Brak pliku rozpoznajemy po EXIT CODE - komunikaty gita bywają zlokalizowane.
    const oid = await this.git(['rev-parse', '--verify', '--quiet', `${ref}:${safePath}`]);
    if (oid.code !== 0) return null;
    const blob = await this.git(['cat-file', 'blob', oid.stdout.toString('utf8').trim()]);
    if (blob.code !== 0) return null; // ścieżka to katalog, nie plik
    return blob.stdout.toString('utf8');
  }

  async listFiles(ref: string, glob: string): Promise<string[]> {
    await this.assertRefExists(ref);
    const out = await this.gitOk(['ls-tree', '-r', '--name-only', '-z', ref]);
    const paths = out.stdout.toString('utf8').split('\0').filter((p) => p.length > 0);
    if (glob.length === 0) return paths.sort();
    const re = globToRegExp(glob);
    return paths.filter((p) => re.test(p)).sort();
  }

  async openPullRequest(p: {
    from: string;
    to: string;
    title: string;
    body: string;
  }): Promise<{ url: string; id: string }> {
    const payload = {
      from: p.from,
      to: p.to,
      title: p.title,
      body: p.body,
      createdAt: this.clock.now().toISOString(),
    };
    const data = `${JSON.stringify(payload, null, 2)}\n`;
    await mkdir(this.prDir, { recursive: true });
    // O_EXCL przyznaje kolejny numer PR bez wyścigu.
    let n = (await this.lastPrNumber()) + 1;
    for (;;) {
      const file = join(this.prDir, `${n}.json`);
      try {
        await writeFile(file, data, { flag: 'wx' });
        // pathToFileURL, nie sklejanie: na Windowsie join() daje backslashe,
        // a file://C:\...\1.json nie jest poprawnym URL-em.
        return { url: pathToFileURL(file).href, id: String(n) };
      } catch (err) {
        if (!hasErrnoCode(err, 'EEXIST')) throw err;
        n += 1;
      }
    }
  }

  /** No-op: commit jest już lokalnie "opublikowany". */
  async push(_branch: string): Promise<void> {
    return;
  }

  /**
   * Seam testowy: wywoływane po zbudowaniu commita, a przed CAS na ref.
   * Nadpisz w teście, żeby zasymulować równoległy zapis do brancha.
   */
  protected async beforeUpdateRef(_branch: string): Promise<void> {
    return;
  }

  private async lastPrNumber(): Promise<number> {
    let entries: string[];
    try {
      entries = await readdir(this.prDir);
    } catch (err) {
      if (hasErrnoCode(err, 'ENOENT')) return 0;
      throw err;
    }
    let max = 0;
    for (const entry of entries) {
      const m = /^(\d+)\.json$/.exec(entry);
      if (m?.[1] !== undefined) max = Math.max(max, Number(m[1]));
    }
    return max;
  }

  private async resolveBranchSha(branch: string): Promise<string> {
    const result = await this.git(['rev-parse', '--verify', `refs/heads/${branch}^{commit}`]);
    if (result.code !== 0) {
      throw new Error(`Branch ${branch} does not exist in ${this.repoDir}`);
    }
    return result.stdout.toString('utf8').trim();
  }

  private async assertRefExists(ref: string): Promise<void> {
    const result = await this.git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    if (result.code !== 0) throw new Error(`Unknown ref: ${ref}`);
  }

  /** Zachowuje bit wykonywalności wpisu z indeksu. */
  private async existingMode(path: string, env: Record<string, string>): Promise<string> {
    const result = await this.git(['ls-files', '--stage', '--', path], { env });
    if (result.code !== 0) return DEFAULT_FILE_MODE;
    const mode = result.stdout.toString('utf8').split(/\s/, 1)[0];
    return mode !== undefined && /^\d{6}$/.test(mode) ? mode : DEFAULT_FILE_MODE;
  }

  /** Fallback tożsamości, gdy brak user.name/user.email (typowe w CI). */
  private async commitIdentityEnv(): Promise<Record<string, string>> {
    if (this.identityEnv !== null) return this.identityEnv;
    const email = await this.git(['config', '--get', 'user.email']);
    const name = await this.git(['config', '--get', 'user.name']);
    this.identityEnv =
      email.code === 0 && name.code === 0
        ? {}
        : {
            GIT_AUTHOR_NAME: 'greenproof',
            GIT_AUTHOR_EMAIL: 'greenproof@localhost',
            GIT_COMMITTER_NAME: 'greenproof',
            GIT_COMMITTER_EMAIL: 'greenproof@localhost',
          };
    return this.identityEnv;
  }

  private async gitOk(args: string[], options?: GitOptions): Promise<GitResult> {
    const result = await this.git(args, options);
    if (result.code !== 0) {
      throw new Error(`git ${args.join(' ')} failed: ${result.stderr.trim()}`);
    }
    return result;
  }

  private async gitText(args: string[], options?: GitOptions): Promise<string> {
    const result = await this.gitOk(args, options);
    return result.stdout.toString('utf8').trim();
  }

  private git(args: string[], options?: GitOptions): Promise<GitResult> {
    // LC_ALL=C: komunikaty gita w jednym języku (parsowanie stderr).
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      LC_ALL: 'C',
      LANG: 'C',
      ...(options?.env ?? {}),
    };
    // Odcinamy odziedziczony kontekst gita (np. w hooku).
    for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) {
      if (options?.env?.[key] === undefined) delete env[key];
    }
    return new Promise<GitResult>((resolve, reject) => {
      const child = execFile(
        'git',
        args,
        { cwd: this.repoDir, env, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 },
        (error, stdout, stderr) => {
          if (error !== null && typeof error.code !== 'number') {
            reject(error); // brak binarki git / sygnał - to nie jest exit code komendy
            return;
          }
          resolve({
            code: error === null ? 0 : (error.code as number),
            stdout,
            stderr: stderr.toString('utf8'),
          });
        },
      );
      if (options?.input !== undefined) child.stdin?.end(options.input);
    });
  }
}

/**
 * Minimalny glob → RegExp: '**' (dowolna głębokość), '*' (bez '/'), '?'.
 * Świadomie bez klas znaków i nawiasów - zero zależności.
 */
export function globToRegExp(glob: string): RegExp {
  let out = '';
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i += 1;
        if (glob[i + 1] === '/') {
          i += 1;
          out += '(?:[^/]+/)*'; // '**/' pasuje też do zera katalogów
        } else {
          out += '.*';
        }
      } else {
        out += '[^/]*';
      }
      continue;
    }
    if (c === '?') {
      out += '[^/]';
      continue;
    }
    out += (c ?? '').replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}
