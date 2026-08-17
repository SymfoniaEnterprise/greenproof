/**
 * Znormalizowany plan testów - natywny format wejściowy greenproof.
 * Formaty zewnętrzne tłumaczą do tego kształtu pluginy PlanSource; core ich nie zna.
 */

export type CasePriority = 'P0' | 'P1' | 'P2' | 'P3';

export type CaseLevel = 'e2e' | 'integration' | 'unit';

export interface PlanCase {
  /** Stabilny identyfikator przypadku, np. "3.2-E2E-019". */
  caseId: string;
  title: string;
  level: CaseLevel;
  priority: CasePriority;
  /** Wymogi (ID lub treść) pokrywane przez ten przypadek. */
  requirements: string[];
  /**
   * Tagi flow/route (np. "payroll/create", "contract/annex") - klucz
   * dopasowania istniejących POM-ów i wpisów wiedzy projektowej w triażu
   * oraz jednostka, której dotyczy lista churn-prone.
   */
  flows: string[];
  /** Typ biznesowy przypadku (np. "lista-plac") - porównywany z listą churn-prone. */
  type?: string;
  notes?: string;
}

export interface NormalizedPlan {
  /** Slug przebiegu/PRD, np. "aneks-ubezpieczenia". */
  slug: string;
  cases: PlanCase[];
  /** Metadane pochodzenia - czysto informacyjne. */
  source?: { format: string; path?: string };
}

/** Plugin źródła planu. Wbudowana implementacja: passthrough JSON z walidacją. */
export interface PlanSource {
  /** Nazwa formatu, np. "json", "bmad-tea". */
  readonly format: string;
  /** Tłumaczy surowe wejście na znormalizowany plan; rzuca PlanParseError. */
  parse(input: string, opts?: { path?: string }): NormalizedPlan;
}

export class PlanParseError extends Error {
  constructor(
    message: string,
    readonly details?: { path?: string; line?: number },
  ) {
    super(message);
    this.name = 'PlanParseError';
  }
}
