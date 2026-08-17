import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { FsScm } from '../src/index.js';
import { cleanupTmp, git, initRepo, tmpDir } from './helpers.js';

afterAll(cleanupTmp);

async function makeScm(): Promise<{ scm: FsScm; repoDir: string; prDir: string }> {
  const repoDir = await initRepo();
  const prDir = await tmpDir('gp-prs-');
  return { scm: new FsScm({ repoDir, prDir }), repoDir, prDir };
}

describe('FsScm.ensureBranch', () => {
  it('tworzy branch i jest idempotentne', async () => {
    const { scm, repoDir } = await makeScm();
    await scm.ensureBranch('author/case-1', 'main');
    await scm.ensureBranch('author/case-1', 'main');
    expect(await git(repoDir, 'rev-parse', 'author/case-1')).toBe(
      await git(repoDir, 'rev-parse', 'main'),
    );
  });
});

describe('FsScm.deleteBranch / listBranches', () => {
  it('usuwa branch (także aktualnie wybrany - przez detach), brak = no-op', async () => {
    const { scm, repoDir } = await makeScm();
    await scm.ensureBranch('author/case-1', 'main');
    await scm.deleteBranch('author/case-1');
    expect(await git(repoDir, 'branch', '--list', 'author/case-1')).toBe('');

    // Aktualnie wybrany branch: HEAD zostaje odczepiony, ref znika.
    await scm.ensureBranch('author/case-2', 'main');
    await git(repoDir, 'checkout', 'author/case-2');
    await scm.deleteBranch('author/case-2');
    expect(await git(repoDir, 'branch', '--list', 'author/case-2')).toBe('');

    await scm.deleteBranch('author/nie-ma'); // idempotentne
  });

  it('listBranches zwraca branche pod prefiksem-ścieżką', async () => {
    const { scm } = await makeScm();
    await scm.ensureBranch('greenproof/fixtures-failed/r-1/typ-a', 'main');
    await scm.ensureBranch('greenproof/fixtures-failed/r-1/typ-b', 'main');
    await scm.ensureBranch('greenproof/fixtures-failed/r-2/typ-a', 'main');

    expect(await scm.listBranches('greenproof/fixtures-failed/r-1/')).toEqual([
      'greenproof/fixtures-failed/r-1/typ-a',
      'greenproof/fixtures-failed/r-1/typ-b',
    ]);
    expect(await scm.listBranches('greenproof/nie-ma/')).toEqual([]);
  });
});

describe('FsScm.commitFiles', () => {
  it('commituje pliki w podkatalogach bez ruszania checkoutu', async () => {
    const { scm, repoDir } = await makeScm();
    await scm.ensureBranch('author/case-1', 'main');
    const head = await git(repoDir, 'rev-parse', 'main');

    const { sha } = await scm.commitFiles(
      'author/case-1',
      [
        { path: 'specs/checkout/pay.spec.ts', content: 'export const a = 1;\n' },
        { path: 'poms/CheckoutPage.ts', content: 'export class CheckoutPage {}\n' },
      ],
      'feat: draft',
    );

    expect(sha).not.toBe(head);
    expect(await git(repoDir, 'rev-parse', 'author/case-1')).toBe(sha);
    expect(await git(repoDir, 'rev-parse', `${sha}^`)).toBe(head);
    // main nietknięty, working tree nietknięty
    expect(await git(repoDir, 'rev-parse', 'main')).toBe(head);
    expect(await git(repoDir, 'status', '--porcelain')).toBe('');

    expect(await scm.readFile('author/case-1', 'specs/checkout/pay.spec.ts')).toBe(
      'export const a = 1;\n',
    );
    expect(await scm.readFile('author/case-1', 'poms/CheckoutPage.ts')).toBe(
      'export class CheckoutPage {}\n',
    );
  });

  it('drugi commit nadpisuje i usuwa pliki', async () => {
    const { scm, repoDir } = await makeScm();
    await scm.ensureBranch('author/case-1', 'main');
    const first = await scm.commitFiles(
      'author/case-1',
      [
        { path: 'specs/a.spec.ts', content: 'v1\n' },
        { path: 'specs/b.spec.ts', content: 'b\n' },
      ],
      'first',
    );
    const second = await scm.commitFiles(
      'author/case-1',
      [
        { path: 'specs/a.spec.ts', content: 'v2\n' },
        { path: 'specs/b.spec.ts', content: null },
      ],
      'second',
    );

    expect(second.sha).not.toBe(first.sha);
    expect(await scm.readFile('author/case-1', 'specs/a.spec.ts')).toBe('v2\n');
    expect(await scm.readFile('author/case-1', 'specs/b.spec.ts')).toBeNull();
    // historia zachowana
    expect(await git(repoDir, 'rev-parse', `${second.sha}^`)).toBe(first.sha);
  });

  it('nie tworzy pustego commita, gdy treść się nie zmienia', async () => {
    const { scm } = await makeScm();
    await scm.ensureBranch('author/case-1', 'main');
    const first = await scm.commitFiles(
      'author/case-1',
      [{ path: 'specs/a.spec.ts', content: 'v1\n' }],
      'first',
    );
    const again = await scm.commitFiles(
      'author/case-1',
      [{ path: 'specs/a.spec.ts', content: 'v1\n' }],
      'first (retry)',
    );
    expect(again.sha).toBe(first.sha);
  });

  it('CAS na update-ref: równoległy commit między odczytem a zapisem = błąd', async () => {
    const repoDir = await initRepo();
    const prDir = await tmpDir('gp-prs-');
    const racer = new FsScm({ repoDir, prDir });

    // Podklasa wstrzykuje "obcy" commit dokładnie po zbudowaniu commita,
    // a przed CAS-em na refie - czyli klasyczny wyścig dwóch runnerów.
    class RacingScm extends FsScm {
      raced = false;
      protected override async beforeUpdateRef(branch: string): Promise<void> {
        if (this.raced) return;
        this.raced = true;
        await racer.commitFiles(branch, [{ path: 'other.txt', content: 'foreign\n' }], 'foreign');
      }
    }

    const scm = new RacingScm({ repoDir, prDir });
    await scm.ensureBranch('author/case-1', 'main');
    const before = await git(repoDir, 'rev-parse', 'author/case-1');

    await expect(
      scm.commitFiles('author/case-1', [{ path: 'mine.txt', content: 'mine\n' }], 'mine'),
    ).rejects.toThrow(/modified concurrently/i);

    // Ref należy do zwycięzcy wyścigu, nie do przegranego.
    expect(await scm.readFile('author/case-1', 'other.txt')).toBe('foreign\n');
    expect(await scm.readFile('author/case-1', 'mine.txt')).toBeNull();
    expect(await git(repoDir, 'rev-parse', 'author/case-1')).not.toBe(before);
  });

  it('rzuca czytelny błąd dla nieistniejącego brancha', async () => {
    const { scm } = await makeScm();
    await expect(
      scm.commitFiles('author/nope', [{ path: 'a.txt', content: 'x' }], 'm'),
    ).rejects.toThrow(/does not exist/i);
  });
});

