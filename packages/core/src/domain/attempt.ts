import type { BlockedReason } from './state.js';

export type AttemptTrigger = 'initial' | 'auto-retry' | 'human-retry';

export type AttemptOutcome = 'delivered' | 'blocked' | 'attempt_failed' | 'interrupted';

export type AuthorPhase = 'arrange' | 'act' | 'assert';

export interface PhaseStats {
  turns: number;
  playwrightRuns: number;
}

export interface SeedAttempt {
  strategy: string;
  outcome: 'ok' | 'failed';
  note?: string;
}

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

/** Wpis ledgera prób (cases/<caseId>/ledger.jsonl) - pełna pamięć o próbie. */
export interface AttemptRecord {
  attemptId: string;
  caseId: string;
  runId: string;
  startedAt: string;
  endedAt: string;
  trigger: AttemptTrigger;
  /** Uwagi testerki przekazane przy human-retry. */
  humanNotes?: string;
  outcome: AttemptOutcome;
  blockedReason?: BlockedReason;
  costUsd: number;
  turns: number;
  playwrightRuns: number;
  /** Ile runów poszło z OSOBNEJ puli dowodowej (telemetria strojenia capów). */
  proofRuns?: number;
  tokens: TokenUsage;
  phases: Partial<Record<AuthorPhase, PhaseStats>>;
  seedAttempts?: SeedAttempt[];
  /** Ekstrakt ostatnich błędów asercji/stacktrace z raportów Playwrighta. */
  lastErrors: string[];
  filesTouched: string[];
  commits: string[];
  /** Nazwy POM-ów/fixture'ów reużytych w tej próbie (telemetria wartości harvestu). */
  reusedPoms: string[];
  /** Strukturalny wynik sesji agenta (outputFormat json_schema). */
  agentResult?: unknown;
  /** Skondensowane wnioski - wejście do promptu następnej próby. */
  digest?: string;
  /** Klucz artefaktu z pełnym transcriptem sesji. */
  transcriptKey?: string;
}
