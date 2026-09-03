/**
 * Implementacje komend - czyste funkcje nad (config, ports, input). Nie
 * dotykają argv/procesu/stdout: main.ts je woła i serializuje wynik.
 */
import { execFile } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import {
  AcceptInputSchema,
  AppMapSchema,
  AuthorInputSchema,
  CleanInputSchema,
  DeliverInputSchema,
  FilterInputSchema,
  FixtureInputSchema,
  runClean,
  runFixtureAuthor,
  runPreventiveFixtures,
  ReleaseInputSchema,
  RetryInputSchema,
  RunNotFoundError,
  StatusInputSchema,
  TriageInputSchema,
  UiTrapsSchema,
  runAccept,
  runAuthor,
  runAutoAccept,
  runDeliver,
  runFilter,
  runRelease,
  runRetry,
  runStats,
  runTriage,
  spawnArgv,
  summarizeRun,
} from '@greenproof/core';
import type {
  AcceptOutput,
  AuthorOutput,
  AuthorParams,
  AutoAcceptResult,
  CaseStats,
  CleanOutput,
  DeliverOutput,
  FilterOutput,
  FilterParams,
  GreenproofConfig,
  FixtureOutput,
  Logger,
  NormalizedPlan,
  PipelineState,
  PlanRef,
  Ports,
  PreflightResult,
  PreventiveFixtureResult,
  ReleaseOutput,
  ReleaseParams,
  RunRollup,
  StatsTotals,
  TriageOutput,
  TriageParams,
} from '@greenproof/core';
import { CliError } from './exit-codes.js';
import { envSecrets, resolvePlanSource } from './platform.js';
import { applyDotenv } from './dotenv.js';
import { packageVersion } from './version.js';

export interface CommandArgs {
  config: GreenproofConfig;
  ports: Ports;
  /** Surowy JSON wejścia (--in/--run), walidowany w komendzie. */
  input: unknown;
  /** Katalog configu - baza importów pluginów i ścieżek względnych. */
  baseDir: string;
  /** --no-auto-accept (tylko run): wyłącza auto-akceptację mimo configu. */
  noAutoAccept?: boolean;
}

/** Komendy wiedzy nie potrzebują portów platformy - działają na filesystemie. */
export type KnowledgeArgs = Pick<CommandArgs, 'config' | 'input'>;

/* --------------------------------------------------------------------- init */

export interface InitArgs {
  /** Gotowy profil (codex-sub | litellm | claude-sub). */
  preset?: string;
  testsRepo?: string;
  /** Docelowy plik konfiguracyjny. */
  config?: string;
  force?: boolean;
  /** Nadpisanie presetu (provider/model) bez edycji pliku. */
  author?: string;
  baseUrl?: string;
  tokenEnv?: string;
  /** Model eskalacji fixture: 'none' wyłącza, 'auto' (lub brak) wybiera z listy bramy. */
  fixtureAuthor?: string;
  /** Logger meldowania wyboru eskalacji w trybie auto. */
  logger: Logger;
}

export interface InitOutput {
  path: string;
  preset: string;
  testsRepoDir: string;
  author: string;
  baseUrl: string | null;
  tokenEnv: string;
  /** null = bez eskalacji fixture-author. */
  fixtureAuthor: string | null;
  /** Źródło wyboru modelu eskalacji. */
  fixtureAuthorSource: 'flag' | 'endpoint' | 'preset' | 'none';
}

interface PresetFixtureAuthor {
  model: string;
}

/**
 * Nazwa modelu autora w bramie LiteLLM jest INSTALACYJNA - każdy nazywa swoje
 * wpisy po swojemu, więc preset nie ma czego zgadywać. Zamiast wpisywać tu
 * alias z naszej bramy (i skazywać obcą instalację na „model not found"),
 * zostawiamy placeholder: `grp models` wypisze realne nazwy, a preflight
 * przerywa z konkretną instrukcją, gdy ktoś odpali run bez wypełnienia.
 * Presety subskrypcyjne placeholdera nie potrzebują - tam nazwy modeli
 * narzuca mostek i są takie same u wszystkich.
 */
export const MODEL_PLACEHOLDER = '<model-z-bramy>';

/** Czy nazwa modelu to niewypełniony placeholder (`<...>`)? */
export function isModelPlaceholder(model: string): boolean {
  return /^<.*>$/.test(model.trim());
}

interface InitPreset {
  /** Opis do helpa i komentarza wygenerowanego pliku. */
  label: string;
  baseUrl?: string;
  tokenEnv: string;
  author: string;
  /** Brak = bez eskalacji; bez baseUrl/tokenEnv = poświadczenia Claude z HOME. */
  fixtureAuthor?: PresetFixtureAuthor;
  /** Ranking modeli eskalacji (auto, po nazwie bazowej); brak = bez eskalacji. */
  fixtureAuthorPreference?: string[];
  /** Wpisy per bazowa nazwa modelu (bez sufiksu effortu). */
  priceTable: Record<string, { inPerMTok: number; outPerMTok: number; cacheReadPerMTok: number }>;
  fixtureSessionMaxCostUsd: number;
  /** Instrukcja sekretu do komentarza wygenerowanego pliku. */
  secretsNote: string;
}

/**
 * Presety = punkty startowe per provider; każde pole da się nadpisać flagą,
 * więc dowolna kombinacja nie wymaga ręcznej edycji pliku.
 */
