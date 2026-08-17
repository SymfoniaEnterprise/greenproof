# Benchmarki greenproof - bugi, problemy i wnioski

Pełne tabele wyników per model żyją w dwóch dedykowanych, uzupełnianych na
bieżąco dokumentach:

- **Easy app (DemoPay)** - `benchmarks-easy-app.md`. 2 case'y golden path
  (`E2E-LOGIN-001` P0, `E2E-PAYROLL-002` P1 churn-prone `lista-plac`).
- **Complex app (HR-Payroll)** - `benchmarks-complex-app.md`. 10 case'ów
  (`examples/benchmark-plan.json`): role, paginacja serwerowa, optimistic
  locking, PESEL z cyfrą kontrolną, workflow statusów, nakładanie urlopów,
  celowy churn payrollu.

Ten dokument zbiera to, czego w tamtych tabelach nie ma: **bugi** (w pipelinie
i w testowanych appkach), **problemy napotkane w trakcie runów** oraz **wnioski
i mechanizmy potwierdzone w boju**. Rekordy nieudanych runów zostają tam, gdzie
czegoś uczą; pominięto porażki z limitów czysto zewnętrznych (wyczerpana kwota
abonamentu, darmowy próg API) - nie mówią nic o modelu ani o pipelinie.

## Easy app (DemoPay)

> **Aktualne zestawienie modeli** (dwie tabele: lokalne i chmurowe, uzupełniane
> na bieżąco) mieszka w `benchmarks-easy-app.md`. Sekcje poniżej zostają jako
> materiał historyczny i analiza przyczyn porażek.

