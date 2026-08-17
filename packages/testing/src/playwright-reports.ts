/**
 * Fixture'y surowych raportów JSON Playwrighta (reporter json, ~1.4x/1.5x);
 * kształt odwzorowuje typy JSONReport* z playwright/types/testReporter.d.ts.
 * Walidator dowodu parsuje dokładnie takie stringi, więc fixture'y kłamią jak
 * najmniej - stąd renderowane errors[], snippety i osobny kształt timeoutu.
 */

// --- typy raportu ------------------------------------------------------------

/** Status pojedynczego uruchomienia (TestStatus). */
export type PwTestStatus = 'passed' | 'failed' | 'timedOut' | 'skipped' | 'interrupted';

/** Wynik po retry i expectedStatus (JSONReportTest.status); to outcome, nie 'passed'/'failed'. */
export type PwTestOutcome = 'skipped' | 'expected' | 'unexpected' | 'flaky';

export interface PwLocation {
  file: string;
  line: number;
  column: number;
}

/** TestError z reportera - wszystkie pola opcjonalne. */
export interface PwTestError {
  message?: string;
  stack?: string;
  location?: PwLocation;
  snippet?: string;
  value?: string;
}

/** JSONReportError - komunikat już wyrenderowany. */
export interface PwJsonReportError {
  message: string;
  location?: PwLocation;
}

export interface PwTestResult {
  workerIndex: number;
  parallelIndex: number;
  status: PwTestStatus;
  duration: number;
  error?: PwTestError;
  errors: PwJsonReportError[];
  stdout: { text: string }[];
  stderr: { text: string }[];
  retry: number;
  startTime: string;
  attachments: { name: string; contentType: string; path?: string; body?: string }[];
  annotations: { type: string; description?: string }[];
  errorLocation?: PwLocation;
}

export interface PwTest {
  timeout: number;
  annotations: { type: string; description?: string }[];
  expectedStatus: PwTestStatus;
  projectName: string;
  projectId: string;
  results: PwTestResult[];
  status: PwTestOutcome;
}

export interface PwSpec {
  tags: string[];
  title: string;
  ok: boolean;
  tests: PwTest[];
  id: string;
  file: string;
  line: number;
  column: number;
}

export interface PwSuite {
  title: string;
  file: string;
  column: number;
  line: number;
  specs: PwSpec[];
  suites?: PwSuite[];
}

export interface PwProjectConfig {
  outputDir: string;
  repeatEach: number;
  retries: number;
  metadata: Record<string, unknown>;
  id: string;
  name: string;
  testDir: string;
  testIgnore: string[];
  testMatch: string[];
  timeout: number;
}

/** Podzbiór config z reportera json (zrzuca cały FullConfig). */
export interface PwConfig {
  configFile: string;
  rootDir: string;
  forbidOnly: boolean;
  fullyParallel: boolean;
  globalSetup: string | null;
  globalTeardown: string | null;
  globalTimeout: number;
  /** RegExp serializuje się do `{}` - tak jest w prawdziwym raporcie. */
  grep: Record<string, never>;
  grepInvert: null;
  maxFailures: number;
  metadata: Record<string, unknown>;
  preserveOutput: string;
  projects: PwProjectConfig[];
  reporter: [string, unknown][];
  reportSlowTests: { max: number; threshold: number };
  quiet: boolean;
  shard: null;
  updateSnapshots: string;
  version: string;
  workers: number;
  webServer: null;
}

export interface PwJsonReport {
  config: PwConfig;
  suites: PwSuite[];
  /** Błędy spoza testów (config, globalSetup). */
  errors: PwTestError[];
  stats: {
    startTime: string;
    duration: number;
    expected: number;
    skipped: number;
    unexpected: number;
    flaky: number;
  };
}

// --- wejścia builderów -------------------------------------------------------

/** Status testu w fixture'cie (bez 'interrupted'). */
export type FixtureStatus = 'passed' | 'failed' | 'timedOut' | 'skipped';

