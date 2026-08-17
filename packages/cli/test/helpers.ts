/** Wspólne narzędzia testowe: tmp dir + prawdziwe repo git (tylko w tmp!). */
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const created: string[] = [];

export async function tmpDir(prefix = 'gp-cli-'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}

export async function cleanupTmp(): Promise<void> {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
}

export async function git(dir: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd: dir });
  return stdout.trim();
}

export async function writeFileIn(dir: string, rel: string, content: string): Promise<string> {
  const file = join(dir, rel);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content, 'utf8');
  return file;
}

/**
 * Świeże repo testów z jednym commitem na main. `specs` to ścieżki plików
 * (względne), które mają udawać już zaakceptowane spece.
 */
export async function initRepo(specs: string[] = []): Promise<string> {
  const dir = await tmpDir('gp-cli-repo-');
  await git(dir, 'init', '-q', '-b', 'main');
  await git(dir, 'config', 'user.email', 'test@example.com');
  await git(dir, 'config', 'user.name', 'Greenproof Test');
  await git(dir, 'config', 'commit.gpgsign', 'false');
  await writeFileIn(dir, 'README.md', '# test\n');
  for (const spec of specs) await writeFileIn(dir, spec, "// spec\n");
  await git(dir, 'add', '.');
  await git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

/** Minimalny, poprawny config greenproof jako obiekt do zapisu na dysk. */
export function configObject(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    platform: '@greenproof/adapter-fs',
    plan: { source: 'json' },
    model: { authTokenEnv: 'GREENPROOF_TOKEN', author: 'claude-test' },
    paths: { testsRepoDir: '.' },
    ...overrides,
  };
}
