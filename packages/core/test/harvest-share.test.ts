/**
 * Współdzielenie harvestu WEWNĄTRZ runu: po dostarczonym case'ie jego
 * zarejestrowane POM-y/fixture'y trafiają na wspólny branch fixture'ów
 * (greenproof/fixtures/<runId>), a triaż kolejnych case'ów widzi je bez
 * czekania na accept. Tu: shareCaseHarvest na fake'ach, triaż czytający
 * fixturesRef oraz wiring w steps/author.
 */
import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeFakePorts, makeGreenReport, makeRedAssertionReport } from '@greenproof/testing';
import { GreenproofConfigSchema } from '../src/schemas/index.js';
import { shareCaseHarvest } from '../src/harvest/share.js';
import { runFilter } from '../src/steps/filter.js';
import { runTriage, contextKey, type CaseContext } from '../src/steps/triage.js';
import { runAuthor } from '../src/steps/author.js';
import { AuthorSessionState } from '../src/author/state.js';
import type { AuthorSessionOptions, AuthorSessionResult } from '../src/author/session.js';
import type { PomIndex, PomIndexEntry } from '../src/domain/harvest.js';
import type { NormalizedPlan } from '../src/domain/plan.js';
import type { FileChange, ScmPort } from '../src/ports/index.js';

const execFileP = promisify(execFile);

const config = GreenproofConfigSchema.parse({
  platform: 'fake',
  plan: { source: 'json' },
  model: { authTokenEnv: 'T', author: 'm' },
  paths: { testsRepoDir: '/tmp/x' },
});

const INDEX_PATH = 'tests/support/pom-index.json';

function entry(name: string, path: string, covers: string[] = ['payroll']): PomIndexEntry {
  return {
    name,
    path,
    kind: 'pom',
    description: `${name} opis`,
    covers,
    keySelectors: [],
    harvestedBy: 'E2E-PAY-1',
    reuseCount: 0,
    addedAt: '2026-08-14T10:00:00Z',
  };
}

function indexOf(...entries: PomIndexEntry[]): string {
  return JSON.stringify({ version: 1, entries });
}

async function readIndex(f: ReturnType<typeof makeFakePorts>, ref: string): Promise<PomIndex> {
  return JSON.parse((await f.scm.readFile(ref, INDEX_PATH))!) as PomIndex;
}

/**
 * ScmPort owijający InMemoryScm: potrafi odrzucić N pierwszych commitów jako
 * konflikt CAS (`... was modified concurrently ...` - dokładnie tak sygnalizuje
 * przegraną update-ref adapter fs).
 */
class FlakyScm implements ScmPort {
  /** Ile kolejnych commitów ma zostać odrzuconych jako konflikt CAS. */
  rejectCommits = 0;

  constructor(private readonly inner: ScmPort) {}

  async ensureBranch(name: string, fromRef: string): Promise<void> {
    return this.inner.ensureBranch(name, fromRef);
  }

  async commitFiles(branch: string, files: FileChange[], message: string): Promise<{ sha: string }> {
    if (this.rejectCommits > 0) {
      this.rejectCommits -= 1;
      throw new Error(`Branch ${branch} was modified concurrently (expected 0000000): race`);
    }
    return this.inner.commitFiles(branch, files, message);
  }

  async readFile(ref: string, path: string): Promise<string | null> {
    return this.inner.readFile(ref, path);
  }

  async listFiles(ref: string, glob: string): Promise<string[]> {
    return this.inner.listFiles(ref, glob);
  }

  async openPullRequest(p: {
    from: string;
    to: string;
    title: string;
    body: string;
  }): Promise<{ url: string; id: string }> {
    return this.inner.openPullRequest(p);
  }
}