Data: 2026-08-15 · plan: 2 case'y na appce DemoPay -
`E2E-LOGIN-001` (P0, auth) i `E2E-PAYROLL-002` (P1, churn-prone `lista-plac`,
oracle netto z golden-case'ów). Capy: 25 min / $3 / 6 runów playwright
(assert) / auto-retry 1 / snapshotGating **enforce**. Adapter: fs · brama:
LiteLLM (klucz wirtualny) · Opus: subskrypcja Claude (bez bramy).

### Wyniki

| Model | LOGIN-001 (P0) | PAYROLL-002 (P1) | Koszt runa | Release |
|---|---|---|---|---|
| **deepseek-v4-flash** | ✅ released (a1, ~$0.01, dowód valid) - po drodze **pad runnera i wznowienie z przejęciem lease** | 🚧 blocked `fixture-gap` (bezpiecznik seedu, 46 tur arrange, $0.008, 0 runów pw) | **~$0.02** | **PASS** (P1 z waiverem fixture-gap) |
| **gpt-5.6-luna (subskrypcja przez mostek OAuth)** | ✅ released (a2, est. $2.28, 67 tur; a1 odrzucona mutacja) | 🚧 blocked `fixture-gap` (a1, est. $0.53, 45 tur arrange, 0 runów pw) | **$0.00 realnie** (SDK est. $2.81) | **FAIL** (P1 bez waivera) |
| **claude-opus-5** | ✅ released (a3 human-retry, $1.27, 48 tur, **reuse LoginPage+EmployeesPage**) | ✅ released (**a1**, $2.21, 87 tur, seed przez API, dowód: netto ±1 grosz vs oracle) | **$6.58** (w tym 2 nieudane próby LOGIN po $1.36-1.73) | **PASS** bez waiverów |

Skrótowo (tabela z podsumowania modeli): **claude-opus-5** - `released`/`released`,
ukończył oba przypadki za pierwszym razem, payroll przeszedł seed przez API
i 5 testów Playwright, **PASS**. **deepseek-v4-flash 0731** - `released`/
`blocked: fixture-gap` (46 tur arrange, 0 testów pw), **PASS** (z waiverem).
**gpt-5.6-luna max** - `released` po auto-retry / `blocked: fixture-gap`
(45 tur arrange, 0 testów pw), **FAIL**.

### Reruny z fixture-author (eskalacja do claude-opus-5) - przed vs po

Świeże runy deepseek i Luna po dorobieniu mechanizmu `fixture` (wąska sesja
mocniejszego modelu uzupełnia lukę po fixture-gap; odbiór deterministyczny -
skrypt weryfikacyjny musi wyjść kodem 0) oraz po podbiciu capu runów playwright
6 → 12 (limit 6 trzykrotnie zagłodził fazę dowodu).

| Model | PAYROLL przed | PAYROLL po | Rozbicie kosztu „po" | Release przed → po |
|---|---|---|---|---|
| **deepseek-v4-flash** | 🚧 fixture-gap, 0 testów | ✅ **released** (a3: 132 tur, 8 runów pw, reuse `payrollSeed`+`PayrollPage`, dowód valid - mutacja oracle ±1 grosz) | Opus-fixture **$1.30**/40 tur + deepseek $0.12 ≈ **$1.42** (vs $2.21 Opus solo) | PASS z waiverem → **PASS bez waivera** |
| **gpt-5.6-luna** (mostek OAuth) | 🚧 fixture-gap, 0 testów; FAIL bez waivera | ✅ **released** (a2: 189 tur, 6 runów pw, reuse `PayrollSeedFixture`+`PayrollPage`+`AuthPage`, dowód valid) | Opus-fixture **$1.02**/38 tur + Luna est. $3.58 (realnie **$0** - subskrypcja; kwoty Luny to estymaty SDK) | FAIL → **PASS bez waivera** |
| qwen3.8 (lokalny) | 🚧 time (zwis Vulkana zafałszował próbę) | ❌ attempt_failed ×4 (run z fallbackiem na kanał abonamentowy - szczegóły w sekcji niżej) | prewencyjny fixture z abonamentu **$0.28**/68 tur; qwen $0 (lokalny) | - → **FAIL** (P1 niedowieziony; LOGIN ✅ released) |
| qwen36-27b-mtp (lokalny) | - | 🚧 blocked `playwright-runs`; LOGIN ❌ ×2 na dowodzie mutacyjnym (sekcja niżej) | prewencyjny fixture z abonamentu **$0.49**/83 tury; qwen36 $0 (lokalny) | **FAIL** (P0 i P1 niedowiezione) |

LOGIN w rerunach: deepseek released (a2, auto-retry z digestem), Luna released
(a1, za pierwszym podejściem, $0.76 est.).

**Wnioski z rerunów:**

- Teza „mocny łata luki, tani dowozi" potwierdzona dwukrotnie: fixture od Opusa
  ($1.02-1.30 za wąską sesję) odblokował obu tanich autorów; fixture zostaje
  w repo i będzie darmowy dla wszystkich kolejnych case'ów payrollowych.
- Poprawka bezpiecznika (spóźnione `report_seed_attempt(ok)` zdejmuje fuse)
  i cap runów 12 były warunkami koniecznymi - sam fixture nie wystarczał.
- Deterministyczny odbiór fixture'a (verify-script) zadziałał w obu runach -
  żaden fixture nie wszedł „na słowo".

### Run qwen3.8 (lokalny) + fallback fixture-author `deepseek-flash` - 2026-08-15

Pierwszy run golden path z fallbackiem fixture-author innym niż Opus:
autor **qwen3.8** (lokalny, Lemonade przez bramę), fixture-author
**deepseek-flash** (abonament przez bramę). Planowany drugi run
(gemini-3.7-openrouter + ten sam fallback) odwołany decyzją usera - wpis
`gemini37` w `scripts/golden-path.mjs` zostaje na przyszłość.
RunId: `gp-golden-qwen-20260815T192554-ijas`, czas 21:26-23:37 (~132 min),
caps qwena: 90 min / maxOutputTokens 8192 (ctx 64k).

| Etap | Wynik | Tury | Koszt realny |
|---|---|---|---|
| Prewencyjny fixture `lista-plac` (abonament) | ✅ dostarczony `payrollSeed.ts` | 68 | **$0.28** |
| E2E-LOGIN-001 (qwen) | ✅ **released** (a1, 4 zielone runy pw + dowód mutacyjny `valid`) | 141 (~36 min) | $0 (lokalny) |
| E2E-PAYROLL-002 (qwen) | ❌ attempt_failed (a1: 37 tur, SDK `Request timed out`; a2-a4: 0 tur, watchdog `infra`) | 37+0+0+0 | $0 |
| Release | **FAIL** (P0 1/1 ✅, P1 0/1 ❌) | Σ 178 | **~$0.28** |

**Co się właściwie stało z payrollem** (Lemonade zdrowe: 0 restartów,
stabilne ~14 tok/s - to nie była awaria infrastruktury):

1. Tury rozciągnęły się do ~20 min i próba 1 padła na timeoucie requestu
   w Agent SDK. **Nie przez generację**: ledger pokazuje tylko ~120-140
   tokenów wyjścia na turę (przy 14 t/s to ~10 s), więc czas zjadał
   **prefill promptu** - slot llama-server raportował requesty po ~53,5k
   tokenów wejścia. Podejrzenie: unieważniany cache KV zmuszał do pełnego
   prefillu przy każdej turze (do zbadania osobno).
2. Próby 2-4 padły z 0 turami: **`firstTurnTimeoutMinutes` (5 min) jest
   krótszy niż pierwsza tura lokalnego 27B** (długi prefill ~50k + wolna
   generacja) - watchdog błędnie klasyfikował żywą sesję jako `infra`.
   Mechanizm infra-retry zadziałał zgodnie z projektem, ale na złej diagnozie.

**Pułapka kosztowa**: raport pokazał $11.70 za LOGIN i $2.04 za payroll,
mimo zerowego priceTable qwena - `author.ts` przy koszcie własnym 0 bierze
koszt SDK (cennik Claude). Fallback na koszt SDK powinien działać tylko przy
*braku* priceTable, nie przy koszcie 0 (model lokalny legalnie kosztuje $0).

**Wnioski:**

- **Lokalny 27B dowiózł P0 z dowodem mutacyjnym za $0** - pierwszy released
  case golden path w pełni na lokalnym modelu (poprzednia próba padła na
  zwisie Vulkana).
- **Fallback fixture-author na deepseek-flash działa**: dostarczył
  zweryfikowany fixture za $0.28/68 tur vs $1.02-1.30 Opusa - tania
  alternatywa dla wąskiej sesji fixture (choć wolniejsza: 68 tur vs ~40).
- Dla lokalnych modeli w configu: podnieść `firstTurnTimeoutMinutes`
  (np. 15 min) i rozważyć zbicie `maxOutputTokens` do ~4096, żeby tura nie
  trwała 10 min i nie wpadała w timeouty SDK.

### Run qwen36-27b-mtp (lokalny) + fallback `deepseek-flash` - 2026-08-16

Powtórka runu wyżej z podmienionym autorem: **qwen36-27b-mtp** (Qwen3.6-27B
gęsty Q5 z MTP/spekulatywnym dekodowaniem) zamiast qwen3.8, ten sam fallback
fixture-author. RunId: `gp-golden-qwen36-20260815T215926-nuu3`, 23:59-01:23
(**84 min** vs 132 min u qwen3.8), 388 tur.

**Przygotowanie (dwie pułapki do zapamiętania):**

1. **Brama po cichu podmieniła model**: pierwsze żądanie o `qwen36-27b-mtp`
   obsłużył `Qwen36-35B-A3B`. Lemonade trzyma **1 model LLM naraz**
   (`max_models.llm = 1`), a równoległa kaskada fallbacków
   (`qwen3.8 → qwen36-35b-a3b → laguna-xs-21`) eksmitowała MTP zaraz po
   załadowaniu. Zawsze weryfikować pole `model` w odpowiedzi - inaczej raport
   opisuje inny model niż zamówiony.
2. **Rejestr Lemonade dawał `ctx_size: 32768`** przy `max_context_window`
   262144 - za mało (prompty tego planu sięgają 50k+). Podniesione do
   **131072** przez `POST /api/v1/load {"model_name":…,"ctx_size":131072}`.

| Etap | Wynik | Tury | Runy pw |
|---|---|---|---|
| Prewencyjny fixture `lista-plac` (abonament) | ✅ `payrollSeed.ts` | 83 | - |
| E2E-LOGIN-001 | ❌ attempt_failed ×2 - **dowód mutacyjny odrzucił spec** („po mutacji test nadal przechodzi - spec nie weryfikuje warunku") | 94 + 97 | 5 + 3 |
| E2E-PAYROLL-002 | 🚧 blocked `playwright-runs` - wyczerpana pula dowodu; seed przez API OK, **reuse `payrollSeed`** | 197 | 10 |
| Release | **FAIL** (P0 0/1, P1 0/1) | Σ 388 | 18 |

Koszt realny: **$0.49** (fixture z abonamentu); qwen36 lokalnie $0. Kwoty w raporcie
($41.54) to ten sam fantom cennika SDK co wyżej.

**qwen3.6-MTP vs qwen3.8 - szybszy, ale słabszy jakościowo:**

| Metryka | qwen3.8 | qwen36-27b-mtp |
|---|---|---|
| Generacja (średnia z runu) | 14,8 t/s | 15,2 t/s |
| Generacja (krótki prompt) | 14 t/s | 44 t/s - zysk MTP znika przy długim kontekście |
| Tur na minutę | 1,35 | **4,6** |
| LOGIN | ✅ released, 141 tur / 36 min | ❌ ×2, 94+97 tur / 14+13 min |
| PAYROLL | ❌ attempt_failed ×4 (timeouty) | 🚧 blocked na puli dowodu, 197 tur, 10 runów pw |
| Wyjście na turę | ~120-140 tok | ~92-164 tok |
| Czas runu | 132 min | 84 min |

**Wnioski:**

- **Tempo przestało być wąskim gardłem, ale nie dzięki MTP**: surowa generacja
  wyszła praktycznie identycznie (15,2 vs 14,8 t/s średnio z całego runu -
  zysk spekulatywnego dekodowania widać tylko na krótkich promptach, przy
  50k+ znika), a oba modele piszą podobnie zwięźle (~120-140 vs ~92-164 tok
  na turę). Różnicę 4,6 vs 1,35 tury/min zrobił **prefill**, nie generacja -
  patrz sekcja o kotwicy dowodu i hipoteza o cache'u KV wyżej.
- **Wąskim gardłem jest jakość dowodu, nie objętość myślenia**: qwen3.6
  dwukrotnie wyprodukował test, który świeci na zielono, ale nie weryfikuje
  warunku - **dowód mutacyjny złapał to dwa razy z rzędu**,
  dokładnie ta klasa błędu, dla której powstał.
- Payroll doszedł dalej niż u qwen3.8 (seed przez API, reuse fixture'a,
  zielone runy w fazie dowodu), ale **zabrakło runów w puli dowodu**
  (`proofRuns: 4`) - 10 runów pw na case przy tak tanim modelu sugeruje, że
  dla lokalnych warto podnieść pulę dowodu, skoro run kosztuje tylko czas GPU.
- Do porównań na lokalnych: sprawdzać `ctx_size` w rejestrze Lemonade **przed**
  runem i pilnować, żeby nic innego nie prosiło o inny model lokalny (limit
  1 modelu = eksmisja w trakcie runu).

### Co przebiegi udowodniły (mechanizmy w boju)

- **Dowód mutacyjny łapie fałszywą zieleń**: 2× odrzucił mutacje, które nie czerwieniły testu
  (flash a2, opus a1) - dokładnie klasa błędu, dla której dowód istnieje.
- **Bezpiecznik seedu**: flash na churn-prone odcięty 2× po ~45 turach arrange za ~$0.01
  zamiast mielenia do capu (scenariusz „$13/case" z oryginalnego procesu zatrzymany za grosze).
- **Odporność na pady**: run flasha ubity w trakcie author → stan w StateStore przetrwał,
  wygasły lease przejęty, dokończony innym procesem bez utraty pracy (commity na branchu case'a).
- **Retry z wnioskami**: digest + uwagi przeglądu w promptcie trzeciej próby Opusa → delivered;
  auto-retry działa (trigger `auto-retry`/`human-retry` w ledgerze).
- **Harvest POM tnie koszt**: opus a3 z inventory (2 POM-y) = $1.27/48 tur vs a1 bez = $1.73/76 tur.
- **Oracle**: PAYROLL asertuje netto z `docs/golden-cases/netto.yaml`, nie z UI; mutacja o 1 grosz
  czerwieni się własną asercją.
- **Waiver P1 / bramki**: release FAIL bez waivera dla P0 (test negatywny), PASS z waiverem dla P1.
- **Koszty liczone z własnego cennika** (modelUsage × priceTable) - patrz pułapki.

### Pułapki znalezione i naprawione w trakcie prób

1. **SDK wycenia modele za bramą własnym cennikiem** (~60× zawyżenie dla flasha: $3.01 vs ~$0.05
   realnie) i **brama zeruje usage w streamie** → koszt liczymy z `modelUsage` (tokeny z resultu)
   × `priceTable`; natywny `maxBudgetUsd` zdegradowany do odbojnika ×20.
2. SDK **rzuca wyjątkiem po wyemitowaniu error-resultu** (max budget) → łapane, nie wywala partii.
3. Agenci przekazują raporty dowodu **ścieżkami plików**, nie treścią → narzędzie przyjmuje oba,
   waliduje JSON od razu (feedback w sesji).
4. Słabe modele **nie commitują** przed końcem → przywrócenie mutacji weryfikowane także
   testem treści (zmutowane linie diffa nieobecne w plikach), nie tylko czystym `git diff`.
5. Heurystyka powiązania asercji z warunkiem: nakładanie liczone też z **linii diffa** (wartości
   literalne, niezależne od języka opisu), stop-słowa kodowe, próg strojony 0.25 → **0.15**
   (dwa realne near-missy: 13% i 22%).
6. playwright-mcp wymaga `--browser chromium` (inaczej szuka systemowego Chrome'a).
7. Porzucone case'y w stanie `authoring` z wygasłym lease'em są teraz podejmowane przez `author`
   (luka wznowienia).
8. Nazwy modeli w bramie zmieniają się po rekonfiguracji - trzymać w konfigu per projekt,
   weryfikować `/v1/models` przed runem.

### Wnioski do dalszej pracy

- deepseek-v4-flash: zaskakująco zdolny na prostych flow przy koszcie ~centów; na churn-prone
  wymaga gotowego fixture'a (dokładnie po to jest mechanizm fixture-gap → człowiek dopisuje POM).
- Opus: rozwiązuje trudne case'y za pierwszym podejściem, koszt zgodny z targetem 2-5 $/test.
- Luna na tym przebiegu zachowała się bliżej deepseek-flash niż Opusa: doprowadziła P0 do `released`,
  ale P1 zatrzymała na `fixture-gap`; nie ma dowodu, że było to załamanie modelu, bo nie wystartował
  jeszcze żaden test Playwright. CLIProxy obsłużył 121 żądań `/v1/messages` kodem 200, bez 5xx;
  pojawiło się jedno ostrzeżenie pętli SDK po wyniku z `stop_reason=tool_use`, ale nie przerwało runu.
- Warto rozważyć osobny licznik runów playwright dla fazy dowodu (opus a1 zjadł limit na
  poprawkę wyścigu i zabrakło mu runa na finalny czerwony).

## Complex app (HR-Payroll)

> **Aktualne zestawienie modeli** (tabela zbiorcza + macierz per case,
> uzupełniane na bieżąco) mieszka w `benchmarks-complex-app.md`. Sekcje poniżej
> zostają jako materiał historyczny i analiza przyczyn per run.

Data: 2026-08-15 · appka: HR-Payroll demo (rola, paginacja serwerowa,
optimistic locking, PESEL z cyfrą kontrolną, workflow statusów, nakładanie
urlopów, celowy churn payrollu) · plan: `examples/benchmark-plan.json`.
Capy: 400 tur / 30 min / $8 / 12 runów pw / auto-retry 1 / snapshotGating
enforce. Eskalacja fixture-gap: deepseek→claude-opus-5, luna→gpt-5.6-sol (oba
na DOMYŚLNYM effortcie - medium; patrz wnioski). Repo testów świeże, z
minimalną app-map z README (poprzednie runy usera szły bez niej).

### Run 1 - wynik zbiorczy

| Model | Released | Porażki | Czas | Koszt |
|---|---|---|---|---|
| **deepseek-v4-flash-0731** (OpenRouter) | **9/10** | 1× blocked (payroll-create-churn - bug stęchłego kontekstu, patrz niżej) | 177 min | **$3.47** (w tym $2.43 eskalacje Opusa) |
| **gpt-5.6-luna** (CLIProxyAPI, medium) | **5/10** | 3× attempt_failed (dowód mutacyjny), 2× blocked (eskalacje Sola padły na turach) | ~150 min | $26.77 est. SDK (realnie $0 - subskrypcja) |

Release gates: oba FAIL (deepseek przez 1 niedomknięty case; luna przez 5).

#### Deepseek - per case

| Case | Status | Próby | Tury | Runy pw | Koszt |
|---|---|---|---|---|---|
| login-success | ✅ released | 1 | 97 | 7 | $0.03 |
| login-failure | ✅ released | 1 | 155 | 4 | $0.05 |
| employee-create-validation (PESEL) | ✅ released | 2 | 337 | 9 | $0.15 |
| employee-pagination-sort | ✅ released | 2 | 303 | 8 | $0.12 |
| employee-optimistic-lock | ✅ released | 1 | 174 | 10 | $0.08 |
| payroll-create-churn | 🚧 blocked | 3 | 253 | 9 | $1.47¹ |
| payroll-approve-pay | ✅ released | 2 | 218 | 8 | $1.15² |
| leave-create-overlap | ✅ released | 2 | 434 | 16 | $0.25 |
| leave-review | ✅ released | 1 | 151 | 4 | $0.07 |
| roles-employee-scope | ✅ released | 1 | 195 | 7 | $0.10 |

¹ w tym eskalacja Opusa $1.37.
² w tym eskalacja Opusa $1.06.

#### Luna - mapa porażek (szczegóły w archiwum runu)

- `login-failure`, `employee-create-validation`, `employee-pagination-sort` -
  **dowód mutacyjny**: mutacje nieczerwieniące testu + bałagan w plikach
  raportów (wszystkie runy piszą do jednego `pw-report.json`, Luna podawała
  ścieżki bez kopii per przebieg → walidator dostawał nadpisane raporty).
- `payroll-create-churn`, `payroll-approve-pay` - bezpiecznik seedu OK, ale
  **obie eskalacje Sola padły na `error_max_turns` (40)** - cap wąskiej sesji
  za ciasny na appkę z rolami/loginem przed seedem.
- `leave-create-overlap` - deklarowany `blocked(other)` („kontrakt API blokuje
  flow") po 184 turach - do przeglądu człowieka.
- Dowiezione: login-success, employee-optimistic-lock + 3 po drodze akceptów.

#### Porównanie run 1 z easy app (golden path)

- Deepseek: easy app 2/2 (z fixture od Opusa) ≈ $1.42; complex **9/10 za
  $3.47** - skalowanie kosztu niemal liniowe z liczbą case'ów, jakość trzyma.
- Luna: easy 2/2; complex 5/10 - dowód mutacyjny na trudnych flow to jej
  główna bariera (te same dwa błędy co na łatwej appce przed poprawkami,
  tylko częstsze).
- Fixture-author: 3/4 eskalacje dostarczyły zweryfikowany fixture; ekonomia
  potwierdzona ($1.0-1.4 za odblokowanie klasy case'ów payrollowych).

#### Wnioski run 1 → poprawki przed powtórką (szczegóły: `docs/tuning-backlog.md`)

1. **Bug stęchłego kontekstu**: author musi odświeżać triaż przed KAŻDĄ
   sesją - jedyna porażka deepseeka to jego skutek.
2. **Protokół kopii raportów dowodu** w promptcie - wytnie główną klasę
   porażek Luny.
3. **`fixtureSession.maxTurns` 40→80** - eskalacje na trudnej appce potrzebują
   miejsca na role/login przed seedem.
4. **Efforty**: cały run szedł na domyślnym medium - powtórka: luna(max)+sol(high)
   i deepseek(max)+opus(high); mechanika sufiksu efforu w CLIProxy zweryfikowana
   (`docs/model-bridges.md` §4a).

Wszystkie cztery poprawki (plus watchdog pierwszej tury → `blocked('infra')`,
osobna pula dowodu `caps.proofRuns`, workdiry trwałe w
`~/.local/share/greenproof/runs/<runId>`, live progress
`GREENPROOF_PROGRESS`, prewencyjny fixture-author per typ churn-prone) zostały
wdrożone 2026-08-15 (branch `feat/tuning-backlog-p1`, 13 commitów, 309 testów
zielonych) przed poniższym Run 2.

### Run 2 (po poprawkach): luna(max) + sol(high) - przerwany

Run `gp-bench-luna-20260815T183900-81uj` wystartował po zielonym preflighcie
(ping i wymuszony `tool_use`) bez LiteLLM. CLIProxyAPI empirycznie zaakceptował
`gpt-5.6-luna(max)`, `gpt-5.6-luna(xhigh)` i `gpt-5.6-luna(high)`, więc autor
pracował na najwyższym działającym wariancie `max`. Fixture-author pozostał na
`gpt-5.6-sol(high)`, ale przed przerwaniem runu nie został wywołany.

Tego przebiegu **nie należy interpretować jako wyniku 2/10**: proces
`grp step author` został zakończony sygnałem podczas trzeciego case'a, a
runner zwrócił `grp step author exit null`. Pozostałe case'y nie dostały
szansy wykonania.

| Case | Stan w chwili przerwania | Próby | Tury | Runy pw | Koszt est. SDK |
|---|---|---:|---:|---:|---:|
| login-success | ✅ delivered, proof `valid` | 1 | 104 | 4 assert + 1 proof | $1.51 |
| login-failure | ✅ delivered, proof `valid` | 1 | 101 | 3 assert + 1 proof | $1.47 |
| employee-create-validation | ⛔ authoring przerwane sygnałem | w toku | 83 zaobserwowane, nieutrwalone w totals | 0 | nieutrwalony |
| pozostałe 7 case'ów | nieuruchomione (`triaged`) | 0 | 0 | 0 | $0.00 |

Utrwalone totals obejmują wyłącznie dwa zakończone case'y: **205 tur** i
**$2.97 est. SDK**; realny koszt to **$0** (subskrypcja). Mostek obsłużył 136
żądań `/v1/messages` kodem 200, bez 5xx i bez utraty `tool_use`. Jedyny 499
pojawił się po zniknięciu klienta. Nie było OOM ani presji pamięci; jednostka
benchmarku osiągnęła 2.7 GB peak przy ponad 50 GB dostępnej pamięci. Obecny
runner nie zachowuje sygnału z eventu `close`, dlatego dokładnego źródła
zewnętrznego zakończenia procesu nie da się ustalić z tego przebiegu.

Trwały workdir: `~/.local/share/greenproof/runs/gp-bench-luna-20260815T183900-81uj/`.

### Run 2 (po poprawkach): deepseek(max) przez kanał abonamentowy - przerwany

2026-08-15 wieczór, wpis bramy `deepseek-flash-max` z `reasoning_effort:
max` i fallbackiem na OpenRouter - **PRZERWANY RĘCZNIE** przez usera po 2✓/10:

- `login-success` - delivered, 80 tur, $0.02, dowód valid.
- `login-failure` - delivered, 106 tur, $0.04, dowód valid.
- `employee-create-validation` (case 3) - przerwany w fazie `act` (~190 tur).

Zero błędów tool-callingu przez cały przebieg - wcześniejsza próba na tym kanale
(sekcja niżej) padała na „No tool output found"; nie wiadomo, co dokładnie
pomogło (inny wpis bramy / nowsza wersja LiteLLM / narzędzie run_playwright
zamiast Bash-owych runów), ale kanał jest teraz zdatny do sesji agentowych.

### Run 3 (2026-08-15/16 noc): deepseek(max) i luna(max) - po 8/10, obie porażki = REALNE BUGI APPKI

Pierwsze pełne runy przez jednokomendowy `grp run` (config `configs/…`,
`--in <plan>` + `--app-url`). Oba modele niezależnie poległy na TEJ SAMEJ parze
case'ów - i oba miały rację:

| Autor | Wynik | Koszt | Tury | Porażki |
|---|---|---|---|---|
| `deepseek-flash-max` (abonament) + eskalacja opus | **8/10 in_review** | $0.38 est. (realnie $0, subskrypcja) | 1640 | `employee-create-validation` blocked(time), `leave-create-overlap` blocked(other: app-defect) |
| `gpt-5.6-luna(max)` (CLIProxyAPI) + eskalacja sol | **8/10 in_review** | $33.08 est. SDK (realnie $0, subskrypcja) | 2028 | te same dwa case'y, oba blocked(other) z diagnozą |

**Trzy defekty appki HR-Payroll, potwierdzone w źródłach linia po linii:**

1. `public/leave.html:39-42` wysyła polskie typy urlopów
   (`wypoczynkowy/chorobowy/…`), a `src/server.js:687` akceptuje wyłącznie
   `vacation|sick|unpaid` → każdy submit z UI = 400.
2. `src/server.js:696` robi `SELECT … WHERE full_name = ?` na tabeli
   `employees`, która NIE MA kolumny `full_name` → POST /api/leave dla roli
   employee = 500.
3. `public/employees.html:60` ma `#add-employee-form-container` z twardym
   `display:none`, a JS tylko UKRYWA `.nav-admin` nie-adminom, nigdy nie
   pokazuje adminowi → formularz dodania pracownika nieosiągalny dla nikogo.

Deepseek udowodnił defekt „na 3 niezależnych poziomach" (served HTML, kod
serwera, zachowanie API) i odmówił fabrykowania zieleni; luna dtto + pełna
diagnoza ukrytego formularza (deepseek na nim spalił cap czasu).

**Kontekst historyczny:** bugi istniały już w run 1 - tamten deepseek dostał
9/10, bo leave obszedł PRZEZ API (`page.request` z `type:'vacation'`,
udokumentowane w komentarzach speca z archiwum). Dzisiejsza, ostrzejsza
dyscyplina (oracle-first, `run_playwright`, wymóg realnego flow UI) zamieniła
obejście w raport defektu - **8/10 z dwoma poprawnymi zgłoszeniami bugów jest
uczciwsze niż tamte 9/10**.

**Wniosek systemowy:** raport defektu ląduje dziś jako `blocked(other)` i ginie
w kupce blokad - backlog **8.7** (osobny raport „app-defect?" w deliver)
dostał najlepsze możliwe uzasadnienie; do podniesienia priorytetu.

**Naprawa (2026-08-16):** wszystkie trzy defekty poprawione w
`~/dev/hr-payroll-demo` (commit z opisem; weryfikacja na świeżej bazie:
wniosek employee 201, nakładanie 422, zły typ 400) - powtórka runu mierzy od
teraz czyste autorowanie i 10/10 jest osiągalne.

## Wcześniejsze próby (kanał abonamentowy / fallback)

Pierwsze przebiegi pełnego pipeline'u greenproof na trudnej appce, sprzed
poprawek z `docs/tuning-backlog.md` i sprzed wpisu bramy z wymuszonym
effortem - inny zestaw runów niż Run 1/Run 2 wyżej, zebrany 2026-08-14/15.
Pipeline uruchamiany przez `packages/cli/dist/main.js`, autor przez Claude
Agent SDK → brama LiteLLM (`http://127.0.0.1:4000`). Adapter-fs, repo testów:
`examples/benchmark-tests`.

### Uczestnicy

| Run | Model (przez bramę) | Config | RunId |
|---|---|---|---|
| abonament | `deepseek-flash` | `benchmark-abonament.config.mjs` | `...2250` |
| fallback | `deepseek-v4-flash` (OpenRouter 0731) | `benchmark-fallback.config.mjs` | `...0922` |

### Run abonamentowy (`deepseek-flash`)

**Wynik: 1/10 delivered.** Częściowo zablokowany przez błędy bramy:
`No tool output found for tool call` z Console Go (problem po stronie
dostawcy abonamentu) - stąd decyzja o runie fallbackowym.

| Case | Wynik | Tury | Koszt |
|---|---|---|---|
| employee-optimistic-lock | **delivered** | 182 | $1.91 |
| employee-create-validation | blocked | 71 | $0.02 |
| employee-pagination-sort | blocked | 54 | $0 |
| leave-create-overlap | blocked | 24 | $0 |
| leave-review | attempt_failed | 109 | $1.16 |
| login-failure | blocked | 40 | $0 |
| login-success | blocked | 45 | $0 |
| payroll-approve-pay | blocked | 44 | $0 |
| payroll-create-churn | blocked | 33 | $0 |
| roles-employee-scope | blocked | 61 | $0.02 |

**Koszt łączny: ~$3.11** (niemal wszystko w 2 case'ach).

### Run fallback (`deepseek-v4-flash` 0731, OpenRouter) - PRZERWANY RĘCZNIE

Run zatrzymany na życzenie użytkownika po 3 dostarczonych case'ach
(5 w toku, 2 failed po auto-retry).

| Case | Wynik | Tury | Koszt | Runy PW |
|---|---|---|---|---|
| login-success | **delivered** | 145 | $0.15 | 6 |
| login-failure | **delivered** | 85 | $0.11 | 4 |
| employee-optimistic-lock | **delivered** | 301 | $0.56 | 6 |
| employee-create-validation | attempt_failed | 223 | $0.29 | 7 |
| employee-pagination-sort | attempt_failed | 90 | $0.13 | 4 |
| leave-create-overlap | (przerwany, w toku) | - | - | - |
| leave-review | (przerwany, w toku) | - | - | - |
| payroll-approve-pay | (przerwany, w toku) | - | - | - |
| payroll-create-churn | (przerwany, w toku) | - | - | - |
| roles-employee-scope | (przerwany, w toku) | - | - | - |

**Koszt zrealizowanych case'ów: ~$1.24** (3 delivered + 2 failed).

### Porównanie (skorygowane o niepełny przebieg)

| Metryka | ds-flash (abonament) | ds-v4-flash (częściowo) |
|---|---|---|
| Delivered | 1/10 | 3/5 ukończonych |
| Koszt / delivered case | $1.91 | ~$0.27 |
| Średni koszt / case | ~$0.31 | ~$0.25 |
| Błędy infrastruktury | `No tool output` (Console Go) | brak |

**Wnioski:**

1. **deepseek-v4-flash 0731 (OpenRouter) wyraźnie najlepszy**: 3 delivered
   z dowodem mutacyjnym po ~0.3-0.6 USD/case, 0 błędów infrastruktury.
2. **deepseek-flash (abonament) ma problem z tool-callami** przez
   Console Go (`No tool output found`) - nie nadaje się do pracy
   narzędziowej jak playwright/autorowanie; jako model czysto tekstowy
   działa, ale sesje agentowe padają. (Rozwiązane w Run 2 trudnej appki
   wpisem bramy `deepseek-flash-max` z wymuszonym effortem - zero
   błędów tool-callingu.)
3. Najtrudniejsze case'y dla wszystkich modeli: **payroll-create-churn**
   (losowy 503 + długie delay) i **roles-employee-scope** (wymaga
   wielosesyjnej weryfikacji ról). Najłatwiejsze: **login-\***.
4. Auto-retry (maxAutoRetries: 1) działa - attempt_failed → 2. próba.

### Uwagi techniczne

- Gałęzie `author/*` w `benchmark-tests` są efemeryczne - pipeline
  autorów odtwarza je z commitu bazowego przy każdej próbie; usunięte
  gałęzie fallbacka zostały odtworzone z reflog (commity `login-success`
  ff52952, `login-failure` d94599b).
- Spec'y delivered siedzą w artifact store:
  `benchmark-platform-{abonament,fallback}/artifacts/<runId>/cases/<case>/spec.ts`
  + `proof.json` (dowód mutacyjny).

## Operacyjnie: monitoring i efforty

Fakty trwałe, niezależne od konkretnej sesji benchmarku:

- **Workdir runu**: `~/.local/share/greenproof/runs/<runId>/` (XDG, stamp =
  ISO bez separatorów do sekundy + losowy sufiks, np.
  `20260815T175042-3f2a`). Stan pipeline'u:
  `<workdir>/platform/state/<runId>.json`.
- **Live progress**: stderr harnessu pokazuje postęp sam - w terminalu
  interaktywnym tablica TTY, w unitach systemd/logach linie plain
  `[grp HH:MM:SS] …` per tura/case/run playwright (throttlowane do jednej linii
  na ≤30 s), plus linie `[benchmark-path]` dla fixture-eskalacji i ponownych
  prób. Sterowane zmienną `GREENPROOF_PROGRESS` (`auto`/`tty`/`plain`/
  `github`/`json`).
- **Post-hoc**: `grp status --run <runId>` zwraca pole `summary`
  (done/remaining/passed/failed, koszt, tury) - bez ręcznego grep-owania stanu.
- **Transcrypty prób**: `<workdir>/<caseId>/attempt-N/messages.jsonl`,
  wersjonowane raporty playwright:
  `<workdir>/<caseId>/attempt-N/pw-runs/run-NN-<purpose>.json`.
- **Efforty per kanał**:
  - CLIProxyAPI parsuje sufiks w nazwie modelu, np. `gpt-5.6-luna(high)`,
    `gpt-5.6-luna(max)` (myślnik `-high` NIE działa - tylko forma
    `(poziom)`); najwyższy działający poziom trzeba sprawdzać empirycznie na
    danym mostku (curl `/v1/messages` z ping + oczekiwanym `"type":"message"`),
    nie zakładać z pamięci.
  - Na bramie LiteLLM efforty wymuszane są przez dedykowany wpis modelu z
    `reasoning_effort` na sztywno w `litellm_params` (przykład: wpis
    `deepseek-flash-max` z `reasoning_effort: max`) - nie przez sufiks
    w nazwie.
