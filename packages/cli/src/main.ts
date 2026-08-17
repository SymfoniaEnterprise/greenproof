#!/usr/bin/env node
/**
 * Punkt wejścia binarki `greenproof`. Odpowiada wyłącznie za: parsowanie argv
 * (własny mini-parser, zero zależności), wczytanie configu, zbudowanie portów,
 * wywołanie komendy i serializację wyniku.
 *
 * KONTRAKT I/O: stdout = wyłącznie JSON wyniku, stderr = wyłącznie logi.
 */
import { access, readFile, mkdir, writeFile } from 'node:fs/promises';
import { constants, existsSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  buildRunFilterInput,
  cmdAccept,
  cmdAuthor,
  cmdClean,
  cmdDeliver,
  emptyRunOutput,
  cmdFilter,
  cmdInit,
  cmdKnowledge,
  cmdRelease,
  cmdFixture,
  cmdModels,
  cmdRetry,
  cmdRun,
  cmdStatus,
  cmdTriage,
  ensureTestsRepoScaffold,
} from './commands.js';
import type { CommandArgs } from './commands.js';
import { loadConfig, SUPPORTED_CONFIG_EXTENSIONS } from './config.js';
import type { LoadedConfig } from './config.js';
import {
  CliError,
  EXIT_OK,
  EXIT_VALIDATION,
  exitCodeFor,
  failureOutcome,
  isCommandName,
  isStepName,
  isZodError,
  STEP_COMMAND_MIGRATIONS,
  STEP_NAMES,
  successOutcome,
} from './exit-codes.js';
import type { CommandName, OutcomeCommand, StepName } from './exit-codes.js';
import { createStderrLogger, defaultPlatformDeps, envSecrets, resolvePlatform } from './platform.js';
import { applyDotenv } from './dotenv.js';
import { packageVersion } from './version.js';
import { createProgressRenderer } from './progress/index.js';
import type { RendererIo } from './progress/index.js';
import { FilterInputSchema, runPreflight } from '@greenproof/core';
import type { ProgressSink } from '@greenproof/core';

export interface ParsedArgs {
  command: string | undefined;
  /** Pozycyjne po komendzie (np. `knowledge init`). */
  positionals: string[];
  config: string | undefined;
  preset: string | undefined;
  testsRepo: string | undefined;
  author: string | undefined;
  baseUrl: string | undefined;
  tokenEnv: string | undefined;
  fixtureAuthor: string | undefined;
  appUrl: string | undefined;
  ref: string | undefined;
  run: string | undefined;
  in: string | undefined;
  out: string | undefined;
  initOnly: boolean;
  force: boolean;
  cases: boolean;
  noAutoAccept: boolean;
  help: boolean;
  version: boolean;
}

const VALUE_FLAGS = new Set([
  'config',
  'preset',
  'tests-repo',
  'author',
  'base-url',
  'token-env',
  'fixture-author',
  'app-url',
  'ref',
  'run',
  'in',
  'out',
]);

/** Flagi kebab-case → pola camelCase w ParsedArgs. */
const FLAG_PROPERTY: Record<string, string> = {
  'tests-repo': 'testsRepo',
  'base-url': 'baseUrl',
  'token-env': 'tokenEnv',
  'fixture-author': 'fixtureAuthor',
  'app-url': 'appUrl',
};

/** Mini-parser: `--flag value` oraz `--flag=value`. Nieznana flaga = błąd. */
export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    command: undefined,
    positionals: [],
    config: undefined,
    preset: undefined,
    testsRepo: undefined,
    author: undefined,
    baseUrl: undefined,
    tokenEnv: undefined,
    fixtureAuthor: undefined,
    appUrl: undefined,
    ref: undefined,
    run: undefined,
    in: undefined,
    out: undefined,
    initOnly: false,
    force: false,
    cases: false,
    noAutoAccept: false,
    help: false,
    version: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] as string;
    if (token === '--help' || token === '-h') {
      parsed.help = true;
      continue;
    }
    if (token === '--version' || token === '-v') {
      parsed.version = true;
      continue;
    }
    if (!token.startsWith('--')) {
      if (parsed.command === undefined) parsed.command = token;
      else parsed.positionals.push(token);
      continue;
    }
    if (token === '--init-only') {
      parsed.initOnly = true;
      continue;
    }
    if (token === '--force') {
      parsed.force = true;
      continue;
    }
    if (token === '--cases') {
      parsed.cases = true;
      continue;
    }
    if (token === '--no-auto-accept') {
      parsed.noAutoAccept = true;
      continue;
    }
    const eq = token.indexOf('=');
    const name = eq === -1 ? token.slice(2) : token.slice(2, eq);
    if (name === 'init-only') {
      throw new CliError('Flaga --init-only nie przyjmuje wartości.');
    }
    if (name === 'force') {
      throw new CliError('Flaga --force nie przyjmuje wartości.');
    }
    if (name === 'cases') {
      throw new CliError('Flaga --cases nie przyjmuje wartości.');
    }
    if (name === 'no-auto-accept') {
      throw new CliError('Flaga --no-auto-accept nie przyjmuje wartości.');
    }
    if (!VALUE_FLAGS.has(name)) {
      throw new CliError(`Nieznana flaga: --${name}. Użyj --help.`);
    }
    let value: string | undefined;
    if (eq === -1) {
      value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new CliError(`Flaga --${name} wymaga wartości.`);
      }
      i += 1;
    } else {
      value = token.slice(eq + 1);
    }
    if (value.length === 0) throw new CliError(`Flaga --${name} wymaga niepustej wartości.`);
    const propertyName = FLAG_PROPERTY[name] ?? name;
    (parsed as unknown as Record<string, string>)[propertyName] = value;
  }
  return parsed;
}

