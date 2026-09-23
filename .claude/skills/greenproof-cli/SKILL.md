---
name: greenproof-cli
description: Run greenproof E2E test authoring from the CLI - pick a config preset or scaffold from scratch, build the full `grp run` command with flags, handle tokens via .env, and interpret exit codes (0/2/3/5/10). Use when the user wants to start, re-run, or debug a greenproof run, or asks which command to type.
---

Skill uruchamiania przebiegów greenproof przez CLI: wybór wariantu konfiguracji
(gotowy config z `configs/` vs `--tests-repo` od zera), pełna komenda
`grp run` z flagami, sekrety przez `.env`, kody wyjścia, komendy po
runie (`status`/`accept`/`release`/`clean`) i typowe błędy.

Zasada nadrzędna: **run odpala domyślnie CZŁOWIEK w interaktywnej sesji
terminala** - agent w sesji z mechanizmem zadań w tle (start, podgląd stanu,
przerwanie scoped do własnego zadania) może odpalić `grp run` sam, pod
warunkami z §0a skilla; bez tego mechanizmu zostaje przy podaniu komendy do
wklejenia.

Przeczytaj i stosuj instrukcje z `skills/greenproof-cli.md` (ścieżka względem
korzenia repo).
