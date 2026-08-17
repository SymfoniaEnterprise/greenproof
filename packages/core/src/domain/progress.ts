/**
 * Strumień postępu dla hosta (CLI/CI). Core tylko emituje przez `Ports.progress`;
 * renderowanie (TTY/plain/GitHub/NDJSON) to sprawa hosta. Emiter nie throttluje.
 */
import type { BlockedReason, CaseStatus, PipelineState } from './state.js';

/** Zbiorczy obraz runu policzony ze stanu - reużywany przez status i eventy. */
export interface RunRollup {
  /** Liczba wszystkich case'ów w stanie runu. */
  total: number;
  byStatus: Partial<Record<CaseStatus, number>>;
  /** Case'y zakończone (sukcesem lub porażką) - total - remaining. */
  done: number;
  /** Case'y jeszcze niedokończone (pending/selected/triaged/authoring/proving/…). */
  remaining: number;
  /** Dostarczone lub dalej: delivered / in_review / accepted / released. */
  passed: number;
  /** Zatrzymane: blocked / attempt_failed / failed. */
  failed: number;
  /** Pominięte (skipped) - poza passed/failed, ale liczone jako done. */
  skipped: number;
  costUsd: number;
  turns: number;
}

const PASSED_STATUSES: readonly CaseStatus[] = ['delivered', 'in_review', 'accepted', 'released'];
const FAILED_STATUSES: readonly CaseStatus[] = ['blocked', 'attempt_failed', 'failed'];

/** Czysta funkcja: rollup liczników ze stanu pipeline'u. */
export function summarizeRun(state: PipelineState): RunRollup {
  const byStatus: Partial<Record<CaseStatus, number>> = {};
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  const cases = Object.values(state.cases);
  for (const cs of cases) {
    byStatus[cs.status] = (byStatus[cs.status] ?? 0) + 1;
    if (PASSED_STATUSES.includes(cs.status)) passed += 1;
    else if (FAILED_STATUSES.includes(cs.status)) failed += 1;
    else if (cs.status === 'skipped') skipped += 1;
  }
  const done = passed + failed + skipped;
  return {
    total: cases.length,
    byStatus,
    done,
    remaining: cases.length - done,
    passed,
    failed,
    skipped,
    costUsd: state.totals.costUsd,
    turns: state.totals.turns,
  };
}

/** Migawka capów sesji - renderer pokazuje zużycie vs limit bez znajomości configu. */
export interface ProgressCaps {
  maxTurns: number;
  maxTimeMinutes: number;
  maxCostUsd: number;
  maxPlaywrightRuns: number;
  proofRuns: number;
}

/** Stan pul playwright w trakcie sesji (assert + proof). */
export interface ProgressPlaywright {
  assertUsed: number;
  assertMax: number;
  proofUsed: number;
  proofMax: number;
  greenRuns: number;
}

interface ProgressEventBase {
  runId: string;
  /** ISO 8601 - od zegara portu (`ports.clock`), nie od ściany renderera. */
  at: string;
}

/** Grube kamienie milowe komend/kroków (filter, triage, prewencja per typ, deliver…). */
export interface StepProgressEvent extends ProgressEventBase {
  kind: 'step';
  name: string;
  phase: 'start' | 'end';
  note?: string;
}

/** Start sesji autora dla case'a (po triażu, przed pierwszą turą). */
export interface CaseStartProgressEvent extends ProgressEventBase {
  kind: 'case-start';
  caseId: string;
  attempt: number;
  /** Identyfikator modelu sesji (informacyjny - core nie interpretuje). */
  model?: string;
  caps: ProgressCaps;
  rollup: RunRollup;
}

/** Jedna tura sesji (author lub fixture) - emitowana per assistant message. */
export interface TurnProgressEvent extends ProgressEventBase {
  kind: 'turn';
  caseId: string;
  attempt: number;
  /** 'arrange' | 'act' | 'assert' dla autora; 'fixture' dla sesji fixture. */
  phase: string;
  turns: number;
  maxTurns: number;
  elapsedSec: number;
  maxTimeSec: number;
  costUsd: number;
  maxCostUsd: number;
  pw?: ProgressPlaywright;
  /** Krótki opis ostatniego zdarzenia (np. "run_playwright #3 (green) → 5/6"). */
  lastEvent?: string;
}

/** Wynik pojedynczego runu playwright z narzędzia run_playwright. */
export interface PlaywrightRunProgressEvent extends ProgressEventBase {
  kind: 'playwright-run';
  caseId: string;
  attempt: number;
  runIndex: number;
  purpose: string;
  pool: 'assert' | 'proof';
  passed: number;
  failed: number;
  total: number;
  pw: ProgressPlaywright;
}

/** Koniec pracy nad case'em w tej próbie (po klasyfikacji i zapisie stanu). */
export interface CaseEndProgressEvent extends ProgressEventBase {
  kind: 'case-end';
  caseId: string;
  attempt: number;
  status: CaseStatus;
  blockedReason?: BlockedReason;
  costUsd: number;
  turns: number;
  rollup: RunRollup;
}

export type ProgressEvent =
  | StepProgressEvent
  | CaseStartProgressEvent
  | TurnProgressEvent
  | PlaywrightRunProgressEvent
  | CaseEndProgressEvent;

/** Odbiornik zdarzeń postępu - MUSI być odporny (wyjątek nie może zabić sesji). */
export type ProgressSink = (event: ProgressEvent) => void;

/** Bezpieczna emisja - awaria renderera nigdy nie przerywa pipeline'u. */
export function emitProgress(sink: ProgressSink | undefined, event: ProgressEvent): void {
  if (!sink) return;
  try {
    sink(event);
  } catch {
    // celowo połknięte - postęp jest best-effort
  }
}
