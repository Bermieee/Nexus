# Nexus Tree Continuous-Pool Latency Repair — 2026-09-22

## Evidence
Live Builder 2 diagnostics showed that the outer Tree Batch Layer correctly packed 14 semantic survey slices into 7 multiplexed physical requests and admitted them into a two-worker continuous A/B pool. However, each already-packed physical request then re-entered the generic Sidecar coalescer as a single queued item. The configured coalesce window was 45 ms, but browser/event-loop delays caused some single-item physical requests to remain behind that redundant timer for tens of seconds before dispatch.

## Repair
- The existing outer Tree Batch Layer remains the sole packing/rolling-pool owner.
- `dispatchNexusModelWorkerUnits()` now recognizes the existing `nexusBatchTreeRollingDispatch:true` marker supplied by the Batch Layer.
- Only those already-packed Tree rolling-pool physical units are sent with `batchable:false` to `enqueueNexusSidecarJob()`.
- The existing `batchable:false` path dispatches directly into the canonical Sidecar Bus/router rather than entering the generic debounce/coalescing queue a second time.
- Non-Tree work and Tree requests outside the marked rolling-pool path retain existing coalescing behavior.

## Preserved authority
This does not change:
- Builder 2 semantic slicing or physical multiplex packing;
- Batch Layer planning, validation, recovery, or continuous-pool width;
- Work Director/model-worker resource selection;
- Sidecar A/B health routing, adaptive fallback, or JobQueue authority;
- prompts, reasoning, token targets, semantic validators, PlanStore, review, mutation, or Ledger ownership.

The change removes only a redundant scheduling barrier after Builder work is already physically packed and admitted.
