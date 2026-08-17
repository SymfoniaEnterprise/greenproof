/**
 * STATS - per-case rollup Z LEDGERÓW prób (read-only). Uzupełnienie `status`
 * (rollup ze stanu) o liczby, które żyją wyłącznie w ledgerze: tury, runy
 * playwright (w tym osobna pula dowodowa), koszt, reużyte POM-y, sekwencja
 * wyników prób i powód blokady. Wsad do raportów z benchmarków i CI.
 *
 * Czysty odczyt - nie mutuje pipeline'u i nie używa withState.
 */
import type { GreenproofConfig } from '../config/types.js';
import type { AttemptOutcome, AttemptRecord, TokenUsage } from '../domain/attempt.js';
import type { RunRollup } from '../domain/progress.js';
import { summarizeRun } from '../domain/progress.js';
import type { BlockedReason, CaseState, CaseStatus } from '../domain/state.js';
import { RunNotFoundError } from '../machine/withState.js';
import { readLedger } from '../ledger/store.js';
import type { Ports } from '../ports/index.js';

export interface StatsParams {
  runId: string;
}

export interface CaseStats {
  caseId: string;
  status: CaseStatus;
  blockedReason?: BlockedReason;
  /** Liczba prób = liczba wpisów w ledgerze (case bez ledgera = 0). */
  attempts: number;
  turns: number;
  playwrightRuns: number;
  /** Runy z OSOBNEJ puli dowodowej (telemetria strojenia capów). */
  proofRuns: number;
  /** Suma costUsd prób z ledgera (bez sesji fixture). */
  costUsd: number;
  /** Unikalne nazwy POM-ów/fixture'ów, w kolejności pierwszego użycia. */
  reusedPoms: string[];
  /** Suma tokenów wszystkich prób. */
  tokens: TokenUsage;
  /** Wyniki prób po kolei (puste dla case'a bez ledgera). */
  outcomes: AttemptOutcome[];
  lastOutcome?: AttemptOutcome;
  branch?: string;
}

export interface PomsTopEntry {
  name: string;
  count: number;
}

export interface StatsTotals {
  attempts: number;
  turns: number;
  playwrightRuns: number;
  proofRuns: number;
  /** Suma costUsd po ledgerach prób. */
  costUsd: number;
  /**
   * Koszt ze stanu - do sumy runu wchodzą sesje fixture, więc rozjazd między
   * costUsd (ledger) a costUsdState (stan) jest normalny i celowo widoczny.
   */
  costUsdState: number;
  tokens: TokenUsage;
  /** Telemetria wartości harvestu: ile case'ów reużyło dany POM (malejąco). */
  reusedPomsTop: PomsTopEntry[];
}

export interface StatsResult {
  runId: string;
  summary: RunRollup;
  cases: CaseStats[];
  totals: StatsTotals;
}

const ZERO_TOKENS: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };

function addTokens(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheCreation: a.cacheCreation + b.cacheCreation,
  };
}

export async function runStats(
  ports: Ports,
  config: GreenproofConfig,
  params: StatsParams,
): Promise<StatsResult> {
  void config; // API symetryczne z innymi krokami (deliver/author) - stats configu nie używa.
  const loaded = await ports.state.load(params.runId);
  if (!loaded) throw new RunNotFoundError(params.runId);
  const state = loaded.state;

  const totals: StatsTotals = {
    attempts: 0,
    turns: 0,
    playwrightRuns: 0,
    proofRuns: 0,
    costUsd: 0,
    costUsdState: state.totals.costUsd,
    tokens: { ...ZERO_TOKENS },
    reusedPomsTop: [],
  };

  const cases: CaseStats[] = [];
  const pomCounts = new Map<string, number>();
  for (const cs of Object.values(state.cases)) {
    const ledger = await readLedger(ports.artifacts, params.runId, cs.caseId);
    const stats = rollupCase(cs, ledger);
    cases.push(stats);

    totals.attempts += stats.attempts;
    totals.turns += stats.turns;
    totals.playwrightRuns += stats.playwrightRuns;
    totals.proofRuns += stats.proofRuns;
    totals.costUsd += stats.costUsd;
    totals.tokens = addTokens(totals.tokens, stats.tokens);
    for (const name of stats.reusedPoms) {
      pomCounts.set(name, (pomCounts.get(name) ?? 0) + 1);
    }
  }

  totals.reusedPomsTop = [...pomCounts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  return { runId: params.runId, summary: summarizeRun(state), cases, totals };
}

/** Rollup jednego case'a z jego ledgera (case bez ledgera = same zera). */
function rollupCase(cs: CaseState, ledger: AttemptRecord[]): CaseStats {
  let turns = 0;
  let playwrightRuns = 0;
  let proofRuns = 0;
  let costUsd = 0;
  let tokens: TokenUsage = { ...ZERO_TOKENS };
  let lastOutcome: AttemptOutcome | undefined;
  const outcomes: AttemptOutcome[] = [];
  const reused: string[] = [];
  const seen = new Set<string>();

  for (const attempt of ledger) {
    turns += attempt.turns;
    playwrightRuns += attempt.playwrightRuns;
    proofRuns += attempt.proofRuns ?? 0;
    costUsd += attempt.costUsd;
    tokens = addTokens(tokens, attempt.tokens);
    lastOutcome = attempt.outcome;
    outcomes.push(attempt.outcome);
    for (const name of attempt.reusedPoms) {
      if (!seen.has(name)) {
        seen.add(name);
        reused.push(name);
      }
    }
  }

  return {
    caseId: cs.caseId,
    status: cs.status,
    ...(cs.blockedReason !== undefined ? { blockedReason: cs.blockedReason } : {}),
    attempts: ledger.length,
    turns,
    playwrightRuns,
    proofRuns,
    costUsd,
    reusedPoms: reused,
    tokens,
    outcomes,
    ...(lastOutcome !== undefined ? { lastOutcome } : {}),
    ...(cs.branch !== undefined ? { branch: cs.branch } : {}),
  };
}
