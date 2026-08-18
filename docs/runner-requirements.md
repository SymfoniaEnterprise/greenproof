# Wymagania środowiska CI (runner requirements)

Co job CI musi mieć zainstalowane, jakie sekrety podać i jak ustawić timeout,
żeby pipeline greenproof działał end-to-end. Wszystkie wartości poniżej są
wprost z `package.json`/`packages/cli/...`/kontraktów rdzenia - nie są
rekomendacjami.

Wspierane systemy runnera: Linux, macOS i Windows natywnie (cmd/PowerShell,
bez WSL). Windows nie jest deklaracją - potwierdza go workflow
`.github/workflows/windows.yml`: macierz `ubuntu-latest`/`windows-latest` dla
`pnpm install`/`build`/`test` plus job, który na `windows-latest` naprawdę
odpala CLI (`run --init-only` przechodzi przez `cmd.exe` przy `npm install`,
repo testów leży w katalogu ze spacją, dane runu lądują w `%LOCALAPPDATA%`).
Job nie używa żadnych sekretów ani bramy modeli, więc nie potwierdza sesji
autora na Windowsie - tylko warstwę uruchomieniową pod nią.

## Warstwy środowiska

### 1. Node.js >= 20

`package.json` (root): `"engines": { "node": ">=20" }`. Referencyjne
workflow (`examples/github-workflow/e2e-start.yml`) używają
`actions/setup-node@v4` z `node-version: 22`.

### 2. pnpm

Monorepo używa `pnpm@11.6.0` (`packageManager` w root `package.json`).
Workflow woła `pnpm/action-setup@v4`. Instalacja:

```sh
pnpm install --frozen-lockfile
```

`pnpm --filter @greenproof/cli build` buduje binarkę `packages/cli/dist/main.js`,
którą referencyjne workflow wołają jako `pnpm exec grp …`. Jeśli
publikujesz CLI jako pakiet (`@greenproof/cli`) i instalujesz w innym
repo - wystarczy samo `pnpm install`, buildu nie trzeba powtarzać.
Na runnerze/CI wrapper `grp`/`greenproof` z `pnpm setup-cli` jest zbędny - job
woła wprost `node packages/cli/dist/main.js` po `pnpm build` (albo instaluje
pakiet z rejestru, gdy będzie publikowany). Lokalnie `pnpm setup-cli` działa na
wszystkich trzech systemach: na Linuksie i macOS zakłada skrypty bashowe w
`~/.local/bin`, na Windowsie pliki `.cmd` w `%LOCALAPPDATA%\greenproof\bin`
(cmd.exe znajduje je przez PATHEXT). Wrapper przekazuje kod wyjścia CLI, więc
`grp step author || [ $? -eq 3 ]` i jego windowsowe odpowiedniki działają tak
samo jak wywołanie `node …/main.js`.

Pwsh-izm, o którym trzeba pamiętać pisząc kroki CI (`shell: pwsh` to domyślna
powłoka runnerów `windows-*`): Actions doklejają na koniec każdego kroku `pwsh` linijkę
`if ((Test-Path -LiteralPath variable:\LASTEXITCODE)) { exit $LASTEXITCODE }`.
Krok, który świadomie sprawdza NIEZEROWY kod wyjścia greenproofa (3/5/10 albo 2)
i na tym kończy, wyjdzie tym właśnie kodem i zaświeci się na czerwono mimo
zaliczonych asercji - trzeba go domknąć jawnym `exit 0`.

### 3. Claude Code CLI

Rdzeń używa `@anthropic-ai/claude-agent-sdk` (`packages/core/src/author/session.ts`),
który sam woła Claude Code CLI jako subprocess. SDK instaluje je przy
`pnpm install` jako zależność przechodnią - nie trzeba osobnego kroku
instalacji. Nie wywołuj `claude` ręcznie w jobie; całą interakcję z modelem
robi rdzeń przez SDK.

### 4. Przeglądarka dla Playwright

Faza `assert` autora uruchamia `playwright test` (cap: `caps.maxPlaywrightRuns`,
domyślnie 6). Jedyny wymagany silnik to chromium:

```sh
pnpm exec playwright install --with-deps chromium
```

Referencyjne workflow wołają to w krokach obu jobów (`e2e-start.yml`,
`e2e-decision.yml`). Bez tego sesja agenta padnie na pierwszym uruchomieniu
testu.

### 5. Brama modeli

