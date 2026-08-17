---
name: greenproof-cli
description: Run greenproof E2E test authoring from the CLI - pick a config preset or scaffold from scratch, build the full `gp run` command with flags, handle tokens via .env, and interpret exit codes (0/2/3/5/10). Use when the user wants to start, re-run, or debug a greenproof run, or asks which command to type.
---

Skill uruchamiania przebiegów greenproof przez CLI: wybór wariantu konfiguracji
(gotowy config z `configs/` vs `--tests-repo` od zera), pełna komenda
`gp run` z flagami, sekrety przez `.env`, kody wyjścia, komendy po
runie (`status`/`accept`/`release`/`clean`) i typowe błędy.

Zasada nadrzędna: **run odpala CZŁOWIEK w interaktywnej sesji terminala, nigdy
agent w tle** - agent składa komendę i oddaje ją użytkownikowi (uzasadnienie
w §0a skilla).

Przeczytaj i stosuj instrukcje z `skills/greenproof-cli.md` (ścieżka względem
korzenia repo).
