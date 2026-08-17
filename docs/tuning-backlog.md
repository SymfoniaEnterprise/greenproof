# Wnioski „do podkręcenia" - backlog strojenia po realnych runach (2026-08-15)

Zebrane z golden path (demo-app, 2 case'y × 6 modeli) i benchmarku
(HR-Payroll demo, 10 case'ów × deepseek/luna). Źródła: ledgery i transcripty
z archiwów runów (trzymane lokalnie, poza repo), zbiorczy raport
w `./benchmarks.md`.

## 1. Trwałość artefaktów runów (zgłoszone przez usera - priorytet) - ✅ WDROŻONE 2026-08-15

**Problem:** workdiry runów (stan, ledgery, transcripty, dowody, raporty) żyją
w `/tmp` - reboot je kasuje; dziś ratowaliśmy je ręczną archiwizacją.

**Do zrobienia:**
- Harnessy (`golden-path.mjs`, `benchmark-path.mjs`) mają zakładać workdiry w
  trwałej lokalizacji (np. `~/.local/share/greenproof/runs/<runId>` albo katalog
  z konfigu), nie w `os.tmpdir()`.
- W bibliotece: retencja artefaktów sprzężona z cyklem życia case'a - **artefakty
  case'a wolno usuwać dopiero po jego zaakceptowaniu** (accept/release), nigdy
  wcześniej; sprzątanie jako świadoma komenda (`gp clean --released`),
  nie efekt uboczny.
- W CI (GitHub/platformy firmowe) to załatwia ArtifactStore platformy - problem
  dotyczy głównie adapter-fs i harnessów lokalnych.

## 2. Dyscyplina raportów dowodu (główna klasa porażek Luny) - ✅ WDROŻONE 2026-08-15 (wariant twardy: narzędzie `run_playwright`)

**Problem:** wszystkie uruchomienia playwright piszą do jednego
`pw-report.json`; modele podają ścieżkę bez kopii per przebieg → walidator
dostaje nadpisane/nie te raporty („zielony raport bez przechodzącego testu",
„czerwony raport nie zawiera testu").

**Do zrobienia:**
- W promptcie autora: jawny protokół „po KAŻDYM uruchomieniu skopiuj
  `pw-report.json` do osobnego pliku (`.greenproof-runs/.../green1.json`,
  `green2.json`, `red.json`) i te kopie podawaj w record_proof_material".
- Twardsze: narzędzie procesowe `run_playwright` (zamiast gołego Bash), które
  samo wykonuje run, wersjonuje raport i zwraca ścieżkę - eliminuje całą klasę.

## 3. Osobny budżet runów playwright dla fazy dowodu - ✅ WDROŻONE 2026-08-15 (`caps.proofRuns`)

**Problem:** wspólny cap (6, potem 12) trzykrotnie zagłodził dowód mutacyjny
(opus a1, deepseek a2 golden, luna benchmark) - model dochodzi do zielonych
i nie ma już runów na czerwony/przywrócenie.

**Do zrobienia:** `caps.maxPlaywrightRuns` dla fazy assert-do-zielonych +
osobna pula `caps.proofRuns` (np. 4) odblokowywana po drugim zielonym.

## 4. Cap wąskiej sesji fixture-author zależny od aplikacji - ✅ WDROŻONE 2026-08-15 (maxTurns 80 + `appDocs` w prompcie)

**Problem:** na trudnej appce Sol wypalił `error_max_turns` (40) zanim dostarczył
fixture (przed seedem trzeba ogarnąć role/login/kontrakty API) - obie eskalacje
Luny padły; na łatwej appce 38-40 tur wystarczało z zapasem.

**Do zrobienia:** podnieść domyślne `caps.fixtureSession.maxTurns` do ~80 i
umożliwić nadpisanie per projekt; rozważyć wpuszczenie fixture-authorowi
README aplikacji wprost do promptu (dziś ma tylko nakaz „przeczytaj").

## 5. Profil capów dla modeli lokalnych

**Problemy z runów qwena:**
- llama.cpp wymaga `prompt + max_tokens ≤ ctx` - domyślna rezerwa wyjścia
  Claude Code (32k) przepełnia 64k okno → wdrożone `model.maxOutputTokens`
  (ustawiać ZAWSZE dla lokalnych; 8192 działa).
- ~2 tury/min: `maxTimeMinutes` 25 jest nierealne; 90 min minimum.
- Timeout bramy (600 s) vs zimny prompt-processing dużego kontekstu - po
  stronie LiteLLM rozważyć wyższy timeout dla lokalnych deploymentów.

## 6. Infrastruktura lokalna (Lemonade/Vulkan) - operacyjne

- Zwis Vulkana w środku batcha degraduje sterownik do rebootu; respawn procesu
  nie pomaga (3 próby). Diagnoza: `/slots` na porcie wewnętrznym llama-servera
  (licznik tokenów zamrożony), nie `/health` (kłamie „ok").
- Watchdog Lemonade wskrzesza pełznący backend w nieskończoność - „wyczyść GPU"
  wymaga `systemctl --user stop lemond`, nie kill procesu.
- Timer `litellm-fallback-check` sonduje modele (kluczem delegate-claude!) i
  budzi Lemonade co godzinę - na czas eksperymentów z lokalnymi modelami
  zatrzymywać; docelowo sondy powinny omijać modele lokalne albo mieć własny
  klucz (czytelność w spend logach).
- Speculative decoding (draft-mtp) rzucił 500 „speculative batch index…" -
  obserwować; przy nawrotach wyłączyć w recipe.
- Fallbacki bramy prowadzące do modeli lokalnych (`gemini→qwen3.8` itd.)
  potrafią przenieść ruch chmurowy na GPU - przy benchmarkach modeli
  chmurowych weryfikować w spend logach, że nic nie zjechało na fallback
  (dziś: 323/323 czysto, ale tylko dlatego, że OpenRouter nie czkał).

## 6a. Stęchły kontekst po fixture-author (bug) - ✅ NAPRAWIONE 2026-08-15 (author zawsze triażuje przed sesją)

**Problem:** `authorOneCase` używa istniejącego `cases/<id>/context.json`
zamiast go odświeżyć - po sesji fixture-author ponowna próba autora NIE widzi
extra-inwentarza (fixture) ani retryNotes (benchmark ds: attempt-3
`payroll-create-churn` znów fuse, `reuse: []`, mimo zweryfikowanego fixture'a
od Opusa). Na łatwej appce maskowane tym, że model sam znajdował pliki na
branchu.

**Fix:** author ZAWSZE uruchamia triaż dla case'a bezpośrednio przed sesją
(deterministyczny i tani); usuwa to też rozjazd „kto miał zawołać triage"
między harnessami a CLI.

## 8. Pomysły z podsumowania runów (2. iteracja, 2026-08-15 wieczór)

Priorytet „przed nowym runem benchmarku" (tanie, adresują dzisiejsze straty):

- [x] **8.1 Mutacja oracle jako pierwszy wybór dowodu** - wszystkie udane
      dowody = minimalna delta wartości z golden-case (±1 grosz); wszystkie
      „mutacja nie czerwieni testu" = mutacje kroków/seedu. Do promptu autora:
      „mutuj NAJPIERW wartość oczekiwaną z oracle; mutację logiki wybieraj
      tylko, gdy case nie ma oracle". Mechanicznie gwarantuje czerwień, jeśli
      spec asertuje oracle - a jeśli nie asertuje, dowód słusznie to obnaża.
- [x] **8.2 Watchdog time-to-first-turn** - sesje na zwisniętym backendzie
      paliły pełny cap czasu z 0 turami. Silnik: brak PIERWSZEJ tury w ~5 min
      → przerwij z klasyfikacją `infra` (nie `time`); szybka porażka, czytelny
      ledger, platforma może ponowić.
- [x] **8.3 Ponowienie po fixture-author poza budżetem `maxAutoRetries`** -
      auto-retry potrafi się spalić PRZED fixture'em (payroll-create-churn);
      próba „z nowym klockiem" to inny reżim i powinna mieć własną pulę
      (np. 1 gwarantowana próba po każdym udanym fixture).
- [x] **8.4 Prewencyjny fixture-author dla typów churn-prone** (miękkie) -
      plan zna typy z góry: jedna wąska sesja per typ PRZED partią zamiast
      czekania na bezpiecznik w każdym casie osobno (dziś: ~4 nieudane próby
      do zaoszczędzenia na 2 case'ach payrollowych).

Następna iteracja (po nowym runie):

- [x] **8.5 Współdzielenie harvestu WEWNĄTRZ partii** - ✅ WDROŻONE 2026-08-16.
      Inwentarz jest aktualizowany po każdym *delivered* (run-scoped), nie
      dopiero po accept; dziś 10 case'ów budowało logowanie ~10×; szacunkowo
      −20-30% tur na trudnej appce. Mechanizm ten sam co przy prewencyjnym
      fixture: `harvest/share.ts` przenosi na wspólny branch runu
      (`greenproof/fixtures/<runId>`, `state.fixturesRef`) WYŁĄCZNIE pliki
      wskazane przez wpisy pom-index + sam indeks (nigdy specu case'a), a
      triaż i lint delivera czytają indeks z `fixturesRef ?? baseRef`. Branche
      kolejnych case'ów i tak tną się z `fixturesRef`, więc pliki są też
      fizycznie w checkoucie. Wpis bez pliku = pominięty (fantom), awaria
      współdzielenia nie wywraca dostarczonego case'a.
- [x] **8.6 Rollup ledgerów runu** - ✅ WDROŻONE 2026-08-16 (jako flaga
      `--cases` komendy `status`; osobna komenda `stats` została scalona). Rollup
      ledgerów runu (per case: próby, tury, runy pw z osobną pulą dowodową,
      koszt, reużyte POM-y, sekwencja wyników prób, powód blokady) plus sumy
      runu i ranking `reusedPomsTop`; `summary` reużywa `summarizeRun`, więc
      liczenie statusów jest w jednym miejscu. Koszt podany dwukrotnie:
      `totals.costUsd` (suma ledgerów) i `totals.costUsdState` (stan) -
      rozjazd to sesje fixture i ma być widoczny. Krok: `steps/stats.ts`,
      komenda `gp status --run <id> --cases` (tylko odczyt, JSON na stdout).
- [x] **8.8 Fantomowy koszt SDK przy zerowym priceTable (bug, run qwen)** -
      ✅ NAPRAWIONE 2026-08-16. Gdy priceTable miał wpis z zerowymi stawkami
      (modele lokalne/subskrypcje), `author.ts` przy koszcie 0 sięgał po koszt
      z SDK (cennik Claude - fantom $11.70 dla qwena). Teraz fallback na koszt
      SDK działa TYLKO przy BRAKU priceTable, a jawny wpis 0 = świadome
      „koszt $0" (`ownCostAuthoritative` w `steps/author.ts`, cap SDK wg
      `costModel` w `author/session.ts`; testy `sdk-budget.test.ts`
      i `author-step.test.ts`). Watchdog 1. tury dla lokalnych już obsłużony
      per profil (firstTurnTimeoutMinutes: 15 w profilach qwen/qwen36).
- [x] **8.7 `blocked(other)` jako raport „app-defect?"** - ✅ WDROŻONE
      2026-08-16. Deklaracja agenta „kontrakt API blokuje flow" to albo
      ZNALEZIONY DEFEKT aplikacji (najcenniejszy wynik testera), albo wymówka.
      Deliver emituje dla `blocked(other)` z notatką agenta osobny raport
      `app_defect_suspected` (notatka, branch, koszt, ostatnie błędy asercji
      z ledgera) zamiast chować case w kupce `case_blocked`; pozostałe powody
      blokady bez zmian.

## 9. Pomniejsze

- `blocked(other)` z deklaracji agenta (luna: „application/API contract") -
  wymaga przeglądu człowieka: albo prawdziwy defekt appki, albo wymówka;
  warto, by deliver oznaczał takie case'y wyraźniej niż fixture-gap.
- W tabelach zawsze podajemy estymatę kosztu z dopiskiem `(est.)`, niezależnie
  od kanału (abonament, subskrypcja, pay-per-token); przy abonamencie dodajemy,
  że realnie z kieszeni nic nie wychodzi (robimy, utrzymać).
- Digest tanim modelem wciąż nieprzetestowany w boju (konfiguracje trial
  używały tylko deterministycznego) - sprawdzić na kolejnym benchmarku.