describe('shareCaseHarvest', () => {
  it("nowy wpis na branchu case'a → plik i indeks lądują na wspólnym branchu", async () => {
    const f = makeFakePorts();
    f.scm.seedBranch('main', {});
    const pom = entry('PayrollPage', 'tests/support/pom/payroll.page.ts');
    f.scm.seedBranch('author/A', {
      [INDEX_PATH]: indexOf(pom),
      'tests/support/pom/payroll.page.ts': 'export class PayrollPage {}',
    });

    const res = await shareCaseHarvest(f.ports, config, {
      runId: 'r-1', caseId: 'A', branch: 'author/A', baseRef: 'main',
    });

    expect(res.branch).toBe('greenproof/fixtures/r-1');
    expect(res.shared.map((e) => e.name)).toEqual(['PayrollPage']);
    expect(await f.scm.readFile(res.branch, 'tests/support/pom/payroll.page.ts')).toContain('PayrollPage');
    expect((await readIndex(f, res.branch)).entries.map((e) => e.name)).toEqual(['PayrollPage']);
    expect(f.scm.getCommits(res.branch)).toHaveLength(1);
    // Spec ani inne pliki brancha case'a nie przeciekły na wspólny branch.
    expect(await f.scm.readFile(res.branch, 'tests/e2e/A.spec.ts')).toBeNull();
  });

  it('wpis bez pliku na branchu → pominięty, brak commita i brancha, ostrzeżenie', async () => {
    const f = makeFakePorts();
    f.scm.seedBranch('main', {});
    const pom = entry('PayrollPage', 'tests/support/pom/payroll.page.ts');
    f.scm.seedBranch('author/A', { [INDEX_PATH]: indexOf(pom) });

    const res = await shareCaseHarvest(f.ports, config, {
      runId: 'r-1', caseId: 'A', branch: 'author/A', baseRef: 'main',
    });

    expect(res.shared).toEqual([]);
    expect(f.scm.hasBranch('greenproof/fixtures/r-1')).toBe(false);
    expect(f.logger.messages('warn').some((m) => m.includes('PayrollPage'))).toBe(true);
  });

  it('brak nowych wpisów → zero commitów i brak tworzenia brancha', async () => {
    const f = makeFakePorts();
    const pom = entry('PayrollPage', 'tests/support/pom/payroll.page.ts');
    f.scm.seedBranch('main', {
      [INDEX_PATH]: indexOf(pom),
      'tests/support/pom/payroll.page.ts': 'export class PayrollPage {}',
    });
    f.scm.seedBranch('author/A', {
      [INDEX_PATH]: indexOf(pom),
      'tests/support/pom/payroll.page.ts': 'export class PayrollPage {}',
    });

    const res = await shareCaseHarvest(f.ports, config, {
      runId: 'r-1', caseId: 'A', branch: 'author/A', baseRef: 'main',
    });

    expect(res.shared).toEqual([]);
    expect(f.scm.hasBranch('greenproof/fixtures/r-1')).toBe(false);
  });

  it('wpis o zmienionej ścieżce → plik przeniesiony pod nową ścieżką', async () => {
    const f = makeFakePorts();
    const oldPath = 'tests/support/pom/payroll.page.ts';
    const newPath = 'tests/support/pom/payroll.v2.page.ts';
    f.scm.seedBranch('main', {
      [INDEX_PATH]: indexOf(entry('PayrollPage', oldPath)),
      [oldPath]: 'export class PayrollPage {}',
    });
    f.scm.seedBranch('author/A', {
      [INDEX_PATH]: indexOf(entry('PayrollPage', newPath)),
      [newPath]: 'export class PayrollPage {}',
    });

    const res = await shareCaseHarvest(f.ports, config, {
      runId: 'r-1', caseId: 'A', branch: 'author/A', baseRef: 'main',
    });

    expect(res.shared).toHaveLength(1);
    const idx = await readIndex(f, res.branch);
    expect(idx.entries.find((e) => e.name === 'PayrollPage')!.path).toBe(newPath);
    expect(await f.scm.readFile(res.branch, newPath)).toContain('PayrollPage');
  });

  it('zmieniona treść pod tą samą ścieżką → plik przeniesiony (aktualizacja istniejącego POM)', async () => {
    const f = makeFakePorts();
    const path = 'tests/support/pom/payroll.page.ts';
    f.scm.seedBranch('main', {
      [INDEX_PATH]: indexOf(entry('PayrollPage', path)),
      [path]: 'export class PayrollPage { get netto() { return "3214.50"; } }',
    });
    f.scm.seedBranch('author/A', {
      [INDEX_PATH]: indexOf(entry('PayrollPage', path)),
      [path]: 'export class PayrollPage { get netto() { return "9999.99"; } }',
    });

    const res = await shareCaseHarvest(f.ports, config, {
      runId: 'r-1', caseId: 'A', branch: 'author/A', baseRef: 'main',
    });

    expect(res.shared.map((e) => e.name)).toEqual(['PayrollPage']);
    expect(await f.scm.readFile(res.branch, path)).toContain('9999.99');
    expect(f.scm.getCommits(res.branch)).toHaveLength(1);
  });

  it('identyczna treść pod tą samą ścieżką → brak commita i brancha', async () => {
    const f = makeFakePorts();
    const path = 'tests/support/pom/payroll.page.ts';
    const content = 'export class PayrollPage {}';
    f.scm.seedBranch('main', {
      [INDEX_PATH]: indexOf(entry('PayrollPage', path)),
      [path]: content,
    });
    f.scm.seedBranch('author/A', {
      [INDEX_PATH]: indexOf(entry('PayrollPage', path)),
      [path]: content,
    });

    const res = await shareCaseHarvest(f.ports, config, {
      runId: 'r-1', caseId: 'A', branch: 'author/A', baseRef: 'main',
    });

    expect(res.shared).toEqual([]);
    expect(f.scm.hasBranch('greenproof/fixtures/r-1')).toBe(false);
  });

  it('konflikt CAS przy dostawie → ponowienie po ponownym odczycie wspólnego indeksu', async () => {
    const f = makeFakePorts();
    f.scm.seedBranch('main', {});
    f.scm.seedBranch('author/A', {
      [INDEX_PATH]: indexOf(entry('PayrollPage', 'tests/support/pom/payroll.page.ts')),
      'tests/support/pom/payroll.page.ts': 'export class PayrollPage {}',
    });
    // Wspólny branch już istnieje - jakby drugi case dostarczył równolegle.
    f.scm.seedBranch('greenproof/fixtures/r-1', {
      [INDEX_PATH]: indexOf(entry('AnnexPage', 'tests/support/pom/annex.page.ts')),
      'tests/support/pom/annex.page.ts': 'export class AnnexPage {}',
    });

    const flaky = new FlakyScm(f.scm);
    flaky.rejectCommits = 1;
    f.ports.scm = flaky;

    const res = await shareCaseHarvest(f.ports, config, {
      runId: 'r-1', caseId: 'A', branch: 'author/A', baseRef: 'main', fixturesRef: 'greenproof/fixtures/r-1',
    });

    expect(res.shared.map((e) => e.name)).toEqual(['PayrollPage']);
    // Po ponowieniu indeks zawiera i istniejący wpis (Annex), i dorobiony (Payroll).
    expect((await readIndex(f, 'greenproof/fixtures/r-1')).entries.map((e) => e.name).sort())
      .toEqual(['AnnexPage', 'PayrollPage']);
  });

  it("wspólny branch istnieje, ale fixturesRef nieustawiony → wpis innego case'a nie ginie z indeksu", async () => {
    const f = makeFakePorts();
    f.scm.seedBranch('main', {});
    // Wspólny branch już zawiera wpis innego case'a (LoginPage) - a ten case
    // go nie widzi, bo state.fixturesRef nie zdążył się utrwalić (sharedRef =
    // baseRef). Jego commit nie może przepisać indeksu stanem sprzed LoginPage.
    f.scm.seedBranch('greenproof/fixtures/r-1', {
      [INDEX_PATH]: indexOf(entry('LoginPage', 'tests/support/pom/login.page.ts')),
      'tests/support/pom/login.page.ts': 'export class LoginPage {}',
    });
    f.scm.seedBranch('author/A', {
      [INDEX_PATH]: indexOf(entry('PayrollPage', 'tests/support/pom/payroll.page.ts')),
      'tests/support/pom/payroll.page.ts': 'export class PayrollPage {}',
    });

    const res = await shareCaseHarvest(f.ports, config, {
      runId: 'r-1', caseId: 'A', branch: 'author/A', baseRef: 'main',
    });

    expect(res.branch).toBe('greenproof/fixtures/r-1');
    expect(res.shared.map((e) => e.name)).toEqual(['PayrollPage']);
    // Po poprawce nextIndex bierze się z targetBranch: LoginPage z pierwszego
    // case'a i PayrollPage z tego case'a muszą współistnieć.
    expect((await readIndex(f, res.branch)).entries.map((e) => e.name).sort())
      .toEqual(['LoginPage', 'PayrollPage']);
    expect(await f.scm.readFile(res.branch, 'tests/support/pom/login.page.ts')).toContain('LoginPage');
  });

  it('wyczerpanie prób CAS → propaguje błąd konfliktu', async () => {
    const f = makeFakePorts();
    f.scm.seedBranch('main', {});
    f.scm.seedBranch('author/A', {
      [INDEX_PATH]: indexOf(entry('PayrollPage', 'tests/support/pom/payroll.page.ts')),
      'tests/support/pom/payroll.page.ts': 'export class PayrollPage {}',
    });
    f.scm.seedBranch('greenproof/fixtures/r-1', { [INDEX_PATH]: indexOf() });

    const flaky = new FlakyScm(f.scm);
    flaky.rejectCommits = 3;
    f.ports.scm = flaky;

    await expect(
      shareCaseHarvest(f.ports, config, {
        runId: 'r-1', caseId: 'A', branch: 'author/A', baseRef: 'main', fixturesRef: 'greenproof/fixtures/r-1',
      }),
    ).rejects.toThrow(/modified concurrently/);
  });

  it('drugi dostarczony case dokłada się do TEGO SAMEGO brancha', async () => {
    const f = makeFakePorts();
    f.scm.seedBranch('main', {});
    f.scm.seedBranch('author/A', {
      [INDEX_PATH]: indexOf(entry('PayrollPage', 'tests/support/pom/payroll.page.ts')),
      'tests/support/pom/payroll.page.ts': 'export class PayrollPage {}',
    });
    f.scm.seedBranch('author/B', {
      [INDEX_PATH]: indexOf(entry('AnnexPage', 'tests/support/pom/annex.page.ts')),
      'tests/support/pom/annex.page.ts': 'export class AnnexPage {}',
    });

    const first = await shareCaseHarvest(f.ports, config, {
      runId: 'r-1', caseId: 'A', branch: 'author/A', baseRef: 'main',
    });
    const second = await shareCaseHarvest(f.ports, config, {
      runId: 'r-1', caseId: 'B', branch: 'author/B', baseRef: 'main', fixturesRef: first.branch,
    });

    expect(second.branch).toBe(first.branch);
    expect((await readIndex(f, first.branch)).entries.map((e) => e.name)).toEqual([
      'PayrollPage', 'AnnexPage',
    ]);
    expect(f.scm.getCommits(first.branch)).toHaveLength(2);
  });

  it("ponowne wywołanie dla tego samego case'a jest idempotentne (brak drugiego commita)", async () => {
    const f = makeFakePorts();
    f.scm.seedBranch('main', {});
    const pom = entry('PayrollPage', 'tests/support/pom/payroll.page.ts');
    f.scm.seedBranch('author/A', {
      [INDEX_PATH]: indexOf(pom),
      'tests/support/pom/payroll.page.ts': 'export class PayrollPage {}',
    });

    const first = await shareCaseHarvest(f.ports, config, {
      runId: 'r-1', caseId: 'A', branch: 'author/A', baseRef: 'main',
    });
    expect(first.shared).toHaveLength(1);
    const commits = f.scm.getCommits(first.branch).length;

    // Drugie wywołanie: fixturesRef już wskazuje wspólny branch (jak po state.fixturesRef ??=).
    const second = await shareCaseHarvest(f.ports, config, {
      runId: 'r-1', caseId: 'A', branch: 'author/A', baseRef: 'main', fixturesRef: first.branch,
    });

    expect(second.shared).toEqual([]);
    expect(f.scm.getCommits(first.branch)).toHaveLength(commits);
  });
});

