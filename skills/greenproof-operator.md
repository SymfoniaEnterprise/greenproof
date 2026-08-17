# Skill: greenproof-operator - prowadzenie pełnego cyklu przez agenta

Jak czytać wyniki przebiegu, gdzie szukać dowodów i jakie decyzje podejmować.
Uruchamianie komend: `skills/greenproof-cli.md`. Konfiguracja modeli:
`skills/greenproof-config.md`. Kontrakty portów i retencja: `docs/adapters.md`.

## 1. Zasady bezpieczeństwa (nadrzędne)

- **NIE pushuj** do repo testów. Jedyny push to PR akceptacji: robi go
  `run` (auto-accept) albo ręczna komenda `grp accept`.
- **NIE wołaj `accept`, `release`, `clean --purge` bez wyraźnej zgody
  człowieka.** Agent przygotowuje gotową komendę i rekomendację; klika człowiek.
  Wyjątek: auto-akceptacja w `run` to robota pipeline'u (deterministyczny
  werdykt dowodu), nie decyzja agenta.
- **Nie ruszaj cudzych runów** - działaj tylko na `runId`, który sam
  uruchomiłeś albo który wskazał człowiek. Nie kasuj artefaktów spoza niego.
- Sekrety: nie wypisuj tokenów, nie commituj `.env`.
- Czytanie stanu (`status`, ledgery, transcripty) jest zawsze bezpieczne.

## 2. Odczyt wyniku `run` (result.json)

`RunOutput` ma stały kształt - czytaj w tej kolejności:

1. `preflight` - `{ endpoint, model, ping{ok}, toolUse{ok}, ok }`. `ok:false`
   → run się NIE odbył (pusty wynik). Napraw endpoint/token, dopiero potem run.
2. `filter` - `{ runId, selected[], skipped[], timeoutMinutes, warnings[] }`.
   Puste `selected` = exit 10. `warnings` zawiera m.in. sugestię podziału planu.
3. `triage` - `contexts[]` (`caseId` + klucz artefaktu kontekstu).
4. `preventiveFixture` - sesje prewencyjne per churn-prone TYP (gdy w configu
   jest `model.fixtureAuthor`). `ok:false` NIE blokuje partii.
5. `initialAuthor.results[]` - per case: `{ caseId, status, costUsd, turns,
   blockedReason? }`.
6. `fixtureEscalations[]` - `{ caseId, fixture, retryAuthor }`. `retryAuthor:null`
   = fixture nie został dostarczony (nie było dodatkowej próby).
7. `deliver.reported[]` - raporty zameldowane człowiekowi (id typu
   `<runId>:<caseId>:draft_delivered|case_blocked|app_defect_suspected`).
   `autoAccept` - `{ accepted[], waiting[] }` (albo `null`, gdy auto-akceptacja
   wyłączona): które case'y pipeline przyjął sam, a które czekają na człowieka.
8. `status.summary` - rollup: `total/done/remaining/passed/failed/skipped/
   costUsd/turns` + `byStatus`. To jest liczba, którą raportujesz człowiekowi.

Statusy case'a: `pending, skipped, selected, triaged, authoring, proving,
delivered, in_review, retry_requested, accepted, released, blocked,
attempt_failed, failed`. `passed` w rollupie = delivered/in_review/accepted/
released; `failed` = blocked/attempt_failed/failed.

## 3. Artefakty - gdzie co leży (adapter-fs)

`baseDir` z `platformOptions` (configi referencyjne:
`~/.local/share/greenproof/manual-<preset>/platform`):

- stan przebiegu: `<baseDir>/state/<runId>.json`
- ledger case'a: `<baseDir>/artifacts/<runId>/cases/<caseId>/ledger.jsonl`
- spec i dowód: `.../cases/<caseId>/spec.ts`, `.../proof.json`
- kontekst triażu: `.../cases/<caseId>/context.json`
- inwentarz z fixture: `.../cases/<caseId>/extra-inventory.json`
- transcripty sesji fixture: `.../cases/<caseId>/fixture-session.messages.jsonl`,
  `.../preventive-fixture.messages.jsonl`
- raporty dla człowieka: `<baseDir>/reports/<runRef>/<reportId>.md` (+ `.json`)

**Współdzielenie harvestu wewnątrz runu.** Po DOSTARCZONYM case'ie jego
zarejestrowane POM-y/fixture'y trafiają na wspólny branch runu
`greenproof/fixtures/<runId>` (`state.fixturesRef`), a kolejne case'y tną z
niego swoje branche i widzą te wpisy w inwentarzu triażu. Przy diagnostyce to
znaczy dwie rzeczy: (a) `extra-inventory.json` case'a to nie cała prawda -
późniejsze case'y mogły skorzystać z POM-ów wcześniejszych, (b) w logach runu
widać wpis `Udostępniono N wpis(ów) harvestu z <caseId> na greenproof/fixtures/<runId>`,
który potwierdza, że harvest realnie poszedł dalej.

Workdir prób autora: `GREENPROOF_WORK_DIR` jeśli ustawiony, inaczej
`<testsRepoDir>/.greenproof-runs/<runId>`; skrypty benchmarkowe używają
`~/.local/share/greenproof/runs/<runId>`. W nim:

- transcript próby: `<workdir>/<caseId>/attempt-N/messages.jsonl`
- raporty Playwrighta per przebieg: `<workdir>/<caseId>/attempt-N/pw-runs/run-NN-<purpose>.json`

Czytaj ledger jako pierwszy (tani, strukturalny); transcript dopiero, gdy
ledger nie tłumaczy porażki.

## 4. Po runie: diagnostyka i retry

Oficjalny proces po zakończonym runie: **zbierz diagnostykę → zakwalifikuj
każdy nieudany case na drabince → wystartuj retry (albo napraw przyczynę)**.

### 4.1 Zbierz diagnostykę (kolejność od najtańszej)

```sh
grp status --config configs/<preset>.config.mjs \
  --tests-repo <repo> --run <runId>          # zawsze exit 0 - to czysty odczyt
