import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PipelineState } from '@greenproof/core';
import { StateConflictError } from '@greenproof/core';
import { afterAll, describe, expect, it } from 'vitest';
import { FsStateStore } from '../src/index.js';
import { cleanupTmp, tmpDir } from './helpers.js';

afterAll(cleanupTmp);

function makeState(runId: string, costUsd = 0): PipelineState {
  return {
    runId,
    slug: 'checkout',
    planHash: 'abc123',
    envUrl: 'https://staging.example.com',
    baseRef: 'main',
    runRef: '42',
    createdAt: '2026-01-01T00:00:00.000Z',
    cases: {},
    totals: { costUsd, turns: 0 },
  };
}

describe('FsStateStore', () => {
  it('tworzy stan z expectedVersion=null i odrzuca drugie tworzenie', async () => {
    const dir = await tmpDir('gp-state-');
    const store = new FsStateStore({ dir });

    expect(await store.load('run-1')).toBeNull();
    const created = await store.save('run-1', makeState('run-1'), null);
    expect(created.version).toMatch(/^[0-9a-f]{64}$/);

    const loaded = await store.load('run-1');
    expect(loaded?.state.runId).toBe('run-1');
    expect(loaded?.version).toBe(created.version);

    await expect(store.save('run-1', makeState('run-1'), null)).rejects.toBeInstanceOf(
      StateConflictError,
    );
  });

  it('poprawna sekwencja load → save aktualizuje stan i zmienia wersję', async () => {
    const dir = await tmpDir('gp-state-');
    const store = new FsStateStore({ dir });
    const v1 = await store.save('run-1', makeState('run-1'), null);

    const loaded = await store.load('run-1');
    expect(loaded).not.toBeNull();
    const v2 = await store.save('run-1', makeState('run-1', 1.5), loaded?.version ?? null);
    expect(v2.version).not.toBe(v1.version);

    const after = await store.load('run-1');
    expect(after?.version).toBe(v2.version);
    expect(after?.state.totals.costUsd).toBe(1.5);
  });

  it('zły expectedVersion → StateConflictError, plik nietknięty', async () => {
    const dir = await tmpDir('gp-state-');
    const store = new FsStateStore({ dir });
    const v1 = await store.save('run-1', makeState('run-1'), null);

    await expect(
      store.save('run-1', makeState('run-1', 9), 'a'.repeat(64)),
    ).rejects.toBeInstanceOf(StateConflictError);

    const after = await store.load('run-1');
    expect(after?.version).toBe(v1.version);
    expect(after?.state.totals.costUsd).toBe(0);
  });

  it('wykrywa zapis obcego procesu między load a save', async () => {
    const dir = await tmpDir('gp-state-');
    const store = new FsStateStore({ dir });
    await store.save('run-1', makeState('run-1'), null);
    const loaded = await store.load('run-1');

    // obcy proces nadpisuje plik stanu
    await writeFile(join(dir, 'run-1.json'), `${JSON.stringify(makeState('run-1', 42), null, 2)}\n`);

    await expect(
      store.save('run-1', makeState('run-1', 1), loaded?.version ?? null),
    ).rejects.toBeInstanceOf(StateConflictError);
  });

  it('save z wersją na nieistniejącym stanie → konflikt', async () => {
    const dir = await tmpDir('gp-state-');
    const store = new FsStateStore({ dir });
    await expect(
      store.save('run-1', makeState('run-1'), 'b'.repeat(64)),
    ).rejects.toBeInstanceOf(StateConflictError);
  });

  it('nie zostawia locka po konflikcie ani po sukcesie', async () => {
    const dir = await tmpDir('gp-state-');
    const store = new FsStateStore({ dir });
    const v1 = await store.save('run-1', makeState('run-1'), null);
    await expect(store.save('run-1', makeState('run-1'), 'c'.repeat(64))).rejects.toThrow();
    // kolejny poprawny zapis musi dostać locka bez czekania
    const v2 = await store.save('run-1', makeState('run-1', 2), v1.version);
    expect((await store.load('run-1'))?.version).toBe(v2.version);
  });
});
