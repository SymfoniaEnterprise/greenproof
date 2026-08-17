# Referencja pól configu

Pole po polu: co znaczy, jaka jest wartość domyślna i kiedy warto ją zmienić.
Jak uruchamiać CLI (szybki start, wejście `--in`, flagi, zmienne środowiskowe):
[configuration.md](configuration.md).

Typ TS: `packages/core/src/config/types.ts`. Schemat walidujący i wartości
domyślne: `packages/core/src/schemas/config.ts` - `parse` zawsze oddaje
kompletny `GreenproofConfig`, więc w pliku podajesz wyłącznie to, co zmieniasz.

## Najwyższy poziom

```ts
interface GreenproofConfig {
  platform: string;                  // wymagane
  platformOptions?: unknown;         // kształt zna adapter
  plan: { source: 'json' } | { source: 'parser'; module: string };  // wymagane
  model: ModelConfig;                // wymagane
  caps?: CapsConfig;                 // domyślne z DEFAULT_CONFIG
  qualityGates?: Record<CasePriority, number>;  // domyślne
  gates?: GatesConfig;               // domyślne (autoAccept: true)
  batching?: BatchingConfig;         // domyślne
  paths: PathsConfig;                // wymagane (testsRepoDir)
  knowledge?: KnowledgeConfig;
  oracle?: OracleConfig;
}
```

### `platform`

`string`. Ścieżka lub nazwa pakietu adaptera. CLI importuje moduł
dynamicznym `import`. Ścieżki względne (`./my-adapter.mjs`) liczone od
katalogu configu. Nazwy pakietów najpierw rozwiązywane z katalogu configu
(`createRequire` na sztucznym `__greenproof__.js`), potem z kontekstu CLI.
Moduł musi eksportować `default` typu `PlatformFactory` (funkcja
`({ config, secrets, logger }) => Ports | Promise<Ports>`).

```js
platform: '@greenproof/adapter-github'
platform: '@greenproof/adapter-fs'
platform: './adapters/my-platform.mjs'    // względem katalogu configu
```

### `platformOptions`

`unknown` - kształt zależy od adaptera. Adapter waliduje wewnętrznie
i rzuca `Error` z czytelnym komunikatem przy brakach (CLI mapuje na
`exit 2`). Przykłady w [`docs/adapters.md`](./adapters.md).

### `plan`

Źródło planu. Dyskryminowane po `source`:

```js
plan: { source: 'json' }                          // plan jako inline JSON lub { path: '...' }
plan: { source: 'parser', module: '@greenproof/plan-parser-bmad' }  // plugin
```

Moduł `plan.module` musi eksportować `default` typu `PlanSource`
(`{ parse(input: string, opts?: { path?: string }): NormalizedPlan }`).
CLI rzuca `CliError` (`exit 2`) jeśli moduł nie istnieje albo nie ma
domyślnego eksportu z metodą `parse`.

### `model`

```ts
interface ModelConfig {
  baseUrl?: string;            // ANTHROPIC_BASE_URL - brama (LiteLLM itp.)
  authTokenEnv: string;        // nazwa zmiennej env z tokenem (wymagane)
  author: string;              // model agenta-autora (wymagane)
  digest?: string;             // opcjonalny tani model do digestów ledgera
  priceTable?: Record<string, {
    inPerMTok: number;
    outPerMTok: number;
    cacheReadPerMTok?: number;
    cacheWritePerMTok?: number;
  }>;
  costModel?: 'local' | 'subscription' | 'metered';
}
```

- **`authTokenEnv`** - nazwa zmiennej środowiskowej z tokenem. Wzorzec:
  `'LITELLM_KEY'` dla bramy, `'ANTHROPIC_AUTH_TOKEN'` dla SDK bezpośrednio.
  CLI czyta ją przez `SecretsPort.get(name)` - `process.env[name]` w
  domyślnej konfiguracji.
- **`baseUrl`** - adres bramy (np. `https://litellm.firma.pl`). Pominięte
  = API Anthropic. NIE ustawiaj na adres Anthropic, jeśli chcesz korzystać
  z bramy.
- **`author`** - nazwa modelu widziana przez bramę. Niekoniecznie ta sama
  co nazwa w API Anthropic.
- **`priceTable`** - własne liczenie kosztu. Źródło prawdy dla capa
  kosztowego, bo `total_cost_usd` z SDK bywa błędny dla customowych nazw
  modeli za bramą. Ceny w USD/MTok. Brak wpisu dla używanego modelu =
  cap kosztowy nie zadziała poprawnie (autor zakończy sesję tylko przez
  cap tur/czasu). Z `priceTable` koszt 0 jest **legalnym wynikiem pomiaru**
  (model lokalny), a nie brakiem danych - raport pokazuje $0, nie estymatę SDK.
