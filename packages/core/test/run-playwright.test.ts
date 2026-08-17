/**
 * Narzędzie procesowe run_playwright: wersjonowanie raportu per przebieg
 * (współdzielony pw-report.json nadpisywał dowód) i DWIE pule budżetu runów
 * (assert + dowodowa) - pula dowodowa nie może być głodzona przez iteracje
 * dochodzenia do zieleni.
 *
 * Zamiast prawdziwego playwrighta uruchamiamy skrypt node'owy, który zapisuje
 * gotowy raport JSON (z @greenproof/testing) pod ścieżką ze zmiennej
 * środowiskowej i kończy się zadanym kodem wyjścia.
 */
import { describe, expect, it, beforeAll } from 'vitest';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeGreenReport, makeRedAssertionReport } from '@greenproof/testing';
import { createGreenproofTools, type ToolDeps } from '../src/author/tools.js';
import { AuthorSessionState } from '../src/author/state.js';
import { GreenproofConfigSchema } from '../src/schemas/index.js';
import type { CaseContext } from '../src/steps/triage.js';
import type { AuthorPhase } from '../src/domain/attempt.js';
import type { PlaywrightRunProgressEvent, ProgressEvent } from '../src/domain/progress.js';

/**
 * Fałszywy `playwright test`. Sterowany zmiennymi środowiskowymi testu:
 * FAKE_PW_MODE = env (raport pod ścieżką ze zmiennej) | shared (raport pod
 * współdzieloną ścieżką w cwd, zmienna zignorowana) | none (żadnego raportu),
 * FAKE_PW_REPORT = treść raportu, FAKE_PW_EXIT = kod wyjścia,
 * FAKE_PW_ARGV = plik, do którego skrypt zrzuca własne argv (kontrola budowania komendy).
 */
const FAKE_PW = `
import { writeFileSync, appendFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
const mode = process.env.FAKE_PW_MODE ?? 'env';
const report = process.env.FAKE_PW_REPORT ?? '{}';
if (process.env.FAKE_PW_ARGV) appendFileSync(process.env.FAKE_PW_ARGV, JSON.stringify(process.argv.slice(2)) + '\\n');
if (mode === 'orphan') {
  // Wnuk w TEJ SAMEJ grupie procesów - model dla npx -> node -> playwright.
  // Rodzic wisi dłużej niż limit czasu, wnuk zapisuje znacznik dopiero po chwili,
  // więc znacznik na dysku = wnuk przeżył ubicie rodzica.
  if (process.env.FAKE_PW_ROLE === 'child') {
    setTimeout(() => writeFileSync(process.env.FAKE_PW_MARKER, 'sierota'), Number(process.env.FAKE_PW_CHILD_MS));
  } else {
    spawn(process.execPath, [process.argv[1]], {
      stdio: 'ignore',
      env: { ...process.env, FAKE_PW_ROLE: 'child' },
    }).unref();
    setTimeout(() => {}, 60000);
  }
} else {
  if (mode === 'env') writeFileSync(process.env.PLAYWRIGHT_JSON_OUTPUT_NAME, report);
  else if (mode === 'shared') writeFileSync(join(process.cwd(), 'pw-report.json'), report);
  process.exit(Number(process.env.FAKE_PW_EXIT ?? '0'));
}
`;

const GREEN = makeGreenReport({ file: 'specs/pay.spec.ts', testTitle: 'nalicza netto' });
const RED = makeRedAssertionReport({
  file: 'specs/pay.spec.ts',
  testTitle: 'nalicza netto',
  matcher: 'toHaveText',
  expected: '4321.00',
  received: '4320.00',
});

let fakePwPath: string;

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gp-fakepw-'));
  fakePwPath = join(dir, 'fake-playwright.mjs');
  await writeFile(fakePwPath, FAKE_PW);
});

interface ToolDef {
  name: string;
  handler(args: Record<string, unknown>, extra: unknown): Promise<{ content: { text: string }[] }>;
}

