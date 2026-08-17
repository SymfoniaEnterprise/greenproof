/**
 * ScmPort na REST API GitHuba - commity przez git data API
 * (blob → tree → commit → ref), bez lokalnego checkoutu.
 */
import { execFile } from 'node:child_process';
import type { FileChange, Logger, ScmPort } from '@greenproof/core';
import type { GithubApi, RepoRef } from './internal.js';
import {
  createCommitWithFiles,
  getBranchHead,
  globToRegExp,
  isAlreadyExistsError,
  isNotFound,
  isRefRaceError,
  getFileBuffer,
  listBlobPaths,
  messageOf,
} from './internal.js';

/** Wyścig na refie: ktoś zmienił brancha między odczytem heada a zapisem. */
export class ScmConflictError extends Error {
  constructor(
    readonly branch: string,
    readonly expectedSha: string,
    readonly cause?: unknown,
  ) {
    super(
      `Branch ${branch} was modified concurrently (expected head ${expectedSha})` +
        (cause === undefined ? '' : `: ${messageOf(cause)}`),
    );
    this.name = 'ScmConflictError';
  }
}

export interface GithubScmOptions {
  octokit: GithubApi;
  owner: string;
  repo: string;
  logger: Logger;
  /**
   * Lokalny checkout repo (opcjonalny, tylko w CI). Jeśli podany, push() robi
   * realne git push; bez niego push jest no-opem - commity poszły przez API.
   */
  repoDir?: string | undefined;
}

export class GithubScm implements ScmPort {
  private readonly api: GithubApi;
  private readonly repoRef: RepoRef;
  private readonly logger: Logger;
  private readonly repoDir: string | undefined;

  constructor(options: GithubScmOptions) {
    this.api = options.octokit;
    this.repoRef = { owner: options.owner, repo: options.repo };
    this.logger = options.logger;
    this.repoDir = options.repoDir;
  }

  async ensureBranch(name: string, fromRef: string): Promise<void> {
    const existing = await getBranchHead(this.api, this.repoRef, name);
    if (existing !== null) return;

    const sha = await this.resolveToSha(fromRef);
    try {
      await this.api.git.createRef({ ...this.repoRef, ref: `refs/heads/${name}`, sha });
    } catch (err) {
      // Wyścig dwóch runnerów: branch mógł powstać - to sukces.
      if (isAlreadyExistsError(err)) {
        this.logger.debug('greenproof/github: branch already created concurrently', { name });
        return;
      }
      throw err;
    }
  }

  async commitFiles(
    branch: string,
    files: FileChange[],
    message: string,
  ): Promise<{ sha: string }> {
    const headSha = await getBranchHead(this.api, this.repoRef, branch);
    if (headSha === null) {
      throw new Error(`Branch ${branch} does not exist in ${this.slug()}`);
    }
    const head = await this.api.git.getCommit({ ...this.repoRef, commit_sha: headSha });
    const baseTreeSha = head.data.tree.sha;

    const { commitSha, treeSha } = await createCommitWithFiles(this.api, this.repoRef, {
      parentSha: headSha,
      baseTreeSha,
      files: files.map((f) => ({ path: f.path, content: f.content })),
      message,
    });

    // Brak zmiany treści = brak pustego commita (idempotentne).
    if (treeSha === baseTreeSha) {
      this.logger.debug('greenproof/github: nothing to commit, tree unchanged', { branch });
      return { sha: headSha };
    }

    await this.beforeUpdateRef(branch);

    try {
      // force:false = CAS po stronie GitHuba (fast-forward z naszego parenta).
      await this.api.git.updateRef({
        ...this.repoRef,
        ref: `heads/${branch}`,
        sha: commitSha,
        force: false,
      });
    } catch (err) {
      if (isRefRaceError(err)) throw new ScmConflictError(branch, headSha, err);
      throw err;
    }
    return { sha: commitSha };
  }

  async readFile(ref: string, path: string): Promise<string | null> {
    const buf = await getFileBuffer(this.api, this.repoRef, ref, path);
    return buf === null ? null : buf.toString('utf8');
  }

  async listFiles(ref: string, glob: string): Promise<string[]> {
    const commitSha = await this.resolveToSha(ref);
    const { paths, truncated } = await listBlobPaths(this.api, this.repoRef, commitSha);
    if (truncated) {
      this.logger.warn('greenproof/github: git tree truncated, listing may be incomplete', {
        ref,
      });
    }
    if (glob.length === 0) return paths.slice().sort();
    const re = globToRegExp(glob);
    return paths.filter((p) => re.test(p)).sort();
  }

  async openPullRequest(p: {
    from: string;
    to: string;
    title: string;
    body: string;
  }): Promise<{ url: string; id: string }> {
    try {
      const created = await this.api.pulls.create({
        ...this.repoRef,
        head: p.from,
        base: p.to,
        title: p.title,
        body: p.body,
      });
      return { url: created.data.html_url, id: String(created.data.number) };
    } catch (err) {
      if (!isPullRequestExistsError(err)) throw err;
      // PR z tego brancha już wisi - zwracamy istniejący.
      const existing = await this.api.pulls.list({
        ...this.repoRef,
        head: `${this.repoRef.owner}:${p.from}`,
        base: p.to,
        state: 'open',
      });
      const pr = existing.data[0];
      if (pr === undefined) {
        throw new Error(
          `GitHub reports an existing pull request for ${p.from}, but none was found: ${messageOf(err)}`,
        );
      }
      this.logger.debug('greenproof/github: reusing existing pull request', {
        number: pr.number,
      });
      return { url: pr.html_url, id: String(pr.number) };
    }
  }

  /** Push zwykle zbędny (commity idą przez API); wyjątek: lokalny checkout z commitami. */
  async push(branch: string): Promise<void> {
    if (this.repoDir === undefined) {
      this.logger.debug('greenproof/github: push is a no-op (commits went through the API)', {
        branch,
      });
      return;
    }
    const repoDir = this.repoDir;
    await new Promise<void>((resolve, reject) => {
      execFile(
        'git',
        ['push', 'origin', branch],
        // LC_ALL=C: komunikaty gita w jednym języku.
        { cwd: repoDir, env: { ...process.env, LC_ALL: 'C', LANG: 'C' } },
        (error, _stdout, stderr) => {
          if (error === null) {
            resolve();
            return;
          }
          reject(new Error(`git push origin ${branch} failed: ${String(stderr).trim()}`));
        },
      );
    });
  }

  /**
   * Seam testowy: wywoływane po zbudowaniu commita, a przed CAS na ref.
   * Nadpisz w teście, żeby zasymulować równoległy zapis do brancha.
   */
  protected async beforeUpdateRef(_branch: string): Promise<void> {
    return;
  }

  /** Ref → sha commita: branch, potem tag, na końcu goły sha. */
  private async resolveToSha(ref: string): Promise<string> {
    const head = await getBranchHead(this.api, this.repoRef, ref);
    if (head !== null) return head;
    try {
      const tag = await this.api.git.getRef({ ...this.repoRef, ref: `tags/${ref}` });
      return tag.data.object.sha;
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
    try {
      const commit = await this.api.git.getCommit({ ...this.repoRef, commit_sha: ref });
      return commit.data.sha;
    } catch (err) {
      if (isNotFound(err)) {
        throw new Error(`Unknown ref in ${this.slug()}: ${ref}`);
      }
      throw err;
    }
  }

  private slug(): string {
    return `${this.repoRef.owner}/${this.repoRef.repo}`;
  }
}

function isPullRequestExistsError(err: unknown): boolean {
  return /pull request already exists/i.test(messageOf(err));
}
