import { describe, expect, it } from 'vitest';
import { FixedClock } from '@greenproof/testing';
import { approveChurnEntry, detectChurnIncidents, updateLearnedChurn } from '../src/knowledge/churn.js';
import { effectiveChurnTypes, isChurnProne } from '../src/knowledge/loader.js';
import { GreenproofConfigSchema } from '../src/schemas/index.js';
import type { AttemptRecord } from '../src/domain/attempt.js';
import type { NormalizedPlan } from '../src/domain/plan.js';
import type { LearnedChurnList } from '../src/domain/knowledge.js';

const config = GreenproofConfigSchema.parse({
  platform: 'x',
  plan: { source: 'json' },
  model: { authTokenEnv: 'T', author: 'm' },
  paths: { testsRepoDir: '/tmp/x' },
  caps: { seedFuse: { churnProneTypes: ['lista-plac'], learn: 'propose', learnedEntryTtlRuns: 2 } },
});

const plan: NormalizedPlan = {
  slug: 's',
  cases: [
    { caseId: 'C-FUSE', title: '', level: 'e2e', priority: 'P1', requirements: [], flows: ['insurance/annex'], type: 'aneks-ubezpieczenia' },
    { caseId: 'C-CHEAP1', title: '', level: 'e2e', priority: 'P2', requirements: [], flows: ['a'] },
    { caseId: 'C-CHEAP2', title: '', level: 'e2e', priority: 'P2', requirements: [], flows: ['b'] },
    { caseId: 'C-COSTLY', title: '', level: 'e2e', priority: 'P2', requirements: [], flows: ['closed-list'] },
  ],
};

function attempt(caseId: string, over?: Partial<AttemptRecord>): AttemptRecord {
  return {
    attemptId: 'attempt-1',
    caseId,
    runId: 'r-1',
    startedAt: '2026-08-14T10:00:00Z',
    endedAt: '2026-08-14T10:10:00Z',
    trigger: 'initial',
    outcome: 'delivered',
    costUsd: 2,
    turns: 50,
    playwrightRuns: 3,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    phases: {},
    lastErrors: [],
    filesTouched: [],
    commits: [],
    reusedPoms: [],
    ...over,
  };
}

describe('detectChurnIncidents', () => {
  it('wykrywa fuse, serie nieudanych strategii i odstający koszt', () => {
    const ledgers = new Map<string, AttemptRecord[]>([
      ['C-FUSE', [attempt('C-FUSE', { outcome: 'blocked', blockedReason: 'fixture-gap', costUsd: 4 })]],
      ['C-CHEAP1', [attempt('C-CHEAP1', { costUsd: 2 })]],
      ['C-CHEAP2', [attempt('C-CHEAP2', { costUsd: 2 })]],
      ['C-COSTLY', [attempt('C-COSTLY', { costUsd: 9 })]],
    ]);
    const incidents = detectChurnIncidents(plan, ledgers, config, 'r-1');
    const reasons = new Map(incidents.map((i) => [i.caseId, i.reason]));
    expect(reasons.get('C-FUSE')).toBe('seed-fuse');
    expect(reasons.get('C-COSTLY')).toBe('cost-outlier');
    expect(reasons.has('C-CHEAP1')).toBe(false);
  });

  it('liczy RÓŻNE nieudane strategie ponad próg', () => {
    const seedy = attempt('C-FUSE', {
      seedAttempts: [
        { strategy: 'ui', outcome: 'failed' },
        { strategy: 'api', outcome: 'failed' },
        { strategy: 'sql', outcome: 'failed' },
        { strategy: 'sql', outcome: 'failed' },
      ],
    });
    const incidents = detectChurnIncidents(plan, new Map([['C-FUSE', [seedy]]]), config, 'r-1');
    expect(incidents[0]?.reason).toBe('failed-seed-strategies');
    expect(incidents[0]?.failedStrategies).toBe(3);
  });
});

