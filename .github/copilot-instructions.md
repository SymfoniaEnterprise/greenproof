# Copilot - instrukcje dla repo greenproof

**greenproof** to biblioteka agentowego autorowania testów E2E Playwright
z bramkami ludzkimi i dowodem mutacyjnym (monorepo TypeScript, pnpm; rdzeń
w `packages/core`, CLI `greenproof` w `packages/cli`, adaptery platformy
osobno). Pipeline: `filter → triage → [fixture prewencyjny] → author → dowód
mutacyjny → deliver → auto-accept (pipeline) → release (człowiek, bramki)`.

Katalog `docs/` jest **źródłem prawdy** - nie zgaduj zachowania CLI ani pól
configu: `docs/configuration.md`, `docs/config-reference.md`,
`docs/adapters.md`, `docs/model-bridges.md`, `docs/benchmarks.md`
(+ wyniki: `docs/benchmarks-easy-app.md`, `docs/benchmarks-complex-app.md`),
`README.md`. Aktualny help:
`node packages/cli/dist/main.js --help`.

Testy: `npx tsc -b && npx vitest run` z korzenia repo.

## Skille - przeczytaj właściwy plik przed działaniem

Pełne instrukcje operacyjne (komendy do skopiowania, decyzje „jeśli X → zrób Y")
leżą w `skills/`:

- **`skills/greenproof-start.md`** - PIERWSZA konfiguracja u użytkownika: wywiad
  onboardingowy (repo testów, adres appki, preset i model, token, minimalny
  plan), preflight i przygotowanie pierwszej komendy `grp run`.
- **`skills/greenproof-cli.md`** - odpalanie przebiegów przez CLI: wybór configu
  (gotowy z `configs/` vs `--tests-repo` od zera), komenda `greenproof run`
  z flagami, sekrety przez `.env`, kody wyjścia (0/2/3/5/10), komendy po runie.
- **`skills/greenproof-operator.md`** - prowadzenie cyklu: czytanie
  `result.json`/`status.summary`, ledgerów, dowodów i transcriptów; decyzje
  retry vs eskalacja fixture; rekomendacje accept/waiver/release; sprzątanie
  i monitoring długich runów.
- **`skills/greenproof-config.md`** - presety providerów
  (`codex-sub`/`litellm`/`claude-sub`), zmiana modelu i providera, obowiązkowy
  `greenproof preflight`, eskalacja fixture, `priceTable`, capy, efforty, tokeny.

Zasady nadrzędne: **run odpala człowiek w interaktywnym terminalu, nigdy agent
w tle** (`skills/greenproof-cli.md` §0a); case'y z ważnym dowodem przyjmuje sam
pipeline, a ręczny `accept` (dla nieprzyjętych), `release` i `clean --purge` to
decyzje CZŁOWIEKA - proponuj komendę, nie uruchamiaj; nie pushuj do repo
testów; nie commituj bez wyraźnej prośby, a `.env` ani tokenów nigdy;
aplikacja pod `--app-url` musi działać przed runem.