export interface TestSpecInput {
  /** Ścieżka pliku speca względem rootDir, np. "tests/payroll.spec.ts". */
  file: string;
  testTitle: string;
  status: FixtureStatus;
  /** Pełny komunikat błędu (dla failed/timedOut). */
  message?: string;
  /** Stack; domyślnie message + ramka wskazująca linię w specu. */
  stack?: string;
  /** Ramka kodu (`snippet`) dołączana do błędu i do errors[]. */
  snippet?: string;
  /** Linia kodu do wygenerowania domyślnej ramki. */
  codeLine?: string;
  /** Dodatkowe wpisy errors[] (Playwright przy timeoucie ma ich dwa). */
  extraErrors?: string[];
  durationMs?: number;
  line?: number;
  column?: number;
  projectName?: string;
}

export interface ReportOptions {
  projectName?: string;
  /** Absolutny rootDir; ścieżki w błędach są absolutne, w specach względne. */
  rootDir?: string;
  startTime?: string;
  timeoutMs?: number;
  /** Błędy globalne przebiegu (np. pad globalSetup). */
  errors?: PwTestError[];
  playwrightVersion?: string;
}

const DEFAULT_START = '2025-01-01T10:00:00.000Z';
const DEFAULT_PROJECT = 'chromium';
const DEFAULT_ROOT = '/repo';
const DEFAULT_TIMEOUT = 30_000;
/** Wersja z nowszym brzmieniem expect ("... failed"). */
const DEFAULT_VERSION = '1.55.0';

/** Deterministyczne id speca (Playwright: skrót z pliku + tytułu). */
function specId(file: string, title: string): string {
  let h = 0x811c9dc5;
  const input = `${file} ${title}`;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0').repeat(3).slice(0, 20);
}

function makeConfig(options: ReportOptions): PwConfig {
  const rootDir = options.rootDir ?? DEFAULT_ROOT;
  const projectName = options.projectName ?? DEFAULT_PROJECT;
  return {
    configFile: `${rootDir}/playwright.config.ts`,
    rootDir,
    forbidOnly: false,
    fullyParallel: true,
    globalSetup: null,
    globalTeardown: null,
    globalTimeout: 0,
    grep: {},
    grepInvert: null,
    maxFailures: 0,
    metadata: { actualWorkers: 1 },
    preserveOutput: 'always',
    projects: [
      {
        outputDir: `${rootDir}/test-results`,
        repeatEach: 1,
        retries: 0,
        metadata: {},
        id: projectName,
        name: projectName,
        testDir: `${rootDir}/tests`,
        testIgnore: [],
        testMatch: ['**/*.@(spec|test).?(c|m)[jt]s?(x)'],
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT,
      },
    ],
    reporter: [['json', null]],
    reportSlowTests: { max: 5, threshold: 300_000 },
    quiet: false,
    shard: null,
    updateSnapshots: 'missing',
    version: options.playwrightVersion ?? DEFAULT_VERSION,
    workers: 1,
    webServer: null,
  };
}

function outcomeOf(status: FixtureStatus): PwTestOutcome {
  if (status === 'passed') return 'expected';
  if (status === 'skipped') return 'skipped';
  return 'unexpected';
}

/** Ramka kodu jak z formatError - linia z `>` i daszkiem. */
export function codeFrame(line: number, code: string, column = 5): string {
  const gutter = String(line).length;
  const pad = (n: number): string => String(n).padStart(gutter, ' ');
  return [
    `  ${pad(line - 1)} |`,
    `> ${pad(line)} | ${code}`,
    `  ${' '.repeat(gutter)} | ${' '.repeat(column + 2)}^`,
    `  ${pad(line + 1)} | });`,
  ].join('\n');
}

/** Renderowany wpis errors[]: komunikat + snippet + ogon stacku. */
function renderError(
  message: string,
  snippet: string | undefined,
  absFile: string,
  line: number,
  column: number,
): string {
  const parts = [message];
  if (snippet) parts.push('', snippet);
  parts.push(`    at ${absFile}:${line}:${column}`);
  return parts.join('\n');
}