const INIT_PRESETS: Record<string, InitPreset> = {
  'codex-sub': {
    label: 'CLIProxyAPI (subskrypcja przez mostek OAuth): gpt-5.6-luna(max) + eskalacja gpt-5.6-sol(high)',
    baseUrl: 'http://127.0.0.1:8317',
    tokenEnv: 'CLIPROXY_TOKEN',
    author: 'gpt-5.6-luna(max)',
    fixtureAuthor: { model: 'gpt-5.6-sol(high)' },
    fixtureAuthorPreference: ['gpt-5.6-sol(high)', 'gpt-5.6-luna(max)'],
    priceTable: {
      'gpt-5.6-luna': { inPerMTok: 0, outPerMTok: 0, cacheReadPerMTok: 0 },
      'gpt-5.6-sol': { inPerMTok: 0, outPerMTok: 0, cacheReadPerMTok: 0 },
    },
    fixtureSessionMaxCostUsd: 1,
    secretsNote: 'Ustaw CLIPROXY_TOKEN w środowisku procesu.',
  },
  litellm: {
    label:
      'Brama LiteLLM (127.0.0.1:4000): model autora WŁASNY (podaj --author, nazwy z `grp models`) + eskalacja claude-sonnet-5 (brama)',
    baseUrl: 'http://127.0.0.1:4000',
    tokenEnv: 'LITELLM_KEY',
    author: MODEL_PLACEHOLDER,
    // Eskalacja dziedziczy endpoint i token autora (ta sama brama).
    fixtureAuthor: { model: 'claude-sonnet-5' },
    // claude-sonnet-5 to udokumentowany domyślny; Opus tylko, gdy Sonneta nie ma.
    fixtureAuthorPreference: ['claude-sonnet-5', 'claude-opus-5', 'gpt-5.6-sol', 'deepseek-v4-pro'],
    priceTable: {
      // Zerowe stawki dla niewypełnionego placeholdera: capy $ nie gryzą, dopóki
      // użytkownik nie wpisze swojego modelu i jego cennika (zostają tury i czas).
      [MODEL_PLACEHOLDER]: { inPerMTok: 0, outPerMTok: 0, cacheReadPerMTok: 0 },
      // Eskalacja metered: estymata Sonnet, uzupełnij realne stawki.
      'claude-sonnet-5': { inPerMTok: 3, outPerMTok: 15, cacheReadPerMTok: 0.3 },
    },
    fixtureSessionMaxCostUsd: 2.5,
    secretsNote: 'Ustaw LITELLM_KEY (klucz wirtualny bramy) w środowisku procesu.',
  },
  'claude-sub': {
    label: 'Claude: subskrypcja z HOME (token nieustawiony) albo API (ANTHROPIC_AUTH_TOKEN); claude-opus-5, bez eskalacji fixture',
    tokenEnv: 'ANTHROPIC_AUTH_TOKEN',
    author: 'claude-opus-5',
    // Brak rankingu celowo: jedyny kandydat to model autora.
    priceTable: {},
    fixtureSessionMaxCostUsd: 2.5,
    secretsNote: 'Ustaw ANTHROPIC_AUTH_TOKEN w środowisku procesu.',
  },
};

/** Bazowa nazwa modelu (sufiks effortu w nawiasie odpada). */
function priceTableKey(model: string): string {
  return model.replace(/\([^)]*\)$/, '');
}

/** Bazowa nazwa modelu (bez sufiksu effortu). */
function baseModelName(model: string): string {
  return priceTableKey(model).trim();
}

interface FixtureAuthorResolution {
  model: PresetFixtureAuthor | undefined;
  source: InitOutput['fixtureAuthorSource'];
}

/**
 * Wybór modelu eskalacji. 'auto' (lub brak) pyta bramę o /v1/models i bierze
 * pierwszy dostępny z rankingu presetu; fallback na preset, a bez niego -
 * eskalacja wyłączona. Nie rzuca przez sieć (timeout + try/catch w listModels).
 */
async function resolveFixtureAuthor(opts: {
  fixtureAuthor: string | undefined;
  preset: InitPreset;
  baseUrl: string | undefined;
  tokenEnv: string;
  logger: Logger;
}): Promise<FixtureAuthorResolution> {
  const { fixtureAuthor, preset, baseUrl, tokenEnv, logger } = opts;

  if (fixtureAuthor === 'none') {
    return { model: undefined, source: 'none' };
  }
  if (fixtureAuthor !== undefined && fixtureAuthor !== 'auto') {
    return { model: { model: fixtureAuthor }, source: 'flag' };
  }

  const preference = preset.fixtureAuthorPreference ?? [];
  if (preference.length === 0) {
    // Preset bez rankingu: preset albo brak eskalacji.
    return preset.fixtureAuthor !== undefined
      ? { model: { model: preset.fixtureAuthor.model }, source: 'preset' }
      : { model: undefined, source: 'none' };
  }

  const token = envSecrets.get(tokenEnv);
  const listing = await listModels({ baseUrl, token, timeoutMs: MODELS_TIMEOUT_MS });
  if (listing.available) {
    const chosen = pickPreferred(preference, listing.models);
    if (chosen !== undefined) {
      logger.info(`fixture-author auto: ${chosen} (pierwszy pasujący z listy /v1/models: ${listing.endpoint})`);
      return { model: { model: chosen }, source: 'endpoint' };
    }
    if (preset.fixtureAuthor !== undefined) {
      logger.info(
        `fixture-author auto: ${preset.fixtureAuthor.model} (z presetu - żaden model z rankingu nie pasował do listy ${listing.endpoint})`,
      );
      return { model: { model: preset.fixtureAuthor.model }, source: 'preset' };
    }
    logger.info('fixture-author auto: eskalacja wyłączona - żaden model z rankingu nie pasował do listy.');
    return { model: undefined, source: 'none' };
  }

  // Lista niedostępna (timeout/404/brak sieci) - fallback na preset.
  if (preset.fixtureAuthor !== undefined) {
    logger.info(
      `fixture-author auto: ${preset.fixtureAuthor.model} (z presetu - lista modeli niedostępna: ${listing.note ?? 'brak'})`,
    );
    return { model: { model: preset.fixtureAuthor.model }, source: 'preset' };
  }
  logger.info(
    `fixture-author auto: eskalacja wyłączona - lista modeli niedostępna (${listing.note ?? 'brak'}).`,
  );
  return { model: undefined, source: 'none' };
}

/**
 * Pierwszy model z rankingu o nazwie bazowej obecnej na liście bramy
 * (case-insensitive). Zwraca wpis rankingu (z sufiksem), nie id z bramy.
 */
