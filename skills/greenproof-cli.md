# Skill: greenproof-cli - odpalanie testów E2E przez CLI

Jeśli konfigurujesz greenproof po raz pierwszy, zacznij od wywiadu onboardingowego w `skills/greenproof-start.md` - niniejszy skill jest przeznaczony dla kogoś, kto posiada już gotowy config.

Przepis operacyjny na uruchomienie przebiegu greenproof. Szczegóły pól configu:
`docs/configuration.md`. Modele/mostki: `docs/model-bridges.md`. Pełna tabela
komend i kodów wyjścia: `README.md`.

## 0a. ZASADA: run odpala CZŁOWIEK w terminalu, nigdy agent w tle

Przebieg greenproof uruchamia się **wyłącznie w interaktywnej sesji terminala
użytkownika**. Agent AI podaje gotową komendę do skopiowania - i na tym kończy
swoją rolę w starcie runu.

Agent NIE odpala runu:
- w tle własnej sesji (`run_in_background`, `&`, `nohup`),
- przez `systemd-run --user`,
- ani w żaden inny sposób „za użytkownika".

Powód jest praktyczny, nie ceremonialny:

- **Widok postępu ma sens tylko na TTY.** Renderer `tty` rysuje tablicę
  odświeżaną w miejscu (cursor-up + erase-down). Bez terminala degraduje się do
  strumienia linii, a wiadomość w czacie AI i tak się nie przerysowuje -
  „podgląd na żywo" przez agenta to iluzja wymagająca ręcznego odpytywania.
- **Run trwa godzinami** (lokalny model na trudnej appce: 4–10 h). Sesja agenta
  nie jest do tego stworzona; procesy w tle bywają ubijane razem z nią.
- **Przerwanie i wznowienie należy do człowieka.** Ctrl+C w terminalu jest
  natychmiastowe i jednoznaczne; ubijanie procesów po PID z drugiej sesji
  kończyło się już zabiciem cudzej pracy i osieroconymi żądaniami na GPU.
- **Runy lokalne konkurują o jeden slot modelu.** Uruchomienie „w tle" przez
  agenta ukrywa fakt zajętego GPU przed użytkownikiem, który zaraz odpali drugi.

Rola agenta przy starcie runu:

1. sprawdzić warunki wstępne (aplikacja odpowiada, model załadowany z właściwym
   kontekstem, GPU wolne),
2. **podać jedną komendę do wklejenia** - z pełnymi ścieżkami, bez `export`
   (sekrety z `configs/.env`),
3. po starcie: czytać stan z plików (`~/.local/share/greenproof/*/platform/state/`,
   `--out`), nie z własnego stdout.

Wyjątek dotyczy wyłącznie krótkich sond diagnostycznych (preflight, `curl` do
bramy, `grp status`) - te agent wykonuje sam, bo trwają sekundy i nic nie zajmują.

## 0. Warunek wstępny: aplikacja testowana MUSI działać

Pipeline steruje przeglądarką przeciw żywej aplikacji pod adresem `envUrl`
(flaga `--app-url`). Zanim cokolwiek odpalisz, sprawdź, że odpowiada:

```sh
curl -sSf -o /dev/null -w '%{http_code}\n' <adres-appki>   # np. http://localhost:3132
```

Nie odpowiada → uruchom aplikację (na tej maszynie appki demo żyją poza repo:
`~/dev/demopay-demo`, `~/dev/hr-payroll-demo`; u innego użytkownika będzie to
jego aplikacja) i dopiero wtedy startuj run.

Binarka: `grp` jest formą domyślną; `greenproof` działa jako pełny alias. Jeśli
nie ma żadnej na PATH, wrappery zakłada się jednym poleceniem (z korzenia repo):

```sh
pnpm setup-cli
```

Po zmianach w `packages/*/src` przebuduj `npx tsc -b`, bo wrapper bierze `dist`.

Wyjątek: benchmarki na trudnej appce to też JEDNA komenda -
`node scripts/benchmark-path.mjs --model <profil>` (harness sam stawia
aplikację, scaffolduje repo testów i generuje config). To jedyny przypadek,
gdy używamy `node` wprost, bo to skrypt repo, nie CLI.

## 1. Wybierz wariant konfiguracji

**Wariant A - gotowy config z `configs/`** (najszybszy; presety opisane
w `skills/greenproof-config.md`):

