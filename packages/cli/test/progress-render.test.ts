/**
 * Renderery postępu plain/github/json - format linii, throttle turn,
 * grupy GitHub i Job Summary, NDJSON.
 */
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { ProgressEvent, RunRollup } from '@greenproof/core';
import { cleanupTmp, tmpDir } from './helpers.js';
import { createPlainRenderer } from '../src/progress/plain.js';
import { createGithubRenderer } from '../src/progress/github.js';
import { createJsonRenderer } from '../src/progress/json.js';
import type { RendererIo } from '../src/progress/types.js';

afterAll(cleanupTmp);

/* ------------------------------------------------ helpery io + zdarzenia */

interface BufferedIo {
  io: RendererIo;
  buffer: () => string;
  lines: () => string[];
  advanceMs: (ms: number) => void;
}

function makeIo(env: Record<string, string | undefined> = {}): BufferedIo {
  const chunks: string[] = [];
  let nowMs = Date.UTC(2026, 0, 1, 10, 41, 0);
  return {
    io: {
      write: (chunk: string) => void chunks.push(chunk),
      env,
      isTTY: false,
      now: () => new Date(nowMs),
    },
    buffer: () => chunks.join(''),
    lines: () => chunks.join('').split('\n').filter((l) => l.length > 0),
    advanceMs: (ms: number) => void (nowMs += ms),
  };
}

function rollup(partial: Partial<RunRollup>): RunRollup {
  return {
    total: 10,
    byStatus: {},
    done: 3,
    remaining: 7,
    passed: 2,
    failed: 1,
    skipped: 0,
    costUsd: 1.84,
    turns: 212,
    ...partial,
  };
}

const AT = '2026-01-01T10:41:00.000Z';

function caseStart(): ProgressEvent {
  return {
    kind: 'case-start',
    runId: 'gp-42',
    at: AT,
    caseId: 'UC-3',
    attempt: 2,
    model: 'deepseek-chat',
    caps: { maxTurns: 1000, maxTimeMinutes: 30, maxCostUsd: 6, maxPlaywrightRuns: 6, proofRuns: 4 },
    rollup: rollup({}),
  };
}

function turn(turns: number): ProgressEvent {
  return {
    kind: 'turn',
    runId: 'gp-42',
    at: AT,
    caseId: 'UC-3',
    attempt: 2,
    phase: 'assert',
    turns,
    maxTurns: 1000,
    elapsedSec: 372,
    maxTimeSec: 1800,
    costUsd: 0.42,
    maxCostUsd: 6,
    pw: { assertUsed: 3, assertMax: 6, proofUsed: 0, proofMax: 4, greenRuns: 1 },
  };
}

function pwRun(): ProgressEvent {
  return {
    kind: 'playwright-run',
    runId: 'gp-42',
    at: AT,
    caseId: 'UC-3',
    attempt: 2,
    runIndex: 3,
    purpose: 'green',
    pool: 'assert',
    passed: 5,
    failed: 1,
    total: 6,
    pw: { assertUsed: 3, assertMax: 6, proofUsed: 0, proofMax: 4, greenRuns: 1 },
  };
}

function caseEnd(status: 'delivered' | 'blocked' = 'delivered'): ProgressEvent {
  return {
    kind: 'case-end',
    runId: 'gp-42',
    at: AT,
    caseId: 'UC-3',
    attempt: 2,
    status,
    ...(status === 'blocked' ? { blockedReason: 'fixture-gap' as const } : {}),
    costUsd: 0.58,
    turns: 19,
    rollup: rollup({ done: 4, remaining: 6, passed: 3 }),
  };
}

/* ------------------------------------------------------------------ plain */

