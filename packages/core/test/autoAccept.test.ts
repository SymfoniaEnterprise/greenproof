/**
 * Testy kroku auto-accept: deterministyczne kryterium (dowód valid, zero
 * ostrzeżeń walidatora, czysty lint) i odporność na awarię pojedynczego case'a. Reużywa fake'ów portów jak
 * steps.test.ts - bez agenta, wynik pracy autora symulowany.
 */
import { describe, expect, it } from 'vitest';
import { makeFakePorts, makeGreenReport, makeRedAssertionReport } from '@greenproof/testing';
import { runFilter } from '../src/steps/filter.js';
import { runTriage } from '../src/steps/triage.js';
import { runDeliver, proofArtifactKey, specArtifactKey } from '../src/steps/deliver.js';
import { runAutoAccept } from '../src/steps/autoAccept.js';
import { transitionCase } from '../src/machine/pipeline.js';
import { validateProof } from '../src/proof/validator.js';
import { appendAttempt } from '../src/ledger/store.js';
import { GreenproofConfigSchema } from '../src/schemas/index.js';
import type { NormalizedPlan } from '../src/domain/plan.js';
import type { AttemptRecord } from '../src/domain/attempt.js';

const config = GreenproofConfigSchema.parse({
  platform: 'fake',
  plan: { source: 'json' },
  model: { authTokenEnv: 'T', author: 'm' },
  paths: { testsRepoDir: '/tmp/x' },
});

const plan: NormalizedPlan = {
  slug: 'auto',
  cases: [
    { caseId: 'E2E-001', title: 'netto', level: 'e2e', priority: 'P0', requirements: ['R1'], flows: ['payroll'] },
    { caseId: 'E2E-002', title: 'brutto', level: 'e2e', priority: 'P1', requirements: ['R2'], flows: ['payroll'] },
  ],
};

function setup() {
  const f = makeFakePorts();
  f.scm.seedBranch('main', {
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
  });
  return f;
}

async function filterAndTriage(f: ReturnType<typeof setup>) {
  await runFilter(f.ports, config, {
    runId: 'r-1',
    envUrl: 'https://demo.local',
    ref: 'main',
    runRef: '42',
    plan,
  });
  await runTriage(f.ports, config, { runId: 'r-1' });
}

/** Pełny, deterministycznie walidny dowód (jak w steps.test.ts). */
function validProof(caseId: string) {
  const file = `tests/e2e/${caseId}.spec.ts`;
  const title = `case ${caseId}`;
  return validateProof(
    {
      greenRunReports: [
        makeGreenReport({ file, testTitle: title }),
        makeGreenReport({ file, testTitle: title }),
      ],
      // Mutacja i komunikat asercji MUSZĄ mówić o tym samym (`netto`), inaczej
      // walidator słusznie dokłada ostrzeżenie o słabym powiązaniu - a wtedy
      // dowód nie kwalifikuje się do auto-akceptacji.
      mutation: {
        description: 'odwrócone netto',
        diff: `--- ${file}\n+++ ${file}\n-  await expect(netto).toHaveText('3214.50');\n+  await expect(netto).toHaveText('9999');`,
        targetCondition: 'netto',
      },
      redRunReport: makeRedAssertionReport({ file, testTitle: title, message: 'Error: expect(netto).toHaveText(expected) failed\nExpected "9999"\nReceived "3214.50"' }),
    },
    { caseId, attemptId: 'attempt-1', gitDiffEmpty: true, restoredVerified: true },
  );
}

/**
 * Składa case w stan delivered z zadanym dowodem i spec'iem - dokładnie te
 * artefakty i przejścia, które robi steps/author.ts. `clearBranch` usuwa
 * branch autora (używane do symulacji awarii runAccept).
 */
