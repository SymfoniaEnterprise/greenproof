/**
 * Prewencyjne fixture'y per churn-prone TYP: jedna sesja na typ przed partią
 * autora, dedykowany branch greenproof/fixtures/<runId>, extra-inventory dla
 * WSZYSTKICH case'ów typu i zero przejść stanu. Sesja wstrzykiwana jako fake.
 */
import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeFakePorts } from '@greenproof/testing';
import { GreenproofConfigSchema } from '../src/schemas/index.js';
import { runFilter } from '../src/steps/filter.js';
import { runTriage, contextKey, type CaseContext } from '../src/steps/triage.js';
import { extraInventoryKey } from '../src/steps/fixtureAuthor.js';
import { runPreventiveFixtures } from '../src/steps/preventiveFixture.js';
import type { FixtureContext, FixtureSessionResult } from '../src/author/fixtureSession.js';
import type { NormalizedPlan } from '../src/domain/plan.js';

const execFileP = promisify(execFile);

/**
 * Dwa case'y typu churn-prone (P2 przed P1 w kolejności planu - reprezentantem
 * ma zostać P1) i jeden case typu spoza listy.
 */
const plan: NormalizedPlan = {
  slug: 'pf',
  cases: [
    {
      caseId: 'E2E-PAY-1', title: 'lista płac netto', level: 'e2e', priority: 'P2',
      requirements: ['netto'], flows: ['payroll'], type: 'lista-plac',
    },
    {
      caseId: 'E2E-PAY-2', title: 'lista płac korekta', level: 'e2e', priority: 'P1',
      requirements: ['korekta'], flows: ['payroll'], type: 'lista-plac',
    },
    {
      caseId: 'E2E-CON-1', title: 'aneks', level: 'e2e', priority: 'P0',
      requirements: ['aneks'], flows: ['contract'], type: 'umowa',
    },
  ],
};

async function setup() {
  const repo = await mkdtemp(join(tmpdir(), 'gp-pf-repo-'));
  const git = (...a: string[]) => execFileP('git', a, { cwd: repo, env: { ...process.env, LC_ALL: 'C' } });
  await git('init', '-b', 'main');
  await git('config', 'user.name', 't');
  await git('config', 'user.email', 't@t');
  await writeFile(join(repo, 'README.md'), 'demo');
  await git('add', '-A');
  await git('commit', '-m', 'init');

  const config = GreenproofConfigSchema.parse({
    platform: 'fake',
    plan: { source: 'json' },
    model: {
      authTokenEnv: 'T', author: 'tani-model',
      fixtureAuthor: { model: 'mocny-model' },
    },
    paths: { testsRepoDir: repo },
    caps: { seedFuse: { churnProneTypes: ['lista-plac'] } },
  });

  const f = makeFakePorts();
  f.scm.seedBranch('main', {});
  await runFilter(f.ports, config, { runId: 'r-pf', envUrl: 'http://127.0.0.1:9', ref: 'main', runRef: 'x', plan });
  await runTriage(f.ports, config, { runId: 'r-pf' });
  return { repo, config, f, git };
}

/** Fake sesji: pisze fixture + skrypt weryfikacyjny o zadanym kodzie wyjścia. */
function fakeRunner(opts: { verifyExit: number; name?: string }) {
  const calls: FixtureContext[] = [];
  const name = opts.name ?? 'paySeed';
  const runner = async (deps: { cwd: string; context: FixtureContext }): Promise<FixtureSessionResult> => {
    calls.push(deps.context);
    await mkdir(join(deps.cwd, 'tests/support/fixtures'), { recursive: true });
    await writeFile(join(deps.cwd, `tests/support/fixtures/${name}.ts`), 'export async function seed(){}\n');
    await writeFile(
      join(deps.cwd, `tests/support/fixtures/${name}.verify.mjs`),
      `process.exit(${opts.verifyExit});\n`,
    );
    return {
      resultSubtype: 'success',
      structured: {
        status: 'delivered', name,
        fixturePath: `tests/support/fixtures/${name}.ts`,
        verifyScriptPath: `tests/support/fixtures/${name}.verify.mjs`,
        description: 'seed listy płac', covers: ['payroll'],
      },
      costUsd: 0.3, turns: 12, messagesPath: '/dev/null',
    };
  };
  return { runner, calls };
}

