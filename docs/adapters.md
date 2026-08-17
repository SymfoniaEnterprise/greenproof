# Adaptery platformy

Rdzeń greenproof nie importuje niczego platformowego. Konkretna platforma
(GitHub, GitLab, Jenkins, Jira, filesystem…) dostarcza moduł adaptera, który
eksportuje `default` typu `PlatformFactory`. CLI ładuje go dynamicznym
`import` po nazwie w `platform` w configu (ścieżki względne liczone od
katalogu configu; nazwy pakietów najpierw rozwiązywane z `baseDir`, potem
z kontekstu CLI - `packages/cli/src/platform.ts`).

## Kontrakty portów

Wszystkie kontrakty w `packages/core/src/ports/index.ts`.

### `ScmPort` - repozytorium testów (SCM)

```ts
interface ScmPort {
  ensureBranch(name: string, fromRef: string): Promise<void>;
  commitFiles(
    branch: string,
    files: FileChange[],     // FileChange = { path, content: string | null }  // null = usunięcie
    message: string,
  ): Promise<{ sha: string }>;
  readFile(ref: string, path: string): Promise<string | null>;
  listFiles(ref: string, glob: string): Promise<string[]>;
  openPullRequest(p: {
    from: string; to: string; title: string; body: string;
  }): Promise<{ url: string; id: string }>;
  push?(branch: string): Promise<void>;   // no-op w adapterach czysto API-owych
}
```

Semantyka:

- **Idempotencja.** `ensureBranch` na istniejącym branchu to no-op. `commitFiles`
  na istniejącym branchu commituje normalnie (commit po commicie); rdzeń tego
  nie wycofuje. `openPullRequest` dla pary (`from`, `to`) z istniejącym PR-em
  powinno zwrócić istniejący PR (nie tworzyć duplikatu) - to jest testowane
  w `examples/github-workflow/e2e-start.yml` jako retry-safe flow.
- **`listFiles` z globem** - adapter sam tłumaczy glob na swój mechanizm
  (np. `git ls-tree`, GitHub Trees API z `globToRegExp`). Rdzeń używa tego do
  wykrywania już zaakceptowanych speców i draftów na branchach autora.
