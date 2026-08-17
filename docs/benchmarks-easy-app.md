# Benchmarki easy app (DemoPay)

Pełna pętla greenproof (`filter → triage → author → deliver → accept → release`)
na appce **DemoPay** (`~/dev/demopay-demo`), plan: 2 case'y -
`E2E-LOGIN-001` (P0, logowanie) i `E2E-PAYROLL-002` (P1, churn-prone
`lista-plac`, oracle netto z golden-case'ów). Adapter: fs.

Runy z 2026-08-16 idą na wersji kodu po poprawkach z tego dnia (reguła kotwicy
w prompcie autora, brak fantomowego capu kosztu dla modeli lokalnych).
Runy Opus, deepseek i Luna idą na starszej wersji silnika - bez reguły kotwicy,
z capem runów Playwright 6 zamiast 12 + 4 dowodu i ratunkowym (nie
prewencyjnym) trybem fallbacku - ich wyniki czytać jako orientacyjne.

Stan na 2026-08-16 wieczorem: **stawka zamknięta** - 6 modeli lokalnych
i 6 chmurowych/abonamentowych.

## Wnioski

**Pięć z sześciu modeli lokalnych przechodzi golden path bez waiverów.** Rok
temu byłoby to nie do pomyślenia; dziś różnicują je nie „czy dowiozą", tylko
ekonomia - liczba tur i uruchomień testów potrzebnych do tego samego wyniku.

- **Najoszczędniejszy: Qwen3.6-27B-MTP** - 160 tur i 6 uruchomień Playwrighta,
  oba case'y za pierwszym podejściem. Wzorzec ekonomii wśród lokalnych.
- **Najszybszy: Ornith-1.0-35B** - 9,0 tury/min, cały run w 25 minut, mimo że
  oba case'y dowiózł dopiero za drugą próbą.
- **Najdroższy w pracy GPU: Laguna-XS-2.1** - 376 tur i 21 uruchomień testów na
  te same 2 case'y. Szybka, ale nadrabia szybkością to, czego nie trafia za
  pierwszym razem.
- **Jedyna porażka: Qwen3.6-35B-A3B**, jedyny model z wyłączonym myśleniem.
  Dowód mutacyjny trafił bez problemu, ale dwa razy poległ na doprowadzeniu
  aplikacji do stanu wyjściowego (`fixture-gap`) - patrz ².

**Chmura nadal wygrywa jakością na turę, ale przewaga stopniała.**
Gemini 3.7 zamknął oba case'y w **64 turach i 13 minutach za $0,19** - to 2,5×
mniej tur niż najlepszy lokalny. Opus jest najszybszy wśród płatnych (11 minut),
ale kosztuje $3,33, czyli 17× więcej od Gemini przy gorszej ekonomii tur.

Plik uzupełniany **na bieżąco**, w miarę kończenia runów.

## Modele lokalne

Lemonade → llama.cpp (Vulkan), kontekst 131072, koszt = czas GPU.

| Model | Kwantyzacja | LOGIN | PAYROLL | Σ tur | Czas | Tur/min | Runy Playwright | Fallback | Release |
|---|---|---|---|---|---|---|---|---|---|
| Laguna-XS-2.1 33B-A3B | Q4_K_M (MoE) | ✅ released, 175 tur (a1) | ✅ released, 201 tura (a1) | 376 | 42,1 min | 8,9 | **21** | prewencyjny: `deepseek-v4-flash` - $0,19 | **PASS**¹ |
| Qwen3.6-27B-MTP | Q5_K_M | ✅ released, 89 tur (a1) | ✅ released, 71 tur (a1) | 160 | 29,2 min | 5,5 | 6 | prewencyjny: `deepseek-flash` - $0,27 / 76 tur | **PASS** |
| Muse-Glimmer-30B | K-Quant Dynamic Q4_K_XL | ✅ released, 104 tury (a1) | ✅ released, 70 tur (a1) | 174 | 36,7 min | 4,7 | 11 | prewencyjny: `deepseek-flash` - $0,34 / 71 tur | **PASS** |
| Qwen3.8-27B | UD-Q4_K_XL | ✅ released, 103 tury (a1) | ✅ released, 93 tury (a1) | 196 | 62,5 min | 3,1 | 8 | prewencyjny: `deepseek-v4-flash` (OpenRouter) - $0,47 | **PASS** |
| Ornith-1.0-35B | Q4_K_M (MoE) | ✅ released, 78 tur (a2) | ✅ released, 66 tur (a2) | 227 | 25,2 min | 9,0 | 11 | prewencyjny + ratunkowy: `deepseek-v4-flash` - $0,78 łącznie | **PASS** |
| Qwen3.6-35B-A3B | Q8_0 (MoE, **bez myślenia**) | ✅ released, 85 tur (a1) | 🚧 blocked `fixture-gap` ×2 (45 + 45 tur) | 175 | 25,8 min | 6,8 | 4 | prewencyjny + 2× ratunkowy: `deepseek-v4-flash` - $1,31 | FAIL² |

¹ **Laguna: szybkość zamieniona na próby, nie na czas.** Dowiozła oba case'y
za pierwszym podejściem, ale najdrożej ze wszystkich: **376 tur i 21 runów
Playwright** (Qwen3.6 potrzebował 160 tur i 6 runów na to samo). Tempo miała
drugie w stawce (8,9 tury/min, zgodnie z deklarowanymi 92 tok/s) - cała
przewaga szybkości poszła jednak na dochodzenie do zieleni metodą prób, nie na
skrócenie runu. Sam LOGIN zjadł 15 uruchomień testów.

To model, który nadrabia szybkością to, czego nie trafia za pierwszym razem:
przy tanim sprzęcie działa, ale w przeliczeniu na obciążenie GPU jest
najkosztowniejszy z lokalnych.

² **A3B (jedyny model z jawnie wyłączonym myśleniem)** dowiózł LOGIN za pierwszym
podejściem (85 tur), ale PAYROLL poległ dwukrotnie na `fixture-gap` (po 45 turach)
- mimo gotowego fixture'a nie doprowadził aplikacji do stanu wyjściowego.

## Modele chmurowe i abonamentowe

| Model | Skąd | LOGIN | PAYROLL | Σ tur | Czas | Runy Playwright | Fallback | Koszt autora | Koszt eskalacji | Release |
|---|---|---|---|---|---|---|---|---|---|---|
| deepseek-v4-flash 0731 | OpenRouter / abonament | ✅ released, 94 tur (a2) | ✅ released, 132 tury (a3) | 226⁴ | 45,4 min⁵ | 8 (payroll) | ratunkowy: `claude-opus-5` - $1,30 / 40 tur | ~$0,12 | $1,30 (est.) - 1 run ratunkowy | **PASS** |
| gemini-3.7-flash | OpenRouter | ✅ released, 33 tury (a1) | ✅ released, 31 tur (a1) | **64** | **13,3 min** | 7 | prewencyjny: `deepseek-flash` - $0,47 / 98 tur | $0,19 | $0,47 (est.) - run prewencyjny | **PASS** |
| GLM 5.2 | OpenRouter (`z-ai/glm-5.2`) | ✅ released, 63 tury (a1) | ✅ released, 98 tur (a2) | 161 | 17,7 min | 8 | prewencyjny: `deepseek-v4-flash` - 54 tury | $0,36³ | kilka centów (est.) - run prewencyjny | **PASS** |
| claude-opus-5 | subskrypcja Claude | ✅ released, 36 tur (a1) | ✅ released, 68 tur (a1) | 104 | **11,1 min** | 6 | prewencyjny: `claude-opus-5` - $0,70 / 25 tur | $3,33 (est.) | $0,70 (est.) - run prewencyjny | **PASS** |
| gpt-5.6-luna | subskrypcja przez mostek OAuth | ✅ released, 32 tury (a1) | ✅ released, 66 tur (a2) | 158 | 14,2 min | 6 | prewencyjny `claude-opus-5` $0,86 **+ ratunkowy** `claude-opus-5` $1,14 / 37 tur | ~$3,36 (est.) | $2,00 (est.) - prewencyjny + 1 ratunkowy⁶ | **PASS** |
| claude-sonnet-5 | subskrypcja Claude | ✅ released, 63 tury (a1) | ✅ released, 138 tur (a1) | 223 | 16,2 min | 12 | prewencyjny: `claude-opus-5` | $4,39 (est.) | run prewencyjny, kwoty brak w źródle | **PASS** |

³ **Dlaczego raport pokazał $0, a realnie kosztowało $0,36.** Koszt liczy własny
licznik: tokeny × `priceTable` pod kluczem autora. Autorem był `glm-abonament`, a jego
stawki są zerowe (wpis abonamentowy), więc licznik policzył zero. Pracę wykonał
jednak fallback `openrouter/z-ai/glm-5.2`, rozliczany normalnie: 103 żądania,
3,70 mln tokenów wejścia, 17,7 tys. wyjścia = **$0,3612** (dane z
`LiteLLM_SpendLogs`), plus drobne kilka centów za fixture przez OpenRoutera.

⁴ U chmurowych Σ tur = suma tur **zwycięskich** prób. Pełne sumy wszystkich prób
+ sesje fixture, z ledgerów archiwów runów: opus 264, deepseek 560.

⁵ Dwa osobne uruchomienia: LOGIN z runu oryginalnego (9,5 min), PAYROLL
z rerunu po fixture (18,0 min), przerwa ~85 min między nimi - jeden
wall-clock nie istnieje.

⁶ **Skąd „praca Opusa" w koszcie Luny.** Sama Luna kosztuje $0 - idzie
z abonamentu przez mostek OAuth. Całe $2,00 to rachunek za sesje
`claude-opus-5`, którego pipeline zaprzągł jako fixture-authora: $0,86
prewencyjnie (przed autorowaniem) i $1,14 ratunkowo, gdy Luna utknęła na
`fixture-gap` przy payrollu. Czyli to koszt CUDZEJ pracy wykonanej na rzecz
tego runu, nie zużycie modelu-autora. Wpis Luny w harnessie nie ma własnego
`fixtureAuthor`, więc zadziałał domyślny Opus - pozostałe dzisiejsze runy miały
tu deepseeka i stąd ich fixture'y kosztowały grosze.

Wykluczone z zestawienia: **gemini-3.6-flash** (darmowy próg AI Studio - 8 RPM
nie pozwoliło zmieścić się w capie czasu, ograniczenie konta, nie modelu) oraz
**minimax-m3** (wyczerpana kwota abonamentu, który nie będzie odnawiany).

## Jak czytać kolumny

- **LOGIN / PAYROLL** - status końcowy, liczba tur sesji autora i numer próby
  (`a1` = dostarczone za pierwszym podejściem, `a3` = dopiero za trzecim).
- **Σ tur** - suma tur w całym runie, razem z sesjami fallbacku. Miara wysiłku
  modelu niezależna od tego, jak szybko akurat liczył sprzęt.
- **Tur/min** - przepustowość runu. Rozdziela dwie różne rzeczy: model może być
  wolny, bo wolno generuje, albo dlatego, że dużo pisze w każdej turze.
- **Runy Playwright** - ile razy w całym runie uruchomiono testy (narzędzie
  `run_playwright`). Sygnał, ile prób model potrzebuje, żeby dojść do zieleni:
  Glimmer zużył 11, Qwen3.6 tylko 6 przy podobnej liczbie tur.
- **Release** - werdykt bramek jakości (P0 100%, P1 95%). PASS = oba case'y
  dostarczone z ważnym dowodem mutacyjnym.

## Fallback - co to znaczy

Autor pisze testy sam, ale gdy nie potrafi doprowadzić aplikacji do stanu
wyjściowego, pipeline uruchamia **wąską, jednorazową sesję innego modelu**
wyłącznie po to, by dorobił brakujący fixture. Odbiór jest deterministyczny -
skrypt weryfikacyjny musi wyjść kodem 0, żaden fixture nie wchodzi „na słowo".
Potem autor wraca do case'a z gotowym klockiem.

Dwa tryby:

- **Prewencyjny** - odpalany zawsze, między triażem a autorowaniem, dla typów
  oznaczonych jako churn-prone (tu: `lista-plac`). Fixture powstaje z góry.
- **Ratunkowy** - dopiero gdy autor utknie i zgłosi `fixture-gap`.

Ekonomia: mocniejszy model płaci za odkrycie raz, fixture zostaje w repo i jest
darmowy dla wszystkich kolejnych case'ów payrollowych (deepseek: $1,42 łącznie
wobec $2,21, gdy Opus robił całość sam).

