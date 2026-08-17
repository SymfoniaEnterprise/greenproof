/**
 * Deterministyczne części fixture-author: warunek wejścia, odbiór skryptem
 * weryfikacyjnym, extra-inventory, przejścia stanu i merge w triażu.
 * Sesja agenta wstrzykiwana jako fake (sessionRunner).
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
import { runFixtureAuthor, extraInventoryKey } from '../src/steps/fixtureAuthor.js';
import { transitionCase } from '../src/machine/pipeline.js';
import { appendAttempt } from '../src/ledger/store.js';
import type { FixtureSessionResult } from '../src/author/fixtureSession.js';
import type { NormalizedPlan } from '../src/domain/plan.js';

const execFileP = promisify(execFile);

const plan: NormalizedPlan = {
  slug: 'fx',
  cases: [
    {
      caseId: 'E2E-PAY-1', title: 'payroll', level: 'e2e', priority: 'P1',
      requirements: ['netto'], flows: ['payroll'], type: 'lista-plac',
    },
  ],
};

async function setup() {
  const repo = await mkdtemp(join(tmpdir(), 'gp-fx-repo-'));
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
  await runFilter(f.ports, config, { runId: 'r-fx', envUrl: 'http://127.0.0.1:9', ref: 'main', runRef: 'x', plan });
  await runTriage(f.ports, config, { runId: 'r-fx' });

  // Symulacja historii: próba autora skończona blocked(fixture-gap) + ledger.
  const st = await f.state.load('r-fx');
  transitionCase(st!.state, 'E2E-PAY-1', 'authoring');
  transitionCase(st!.state, 'E2E-PAY-1', 'blocked', { blockedReason: 'fixture-gap', attempts: 1 });
  await f.state.save('r-fx', st!.state, st!.version);
  await appendAttempt(f.artifacts, 'r-fx', {
    attemptId: 'attempt-1', caseId: 'E2E-PAY-1', runId: 'r-fx',
    startedAt: '2026-08-15T10:00:00Z', endedAt: '2026-08-15T10:20:00Z', trigger: 'initial',
    outcome: 'blocked', blockedReason: 'fixture-gap', costUsd: 0.01, turns: 45, playwrightRuns: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, phases: {},
    seedAttempts: [{ strategy: 'ui-klikanie', outcome: 'failed' }],
    lastErrors: [], filesTouched: [], commits: [], reusedPoms: [],
  });
  return { repo, config, f };
}

function fakeRunner(opts: { verifyExit: number; deliver?: boolean }) {
  const calls: unknown[] = [];
  const runner = async (deps: { cwd: string; context: { failedStrategies: unknown[] } }): Promise<FixtureSessionResult> => {
    calls.push(deps.context);
    if (opts.deliver === false) {
      return { resultSubtype: 'success', structured: { status: 'failed', notes: 'nie ma jak' }, costUsd: 0.2, turns: 10, messagesPath: '/dev/null' };
    }
    await mkdir(join(deps.cwd, 'tests/support/fixtures'), { recursive: true });
    await writeFile(join(deps.cwd, 'tests/support/fixtures/paySeed.ts'), 'export async function seed(){}\n');
    await writeFile(
      join(deps.cwd, 'tests/support/fixtures/paySeed.verify.mjs'),
      `process.exit(${opts.verifyExit});\n`,
    );
    return {
      resultSubtype: 'success',
      structured: {
        status: 'delivered', name: 'paySeed',
        fixturePath: 'tests/support/fixtures/paySeed.ts',
        verifyScriptPath: 'tests/support/fixtures/paySeed.verify.mjs',
        description: 'seed listy płac', covers: ['payroll'],
      },
      costUsd: 0.3, turns: 12, messagesPath: '/dev/null',
    };
  };
  return { runner, calls };
}

describe('fixture-author', () => {
  it('sukces: fixture zweryfikowany → extra-inventory, triaged z retryNotes, kontekst retry zawiera fixture', async () => {
    const { config, f } = await setup();
    const { runner, calls } = fakeRunner({ verifyExit: 0 });
    const res = await runFixtureAuthor(f.ports, config, { runId: 'r-fx', caseId: 'E2E-PAY-1', sessionRunner: runner });

    expect(res.ok).toBe(true);
    expect(res.fixture?.name).toBe('paySeed');
    expect(res.verify?.exitCode).toBe(0);
    // Kontekst sesji dostał nieudane strategie z ledgera.
    expect((calls[0] as { failedStrategies: unknown[] }).failedStrategies).toHaveLength(1);

    const st = await f.state.load('r-fx');
    expect(st!.state.cases['E2E-PAY-1']!.status).toBe('triaged');
    expect(st!.state.cases['E2E-PAY-1']!.retryNotes).toMatch(/paySeed/);
    expect(st!.state.cases['E2E-PAY-1']!.blockedReason).toBeUndefined();
    // Udany fixture-author dokłada kredyt ponowienia poza pulą maxAutoRetries.
    expect(st!.state.cases['E2E-PAY-1']!.fixtureRetryCredits).toBe(1);
    // Koszt sesji policzony DOKŁADNIE raz (case + suma przebiegu).
    expect(st!.state.cases['E2E-PAY-1']!.costUsd).toBeCloseTo(0.3);
    expect(st!.state.totals.costUsd).toBeCloseTo(0.3);

    const extra = JSON.parse(f.artifacts.getText('r-fx', extraInventoryKey('E2E-PAY-1'))!) as { entries: { name: string }[] };
    expect(extra.entries[0]!.name).toBe('paySeed');

    // Triage po fixture: fixture wchodzi do inventory kontekstu.
    await runTriage(f.ports, config, { runId: 'r-fx', caseId: 'E2E-PAY-1' });
    const ctx = JSON.parse(f.artifacts.getText('r-fx', contextKey('E2E-PAY-1'))!) as CaseContext;
    expect(ctx.inventory.map((e) => e.name)).toContain('paySeed');
    expect(ctx.previousAttempt?.humanNotes).toMatch(/paySeed/);
  });

  it('sesja fixture emituje case-start/case-end (sukces → triaged, porażka → blocked)', async () => {
    const { config, f } = await setup();
    const events: { kind: string; status?: string; attempt?: number }[] = [];
    f.ports.progress = (e) => events.push(e as (typeof events)[number]);

    await runFixtureAuthor(f.ports, config, {
      runId: 'r-fx', caseId: 'E2E-PAY-1', sessionRunner: fakeRunner({ verifyExit: 0 }).runner,
    });
    expect(events.find((e) => e.kind === 'case-start')).toMatchObject({ attempt: 1 });
    expect(events.find((e) => e.kind === 'case-end')).toMatchObject({ status: 'triaged' });

    // Druga runda: porażka weryfikacji - case-end raportuje blocked.
    events.length = 0;
    const st = await f.state.load('r-fx');
    transitionCase(st!.state, 'E2E-PAY-1', 'authoring');
    transitionCase(st!.state, 'E2E-PAY-1', 'blocked', { blockedReason: 'fixture-gap', attempts: 2 });
    await f.state.save('r-fx', st!.state, st!.version);
    await runFixtureAuthor(f.ports, config, {
      runId: 'r-fx', caseId: 'E2E-PAY-1', sessionRunner: fakeRunner({ verifyExit: 1 }).runner,
    });
    expect(events.find((e) => e.kind === 'case-end')).toMatchObject({
      status: 'blocked', attempt: 2,
    });
  });

  it('skrypt weryfikacyjny wychodzi niezerowo → ok=false, case zostaje blocked, ale KOSZT policzony', async () => {
    const { config, f } = await setup();
    const { runner } = fakeRunner({ verifyExit: 1 });
    const res = await runFixtureAuthor(f.ports, config, { runId: 'r-fx', caseId: 'E2E-PAY-1', sessionRunner: runner });
    expect(res.ok).toBe(false);
    expect(res.verify?.exitCode).toBe(1);
    const st = await f.state.load('r-fx');
    expect(st!.state.cases['E2E-PAY-1']!.status).toBe('blocked');
    // REGRESJA: sesja się odbyła i kosztowała - suma przebiegu musi to widzieć.
    expect(st!.state.totals.costUsd).toBeCloseTo(0.3);
    expect(st!.state.cases['E2E-PAY-1']!.costUsd).toBeCloseTo(0.3);
  });

  it('sesja bez delivered → ok=false z powodem, koszt nieudanej sesji w stanie', async () => {
    const { config, f } = await setup();
    const { runner } = fakeRunner({ verifyExit: 0, deliver: false });
    const res = await runFixtureAuthor(f.ports, config, { runId: 'r-fx', caseId: 'E2E-PAY-1', sessionRunner: runner });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/nie ma jak|status=failed/);
    // REGRESJA: koszt nieudanej eskalacji (0.2) nie może wyparować z sumy runu.
    const st = await f.state.load('r-fx');
    expect(st!.state.totals.costUsd).toBeCloseTo(0.2);
    expect(st!.state.cases['E2E-PAY-1']!.costUsd).toBeCloseTo(0.2);
  });

  it('wyczerpane tury bez wyniku → koszt w stanie i w rollupie case-end', async () => {
    const { config, f } = await setup();
    const events: { kind: string; status?: string; rollup?: { costUsd: number } }[] = [];
    f.ports.progress = (e) => events.push(e as (typeof events)[number]);
    // Sesja wraca bez structured (error_max_turns) - przypadek z benchmarku:
    // porażka, która i tak kosztowała.
    const runner = async (): Promise<FixtureSessionResult> => ({
      resultSubtype: 'error_max_turns', costUsd: 0.42, turns: 80, messagesPath: '/dev/null',
    });
    const res = await runFixtureAuthor(f.ports, config, { runId: 'r-fx', caseId: 'E2E-PAY-1', sessionRunner: runner });

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/error_max_turns/);
    const st = await f.state.load('r-fx');
    expect(st!.state.cases['E2E-PAY-1']!.status).toBe('blocked');
    expect(st!.state.totals.costUsd).toBeCloseTo(0.42);
    // Renderer dostaje rollup PO zapisie kosztu, nie sprzed sesji.
    const end = events.find((e) => e.kind === 'case-end');
    expect(end).toMatchObject({ status: 'blocked' });
    expect(end!.rollup!.costUsd).toBeCloseTo(0.42);
  });

  it('appDocs: dokumentacja z repo testów trafia do kontekstu sesji; brak pliku nie wywala', async () => {
    const { config, f } = await setup();
    f.scm.seedBranch('main', { 'docs/app/README.md': '# HR-Payroll\nPOST /api/test/seed' });
    const cfgDocs = { ...config, appDocs: { paths: ['docs/app/README.md', 'docs/app/NIE-MA.md'], maxChars: 20_000 } };
    const { runner, calls } = fakeRunner({ verifyExit: 0 });
    const res = await runFixtureAuthor(f.ports, cfgDocs, { runId: 'r-fx', caseId: 'E2E-PAY-1', sessionRunner: runner });
    expect(res.ok).toBe(true);
    const ctx = calls[0] as { docs?: { path: string; content: string }[] };
    expect(ctx.docs).toHaveLength(1);
    expect(ctx.docs![0]!.path).toBe('docs/app/README.md');
    expect(ctx.docs![0]!.content).toMatch(/api\/test\/seed/);
  });

  it('case w innym stanie niż blocked(fixture-gap) → błąd', async () => {
    const { config, f } = await setup();
    const st = await f.state.load('r-fx');
    transitionCase(st!.state, 'E2E-PAY-1', 'triaged');
    await f.state.save('r-fx', st!.state, st!.version);
    const { runner } = fakeRunner({ verifyExit: 0 });
    await expect(
      runFixtureAuthor(f.ports, config, { runId: 'r-fx', caseId: 'E2E-PAY-1', sessionRunner: runner }),
    ).rejects.toThrow(/blocked\(fixture-gap\)/);
  });
});
