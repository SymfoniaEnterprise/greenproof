# AGENTS.md - greenproof

**greenproof** to biblioteka do agentowego autorowania testów E2E Playwright
z bramkami ludzkimi i dowodem mutacyjnym. Monorepo TypeScript (pnpm):
`packages/core` (rdzeń, platform-agnostic), `packages/cli` (binarka
`greenproof`), adaptery platformy (`adapter-fs`, `adapter-github`), parser
planu i pakiet testowy. Pipeline: `filter → triage → [fixture prewencyjny] →
author → dowód mutacyjny → deliver → auto-accept (pipeline) → release
(człowiek, bramki jakości)`.

**Katalog `docs/` jest źródłem prawdy** - nie zgaduj zachowania CLI ani pól
configu z pamięci: `docs/configuration.md` (presety, flagi, wejście komend),
`docs/config-reference.md` (pola configu, capy),
`docs/adapters.md` (porty, retencja, branche), `docs/model-bridges.md` (mostki
subskrypcyjne, efforty, preflight), `docs/benchmarks.md` (metodyka, monitoring,
historia runów) wraz z wynikami w `docs/benchmarks-easy-app.md` i
`docs/benchmarks-complex-app.md`, `README.md` (pipeline, tabela komend i kodów
wyjścia).
Aktualny help: `node packages/cli/dist/main.js --help`.

**Testy**: `npx tsc -b && npx vitest run` z korzenia repo. Po zmianach w
`packages/*/src` przebuduj (`npx tsc -b`) - wrapper `greenproof` bierze `dist`.

**Nie commituj bez wyraźnej prośby.** Nigdy nie commituj `.env` ani tokenów.

## Skille dla agentów

Kanoniczna treść skilli leży w `skills/*.md` (po polsku, operacyjnie: komendy
do skopiowania i decyzje „jeśli X → zrób Y"). Przeczytaj właściwy plik W CAŁOŚCI
zanim zaczniesz działać.

| Kiedy użyć | Przeczytaj |
|---|---|
| PIERWSZA konfiguracja greenproof u użytkownika: wywiad onboardingowy, repo testów, adres appki, preset i model, token, minimalny plan, preflight, pierwsza komenda `gp run` | `skills/greenproof-start.md` |
| Użytkownik chce odpalić/powtórzyć/zdebugować przebieg testów: wybór configu, komenda `greenproof run`, flagi, `.env`, kody wyjścia, `status`/`accept`/`release`/`clean` | `skills/greenproof-cli.md` |
| Trzeba zinterpretować wynik runu (`result.json`, `status.summary`, ledgery, dowody, transcripty), zdecydować retry vs eskalacja fixture, rekomendować accept/waiver/release, posprzątać albo monitorować długi run | `skills/greenproof-operator.md` |
| Zmiana modelu autora lub providera (presety `codex-sub`/`litellm`/`claude-sub`, `--author`, `--base-url`/`--token-env`, preflight), eskalacja fixture, `priceTable`, capy, efforty, tokeny | `skills/greenproof-config.md` |

Zasady nadrzędne dla wszystkich skilli:

- **Run odpala CZŁOWIEK w interaktywnym terminalu, nigdy agent w tle.** Agent
  przygotowuje komendę i oddaje ją użytkownikowi; szczegóły i uzasadnienie:
  `skills/greenproof-cli.md` §0a.
- Case'y z ważnym dowodem i czystym lintem przyjmuje SAM pipeline (auto-accept).
  Ręczny `accept` dotyczy tylko tych, których pipeline nie wziął (dowód
  nieważny, duplikat selektora, `blocked`) - i to, razem z `release` oraz
  `clean --purge`, są decyzje CZŁOWIEKA: agent przygotowuje gotową komendę
  i rekomendację, ale jej nie uruchamia bez zgody.
- Agent nie pushuje do repo testów; jedyny push robi `greenproof accept`.
- Aplikacja testowana (pod `envUrl` / `--app-url`) musi działać przed runem.
- Nie ruszaj cudzych runów ani ich artefaktów.
