import { describe, expect, it } from 'vitest';
import {
  makeGreenReport,
  makeRedAssertionReport,
  makeRedTimeoutReport,
  makeInfraErrorReport,
  makeMultiTestReport,
} from '@greenproof/testing';
import {
  classifyFailure,
  conditionOverlap,
  parseRunSummaries,
  validateProof,
} from '../src/proof/validator.js';
import type { ProofMaterial } from '../src/domain/proof.js';

const FILE = 'tests/e2e/payroll.spec.ts';
const TITLE = 'lista płac wylicza netto z golden-case';

function material(overrides?: Partial<ProofMaterial>): ProofMaterial {
  return {
    greenRunReports: [
      makeGreenReport({ file: FILE, testTitle: TITLE }),
      makeGreenReport({ file: FILE, testTitle: TITLE }),
    ],
    mutation: {
      description: 'odwrócono oczekiwane netto',
      diff:
        '--- tests/e2e/payroll.spec.ts\n+++ tests/e2e/payroll.spec.ts\n' +
        '- expect(net).toBe("3214.50")\n+ expect(net).toBe("9999.99")',
      targetCondition: 'payroll-net pokazuje netto 3214.50',
    },
    redRunReport: makeRedAssertionReport({
      file: FILE,
      testTitle: TITLE,
      message:
        'Error: expect(locator).toHaveText(expected) failed\n\nLocator: getByTestId(\'payroll-net\')\nExpected string: "9999.99"\nReceived string: "3214.50"',
    }),
    ...overrides,
  };
}

const opts = {
  caseId: 'C-1',
  attemptId: 'attempt-1',
  gitDiffEmpty: true,
  restoredVerified: true,
};

describe('parseRunSummaries', () => {
  it('spłaszcza raport do testId i statusu', () => {
    const runs = parseRunSummaries(makeGreenReport({ file: FILE, testTitle: TITLE }));
    expect(runs).toHaveLength(1);
    expect(runs[0]!.testId).toBe(`${FILE}::${TITLE}`);
    expect(runs[0]!.status).toBe('passed');
  });

  it('timedOut liczy się jako failed z komunikatem', () => {
    const runs = parseRunSummaries(makeRedTimeoutReport({ file: FILE, testTitle: TITLE }));
    expect(runs[0]!.status).toBe('failed');
    expect(runs[0]!.errorMessage).toMatch(/timeout/i);
  });
});

describe('classifyFailure', () => {
  it('nowy styl expect (>=1.53) to own-assertion', () => {
    expect(classifyFailure('Error: expect(locator).toHaveText(expected) failed\nExpected string: "a"')).toBe(
      'own-assertion',
    );
  });
  it('legacy web-first timeout asercji to own-assertion', () => {
    expect(
      classifyFailure('Timed out 5000ms waiting for expect(locator).toHaveText(expected)\nExpected string: "a"'),
    ).toBe('own-assertion');
  });
  it('timeout testu to timeout', () => {
    expect(classifyFailure('Test timeout of 30000ms exceeded.')).toBe('timeout');
  });
  it('błędy sieci/przeglądarki to infra', () => {
    expect(classifyFailure('page.goto: net::ERR_CONNECTION_REFUSED at http://x')).toBe('infra');
    expect(classifyFailure('browserContext.close: Target crashed')).toBe('infra');
  });
});

