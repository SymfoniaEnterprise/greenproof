/**
 * Wersja aplikacji: wzór z liczby commitów (czysta funkcja) + spójność
 * `--version` i pola `version` w statusie z package.json. Nie wołamy gita -
 * wersję czytamy z packages/cli/package.json (fallback, gdy gita brak).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { versionFromCommitCount } from '../../../scripts/version.mjs';
import { run } from '../src/main.js';
import { cleanupTmp, configObject, initRepo, tmpDir, writeFileIn } from './helpers.js';

const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
) as { version: string };

function capture(): { out: string[]; err: string[]; options: Parameters<typeof run>[1] } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, options: { stdout: (t) => out.push(t), stderr: (t) => err.push(t) } };
}

describe('versionFromCommitCount', () => {
  const cases: Array<[number, string]> = [
    [112, '0.1.12'],
    [113, '0.1.13'],
    [199, '0.1.99'],
    [200, '0.2.0'],
    [1204, '0.12.4'],
  ];
  for (const [n, expected] of cases) {
    it(`n=${n} → ${expected}`, () => {
      expect(versionFromCommitCount(n)).toBe(expected);
    });
  }
});

describe('wersja w CLI', () => {
  it('--version wypisuje wersję zgodną z package.json (małe litery, bez prefiksu v)', async () => {
    const io = capture();
    const code = await run(['--version'], io.options);
    expect(code).toBe(0);
    expect(io.out.join('')).toBe(`${pkg.version}\n`);
    expect(pkg.version).toMatch(/^0\.\d+\.\d+$/);
  });

  it('status zwraca pole version z tą samą wartością', async () => {
    const repoDir = await initRepo();
    const workDir = await tmpDir('gp-cli-ver-');
    const configFile = await writeFileIn(
      workDir,
      'greenproof.json',
      JSON.stringify(configObject({ platformOptions: { repoDir, baseDir: workDir }, paths: { testsRepoDir: repoDir } })),
    );
    const inFile = await writeFileIn(
      workDir,
      'filter-in.json',
      JSON.stringify({
        slug: 'demo',
        envUrl: 'https://app.example.test',
        ref: 'main',
        runRef: 'ver',
        plan: { slug: 'demo', cases: [] },
      }),
    );

    const filterIo = capture();
    await run(['step', 'filter', '--config', configFile, '--in', inFile], filterIo.options);
    const runId = (JSON.parse(filterIo.out.join('')) as { runId: string }).runId;

    const statusIo = capture();
    const code = await run(['status', '--config', configFile, '--run', runId], statusIo.options);
    expect(code).toBe(0);
    const status = JSON.parse(statusIo.out.join('')) as { version: string };
    expect(status.version).toBe(pkg.version);
  });
});
