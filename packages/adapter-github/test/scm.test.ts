import { describe, expect, it } from 'vitest';
import { GithubScm, ScmConflictError } from '../src/index.js';
import { FakeOctokit, fakeLogger } from './fake-octokit.js';

function makeScm(fake: FakeOctokit): GithubScm {
  return new GithubScm({ octokit: fake, owner: fake.owner, repo: fake.repo, logger: fakeLogger() });
}

function setup(options?: { largeFileThreshold?: number }): {
  fake: FakeOctokit;
  scm: GithubScm;
  main: string;
} {
  const fake = new FakeOctokit(
    options?.largeFileThreshold === undefined
      ? {}
      : { largeFileThreshold: options.largeFileThreshold },
  );
  const main = fake.seed('main', { 'README.md': '# test\n' });
  return { fake, scm: makeScm(fake), main };
}

describe('GithubScm.ensureBranch', () => {
  it('tworzy branch z brancha bazowego i jest idempotentne', async () => {
    const { fake, scm, main } = setup();
    await scm.ensureBranch('author/case-1', 'main');
    await scm.ensureBranch('author/case-1', 'main');
    expect(fake.refs.get('heads/author/case-1')).toBe(main);
    // Drugie wywołanie nie tworzy refa ponownie.
    expect(fake.callCount('git.createRef')).toBe(1);
  });

  it('rozwiązuje fromRef z tagu i z gołego sha', async () => {
    const { fake, scm, main } = setup();
    fake.seedTag('v1.0.0', main);
    await scm.ensureBranch('author/from-tag', 'v1.0.0');
    await scm.ensureBranch('author/from-sha', main);
    expect(fake.refs.get('heads/author/from-tag')).toBe(main);
    expect(fake.refs.get('heads/author/from-sha')).toBe(main);
  });

  it('rzuca czytelny błąd dla nieznanego refa', async () => {
    const { scm } = setup();
    await expect(scm.ensureBranch('author/x', 'nie-ma')).rejects.toThrow(/Unknown ref/i);
  });
});