interface Harness {
  state: AuthorSessionState;
  cwd: string;
  attemptDir: string;
  /** Zdarzenia postępu przechwycone przez onProgress w ToolDeps. */
  events: ProgressEvent[];
  call(name: string, args: Record<string, unknown>): Promise<string>;
  run(args?: Record<string, unknown>): Promise<string>;
  /** Ostatni wynik run_playwright sparsowany z pierwszej linii odpowiedzi. */
  lastRun(text: string): Record<string, unknown>;
}

async function makeHarness(
  capsOverride: Record<string, unknown> = {},
  phase: AuthorPhase = 'assert',
  pwOverride: Record<string, unknown> = {},
): Promise<Harness> {
  const cwd = await mkdtemp(join(tmpdir(), 'gp-pw-repo-'));
  const attemptDir = await mkdtemp(join(tmpdir(), 'gp-pw-attempt-'));
  // Spec, na który wskazują nagłówki diffa mutacji w testach record_proof_material
  // (bramka zasięgu wymaga, by plik istniał w repo testów).
  await mkdir(join(cwd, 'specs'), { recursive: true });
  await writeFile(join(cwd, 'specs/pay.spec.ts'), '// pay spec\n');
  const config = GreenproofConfigSchema.parse({
    platform: 'fake',
    plan: { source: 'json' },
    model: { authTokenEnv: 'T', author: 'tani-model' },
    paths: { testsRepoDir: cwd },
    caps: { maxPlaywrightRuns: 2, proofRuns: 2, ...capsOverride },
    playwright: { command: ['node', fakePwPath], ...pwOverride },
  });
  const context: CaseContext = {
    case: {
      caseId: 'E2E-PAY-1', title: 'payroll', level: 'e2e', priority: 'P1',
      requirements: ['netto'], flows: ['payroll'],
    },
    envUrl: 'http://127.0.0.1:9',
    branch: 'gp/E2E-PAY-1',
    attempt: 1,
    inventory: [],
    uiTraps: [],
    appMapViews: [],
    churnProne: false,
    oracleFiles: [],
  };
  const state = new AuthorSessionState();
  state.markPhase(phase);
  const events: ProgressEvent[] = [];
  const deps: ToolDeps = {
    state,
    config,
    context,
    cwd,
    attemptDir,
    clock: { now: () => new Date('2026-01-01T00:00:00Z') },
    runId: 'r-pw',
    onProgress: (e) => events.push(e),
  };
  const tools = createGreenproofTools(deps) as unknown as ToolDef[];
  const call = async (name: string, args: Record<string, unknown>): Promise<string> => {
    const t = tools.find((x) => x.name === name);
    if (!t) throw new Error(`brak narzędzia ${name}`);
    return (await t.handler(args, {})).content[0]!.text;
  };
  return {
    state,
    cwd,
    attemptDir,
    events,
    call,
    run: (args = {}) => call('run_playwright', { purpose: 'green', extraArgs: [], ...args }),
    lastRun: (text) => JSON.parse(text.split('\n')[0]!) as Record<string, unknown>,
  };
}

/** Ustawia zachowanie fałszywego playwrighta na czas jednego wywołania. */
function fakePw(opts: { mode?: string; report?: string; exit?: number; argvFile?: string }): void {
  process.env['FAKE_PW_MODE'] = opts.mode ?? 'env';
  process.env['FAKE_PW_REPORT'] = opts.report ?? GREEN;
  process.env['FAKE_PW_EXIT'] = String(opts.exit ?? 0);
  if (opts.argvFile) process.env['FAKE_PW_ARGV'] = opts.argvFile;
  else delete process.env['FAKE_PW_ARGV'];
}

