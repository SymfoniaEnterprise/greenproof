# Konfiguracja i uruchamianie

Jak skonfigurować greenproof i odpalić przebieg: presety, flagi, wejście
komend, zmienne środowiskowe. **Pole po polu, co znaczy każde ustawienie
w configu: [config-reference.md](config-reference.md).**

Config to obiekt wczytany z pliku wskazanego przez `--config`. CLI akceptuje
`.json`, `.yaml`, `.yml`, `.mjs`, `.js`, `.cjs` (export `default`); `.ts` NIE
jest obsługiwane - skompiluj albo użyj `.mjs`. Podajesz wyłącznie to, co
zmieniasz - reszta pól dostaje wartości domyślne ze schematu.

## Szybki start: `run --init-only` + `run`

Config generuje `gp run --tests-repo <p> --init-only` wprost z repozytorium
testów (musi istnieć katalog `.git`). `--tests-repo` wskazuje **repo testów** -
miejsce, w którym greenproof zapisuje testy. Testowana aplikacja to co innego:
podajesz ją przez `--app-url`.

Presety to punkty startowe per provider - `codex-sub` (domyślny, subskrypcja
przez mostek OAuth), `litellm` (brama LiteLLM), `claude-sub` (API
Anthropic wprost). KAŻDE pole modelu nadpiszesz flagą, więc dowolna kombinacja
provider+model nie wymaga ręcznej edycji pliku:

**Preset `litellm` wymaga `--author`.** Aliasy modeli w bramie są
instalacyjne - u każdego wpisy nazywają się inaczej - więc preset nie zgaduje
i zapisuje placeholder `<model-z-bramy>`. Dopóki tam zostaje, preflight
przerywa run z instrukcją zamiast wysyłać do bramy nieistniejącą nazwę. Listę
realnych nazw daje `gp models`. Presety subskrypcyjne placeholdera nie mają:
tam nazwy narzuca mostek i są takie same u wszystkich.

```sh
# Preset bez zmian (token w env wg presetu: CLIPROXY_TOKEN / LITELLM_KEY / ANTHROPIC_AUTH_TOKEN):
gp models --config <config>        # najpierw sprawdź, co wystawia TWOJA brama
gp run --tests-repo /ścieżka/do/repo-z-testami --init-only --preset litellm \
  --author <nazwa-z-listy-wyżej>

# Ten sam preset, inny model autora i eskalacja wyłączona:
gp run --tests-repo /ścieżka/do/repo-z-testami --init-only --preset litellm \
  --author gemini-3.7-openrouter --fixture-author none
```

`--fixture-author <model>|auto|none` ustawia model eskalacji - eskalacja
dziedziczy endpoint i token autora (inny provider podasz w configu). `auto`
(lub brak flagi) pyta bramę o `/v1/models` i wybiera pierwszy dostępny model
z rankingu presetu; gdy lista niedostępna albo nic nie pasuje - używa modelu
eskalacji z presetu (a gdy preset go nie ma, zostawia eskalację wyłączoną).
Nadpisany model autora oraz model eskalacji spoza presetu dostają zerowy wpis
`priceTable` - uzupełnij realne stawki, jeśli chcesz twardych capów
kosztowych.

Sekrety: tokeny zakładamy już w środowisku - albo plik `.env` obok configu,
który CLI wczytuje sam (istniejące env zawsze wygrywa). Nie commituj `.env`.

Generowanie configu zapisuje ścieżkę repo testów w `paths.testsRepoDir`, więc
dalej `run --config <config>` już jej nie potrzebuje.

Przebieg to jedna komenda (endpoint najpierw przechodzi preflight). Dwa
warianty - gotowy config z repo ALBO customizacja od zera:

```sh
# Wariant A: gotowy config (configs/litellm|codex|claude.config.mjs - model
# w jednym oznaczonym miejscu, token w configs/.env). --tests-repo wskazuje
# repo testów, bo gotowe configi nie mają go wbitego:
gp run --config configs/litellm.config.mjs \
  --tests-repo ~/dev/moje-testy \
  --in plan.json --app-url http://localhost:3132

# Wariant B: od zera - repo testów i config powstają same przy 1. uruchomieniu:
gp run --preset litellm --author <model-z-bramy> \
  --tests-repo ~/dev/moje-testy \
  --in plan.json --app-url http://localhost:3132
```

`--in` przyjmuje albo gotowy `FilterInput` (JSON), albo plik planu - plan JSON
albo format parsera (BMAD); źródło wybiera config (`plan.source`). Przy planie
`--app-url` jest wymagane (envUrl nie ma skąd wziąć). Scaffold repo testów
(git init, playwright, struktura katalogów) jest idempotentny - istniejące repo
z `package.json` nie jest ruszane.

Gotowe configi referencyjne do edycji leżą w [`configs/`](../configs/). Pełne
demo od zera (appka + repo testów + config + run) to `pnpm demo` - patrz README.

## Plik `--in` - wejście komendy

