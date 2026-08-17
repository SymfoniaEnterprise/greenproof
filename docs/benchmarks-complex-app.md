# Benchmarki complex app (HR-Payroll)

Pełna pętla greenproof (`filter → triage → author → deliver → accept → release`)
na appce **HR-Payroll demo** (`~/dev/hr-payroll-demo`), plan: **10 case'ów**
(`examples/benchmark-plan.json`) - role, paginacja serwerowa, optimistic
locking, PESEL z cyfrą kontrolną, workflow statusów, nakładanie urlopów,
celowy churn payrollu. Adapter: fs. Capy: 400 tur / 30 min / $8 per case,
12 runów pw + osobna pula dowodu, auto-retry 1, snapshotGating enforce.

Zestawienie trzyma **wyłącznie runy na naprawionej appce** (bugi HR-Payroll
usunięte 2026-08-16 rano - wcześniejsze przebiegi trafiały na 3 realne defekty
i nie są porównywalne; historia w `benchmarks.md`). Plik uzupełniany
**na bieżąco**, w miarę kończenia runów.

## Zestawienie modeli

| Model | Skąd | Wynik | Σ tur | Czas | Eskalacje fixture | Koszt autora | Uwagi |
|---|---|---|---|---|---|---|---|
| deepseek-flash-max + opus | abonament (brama) | **10/10** in_review | 1734 | 141 min (11:18-13:39) | 2× claude-opus-5 (payroll-create-churn, payroll-approve-pay) - obie udane, łącznie $2,43 (est.) - $1,37 + $1,06, 82 tury | $1,76 (est.) | pierwszy komplet 10/10 na complex app; `leave-review` za 2. próbą (auto-retry) |
| gemini-3.7-flash | OpenRouter | **10/10** in_review | **616** | **45 min** (14:27-15:12) | żadna | **$2,30** | komplet **za pierwszym podejściem w każdym case'ie**, bez auto-retry i bez żadnego fixture (plan bez typów churn-prone); 3× mniej tur i 3× krócej niż poprzednicy |
| gpt-5.6-luna(max) + sol(high) | subskrypcja przez mostek OAuth | **10/10** in_review (10. case po ręcznym retry - tabela niżej) | 1879 | 129 min (11:20-13:29) + 8 min retry | 2× gpt-5.6-sol (payroll-create-churn, payroll-approve-pay) - pierwsza NIEUDANA (error_max_turns), druga udana: $1,04 (est.), 70 tur | $25,60 (est. SDK, prawdopodobnie zawyżona - wycena cennikiem obcego dostawcy, ten sam mechanizm co fantomowe kwoty modeli lokalnych) | w runie 9/10; `employee-optimistic-lock` blocked(`time`) - 129 tur / 30 min capu, 0 runów pw |
| Qwen3.6-27B-MTP-GGUF Q5\_K\_M | **lokalnie** (llama.cpp Vulkan / Lemonade, ctx 131072) | **8/10** accepted w runie, **10/10** po dwóch ręcznych retry (tabela niżej) | 1408 (+330 w retry) | **337 min** (00:26-06:03, cap 60 min/case) + 91 min retry | żadna | **$0** (GPU, nie kwota) | pierwszy model LOKALNY na complex app; **10 dowodów mutacyjnych ważnych, zero ostrzeżeń walidatora**; w runie 2× blocked(`time`) - `employee-create-validation` (235 tur, 4 z 4 prób dowodu) i `employee-optimistic-lock` (175 tur, 0 dowodów); `login-success` za 2. próbą (auto-retry po `attempt_failed` w 29 turach) |

Uwaga: `costUsd` ze stanu runu (deepseek $1,76, luna $25,60) pokrywa się co do grosza z sumą ledgerów samych case'ów - koszt sesji eskalacji fixture NIE jest w nim zawarty, więc kwoty z kolumny „Eskalacje fixture" nie są doliczone do „Koszt autora" i nie należy ich dodawać po cichu.

### Ręczne retry (drabinka po runie)