/** Buduje pojedynczy wynik przebiegu (jedna próba, bez retry). */
function makeResult(
  input: TestSpecInput,
  options: ReportOptions,
  index: number,
): PwTestResult {
  const rootDir = options.rootDir ?? DEFAULT_ROOT;
  const line = input.line ?? 12;
  const column = input.column ?? 5;
  const duration = input.durationMs ?? (input.status === 'passed' ? 1234 : 5678);
  const start = new Date(
    new Date(options.startTime ?? DEFAULT_START).getTime() + index * 10,
  );
  const base: PwTestResult = {
    workerIndex: 0,
    parallelIndex: 0,
    status: input.status,
    duration,
    errors: [],
    stdout: [],
    stderr: [],
    retry: 0,
    startTime: start.toISOString(),
    attachments: [],
    annotations: [],
  };
  if (input.status === 'passed' || input.status === 'skipped') return base;

  const message = input.message ?? 'Error: test failed';
  const absFile = `${rootDir}/${input.file}`;
  const location: PwLocation = { file: absFile, line, column };
  const snippet =
    input.snippet ??
    codeFrame(line, input.codeLine ?? "  await expect(page.getByTestId('x')).toBeVisible();", column);

  if (input.status === 'timedOut') {
    // Timeout: error bez location/snippet; errors[] ma wpis wskazujący wiszące wywołanie.
    const extra = input.extraErrors ?? [];
    return {
      ...base,
      error: { message, stack: input.stack ?? message },
      errors: [
        { message },
        ...extra.map((m) => ({
          message: renderError(m, snippet, absFile, line, column),
          location,
        })),
      ],
    };
  }

  const stack = input.stack ?? `${message}\n    at ${absFile}:${line}:${column}`;
  return {
    ...base,
    error: { message, stack, location, snippet },
    errors: [
      { message: renderError(message, snippet, absFile, line, column), location },
      ...(input.extraErrors ?? []).map((m) => ({
        message: renderError(m, undefined, absFile, line, column),
        location,
      })),
    ],
    errorLocation: location,
  };
}

function makeSpec(input: TestSpecInput, options: ReportOptions, index: number): PwSpec {
  const line = input.line ?? 12;
  const projectName = input.projectName ?? options.projectName ?? DEFAULT_PROJECT;
  const ok = input.status === 'passed' || input.status === 'skipped';
  return {
    tags: [],
    title: input.testTitle,
    ok,
    tests: [
      {
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT,
        annotations: [],
        expectedStatus: 'passed',
        projectName,
        projectId: projectName,
        results: [makeResult(input, options, index)],
        status: outcomeOf(input.status),
      },
    ],
    id: specId(input.file, input.testTitle),
    file: input.file,
    line,
    column: 1,
  };
}

/** Wspólny builder: grupuje testy w suite'y po pliku i liczy stats. */
export function makeReportObject(
  specs: TestSpecInput[],
  options: ReportOptions = {},
): PwJsonReport {
  const bySuite = new Map<string, PwSuite>();
  let duration = 0;
  let expected = 0;
  let skipped = 0;
  let unexpected = 0;

  specs.forEach((input, index) => {
    const spec = makeSpec(input, options, index);
    duration += spec.tests[0]?.results[0]?.duration ?? 0;
    if (input.status === 'passed') expected += 1;
    else if (input.status === 'skipped') skipped += 1;
    else unexpected += 1;

    let suite = bySuite.get(input.file);
    if (!suite) {
      // Suite pliku: title === ścieżka pliku, line/column = 0.
      suite = { title: input.file, file: input.file, column: 0, line: 0, specs: [] };
      bySuite.set(input.file, suite);
    }
    suite.specs.push(spec);
  });

  return {
    config: makeConfig(options),
    suites: [...bySuite.values()],
    errors: options.errors ?? [],
    stats: {
      startTime: options.startTime ?? DEFAULT_START,
      duration,
      expected,
      skipped,
      unexpected,
      flaky: 0,
    },
  };
}

/** Serializacja jak z `--reporter=json` (2 spacje wcięcia). */
export function stringifyReport(report: PwJsonReport): string {
  return JSON.stringify(report, null, 2);
}

