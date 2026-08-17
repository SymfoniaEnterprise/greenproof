/**
 * Wiedza projektowa - per projekt (ui-traps nie przenoszą się między projektami).
 * Harvest z runów: propozycje na branchu case'a, promocja przy accept.
 */

export type UiTrapCategory = 'component-behavior' | 'domain-knowledge';

export interface UiTrap {
  /** Komponent/obszar, którego dotyczy, np. "dropdown-multiselect". */
  component: string;
  trap: string;
  workaround: string;
  /** Przykładowy selektor/kod obejścia. */
  selectorExample?: string;
  category: UiTrapCategory;
  /** Tagi flow/route, przy których wpis jest dokładany do kontekstu. */
  appliesTo: string[];
  /** Skąd wiemy (case/attempt, który zapłacił za odkrycie). */
  evidence?: { caseId: string; attemptId: string };
}

export interface AppMapView {
  /** Route/identyfikator widoku, np. "payroll/list". */
  route: string;
  description?: string;
  /** Kroki nawigacji do widoku (od strony głównej). */
  navigationSteps: string[];
  keySelectors: Record<string, string>;
}

export interface AppMap {
  version: 1;
  views: AppMapView[];
}

export interface UiTraps {
  version: 1;
  traps: UiTrap[];
}

/** Wpis nauczonej listy churn-prone (knowledge/churn-prone.learned.json). */
export interface LearnedChurnEntry {
  /** Typ/tag flow uznany za churn-prone. */
  type: string;
  evidence: {
    caseId: string;
    runId: string;
    reason: 'seed-fuse' | 'cost-outlier' | 'failed-seed-strategies';
    costUsd?: number;
    failedStrategies?: number;
  };
  addedAt: string;
  /** Status propozycji (tryb learn=propose wymaga zatwierdzenia człowieka). */
  status: 'proposed' | 'active';
  /** Liczba kolejnych runów bez incydentu (do wygaszania). */
  quietRuns: number;
}

export interface LearnedChurnList {
  version: 1;
  entries: LearnedChurnEntry[];
}
