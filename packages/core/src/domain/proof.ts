/**
 * Dowód mutacyjny - kontrola, że zielony przebieg nie jest fałszywy.
 * Materiał zbiera agent; werdykt wydaje deterministyczny walidator w core.
 */

export type FailureKind = 'own-assertion' | 'timeout' | 'infra' | 'other';

/** Streszczenie pojedynczego uruchomienia `playwright test` (z raportu --reporter=json). */
export interface RunSummary {
  /** Ścieżka pliku spec + tytuł testu, np. "payroll.spec.ts::tworzy listę płac". */
  testId: string;
  status: 'passed' | 'failed';
  durationMs?: number;
  /** Pełny komunikat błędu pierwszej porażki (jeśli failed). */
  errorMessage?: string;
}

export interface MutationInfo {
  /** Co zostało celowo zepsute (opis dla człowieka). */
  description: string;
  /** Diff mutacji (unified). */
  diff: string;
  /** Warunek, który spec weryfikuje i który mutacja psuje. */
  targetCondition: string;
}

export interface RedRunAnalysis extends RunSummary {
  failedInSameTest: boolean;
  /** Klasyfikacja rodzaju porażki - 'own-assertion' jest jedyną akceptowaną. */
  failureKind: FailureKind;
  /** Wyekstrahowany komunikat asercji. */
  assertionMessage?: string;
}

export interface MutationProof {
  caseId: string;
  attemptId: string;
  /** Zielone przebiegi wymagane przed dowodem. */
  greenRuns: [RunSummary, RunSummary];
  mutation: MutationInfo;
  redRun: RedRunAnalysis;
  restored: {
    /** Czy agent zadeklarował przywrócenie. */
    verified: boolean;
    /** Czy `git diff` względem commita sprzed mutacji jest pusty (sprawdzane przez core). */
    gitDiffEmpty: boolean;
  };
  verdict: 'valid' | 'invalid';
  /** Powody werdyktu invalid (puste przy valid). */
  reasons: string[];
  /**
   * Zastrzeżenia nieunieważniające dowodu - do raportu i oczy człowieka przy
   * `accept`. Sygnały jakościowe nierozstrzygalne mechanicznie; twarde
   * odrzucanie dawało fałszywe negatywy.
   */
  warnings: string[];
}

/** Surowiec dowodu przekazywany przez agenta (record_proof_material) - przed walidacją. */
export interface ProofMaterial {
  /** Raporty JSON Playwrighta (surowe stringi) dwóch zielonych przebiegów. */
  greenRunReports: [string, string];
  mutation: MutationInfo;
  /** Raport JSON Playwrighta czerwonego przebiegu. */
  redRunReport: string;
  /**
   * Test dowodowy - pełny `plik::tytuł` albo fragment tytułu jednoznacznie
   * wskazujący jeden test. Pominięty = walidator bierze pierwszy przechodzący
   * test pierwszego zielonego raportu (reguła pozycyjna).
   */
  proofTest?: string;
}
