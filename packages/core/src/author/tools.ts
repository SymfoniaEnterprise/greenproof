/**
 * Własny serwer MCP (in-process) z narzędziami PROCESOWYMI sesji autora.
 * Interakcję z przeglądarką robi @playwright/mcp - tu żyje pamięć sesji:
 * fazy, bezpiecznik seedu, harvest POM/wiedzy i surowiec dowodu mutacyjnego.
 */
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { GreenproofConfig } from '../config/types.js';
import type { UiTrap } from '../domain/knowledge.js';
import type { PomIndex } from '../domain/harvest.js';
import type { Clock } from '../ports/index.js';
import { emitProgress, type ProgressSink } from '../domain/progress.js';
import { upsertEntry, HarvestValidationError } from '../harvest/inventory.js';
import { mutationPaths, parseRunSummaries } from '../proof/validator.js';
import type { CaseContext } from '../steps/triage.js';
import { safeCaseId } from '../steps/filter.js';
import { npxDirect, runToCompletion, spawnArgv, type SpawnArgvOptions } from '../util/exec.js';
import type { AuthorSessionState, PlaywrightRunRecord } from './state.js';

function text(message: string) {
  return { content: [{ type: 'text' as const, text: message }] };
}

/**
 * Prefiks litery dysku Windows - `C:/x`, `c:\x`, a także drive-relative `C:x`.
 * Dotyczy TYLKO początku całej ścieżki: `a/b:c.ts` to legalna nazwa pliku.
 * `isAbsolute` nie łapie drive-relative, więc bez tego `join(cwd, 'C:raport.json')`
 * dawałby na Windowsie ścieżkę-śmiecia.
 */
const WINDOWS_DRIVE_PREFIX = /^[A-Za-z]:/;

export interface ToolDeps {
  state: AuthorSessionState;
  config: GreenproofConfig;
  context: CaseContext;
  /** Katalog roboczy repo testów (cwd agenta). */
  cwd: string;
  /** Katalog plików roboczych próby - tu lądują wersjonowane raporty (pw-runs/). */
  attemptDir: string;
  clock: Clock;
  /** Identyfikator przebiegu - do zdarzeń postępu (caseId/attempt są w kontekście). */
  runId: string;
  /** Odbiornik zdarzeń postępu z sesji; brak = brak emisji. */
  onProgress?: ProgressSink;
}