- **`costModel`** - skąd bierze się koszt sesji; steruje natywnym capem
  kosztowym SDK (`maxBudgetUsd`):
  - `local` - model na własnym sprzęcie. Cap SDK **nie jest ustawiany**;
    granicą są `maxTurns` i `maxTimeMinutes` (SDK wyceniłoby darmowy run
    cennikiem Anthropic i ubiło go na capie kosztowym).
  - `subscription` - mostek do abonamentu (CLIProxyAPI, subskrypcja
    Claude). Per token nie płacimy, ale limit zużycia istnieje → odbojnik
    zostaje (`maxCostUsd × 20` z `priceTable`, inaczej `maxCostUsd`).
  - `metered` - zwykłe API rozliczane per token.

  Pominięte = wnioskowane z cennika: zerowe stawki autora traktujemy jak
  `local`. Modele z subskrypcji też bywają wpisane z zerowym cennikiem, więc
  oznaczaj je jawnie.

### `caps` - limity budżetowe (CapsConfig)

Wszystkie pola opcjonalne - pusty obiekt przechodzi przez parse i zbiera
domyślne. Domyślne wartości z `packages/core/src/config/types.ts`:

```ts
{
  maxTurns: 1000,
  maxTimeMinutes: 30,
  maxCostUsd: 6,
  maxPlaywrightRuns: 12,
  proofRuns: 4,
  maxAutoRetries: 1,
  firstTurnTimeoutMinutes: 5,
  maxInfraRetries: 2,
  maxCostUsdPerCase: undefined,    // brak limitu per case
  snapshotMaxChars: 30_000,
  snapshotGating: 'warn',
  enforceRunPlaywrightTool: true,
  seedFuse: {
    churnProneTypes: [],
    learn: 'propose',
    maxFailedStrategies: 3,
    maxArrangeTurns: 40,
    learnedEntryTtlRuns: 10,
  },
}
```

