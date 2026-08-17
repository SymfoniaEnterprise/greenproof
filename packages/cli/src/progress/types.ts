/**
 * Kontrakt rendererów postępu CLI. Piszą WYŁĄCZNIE na stderr (stdout = JSON
 * wyniku). Wybór: env GREENPROOF_PROGRESS (auto|tty|plain|github|json|off).
 */
import type { ProgressEvent } from '@greenproof/core';

export interface ProgressRenderer {
  /** Odbiór pojedynczego zdarzenia. Musi być odporny - błąd nie może się wydostać. */
  onEvent(event: ProgressEvent): void;
  /**
   * Linia loguera do wydrukowania NAD widokiem - TTY czyści tablicę, drukuje
   * linię i odrysowuje; pozostałe przepuszczają na stderr.
   */
  printAbove(line: string): void;
  /** Raz na końcu komendy: domknięcie widoku (finalny stan, Job Summary, kursor). */
  finalize(): void;
  /**
   * Kontekst znany hostowi przed pierwszym zdarzeniem (np. model z configu) -
   * tablica nie czeka na case-start. Zdarzenia z własnym modelem nadpisują.
   */
  hint?(ctx: { model?: string }): void;
}

/** Zależności wstrzykiwane do rendererów - testowalne bez prawdziwego stderr. */
export interface RendererIo {
  /** Zapis na stderr (domyślnie process.stderr.write). */
  write: (chunk: string) => void;
  env: Record<string, string | undefined>;
  isTTY: boolean;
  now: () => Date;
  /**
   * Żywa szerokość terminala (process.stderr.columns) - env COLUMNS zwykle
   * NIE jest eksportowane do procesów potomnych; zły odczyt = zawijanie i
   * rozjazd kursora.
   */
  columns?: () => number | undefined;
}