// --- komunikaty błędów -------------------------------------------------------

export interface AssertionMessageInput {
  matcher?: string;
  locator?: string;
  expected?: string;
  received?: string;
  timeoutMs?: number;
  /** 'modern' (≥1.53): "expect(locator).toHaveText(expected) failed"; 'legacy' (1.4x): "Timed out...". */
  style?: 'modern' | 'legacy';
}

/**
 * Komunikat porażki expect w stylu Playwrighta: nagłówek matchera, lokator,
 * Expected/Received i call log. matcherResult NIE jest osobnym polem w JSON -
 * Playwright renderuje go wyłącznie w treści message.
 */
export function assertionMessage(input: AssertionMessageInput = {}): string {
  const matcher = input.matcher ?? 'toHaveText';
  const locator = input.locator ?? "getByTestId('net-pay')";
  const expected = input.expected ?? '3 214,50';
  const received = input.received ?? '3 000,00';
  const timeout = input.timeoutMs ?? 5000;
  const header =
    input.style === 'legacy'
      ? `Error: Timed out ${timeout}ms waiting for expect(locator).${matcher}(expected)`
      : `Error: expect(locator).${matcher}(expected) failed`;
  const lines = [
    header,
    '',
    `Locator: ${locator}`,
    `Expected string: "${expected}"`,
    `Received string: "${received}"`,
  ];
  if (input.style !== 'legacy') lines.push(`Timeout: ${timeout}ms`);
  lines.push(
    '',
    'Call log:',
    `  - expect.${matcher} with timeout ${timeout}ms`,
    `  - waiting for ${locator}`,
    `    9 × locator resolved to <span data-testid="net-pay">${received}</span>`,
    `      - unexpected value "${received}"`,
  );
  return lines.join('\n');
}

/** Komunikat timeoutu testu - porażka NIE jest własną asercją speca. */
export function timeoutMessage(timeoutMs = DEFAULT_TIMEOUT): string {
  return `Test timeout of ${timeoutMs}ms exceeded.`;
}

/** Drugi wpis errors[] przy timeoucie: wiszące wywołanie Playwrighta. */
export function timeoutPendingCallMessage(
  timeoutMs = DEFAULT_TIMEOUT,
  call = "locator.click: waiting for getByRole('button', { name: 'Zapisz' })",
): string {
  const [action = 'locator.click'] = call.split(':');
  return [
    `TimeoutError: ${action}: Test timeout of ${timeoutMs}ms exceeded.`,
    '',
    'Call log:',
    `  - ${call}`,
  ].join('\n');
}

/** Komunikat awarii infrastruktury (środowisko/przeglądarka, nie kod testu). */
export function infraMessage(url = 'http://localhost:3000/'): string {
  return [
    `Error: page.goto: net::ERR_CONNECTION_REFUSED at ${url}`,
    'Call log:',
    `  - navigating to "${url}", waiting until "load"`,
  ].join('\n');
}

/** Alternatywna awaria infra: pad przeglądarki. */
export const BROWSER_CRASH_MESSAGE = [
  'Error: browserContext.close: Target crashed',
  '=========================== logs ===========================',
  '<launching> /root/.cache/ms-playwright/chromium-1148/chrome-linux/chrome',
  '============================================================',
].join('\n');

// --- buildery ----------------------------------------------------------------

export interface GreenReportInput {
  file: string;
  testTitle: string;
  durationMs?: number;
  projectName?: string;
  line?: number;
  options?: ReportOptions;
}

export function makeGreenReportObject(input: GreenReportInput): PwJsonReport {
  return makeReportObject(
    [
      {
        file: input.file,
        testTitle: input.testTitle,
        status: 'passed',
        ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }),
        ...(input.projectName === undefined ? {} : { projectName: input.projectName }),
        ...(input.line === undefined ? {} : { line: input.line }),
      },
    ],
    input.options ?? {},
  );
}

/** Zielony przebieg: 1 test passed, stats.expected = 1. */
export function makeGreenReport(input: GreenReportInput): string {
  return stringifyReport(makeGreenReportObject(input));
}