export function helpText(): string {
  return `gp - cienki CLI nad @greenproof/core (I/O przez pliki JSON).
\`greenproof\` pozostaje pełnym aliasem \`gp\` - obie nazwy są wymienne.

UŻYCIE
  gp <komenda> --config <ścieżka> [--run <runId>] [--in <in.json>] [--out <out.json>]
  gp run --tests-repo <ścieżka> --init-only [--preset codex-sub|litellm|claude-sub]
                 [--config <output.mjs>] [--author <model>] [--base-url <url>]
                 [--token-env <ENV>] [--fixture-author <model>|auto|none] [--force]
  gp run (--config <gotowy config> | --tests-repo <dir> [--preset …] [--author …])
                 --in <filter-input.json | plan> [--app-url <url>] [--out <result.json>]
  gp step filter|triage|author|deliver [--config <ścieżka>] [--in <in.json>] [--out <out.json>]
  gp knowledge init|lint --config <ścieżka>
  gp preflight --config <ścieżka>

KOMENDY
  step       Jeden krok pipeline'u jako osobny job (platformy/CI odpalają każdy
             krok osobno). Krok jest obowiązkowy:
               filter   Wybiera case'y E2E z planu i zakłada run.  (wejście: FilterInput | plan)
               triage   Składa kontekst startowy agenta.           (wejście: TriageInput)
               author   Odpala sesje agenta dla case'ów po triażu. (wejście: AuthorInput)
               deliver  Melduje drafty i blokady człowiekowi.      (wejście: DeliverInput | --run)
  run        CAŁY przebieg jedną komendą: preflight→filter→triage→fixture→author
             →deliver→auto-accept (case'y spełniające deterministyczne kryterium -
             dowód mutacyjny valid + czysty lint - pipeline akceptuje sam; \`release\`
             zostaje decyzją człowieka; \`--no-auto-accept\` wraca do starego
             zachowania). Config: gotowy plik (--config, np. configs/litellm.config.mjs)
             ALBO customizacja od zera (--tests-repo + flagi presetu - scaffold repo
             testów i config powstają same przy pierwszym uruchomieniu). Wejście: --in
             (FilterInput JSON ALBO plik planu - plan wymaga --app-url;
              opcjonalnie --ref).
             Tryb \`--init-only\`: sam scaffold i generowanie configu bez runu/preflightu.
  retry      Pętla ponowienia case'a: retry→triage→author→deliver. (wejście: RetryInput)
  accept     Otwiera PR z brancha case'a do gałęzi docelowej.(wejście: AcceptInput)
  release    Bramki jakości i domknięcie przebiegu.          (wejście: ReleaseInput)
  status     Zwraca stan przebiegu (tylko odczyt).           (wejście: StatusInput | --run)
             Z flagą --cases dokłada per-case rollup z ledgerów prób i sumy
             (dawna komenda stats).
  models     Lista modeli bramy z /v1/models (tylko odczyt).  (bez wejścia)
  knowledge  init: szablony wiedzy w katalogu z configu; lint: walidacja + duplikaty.
  fixture    fixture-author dla case'a blocked(fixture-gap): wąska sesja (opcjonalnie
             mocniejszym modelem z model.fixtureAuthor) dostarcza fixture seedu,
             pipeline odbiera go deterministycznie (skrypt weryfikacyjny musi wyjść 0)
             i cofa case do triaged - potem \`author --in {"runId":…,"caseIds":[…]}\`
             + \`deliver\` (case w triaged nie przyjmie retry). Exit 3 gdy się nie udało.
             Tryb prewencyjny (--in {"runId": ..., "mode": "preventive", "types": [...]}):
             jedna sesja na churn-prone TYP PRZED partią autora; fixture'y lądują na
             branchu greenproof/fixtures/<runId>, z którego wychodzą branche case'ów.
  clean      sprząta artefakty case'ów PO release (transcripty, kontekst triażu,
             extra-inventory; ledger/spec/proof zostają - usuwa je dopiero
             "purge": true w --in) ORAZ branche: author/<caseId> released
             case'ów, a gdy cały run terminalny - greenproof/fixtures/<runId>
             (purge dodaje bocznice fixtures-failed). Opcje w --in: caseIds,
             purge, dryRun, branches:false (zostaw branche).
             Wymaga ArtifactStore z delete (adapter-fs tak; GitHub - nie, exit 2);
             bez ScmPort.deleteBranch branche tylko odnotowane w branchNote.
  preflight  waliduje endpoint modelu z configu: ping /v1/messages + wymuszony tool-call
             (mostki subskrypcyjne typu CLIProxyAPI często gubią tool_use - patrz
             docs/model-bridges.md); exit 2 gdy endpoint niezdatny dla silnika autora.

FLAGI
  --config <p>  Plik konfiguracyjny: .json, .yaml/.yml, .mjs/.js/.cjs (export default).
                Pliki .ts NIE są obsługiwane - skompiluj je albo użyj .mjs.
                Bez --config CLI szuka greenproof.config.<ext> w cwd, potem w
                katalogu z GREENPROOF_TESTS_REPO.
  --init-only   Dla \`run\`: wykonuje tylko scaffold repo testów i generowanie configu,
                po czym kończy z kodem 0 (bez preflightu, filtra i sesji).
  --preset <p>  Profil dla konfiguracji: codex-sub | litellm | claude-sub (domyślnie codex-sub).
                codex-sub: CLIProxyAPI :8317 (subskrypcja przez mostek OAuth), luna(max)+sol(high)
                litellm: brama LiteLLM :4000, model z bramy + eskalacja claude-sonnet-5
                claude-sub: Claude (subskrypcja z HOME albo API), claude-opus-5
  --tests-repo <p> Repozytorium git testów. Cel konfiguracji lub kotwica do
                <p>/greenproof.config.mjs. Z jawnym --config ustawia GREENPROOF_TESTS_REPO.
  --author <m>  Nadpisuje model autora z presetu.
  --base-url <u>   Nadpisuje endpoint autora (brama/mostek).
  --token-env <E>  Nadpisuje nazwę zmiennej env z tokenem autora.
  --fixture-author <m>|auto|none  Model eskalacji fixture. 'auto' (lub brak flagi)
                pyta bramę o /v1/models i wybiera pierwszy dostępny model z rankingu
                presetu; 'none' wyłącza eskalację. Eskalacja dziedziczy endpoint i token autora.
  --app-url <u> run/filter: adres testowanej aplikacji (envUrl; też baseURL
                scaffoldu). Wymagane, gdy --in to plik planu (nie FilterInput).
  --ref <r>     run/filter: ref bazowy repo testów (domyślnie main).
  --in <p>      Wejście komendy: dla run/filter FilterInput JSON ALBO plik planu
                (wtedy razem z --app-url); dla reszty komend walidowany schematem.
  --out <p>     Zapisz JSON wyniku także do pliku (stdout dostaje go zawsze).
  --run <id>    Uzupełnia/nadpisuje runId w wejściu; dla status/deliver wystarcza sam --run.
  --force       Dla \`run --init-only\` zezwala na nadpisanie istniejącego configu.
  --cases       Dla \`status\`: dokłada per-case rollup z ledgerów (cases + totals).
  --no-auto-accept  Dla \`run\`: wyłącza automatyczną akceptację case'ów po deliver
                (stare zachowanie - człowiek klika \`accept\` per case).
  --help, -h    Ta pomoc.   --version, -v   Wersja pakietu.

ŚRODOWISKO
  GREENPROOF_DEBUG=1     Włącza logi debug (stderr).
  GREENPROOF_TESTS_REPO  Katalog repo testów - drugie miejsce autodetekcji configu
                         (greenproof.config.<ext>), gdy brak --config i --tests-repo.
  GREENPROOF_WORK_DIR    Katalog roboczy prób autora (przestrzeń runnera).
  GREENPROOF_PROGRESS    Widok postępu na stderr: auto (domyślnie: GitHub Actions
                         → github, terminal → tty-tablica, inaczej plain-linie),
                         tty | plain | github | json (NDJSON) | off.
  Sekrety czytane są z env po nazwach z configu (model.authTokenEnv itd.).
  Plik .env obok configu jest wczytywany automatycznie (istniejące env wygrywa)
  - wygodne lokalnie; NIE commituj .env do repo.

KODY WYJŚCIA
  0  OK
  1  błąd infrastruktury / nieznany (można ponowić)
  2  walidacja wejścia lub konfigu (ZodError, zły plik, nieznana komenda, brak runa)
  3  częściowy sukces - author/retry z co najmniej jednym case'em blocked/attempt_failed
  4  konflikt stanu (StateConflictError) - ponów krok
  5  release nie przeszedł bramek jakości (pass=false)
  10 filter nie wybrał żadnego case'a
`;
}

