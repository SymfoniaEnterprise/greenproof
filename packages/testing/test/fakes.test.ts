import { describe, expect, it } from 'vitest';
import { StateConflictError } from '@greenproof/core';
import type { HumanReport, PipelineState } from '@greenproof/core';
import {
  CapturingHumanChannel,
  FixedClock,
  InMemoryArtifactStore,
  InMemoryScm,
  InMemoryStateStore,
  TestLogger,
  globToRegExp,
  makeFakePorts,
} from '../src/index.js';

function makeState(runId: string, costUsd = 0): PipelineState {
  return {
    runId,
    slug: 'payroll',
    planHash: 'hash',
    envUrl: 'http://localhost:3000',
    baseRef: 'main',
    runRef: '42',
    createdAt: '2025-01-01T00:00:00.000Z',
    cases: {},
    totals: { costUsd, turns: 0 },
  };
}

function makeReport(reportId: string, title: string): HumanReport {
  return { kind: 'roster', title, markdown: `# ${title}`, data: { title }, reportId };
}

describe('InMemoryStateStore (CAS)', () => {
  it('tworzy stan przy expectedVersion=null i zwraca rosnące wersje', async () => {
    const store = new InMemoryStateStore();
    const first = await store.save('run-1', makeState('run-1'), null);
    const second = await store.save('run-1', makeState('run-1', 5), first.version);
    expect(first.version).not.toBe(second.version);

    const loaded = await store.load('run-1');
    expect(loaded?.version).toBe(second.version);
    expect(loaded?.state.totals.costUsd).toBe(5);
  });

  it('rzuca StateConflictError przy nieaktualnej wersji', async () => {
    const store = new InMemoryStateStore();
    const created = await store.save('run-1', makeState('run-1'), null);
    await store.save('run-1', makeState('run-1', 1), created.version);

    await expect(store.save('run-1', makeState('run-1', 2), created.version)).rejects.toThrow(
      StateConflictError,
    );
    // Konflikt nie nadpisał stanu.
    expect(store.snapshot('run-1')?.totals.costUsd).toBe(1);
  });

  it('rzuca StateConflictError przy tworzeniu istniejącego runu i przy zapisie nieistniejącego', async () => {
    const store = new InMemoryStateStore();
    await store.save('run-1', makeState('run-1'), null);
    await expect(store.save('run-1', makeState('run-1'), null)).rejects.toThrow(
      StateConflictError,
    );
    await expect(store.save('brak', makeState('brak'), '1')).rejects.toThrow(
      StateConflictError,
    );
    expect(await store.load('brak')).toBeNull();
  });

  it('nie dzieli referencji ze stanem wywołującego', async () => {
    const store = new InMemoryStateStore();
    const state = makeState('run-1');
    const { version } = await store.save('run-1', state, null);
    state.totals.costUsd = 999;
    expect(store.snapshot('run-1')?.totals.costUsd).toBe(0);
    expect(store.version('run-1')).toBe(version);
  });
});

describe('CapturingHumanChannel', () => {
  it('nadpisuje raport o tym samym reportId', async () => {
    const human = new CapturingHumanChannel();
    await human.postReport('42', makeReport('run-1:roster', 'v1'));
    await human.postReport('42', makeReport('run-1:roster', 'v2'));

    expect(human.reports).toHaveLength(1);
    expect(human.posts).toBe(2);
    expect(human.byId('run-1:roster')?.title).toBe('v2');
  });

  it('filtruje po kind', async () => {
    const human = new CapturingHumanChannel();
    await human.postReport('42', makeReport('a', 'roster'));
    await human.postReport('42', { ...makeReport('b', 'blok'), kind: 'case_blocked' });

    expect(human.byKind('roster').map((r) => r.reportId)).toEqual(['a']);
    expect(human.byKind('case_blocked')).toHaveLength(1);
    expect(human.last()?.reportId).toBe('b');
  });
});