Każda komenda pipeline'u przyjmuje dokładnie jedno wejście: **obiekt JSON**
walidowany schematem zod właściwym dla tej komendy (definicje:
`packages/core/src/schemas/io.ts`). `--in <ścieżka>` wskazuje **plik** z tym
obiektem - nie inline JSON w argumencie; niepoprawny JSON albo pola niezgodne
ze schematem = czytelny błąd walidacji przed jakąkolwiek pracą.

Pola per komenda (`?` = opcjonalne):

| Komenda | Schemat | Pola |
|---|---|---|
| `run` / `step filter` | `FilterInput` | `runId?`, `slug`, `envUrl`, `ref`, `runRef`, `plan` |
| `step triage` | `TriageInput` | `runId`, `caseId?` (bez = wszystkie wybrane) |
| `step author` | `AuthorInput` | `runId`, `caseIds?` (bez = wszystkie po triażu) |
| `step deliver` | `DeliverInput` | `runId` |
| `retry` | `RetryInput` | `runId`, `caseId`, `notes?` - uwagi dla następnej próby; trafiają do promptu autora obok digestu próby poprzedniej |
| `accept` | `AcceptInput` | `runId`, `caseId`, `targetBranch` |
| `release` | `ReleaseInput` | `runId`, `waivers?` (`[{caseId, reason}]`) |
| `fixture` | `FixtureInput` | `runId`, `mode?` (`case`/`preventive`), `caseId` (wymagane w `case`), `types?` (tylko `preventive`) |
| `status` | `StatusInput` | `runId`; z flagą `--cases` dokłada per-case rollup z ledgerów prób |
| `models` | - | bez wejścia, read-only: `GET /v1/models` → `{ endpoint, available, models, note? }`. Brama bez listy modeli (404, timeout, nieznany kształt) daje `available: false` z notą i **exit 0** - to cecha bramy, nie błąd użytkownika |
| `clean` | `CleanInput` | `runId`, `caseIds?`, `purge?`, `dryRun?`, `branches?` |

Przykład - retry case'a z uwagami (`retry.json`):

```json
{
  "runId": "gp-hr-payroll-benchmark-v1-…-20260816T0920",
  "caseId": "employee-optimistic-lock",
  "notes": "Nie eksploruj appki od nowa: od razu edycja pracownika w dwóch kontekstach i asercja konfliktu wersji."
}
```

```sh
gp retry --config configs/codex.config.mjs \
  --tests-repo ~/dev/moje-testy --in retry.json --out wynik.json
```

Wynik komendy to też JSON (stdout albo `--out <plik>`), walidowany
odpowiadającym schematem `*Output` - nadaje się do maszynowego łańcuchowania
kroków w CI.

## Flagi CLI i zmienne środowiskowe

### Flagi

- `--config <p>` - plik konfiguracyjny. Jawny `--config` wyłącza autodetekcję.
  Bez `--config` CLI szuka `greenproof.config.<ext>` najpierw w cwd, potem
  w katalogu z `GREENPROOF_TESTS_REPO` (pierwszy trafiony wygrywa) i loguje,
  który plik wybrał i skąd.
- `run --tests-repo <p> --init-only [--preset codex-sub|litellm|claude-sub]` - generuje
  `<tests-repo>/greenproof.config.mjs` (domyślny preset: `codex-sub`);
  `--config <p>` zmienia cel, a `--force` pozwala nadpisać istniejący plik.
- `--author` / `--base-url` / `--token-env` / `--fixture-author <model>|auto|none`
  - nadpisania pól presetu (`run --init-only`, oraz `run` przy pierwszorazowej
  konfiguracji z `--tests-repo` bez `--config`). Eskalacja dziedziczy endpoint
  i token autora.
- `--tests-repo <p>` - repo testów do przebiegu. Bez `--config` jest kotwicą do
  `<p>/greenproof.config.mjs` dla KAŻDEJ komendy (nie tylko `run`): `run` przy
  braku pliku robi scaffold repo + generowanie configu od zera, pozostałe komendy kończą się
  błędem z podpowiedzią (`gp run --tests-repo <p> --init-only` albo jawny `--config`). Z `--config` wskazuje,
  na którym repo działać (ustawia `GREENPROOF_TESTS_REPO`).
- `run / step filter --in <p>` - JEDYNA flaga wejścia filtra: gotowy `FilterInput`
  JSON ALBO plik planu (JSON albo format parsera wg `plan.source`); plan
  wymaga `--app-url`. Flaga `--plan` nie istnieje. Gdy plik nie jest ani
  `FilterInputem`, ani planem, CLI wypisuje jeden błąd z obiema przyczynami
  (exit 2).
- `--app-url <url>` - adres testowanej aplikacji (`envUrl`); wymagany, gdy
  `--in` to plik planu.
- `--ref <r>` - ref bazowy repo testów (domyślnie `main`).
- `--in <p>` - plik JSON z wejściem komendy (walidowany schematem).
- `--out <p>` - zapisz JSON wyniku do pliku (stdout dostaje go zawsze).
- `--run <id>` - uzupełnia/nadpisuje `runId` w wejściu (działa też razem
  z `--in` - flaga wygrywa nad polem z pliku); dla `status`/`step deliver`
  wystarcza sam `--run`.
