# Endpoint dla silnika autora: brama LiteLLM i wzorzec własnej bramy

Silnik autora greenproof wymaga **dowolnego** endpointu w formacie Anthropic
(`/v1/messages` pod `model.baseUrl`) - brama LiteLLM nigdy nie była wymogiem,
tylko wygodą (budżety kluczy wirtualnych, telemetria, fallbacki). Ten dokument
opisuje wspierany wzorzec podpięcia takiego endpointu przez bramę oraz
konfigurację LiteLLM.

> Modele GPT-5.6 Luna/Sol/Terra podpinasz przez **oficjalny GitHub Copilot CLI**
> (preset `copilot`, patrz [configuration.md](configuration.md)) - to nie jest
> endpoint HTTP i nie przechodzi przez ten dokument. Dostęp może pochodzić z
> subskrypcji, ale Greenproof raportuje dla tego presetu estymatę kosztu z usage.
> Poniższy wzorzec dotyczy endpointów mówiących
> formatem Anthropic (brama LiteLLM albo własna brama).

> Status: brama jest OPCJONALNA i świadomie trzymana poza core. Core nie zależy
> od żadnej konkretnej bramy; jedyne wsparcie w bibliotece to komenda
> `preflight`, która mówi, czy dany endpoint w ogóle nadaje się dla silnika
> autora.

## Wzorzec

```
model autora ──> brama /v1/messages (np. LiteLLM) ──> http://127.0.0.1:<port>/v1/messages
                                                            ▲
                                greenproof: model.baseUrl ──┘
```

Brama wystawia endpoint w formacie Anthropic (`/v1/messages`), a greenproof
celuje w nią przez `model.baseUrl`. LiteLLM dodatkowo daje budżety kluczy
wirtualnych, telemetrię i fallbacki; własna brama musi jedynie poprawnie
przekazywać blok `tool_use` (patrz preflight niżej) - to najczęstsza awaria
bram, którą łapie `grp preflight` PRZED spaleniem kwoty na run, który i tak się
wywróci.

## Konfiguracja greenproof (LiteLLM)

```js
export default {
  // …
  model: {
    baseUrl: 'http://127.0.0.1:4000',   // endpoint bramy LiteLLM
    authTokenEnv: 'LITELLM_KEY',        // klucz wirtualny bramy
    author: '<model-z-bramy>',          // nazwa aliasu z `grp models`
    // priceTable kluczuj nazwą aliasu w bramie (tak wraca w modelUsage):
    priceTable: { '<model-z-bramy>': { inPerMTok: 0, outPerMTok: 0, cacheReadPerMTok: 0 } },
  },
};
```

Nazwy modeli w bramie są instalacyjne - u każdego wpisy nazywają się inaczej,
więc listę realnych aliasów daje `grp models --config <config>`. Dla modelu
rozliczanego per token uzupełnij realne stawki w `priceTable` (i ustaw
`costModel: 'metered'`), żeby cap kosztowy działał.

## OBOWIĄZKOWY preflight przed pierwszym runem

```sh
grp preflight --config greenproof.config.mjs
```

Komenda robi dwie rzeczy i zwraca exit 2, jeśli którakolwiek zawiedzie
(implementacja: `packages/core/src/preflight/check.ts`, mapowanie na exit:
`packages/cli/src/exit-codes.ts`):

1. **Ping** `/v1/messages` - czy endpoint w ogóle odpowiada w formacie Anthropic.
2. **Wymuszony tool-call** - żąda odpowiedzi przez narzędzie i sprawdza, że
   w odpowiedzi jest blok `tool_use`. To najczęstsza awaria bram: model
   odpowiada tekstem, brama gubi tool-calling - a silnik autora żyje z
   narzędzi (Bash, playwright-mcp, narzędzia procesowe). **Endpoint bez
   sprawnego tool-callingu = sesje autora nie zadziałają**; nie pal kwoty
   na run, który się wywróci.

