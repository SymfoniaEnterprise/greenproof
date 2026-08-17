/**
 * Deterministyczna walidacja dowodu mutacyjnego - poza kontrolą agenta.
 * Dowód wymaga: zepsuty warunek czerwieni test WŁASNĄ asercją (nie timeoutem,
 * nie błędem infry), w tym samym teście, a po przywróceniu diff pusty.
 */
import type {
  FailureKind,
  MutationProof,
  ProofMaterial,
  RunSummary,
} from '../domain/proof.js';

/** Minimalny kształt raportu JSON Playwrighta (suites zagnieżdżone). */
interface PwReport {
  suites?: PwSuite[];
  errors?: { message?: string }[];
}
interface PwSuite {
  title?: string;
  file?: string;
  specs?: PwSpec[];
  suites?: PwSuite[];
}
interface PwSpec {
  title?: string;
  file?: string;
  tests?: { results?: PwResult[]; status?: string }[];
}
interface PwResult {
  status?: string;
  duration?: number;
  error?: { message?: string; stack?: string };
  errors?: { message?: string }[];
}

export class ReportParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReportParseError';
  }
}

/** Spłaszcza raport JSON Playwrighta do listy RunSummary (testId = plik::tytuł). */
export function parseRunSummaries(reportJson: string): RunSummary[] {
  let report: PwReport;
  try {
    report = JSON.parse(reportJson) as PwReport;
  } catch {
    throw new ReportParseError('Raport Playwrighta nie jest poprawnym JSON-em');
  }
  const out: RunSummary[] = [];
  const walk = (suite: PwSuite, parentFile?: string): void => {
    const file = suite.file ?? parentFile;
    for (const spec of suite.specs ?? []) {
      const specFile = spec.file ?? file ?? 'unknown';
      for (const test of spec.tests ?? []) {
        // Ostatni result = efektywny (wcześniejsze to retry Playwrighta).
        const results = test.results ?? [];
        const last = results[results.length - 1];
        const failed =
          last?.status !== undefined && last.status !== 'passed' && last.status !== 'skipped';
        const errorMessage =
          last?.error?.message ?? last?.errors?.map((e) => e.message).find(Boolean);
        out.push({
          testId: `${specFile}::${spec.title ?? ''}`,
          status: failed ? 'failed' : 'passed',
          ...(last?.duration !== undefined ? { durationMs: last.duration } : {}),
          ...(failed && errorMessage !== undefined ? { errorMessage } : {}),
        });
      }
    }
    for (const child of suite.suites ?? []) walk(child, file);
  };
  for (const suite of report.suites ?? []) walk(suite);
  return out;
}

const TIMEOUT_PATTERNS = [
  /test timeout of \d+m?s exceeded/i,
  /timeouterror/i,
  /timeout \d+m?s exceeded/i,
  /exceeded while waiting/i,
];

/**
 * Wzorce muszą być WĄSKIE: to samo słowo bywa treścią aplikacji, więc
 * łapiemy konkretne komunikaty Playwrighta/Node'a, nie słowa („proxy",
 * „SSL", „certyfikat").
 */
const INFRA_PATTERNS = [
  /net::err_/i,
  /econnrefused|econnreset|enotfound|eai_again/i,
  /browsercontext\.|browser\.newcontext|browsertype\.launch/i,
  /target (crashed|closed)/i,
  /browser has been closed/i,
  /page crashed/i,
  /proxy connect (error|failed)|err_proxy|tunneling socket could not be established/i,
  /unable to verify the first certificate|self[- ]signed certificate|cert_authority_invalid|err_cert_|ssl routines|epROTO/i,
];

/** Sygnatury błędu pochodzącego z własnej asercji expect() Playwrighta. */
const ASSERTION_PATTERNS = [
  /expect\(.*\)\s*(failed|\.)/is,
  /expect\(received\)/i,
  /\bto(Have|Be|Contain|Equal|Match)[A-Za-z]*\b.*(failed|expected)/is,
  /expected (string|value|substring|pattern)?:/i,
  /assertionerror/i,
];

/** Kody ANSI trafiają do komunikatów nawet w raporcie JSON. */
export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\[[0-9;]*m/g, '');
}

