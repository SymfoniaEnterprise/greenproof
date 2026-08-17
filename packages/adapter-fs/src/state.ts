/**
 * StateStore na plikach: <dir>/<runId>.json, wersja = sha256 zawartości pliku.
 * Optimistic locking: porównanie sha pod krótkim lockiem katalogowym (mkdir).
 */
import { mkdir, readFile, rmdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PipelineState, StateStore } from '@greenproof/core';
import { StateConflictError } from '@greenproof/core';
import { assertSafeSegment, hasErrnoCode, sha256, sleep, writeFileAtomic } from './internal.js';

/** Łączny czas prób przejęcia locka. */
const LOCK_TIMEOUT_MS = 2_000;
const LOCK_RETRY_START_MS = 10;
const LOCK_RETRY_MAX_MS = 100;

export interface FsStateStoreOptions {
  /** Katalog stanów (baseDir/state). */
  dir: string;
}

export class FsStateStore implements StateStore {
  private readonly dir: string;

  constructor(options: FsStateStoreOptions) {
    this.dir = options.dir;
  }

  async load(runId: string): Promise<{ state: PipelineState; version: string } | null> {
    const raw = await this.readRaw(runId);
    if (raw === null) return null;
    return { state: JSON.parse(raw.toString('utf8')) as PipelineState, version: sha256(raw) };
  }

  async save(
    runId: string,
    state: PipelineState,
    expectedVersion: string | null,
  ): Promise<{ version: string }> {
    const file = this.file(runId);
    const data = `${JSON.stringify(state, null, 2)}\n`;

    if (expectedVersion === null) {
      // Tworzenie: O_EXCL jest atomowe, lock niepotrzebny.
      await mkdir(this.dir, { recursive: true });
      try {
        await writeFile(file, data, { flag: 'wx' });
      } catch (err) {
        if (hasErrnoCode(err, 'EEXIST')) throw new StateConflictError(runId);
        throw err;
      }
      return { version: sha256(data) };
    }

    await this.withLock(runId, async () => {
      const current = await this.readRaw(runId);
      if (current === null || sha256(current) !== expectedVersion) {
        throw new StateConflictError(runId);
      }
      await writeFileAtomic(file, data);
    });
    return { version: sha256(data) };
  }

  private file(runId: string): string {
    return join(this.dir, `${assertSafeSegment(runId, 'runId')}.json`);
  }

  private async readRaw(runId: string): Promise<Buffer | null> {
    try {
      return await readFile(this.file(runId));
    } catch (err) {
      if (hasErrnoCode(err, 'ENOENT')) return null;
      throw err;
    }
  }

  /** Lock = katalog <runId>.lock; mkdir jest atomowy również na NFS-ie. */
  private async withLock<T>(runId: string, fn: () => Promise<T>): Promise<T> {
    const lockDir = join(this.dir, `${assertSafeSegment(runId, 'runId')}.lock`);
    await mkdir(this.dir, { recursive: true });
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    let delay = LOCK_RETRY_START_MS;
    for (;;) {
      try {
        await mkdir(lockDir);
        break;
      } catch (err) {
        if (!hasErrnoCode(err, 'EEXIST')) throw err;
        if (Date.now() >= deadline) {
          throw new Error(`Timed out waiting for state lock ${lockDir}`);
        }
        await sleep(delay);
        delay = Math.min(delay * 2, LOCK_RETRY_MAX_MS);
      }
    }
    try {
      return await fn();
    } finally {
      await rmdir(lockDir).catch(() => undefined);
    }
  }
}
