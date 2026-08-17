/**
 * Test integracyjny kroków pipeline'u na fake'ach portów - bez agenta.
 * Wynik pracy autora (spec, proof, ledger) jest symulowany dokładnie tak,
 * jak zapisuje go steps/author.ts.
 */
import { describe, expect, it } from 'vitest';
import { makeFakePorts, makeGreenReport, makeRedAssertionReport } from '@greenproof/testing';
import { runFilter } from '../src/steps/filter.js';
import { runTriage, contextKey, type CaseContext } from '../src/steps/triage.js';
import { runDeliver, proofArtifactKey, specArtifactKey } from '../src/steps/deliver.js';
import { runRetry } from '../src/steps/retry.js';
import { runAccept } from '../src/steps/accept.js';
import { runRelease } from '../src/steps/release.js';
import { transitionCase } from '../src/machine/pipeline.js';
import { validateProof } from '../src/proof/validator.js';
import { appendAttempt } from '../src/ledger/store.js';
import { GreenproofConfigSchema } from '../src/schemas/index.js';
import type { NormalizedPlan } from '../src/domain/plan.js';
import type { AttemptRecord } from '../src/domain/attempt.js';
import type { BlockedReason } from '../src/domain/state.js';

const config = GreenproofConfigSchema.parse({
  platform: 'fake',
  plan: { source: 'json' },
  model: { authTokenEnv: 'T', author: 'm' },
  paths: { testsRepoDir: '/tmp/x' },
  knowledge: { dir: 'knowledge' },
});

const plan: NormalizedPlan = {
  slug: 'demo',
  cases: [
    { caseId: 'E2E-001', title: 'netto na liście płac', level: 'e2e', priority: 'P0', requirements: ['AC-1'], flows: ['payroll'] },
    { caseId: 'E2E-002', title: 'pokryty wcześniej', level: 'e2e', priority: 'P1', requirements: ['AC-2'], flows: ['x'] },
    { caseId: 'UNIT-001', title: 'unit poza zakresem', level: 'unit', priority: 'P1', requirements: [], flows: [] },
  ],
};

function setup() {
  const f = makeFakePorts();
  // Repo testów: main z jednym już pokrytym case'em + indeks POM + wiedza.
  f.scm.seedBranch('main', {
    'tests/e2e/E2E-002-pokryty.spec.ts': '// istniejący spec',
    'tests/support/pom-index.json': JSON.stringify({
      version: 1,
      entries: [
        {
          name: 'PayrollPage', path: 'tests/support/pom/payroll.page.ts', kind: 'pom',
          description: 'Lista płac', covers: ['payroll'], keySelectors: ["getByTestId('payroll-create')"],
          reuseCount: 0, addedAt: '2026-08-01T00:00:00Z',
        },
      ],
    }),
    'knowledge/ui-traps.yaml': [
      'version: 1',
      'traps:',
      '  - component: dropdown',
      '    trap: portal przechwytuje klik',
      '    workaround: klikaj dropdown-child',
      '    category: component-behavior',
      '    appliesTo: [payroll]',
    ].join('\n'),
  });
  return f;
}

async function filterAndTriage(f: ReturnType<typeof setup>) {
  const filterOut = await runFilter(f.ports, config, {
    runId: 'r-1',
    envUrl: 'https://demo.local',
    ref: 'main',
    runRef: '42',
    plan,
  });
  await runTriage(f.ports, config, { runId: 'r-1' });
  return filterOut;
}