- **`openPullRequest`** - jedyny sposób rdzenia na push do repo testów.
  Hook `PreToolUse` agenta blokuje `git push`, `gh pr`, `gh release`,
  `gh repo` (własny `git push` case'a idzie przez PR).
- **`push?`** - opcjonalny. Adaptery czysto API-owe (GitHub commituje przez
  data API) zwracają `undefined`/no-op. Adaptery z lokalnym checkoutem
  (`repoDir: '.'`) włączają realny push.

### `ArtifactStore` - trwałe artefakty przebiegu

```ts
interface ArtifactStore {
  put(
    runId: string, key: string, data: Buffer | Readable,
    meta?: Record<string, string>,
  ): Promise<void>;
  get(runId: string, key: string): Promise<Buffer | null>;
  list(runId: string, prefix?: string): Promise<string[]>;
  delete?(runId: string, key: string): Promise<void>;   // OPCJONALNE
}
```

**Kontrakt retencji:** `delete` jest opcjonalne. Implementuje je adapter,
w którym retencją artefaktów zarządza greenproof (`adapter-fs` - lokalne
runy). Platformy z własnym cyklem życia artefaktów (GitHub Actions,
platformy firmowe) go NIE implementują - wtedy `gp clean` odmawia
typowanym błędem (`ArtifactDeleteUnsupportedError`, exit 2) zamiast po
cichu nic nie robić. Rdzeń NIGDY nie woła `delete` poza jawnym krokiem
`clean`, a `clean` usuwa artefakty case'a wyłącznie po `released`
(domyślnie tylko odtwarzalne: transcripty, kontekst triażu,
extra-inventory; `purge` obejmuje też ledger/spec/proof).

**Branche (`ScmPort.deleteBranch?` / `listBranches?`):** analogicznie
opcjonalne. `clean` sprząta nimi osad runów: `author/<caseId>` case'ów
`released` (praca jest już zmergowana przez PR z accept), a gdy CAŁY run
jest terminalny (released/skipped/failed) - także `greenproof/fixtures/<runId>`
(commity pozostają osiągalne z branchy case'ów, znika sam ref); bocznice
`greenproof/fixtures-failed/<runId>/*` (praca nieudanych sesji do wglądu
człowieka) dopiero z `purge` i tylko przy dostępnym `listBranches`. Platforma
bez `deleteBranch` (np. GitHub z auto-delete po merge'u) dostaje wpis
`branchNote` w wyniku zamiast błędu - branche to higiena, nie retencja
artefaktów. `branches: false` w wejściu wyłącza sprzątanie branchy.

Klucze używane przez rdzeń (prefix `cases/<caseId>/`):

- `cases/<safeCaseId>/spec.ts` - draft speca (z deliver)
- `cases/<safeCaseId>/proof.json` - raport dowodu mutacyjnego
- `cases/<safeCaseId>/ledger.jsonl` - log prób (jsonl, append-only)
- `plan.json` - znormalizowany plan (z filter)
- `<caseId>/context.json` - kontekst startowy agenta (z triage)
- `learned-churn.json` - proponowane typy churn-prone (z release, tryb `propose`)

Semantyka:

- **`put` jest idempotentny** - powtórzenie z tą samą zawartością daje ten
  sam efekt (commity w GitHub adapterze mają retry z ponownym odczytem heada,
  bo kolejność artefaktów nie ma znaczenia).
- **`get(runId, key)`** zwraca `null` dla nieistniejącego klucza (nie rzuca).
- **`meta`** jest opcjonalne - adapter może zapisać obok `<key>.meta.json`
  do późniejszego odczytu.

### `HumanChannelPort` - kanał do człowieka

```ts
interface HumanChannelPort {
  postReport(runRef: string, report: HumanReport): Promise<void>;
}
```

`HumanReport = { kind, reportId, title, markdown, data }`.

**Human channel jest WYŁĄCZNIE WYCHODZĄCY.** Biblioteka NIGDY nie nasłuchuje
- komendy człowieka (`/retry`, `/accept`, `/release`) są zdarzeniami platformy
(np. komentarz na issue), które platforma tłumaczy na wywołania CLI w
workflow. To dlatego `examples/github-workflow/e2e-decision.yml` jest
kolejnym workflow reagującym na `issue_comment` - rdzeń nie ma pojęcia
o webhookach.

Idempotencja: ten sam `reportId` (np. `gp-…:roster`, `gp-…:released`) =
update istniejącego raportu, nie kolejny duplikat. Adapter-github osiąga
to markerem `<!-- greenproof:report:<reportId> -->` w pierwszej linii
komentarza.

### `StateStore` - trwały stan pipeline'u z optimistic lockingiem

```ts
export class StateConflictError extends Error {
  constructor(readonly runId: string) {
    super(`Pipeline state for run ${runId} was modified concurrently`);
    this.name = 'StateConflictError';
  }
}

interface StateStore {
  load(runId: string): Promise<{ state: PipelineState; version: string } | null>;
  save(
    runId: string, state: PipelineState,
    expectedVersion: string | null,   // null = tworzenie
  ): Promise<{ version: string }>;
}
```

Wzorzec `withState` (load → mutacja → save z CAS) jest w
`packages/core/src/machine/withState.ts`. Konflikt = `StateConflictError`,
CLI mapuje go na exit `4`, platforma ponawia krok.

Adapter musi:

- **`expectedVersion === null`** - atomic create. Drugi create dla tego
  samego `runId` rzuca `StateConflictError`.
- **`expectedVersion !== null`** - read-modify-write z CAS. Rozbieżność
  wersji = `StateConflictError`. Wersja może być dowolnym opaque stringiem
  (sha blobu, sha256 pliku - patrz implementacje poniżej), ale musi być
  wersją JEDNEGO runu - wersja współdzielona przez wszystkie runy robi
  fałszywe konflikty.

Adapter-github trzyma stan wszystkich runów na orphan branchu
`greenproof/state` (plik `<runId>.json`), ale wersją jest sha BLOBU tego
pliku, nie sha commita brancha. Dzięki temu lock jest per run: zapis innego
runu przesuwa head, lecz nie unieważnia naszej wersji. CAS to porównanie sha
blobu pod aktualnym headem + `updateRef(force:false)`; przegrany wyścig na
refie (cudzy commit wszedł pierwszy) adapter pochłania - przeładowuje head,
ponownie sprawdza sha NASZEGO blobu i przebudowuje commit na nowym rodzicu
(do 5 prób, potem uczciwie oddaje `StateConflictError`). Zmiana naszego pliku
przez kogokolwiek innego nadal leci wyżej jako `StateConflictError` - retry
w adapterze nie zamiata prawdziwego konfliktu. Wersja pozostaje weryfikowalna
po stronie platformy (sha blobu widać w drzewie commita), a historia stanu
jest audytowalna commit po commicie. Ograniczenie takie samo jak w
adapterze-fs: wersja jest funkcją treści, więc zapis identycznej treści jest
nieodróżnialny od braku zapisu (i nieszkodliwy).

Adapter-fs używa sha256 pliku jako wersji, optimistic locking przez krótki
lock katalogowy (`mkdir` jako mutex, z exponential backoff). `O_EXCL`
przy tworzeniu jest atomowe.

### `SecretsPort`, `Logger`, `Clock` - własne kontrakty

```ts
interface SecretsPort { get(name: string): string | undefined; }
interface Logger {
  debug(msg: string, data?: unknown): void;
  info(msg: string, data?: unknown): void;
  warn(msg: string, data?: unknown): void;
  error(msg: string, data?: unknown): void;
}
interface Clock { now(): Date; }
```

CLI dostarcza domyślne: `envSecrets` (czytanie z `process.env`),
`createStderrLogger` (stdout zarezerwowany na czysty JSON wyniku),
`systemClock` (`new Date()`). Adapter może je zignorować albo nadpisać
(np. własny clock dla testów deterministycznych).

## `PlatformFactory`

```ts
type PlatformFactory = (options: {
  config: unknown;          // platformOptions z konfigu (kształt zna adapter)
  secrets: SecretsPort;
  logger: Logger;
}) => Promise<Ports> | Ports;
```

Wymogi:

- **Eksport `default`** typu `PlatformFactory` - CLI rzuca `CliError`
  (`exit 2`) jeśli moduł nie ma domyślnego eksportu lub nie jest funkcją.
- **Zwraca pełny `Ports`** (`scm`, `artifacts`, `human`, `state`, `secrets`,
  `logger`, `clock`). Adapter może przejąć `secrets`/`logger` z parametrów
  (zachować nasze), ale `clock` powinien zwrócić własny - CLI nie nadpisuje
  go po fakcie.
- **Rzuca `Error` z czytelnym komunikatem** przy braku wymaganych pól
  `platformOptions` lub braku sekretu. CLI zmapuje to na `exit 2`.
- **Może być async** - fabryka może otworzyć połączenie, odpytać API itp.
- **Ścieżka modułu w configu** - względna (`./my-adapter.mjs`) liczona od
  katalogu configu; bezwzględna; `file://…`; nazwa pakietu.

CLI wywołuje fabrykę z `config.platformOptions` (nie pełnym configiem).
Adapter dostaje więc TYLKO swój kawałek konfigu - kształt zna sam.

## Przykład: adapter-fs

Pełny plik: `packages/adapter-fs/src/index.ts`. Kształt:

```ts
// platformOptions: { repoDir: string; baseDir: string }
const createFsPlatform: PlatformFactory = ({ config, secrets, logger }) => {
  const options = parseOptions(config);     // walidacja kształtu, czytelny błąd
  const repoDir = resolve(options.repoDir);
  const paths = fsPlatformPaths(options.baseDir);
  // bazowy check: repo musi istnieć (lepszy błąd niż z głębi gita)
  if (!existsSync(repoDir)) throw new Error(`repoDir does not exist: ${repoDir}`);
  const clock: Clock = { now: () => new Date() };
  return {
    scm: new FsScm({ repoDir, prDir: paths.prDir, clock }),
    artifacts: new FsArtifactStore({ dir: paths.artifactsDir }),
    human: new FsHumanChannel({ dir: paths.reportsDir, clock }),
    state: new FsStateStore({ dir: paths.stateDir }),
    secrets, logger, clock,
  };
};
export default createFsPlatform;
```

Cechy szczególne:

- **Scm na lokalnym gicie** - przez plumbing i tymczasowy indeks
  (`GIT_INDEX_FILE`); checkout ani worktree użytkownika nie są dotykane.
  Identyfikator commitera ustalany leniwie, gdy repo/global config go nie ma.
- **ArtifactStore na plikach** - `<baseDir>/artifacts/<runId>/<key>` + meta
  obok jako `<key>.meta.json`. Zapis atomowy (`writeFileAtomic`).
- **StateStore na plikach** - `<baseDir>/state/<runId>.json`, wersja = sha256.
  Lock katalogowy z exponential backoff (łącznie 2 s).
- **HumanChannel na plikach markdown** - `<baseDir>/reports/<runRef>/<reportId>.md`
  (+ `.json` z danymi). Ten sam `reportId` = update, nie duplikat.
- **"PR"** - `openPullRequest` zapisuje JSON do `<baseDir>/prs/`.

Config: `platform: '@greenproof/adapter-fs'`, `platformOptions: { repoDir, baseDir }`.

## Przykład: adapter-github

Pełny plik: `packages/adapter-github/src/index.ts`. Kształt:

```ts
// platformOptions: {
//   owner: string; repo: string;
//   tokenEnv?: string;          // domyślnie 'GITHUB_TOKEN'
//   stateBranch?: string;       // domyślnie 'greenproof/state'
//   artifactsBranch?: string;   // domyślnie 'greenproof/artifacts'
//   repoDir?: string;           // lokalny checkout → włącza realny push()
//   baseUrl?: string;           // GitHub Enterprise: https://ghe.firma.pl/api/v3
// }
const createGithubPlatform: PlatformFactory = ({ config, secrets, logger }) => {
  const options = parseOptions(config);
  const tokenEnv = options.tokenEnv ?? 'GITHUB_TOKEN';
  const token = secrets.get(tokenEnv);
  if (!token) throw new Error(`missing GitHub token - set ${tokenEnv}`);
  const octokit = new Octokit({ auth: token, baseUrl: options.baseUrl });
  return createGithubPorts({ octokit, owner, repo, logger, secrets, ... });
};
export default createGithubPlatform;
```

Cechy szczególne:

- **Bez lokalnego checkoutu** - branche i PR-y przez git data API
  (blob → tree → commit → ref). Wyjątek: opcjonalny `push()` gdy `repoDir`
  ustawione.
- **Token z portu sekretów, nigdy z configu** - `secrets.get(tokenEnv)`.
  Domyślna nazwa zmiennej to `GITHUB_TOKEN` (kompatybilne z GitHub Actions).
- **ArtifactStore** na dedykowanym branchu (`greenproof/artifacts`,
  orphan). Ścieżka `<runId>/<key>`, metadane obok jako `<key>.meta.json`.
  Zapis per plik (bez batchowania), wyścig na refie → retry z ponownym
  odczytem heada (`MAX_ATTEMPTS = 3`). Kolejność artefaktów nie ma znaczenia,
  więc powtórzenie commita jest bezpieczne.
- **StateStore** na ORPHAN branchu `greenproof/state`. Jeden plik
  `<runId>.json` per przebieg, wersja = sha BLOBU tego pliku, CAS = porównanie
  sha blobu + `updateRef(force:false)` z retry na przesunięty head. Równoległe
  runy na tym samym repo nie kolidują - zob. sekcja StateStore powyżej.
- **HumanChannel** na komentarzach do issue. `runRef` = numer issue
  (`parseIssueNumber`). Idempotencja: pierwszy wiersz komentarza to
  niewidoczny marker `<!-- greenproof:report:<reportId> -->`. Ten sam
  reportId = update istniejącego komentarza, nie kolejny duplikat.
  Limit długości JSON-a w `<details>` to `MAX_DATA_CHARS = 8_000`
  (limit komentarza ~65k).
- **ScmPort** używa `globToRegExp` do tłumaczenia globów na regex dla
  `git ls-tree` po API. Wewnętrzny `ScmConflictError` jest konwertowany na
  `StateConflictError` przez rdzeń (oba są rozpoznawane po nazwie klasy,
  nie `instanceof`, bo rdzeń i adapter mogą mieć osobne kopie zod).

Konfiguracja: `platform: '@greenproof/adapter-github'`, `platformOptions:
{ owner, repo, tokenEnv, repoDir? }`. Pełny przykład: `examples/github-workflow/greenproof.config.example.mjs`.

## Checklista testów adaptera

Pakiet `@greenproof/testing` (`packages/testing/src/fakes/`) daje
referencyjne implementacje portów na potrzeby testów adaptera:

- `InMemoryScm` - pełny `ScmPort`, z historią commitów i PR-ów.
- `InMemoryArtifactStore` - pełny `ArtifactStore` w pamięci.
- `InMemoryStateStore` - pełny `StateStore` (prosty, bez CAS - do testów
  adapterów WYŻEJ, nie do testów rdzenia z CAS).
- `CapturingHumanChannel` - zbiera `HumanReport` zamiast wysyłać.
- `FixedClock`, `TestLogger`, `EnvSecrets` - deterministyczne implementacje
  `Clock`/`Logger`/`SecretsPort`.
- `makeFakePorts(overrides?)` - komplet `Ports` z powyższych.

Checklista:

1. **Idempotencja.** Wywołaj tę samą operację dwukrotnie (np. `commitFiles`,
   `postReport` z tym samym `reportId`, `ensureBranch` na istniejącym
   branchu, `openPullRequest` dla pary z istniejącym PR-em) i zweryfikuj,
   że drugie wywołanie zwraca istniejący obiekt / no-op, a nie tworzy
   duplikatu.
2. **CAS na StateStore.** Dwa równoległe `load` + `save` z tą samą
   `expectedVersion` - drugi `save` rzuca `StateConflictError`. Tworzenie
   (`expectedVersion: null`) dwukrotnie dla tego samego `runId` też rzuca
   `StateConflictError`. Odwrotnie: zapisy DWÓCH różnych `runId` nie mogą
   kolidować, nawet gdy adapter trzyma je we wspólnym magazynie.
3. **HumanChannel idempotentny po `reportId`.** Pierwsze `postReport`
   z `reportId = 'gp-…:roster'` tworzy raport. Drugie z tym samym
   `reportId` go aktualizuje, nie tworzy kolejnego. (W adapter-github:
   sprawdź, że drugi komentarz NIE pojawił się na issue.)
4. **ScmPort: glob + branch detection.** `listFiles` na branchu
   z draftem (`author/<caseId>`) zwraca pliki speca; na czystym refie
   bazowym zwraca już zaakceptowane spec.
5. **Puste/nieistniejące `get` zwraca `null`, nie rzuca.** Sprawdź
   `ArtifactStore.get` i `StateStore.load` dla nieznanego `runId`/klucza.
6. **Push zablokowany poza adapterem.** Hook agenta (`PreToolUse`) odmawia
   `git push`, `gh pr`, `gh release`, `gh repo`. Test: agent w sesji
   próbuje pushować → dostaje `deny`. Jedyna droga do repo testów =
   `accept`, który woła `ScmPort.openPullRequest`.
7. **Determinizm w testach.** Użyj `FixedClock` i `TestLogger` zamiast
   `new Date()` / `console.*` - logi i timestampy muszą być stabilne.
8. **Błędy konfigu mają czytelne komunikaty.** `parseOptions` rzuca
   `Error` z wypisanym brakującym polem (`platformOptions is missing
   required string field(s): owner, repo`). Brak sekretu = komunikat
   z nazwą zmiennej (`missing GitHub token - set GITHUB_TOKEN`).
9. **Round-trip przez prawdziwy rdzeń.** Użyj `cmdFilter`, `cmdTriage`,
   `cmdAuthor` (z fake'owym modelem, np. `InMemoryScm` + test
   deterministyczny) z adapterem zamiast fake'ów - to łapie rozjazdy
   między kontraktem a implementacją, których testy jednostkowe adaptera
   nie zauważą.
10. **Bezpieczeństwo kluczy.** Token NIGDY nie pochodzi z configu -
    tylko z `SecretsPort.get(tokenEnv)`. Sprawdź, że adapter nie ma
    fallbacku na plaintext w configu (wzor: `adapter-github/src/index.ts`
    rzuca Error gdy brak sekretu).
