import { describe, expect, it } from 'vitest';
import {
  BROWSER_CRASH_MESSAGE,
  makeGreenReport,
  makeGreenReportObject,
  makeInfraErrorReport,
  makeMultiTestReport,
  makeRedAssertionReport,
  makeRedAssertionReportObject,
  makeRedTimeoutReport,
} from '../src/index.js';
import type { PwJsonReport } from '../src/index.js';

const FILE = 'tests/payroll.spec.ts';
const TITLE = 'wylicza płacę netto';

/** Fixture'y są stringami - walidator dostanie dokładnie to. */
function parse(raw: string): PwJsonReport {
  expect(typeof raw).toBe('string');
  return JSON.parse(raw) as PwJsonReport;
}

function firstResult(report: PwJsonReport) {
  const spec = report.suites[0]?.specs[0];
  const test = spec?.tests[0];
  const result = test?.results[0];
  expect(spec).toBeDefined();
  expect(result).toBeDefined();
  return { spec: spec!, test: test!, result: result! };
}

describe('makeGreenReport', () => {
  it('daje parsowalny raport z jednym passed testem', () => {
    const report = parse(makeGreenReport({ file: FILE, testTitle: TITLE, durationMs: 2500 }));

    expect(report.stats).toEqual({
      startTime: expect.any(String),
      duration: 2500,
      expected: 1,
      skipped: 0,
      unexpected: 0,
      flaky: 0,
    });
    expect(report.errors).toEqual([]);
    expect(report.config.version).toMatch(/^\d+\.\d+/);
    expect(report.config.projects[0]?.timeout).toBe(30_000);

    const suite = report.suites[0];
    expect(suite?.title).toBe(FILE);
    expect(suite?.file).toBe(FILE);
    expect(suite?.line).toBe(0);

    const { spec, test, result } = firstResult(report);
    expect(spec.title).toBe(TITLE);
    expect(spec.ok).toBe(true);
    expect(spec.file).toBe(FILE);
    expect(test.projectName).toBe('chromium');
    expect(test.status).toBe('expected');
    expect(result.status).toBe('passed');
    expect(result.duration).toBe(2500);
    expect(result.error).toBeUndefined();
    expect(result.errors).toEqual([]);
  });

  it('wersja obiektowa i stringowa opisują to samo', () => {
    const object = makeGreenReportObject({ file: FILE, testTitle: TITLE });
    expect(parse(makeGreenReport({ file: FILE, testTitle: TITLE }))).toEqual(object);
    // Deterministyczne id speca.
    expect(object.suites[0]?.specs[0]?.id).toBe(
      makeGreenReportObject({ file: FILE, testTitle: TITLE }).suites[0]?.specs[0]?.id,
    );
  });
});

describe('makeRedAssertionReport', () => {
  it('failed z komunikatem asercji expect i stats.unexpected = 1', () => {
    const message =
      'Error: expect(locator).toHaveText(expected) failed\n\n' +
      "Locator: getByTestId('net-pay')\n" +
      'Expected string: "3 214,50"\n' +
      'Received string: "3 000,00"';
    const report = parse(makeRedAssertionReport({ file: FILE, testTitle: TITLE, message }));

    expect(report.stats.unexpected).toBe(1);
    expect(report.stats.expected).toBe(0);

    const { spec, test, result } = firstResult(report);
    expect(spec.ok).toBe(false);
    expect(test.status).toBe('unexpected');
    expect(result.status).toBe('failed');
    expect(result.error?.message).toBe(message);
    expect(result.error?.stack).toContain('    at /repo/tests/payroll.spec.ts:');
    expect(result.error?.location?.file).toBe('/repo/tests/payroll.spec.ts');
    expect(result.error?.snippet).toContain('>');
    // errors[] jest wyrenderowane: komunikat + snippet + ogon stacku.
    expect(result.errors[0]?.message).toContain('Received string: "3 000,00"');
    expect(result.errors[0]?.message).toContain('    at /repo/tests/payroll.spec.ts:');
    expect(result.errorLocation?.line).toBe(result.error?.location?.line);
  });

  it('domyślny komunikat zawiera matcher, lokator, expected i received', () => {
    const report = makeRedAssertionReportObject({
      file: FILE,
      testTitle: TITLE,
      matcher: 'toHaveText',
      locator: "getByTestId('net-pay')",
      expected: '3 214,50',
      received: '3 000,00',
    });
    const message = report.suites[0]?.specs[0]?.tests[0]?.results[0]?.error?.message ?? '';
    expect(message).toContain('expect(locator).toHaveText(expected) failed');
    expect(message).toContain("Locator: getByTestId('net-pay')");
    expect(message).toContain('Expected string: "3 214,50"');
    expect(message).toContain('Received string: "3 000,00"');
    expect(message).toContain('Call log:');
  });

  it('styl legacy (1.4x) używa brzmienia "Timed out ... waiting for"', () => {
    const report = makeRedAssertionReportObject({
      file: FILE,
      testTitle: TITLE,
      style: 'legacy',
    });
    const message = report.suites[0]?.specs[0]?.tests[0]?.results[0]?.error?.message ?? '';
    expect(message).toContain('Timed out 5000ms waiting for expect(locator).toHaveText');
  });
});