```

Zwraca `PipelineState` + pole `summary` (rollup) i `cases[<caseId>]` ze
`status`, `blockedReason`, `blockedNote`, `attempts`, `costUsd`, `artifacts`.
To samo leży na dysku: `<baseDir>/state/<runId>.json` (dla configów
referencyjnych `~/.local/share/greenproof/manual-<preset>/platform/state/...`).

Zanim wejdziesz w ledgery pojedynczych case'ów, zbierz per-case liczby jedną
komendą (flaga `--cases` na `status` - dawniej osobna komenda `stats`):

```sh
grp status --cases --config configs/<preset>.config.mjs \
  --tests-repo <repo> --run <runId>          # per-case rollup z ledgerów, exit 0
```

Wynik `status --cases` dokłada do zwykłego statusu `cases[]` (per case:
`status`, `blockedReason`, `attempts`, `turns`, `playwrightRuns`, `proofRuns` -
osobna pula dowodowa, `costUsd`, `reusedPoms`, `outcomes` - sekwencja wyników
prób, `lastOutcome`) oraz `totals` (suma runu + ranking `reusedPomsTop`). Uwaga
na DWA koszty: `totals.costUsd` to suma z LEDGERÓW prób, a
`totals.costUsdState` ze STANU - różnicę robią sesje fixture, które nie mają
wpisów w ledgerach prób. `status --cases` to pierwszy rzut oka, a nie diagnoza
- przyczynę porażki nadal czytasz z ledgera (§4.1 dalej).

Dalej per nieudany case (ścieżki: §3):

1. **`ledger.jsonl` - OSTATNI wpis. Pierwsze miejsce do sprawdzenia.**
   `AttemptRecord` mówi wprost, co się stało: `outcome`
   (`delivered|blocked|attempt_failed|interrupted`), `blockedReason`, `turns`,
   `playwrightRuns`, `phases` (`arrange`/`act`/`assert` → `turns` +
   `playwrightRuns` - pokazuje, GDZIE spalił się budżet), `seedAttempts`
   (strategie seedu + `ok|failed`), `lastErrors`, `filesTouched`, `reusedPoms`,
   `costUsd`, `tokens`, `digest`, `trigger` (`initial|auto-retry|human-retry`)
   i `humanNotes` (uwagi, z którymi szła ta próba).
2. **`attempt-N.messages.jsonl`** (artefakt) albo `<workdir>/<caseId>/attempt-N/
   messages.jsonl` - pełny transkrypt. Otwieraj dopiero, gdy ledger nie
   tłumaczy porażki.
3. **`pw-runs/run-NN-<purpose>.json`** w katalogu próby - wersjonowane raporty
   Playwrighta. Zero plików = agent w ogóle nie uruchomił testu.

Czytelna sygnatura: `phases.arrange.turns` znacznie większe od `act`+`assert`
przy zerze runów Playwrighta = sesja utknęła na odkrywaniu stanu wyjściowego,
nie na pisaniu testu.

### 4.2 Drabinka decyzji per case

`blockedReason` (enum): `fixture-gap`, `budget`, `turns`, `time`,
`playwright-runs`, `infra`, `other`.

| Objaw | Interpretacja | Ruch |
|---|---|---|
| `attempt_failed` | próba padła (często odrzucony dowód mutacyjny) | `retry` z konkretnymi `notes` - bez uwag powtórzysz ten sam błąd |
| `blocked` + `fixture-gap` | bezpiecznik seedu: agent nie doprowadził stanu wyjściowego | `grp fixture` (wąska sesja mocniejszego modelu, odbiór deterministyczny - skrypt weryfikacyjny musi wyjść 0), POTEM ponowna sesja autora (uwaga niżej: `author`, nie `retry`); `run` robi obie rzeczy sam |
| `blocked` + `time`/`turns`/`budget`/`playwright-runs` | cap zadziałał | podbij właściwy cap w configu (`caps.maxTimeMinutes`/`maxTurns`/`maxCostUsd`/`maxPlaywrightRuns`) ALBO retry z `notes` - często oba naraz; nie podbijaj capów odruchowo |
| `blocked` + `infra` | zwis/timeout backendu, watchdog pierwszej tury | napraw infrastrukturę (brama/mostek/appka), potem retry; dla modeli LOKALNYCH podnieś `caps.firstTurnTimeoutMinutes` (~15) - 5 min ubija żywą sesję |
| `blocked` + `other` z notatką | `deliver` emituje OSOBNY raport `app_defect_suspected` (nie `case_blocked`) - deklaracja agenta, że aplikacja/kontrakt API blokuje flow | werdykt człowieka: zweryfikuj defekt ręcznie. Prawdziwy bug = najcenniejszy wynik testera (zgłoś, nie retryuj na ślepo); wymówka modelu = retry z `notes`. Zacytuj `blockedNote` + `lastErrors` z raportu |
| `blocked` + `other` bez notatki | zwykła blokada bez deklaracji defektu | do przeglądu człowieka - zacytuj `blockedNote`/ledger |
| `delivered` | draft + dowód gotowe (stan przejściowy - deliver od razu przenosi do `in_review`) | patrz `in_review` niżej |
| `in_review` | draft czeka na człowieka: dowód `invalid`, duplikat selektora albo auto-accept wyłączona | zweryfikuj dowód/lint z raportu `draft_delivered`; zaproponuj `retry` z `notes` albo ręczny `accept` |
| `accepted` | pipeline przyjął case automatycznie (dowód `valid` bez ostrzeżeń + czysty lint) | nic nie rób - case czeka tylko na `release` |
| `released` | domknięte | kandydat do `clean` |

Bramki release (§5) są nadrzędne nad drabinką: **P0 fail blokuje bezwzględnie**
(żadnego waivera), **P1 fail wymaga waivera na KAŻDY niedomknięty case**.
Czyli: nieudany case P0 zawsze wraca na drabinkę, P1 wolno zamknąć waiverem
z uzasadnieniem.

Retry ma sens, gdy: (a) porażka była jednorazowa/infra, albo (b) masz konkretną
wskazówkę do `notes`. Retry bez nowej informacji = spalony budżet. Pamiętaj, że
auto-retry (`caps.maxAutoRetries`) JUŻ się wydarzył w runie - ręczny retry to
kolejna próba na żądanie człowieka. Po udanym fixture case dostaje osobny kredyt
ponowienia (poza `maxAutoRetries`).

Eskalacja fixture ręcznie:

```sh
echo '{"runId":"<runId>","caseId":"<caseId>"}' > fx.json
grp fixture --config <c> --in fx.json            # exit 3 = nie udało się

