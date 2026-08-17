/**
 * Dwie bramki bezpieczeństwa kroku author:
 * 1. brudne repo testów - autor NIE startuje, zamiast zabrać cudzą pracę na
 *    branch case'a (`git checkout`) i zamieść ją do commitu (`git add -A`),
 * 2. nieudany push - case NIE może udawać dostarczonego (PR do brancha, którego
 *    commitów nie ma na zdalnym).
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
import { runPreventiveFixtures } from '../src/steps/preventiveFixture.js';
import { readLedger } from '../src/ledger/store.js';
import { AuthorSessionState } from '../src/author/state.js';
import { ALLOW_DIRTY_ENV, DirtyTestsRepoError, worktreeDirt } from '../src/util/localGit.js';
import type { AuthorSessionOptions, AuthorSessionResult } from '../src/author/session.js';
import type { NormalizedPlan } from '../src/domain/plan.js';

const execFileP = promisify(execFile);

const plan: NormalizedPlan = {
  slug: 'gd',
  cases: [
    {
      caseId: 'E2E-PAY-1', title: 'payroll', level: 'e2e', priority: 'P1',
      requirements: ['netto'], flows: ['payroll'], type: 'lista-plac',
    },
  ],
};

const SPEC_PATH = 'tests/e2e/payroll.spec.ts';
const SPEC_TITLE = 'lista płac wylicza netto z golden-case';

async function setup() {
  const repo = await mkdtemp(join(tmpdir(), 'gp-guard-repo-'));
  const git = (...a: string[]) => execFileP('git', a, { cwd: repo, env: { ...process.env, LC_ALL: 'C' } });
  await git('init', '-b', 'main');
  await git('config', 'user.name', 't');
  await git('config', 'user.email', 't@t');
  await writeFile(join(repo, 'README.md'), 'demo\n');
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
  await runFilter(f.ports, config, { runId: 'r-gd', envUrl: 'http://127.0.0.1:9', ref: 'main', runRef: 'x', plan });
  await runTriage(f.ports, config, { runId: 'r-gd' });
  return { repo, config, f, git };
}

/** Sesja dostarczająca komplet: spec na dysku + poprawny surowiec dowodu. */
function deliveringRunner(calls: AuthorSessionOptions[] = []) {
  return async (opts: AuthorSessionOptions): Promise<AuthorSessionResult> => {
    calls.push(opts);
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

describe('rozbiór `git status --porcelain -z`', () => {
  it('zmiana nazwy (dwa pola) i spacje w ścieżce nie mylą się z osobnym wpisem', async () => {
    const { repo, git } = await setup();
    await writeFile(join(repo, 'plik ze spacją.md'), 'a\n');
    await git('add', '-A');
    await git('commit', '-m', 'drugi plik');
    await git('mv', 'README.md', 'DOKUMENTACJA.md');
    await writeFile(join(repo, 'plik ze spacją.md'), 'b\n');
    await writeFile(join(repo, 'nowy nieśledzony.md'), 'c\n');

    const dirt = await worktreeDirt(repo);
    // Stara ścieżka NIE może wylądować jako osobny (błędnie sklasyfikowany) wpis.
    expect(dirt.tracked.sort()).toEqual([' M plik ze spacją.md', 'R  DOKUMENTACJA.md']);
    expect(dirt.untracked).toEqual(['nowy nieśledzony.md']);
  });
});

describe('bramka czystości repo testów', () => {
  it('niezacommitowana zmiana w śledzonym pliku zatrzymuje partię PRZED mutacją repo', async () => {
    const { repo, config, f } = await setup();
    // Praca użytkownika: zmiana w pliku śledzonym.
    await writeFile(join(repo, 'README.md'), 'MOJA NIEZACOMMITOWANA PRACA\n');
    const calls: AuthorSessionOptions[] = [];

    await expect(
      runAuthor(f.ports, config, { runId: 'r-gd', sessionRunner: deliveringRunner(calls) }),
    ).rejects.toBeInstanceOf(DirtyTestsRepoError);

    // Żadnej sesji, żadnej mutacji stanu, żadnego brancha case'a.
    expect(calls).toHaveLength(0);
    expect((await f.state.load('r-gd'))!.state.cases['E2E-PAY-1']!.status).toBe('triaged');
    const branches = await execFileP('git', ['branch', '--format=%(refname:short)'], { cwd: repo });
    expect(branches.stdout.trim()).toBe('main');
    // Praca użytkownika nietknięta.
    const status = await execFileP('git', ['status', '--porcelain'], { cwd: repo });
    expect(status.stdout).toContain('README.md');
  });

  it('komunikat mówi, CO jest brudne i co z tym zrobić', async () => {
    const { repo, config, f } = await setup();
    await writeFile(join(repo, 'README.md'), 'zmiana\n');
    const err = await runAuthor(f.ports, config, { runId: 'r-gd', sessionRunner: deliveringRunner() })
      .then(() => null, (e: unknown) => e as DirtyTestsRepoError);
    expect(err).toBeInstanceOf(DirtyTestsRepoError);
    expect(err!.message).toContain('README.md');
    expect(err!.message).toContain('stash push -u');
    expect(err!.message).toContain(ALLOW_DIRTY_ENV);
    expect(err!.dirt.tracked).toEqual([' M README.md']);
  });

  it('same pliki NIEŚLEDZONE nie blokują startu (adapter fs trzyma state/ w repo testów)', async () => {
    const { repo, config, f } = await setup();
    await mkdir(join(repo, 'state'), { recursive: true });
    await writeFile(join(repo, 'state/r-gd.json'), '{}\n');

    const res = await runAuthor(f.ports, config, { runId: 'r-gd', sessionRunner: deliveringRunner() });
    expect(res.results[0]!.status).toBe('delivered');
    // ...ale człowiek dostaje ostrzeżenie, bo `git add -A` je zabierze.
    expect(f.logger.entries.some((e) => e.level === 'warn' && e.msg.includes('nieśledzonych'))).toBe(true);
  });

  it('GREENPROOF_ALLOW_DIRTY_TESTS_REPO=1 przepuszcza świadomego operatora', async () => {
    const { repo, config, f } = await setup();
    await writeFile(join(repo, 'README.md'), 'zmiana\n');
    const prev = process.env[ALLOW_DIRTY_ENV];
    process.env[ALLOW_DIRTY_ENV] = '1';
    try {
      const res = await runAuthor(f.ports, config, { runId: 'r-gd', sessionRunner: deliveringRunner() });
      expect(res.results[0]!.status).toBe('delivered');
    } finally {
      if (prev === undefined) delete process.env[ALLOW_DIRTY_ENV];
      else process.env[ALLOW_DIRTY_ENV] = prev;
    }
  });

  it('prewencyjne fixture\'y też nie ruszają brudnego repo', async () => {
    const { repo, config, f } = await setup();
    await writeFile(join(repo, 'README.md'), 'zmiana\n');
    let sessions = 0;
    await expect(
      runPreventiveFixtures(f.ports, config, {
        runId: 'r-gd',
        sessionRunner: async () => {
          sessions++;
          throw new Error('nie powinno dojść do sesji');
        },
      }),
    ).rejects.toBeInstanceOf(DirtyTestsRepoError);
    expect(sessions).toBe(0);
    const branches = await execFileP('git', ['branch', '--format=%(refname:short)'], { cwd: repo });
    expect(branches.stdout.trim()).toBe('main');
  });
});

describe('nieudany push nie udaje dostawy', () => {
  it('padnięty push blokuje delivered - case attempt_failed(infra) z pełnym ledgerem', async () => {
    const { config, f } = await setup();
    f.ports.scm.push = async () => {
      throw new Error('remote rejected: 403');
    };
    const calls: AuthorSessionOptions[] = [];

    const res = await runAuthor(f.ports, config, { runId: 'r-gd', sessionRunner: deliveringRunner(calls) });

    expect(res.results[0]!.status).toBe('attempt_failed');
    expect(res.results[0]!.blockedReason).toBe('infra');
    const cs = (await f.state.load('r-gd'))!.state.cases['E2E-PAY-1']!;
    expect(cs.status).toBe('attempt_failed');

    // Praca sesji NIE przepada: ledger, digest, koszt, commity, artefakty.
    const ledger = await readLedger(f.artifacts, 'r-gd', 'E2E-PAY-1');
    const last = ledger[ledger.length - 1]!;
    expect(last.outcome).toBe('attempt_failed');
    expect(last.blockedReason).toBe('infra');
    expect(last.costUsd).toBe(0.5);
    expect(last.turns).toBe(7);
    expect(last.commits.length).toBeGreaterThan(0);
    expect(last.digest).toBeDefined();
    expect(last.lastErrors.join(' ')).toContain('Push brancha');
    expect(await f.artifacts.get('r-gd', 'cases/E2E-PAY-1/spec.ts')).not.toBeNull();

    // Zepsuty zdalny jest systemowy - żadnego auto-retry (jedna sesja).
    expect(calls).toHaveLength(1);
  });

  it('adapter BEZ metody push dostarcza normalnie (push jest opcjonalny)', async () => {
    const { config, f } = await setup();
    delete (f.ports.scm as { push?: unknown }).push;

    const res = await runAuthor(f.ports, config, { runId: 'r-gd', sessionRunner: deliveringRunner() });
    expect(res.results[0]!.status).toBe('delivered');
  });

  it('udany push zostawia dostawę nietkniętą', async () => {
    const { config, f } = await setup();
    const res = await runAuthor(f.ports, config, { runId: 'r-gd', sessionRunner: deliveringRunner() });
    expect(res.results[0]!.status).toBe('delivered');
    expect(f.scm.pushed).toEqual(['author/E2E-PAY-1']);
  });
});
