# Skill: greenproof-config - konfiguracja presetów, modelu i providera

Jak wskazać greenproofowi model i kanał (provider), i które capy warto ruszać.
Pełny opis pól: `docs/config-reference.md`. Mostki subskrypcyjne:
`docs/model-bridges.md`. Uruchamianie: `skills/greenproof-cli.md`.

## 0. Tryby, między którymi przełączamy się w tym repo

Nie budujemy nowych configów od zera - przełączamy się między gotowymi
trybami. Każdy ma DOKŁADNIE jedną komendę `--init-only` do wygenerowania
configu i jedną komendę `run`/`preflight`. `<repo>` = katalog repo testów
(`--tests-repo`), `<config>` = ścieżka do wygenerowanego `greenproof.config.mjs`.

### A. `claude-native` — Claude Code natywnie (subskrypcja albo firmowa brama LiteLLM przez ~/.claude/settings.json)

> **Status: preflight ma dedykowaną ścieżkę walidacji, end-to-end jeszcze
> niepotwierdzone.** Dwa niezależne problemy znalezione po drodze, oba
> naprawione w kodzie: (1) token proxy odrzucany (`401 Invalid proxy server
> token passed...`) - okazało się problemem po stronie operatora/organizacji
> (wydawanie efemerycznych kluczy dla izolowanego podprocesu pod kontem
> Team/BYOK), naprawione zmianą ustawień operatora, potwierdzone ręcznym
> testem; (2) sesja autora (`runClaudeAuthorSession`) i sesja eskalacji
> fixture (`runClaudeFixtureSession`) wołały SDK z `settingSources: []`
> (pełna izolacja od `~/.claude/settings.json`), więc nie dziedziczyły
> `ANTHROPIC_BASE_URL`/nagłówków firmowej bramy - model `*-byok` był
> nierozpoznany. Naprawione w kodzie: dla trybu bez `authToken`/`baseUrl`
> obie sesje mają teraz `settingSources: ['user']` (świadomy koszt: sesja
> dziedziczy też hooki/inne ustawienia operatora, nie tylko routing modelu).
> `grp preflight` rozpoznaje ten tryb (brak tokenu I brak `baseUrl`) i sprawdza
> binarkę Claude Code + obecność `ANTHROPIC_BASE_URL` w `~/.claude/settings.json`,
> zamiast fałszywie czerwonego pingu na `api.anthropic.com`. Do zrobienia przed
> pełnym zaufaniem temu trybowi: (1) ustalić z zespołem platformowym zgodność z
> regulaminem licencji (Team/Enterprise czy subskrypcja indywidualna), (2)
> potwierdzić pełny, zielony `grp run` na żywym przypadku E2E. Szczegóły:
> `docs/model-bridges.md`, sekcja "Preset `claude-native`".

### B. LiteLLM bezpośrednio, po staremu (statyczny klucz w `.env`)

Klasyczny, w pełni zweryfikowany przez `preflight` tryb - wymaga klucza
wirtualnego bramy (`sk-...`, wydawanego per-developer przez zespół platformowy,
**nie** loguj tu OAuth-a Claude Code).

```sh
grp run --tests-repo <repo> --init-only --preset litellm \
        --author claude-sonnet-5 --base-url https://ai-proxy.szybkafaktura.pl

echo "LITELLM_KEY=sk-..." >> <repo>/.env   # nigdy nie commituj, nigdy nie wypisuj wartości

grp preflight --config <config>            # tu preflight faktycznie coś sprawdza
grp run --config <config> --in plan.json --app-url <url> --out run-result.json
```

Nazwa modelu za bramą jest instalacyjna - potwierdź realną listę:
`grp models --config <config>`.

### C. Oficjalny GitHub Copilot CLI

Osobny, licencjonowany produkt (nie to samo pytanie o regulamin co tryb A) -
GitHub Copilot CLI obsługuje jako backend też modele z rodziny Claude, nie
tylko GPT-5.6.

```sh
copilot login   # jednorazowo, jeśli jeszcze nie zalogowany

grp run --tests-repo <repo> --init-only --preset copilot \
        --author claude-sonnet-5 --fixture-author none
        # albo --author gpt-5.6-luna (domyślny model presetu)

grp preflight --config <config>            # sprawdza tylko dostępność CLI
grp run --config <config> --in plan.json --app-url <url> --out run-result.json
```