describe('run_playwright - wersjonowanie raportów', () => {
  it('każdy przebieg dostaje własny plik run-NN-<purpose>.json', async () => {
    const h = await makeHarness({ maxPlaywrightRuns: 6 });
    fakePw({});
    const first = h.lastRun(await h.run());
    const second = h.lastRun(await h.run());
    expect(String(first['reportPath'])).toContain(join('pw-runs', 'run-01-green.json'));
    expect(String(second['reportPath'])).toContain(join('pw-runs', 'run-02-green.json'));
    expect(first['reportPath']).not.toBe(second['reportPath']);
    expect(existsSync(String(first['reportPath']))).toBe(true);
    expect(existsSync(String(second['reportPath']))).toBe(true);
    expect(first['runIndex']).toBe(1);
    expect(second['runIndex']).toBe(2);
    // Purpose jest tylko etykietą - trafia do nazwy pliku i telemetrii.
    const red = h.lastRun(await h.run({ purpose: 'red' }));
    expect(String(red['reportPath'])).toContain('run-03-red.json');
  });

  it('buduje argv z komendy z configu: spec, --grep, --reporter=json, extraArgs', async () => {
    const h = await makeHarness({ maxPlaywrightRuns: 6 });
    const argvFile = join(h.attemptDir, 'argv.log');
    fakePw({ argvFile });
    await h.run({ specPath: 'specs/pay.spec.ts', grep: 'netto', extraArgs: ['--workers=1'] });
    const argv = JSON.parse((await readFile(argvFile, 'utf8')).trim()) as string[];
    expect(argv).toEqual(['specs/pay.spec.ts', '--grep', 'netto', '--reporter=json', '--workers=1']);
  });

  it(
    'timeout ubija CAŁE drzewo - wnuk nie zostaje sierotą',
    async () => {
      const h = await makeHarness({}, 'assert', { runTimeoutMinutes: 0.01 });
      const marker = join(h.attemptDir, 'sierota.txt');
      fakePw({ mode: 'orphan' });
      process.env['FAKE_PW_MARKER'] = marker;
      process.env['FAKE_PW_CHILD_MS'] = '2500';
      try {
        const out = await h.run();
        // Timeout to nadal AWARIA przebiegu, nie czerwone testy: brak raportu,
        // kod -1 i notatka o limicie czasu.
        expect(out).toContain('BRAK RAPORTU');
        expect(out).toContain('twardy limit');
        expect(out).toContain('kod wyjścia -1');
        // Znacznik pisze się później niż ubicie rodzica - jeśli powstanie,
        // znaczy, że wnuk przeżył.
        await new Promise((resolve) => setTimeout(resolve, 3500));
        expect(existsSync(marker)).toBe(false);
      } finally {
        delete process.env['FAKE_PW_MARKER'];
        delete process.env['FAKE_PW_CHILD_MS'];
      }
    },
    30_000,
  );

  it('kod wyjścia !=0 to normalny wynik (czerwone testy), nie awaria', async () => {
    const h = await makeHarness();
    fakePw({ report: RED, exit: 1 });
    const out = h.lastRun(await h.run({ purpose: 'red' }));
    expect(out['exitCode']).toBe(1);
    expect(out['failed']).toBe(1);
    expect(out['passed']).toBe(0);
    expect(String(out['firstError'])).toContain('4320.00');
    expect(h.state.greenRuns).toBe(0);
  });

  it('kopiuje współdzielony raport, gdy projekt zignorował zmienną środowiskową', async () => {
    const h = await makeHarness();
    fakePw({ mode: 'shared' });
    const out = h.lastRun(await h.run());
    expect(String(out['reportPath'])).toContain('run-01-green.json');
    expect(out['total']).toBe(1);
    // Raport wylądował pod ścieżką WERSJONOWANĄ, mimo że proces pisał do wspólnej.
    expect(JSON.parse(await readFile(String(out['reportPath']), 'utf8'))).toBeTruthy();
    expect(h.state.greenRuns).toBe(1);
  });

  it('sprzątanie raportów nie wychodzi poza repo testów (traversal w reportFile)', async () => {
    const outsideName = `gp-poza-${Math.random().toString(36).slice(2)}.json`;
    const h = await makeHarness({}, 'assert', { reportFile: `../${outsideName}` });
    const outside = join(h.cwd, '..', outsideName);
    await writeFile(outside, 'nie-kasuj');

    fakePw({ mode: 'none', exit: 1 });
    const out = await h.run();

    // Plik poza cwd przeżył sprzątanie i NIE został podczytany jako fallback.
    expect(await readFile(outside, 'utf8')).toBe('nie-kasuj');
    expect(out).toContain('BRAK RAPORTU JSON');
  });

  it('zielony przebieg wymaga CZYSTEGO wyjścia procesu - pad teardownu nie odblokowuje puli proof', async () => {
    const h = await makeHarness();
    fakePw({ report: GREEN, exit: 1 });
    await h.run();

    expect(h.state.playwrightRuns[0]!.passed).toBeGreaterThan(0);
    expect(h.state.greenRuns).toBe(0);
  });

  it('stęchłe raporty są kasowane przed przebiegiem - pad bez raportu nie legalizuje przeszłości', async () => {
    const h = await makeHarness();
    // Zostałości z poprzedniego życia: wersjonowany raport po przejętym lease
    // (numeracja runów wraca do 1) i współdzielony raport po innym casie.
    await mkdir(join(h.attemptDir, 'pw-runs'), { recursive: true });
    await writeFile(join(h.attemptDir, 'pw-runs', 'run-01-green.json'), GREEN);
    await writeFile(join(h.cwd, 'pw-report.json'), GREEN);

    fakePw({ mode: 'none', exit: 1 });
    const out = await h.run();

    expect(out).toContain('BRAK RAPORTU JSON');
    expect(h.state.greenRuns).toBe(0);
    expect(h.state.playwrightRuns[0]!.passed).toBe(0);
  });

  it('brak raportu = czytelna diagnostyka zamiast wywrotki, przebieg liczy się do budżetu', async () => {
    const h = await makeHarness();
    fakePw({ mode: 'none' });
    const out = await h.run();
    expect(out).toContain('BRAK RAPORTU JSON');
    expect(out).toContain('PLAYWRIGHT_JSON_OUTPUT_NAME');
    expect(h.state.playwrightRunsByPhase.assert).toBe(1);
    expect(h.state.greenRuns).toBe(0);
    expect(h.state.playwrightRuns[0]!.reportPath).toBe('');
  });

  it('raport nie-JSON = diagnostyka reportera', async () => {
    const h = await makeHarness();
    fakePw({ report: 'Running 1 test...\nok' });
    const out = await h.run();
    expect(out).toContain('nie jest poprawnym JSON-em Playwrighta');
    expect(h.state.greenRuns).toBe(0);
  });
});

