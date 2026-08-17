/** ArtifactStore na plikach: <dir>/<runId>/<key>, meta obok jako <key>.meta.json. */
import { readFile, readdir, rm, rmdir } from 'node:fs/promises';
import { dirname, join, posix, relative, sep } from 'node:path';
import type { Readable } from 'node:stream';
import type { ArtifactStore } from '@greenproof/core';
import { assertSafeKey, assertSafeSegment, hasErrnoCode, writeFileAtomic } from './internal.js';

const META_SUFFIX = '.meta.json';

export interface FsArtifactStoreOptions {
  /** Katalog bazowy artefaktów (baseDir/artifacts). */
  dir: string;
}

export class FsArtifactStore implements ArtifactStore {
  private readonly dir: string;

  constructor(options: FsArtifactStoreOptions) {
    this.dir = options.dir;
  }

  async put(
    runId: string,
    key: string,
    data: Buffer | Readable,
    meta?: Record<string, string>,
  ): Promise<void> {
    const file = this.resolve(runId, key);
    await writeFileAtomic(file, data);
    if (meta !== undefined) {
      await writeFileAtomic(`${file}${META_SUFFIX}`, `${JSON.stringify(meta, null, 2)}\n`);
    }
  }

  async get(runId: string, key: string): Promise<Buffer | null> {
    try {
      return await readFile(this.resolve(runId, key));
    } catch (err) {
      if (hasErrnoCode(err, 'ENOENT') || hasErrnoCode(err, 'EISDIR')) return null;
      throw err;
    }
  }

  async list(runId: string, prefix?: string): Promise<string[]> {
    const runDir = join(this.dir, assertSafeSegment(runId, 'runId'));
    let entries: string[];
    try {
      entries = await walk(runDir);
    } catch (err) {
      if (hasErrnoCode(err, 'ENOENT')) return [];
      throw err;
    }
    const keys = entries
      .map((abs) => relative(runDir, abs).split(sep).join(posix.sep))
      .filter((key) => !key.endsWith(META_SUFFIX))
      .filter((key) => prefix === undefined || key.startsWith(prefix));
    return keys.sort();
  }

  async delete(runId: string, key: string): Promise<void> {
    const file = this.resolve(runId, key);
    await rm(file, { force: true });
    await rm(`${file}${META_SUFFIX}`, { force: true });
    // Opróżnione katalogi znikają aż do katalogu runu (rmdir nie tknie pełnych).
    const runDir = join(this.dir, assertSafeSegment(runId, 'runId'));
    for (let dir = dirname(file); dir !== runDir && dir.startsWith(runDir); dir = dirname(dir)) {
      try {
        await rmdir(dir);
      } catch {
        break; // niepusty albo już nie istnieje - koniec sprzątania
      }
    }
  }

  private resolve(runId: string, key: string): string {
    const safeKey = assertSafeKey(key, 'artifact key');
    return join(this.dir, assertSafeSegment(runId, 'runId'), ...safeKey.split('/'));
  }
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(abs)));
    else out.push(abs);
  }
  return out;
}
