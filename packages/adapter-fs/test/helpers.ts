/** Wspólne narzędzia testowe: tmp dir + prawdziwe repo git (tylko w tmp!). */
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const created: string[] = [];

export async function tmpDir(prefix = 'gp-'): Promise<string> {
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

/** Świeże repo z jednym commitem na branchu main i lokalną tożsamością. */
export async function initRepo(): Promise<string> {
  const dir = await tmpDir('gp-repo-');
  await git(dir, 'init', '-q', '-b', 'main');
  await git(dir, 'config', 'user.email', 'test@example.com');
  await git(dir, 'config', 'user.name', 'Greenproof Test');
  await git(dir, 'config', 'commit.gpgsign', 'false');
  await writeFile(join(dir, 'README.md'), '# test\n');
  await git(dir, 'add', '.');
  await git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}
