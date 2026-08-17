/**
 * Mutowalny stan pojedynczej sesji autora - współdzielony między hookami,
 * narzędziami procesowymi i obserwatorem wiadomości. Tu żyją liczniki capów.
 */
import type { AuthorPhase, SeedAttempt, TokenUsage } from '../domain/attempt.js';
import type { ProofMaterial } from '../domain/proof.js';
import type { BlockedReason } from '../domain/state.js';

/**
 * Jedno uruchomienie run_playwright. Każdy przebieg ma WŁASNY plik raportu -
 * współdzielony pw-report.json jest nadpisywany, więc dowód na jego ścieżce
 * ocenia nie te przebiegi.
 */
export interface PlaywrightRunRecord {
  index: number;
  phase: AuthorPhase;
  purpose: string;
  /** Ścieżka wersjonowanego raportu; puste = przebieg nie wyprodukował raportu. */
  reportPath: string;
  passed: number;
  failed: number;
  total: number;
  exitCode: number;
}

export interface FinishInfo {
  status: 'delivered' | 'blocked' | 'failed';
  specPath?: string;
  notes?: string;
  reusedPoms?: string[];
  errors?: string[];
}

export class AuthorSessionState {
  phase: AuthorPhase = 'arrange';
  /** Tura = jedna wiadomość asystenta w pętli głównej. */
  turns = 0;
  phaseStartTurn = 0;
  turnsByPhase: Record<AuthorPhase, number> = { arrange: 0, act: 0, assert: 0 };
  playwrightRunsByPhase: Record<AuthorPhase, number> = { arrange: 0, act: 0, assert: 0 };

  /** Historia przebiegów run_playwright (indeks → wersjonowany raport). */
  playwrightRuns: PlaywrightRunRecord[] = [];
  /** Przebiegi fazy assert w całości zielone (total>0 && failed===0). */
  greenRuns = 0;
  /** Zużycie OSOBNEJ puli dowodowej (odblokowanej po 2. zielonym). */
  proofRunsUsed = 0;
  /** Któraś z pul runów wyczerpana - sesja ma się zamknąć aktualnym wynikiem. */
  playwrightRunsExhausted = false;

  seedAttempts: SeedAttempt[] = [];
  seedConfirmed = false;

  /** Bezpiecznik seedu zadziałał - od teraz wolno tylko zakończyć sesję. */
  fuseTripped = false;
  fuseTrippedAtTurn?: number;
  fuseNote?: string;

  pageChangedSinceSnapshot = true;
  /** Liczba odmów/ostrzeżeń bramki snapshotów (telemetria strojenia). */
  snapshotGateHits = 0;

  /** Własny licznik kosztu (priceTable) - źródło prawdy dla capu. */
  costUsd = 0;
  tokens: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };

  filesTouched = new Set<string>();
  proofMaterial?: ProofMaterial;
  finish?: FinishInfo;

  /** Powód żądanego przerwania (interrupt) - ustawiany przez liczniki. */
  interruptReason?: BlockedReason;

  markPhase(phase: AuthorPhase): void {
    this.phase = phase;
    this.phaseStartTurn = this.turns;
  }

  get distinctFailedSeedStrategies(): number {
    return new Set(
      this.seedAttempts.filter((s) => s.outcome === 'failed').map((s) => s.strategy),
    ).size;
  }

  get turnsInArrange(): number {
    return this.turnsByPhase.arrange;
  }
}