```sh
grp run \
  --config configs/litellm.config.mjs \
  --tests-repo ~/dev/moje-testy \
  --in examples/benchmark-plan.json \
  --app-url http://localhost:3132 \
  --out run-result.json
```

`--tests-repo` razem z `--config` ustawia `GREENPROOF_TESTS_REPO` - configi
referencyjne czytają tę zmienną. Bez flagi użyją domyślnej lokalizacji
(`~/.local/share/greenproof/manual-<preset>/tests-repo`), którą `run`
scaffolduje sam (git init + Playwright; idempotentnie).

**Wariant B - od zera, bez gotowego configu**: `--tests-repo` BEZ `--config`.
Config (`<tests-repo>/greenproof.config.mjs`) i scaffold repo testów powstają
przy pierwszym uruchomieniu:

```sh
grp run \
  --tests-repo ~/dev/moje-testy \
  --preset litellm --author claude-sonnet-5 \
  --in plan.json --app-url http://localhost:3132 --out run-result.json
```

**Wariant C - sam config, bez runu**: `grp run --tests-repo <p> --init-only [--preset <p>]`
(wymaga ISTNIEJĄCEGO repo git - inaczej exit 2), potem `run --config`.

**Tip - będąc w repo testów**: z wygenerowanym `greenproof.config.mjs` w cwd
autodetekcja configu sama go znajdzie, więc najkrótsza forma runu to po
prostu:

```sh
grp run --in plan.json --app-url http://localhost:3132
```

`--tests-repo` bez `--config` to kotwica do `<p>/greenproof.config.mjs` dla
KAŻDEJ komendy (nie tylko `run`): `run` przy braku pliku zrobi scaffold + generowanie configu
od zera, reszta komend zgłosi błąd z podpowiedzią.

## 2. Wejście filtra: `--in`

- `--in <filter-input.json>` - gotowy `FilterInput`. Kształt:
  `{ slug, envUrl, ref, runRef, plan }` (`plan` inline albo `{ "path": "..." }`;
  opcjonalnie `runId`).
- `--in <plan.json> --app-url <url>` - plik planu (JSON albo format parsera,
  np. BMAD; źródło wybiera config `plan.source`). `--app-url` jest wtedy
  wymagane - envUrl nie ma skąd wziąć. `FilterInput` (slug, ref, runRef)
  CLI składa sam.
- `--in` to JEDYNA flaga wejścia `run`/`filter` - flaga `--plan` nie istnieje.
  Gdy plik nie jest ani `FilterInputem`, ani planem, CLI wypisuje jeden błąd
  z obiema przyczynami (exit 2).
- `--ref <r>` - ref bazowy repo testów (domyślnie `main`).

## 3. Sekrety

Token czytany jest ze zmiennej środowiskowej o nazwie z configu
(`model.authTokenEnv`: `LITELLM_KEY`, `CLIPROXY_TOKEN`, `ANTHROPIC_AUTH_TOKEN`).
Plik `.env` **obok configu** (np. `configs/.env`) CLI wczytuje automatycznie
przed każdą komendą; zmienna już obecna w środowisku wygrywa. `.env` jest
w `.gitignore` - nigdy go nie commituj i nie wypisuj jego zawartości.

## 4. Co robi `run`

Jedna orkiestracja w jednym procesie: `preflight → filter → triage →
[prewencyjny fixture] → author → deliver → [eskalacje fixture-gap] →
auto-accept → status`. Po deliver pipeline SAM akceptuje case'y spełniające
deterministyczne kryterium (dowód mutacyjny `valid` bez ostrzeżeń + czysty lint
anty-duplikacji selektorów) - reszta zostaje człowiekowi. `release` NIE jest
częścią `run` - to świadoma decyzja człowieka. Auto-akceptację wyłączysz
flagą `--no-auto-accept` (albo `gates.autoAccept: false` w configu), żeby
wrócić do starego zachowania (człowiek klika `accept` per case).

Przy pierwszym uruchomieniu na nowym endpointcie (brama/mostek) zrób osobno:

```sh
grp preflight --config <config>     # ping /v1/messages + wymuszony tool_use
```

Exit 0 = endpoint zdatny. Exit 2 = nie odpalaj autora.

## 5. Kody wyjścia - co robić