| Run | Case | Powód retry | Wynik | Tury | Runy pw | Czas | Koszt | Co zadziałało |
|---|---|---|---|---|---|---|---|---|
| luna-max | `employee-optimistic-lock` | blocked(`time`) po próbie 1 | ✅ **delivered** (a2, human-retry) | 129 | 3 | 8 min (13:37-13:45) | $0 | `notes` w `--in`: „bez eksploracji od nowa - od razu edycja w dwóch kontekstach i asercja konfliktu wersji"; digest próby 1; cap czasu bez zmian (30 min) |
| qwen3.6-27b-mtp | `employee-create-validation` | blocked(`time`) po próbie 1 | ⚠️ `attempt_failed` (a2) → ✅ **delivered** (a3) | 49 + 49 | 3 + 3 | 9 min + **5,9 min** (09:36-09:45, 10:00-10:06) | $0 | a2 miała KOMPLET dowodu i przepadła na buga biblioteki (niżej); a3 z tą samą ścieżką dowodu poszła w 6 minut przy 1 z 8 prób dowodu |
| qwen3.6-27b-mtp | `employee-optimistic-lock` | blocked(`time`) po próbie 1 | ✅ **delivered** (a2) | 232 | 10 | **75,7 min** (10:05-11:14) | $0 | cap czasu 60 → 150 min był tu realnie potrzebny: 76 min to więcej, niż nocny run mógł dać. Najpierw przestawił kolejność testów pod kotwicę (`58d8f24`), potem naprawił PESEL, `loadEmployees` i parsowanie odpowiedzi API (`6349985`) |

Oba retry poszły tym samym configiem z podniesionymi sufitami: `maxTimeMinutes`
60→150, `proofRuns` 4→8, `maxPlaywrightRuns` 12→24, `maxAutoRetries` 1→0
(przy 150-minutowym capie automatyczne powtórzenie od zera kosztowałoby drugie
2,5 h GPU - jedna próba na komendę, decyzję o kolejnej podejmuje człowiek).
**Z podniesionych capów przydał się tylko czas
i to wyłącznie drugiemu case'owi**: `employee-create-validation` zużył 1 z 8
prób dowodu i 3 z 24 runów pw. Po tych dwóch retry qwen3.6-27b-mtp ma na
complex app **10/10 z ważnym dowodem i zerem ostrzeżeń walidatora**.

#### Czego nauczył nas `attempt_failed` z 09:45

Próba 2 `employee-create-validation` zrobiła wszystko poprawnie - przestawiła
testy pod kotwicę, zebrała dwa zielone przebiegi, zmutowała oczekiwany
komunikat PESEL, dostała czerwony przebieg, zapisała surowiec dowodu z
poprawnym `proofTest` i przywróciła plik - po czym **zakończyła turę bez
wywołania `finish`**. Bez `declaredStatus` krok autora klasyfikuje próbę jako
`attempt_failed`, więc gotowy dowód poszedł do kosza.

Przyczyna była w komunikacie zwracanym przez `record_proof_material`: mówił
„zrób commit końcowy i **zakończ sesję**", nie nazywając narzędzia. Komunikaty
na ścieżkach STOP nazywały `finish` od zawsze - ścieżka SUKCESU, jedyna
prowadząca do `delivered`, jako jedyna nie. Model chmurowy domyśla się z
promptu (wzmianka o `finish` pada tam raz, kilkadziesiąt tur wcześniej),
lokalny 27B wziął instrukcję dosłownie.

Poprawione w `packages/core/src/author/tools.ts` (numerowane kroki + jawne
ostrzeżenie, że bez `finish` próba przepada) razem z testem regresyjnym w
`run-playwright.test.ts`. To **trzeci** przypadek w tym benchmarku, w którym
run przegrał nie z powodu słabości modelu, tylko luki w instrukcji - po regule
kotwicy i fantomowym budżecie SDK. Wniosek się powtarza: **narzędzie musi
powiedzieć modelowi to, czego od niego wymaga, w momencie, w którym tego
wymaga** - a modele lokalne są najczulszym wykrywaczem takich luk, bo nie
nadrabiają domysłem.

W kolejce po tych runach: **GLM 5.2** - przy czym kanał abonamentowy jest
2026-08-16 niesprawny (patrz `benchmarks-easy-app.md`), więc realnie
pójdzie przez OpenRouter (`z-ai/glm-5.2`).

Run gemini poszedł presetem `litellm` z autorem `gemini-3.7-openrouter`
(stawki OpenRoutera) i eskalacją fixture na `deepseek-v4-flash` - nie na kanał
abonamentowy, bo ten tego dnia padał.
Pierwsze podejście wystartowało na starym repo testów i **pominęło 4 case'y**
jako już pokryte (zostały gałęzie `author/*` po przerwanym runie); wynik niżej
pochodzi ze świeżego repo `~/dev/gp-testy-gemini37-v2`, gdzie filtr wybrał
pełną dziesiątkę.

## Per case (macierz)

✅ = delivered/released z ważnym dowodem, 🚧 = blocked, ⏳ = w toku,
`(a2)` = za drugą próbą.

