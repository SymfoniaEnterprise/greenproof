/** In-memory StateStore z prawdziwym CAS (optimistic locking). */
import type { PipelineState, StateStore } from '@greenproof/core';
import { StateConflictError } from '@greenproof/core';

interface Entry {
  state: PipelineState;
  version: string;
}

export class InMemoryStateStore implements StateStore {
  private readonly entries = new Map<string, Entry>();
  /** Globalny licznik wersji - rośnie przy każdym udanym save. */
  private versionCounter = 0;

  // --- StateStore ------------------------------------------------------------

  async load(runId: string): Promise<{ state: PipelineState; version: string } | null> {
    const entry = this.entries.get(runId);
    if (!entry) return null;
    return { state: structuredClone(entry.state), version: entry.version };
  }

  async save(
    runId: string,
    state: PipelineState,
    expectedVersion: string | null,
  ): Promise<{ version: string }> {
    const current = this.entries.get(runId);
    if (expectedVersion === null) {
      // Tworzenie: istniejący wpis to konflikt (ktoś nas ubiegł).
      if (current) throw new StateConflictError(runId);
    } else if (!current || current.version !== expectedVersion) {
      throw new StateConflictError(runId);
    }
    this.versionCounter += 1;
    const version = String(this.versionCounter);
    this.entries.set(runId, { state: structuredClone(state), version });
    return { version };
  }

  // --- pomocnicze dla testów -------------------------------------------------

  /** Kopia zapisanego stanu (null, gdy brak). */
  snapshot(runId: string): PipelineState | null {
    const entry = this.entries.get(runId);
    return entry ? structuredClone(entry.state) : null;
  }

  /** Aktualna wersja wpisu (null, gdy brak). */
  version(runId: string): string | null {
    return this.entries.get(runId)?.version ?? null;
  }

  runIds(): string[] {
    return [...this.entries.keys()].sort();
  }
}