export function createGreenproofTools(deps: ToolDeps) {
  const { state, config, context, cwd, clock } = deps;
  const caps = config.caps;
  const pw = config.playwright;
  const fuse = caps.seedFuse;

  const markPhase = tool(
    'mark_phase',
    'OBOWIĄZKOWE oznaczenie bieżącej fazy pracy: arrange (doprowadzanie stanu/seed), act (kroki testu), assert (asercje i uruchomienia playwright test). Wywołuj przy każdej zmianie fazy.',
    { phase: z.enum(['arrange', 'act', 'assert']) },
    async ({ phase }) => {
      state.markPhase(phase);
      return text(`Faza: ${phase}.`);
    },
  );

  const reportSeedAttempt = tool(
    'report_seed_attempt',
    'Raportuj każdą próbę strategii doprowadzenia stanu wyjściowego (seed) - nazwa strategii + wynik. Obowiązkowe dla case churn-prone.',
    {
      strategy: z.string().min(1),
      outcome: z.enum(['ok', 'failed']),
      note: z.string().optional(),
    },
    async ({ strategy, outcome, note }) => {
      state.seedAttempts.push({ strategy, outcome, ...(note !== undefined ? { note } : {}) });
      if (outcome === 'ok') {
        state.seedConfirmed = true;
        if (state.fuseTripped) {
          // Spóźnione potwierdzenie seedu zdejmuje bezpiecznik - wracamy do pracy.
          state.fuseTripped = false;
          delete state.fuseTrippedAtTurn;
          delete state.fuseNote;
          return text(
            'Seed potwierdzony - bezpiecznik ZDJĘTY. Wracaj do pracy: mark_phase("act"), pisz spec i od razu przechodź do uruchomień playwright test. Raportuj strategie seedu NATYCHMIAST po weryfikacji, nie po fakcie.',
          );
        }
        return text('Seed potwierdzony - przejdź do fazy act (mark_phase).');
      }
      if (context.churnProne && state.distinctFailedSeedStrategies >= fuse.maxFailedStrategies) {
        state.fuseTripped = true;
        state.fuseTrippedAtTurn = state.turns;
        state.fuseNote = `fixture-gap: ${state.distinctFailedSeedStrategies} różne strategie seedu zawiodły (${state.seedAttempts
          .filter((s) => s.outcome === 'failed')
          .map((s) => s.strategy)
          .join(', ')})`;
        return text(
          'STOP - bezpiecznik seedu. Wyczerpałeś limit strategii doprowadzenia stanu. NIE próbuj kolejnych podejść. Natychmiast wywołaj mcp__greenproof__finish ze statusem "blocked" i notatką fixture-gap opisującą, jakiego POM/fixture\'a brakuje, po czym zakończ turę.',
        );
      }
      return text(
        `Strategia "${strategy}" nieudana (${state.distinctFailedSeedStrategies}/${fuse.maxFailedStrategies} różnych porażek).`,
      );
    },
  );

  const registerPom = tool(
    'register_pom',
    'Zarejestruj NOWY Page Object / fixture odkryty w tej sesji we współdzielonym inwentarzu (pom-index.json). Odkrycie, za które zapłaciłeś, staje się darmowe dla kolejnych case.',
    {
      name: z.string().min(1),
      path: z.string().min(1),
      kind: z.enum(['pom', 'fixture']),
      description: z.string().min(1),
      covers: z.array(z.string().min(1)).min(1),
      keySelectors: z.array(z.string()).default([]),
    },
    async (input) => {
      const abs = join(cwd, input.path);
      let source: string;
      try {
        source = await readFile(abs, 'utf8');
      } catch {
        return text(`BŁĄD: plik ${input.path} nie istnieje - najpierw utwórz POM, potem rejestruj.`);
      }
      if (input.kind === 'pom' && !/export\s+(class|const|function)/.test(source)) {
        return text(`BŁĄD: ${input.path} niczego nie eksportuje - POM musi być reużywalny.`);
      }
      const indexPath = join(cwd, config.paths.pomIndex);
      let index: PomIndex = { version: 1, entries: [] };
      try {
        index = JSON.parse(await readFile(indexPath, 'utf8')) as PomIndex;
      } catch {
        /* brak indeksu = pierwszy wpis */
      }
      try {
        const updated = upsertEntry(index, { ...input, harvestedBy: context.case.caseId }, clock);
        await mkdir(dirname(indexPath), { recursive: true });
        await writeFile(indexPath, JSON.stringify(updated, null, 2));
      } catch (err) {
        if (err instanceof HarvestValidationError) return text(`BŁĄD: ${err.message}`);
        throw err;
      }
      state.filesTouched.add(input.path);
      return text(
        `Zarejestrowano ${input.name} (${input.kind}) w inwentarzu. Pamiętaj o commicie pom-index.json razem z plikiem.`,
      );
    },
  );

  const registerUiTrap = tool(
    'register_ui_trap',
    'Zaproponuj wpis wiedzy projektowej: pułapka UI, za której odkrycie właśnie zapłaciłeś turami. Propozycja trafi do przeglądu człowieka przy akcepcie.',
    {
      component: z.string().min(1),
      trap: z.string().min(1),
      workaround: z.string().min(1),
      selectorExample: z.string().optional(),
      category: z.enum(['component-behavior', 'domain-knowledge']),
      appliesTo: z.array(z.string()).default([]),
    },
    async (input) => {
      if (!config.knowledge) {
        return text('Projekt nie ma katalogu wiedzy - pomiń rejestrowanie pułapek.');
      }
      const proposalPath = join(
        cwd,
        config.knowledge.dir,
        'proposals',
        `${safeCaseId(context.case.caseId)}.yaml`,
      );
      let traps: UiTrap[] = [];
      try {
        traps = ((parseYaml(await readFile(proposalPath, 'utf8')) as { traps?: UiTrap[] })
          ?.traps ?? []);
      } catch {
        /* pierwszy wpis */
      }
      const entry: UiTrap = {
        component: input.component,
        trap: input.trap,
        workaround: input.workaround,
        ...(input.selectorExample !== undefined ? { selectorExample: input.selectorExample } : {}),
        category: input.category,
        appliesTo: input.appliesTo.length > 0 ? input.appliesTo : context.case.flows,
        evidence: { caseId: context.case.caseId, attemptId: `attempt-${context.attempt}` },
      };
      traps.push(entry);
      await mkdir(dirname(proposalPath), { recursive: true });
      await writeFile(proposalPath, stringifyYaml({ traps }));
      return text('Propozycja zapisana (knowledge/proposals). Dodaj plik do commita.');
    },
  );

  /**
   * Uruchomienie `playwright test` pod kontrolą pipeline'u. Dwa powody, dla
   * których to NIE może być zwykły Bash:
   * 1) raport JSON leci pod WERSJONOWANĄ ścieżkę (run-NN-<purpose>.json) -
   *    współdzielony plik z configu projektu nadpisuje każdy kolejny przebieg,
   *    więc dowód budowany na jego ścieżce ocenia nie te uruchomienia, co trzeba;
   * 2) budżet runów ma DWIE pule (assert + dowodowa), a model nie może ich mylić.
   */
  const runPlaywright = tool(
    'run_playwright',
    'JEDYNY sposób uruchomienia `playwright test` (Bash jest zablokowany). Zwraca ścieżkę WERSJONOWANEGO raportu JSON tego przebiegu - tę ścieżkę (albo run:<n>) podajesz do record_proof_material. Nigdy nie podawaj współdzielonego pliku raportu z configu projektu.',
    {
      purpose: z
        .enum(['green', 'red', 'debug'])
        .describe('green = przebieg dowodowy zielony, red = po mutacji, debug = diagnostyka'),
      specPath: z.string().optional().describe('Ścieżka speca (bez = cały pakiet testów)'),
      grep: z.string().optional().describe('Filtr tytułu testu (--grep)'),
      extraArgs: z.array(z.string()).default([]),
    },
    async ({ purpose, specPath, grep, extraArgs }) => {
      // Pula wynika WYŁĄCZNIE z licznika zielonych przebiegów - nigdy z pola
      // purpose. Purpose to telemetria i dyscyplina promptu: modele kłamią.
      const pool: 'assert' | 'proof' = state.greenRuns >= 2 ? 'proof' : 'assert';
      if (pool === 'proof') {
        if (state.proofRunsUsed >= caps.proofRuns) {
          state.playwrightRunsExhausted = true;
          return text(
            `STOP - pula ${caps.proofRuns} runów dowodowych wyczerpana. NIE uruchamiaj testów dalej: zakończ sesję (finish + wynik strukturalny) z tym, co masz. Jeśli masz komplet raportów, wywołaj record_proof_material; jeśli nie - zgłoś status blocked z notatką, czego zabrakło.`,
          );
        }
      } else if (state.phase === 'assert' && state.playwrightRunsByPhase.assert >= caps.maxPlaywrightRuns) {
        state.playwrightRunsExhausted = true;
        return text(
          `STOP - limit ${caps.maxPlaywrightRuns} runów fazy assert wyczerpany, a nie masz dwóch zielonych przebiegów. NIE iteruj dalej: zakończ sesję (finish + wynik strukturalny) z aktualnym wynikiem i opisz w notatce, co blokuje zieleń.`,
        );
      }

      const runIndex = state.playwrightRuns.length + 1;
      const runsDir = join(deps.attemptDir, 'pw-runs');
      const reportPath = join(runsDir, `run-${String(runIndex).padStart(2, '0')}-${purpose}.json`);
      await mkdir(runsDir, { recursive: true });

      // Kasujemy OBU kandydatów raportu PRZED startem: po przejętym lease
      // attemptDir (i numeracja runów) wraca do zera, a współdzielony
      // pw.reportFile przeżywa między case'ami - bez tego przebieg, który padł
      // bez raportu, mógłby zalegalizować stęchłe zielone/czerwone z przeszłości.
      // Współdzielony raport honorujemy TYLKO wewnątrz repo testów: reportFile
      // z traversalem (../..) nie może kasować ani podczytywać plików poza cwd.
      const sharedCandidate = resolve(cwd, pw.reportFile);
      const sharedReportPath = sharedCandidate.startsWith(resolve(cwd) + sep)
        ? sharedCandidate
        : undefined;
      await rm(reportPath, { force: true });
      if (sharedReportPath !== undefined) await rm(sharedReportPath, { force: true });

      const [rawCommand, ...baseArgs] = pw.command as [string, ...string[]];
      const fullArgs = [
        ...baseArgs,
        ...(specPath !== undefined ? [specPath] : []),
        ...(grep !== undefined ? ['--grep', grep] : []),
        '--reporter=json',
        ...extraArgs,
      ];
      // Config zostaje neutralny platformowo (`npx playwright test`) - platformę
      // rozstrzygamy dopiero tutaj, w miejscu spawnu. Argumenty są dynamiczne
      // (ścieżka spec-a, wzorzec --grep OD MODELU), więc na Windowsie domyślne
      // `npx` odpalamy wprost node'em (npx-cli.js): wtedy argv w ogóle nie
      // przechodzi przez parser metaznaków cmd.exe. Dla innych komend z configu
      // zostaje cmd.exe z ręcznym escapowaniem przez spawnArgv.
      const direct = rawCommand === 'npx' ? npxDirect(fullArgs) : undefined;
      const { command, args: argv, options: spawnOptions } =
        direct !== undefined
          ? { ...direct, options: {} as SpawnArgvOptions }
          : spawnArgv(rawCommand, fullArgs);

      const outcome = await runToCompletion(command, argv, {
        cwd,
        env: { ...process.env, [pw.reportEnvVar]: reportPath },
        timeoutMs: pw.runTimeoutMinutes * 60_000,
        ...spawnOptions,
      });

      // Niezerowy kod = czerwone testy, czyli NORMALNY wynik, nie awaria.
      // Awaria spawnu, timeout i śmierć od sygnału dostają kod -1 i notatkę.
      let exitCode = 0;
      let spawnError: string | undefined;
      if (outcome.timedOut) {
        exitCode = -1;
        spawnError = `przebieg przekroczył twardy limit ${pw.runTimeoutMinutes} min i został ubity razem z procesami potomnymi`;
      } else if (outcome.spawnError !== undefined) {
        exitCode = -1;
        spawnError = `nie udało się uruchomić "${rawCommand}": ${outcome.spawnError.code ?? outcome.spawnError.message}`;
      } else if (outcome.exitCode === null) {
        exitCode = -1;
        spawnError = `proces został ubity sygnałem ${outcome.signal ?? 'nieznanym'}`;
      } else {
        exitCode = outcome.exitCode;
      }

      // Licznik puli rośnie za KAŻDY realny przebieg (także taki bez raportu) -
      // inaczej zepsuta konfiguracja reportera pozwalałaby kręcić się w kółko
      // za darmo.
      state.playwrightRunsByPhase[state.phase] += 1;
      if (pool === 'proof') state.proofRunsUsed += 1;

      const pushRecord = (rec: Omit<PlaywrightRunRecord, 'index' | 'phase' | 'purpose'>): void => {
        state.playwrightRuns.push({ index: runIndex, phase: state.phase, purpose, ...rec });
      };
      const budget = () => ({
        assertUsed: state.playwrightRunsByPhase.assert,
        assertMax: caps.maxPlaywrightRuns,
        proofUsed: state.proofRunsUsed,
        proofMax: caps.proofRuns,
        greenRuns: state.greenRuns,
      });

      // Fallback: projekt mógł zignorować zmienną środowiskową (reporter json
      // zapisany na sztywno w playwright.config) - wtedy kopiujemy współdzielony
      // raport pod ścieżkę wersjonowaną, żeby dowód dostał właściwy przebieg.
      let raw: string | undefined;
      try {
        raw = await readFile(reportPath, 'utf8');
      } catch {
        if (sharedReportPath !== undefined) {
          try {
            raw = await readFile(sharedReportPath, 'utf8');
            await writeFile(reportPath, raw);
          } catch {
            /* brak obu ścieżek = diagnostyka poniżej */
          }
        }
      }
      if (raw === undefined) {
        pushRecord({ reportPath: '', passed: 0, failed: 0, total: 0, exitCode });
        return text(
          [
            `BRAK RAPORTU JSON dla przebiegu ${runIndex} (kod wyjścia ${exitCode}).`,
            ...(spawnError !== undefined ? [`Powód: ${spawnError}.`] : []),
            `Nie znalazłem ani ${reportPath}, ani ${pw.reportFile} w katalogu roboczym.`,
            `Upewnij się, że projekt ma reporter "json" i respektuje zmienną ${pw.reportEnvVar} (albo zapisuje raport do ${pw.reportFile}). Ten przebieg policzył się do budżetu: ${JSON.stringify(budget())}.`,
          ].join(' '),
        );
      }

      let passed = 0;
      let failed = 0;
      let total = 0;
      let firstError: string | undefined;
      try {
        const summaries = parseRunSummaries(raw);
        total = summaries.length;
        failed = summaries.filter((s) => s.status === 'failed').length;
        passed = total - failed;
        firstError = summaries.find((s) => s.errorMessage !== undefined)?.errorMessage?.slice(0, 800);
      } catch {
        pushRecord({ reportPath, passed: 0, failed: 0, total: 0, exitCode });
        return text(
          `Raport ${reportPath} nie jest poprawnym JSON-em Playwrighta - uruchom testy z reporterem "json" (przebieg policzony do budżetu: ${JSON.stringify(budget())}).`,
        );
      }

      // Zielony = faza assert + realnie wykonane testy + zero porażek + CZYSTE
      // wyjście procesu. Niezerowy kod przy przechodzących testach (padnięty
      // teardown/reporter) to nie jest dowodowa zieleń - nie odblokowuje puli proof.
      if (state.phase === 'assert' && total > 0 && failed === 0 && exitCode === 0) {
        state.greenRuns += 1;
      }
      pushRecord({ reportPath, passed, failed, total, exitCode });

      // Postęp: stan pul PO runie (budget()) - renderer pokazuje zużycie bez
      // czekania na koniec tury.
      emitProgress(deps.onProgress, {
        kind: 'playwright-run',
        runId: deps.runId,
        at: clock.now().toISOString(),
        caseId: context.case.caseId,
        attempt: context.attempt,
        runIndex,
        purpose,
        pool,
        passed,
        failed,
        total,
        pw: budget(),
      });

      return text(
        [
          JSON.stringify({
            runIndex,
            phase: state.phase,
            purpose,
            reportPath,
            passed,
            failed,
            total,
            exitCode,
            budget: budget(),
            ...(firstError !== undefined ? { firstError } : {}),
          }),
          `Do record_proof_material podawaj reportPath tego przebiegu albo "run:${runIndex}" - NIGDY ${pw.reportFile} (ten plik nadpisuje każdy kolejny przebieg).`,
        ].join('\n'),
      );
    },
  );

  /**
   * Raport można podać treścią, ścieżką pliku ALBO referencją run:<n> do
   * przebiegu run_playwright (ścieżka/referencja są tańsze - zero tokenów na
   * inline). Przy enforceRunPlaywrightTool treść inline i obce ścieżki są
   * odrzucane - patrz strażnik prowieniencji poniżej.
   */
  async function resolveReport(value: string): Promise<{ json: string } | { error: string }> {
    let raw = value.trim();
    // Prowieniencja przy twardym egzekwowaniu: surowiec dowodu pochodzi
    // WYŁĄCZNIE z run_playwright (run:<n> albo dokładnie jego reportPath).
    // Inaczej `npm test` w skrypcie pakietowym omijałby budżet i wersjonowanie,
    // a inline-JSON dałoby się po prostu sfabrykować.
    if (
      config.caps.enforceRunPlaywrightTool &&
      !/^run:\d+$/.test(raw) &&
      !state.playwrightRuns.some((r) => r.reportPath !== '' && r.reportPath === raw)
    ) {
      return {
        error: `"${value.slice(0, 120)}": przy enforceRunPlaywrightTool surowiec dowodu musi pochodzić z run_playwright - podaj run:<n> albo reportPath zwrócony przez to narzędzie`,
      };
    }
    const runRef = /^run:(\d+)$/.exec(raw);
    if (runRef) {
      const index = Number(runRef[1]);
      const record = state.playwrightRuns.find((r) => r.index === index);
      if (!record) {
        return { error: `nie ma przebiegu run:${index} (wykonane: ${state.playwrightRuns.length})` };
      }
      if (record.reportPath === '') {
        return { error: `przebieg run:${index} nie wyprodukował raportu JSON - powtórz uruchomienie` };
      }
      raw = record.reportPath;
    } else if (!raw.startsWith('{') && state.playwrightRuns.length > 0 && basename(raw) === basename(pw.reportFile)) {
      return {
        error: `"${value.slice(0, 120)}": ten plik jest nadpisywany przez każdy przebieg - podaj raport zwrócony przez run_playwright (reportPath albo run:<n>)`,
      };
    }
    if (!raw.startsWith('{')) {
      try {
        // Ścieżka systemu plików podana przez model: absolutna zostaje, relatywna
        // dokleja się do repo testów. Na Windowsie 'C:\raport.json' jest absolutna,
        // choć nie zaczyna się od '/'.
        const abs = isAbsolute(raw) || WINDOWS_DRIVE_PREFIX.test(raw);
        raw = await readFile(abs ? raw : join(cwd, raw), 'utf8');
      } catch {
        return { error: `nie mogę odczytać pliku raportu "${value.slice(0, 120)}"` };
      }
    }
    try {
      JSON.parse(raw);
    } catch {
      return { error: `raport nie jest poprawnym JSON-em (użyj --reporter=json): "${value.slice(0, 120)}"` };
    }
    return { json: raw };
  }

  const recordProofMaterial = tool(
    'record_proof_material',
    'Przekaż surowiec dowodu mutacyjnego: dwa zielone raporty playwright i czerwony - jako reportPath/run:<n> z run_playwright (albo pełną treść JSON) - oraz opis+diff mutacji z warunkiem, który psuje. Werdykt wyda pipeline - nie Ty.',
    {
      greenRunReport1: z.string().min(2).describe('reportPath albo run:<n> z run_playwright (lub treść JSON)'),
      greenRunReport2: z.string().min(2).describe('reportPath albo run:<n> z run_playwright (lub treść JSON)'),
      proofTest: z
        .string()
        .min(1)
        .optional()
        .describe(
          'Test, na którym opiera się dowód: "plik::tytuł" albo fragment tytułu wskazujący JEDEN test. Pominięcie = pipeline weźmie pierwszy przechodzący test specu.',
        ),
      mutationDescription: z.string().min(1),
      mutationDiff: z.string().min(1),
      targetCondition: z.string().min(1),
      redRunReport: z.string().min(2).describe('reportPath albo run:<n> z run_playwright (lub treść JSON)'),
    },
    async (input) => {
      const [g1, g2, red] = await Promise.all([
        resolveReport(input.greenRunReport1),
        resolveReport(input.greenRunReport2),
        resolveReport(input.redRunReport),
      ]);
      const errors = [g1, g2, red].flatMap((r) => ('error' in r ? [r.error] : []));
      if (errors.length > 0 || !('json' in g1) || !('json' in g2) || !('json' in red)) {
        return text(`BŁĄD: ${errors.join('; ')}. Popraw i wywołaj ponownie.`);
      }

      // Zasięg mutacji sprawdzamy TUTAJ, bo tylko tu mamy dysk: każdy plik
      // z diffa musi istnieć w repo testów. Walidator (funkcja czysta) widzi
      // same ścieżki, więc złapie tylko `/abs` i `..` - a mutacja kodu
      // APLIKACJI to jedyny sposób przepchnięcia fałszywego dowodu bez
      // łamania protokołu: test czerwieni się własną asercją, aplikacja wraca
      // do normy, a `git diff` repo testów przez cały czas jest pusty.
      const declared = mutationPaths(input.mutationDiff);
      if (declared.length === 0) {
        return text(
          'BŁĄD: diff mutacji nie zawiera nagłówków plików - musi mieć `diff --git a/… b/…` ' +
            'albo parę `--- a/…` / `+++ b/…`, bo bez nich nie da się sprawdzić, czy mutacja ' +
            'została w repo testów. Podaj pełny unified diff z nagłówkami i wywołaj ponownie.',
        );
      }
      const foreign: string[] = [];
      for (const p of declared) {
        const abs = resolve(cwd, p);
        if (!abs.startsWith(resolve(cwd) + sep)) {
          foreign.push(`${p} (poza repo testów)`);
          continue;
        }
        if (!existsSync(abs)) foreign.push(`${p} (brak takiego pliku w repo testów)`);
      }
      if (foreign.length > 0) {
        return text(
          `BŁĄD: mutacja musi dotyczyć plików repo testów (spec/POM/fixture), a diff wskazuje: ${foreign.join('; ')}. ` +
            'Psucie kodu aplikacji nie jest dowodem - po przywróceniu nie zostawia śladu w repo testów. ' +
            'Popraw mutację i wywołaj ponownie.',
        );
      }
      // Deklarację testu dowodowego weryfikujemy od razu: lepiej oddać agentowi
      // konkretny błąd teraz, niż unieważnić cały dowód po sesji.
      if (input.proofTest !== undefined) {
        const passing = parseRunSummaries(g1.json).filter((r) => r.status === 'passed');
        const hit = passing.filter(
          (r) => r.testId === input.proofTest || r.testId.includes(input.proofTest as string),
        );
        if (hit.length === 0) {
          return text(
            `BŁĄD: proofTest "${input.proofTest}" nie występuje jako przechodzący w pierwszym zielonym raporcie. ` +
              `Dostępne: ${passing.map((r) => r.testId).join(' | ')}. Popraw i wywołaj ponownie.`,
          );
        }
        if (hit.length > 1) {
          return text(
            `BŁĄD: proofTest "${input.proofTest}" pasuje do ${hit.length} testów (${hit
              .map((r) => r.testId)
              .join(' | ')}). Podaj pełny identyfikator plik::tytuł.`,
          );
        }
      }

      state.proofMaterial = {
        greenRunReports: [g1.json, g2.json],
        mutation: {
          description: input.mutationDescription,
          diff: input.mutationDiff,
          targetCondition: input.targetCondition,
        },
        redRunReport: red.json,
        ...(input.proofTest !== undefined ? { proofTest: input.proofTest } : {}),
      };
      // Narzędzie `finish` MUSI być tu nazwane wprost. Bez niego `declaredStatus`
      // zostaje pusty i krok autora klasyfikuje próbę jako attempt_failed - nawet
      // gdy dowód jest komplet. Regresja z retry employee-create-validation
      // (2026-08-17): qwen3.6-27b-mtp zrobił dwa zielone przebiegi, mutację,
      // czerwony przebieg, przywrócił plik i zacommitował, po czym wziął
      // „zakończ sesję" dosłownie i skończył turę bez `finish` - 9 minut pracy
      // i gotowy dowód do kosza. Ścieżki STOP niżej nazywają `finish` od zawsze;
      // ścieżka SUKCESU, jedyna prowadząca do `delivered`, jako jedyna nie.
      return text(
        'Surowiec dowodu zapisany. Teraz po kolei: (1) przywróć wersję sprzed mutacji (git diff musi być pusty), ' +
          '(2) zrób commit końcowy, (3) wywołaj mcp__greenproof__finish ze statusem "delivered", ' +
          'ścieżką specu w specPath i listą reusedPoms. Bez tego wywołania próba przepada jako nieudana, ' +
          'choćby dowód był kompletny. Dopiero po `finish` zakończ turę.',
      );
    },
  );

  const finish = tool(
    'finish',
    'Formalne zakończenie pracy nad casem - wywołaj dokładnie raz, tuż przed końcem sesji.',
    {
      status: z.enum(['delivered', 'blocked', 'failed']),
      specPath: z.string().optional(),
      notes: z.string().optional(),
      reusedPoms: z.array(z.string()).default([]),
      errors: z.array(z.string()).default([]),
    },
    async (input) => {
      state.finish = {
        status: input.status,
        ...(input.specPath !== undefined ? { specPath: input.specPath } : {}),
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
        reusedPoms: input.reusedPoms,
        errors: input.errors,
      };
      return text('Przyjęto. Zakończ turę.');
    },
  );

  return [
    markPhase,
    reportSeedAttempt,
    registerPom,
    registerUiTrap,
    runPlaywright,
    recordProofMaterial,
    finish,
  ];
}

export function createGreenproofServer(deps: ToolDeps) {
  return createSdkMcpServer({ name: 'greenproof', tools: createGreenproofTools(deps) });
}