export interface RunOptions {
  /** Zapis stdout (podmieniany w testach). */
  stdout?: (text: string) => void;
  /** Zapis stderr (podmieniany w testach). */
  stderr?: (text: string) => void;
  /** Env dla wyboru renderera postępu (podmieniane w testach). */
  env?: Record<string, string | undefined>;
  /** Czy stderr to TTY - steruje auto-wyborem renderera (podmieniane w testach). */
  isTTY?: boolean;
}

/** Wykonuje komendę i zwraca kod wyjścia. Nigdy nie woła process.exit. */
export async function run(argv: string[], options: RunOptions = {}): Promise<number> {
  const stdout = options.stdout ?? ((text: string) => void process.stdout.write(text));
  const stderr = options.stderr ?? ((text: string) => void process.stderr.write(text));

  // Renderer postępu pisze na stderr; „uzbraja się" dopiero od pierwszego
  // eventu, żeby komendy bez postępu (status, help) nie rysowały pustej tablicy.
  const rendererIo: RendererIo = {
    write: stderr,
    env: options.env ?? process.env,
    isTTY: options.isTTY ?? process.stderr.isTTY === true,
    now: () => new Date(),
    columns: () => process.stderr.columns,
  };
  const renderer = createProgressRenderer(rendererIo);
  let progressActive = false;
  const progressSink: ProgressSink | undefined = renderer
    ? (event) => {
        progressActive = true;
        renderer.onEvent(event);
      }
    : undefined;
  // Logi loguera idą NAD widok postępu, gdy ten jest aktywny (tty odrysowuje tablicę).
  const logWrite =
    renderer === null
      ? stderr
      : (text: string) => {
          if (progressActive) renderer.printAbove(text.replace(/\n$/, ''));
          else stderr(text);
        };
  const logger = createStderrLogger(logWrite);

  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    return reportError(err, stderr);
  }

  if (args.version) {
    stdout(`${packageVersion()}\n`);
    return EXIT_OK;
  }
  if (args.help || args.command === undefined) {
    stdout(helpText());
    return args.command === undefined && !args.help ? EXIT_VALIDATION : EXIT_OK;
  }

  const command = args.command;
  try {
    const migrated = STEP_COMMAND_MIGRATIONS[command];
    if (migrated !== undefined) {
      throw new CliError(`Komenda \`${command}\` została przeniesiona: użyj \`gp ${migrated}\`.`);
    }
    if (!isCommandName(command)) {
      throw new CliError(`Nieznana komenda: ${command}. Użyj --help.`);
    }
    const output = await dispatch(command, args, logger, progressSink, (ctx) => {
      if (renderer?.hint === undefined) return;
      // Podpowiedź RYSUJE tablicę, więc od tego momentu logi muszą iść przez
      // printAbove - inaczej drukują się pod tablicą i rozjeżdżają odrysowanie
      // (duch starej tablicy zostaje na ekranie).
      progressActive = true;
      renderer.hint(ctx);
    });
    await emit(output, args.out, stdout);
    // Kody wyjścia kroków liczą się po nazwie KROKU (filter→10, author→3, …),
    // a nie po top-level `step` - dlatego successOutcome dostaje nazwę kroku.
    const outcomeCommand: OutcomeCommand =
      command === 'step' ? (args.positionals[0] as StepName) : command;
    return exitCodeFor(successOutcome(outcomeCommand, output));
  } catch (err) {
    return reportError(err, stderr);
  } finally {
    // Domknięcie widoku (finalna tablica / Job Summary) tylko gdy coś rysował.
    // Best-effort: renderer nigdy nie może zmienić kodu wyjścia komendy.
    if (renderer !== null && progressActive) {
      try {
        renderer.finalize();
      } catch {
        /* postęp jest best-effort */
      }
    }
  }
}