| Kod | Znaczenie | Reakcja |
|-----|-----------|---------|
| `0` | OK | czytaj wynik |
| `1` | infrastruktura / nieznane | ponów krok |
| `2` | walidacja wejścia/configu (ZodError, zły plik, preflight `ok:false`) | popraw wejście/config, NIE ponawiaj na ślepo |
| `3` | częściowy sukces - ≥1 case `blocked`/`attempt_failed`/`failed` | normalna sytuacja: czytaj `status.summary`, decyduj per case |
| `4` | `StateConflictError` (CAS) | ponów tę samą komendę |
| `5` | `release` nie przeszedł bramek (`pass=false`) | czytaj `gates`, waiver P1 albo domknij case'y |
| `10` | filtr nie wybrał żadnego case'a | plan pusty albo wszystko już pokryte |

W skryptach: `run`/`author`/`retry` toleruj `3`, `release` toleruj `5`.

## 6. Obserwacja przebiegu

- Stdout = WYŁĄCZNIE JSON wyniku. Stderr = logi i żywy postęp.
- `GREENPROOF_PROGRESS`: `auto` (domyślnie), `tty` (tablica odświeżana
  w miejscu), `plain` (linie `[gp HH:MM:SS] …`, bezpieczne do logów),
  `github`, `json` (NDJSON), `off`.
  W tle/logach używaj `plain`.
- `GREENPROOF_DEBUG=1` - logi debug na stderr.
- Post-hoc rollup: `grp status --config <c> --run <runId>` → pole
  `summary` (`total/done/remaining/passed/failed/skipped/costUsd/turns`
  + `byStatus`).
- Per-case liczby z ledgerów: `grp status --cases --config <c> --run <runId>`
  (próby, tury, runy playwright, koszt, reużyte POM-y, powód blokady) - patrz
  `skills/greenproof-operator.md` §4.

## 7. Po runie - diagnostyka nieudanych case'ów

Trzy kroki, od najtańszego. Szersza wersja (z drabinką decyzji per
`blockedReason`): `skills/greenproof-operator.md` §4.

```sh
# 1) rollup + statusy per case (czysty odczyt, zawsze exit 0)
grp status --config configs/<preset>.config.mjs \
  --tests-repo <repo> --run <runId>          # pole summary + cases[<caseId>]

# 2) ostatni wpis ledgera case'a - TU jest powód porażki
BASE=~/.local/share/greenproof/manual-<preset>/platform
tail -n 1 $BASE/artifacts/<runId>/cases/<caseId>/ledger.jsonl | jq .
#   outcome, blockedReason, turns, playwrightRuns, phases (arrange/act/assert),
#   seedAttempts, lastErrors, humanNotes

# 3) dopiero gdy ledger nie tłumaczy: pełny transkrypt i raporty Playwrighta
less $BASE/artifacts/<runId>/cases/<caseId>/attempt-1.messages.jsonl
ls <repo>/.greenproof-runs/<runId>/<caseId>/attempt-1/pw-runs/   # run-NN-<purpose>.json
```

Stan przebiegu na dysku: `$BASE/state/<runId>.json` (`baseDir` z
`platformOptions` w configu).

Skrót diagnozy: `blocked(fixture-gap)` → `grp fixture`, potem `author`
na ten case (§8);
`blocked(time|turns|budget|playwright-runs)` → podbij cap w configu i/lub retry
z uwagami; `blocked(infra)` → napraw bramę/mostek/appkę, potem retry;
`blocked(other)` z opisem defektu aplikacji → to bug appki, nie porażka autora;
`attempt_failed` → retry z konkretnymi uwagami.

## 8. Po runie - retry i decyzje

Ponowienie jednego case'a z uwagami człowieka (`RetryInputSchema`:
`runId`, `caseId`, opcjonalne `notes`):

```sh
cat > retry-in.json <<'JSON'
{ "runId": "<runId>", "caseId": "<caseId>",
  "notes": "co poszło źle i czego NIE powtarzać (konkretnie)" }
JSON

grp retry --config configs/<preset>.config.mjs \
  --tests-repo <repo> --in retry-in.json --out retry-out.json
```

- Pełna pętla: cofnięcie case'a do `triaged` → triaż → autor (digest
  poprzedniej próby + Twoje `notes`) → `deliver`.
