# Skill: greenproof-config - konfiguracja presetów, modelu i providera

Jak wskazać greenproofowi model i kanał (provider), i które capy warto ruszać.
Pełny opis pól: `docs/config-reference.md`. Mostki subskrypcyjne:
`docs/model-bridges.md`. Uruchamianie: `skills/greenproof-cli.md`.

## 1. Trzy presety

| Preset | Kanał | `baseUrl` | Token (`authTokenEnv`) | Kiedy |
|---|---|---|---|---|
| `codex-sub` (domyślny) | CLIProxyAPI - subskrypcja przez mostek OAuth | `http://127.0.0.1:8317` | `CLIPROXY_TOKEN` | masz subskrypcję asystenta CLI i mostek; koszt $ realnie 0 |
| `litellm` | brama LiteLLM | `http://127.0.0.1:4000` | `LITELLM_KEY` | chcesz budżetów klucza wirtualnego, telemetrii i fallbacków; modele deepseek/lokalne |
| `claude-sub` | API Anthropic wprost (albo poświadczenia Claude z HOME) | brak | `ANTHROPIC_AUTH_TOKEN` | najmocniejszy autor, koszt liczony realnie |

Gotowe configi referencyjne: `configs/litellm.config.mjs`,
`configs/codex.config.mjs`, `configs/claude.config.mjs` (opis pól:
`docs/config-reference.md`). Generator własnego: `grp run --tests-repo <ścieżka> --init-only --preset <p>` (repo musi mieć `.git`).

## 2. Zmiana modelu - dwie drogi

**Flagą** (nie dotyka plików; działa w `run --init-only` oraz w `run` przy
pierwszorazowej konfiguracji z `--tests-repo` bez `--config`):

```sh
grp run --tests-repo <p> --init-only --preset litellm --author claude-sonnet-5
grp run --tests-repo <p> --preset codex-sub --author 'gpt-5.6-luna(max)' \
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
curl -s http://127.0.0.1:8317/v1/models -H "Authorization: Bearer $CLIPROXY_TOKEN"
```

## 3. Zmiana providera

Provider = para `baseUrl` + `authTokenEnv` (flagi `--base-url`, `--token-env`).

Wymóg endpointu: **format Anthropic `/v1/messages` z działającym `tool_use`**.
LiteLLM nigdy nie był wymogiem - wymogiem jest ten kontrakt. Dlatego po KAŻDEJ
zmianie providera/endpointu, PRZED pierwszym runem:

```sh
grp preflight --config <config>
```

Ping + wymuszony tool-call. Exit 2 = endpoint niezdatny (najczęściej: mostek
gubi `tool_use` albo 401/403 - brak tokenu / wygasła sesja OAuth). Nie odpalaj
`author` na takim endpointcie - sesje żyją z narzędzi (Bash, playwright-mcp).

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

- **CLIProxyAPI**: sufiks w NAZWIE modelu - `gpt-5.6-luna(max)`,
  `gpt-5.6-sol(high)`. Forma z myślnikiem (`-high`) NIE działa. Najwyższy
  działający poziom sprawdzaj empirycznie na danym mostku. Bez sufiksu backend
  bierze swój domyślny effort (zwykle medium) - psuje to porównania modeli.
  `priceTable` kluczuj bazową nazwą (`'gpt-5.6-luna'`).
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

1. Model widoczny w `grp models` (lista `/v1/models` providera).
2. `author` (i ewentualny `fixtureAuthor`) ustawiony flagą albo w oznaczonym
   miejscu configu.
3. `priceTable` ma wpis na bazową nazwę modelu (zera dla subskrypcji/lokalnych).
4. Token w `.env` obok configu albo w env.
5. `grp preflight --config <c>` → exit 0.
6. Dla modelu lokalnego: `caps.firstTurnTimeoutMinutes` ~15.
