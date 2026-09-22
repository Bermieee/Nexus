# Nexus UI/Wiring + Speed Pass Checkpoint

Date: 2026-09-22

## Executable return point

`1b068f5bfa4771628a93fe05ac7a674d4c80b45c`

Commit message:

`perf: lazily render Activity Feed developer payloads`

This SHA is the exact executable Nexus checkpoint after:

- task #197 CSS / stale wiring cleanup;
- Main authority consolidation under Call Center;
- verified orphan CSS purge;
- safe performance hot-path work through the Activity Feed lazy developer-payload change.

Use the SHA above when returning to the exact runtime code state. Documentation commits placed after this checkpoint do not alter executable Nexus behavior.

## Integration target

`Bermieee/Nexus` -> `Development`

## Consolidated change log

See:

`records/integration/NEXUS_UI_WIRING_SPEED_PASS_CHANGELOG_2026-09-22.pdf`

The PDF distinguishes retained production changes from performance experiments that were deliberately backed out for safety, including the rejected concurrent SillyTavern World Info lorebook reads.

## Safety boundary

At this checkpoint the performance pass intentionally did not change:

- Change Gate classifications or thresholds;
- Retrieval scoring weights or relevance thresholds;
- prompt budgets or injection ordering;
- Memory Recall scoring/rerank policy;
- Sidecar routing/concurrency policy;
- Work Director / Decision Core authority;
- Character State behavior;
- Builder / Builder2 behavior;
- canonical mutation / ledger ownership;
- Main prompt or Generation Frame publication authority.
