# Test Design: Aneks Ubezpieczenia

Autor: TEA (BMAD)
Data: 2026-08-14

## Coverage Matrix - AC-1..AC-3

| ID | Requirement | Level | Priority | Description | Flow | Type |
| --- | --- | --- | --- | --- | --- | --- |
| 3.2-E2E-019 | AC-1, AC-2 | E2E | P0 | Dodanie aneksu ubezpieczenia z poziomu listy | contract/annex, insurance/add | aneks |
| `3.2-UNIT-004` | AC-3 | UNIT | P1 | Walidacja daty obowiązywania \| granice zakresu |  |  |
| TBD-1 | AC-9 | E2E | P2 | Wiersz roboczy - ID jeszcze nie nadane |  |  |

## Coverage Matrix - Epic 1.1

| Test ID | AC | Poziom | Priorytet | Opis | Tags | Typ |
|---------|----|:------:|-----------|------|------|-----|
| 1.1-INT-002 | AC-4 | E2E | P2 | Import listy płac z pliku | payroll/import | lista płac |
| 1.1-INTEGRATION-003 |  | INT | P3 |  |  |  |

## Risk Profile

| Risk | Score |
| --- | --- |
| Utrata danych kadrowych | 6 |

## Quality Gate Criteria

Bramki jakości pochodzą z konfiguracji greenproof, nie z tego dokumentu.

| ID | Gate | Priority |
| --- | --- | --- |
| 9.9-E2E-999 | blocker | P0 |