describe('run_playwright - pule budżetu', () => {
  it('zielone liczą się tylko w fazie assert i tylko przy zerze porażek', async () => {
    const h = await makeHarness({ maxPlaywrightRuns: 6 }, 'act');
    fakePw({});
    await h.run();
    // Faza act: przebieg policzony, ale to nie jest "zielony dowodowy".
    expect(h.state.playwrightRunsByPhase.act).toBe(1);
    expect(h.state.greenRuns).toBe(0);

    h.state.markPhase('assert');
    await h.run();
    expect(h.state.greenRuns).toBe(1);
    // Czerwony przebieg zieleni nie dodaje.
    fakePw({ report: RED, exit: 1 });
    await h.run();
    expect(h.state.greenRuns).toBe(1);
  });

  it('po DRUGIM zielonym runy idą z osobnej puli dowodowej', async () => {
    const h = await makeHarness({ maxPlaywrightRuns: 2, proofRuns: 3 });
    fakePw({});
    await h.run();
    await h.run();
    expect(h.state.greenRuns).toBe(2);
    expect(h.state.playwrightRunsByPhase.assert).toBe(2);
    expect(h.state.proofRunsUsed).toBe(0);

    // Pula assert jest wyczerpana (2/2), ale dowód ma WŁASNE runy - kiedyś
    // w tym miejscu model tracił możliwość zrobienia czerwonego przebiegu.
    fakePw({ report: RED, exit: 1 });
    const out = h.lastRun(await h.run({ purpose: 'red' }));
    expect(h.state.proofRunsUsed).toBe(1);
    expect(h.state.playwrightRunsExhausted).toBe(false);
    const budget = out['budget'] as Record<string, number>;
    expect(budget).toEqual({ assertUsed: 3, assertMax: 2, proofUsed: 1, proofMax: 3, greenRuns: 2 });
  });

  it('wyczerpana pula assert = STOP i playwrightRunsExhausted', async () => {
    const h = await makeHarness({ maxPlaywrightRuns: 2 });
    // Przebiegi z porażką nie dają zieleni, więc pula assert się wyczerpuje.
    fakePw({ report: RED, exit: 1 });
    await h.run();
    await h.run();
    expect(h.state.playwrightRunsExhausted).toBe(false);
    const stop = await h.run();
    expect(stop).toContain('STOP');
    expect(stop).toContain('zakończ sesję');
    expect(h.state.playwrightRunsExhausted).toBe(true);
    // STOP nie uruchamia procesu - liczniki stoją.
    expect(h.state.playwrightRunsByPhase.assert).toBe(2);
    expect(h.state.playwrightRuns).toHaveLength(2);
  });

  it('pula assert obowiązuje tylko w fazie assert (arrange/act są nielimitowane)', async () => {
    const h = await makeHarness({ maxPlaywrightRuns: 1 }, 'act');
    fakePw({});
    await h.run();
    await h.run();
    const third = h.lastRun(await h.run());
    expect(third['runIndex']).toBe(3);
    expect(h.state.playwrightRunsByPhase.act).toBe(3);
    expect(h.state.playwrightRunsExhausted).toBe(false);
  });

  it('wyczerpana pula dowodowa = STOP', async () => {
    const h = await makeHarness({ maxPlaywrightRuns: 4, proofRuns: 1 });
    fakePw({});
    await h.run();
    await h.run();
    await h.run({ purpose: 'red' });
    expect(h.state.proofRunsUsed).toBe(1);
    const stop = await h.run({ purpose: 'red' });
    expect(stop).toContain('STOP');
    expect(stop).toContain('runów dowodowych');
    expect(h.state.playwrightRunsExhausted).toBe(true);
    expect(h.state.proofRunsUsed).toBe(1);
  });

  it('purpose nie wpływa na wybór puli (modele kłamią)', async () => {
    const h = await makeHarness({ maxPlaywrightRuns: 4, proofRuns: 2 });
    fakePw({});
    // "red" przed jakimkolwiek zielonym nadal idzie z puli assert.
    await h.run({ purpose: 'red' });
    expect(h.state.proofRunsUsed).toBe(0);
    expect(h.state.playwrightRunsByPhase.assert).toBe(1);
    // ...a "debug" po dwóch zielonych idzie już z puli dowodowej - o puli
    // decyduje WYŁĄCZNIE licznik zieleni, nie etykieta podana przez model.
    await h.run();
    expect(h.state.greenRuns).toBe(2);
    await h.run({ purpose: 'debug' });
    expect(h.state.proofRunsUsed).toBe(1);
  });
});