## Ograniczenia wzorca (świadome)

- **Brak budżetów bramy** - jeśli celujesz `baseUrl` wprost w endpoint bez
  LiteLLM, nie ma bezpiecznika klucza wirtualnego; zostają capy greenproof
  (tury / czas / runy playwright), a przy modelu o zerowym koszcie $ w
  telemetrii jest zerowy. Kwotę zżynasz realnie - jeden run to 2+ sesje
  agentowe po kilkadziesiąt-200 tur.
- **Stabilność** - obserwuj w ledgerach błędy 5xx, zrywane streamy i
  zniekształcone tool-calle; brama, która je generuje, zafałszuje porównania
  modeli.
- **Zgodność z regulaminem dostawcy** - modele subskrypcyjne używaj zgodnie
  z ToS dostawcy; decyzja i ryzyko po stronie użytkownika.

## Preset `claude-native`: Claude Code natywnie, sesja dziedziczy logowanie z HOME

> **Preflight ma dedykowaną ścieżkę walidacji** (`runClaudeNativePreflight` w
> `packages/core/src/preflight/check.ts`), wzorem `copilot-cli`: sprawdza
> binarkę Claude Code i obecność `env.ANTHROPIC_BASE_URL` w
> `~/.claude/settings.json`, bez żadnego requestu sieciowego. Realny
> ping+tool-use test zostaje odroczony do pierwszej sesji autora. **Nadal
> nieskonfirmowane**: pełny, zielony przebieg `grp run` end-to-end na żywym
> przypadku E2E (patrz klauzula na końcu tej sekcji).

Preset `claude-native` (albo `claude-sub` bez ustawionego `authTokenEnv`/
`baseUrl` - ten sam mechanizm, dwa punkty wejścia) nie jest bramą HTTP w
ogóle - to osobna ścieżka. Sesja autora idzie przez oficjalny
`@anthropic-ai/claude-agent-sdk` (`packages/core/src/author/session.ts`),
który spawnuje **wbudowaną binarkę Claude Code jako podproces**, dziedziczącą
`HOME`/`USERPROFILE` z procesu greenproof. Ta binarka sama zarządza swoim
uwierzytelnieniem dokładnie tak jak przy zwykłym interaktywnym `claude` -
OAuth (Team/Enterprise), subskrypcja indywidualna, albo cokolwiek innego, co
ma skonfigurowane w `~/.claude/settings.json`. Greenproof **nie** czyta
samodzielnie `~/.claude.json`/`~/.claude/.credentials.json` i **nie**
wykonuje własnych wywołań `fetch`/`axios` do `api.anthropic.com` w tej
ścieżce (poza preflightem, który tylko CZYTA plik lokalnie) - jedyne miejsce
z bezpośrednim klientem HTTP (`@anthropic-ai/sdk`) to poboczna funkcja
digestu (`packages/core/src/ledger/digest.ts`), która wymaga jawnego tokenu i
nie ma dostępu awaryjnego do poświadczeń z HOME.

**Problem 1 (ROZWIĄZANY): `grp preflight` miał dla tego trybu tylko ścieżkę
generyczną.** Bez `baseUrl` ta ścieżka domyślnie celuje w
`https://api.anthropic.com` i wymaga `x-api-key` - a to dokładnie ta ścieżka,
której sesja autora w tym trybie NIE używa, więc zawsze wracała czerwona
niezależnie od tego, czy sesja autora by faktycznie zadziałała.
`runClaudeNativePreflight` rozpoznaje ten tryb (brak tokenu I brak `baseUrl`,
ten sam warunek co w `session.ts`) i sprawdza zamiast tego dostępność binarki
`claude` oraz obecność `env.ANTHROPIC_BASE_URL` w `~/.claude/settings.json`.
`grp run --skip-preflight` zostaje w kodzie jako ogólny escape hatch dla
przypadków, które nie pasują do rozpoznanego wzorca (np. `claude-sub` bez
tokenu dla kogoś bez `~/.claude/settings.json` skonfigurowanego pod proxy -
wtedy preflight może fałszywie ostrzec o braku `ANTHROPIC_BASE_URL`, mimo że
czysta subskrypcja bez proxy działa bez tego pola).

