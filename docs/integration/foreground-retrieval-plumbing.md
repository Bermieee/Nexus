# Foreground retrieval and cognition plumbing — 2026-09-30

## Live evidence and root cause

The 20:18 diagnostics export for `tv2_generation_1790813815945_2` recorded a
15,825 ms foreground retrieval stall. Scene Scanner had zero attempts and no
start timestamp. The scheduler's inner physical dispatch had changed the
foreground flag to false. During generation, the physical queue pauses background
work; retrieval was waiting for a Scene prerequisite that could not start.

The scheduler now preserves foreground queue access after admitting a foreground
lease. A private Symbol prevents recursive scheduler admission without changing
the physical job into background work. Background work remains paused, failover
keeps foreground access, and cancellation releases both leases. Timeout budgets
are unchanged.

## Traced handoffs

- Scene Scanner supplies retrieval's Scene prerequisite. Scene Intelligence owns
  the product Scene view and updates Hot Cognition through its integration signal.
  Unknown objects and inferred atmosphere can legitimately degrade the Scene view.
- Hot Cognition's fresh cast and continuity nominate canonical World Tree Lore
  through Sensory's `hot-continuity` channel. Foreign-chat snapshots and stale
  segment values are now excluded.
- Graph Walker reads the canonical World Tree compatibility projection. Its
  nominations join the Sensory envelope; its traversal receipt updates Hot's graph
  neighborhood. That graph-feed event now carries the captured generation ID.
- Sensory's fused envelope reaches Truth with candidate identity, provenance and
  source revisions preserved. Truth's filtered candidates feed the remaining
  retrieval admission path. The live timeout occurred before these stages.
- Foreground retrieval results join Gather. Existing deadline behavior still
  seals a bounded fallback if work cannot finish; late work cannot rewrite a seal.
- Jev's retrieval admission calls now carry captured chat/generation identity
  through the Decision Site runtime into result telemetry. Actual Jev physical
  attempts are distinguished from unconfigured adapters. The UI reads completed,
  failed/fallback and stale scoped results; probes, deterministic answers and
  foreign or anonymous events cannot prove a selected-turn Jev call. A typed
  advisory receipt does not claim owner settlement.

## Receipt display correction

The Brain explanation expected `selected.producers`, while the Nexus adapter
provided `selected.stages`. Consequently it reported Seal, PromptPlan and Delivery
missing even while other surfaces showed their actual owner receipts. The adapter
now supplies the expected producer map from those receipts. Sensory and Truth are
included only when scoped evidence exists. Their event readers also reject
anonymous and foreign events instead of relabeling them with the current selection.
Host delivery still requires a matching non-dry-run host event; frame preparation
alone is not host observation. Owner acceptance is not inferred from availability.

## Verification

- Focused scheduler/queue, integration handoff, Jev producer/host and Diagnostics
  checks: 48/48 passing.
- Complete offline run: 61/65 standalone files passing; 506/506 syntax checks.
- The same four prior failures remain: `character-review-policy.mjs`,
  `performance-hotpaths.mjs`, `prompt-loader-adapters.mjs`, and
  `summary-digest-coverage.mjs`. Three reference removed legacy UI files; the
  prompt-loader test requires the removed Activity Feed startup call.
- Evidence: `C:/Users/cacon/AppData/Local/Temp/nexus-plumbing-20260930/report.json`.
- New regression files are included in the scheduler GitHub workflow.

Real SillyTavern/provider acceptance has not been run after this repair. On the
next generation, check that the Scene prerequisite starts, Sensory/Truth and Walker
emit matching-generation evidence, Gather's retrieval result is not the old
queued-work fallback, and an enabled Jev admission call produces scoped evidence.
An absent Jev call must remain absent. Current Hot snapshots are chat-scoped live
working state, not retained historical turn receipts.