async function deliverCase(
  f: ReturnType<typeof setup>,
  caseId: string,
  opts: { proof: Record<string, unknown>; spec: string; clearBranch?: boolean },
) {
  await f.artifacts.put('r-1', specArtifactKey(caseId), Buffer.from(opts.spec));
  await f.artifacts.put('r-1', proofArtifactKey(caseId), Buffer.from(JSON.stringify(opts.proof)));
  const record: AttemptRecord = {
    attemptId: 'attempt-1', caseId, runId: 'r-1',
    startedAt: '2026-08-14T10:00:00Z', endedAt: '2026-08-14T10:20:00Z', trigger: 'initial',
    outcome: 'delivered', costUsd: 2.1, turns: 48, playwrightRuns: 3,
    tokens: { input: 1000, output: 500, cacheRead: 9000, cacheCreation: 100 },
    phases: {}, lastErrors: [], filesTouched: [], commits: ['abc1234'], reusedPoms: [],
  };
  await appendAttempt(f.artifacts, 'r-1', record);
  const loaded = await f.state.load('r-1');
  transitionCase(loaded!.state, caseId, 'authoring');
  transitionCase(loaded!.state, caseId, 'proving');
  transitionCase(loaded!.state, caseId, 'delivered', {
    attempts: 1,
    costUsd: 2.1,
    artifacts: { ledger: `cases/${caseId}/ledger.jsonl`, spec: specArtifactKey(caseId), proof: proofArtifactKey(caseId) },
    ...(opts.clearBranch ? { branch: undefined } : {}),
  });
  await f.state.save('r-1', loaded!.state, loaded!.version);
}

const CLEAN_SPEC = 'import { PayrollPage } from "../support/pom/payroll.page.ts";\n';

