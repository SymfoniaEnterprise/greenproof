import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../src/config/types.js';
import {
  AcceptInputSchema,
  AcceptOutputSchema,
  AppMapSchema,
  AppMapViewSchema,
  AttemptRecordSchema,
  AuthorInputSchema,
  AuthorOutputSchema,
  CaseStateSchema,
  DeliverInputSchema,
  DeliverOutputSchema,
  DuplicationFindingSchema,
  FilterInputSchema,
  FilterOutputSchema,
  FixtureInputSchema,
  GreenproofConfigSchema,
  LearnedChurnEntrySchema,
  LearnedChurnListSchema,
  LeaseSchema,
  MutationProofSchema,
  NormalizedPlanSchema,
  PipelineStateSchema,
  PlanCaseSchema,
  PomIndexEntrySchema,
  PomIndexSchema,
  PreventiveFixtureOutputSchema,
  ProofMaterialSchema,
  ReleaseInputSchema,
  ReleaseOutputSchema,
  RetryInputSchema,
  RunSummarySchema,
  StatusInputSchema,
  StatsInputSchema,
  TriageInputSchema,
  TriageOutputSchema,
  UiTrapSchema,
  UiTrapsSchema,
} from '../src/schemas/index.js';

const ISO = '2026-08-14T10:00:00Z';

const planCase = {
  caseId: '3.2-E2E-019',
  title: 'tworzy aneks ubezpieczenia',
  level: 'e2e',
  priority: 'P0',
  requirements: ['REQ-1'],
  flows: ['contract/annex'],
};

const runSummary = { testId: 'a.spec.ts::t', status: 'passed' };

describe('plan', () => {
  it('przyjmuje poprawny case i plan (pusta lista cases jest legalna)', () => {
    expect(PlanCaseSchema.parse(planCase).caseId).toBe('3.2-E2E-019');
    const plan = NormalizedPlanSchema.parse({ slug: 'aneks', cases: [] });
    expect(plan.cases).toEqual([]);
    expect(
      NormalizedPlanSchema.parse({
        slug: 'aneks',
        cases: [planCase],
        source: { format: 'bmad-tea', path: 'docs/test-design.md' },
      }).cases,
    ).toHaveLength(1);
  });

  it('odrzuca pusty caseId i nieznany priorytet', () => {
    expect(PlanCaseSchema.safeParse({ ...planCase, caseId: '' }).success).toBe(false);
    expect(PlanCaseSchema.safeParse({ ...planCase, priority: 'P9' }).success).toBe(false);
    expect(PlanCaseSchema.safeParse({ ...planCase, level: 'smoke' }).success).toBe(false);
    expect(NormalizedPlanSchema.safeParse({ cases: [] }).success).toBe(false);
  });

  it('pole opcjonalne nie przyjmuje jawnego undefined (exactOptional)', () => {
    expect(PlanCaseSchema.safeParse({ ...planCase, type: undefined }).success).toBe(false);
  });
});

describe('state', () => {
  const caseState = {
    caseId: 'C-1',
    status: 'authoring',
    priority: 'P1',
    attempts: 1,
    artifacts: { ledger: 'cases/C-1/ledger.jsonl' },
    costUsd: 0.42,
  };

  it('przyjmuje lease, case state i stan pipeline’u', () => {
    expect(LeaseSchema.parse({ owner: 'job-7', expiresAt: ISO }).owner).toBe('job-7');
    expect(CaseStateSchema.parse(caseState).status).toBe('authoring');
    const state = PipelineStateSchema.parse({
      runId: 'r-1',
      slug: 'aneks',
      planHash: 'deadbeef',
      envUrl: 'https://app.example.com',
      baseRef: 'main',
      runRef: 'issue-12',
      createdAt: ISO,
      cases: { 'C-1': caseState },
      totals: { costUsd: 0.42, turns: 11 },
    });
    expect(Object.keys(state.cases)).toEqual(['C-1']);
  });

  it('odrzuca nieznany status, ujemne próby i zły envUrl', () => {
    expect(CaseStateSchema.safeParse({ ...caseState, status: 'zombie' }).success).toBe(false);
    expect(CaseStateSchema.safeParse({ ...caseState, attempts: -1 }).success).toBe(false);
    expect(LeaseSchema.safeParse({ owner: 'j', expiresAt: 'wczoraj' }).success).toBe(false);
    expect(
      PipelineStateSchema.safeParse({
        runId: 'r-1',
        slug: 'aneks',
        planHash: 'x',
        envUrl: 'nie-url',
        baseRef: 'main',
        runRef: 'issue-12',
        createdAt: ISO,
        cases: {},
        totals: { costUsd: 0, turns: 0 },
      }).success,
    ).toBe(false);
  });
});

