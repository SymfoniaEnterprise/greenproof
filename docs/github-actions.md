# greenproof w GitHub Actions - wzorzec widoczności postępu

CLI wykrywa Actions samo (`GITHUB_ACTIONS=true` → renderer `github`), więc bez
żadnej konfiguracji dostajesz w logu joba:

- linie postępu `[gp HH:MM:SS] …` streamowane na żywo (case'y, tury co 30 s,
  runy playwright, kamienie milowe kroków),
- zwijane grupy `::group::case UC-3 (próba 2)` - log każdego case'a domyka się
  w jedną sekcję,
- po zakończeniu komendy tabelę per case w **Job Summary** (status ✅/❌, koszt,
  tury, wiersz „Razem" z rollupem runu).

Ograniczenie platformy: Actions nie obsługuje odświeżania linii przez `\r`,
więc tablica statusu (`tty`) jest tylko dla lokalnego terminala - w CI
automatycznie lecą linie.

## Wzorzec joba: krok per faza

Job Summary agreguje wpisy **po zakończeniu każdego kroku** workflow - dziel
pipeline na osobne kroki, a podsumowanie rośnie w trakcie runu zamiast pojawić
się dopiero na końcu:

```yaml
jobs:
  greenproof:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci

      - name: step filter + step triage
        run: |
          node packages/cli/dist/main.js step filter --config gp.config.mjs \
            --in filter-in.json --out out/filter.json
          node packages/cli/dist/main.js step triage --config gp.config.mjs \
            --run "$(jq -r .runId out/filter.json)"

      - name: fixture (prewencja)
        # --in przyjmuje ŚCIEŻKĘ do pliku JSON, nie inline JSON
        run: |
          printf '{"runId":"%s","mode":"preventive"}' "$RUN_ID" > fixture-in.json
          node packages/cli/dist/main.js fixture --config gp.config.mjs \
            --in fixture-in.json
        continue-on-error: true # exit 3 = częściowa porażka typów, nie ubijaj runu

      - name: step author   # najdłuższy krok - grupy per case + tabela do Summary
        run: node packages/cli/dist/main.js step author --config gp.config.mjs --run "$RUN_ID"

      - name: step deliver + status
        if: always()
        run: |
          node packages/cli/dist/main.js step deliver --config gp.config.mjs --run "$RUN_ID"
          node packages/cli/dist/main.js status --config gp.config.mjs --run "$RUN_ID" \
            --out out/status.json
```

Uwagi:

- `status` zwraca w polu `summary` rollup (`done/remaining/passed/failed`,
  koszt, tury) - wygodny wsad do własnych adnotacji (`::notice::`) albo
  komentarza w PR.
- Kody wyjścia sterują przepływem joba (patrz `docs/adapters.md` i pomoc CLI):
  `3` = partial (co najmniej jeden case niedowieziony), `10` = pusta selekcja.
- Matrix po modelach (`strategy.matrix.model`) daje darmowy podgląd per model
  w grafie workflow; każdy job pisze własne Job Summary.
- Wymuszenie innego widoku: `GREENPROOF_PROGRESS=plain|json|off` w `env` kroku
  (np. `json` gdy postęp ma konsumować własny skrypt).
