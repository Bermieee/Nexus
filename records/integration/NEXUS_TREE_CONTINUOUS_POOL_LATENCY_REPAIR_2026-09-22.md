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


## Elastic Main-lane follow-up

### Source-confirmed gap
The abstract Model Worker pool was already in place, but the batch planner still snapshotted physical availability at batch start. When canonical Main-worker authority was enabled but Main was physically busy at that instant, the planner replaced the hybrid worker set with Sidecars only for the lifetime of that batch. Main therefore could not join remaining Builder work after foreground generation released the Main lease.

The repair keeps `MAIN` in the batch's potential worker set when Main is authorized/connected but temporarily busy. Physical dispatch remains dynamic: every unit still re-reads Main policy, gateway connectivity, busy state, reservation state, and Sidecar availability before choosing a resource. A Main-preferred unit falls back to Sidecar while Main is busy; later units can use Main once it becomes free.

This changes only physical pool elasticity. It does not change Builder 2 semantic work, Work Director ownership, Main foreground priority, Sidecar routing, validation, PlanStore, review, mutation, or Ledger authority.

### Live diagnostic clarification
The diagnostic used while tracing this seam (`Nexus-diagnostics-2026-09-23T03-01-25-450Z.json`) repeatedly showed `mainEligible:true` but `mainConfigured:false`. That run did not have canonical Nexus Main-worker participation enabled, so its A/B-only Builder execution is correct switch behavior and is not evidence of the busy-Main elasticity defect. A live Main+Sidecar acceptance run must explicitly enable the canonical Call Center `mainModelAccess` switch.

### TDD evidence
- RED commit state: `0aacb7f12fee3f98a8e048cf02b8385f25f15ca5`
- RED Actions run: `35816381475`
- Exact failing assertion: `busy Main must not collapse the whole Builder batch to Sidecar-only`
- GREEN production commit: `8c8f5f309daf606e2c8b061f7fd13db76167aac7`
- GREEN Tree continuous-pool validation: `35816426249`
- GREEN Builder 2 taxonomy-plan hedge validation: `35816426395`
- GREEN Nexus 0.7.5 release validation: `35816426336`

Offline/CI validation is green. Live SillyTavern acceptance still requires a run with canonical Main participation enabled so Main can be observed joining remaining Builder work after becoming physically free.