export interface RedAssertionReportInput extends AssertionMessageInput {
  file: string;
  testTitle: string;
  /** Gotowy komunikat; gdy pominięty, budowany z matcher/expected/received. */
  message?: string;
  durationMs?: number;
  line?: number;
  projectName?: string;
  codeLine?: string;
  options?: ReportOptions;
}

export function makeRedAssertionReportObject(
  input: RedAssertionReportInput,
): PwJsonReport {
  const message = input.message ?? assertionMessage(input);
  const matcher = input.matcher ?? 'toHaveText';
  const locator = input.locator ?? "getByTestId('net-pay')";
  const expected = input.expected ?? '3 214,50';
  return makeReportObject(
    [
      {
        file: input.file,
        testTitle: input.testTitle,
        status: 'failed',
        message,
        codeLine:
          input.codeLine ?? `  await expect(page.${locator}).${matcher}('${expected}');`,
        ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }),
        ...(input.projectName === undefined ? {} : { projectName: input.projectName }),
        ...(input.line === undefined ? {} : { line: input.line }),
      },
    ],
    input.options ?? {},
  );
}

/** Czerwony przebieg z własnej asercji speca - jedyny akceptowany w dowodzie. */
export function makeRedAssertionReport(input: RedAssertionReportInput): string {
  return stringifyReport(makeRedAssertionReportObject(input));
}

export interface RedTimeoutReportInput {
  file: string;
  testTitle: string;
  message?: string;
  timeoutMs?: number;
  durationMs?: number;
  line?: number;
  projectName?: string;
  codeLine?: string;
  options?: ReportOptions;
}

export function makeRedTimeoutReportObject(input: RedTimeoutReportInput): PwJsonReport {
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT;
  const message = input.message ?? timeoutMessage(timeoutMs);
  return makeReportObject(
    [
      {
        file: input.file,
        testTitle: input.testTitle,
        status: 'timedOut',
        message,
        extraErrors: [timeoutPendingCallMessage(timeoutMs)],
        codeLine:
          input.codeLine ?? "  await page.getByRole('button', { name: 'Zapisz' }).click();",
        durationMs: input.durationMs ?? timeoutMs,
        ...(input.projectName === undefined ? {} : { projectName: input.projectName }),
        ...(input.line === undefined ? {} : { line: input.line }),
      },
    ],
    { ...(input.options ?? {}), timeoutMs },
  );
}

/** Czerwony przebieg z timeoutu - dla walidatora to NIE jest dowód. */
export function makeRedTimeoutReport(input: RedTimeoutReportInput): string {
  return stringifyReport(makeRedTimeoutReportObject(input));
}

export interface InfraErrorReportInput {
  file: string;
  testTitle: string;
  message?: string;
  durationMs?: number;
  line?: number;
  projectName?: string;
  codeLine?: string;
  options?: ReportOptions;
}

export function makeInfraErrorReportObject(input: InfraErrorReportInput): PwJsonReport {
  return makeReportObject(
    [
      {
        file: input.file,
        testTitle: input.testTitle,
        status: 'failed',
        message: input.message ?? infraMessage(),
        codeLine: input.codeLine ?? "  await page.goto('/payroll');",
        ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }),
        ...(input.projectName === undefined ? {} : { projectName: input.projectName }),
        ...(input.line === undefined ? {} : { line: input.line }),
      },
    ],
    input.options ?? {},
  );
}

/** Czerwony przebieg z awarii środowiska - dla walidatora to NIE jest dowód. */
export function makeInfraErrorReport(input: InfraErrorReportInput): string {
  return stringifyReport(makeInfraErrorReportObject(input));
}

export function makeMultiTestReportObject(
  specs: TestSpecInput[],
  options: ReportOptions = {},
): PwJsonReport {
  return makeReportObject(specs, options);
}

/** Raport z wieloma testami (także z wielu plików - suite na plik). */
export function makeMultiTestReport(
  specs: TestSpecInput[],
  options: ReportOptions = {},
): string {
  return stringifyReport(makeMultiTestReportObject(specs, options));
}