describe('updateLearnedChurn', () => {
  const clock = new FixedClock(new Date('2026-08-14T12:00:00Z'));
  const empty: LearnedChurnList = { version: 1, entries: [] };

  it('propose: nowy wpis ma status proposed i uczy się po typie biznesowym', () => {
    const { list, added } = updateLearnedChurn(
      empty,
      [{ caseId: 'C-FUSE', runId: 'r-1', reason: 'seed-fuse' }],
      plan,
      config,
      clock,
    );
    expect(added).toHaveLength(1);
    expect(list.entries[0]!.type).toBe('aneks-ubezpieczenia');
    expect(list.entries[0]!.status).toBe('proposed');
  });

  it('auto: wpis od razu aktywny; fallback na pierwszy flow gdy brak typu', () => {
    const autoCfg = { ...config, caps: { ...config.caps, seedFuse: { ...config.caps.seedFuse, learn: 'auto' as const } } };
    const { list } = updateLearnedChurn(
      empty,
      [{ caseId: 'C-COSTLY', runId: 'r-1', reason: 'cost-outlier', costUsd: 9 }],
      plan,
      autoCfg,
      clock,
    );
    expect(list.entries[0]!.type).toBe('closed-list');
    expect(list.entries[0]!.status).toBe('active');
  });

  it('spokojne runy podbijają quietRuns i wygaszają po TTL', () => {
    const seeded: LearnedChurnList = {
      version: 1,
      entries: [
        { type: 'closed-list', evidence: { caseId: 'C', runId: 'r-0', reason: 'seed-fuse' }, addedAt: 'x', status: 'active', quietRuns: 0 },
      ],
    };
    const first = updateLearnedChurn(seeded, [], plan, config, clock);
    expect(first.list.entries[0]!.quietRuns).toBe(1);
    const second = updateLearnedChurn(first.list, [], plan, config, clock);
    expect(second.expired).toEqual(['closed-list']);
    expect(second.list.entries).toHaveLength(0);
  });

  it('incydent zeruje quietRuns istniejącego wpisu', () => {
    const seeded: LearnedChurnList = {
      version: 1,
      entries: [
        { type: 'aneks-ubezpieczenia', evidence: { caseId: 'C', runId: 'r-0', reason: 'seed-fuse' }, addedAt: 'x', status: 'active', quietRuns: 1 },
      ],
    };
    const { list, added } = updateLearnedChurn(
      seeded,
      [{ caseId: 'C-FUSE', runId: 'r-1', reason: 'seed-fuse' }],
      plan,
      config,
      clock,
    );
    expect(added).toHaveLength(0);
    expect(list.entries[0]!.quietRuns).toBe(0);
  });
});

describe('lista efektywna', () => {
  it('ręczna ∪ nauczone aktywne (proposed nie liczy się)', () => {
    const learned: LearnedChurnList = {
      version: 1,
      entries: [
        { type: 'a-active', evidence: { caseId: 'C', runId: 'r', reason: 'seed-fuse' }, addedAt: 'x', status: 'active', quietRuns: 0 },
        { type: 'b-proposed', evidence: { caseId: 'C', runId: 'r', reason: 'seed-fuse' }, addedAt: 'x', status: 'proposed', quietRuns: 0 },
      ],
    };
    const types = effectiveChurnTypes(config, learned);
    expect(types.has('lista-plac')).toBe(true);
    expect(types.has('a-active')).toBe(true);
    expect(types.has('b-proposed')).toBe(false);
  });

  it('isChurnProne dopasowuje po typie i po flow; approve aktywuje wpis', () => {
    const types = new Set(['lista-plac']);
    expect(isChurnProne(types, { type: 'lista-plac', flows: [] })).toBe(true);
    expect(isChurnProne(types, { flows: ['lista-plac'] })).toBe(true);
    expect(isChurnProne(types, { flows: ['inne'] })).toBe(false);

    const learned: LearnedChurnList = {
      version: 1,
      entries: [{ type: 'x', evidence: { caseId: 'C', runId: 'r', reason: 'seed-fuse' }, addedAt: 'a', status: 'proposed', quietRuns: 0 }],
    };
    expect(approveChurnEntry(learned, 'x').entries[0]!.status).toBe('active');
  });
});