**Który tryb wybrać dziś:** `claude-native` (A) jako domyślny dla operatorów
zalogowanych do Claude Code przez firmowe proxy albo subskrypcję - preflight
ma dedykowaną ścieżkę, koszt zerowy (subskrypcja/abonament). C (`copilot`)
jako alternatywa bez pytań o regulamin subskrypcji Claude - to inny produkt z
własnym ToS. B (`litellm`), gdy masz klucz `sk-...` i chcesz budżetów/
telemetrii bramy dla dowolnego modelu.

## 1. Presety

| Preset | Kanał | `baseUrl` | Token (`authTokenEnv`) | Kiedy |
|---|---|---|---|---|
| `claude-native` | Claude Code natywnie, dziedziczy `~/.claude/settings.json` (patrz §0.A) | brak | `ANTHROPIC_AUTH_TOKEN` (NIE ustawiaj) | zalecany start dla operatorów z dostępem do Claude Code (subskrypcja albo firmowe proxy) |
| `copilot` | oficjalne GitHub Copilot CLI (driver `copilot-cli`) | brak | brak (`copilot login`) | autor `gpt-5.6-luna`, eskalacja `gpt-5.6-terra`; koszt estymowany z usage CLI |
| `litellm` | brama LiteLLM | `http://127.0.0.1:4000` | `LITELLM_KEY` | zaawansowane: budżety klucza wirtualnego, telemetria i fallbacki; modele deepseek/lokalne |
| `claude-sub` | API Anthropic wprost, jawny token (tryb bramy, reprodukowalny/CI) | brak | `ANTHROPIC_AUTH_TOKEN` (wymagany) | zaawansowane: CI/reprodukowalność - dla trybu bez tokenu użyj `claude-native` zamiast tego |
| `codex-sub` (alias wsteczny, domyślny `init`) | CLIProxyAPI przez mostek OAuth | `http://127.0.0.1:8317` | `CLIPROXY_TOKEN` | istniejące konfiguracje; nowe wybierz jawnie `claude-native` albo `copilot` |

Gotowe configi referencyjne: `configs/litellm.config.mjs`,
`configs/copilot.config.mjs`, `configs/claude.config.mjs` (opis pól:
`docs/config-reference.md`). Generator własnego: `grp run --tests-repo <ścieżka> --init-only --preset <p>` (repo musi mieć `.git`).

## 2. Zmiana modelu - dwie drogi

**Flagą** (nie dotyka plików; działa w `run --init-only` oraz w `run` przy
pierwszorazowej konfiguracji z `--tests-repo` bez `--config`):

```sh
grp run --tests-repo <p> --init-only --preset litellm --author claude-sonnet-5
grp run --tests-repo <p> --preset copilot --author gpt-5.6-luna \
       --in plan.json --app-url <url>
```

**Edycją gotowego configu** - każdy plik w `configs/` ma DOKŁADNIE JEDNO
oznaczone miejsce:

```js
// ── TU ZMIENIASZ MODEL ── (wpisz konkretny alias z bramy; nazwy da `grp models`)
author: 'claude-sonnet-5',
```

Nazwę modelu bierz z listy providera, nie z pamięci - nazwy w bramie zmieniają
się po rekonfiguracji:

```sh
grp models --config configs/<preset>.config.mjs   # { endpoint, available, models }
```

Brak listy (`available: false` z notą `note`) to cecha bramy, nie błąd. Wariant
awaryjny bez configu:

```sh
curl -s http://127.0.0.1:4000/v1/models -H "Authorization: Bearer $LITELLM_KEY"
```

## 3. Zmiana providera

Provider = para `baseUrl` + `authTokenEnv` (flagi `--base-url`, `--token-env`).

Dla `model.driver: 'copilot-cli'` ta sekcja nie ma zastosowania: Copilot CLI
nie używa endpointu Anthropic, `authTokenEnv` ani `/v1/models`. Użyj
`copilot login`, wybierz model dostępny w lokalnym CLI, a następnie uruchom
`grp preflight --config <config>` - preflight sprawdzi binarkę i podstawowy
start CLI, nie ping endpointu.

