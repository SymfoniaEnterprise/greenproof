# HR-Payroll Benchmark — demo-app-benchmark

Rozszerzona aplikacja kadrowo-płacowa (UI po polsku, kod po angielsku) do
testowania pipeline'u E2E greenproof. Celowo **większa i trudniejsza do
przetestowania** niż `demo-app` (DemoPay): role, paginacja serwerowa,
optimistic locking, workflow statusów, nakładanie urlopów, losowy churn,
audyt i pułapki walidacyjne (PESEL z cyfrą kontrolną).

Bez bundlera, bez natywnych zależności. Fastify + node:sqlite + vanilla JS.

## Uruchomienie

```sh
pnpm install            # w rootcie monorepo greenproof
pnpm --filter @greenproof/demo-app-benchmark start
# lub: node src/server.js (port 3132, nadpisz przez DEMO_PORT)
```

Serwer nasłuchuje na `http://localhost:3132`.

## Konta demo

| Rola       | Login        | Hasło        |
|------------|--------------|--------------|
| admin      | `admin`      | `admin123`   |
| accountant | `accountant` | `account123` |
| employee   | `employee`   | `employee123` |

## Mapa routingu

Strony: `/login`, `/dashboard`, `/employees`, `/payroll`, `/leave`,
`/departments` (tylko admin).

| Metoda | Ścieżka | Opis | Role |
|---|---|---|---|
| POST | `/api/login` | logowanie → ciasteczko sesji (TTL 8h) | — |
| POST | `/api/logout` | wylogowanie | — |
| GET | `/api/session` | `{authenticated, username, role, full_name}` | — |
| GET | `/api/employees` | lista z paginacją/sort/filtrami `?page&pageSize&sortBy&sortDir&departmentId&active&search` | wszyscy |
| POST | `/api/employees` | dodanie pracownika (walidacje PESEL itd.) | admin |
| PUT | `/api/employees/:id` | edycja z optimistic lock (`version`) | admin |
| POST | `/api/employees/:id/terminate` | zwolnienie (422 przy niezakończonych payrollach) | admin |
| DELETE | `/api/employees/:id` | usunięcie (422 przy payrollach/urlopach) | admin |
| GET | `/api/departments` | lista działów | wszyscy |
| POST | `/api/departments` | nowy dział (409 przy duplikacie) | admin |
| GET | `/api/payroll?month=YYYY-MM` | lista płac | admin/accountant |
| POST | `/api/payroll` | tworzenie listy płac (delay 2-8s, churn 503, 409 przy duplikacie) | admin/accountant |
| POST | `/api/payroll/:id/approve` | zatwierdzenie (409 gdy nie draft / zły version) | admin/accountant |
| POST | `/api/payroll/:id/pay` | wypłata (409 gdy nie approved / zły version) | admin/accountant |
| GET | `/api/leave?status=` | wnioski urlopowe (employee widzi tylko swoje) | wszyscy |
| POST | `/api/leave` | nowy wniosek (422 przy nakładaniu dat) | wszyscy |
| POST | `/api/leave/:id/review` | akceptacja/odrzucenie (409 gdy nie pending) | admin/accountant |
| GET | `/api/audit?limit=` | log audytu | admin |
| POST | `/api/test/reset` | czyści bazę → 3 konta demo | — |
| POST | `/api/test/seed` | seed danych; akceptuje `department_name`/`employee_pesel` zamiast ID | — |

## Pułapki testowe (po co to istnieje)

- **PESEL**: 11 cyfr + algorytm cyfry kontrolnej (wagi 1,3,7,9,1,3,7,9,1,3),
  duplikat → 409.
- **Paginacja serwerowa** (pageSize max 50), sortowanie po 5 polach, filtry
  dział/status/search.
- **Optimistic lock**: PUT employee, approve/pay payroll wymagają `version` —
  nieaktualny → 409 "Ktoś zmodyfikował ten rekord".
- **Churn**: tworzenie listy płac trwa 2-8 s i ma 30% szans na 503 przy
  pierwszej próbie dla miesiąca.
- **Workflow**: payroll draft → approved → paid (nielegalne przejścia → 409);
  urlopy pending → approved/rejected (re-review → 409).
- **Nakładanie urlopów**: 422 gdy daty kolidują z istniejącym wnioskiem.
- **Role**: employee nie może tworzyć departamentów ani akceptować urlopów (403).
- **Audyt**: każda istotna akcja w `audit_log` (login, create, terminate,
  approve, pay, review...).
- **Seed deterministyczny**: reset + seed wraca do znanego stanu; odwołania
  przez nazwy (department_name, employee_pesel), nie po ID.

## Zależności od demo-app

Ta aplikacja jest nową, niezależną paczką — nie dzieli kodu z DemoPay.
Różnice względem DemoPay: role i sesje per-user, paginacja serwerowa,
optimistic locking, workflow statusów, urlopy, audyt, szerszy seed.