- `--help`, `--version`.
- `--no-auto-accept` - wyłącza automatyczną akceptację case'ów po deliver
  (stare zachowanie: człowiek klika `accept` per case). Dostępne wyłącznie
  dla `run`; równoważne `gates.autoAccept: false` w configu.

### Zmienne środowiskowe

- `GREENPROOF_DEBUG=1` - włącza logi debug na stderr.
- `GREENPROOF_WORK_DIR` - katalog roboczy prób autora (przestrzeń runnera,
  patrz `cmdAuthor`).
- `GREENPROOF_PROGRESS` - widok postępu na stderr (`auto`/`tty`/`plain`/
  `github`/`json`/`off`); domyślnie w terminalu tablica statusu odświeżana
  w miejscu. Opis wartości niżej.
- `GREENPROOF_SKIP_INSTALL=1` - pomija `npm install` w scaffoldzie repo
  testów (`run --tests-repo` na pustym katalogu) - przydatne w testach/CI.
- `GREENPROOF_ALLOW_DIRTY_TESTS_REPO=1` - wyłącza bramkę odmawiającą startu,
  gdy repo testów ma niezacommitowane zmiany w plikach ŚLEDZONYCH. Bramka
  istnieje, bo autor przełącza branche i robi `git add -A` w tym repo - bez
  niej cudza niezacommitowana praca wsiąka w commit case'a. Włączaj tylko
  świadomie; użycie loguje ostrzeżenie z listą brudnych plików.
- Plik `.env` obok configu wczytywany jest automatycznie (istniejące env
  wygrywa) - nie commituj `.env`.
- Pozostałe sekrety czytane z env po nazwach z configu (`model.authTokenEnv`
  itd.).

## Kody wyjścia

Kod wyjścia jest kontraktem dla platformy i joba CI: mówi, czy krok wolno
ponowić, czy trzeba wołać człowieka.

| Kod | Znaczenie | Gdzie |
|---|---|---|
| `0` | OK | wszędzie |
| `1` | Błąd infrastruktury / nieznany - platforma może ponowić krok | wszędzie |
| `2` | Walidacja wejścia lub konfigu (ZodError, zły plik, nieznana komenda, brak runa) | wszędzie; dodatkowo `preflight` (endpoint niezdatny dla silnika autora), `clean` (platforma bez `delete`), `knowledge lint` (`ok=false`) |
| `3` | Co najmniej jeden case `blocked`/`attempt_failed`/`failed` | `run`, `step author`, `retry`; `fixture` przy `ok=false` |
| `4` | `StateConflictError` - ponów krok (load → mutacja → save obronił się CAS-em) | wszędzie |
| `5` | Bramki jakości nie przeszły (`pass=false`) | `release` |
| `10` | Filter nie wybrał żadnego case'a (pusty roster) | `run`, `step filter` |

Co zrobić z każdym kodem podczas prowadzenia przebiegu:
[`skills/greenproof-cli.md`](../skills/greenproof-cli.md), sekcja „Kody wyjścia".

## Śledzenie postępów (`GREENPROOF_PROGRESS`)

Podczas długich komend (`author`, `fixture`, `retry`) CLI pokazuje na **stderr**
żywy postęp: bieżący case i próbę, model, tury/czas/koszt vs capy, pule
playwright (assert/proof), rollup runu. Stdout pozostaje czystym JSON-em
wyniku, więc harnessy i CI niczego nie parsują inaczej.

- `auto` (domyślna) - GitHub Actions (`GITHUB_ACTIONS=true`) → `github`;
  stderr będący TTY → `tty`; inaczej `plain`.
- `tty` - tablica statusu w ramce, odświeżana w miejscu (ANSI, kolory;
  `NO_COLOR` je wyłącza).
- `plain` - pojedyncze linie `[gp HH:MM:SS] …`: zdarzenia kluczowe zawsze,
  tury throttlowane do jednej linii na 30 s. Bezpieczne dla logów CI.
- `github` - linie jak `plain` + zwijane grupy `::group::` per case; na końcu
  komendy tabela per case dopisywana do Job Summary (`$GITHUB_STEP_SUMMARY`).
- `json` - każde zdarzenie jako NDJSON na stderr (konsumpcja maszynowa).
- `off` - brak emisji.

W tablicy `assert` to pula runów fazy assert (`caps.maxPlaywrightRuns`),
`proof` - osobna pula fazy dowodu (`caps.proofRuns`, odblokowywana po drugim
zielonym runie), `green` - licznik zielonych runów, czyli to, czego wymaga
dowód mutacyjny.

Ten sam rollup jest dostępny post-hoc w polu `summary` wyniku komendy
`status`. Flaga `--cases` dokłada per-case rollup z ledgerów prób (`cases`)
oraz sumy (`totals`): próby, tury, runy playwright, koszt, reużyte POM-y,
sekwencja wyników i powód blokady. W `totals` są DWA koszty - `costUsd` (suma
z ledgerów prób) i `costUsdState` (ze stanu); różnicę robią sesje fixture.