function pickPreferred(preference: string[], available: string[]): string | undefined {
  const availableBase = new Set(available.map((m) => baseModelName(m).toLowerCase()));
  for (const preferred of preference) {
    if (availableBase.has(baseModelName(preferred).toLowerCase())) return preferred;
  }
  return undefined;
}

/**
 * Tworzy samodzielną konfigurację z presetu. Zapisuje tylko ścieżki i nazwy
 * zmiennych env (nigdy sekretów); repo testów rozwiązywane tutaj, żeby config
 * był przenośny między katalogiem configu a repo testów.
 */
export async function cmdInit(args: InitArgs): Promise<InitOutput> {
  const presetName = args.preset ?? 'codex-sub';
  const preset = INIT_PRESETS[presetName];
  if (preset === undefined) {
    throw new CliError(
      `Nieznany preset '${presetName}'. Dostępne: ${Object.keys(INIT_PRESETS).join(', ')} - każdy do nadpisania flagami --author/--base-url/--token-env/--fixture-author.`,
    );
  }
  if (args.testsRepo === undefined || args.testsRepo.length === 0) {
    throw new CliError('Komenda init wymaga flagi --tests-repo <ścieżka>.');
  }

  const author = args.author ?? preset.author;
  const baseUrl = args.baseUrl ?? preset.baseUrl;
  const tokenEnv = args.tokenEnv ?? preset.tokenEnv;

  // Zerowy wpis dla nadpisanego modelu: 0 = miękkie capy, realne stawki uzupełnia użytkownik.
  const priceTable: InitPreset['priceTable'] = { ...preset.priceTable };
  priceTable[priceTableKey(author)] ??= { inPerMTok: 0, outPerMTok: 0, cacheReadPerMTok: 0 };

  const testsRepoDir = resolve(args.testsRepo);
  try {
    if (!statSync(testsRepoDir).isDirectory()) {
      throw new CliError(`--tests-repo nie wskazuje katalogu: ${testsRepoDir}`);
    }
  } catch (err) {
    if (err instanceof CliError) throw err;
    throw new CliError(`Nie znaleziono katalogu --tests-repo: ${testsRepoDir}`);
  }
  if (!existsSync(join(testsRepoDir, '.git'))) {
    throw new CliError(
      `--tests-repo nie jest repozytorium git (brak .git): ${testsRepoDir}\n` +
        '  --tests-repo to osobne repozytorium TESTÓW (specy playwright, POM-y) - tam autor\n' +
        '  commituje pracę na branchach author/<caseId>. To NIE katalog testowanej aplikacji\n' +
        '  (aplikację wskazuje envUrl w wejściu filtra) ani podkatalog innego repo.\n' +
        '  Załóż je jedną komendą:  mkdir moje-testy && git -C moje-testy init',
    );
  }

  const path = resolve(args.config ?? join(testsRepoDir, 'greenproof.config.mjs'));
  const force = args.force === true;
  let newConfigFile: Awaited<ReturnType<typeof open>> | undefined;
  if (!force) {
    await mkdir(dirname(path), { recursive: true });
    try {
      newConfigFile = await open(path, 'wx');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new CliError(`Plik configu już istnieje: ${path} - użyj --force, aby go nadpisać.`);
      }
      throw err;
    }
  }

  // dispatch woła cmdInit zanim applyDotenv; wczytujemy .env z katalogu configu,
  // żeby tryb auto widział token. Istniejące env nadal wygrywają.
  await applyDotenv(dirname(path), args.logger);

  const fixture = await resolveFixtureAuthor({
    fixtureAuthor: args.fixtureAuthor,
    preset,
    baseUrl,
    tokenEnv,
    logger: args.logger,
  });
  const fixtureAuthor = fixture.model;
  const fixtureAuthorSource = fixture.source;

  // Zerowy wpis też dla modelu eskalacji spoza presetu - bez niego sesja
  // liczona $0, capy by nie gryzły. Ta sama konwencja co przy autorze.
  if (fixtureAuthor !== undefined) {
    priceTable[priceTableKey(fixtureAuthor.model)] ??= { inPerMTok: 0, outPerMTok: 0, cacheReadPerMTok: 0 };
  }

  await mkdir(dirname(path), { recursive: true });
  const source = configSource({
    presetName,
    label: preset.label,
    secretsNote: preset.secretsNote,
    testsRepoDir,
    author,
    ...(baseUrl !== undefined ? { baseUrl } : {}),
    tokenEnv,
    ...(fixtureAuthor !== undefined ? { fixtureAuthor } : {}),
    priceTable,
    fixtureSessionMaxCostUsd: preset.fixtureSessionMaxCostUsd,
  });
  try {
    if (force) {
      await writeFile(path, source, 'utf8');
    } else {
      await newConfigFile?.writeFile(source, 'utf8');
    }
  } finally {
    await newConfigFile?.close();
  }

  return {
    path,
    preset: presetName,
    testsRepoDir,
    author,
    baseUrl: baseUrl ?? null,
    tokenEnv,
    fixtureAuthor: fixtureAuthor?.model ?? null,
    fixtureAuthorSource,
  };
}

interface ConfigSourceInput {
  presetName: string;
  label: string;
  secretsNote: string;
  testsRepoDir: string;
  author: string;
  baseUrl?: string;
  tokenEnv: string;
  fixtureAuthor?: PresetFixtureAuthor;
  priceTable: InitPreset['priceTable'];
  fixtureSessionMaxCostUsd: number;
}