| Case | Prio | ds-max | luna-max | gemini-3.7 (tury/pw) | qwen3.6-27b-mtp (tury/pw, czas) |
|---|---|---|---|---|---|
| login-success | P0 | ✅ | ✅ | ✅ 36/3 | ✅ (a2) 89/4, 11 min |
| login-failure | P0 | ✅ | ✅ | ✅ 88/3 | ✅ 123/5, 23 min |
| employee-create-validation | P0 | ✅ | ✅ | ✅ 49/4 | ✅ (a3 retry) 49/3, 6 min¹ |
| employee-pagination-sort | P1 | ✅ | ✅ | ✅ 53/6 | ✅ 119/7, 23 min |
| employee-optimistic-lock | P1 | ✅ | ✅ (a2 retry) | ✅ 54/5 | ✅ (a2 retry) 232/10, 76 min¹ |
| payroll-create-churn | P0 | ✅ | ✅ | ✅ 62/5 | ✅ 117/6, 27 min |
| payroll-approve-pay | P1 | ✅ | ✅ | ✅ 96/15 | ✅ 125/6, 46 min |
| leave-create-overlap | P1 | ✅ | ✅ | ✅ 58/5 | ✅ 137/8, 34 min |
| leave-review | P1 | ✅ (a2) | ✅ | ✅ 66/9 | ✅ 145/5, 31 min |
| roles-employee-scope | P0 | ✅ | ✅ | ✅ 54/4 | ✅ 114/3, 21 min |

¹ Kolumna qwen: w samym runie oba te case'y wyszły blocked(`time`) (235 tur /
10 pw i 175 tur / 4 pw, po 60 min każdy). Liczby w tabeli pochodzą z ręcznych
retry z 2026-08-17 - szczegóły w drabince wyżej.

### Run lokalny (qwen3.6-27b-mtp, noc 16/17.08) - co z niego wynika

Poszedł presetem `litellm` z nadpisaniami pod model lokalny (w `configs/`
trzymamy tylko trzy presety, więc odtwarza się go tak):

```js
model: {
  baseUrl: 'http://127.0.0.1:4000',
  authTokenEnv: 'LITELLM_KEY',
  author: '<alias modelu lokalnego w bramie>',
  costModel: 'local',          // bez tego natywny cap SDK wycenia run stawkami
                               // Anthropic i ubija go fantomowym budżetem
  maxOutputTokens: 8192,       // llama.cpp: prompt + max_tokens ≤ ctx
},
caps: {
  maxTurns: 400,
  maxTimeMinutes: 60,          // 30 min (jak u chmurowych) NIE wystarcza:
                               // lokalny 27B robi ~4-5,5 tury/min
  maxPlaywrightRuns: 12, proofRuns: 4, maxAutoRetries: 1,
  firstTurnTimeoutMinutes: 15, // pierwsza tura to prefill ~50k tokenów;
                               // domyślne 5 min klasyfikowało żywą sesję
                               // jako awarię infrastruktury
},
```

**Kontekst modelu ustawia się w rejestrze silnika, nie w greenproofie**:
`lemonade load <model> --ctx-size 131072 --save-options`. Samo
`POST /api/v1/load {ctx_size}` działa tylko na bieżącą instancję i ginie przy
przeładowaniu - tak przepadł kontekst w runie qwen3.8 z 16.08. Weryfikacja
przed startem: `pgrep -af llama-server | grep -o '\-\-ctx-size [0-9]*'`.
Silnik trzyma JEDEN model naraz, więc inne runy lokalne muszą być skończone.

Eskalacja fixture była skonfigurowana na model chmurowy z bramy, ale **nie
odpaliła ani razu** - plan nie miał typów churn-prone, a żaden case nie zgłosił
`fixture-gap`.

- **Jakość dowodów bez ustępstw**: 8/8 dowodów `valid` w samym runie (10/10 po
  retry), każdy z 2 zielonymi
  przebiegami, mutacją trafiającą w warunek case'a i zweryfikowanym przywróceniem
  pliku (`gitDiffEmpty`). **Zero ostrzeżeń** walidatora - żadnej mutacji poza
  zakresem, żadnego podejrzenia o obcą asercję. Lokalny 27B nie produkuje
  „zieleni na skróty".
- **Porażki były czasowe, nie merytoryczne - i retry to potwierdziło**:
  `employee-create-validation` wykonał w runie 10 runów Playwrighta i **4 pełne
  próby dowodu**, dobijając do poprawnej mutacji, gdy skończył się cap;
  w retry dowiózł go w **6 minut** przy 1 próbie dowodu. `employee-optimistic-lock`
  (dwa konteksty przeglądarki, konflikt wersji) nie doszedł w runie nawet do
  fazy dowodu, a w retry potrzebował **76 minut** - czyli realnie więcej, niż
  60-minutowy cap mógł dać. Oba to case'y, które modele chmurowe też mają za
  najdroższe (luna też poległa na optimistic-lock w 30 min).
