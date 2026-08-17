/**
 * Rollup przebiegu (summarizeRun) - czysta funkcja licząca „gdzie jesteśmy"
 * ze stanu. Renderery postępu i raport statusu opierają na niej całą arytmetykę,
 * więc klasyfikacja statusów (passed / failed / skipped / remaining) musi być
 * twarda: każdy status pipeline'u wpada dokładnie do jednego kubełka.
 */
import { describe, expect, it } from 'vitest';
import { summarizeRun } from '../src/domain/progress.js';
import type { CaseState, CaseStatus, PipelineState } from '../src/domain/state.js';

function makeState(
  statuses: CaseStatus[],
  totals: { costUsd: number; turns: number } = { costUsd: 1.25, turns: 42 },
): PipelineState {
  const cases: Record<string, CaseState> = {};
  statuses.forEach((status, i) => {
    const caseId = `E2E-${i + 1}`;
    cases[caseId] = {
      caseId,
      status,
      priority: 'P1',
      attempts: 0,
      costUsd: 0,
      artifacts: { ledger: `cases/${caseId}/ledger.jsonl` },
    };
  });
  return {
    runId: 'r-1',
    slug: 'demo',
    planHash: 'h',
    envUrl: 'http://127.0.0.1:9',
    baseRef: 'main',
    runRef: 'x',
    createdAt: '2026-08-15T10:00:00Z',
    cases,
    totals,
  };
}

describe('summarizeRun', () => {
  it('klasyfikuje WSZYSTKIE statusy: passed / failed / skipped / w toku', () => {
    const state = makeState([
      // passed: dostarczone i dalej
      'delivered', 'in_review', 'accepted', 'released',
      // failed: zatrzymane
      'blocked', 'attempt_failed', 'failed',
      // skipped - done, ale ani passed, ani failed
      'skipped',
      // reszta = jeszcze w toku
      'pending', 'selected', 'triaged', 'authoring', 'proving', 'retry_requested',
    ]);
    const r = summarizeRun(state);

    expect(r.total).toBe(14);
    expect(r.passed).toBe(4);
    expect(r.failed).toBe(3);
    expect(r.skipped).toBe(1);
    expect(r.done).toBe(8);
    expect(r.remaining).toBe(6);
    expect(r.done + r.remaining).toBe(r.total);
  });

  it('byStatus zlicza case\'y per status (bez wpisów o zerze)', () => {
    const r = summarizeRun(makeState(['delivered', 'delivered', 'blocked', 'triaged']));
    expect(r.byStatus).toEqual({ delivered: 2, blocked: 1, triaged: 1 });
    expect(r.byStatus.failed).toBeUndefined();
    expect(r.passed).toBe(2);
    expect(r.failed).toBe(1);
    expect(r.remaining).toBe(1);
  });

  it('koszt i tury biorą się z totals przebiegu, nie z sumy case\'ów', () => {
    const r = summarizeRun(makeState(['delivered'], { costUsd: 3.5, turns: 120 }));
    expect(r.costUsd).toBe(3.5);
    expect(r.turns).toBe(120);
  });

  it('pusty przebieg: same zera, bez dzielenia przez zero', () => {
    const r = summarizeRun(makeState([], { costUsd: 0, turns: 0 }));
    expect(r).toEqual({
      total: 0, byStatus: {}, done: 0, remaining: 0,
      passed: 0, failed: 0, skipped: 0, costUsd: 0, turns: 0,
    });
  });
});