describe('validateProof', () => {
  it('pełny poprawny dowód → valid', () => {
    const proof = validateProof(material(), opts);
    expect(proof.reasons).toEqual([]);
    expect(proof.verdict).toBe('valid');
    expect(proof.redRun.failureKind).toBe('own-assertion');
    expect(proof.redRun.failedInSameTest).toBe(true);
  });

  it('czerwony przez timeout → invalid', () => {
    const proof = validateProof(
      material({ redRunReport: makeRedTimeoutReport({ file: FILE, testTitle: TITLE }) }),
      opts,
    );
    expect(proof.verdict).toBe('invalid');
    expect(proof.reasons.join(' ')).toMatch(/timeout/);
  });

  it('czerwony przez błąd infry → invalid', () => {
    const proof = validateProof(
      material({ redRunReport: makeInfraErrorReport({ file: FILE, testTitle: TITLE }) }),
      opts,
    );
    expect(proof.verdict).toBe('invalid');
    expect(proof.reasons.join(' ')).toMatch(/infra/);
  });

  it('mutacja nie czerwieni testu (nadal zielony) → invalid', () => {
    const proof = validateProof(
      material({ redRunReport: makeGreenReport({ file: FILE, testTitle: TITLE }) }),
      opts,
    );
    expect(proof.verdict).toBe('invalid');
    expect(proof.reasons.join(' ')).toMatch(/nadal przechodzi/);
  });

  it('czerwieni się INNY test → invalid', () => {
    const proof = validateProof(
      material({
        redRunReport: makeRedAssertionReport({ file: FILE, testTitle: 'zupełnie inny test' }),
      }),
      opts,
    );
    expect(proof.verdict).toBe('invalid');
  });

  // Regresja z runu qwen36-27b-mtp: model zacytował poprawnie komunikat
  // "nadal przechodzi", po czym ponownie zmutował stałą używaną wyłącznie
  // przez DRUGI test. Odrzucenie musi wprost mówić, co jest kotwicą i że
  // czerwień innego testu jej nie zastępuje.
  it('kotwica zielona → powód tłumaczy regułę kotwicy i wskazuje inne czerwone testy', () => {
    const proof = validateProof(
      material({ redRunReport: makeGreenReport({ file: FILE, testTitle: TITLE }) }),
      opts,
    );
    const reasons = proof.reasons.join(' ');
    expect(proof.verdict).toBe('invalid');
    expect(reasons).toMatch(/kotwica = pierwszy przechodzący test/);
    expect(reasons).toMatch(/Zmutuj wartość, od której zależy WŁAŚNIE ten test/);
  });

  // Regresja z runu claude-sonnet-5 (2026-08-16): mutacja stałej z hasłem,
  // kotwica pada WŁASNĄ asercją o URL-u. Powiązanie w przód liczyło 12%
  // (rozbudowany opis warunku ma niskie pokrycie w krótkim komunikacie),
  // wstecz 21% - dowód poprawny, odrzucał go kierunek pomiaru.
  it('mutacja i komunikat opisują różne warstwy, ale są powiązane → valid', () => {
    const proof = validateProof(
      material({
        mutation: {
          description: "DEMO_CREDENTIALS.password 'demo123' → 'demo124'",
          diff:
            '--- tests/support/fixtures/credentials.ts\n+++ tests/support/fixtures/credentials.ts\n' +
            "- export const DEMO_CREDENTIALS = { username: 'demo', password: 'demo123' };\n" +
            "+ export const DEMO_CREDENTIALS = { username: 'demo', password: 'demo124' };",
          targetCondition:
            'Kotwica (pierwszy test): poprawne dane logowania (demo/demo123) muszą przenieść ' +
            'na /employees - expect(page).toHaveURL(/\\/employees$/) zależy bezpośrednio od ' +
            'DEMO_CREDENTIALS.password używanego przez LoginPage.login().',
        },
        redRunReport: makeRedAssertionReport({
          file: FILE,
          testTitle: TITLE,
          message:
            'Error: expect(page).toHaveURL(expected) failed\n\n' +
            'Expected pattern: /\\/employees$/\nReceived string:  "http://127.0.0.1:3471/login"\n' +
            'Timeout: 5000ms',
        }),
      }),
      opts,
    );
    expect(proof.verdict).toBe('valid');
    expect(proof.reasons.join(' ')).not.toMatch(/nie odnosi się/);
  });

  // Jedyna ścieżka przepchnięcia fałszywego dowodu bez łamania protokołu:
  // zepsuć kod APLIKACJI (poza repo testów), złapać czerwień własną asercją
  // i przywrócić - `git diff` repo testów pozostaje pusty, bo zmiany tam
  // nigdy nie było.
  it('mutacja poza repo testów → invalid', () => {
    const proof = validateProof(
      material({
        mutation: {
          description: 'zepsuty routing aplikacji',
          diff:
            '--- /home/user/dev/demopay/src/server.js\n' +
            '+++ /home/user/dev/demopay/src/server.js\n' +
            "- res.redirect('/employees')\n+ res.redirect('/nope')",
          targetCondition: 'payroll-net pokazuje netto 3214.50',
        },
      }),
      opts,
    );
    expect(proof.verdict).toBe('invalid');
    expect(proof.reasons.join(' ')).toMatch(/poza repo testów/);
  });

  // Windows: 'C:/x' i drive-relative 'C:x' są absolutne, choć nie zaczynają się
  // od '/'. Diff z gita jest POSIX-owy, ale wartownik ma odrzucać wszystko, co
  // absolutne - także materiał podrzucony z zewnątrz.
  it('ścieżka z literą dysku w diffie → invalid', () => {
    const proof = validateProof(
      material({
        mutation: {
          description: 'zepsuty routing aplikacji na Windowsie',
          diff:
            'diff --git a/C:/dev/demopay/src/server.js b/C:/dev/demopay/src/server.js\n' +
            "- res.redirect('/employees')\n+ res.redirect('/nope')",
          targetCondition: 'payroll-net pokazuje netto 3214.50',
        },
      }),
      opts,
    );
    expect(proof.verdict).toBe('invalid');
    expect(proof.reasons.join(' ')).toMatch(/poza repo testów/);
  });

  it('ścieżka drive-relative (C:x) w diffie → invalid', () => {
    const proof = validateProof(
      material({
        mutation: {
          description: 'ucieczka na bieżący katalog dysku C',
          diff:
            '--- C:server.js\n+++ C:server.js\n' +
            "- res.redirect('/employees')\n+ res.redirect('/nope')",
          targetCondition: 'payroll-net pokazuje netto 3214.50',
        },
      }),
      opts,
    );
    expect(proof.verdict).toBe('invalid');
    expect(proof.reasons.join(' ')).toMatch(/poza repo testów/);
  });

  it('dwukropek w nazwie pliku to nie litera dysku - ścieżka zostaje w repo', () => {
    const proof = validateProof(
      material({
        mutation: {
          description: 'mutacja w pliku z dwukropkiem w nazwie',
          diff:
            '--- tests/e2e/pay:roll.spec.ts\n+++ tests/e2e/pay:roll.spec.ts\n' +
            '- expect(net).toBe("3214.50")\n+ expect(net).toBe("9999.99")',
          targetCondition: 'payroll-net pokazuje netto 3214.50',
        },
      }),
      opts,
    );
    expect(proof.reasons.join(' ')).not.toMatch(/poza repo testów/);
  });

  it('ścieżka z .. w diffie → invalid', () => {
    const proof = validateProof(
      material({
        mutation: {
          description: 'ucieczka katalogiem wyżej',
          diff: 'diff --git a/../demopay/src/app.js b/../demopay/src/app.js\n- x\n+ y',
          targetCondition: 'payroll-net pokazuje netto 3214.50',
        },
      }),
      opts,
    );
    expect(proof.verdict).toBe('invalid');
    expect(proof.reasons.join(' ')).toMatch(/poza repo testów/);
  });

  // Regresja: diff bez nagłówków plików nie niesie żadnej ścieżki, więc bramka
  // zasięgu nie ma czego sprawdzić - agent mógłby zmutować kod aplikacji i
  // przywrócić go bez śladu w repo testów. Brak ścieżek = twardy invalid.
  it('diff bez ścieżek (bez nagłówków) → invalid', () => {
    const proof = validateProof(
      material({
        mutation: {
          description: 'bezgłówkowy diff',
          diff: '- expect(net).toBe("3214.50")\n+ expect(net).toBe("9999.99")',
          targetCondition: 'payroll-net pokazuje netto 3214.50',
        },
      }),
      opts,
    );
    expect(proof.verdict).toBe('invalid');
    expect(proof.reasons.join(' ')).toMatch(/nie zawiera żadnej ścieżki pliku/);
    expect(proof.reasons.join(' ')).toMatch(/repo testów/);
  });

  // Regresja: „proxy", „SSL" i „certyfikat" bywają TREŚCIĄ testowanej aplikacji.
  // Wcześniej każdy taki komunikat asercji lądował jako awaria infrastruktury.
  it('asercja o treści zawierającej proxy/certyfikat → nadal własna asercja', () => {
    for (const value of ['proxy.firma.pl', 'certyfikat rezydencji', 'SSL wygasa 2027-01-01']) {
      const proof = validateProof(
        material({
          mutation: {
            description: 'mutacja wartości oczekiwanej',
            diff:
              '--- tests/e2e/payroll.spec.ts\n+++ tests/e2e/payroll.spec.ts\n' +
              `- expect(v).toBe("${value}")\n+ expect(v).toBe("ZMUTOWANE")`,
            targetCondition: `pole pokazuje ${value}`,
          },
          redRunReport: makeRedAssertionReport({
            file: FILE,
            testTitle: TITLE,
            message:
              'Error: expect(locator).toHaveText(expected) failed\n\n' +
              `Expected string: "${value}"\nReceived string: "ZMUTOWANE"`,
          }),
        }),
        opts,
      );
      expect(proof.redRun.failureKind, `wartość: ${value}`).toBe('own-assertion');
      expect(proof.verdict, `wartość: ${value}`).toBe('valid');
    }
  });

  it('brudny git diff po przywróceniu → invalid', () => {
    const proof = validateProof(material(), { ...opts, gitDiffEmpty: false });
    expect(proof.verdict).toBe('invalid');
    expect(proof.reasons.join(' ')).toMatch(/git diff/);
  });

  // ZMIANA KONTRAKTU (2026-08-16): słabe powiązanie komunikatu z mutacją nie
  // unieważnia dowodu - łańcuch mechaniczny (2× zielony → mutacja w repo
  // testów → czerwień własną asercją TEGO testu → czyste przywrócenie) sam
  // dowodzi przyczynowości. Niskie nakładanie oznacza słabszy RODZAJ dowodu
  // (mutacja wejścia zamiast wartości asertowanej) i idzie jako ostrzeżenie
  // do człowieka przy accept. Twarde odrzucanie kosztowało 2 runy.
  it('komunikat asercji bez związku z warunkiem → valid z ostrzeżeniem', () => {
    const proof = validateProof(
      material({
        mutation: {
          description: 'x',
          diff:
            '--- tests/e2e/payroll.spec.ts\n+++ tests/e2e/payroll.spec.ts\n- const x = 1;\n+ const x = 2;',
          targetCondition: 'suma ubezpieczenia aneksu kontraktu terminowego',
        },
      }),
      opts,
    );
    expect(proof.verdict).toBe('valid');
    expect(proof.reasons).toEqual([]);
    expect(proof.warnings.join(' ')).toMatch(/Słabe powiązanie/);
    expect(proof.warnings.join(' ')).toMatch(/zmutowano WEJŚCIE/);
  });

  it('zadeklarowany proofTest wskazuje kotwicę zamiast pozycji w specu', () => {
    const DRUGI = 'drugi test w specu';
    const green = makeMultiTestReport([
      { file: FILE, testTitle: TITLE, status: 'passed' },
      { file: FILE, testTitle: DRUGI, status: 'passed' },
    ]);
    const red = makeMultiTestReport([
      { file: FILE, testTitle: TITLE, status: 'passed' },
      {
        file: FILE,
        testTitle: DRUGI,
        status: 'failed',
        message:
          'Error: expect(locator).toHaveText(expected) failed\n\nExpected string: "3214.50"\nReceived string: "9999.99"',
      },
    ]);
    const proof = validateProof(
      material({
        greenRunReports: [green, green],
        redRunReport: red,
        proofTest: DRUGI,
      }),
      opts,
    );
    expect(proof.verdict).toBe('valid');
    expect(proof.redRun.testId).toContain(DRUGI);
  });

  it('proofTest nieobecny w zielonym raporcie → invalid z listą dostępnych', () => {
    const proof = validateProof(material({ proofTest: 'nie ma takiego testu' }), opts);
    expect(proof.verdict).toBe('invalid');
    expect(proof.reasons.join(' ')).toMatch(/nie występuje jako przechodzący/);
  });
});

describe('conditionOverlap', () => {
  it('liczy nakładanie tokenów', () => {
    expect(conditionOverlap('netto 3214.50', 'Expected: "3214.50" netto')).toBe(1);
    expect(conditionOverlap('aneks ubezpieczenia', 'Expected string: "42"')).toBe(0);
  });
});
