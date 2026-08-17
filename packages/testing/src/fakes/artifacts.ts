/** In-memory ArtifactStore: Map<runId, Map<key, Buffer>> + metadane. */
import type { Readable } from 'node:stream';
import type { ArtifactStore } from '@greenproof/core';

interface StoredArtifact {
  data: Buffer;
  meta: Record<string, string>;
}

/** Zbiera strumień do Buffera (chunki mogą być stringami). */
async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer));
  }
  return Buffer.concat(chunks);
}

export class InMemoryArtifactStore implements ArtifactStore {
  private readonly runs = new Map<string, Map<string, StoredArtifact>>();

  // --- ArtifactStore ---------------------------------------------------------

  async put(
    runId: string,
    key: string,
    data: Buffer | Readable,
    meta?: Record<string, string>,
  ): Promise<void> {
    const buf = Buffer.isBuffer(data) ? Buffer.from(data) : await collect(data);
    let run = this.runs.get(runId);
    if (!run) {
      run = new Map<string, StoredArtifact>();
      this.runs.set(runId, run);
    }
    run.set(key, { data: buf, meta: { ...(meta ?? {}) } });
  }

  async get(runId: string, key: string): Promise<Buffer | null> {
    const stored = this.runs.get(runId)?.get(key);
    return stored ? Buffer.from(stored.data) : null;
  }

  async list(runId: string, prefix?: string): Promise<string[]> {
    const run = this.runs.get(runId);
    if (!run) return [];
    return [...run.keys()].filter((k) => (prefix ? k.startsWith(prefix) : true)).sort();
  }

  async delete(runId: string, key: string): Promise<void> {
    this.runs.get(runId)?.delete(key);
  }

  // --- pomocnicze dla testów -------------------------------------------------

  /** Zawartość artefaktu jako utf-8 (null, gdy brak). */
  getText(runId: string, key: string): string | null {
    const stored = this.runs.get(runId)?.get(key);
    return stored ? stored.data.toString('utf8') : null;
  }

  /** Skrót do zapisu tekstu bez ręcznego Buffer.from w teście. */
  putText(
    runId: string,
    key: string,
    text: string,
    meta?: Record<string, string>,
  ): Promise<void> {
    return this.put(runId, key, Buffer.from(text, 'utf8'), meta);
  }

  getMeta(runId: string, key: string): Record<string, string> | null {
    const stored = this.runs.get(runId)?.get(key);
    return stored ? { ...stored.meta } : null;
  }

  runIds(): string[] {
    return [...this.runs.keys()].sort();
  }
}
