/**
 * greenproof stats - per-case rollup z ledgerów prób (read-only). Sprawdza
 * sumowanie prób/tokenów, unikalne reusedPoms + ranking, case bez ledgera,
 * zgodność summary z summarizeRun oraz rozjazd costUsd ledger vs stan.
 */
import { describe, expect, it } from 'vitest';
import { makeFakePorts } from '@greenproof/testing';
import { runFilter } from '../src/steps/filter.js';
import { runStats } from '../src/steps/stats.js';
import { appendAttempt } from '../src/ledger/store.js';
import { transitionCase } from '../src/machine/pipeline.js';
import { summarizeRun } from '../src/domain/progress.js';
import { GreenproofConfigSchema } from '../src/schemas/index.js';
import type { NormalizedPlan } from '../src/domain/plan.js';
import type { AttemptRecord } from '../src/domain/attempt.js';

const config = GreenproofConfigSchema.parse({
  platform: 'fake',
  plan: { source: 'json' },
  model: { authTokenEnv: 'T', author: 'm' },
  paths: { testsRepoDir: '/tmp/x' },
});

const plan: NormalizedPlan = {
  slug: 'stats',
  cases: [
    { caseId: 'A', title: 'a', level: 'e2e', priority: 'P1', requirements: [], flows: [], type: 't' },
    { caseId: 'B', title: 'b', level: 'e2e', priority: 'P1', requirements: [], flows: [], type: 't' },
    { caseId: 'C', title: 'c', level: 'e2e', priority: 'P1', requirements: [], flows: [], type: 't' },
  ],
};

function attempt(partial: Partial<AttemptRecord> & { attemptId: string; caseId: string }): AttemptRecord {
  return {
    runId: 'r-st',
    startedAt: '2026-08-14T10:00:00Z',
    endedAt: '2026-08-14T10:20:00Z',
    trigger: 'initial',
    outcome: 'delivered',
    costUsd: 0,
    turns: 0,
    playwrightRuns: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    phases: {},
    lastErrors: [],
    filesTouched: [],
    commits: [],
    reusedPoms: [],
    ...partial,
  };
}

async function setup() {
  const f = makeFakePorts();
  f.scm.seedBranch('main', {});
  await runFilter(f.ports, config, {
    runId: 'r-st',
    envUrl: 'http://127.0.0.1:9',
    ref: 'main',
    runRef: 'x',
    plan,
  });

  // A: dwie próby (attempt_failed → delivered), reużywa PayrollPage dwukrotnie.
  await appendAttempt(f.artifacts, 'r-st', attempt({
    attemptId: 'a-1', caseId: 'A',
    outcome: 'attempt_failed',
    turns: 10, playwrightRuns: 1, costUsd: 0.5,
    tokens: { input: 100, output: 20, cacheRead: 0, cacheCreation: 0 },
    reusedPoms: ['PayrollPage', 'LoginPage'],
  }));
  await appendAttempt(f.artifacts, 'r-st', attempt({
    attemptId: 'a-2', caseId: 'A',
    outcome: 'delivered',
    turns: 15, playwrightRuns: 2, proofRuns: 1, costUsd: 1.0,
    tokens: { input: 200, output: 40, cacheRead: 5, cacheCreation: 10 },
    reusedPoms: ['PayrollPage'],
  }));

  // B: jedna próba zablokowana z powodem budżetu.
  await appendAttempt(f.artifacts, 'r-st', attempt({
    attemptId: 'b-1', caseId: 'B',
    outcome: 'blocked', blockedReason: 'budget',
    turns: 5, playwrightRuns: 1, costUsd: 0.2,
    tokens: { input: 50, output: 10, cacheRead: 0, cacheCreation: 0 },
    reusedPoms: ['PayrollPage'],
  }));

  const loaded = await f.state.load('r-st');
  const state = loaded!.state;

  transitionCase(state, 'A', 'triaged');
  transitionCase(state, 'A', 'authoring', { branch: 'author/A' });
  transitionCase(state, 'A', 'proving');
  transitionCase(state, 'A', 'delivered', { attempts: 2, costUsd: 1.5 });

  transitionCase(state, 'B', 'triaged');
  transitionCase(state, 'B', 'authoring', { branch: 'author/B' });
  transitionCase(state, 'B', 'blocked', { blockedReason: 'budget', costUsd: 0.2 });

  // C zostaje selected - bez ledgera.

  // Sesje fixture podbijają koszt w stanie, ale nie w ledgerach case'ów.
  state.totals = { costUsd: 2.2, turns: 30 };
  await f.state.save('r-st', state, loaded!.version);

  return f;
}

