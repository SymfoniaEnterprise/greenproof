import type { CasePriority } from '../domain/plan.js';

/**
 * Eskalacja: mocniejszy model używany WYŁĄCZNIE w sesji fixture-author.
 * Brak baseUrl/authTokenEnv = dziedziczy endpoint i token autora.
 */
export interface FixtureAuthorModelConfig {
  model: string;
  baseUrl?: string;
  authTokenEnv?: string;
}

export interface ModelConfig {
  /** Baza API (ANTHROPIC_BASE_URL). Pominięte = API Anthropic. */
  baseUrl?: string;
  /** Zmienna środowiskowa z tokenem (ANTHROPIC_AUTH_TOKEN). */
  authTokenEnv: string;
  /** Model autora (nazwa w bramie). */
  author: string;
  /** Tani model do digestów ledgera. */
  digest?: string;
  /** Eskalacja do sesji fixture-author (brak = model autora). */
  fixtureAuthor?: FixtureAuthorModelConfig;
  /**
   * Limit tokenów wyjścia per żądanie (CLAUDE_CODE_MAX_OUTPUT_TOKENS).
   * Konieczny dla modeli lokalnych: llama.cpp wymaga prompt + max_tokens ≤ ctx,
   * a domyślne 32k rezerwy wyjścia przepełnia 64k okno.
   */
  maxOutputTokens?: number;
  /**
   * Cennik per model ($/MTok) do własnego liczenia kosztu - źródło prawdy
   * dla capu, bo total_cost_usd SDK bywa błędne dla customowych nazw modeli.
   */
  priceTable?: Record<
    string,
    { inPerMTok: number; outPerMTok: number; cacheReadPerMTok?: number; cacheWritePerMTok?: number }
  >;
  /**
   * Źródło kosztu sesji; steruje capem kosztowym SDK.
   * `local` - cap SDK NIE jest ustawiany: wycena cennikiem Anthropic ubija
   * darmowe runy. Granicą są `maxTurns` i `maxTimeMinutes`.
   * `subscription` - abonament (mostek OAuth, Claude); limit zużycia
   * istnieje, odbojnik zostaje.
   * `metered` - zwykłe API rozliczane per token.
   *
   * Pominięte = wnioskowane z `priceTable`: zerowy cennik autora = `local`.
   * Uwaga: modele z subskrypcji też bywają zerowe - ustaw `subscription` jawnie.
   */
  costModel?: 'local' | 'subscription' | 'metered';
}

export interface SeedFuseConfig {
  /** Ręczna lista typów churn-prone (PlanCase.type / tagi flow). */
  churnProneTypes: string[];
  /** Uczenie listy z ledgera (domyślnie propose). */
  learn: 'propose' | 'auto' | 'off';
  /** Po ilu RÓŻNYCH nieudanych strategiach seedu przerwać. */
  maxFailedStrategies: number;
  /** Po ilu turach fazy arrange bez potwierdzonego stanu przerwać. */
  maxArrangeTurns: number;
  /** Po ilu runach bez incydentu wygasa wpis nauczony. */
  learnedEntryTtlRuns: number;
}

export interface CapsConfig {
  maxTurns: number;
  maxTimeMinutes: number;
  maxCostUsd: number;
  /** Cap uruchomień `playwright test` w fazie assert. */
  maxPlaywrightRuns: number;
  /** Osobna pula runów playwright na fazę dowodu (odblokowana po 2. zielonym). */
  proofRuns: number;
  /** Automatyczne ponowienia po attempt_failed (0 = tylko human-retry). */
  maxAutoRetries: number;
  /** Watchdog: brak PIERWSZEJ tury asystenta w tyle minut → przerwij jako 'infra'. */
  firstTurnTimeoutMinutes: number;
  /** Ponowienia po przerwaniu 'infra' - NIE liczą się do maxAutoRetries. */
  maxInfraRetries: number;
  /** Łączny budżet $ na case przez wszystkie próby. */
  maxCostUsdPerCase?: number;
  seedFuse: SeedFuseConfig;
  /** Twarde przycięcie pojedynczego wyniku narzędzia (znaki). */
  snapshotMaxChars: number;
  /**
   * Bramka higieny snapshotów: 'warn' loguje nadmiarowe pełne snapshoty,
   * 'enforce' odrzuca je (deny).
   */
  snapshotGating: 'warn' | 'enforce';
  /** Bash-owe `playwright test` = deny; runy wyłącznie narzędziem run_playwright. */
  enforceRunPlaywrightTool: boolean;
  /** Capy WĄSKIEJ sesji fixture-author - celowo małe (jedno zadanie: fixture). */
  fixtureSession: { maxTurns: number; maxTimeMinutes: number; maxCostUsd: number };
}