- **Wąskim gardłem jest prefill, nie generowanie**: 647 żądań do bramy,
  **28,9 mln tokenów wejścia** przy 176 tys. wyjścia - 164 tokeny wczytane
  na każdy wygenerowany. Ledgery raportują 17,3 mln wejścia, bo case'y
  `blocked` nie domykają rozliczenia tokenów; do porównań tempa używać liczb
  z bramy.
- **Cena**: 5 h 37 min pracy GPU w runie plus 1 h 31 min retry, $0 z kieszeni.
  Gemini zrobił 10/10 w 45 min za $2,30 - lokalny doszedł do tego samego 10/10,
  ale ~9× wolniej i z ręczną interwencją człowieka. Bez kosztu i bez wysyłania
  kodu na zewnątrz.

Warte odnotowania: oba case'y, które w nocnych runach na zabugowanej appce
kładły oba modele (`employee-create-validation`, `leave-create-overlap`),
po naprawie appki przeszły u obu za pierwszym podejściem - porażki były
diagnozą defektów, nie słabością autorów.

## Jak czytać kolumny

- **Wynik** - case'y z ważnym dowodem mutacyjnym / 10; `delivered`/`in_review`
  = dowiezione. Runy z tej tabeli szły przed auto-akceptacją, więc czekały na
  ręczny `accept`; dziś pipeline przyjmuje je sam, a człowiekowi zostaje
  `release`.
- **Σ tur** - suma tur całego runu razem z sesjami eskalacji; miara wysiłku
  modelu niezależna od tempa sprzętu/API.
- **Eskalacje fixture** - ile razy pipeline dopłacił mocniejszemu modelowi za
  wąską sesję fixture (mechanizm opisany w `benchmarks-easy-app.md`).
- **Koszt autora** - estymata zużycia tokenów × cennik, zawsze z dopiskiem
  `(est.)`; przy abonamencie/subskrypcji (abonament, subskrypcja) realnie z kieszeni
  nic nie wychodzi, ale kwotę estymaty podajemy mimo to.

## Runy historyczne - appka z defektami (osobna tabela)

Przebiegi sprzed naprawy 3 bugów HR-Payroll (2026-08-16 rano): niedopasowane
typy urlopów UI↔API, `full_name` na tabeli bez tej kolumny, formularz admina
na stałe ukryty. **Nie porównywać z tabelą główną** - mierzyły inną appkę.

| Model | Skąd | Wynik | Σ tur | Czas | Eskalacje fixture | Koszt autora | Uwagi |
|---|---|---|---|---|---|---|---|
| deepseek-flash-max + opus | abonament (brama) | **8/10** in_review | 1640 | noc 15/16.08 | opus (fixture payroll) | $0 (est. $0.38) | 2 blokady = poprawne raporty defektów appki |
| gpt-5.6-luna(max) + sol(high) | subskrypcja przez mostek OAuth | **8/10** in_review | 2028 | noc 15/16.08 | sol | $0 (est. SDK $33.08) | te same 2 blokady, pełna diagnoza ukrytego formularza |

Per case (runy historyczne):

| Case | Prio | ds-max run 3 | luna-max run 3 |
|---|---|---|---|
| login-success | P0 | ✅ | ✅ |
| login-failure | P0 | ✅ (a2) | ✅ |
| employee-create-validation | P0 | 🚧 time¹ | 🚧 defekt appki¹ |
| employee-pagination-sort | P1 | ✅ | ✅ |
| employee-optimistic-lock | P1 | ✅ | ✅ |
| payroll-create-churn | P0 | ✅ | ✅ (a2) |
| payroll-approve-pay | P1 | ✅ | ✅ |
| leave-create-overlap | P1 | 🚧 defekt appki | 🚧 defekt appki |
| leave-review | P1 | ✅ | ✅ |
| roles-employee-scope | P0 | ✅ (a2) | ✅ |

¹ Ten sam defekt (formularz admina ukryty na stałe): deepseek spalił na jego
odkrywaniu cap czasu, luna dowiozła pełną diagnozę jako `blocked(other)`.
Oba modele odmówiły fabrykowania zieleni na zepsutym UI - **8/10 z dwoma
poprawnymi zgłoszeniami bugów to wynik uczciwy**, nie porażka autorów.