describe('attempt', () => {
  const attempt = {
    attemptId: 'a-1',
    caseId: 'C-1',
    runId: 'r-1',
    startedAt: ISO,
    endedAt: ISO,
    trigger: 'initial',
    outcome: 'delivered',
    costUsd: 1.5,
    turns: 42,
    playwrightRuns: 3,
    tokens: { input: 10, output: 20, cacheRead: 0, cacheCreation: 5 },
    phases: { arrange: { turns: 10, playwrightRuns: 0 } },
    seedAttempts: [{ strategy: 'ui', outcome: 'ok' }],
    lastErrors: [],
    filesTouched: ['tests/e2e/a.spec.ts'],
    commits: ['abc123'],
    reusedPoms: ['ContractAnnexPage'],
  };

  it('przyjmuje pełny wpis ledgera', () => {
    const parsed = AttemptRecordSchema.parse(attempt);
    expect(parsed.phases.arrange?.turns).toBe(10);
    expect(parsed.seedAttempts).toHaveLength(1);
  });

  it('odrzuca nieznany trigger i ułamkową liczbę tur', () => {
    expect(AttemptRecordSchema.safeParse({ ...attempt, trigger: 'cron' }).success).toBe(false);
    expect(AttemptRecordSchema.safeParse({ ...attempt, turns: 1.5 }).success).toBe(false);
    expect(
      AttemptRecordSchema.safeParse({ ...attempt, tokens: { input: 1 } }).success,
    ).toBe(false);
  });
});

describe('proof', () => {
  const proof = {
    caseId: 'C-1',
    attemptId: 'a-1',
    greenRuns: [runSummary, runSummary],
    mutation: { description: 'psuje sumę', diff: '--- a\n+++ b', targetCondition: 'suma == 100' },
    redRun: {
      testId: 'a.spec.ts::t',
      status: 'failed',
      failedInSameTest: true,
      failureKind: 'own-assertion',
      assertionMessage: 'expected 100',
    },
    restored: { verified: true, gitDiffEmpty: true },
    verdict: 'valid',
    reasons: [],
    warnings: [],
  };

  it('przyjmuje dowód i surowiec dowodu', () => {
    expect(RunSummarySchema.parse(runSummary).status).toBe('passed');
    expect(MutationProofSchema.parse(proof).greenRuns).toHaveLength(2);
    expect(
      ProofMaterialSchema.parse({
        greenRunReports: ['{}', '{}'],
        mutation: proof.mutation,
        redRunReport: '{}',
      }).redRunReport,
    ).toBe('{}');
    // proofTest jest opcjonalny - surowiec bez niego i z nim musi przechodzić.
    expect(
      ProofMaterialSchema.parse({
        greenRunReports: ['{}', '{}'],
        mutation: proof.mutation,
        redRunReport: '{}',
        proofTest: 'login.spec.ts::poprawne logowanie',
      }).proofTest,
    ).toBe('login.spec.ts::poprawne logowanie');
  });

  it('odrzuca jeden zielony przebieg i nieznany verdict', () => {
    expect(MutationProofSchema.safeParse({ ...proof, greenRuns: [runSummary] }).success).toBe(
      false,
    );
    expect(MutationProofSchema.safeParse({ ...proof, verdict: 'maybe' }).success).toBe(false);
    expect(RunSummarySchema.safeParse({ testId: 't', status: 'flaky' }).success).toBe(false);
  });
});

describe('harvest', () => {
  const entry = {
    name: 'ContractAnnexPage',
    path: 'tests/support/pom/contractAnnex.page.ts',
    kind: 'pom',
    description: 'Aneksy do umów',
    covers: ['contract/annex'],
    keySelectors: ['[data-test=annex-form]'],
    reuseCount: 0,
    addedAt: ISO,
  };

  it('przyjmuje wpis i indeks w wersji 1', () => {
    expect(PomIndexEntrySchema.parse(entry).kind).toBe('pom');
    expect(PomIndexSchema.parse({ version: 1, entries: [entry] }).entries).toHaveLength(1);
    expect(
      DuplicationFindingSchema.parse({
        specPath: 'tests/e2e/a.spec.ts',
        selector: '#x',
        pomName: 'ContractAnnexPage',
        pomPath: entry.path,
      }).selector,
    ).toBe('#x');
  });

  it('odrzuca inną wersję indeksu i nieznany kind', () => {
    expect(PomIndexSchema.safeParse({ version: 2, entries: [] }).success).toBe(false);
    expect(PomIndexEntrySchema.safeParse({ ...entry, kind: 'helper' }).success).toBe(false);
  });
});