describe('FsScm.readFile', () => {
  it('zwraca null dla brakującego pliku, rzuca dla nieznanego refa', async () => {
    const { scm } = await makeScm();
    expect(await scm.readFile('main', 'README.md')).toBe('# test\n');
    expect(await scm.readFile('main', 'nie/ma/takiego.ts')).toBeNull();
    await expect(scm.readFile('nie-ma-refa', 'README.md')).rejects.toThrow(/Unknown ref/i);
  });
});

describe('FsScm.listFiles', () => {
  it('filtruje globem ** i *', async () => {
    const { scm } = await makeScm();
    await scm.ensureBranch('author/case-1', 'main');
    await scm.commitFiles(
      'author/case-1',
      [
        { path: 'specs/a.spec.ts', content: 'a' },
        { path: 'specs/deep/nested/b.spec.ts', content: 'b' },
        { path: 'poms/Page.ts', content: 'p' },
        { path: 'root.ts', content: 'r' },
        { path: 'docs/readme.md', content: 'd' },
      ],
      'files',
    );

    expect(await scm.listFiles('author/case-1', '**/*.ts')).toEqual([
      'poms/Page.ts',
      'root.ts',
      'specs/a.spec.ts',
      'specs/deep/nested/b.spec.ts',
    ]);
    expect(await scm.listFiles('author/case-1', 'specs/*.spec.ts')).toEqual(['specs/a.spec.ts']);
    expect(await scm.listFiles('author/case-1', 'specs/**/*.spec.ts')).toEqual([
      'specs/a.spec.ts',
      'specs/deep/nested/b.spec.ts',
    ]);
    expect(await scm.listFiles('author/case-1', '*.md')).toEqual(['README.md']);
    expect(await scm.listFiles('author/case-1', '**/*.java')).toEqual([]);
  });
});

describe('FsScm.openPullRequest / push', () => {
  it('numeruje PR-y i zapisuje JSON, push jest no-opem', async () => {
    const { scm, prDir } = await makeScm();
    const first = await scm.openPullRequest({
      from: 'author/case-1',
      to: 'main',
      title: 'Draft case-1',
      body: 'body',
    });
    const second = await scm.openPullRequest({
      from: 'author/case-2',
      to: 'main',
      title: 'Draft case-2',
      body: 'body2',
    });

    expect(first.id).toBe('1');
    expect(second.id).toBe('2');
    // pathToFileURL: poprawny URL na obu platformach (na Windows file:///C:/...).
    expect(first.url).toBe(pathToFileURL(join(prDir, '1.json')).href);

    const raw = await readFile(fileURLToPath(first.url), 'utf8');
    const parsed = JSON.parse(raw) as Record<string, string>;
    expect(parsed['from']).toBe('author/case-1');
    expect(parsed['to']).toBe('main');
    expect(parsed['title']).toBe('Draft case-1');
    expect(parsed['body']).toBe('body');
    expect(Date.parse(parsed['createdAt'] ?? '')).not.toBeNaN();

    await expect(scm.push('author/case-1')).resolves.toBeUndefined();
  });
});