/** Komendy z emisją kamieni milowych `step` - status zostaje cichy (czysty odczyt). */
const STEP_EVENT_COMMANDS: ReadonlySet<CommandName> = new Set([
  'run',
  'step',
  'retry',
  'fixture',
  'accept',
  'release',
  'clean',
]);

/**
 * `step <krok>`: krok obowiązkowy i musi być jednym z dozwolonych. Zarówno
 * brak argumentu, jak i nieznany krok kończy się CliError (exit 2) z listą
 * dozwolonych kroków.
 */
function resolveStep(args: ParsedArgs): StepName {
  const step = args.positionals[0];
  if (step === undefined) {
    throw new CliError(
      `Komenda step wymaga kroku. Dozwolone: ${STEP_NAMES.join(' | ')}.`,
    );
  }
  if (args.positionals.length > 1) {
    throw new CliError(
      `Komenda step przyjmuje dokładnie jeden krok (dostałem: ${args.positionals.join(' ')}). Dozwolone: ${STEP_NAMES.join(' | ')}.`,
    );
  }
  if (!isStepName(step)) {
    throw new CliError(
      `Nieznany krok \`${step}\`. Dozwolone: ${STEP_NAMES.join(' | ')}.`,
    );
  }
  return step;
}

async function dispatch(
  command: CommandName,
  args: ParsedArgs,
  logger: ReturnType<typeof createStderrLogger>,
  progress?: ProgressSink,
  progressHint?: (ctx: { model?: string }) => void,
): Promise<unknown> {
  // `step` rozpakowuje krok do logicznej komendy - cała reszta dispatchu
  // (walidacja flag, wejście, config, kod wyjścia, postęp) zachowuje się
  // dokładnie tak, jak działała osobna komenda o tej nazwie.
  const effective: CommandName | StepName = command === 'step' ? resolveStep(args) : command;

  // --cases dokłada per-case rollup wyłącznie do statusu (dawna komenda stats).
  if (effective !== 'status' && args.cases) {
    throw new CliError(
      'Flaga --cases jest dostępna wyłącznie dla komendy status (użyj: gp status --cases).',
    );
  }

  // --no-auto-accept wyłącza auto-akceptację tylko w orkiestracji run.
  if (effective !== 'run' && args.noAutoAccept) {
    throw new CliError(
      'Flaga --no-auto-accept jest dostępna wyłącznie dla komendy run.',
    );
  }

  if (effective !== 'run' && args.initOnly) {
    throw new CliError('Flaga --init-only jest dostępna wyłącznie dla komendy run (użyj: gp run --tests-repo <p> --init-only).');
  }

  if (effective === 'run' && args.initOnly) {
    if (
      args.positionals.length > 0 ||
      args.run !== undefined ||
      args.in !== undefined ||
      args.out !== undefined ||
      args.appUrl !== undefined ||
      args.ref !== undefined
    ) {
      throw new CliError(
        'Tryb run --init-only obsługuje tylko --tests-repo, --config, --preset, --force oraz nadpisania --author/--base-url/--token-env/--fixture-author.',
      );
    }
    if (args.testsRepo === undefined && args.config === undefined) {
      throw new CliError('Tryb run --init-only wymaga flagi --tests-repo <ścieżka> (albo --config <ścieżka>).');
    }
    const repoDir = args.testsRepo !== undefined
      ? resolve(args.testsRepo)
      : args.config !== undefined
        ? dirname(resolve(args.config))
        : process.cwd();
    await ensureTestsRepoScaffold(repoDir, undefined, logger);
    return cmdInit({
      ...(args.preset !== undefined ? { preset: args.preset } : {}),
      ...(args.testsRepo !== undefined ? { testsRepo: args.testsRepo } : { testsRepo: repoDir }),
      ...(args.config !== undefined ? { config: args.config } : {}),
      ...(args.author !== undefined ? { author: args.author } : {}),
      ...(args.baseUrl !== undefined ? { baseUrl: args.baseUrl } : {}),
      ...(args.tokenEnv !== undefined ? { tokenEnv: args.tokenEnv } : {}),
      ...(args.fixtureAuthor !== undefined ? { fixtureAuthor: args.fixtureAuthor } : {}),
      ...(args.force ? { force: true } : {}),
      logger,
    });
  }

  if (
    args.preset !== undefined ||
    args.force ||
    args.author !== undefined ||
    args.baseUrl !== undefined ||
    args.tokenEnv !== undefined ||
    args.fixtureAuthor !== undefined
  ) {
    if (effective !== 'run') {
      throw new CliError(
        'Flagi --preset i nadpisania modeli (--author/--base-url/--token-env/--fixture-author) są dostępne wyłącznie dla komendy run.',
      );
    }
    if (args.force && !args.initOnly) {
      throw new CliError('Flaga --force jest dostępna wyłącznie dla komendy run z flagą --init-only.');
    }
  } else if (args.force && !args.initOnly) {
    throw new CliError('Flaga --force jest dostępna wyłącznie dla komendy run z flagą --init-only.');
  }
  // --app-url i --ref są wyłącznie dla run/filter (wejście z planu); pozostałe
  // komendy mają swoje wejście w --in.
  if (effective !== 'run' && effective !== 'filter' && (args.appUrl !== undefined || args.ref !== undefined)) {
    throw new CliError('Flagi --app-url i --ref są dostępne wyłącznie dla komend run oraz filter.');
  }

  // Fail-fast: braki wejścia run/filter wykrywamy PRZED preflightem I scaffoldem
  // configu (zero sieci i zero efektów ubocznych przy błędzie użytkownika).
  if (effective === 'run' || effective === 'filter') {
    if (args.in === undefined) {
      throw new CliError(
        effective === 'run'
          ? 'Komenda run potrzebuje wejścia: --in <filter-input.json | plik planu> (plan wymaga też --app-url <url>).'
          : 'Komenda filter potrzebuje wejścia: --in <filter-input.json | plik planu> (plan wymaga też --app-url <url>).',
      );
    }
    // Nieistniejący/nieczytelny --in sprawdzamy TUTAJ (przed scaffoldem repo
    // testów, initem i preflightem): literówka w ścieżce nie może kosztować
    // sieci ani mutacji stanu. Pełne parsowanie JSON zostaje w readRunFilterInput.
    const inputFile = resolve(args.in);
    try {
      await access(inputFile, constants.R_OK);
    } catch (err) {
      throw new CliError(`Nie mogę odczytać pliku wejściowego ${inputFile}: ${errMessage(err)}`, 2, {
        cause: err,
      });
    }
  }

  // Jawny --config wygrywa i całkowicie wyłącza autodetekcję. Bez niego config
  // rozpoznajemy: (1) --tests-repo jest kotwicą do <repo>/greenproof.config.mjs,
  // (2) w przeciwnym razie szukamy greenproof.config.<ext> w cwd, potem w
  // katalogu z GREENPROOF_TESTS_REPO.
  const explicitConfig = args.config;
  if (args.config === undefined) {
    args.config = await resolveConfigPath(effective, args, logger);
  }

  // --tests-repo RAZEM z jawnym configiem: konwencja GREENPROOF_TESTS_REPO -
  // configi referencyjne (configs/*.config.mjs) czytają tę zmienną, więc flaga
  // wskazuje repo testów bez edycji pliku. Jawna flaga wygrywa z env.
  if (explicitConfig !== undefined && args.testsRepo !== undefined) {
    process.env['GREENPROOF_TESTS_REPO'] = resolve(args.testsRepo);
  }
  const loaded = await loadConfig(args.config);
  // Sekrety z .env obok configu - PRZED preflight/knowledge/platformą,
  // bo wszystkie czytają tokeny z env. Istniejące zmienne wygrywają.
  await applyDotenv(loaded.dir, logger);
  // Model autora znany od razu z configu - tablica TTY nie czeka na case-start.
  // Tylko dla komend z postępem: status/preflight nie mają rysować tablicy.
  if (STEP_EVENT_COMMANDS.has(command)) progressHint?.({ model: loaded.config.model.author });

  // run: repo testów z configu może jeszcze nie istnieć (gotowe configi z
  // repo greenproof) - scaffold jest idempotentny i tani dla istniejących.
  // Ścieżka --tests-repo zascaffoldowała repo już w resolveConfigPath (init
  // wymaga .git), więc nie powtarzamy tego tutaj; jawny --config nadal tu
  // trafia, bo repo z gotowego configu może jeszcze nie istnieć.
  const scaffoldDoneInResolve = explicitConfig === undefined && args.testsRepo !== undefined;
  if (effective === 'run' && !scaffoldDoneInResolve) {
    await ensureTestsRepoScaffold(loaded.config.paths.testsRepoDir, args.appUrl, logger);
  }

  if (effective === 'preflight') {
    // Walidacja endpointu modelu (ping + tool-call) - bez portów platformy,
    // działa dla bramy, mostka subskrypcyjnego (np. CLIProxyAPI) i API wprost.
    return runPreflight(loaded.config, envSecrets);
  }

  if (effective === 'knowledge') {
    const action = args.positionals[0];
    if (action === undefined) {
      throw new CliError('Komenda knowledge wymaga podkomendy: `init` albo `lint`.');
    }
    return cmdKnowledge({ config: loaded.config, input: { action } });
  }

  // Jednokomendowy run wykonuje preflight przed pierwszą mutacją stanu.
  // Porty są nadal tworzone tylko raz i przekazywane wszystkim krokom.
  const runPreflightResult = effective === 'run'
    ? await runPreflight(loaded.config, envSecrets)
    : undefined;

  // Niezdatny endpoint jest błędem walidacji autora, nie błędem adaptera.
  // Nie inicjalizujemy platformy ani nie wykonujemy żadnej mutacji stanu, gdy
  // preflight już jasno zwrócił ok=false.
  if (effective === 'run' && runPreflightResult !== undefined && !runPreflightResult.ok) {
    return emptyRunOutput(runPreflightResult);
  }

  const deps = { ...defaultPlatformDeps(loaded.dir), logger };
  const basePorts = await resolvePlatform(loaded.config, deps);
  const ports = progress !== undefined ? { ...basePorts, progress } : basePorts;
  // run/filter: --in to FilterInput JSON ALBO plik planu (wtedy z --app-url);
  // pozostałe komendy czytają --in jak dotąd (JSON walidowany schematem).
  const input =
    effective === 'run' || effective === 'filter'
      ? await readRunFilterInput(args, loaded)
      : await readInput(args);
  const commandArgs: CommandArgs = {
    config: loaded.config,
    ports,
    input,
    baseDir: loaded.dir,
    ...(args.noAutoAccept ? { noAutoAccept: true } : {}),
  };

  // Kamienie milowe komend dla widoku postępu (core emituje drobniejsze zdarzenia).
  const runId =
    typeof input === 'object' && input !== null && 'runId' in input
      ? String((input as { runId?: unknown }).runId ?? '')
      : '';
  const emitStep = (phase: 'start' | 'end'): void => {
    if (progress === undefined || !STEP_EVENT_COMMANDS.has(command)) return;
    try {
      progress({ kind: 'step', runId, at: new Date().toISOString(), name: effective, phase });
    } catch {
      // postęp jest best-effort
    }
  };

  emitStep('start');
  try {
    return await dispatchCommand(effective, commandArgs, runPreflightResult, args.cases);
  } finally {
    emitStep('end');
  }
}

