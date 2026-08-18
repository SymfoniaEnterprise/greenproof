# Mostki subskrypcyjne (opcjonalne): model z subskrypcji zamiast API

Silnik autora greenproof wymaga **dowolnego** endpointu w formacie Anthropic
(`/v1/messages` pod `model.baseUrl`) - brama LiteLLM nigdy nie była wymogiem,
tylko wygodą (budżety kluczy wirtualnych, telemetria, fallbacki). Ten dokument
opisuje wspierany wzorzec podpięcia modeli z **subskrypcji konsumenckich**
(subskrypcje asystentów CLI), które nie wystawiają API, przez lokalny
mostek OAuth → endpoint.

> Status: wzorzec OPCJONALNY i świadomie trzymany poza core. Mostki są
> nieoficjalne - dostawca może je w każdej chwili ukrócić. Core nie zależy od
> żadnego z nich; jedyne wsparcie w bibliotece to komenda `preflight`, która
> mówi, czy dany endpoint w ogóle nadaje się dla silnika autora.

## Wzorzec

```
subskrypcja (OAuth) ──> lokalny mostek (np. CLIProxyAPI) ──> http://127.0.0.1:<port>/v1/messages
                                                                    ▲
                                        greenproof: model.baseUrl ──┘  (bez LiteLLM)
                                lub: wpis w LiteLLM z api_base mostka  (z budżetami bramy)
```

Znane implementacje mostków: **CLIProxyAPI** (kilka subskrypcji naraz - wystawia
endpointy OpenAI- i Anthropic-compatible), **geminicli2api** (tylko Gemini).
Wybieraj aktywnie utrzymywany projekt; instalacja i konfiguracja wg jego
dokumentacji. Mostek uruchamiaj jako jednostkę użytkownika systemd i ustaw
w nim własny token dostępowy.

## CLIProxyAPI krok po kroku

