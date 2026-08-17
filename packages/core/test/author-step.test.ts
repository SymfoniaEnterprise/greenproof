/**
 * Deterministyczne części kroku author: świeży kontekst triażu przed KAŻDĄ
 * sesją (bug „stęchły context.json po fixture-authorze"), klasyfikacja wyniku.
 * Sesja agenta wstrzykiwana jako fake (sessionRunner).
 */
import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeFakePorts, makeGreenReport, makeRedAssertionReport } from '@greenproof/testing';
import { GreenproofConfigSchema } from '../src/schemas/index.js';
import { runFilter } from '../src/steps/filter.js';
import { runTriage } from '../src/steps/triage.js';
import { runAuthor } from '../src/steps/author.js';
import { runFixtureAuthor } from '../src/steps/fixtureAuthor.js';
import { runPreventiveFixtures } from '../src/steps/preventiveFixture.js';
import { transitionCase } from '../src/machine/pipeline.js';
import { appendAttempt, lastAttempt, readLedger } from '../src/ledger/store.js';
import { AuthorSessionState } from '../src/author/state.js';
import type { AuthorSessionOptions, AuthorSessionResult } from '../src/author/session.js';
import type { FixtureSessionResult } from '../src/author/fixtureSession.js';
import type { NormalizedPlan } from '../src/domain/plan.js';
import type {
  CaseEndProgressEvent,
  CaseStartProgressEvent,
  ProgressEvent,
} from '../src/domain/progress.js';

const execFileP = promisify(execFile);

const plan: NormalizedPlan = {
  slug: 'au',
  cases: [
    {
      caseId: 'E2E-PAY-1', title: 'payroll', level: 'e2e', priority: 'P1',
      requirements: ['netto'], flows: ['payroll'], type: 'lista-plac',
    },
  ],
};

async function setup(capsOverride: Record<string, unknown> = {}) {
  const repo = await mkdtemp(join(tmpdir(), 'gp-au-repo-'));
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
    caps: { seedFuse: { churnProneTypes: ['lista-plac'] }, ...capsOverride },
  });

  const f = makeFakePorts();
  f.scm.seedBranch('main', {});
  await runFilter(f.ports, config, { runId: 'r-au', envUrl: 'http://127.0.0.1:9', ref: 'main', runRef: 'x', plan });
  await runTriage(f.ports, config, { runId: 'r-au' });
  return { repo, config, f };
}

/**
 * Fake sesji autora: rejestruje przekazany kontekst, domyślnie kończy próbę
 * porażką. `perCall` nadpisuje wynik kolejnych wywołań (ostatni wpis się powtarza).
 */
function fakeAuthorRunner(perCall: Partial<AuthorSessionResult>[] = []) {
  const contexts: AuthorSessionOptions['context'][] = [];
  const runner = async (opts: AuthorSessionOptions): Promise<AuthorSessionResult> => {
    const override = perCall[Math.min(contexts.length, perCall.length - 1)] ?? {};
    contexts.push(opts.context);
    return {
      resultSubtype: 'success',
      structured: { status: 'failed', errors: ['nic z tego'] },
      state: new AuthorSessionState(),
      costUsdSdk: 0,
      durationMs: 1,
      messagesPath: '/dev/null',
      ...override,
    };
  };
  return { runner, contexts };
}

const SPEC_PATH = 'tests/e2e/payroll.spec.ts';
const SPEC_TITLE = 'lista płac wylicza netto z golden-case';

/**
 * Fake sesji, która dostarcza KOMPLET: spec na dysku + poprawny surowiec dowodu
 * mutacyjnego. Case przechodzi przez proving do delivered - tylko tak da się
 * sprawdzić rollup z passed>0 w case-end.
 */
