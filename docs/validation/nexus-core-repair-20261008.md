# Nexus core repair — 2026-10-08

## Scope and authority

This batch starts from `main@5e93d2d3d413cbc28d8ef042c3d8f49e619b224a`. The user authorized fixing the verified concerns after the architecture audit and review of Claude's older findings. Work uses the existing checkout, canonical World Tree, coordinator, bank adapters, scheduler, router and ephemeral owners. No new branch, checkout, provider call, installed-extension change, live story mutation or configuration workaround was used.

## Repaired behavior

| Area | Before | Result |
| --- | --- | --- |
| Memory durability (audit A1) | Migrated bank wrappers guarded the retired `tv2_memory_bank` key; a failed save could leave and persist the rejected canonical memory | Create, revise, rollback, delete, permanence, protection, lock, coverage and route-assessment wrappers protect the canonical chat snapshot, await verified host persistence and restore the same story's live owner on safe rollback |
| Lore route settlement (A1) | Parent/no-op/recovery wrote the retired bank and could fail expected-state checks | Existing canonical coordinator receives a previewed World Tree snapshot and its exact expected pre-image; after committed persistence, the originating chat owner is hydrated. Saga and child settlement fences remain |
| Character durability (A2) | `updateCharacterBankDurably` returned after requesting a debounced save | It awaits the existing verified metadata barrier and announces success afterward; failed saves restore canonical Character State or report indeterminate rollback |
| Snapshot reporting (A2) | A debounced save request was reported as persisted | Snapshot helper reports `snapshotUpdated`/`saveRequested` and `persisted:false`; synchronous and asynchronous save-request errors are logged. Verified operations use the separate barrier |
| Owner replacement (A4) | Equal numeric revisions could reuse a facade from an old owner | Memory and Character facade/read caches require exact owner identity as well as their existing revision keys |
| Reduced worker setups (Claude 1) | Individual scheduled work could reserve disabled A/B; permitted Main-only scheduled work failed | Scheduler admission uses the router's configured/eligible slots. A-only background work can use A. Main-only jobs use the existing Main gateway only when caller and operator policy permit it. Unavailable physical workers use the existing retryable error type |
| Scene gate (Claude 2) | Preflight advice could replace a fresh measured change | Advice classifies an explicitly reused observation only; a fresh scan retains Change Gate authority |
| Green Room (Claude 3) | The next MINOR revision discarded accepted inference before its TTL | Explicit same-scene revision advances retain accepted inference under the original TTL and invalidation rules. Pending publication remains fenced to the exact requested revision |
| Scene continuity (Claude 4–5) | Similar numbered locations collapsed; blank fields never cleared; one participant omission caused a cut | Distinct numeric/directional markers prevent false location equivalence. Continuing scenes preserve omitted established cast; explicit departures and field clearing require citations present in new narrative evidence |
| Observation conflict (Claude 7) | Key order, extra fields and differing confidence manufactured arbitration work | Shared supported values are compared semantically. Ordering, extra containment and unknown fields do not manufacture a conflict; genuine location/presence contradictions still do |
| Repairable scanner output (Claude 9) | A character duplicated as present and discussed discarded the whole scan | Exact duplicate references are removed while physical presence remains authoritative; normalization is reported. Other schema validation remains strict |
| Reduced extraction (Claude 10, partial) | “Takes a deep breath” produced an object | Generic “takes” and common nonphysical idioms are excluded; obvious preposition tails are trimmed. This remains a disclosed English-oriented reduced extractor |

The bank barrier captures owner pre/post-images inside the existing serialized metadata operation. It rejects owner/binding/chat changes, restores only the originating chat, and refuses rollback after newer same-story data appears. An unrelated story's revision does not authorize replacing that story. This adds no second bank store or alternate Lore writer.

Non-collected sidecar dispatch now carries `schedulerJobId` into physical telemetry. This is a partial attribution repair, not closure of the entire logical-job/physical-call/selected-turn evidence join.

## Verification

All **126 standalone test files pass** using `node --experimental-vm-modules`, including the existing integration harness. Host, provider and persistence boundaries are simulated; production owner, intake, bank, scheduler, router, batch, Scene, Green Room and delivery modules run in the relevant tests.

All 642 JavaScript/module files pass `node --check`; the diff whitespace check is clean.

- `world-tree-bank-durability.mjs`: failed save rollback for Memory and Character State, verified success, rollback failure, canonical route preview, replacement-owner cache, binding switch, unrelated-story preservation and newer same-story divergence.
- `scene-authority-regressions.mjs`: numbered moves, stale advice, omitted versus explicitly departing cast, grounded clearing, duplicate-reference repair, genuine contradictions and equivalent evidence.
- `scheduler-batching.mjs`: A-only/B-only individual work, permitted and forbidden Main-only work, A-only background work; existing dynamic A/B refill, batching, loan, abort, failure recovery and sealed delivery checks remain passing.
- `a52-green-room-full.mjs` and `ephemeral-working-state.mjs`: same-scene continuity, strict legacy revision behavior, TTL/departure/correction/source invalidation, scene replacement and stale pending-result rejection.
- `scene-memory-freshness.mjs`: equivalent observation paths avoid false Jev arbitration; idiomatic breathing does not become an object.

Two existing source-transform fixtures were extended to stub the newly consulted bus capability boundary and to specify disabled Main policy explicitly. Their routing and delivery assertions remain. No tests were removed or skipped.

The initial full run found those two fixture failures. After repairing the fixtures and completing the owner-freshness checks, a fresh full run passed 126/126. The local full output is `C:/Users/cacon/AppData/Local/Temp/nexus-repair-final-suite-20261008.log`.

## Remaining work

- Audit A3/A5: validate imported chat scopes/collisions and preserve identity metadata through chat snapshot restore. A4 alone does not close restoration correctness.
- Audit A6/A7/A8: repeated full-snapshot/save costs, exact selected-turn attribution/live-Lore revision consistency, and measured whole-extension/live acceptance.
- Claude 6/8: capture actual failing post-turn observation payloads before extending normalization; establish physically supported objects/parent location without promoting reference-only items into presence. No blanket `DEGRADED` suppression or provider retry increase was added.
- Lore Study integration and the deferred chat-versus-canon producer/campaign-time work remain product gaps; no status flag or model access was enabled to disguise them.
- Complete worker/Scatter/Gather attribution, Main provider cache reporting and Sensory channel deadline fairness still need their own reproductions and checks. Compatibility naming and dense-file cleanup remain separate maintenance work.
- Live new-story and large established-story checks, provider execution, reload/crash recovery and a representative multi-turn run remain outstanding. Offline passing tests are not live completion evidence.