**Problem 2 (zdiagnozowany, dwie oddzielne przyczyny - obie naprawione w
kodzie, jedna też po stronie operatora/organizacji):**

1. *Token proxy odrzucony* (`401 Invalid proxy server token passed... Unable
   to find token in cache`) - wystąpił dwukrotnie, za każdym razem z innym
   efemerycznym kluczem `sk-...`. Nie był to wygasły klucz do odświeżenia,
   tylko coś w przepływie wydawania kluczy dla kont Team/BYOK tej organizacji,
   co nie działało z izolowanym, nieinteraktywnym podprocesem. **Naprawione
   po stronie operatora** (zmiana w jego `~/.claude/settings.json` /
   `.credentials.json`) - potwierdzone ręcznym testem spawnu po naprawie.
2. *Model BYOK nierozpoznany przez SDK* - nawet po naprawieniu (1), sesja
   autora kończyła się `There's an issue with the selected model
   (claude-sonnet-5-byok). It may not exist or you may not have access to
   it.` Przyczyna: `runClaudeAuthorSession` wołał SDK z `settingSources: []`
   (pełna izolacja od `~/.claude/settings.json`), więc sesja NIE dziedziczyła
   `env.ANTHROPIC_BASE_URL`/nagłówków proxy operatora - uderzała wprost w
   `api.anthropic.com`, gdzie alias modelu specyficzny dla firmowej bramy
   (`*-byok`) nie istnieje. **Naprawione w kodzie**: dla trybu bez
   `authToken`/`baseUrl` (czysto subskrypcyjnego, HOME-inherited)
   `settingSources` to teraz `['user']`, nie `[]` - sesja czyta
   `~/.claude/settings.json` operatora tak samo jak zwykłe `claude -p`.
   Świadomy kompromis: sesja autora (autonomiczna, `bypassPermissions`)
   odziedzicza też ewentualne hooki/inne ustawienia z tego pliku, nie tylko
   routing modelu - `settingSources: []` zostaje bez zmian dla trybu z
   jawnym `baseUrl`/tokenem (reprodukowalna izolacja, config sam niesie
   endpoint). **Ta sama naprawa dotyczyła tylko `runClaudeAuthorSession`** -
   `runClaudeFixtureSession` (`packages/core/src/author/fixtureSession.ts`)
   miał sztywne `settingSources: []` bezwarunkowo do czasu tej zmiany, więc
   eskalacja fixture-gap w tym trybie trafiała ten sam błąd nierozpoznanego
   aliasu BYOK. Teraz oba miejsca stosują ten sam warunek.

**Nadal nieskonfirmowane:** pełny, zielony przebieg `grp run` end-to-end w
tym trybie (autoring rzeczywistego przypadku E2E). Przed poleceniem tego
trybu operatorom: (1) potwierdź z zespołem platformowym zgodność z
regulaminem licencji (Team/Enterprise czy subskrypcja indywidualna - patrz
sekcja "Zgodność z regulaminem dostawcy" niżej), (2) potwierdź działającą
sesję end-to-end na żywym przypadku testowym.

## Model o zerowym koszcie za LiteLLM

Jeśli chcesz zachować budżety i telemetrię bramy dla modelu, za który nie
płacisz per token (np. upstream subskrypcyjny): dodaj w LiteLLM wpis z jawnymi
`input_cost_per_token: 0` / `output_cost_per_token: 0` (inaczej LiteLLM
dopasuje nazwę modelu do własnej mapy cen i naliczy fikcyjny spend). Wtedy
`model.baseUrl` w greenproof zostaje na bramie jak dotychczas, a `costModel`
oznacz jako `subscription`.
