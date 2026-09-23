# Nexus Tasks #202/#203 — Lifecycle Execution Ownership Checkpoint

Date: 2026-09-22  
Workspace: `Bermieee/Development`  
Branch: `Development-New-Features` only  
Baseline: `b00977a2bfddf8b563a8c844ec1aebf441ac51b6`

## Scope

This checkpoint covers:

- #202 — resumable/durable execution checkpoints for preemptible lifecycle work.
- #203 — separation of logical lifecycle-cycle authority from physical background execution ownership.

No branch was created or switched.

## Invariants preserved

1. One executable physical owner exists for an exact work unit.
2. Conflicting target work cannot execute concurrently. A newer unit may wait, but it cannot take the lease until the old physical promise settles.
3. Logical invalidation revokes authority without pretending transport/execution stopped.
4. Exact duplicate work joins the existing physical promise instead of launching a second executor.
5. Unrelated/non-conflicting targets may execute concurrently.
6. Foreground priority remains owned by the existing central JobQueue/model-worker path; this work does not create a second worker scheduler.
7. Every checkpointed effect persists an execution-intent checkpoint before execution.
8. If pre-execution checkpoint persistence fails, execution does not start.
9. Once execution has started, unknown failure is indeterminate by default and becomes `recovery-required`; it is never silently replayable.
10. If the completion checkpoint fails after an effect may have committed, reload normalizes the durable execution intent to `recovery-required`.
11. Checkpoint source authority includes the owning subsystem's source fingerprint. Smart Warm incorporates chat scope, active Tree books/lore revision, Smart Context policy, and operator/active pins. Housekeeper incorporates chat scope, active Tree books/lore revision, Memory Bank revision, and Housekeeper policy.
12. Complete execution checkpoints for Smart Warm/Housekeeper are keyed by stable caller + owner source authority and therefore survive reload without replay. The runtime session ID is diagnostic metadata only and is not part of completion identity. Same-source indeterminate checkpoints also block replay until recovery is resolved.
13. Generic execution checkpoints are allow-listed only for Smart Warm/Housekeeper maintenance work.

## Coverage boundary

Execution completion is NOT narrative coverage.

Summary, Summary promotion, Lore routing, Notebook, Post-turn, proposal settlement, and canonical mutations are not allowed to use the generic execution-completed checkpoint as coverage authority.

Existing Memory Bank/Lore digest durability remains authoritative:
- `coverageReceipts`
- `preserveCoverage`
- `restoreMemoryCoverageFromRecord`
- `reconcileDigestedSummaryCoverage`
- canonical digest-settlement proof before delete-after-digest cleanup

This deliberately prevents a finished physical job from falsely closing a Summary backlog or proving deleted narrative coverage.

## Implementation

Changed/added runtime files:

- `nexus/continuable-work.js`
- `lifecycle/execution-leases.js`
- `lifecycle/execution-guard.js`
- `lifecycle/scheduler.js`
- `nexus/lifecycle-bridge.js`

Added regression contracts:

- `tests/task202-continuable-work.mjs`
- `tests/task203-lifecycle-execution-leases.mjs`
- `tests/task202-203-lifecycle-contract.mjs`

Scheduler changes:
- removed the single-cycle execution mutex as physical ownership authority;
- tracks multiple logical cycles separately;
- exposes physical lease occupancy separately in scheduler state/telemetry;
- removed the obsolete all-or-nothing `pendingAutomaticCycle` catch-up queue;
- Smart Warm/Housekeeper use checkpointed execution;
- Summary/Promotion/Lore routing remain under Memory Bank coverage/transaction authority and only use physical conflict serialization.

Director bridge changes:
- removed the generic `completedWorkMemo` that could suppress Summary/coverage-owned work;
- Smart Warm/Maintenance use checkpointed execution;
- all other migrated workloads use physical conflict leases only;
- bridge reset logically invalidates its physical leases without releasing them early.

## Commits

- `5421db1d1e1b8a246861c96482627e22955ac03a` — feat(lifecycle): harden resumable execution ownership (#202 #203)
- `02bcf90d1a62db5658a7c42a179b9e4d92d4840b` — refactor(lifecycle): remove obsolete cycle catch-up mutex
- `22b492ba52f1bc178a8581c3d5db6721ed3b8879` — fix(lifecycle): keep completed execution checkpoints reload-stable (#202 #203)

## Validation completed

PASS:
- branch-exact #202 ContinuableWork hydration/resume without completed-unit replay;
- pre-execution checkpoint failure blocks executor start;
- post-effect checkpoint failure produces recovery-required;
- unknown post-execution failure is indeterminate/recovery-required;
- branch-exact #203 duplicate-work single-owner behavior;
- completed execution checkpoint identity is stable across reload and cannot be split by a runtime-session ID;
- logical invalidation retains the live physical lease;
- conflicting replacement waits until old physical owner settles;
- unrelated target concurrency;
- syntax validation for all five changed runtime modules;
- parse validation for all three new tests;
- static #202/#203 integration contract;
- Summary/Digest coverage boundary contract;
- committed Lore digest cleanup policy still requires committed parent + approved child proposals;
- changed-file relative imports resolve to existing repository paths.

GitHub reported no automatic CI status contexts for the branch commit because the existing release workflow does not run on `Development-New-Features`.

## Still requires live acceptance before merge/release

Do not mark the work fully live-accepted from source/offline evidence alone.

Required live checks:
- foreground generation while Smart Warm is active;
- foreground generation while Housekeeper/model work is active;
- logical cycle invalidation while physical work is visibly still draining;
- same-target replacement waits, unrelated task proceeds;
- A/B Sidecar topology;
- Main-only topology;
- reload with a deliberately persisted execution-intent/recovery-required checkpoint;
- checkpoint persistence failure/fallback path;
- verify Summary backlog/digest-delete coverage is unchanged in live use;
- diagnostics show logical cycles separately from physical lease occupancy.

No live SillyTavern acceptance or package/release claim is made by this checkpoint.