describe('run_playwright - zdarzenia postępu', () => {
  /** Zdarzenia playwright-run z przechwyconego strumienia. */
  const runs = (h: Harness): PlaywrightRunProgressEvent[] =>
    h.events.filter((e): e is PlaywrightRunProgressEvent => e.kind === 'playwright-run');

  it('jeden przebieg = DOKŁADNIE jeden event z wynikiem i pulą assert', async () => {
    const h = await makeHarness({ maxPlaywrightRuns: 4, proofRuns: 2 });
    fakePw({ report: RED, exit: 1 });
    await h.run({ purpose: 'red' });

    expect(h.events).toHaveLength(1);
    const e = runs(h)[0]!;
    expect(e).toMatchObject({
      kind: 'playwright-run',
      runId: 'r-pw',
      caseId: 'E2E-PAY-1',
      attempt: 1,
      runIndex: 1,
      purpose: 'red',
      // Purpose jest tylko etykietą - pula wynika z licznika zieleni.
      pool: 'assert',
      passed: 0,
      failed: 1,
      total: 1,
    });
    // Stan pul PO runie.
    expect(e.pw).toEqual({ assertUsed: 1, assertMax: 4, proofUsed: 0, proofMax: 2, greenRuns: 0 });
    expect(e.at).toBe('2026-01-01T00:00:00.000Z');
  });

  it('po dwóch zielonych event raportuje pulę proof i zieleń', async () => {
    const h = await makeHarness({ maxPlaywrightRuns: 4, proofRuns: 2 });
    fakePw({});
    await h.run();
    await h.run();
    fakePw({ report: RED, exit: 1 });
    await h.run({ purpose: 'red' });

    const events = runs(h);
    expect(events).toHaveLength(3);
    expect(events.map((e) => e.pool)).toEqual(['assert', 'assert', 'proof']);
    expect(events[1]!).toMatchObject({ passed: 1, failed: 0, total: 1 });
    expect(events[2]!.pw).toEqual({
      assertUsed: 3, assertMax: 4, proofUsed: 1, proofMax: 2, greenRuns: 2,
    });
  });

  it('STOP na wyczerpanej puli i brak raportu nie emitują eventu wyniku', async () => {
    const h = await makeHarness({ maxPlaywrightRuns: 1 });
    fakePw({ mode: 'none' });
    await h.run(); // przebieg bez raportu - nie ma czego raportować
    expect(runs(h)).toHaveLength(0);
    const stop = await h.run();
    expect(stop).toContain('STOP');
    expect(runs(h)).toHaveLength(0);
  });
});

