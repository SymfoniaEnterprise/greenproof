/**
 * Przepływ end-to-end na referencyjnym adapterze (@greenproof/adapter-fs)
 * w tymczasowym repo git: filter → status → retry nieistniejącego runa.
 * Komendy author/retry NIE są tu odpalane na prawdziwym agencie (wymaga
 * modelu) - pętla ponowienia jest pokryta na poziomie exitCodeFor.
 */
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fsPlatformPaths } from '@greenproof/adapter-fs';
import type { NormalizedPlan, Ports } from '@greenproof/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cmdFilter, cmdRetry, cmdStatus } from '../src/commands.js';
import type { CommandArgs } from '../src/commands.js';
import { loadConfig } from '../src/config.js';
import { exitCodeFor, failureOutcome, successOutcome } from '../src/exit-codes.js';
import { createStderrLogger, defaultPlatformDeps, resolvePlatform } from '../src/platform.js';
import { cleanupTmp, configObject, initRepo, tmpDir, writeFileIn } from './helpers.js';

afterAll(cleanupTmp);

/** Case 001 ma już speca w repo → filtr musi go pominąć. */
const COVERED_CASE = '3.2-E2E-001';
const OPEN_CASE = '3.2-E2E-002';
const UNIT_CASE = '3.2-UNIT-003';

function plan(slug = 'aneks-ubezpieczenia'): NormalizedPlan {
  return {
    slug,
    cases: [
      {
        caseId: COVERED_CASE,
        title: 'Aneks - happy path',
        level: 'e2e',
        priority: 'P0',
        requirements: ['FR-1'],
        flows: ['contract/annex'],
      },
      {
        caseId: OPEN_CASE,
        title: 'Aneks - walidacja dat',
        level: 'e2e',
        priority: 'P1',
        requirements: ['FR-2'],
        flows: ['contract/annex'],
      },
      {
        caseId: UNIT_CASE,
        title: 'Kalkulacja składki',
        level: 'unit',
        priority: 'P2',
        requirements: ['FR-3'],
        flows: ['contract/annex'],
      },
    ],
  };
}

let repoDir: string;
let baseDir: string;
let configDir: string;
let args: Omit<CommandArgs, 'input'>;
let ports: Ports;

beforeAll(async () => {
  repoDir = await initRepo([`tests/e2e/${COVERED_CASE}.spec.ts`]);
  baseDir = await tmpDir('gp-cli-base-');
  configDir = await tmpDir('gp-cli-cfg-');
  const configFile = await writeFileIn(
    configDir,
    'greenproof.json',
    JSON.stringify(
      configObject({
        platformOptions: { repoDir, baseDir },
        paths: { testsRepoDir: repoDir },
        knowledge: { dir: 'docs/knowledge' },
      }),
    ),
  );
  const loaded = await loadConfig(configFile);
  const logger = createStderrLogger(() => undefined);
  ports = await resolvePlatform(loaded.config, { ...defaultPlatformDeps(loaded.dir), logger });
  args = { config: loaded.config, ports, baseDir: loaded.dir };
});