describe('knowledge', () => {
  const trap = {
    component: 'dropdown-multiselect',
    trap: 'zamyka się po kliknięciu opcji',
    workaround: 'klikaj przez klawiaturę',
    category: 'component-behavior',
    appliesTo: ['payroll/create'],
    evidence: { caseId: 'C-1', attemptId: 'a-1' },
  };

  it('przyjmuje ui-traps, app-map i listę churn-prone', () => {
    expect(UiTrapSchema.parse(trap).component).toBe('dropdown-multiselect');
    expect(UiTrapsSchema.parse({ version: 1, traps: [trap] }).traps).toHaveLength(1);
    const view = {
      route: 'payroll/list',
      navigationSteps: ['Menu > Płace'],
      keySelectors: { table: '[data-test=table]' },
    };
    expect(AppMapViewSchema.parse(view).keySelectors['table']).toBe('[data-test=table]');
    expect(AppMapSchema.parse({ version: 1, views: [view] }).views).toHaveLength(1);
    const churn = {
      type: 'lista-plac',
      evidence: { caseId: 'C-1', runId: 'r-1', reason: 'seed-fuse' },
      addedAt: ISO,
      status: 'proposed',
      quietRuns: 0,
    };
    expect(LearnedChurnEntrySchema.parse(churn).status).toBe('proposed');
    expect(LearnedChurnListSchema.parse({ version: 1, entries: [churn] }).entries).toHaveLength(
      1,
    );
  });

  it('odrzuca nieznaną kategorię i zły powód wpisu churn', () => {
    expect(UiTrapSchema.safeParse({ ...trap, category: 'inne' }).success).toBe(false);
    expect(
      LearnedChurnEntrySchema.safeParse({
        type: 't',
        evidence: { caseId: 'C-1', runId: 'r-1', reason: 'nuda' },
        addedAt: ISO,
        status: 'active',
        quietRuns: 0,
      }).success,
    ).toBe(false);
  });
});

describe('config', () => {
  const minimal = {
    platform: '@greenproof/adapter-github',
    plan: { source: 'json' },
    model: { authTokenEnv: 'ANTHROPIC_AUTH_TOKEN', author: 'sonnet-4-5' },
    paths: { testsRepoDir: '/repo/tests' },
  };

  it('uzupełnia defaulty z DEFAULT_CONFIG dla częściowego wejścia', () => {
    const cfg = GreenproofConfigSchema.parse(minimal);
    expect(cfg.caps).toEqual(DEFAULT_CONFIG.caps);
    // Wartość świadomie wybrana, nie przypadkowa: przy 6 runach pula assert
    // wyczerpywała się przed dwoma zielonymi przebiegami i dowód mutacyjny
    // nie miał z czego wystartować.
    expect(cfg.caps.maxPlaywrightRuns).toBe(12);
    expect(cfg.qualityGates).toEqual(DEFAULT_CONFIG.qualityGates);
    expect(cfg.batching).toEqual(DEFAULT_CONFIG.batching);
    expect(cfg.paths).toEqual({
      testsRepoDir: '/repo/tests',
      pomDir: 'tests/support/pom',
      fixturesDir: 'tests/support/fixtures',
      pomIndex: 'tests/support/pom-index.json',
      specsDir: 'tests/e2e',
    });
  });

  it('scala defaulty zagnieżdżone z podanymi wartościami', () => {
    const cfg = GreenproofConfigSchema.parse({
      ...minimal,
      caps: { maxCostUsd: 12, seedFuse: { learn: 'auto' } },
      qualityGates: { P2: 0.5 },
    });
    expect(cfg.caps.maxCostUsd).toBe(12);
    expect(cfg.caps.maxTurns).toBe(DEFAULT_CONFIG.caps.maxTurns);
    expect(cfg.caps.seedFuse.learn).toBe('auto');
    expect(cfg.caps.seedFuse.maxFailedStrategies).toBe(
      DEFAULT_CONFIG.caps.seedFuse.maxFailedStrategies,
    );
    expect(cfg.qualityGates.P2).toBe(0.5);
    expect(cfg.qualityGates.P0).toBe(DEFAULT_CONFIG.qualityGates.P0);
  });

  it('defaulty playwright i nowych capów; appDocs opcjonalne', () => {
    const cfg = GreenproofConfigSchema.parse(minimal);
    expect(cfg.playwright).toEqual(DEFAULT_CONFIG.playwright);
    expect(cfg.playwright.command).not.toBe(DEFAULT_CONFIG.playwright.command);
    expect(cfg.caps.proofRuns).toBe(4);
    expect(cfg.caps.firstTurnTimeoutMinutes).toBe(5);
    expect(cfg.caps.maxInfraRetries).toBe(2);
    expect(cfg.caps.enforceRunPlaywrightTool).toBe(true);
    expect(cfg.caps.fixtureSession.maxTurns).toBe(80);
    expect(cfg.appDocs).toBeUndefined();
  });

  it('nadpisania per projekt nowych pól przechodzą', () => {
    const cfg = GreenproofConfigSchema.parse({
      ...minimal,
      caps: { proofRuns: 2, enforceRunPlaywrightTool: false, fixtureSession: { maxTurns: 120 } },
      playwright: { runTimeoutMinutes: 10 },
      appDocs: { paths: ['docs/README.md'] },
    });
    expect(cfg.caps.proofRuns).toBe(2);
    expect(cfg.caps.enforceRunPlaywrightTool).toBe(false);
    expect(cfg.caps.fixtureSession.maxTurns).toBe(120);
    expect(cfg.playwright.runTimeoutMinutes).toBe(10);
    expect(cfg.playwright.command).toEqual(DEFAULT_CONFIG.playwright.command);
    expect(cfg.appDocs?.maxChars).toBe(20000);
    expect(cfg.appDocs?.paths).toEqual(['docs/README.md']);
  });

  it('nie mutuje DEFAULT_CONFIG między parsami', () => {
    const a = GreenproofConfigSchema.parse(minimal);
    a.caps.seedFuse.churnProneTypes.push('lista-plac');
    const b = GreenproofConfigSchema.parse(minimal);
    expect(b.caps.seedFuse.churnProneTypes).toEqual([]);
    expect(DEFAULT_CONFIG.caps.seedFuse.churnProneTypes).toEqual([]);
  });

  it('odrzuca brak testsRepoDir, zły plan.source i próg poza 0..1', () => {
    expect(GreenproofConfigSchema.safeParse({ ...minimal, paths: {} }).success).toBe(false);
    expect(
      GreenproofConfigSchema.safeParse({ ...minimal, plan: { source: 'yaml' } }).success,
    ).toBe(false);
    expect(
      GreenproofConfigSchema.safeParse({ ...minimal, qualityGates: { P0: 1.5 } }).success,
    ).toBe(false);
    expect(
      GreenproofConfigSchema.safeParse({ ...minimal, plan: { source: 'parser' } }).success,
    ).toBe(false);
  });
});