describe('triaż - indeks POM z fixturesRef', () => {
  const plan: NormalizedPlan = {
    slug: 'share',
    cases: [
      { caseId: 'E2E-001', title: 'payroll', level: 'e2e', priority: 'P1', requirements: [], flows: ['payroll'] },
    ],
  };

  it("kolejny case widzi wpis z poprzedniego case'a (inventory po flow)", async () => {
    const f = makeFakePorts();
    f.scm.seedBranch('main', { [INDEX_PATH]: indexOf() });
    await runFilter(f.ports, config, { runId: 'r-1', envUrl: 'http://x', ref: 'main', runRef: 'x', plan });
    // Wspólny branch ma dorobiony POM, a state.fixturesRef go wskazuje.
    f.scm.seedBranch('greenproof/fixtures/r-1', {
      [INDEX_PATH]: indexOf(entry('PayrollPage', 'tests/support/pom/payroll.page.ts')),
    });
    const st = await f.state.load('r-1');
    st!.state.fixturesRef = 'greenproof/fixtures/r-1';
    await f.state.save('r-1', st!.state, st!.version);

    await runTriage(f.ports, config, { runId: 'r-1' });
    const ctx = JSON.parse(f.artifacts.getText('r-1', contextKey('E2E-001'))!) as CaseContext;
    expect(ctx.inventory.map((e) => e.name)).toEqual(['PayrollPage']);
  });

  it('fixturesRef bez indeksu POM nie gubi bazowego inwentarza (unia z baseRef)', async () => {
    const f = makeFakePorts();
    f.scm.seedBranch('main', {
      [INDEX_PATH]: indexOf(entry('AnnexPage', 'tests/support/pom/annex.page.ts')),
    });
    await runFilter(f.ports, config, { runId: 'r-1', envUrl: 'http://x', ref: 'main', runRef: 'x', plan });
    // Branch fixture'ów NIE zawiera pom-index - adapter czysto API-owy nie ma go
    // po stronie zdalnej (readFile zwróci null → pusty indeks).
    f.scm.seedBranch('greenproof/fixtures/r-1', {});
    const st = await f.state.load('r-1');
    st!.state.fixturesRef = 'greenproof/fixtures/r-1';
    await f.state.save('r-1', st!.state, st!.version);

    await runTriage(f.ports, config, { runId: 'r-1' });
    const ctx = JSON.parse(f.artifacts.getText('r-1', contextKey('E2E-001'))!) as CaseContext;
    expect(ctx.inventory.map((e) => e.name)).toEqual(['AnnexPage']);
  });
});

