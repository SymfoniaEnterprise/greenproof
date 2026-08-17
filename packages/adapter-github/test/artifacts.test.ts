import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { DEFAULT_ARTIFACTS_BRANCH, GithubArtifactStore } from '../src/index.js';
import { assertSafeKey } from '../src/internal.js';
import { FakeOctokit, fakeLogger } from './fake-octokit.js';

function setup(): { fake: FakeOctokit; store: GithubArtifactStore } {
  const fake = new FakeOctokit();
  fake.seed('main', { 'README.md': '# test\n' });
  return {
    fake,
    store: new GithubArtifactStore({
      octokit: fake,
      owner: fake.owner,
      repo: fake.repo,
      logger: fakeLogger(),
    }),
  };
}

describe('GithubArtifactStore', () => {
  it('put/get/list na osobnym branchu', async () => {
    const { fake, store } = setup();
    expect(await store.list('run-1')).toEqual([]);
    expect(await store.get('run-1', 'spec.ts')).toBeNull();

    await store.put('run-1', 'draft/spec.ts', Buffer.from('export const a = 1;\n', 'utf8'));
    await store.put('run-1', 'ledger.jsonl', Buffer.from('{"a":1}\n', 'utf8'));
    await store.put('run-2', 'other.txt', Buffer.from('x', 'utf8'));

    // Pierwszy zapis tworzy branch artefaktów (orphan - bez plików z main).
    expect(fake.refs.has(`heads/${DEFAULT_ARTIFACTS_BRANCH}`)).toBe(true);
    expect(fake.fileAt(DEFAULT_ARTIFACTS_BRANCH, 'README.md')).toBeNull();

    expect((await store.get('run-1', 'draft/spec.ts'))?.toString('utf8')).toBe(
      'export const a = 1;\n',
    );
    expect(await store.list('run-1')).toEqual(['draft/spec.ts', 'ledger.jsonl']);
    expect(await store.list('run-1', 'draft/')).toEqual(['draft/spec.ts']);
    expect(await store.list('run-2')).toEqual(['other.txt']);
  });

  it('zapisuje dane binarne bez uszkodzenia', async () => {
    const { store } = setup();
    const binary = Buffer.from([0x00, 0xff, 0x10, 0x80, 0x7f]);
    await store.put('run-1', 'trace.zip', binary);
    expect(await store.get('run-1', 'trace.zip')).toEqual(binary);
  });

  it('przyjmuje strumień', async () => {
    const { store } = setup();
    await store.put('run-1', 'stream.txt', Readable.from([Buffer.from('ab'), Buffer.from('cd')]));
    expect((await store.get('run-1', 'stream.txt'))?.toString('utf8')).toBe('abcd');
  });

  it('meta zapisuje się obok i nie pojawia się w list', async () => {
    const { fake, store } = setup();
    await store.put('run-1', 'proof.json', Buffer.from('{}', 'utf8'), {
      contentType: 'application/json',
    });
    expect(await store.list('run-1')).toEqual(['proof.json']);
    const meta = fake.fileAt(DEFAULT_ARTIFACTS_BRANCH, 'run-1/proof.json.meta.json');
    expect(meta).not.toBeNull();
    expect(JSON.parse(meta as string)).toEqual({ contentType: 'application/json' });
    // Meta jest jednak czytelne przez get pod jawnym kluczem.
    expect((await store.get('run-1', 'proof.json.meta.json'))?.toString('utf8')).toContain(
      'application/json',
    );
  });

  it('ponawia zapis po wyścigu na refie', async () => {
    const { fake } = setup();
    const logger = fakeLogger();

    class RacingStore extends GithubArtifactStore {
      protected override async beforeUpdateRef(attempt: number): Promise<void> {
        // Tylko pierwsze podejście przegrywa wyścig.
        if (attempt !== 1) return;
        fake.seed(DEFAULT_ARTIFACTS_BRANCH, { 'run-1/foreign.txt': 'foreign' }, 'foreign');
      }
    }
    const store = new RacingStore({
      octokit: fake,
      owner: fake.owner,
      repo: fake.repo,
      logger,
    });

    await store.put('run-1', 'first.txt', Buffer.from('first', 'utf8'));
    await store.put('run-1', 'second.txt', Buffer.from('second', 'utf8'));

    // Oba zapisy weszły dopiero za drugim podejściem, a obcy plik przetrwał.
    expect(await store.list('run-1')).toEqual(['first.txt', 'foreign.txt', 'second.txt']);
    // Zapis 1: createRef przegrywa (branch powstał obok) → updateRef w 2. próbie.
    // Zapis 2: updateRef przegrywa, powtórzony na świeżym headzie.
    expect(fake.callCount('git.createRef')).toBe(1);
    expect(fake.callCount('git.updateRef')).toBe(3);
  });

  it('poddaje się po trzech nieudanych podejściach', async () => {
    const { fake, store } = setup();
    await store.put('run-1', 'first.txt', Buffer.from('first', 'utf8'));

    class AlwaysRacingStore extends GithubArtifactStore {
      protected override async beforeUpdateRef(attempt: number): Promise<void> {
        fake.seed(DEFAULT_ARTIFACTS_BRANCH, { [`run-1/foreign-${attempt}.txt`]: 'x' }, 'foreign');
      }
    }
    const racing = new AlwaysRacingStore({
      octokit: fake,
      owner: fake.owner,
      repo: fake.repo,
      logger: fakeLogger(),
    });

    await expect(
      racing.put('run-1', 'never.txt', Buffer.from('never', 'utf8')),
    ).rejects.toThrow(/after 3 attempts/i);
    expect(await store.list('run-1')).not.toContain('never.txt');
  });

  it('dociąga duże artefakty przez blob', async () => {
    const fake = new FakeOctokit({ largeFileThreshold: 4 });
    const store = new GithubArtifactStore({
      octokit: fake,
      owner: fake.owner,
      repo: fake.repo,
      logger: fakeLogger(),
    });
    await store.put('run-1', 'big.bin', Buffer.from('0123456789', 'utf8'));
    expect((await store.get('run-1', 'big.bin'))?.toString('utf8')).toBe('0123456789');
    expect(fake.callCount('git.getBlob')).toBe(1);
  });
});

// Klucze artefaktów są POSIX-owe, ale wartownik ma odrzucać wszystko, co absolutne -
// także wejście z Windowsa, gdzie 'C:\x' i drive-relative 'C:x' nie zaczynają się od '/'.
describe('assertSafeKey - ścieżki absolutne Windows', () => {
  it('odrzuca literę dysku w każdej postaci', () => {
    expect(() => assertSafeKey('C:/x')).toThrow(/relative/i);
    expect(() => assertSafeKey('C:x')).toThrow(/relative/i);
    expect(() => assertSafeKey('c:\\x')).toThrow(/relative/i);
  });

  it('nadal odrzuca POSIX-owe absolutne i ucieczkę katalogiem wyżej', () => {
    expect(() => assertSafeKey('/x')).toThrow(/relative/i);
    expect(() => assertSafeKey('../x')).toThrow(/\.\./);
    expect(() => assertSafeKey('\\\\server\\share\\x')).toThrow(/relative/i);
  });

  it('przepuszcza klucze relatywne, także z dwukropkiem w segmencie', () => {
    expect(assertSafeKey('tests/support/pom/a.ts')).toBe('tests/support/pom/a.ts');
    expect(assertSafeKey('a/b:c.ts')).toBe('a/b:c.ts');
  });
});