function fakeDeliveringRunner(): (opts: AuthorSessionOptions) => Promise<AuthorSessionResult> {
  return async (opts) => {
    await mkdir(join(opts.cwd, 'tests/e2e'), { recursive: true });
    await writeFile(join(opts.cwd, SPEC_PATH), `test('${SPEC_TITLE}', async () => {});\n`);
    const state = new AuthorSessionState();
    state.turns = 7;
    state.costUsd = 0.5;
    state.proofMaterial = {
      greenRunReports: [
        makeGreenReport({ file: SPEC_PATH, testTitle: SPEC_TITLE }),
        makeGreenReport({ file: SPEC_PATH, testTitle: SPEC_TITLE }),
      ],
      mutation: {
        description: 'odwrócono oczekiwane netto',
        diff:
          '--- tests/e2e/payroll.spec.ts\n+++ tests/e2e/payroll.spec.ts\n' +
          '- expect(net).toBe("3214.50")\n+ expect(net).toBe("9999.99")',
        targetCondition: 'payroll-net pokazuje netto 3214.50',
      },
      redRunReport: makeRedAssertionReport({
        file: SPEC_PATH,
        testTitle: SPEC_TITLE,
        message:
          'Error: expect(locator).toHaveText(expected) failed\n\nLocator: getByTestId(\'payroll-net\')\nExpected string: "9999.99"\nReceived string: "3214.50"',
      }),
    };
    return {
      resultSubtype: 'success',
      structured: { status: 'delivered', specPath: SPEC_PATH },
      state,
      costUsdSdk: 0,
      durationMs: 1,
      messagesPath: '/dev/null',
    };
  };
}

/** Wynik sesji przerwanej watchdogiem startu (awaria bramy/backendu). */
const INFRA: Partial<AuthorSessionResult> = { resultSubtype: 'aborted', cappedBy: 'infra' };