describe('author - współdzielenie po dostarczonym case', () => {
  const plan: NormalizedPlan = {
    slug: 'au',
    cases: [
      { caseId: 'E2E-PAY-1', title: 'payroll', level: 'e2e', priority: 'P1', requirements: [], flows: ['payroll'] },
    ],
  };

  async function setup() {
    const repo = await mkdtemp(join(tmpdir(), 'gp-share-repo-'));
    const git = (...a: string[]) => execFileP('git', a, { cwd: repo, env: { ...process.env, LC_ALL: 'C' } });
    await git('init', '-b', 'main');
    await git('config', 'user.name', 't');
    await git('config', 'user.email', 't@t');
    await writeFile(join(repo, 'README.md'), 'demo');
    await git('add', '-A');
    await git('commit', '-m', 'init');

    const cfg = GreenproofConfigSchema.parse({
      platform: 'fake',
      plan: { source: 'json' },
      model: { authTokenEnv: 'T', author: 'tani-model' },
      paths: { testsRepoDir: repo },
    });
    const f = makeFakePorts();
    f.scm.seedBranch('main', {});
    await runFilter(f.ports, cfg, { runId: 'r-au', envUrl: 'http://127.0.0.1:9', ref: 'main', runRef: 'x', plan });
    await runTriage(f.ports, cfg, { runId: 'r-au' });
    return { repo, cfg, f, git };
  }

  const SPEC_PATH = 'tests/e2e/payroll.spec.ts';
  const SPEC_TITLE = 'lista płac wylicza netto z golden-case';

  function deliveringRunner(): (opts: AuthorSessionOptions) => Promise<AuthorSessionResult> {
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

  it('dostarczony case → fixturesRef ustawiony, plik i indeks na wspólnym branchu', async () => {
    const { cfg, f } = await setup();
    const pom = entry('PayrollPage', 'tests/support/pom/payroll.page.ts');
    f.scm.seedBranch('author/E2E-PAY-1', {
      [INDEX_PATH]: indexOf(pom),
      'tests/support/pom/payroll.page.ts': 'export class PayrollPage {}',
    });

    const res = await runAuthor(f.ports, cfg, { runId: 'r-au', sessionRunner: deliveringRunner() });

    expect(res.results[0]!.status).toBe('delivered');
    const state = (await f.state.load('r-au'))!.state;
    expect(state.fixturesRef).toBe('greenproof/fixtures/r-au');
    expect(await f.scm.readFile('greenproof/fixtures/r-au', 'tests/support/pom/payroll.page.ts')).toContain('PayrollPage');
    expect((await readIndex(f, 'greenproof/fixtures/r-au')).entries.map((e) => e.name)).toEqual(['PayrollPage']);
  });

  it('fixturesRef już ustawiony (prewencja) nie jest nadpisywany - case dokłada wpis na ten sam branch', async () => {
    const { cfg, f, git } = await setup();
    const preventive = entry('paySeed', 'tests/support/fixtures/paySeed.ts');
    const pom = entry('PayrollPage', 'tests/support/pom/payroll.page.ts');
    // Prewencja wytworzyła już wspólny branch (realny git + fake SCM) i wpis.
    await git('branch', 'greenproof/fixtures/r-au');
    f.scm.seedBranch('greenproof/fixtures/r-au', {
      [INDEX_PATH]: indexOf(preventive),
      'tests/support/fixtures/paySeed.ts': 'export async function seed(){}',
    });
    // Branch case'a wychodzi z warstwy prewencyjnej; agent dorobił własny POM.
    f.scm.seedBranch('author/E2E-PAY-1', {
      [INDEX_PATH]: indexOf(preventive, pom),
      'tests/support/fixtures/paySeed.ts': 'export async function seed(){}',
      'tests/support/pom/payroll.page.ts': 'export class PayrollPage {}',
    });
    const st = await f.state.load('r-au');
    st!.state.fixturesRef = 'greenproof/fixtures/r-au';
    await f.state.save('r-au', st!.state, st!.version);

    const res = await runAuthor(f.ports, cfg, { runId: 'r-au', sessionRunner: deliveringRunner() });

    expect(res.results[0]!.status).toBe('delivered');
    const state = (await f.state.load('r-au'))!.state;
    expect(state.fixturesRef).toBe('greenproof/fixtures/r-au');
    const idx = await readIndex(f, 'greenproof/fixtures/r-au');
    expect(idx.entries.map((e) => e.name).sort()).toEqual(['PayrollPage', 'paySeed']);
  });
});
