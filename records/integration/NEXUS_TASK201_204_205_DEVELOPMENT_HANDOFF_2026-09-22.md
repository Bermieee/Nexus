# Nexus Tasks #201, #204, #205 — Development Handoff

Date: 2026-09-22
Workspace: `Bermieee/Development` → lowercase `development` branch
Promotion target: Nexus main after integration/live acceptance
Scope: performance/duplication only; no mutation-authority, retrieval-quality, Smart Context policy, or worker-authority redesign.

## Non-negotiable fences preserved

- Narrative/context quality remains authoritative over latency.
- No proposal/Ledger/transaction/PlanStore bypass was added.
- No worker gained canonical mutation authority.
- No Jev result gained authority outside its existing decision contract.
- Smart Context behavior was not changed.
- Stale-source checks remain mandatory before Housekeeper advice can be treated as current.
- Telemetry persistence is observational only; storage failure never alters the live telemetry ring or any runtime decision path.

## #201 — Housekeeper canonical early reuse

Implemented:

- Added an early Housekeeper source signature before Memory scanning, Jev assists, merge similarity, or Sidecar review.
- Reuse requires exact agreement on:
  - target lorebooks,
  - canonical lore/Tree source revision,
  - Memory Bank evidence revision,
  - deterministic Housekeeper audit thresholds.
- Removed finding-fingerprint-only advice reuse as an authority path.
- Manual/force scans always bypass early reuse.
- Added canonical read telemetry (`lore`, `tree`, `memory`) and explicit early-reuse hit/miss telemetry.
- Housekeeper now loads each target lorebook and Tree once and passes those already-loaded sources into merge-similarity scanning.
- Lore corpus discovery uses cheap `hasTree()` filtering instead of loading Trees during eligibility discovery.
- Tree writes now advance the canonical lore/Tree source revision for every Tree mutation kind, including `summary-only`.
- Native SillyTavern `WORLDINFO_UPDATED` and `WORLDINFO_SETTINGS_UPDATED` events now advance the broad lore-source revision.
- A canonical source revision change during deterministic/Jev work or Sidecar review marks the run stale and prevents current advice publication.

Files:

- `maintenance/housekeeper.js`
- `tools/merge.js`
- `tree/store.js`
- `index.js`
- `memory/store.js`
- `tests/task201-housekeeper-reuse.mjs`

## #204 — Long-session incremental bookkeeping

Implemented:

- Added `lifecycle/cadence-counter.js`.
- Lifecycle cadence now stores assistant-turn count, message count, structure epoch, and counter revision.
- Normal append checks inspect only the appended delta.
- Message edit/swipe/delete invalidates the counter; structural epoch change forces a truthful full rebase.
- Existing cadence due/elapsed/remaining semantics are unchanged.
- Memory Bank now maintains an `evidenceRevision`.
- Memory health/coverage/validity is computed into one revision-scoped inspection index and reused by:
  - validity report,
  - effective summarized-through calculation,
  - Memory stats,
  - Housekeeper Memory scan.
- Plain append can reuse the Memory inspection index when all referenced Memory source ranges end inside the previously inspected prefix.
- Structural chat changes or Memory evidence mutations invalidate the index.
- Non-evidence metadata writes such as lifecycle cycle ID and route-evaluation receipts do not invalidate the health index.

Files:

- `lifecycle/cadence-counter.js`
- `lifecycle/scheduler.js`
- `index.js`
- `memory/store.js`
- `tests/task204-long-session-bookkeeping.mjs`

## #205 — Bounded incremental telemetry persistence

Implemented:

- Replaced 250 ms whole-ring sessionStorage serialization with fixed event chunks of at most 64 events.
- The hot path writes only dirty chunks plus compact sidecar/metrics/latest state.
- Evicted chunks are not rewritten and older persisted chunks are pruned.
- Full-ring checkpoint serialization is reserved for explicit diagnostic export or `pagehide`.
- Existing portable diagnostic export version remains `tv2-telemetry-v1`; the persistence implementation is internal.
- `capturePayloads:false` strips top-level payload fields before recursive sanitization.
- Restore reconstructs the same visible bounded event ring and compact diagnostic state.
- Persistence/quota failure does not trim or otherwise mutate the live event ring.

Files:

- `observability/telemetry.js`
- `tests/task205-telemetry-persistence.mjs`

## Validation performed on committed lowercase-development bytes

### Syntax / module-shape

Direct V8 compile checks passed for all changed source files:

- `lifecycle/cadence-counter.js`
- `lifecycle/scheduler.js`
- `memory/store.js`
- `maintenance/housekeeper.js`
- `tools/merge.js`
- `tree/store.js`
- `observability/telemetry.js`
- `index.js`

The three new task tests also compile; `import.meta` was replaced only in the external validation wrapper because V8 Function compilation is not a module loader.

### #201 contract probe

PASS:

- canonical lore/Tree + Memory revision signature present,
- early reuse gate executes before Memory scan,
- finding-fingerprint-only reuse removed,
- preloaded book/Tree state reaches merge scan,
- no run-level freshness reload of the same books/Trees,
- Tree revision advances for all Tree writes,
- native World Info events advance lore revision,
- force scan bypasses reuse.

### #204 5,000-turn cadence probe

Synthetic 5,000 assistant-turn / 10,000-message history:

- initial rebase: 10,000 messages inspected,
- one assistant append: 1 message inspected,
- unchanged follow-up cadence check: 0 messages inspected,
- structural epoch change: truthful 10,001-message rebase,
- assistant-turn count remained identical to a full scan.

Memory inspection probe:

- first scan: cache miss,
- repeated unchanged scan: cache hit,
- append beyond all referenced Memory ranges: cache hit,
- structural epoch change: cache miss,
- Memory evidence mutation: cache miss,
- evidence revision stayed stable across plain append and lifecycle-cycle metadata,
- evidence revision changed on structural epoch or Memory evidence mutation.

### #205 persistence/restore probe

With `maxEvents=128`, 300 generated telemetry events, and payload capture disabled:

- visible ring: 128 events,
- payload field dropped before persistence,
- persisted event chunks: 3,
- largest persisted chunk: 64 events,
- legacy whole-ring hot key: absent,
- hot-path full checkpoint: absent,
- explicit export checkpoint: present,
- export schema marker: `tv2-telemetry-v1`,
- restored event IDs: exact match,
- restored metrics: exact match,
- restored latest diagnostic state: exact match.

### Existing performance-contract spot check

PASS for unchanged contracts covering:

- read-only Activity Feed telemetry snapshot,
- metadata-only snapshot path,
- scheduler full diagnostic state API,
- scheduler compact status API.

## Validation still required before closing/promoting

The repository contains `.github/workflows/task201-204-205-validation.yml` scoped to lowercase `development`, but no GitHub Actions run was surfaced through the connected GitHub API during this work session.

Do not mark the tasks fully release-green until live SillyTavern acceptance verifies:

1. unchanged automatic Housekeeper runs show early-reuse hits with zero semantic Jev/Sidecar work and zero book/Tree reads;
2. a lore edit, Tree summary/routing edit, Memory mutation, or structural chat edit deterministically invalidates reuse;
3. 5,000-turn live/representative cadence and Memory-maintenance telemetry stays bounded while due/remaining decisions match baseline;
4. telemetry-heavy live use restores/export diagnostics correctly and persistence failure cannot affect runtime work;
5. Main prompt/context relevance and downstream narrative behavior are not diluted versus the pre-change baseline.