# prewencyjnie, przed partią, per churn-prone TYP:
echo '{"runId":"<runId>","mode":"preventive","types":["lista-plac"]}' > fx-prev.json
grp fixture --config <c> --in fx-prev.json
```

Udany `fixture` SAM cofa case do `triaged`, SAM wpisuje `retryNotes` („użyj
dostarczonego fixture'a zamiast odkrywania") i dokłada kredyt ponowienia. Nie
odpalaj wtedy `retry` - case jest już w `triaged`, a `CASE_TRANSITIONS` nie zna
przejścia `triaged → triaged` (`InvalidTransitionError`, exit 1). Dokończ tak
jak robi to `run`: sesją autora na ten jeden case, potem `deliver`.

```sh
echo '{"runId":"<runId>","caseIds":["<caseId>"]}' > au.json
grp step author --config <c> --tests-repo <repo> --in au.json  # exit 3 = dalej nieudany
grp step deliver --config <c> --tests-repo <repo> --run <runId>
```

(Pomoc CLI przy komendzie `fixture` mówi „potem zwykłe retry" - to skrót
myślowy; sprawdzalny w kodzie jest powyższy wariant z `author`.)

### 4.3 Start retry

Wejście musi być zgodne z `RetryInputSchema` - dokładnie trzy pola
(`notes` opcjonalne):

```sh
cat > retry.json <<'JSON'
{
  "runId": "<runId>",
  "caseId": "<caseId>",
  "notes": "Konkretnie: co poszło źle i czego NIE powtarzać."
}
JSON