Rdzeń czyta model z `config.model` (schemat w `packages/core/src/schemas/config.ts`).
Dwa warianty:

**A. Bezpośrednio Claude (subskrypcja).** Pomiń `model.baseUrl`. SDK
zaadresuje API Anthropic sam. Token nie jest potrzebny (subskrypcja CLI),
ale job musi mieć credentials w `~/.claude/` - tj. CLI musi być
zalogowane na runnerze (jednorazowo w image, albo przez akcję typu
`anthropic-ai/github-action/login@v1` - sprawdź aktualną dokumentację
Anthropic, bo ten krok się zmienia). Model autora: `model.author: 'claude-opus-latest'`
albo `claude-sonnet-…`. `scripts/golden-path.mjs --model opus` jest
przykładem tego wariantu.

**B. Własna brama (np. LiteLLM / firmowy proxy).** Ustaw:

- `model.baseUrl: 'https://litellm.firma.pl'` (URL bramy - NIE Anthropic).
- `model.authTokenEnv: 'LITELLM_KEY'` (nazwa zmiennej z tokenem bramy).
- `model.author: 'claude-sonnet'` (nazwa modelu WIDZIANA PRZEZ BRAMĘ,
  niekoniecznie ta sama co nazwa w API Anthropic).
- `model.digest: 'tani-model'` (opcjonalny, do digestów ledgera).
- `model.priceTable: { 'claude-sonnet': { inPerMTok: 3, outPerMTok: 15,
  cacheReadPerMTok: 0.3, cacheWritePerMTok: 3.75 } }` - WŁASNE liczenie
  kosztu. Źródło prawdy dla capa kosztowego, bo `total_cost_usd` z SDK
  bywa błędny dla customowych nazw modeli za bramą.

Sekret w jobie:

```yaml
env:
  LITELLM_KEY: ${{ secrets.LITELLM_KEY }}
```

Albo `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` - to są nazwy zmiennych,
których SDK szuka bezpośrednio, gdy `model.baseUrl` / `model.authTokenEnv`
nie są ustawione.

### 6. Sekrety platformy

Per adapter. Dla adapter-github:

- `GITHUB_TOKEN` (domyślna nazwa; zmienisz przez `platformOptions.tokenEnv`)
  - PAT z uprawnieniami do zapisu (branche, commity, PR-y, komentarze
  do issue). W workflow: `${{ secrets.GREENPROOF_TOKEN }}`.
- Dla adapter-fs: żadne, operuje na lokalnym repo.

### 7. Sekrety aplikacji poddawanej testom

Jeśli demo-app albo SUT wymaga loginu (jak DemoPay), dane testowe
przekaż jako `process.env` wewnątrz fazy act (autor ma dostęp do env
processu sesji). Wzorzec: README appki DemoPay (`~/dev/demopay-demo/README.md`) opisuje
`demo / demo123`.

## Zmienne środowiskowe per komenda

| Komenda    | Wymaga                                              |
|------------|-----------------------------------------------------|
| `step filter`  | sekret platformy (`GITHUB_TOKEN` dla adapter-github) |
| `step triage`  | sekret platformy                                     |
| `step author`  | sekret platformy + sekret modelu (`LITELLM_KEY`/`ANTHROPIC_AUTH_TOKEN`) + `GREENPROOF_WORK_DIR` |
| `step deliver` | sekret platformy                                     |
| `retry`    | sekret platformy + sekret modelu + `GREENPROOF_WORK_DIR` |
| `accept`   | sekret platformy                                     |
| `release`  | sekret platformy                                     |
| `status`   | sekret platformy                                     |
| `knowledge init` / `knowledge lint` | żadnego - operuje na filesystemie |

`GREENPROOF_WORK_DIR` (tylko dla `author` i `retry`): katalog roboczy
prób autora. To jest przestrzeń robocza runnera - checkout repo testów,
tam narzędzie `run_playwright` wykonuje testy i wersjonuje raporty
(`pw-runs/`). **Lokalnie (adapter-fs, harnessy) używaj TRWAŁEJ lokalizacji**
- np. `~/.local/share/greenproof/runs/<runId>` - nigdy `/tmp`: reboot
kasuje workdiry, a artefakty case'a wolno usuwać dopiero po jego release
(świadomą komendą `grp clean`, nie efektem ubocznym).
Wzorzec w workflow: ustaw na
`${{ runner.workspace }}/…` albo na katalog, w którym `actions/checkout@v4`
zrobił checkout z `fetch-depth: 0` (konieczne, bo branche autora
wychodzą z ref-a bazowego - `e2e-start.yml` używa `fetch-depth: 0`).