/**
 * Timeout ASERCJI ("Timed out 5000ms waiting for expect(locator)...") to WŁASNA
 * asercja - auto-ponawiane expect() zawsze czeka do limitu przy złej wartości.
 * Dyskwalifikuje timeout TESTU albo czekanie bez expect().
 */
const ASSERTION_TIMEOUT_RE = /waiting for expect\(/i;

export function classifyFailure(errorMessage: string | undefined): FailureKind {
  if (!errorMessage) return 'other';
  const msg = stripAnsi(errorMessage);
  if (ASSERTION_TIMEOUT_RE.test(msg)) return 'own-assertion';
  if (TIMEOUT_PATTERNS.some((p) => p.test(msg))) return 'timeout';
  if (INFRA_PATTERNS.some((p) => p.test(msg))) return 'infra';
  if (ASSERTION_PATTERNS.some((p) => p.test(msg))) return 'own-assertion';
  return 'other';
}

/**
 * Ścieżki plików dotkniętych mutacją, z nagłówków unified diff
 * (`diff --git a/x b/y`, pary `--- a/x` / `+++ b/y`; prefiksy `a/`, `b/`
 * i `/dev/null` odpadają).
 */
export function mutationPaths(diff: string): string[] {
  const out = new Set<string>();
  for (const line of diff.split('\n')) {
    const git = /^diff --git\s+(\S+)\s+(\S+)/.exec(line);
    if (git) {
      for (const p of [git[1], git[2]]) if (p) out.add(p.replace(/^[ab]\//, ''));
      continue;
    }
    const hdr = /^(?:---|\+\+\+)\s+(\S+)/.exec(line);
    if (hdr?.[1] && hdr[1] !== '/dev/null') out.add(hdr[1].replace(/^[ab]\//, ''));
  }
  return [...out];
}

/**
 * Mutacja MUSI mieścić się w repo testów. Inaczej otwiera się ścieżka
 * fałszywego dowodu: agent psuje kod APLIKACJI, test czerwieni się własną
 * asercją, a `git diff` repo testów jest pusty, bo zmiany w nim nie było.
 */
function pathEscapesTestsRepo(p: string): boolean {
  // Wartownik odrzuca wszystko, co absolutne - także materiał dowodu z zewnątrz.
  // Normalizacja '\' → '/' domyka UNC i `..\x`; prefiks litery dysku (`C:/x`,
  // `C:x`) sprawdzamy TYLKO na początku, bo `a/b:c.ts` to legalna nazwa na Linuksie.
  const normalized = p.replaceAll('\\', '/');
  return (
    normalized.startsWith('/') ||
    normalized.startsWith('~') ||
    /^[A-Za-z]:/.test(normalized) ||
    normalized.split('/').includes('..')
  );
}

/** Tokeny zbyt generyczne w kodzie testowym, by dowodziły związku z warunkiem. */
const OVERLAP_STOPWORDS = new Set([
  'await', 'expect', 'page', 'locator', 'async', 'const', 'test', 'tobe', 'not',
]);

/** Nakładanie tokenów warunku na komunikat błędu (0..1). */
export function conditionOverlap(targetCondition: string, errorMessage: string): number {
  const tokens = [
    ...new Set(
      targetCondition
        .toLowerCase()
        .split(/[^\p{L}\p{N},.]+/u)
        .filter((t) => t.length >= 3 && !OVERLAP_STOPWORDS.has(t)),
    ),
  ];
  if (tokens.length === 0) return 0;
  const msg = errorMessage.toLowerCase();
  const hit = tokens.filter((t) => msg.includes(t)).length;
  return hit / tokens.length;
}

export interface ValidateProofOptions {
  caseId: string;
  attemptId: string;
  /** Czy `git diff` po przywróceniu mutacji jest pusty (sprawdzane przez wywołującego na repo). */
  gitDiffEmpty: boolean;
  /** Czy agent zadeklarował przywrócenie. */
  restoredVerified: boolean;
  /**
   * Minimalne nakładanie targetCondition/diffa na komunikat asercji
   * (domyślnie 0.15: powiązane komunikaty 20-100%, niepowiązane ~0%).
   */
  conditionOverlapThreshold?: number;
}

export function validateProof(
  material: ProofMaterial,
  opts: ValidateProofOptions,
): MutationProof {
  const reasons: string[] = [];
  const warnings: string[] = [];
  const threshold = opts.conditionOverlapThreshold ?? 0.15;

  const [green1, green2] = material.greenRunReports.map((r) => parseRunSummaries(r)) as [
    RunSummary[],
    RunSummary[],
  ];
  const red = parseRunSummaries(material.redRunReport);

  // Test-kotwica. Preferujemy DEKLARACJĘ agenta (`proofTest`) - wybór pozycyjny
  // („pierwszy przechodzący") zależy od kolejności testów, przez co poprawny
  // dowód potrafił trafić w niewłaściwy test. Deklaracja nie osłabia kontroli:
  // wskazany test i tak musi przejść w OBU zielonych i paść własną asercją.
  const passing1 = green1.filter((r) => r.status === 'passed');
  const declared = material.proofTest?.trim();
  let anchor: RunSummary | undefined;
  if (declared) {
    const exact = passing1.filter((r) => r.testId === declared);
    const partial = exact.length > 0 ? exact : passing1.filter((r) => r.testId.includes(declared));
    if (partial.length === 0) {
      reasons.push(
        `Zadeklarowany test dowodowy "${declared}" nie występuje jako przechodzący w pierwszym zielonym raporcie`,
      );
    } else if (partial.length > 1) {
      reasons.push(
        `Zadeklarowany test dowodowy "${declared}" pasuje do ${partial.length} testów (${partial
          .map((r) => r.testId)
          .join(', ')}) - podaj pełny identyfikator plik::tytuł`,
      );
    } else {
      anchor = partial[0];
    }
  } else {
    anchor = passing1[0];
    if (!anchor) reasons.push('Pierwszy zielony raport nie zawiera żadnego przechodzącego testu');
  }
  const anchorId = anchor?.testId ?? '';

  if (anchor) {
    const inSecond = green2.find((r) => r.testId === anchorId);
    if (!inSecond || inSecond.status !== 'passed') {
      reasons.push(`Drugi zielony raport nie potwierdza przejścia testu ${anchorId}`);
    }
  }

  const redResult = red.find((r) => r.testId === anchorId);
  const failedInSameTest = redResult?.status === 'failed';
  if (!redResult) {
    reasons.push(`Czerwony raport nie zawiera testu ${anchorId}`);
  } else if (redResult.status !== 'failed') {
    // Sam komunikat "nadal przechodzi" bywa nieczytelny - model mutował stałą,
    // od której kotwica nie zależy, i zaczerwienił INNY test. Stąd jawna
    // wskazówka: co jest kotwicą i co z tym zrobić.
    const otherReds = red
      .filter((r) => r.testId !== anchorId && r.status === 'failed')
      .map((r) => r.testId);
    reasons.push(
      `Po mutacji test ${anchorId} nadal przechodzi - spec nie weryfikuje warunku. ` +
        `Dowód liczy się TYLKO dla tego testu (kotwica = pierwszy przechodzący test specu)` +
        (otherReds.length > 0
          ? `; zaczerwienienie innych testów (${otherReds.join(', ')}) nie zastępuje dowodu`
          : '') +
        `. Zmutuj wartość, od której zależy WŁAŚNIE ten test (stała/selektor/dane używane w jego ścieżce) - ` +
        `jeśli mutowana stała jest używana wyłącznie przez inny test, kotwica nigdy się nie zaczerwieni.`,
    );
  }

  const failureKind = classifyFailure(redResult?.errorMessage);
  if (failedInSameTest && failureKind !== 'own-assertion') {
    reasons.push(
      `Porażka po mutacji ma rodzaj "${failureKind}" - wymagana własna asercja (timeout/błąd infry nie dowodzi niczego)`,
    );
  }

  const assertionMessage = failureKind === 'own-assertion' ? redResult?.errorMessage : undefined;
  if (assertionMessage) {
    const msg = stripAnsi(assertionMessage);
    // Dwa źródła powiązania: opis warunku (może być w innym języku niż kod)
    // ORAZ linie diffa mutacji - wartości oczekiwane, które Playwright powtarza
    // w komunikacie asercji.
    const diffLines = material.mutation.diff
      .split('\n')
      .filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---)/.test(l))
      .map((l) => l.slice(1))
      .join(' ');
    // Powiązanie liczymy SYMETRYCZNIE: `conditionOverlap` mierzy, jaka część
    // tokenów pierwszego tekstu jest w drugim - wrażliwa na długość opisu,
    // więc rozbudowany `targetCondition` ma niskie pokrycie w krótkim
    // komunikacie, choć oba mówią o tym samym.
    const relatedness = (a: string, b: string): number =>
      Math.max(conditionOverlap(a, b), conditionOverlap(b, a));
    const overlap = Math.max(
      relatedness(material.mutation.targetCondition, msg),
      relatedness(diffLines, msg),
    );
    // OSTRZEŻENIE, nie odrzucenie. Łańcuch mechaniczny (przejście ×2 → mutacja
    // → porażka własną asercją TEGO testu → mutacja w repo testów → czyste
    // przywrócenie) sam dowodzi przyczynowości. Niskie nakładanie sygnalizuje
    // mutację WEJŚCIA (np. hasła w fixture) zamiast wartości ASERTOWANEJ -
    // test padł, bo nie doszedł do asercji. To słabszy, nie fałszywy dowód;
    // decyzję zostawiamy człowiekowi przy `accept`.
    if (overlap < threshold) {
      warnings.push(
        `Słabe powiązanie komunikatu asercji z mutacją (${(overlap * 100).toFixed(0)}% < ${(threshold * 100).toFixed(0)}%) - ` +
          `prawdopodobnie zmutowano WEJŚCIE testu, nie wartość asertowaną. Dowód jest ważny mechanicznie, ` +
          `ale słabszy: sprawdź przy akceptacji, czy spec faktycznie weryfikuje warunek, a nie tylko od niego zależy`,
      );
    }
  }

  const mutationFiles = mutationPaths(material.mutation.diff);
  if (mutationFiles.length === 0) {
    // Diff bez nagłówków plików nie niesie żadnej ścieżki - bramka zasięgu nie
    // ma czego sprawdzić, a agent mógłby zmutować kod APLIKACJI bez śladu.
    // Brak ścieżek to twarda dyskwalifikacja, nie ostrzeżenie.
    reasons.push(
      'Diff mutacji nie zawiera żadnej ścieżki pliku (brak nagłówków `diff --git a/… b/…` ani `--- a/…` / `+++ b/…`) - ' +
        'nie da się zweryfikować, czy mutacja mieściła się w repo testów',
    );
  }
  const outside = mutationFiles.filter(pathEscapesTestsRepo);
  if (outside.length > 0) {
    reasons.push(
      `Mutacja wyszła poza repo testów (${outside.join(', ')}) - dowód musi psuć spec/POM/fixture, ` +
        `nie kod aplikacji: zmiany poza repo nie są widoczne w kontroli przywrócenia`,
    );
  }

  if (!opts.restoredVerified) reasons.push('Agent nie zadeklarował przywrócenia wersji sprzed mutacji');
  if (!opts.gitDiffEmpty) reasons.push('git diff po przywróceniu mutacji nie jest pusty');

  const greenSummary = (runs: RunSummary[]): RunSummary =>
    runs.find((r) => r.testId === anchorId) ?? runs[0] ?? { testId: anchorId, status: 'failed' };

  return {
    caseId: opts.caseId,
    attemptId: opts.attemptId,
    greenRuns: [greenSummary(green1), greenSummary(green2)],
    mutation: material.mutation,
    redRun: {
      ...(redResult ?? { testId: anchorId, status: 'failed' }),
      failedInSameTest,
      failureKind,
      ...(assertionMessage !== undefined ? { assertionMessage } : {}),
    },
    restored: { verified: opts.restoredVerified, gitDiffEmpty: opts.gitDiffEmpty },
    verdict: reasons.length === 0 ? 'valid' : 'invalid',
    reasons,
    warnings,
  };
}