function configSource(input: ConfigSourceInput): string {
  const repo = JSON.stringify(input.testsRepoDir);
  const j = (v: unknown): string => JSON.stringify(v);

  const fixtureLines =
    input.fixtureAuthor === undefined
      ? ''
      : [
          `    // Eskalacja dziedziczy endpoint i token autora (inny provider:`,
          `    // dopisz baseUrl/authTokenEnv w tym obiekcie).`,
          `    fixtureAuthor: { model: ${j(input.fixtureAuthor.model)} },`,
        ].join('\n') + '\n';

  const priceLines = Object.entries(input.priceTable)
    .map(
      ([name, p]) =>
        `      ${j(name)}: { inPerMTok: ${p.inPerMTok}, outPerMTok: ${p.outPerMTok}, cacheReadPerMTok: ${p.cacheReadPerMTok} },`,
    )
    .join('\n');

  return `// Wygenerowano przez: greenproof init --preset ${input.presetName}
// Profil: ${input.label}
// Sekretów nie ma w tym pliku. ${input.secretsNote}
import { homedir } from 'node:os';
import { join } from 'node:path';

const testsRepoDir = ${repo};
// Dane aplikacji: %LOCALAPPDATA% na Windowsie, XDG (POSIX) poza nim.
const dataHomeDir =
  process.platform === 'win32'
    ? process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local')
    : process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share');
const baseDir = join(
  dataHomeDir,
  'greenproof',
  'manual-${input.presetName}',
  'platform',
);

export default {
  platform: '@greenproof/adapter-fs',
  platformOptions: { repoDir: testsRepoDir, baseDir },
  plan: { source: 'json' },
  model: {
${input.baseUrl !== undefined ? `    baseUrl: ${j(input.baseUrl)},\n` : ''}    authTokenEnv: ${j(input.tokenEnv)},
    author: ${j(input.author)},
${fixtureLines}    // Stawki 0 = capy kosztowe nie gryzą (zostają tury/czas) - uzupełnij
    // realne USD/MTok, jeśli chcesz twardego budżetu $.
    priceTable: {
${priceLines}
    },
  },
  caps: {
    maxTurns: 400,
    maxTimeMinutes: 30,
    maxCostUsd: 8,
    maxPlaywrightRuns: 12,
    proofRuns: 4,
    maxAutoRetries: 1,
    firstTurnTimeoutMinutes: 5,
    maxInfraRetries: 2,
    snapshotMaxChars: 30_000,
    snapshotGating: 'enforce',
    enforceRunPlaywrightTool: true,
    seedFuse: {
      churnProneTypes: ['payroll'],
      learn: 'propose',
      maxFailedStrategies: 3,
      maxArrangeTurns: 40,
      learnedEntryTtlRuns: 10,
    },
    fixtureSession: { maxTurns: 80, maxTimeMinutes: 30, maxCostUsd: ${input.fixtureSessionMaxCostUsd} },
  },
  qualityGates: { P0: 1, P1: 0.95, P2: 0.9, P3: 0.9 },
  batching: {
    timeoutBaseMin: 20,
    timeoutPerCaseMin: 25,
    timeoutCapMin: 340,
    splitWarnAt: 12,
  },
  playwright: {
    command: ['npx', 'playwright', 'test'],
    runTimeoutMinutes: 5,
    reportFile: 'pw-report.json',
    reportEnvVar: 'PLAYWRIGHT_JSON_OUTPUT_NAME',
  },
  paths: {
    testsRepoDir,
    pomDir: 'tests/support/pom',
    fixturesDir: 'tests/support/fixtures',
    pomIndex: 'tests/support/pom-index.json',
    specsDir: 'tests/e2e',
  },
};
`;
}

/* ------------------------------------------ run: pierwszy raz jedną komendą */

const execFileP = promisify(execFile);

/**
 * Scaffold repo testów, żeby `run --tests-repo` działał na pustym katalogu:
 * git init, package.json (@playwright/test), playwright.config.ts, struktura,
 * pusty indeks POM. Istniejące repo nietknięte. GREENPROOF_SKIP_INSTALL=1
 * pomija npm install (testy).
 */
export async function ensureTestsRepoScaffold(
  dir: string,
  appUrl: string | undefined,
  logger: Ports['logger'],
): Promise<void> {
  await mkdir(dir, { recursive: true });
  const git = (...a: string[]) =>
    execFileP('git', ['-C', dir, '-c', 'user.name=greenproof', '-c', 'user.email=greenproof@localhost', ...a]);
  if (!existsSync(join(dir, '.git'))) {
    await git('init', '-b', 'main');
    logger.info(`zainicjalizowano repozytorium git testów: ${dir}`);
  }
  if (existsSync(join(dir, 'package.json'))) return;

  logger.info(`scaffold repo testów w ${dir} (playwright + struktura katalogów)`);
  for (const d of ['tests/e2e', 'tests/support/pom', 'tests/support/fixtures']) {
    await mkdir(join(dir, d), { recursive: true });
  }
  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify(
      {
        name: 'greenproof-tests',
        private: true,
        type: 'module',
        devDependencies: { '@playwright/test': '^1.55.0' },
      },
      null,
      2,
    ) + '\n',
  );
  await writeFile(
    join(dir, 'playwright.config.ts'),
    [
      "import { defineConfig } from '@playwright/test';",
      'export default defineConfig({',
      "  testDir: 'tests/e2e',",
      '  timeout: 60_000,',
      '  retries: 0,',
      "  reporter: [['json', { outputFile: 'pw-report.json' }], ['line']],",
      `  use: { baseURL: '${appUrl ?? 'http://localhost:3000'}', headless: true },`,
      '});',
      '',
    ].join('\n'),
  );
  await writeFile(
    join(dir, 'tests/support/pom-index.json'),
    JSON.stringify({ version: 1, entries: [] }, null, 2) + '\n',
  );
  // state/artifacts/reports/prs to katalogi adaptera fs, gdy baseDir wskazuje
  // repo testów (domyślnie przy `run --tests-repo`). Bez nich w .gitignore
  // `git add -A` wciągałby stan przebiegu na branche autora.
  await writeFile(
    join(dir, '.gitignore'),
    'node_modules/\npw-report.json\ntest-results/\n.greenproof-runs/\n.env\nstate/\nartifacts/\nreports/\nprs/\n',
  );
  if (process.env['GREENPROOF_SKIP_INSTALL'] !== '1') {
    logger.info('npm install @playwright/test (chwilę potrwa)…');
    const npm = spawnArgv('npm', ['install', '--no-fund', '--no-audit']);
    await execFileP(npm.command, npm.args, { cwd: dir, ...npm.options });
  }
  await git('add', '-A');
  await git('commit', '-m', 'scaffold repo testów greenproof');
}