/** Symulacja wyniku pracy autora - dokładnie te artefakty i przejścia, które robi steps/author.ts. */
async function simulateDelivered(f: ReturnType<typeof setup>, caseId: string) {
  const file = 'tests/e2e/E2E-001-netto.spec.ts';
  const title = 'netto z golden-case';
  const proof = validateProof(
    {
      greenRunReports: [
        makeGreenReport({ file, testTitle: title }),
        makeGreenReport({ file, testTitle: title }),
      ],
      mutation: {
        description: 'odwrócone netto',
        diff: '--- tests/e2e/E2E-001-netto.spec.ts\n+++ tests/e2e/E2E-001-netto.spec.ts\n-a\n+b',
        targetCondition: 'netto golden-case 3214.50',
      },
      redRunReport: makeRedAssertionReport({ file, testTitle: title, message: 'Error: expect(locator).toHaveText(expected) failed\nExpected string: "9999"\nReceived string: "3214.50" netto golden-case' }),
    },
    { caseId, attemptId: 'attempt-1', gitDiffEmpty: true, restoredVerified: true },
  );
  expect(proof.verdict).toBe('valid');
  await f.artifacts.put('r-1', specArtifactKey(caseId), Buffer.from('// spec\nimport { PayrollPage } from "../support/pom/payroll.page.ts";\n'));
  await f.artifacts.put('r-1', proofArtifactKey(caseId), Buffer.from(JSON.stringify(proof)));
  const record: AttemptRecord = {
    attemptId: 'attempt-1', caseId, runId: 'r-1',
    startedAt: '2026-08-14T10:00:00Z', endedAt: '2026-08-14T10:20:00Z', trigger: 'initial',
    outcome: 'delivered', costUsd: 2.1, turns: 48, playwrightRuns: 3,
    tokens: { input: 1000, output: 500, cacheRead: 9000, cacheCreation: 100 },
    phases: { arrange: { turns: 10, playwrightRuns: 0 }, assert: { turns: 20, playwrightRuns: 3 } },
    lastErrors: [], filesTouched: [], commits: ['abc1234'], reusedPoms: ['PayrollPage'],
  };
  await appendAttempt(f.artifacts, 'r-1', record);
  const loaded = await f.state.load('r-1');
  transitionCase(loaded!.state, caseId, 'authoring');
  transitionCase(loaded!.state, caseId, 'proving');
  transitionCase(loaded!.state, caseId, 'delivered', {
    attempts: 1,
    costUsd: 2.1,
    artifacts: { ledger: `cases/${caseId}/ledger.jsonl`, spec: specArtifactKey(caseId), proof: proofArtifactKey(caseId) },
  });
  await f.state.save('r-1', loaded!.state, loaded!.version);
}

/** Symulacja case'a zablokowanego z powodem i notatką (zapis ledgera, jak robi steps/author.ts). */
async function simulateBlocked(
  f: ReturnType<typeof setup>,
  caseId: string,
  opts: { reason?: BlockedReason; note?: string; lastErrors?: string[] } = {},
) {
  const record: AttemptRecord = {
    attemptId: 'attempt-1', caseId, runId: 'r-1',
    startedAt: '2026-08-14T10:00:00Z', endedAt: '2026-08-14T10:20:00Z', trigger: 'initial',
    outcome: 'blocked', blockedReason: opts.reason, costUsd: 0.7, turns: 30, playwrightRuns: 2,
    tokens: { input: 1000, output: 500, cacheRead: 9000, cacheCreation: 100 },
    phases: {}, lastErrors: opts.lastErrors ?? [], filesTouched: [], commits: [], reusedPoms: [],
  };
  await appendAttempt(f.artifacts, 'r-1', record);
  const loaded = await f.state.load('r-1');
  transitionCase(loaded!.state, caseId, 'authoring');
  transitionCase(loaded!.state, caseId, 'blocked', {
    blockedReason: opts.reason,
    blockedNote: opts.note,
    branch: `author/${caseId}`,
    costUsd: 0.7,
  });
  await f.state.save('r-1', loaded!.state, loaded!.version);
}