/** Fake sesji fixture-author dostarczający zweryfikowany fixture paySeed. */
function fakeFixtureRunner() {
  return async (deps: { cwd: string }): Promise<FixtureSessionResult> => {
    await mkdir(join(deps.cwd, 'tests/support/fixtures'), { recursive: true });
    await writeFile(join(deps.cwd, 'tests/support/fixtures/paySeed.ts'), 'export async function seed(){}\n');
    await writeFile(join(deps.cwd, 'tests/support/fixtures/paySeed.verify.mjs'), 'process.exit(0);\n');
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
}

/**
 * Historia case'a: pierwsza próba autora skończona blocked(fixture-gap) + ledger.
 * Po niej zwykły budżet auto-retry (maxAutoRetries=1) jest już wyczerpany.
 */
async function seedFixtureGapHistory(f: Awaited<ReturnType<typeof setup>>['f']) {
  const st = await f.state.load('r-au');
  transitionCase(st!.state, 'E2E-PAY-1', 'authoring');
  transitionCase(st!.state, 'E2E-PAY-1', 'blocked', { blockedReason: 'fixture-gap', attempts: 1 });
  await f.state.save('r-au', st!.state, st!.version);
  await appendAttempt(f.artifacts, 'r-au', {
    attemptId: 'attempt-1', caseId: 'E2E-PAY-1', runId: 'r-au',
    startedAt: '2026-08-15T10:00:00Z', endedAt: '2026-08-15T10:20:00Z', trigger: 'initial',
    outcome: 'blocked', blockedReason: 'fixture-gap', costUsd: 0.01, turns: 45, playwrightRuns: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, phases: {},
    seedAttempts: [{ strategy: 'ui-klikanie', outcome: 'failed' }],
    lastErrors: [], filesTouched: [], commits: [], reusedPoms: [],
  });
}

describe('author step - świeży kontekst triażu', () => {
  it('ponowna próba po fixture-authorze widzi fixture w inventory i retryNotes w humanNotes', async () => {
    const { config, f } = await setup();
    await seedFixtureGapHistory(f);

    // Fixture-author dostarcza zweryfikowany fixture (case wraca do triaged).
    const fx = await runFixtureAuthor(f.ports, config, {
      runId: 'r-au', caseId: 'E2E-PAY-1', sessionRunner: fakeFixtureRunner(),
    });
    expect(fx.ok).toBe(true);

    // Ponowny author BEZ ręcznego triażu - sam musi odświeżyć kontekst.
    const { runner, contexts } = fakeAuthorRunner();
    const res = await runAuthor(f.ports, config, { runId: 'r-au', sessionRunner: runner });

    // 2 sesje: próba po fixture + jedno ponowienie z kredytu fixture (zwykła
    // pula auto-retry jest wyczerpana pierwszą próbą z historii).
    expect(contexts).toHaveLength(2);
    const ctx = contexts[0]!;
    expect(ctx.inventory.map((e) => e.name)).toContain('paySeed');
    expect(ctx.previousAttempt?.humanNotes).toMatch(/paySeed/);
    expect(res.results[0]!.status).toBe('attempt_failed');
  });

  it('branch case\'a wychodzi z warstwy prewencyjnej - fixture jest w drzewie brancha', async () => {
    const { repo, config, f } = await setup();
    const prev = await runPreventiveFixtures(f.ports, config, {
      runId: 'r-au', sessionRunner: fakeFixtureRunner(),
    });
    expect(prev.ok).toBe(true);

    const { runner, contexts } = fakeAuthorRunner();
    await runAuthor(f.ports, config, { runId: 'r-au', sessionRunner: runner });

    const files = (
      await execFileP('git', ['ls-tree', '-r', '--name-only', 'author/E2E-PAY-1'], { cwd: repo })
    ).stdout;
    expect(files).toContain('tests/support/fixtures/paySeed.ts');
    expect(contexts[0]!.inventory.map((e) => e.name)).toContain('paySeed');
  });

  it('pierwsza próba (bez historii) też dostaje kontekst i przechodzi przez sesję', async () => {
    const { config, f } = await setup();
    const { runner, contexts } = fakeAuthorRunner();
    const res = await runAuthor(f.ports, config, { runId: 'r-au', sessionRunner: runner });
    // maxAutoRetries=1: porażka pierwszej próby dostaje jedno auto-ponowienie.
    expect(contexts).toHaveLength(2);
    expect(contexts[0]!.case.caseId).toBe('E2E-PAY-1');
    expect(res.results[0]!.status).toBe('attempt_failed');
  });

  it('fixturesRef nieobecny lokalnie i bez remote → case startuje z baseRef z ostrzeżeniem', async () => {
    const { config, f } = await setup();
    // Wspólny branch istnieje tylko ZDALNIE (adapter API-owy); lokalny checkout
    // go nie zna, a remote nie istnieje - autor ma wystartować z baseRef, nie wywrócić.
    const st = await f.state.load('r-au');
    st!.state.fixturesRef = 'greenproof/fixtures/r-au';
    await f.state.save('r-au', st!.state, st!.version);

    const { runner } = fakeAuthorRunner();
    const res = await runAuthor(f.ports, config, { runId: 'r-au', sessionRunner: runner });

    // Case się wykonał (2 próby: porażka + auto-ponowienie), a nie wywalił na checkoutcie.
    expect(res.results[0]!.status).toBe('attempt_failed');
    expect(f.logger.messages('warn').some((m) => m.includes('greenproof/fixtures/r-au'))).toBe(true);
  });
});

describe('author step - zdarzenia postępu', () => {
  /** Sink postępu podpięty po fakcie - dokładnie tak wpina go host CLI. */
  function capture(f: Awaited<ReturnType<typeof setup>>['f']): ProgressEvent[] {
    const events: ProgressEvent[] = [];
    f.ports.progress = (e) => events.push(e);
    return events;
  }

  it('dostarczony case: case-start → case-end, caps z configu, rollup ze stanu PO zapisie', async () => {
    const { config, f } = await setup();
    const events = capture(f);

    const res = await runAuthor(f.ports, config, {
      runId: 'r-au', sessionRunner: fakeDeliveringRunner(),
    });
    expect(res.results[0]!.status).toBe('delivered');

    expect(events.map((e) => e.kind)).toEqual(['case-start', 'case-end']);

    const start = events[0] as CaseStartProgressEvent;
    expect(start.caseId).toBe('E2E-PAY-1');
    expect(start.attempt).toBe(1);
    expect(start.runId).toBe('r-au');
    expect(start.model).toBe('tani-model');
    expect(start.caps).toEqual({
      maxTurns: config.caps.maxTurns,
      maxTimeMinutes: config.caps.maxTimeMinutes,
      maxCostUsd: config.caps.maxCostUsd,
      maxPlaywrightRuns: config.caps.maxPlaywrightRuns,
      proofRuns: config.caps.proofRuns,
    });
    // Stan po przejściu w authoring: case jeszcze w toku.
    expect(start.rollup).toMatchObject({ total: 1, remaining: 1, done: 0, passed: 0 });

    const end = events[1] as CaseEndProgressEvent;
    const cs = (await f.state.load('r-au'))!.state.cases['E2E-PAY-1']!;
    expect(end.status).toBe('delivered');
    expect(end.status).toBe(cs.status);
    expect(end.attempt).toBe(1);
    expect(end.costUsd).toBe(0.5);
    expect(end.turns).toBe(7);
    // Rollup POLICZONY ZE STANU PO ZAPISIE - delivered liczy się jako passed.
    expect(end.rollup).toMatchObject({ total: 1, passed: 1, done: 1, remaining: 0, failed: 0 });
    expect(end.rollup.byStatus).toEqual({ delivered: 1 });
    expect(end.rollup.costUsd).toBe(0.5);
    expect(end.rollup.turns).toBe(7);
    expect(Date.parse(end.at)).not.toBeNaN();
  });

  it('każda próba ma własną parę case-start/case-end ze statusem zgodnym ze stanem', async () => {
    const { config, f } = await setup();
    const events = capture(f);

    const { runner } = fakeAuthorRunner();
    await runAuthor(f.ports, config, { runId: 'r-au', sessionRunner: runner });

    // Próba + auto-ponowienie (maxAutoRetries=1) - dwie pełne pary.
    expect(events.map((e) => e.kind)).toEqual(['case-start', 'case-end', 'case-start', 'case-end']);
    expect((events[0] as CaseStartProgressEvent).attempt).toBe(1);
    expect((events[2] as CaseStartProgressEvent).attempt).toBe(2);

    const cs = (await f.state.load('r-au'))!.state.cases['E2E-PAY-1']!;
    const end = events[3] as CaseEndProgressEvent;
    expect(end.status).toBe('attempt_failed');
    expect(end.status).toBe(cs.status);
    expect(end.rollup).toMatchObject({ total: 1, failed: 1, passed: 0, done: 1, remaining: 0 });
  });

  it('wywrotka sinka nie przewraca partii (emisja best-effort)', async () => {
    const { config, f } = await setup();
    f.ports.progress = () => {
      throw new Error('renderer padł');
    };
    const res = await runAuthor(f.ports, config, {
      runId: 'r-au', sessionRunner: fakeDeliveringRunner(),
    });
    expect(res.results[0]!.status).toBe('delivered');
  });
});

describe('author step - pule ponowień', () => {
  it('padnięty triaż/kontekst nie zostawia case\'a w authoring z żywym lease', async () => {
    const { config, f } = await setup({ maxAutoRetries: 0 });
    // Chwilowa awaria magazynu artefaktów przy odczycie kontekstu - dokładnie
    // między lease/authoring a startem sesji.
    const orig = f.ports.artifacts.get.bind(f.ports.artifacts);
    let tripped = false;
    f.ports.artifacts.get = async (runId: string, key: string) => {
      if (!tripped && key.includes('context')) {
        tripped = true;
        throw new Error('ENETDOWN: magazyn artefaktów niedostępny');
      }
      return orig(runId, key);
    };
    const res = await runAuthor(f.ports, config, { runId: 'r-au', sessionRunner: fakeDeliveringRunner() });

    // Awaria skonsumowała pulę infra i batch sam się podniósł do delivered.
    expect(res.results[0]!.status).toBe('delivered');
    const cs = (await f.state.load('r-au'))!.state.cases['E2E-PAY-1']!;
    expect(cs.lease).toBeUndefined();
    expect(cs.infraAttempts).toBe(1);
  });

  it('próby infra z wyjątku nie zawyżają fallbacku zwykłej puli (materializacja)', async () => {
    // 2 wyjątki (pula infra) + zwykłe porażki: zwykła pula (maxAutoRetries=1)
    // musi być nadal nietknięta po próbach infra - fallback attempts-1 zawyżałby.
    const { config, f } = await setup();
    const { runner: failingRunner, contexts } = fakeAuthorRunner([{}]);
    let thrown = 0;
    const runner = async (opts: Parameters<typeof failingRunner>[0]) => {
      if (thrown < 2) {
        thrown += 1;
        throw new Error('ECONNRESET: brama padła');
      }
      return failingRunner(opts);
    };
    const res = await runAuthor(f.ports, config, { runId: 'r-au', sessionRunner: runner });

    // 2 wyjątki + zwykła porażka + jedno zwykłe ponowienie = 2 konteksty sesji.
    expect(thrown).toBe(2);
    expect(contexts).toHaveLength(2);
    expect(res.results[0]!.status).toBe('attempt_failed');
    const cs = (await f.state.load('r-au'))!.state.cases['E2E-PAY-1']!;
    expect(cs.infraAttempts).toBe(2);
    expect(cs.autoRetriesUsed).toBe(1);
  });

  it('twardy wyjątek sesji (przed jej zwrotem) też idzie przez pulę infra', async () => {
    // Connection reset / 5xx mostka rzuca ZANIM sesja cokolwiek zwróci - to
    // awaria infrastruktury i musi konsumować maxInfraRetries, nie znikać.
    const { config, f } = await setup({ maxAutoRetries: 0 });
    let calls = 0;
    const runner = async (): Promise<never> => {
      calls += 1;
      throw new Error('ECONNRESET: brama padła');
    };
    const res = await runAuthor(f.ports, config, { runId: 'r-au', sessionRunner: runner });

    expect(calls).toBe(1 + config.caps.maxInfraRetries);
    expect(res.results[0]!.status).toBe('attempt_failed');
    expect(res.results[0]!.blockedReason).toBe('infra');
    const cs = (await f.state.load('r-au'))!.state.cases['E2E-PAY-1']!;
    expect(cs.status).toBe('attempt_failed');
    expect(cs.infraAttempts).toBe(config.caps.maxInfraRetries);
    expect(cs.autoRetriesUsed ?? 0).toBe(0);
  });

  it("przerwanie 'infra' → ledger interrupted/infra, ponowienia z puli infra, potem attempt_failed", async () => {
    // Bez zwykłej puli - widać czyste działanie puli infra (maxInfraRetries=2).
    const { config, f } = await setup({ maxAutoRetries: 0 });
    const { runner, contexts } = fakeAuthorRunner([INFRA]);
    const res = await runAuthor(f.ports, config, { runId: 'r-au', sessionRunner: runner });

    expect(contexts).toHaveLength(1 + config.caps.maxInfraRetries);
    expect(res.results[0]!.status).toBe('attempt_failed');

    const ledger = await readLedger(f.artifacts, 'r-au', 'E2E-PAY-1');
    expect(ledger).toHaveLength(3);
    const last = lastAttempt(ledger)!;
    expect(last.outcome).toBe('interrupted');
    expect(last.blockedReason).toBe('infra');

    const cs = (await f.state.load('r-au'))!.state.cases['E2E-PAY-1']!;
    expect(cs.infraAttempts).toBe(2);
    expect(cs.autoRetriesUsed).toBe(0);
  });

  it("próba 'infra' NIE zjada zwykłej puli auto-retry", async () => {
    const { config, f } = await setup();
    // 1. awaria infrastruktury, dalej zwykłe porażki.
    const { runner, contexts } = fakeAuthorRunner([INFRA, {}]);
    await runAuthor(f.ports, config, { runId: 'r-au', sessionRunner: runner });

    // 3 sesje: pierwsza (infra) + ponowienie z puli infra + ponowienie zwykłe.
    expect(contexts).toHaveLength(3);
    const cs = (await f.state.load('r-au'))!.state.cases['E2E-PAY-1']!;
    expect(cs.infraAttempts).toBe(1);
    expect(cs.autoRetriesUsed).toBe(1);
  });

  it('kredyt po fixture-authorze daje dokładnie jedno dodatkowe podejście', async () => {
    const { config, f } = await setup();
    await seedFixtureGapHistory(f); // zwykła pula auto-retry wyczerpana

    const fx = await runFixtureAuthor(f.ports, config, {
      runId: 'r-au', caseId: 'E2E-PAY-1', sessionRunner: fakeFixtureRunner(),
    });
    expect(fx.ok).toBe(true);
    expect((await f.state.load('r-au'))!.state.cases['E2E-PAY-1']!.fixtureRetryCredits).toBe(1);

    const { runner, contexts } = fakeAuthorRunner();
    const res = await runAuthor(f.ports, config, { runId: 'r-au', sessionRunner: runner });

    expect(contexts).toHaveLength(2); // próba + JEDNO ponowienie z kredytu
    expect(res.results[0]!.status).toBe('attempt_failed');
    const cs = (await f.state.load('r-au'))!.state.cases['E2E-PAY-1']!;
    expect(cs.fixtureRetryCredits).toBe(0);
  });

  it('dwa udane fixture-authory → dwa kredyty', async () => {
    const { config, f } = await setup();
    await seedFixtureGapHistory(f);

    for (let i = 0; i < 2; i += 1) {
      const fx = await runFixtureAuthor(f.ports, config, {
        runId: 'r-au', caseId: 'E2E-PAY-1', sessionRunner: fakeFixtureRunner(),
      });
      expect(fx.ok).toBe(true);
      if (i === 0) {
        // Ponowny fixture-gap na tym samym casie (triaged → authoring → blocked).
        const st = await f.state.load('r-au');
        transitionCase(st!.state, 'E2E-PAY-1', 'authoring');
        transitionCase(st!.state, 'E2E-PAY-1', 'blocked', { blockedReason: 'fixture-gap' });
        await f.state.save('r-au', st!.state, st!.version);
      }
    }

    const cs = (await f.state.load('r-au'))!.state.cases['E2E-PAY-1']!;
    expect(cs.fixtureRetryCredits).toBe(2);
  });

  // Regresja: raporty runów lokalnych pokazywały fantomowe kwoty ($11.70,
  // $60+) liczone cennikiem SDK, bo własny licznik = 0 traktowano jak brak
  // danych. Z priceTable zero jest LEGALNYM kosztem, nie brakiem pomiaru.
  it('z priceTable koszt 0 zostaje zerem, bez podstawiania wyceny SDK', async () => {
    const { repo, f } = await setup();
    const config = GreenproofConfigSchema.parse({
      platform: 'fake',
      plan: { source: 'json' },
      model: {
        authTokenEnv: 'T', author: 'lokalny-model',
        priceTable: { 'lokalny-model': { inPerMTok: 0, outPerMTok: 0, cacheReadPerMTok: 0 } },
      },
      paths: { testsRepoDir: repo },
      caps: { seedFuse: { churnProneTypes: ['lista-plac'] } },
    });

    const { runner } = fakeAuthorRunner([{ costUsdSdk: 42.5 }]);
    const res = await runAuthor(f.ports, config, { runId: 'r-au', sessionRunner: runner });

    expect(res.results[0]!.costUsd).toBe(0);
  });

  it('maxAutoRetries=0 + jeden kredyt → dokładnie jedno ponowienie', async () => {
    const { config, f } = await setup({ maxAutoRetries: 0 });
    const st = await f.state.load('r-au');
    st!.state.cases['E2E-PAY-1']!.fixtureRetryCredits = 1;
    await f.state.save('r-au', st!.state, st!.version);

    const { runner, contexts } = fakeAuthorRunner();
    const res = await runAuthor(f.ports, config, { runId: 'r-au', sessionRunner: runner });

    expect(contexts).toHaveLength(2);
    expect(res.results[0]!.status).toBe('attempt_failed');
    const cs = (await f.state.load('r-au'))!.state.cases['E2E-PAY-1']!;
    expect(cs.fixtureRetryCredits).toBe(0);
  });
});