/**
 * Wejście filtra z pliku planu + --app-url (bez ręcznego JSON-a). Wymaga planu
 * ze slugiem; plany z parsera przechodzą tą samą ścieżką (plan.source).
 */
export async function buildRunFilterInput(opts: {
  plan: string;
  appUrl: string;
  ref?: string;
  config: GreenproofConfig;
  baseDir: string;
}): Promise<Record<string, unknown>> {
  // Ta sama ścieżka co cmdFilter (PlanSource z configu), więc slug wiarygodny
  // dla obu formatów.
  const plan = await resolvePlan({ config: opts.config, baseDir: opts.baseDir }, { path: opts.plan });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
  return {
    slug: plan.slug,
    envUrl: opts.appUrl,
    ref: opts.ref ?? 'main',
    runRef: `manual-${stamp}`,
    plan: { path: opts.plan },
  };
}

/* ------------------------------------------------------------------ filter */

export async function cmdFilter(args: CommandArgs): Promise<FilterOutput> {
  const input = FilterInputSchema.parse(args.input);
  const plan = await resolvePlan(args, input.plan);
  const params: FilterParams = {
    envUrl: input.envUrl,
    ref: input.ref,
    runRef: input.runRef,
    plan,
    ...(input.runId !== undefined ? { runId: input.runId } : {}),
  };
  const result = await runFilter(args.ports, args.config, params);
  // Slug należy do planu; rozjazd z wejściem to warning, nie błąd.
  const warnings =
    plan.slug === input.slug
      ? result.warnings
      : [
          ...result.warnings,
          `Slug planu ('${plan.slug}') różni się od slug z wejścia ('${input.slug}') - użyto slug z planu.`,
        ];
  // Ostrzeżenia też na stderr - użytkownik nie ma grzebać w JSON-ie.
  for (const w of warnings) args.ports.logger.warn(w);
  return { ...result, warnings };
}

/* --------------------------------------------------------------------- run */

export interface RunFixtureEscalation {
  caseId: string;
  /** Wynik wąskiej sesji fixture-authora (także porażka). */
  fixture: unknown;
  /** Wynik ponownej sesji autora; null, gdy fixture nie został dostarczony. */
  retryAuthor: AuthorOutput | null;
}

/**
 * Jednokomendowa orkiestracja lokalnego przebiegu. Kroki wołane bezpośrednio
 * nad tym samym zestawem portów (wspólny adapter/stan/logger/WORK_DIR) - bez
 * ukrytego spawnowania CLI.
 */
export interface RunOutput {
  runId: string | null;
  preflight: PreflightResult;
  filter: FilterOutput | null;
  triage: TriageOutput | null;
  preventiveFixture: (PreventiveFixtureResult & { error?: string }) | null;
  initialAuthor: AuthorOutput | null;
  fixtureEscalations: RunFixtureEscalation[];
  deliver: DeliverOutput | null;
  /**
   * Wynik auto-akceptacji; null, gdy wyłączona (--no-auto-accept albo
   * gates.autoAccept=false).
   */
  autoAccept: AutoAcceptResult | null;
  /** Końcowy odczyt stanu przez istniejące cmdStatus. */
  status: StatusOutput | null;
}

export function emptyRunOutput(preflight: PreflightResult): RunOutput {
  return {
    runId: null,
    preflight,
    filter: null,
    triage: null,
    preventiveFixture: null,
    initialAuthor: null,
    fixtureEscalations: [],
    deliver: null,
    autoAccept: null,
    status: null,
  };
}

export async function cmdRun(args: CommandArgs, preflight: PreflightResult): Promise<RunOutput> {
  const empty = emptyRunOutput(preflight);
  // Preflight to bramka autora: bez niego nie zakładamy runa ani nie mutujemy repo.
  if (!preflight.ok) return empty;

  const filter = await cmdFilter(args);
  const runId = filter.runId;
  const output: RunOutput = { ...empty, runId, filter };

  // Auto-akceptacja: gates.autoAccept (domyślnie true) wyłączalna flagą
  // --no-auto-accept. Stan liczony raz, przekazywany do delivera i autoAccept.
  const autoAccept = args.config.gates.autoAccept !== false && args.noAutoAccept !== true;

  // Status po filtrze: stabilny kształt także dla pustego wyboru.
  output.status = await cmdStatus({ ...args, input: { runId } });
  if (filter.selected.length === 0) return output;

  output.triage = await cmdTriage({ ...args, input: { runId } });

  // Prewencja przed partią autora; porażka nie blokuje zwykłego autora.
  if (args.config.model.fixtureAuthor !== undefined) {
    try {
      output.preventiveFixture = (await cmdFixture({
        ...args,
        input: { runId, mode: 'preventive' },
      })) as PreventiveFixtureResult;
    } catch (err) {
      args.ports.logger.warn(`Prewencyjny fixture-author nie powiódł się - kontynuuję partię`, err);
      output.preventiveFixture = {
        types: [],
        costUsd: 0,
        turns: 0,
        ok: false,
        error: String(err),
      };
    }
  }

  output.initialAuthor = await cmdAuthor({ ...args, input: { runId } });
  output.deliver = await cmdDeliver({ ...args, input: { runId } }, { autoAccept });

  // Fixture-gap to jedyne automatyczne wejście w eskalację; udany fixture daje
  // dokładnie jedną dodatkową próbę autora.
  for (const result of output.initialAuthor.results) {
    if (result.status !== 'blocked' || result.blockedReason !== 'fixture-gap') continue;

    let fixture: unknown;
    try {
      fixture = await cmdFixture({ ...args, input: { runId, caseId: result.caseId } });
    } catch (err) {
      fixture = {
        ok: false,
        caseId: result.caseId,
        error: String(err),
        costUsd: 0,
        turns: 0,
      };
      args.ports.logger.warn(`Fixture-author ${result.caseId} nie powiódł się`, err);
    }

    let retryAuthor: AuthorOutput | null = null;
    const fixtureOutput = fixture as Partial<FixtureOutput> | null;
    if (fixtureOutput?.ok === true && fixtureOutput.fixture !== undefined) {
      retryAuthor = await cmdAuthor({
        ...args,
        input: { runId, caseIds: [result.caseId] },
      });
      output.deliver = await cmdDeliver({ ...args, input: { runId } }, { autoAccept });
    }
    output.fixtureEscalations.push({ caseId: result.caseId, fixture, retryAuthor });
  }

  // Auto-akceptacja po ostatnim deliver: przyjmuje case'y z dowodem valid +
  // czystym lintem, reszta człowiekowi. Wyłączona → null.
  if (autoAccept) {
    output.autoAccept = await runAutoAccept(args.ports, args.config, { runId });
  }

  output.status = await cmdStatus({ ...args, input: { runId } });
  return output;
}