export interface BatchingConfig {
  /** Timeout autora = min(base + perCase × n, cap) [min]. */
  timeoutBaseMin: number;
  timeoutPerCaseMin: number;
  timeoutCapMin: number;
  /** Powyżej tylu case'ów filter ostrzega o podziale planu. */
  splitWarnAt: number;
}

export interface PathsConfig {
  /** Katalog repo testów (cwd agenta). */
  testsRepoDir: string;
  /** Katalog POM-ów względem repo testów. */
  pomDir: string;
  fixturesDir: string;
  /** Indeks inwentarza POM (JSON) względem repo testów. */
  pomIndex: string;
  /** Katalog, w którym autor składa drafty speców. */
  specsDir: string;
}

export interface KnowledgeConfig {
  /** Katalog wiedzy względem repo testów (ui-traps.yaml, app-map.yaml, proposals/). */
  dir: string;
}

export interface OracleConfig {
  /** Katalog golden-case'ów (JSON/YAML) - jedyne źródło wartości oczekiwanych. */
  goldenCasesDir: string;
}

/** Wykonanie playwrighta przez narzędzie procesowe run_playwright. */
export interface PlaywrightConfig {
  /** Komenda uruchamiająca testy (argv). */
  command: string[];
  /** Twardy timeout pojedynczego runu [min]. */
  runTimeoutMinutes: number;
  /** Współdzielony plik raportu JSON z configu projektu (fallback kopii). */
  reportFile: string;
  /** Zmienna środowiskowa wymuszająca ścieżkę raportu JSON. */
  reportEnvVar: string;
}

/**
 * Bramki przebiegu poza bramkami jakości release - nie dotyczą pokrycia
 * (to `qualityGates`), tylko zachowania pipeline'u.
 */
export interface GatesConfig {
  /**
   * Auto-akceptacja po deliver: case spełniający dowód mutacyjny `valid`
   * bez ostrzeżeń walidatora + czysty lint. Wyłącza flagą `--no-auto-accept`
   * albo polem `false` w configu.
   */
  autoAccept: boolean;
}

/** Dokumentacja aplikacji wstrzykiwana do promptu fixture-authora. */
export interface AppDocsConfig {
  /** Ścieżki plików W REPO TESTÓW (czytane przez port SCM, nie z dysku). */
  paths: string[];
  /** Twarde przycięcie łącznej długości wstrzykiwanej dokumentacji (znaki). */
  maxChars: number;
}

export interface GreenproofConfig {
  /** Moduł adaptera platformy (eksport default: PlatformFactory). */
  platform: string;
  /** Opcje przekazywane fabryce adaptera (kształt zna adapter). */
  platformOptions?: unknown;
  /** Źródło planu: 'json' (natywne) albo moduł parsera (eksport default: PlanSource). */
  plan: { source: 'json' } | { source: 'parser'; module: string };
  model: ModelConfig;
  caps: CapsConfig;
  /** Progi pokrycia per priorytet (0..1); P1 fail wymaga waivera. */
  qualityGates: Record<CasePriority, number>;
  /** Bramki zachowania pipeline'u (auto-akceptacja). */
  gates: GatesConfig;
  batching: BatchingConfig;
  playwright: PlaywrightConfig;
  paths: PathsConfig;
  knowledge?: KnowledgeConfig;
  oracle?: OracleConfig;
  appDocs?: AppDocsConfig;
}

export const DEFAULT_CONFIG: Pick<
  GreenproofConfig,
  'caps' | 'qualityGates' | 'gates' | 'batching' | 'playwright'
> = {
  caps: {
    maxTurns: 1000,
    maxTimeMinutes: 30,
    maxCostUsd: 6,
    // 12, nie 6: przy sześciu runach pula assert wyczerpuje się przed dwoma
    // zielonymi przebiegami dowodu mutacyjnego.
    maxPlaywrightRuns: 12,
    proofRuns: 4,
    maxAutoRetries: 1,
    firstTurnTimeoutMinutes: 5,
    maxInfraRetries: 2,
    seedFuse: {
      churnProneTypes: [],
      learn: 'propose',
      maxFailedStrategies: 3,
      maxArrangeTurns: 40,
      learnedEntryTtlRuns: 10,
    },
    snapshotMaxChars: 30_000,
    snapshotGating: 'warn',
    enforceRunPlaywrightTool: true,
    fixtureSession: { maxTurns: 80, maxTimeMinutes: 20, maxCostUsd: 1 },
  },
  qualityGates: { P0: 1.0, P1: 0.95, P2: 0.9, P3: 0.9 },
  gates: { autoAccept: true },
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
};