describe('makeRedTimeoutReport', () => {
  it('status timedOut, komunikat o przekroczonym czasie, bez location w error', () => {
    const report = parse(makeRedTimeoutReport({ file: FILE, testTitle: TITLE }));

    expect(report.stats.unexpected).toBe(1);
    const { test, result } = firstResult(report);
    expect(test.status).toBe('unexpected');
    expect(result.status).toBe('timedOut');
    expect(result.error?.message).toBe('Test timeout of 30000ms exceeded.');
    // Playwright przy timeoucie nie ma location/snippet w error.
    expect(result.error?.location).toBeUndefined();
    expect(result.errorLocation).toBeUndefined();
    // Drugi wpis errors[] wskazuje wiszące wywołanie.
    expect(result.errors).toHaveLength(2);
    expect(result.errors[1]?.message).toContain('TimeoutError');
    expect(result.errors[1]?.message).toContain('Test timeout of 30000ms exceeded.');
  });

  it('respektuje własny timeout', () => {
    const report = parse(
      makeRedTimeoutReport({ file: FILE, testTitle: TITLE, timeoutMs: 15_000 }),
    );
    const { result } = firstResult(report);
    expect(result.error?.message).toBe('Test timeout of 15000ms exceeded.');
    expect(report.config.projects[0]?.timeout).toBe(15_000);
  });
});

describe('makeInfraErrorReport', () => {
  it('domyślnie ERR_CONNECTION_REFUSED, status failed', () => {
    const report = parse(makeInfraErrorReport({ file: FILE, testTitle: TITLE }));
    const { result } = firstResult(report);
    expect(result.status).toBe('failed');
    expect(result.error?.message).toContain('net::ERR_CONNECTION_REFUSED at http://');
    expect(result.error?.message).not.toContain('expect(');
    expect(report.stats.unexpected).toBe(1);
  });

  it('przyjmuje własny komunikat (pad przeglądarki)', () => {
    const report = parse(
      makeInfraErrorReport({ file: FILE, testTitle: TITLE, message: BROWSER_CRASH_MESSAGE }),
    );
    const { result } = firstResult(report);
    expect(result.error?.message).toContain('browserContext.close: Target crashed');
  });
});

describe('makeMultiTestReport', () => {
  it('grupuje testy w suity po pliku i liczy stats', () => {
    const raw = makeMultiTestReport([
      { file: FILE, testTitle: 'zielony', status: 'passed', durationMs: 100 },
      {
        file: FILE,
        testTitle: 'czerwony',
        status: 'failed',
        message: 'Error: expect(locator).toBeVisible() failed',
        durationMs: 200,
      },
      { file: 'tests/other.spec.ts', testTitle: 'pominięty', status: 'skipped', durationMs: 0 },
      {
        file: 'tests/other.spec.ts',
        testTitle: 'timeout',
        status: 'timedOut',
        message: 'Test timeout of 30000ms exceeded.',
        durationMs: 30_000,
      },
    ]);
    const report = parse(raw);

    expect(report.suites).toHaveLength(2);
    expect(report.suites.map((s) => s.file)).toEqual([FILE, 'tests/other.spec.ts']);
    expect(report.suites[0]?.specs).toHaveLength(2);
    expect(report.stats).toMatchObject({
      expected: 1,
      unexpected: 2,
      skipped: 1,
      flaky: 0,
      duration: 30_300,
    });

    const statuses = report.suites.flatMap((s) =>
      s.specs.map((spec) => spec.tests[0]?.results[0]?.status),
    );
    expect(statuses).toEqual(['passed', 'failed', 'skipped', 'timedOut']);
  });
});
