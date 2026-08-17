import { describe, expect, it } from 'vitest';
import { FixedClock } from '@greenproof/testing';
import {
  acquireLease,
  casesInStatus,
  hasExpiredLease,
  initPipelineState,
  LeaseHeldError,
  releaseLease,
  transitionCase,
} from '../src/machine/pipeline.js';
import { InvalidTransitionError, CASE_TRANSITIONS } from '../src/domain/state.js';
import type { NormalizedPlan } from '../src/domain/plan.js';

const plan: NormalizedPlan = {
  slug: 'demo',
  cases: [
    {
      caseId: 'C-1',
      title: 'test',
      level: 'e2e',
      priority: 'P0',
      requirements: ['AC-1'],
      flows: ['payroll'],
    },
  ],
};

function freshState(clock = new FixedClock(new Date('2026-08-14T10:00:00Z'))) {
  return initPipelineState(
    plan,
    { runId: 'r-1', envUrl: 'https://demo.local', baseRef: 'main', runRef: '42' },
    clock,
  );
}

describe('maszyna stanów', () => {
  it('szczęśliwa ścieżka przechodzi wszystkie stany', () => {
    const s = freshState();
    for (const to of ['selected', 'triaged', 'authoring', 'proving', 'delivered', 'in_review', 'accepted', 'released'] as const) {
      transitionCase(s, 'C-1', to);
    }
    expect(s.cases['C-1']!.status).toBe('released');
  });

  it('nielegalne przejście rzuca InvalidTransitionError', () => {
    const s = freshState();
    expect(() => transitionCase(s, 'C-1', 'released')).toThrow(InvalidTransitionError);
  });

  it('released i skipped są stanami końcowymi', () => {
    expect(CASE_TRANSITIONS.released).toEqual([]);
    expect(CASE_TRANSITIONS.skipped).toEqual([]);
  });

  it('blocked można ponowić (→ triaged)', () => {
    const s = freshState();
    transitionCase(s, 'C-1', 'selected');
    transitionCase(s, 'C-1', 'triaged');
    transitionCase(s, 'C-1', 'authoring');
    transitionCase(s, 'C-1', 'blocked', { blockedReason: 'fixture-gap' });
    transitionCase(s, 'C-1', 'triaged');
    expect(s.cases['C-1']!.status).toBe('triaged');
  });
});

describe('lease', () => {
  it('cudzy aktywny lease blokuje', () => {
    const clock = new FixedClock(new Date('2026-08-14T10:00:00Z'));
    const s = freshState(clock);
    acquireLease(s, 'C-1', 'job-A', 45, clock);
    expect(() => acquireLease(s, 'C-1', 'job-B', 45, clock)).toThrow(LeaseHeldError);
  });

  it('wygasły lease jest przejmowany, a case w pracy wraca do triaged', () => {
    const clock = new FixedClock(new Date('2026-08-14T10:00:00Z'));
    const s = freshState(clock);
    transitionCase(s, 'C-1', 'selected');
    transitionCase(s, 'C-1', 'triaged');
    acquireLease(s, 'C-1', 'job-A', 45, clock);
    transitionCase(s, 'C-1', 'authoring');
    clock.advance(46 * 60_000);
    expect(hasExpiredLease(s.cases['C-1']!, clock)).toBe(true);
    const { reclaimed } = acquireLease(s, 'C-1', 'job-B', 45, clock);
    expect(reclaimed).toBe(true);
    expect(s.cases['C-1']!.status).toBe('triaged');
    expect(s.cases['C-1']!.lease?.owner).toBe('job-B');
  });

  it('releaseLease usuwa lease', () => {
    const clock = new FixedClock(new Date('2026-08-14T10:00:00Z'));
    const s = freshState(clock);
    acquireLease(s, 'C-1', 'job-A', 45, clock);
    releaseLease(s, 'C-1');
    expect(s.cases['C-1']!.lease).toBeUndefined();
  });
});

describe('casesInStatus', () => {
  it('filtruje po wielu statusach', () => {
    const s = freshState();
    expect(casesInStatus(s, 'pending')).toHaveLength(1);
    expect(casesInStatus(s, 'released', 'pending')).toHaveLength(1);
    expect(casesInStatus(s, 'released')).toHaveLength(0);
  });
});