describe('auto-accept', () => {
  it('akceptuje case z dowodem valid i czystym lintem', async () => {
    const f = setup();
    await filterAndTriage(f);
    await deliverCase(f, 'E2E-001', { proof: validProof('E2E-001'), spec: CLEAN_SPEC });
    await runDeliver(f.ports, config, { runId: 'r-1' });

    const out = await runAutoAccept(f.ports, config, { runId: 'r-1' });
    expect(out.accepted).toEqual(['E2E-001']);
    expect(out.waiting).toEqual([]);

    const st = await f.state.load('r-1');
    expect(st!.state.cases['E2E-001']!.status).toBe('accepted');
    // PR otwarty z baseRef jako gałęzią docelową.
    expect(f.scm.pullRequests.map((p) => p.to)).toContain('main');
  });

  it('NIE akceptuje case\'a z dowodem invalid', async () => {
    const f = setup();
    await filterAndTriage(f);
    await deliverCase(f, 'E2E-001', {
      proof: { caseId: 'E2E-001', attemptId: 'attempt-1', verdict: 'invalid', reasons: ['red run nie był własną asercją'] },
      spec: CLEAN_SPEC,
    });
    await runDeliver(f.ports, config, { runId: 'r-1' });

    const out = await runAutoAccept(f.ports, config, { runId: 'r-1' });
    expect(out.accepted).toEqual([]);
    expect(out.waiting).toEqual(['E2E-001']);
    expect(f.scm.pullRequests).toHaveLength(0);
  });

  it('NIE akceptuje dowodu valid, który ma ostrzeżenie walidatora', async () => {
    const f = setup();
    await filterAndTriage(f);
    // Ostrzeżenie znaczy "ważny mechanicznie, ale słabszy - niech człowiek
    // spojrzy". Auto-akceptacja skasowałaby jedyny moment, w którym ktoś je
    // przeczyta, więc taki case MUSI zostać w in_review.
    const proof = { ...validProof('E2E-001'), warnings: ['Słabe powiązanie komunikatu asercji z mutacją'] };
    expect(proof.verdict).toBe('valid');
    await deliverCase(f, 'E2E-001', { proof, spec: CLEAN_SPEC });
    await runDeliver(f.ports, config, { runId: 'r-1' });

    const out = await runAutoAccept(f.ports, config, { runId: 'r-1' });
    expect(out.accepted).toEqual([]);
    expect(out.waiting).toEqual(['E2E-001']);
    expect(f.scm.pullRequests).toHaveLength(0);
  });

  it('NIE akceptuje case\'a z duplikatem selektora (lint)', async () => {
    const f = setup();
    await filterAndTriage(f);
    await deliverCase(f, 'E2E-001', {
      proof: validProof('E2E-001'),
      // Surowy selektor, który istnieje już w POM (PayrollPage) - konflikt lintu.
      spec: "await page.getByTestId('payroll-create').click();\n",
    });
    await runDeliver(f.ports, config, { runId: 'r-1' });

    const out = await runAutoAccept(f.ports, config, { runId: 'r-1' });
    expect(out.accepted).toEqual([]);
    expect(out.waiting).toEqual(['E2E-001']);
    expect(f.scm.pullRequests).toHaveLength(0);
  });

  it('NIE akceptuje case\'a blocked', async () => {
    const f = setup();
    await filterAndTriage(f);
    const record: AttemptRecord = {
      attemptId: 'attempt-1', caseId: 'E2E-001', runId: 'r-1',
      startedAt: '2026-08-14T10:00:00Z', endedAt: '2026-08-14T10:20:00Z', trigger: 'initial',
      outcome: 'blocked', blockedReason: 'fixture-gap', costUsd: 0.7, turns: 30, playwrightRuns: 2,
      tokens: { input: 1000, output: 500, cacheRead: 9000, cacheCreation: 100 },
      phases: {}, lastErrors: [], filesTouched: [], commits: [], reusedPoms: [],
    };
    await appendAttempt(f.artifacts, 'r-1', record);
    const loaded = await f.state.load('r-1');
    transitionCase(loaded!.state, 'E2E-001', 'authoring');
    transitionCase(loaded!.state, 'E2E-001', 'blocked', {
      blockedReason: 'fixture-gap', branch: 'author/E2E-001', costUsd: 0.7,
    });
    await f.state.save('r-1', loaded!.state, loaded!.version);
    await runDeliver(f.ports, config, { runId: 'r-1' });

    const out = await runAutoAccept(f.ports, config, { runId: 'r-1' });
    expect(out.accepted).toEqual([]);
    expect(out.waiting).toEqual(['E2E-001']);
    expect(f.scm.pullRequests).toHaveLength(0);
  });

  it('awaria akceptacji jednego case\'a nie psuje pozostałych', async () => {
    const f = setup();
    await filterAndTriage(f);
    // E2E-001 bez brancha autora → runAccept rzuci; E2E-002 przejdzie.
    await deliverCase(f, 'E2E-001', { proof: validProof('E2E-001'), spec: CLEAN_SPEC, clearBranch: true });
    await deliverCase(f, 'E2E-002', { proof: validProof('E2E-002'), spec: CLEAN_SPEC });
    await runDeliver(f.ports, config, { runId: 'r-1' });

    const out = await runAutoAccept(f.ports, config, { runId: 'r-1' });
    expect(out.accepted).toEqual(['E2E-002']);
    expect(out.waiting).toEqual(['E2E-001']);

    const st = await f.state.load('r-1');
    expect(st!.state.cases['E2E-002']!.status).toBe('accepted');
    expect(st!.state.cases['E2E-001']!.status).toBe('in_review');
  });

  it('deliver rozróżnia „kwalifikuje się do auto-akceptacji" od „czeka na Ciebie"', async () => {
    const f = setup();
    await filterAndTriage(f);
    await deliverCase(f, 'E2E-001', { proof: validProof('E2E-001'), spec: CLEAN_SPEC });

    // autoAccept: true → raport „zaakceptowane automatycznie".
    await runDeliver(f.ports, config, { runId: 'r-1', autoAccept: true });
    const auto = f.human.byKind('draft_delivered')[0]!;
    expect((auto.data as { autoAccepted: boolean }).autoAccepted).toBe(true);
    expect(auto.markdown).toContain('Kwalifikuje się do auto-akceptacji');

    // Domyślnie (brak flagi) → „czeka na Ciebie".
    const g = setup();
    await filterAndTriage(g);
    await deliverCase(g, 'E2E-001', { proof: validProof('E2E-001'), spec: CLEAN_SPEC });
    await runDeliver(g.ports, config, { runId: 'r-1' });
    const waiting = g.human.byKind('draft_delivered')[0]!;
    expect((waiting.data as { autoAccepted: boolean }).autoAccepted).toBe(false);
    expect(waiting.markdown).toContain('Czeka na Ciebie');
  });
});
