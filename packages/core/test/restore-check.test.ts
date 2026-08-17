import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkMutationRestoredByContent } from '../src/steps/author.js';

const DIFF = [
  '--- a/tests/e2e/login.spec.ts',
  '+++ b/tests/e2e/login.spec.ts',
  '-    await expect(page).toHaveURL(/\\/employees/);',
  '+    await expect(page).toHaveURL(/\\/admin/);',
].join('\n');

async function repoWith(spec: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'gp-restore-'));
  await mkdir(join(dir, 'tests/e2e'), { recursive: true });
  await writeFile(join(dir, 'tests/e2e/login.spec.ts'), spec);
  return dir;
}

describe('checkMutationRestoredByContent', () => {
  it('przywrócony spec (bez zmutowanej linii) → true', async () => {
    const cwd = await repoWith('await expect(page).toHaveURL(/\\/employees/);\n');
    expect(await checkMutationRestoredByContent(cwd, DIFF, undefined)).toBe(true);
  });

  it('zmutowana linia nadal w pliku → false', async () => {
    const cwd = await repoWith('await expect(page).toHaveURL(/\\/admin/);\n');
    expect(await checkMutationRestoredByContent(cwd, DIFF, undefined)).toBe(false);
  });

  it('diff bez nagłówków plików używa specPath', async () => {
    const bare = '-a stara linia asercji\n+b nowa zmutowana asercja';
    const cwd = await repoWith('a stara linia asercji\n');
    expect(
      await checkMutationRestoredByContent(cwd, bare, 'tests/e2e/login.spec.ts'),
    ).toBe(true);
  });

  it('brak plików i specPath → false (nie da się dowieść)', async () => {
    const cwd = await repoWith('cokolwiek');
    expect(await checkMutationRestoredByContent(cwd, '-x\n+y długa linia', undefined)).toBe(false);
  });
});