- Exit `0` = dowiezione, `3` = znowu blocked/failed (wróć do §7), `4` = ponów.
- `--app-url` przy `retry` to exit 2 - adres aplikacji bierze się z `envUrl`
  zapisanego w runie. PRZED retry sprawdź, że appka pod tym adresem żyje i że
  nie trwa na niej inny run (stan jest współdzielony!).
- Auto-retry z `caps.maxAutoRetries` już się wydarzył w runie - to jest kolejna,
  ręczna próba.
- `retry` działa na case'ie `blocked`/`attempt_failed`/`failed`/`in_review`.
  Po udanym `grp fixture` case jest już w `triaged` (z gotową wskazówką
  od fixture'a) - wtedy NIE `retry` (exit 1), tylko:

```sh
echo '{"runId":"<runId>","caseIds":["<caseId>"]}' > author-in.json
grp step author --config <c> --tests-repo <repo> --in author-in.json
grp step deliver --config <c> --tests-repo <repo> --run <runId>
```

Pipeline sam akceptuje case'y spełniające kryterium (dowód `valid` + czysty
lint anty-duplikacji) - to NIE jest decyzja agenta ani człowieka, tylko
deterministyczny werdykt dowodu. Ręczna komenda `accept` (dla case'ów, których
pipeline NIE przyjął: dowód invalid, duplikat selektora, blocked) i `release`
(bramki jakości) to decyzje CZŁOWIEKA - uruchamiaj wyłącznie po wyraźnej
zgodzie. Bramki release: P0 fail blokuje bezwzględnie, P1 fail wymaga waivera
na KAŻDY niedomknięty case.

```sh
# accept (RĘCZNE narzędzie: case, którego pipeline nie przyjął; WYMAGA ZGODY)
echo '{"runId":"<runId>","caseId":"<caseId>","targetBranch":"main"}' > accept-in.json
grp accept --config <c> --in accept-in.json

# release: bramki jakości (WYMAGA ZGODY CZŁOWIEKA); waiver tylko dla P1
echo '{"runId":"<runId>","waivers":[{"caseId":"<caseId>","reason":"<powód>"}]}' > release-in.json
grp release --config <c> --in release-in.json

# clean: sprzątanie PO released (dry-run najpierw!)
echo '{"runId":"<runId>","dryRun":true}' > clean-in.json
grp clean --config <c> --in clean-in.json
```

## 9. Typowe błędy i ich przyczyny

| Objaw | Przyczyna | Naprawa |
|---|---|---|
| `preflight` 401/403 | brak tokenu w env/`.env` albo wygasła sesja OAuth mostka | ustaw zmienną z `model.authTokenEnv`; dla CLIProxyAPI powtórz logowanie (`-codex-login`) |
| `preflight` ok:false na `toolUse` | endpoint gubi `tool_use` | zmień model/kanał - sesje autora bez tool-callingu nie ruszą |
| exit 2: `--tests-repo nie jest repozytorium git (brak .git)` | `run --init-only` dostał katalog bez `.git` | `git init` w repo testów albo użyj `run --tests-repo` (scaffolduje sam) |
| exit 2: plan nie da się sparsować | `--in` z plikiem spoza formatów configu (`plan.source` nie potrafi go zjeść) | popraw plik planu albo ustaw `plan.source`/`plan.module` na właściwy parser |
| exit 2: brak `--config`/wejścia | `run` bez `--config` i bez `--tests-repo` (i bez autodetekcji `greenproof.config.*`), albo bez `--in` | uzupełnij flagi |
| exit 10 | pusty wybór filtra | sprawdź plan i czy case'y nie są już pokryte spec'ami |
| błędy sieci do appki, 0 tur | aplikacja pod `envUrl` nie działa | wystartuj aplikację, powtórz run |
| `.ts` jako config | nieobsługiwane rozszerzenie | użyj `.mjs`/`.json`/`.yaml` |

## 10. Czego NIE robić

- Nie wołaj `accept`/`release`/`clean --purge` bez zgody człowieka
  (auto-akceptacja w `run` to robota pipeline'u, nie Twoja).
- Nie pushuj niczego z repo testów ręcznie - jedyny push to PR akceptacji
  (auto w `run` albo ręczna komenda `accept`).
- Nie commituj `.env` ani tokenów; nie wypisuj wartości sekretów w logach.
- Nie modyfikuj cudzych runów (obcy `runId`) ani ich workdirów.