describe('createPlainRenderer', () => {
  it('sekwencja case-start → 3×turn (10 s odstępu) → playwright-run → case-end', () => {
    const { io, buffer, lines, advanceMs } = makeIo();
    const r = createPlainRenderer(io);

    r.onEvent(caseStart());
    r.onEvent(turn(14));
    advanceMs(10_000);
    r.onEvent(turn(15));
    advanceMs(10_000);
    r.onEvent(turn(16));
    r.onEvent(pwRun());
    r.onEvent(caseEnd('delivered'));
    r.finalize();

    // Throttle 30 s: tylko pierwsza tura wypisana.
    const turnLines = lines().filter((l) => l.includes('tura '));
    expect(turnLines).toHaveLength(1);
    expect(turnLines[0]).toContain('UC-3 próba 2 · assert · tura 14/1000 · $0.42/$6.00 · pw 3/6+0/4');

    expect(buffer()).toContain('▶ UC-3 próba 2 · start (model: deepseek-chat) · run 3/10 (2✓ 1✗)');
    expect(buffer()).toContain('playwright #3 (green, pula assert) → 5 passed / 1 failed');
    expect(buffer()).toContain('✓ UC-3 delivered · $0.58 · 19 tur · run 4/10 (3✓ 1✗)');
  });

  it('turn po >30 s od poprzedniej wypisanej linii przechodzi przez throttle', () => {
    const { io, lines, advanceMs } = makeIo();
    const r = createPlainRenderer(io);

    r.onEvent(turn(14));
    advanceMs(31_000);
    r.onEvent(turn(20));

    expect(lines().filter((l) => l.includes('tura '))).toHaveLength(2);
  });

  it('case-end z blocked pokazuje ✗ i blockedReason', () => {
    const { io, buffer } = makeIo();
    const r = createPlainRenderer(io);

    r.onEvent(caseEnd('blocked'));

    expect(buffer()).toContain('✗ UC-3 blocked (fixture-gap)');
  });

  it('step daje pojedynczą linię', () => {
    const { io, buffer } = makeIo();
    const r = createPlainRenderer(io);

    r.onEvent({ kind: 'step', runId: 'gp-42', at: AT, name: 'filter', phase: 'start' });

    expect(buffer()).toContain('krok filter - start');
  });
});

/* ----------------------------------------------------------------- github */

describe('createGithubRenderer', () => {
  it('opina case w ::group:: i dopisuje Job Summary na finalize', async () => {
    const dir = await tmpDir('gp-ghsum-');
    const summaryPath = join(dir, 'summary.md');
    const { io, buffer } = makeIo({ GITHUB_STEP_SUMMARY: summaryPath });
    const r = createGithubRenderer(io);

    r.onEvent(caseStart());
    r.onEvent(turn(14));
    r.onEvent(caseEnd('delivered'));
    r.finalize();

    const out = buffer();
    expect(out).toContain('::group::case UC-3 (próba 2)');
    expect(out).toContain('::endgroup::');
    // Grupa otwarta przed linią case-start, zamknięta po linii case-end.
    expect(out.indexOf('::group::')).toBeLessThan(out.indexOf('▶ UC-3'));
    expect(out.indexOf('✓ UC-3')).toBeLessThan(out.indexOf('::endgroup::'));

    const md = await readFile(summaryPath, 'utf8');
    expect(md).toContain('### greenproof - gp-42');
    expect(md).toContain('| UC-3 | ✅ delivered | $0.58 | 19 |');
    expect(md).toContain('**Razem:** 4/10 done · 3✓ · 1✗ · $1.84');
  });

  it('niezapisywalna ścieżka Job Summary nie wywala finalize (best-effort)', () => {
    const { io, buffer } = makeIo({ GITHUB_STEP_SUMMARY: '/nie-ma/takiego/katalogu/summary.md' });
    const r = createGithubRenderer(io);
    r.onEvent(caseEnd('delivered'));

    expect(() => r.finalize()).not.toThrow();
    expect(buffer()).toContain('Job Summary');
  });

  it('bez GITHUB_STEP_SUMMARY nie tworzy pliku podsumowania', async () => {
    const dir = await tmpDir('gp-ghsum-');
    const summaryPath = join(dir, 'summary.md');
    const { io } = makeIo();
    const r = createGithubRenderer(io);

    r.onEvent(caseEnd('delivered'));
    r.finalize();

    expect(existsSync(summaryPath)).toBe(false);
  });
});

/* ------------------------------------------------------------------- json */

describe('createJsonRenderer', () => {
  it('każde zdarzenie to jedna parsowalna linia NDJSON', () => {
    const { io, lines } = makeIo();
    const r = createJsonRenderer(io);
    const evs = [caseStart(), turn(14), pwRun(), caseEnd('delivered')];
    for (const e of evs) r.onEvent(e);
    r.printAbove('greenproof warn: coś');
    r.finalize();

    const parsed = lines().map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(parsed).toHaveLength(evs.length + 1);
    expect(parsed[0]?.['kind']).toBe('case-start');
    expect(parsed[3]?.['kind']).toBe('case-end');
    expect(parsed[4]).toEqual({ kind: 'log', line: 'greenproof warn: coś' });
  });
});