async function resolvePlan(
  ctx: { config: GreenproofConfig; baseDir: string },
  ref: PlanRef,
): Promise<NormalizedPlan> {
  if (!('path' in ref)) return ref;
  const file = resolvePlanPath(ctx.config, ref.path);
  const content = await readFile(file, 'utf8');
  const source = await resolvePlanSource(ctx.config, ctx.baseDir);
  return source.parse(content, { path: file });
}

function resolvePlanPath(config: GreenproofConfig, path: string): string {
  if (isAbsolute(path)) {
    if (!existsSync(path)) throw new CliError(`Nie znaleziono pliku planu: ${path}`);
    return path;
  }
  const candidates = [resolve(process.cwd(), path), resolve(config.paths.testsRepoDir, path)];
  const found = candidates.find((c) => existsSync(c));
  if (!found) {
    throw new CliError(`Nie znaleziono pliku planu '${path}' - sprawdzone: ${candidates.join(', ')}`);
  }
  return found;
}

/* ------------------------------------------------------------------ triage */

export async function cmdTriage(args: CommandArgs): Promise<TriageOutput> {
  const input = TriageInputSchema.parse(args.input);
  return runTriage(args.ports, args.config, triageParams(input));
}

function triageParams(input: { runId: string; caseId?: string }): TriageParams {
  return { runId: input.runId, ...(input.caseId !== undefined ? { caseId: input.caseId } : {}) };
}

/* ------------------------------------------------------------------ author */

export async function cmdAuthor(args: CommandArgs): Promise<AuthorOutput> {
  const input = AuthorInputSchema.parse(args.input);
  const params: AuthorParams = {
    runId: input.runId,
    ...(input.caseIds !== undefined ? { caseIds: input.caseIds } : {}),
    ...workDirParam(),
  };
  return runAuthor(args.ports, args.config, params);
}

/** Katalog roboczy prób podaje job CI (przestrzeń robocza runnera). */
function workDirParam(): { workDir?: string } {
  const workDir = process.env['GREENPROOF_WORK_DIR'];
  return workDir !== undefined && workDir.length > 0 ? { workDir } : {};
}

/* ----------------------------------------------------------------- deliver */

export async function cmdDeliver(args: CommandArgs, opts?: { autoAccept?: boolean }): Promise<DeliverOutput> {
  const input = DeliverInputSchema.parse(args.input);
  return runDeliver(args.ports, args.config, {
    runId: input.runId,
    ...(opts?.autoAccept !== undefined ? { autoAccept: opts.autoAccept } : {}),
  });
}

/* ------------------------------------------------------------------ status */

export interface StatusOutput extends PipelineState {
  /** Rollup liczników (done/remaining/passed/failed/koszt) - wsad dla CI i ludzi. */
  summary: RunRollup;
  /** Wersja aplikacji (ta sama co `grp --version`). */
  version: string;
}

/**
 * Wynik `status --cases`: stan + per-case rollup z ledgerów (dawna komenda
 * stats). `cases`/`totals` niosą wartości ze StatsResult, zastępując mapę
 * `cases[<caseId>]` i proste `totals` ze stanu.
 */
export interface StatusCasesOutput extends Omit<PipelineState, 'cases' | 'totals'> {
  summary: RunRollup;
  version: string;
  cases: CaseStats[];
  totals: StatsTotals;
}

/** Czysty odczyt stanu - bez mutacji i zapisu (bez withState). */
export async function cmdStatus(args: CommandArgs): Promise<StatusOutput>;
export async function cmdStatus(args: CommandArgs, opts: { cases: true }): Promise<StatusCasesOutput>;
export async function cmdStatus(
  args: CommandArgs,
  opts: { cases?: boolean } = {},
): Promise<StatusOutput | StatusCasesOutput> {
  const input = StatusInputSchema.parse(args.input);
  const loaded = await args.ports.state.load(input.runId);
  if (!loaded) throw new RunNotFoundError(input.runId);
  if (opts.cases === true) {
    const stats = await runStats(args.ports, args.config, { runId: input.runId });
    const { cases: _stateCases, totals: _stateTotals, ...rest } = loaded.state;
    return {
      ...rest,
      summary: summarizeRun(loaded.state),
      version: packageVersion(),
      cases: stats.cases,
      totals: stats.totals,
    };
  }
  return { ...loaded.state, summary: summarizeRun(loaded.state), version: packageVersion() };
}

/* ------------------------------------------------------------------ models */

/** Timeout listy /v1/models; brak listy to cecha bramy. */
const MODELS_TIMEOUT_MS = 5_000;
/** Endpoint, gdy config nie podaje baseUrl (jak w preflight). */
const DEFAULT_MODELS_ENDPOINT = 'https://api.anthropic.com';

export interface ModelsOutput {
  endpoint: string;
  available: boolean;
  /** Identyfikatory modeli (data[].id, format OpenAI). */
  models: string[];
  /** Czytelny powód braku listy (404, timeout, brak sieci, nieznany kształt). */
  note?: string;
}

/**
 * Lista modeli z /v1/models. Nagłówki/timeout jak w preflight. Bearer tylko
 * przy własnym baseUrl - domyślny Anthropic dostaje sam x-api-key (nietypowy
 * Authorization dałby 401). Brak listy to nie błąd konfiguracji:
 * available:false z notą zamiast rzucać (exit 0).
 */