describe('record_proof_material - źródło raportów', () => {
  const mutation = {
    mutationDescription: 'zmiana oczekiwanego netto o grosz',
    mutationDiff:
      '--- specs/pay.spec.ts\n+++ specs/pay.spec.ts\n' +
      '-expect(x).toHaveText("4321.00")\n+expect(x).toHaveText("4320.00")',
    targetCondition: 'netto 4321.00',
  };

  it('rozwiązuje referencje run:<n> na wersjonowane raporty', async () => {
    const h = await makeHarness({ maxPlaywrightRuns: 4, proofRuns: 2 });
    fakePw({});
    await h.run();
    await h.run();
    fakePw({ report: RED, exit: 1 });
    await h.run({ purpose: 'red' });

    const out = await h.call('record_proof_material', {
      greenRunReport1: 'run:1',
      greenRunReport2: 'run:2',
      redRunReport: 'run:3',
      ...mutation,
    });
    expect(out).toContain('Surowiec dowodu zapisany');
    expect(h.state.proofMaterial?.greenRunReports[0]).toBe(GREEN);
    expect(h.state.proofMaterial?.redRunReport).toBe(RED);
  });

  it('nieistniejący run:<n> to czytelny błąd, nie wywrotka', async () => {
    const h = await makeHarness();
    fakePw({});
    await h.run();
    const out = await h.call('record_proof_material', {
      greenRunReport1: 'run:1',
      greenRunReport2: 'run:7',
      redRunReport: 'run:1',
      ...mutation,
    });
    expect(out).toContain('nie ma przebiegu run:7');
    expect(h.state.proofMaterial).toBeUndefined();
  });

  it('ścieżka współdzielonego pw-report.json jest twardo odrzucana', async () => {
    const h = await makeHarness({ maxPlaywrightRuns: 4 });
    fakePw({});
    await h.run();
    await h.run();
    await writeFile(join(h.cwd, 'pw-report.json'), GREEN);
    const out = await h.call('record_proof_material', {
      greenRunReport1: 'run:1',
      greenRunReport2: 'pw-report.json',
      redRunReport: 'run:1',
      ...mutation,
    });
    expect(out).toContain('musi pochodzić z run_playwright');
    expect(h.state.proofMaterial).toBeUndefined();
  });

  it('enforcement: treść JSON i obce ścieżki są odrzucane TAKŻE bez żadnego przebiegu', async () => {
    // Dziura z review: `npm test` w skrypcie pakietowym + współdzielony raport
    // omijały budżet i wersjonowanie, póki nie było wersjonowanych runów.
    const h = await makeHarness();
    await writeFile(join(h.cwd, 'pw-report.json'), GREEN);
    const out = await h.call('record_proof_material', {
      greenRunReport1: 'pw-report.json',
      greenRunReport2: GREEN,
      redRunReport: RED,
      ...mutation,
    });
    expect(out).toContain('musi pochodzić z run_playwright');
    expect(h.state.proofMaterial).toBeUndefined();
  });

  it('legacy (enforceRunPlaywrightTool=false): ścieżki i treść JSON działają jak dotąd', async () => {
    const h = await makeHarness({ enforceRunPlaywrightTool: false });
    await writeFile(join(h.cwd, 'pw-report.json'), GREEN);
    const out = await h.call('record_proof_material', {
      greenRunReport1: 'pw-report.json',
      greenRunReport2: GREEN,
      redRunReport: RED,
      ...mutation,
    });
    expect(out).toContain('Surowiec dowodu zapisany');
    expect(h.state.proofMaterial?.greenRunReports).toHaveLength(2);
  });

  // Ścieżka raportu pochodzi z systemu plików (podaje ją model), więc rozstrzyga
  // `isAbsolute` + prefiks litery dysku, a nie `startsWith('/')`. Bez tego
  // 'C:raport.json' lądowało w `join(cwd, 'C:raport.json')`.
  // Plik z dwukropkiem w nazwie da się założyć tylko na POSIX-ie - na Windowsie
  // ten sam przypadek pokrywa natywne `isAbsolute`.
  it.skipIf(process.platform === 'win32')(
    'ścieżka z literą dysku nie jest doklejana do cwd',
    async () => {
      const h = await makeHarness({ enforceRunPlaywrightTool: false });
      await writeFile(join(h.cwd, 'C:raport.json'), GREEN);
      const out = await h.call('record_proof_material', {
        greenRunReport1: 'C:raport.json',
        greenRunReport2: GREEN,
        redRunReport: RED,
        ...mutation,
      });
      expect(out).toContain('nie mogę odczytać pliku raportu');
      expect(h.state.proofMaterial).toBeUndefined();

      // Kontrola: bez litery dysku ta sama nazwa czyta się z cwd normalnie.
      await writeFile(join(h.cwd, 'raport.json'), GREEN);
      const ok = await h.call('record_proof_material', {
        greenRunReport1: 'raport.json',
        greenRunReport2: GREEN,
        redRunReport: RED,
        ...mutation,
      });
      expect(ok).toContain('Surowiec dowodu zapisany');
    },
  );

  // Regresja z retry employee-create-validation (2026-08-17): komunikat sukcesu
  // mówił tylko „zakończ sesję", więc qwen3.6-27b-mtp z kompletnym dowodem
  // skończył turę bez `finish` - a bez `declaredStatus` krok autora klasyfikuje
  // próbę jako attempt_failed. Ścieżka sukcesu MUSI nazywać narzędzie.
  it('komunikat sukcesu nazywa narzędzie finish i ostrzega przed pominięciem go', async () => {
    const h = await makeHarness({ enforceRunPlaywrightTool: false });
    const out = await h.call('record_proof_material', {
      greenRunReport1: GREEN,
      greenRunReport2: GREEN,
      redRunReport: RED,
      ...mutation,
    });
    expect(out).toContain('Surowiec dowodu zapisany');
    expect(out).toContain('mcp__greenproof__finish');
    expect(out).toMatch(/delivered/);
    expect(out).toMatch(/próba przepada/);
  });

  it('diff mutacji bez nagłówków plików → twardy błąd, surowiec nie zapisany', async () => {
    const h = await makeHarness({ enforceRunPlaywrightTool: false });
    const out = await h.call('record_proof_material', {
      greenRunReport1: GREEN,
      greenRunReport2: GREEN,
      redRunReport: RED,
      ...mutation,
      mutationDiff: '-expect(x).toHaveText("4321.00")\n+expect(x).toHaveText("4320.00")',
    });
    expect(out).toContain('BŁĄD');
    expect(out).toContain('nagłówków plików');
    expect(h.state.proofMaterial).toBeUndefined();
  });
});