async function dispatchCommand(
  command: CommandName | StepName,
  commandArgs: CommandArgs,
  runPreflightResult?: Awaited<ReturnType<typeof runPreflight>>,
  cases = false,
): Promise<unknown> {
  switch (command) {
    case 'run':
      if (runPreflightResult === undefined) {
        throw new CliError('Brak wyniku preflight dla komendy run.');
      }
      return cmdRun(commandArgs, runPreflightResult);
    case 'filter':
      return cmdFilter(commandArgs);
    case 'triage':
      return cmdTriage(commandArgs);
    case 'author':
      return cmdAuthor(commandArgs);
    case 'deliver':
      return cmdDeliver(commandArgs);
    case 'retry':
      return cmdRetry(commandArgs);
    case 'accept':
      return cmdAccept(commandArgs);
    case 'release':
      return cmdRelease(commandArgs);
    case 'status':
      return cases ? cmdStatus(commandArgs, { cases: true }) : cmdStatus(commandArgs);
    case 'models':
      return cmdModels(commandArgs);
    case 'fixture':
      return cmdFixture(commandArgs);
    case 'clean':
      return cmdClean(commandArgs);
  }
}

/**
 * Rozpoznanie ścieżki configu, gdy NIE podano --config. Kolejność:
 * 1. `--tests-repo <p>` jest kotwicą do `<p>/greenproof.config.mjs`. Dla `run`
 *    brak pliku to dzisiejsze zachowanie (scaffold repo + init od zera); dla
 *    reszty komend brak pliku to błąd walidacji wskazujący oba wyjścia.
 * 2. Autodetekcja: `greenproof.config.<ext>` w cwd, potem w katalogu z
 *    `GREENPROOF_TESTS_REPO` (rozszerzenia i kolejność: SUPPORTED_CONFIG_EXTENSIONS).
 */