`GREENPROOF_DEBUG=1` włącza logi debug na stderr (przydatne do strojenia,
głośne - nie zostawiaj w normalnych jobach).

## Timeout jobów

Filtr liczy dynamiczny `timeoutMinutes` partii z configu
(`packages/core/src/steps/filter.ts`):

```
timeout = min(timeoutBaseMin + timeoutPerCaseMin × selectedCount, timeoutCapMin)
```

Domyślne wartości (`packages/core/src/config/types.ts`):

- `timeoutBaseMin: 20`
- `timeoutPerCaseMin: 25`
- `timeoutCapMin: 340`

Dla 2 case'ów = `min(20 + 25×2, 340) = 70 min`. Dla 10 = `min(20 + 250,
340) = 270 min`. Filtr zwraca tę wartość w `FilterOutput.timeoutMinutes`,
a `examples/github-workflow/e2e-start.yml` ustawia `timeout-minutes` joba
autora wprost z tego pola:

```yaml
author:
  needs: filter
  timeout-minutes: ${{ fromJSON(needs.filter.outputs.timeout) }}
```

**Dlatego `step filter` i `step author` to OSOBNE joby, nie kroki tego samego
joba** - timeout musi być znany PRZED uruchomieniem autora.

Job `decide` (retry/accept/release w `e2e-decision.yml`) ma statyczny
`timeout-minutes: 60`. To wystarcza, bo:

- `retry` robi jedną próbę dla jednego case'a (nie całą partię).
- `accept` to jeden commit + PR.
- `release` jest deterministyczny (bez agenta).

## Konkretny job startowy (wzorzec)

Minimalnie wystarczy `examples/github-workflow/e2e-start.yml`. Kluczowe
kroki:

```yaml
- uses: actions/checkout@v4
  with: { fetch-depth: 0 }                # branche autora z ref-a bazowego
- uses: pnpm/action-setup@v4
- uses: actions/setup-node@v4
  with: { node-version: 22, cache: pnpm }
- run: pnpm install --frozen-lockfile
- run: pnpm exec playwright install --with-deps chromium

- name: grp step filter
  env:
    GITHUB_TOKEN: ${{ secrets.GREENPROOF_TOKEN }}
  run: |
    pnpm exec grp step filter --config greenproof.config.mjs \
      --in filter-in.json --out filter-out.json

- name: step triage + step author + step deliver
  env:
    GITHUB_TOKEN: ${{ secrets.GREENPROOF_TOKEN }}
    LITELLM_KEY: ${{ secrets.LITELLM_KEY }}
    GREENPROOF_WORK_DIR: ${{ runner.workspace }}/work
  run: |
    jq -n --arg run "$RUN_ID" '{runId: $run}' > run.json
    pnpm exec grp step triage  --config greenproof.config.mjs --in run.json
    pnpm exec grp step author  --config greenproof.config.mjs --in run.json || [ $? -eq 3 ]
    pnpm exec grp step deliver --config greenproof.config.mjs --in run.json
```

`exit 3` z `step author` (częściowy sukces - część case'ów zablokowana) NIE ma
wywracać joba; `deliver` zamelduje te case'y człowiekowi przez
`HumanChannel`. Job ma `needs: filter` z `if: needs.filter.outputs.selected
!= '[]'`, więc pusty roster (`exit 10`) nie odpali autora.

## Co NIE jest wymaganiem środowiska

- **Baza danych demo-app** - SQLite (`node:sqlite DatabaseSync`), tworzona
  automatycznie przy starcie (w DemoPay: `~/dev/demopay-demo/src/db.js`). W CI
  demo-app żyje w osobnym jobie (albo procesie w tle) na porcie z `PORT`.
- **Żaden serwer WWW osobno dla greenproof** - to CLI + agent, nie serwer.
- **WebHooki do greenproof** - brak. Komunikacja z człowiekiem jest
  WYŁĄCZNIE przez adapter (`HumanChannelPort` jest wyłącznie wychodzący,
  zob. `docs/adapters.md`). Decyzje człowieka (`/retry`, `/accept`,
  `/release`) to zdarzenia platformy tłumaczone przez workflow na
  wywołania CLI - rdzeń nie nasłuchuje.