Aktywnie utrzymywany projekt to **[router-for-me/CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)**
(następca wcześniejszego repo pod kontem `luispater`). Poniższe komendy i pola
configu zweryfikowano wprost - pobrano binarkę release (v7.2.132, sierpień
2026), odpalono ją lokalnie i sprawdzono `--help`, `/v1/models` i
`/v1/messages`. Gdzie dokumentacja projektu ([help.router-for.me](https://help.router-for.me/))
była niejednoznaczna albo nieaktualna względem binarki, jest to zaznaczone
wprost poniżej.

### 1. Instalacja i config

**Binarka release do `~/.local/bin`** (assety w releases nazywają się
`CLIProxyAPI_<wersja-bez-v>_<os>_<arch>.tar.gz` i zawierają plik binarny
`cli-proxy-api`):

```sh
VERSION=$(curl -s https://api.github.com/repos/router-for-me/CLIProxyAPI/releases/latest \
  | grep '"tag_name"' | cut -d '"' -f4)                # np. v7.2.132
curl -sL -o /tmp/cliproxy.tar.gz \
  "https://github.com/router-for-me/CLIProxyAPI/releases/download/${VERSION}/CLIProxyAPI_${VERSION#v}_linux_amd64.tar.gz"
mkdir -p ~/.local/bin
tar -xzf /tmp/cliproxy.tar.gz -C /tmp cli-proxy-api
install -m 0755 /tmp/cli-proxy-api ~/.local/bin/cli-proxy-api
```

(dla ARM64 podmień `linux_amd64` na `linux_aarch64`).

**Docker** - projekt trzyma w repo własny `Dockerfile` i `docker-compose.yml`
(obraz domyślny `eceasy/cli-proxy-api:latest`, ale `docker-compose.yml`
buduje go też lokalnie z `Dockerfile`, jeśli wolisz nie ufać cudzemu obrazowi):

```sh
git clone https://github.com/router-for-me/CLIProxyAPI.git
cd CLIProxyAPI
cp config.example.yaml config.yaml   # edytuj port/api-keys jak niżej
docker compose up -d
```

**Config** (`~/.config/cliproxyapi/config.yaml`, kopia `config.example.yaml`
z repo) - pola potwierdzone w `config.example.yaml` i eksperymentem lokalnym:

```yaml
port: 8317
auth-dir: "~/.cli-proxy-api"   # tu OAuth zapisuje tokeny logowania
api-keys:
  - "<WŁASNY-DŁUGI-TOKEN>"      # np. `openssl rand -hex 32`
```

`api-keys` to WŁASNY token dostępowy do mostka (nie ma nic wspólnego z kontem
mostka) - zweryfikowano lokalnie, że akceptowany jest zarówno nagłówek
`Authorization: Bearer <token>`, jak i `x-api-key: <token>` (ten drugi jest
tym, którego używa `grp preflight` i silnik autora, patrz niżej).

### 2. Logowanie subskrypcji (OAuth)

Flagi logowania pochodzą wprost z `cli-proxy-api --help` (binarka v7.2.132) -
każde uruchomienie otwiera domyślną przeglądarkę na stronie logowania
dostawcy; token trafia do `auth-dir` z configu.

**Wariant 1 - subskrypcja asystenta CLI**:

```sh
cli-proxy-api -config ~/.config/cliproxyapi/config.yaml -codex-login
```

**Gemini (konto Google)** - UWAGA: w aktualnej binarce **nie ma** osobnej
flagi `-login` ani `-gemini-login` (starsze poradniki w sieci, sprzed
zmiany nazewnictwa, się na taką flagę powołują - to nieaktualne). Dostęp do
modeli Gemini idzie przez logowanie do **Antigravity** (produkt Google,
ten sam OAuth na konto Google co Gemini):

```sh
cli-proxy-api -config ~/.config/cliproxyapi/config.yaml -antigravity-login
```

Na serwerze bez GUI dodaj `-no-browser` (mostek wypisze URL do otwarcia
ręcznie na innej maszynie) oraz opcjonalnie `-oauth-callback-port <port>`,
jeśli domyślny port callbacku jest zajęty:

```sh
cli-proxy-api -config ~/.config/cliproxyapi/config.yaml -codex-login -no-browser
```

### 3. Jednostka użytkownika systemd

Mostek ma wstawać po restarcie - plik unita zamiast ręcznego
`systemd-run --user`:

`~/.config/systemd/user/cliproxyapi.service`:

```ini
[Unit]
Description=CLIProxyAPI (mostek OAuth -> Anthropic-compatible /v1/messages)
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=%h/.local/bin/cli-proxy-api -config %h/.config/cliproxyapi/config.yaml
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

```sh
systemctl --user daemon-reload
systemctl --user enable --now cliproxyapi.service
# żeby usługa wstawała nawet bez zalogowanej sesji po reboocie:
loginctl enable-linger "$USER"
```

### 4. Weryfikacja

Najpierw lista modeli (potwierdza, że tokeny OAuth się zalogowały i konto
faktycznie ma dostęp do modelu):

```sh
curl -s http://127.0.0.1:8317/v1/models \
  -H "Authorization: Bearer <WŁASNY-DŁUGI-TOKEN>"
```

Potem OBOWIĄZKOWO preflight greenproof - co robi i co oznacza exit 2:
sekcja „OBOWIĄZKOWY preflight" niżej.

```sh
grp preflight --config greenproof.config.mjs
```

### 4a. Wybór reasoning effort (zweryfikowane na v7.2.132)

CLIProxyAPI parsuje **sufiks w nazwie modelu**: `gpt-5.6-sol(high)`,
`gpt-5.6-luna(low)` itd. - i tłumaczy go na parametr reasoning effort
backendu (odpowiedź wraca z bazową nazwą modelu). Wariant z myślnikiem
(`gpt-5.6-sol-high`) NIE działa („unknown provider"). W greenproof to po
prostu nazwa w configu:

```js
model: {
  author: 'gpt-5.6-luna(high)',            // autor na high
  fixtureAuthor: { model: 'gpt-5.6-sol(high)', baseUrl: 'http://127.0.0.1:8317', authTokenEnv: 'CLIPROXY_TOKEN' },
  // priceTable kluczuj BAZOWĄ nazwą (tak wraca w modelUsage): 'gpt-5.6-luna': …
}
```

Bez sufiksu backend stosuje swój domyślny effort (dla tych modeli zwykle
medium) - miej to na uwadze przy porównaniach modeli.

### 5. Typowe problemy

- **Wygasła sesja OAuth** - `ping` albo `toolUse` w preflight zwraca błąd
  401/403. Odśwież token, uruchamiając ponownie komendę logowania
  (`-codex-login` / `-antigravity-login`) - nadpisze plik w `auth-dir`.
- **Model nieobecny na liście `/v1/models`** - konto zalogowane przez OAuth
  nie ma dostępu do tego modelu (np. plan subskrypcji go nie obejmuje).
  Sprawdź w README/panelu dostawcy, jaki masz plan; mostek nie potrafi
  wymusić dostępu, którego konto nie ma.
- **Mostek gubi `tool_use`** - model odpowiada tekstem zamiast blokiem
  narzędzia. To dokładnie ten przypadek, który łapie `preflight`
  (`toolUse.ok === false`), zanim spalisz kwotę subskrypcji na run, który i
  tak się wywróci. Nie odpalaj `author` na endpointach, które tego testu nie
  przechodzą.
- **Port zajęty** - zmień `port:` w `config.yaml` mostka (i `-oauth-callback-port`
  przy logowaniu, jeśli koliduje z portem callbacku OAuth), a potem dopasuj
  `model.baseUrl` w configu greenproof do nowego portu.

### 6. Przykładowy wpis w scripts/golden-path.mjs

`scripts/golden-path.mjs` trzyma mapę `MODELS` (zobacz istniejące wpisy
`deepseek`/`qwen`/`gemini` w tym pliku) - wpis dla modelu z CLIProxyAPI
wygląda tak samo jak dla mostka lokalnego (Lemonade), tylko z innym portem
i innym tokenem env:

```js
const MODELS = {
  // …istniejące wpisy…
  cliproxy: {
    author: '<nazwa-modelu-w-mostku>',   // z GET /v1/models mostka
    baseUrl: 'http://127.0.0.1:8317',
    tokenEnv: 'CLIPROXY_TOKEN',
    priceTable: { '<nazwa-modelu-w-mostku>': { inPerMTok: 0, outPerMTok: 0, cacheReadPerMTok: 0 } },
  },
};
```

Użycie: `CLIPROXY_TOKEN=<WŁASNY-DŁUGI-TOKEN> node scripts/golden-path.mjs --model cliproxy`
- pamiętaj o `grp preflight` PRZED pierwszym runem golden-path na tym
modelu.

## Konfiguracja greenproof

```js
export default {
  // …
  model: {
    baseUrl: 'http://127.0.0.1:8317',   // endpoint mostka (bez LiteLLM)
    authTokenEnv: 'CLIPROXY_TOKEN',     // token ustawiony w mostku
    author: '<nazwa-modelu-w-mostku>',  // z GET /v1/models mostka
    // Subskrypcja = koszt 0; jawny cennik zerowy wyłącza fikcyjne kwoty:
    priceTable: { '<nazwa-modelu-w-mostku>': { inPerMTok: 0, outPerMTok: 0, cacheReadPerMTok: 0 } },
  },
};
```

## OBOWIĄZKOWY preflight przed pierwszym runem

```sh
grp preflight --config greenproof.config.mjs
```

Komenda robi dwie rzeczy i zwraca exit 2, jeśli którakolwiek zawiedzie
(implementacja: `packages/core/src/preflight/check.ts`, mapowanie na exit:
`packages/cli/src/exit-codes.ts`):

1. **Ping** `/v1/messages` - czy endpoint w ogóle odpowiada w formacie Anthropic.
2. **Wymuszony tool-call** - żąda odpowiedzi przez narzędzie i sprawdza, że
   w odpowiedzi jest blok `tool_use`. To najczęstsza awaria mostków: model
   odpowiada tekstem, mostek gubi tool-calling - a silnik autora żyje z
   narzędzi (Bash, playwright-mcp, narzędzia procesowe). **Endpoint bez
   sprawnego tool-callingu = sesje autora nie zadziałają**; nie pal kwoty
   subskrypcji na run, który się wywróci.

## Ograniczenia wzorca (świadome)

- **Brak budżetów bramy** - bez LiteLLM nie ma bezpiecznika klucza
  wirtualnego; zostają capy greenproof (tury / czas / runy playwright), a koszt
  $ w telemetrii jest zerowy (subskrypcja). Kwotę subskrypcji zżynasz realnie -
  jeden run to 2+ sesje agentowe po kilkadziesiąt-200 tur.
- **Stabilność** - obserwuj w ledgerach błędy 5xx, zrywane streamy i
  zniekształcone tool-calle; mostek, który je generuje, zafałszuje porównania
  modeli.
- **Zgodność z regulaminem dostawcy** - mostki OAuth bywają na granicy ToS
  subskrypcji; decyzja i ryzyko po stronie użytkownika.

## Wariant przez LiteLLM

Jeśli wolisz zachować budżety i telemetrię bramy: zamiast celować `baseUrl`
w mostek, dodaj w LiteLLM wpis z `api_base` mostka i jawnymi
`input_cost_per_token: 0` / `output_cost_per_token: 0` (inaczej LiteLLM
dopasuje nazwę modelu do własnej mapy cen i naliczy fikcyjny spend). Wtedy
`model.baseUrl` w greenproof zostaje na bramie jak dotychczas.