async function resolveConfigPath(
  command: CommandName | StepName,
  args: ParsedArgs,
  logger: ReturnType<typeof createStderrLogger>,
): Promise<string> {
  if (args.testsRepo !== undefined) {
    const repoDir = resolve(args.testsRepo);
    const cfgPath = join(repoDir, 'greenproof.config.mjs');
    if (command === 'run') {
      await ensureTestsRepoScaffold(repoDir, args.appUrl, logger);
      if (!existsSync(cfgPath)) {
        const made = await cmdInit({
          testsRepo: repoDir,
          config: cfgPath,
          ...(args.preset !== undefined ? { preset: args.preset } : {}),
          ...(args.author !== undefined ? { author: args.author } : {}),
          ...(args.baseUrl !== undefined ? { baseUrl: args.baseUrl } : {}),
          ...(args.tokenEnv !== undefined ? { tokenEnv: args.tokenEnv } : {}),
          ...(args.fixtureAuthor !== undefined ? { fixtureAuthor: args.fixtureAuthor } : {}),
          logger,
        });
        logger.info(`wygenerowano config ${made.path} (preset ${made.preset}, autor ${made.author})`);
      }
      logger.info(`config: ${cfgPath} (--tests-repo)`);
      return cfgPath;
    }
    if (existsSync(cfgPath)) {
      logger.info(`config: ${cfgPath} (--tests-repo)`);
      return cfgPath;
    }
    throw new CliError(
      `W repo testów ${repoDir} nie ma pliku greenproof.config.mjs. ` +
        `Wygeneruj go (gp run --tests-repo ${args.testsRepo} --init-only) ` +
        `albo wskaż gotowy config jawnie (--config <ścieżka>).`,
    );
  }

  const searchDirs: { dir: string; label: string }[] = [{ dir: process.cwd(), label: 'cwd' }];
  const envRepo = process.env['GREENPROOF_TESTS_REPO'];
  if (envRepo !== undefined && envRepo !== '') {
    searchDirs.push({ dir: resolve(envRepo), label: 'GREENPROOF_TESTS_REPO' });
  }
  const searched: string[] = [];
  for (const { dir, label } of searchDirs) {
    for (const ext of SUPPORTED_CONFIG_EXTENSIONS) {
      const candidate = join(dir, `greenproof.config${ext}`);
      searched.push(candidate);
      if (existsSync(candidate)) {
        logger.info(`config: ${candidate} (autodetekcja z ${label})`);
        return candidate;
      }
    }
  }
  throw new CliError(
    command === 'run'
      ? 'Komenda run potrzebuje --config <gotowy config> ALBO --tests-repo <katalog> ' +
        '(+ opcjonalnie --preset/--author/… - config powstanie sam). ' +
        `Nie znaleziono greenproof.config.<rozszerzenie> w: ${searched.join(', ')}.`
      : 'Brakuje wymaganej flagi --config <ścieżka do configu>. ' +
        `Nie znaleziono greenproof.config.<rozszerzenie> w: ${searched.join(', ')}.`,
  );
}

