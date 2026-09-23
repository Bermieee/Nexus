# Nexus Tasks #200 / #210 — Development-bugs checkpoint

Date: 2026-09-22

## #210 — Decision Core canonical freshness
- Added one shared freshness contract with canonical source material and explicit revision identities.
- Initial and final checks invoke the same canonical input builder.
- Stale diagnostics distinguish revision changes from material-hash changes without exporting source text.
- Migrated promoted Decision sites for Retrieval, Smart Context, Character State, Memory Recall, and Housekeeper.
- Genuine chat/scene/lore-tree/memory/Character State source changes remain invalidating.

## #200 — Housekeeper bounded triage
- Deterministic findings remain the canonical Housekeeper finding set.
- Removed sequential merge/overload Jev filtering from the normal Housekeeper run.
- Removed the separate maintenance shadow triage from the normal Housekeeper run.
- Findings are chunked once through bounded Decision Core triage; independent chunks may run concurrently.
- Jev may route/prioritize only. It never mutates, approves, or deletes deterministic findings.
- Stale, unavailable, malformed, or low-confidence Jev results fail open to the existing Sidecar review path.
- Confident deterministic/operator-only findings may skip redundant Sidecar review.
- Sidecar review receives only exact unresolved/admitted finding IDs.
- Preserved #201 early source-signature reuse and injected lore/Tree read reuse.

## Validation
Automated branch workflow: `.github/workflows/task200-210-validation.yml`
- full JavaScript syntax sweep
- #200/#210 contract regression
- #201 Housekeeper reuse regression
- Decision workflow coverage
- Retrieval Jev admission
- Smart Context Jev admission
- Character review policy
- performance hot paths

Live SillyTavern telemetry/failure/narrative-quality acceptance remains a runtime gate and is not claimed by this source checkpoint.