describe('GithubScm.commitFiles', () => {
  it('tworzy commit na headzie brancha i przesuwa ref', async () => {
    const { fake, scm, main } = setup();
    await scm.ensureBranch('author/case-1', 'main');

    const { sha } = await scm.commitFiles(
      'author/case-1',
      [
        { path: 'specs/checkout/pay.spec.ts', content: 'export const a = 1;\n' },
        { path: 'poms/CheckoutPage.ts', content: 'export class CheckoutPage {}\n' },
      ],
      'feat: draft',
    );

    expect(sha).not.toBe(main);
    expect(fake.refs.get('heads/author/case-1')).toBe(sha);
    expect(fake.parentsOf(sha)).toEqual([main]);
    // main nietknięty
    expect(fake.refs.get('heads/main')).toBe(main);
    expect(await scm.readFile('author/case-1', 'specs/checkout/pay.spec.ts')).toBe(
      'export const a = 1;\n',
    );
    // base_tree zachowany - plik z bazy dalej jest
    expect(await scm.readFile('author/case-1', 'README.md')).toBe('# test\n');
  });

  it('usuwa plik przez wpis z sha=null', async () => {
    const { scm } = setup();
    await scm.ensureBranch('author/case-1', 'main');
    await scm.commitFiles(
      'author/case-1',
      [
        { path: 'specs/a.spec.ts', content: 'v1\n' },
        { path: 'specs/b.spec.ts', content: 'b\n' },
      ],
      'first',
    );
    await scm.commitFiles(
      'author/case-1',
      [
        { path: 'specs/a.spec.ts', content: 'v2\n' },
        { path: 'specs/b.spec.ts', content: null },
      ],
      'second',
    );
    expect(await scm.readFile('author/case-1', 'specs/a.spec.ts')).toBe('v2\n');
    expect(await scm.readFile('author/case-1', 'specs/b.spec.ts')).toBeNull();
  });

  it('nie tworzy pustego commita, gdy drzewo się nie zmienia', async () => {
    const { scm } = setup();
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

  it('wyścig na updateRef kończy się ScmConflictError', async () => {
    const { fake, scm } = setup();
    await scm.ensureBranch('author/case-1', 'main');

    // Podklasa wstrzykuje obcy commit dokładnie między budową commita a CAS-em.
    class RacingScm extends GithubScm {
      raced = false;
      protected override async beforeUpdateRef(branch: string): Promise<void> {
        if (this.raced) return;
        this.raced = true;
        fake.seed(branch, { 'other.txt': 'foreign\n' }, 'foreign');
      }
    }
    const racing = new RacingScm({
      octokit: fake,
      owner: fake.owner,
      repo: fake.repo,
      logger: fakeLogger(),
    });

    await expect(
      racing.commitFiles('author/case-1', [{ path: 'mine.txt', content: 'mine\n' }], 'mine'),
    ).rejects.toBeInstanceOf(ScmConflictError);

    // Ref należy do zwycięzcy wyścigu.
    expect(await scm.readFile('author/case-1', 'other.txt')).toBe('foreign\n');
    expect(await scm.readFile('author/case-1', 'mine.txt')).toBeNull();
  });

  it('rzuca czytelny błąd dla nieistniejącego brancha', async () => {
    const { scm } = setup();
    await expect(
      scm.commitFiles('author/nope', [{ path: 'a.txt', content: 'x' }], 'm'),
    ).rejects.toThrow(/does not exist/i);
  });
});

describe('GithubScm.readFile', () => {
  it('zwraca null dla brakującego pliku i brakującego refa', async () => {
    const { scm } = setup();
    expect(await scm.readFile('main', 'README.md')).toBe('# test\n');
    expect(await scm.readFile('main', 'nie/ma/takiego.ts')).toBeNull();
    expect(await scm.readFile('nie-ma-refa', 'README.md')).toBeNull();
  });

  it('dociąga treść blobem, gdy getContent zwraca pustą zawartość (duży plik)', async () => {
    const { fake, scm } = setup({ largeFileThreshold: 8 });
    fake.seed('main', { 'big.txt': 'x'.repeat(100) });
    expect(await scm.readFile('main', 'big.txt')).toBe('x'.repeat(100));
    expect(fake.callCount('git.getBlob')).toBe(1);
  });

  it('rzuca, gdy ścieżka jest katalogiem', async () => {
    const { fake, scm } = setup();
    fake.seed('main', { 'specs/a.ts': 'a' });
    await expect(scm.readFile('main', 'specs')).rejects.toThrow(/directory/i);
  });
});

describe('GithubScm.listFiles', () => {
  it('filtruje globem ** i *', async () => {
    const { fake, scm } = setup();
    fake.seed('main', {
      'specs/a.spec.ts': 'a',
      'specs/deep/nested/b.spec.ts': 'b',
      'poms/Page.ts': 'p',
      'root.ts': 'r',
      'docs/readme.md': 'd',
    });

    expect(await scm.listFiles('main', '**/*.ts')).toEqual([
      'poms/Page.ts',
      'root.ts',
      'specs/a.spec.ts',
      'specs/deep/nested/b.spec.ts',
    ]);
    expect(await scm.listFiles('main', 'specs/*.spec.ts')).toEqual(['specs/a.spec.ts']);
    expect(await scm.listFiles('main', 'specs/**/*.spec.ts')).toEqual([
      'specs/a.spec.ts',
      'specs/deep/nested/b.spec.ts',
    ]);
    expect(await scm.listFiles('main', '*.md')).toEqual(['README.md']);
    expect(await scm.listFiles('main', '**/*.java')).toEqual([]);
  });
});

describe('GithubScm.openPullRequest', () => {
  it('tworzy PR i jest idempotentne przy istniejącym PR', async () => {
    const { fake, scm } = setup();
    await scm.ensureBranch('author/case-1', 'main');
    const first = await scm.openPullRequest({
      from: 'author/case-1',
      to: 'main',
      title: 'Draft case-1',
      body: 'body',
    });
    expect(first.id).toBe('1');
    expect(first.url).toBe(`https://github.com/${fake.owner}/${fake.repo}/pull/1`);

    const again = await scm.openPullRequest({
      from: 'author/case-1',
      to: 'main',
      title: 'Draft case-1 (retry)',
      body: 'body',
    });
    expect(again).toEqual(first);
    expect(fake.pulls_.size).toBe(1);
    expect(fake.callCount('pulls.list')).toBe(1);
  });
});

describe('GithubScm.push', () => {
  it('bez repoDir jest no-opem z logiem debug', async () => {
    const { fake } = setup();
    const logger = fakeLogger();
    const scm = new GithubScm({ octokit: fake, owner: fake.owner, repo: fake.repo, logger });
    await expect(scm.push('author/case-1')).resolves.toBeUndefined();
    expect(logger.entries.some((e) => e.level === 'debug' && /no-op/.test(e.msg))).toBe(true);
  });
});
