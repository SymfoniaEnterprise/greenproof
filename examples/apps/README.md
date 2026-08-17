# Aplikacje demo

Dwie testowe appki kadrowo-płacowe (Fastify + SQLite `node:sqlite`, bez bundlera),
na których greenproof jest testowany i benchmarkowany. W repo - demo działa bez
stawiania czegokolwiek z zewnątrz.

## DemoPay - easy app (`demopay/`)

Logowanie, lista pracowników, churn-prone lista płac; oracle (golden-cases)
w `docs/golden-cases/`. 2 case'y golden path. Port `3131` (zmienna `PORT`),
konto `demo` / `demo123`.

```sh
cd examples/apps/demopay
npm install && npm start   # http://localhost:3131
```

## HR-Payroll - complex app (`hr-payroll/`)

Role, paginacja serwerowa, optimistic locking, PESEL z cyfrą kontrolną,
workflow statusów, nakładanie urlopów, celowy churn payrollu. 10 case'ów benchmarku.
Port `3132` (zmienna `DEMO_PORT`).

| Rola | Login | Hasło |
|---|---|---|
| admin | `admin` | `admin123` |
| accountant | `accountant` | `account123` |
| employee | `employee` | `employee123` |

```sh
cd examples/apps/hr-payroll
npm install && npm start   # http://localhost:3132
```

## Uwagi

- Baza SQLite (`data/demo.db`) tworzy się sama przy pierwszym starcie
  (`CREATE TABLE IF NOT EXISTS`); ścieżka: `DEMO_DB_PATH`.
- `node_modules/` i `*.db` ignorowane (`.gitignore` w każdej appce).
- `scripts/demo.mjs` i `scripts/benchmark-path.mjs` biorą `hr-payroll` (env `GP_HR_APP_DIR`); `scripts/golden-path.mjs` bierze `demopay` (env `GP_DEMOPAY_APP_DIR`).