describe('przepływ filter → status', () => {
  let runId: string;

  it('filter wybiera tylko niepokryte case\'y E2E i melduje roster', async () => {
    const output = await cmdFilter({
      ...args,
      input: {
        slug: 'aneks-ubezpieczenia',
        envUrl: 'https://app.example.test',
        ref: 'main',
        runRef: '42',
        plan: plan(),
      },
    });

    expect(output.selected).toEqual([OPEN_CASE]);
    expect(output.skipped.sort()).toEqual([COVERED_CASE, UNIT_CASE].sort());
    expect(output.timeoutMinutes).toBeGreaterThan(0);
    expect(exitCodeFor(successOutcome('filter', output))).toBe(0);

    // Raport dla człowieka poszedł kanałem platformy, nie na stdout.
    const reports = await readdir(fsPlatformPaths(baseDir).reportsDir);
    expect(reports.length).toBeGreaterThan(0);

    runId = output.runId;
  });

  it('filter jest idempotentny dla tego samego runId', async () => {
    const output = await cmdFilter({
      ...args,
      input: {
        runId,
        slug: 'aneks-ubezpieczenia',
        envUrl: 'https://app.example.test',
        ref: 'main',
        runRef: '42',
        plan: plan(),
      },
    });

    expect(output.runId).toBe(runId);
    expect(output.selected).toEqual([OPEN_CASE]);
  });

  it('status czyta stan bez zapisu', async () => {
    const before = await readdir(fsPlatformPaths(baseDir).stateDir);
    const state = await cmdStatus({ ...args, input: { runId } });

    expect(state.runId).toBe(runId);
    expect(state.slug).toBe('aneks-ubezpieczenia');
    expect(Object.keys(state.cases).sort()).toEqual([COVERED_CASE, OPEN_CASE, UNIT_CASE].sort());
    expect(state.cases[OPEN_CASE]?.status).toBe('selected');
    expect(state.cases[COVERED_CASE]?.status).toBe('skipped');
    // Rollup dla CI/ludzi: skipped liczy się do done, selected czeka w remaining.
    expect(state.summary.total).toBe(3);
    expect(state.summary.skipped).toBe(2);
    expect(state.summary.done).toBe(2);
    expect(state.summary.remaining).toBe(1);
    expect(state.summary.byStatus['selected']).toBe(1);
    expect(await readdir(fsPlatformPaths(baseDir).stateDir)).toEqual(before);
  });

  it('status nieistniejącego runa → RunNotFoundError → exit 2', async () => {
    const err = await cmdStatus({ ...args, input: { runId: 'gp-nie-ma' } }).catch((e: unknown) => e);

    expect((err as Error).name).toBe('RunNotFoundError');
    expect(exitCodeFor(failureOutcome(err))).toBe(2);
  });

  it('retry nieistniejącego runa → RunNotFoundError → exit 2', async () => {
    const err = await cmdRetry({
      ...args,
      input: { runId: 'gp-nie-ma', caseId: OPEN_CASE },
    }).catch((e: unknown) => e);

    expect((err as Error).name).toBe('RunNotFoundError');
    expect(exitCodeFor(failureOutcome(err))).toBe(2);
  });

  it('filter bez case\'ów E2E → pusta selekcja → exit 10', async () => {
    const empty: NormalizedPlan = {
      slug: 'tylko-unity',
      cases: [
        {
          caseId: 'X-UNIT-1',
          title: 'jednostkowy',
          level: 'unit',
          priority: 'P3',
          requirements: [],
          flows: [],
        },
      ],
    };
    const output = await cmdFilter({
      ...args,
      input: {
        slug: 'tylko-unity',
        envUrl: 'https://app.example.test',
        ref: 'main',
        runRef: '43',
        plan: empty,
      },
    });

    expect(output.selected).toEqual([]);
    expect(output.warnings.join(' ')).toMatch(/E2E/);
    expect(exitCodeFor(successOutcome('filter', output))).toBe(10);
  });

  it('plan z pliku (ścieżka względna repo testów) i ostrzeżenie o rozjeździe slug', async () => {
    await writeFileIn(repoDir, 'docs/plan.json', JSON.stringify(plan('plan-z-pliku')));

    const output = await cmdFilter({
      ...args,
      input: {
        slug: 'inny-slug',
        envUrl: 'https://app.example.test',
        ref: 'main',
        runRef: '44',
        plan: { path: 'docs/plan.json' },
      },
    });

    expect(output.selected).toEqual([OPEN_CASE]);
    expect(output.warnings.join(' ')).toMatch(/Slug planu/);
  });

  it('plan ze ścieżki, której nie ma → CliError → exit 2', async () => {
    const err = await cmdFilter({
      ...args,
      input: {
        slug: 'x',
        envUrl: 'https://app.example.test',
        ref: 'main',
        runRef: '45',
        plan: { path: join('docs', 'nie-ma.json') },
      },
    }).catch((e: unknown) => e);

    expect((err as Error).name).toBe('CliError');
    expect(exitCodeFor(failureOutcome(err))).toBe(2);
  });

  it('wejście niezgodne ze schematem → ZodError → exit 2', async () => {
    const err = await cmdFilter({ ...args, input: { slug: 'x' } }).catch((e: unknown) => e);

    expect((err as Error).name).toBe('ZodError');
    expect(exitCodeFor(failureOutcome(err))).toBe(2);
  });
});