Wymóg endpointu: **format Anthropic `/v1/messages` z działającym `tool_use`**.
LiteLLM nigdy nie był wymogiem - wymogiem jest ten kontrakt. Dlatego po KAŻDEJ
zmianie providera/endpointu, PRZED pierwszym runem:

```sh
grp preflight --config <config>
```

Ping + wymuszony tool-call. Exit 2 = endpoint niezdatny (najczęściej: mostek
gubi `tool_use` albo 401/403 - brak tokenu / wygasła sesja OAuth). Nie odpalaj
`author` na takim endpointcie - sesje żyją z narzędzi (Bash, playwright-mcp).

**Wyjątek: `claude-native` (i `claude-sub` bez tokenu, §0.A).** Preflight
rozpoznaje brak tokenu I brak `baseUrl` i sprawdza zamiast tego binarkę Claude
Code + `~/.claude/settings.json` (`runClaudeNativePreflight`), bez pingowania
`/v1/messages`. `--skip-preflight` na `grp run` zostaje jako ogólny escape
hatch dla przypadków spoza tego wzorca (patrz `docs/model-bridges.md`) - nie
używaj go, żeby obejść realny błąd konfiguracji na innym presecie.

## 4. Eskalacja fixture (`model.fixtureAuthor`)

Wzorzec potwierdzony w benchmarkach: **mocny model płaci za odkrycie raz
(wąska sesja fixture ~$1.0-1.4), tani autor dowozi resztę.**

```sh
--fixture-author claude-sonnet-5        # model eskalacji
--fixture-author none                   # wyłącz eskalację
```

Eskalacja **dziedziczy endpoint i token autora** (ta sama brama), więc
podajesz tylko nazwę modelu. Inny provider (np. Claude wprost) podasz w
configu: `fixtureAuthor: { model, baseUrl, authTokenEnv }`.

Obecność `model.fixtureAuthor` włącza też **prewencyjne** sesje fixture per
churn-prone typ przed partią autora (w `grp run`).

## 5. `priceTable` - miękkie i twarde capy $

Klucz = **BAZOWA** nazwa modelu (bez sufiksu effortu - tak wraca w
`modelUsage`), wartości w USD/MTok:

```js
priceTable: {
  'claude-sonnet-5': { inPerMTok: 3, outPerMTok: 15, cacheReadPerMTok: 0.3 },
}
```

- Cap kosztowy egzekwowany jest z TEGO licznika, nie z SDK (`total_cost_usd`
  bywa błędny za bramą).
- **Zera** (modele subskrypcyjne i lokalne - realnie $0) = capy `$` nie gryzą;
  zostają capy tur i czasu. To świadomy wybór, nie błąd.
- Model nadpisany flagą `--author` oraz model eskalacji spoza presetu (tryb
  auto z listy `/v1/models` albo jawna flaga `--fixture-author`) dostają
  zerowy wpis - uzupełnij realne stawki, jeśli chcesz twardego budżetu $.
- W tabelach zawsze podajemy estymatę kosztu z dopiskiem `(est.)` - niezależnie
  od kanału (abonament, subskrypcja, pay-per-token); przy abonamencie dodajemy, że realnie z kieszeni nic nie wychodzi.

### `costModel` - OBOWIĄZKOWY przy modelach lokalnych

Obok naszego licznika działa **natywny cap SDK**, który wycenia sesję
stawkami Anthropic - także dla modelu, który z Anthropikiem nie ma nic
wspólnego. `costModel` mówi pipeline'owi, skąd naprawdę bierze się koszt:

```js
model: {
  author: '<model-lokalny-z-bramy>',
  costModel: 'local',   // 'local' | 'subscription' | 'metered'
}
```

- **`local`** - płacimy czasem GPU, nie kwotą → natywny cap SDK **wyłączony**,
  granicą są tury i czas. Bez tego run ginie z „Reached maximum budget",
  mimo że realny koszt to $0 (tak padł run ornith-35b po 387 turach).
- **`subscription`** - abonament/mostek: realnie $0, ale odbojnik SDK
  **zostaje** (limit zużycia po stronie dostawcy istnieje).