describe('io', () => {
  const base = {
    slug: 'aneks',
    envUrl: 'https://app.example.com',
    ref: 'main',
    runRef: 'issue-12',
  };

  it('filter: plan inline i plan przez ścieżkę', () => {
    const inline = FilterInputSchema.parse({
      ...base,
      plan: { slug: 'aneks', cases: [planCase] },
    });
    expect('cases' in inline.plan && inline.plan.cases).toHaveLength(1);
    const byPath = FilterInputSchema.parse({
      ...base,
      runId: 'r-1',
      plan: { path: 'docs/plan.json' },
    });
    expect('path' in byPath.plan && byPath.plan.path).toBe('docs/plan.json');
  });

  it('filter: odrzuca zły envUrl i plan bez sluga/ścieżki', () => {
    expect(FilterInputSchema.safeParse({ ...base, envUrl: 'app', plan: { path: 'p' } }).success).toBe(
      false,
    );
    expect(FilterInputSchema.safeParse({ ...base, plan: { cases: [] } }).success).toBe(false);
    expect(
      FilterOutputSchema.parse({
        runId: 'r-1',
        selected: ['C-1'],
        skipped: [],
        timeoutMinutes: 45,
        warnings: [],
      }).timeoutMinutes,
    ).toBe(45);
    expect(
      FilterOutputSchema.safeParse({
        runId: 'r-1',
        selected: [],
        skipped: [],
        timeoutMinutes: 0,
        warnings: [],
      }).success,
    ).toBe(false);
  });

  it('triage / author / deliver', () => {
    expect(TriageInputSchema.parse({ runId: 'r-1' }).caseId).toBeUndefined();
    expect(TriageInputSchema.safeParse({}).success).toBe(false);
    expect(
      TriageOutputSchema.parse({ contexts: [{ caseId: 'C-1', artifactKey: 'k' }] }).contexts,
    ).toHaveLength(1);
    expect(TriageOutputSchema.safeParse({ contexts: [{ caseId: 'C-1' }] }).success).toBe(false);

    expect(AuthorInputSchema.parse({ runId: 'r-1', caseIds: ['C-1'] }).caseIds).toEqual(['C-1']);
    expect(AuthorInputSchema.safeParse({ runId: 'r-1', caseIds: 'C-1' }).success).toBe(false);
    expect(
      AuthorOutputSchema.parse({
        results: [{ caseId: 'C-1', status: 'delivered', costUsd: 1.2, turns: 30 }],
      }).results[0]?.status,
    ).toBe('delivered');
    expect(
      AuthorOutputSchema.safeParse({
        results: [{ caseId: 'C-1', status: 'delivered', costUsd: -1, turns: 30 }],
      }).success,
    ).toBe(false);

    expect(DeliverInputSchema.parse({ runId: 'r-1' }).runId).toBe('r-1');
    expect(DeliverOutputSchema.parse({ reported: ['C-1'] }).reported).toEqual(['C-1']);
    expect(DeliverOutputSchema.safeParse({ reported: 'C-1' }).success).toBe(false);
  });

  it('retry / accept / release / status', () => {
    expect(RetryInputSchema.parse({ runId: 'r-1', caseId: 'C-1', notes: 'popraw' }).notes).toBe(
      'popraw',
    );
    expect(RetryInputSchema.safeParse({ runId: 'r-1' }).success).toBe(false);

    expect(
      AcceptInputSchema.parse({ runId: 'r-1', caseId: 'C-1', targetBranch: 'main' }).targetBranch,
    ).toBe('main');
    expect(AcceptInputSchema.safeParse({ runId: 'r-1', caseId: 'C-1' }).success).toBe(false);
    expect(AcceptOutputSchema.parse({ prUrl: 'https://github.com/o/r/pull/1' }).prUrl).toContain(
      'pull/1',
    );
    expect(AcceptOutputSchema.safeParse({ prUrl: 'pull/1' }).success).toBe(false);

    expect(
      ReleaseInputSchema.parse({
        runId: 'r-1',
        waivers: [{ caseId: 'C-1', reason: 'znany bug' }],
      }).waivers,
    ).toHaveLength(1);
    expect(
      ReleaseInputSchema.safeParse({ runId: 'r-1', waivers: [{ caseId: 'C-1' }] }).success,
    ).toBe(false);
    const release = ReleaseOutputSchema.parse({
      gates: { P0: { required: 1, actual: 1, pass: true, total: 3, done: 3, missing: [] } },
      pass: true,
      released: ['C-1'],
      churn: { added: [], expired: [] },
    });
    expect(release.gates['P0']?.pass).toBe(true);
    expect(
      ReleaseOutputSchema.safeParse({
        gates: { P0: { required: 1, actual: 1, pass: true, total: 3 } },
        pass: true,
      }).success,
    ).toBe(false);

    expect(StatusInputSchema.parse({ runId: 'r-1' }).runId).toBe('r-1');
    expect(StatusInputSchema.safeParse({ runId: '' }).success).toBe(false);
    expect(StatsInputSchema.parse({ runId: 'r-1' }).runId).toBe('r-1');
    expect(StatsInputSchema.safeParse({ runId: '' }).success).toBe(false);
  });

  it('fixture: tryb domyślny zgodny wstecz, preventive bez caseId', () => {
    // Stare wejście {runId, caseId} parsuje się jak dotąd - dochodzi tylko mode.
    const legacy = FixtureInputSchema.parse({ runId: 'r-1', caseId: 'C-1' });
    expect(legacy.mode).toBe('case');
    expect(legacy.caseId).toBe('C-1');
    // caseId jest wymagane WYŁĄCZNIE w trybie 'case'.
    expect(FixtureInputSchema.safeParse({ runId: 'r-1' }).success).toBe(false);
    const preventive = FixtureInputSchema.parse({
      runId: 'r-1', mode: 'preventive', types: ['lista-plac'],
    });
    expect(preventive.caseId).toBeUndefined();
    expect(preventive.types).toEqual(['lista-plac']);
    expect(FixtureInputSchema.safeParse({ runId: 'r-1', mode: 'inny' }).success).toBe(false);

    const out = PreventiveFixtureOutputSchema.parse({
      types: [{ type: 'lista-plac', status: 'delivered', caseId: 'C-1', costUsd: 0.3, turns: 12 }],
      costUsd: 0.3,
      turns: 12,
      ok: true,
    });
    expect(out.types[0]?.status).toBe('delivered');
    expect(
      PreventiveFixtureOutputSchema.safeParse({
        types: [{ type: 'lista-plac', status: 'nieznany', costUsd: 0, turns: 0 }],
        costUsd: 0, turns: 0, ok: true,
      }).success,
    ).toBe(false);
  });
});
