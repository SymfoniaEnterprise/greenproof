import type { CasePriority } from './plan.js';

/** Powód zablokowania case'a - zawsze skutek uderzenia w cap albo bezpiecznik. */
export type BlockedReason =
  | 'fixture-gap' // bezpiecznik seedu: brak POM/fixture'a do dopisania przez człowieka
  | 'budget'
  | 'turns'
  | 'time'
  | 'playwright-runs'
  | 'infra' // sesja nie wystartowała - awaria backendu/bramy, nie wina case'a
  | 'other';

export type CaseStatus =
  | 'pending'
  | 'skipped' // już zaakceptowany albo draft istnieje w repo testów
  | 'selected'
  | 'triaged'
  | 'authoring'
  | 'proving'
  | 'delivered'
  | 'in_review'
  | 'retry_requested'
  | 'accepted'
  | 'released'
  | 'blocked'
  | 'attempt_failed'
  | 'failed';

export interface Lease {
  /** Identyfikator joba/procesu trzymającego lease. */
  owner: string;
  /** ISO 8601; po tym czasie lease można przejąć. */
  expiresAt: string;
}

export interface CaseArtifacts {
  /** Klucz artefaktu z draftem speca. */
  spec?: string;
  /** Klucz artefaktu z dowodem mutacyjnym. */
  proof?: string;
  /** Klucz artefaktu z ledgerem prób (jsonl). */
  ledger: string;
}

export interface CaseState {
  caseId: string;
  status: CaseStatus;
  priority: CasePriority;
  attempts: number;
  currentAttemptId?: string;
  /** Branch robocze autora: author/<case_id>. */
  branch?: string;
  blockedReason?: BlockedReason;
  /** Notatka dla człowieka przy blocked (np. opis fixture-gap). */
  blockedNote?: string;
  lease?: Lease;
  /** Uwagi człowieka z /retry - skonsumowane przez następną próbę. */
  retryNotes?: string;
  artifacts: CaseArtifacts;
  /** Suma kosztów wszystkich prób tego case'a. */
  costUsd: number;
  /** Zużyte auto-retry z puli maxAutoRetries. */
  autoRetriesUsed?: number;
  /** +1 za każdy udany fixture-author; pula ponowień POZA maxAutoRetries. */
  fixtureRetryCredits?: number;
  /** Próby przerwane jako 'infra' - nie liczą się do żadnego budżetu ponowień. */
  infraAttempts?: number;
}

export interface PipelineState {
  runId: string;
  /** Slug planu, z którego powstał run. */
  slug: string;
  /** Hash znormalizowanego planu - wykrywanie dryfu planu między komendami. */
  planHash: string;
  /** URL środowiska, na którym autor pracuje. */
  envUrl: string;
  /** Ref repo testów, z którego wychodzą branche autora. */
  baseRef: string;
  /**
   * Branch z prewencyjnymi fixture'ami (greenproof/fixtures/<runId>) wycięty z
   * baseRef. Po pierwszej sesji prewencyjnej branche case'ów wychodzą z niego.
   */
  fixturesRef?: string;
  /** Identyfikator "miejsca rozmowy" z człowiekiem (nr issue / id zadania platformy). */
  runRef: string;
  createdAt: string;
  cases: Record<string, CaseState>;
  totals: { costUsd: number; turns: number };
}

/** Dozwolone przejścia maszyny stanów - jedyne źródło prawdy. */
export const CASE_TRANSITIONS: Readonly<Record<CaseStatus, readonly CaseStatus[]>> = {
  pending: ['selected', 'skipped'],
  skipped: [],
  selected: ['triaged'],
  triaged: ['authoring'],
  authoring: ['proving', 'blocked', 'attempt_failed'],
  proving: ['delivered', 'attempt_failed'],
  delivered: ['in_review'],
  in_review: ['retry_requested', 'accepted'],
  retry_requested: ['triaged'],
  accepted: ['released'],
  released: [],
  blocked: ['triaged'], // retry po uzupełnieniu fixture'a przez człowieka
  attempt_failed: ['triaged', 'failed'],
  failed: ['triaged'], // human-retry zawsze możliwy
};

export class InvalidTransitionError extends Error {
  constructor(
    readonly caseId: string,
    readonly from: CaseStatus,
    readonly to: CaseStatus,
  ) {
    super(`Case ${caseId}: invalid transition ${from} -> ${to}`);
    this.name = 'InvalidTransitionError';
  }
}