describe('pipeline na fake\'ach', () => {
  it('filter: wybiera e2e, odsiewa pokryte i nie-e2e, melduje roster, jest idempotentny', async () => {
    const f = setup();
    const out = await filterAndTriage(f);
    expect(out.selected).toEqual(['E2E-001']);
    expect(out.skipped.sort()).toEqual(['E2E-002', 'UNIT-001']);
    expect(out.timeoutMinutes).toBe(45); // 20 + 25×1
    expect(f.human.reports.some((r) => r.report.kind === 'roster')).toBe(true);
    // Częściowa deduplikacja NIE generuje ostrzeżenia - to codzienny przypadek.
    expect(out.warnings.some((w) => w.includes('Nic do zrobienia'))).toBe(false);

    // Pusta selekcja przez pokrycie MUSI się wytłumaczyć i podpowiedzieć wyjście.
    const wszystkoPokryte = {
      ...plan,
      cases: plan.cases.filter((c) => c.caseId === 'E2E-002'), // ma już spec w repo
    };
    const pusty = await runFilter(f.ports, config, {
      runId: 'r-pusty', envUrl: 'https://demo.local', ref: 'main', runRef: '43', plan: wszystkoPokryte,
    });
    expect(pusty.selected).toEqual([]);
    expect(pusty.warnings.some((w) => w.includes('Nic do zrobienia') && w.includes('--tests-repo'))).toBe(true);

    // Idempotencja: ten sam plan → ten sam roster, bez duplikatu stanu.
    const again = await runFilter(f.ports, config, { runId: 'r-1', envUrl: 'https://demo.local', ref: 'main', runRef: '42', plan });
    expect(again.selected).toEqual(['E2E-001']);

    // Inny plan pod tym samym runId → błąd.
    const otherPlan = { ...plan, cases: plan.cases.slice(0, 1) };
    await expect(
      runFilter(f.ports, config, { runId: 'r-1', envUrl: 'https://demo.local', ref: 'main', runRef: '42', plan: otherPlan }),
    ).rejects.toThrow(/different plan/);
  });

  it('triage: kontekst zawiera inventory po flow, ui-traps i flagę churn-prone', async () => {
    const f = setup();
    await filterAndTriage(f);
    const ctx = JSON.parse(f.artifacts.getText('r-1', contextKey('E2E-001'))!) as CaseContext;
    expect(ctx.inventory.map((e) => e.name)).toEqual(['PayrollPage']);
    expect(ctx.uiTraps).toHaveLength(1);
    expect(ctx.churnProne).toBe(false);
    expect(ctx.attempt).toBe(1);
    expect(ctx.branch).toBe('author/E2E-001');
  });

  it('deliver → in_review z lintem i dowodem; retry wraca do triaged z uwagami', async () => {
    const f = setup();
    await filterAndTriage(f);
    await simulateDelivered(f, 'E2E-001');

    const delivered = await runDeliver(f.ports, config, { runId: 'r-1' });
    expect(delivered.reported.some((r) => r.includes('draft_delivered'))).toBe(true);
    const draft = f.human.byKind('draft_delivered')[0]!;
    expect(draft.markdown).toContain('valid');

    const retry = await runRetry(f.ports, { runId: 'r-1', caseId: 'E2E-001', notes: 'sprawdź teardown' });
    expect(retry.attempt).toBe(2);
    const st = await f.state.load('r-1');
    expect(st!.state.cases['E2E-001']!.status).toBe('triaged');
    expect(st!.state.cases['E2E-001']!.retryNotes).toBe('sprawdź teardown');

    // Triage po retry wkłada uwagi i digest do kontekstu.
    await runTriage(f.ports, config, { runId: 'r-1', caseId: 'E2E-001' });
    const ctx = JSON.parse(f.artifacts.getText('r-1', contextKey('E2E-001'))!) as CaseContext;
    expect(ctx.previousAttempt?.humanNotes).toBe('sprawdź teardown');
    expect(ctx.previousAttempt?.commits).toEqual(['abc1234']);
  });

  it('accept: PR + bump reuse; release: bramki i raport', async () => {
    const f = setup();
    await filterAndTriage(f);
    await simulateDelivered(f, 'E2E-001');
    await runDeliver(f.ports, config, { runId: 'r-1' });

    // Branch autora istnieje w SCM (symulacja pushu z sesji).
    f.scm.seedBranch('author/E2E-001', {
      ...f.scm.getFiles('main'),
      'tests/e2e/E2E-001-netto.spec.ts': '// spec',
    });

    const accepted = await runAccept(f.ports, config, { runId: 'r-1', caseId: 'E2E-001', targetBranch: 'main' });
    expect(accepted.prUrl).toMatch(/^fake:\/\/pr\//);
    // Licznik reuse podbity na branchu case'a.
    const idx = JSON.parse((await f.ports.scm.readFile('author/E2E-001', 'tests/support/pom-index.json'))!) as {
      entries: { name: string; reuseCount: number }[];
    };
    expect(idx.entries[0]!.reuseCount).toBe(1);

    const release = await runRelease(f.ports, config, { runId: 'r-1' });
    expect(release.pass).toBe(true);
    expect(release.gates.P0.done).toBe(1);
    expect(release.released).toEqual(['E2E-001']);
    const report = f.human.byKind('released')[0]!;
    expect(report.markdown).toContain('reuse POM: 1×');
  });

  it('deliver: fixturesRef bez indeksu POM nadal lintuje po bazowym inwentarzu (unia)', async () => {
    const f = setup();
    await filterAndTriage(f);
    // Branch fixture'ów bez pom-index - adapter czysto API-owy nie ma go po stronie zdalnej.
    f.scm.seedBranch('greenproof/fixtures/r-1', {});
    const st = await f.state.load('r-1');
    st!.state.fixturesRef = 'greenproof/fixtures/r-1';
    await f.state.save('r-1', st!.state, st!.version);
    await simulateDelivered(f, 'E2E-001');
    // Spec z surowym selektorem, który istnieje w bazowym POM (nie na branchu fixture'ów).
    await f.artifacts.put('r-1', specArtifactKey('E2E-001'),
      Buffer.from("await page.getByTestId('payroll-create').click();\n"));

    await runDeliver(f.ports, config, { runId: 'r-1' });
    const draft = f.human.byKind('draft_delivered')[0]!;
    const data = draft.data as { lint: { pomName: string }[] };
    expect(data.lint.map((l) => l.pomName)).toContain('PayrollPage');
  });

  it('deliver: blocked(other) z notatką → osobny raport app_defect_suspected, bez case_blocked', async () => {
    const f = setup();
    await filterAndTriage(f);
    await simulateBlocked(f, 'E2E-001', { reason: 'other', note: 'kontrakt API blokuje flow' });

    const delivered = await runDeliver(f.ports, config, { runId: 'r-1' });
    expect(delivered.reported).toContain('r-1:E2E-001:app_defect_suspected');

    const defect = f.human.byKind('app_defect_suspected')[0]!;
    expect(defect.title).toBe('E2E-001: możliwy defekt aplikacji (do przeglądu)');
    expect(defect.markdown).toContain('DEKLARACJA AGENTA');
    expect(defect.markdown).toContain('Notatka agenta: kontrakt API blokuje flow');
    expect(defect.markdown).toContain('author/E2E-001');
    expect(defect.markdown).toContain('$0.70');
    expect(defect.markdown).toContain('/retry <uwagi>');

    // Ten case NIE ma już raportu case_blocked.
    expect(f.human.byKind('case_blocked')).toHaveLength(0);
  });

  it('deliver: blocked(other) bez notatki → nadal case_blocked', async () => {
    const f = setup();
    await filterAndTriage(f);
    await simulateBlocked(f, 'E2E-001', { reason: 'other' });

    await runDeliver(f.ports, config, { runId: 'r-1' });
    expect(f.human.byKind('app_defect_suspected')).toHaveLength(0);
    expect(f.human.byKind('case_blocked')).toHaveLength(1);
  });

  it('deliver: blocked(fixture-gap) z notatką → nadal case_blocked', async () => {
    const f = setup();
    await filterAndTriage(f);
    await simulateBlocked(f, 'E2E-001', { reason: 'fixture-gap', note: 'brak POM-u' });

    await runDeliver(f.ports, config, { runId: 'r-1' });
    expect(f.human.byKind('app_defect_suspected')).toHaveLength(0);
    expect(f.human.byKind('case_blocked')).toHaveLength(1);
  });

  it('deliver: lastErrors z ledgera trafiają do data raportu app_defect_suspected', async () => {
    const f = setup();
    await filterAndTriage(f);
    await simulateBlocked(f, 'E2E-001', {
      reason: 'other',
      note: 'formularz admina ukryty na stałe',
      lastErrors: ['Error: expect(locator).toBeVisible() failed', 'TimeoutError'],
    });

    await runDeliver(f.ports, config, { runId: 'r-1' });
    const defect = f.human.byKind('app_defect_suspected')[0]!;
    const data = defect.data as { lastErrors: string[]; note: string };
    expect(data.lastErrors).toEqual(['Error: expect(locator).toBeVisible() failed', 'TimeoutError']);
    expect(data.note).toBe('formularz admina ukryty na stałe');
    expect(defect.markdown).toContain('Ostatnie błędy asercji');
  });

  it('release: niedomknięty P0 blokuje, P1 przechodzi tylko z waiverem', async () => {
    const f = setup();
    await filterAndTriage(f);
    // E2E-001 (P0) zostaje w triaged - bramka P0 musi lec.
    const fail = await runRelease(f.ports, config, { runId: 'r-1' });
    expect(fail.pass).toBe(false);
    expect(fail.gates.P0.pass).toBe(false);

    // Waiver nie ratuje P0.
    const waived = await runRelease(f.ports, config, {
      runId: 'r-1',
      waivers: [{ caseId: 'E2E-001', reason: 'znany bug' }],
    });
    expect(waived.gates.P0.pass).toBe(false);
  });
});