/** Wejście = JSON z --in (jeśli jest) + runId z --run (nadpisuje). */
async function readInput(args: ParsedArgs): Promise<unknown> {
  let input: unknown = {};
  if (args.in !== undefined) {
    const file = resolve(args.in);
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch (err) {
      throw new CliError(`Nie mogę odczytać pliku wejściowego ${file}: ${errMessage(err)}`, 2, {
        cause: err,
      });
    }
    try {
      input = JSON.parse(text);
    } catch (err) {
      throw new CliError(`Niepoprawny JSON w ${file}: ${errMessage(err)}`, 2, { cause: err });
    }
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      throw new CliError(`Wejście w ${file} musi być obiektem JSON.`);
    }
  }
  if (args.run !== undefined) {
    input = { ...(input as Record<string, unknown>), runId: args.run };
  }
  return input;
}

/**
 * Wejście run/filter z --in: najpierw próba `FilterInputSchema.parse` (gotowy
 * JSON), potem plik jako PLAN przez źródło z configu (`plan.source`, ścieżka
 * z `buildRunFilterInput`) - w tym wariancie wymagany --app-url. Gdy oba
 * parsowania padną, jeden błąd z obiema przyczynami.
 */
async function readRunFilterInput(
  args: ParsedArgs,
  loaded: LoadedConfig,
): Promise<Record<string, unknown>> {
  const file = resolve(args.in as string);
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    throw new CliError(`Nie mogę odczytać pliku wejściowego ${file}: ${errMessage(err)}`, 2, {
      cause: err,
    });
  }

  // Próba 1: gotowy FilterInput (JSON walidowany schematem).
  let filterInputError: string;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new CliError(`Wejście w ${file} musi być obiektem JSON.`);
    }
    const result = FilterInputSchema.parse(parsed);
    if (args.run !== undefined) return { ...result, runId: args.run };
    return result;
  } catch (err) {
    filterInputError = describeError(err);
  }

  // Próba 2: plik planu (przez plan.source) + --app-url.
  let planError: string;
  if (args.appUrl === undefined) {
    planError = 'brak --app-url <url> (wymagane, gdy --in to plik planu)';
  } else {
    try {
      const built = await buildRunFilterInput({
        plan: args.in as string,
        appUrl: args.appUrl,
        config: loaded.config,
        baseDir: loaded.dir,
        ...(args.ref !== undefined ? { ref: args.ref } : {}),
      });
      if (args.run !== undefined) return { ...built, runId: args.run };
      return built;
    } catch (err) {
      planError = describeError(err);
    }
  }

  throw new CliError(
    `Plik --in ${file} nie jest ani poprawnym FilterInput, ani planem:\n` +
      `  - jako FilterInput: ${filterInputError}\n` +
      `  - jako plan: ${planError}`,
  );
}

