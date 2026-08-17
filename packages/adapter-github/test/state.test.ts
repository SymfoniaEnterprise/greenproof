import type { PipelineState } from '@greenproof/core';
import { StateConflictError } from '@greenproof/core';
import { describe, expect, it } from 'vitest';
import { DEFAULT_STATE_BRANCH, GithubStateStore } from '../src/index.js';
import { FakeOctokit, fakeLogger } from './fake-octokit.js';

function makeState(runId: string, costUsd = 0): PipelineState {
  return {
    runId,
    slug: 'checkout',
    planHash: 'abc123',
    envUrl: 'https://staging.example.com',
    baseRef: 'main',
    runRef: '42',
    createdAt: '2026-01-01T00:00:00.000Z',
    cases: {},
    totals: { costUsd, turns: 0 },
  };
}

function setup(): { fake: FakeOctokit; store: GithubStateStore } {
  const fake = new FakeOctokit();
  fake.seed('main', { 'README.md': '# test\n' });
  return {
    fake,
    store: new GithubStateStore({
      octokit: fake,
      owner: fake.owner,
      repo: fake.repo,
      logger: fakeLogger(),
    }),
  };
}

describe('GithubStateStore', () => {
  it('load nieistniejącego stanu zwraca null', async () => {
    const { fake, store } = setup();
    expect(await store.load('run-1')).toBeNull();
    // Branch stanu istnieje, ale bez pliku tego runu.
    await store.save('run-1', makeState('run-1'), null);
    expect(await store.load('run-2')).toBeNull();
  });

  it('pierwszy zapis tworzy orphan branch (commit bez rodziców)', async () => {
    const { fake, store } = setup();
    const created = await store.save('run-1', makeState('run-1'), null);

    const head = fake.refs.get(`heads/${DEFAULT_STATE_BRANCH}`) as string;
    expect(fake.parentsOf(head)).toEqual([]);
    // Orphan = drzewo stanu nie zawiera plików z main.
    expect(fake.fileAt(DEFAULT_STATE_BRANCH, 'README.md')).toBeNull();
    expect(fake.fileAt(DEFAULT_STATE_BRANCH, 'run-1.json')).not.toBeNull();

    const loaded = await store.load('run-1');
    expect(loaded?.state.runId).toBe('run-1');
    // Wersja jest per run (sha blobu), nie sha commita brancha.
    expect(loaded?.version).toBe(created.version);
    expect(loaded?.version).not.toBe(head);
  });

  it('zapis z poprawną wersją commituje na szczycie brancha stanu', async () => {
    const { fake, store } = setup();
    const created = await store.save('run-1', makeState('run-1'), null);
    const firstHead = fake.refs.get(`heads/${DEFAULT_STATE_BRANCH}`) as string;
    const updated = await store.save('run-1', makeState('run-1', 1.5), created.version);

    expect(updated.version).not.toBe(created.version);
    const head = fake.refs.get(`heads/${DEFAULT_STATE_BRANCH}`) as string;
    expect(fake.parentsOf(head)).toEqual([firstHead]);
    const loaded = await store.load('run-1');
    expect(loaded?.state.totals.costUsd).toBe(1.5);
    expect(loaded?.version).toBe(updated.version);
  });

  it('zapis ze złą wersją rzuca StateConflictError z core', async () => {
    const { store } = setup();
    const created = await store.save('run-1', makeState('run-1'), null);
    await store.save('run-1', makeState('run-1', 1), created.version);

    // created.version to już nieaktualny head brancha stanu.
    await expect(
      store.save('run-1', makeState('run-1', 2), created.version),
    ).rejects.toBeInstanceOf(StateConflictError);
  });

  it('drugie tworzenie (expectedVersion=null) na istniejącym pliku rzuca konflikt', async () => {
    const { store } = setup();
    await store.save('run-1', makeState('run-1'), null);
    await expect(store.save('run-1', makeState('run-1'), null)).rejects.toBeInstanceOf(
      StateConflictError,
    );
  });

  it('tworzenie innego runu na istniejącym branchu stanu dokłada commit', async () => {
    const { fake, store } = setup();
    const first = await store.save('run-1', makeState('run-1'), null);
    const firstHead = fake.refs.get(`heads/${DEFAULT_STATE_BRANCH}`) as string;
    await store.save('run-2', makeState('run-2'), null);
    const secondHead = fake.refs.get(`heads/${DEFAULT_STATE_BRANCH}`) as string;
    expect(fake.parentsOf(secondHead)).toEqual([firstHead]);
    // Cudzy zapis NIE unieważnia naszej wersji - plik run-1 się nie zmienił.
    expect((await store.load('run-1'))?.version).toBe(first.version);
  });

  it('zapisy dwóch różnych runów nie kolidują (naprzemienne load+save)', async () => {
    const { fake, store } = setup();
    const a0 = await store.save('run-a', makeState('run-a'), null);
    const b0 = await store.save('run-b', makeState('run-b'), null);

    // Oba runy trzymają wersje sprzed cudzych zapisów - żaden nie dostaje konfliktu.
    const a1 = await store.save('run-a', makeState('run-a', 1), a0.version);
    const b1 = await store.save('run-b', makeState('run-b', 2), b0.version);
    await store.save('run-a', makeState('run-a', 3), a1.version);
    await store.save('run-b', makeState('run-b', 4), b1.version);

    expect((await store.load('run-a'))?.state.totals.costUsd).toBe(3);
    expect((await store.load('run-b'))?.state.totals.costUsd).toBe(4);
    expect(fake.fileAt(DEFAULT_STATE_BRANCH, 'run-a.json')).not.toBeNull();
    expect(fake.fileAt(DEFAULT_STATE_BRANCH, 'run-b.json')).not.toBeNull();
  });

  it('wyścig na updateRef z CUDZYM runem jest pochłaniany (retry na nowym headzie)', async () => {
    const { fake, store } = setup();
    const created = await store.save('run-1', makeState('run-1'), null);
    const before = fake.callCount('git.updateRef');

    class RacingStore extends GithubStateStore {
      raced = false;
      protected override async beforeUpdateRef(): Promise<void> {
        if (this.raced) return;
        this.raced = true;
        fake.seed(DEFAULT_STATE_BRANCH, { 'run-9.json': '{}' }, 'foreign');
      }
    }
    const racing = new RacingStore({
      octokit: fake,
      owner: fake.owner,
      repo: fake.repo,
      logger: fakeLogger(),
    });

    const saved = await racing.save('run-1', makeState('run-1', 3), created.version);
    // Jedna próba przepadła na 422, druga weszła.
    expect(fake.callCount('git.updateRef')).toBe(before + 2);
    // Stan obu runów żyje - cudzy commit nie został nadpisany.
    expect(fake.fileAt(DEFAULT_STATE_BRANCH, 'run-9.json')).toBe('{}');
    const loaded = await store.load('run-1');
    expect(loaded?.state.totals.costUsd).toBe(3);
    expect(loaded?.version).toBe(saved.version);
  });

  it('równoległy zapis TEGO SAMEGO runu nadal daje StateConflictError', async () => {
    const { fake, store } = setup();
    const created = await store.save('run-1', makeState('run-1'), null);

    class RacingStore extends GithubStateStore {
      raced = false;
      protected override async beforeUpdateRef(): Promise<void> {
        if (this.raced) return;
        this.raced = true;
        // Ktoś inny zapisał NASZ plik stanu - to prawdziwy konflikt.
        fake.seed(DEFAULT_STATE_BRANCH, { 'run-1.json': '{"runId":"run-1"}' }, 'foreign');
      }
    }
    const racing = new RacingStore({
      octokit: fake,
      owner: fake.owner,
      repo: fake.repo,
      logger: fakeLogger(),
    });

    await expect(
      racing.save('run-1', makeState('run-1', 3), created.version),
    ).rejects.toBeInstanceOf(StateConflictError);
    // Zapis zwycięzcy wyścigu zostaje nietknięty.
    expect(fake.fileAt(DEFAULT_STATE_BRANCH, 'run-1.json')).toBe('{"runId":"run-1"}');
  });

  it('branch stanu utworzony równolegle: tworzenie dopisuje się do niego', async () => {
    const fake = new FakeOctokit();

    class RacingStore extends GithubStateStore {
      raced = false;
      protected override async beforeUpdateRef(): Promise<void> {
        if (this.raced) return;
        this.raced = true;
        // Inny run zdążył utworzyć orphan brancha przed nami.
        fake.seed(DEFAULT_STATE_BRANCH, { 'run-9.json': '{}' }, 'foreign');
      }
    }
    const racing = new RacingStore({
      octokit: fake,
      owner: fake.owner,
      repo: fake.repo,
      logger: fakeLogger(),
    });

    const created = await racing.save('run-1', makeState('run-1'), null);
    expect(fake.fileAt(DEFAULT_STATE_BRANCH, 'run-9.json')).toBe('{}');
    expect((await racing.load('run-1'))?.version).toBe(created.version);
  });

  it('gdy head ucieka przy każdej próbie, save oddaje StateConflictError', async () => {
    const { fake, store } = setup();
    const created = await store.save('run-1', makeState('run-1'), null);

    class BusyStore extends GithubStateStore {
      protected override async beforeUpdateRef(attempt: number): Promise<void> {
        fake.seed(DEFAULT_STATE_BRANCH, { [`foreign-${attempt}.json`]: '{}' }, 'foreign');
      }
    }
    const busy = new BusyStore({
      octokit: fake,
      owner: fake.owner,
      repo: fake.repo,
      logger: fakeLogger(),
    });

    await expect(busy.save('run-1', makeState('run-1', 3), created.version)).rejects.toBeInstanceOf(
      StateConflictError,
    );
    // Nasz stan został przy ostatniej udanej wersji - nic nie zostało wymuszone.
    expect((await store.load('run-1'))?.state.totals.costUsd).toBe(0);
  });

  it('zapis na własnym branchu stanu (opcja branch)', async () => {
    const fake = new FakeOctokit();
    const store = new GithubStateStore({
      octokit: fake,
      owner: fake.owner,
      repo: fake.repo,
      logger: fakeLogger(),
      branch: 'custom/state',
    });
    const created = await store.save('run-1', makeState('run-1'), null);
    expect(fake.refs.get('heads/custom/state')).toBeDefined();
    expect(fake.fileAt('custom/state', 'run-1.json')).not.toBeNull();
    expect((await store.load('run-1'))?.version).toBe(created.version);
  });
});
