/**
 * Inwentarz POM - mechanizm Harvest: agent opłaca odkrycie flow, wynik trafia
 * jako współdzielony Page Object do reużycia. Indeks to źródło prawdy triażu.
 */

export type InventoryKind = 'pom' | 'fixture';

export interface PomIndexEntry {
  /** Unikalna nazwa, np. "ContractAnnexPage". */
  name: string;
  /** Ścieżka względem repo testów, np. "tests/support/pom/contractAnnex.page.ts". */
  path: string;
  kind: InventoryKind;
  description: string;
  /** Tagi flow/route pokrywane przez ten POM - klucz dopasowania w triażu. */
  covers: string[];
  /** Kluczowe selektory (informacyjnie + wejście lintu anty-duplikacji). */
  keySelectors: string[];
  /** Case, którego próba opłaciła odkrycie. */
  harvestedBy?: string;
  /** Ile razy reużyty (telemetria wartości). */
  reuseCount: number;
  addedAt: string;
}

export interface PomIndex {
  version: 1;
  entries: PomIndexEntry[];
}

/** Wynik lintu anty-duplikacji: surowy selektor w specu, choć istnieje w POM. */
export interface DuplicationFinding {
  specPath: string;
  selector: string;
  pomName: string;
  pomPath: string;
}
