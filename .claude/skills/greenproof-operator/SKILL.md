---
name: greenproof-operator
description: Drive a full greenproof cycle - read run results (result.json, ledgers, proofs, transcripts), diagnose blocked/attempt_failed cases, decide retry vs fixture escalation, recommend accept/waiver/release, clean up, and monitor long runs. Use when interpreting greenproof output or deciding the next step on a run.
---

Skill prowadzenia pełnego cyklu greenproof: interpretacja `result.json`
i `status.summary`, czytanie artefaktów platformy (ledger, proof, transcripty,
workdiry), decyzje retry / eskalacja fixture / accept / waiver / release,
sprzątanie po release i monitoring długich runów.

Zasada nadrzędna: case'y z ważnym dowodem i czystym lintem przyjmuje SAM
pipeline (auto-accept). Ręczny `accept` (dla tych, których pipeline nie wziął),
`release` i `clean --purge` to decyzje CZŁOWIEKA - agent proponuje gotową
komendę, nie uruchamia jej sam; agent nigdy nie pushuje. Runu też nie odpala
w tle - to robi człowiek w swoim terminalu.

Przeczytaj i stosuj instrukcje z `skills/greenproof-operator.md` (ścieżka
względem korzenia repo).
