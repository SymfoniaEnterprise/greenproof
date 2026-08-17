# Struktura repozytorium

Przegląd katalogów monorepo - gdzie szukać rdzenia, adapterów, CLI, przykładów
i dokumentacji, gdy orientujesz się w kodzie greenproof.

```
greenproof/
├── packages/
│   ├── core/                    - rdzeń: domena, schematy, kroki pipeline,
│   │                              maszyna stanów, porty, autor, harvest,
│   │                              knowledge, ledger, proof
│   ├── cli/                     - binarka `greenproof` (argv → config →
│   │                              resolvePlatform → komenda → JSON)
│   ├── adapter-fs/              - adapter platformy na lokalnym gicie
│   │                              i filesystemie (do devu i testów)
│   ├── adapter-github/          - adapter platformy GitHub (REST API,
│   │                              issue jako kanał do człowieka)
│   ├── plan-parser-bmad/        - plugin parsera planu (BMAD TEA format)
│   └── testing/                 - fake'i portów + fixture'y raportów
│                                  Playwrighta (InMemory*, Capturing*)
├── examples/
│   ├── apps/                    - appki demo w repo: demopay (łatwa),
│   │   │                          hr-payroll (trudna, benchmark)
│   │   ├── demopay/             - DemoPay: logowanie, pracownicy, churn-prone
│   │   │                          lista płac, golden-cases w docs/
│   │   └── hr-payroll/          - HR-Payroll: role, paginacja, optimistic
│   │                              locking, PESEL, workflow statusów, urlopy
│   ├── github-workflow/         - referencyjne workflow + przykładowy config
│   ├── benchmark-plan.json      - plan benchmarku (przebiegi/filtry/per-case)
│   └── benchmark-filter-input.json - wejście filtra dla benchmarku
├── scripts/
│   └── golden-path.mjs          - pełna pętla greenproof (filter → triage →
│                                  author → deliver → accept → release)
│                                  na adapter-fs przeciw appce DemoPay
└── docs/                        - źródło prawdy (config, adaptery, mostki,
                                   benchmarki, CI)
```