**Ważne przy czytaniu wyników lokalnych**: seed payrollu w każdym runie lokalnym
napisał model chmurowy (`deepseek-flash`) w trybie prewencyjnym. Qwen3.6
i Glimmer nie potrzebowały ratunku w trakcie, ale wystartowały z gotowym
klockiem. Jedynym modelem w całym zestawieniu, który przeszedł oba case'y bez
niczyjej pomocy, jest **claude-opus-5**.

## Pełne identyfikatory modeli

- **Qwen3.6-27B-MTP Q5_K_M** - `unsloth/Qwen3.6-27B-MTP-GGUF:Q5_K_M`, 18,5 GB,
  spekulatywne dekodowanie draft-MTP, KV cache k=q8_0 v=f16
- **Muse-Glimmer-30B K-Quant Dynamic Q4_K_XL** - `meta-models/Muse-Glimmer-30B-GGUF`,
  21,1 GB
- **Qwen3.8-27B UD-Q4_K_XL** - `unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_XL`, 17,6 GB,
  draft-MTP, KV cache k=f16 v=f16, dodatkowo mmproj (wizja)
- **Ornith-1.0-35B Q4_K_M** - `ornith-ai/Ornith-1.0-35B-GGUF:Q4_K_M`, 19,7 GB,
  MoE, szablon czatu froggeric (oficjalny wywala tool calling)

Uwaga: MTP mają **oba** Qweny, nie tylko 3.6 - różnią się kwantyzacją
(Q5_K_M vs UD-Q4_K_XL) i typem cache'u KV.