export async function listModels(opts: {
  baseUrl?: string | undefined;
  token?: string | undefined;
  timeoutMs?: number | undefined;
}): Promise<ModelsOutput> {
  const endpoint = opts.baseUrl ?? DEFAULT_MODELS_ENDPOINT;
  const result: ModelsOutput = { endpoint, available: false, models: [] };
  try {
    const res = await fetch(`${endpoint.replace(/\/$/, '')}/v1/models`, {
      method: 'GET',
      headers: {
        'anthropic-version': '2023-06-01',
        ...(opts.token !== undefined
          ? {
              'x-api-key': opts.token,
              ...(opts.baseUrl !== undefined ? { authorization: `Bearer ${opts.token}` } : {}),
            }
          : {}),
      },
      signal: AbortSignal.timeout(opts.timeoutMs ?? MODELS_TIMEOUT_MS),
    });
    if (res.status !== 200) {
      const body = await res.text().catch(() => '');
      result.note = `HTTP ${res.status}: ${body.slice(0, 200)}`;
      return result;
    }
    const json: unknown = await res.json().catch(() => null);
    const ids = extractModelIds(json);
    if (ids === null) {
      result.note = 'Nieznany kształt odpowiedzi /v1/models (brak data[].id).';
      return result;
    }
    result.available = true;
    result.models = ids;
  } catch (err) {
    result.note = err instanceof Error ? err.message : String(err);
  }
  return result;
}

function extractModelIds(json: unknown): string[] | null {
  if (typeof json !== 'object' || json === null) return null;
  const data = (json as { data?: unknown }).data;
  if (!Array.isArray(data)) return null;
  const ids: string[] = [];
  for (const entry of data) {
    const id = (entry as { id?: unknown } | null)?.id;
    if (typeof id !== 'string') return null;
    ids.push(id);
  }
  return ids;
}

/** Read-only lista modeli bramy - cicha jak status. */
export async function cmdModels(args: CommandArgs): Promise<ModelsOutput> {
  const model = args.config.model;
  return listModels({
    baseUrl: model.baseUrl,
    token: args.ports.secrets.get(model.authTokenEnv),
  });
}

/* ------------------------------------------------------------------- clean */

/** Świadome sprzątanie artefaktów po release - nigdy efekt uboczny innego kroku. */
export async function cmdClean(args: CommandArgs): Promise<CleanOutput> {
  const input = CleanInputSchema.parse(args.input);
  return runClean(args.ports, {
    runId: input.runId,
    ...(input.caseIds !== undefined ? { caseIds: input.caseIds } : {}),
    ...(input.purge !== undefined ? { purge: input.purge } : {}),
    ...(input.dryRun !== undefined ? { dryRun: input.dryRun } : {}),
    ...(input.branches !== undefined ? { branches: input.branches } : {}),
  });
}

/* ------------------------------------------------------------------- retry */

export interface RetryOutput {
  caseId: string;
  /** Numer próby zaplanowanej przez runRetry. */
  attempt: number;
  results: AuthorOutput['results'];
  reported: DeliverOutput['reported'];
}

/**
 * Pętla ponowienia case'a: retry → author (z triażem) → deliver. Jeden krok
 * joba CI, bo człowiek oczekuje jednego "spróbuj jeszcze raz".
 */
export async function cmdRetry(args: CommandArgs): Promise<RetryOutput> {
  const input = RetryInputSchema.parse(args.input);
  const retry = await runRetry(args.ports, {
    runId: input.runId,
    caseId: input.caseId,
    ...(input.notes !== undefined ? { notes: input.notes } : {}),
  });
  // Triaż robi sam author przed sesją - bez dublowania.
  const author = await runAuthor(args.ports, args.config, {
    runId: input.runId,
    caseIds: [input.caseId],
    ...workDirParam(),
  });
  const deliver = await runDeliver(args.ports, args.config, { runId: input.runId });
  return {
    caseId: retry.caseId,
    attempt: retry.attempt,
    results: author.results,
    reported: deliver.reported,
  };
}

/* ------------------------------------------------------------------ accept */

export async function cmdAccept(args: CommandArgs): Promise<AcceptOutput> {
  const input = AcceptInputSchema.parse(args.input);
  return runAccept(args.ports, args.config, {
    runId: input.runId,
    caseId: input.caseId,
    targetBranch: input.targetBranch,
  });
}

/* ----------------------------------------------------------------- fixture */

/**
 * Fixture-author, dwa tryby:
 * - 'case' (domyślny): wąska sesja uzupełnia lukę po blocked(fixture-gap);
 * - 'preventive': jedna sesja na churn-prone typ przed partią autora, żeby nie
 *   palić próby na wybicie bezpiecznika.
 */
export async function cmdFixture(args: CommandArgs): Promise<unknown> {
  const input = FixtureInputSchema.parse(args.input);
  if (input.mode === 'preventive') {
    return runPreventiveFixtures(args.ports, args.config, {
      runId: input.runId,
      ...(input.types !== undefined ? { types: input.types } : {}),
      ...workDirParam(),
    });
  }
  const caseId = input.caseId;
  if (caseId === undefined) throw new CliError("Tryb 'case' wymaga caseId"); // wymusza już schemat
  return runFixtureAuthor(args.ports, args.config, {
    runId: input.runId,
    caseId,
    ...workDirParam(),
  });
}

/* ----------------------------------------------------------------- release */

export async function cmdRelease(args: CommandArgs): Promise<ReleaseOutput> {
  const input = ReleaseInputSchema.parse(args.input);
  const params: ReleaseParams = {
    runId: input.runId,
    ...(input.waivers !== undefined ? { waivers: input.waivers } : {}),
  };
  return runRelease(args.ports, args.config, params);
}

/* --------------------------------------------------------------- knowledge */

export const KnowledgeInputSchema = z.object({
  action: z.enum(['init', 'lint']),
});

export const UI_TRAPS_FILE = 'ui-traps.yaml';
export const APP_MAP_FILE = 'app-map.yaml';