grp retry --config configs/<preset>.config.mjs \
  --tests-repo <repo> --in retry.json --out wynik.json
```

- `--tests-repo` razem z `--config` działa dla każdej komendy (nie tylko `run`)
  od commita `7494059` - ustawia `GREENPROOF_TESTS_REPO`, które czytają configi
  referencyjne.
- `--app-url`/`--ref` są WYŁĄCZNIE dla `run`/`filter` (inaczej exit 2). Adres
  aplikacji retry bierze z `envUrl` zapisanego w stanie runu.
- `runId` można też podać flagą `--run` (nadpisuje pole z pliku).

Co robi `retry` (jeden krok, bo człowiek oczekuje jednego „spróbuj jeszcze
raz"): cofnięcie case'a do `triaged` (kasuje `blockedReason`/`blockedNote`,
zwalnia lease; z `in_review` przechodzi formalnie przez `retry_requested`) →
triaż odświeżany przez autora → sesja autora z digestem poprzedniej próby
+ `notes` → `deliver`.

Exit: `0` = case dowieziony, `3` = znowu `blocked`/`attempt_failed`/`failed`
(czytaj świeży ostatni wpis ledgera i wróć na drabinkę), `4` = konflikt CAS
(ponów tę samą komendę).

`retry` wolno wołać tylko na case'ie w stanie terminalnym lub w przeglądzie
(`blocked`, `attempt_failed`, `failed`, `in_review`). Na `triaged`/`authoring`
poleci `InvalidTransitionError` (exit 1) - tam używa się `author`.

**Jak pisać `notes`.** Trafiają do promptu jako „Uwagi przeglądu" tuż obok
automatycznego digestu poprzedniej próby i lądują w ledgerze jako `humanNotes`.
Dlatego: konkret zamiast zachęty. Pisz (a) co poszło źle, (b) czego NIE
powtarzać, (c) skrót do celu, jeśli go znasz. Źle: „spróbuj lepiej,
zmieść się w czasie". Dobrze: „nie eksploruj UI od nowa - logowanie i lista
pracowników są w POM `EmployeesPage`; od razu otwórz dwa konteksty i wywołaj
konflikt wersji".

Przykład z praktyki (run 2026-08-16, model `luna`): case
`employee-optimistic-lock` skończył jako `blocked(time)` - 129 tur w 30 minut,
ZERO runów Playwrighta. Ledger pokazał `phases.arrange.turns` 64 i `act` 65,
czyli cała sesja poszła na odkrywanie stanu. Ruch: retry z `notes` „nie
eksploruj od nowa, od razu dwa konteksty i konflikt wersji" plus rozważenie
`caps.maxTimeMinutes` 30 → 45 dla tego presetu.

### 4.4 Higiena przed retry i po nim

- Sprawdź, że aplikacja pod `envUrl` runu żyje (`curl -sSf -o /dev/null -w
  '%{http_code}\n' <envUrl>`). Retry przeciwko martwej appce spali próbę.
- Upewnij się, że NIE trwa na niej inny run - stan aplikacji jest współdzielony,
  dwa runy równolegle psują sobie seedy i asercje.
- Retry działa na jednym case'ie; nie ruszaj innych case'ów tego runu ani
  cudzych runId.
- Po dowiezieniu retry: case ze spełnionym kryterium (dowód `valid` + czysty
  lint) pipeline NIE zaakceptuje sam - `retry` nie odpala auto-accept (robi to
  tylko `run`). Przygotuj ręczny `accept`, a `release` zawsze wymaga zgody
  człowieka - przygotuj gotowe komendy, nie uruchamiaj ich.

## 5. Rekomendacje accept / waiver / release

- **auto-accept** (w `run`) przyjmuje case'y z dowodem mutacyjnym `valid`
  i bez ostrzeżeń lintu anty-duplikacji selektorów - deterministycznie, bez
  osądu modelu. Te case'y nie potrzebują Twojej decyzji o akcepcie; zostaje
  im tylko `release`.
- **accept** (ręczna komenda) proponuj dla `in_review` z dowodem `valid`
  i czystym lintem, gdy auto-accept była wyłączona (`--no-auto-accept` /
  `gates.autoAccept: false`) albo case został dowieziony przez `retry`. Jeśli
  dowód nie jest `valid` lub lint zgłasza duplikat - nie proponuj accept,
  proponuj `retry`.
- **release** dopiero, gdy wszystkie case'y P0 są domknięte: P0 fail blokuje
  bezwzględnie, bez wyjątków.
- **waiver** dotyczy WYŁĄCZNIE P1 i wymaga wpisu na KAŻDY niedomknięty case
  (`waivers:[{caseId, reason}]`). P2/P3 są informacyjne. Waiver bez realnego
  uzasadnienia (np. „fixture-gap, POM do dopisania przez człowieka") to
  ukrywanie długu - napisz to człowiekowi wprost.
- Release z exit `5` (`pass:false`) to informacja, nie awaria - raport i tak
  trafia do kanału ludzkiego.

## 6. Sprzątanie po release

```sh
echo '{"runId":"<runId>","dryRun":true}' > clean-in.json   # ZAWSZE najpierw dry-run
grp clean --config <c> --in clean-in.json
```

- Domyślnie usuwa transcripty, kontekst triażu i extra-inventory case'ów
  `released`; **ledger/spec/proof zostają** (ślad audytowy).
- `"purge": true` kasuje też ledger/spec/proof - świadomie i tylko na wyraźną
  prośbę człowieka.
- Branche: `author/<caseId>` released case'ów, a gdy cały run jest terminalny -
  `greenproof/fixtures/<runId>`. `"branches": false` je zostawia.
- `"caseIds": [...]` zawęża zakres. Wynik: `deleted[]`, `deletedBranches[]`,
  `kept[]` (z powodem), `branchNote`.
- Exit 2 = platforma bez `ArtifactStore.delete` (np. GitHub - retencją rządzi
  platforma). To nie jest błąd do obejścia.

## 7. Monitoring długich runów

Run na 10 case'ach potrafi trwać 2-3 h (model lokalny: 4-10 h). **Startuje go
człowiek w swoim terminalu** - agent podaje komendę i nie odpala jej sam ani
w tle, ani przez systemd (uzasadnienie: `skills/greenproof-cli.md`, §0a).

Komenda do wklejenia przez użytkownika - zwykły pierwszy plan, żeby widział
tablicę postępu:

```sh
grp run --config <c> --in <plan.json> --app-url <url> --out /tmp/gp-run.json
```

Gdy run ma przeżyć zamknięcie terminala, użytkownik owija go sam:

```sh
systemd-run --user --unit=gp-run --collect \
  --setenv=GREENPROOF_PROGRESS=plain \
  bash -lc 'grp run --config <c> --in <plan.json> --app-url <url> \
            --out /tmp/gp-run.json > /tmp/gp-run.stdout 2> /tmp/gp-run.log'