| Pole                  | Domyślnie | Znaczenie                                                                                  |
|-----------------------|-----------|--------------------------------------------------------------------------------------------|
| `maxTurns`            | `1000`    | Twardy limit tur sesji (1 tura = 1 wiadomość asystenta)                                    |
| `maxTimeMinutes`      | `30`      | Limit czasu sesji; `AbortController` po przekroczeniu                                       |
| `maxCostUsd`          | `6`       | Cap kosztowy z własnego licznika (priceTable)                                              |
| `maxPlaywrightRuns`   | `12`      | Cap uruchomień `playwright test` w fazie assert (do dwóch zielonych przebiegów)             |
| `proofRuns`           | `4`       | Osobna pula runów fazy dowodu, odblokowana po DRUGIM zielonym przebiegu                     |
| `maxAutoRetries`      | `1`       | Automatyczne ponowienia po `attempt_failed`; `0` = tylko human-retry                       |
| `firstTurnTimeoutMinutes` | `5`   | Watchdog startu: brak PIERWSZEJ tury w tym oknie → przerwanie jako `infra` (nie `time`). Dla MODELI LOKALNYCH podnieś do ~15 - pierwsza tura dużego modelu na llama.cpp (prefill + thinking) potrafi trwać ~10 min i domyślne 5 fałszywie ubija żywą sesję |
| `maxInfraRetries`     | `2`       | Ponowienia po przerwaniu `infra` - pula POZA `maxAutoRetries` (zwis backendu nie zjada budżetu case'a) |
| `maxCostUsdPerCase`   | brak      | Łączny budżet $ na case przez wszystkie próby                                               |
| `snapshotMaxChars`    | `30_000`  | Twarde przycięcie wyników narzędzi (nadmiar = cache_read w KAŻDEJ kolejnej turze)          |
| `snapshotGating`      | `'warn'`  | `'warn'` loguje nadmiarowe snapshoty; `'enforce'` odmawia (deny). Zaczynaj od `warn`        |
| `enforceRunPlaywrightTool` | `true` | Bash-owe `playwright test` = deny; runy wyłącznie narzędziem `run_playwright` (wersjonowane raporty). `false` = tryb legacy dla modeli bez MCP |

Uwaga: po udanym fixture-authorze case dostaje **kredyt ponowienia**
(`fixtureRetryCredits`) zużywany PRZED zwykłą pulą `maxAutoRetries` - próba
„z nowym klockiem" nie przepada, nawet gdy auto-retry spalił się wcześniej.

#### `caps.seedFuse` - bezpiecznik seedu

```ts
interface SeedFuseConfig {
  churnProneTypes: string[];                          // ręczna lista (PlanCase.type / tagi flow)
  learn: 'propose' | 'auto' | 'off';                 // tryb uczenia listy z ledgera
  maxFailedStrategies: number;                       // po ilu RÓŻNYCH nieudanych strategiach przerwać
  maxArrangeTurns: number;                            // po ilu turach arrange bez potwierdzonego stanu przerwać
  learnedEntryTtlRuns: number;                        // po ilu runach bez incydentu wpis nauczony wygasa
}
```

Tryby `learn`:

- `'propose'` (domyślny) - wpisy nauczone z ledgera trafiają do
  artefaktu `learned-churn.json` + raport; człowiek zatwierdza i commituje.
- `'auto'` - pipeline commituje prosto do gałęzi bazowej przez
  `scm.commitFiles` z `chore(greenproof): update learned churn-prone list…`.
- `'off'` - uczenie wyłączone.

Incydenty kwalifikujące typ do listy (heurystyka w
`packages/core/src/knowledge/churn.ts`):

- uderzenie w bezpiecznik (`outcome === 'blocked'` + `blockedReason === 'fixture-gap'`),
- `>= maxFailedStrategies` różnych nieudanych strategii,
- koszt case'a `> 2× mediana` kosztów case'ów runa (przy `>= 3` case'ach).

Po `maxArrangeTurns` turach `arrange` bez `seedConfirmed === true` bezpiecznik
też działa - wymusza zakończenie sesji z `blocked`.

#### `caps.fixtureSession` - capy wąskiej sesji fixture-author

```ts
fixtureSession: { maxTurns: 80, maxTimeMinutes: 20, maxCostUsd: 1 }
```

Sesja fixture jest wąska, ale na trudnej aplikacji musi ogarnąć
role/login/kontrakty API zanim dojdzie do seedu - stąd 80 tur, nie mniej.
Nadpisywalne per projekt.

### `playwright` - wykonanie testów przez narzędzie `run_playwright`

```ts
playwright: {
  command: ['npx', 'playwright', 'test'],      // argv komendy uruchamiającej testy
  runTimeoutMinutes: 5,                        // twardy timeout pojedynczego runu
  reportFile: 'pw-report.json',                // współdzielony raport JSON z configu projektu (fallback kopii)
  reportEnvVar: 'PLAYWRIGHT_JSON_OUTPUT_NAME', // env wymuszający ścieżkę raportu
}
```

Autor uruchamia testy WYŁĄCZNIE narzędziem `mcp__greenproof__run_playwright`
(przy `caps.enforceRunPlaywrightTool`): pipeline sam wykonuje run, wersjonuje
raport JSON per przebieg (`pw-runs/run-NN-<purpose>.json`) i pilnuje obu pul
budżetu. `record_proof_material` odrzuca współdzielony `reportFile`: materiałem
dowodowym może być tylko raport konkretnego przebiegu, nie plik, który następny
run nadpisze.

### `appDocs` - dokumentacja aplikacji dla fixture-authora (opcjonalne)

```ts
appDocs?: { paths: string[]; maxChars?: number /* 20_000 */ }
```

Ścieżki plików **w repo testów** (czytane portem SCM - agnostycznie wobec
platformy), wstrzykiwane wprost do promptu sesji fixture-author. Wąska sesja
nie traci tur na szukanie README aplikacji.

### `qualityGates` - progi pokrycia per priorytet

```ts
qualityGates?: Record<CasePriority, number>;  // 0..1
```

Domyślne: `{ P0: 1.0, P1: 0.95, P2: 0.9, P3: 0.9 }`.

Reguły bramek w `packages/core/src/steps/release.ts`:

- **P0** - fail blokuje release bezwzględnie. Brak wyjątków.
- **P1** - fail wymaga waiveru na KAŻDY niedomknięty case (`waivers[]`
  w `ReleaseInput`). Jeden brakujący case bez waiveru = P1 fail.
- **P2 / P3** - informacyjne; `pass = true` nawet przy brakach.
- `pass` całego release = `P0..P3.every(p => gates[p].pass)`.

### `gates` - bramki zachowania pipeline'u

```ts
interface GatesConfig {
  autoAccept: boolean;   // domyślnie true
}
```

- **`autoAccept`** - włącza automatyczną akceptację case'ów po deliver.
  Kryterium jest w pełni deterministyczne (werdykt dowodu wyłącznie
  z walidatora, nigdy deklaracja agenta) i ma TRZY warunki: dowód mutacyjny
  `valid`, ZERO ostrzeżeń walidatora ORAZ czysty lint anty-duplikacji
  selektorów (ta sama funkcja, której używa deliver). Ostrzeżenie znaczy
  „dowód ważny mechanicznie, ale słabszy" - taki case celowo zostaje
  człowiekowi. Case niespełniający wszystkich trzech zostaje w `in_review`
  (albo `blocked`)
  i trafia do raportu dla człowieka. `false` = stare zachowanie (człowiek
  klika `accept` per case). Per-run wyłącza to także flaga `--no-auto-accept`.

### `batching` - limit czasu partii

```ts
interface BatchingConfig {
  timeoutBaseMin: number;
  timeoutPerCaseMin: number;
  timeoutCapMin: number;
  splitWarnAt: number;
}
```

Domyślne: `{ timeoutBaseMin: 20, timeoutPerCaseMin: 25, timeoutCapMin: 340,
splitWarnAt: 12 }`.

Filtr liczy `timeout = min(timeoutBaseMin + timeoutPerCaseMin × selectedCount,
timeoutCapMin)` (minuty); wynik ląduje w `FilterOutput.timeoutMinutes` (użycie
w CI - `timeout-minutes` joba autora: [`docs/runner-requirements.md`](./runner-requirements.md)).

`splitWarnAt` - powyżej tylu case'ów filtr dorzuca warning
("rozważ podział planu na mniejsze przebiegi"). Warning ląduje w raporcie
rosteru, nie blokuje.

### `paths` - ścieżki w repo testów

```ts
interface PathsConfig {
  testsRepoDir: string;                       // wymagane - katalog repo testów (cwd agenta)
  pomDir: string;                             // domyślnie 'tests/support/pom'
  fixturesDir: string;                        // domyślnie 'tests/support/fixtures'
  pomIndex: string;                           // domyślnie 'tests/support/pom-index.json'
  specsDir: string;                           // domyślnie 'tests/e2e'
}
```

- **`testsRepoDir`** - jedyna ścieżka bez domyślnej wartości. Względna
  liczona od katalogu configu (CLI rozwiązuje ją w `packages/cli/src/config.ts`).
  Bezwzględna przechodzi bez zmian. To jest `cwd` agenta-autora i katalog,
  na którym operuje `ScmPort`.
- **`pomIndex`** - JSON z inwentarzem POM/fixture (`{ version: 1, entries: [] }`
  dla pustego). Źródło prawdy triażu. W trakcie runu inwentarz jest
  współdzielony wewnętrznie: po każdym dostarczonym case'ie jego
  zarejestrowane POM-y/fixture'y trafiają na wspólny branch
  `greenproof/fixtures/<runId>` (`state.fixturesRef`), więc kolejne case'y
  tego samego runu widzą je w triażu bez czekania na `accept`.
- **`specsDir`** - katalog, w którym autor składa drafty speca
  (`Filter` sprawdza istniejące zaakceptowane spec'y tutaj, globem
  `<specsDir>/**`).

### `knowledge` - wiedza projektowa (opcjonalne)

```ts
interface KnowledgeConfig {
  dir: string;    // katalog wiedzy względem repo testów
}
```

W katalogu oczekiwane pliki (YAML):

- `ui-traps.yaml` - pułapki UI per komponent/flow. Schemat
  `UiTrapsSchema` walidowany przez `gp knowledge lint`.
  Pusta lista (`traps: []`) jest poprawna.
- `app-map.yaml` - mapa tras: route, navigationSteps, keySelectors.
  Pusta lista (`views: []`) jest poprawna.
- `learned-churn.json` - proponowane typy churn-prone (z release, tryb
  `'propose'`); człowiek commituje po recenzji.

Brak sekcji `knowledge` = projekt bez wiedzy działa, tylko drożej
(agent odkrywa od zera zamiast reużyć `app-map` i `ui-traps`). Komenda
`gp knowledge init` tworzy szablony (istniejących plików NIE nadpisuje - zapis
idzie flagą `wx`, więc nawet wyścig dwóch jobów nie skasuje wiedzy);
`gp knowledge lint` waliduje i wykrywa duplikaty (`component::trap`, `route`).

### `oracle` - golden-case'y (opcjonalne)

```ts
interface OracleConfig {
  goldenCasesDir: string;   // katalog golden-case'ów (JSON/YAML) względem repo testów
}
```

Wartości oczekiwane w asercjach biorą się WYŁĄCZNIE z golden-case'ów
(pliki wskazane w kontekście przez triage), NIGDY z UI aplikacji.
Brak sekcji `oracle` = autor pracuje bez żelaznej reguły, łatwiej
o "test, który potwierdza błąd jako prawdę".
## Minimalny przykład

```js
export default {
  platform: '@greenproof/adapter-fs',
  platformOptions: { repoDir: './tests-repo', baseDir: './platform' },
  plan: { source: 'json' },
  model: { authTokenEnv: 'LITELLM_KEY', author: 'claude-sonnet' },
  paths: { testsRepoDir: './tests-repo' },
};
```

Reszta pól dostaje wartości domyślne z tabel wyżej. Rozbudowany przykład
z adapterem GitHub i komentarzami przy każdej sekcji:
[`examples/github-workflow/greenproof.config.example.mjs`](../examples/github-workflow/greenproof.config.example.mjs).