export interface KnowledgeInitOutput {
  action: 'init';
  dir: string;
  created: string[];
  /** Pliki już istniejące - nie nadpisywane. */
  skipped: string[];
}

export interface KnowledgeFileReport {
  path: string;
  exists: boolean;
  valid: boolean;
  errors: string[];
}

export interface KnowledgeLintOutput {
  action: 'lint';
  dir: string;
  ok: boolean;
  files: KnowledgeFileReport[];
  duplicates: { traps: string[]; routes: string[] };
  counts: { traps: number; views: number };
  errors: string[];
}

export type KnowledgeOutput = KnowledgeInitOutput | KnowledgeLintOutput;

export async function cmdKnowledge(args: KnowledgeArgs): Promise<KnowledgeOutput> {
  const input = KnowledgeInputSchema.parse(args.input);
  const dir = knowledgeDir(args.config);
  return input.action === 'init' ? knowledgeInit(dir) : knowledgeLint(dir);
}

/** Katalog wiedzy żyje w repo testów (core czyta go przez ScmPort). */
export function knowledgeDir(config: GreenproofConfig): string {
  if (!config.knowledge) {
    throw new CliError(
      'Sekcja `knowledge` nie jest skonfigurowana - dodaj knowledge.dir do configu, żeby użyć komendy knowledge.',
    );
  }
  const dir = config.knowledge.dir;
  return isAbsolute(dir) ? dir : resolve(config.paths.testsRepoDir, dir);
}

async function knowledgeInit(dir: string): Promise<KnowledgeInitOutput> {
  await mkdir(dir, { recursive: true });
  const created: string[] = [];
  const skipped: string[] = [];
  for (const [name, template] of [
    [UI_TRAPS_FILE, UI_TRAPS_TEMPLATE],
    [APP_MAP_FILE, APP_MAP_TEMPLATE],
  ] as const) {
    const file = join(dir, name);
    // wx: nie nadpisujemy istniejącej wiedzy nawet przy wyścigu dwóch jobów.
    try {
      await writeFile(file, template, { flag: 'wx' });
      created.push(file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        skipped.push(file);
        continue;
      }
      throw err;
    }
  }
  return { action: 'init', dir, created, skipped };
}

async function knowledgeLint(dir: string): Promise<KnowledgeLintOutput> {
  const traps = await lintFile(join(dir, UI_TRAPS_FILE), UiTrapsSchema);
  const views = await lintFile(join(dir, APP_MAP_FILE), AppMapSchema);

  const trapEntries = traps.value?.traps ?? [];
  const viewEntries = views.value?.views ?? [];
  const duplicateTraps = duplicates(trapEntries.map((t) => `${t.component}::${t.trap}`));
  const duplicateRoutes = duplicates(viewEntries.map((v) => v.route));

  const errors = [
    ...traps.report.errors,
    ...views.report.errors,
    ...duplicateTraps.map((d) => `${UI_TRAPS_FILE}: duplikat wpisu component+trap: ${d}`),
    ...duplicateRoutes.map((d) => `${APP_MAP_FILE}: duplikat route: ${d}`),
  ];

  return {
    action: 'lint',
    dir,
    ok: errors.length === 0,
    files: [traps.report, views.report],
    duplicates: { traps: duplicateTraps, routes: duplicateRoutes },
    counts: { traps: trapEntries.length, views: viewEntries.length },
    errors,
  };
}

async function lintFile<T>(
  file: string,
  schema: { parse: (value: unknown) => T },
): Promise<{ report: KnowledgeFileReport; value: T | null }> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    return {
      report: {
        path: file,
        exists: false,
        valid: false,
        errors: [`${file}: brak pliku - uruchom \`greenproof knowledge init\`.`],
      },
      value: null,
    };
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    return {
      report: {
        path: file,
        exists: true,
        valid: false,
        errors: [`${file}: nieparsowalny YAML - ${err instanceof Error ? err.message : String(err)}`],
      },
      value: null,
    };
  }
  try {
    const value = schema.parse(parsed);
    return { report: { path: file, exists: true, valid: true, errors: [] }, value };
  } catch (err) {
    return {
      report: { path: file, exists: true, valid: false, errors: schemaErrors(file, err) },
      value: null,
    };
  }
}

function schemaErrors(file: string, err: unknown): string[] {
  const issues = (err as { issues?: { path: PropertyKey[]; message: string }[] }).issues;
  if (!Array.isArray(issues)) {
    return [`${file}: ${err instanceof Error ? err.message : String(err)}`];
  }
  return issues.map((i) => `${file}: ${i.path.map(String).join('.') || '(root)'} - ${i.message}`);
}

function duplicates(keys: string[]): string[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const key of keys) {
    if (seen.has(key)) dupes.add(key);
    seen.add(key);
  }
  return [...dupes];
}

const UI_TRAPS_TEMPLATE = `# Pułapki UI - wiedza projektowa czytana przez triaż.
# Pusta lista jest poprawna: projekt bez wiedzy działa, tylko drożej.
version: 1
traps: []

# Przykład wpisu (przenieś pod \`traps:\` i odkomentuj):
# traps:
#   - component: DatePicker
#     trap: Kliknięcie w pole nie otwiera kalendarza - otwiera je dopiero ikona.
#     workaround: Klikaj ikonę kalendarza, potem wybieraj dzień z siatki.
#     selectorExample: page.getByTestId('date-from').getByRole('button')
#     category: component-behavior   # component-behavior | domain-knowledge
#     appliesTo: ['payroll/create']  # tagi flow z planu
`;

const APP_MAP_TEMPLATE = `# Mapa aplikacji - trasy, dojście i kluczowe selektory.
# Pusta lista jest poprawna: projekt bez wiedzy działa, tylko drożej.
version: 1
views: []

# Przykład wpisu (przenieś pod \`views:\` i odkomentuj):
# views:
#   - route: /payroll/new
#     description: Formularz tworzenia listy płac.
#     navigationSteps:
#       - Zaloguj się jako kadrowa.
#       - Menu boczne → Płace → Nowa lista.
#     keySelectors:
#       submit: page.getByRole('button', { name: 'Zapisz' })
`;