journalctl --user -u gp-run -f          # albo: tail -f /tmp/gp-run.log
```

Agent w trakcie runu czyta stan z PLIKÓW, nie ze stdout procesu:

```sh
grp status --config <c> --run <runId>    # rollup w dowolnym momencie
```

- `GREENPROOF_PROGRESS=plain` w tle (tablica TTY jest nieczytelna w logach);
  `json` gdy chcesz parsować zdarzenia (NDJSON na stderr).
- Stdout zostaje czystym JSON-em - przekierowuj go osobno od logów.
- Workdir jest trwały (bez auto-rm) - po padzie procesu stan w StateStore
  przetrwa, wygasły lease zostanie przejęty, a `author` podejmie porzucone
  case'y. Nie startuj drugiego runu „na wszelki wypadek".

## 8. Raportowanie człowiekowi

Krótko i konkretnie: `summary` (ile ✓/✗, koszt, tury), lista case'ów z
`status` + `blockedReason`, dla każdego jedno zdanie diagnozy z ledgera,
i PROPOZYCJE komend (`retry`/`fixture`/`release`, a `accept` tylko gdy
auto-accept nie zadziałała) gotowe do wklejenia. Oddziel case'y przyjęte
automatycznie (`accepted`) od czekających na człowieka (`in_review`/`blocked`)
- to z pola `run.autoAccept` (`accepted[]`/`waiting[]`). Raporty
`app_defect_suspected` wybijaj OSOBNO: to znalezisko do oceny człowieka
(bug aplikacji vs wymówka modelu), nie zwykły `case_blocked`. Nie uruchamiaj
komend sam.