describe('runStats', () => {
  it('sumuje próby, tury, runy (w tym proof) i tokeny po case\'ach', async () => {
    const f = await setup();
    const res = await runStats(f.ports, config, { runId: 'r-st' });

    const a = res.cases.find((c) => c.caseId === 'A')!;
    expect(a.attempts).toBe(2);
    expect(a.turns).toBe(25);
    expect(a.playwrightRuns).toBe(3);
    expect(a.proofRuns).toBe(1);
    expect(a.costUsd).toBe(1.5);
    expect(a.tokens).toEqual({ input: 300, output: 60, cacheRead: 5, cacheCreation: 10 });
    expect(a.outcomes).toEqual(['attempt_failed', 'delivered']);
    expect(a.lastOutcome).toBe('delivered');
    expect(a.branch).toBe('author/A');

    const b = res.cases.find((c) => c.caseId === 'B')!;
    expect(b.attempts).toBe(1);
    expect(b.blockedReason).toBe('budget');
    expect(b.lastOutcome).toBe('blocked');

    expect(res.totals.attempts).toBe(3);
    expect(res.totals.turns).toBe(30);
    expect(res.totals.playwrightRuns).toBe(4);
    expect(res.totals.proofRuns).toBe(1);
    expect(res.totals.costUsd).toBe(1.7);
    expect(res.totals.tokens).toEqual({ input: 350, output: 70, cacheRead: 5, cacheCreation: 10 });
  });

  it('unikalne reusedPoms w kolejności pierwszego użycia + ranking malejąco', async () => {
    const f = await setup();
    const res = await runStats(f.ports, config, { runId: 'r-st' });

    const a = res.cases.find((c) => c.caseId === 'A')!;
    expect(a.reusedPoms).toEqual(['PayrollPage', 'LoginPage']);

    expect(res.totals.reusedPomsTop).toEqual([
      { name: 'PayrollPage', count: 2 },
      { name: 'LoginPage', count: 1 },
    ]);
  });

  it('case bez ledgera = same zera i pusta lista prób (nie wyjątek)', async () => {
    const f = await setup();
    const res = await runStats(f.ports, config, { runId: 'r-st' });

    const c = res.cases.find((cs) => cs.caseId === 'C')!;
    expect(c.status).toBe('selected');
    expect(c.attempts).toBe(0);
    expect(c.turns).toBe(0);
    expect(c.playwrightRuns).toBe(0);
    expect(c.proofRuns).toBe(0);
    expect(c.costUsd).toBe(0);
    expect(c.reusedPoms).toEqual([]);
    expect(c.outcomes).toEqual([]);
    expect(c.lastOutcome).toBeUndefined();
  });

  it('summary reużywa summarizeRun (zgodność 1:1)', async () => {
    const f = await setup();
    const res = await runStats(f.ports, config, { runId: 'r-st' });

    const loaded = await f.state.load('r-st');
    expect(res.summary).toEqual(summarizeRun(loaded!.state));
  });

  it('rozjazd costUsd: ledger (próby) vs stan (z sesjami fixture) jest widoczny', async () => {
    const f = await setup();
    const res = await runStats(f.ports, config, { runId: 'r-st' });

    expect(res.totals.costUsd).toBe(1.7);
    expect(res.totals.costUsdState).toBe(2.2);
    expect(res.totals.costUsd).not.toBe(res.totals.costUsdState);
  });

  it('nieistniejący run → RunNotFoundError', async () => {
    const f = await setup();
    await expect(runStats(f.ports, config, { runId: 'r-nie-ma' })).rejects.toThrow();
  });
});
