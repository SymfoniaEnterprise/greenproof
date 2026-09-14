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

## Model o zerowym koszcie za LiteLLM

Jeśli chcesz zachować budżety i telemetrię bramy dla modelu, za który nie
płacisz per token (np. upstream subskrypcyjny): dodaj w LiteLLM wpis z jawnymi
`input_cost_per_token: 0` / `output_cost_per_token: 0` (inaczej LiteLLM
dopasuje nazwę modelu do własnej mapy cen i naliczy fikcyjny spend). Wtedy
`model.baseUrl` w greenproof zostaje na bramie jak dotychczas, a `costModel`
oznacz jako `subscription`.