/** Czytelny opis błędu (ZodError → lista issue'ów, inaczej message). */
function describeError(err: unknown): string {
  if (isZodError(err)) {
    return err.issues.map((i) => `${i.path.map(String).join('.') || '(root)'}: ${i.message}`).join('; ');
  }
  return errMessage(err);
}

async function emit(
  output: unknown,
  out: string | undefined,
  stdout: (text: string) => void,
): Promise<void> {
  const json = `${JSON.stringify(output, null, 2)}\n`;
  if (out !== undefined) {
    const file = resolve(out);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, json, 'utf8');
  }
  stdout(json);
}

function reportError(err: unknown, stderr: (text: string) => void): number {
  const code = exitCodeFor(failureOutcome(err));
  if (isZodError(err)) {
    stderr(`greenproof error: walidacja nie przeszła (exit ${code}):\n`);
    for (const issue of err.issues) {
      stderr(`  - ${issue.path.map(String).join('.') || '(root)'}: ${issue.message}\n`);
    }
  } else {
    stderr(`greenproof error: ${errMessage(err)} (exit ${code})\n`);
  }
  if (process.env['GREENPROOF_DEBUG'] === '1' && err instanceof Error && err.stack) {
    stderr(`${err.stack}\n`);
  }
  return code;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/* Uruchomienie jako binarka (a nie import programowego API). */
const entry = process.argv[1];
if (entry !== undefined && safeFileUrl(entry) === import.meta.url) {
  void run(process.argv.slice(2)).then((code) => {
    // Kod wyjścia zamiast process.exit - stdout zdąży się opróżnić.
    process.exitCode = code;
  });
}

function safeFileUrl(path: string): string {
  try {
    return pathToFileURL(realpathSync(path)).href;
  } catch {
    return '';
  }
}
