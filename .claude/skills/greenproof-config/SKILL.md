---
name: greenproof-config
description: Configure the greenproof author model and provider - presets (codex-sub/litellm/claude-sub), switching model via --author or the one marked spot in configs/*.mjs, switching provider via --base-url/--token-env plus mandatory preflight, fixture escalation, priceTable, costModel (local/subscription/metered - required for local models, otherwise the run dies on a phantom SDK budget), caps worth tuning, and reasoning efforts. Use when changing model, provider, budget caps, or tokens, or when a run was killed by an unexpected budget limit.
---

Skill konfiguracji greenproof: trzy presety providerów, zmiana modelu (flaga
`--author` vs jedno oznaczone miejsce w `configs/*.config.mjs`), zmiana
providera (`--base-url`/`--token-env` + OBOWIĄZKOWY `grp preflight`),
eskalacja fixture, `priceTable`, capy warte ruszania, efforty i tokeny.

Przeczytaj i stosuj instrukcje z `skills/greenproof-config.md` (ścieżka
względem korzenia repo).