- **`metered`** - płacimy per token; zachowanie domyślne.

Znacznik **bije heurystykę z cennika**: zerowy `priceTable` sam w sobie nie
oznacza modelu lokalnego (modele z subskrypcji też bywają wpisane z zerami).
Przy braku `costModel` pipeline zgaduje z cennika - działa, ale przy modelu
z subskrypcji i zerowym cenniku zgadnie źle.

## 6. Capy warte ruszania (`caps`)

Domyślne z `configs/*`: `maxTurns: 400`, `maxTimeMinutes: 30`, `maxCostUsd: 8`,
`maxPlaywrightRuns: 12`, `proofRuns: 4`, `maxAutoRetries: 1`,
`snapshotGating: 'enforce'`, `fixtureSession: { maxTurns: 80, … }`.

| Pole | Kiedy ruszać |
|---|---|
| `maxPlaywrightRuns` | za mało runów w fazie assert (agent nie dochodzi do dwóch zielonych) - 6 trzykrotnie zagłodziło dowód; 12 to sprawdzona wartość |
| `proofRuns` | osobna pula fazy dowodu, odblokowana po DRUGIM zielonym; podnoś, gdy dowód pada na braku runów |
| `fixtureSession.maxTurns` | wąska sesja pada na `error_max_turns` - na trudnej appce 40 było za mało, 80 wystarcza |
| `firstTurnTimeoutMinutes` | **modele LOKALNE: podnieś do ~15**. Domyślne 5 min jest krótsze niż pierwsza tura dużego modelu na llama.cpp (prefill + thinking) i watchdog ubija żywą sesję jako `infra` |
| `maxTimeMinutes` / `maxTurns` | tylko gdy ledger pokazuje, że case realnie postępował do momentu capu |
| `snapshotGating` | `'warn'` przy strojeniu nowego modelu, `'enforce'` w normalnej pracy |
| `seedFuse.churnProneTypes` | dopisz typ, który powtarzalnie pada na seedzie (tryb `learn: 'propose'` sam podpowiada w `learned-churn.json`) |

Nie podbijaj capów, żeby „przepchnąć" case - capy są jedynym twardym
ograniczeniem kosztu. Najpierw diagnoza z ledgera.

## 7. Efforty (reasoning)

- **Brama LiteLLM**: efforty przez DEDYKOWANY wpis modelu z `reasoning_effort`
  na sztywno w `litellm_params` (osobny alias per effort) - nie przez
  sufiks w nazwie.

## 8. Tokeny i zmienne środowiskowe

- `configs/.env` (albo `.env` obok dowolnego configu): linie `KLUCZ=wartość`,
  wczytywane automatycznie; istniejące env wygrywa. W `.gitignore` - nie
  commituj i nie wypisuj wartości.
- `GREENPROOF_TESTS_REPO` - repo testów dla configów referencyjnych; ustawia ją
  `run --tests-repo`. Bez niej: `~/.local/share/greenproof/manual-<preset>/tests-repo`.
- `GREENPROOF_PROGRESS`, `GREENPROOF_DEBUG`, `GREENPROOF_WORK_DIR`,
  `GREENPROOF_SKIP_INSTALL` - opis w `docs/configuration.md` i `README.md`.

## 9. Checklista przed pierwszym runem na nowym modelu

Dla `model.driver: 'copilot-cli'` wykonaj tylko:

1. `copilot login` i sprawdzenie, że model jest dostępny w lokalnym model pickerze.
2. `grp preflight --config <c>` → exit 0; nie konfiguruj `grp models`, tokenu Anthropic ani `baseUrl`.

Dla drivera Claude/endpointu Anthropic użyj pełnej checklisty:

1. Model widoczny w `grp models` (lista `/v1/models` providera).
2. `author` (i ewentualny `fixtureAuthor`) ustawiony flagą albo w oznaczonym
   miejscu configu.
3. `priceTable` ma wpis na bazową nazwę modelu (zera dla subskrypcji/lokalnych).
4. Token w `.env` obok configu albo w env.
5. `grp preflight --config <c>` → exit 0.
6. Dla modelu lokalnego: `caps.firstTurnTimeoutMinutes` ~15.
