import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger, SecretsPort } from '@greenproof/core';
import { afterAll, describe, expect, it } from 'vitest';
import createFsPlatform, { fsPlatformPaths } from '../src/index.js';
import { cleanupTmp, initRepo, tmpDir } from './helpers.js';

afterAll(cleanupTmp);

const logger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
const secrets: SecretsPort = { get: (name) => (name === 'TOKEN' ? 'sekret' : undefined) };

describe('createFsPlatform', () => {
  it('składa komplet portów i mapuje katalogi z baseDir', async () => {
    const repoDir = await initRepo();
    const baseDir = await tmpDir('gp-base-');
    const ports = await createFsPlatform({
      config: { platformOptions: { repoDir, baseDir } },
      secrets,
      logger,
    });

    expect(ports.secrets.get('TOKEN')).toBe('sekret');
    expect(ports.logger).toBe(logger);
    expect(ports.clock.now()).toBeInstanceOf(Date);

    await ports.artifacts.put('run-1', 'a.txt', Buffer.from('x'));
    await ports.human.postReport('42', {
      kind: 'roster',
      title: 'Roster',
      markdown: 'lista\n',
      data: [],
      reportId: 'run-1:roster',
    });
    await ports.state.save(
      'run-1',
      {
        runId: 'run-1',
        slug: 's',
        planHash: 'h',
        envUrl: 'https://e',
        baseRef: 'main',
        runRef: '42',
        createdAt: '2026-01-01T00:00:00.000Z',
        cases: {},
        totals: { costUsd: 0, turns: 0 },
      },
      null,
    );
    await ports.scm.openPullRequest({ from: 'author/x', to: 'main', title: 't', body: 'b' });

    const paths = fsPlatformPaths(baseDir);
    expect(paths.artifactsDir).toBe(join(baseDir, 'artifacts'));
    expect(await readdir(paths.artifactsDir)).toEqual(['run-1']);
    expect(await readdir(paths.stateDir)).toEqual(['run-1.json']);
    expect(await readdir(paths.reportsDir)).toEqual(['42']);
    expect(await readdir(paths.prDir)).toEqual(['1.json']);

    expect(await ports.scm.readFile('main', 'README.md')).toBe('# test\n');
  });

  it('przyjmuje też same options zamiast całego configu', async () => {
    const repoDir = await initRepo();
    const baseDir = await tmpDir('gp-base-');
    const ports = await createFsPlatform({ config: { repoDir, baseDir }, secrets, logger });
    expect(await ports.state.load('brak')).toBeNull();
  });

  it('waliduje options czytelnym błędem', async () => {
    const baseDir = await tmpDir('gp-base-');
    expect(() =>
      createFsPlatform({ config: { platformOptions: { baseDir } }, secrets, logger }),
    ).toThrow(/repoDir/);
    expect(() => createFsPlatform({ config: null, secrets, logger })).toThrow(
      /platformOptions must be an object/,
    );
    expect(() =>
      createFsPlatform({
        config: { platformOptions: { repoDir: join(baseDir, 'nie-ma'), baseDir } },
        secrets,
        logger,
      }),
    ).toThrow(/repoDir does not exist/);
  });
});
