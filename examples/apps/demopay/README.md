# DemoPay — demo-app do testowania pipeline'u E2E

Prosta aplikacja kadrowo-płacowa (po polsku w UI, kod po angielsku), zbudowana
specjalnie do testowania pipeline'u E2E. Bez bundlera frontendu, bez natywnych
zależności.

## Wymagania

- Node.js >= 20
- pnpm (monorepo `greenproof`)

## Uruchomienie

Zainstaluj zależności w roocie monorepo (jeśli jeszcze nie są):

```sh
pnpm install
```

Uruchom serwer (port 3131, można nadpisać zmienną `PORT`):

```sh
pnpm --filter @greenproof/demo-app start
# lub bezpośrednio
PORT=3131 node examples/demo-app/src/server.js
```

Serwer nasłuchuje na `http://localhost:3131`.

Dane logowania: **demo / demo123**.

## Mapa routingu

| Metoda | Ścieżka           | Opis                                                        | Auth |
|--------|-------------------|-------------------------------------------------------------|------|
| GET    | `/`               | redirect → `/employees` (lub `/login`)                      | tak  |
| GET    | `/login`          | strona logowania                                            | nie  |
| GET    | `/employees`      | strona pracowników                                          | tak  |
| GET    | `/payroll`        | strona listy płac                                           | tak  |
| POST   | `/api/login`      | logowanie (`{username, password}`) → ciasteczko sesji       | nie  |
| POST   | `/api/logout`     | wylogowanie                                                 | tak  |
| GET    | `/api/session`    | czy zalogowany `{authenticated}`                            | nie  |
| GET    | `/api/employees`  | lista pracowników                                           | tak  |
| POST   | `/api/employees`  | dodanie pracownika (walidacja)                              | tak  |
| GET    | `/api/payroll`    | lista płac `?month=YYYY-MM`                                 | tak  |
| POST   | `/api/payroll`    | utworzenie listy płac (churn-prone)                         | tak  |
| POST   | `/api/test/reset` | czyści całą bazę (employees, payrolls, attempts, sessions)  | nie  |
| POST   | `/api/test/seed`  | seed danych wprost                                          | nie  |

## Pełna lista `data-testid` per widok

### Logowanie (`/login`)
| data-testid      | Element                          |
|------------------|----------------------------------|
| `login-username` | pole „Nazwa użytkownika"         |
| `login-password` | pole „Hasło"                     |
| `login-submit`   | przycisk „Zaloguj się"           |
| `login-error`    | komunikat błędu logowania        |

### Pracownicy (`/employees`)
| data-testid          | Element                          |
|----------------------|----------------------------------|
| `employee-name`      | pole formularza „Imię i nazwisko"|
| `employee-pesel`     | pole formularza „PESEL"          |
| `employee-salary`    | pole formularza „Stawka brutto"  |
| `employee-submit`    | przycisk „Dodaj"                 |
| `employee-form-error`| komunikat błędu formularza       |
| `employees-table`    | tabela pracowników               |
| `employee-row`       | wiersz tabeli (jeden pracownik)  |

### Lista płac (`/payroll`)
| data-testid      | Element                                     |
|------------------|---------------------------------------------|
| `payroll-month`  | pole miesiąca (input `type=month`)          |
| `payroll-create` | przycisk „Utwórz listę płac"                |
| `payroll-status` | tekst statusu (tworzenie / utworzono)       |
| `payroll-error`  | komunikat błędu                             |
| `payroll-row`    | wiersz tabeli listy płac                    |
| `payroll-gross`  | komórka „Brutto" w wierszu                  |
| `payroll-net`    | komórka „Netto" w wierszu                   |

## API testowe

Dostępne **bez uwierzytelniania**:

- `POST /api/test/reset` — czyści całą bazę danych (także tabelę `payroll_attempts`).
- `POST /api/test/seed` — tworzy dane wprost, body:

```json
{
  "employees": [
    { "name": "Jan Kowalski", "pesel": "90010112345", "salary": 5000, "hiredAt": "2020-01-01" }
  ],
  "payrolls": [
    { "month": "2026-01" }
  ]
}
```

Seedowanie listy płac **omija** opóźnienie i zachowanie 503, ale tworzy listę
tylko wtedy, gdy w danym miesiącu są pracownicy zatrudnieni najpóźniej w tym
miesiącu (`hiredAt <= ostatni dzień miesiąca`). W przeciwnym razie zwraca
**422** z komunikatem `Brak pracowników zatrudnionych w miesiącu X`.

## Zachowanie churn-prone (utworzenie listy płac)

`POST /api/payroll` z body `{ "month": "YYYY-MM" }`:

1. Serwer czeka **losowo 2–8 sekund** (`setTimeout` po stronie serwera).
2. Przy **pierwszym** wywołaniu dla danego miesiąca w **~30%** przypadków zwraca
   **503** z komunikatem `Lista płac w przygotowaniu, spróbuj ponownie`
   (próby zapisywane w tabeli `payroll_attempts`).
3. Kolejne wywołanie dla tego samego miesiąca zawsze się udaje (licznik prób
   blokuje ponowne 503).
4. Lista auto-populuje się pracownikami zatrudnionymi najpóźniej w wybranym
   miesiącu (pole `hired_at`).

## Wzór na netto

```
ZUS      = round2(brutto * 0.1371)
zaliczka = round2((brutto - ZUS - 250) * 0.12)   // ulga podatkowa 250 zł
netto    = round2(brutto - ZUS - zaliczka)
```

`round2(x) = Math.round(x * 100) / 100` — zaokrąglanie do 2 miejsc dziesiętnych
na **każdym kroku pośrednim**.

Golden-case'y (źródło prawdy): `docs/golden-cases/netto.yaml`.

## Struktura plików

```
examples/demo-app/
├── package.json
├── README.md
├── data/                  (tworzone automatycznie — demo.db)
├── docs/golden-cases/netto.yaml
├── public/
│   ├── style.css
│   ├── login.html / login.js
│   ├── employees.html / employees.js
│   └── payroll.html / payroll.js
└── src/
    ├── server.js          (fastify + routing)
    ├── db.js              (node:sqlite DatabaseSync)
    ├── net.js             (wzór netto)
    └── auth.js            (sesje w ciasteczku)
```