describe('InMemoryScm', () => {
  it('ensureBranch kopiuje drzewo z fromRef i jest idempotentne', async () => {
    const scm = new InMemoryScm({ main: { 'tests/a.spec.ts': 'a' } });
    await scm.ensureBranch('author/case-1', 'main');
    await scm.commitFiles(
      'author/case-1',
      [{ path: 'tests/b.spec.ts', content: 'b' }],
      'dodaj b',
    );
    // Powtórne ensureBranch nie kasuje pracy na branchu.
    await scm.ensureBranch('author/case-1', 'main');

    expect(scm.getFiles('author/case-1')).toEqual({
      'tests/a.spec.ts': 'a',
      'tests/b.spec.ts': 'b',
    });
    // Branch bazowy nietknięty.
    expect(scm.getFiles('main')).toEqual({ 'tests/a.spec.ts': 'a' });
  });

  it('commitFiles zapisuje historię, deterministyczne sha i usuwa pliki', async () => {
    const scm = new InMemoryScm({ main: {} });
    const first = await scm.commitFiles(
      'main',
      [{ path: 'tests/a.spec.ts', content: 'a' }],
      'dodaj a',
    );
    expect(first.sha).toMatch(/^[0-9a-f]{40}$/);

    await scm.commitFiles('main', [{ path: 'tests/a.spec.ts', content: null }], 'usuń a');
    expect(await scm.readFile('main', 'tests/a.spec.ts')).toBeNull();

    const commits = scm.getCommits('main');
    expect(commits.map((c) => c.message)).toEqual(['dodaj a', 'usuń a']);
    expect(commits[0]?.sha).not.toBe(commits[1]?.sha);

    // Ten sam scenariusz na czystej instancji daje te same sha.
    const other = new InMemoryScm({ main: {} });
    const same = await other.commitFiles(
      'main',
      [{ path: 'tests/a.spec.ts', content: 'a' }],
      'dodaj a',
    );
    expect(same.sha).toBe(first.sha);
  });

  it('commitFiles na nieznanym branchu rzuca', async () => {
    const scm = new InMemoryScm();
    await expect(scm.commitFiles('brak', [], 'x')).rejects.toThrow(/nieznany branch/);
  });

  it('listFiles obsługuje glob z ** i *', async () => {
    const scm = new InMemoryScm({
      main: {
        'tests/a.spec.ts': '',
        'tests/pom/login.page.ts': '',
        'tests/deep/nested/b.spec.ts': '',
        'docs/readme.md': '',
      },
    });

    expect(await scm.listFiles('main', '**/*.spec.ts')).toEqual([
      'tests/a.spec.ts',
      'tests/deep/nested/b.spec.ts',
    ]);
    expect(await scm.listFiles('main', 'tests/*.spec.ts')).toEqual(['tests/a.spec.ts']);
    expect(await scm.listFiles('main', 'tests/**')).toEqual([
      'tests/a.spec.ts',
      'tests/deep/nested/b.spec.ts',
      'tests/pom/login.page.ts',
    ]);
    expect(await scm.listFiles('main', 'docs/*.md')).toEqual(['docs/readme.md']);
    expect(await scm.listFiles('brak', '**/*')).toEqual([]);
    // Kropka w globie nie jest wildcardem.
    expect(globToRegExp('*.ts').test('ats')).toBe(false);
  });

  it('openPullRequest zapisuje PR i jest idempotentne dla tej samej pary refów', async () => {
    const scm = new InMemoryScm({ main: {} });
    const pr = await scm.openPullRequest({
      from: 'author/case-1',
      to: 'main',
      title: 'Case 1',
      body: 'body',
    });
    expect(pr).toEqual({ url: 'fake://pr/1', id: '1' });

    const again = await scm.openPullRequest({
      from: 'author/case-1',
      to: 'main',
      title: 'Case 1 (v2)',
      body: 'body2',
    });
    expect(again).toEqual(pr);
    expect(scm.pullRequests).toHaveLength(1);
    expect(scm.pullRequests[0]?.title).toBe('Case 1 (v2)');

    await scm.openPullRequest({ from: 'author/case-2', to: 'main', title: 'C2', body: '' });
    expect(scm.pullRequests.map((p) => p.url)).toEqual(['fake://pr/1', 'fake://pr/2']);
  });
});

describe('InMemoryArtifactStore', () => {
  it('zapisuje Buffer i strumień, listuje po prefiksie', async () => {
    const store = new InMemoryArtifactStore();
    await store.put('run-1', 'proof/case-1.json', Buffer.from('{"a":1}', 'utf8'), {
      contentType: 'application/json',
    });

    const { Readable } = await import('node:stream');
    await store.put('run-1', 'spec/case-1.ts', Readable.from(['const ', 'a = 1;']));

    expect(store.getText('run-1', 'proof/case-1.json')).toBe('{"a":1}');
    expect(store.getText('run-1', 'spec/case-1.ts')).toBe('const a = 1;');
    expect((await store.get('run-1', 'proof/case-1.json'))?.toString()).toBe('{"a":1}');
    expect(await store.get('run-1', 'brak')).toBeNull();
    expect(await store.list('run-1')).toEqual(['proof/case-1.json', 'spec/case-1.ts']);
    expect(await store.list('run-1', 'proof/')).toEqual(['proof/case-1.json']);
    expect(await store.list('inny-run')).toEqual([]);
    expect(store.getMeta('run-1', 'proof/case-1.json')).toEqual({
      contentType: 'application/json',
    });
  });
});

describe('FixedClock / TestLogger / makeFakePorts', () => {
  it('FixedClock jest deterministyczny i przesuwalny', () => {
    const clock = new FixedClock('2025-06-01T12:00:00.000Z');
    expect(clock.now().toISOString()).toBe('2025-06-01T12:00:00.000Z');
    clock.advance(90_000);
    expect(clock.iso()).toBe('2025-06-01T12:01:30.000Z');
  });

  it('TestLogger zbiera wpisy bez klucza data przy braku danych', () => {
    const logger = new TestLogger();
    logger.info('start');
    logger.error('pad', { code: 1 });
    expect(logger.entries).toEqual([
      { level: 'info', msg: 'start' },
      { level: 'error', msg: 'pad', data: { code: 1 } },
    ]);
    expect(logger.messages('error')).toEqual(['pad']);
  });

  it('makeFakePorts składa komplet portów i respektuje overrides', async () => {
    const fakes = makeFakePorts();
    expect(fakes.ports.scm).toBe(fakes.scm);
    expect(fakes.ports.state).toBe(fakes.state);
    expect(fakes.ports.human).toBe(fakes.human);
    expect(fakes.ports.artifacts).toBe(fakes.artifacts);
    expect(fakes.ports.clock).toBe(fakes.clock);
    expect(fakes.ports.logger).toBe(fakes.logger);
    expect(fakes.ports.secrets.get('GITHUB_TOKEN')).toBeUndefined();

    const customClock = new FixedClock('2030-01-01T00:00:00.000Z');
    const withOverride = makeFakePorts({ clock: customClock });
    expect(withOverride.ports.clock).toBe(customClock);
    expect(withOverride.ports.clock.now().getUTCFullYear()).toBe(2030);
  });
});