describe('prewencyjne fixture\'y', () => {
  it('jedna sesja na typ churn-prone: extra-inventory dla WSZYSTKICH case\'ów typu, bez zmiany stanów', async () => {
    const { config, f, git } = await setup();
    const { runner, calls } = fakeRunner({ verifyExit: 0 });
    const res = await runPreventiveFixtures(f.ports, config, { runId: 'r-pf', sessionRunner: runner });

    expect(res.ok).toBe(true);
    expect(res.costUsd).toBeCloseTo(0.3);
    // Typ spoza listy churn-prone nie dostaje sesji.
    expect(res.types.map((t) => t.type)).toEqual(['lista-plac']);
    expect(res.types[0]!.status).toBe('delivered');
    // Reprezentant: P1 wygrywa z wcześniejszym w planie P2.
    expect(res.types[0]!.caseId).toBe('E2E-PAY-2');
    expect(res.types[0]!.fixture?.name).toBe('paySeed');
    expect(calls).toHaveLength(1);
    // Ścieżka prewencyjna nie ma czego brać z historii prób.
    expect(calls[0]!.failedStrategies).toEqual([]);
    expect(calls[0]!.digest).toBeUndefined();

    // Fixture trafia do inwentarza OBU case'ów typu, ale nie do case'a spoza typu.
    for (const caseId of ['E2E-PAY-1', 'E2E-PAY-2']) {
      const extra = JSON.parse(f.artifacts.getText('r-pf', extraInventoryKey(caseId))!) as {
        entries: { name: string; harvestedBy: string }[];
      };
      expect(extra.entries[0]!.name).toBe('paySeed');
      expect(extra.entries[0]!.harvestedBy).toBe('preventive-fixture:lista-plac');
    }
    expect(f.artifacts.getText('r-pf', extraInventoryKey('E2E-CON-1'))).toBeNull();

    const state = (await f.state.load('r-pf'))!.state;
    expect(state.fixturesRef).toBe('greenproof/fixtures/r-pf');
    expect(state.totals.costUsd).toBeCloseTo(0.3);
    // Żadnych przejść stanu, notatek retry ani kredytów - nic nie zawiodło.
    for (const cs of Object.values(state.cases)) {
      expect(cs.status).toBe('triaged');
      expect(cs.retryNotes).toBeUndefined();
      expect(cs.fixtureRetryCredits).toBeUndefined();
      expect(cs.costUsd).toBe(0);
    }

    // Triaż wkłada fixture do kontekstu obu case'ów typu.
    await runTriage(f.ports, config, { runId: 'r-pf' });
    for (const caseId of ['E2E-PAY-1', 'E2E-PAY-2']) {
      const ctx = JSON.parse(f.artifacts.getText('r-pf', contextKey(caseId))!) as CaseContext;
      expect(ctx.inventory.map((e) => e.name)).toContain('paySeed');
    }
    const conCtx = JSON.parse(f.artifacts.getText('r-pf', contextKey('E2E-CON-1'))!) as CaseContext;
    expect(conCtx.inventory.map((e) => e.name)).not.toContain('paySeed');

    // Commit wylądował na dedykowanym branchu; main nietknięty.
    const branchFiles = (await git('ls-tree', '-r', '--name-only', 'greenproof/fixtures/r-pf')).stdout;
    expect(branchFiles).toContain('tests/support/fixtures/paySeed.ts');
    const mainFiles = (await git('ls-tree', '-r', '--name-only', 'main')).stdout;
    expect(mainFiles).not.toContain('paySeed');
    expect((await git('rev-list', '--count', 'main')).stdout.trim()).toBe('1');
  });

  it('drugie wywołanie pomija typ (bramka pokrycia po extra-inventory)', async () => {
    const { config, f } = await setup();
    const { runner, calls } = fakeRunner({ verifyExit: 0 });
    await runPreventiveFixtures(f.ports, config, { runId: 'r-pf', sessionRunner: runner });
    const res = await runPreventiveFixtures(f.ports, config, { runId: 'r-pf', sessionRunner: runner });

    expect(calls).toHaveLength(1);
    expect(res.ok).toBe(true);
    expect(res.types[0]!.status).toBe('skipped');
    expect(res.types[0]!.note).toMatch(/dostarczono już/);
    expect(res.costUsd).toBe(0);
  });

  it('inwentarz repo testów pokrywa już flow → pominięcie bez sesji', async () => {
    const { config, f } = await setup();
    f.scm.seedBranch('main', {
      'tests/support/pom-index.json': JSON.stringify({
        version: 1,
        entries: [{
          name: 'istniejacySeed', path: 'tests/support/fixtures/istniejacySeed.ts', kind: 'fixture',
          description: 'jest', covers: ['payroll'], keySelectors: [], harvestedBy: 'human',
          reuseCount: 0, addedAt: '2026-08-01T10:00:00Z',
        }],
      }),
    });
    const { runner, calls } = fakeRunner({ verifyExit: 0 });
    const res = await runPreventiveFixtures(f.ports, config, { runId: 'r-pf', sessionRunner: runner });

    expect(calls).toHaveLength(0);
    expect(res.types[0]!.status).toBe('skipped');
    expect(res.types[0]!.note).toMatch(/istniejacySeed/);
    expect((await f.state.load('r-pf'))!.state.fixturesRef).toBeUndefined();
  });

  it('nieudany skrypt weryfikacyjny → typ failed, ok=false, bez fixture\'a w stanie i inwentarzu (ale KOSZT policzony)', async () => {
    const { config, f, git } = await setup();
    const { runner } = fakeRunner({ verifyExit: 1 });
    const res = await runPreventiveFixtures(f.ports, config, { runId: 'r-pf', sessionRunner: runner });

    expect(res.ok).toBe(false);
    expect(res.types[0]!.status).toBe('failed');
    expect(res.types[0]!.error).toMatch(/kodem 1/);
    expect(res.costUsd).toBeCloseTo(0.3);

    const state = (await f.state.load('r-pf'))!.state;
    expect(state.fixturesRef).toBeUndefined();
    // REGRESJA: nieudana sesja też kosztowała - suma przebiegu musi ją widzieć.
    expect(state.totals.costUsd).toBeCloseTo(0.3);
    // Prewencja nie obciąża budżetu pojedynczego case'a (cap per case).
    for (const cs of Object.values(state.cases)) expect(cs.costUsd).toBe(0);
    expect(f.artifacts.getText('r-pf', extraInventoryKey('E2E-PAY-1'))).toBeNull();
    expect(f.artifacts.getText('r-pf', extraInventoryKey('E2E-PAY-2'))).toBeNull();

    // Branch fixture'ów istnieje (wycięty przed sesją), ale bez commitu - praca
    // nieudanej sesji poszła na bocznicę, a main pozostaje nietknięty.
    const fixturesSha = (await git('rev-parse', 'greenproof/fixtures/r-pf')).stdout.trim();
    expect(fixturesSha).toBe((await git('rev-parse', 'main')).stdout.trim());
    const scrapFiles = (await git('ls-tree', '-r', '--name-only', 'greenproof/fixtures-failed/r-pf/lista-plac')).stdout;
    expect(scrapFiles).toContain('tests/support/fixtures/paySeed.ts');
    expect((await git('ls-tree', '-r', '--name-only', 'main')).stdout).not.toContain('paySeed');
  });

  it('odrzucony wpis inwentarza → commit zdjęty ze wspólnego brancha na bocznicę', async () => {
    const { config, f, git } = await setup();
    // Weryfikacja przechodzi, ale nazwa nie przejdzie walidacji inwentarza -
    // fixture jest już scommitowany, więc musi zjechać na bocznicę.
    const { runner } = fakeRunner({ verifyExit: 0, name: 'paySeed!' });
    const res = await runPreventiveFixtures(f.ports, config, { runId: 'r-pf', sessionRunner: runner });

    expect(res.ok).toBe(false);
    expect(res.types[0]!.status).toBe('failed');
    expect(res.types[0]!.error).toMatch(/Nieprawidłowa nazwa/);

    const state = (await f.state.load('r-pf'))!.state;
    expect(state.fixturesRef).toBeUndefined();
    // REGRESJA: rollback inwentarza i brancha nie cofa WYDANYCH pieniędzy.
    expect(state.totals.costUsd).toBeCloseTo(0.3);
    expect(f.artifacts.getText('r-pf', extraInventoryKey('E2E-PAY-1'))).toBeNull();

    // Wspólny branch cofnięty do main - kolejny udany typ nie wciągnie śmieci
    // do branchy case'ów; zweryfikowany commit zostaje do wglądu na bocznicy.
    expect((await git('rev-parse', 'greenproof/fixtures/r-pf')).stdout.trim()).toBe(
      (await git('rev-parse', 'main')).stdout.trim(),
    );
    const scrap = (await git('ls-tree', '-r', '--name-only', 'greenproof/fixtures-failed/r-pf/lista-plac')).stdout;
    expect(scrap).toContain('tests/support/fixtures/paySeed!.ts');
  });

  it('porażka wpisu dla późniejszego case\'a cofa wpisy wcześniejszych (rollback inwentarza)', async () => {
    const { config, f, git } = await setup();
    // Magazyn artefaktów pada przy wpisie DRUGIEGO case'a (PAY-2 jest
    // reprezentantem, ale pętla wpisów idzie w kolejności planu: PAY-1, PAY-2)
    // - wpis pierwszego musi zostać wycofany.
    const origPut = f.ports.artifacts.put.bind(f.ports.artifacts);
    f.ports.artifacts.put = async (runId: string, key: string, data: Buffer, meta?: Record<string, string>) => {
      if (key === extraInventoryKey('E2E-PAY-2')) throw new Error('EIO: magazyn artefaktów padł');
      return origPut(runId, key, data, meta);
    };
    const { runner } = fakeRunner({ verifyExit: 0 });
    const res = await runPreventiveFixtures(f.ports, config, { runId: 'r-pf', sessionRunner: runner });

    expect(res.ok).toBe(false);
    expect(res.types[0]!.status).toBe('failed');
    // Wpis PAY-1 wycofany - triaż nie dostanie fixture'a, którego nie ma na branchu.
    expect(f.artifacts.getText('r-pf', extraInventoryKey('E2E-PAY-1'))).toBeNull();
    const state = (await f.state.load('r-pf'))!.state;
    expect(state.fixturesRef).toBeUndefined();
    // REGRESJA: awaria magazynu artefaktów nie może zjeść kosztu sesji.
    expect(state.totals.costUsd).toBeCloseTo(0.3);
    expect((await git('rev-parse', 'greenproof/fixtures/r-pf')).stdout.trim()).toBe(
      (await git('rev-parse', 'main')).stdout.trim(),
    );
  });

  it('sesja bez dostarczonego fixture\'a (wyczerpane tury) → koszt w sumie przebiegu i w rollupie case-end', async () => {
    const { config, f } = await setup();
    const events: { kind: string; rollup?: { costUsd: number } }[] = [];
    f.ports.progress = (e) => events.push(e as (typeof events)[number]);
    // Sesja wraca bez structured - dokładnie przypadek z benchmarku
    // (error_max_turns), który mimo porażki kosztował realne pieniądze.
    const runner = async (): Promise<FixtureSessionResult> => ({
      resultSubtype: 'error_max_turns', costUsd: 0.42, turns: 80, messagesPath: '/dev/null',
    });
    const res = await runPreventiveFixtures(f.ports, config, { runId: 'r-pf', sessionRunner: runner });

    expect(res.types[0]!.status).toBe('failed');
    expect(res.types[0]!.error).toMatch(/error_max_turns/);
    expect(res.costUsd).toBeCloseTo(0.42);

    const state = (await f.state.load('r-pf'))!.state;
    expect(state.totals.costUsd).toBeCloseTo(0.42);
    // Rollup w case-end pokazuje koszt PO zapisie - inaczej renderer gubi wydatek.
    expect(events.find((e) => e.kind === 'case-end')!.rollup!.costUsd).toBeCloseTo(0.42);
  });

  it('sesja prewencyjna emituje case-start/case-end (widoczność w rendererach)', async () => {
    const { config, f } = await setup();
    const events: { kind: string; caseId?: string; attempt?: number; status?: string }[] = [];
    f.ports.progress = (e) => events.push(e as (typeof events)[number]);
    const { runner } = fakeRunner({ verifyExit: 0 });
    await runPreventiveFixtures(f.ports, config, { runId: 'r-pf', sessionRunner: runner });

    const start = events.find((e) => e.kind === 'case-start');
    const end = events.find((e) => e.kind === 'case-end');
    expect(start).toMatchObject({ caseId: 'E2E-PAY-2', attempt: 0 });
    expect(end).toMatchObject({ caseId: 'E2E-PAY-2', attempt: 0, status: 'triaged' });
    // Otoczka typu nadal raportuje kamienie milowe step.
    expect(events.filter((e) => e.kind === 'step')).toHaveLength(2);
  });

  it('jawna lista typów pomija listę churn-prone z configu', async () => {
    const { config, f } = await setup();
    const { runner, calls } = fakeRunner({ verifyExit: 0, name: 'conSeed' });
    const res = await runPreventiveFixtures(f.ports, config, {
      runId: 'r-pf', types: ['umowa'], sessionRunner: runner,
    });

    expect(res.types.map((t) => t.type)).toEqual(['umowa']);
    expect(res.types[0]!.caseId).toBe('E2E-CON-1');
    expect(calls[0]!.flows).toEqual(['contract']);
    expect(f.artifacts.getText('r-pf', extraInventoryKey('E2E-CON-1'))).not.toBeNull();
    expect(f.artifacts.getText('r-pf', extraInventoryKey('E2E-PAY-1'))).toBeNull();
  });

  it('brak case\'ów churn-prone w przebiegu → pusty wynik bez sesji', async () => {
    const { config, f } = await setup();
    const { runner, calls } = fakeRunner({ verifyExit: 0 });
    const res = await runPreventiveFixtures(f.ports, config, {
      runId: 'r-pf', types: ['typ-ktorego-nie-ma'], sessionRunner: runner,
    });
    expect(res).toEqual({ types: [], costUsd: 0, turns: 0, ok: true });
    expect(calls).toHaveLength(0);
  });
});
