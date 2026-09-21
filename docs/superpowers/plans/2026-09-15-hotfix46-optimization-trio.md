# HOTFIX46 Optimization Trio Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement authority-based selective Change Gate reuse, adaptive throughput batch sizing, and resumable fractional bulk lifecycle work on Developer HOTFIX45 without weakening semantic validation or canonical mutation contracts.

**Architecture:** Preserve semantic ownership in each subsystem. Add bounded execution-policy helpers that consume owner-provided authority/freshness evidence; let physical batching adapt only request geometry; let continuable workloads checkpoint computation while final publication remains atomic.

**Tech Stack:** JavaScript ES modules, Node offline regression tests, SillyTavern extension runtime.

**Spec:** `docs/superpowers/specs/2026-09-15-hotfix46-optimization-trio-design.md`

## Global Constraints

- Baseline ZIP SHA-256 is `9070e2dd92424bde09a82e3263144d627fc85b6e406f4b01ae59bd97d8881df8`.
- Preserve HOTFIX43/44/45 behavior and all canonical mutation/Ledger ownership.
- One Sidecar must remain sufficient for eventual completion.
- Foreground RP always retains priority.
- Reuse is authority/freshness based, never similarity-only.
- Partial computation may checkpoint; partial canonical truth may not publish.
- Adaptive batching may alter physical request geometry only, never semantic coverage.

---

### Task 1: Throughput telemetry and adaptive policy

**Files:**
- Create: `nexus/adaptive-throughput.js`
- Modify: `nexus/batch-layer.js`
- Modify: `builder2/nexus-semantic.js`
- Test: `tests/nexus-065-hotfix46-adaptive-throughput-regression.mjs`

**Interfaces:**
- Consumes: workload type, provider/model/physical lane identity, logical item count, elapsed time, outcome classification.
- Produces: `recordThroughputSample()`, `recommendAdaptiveBatchSize()`, `getThroughputProfileSnapshot()`.

- [ ] Write failing regression proving 5-item history can outperform 10-item history, timeout shrinks recommendation, healthy growth is gradual, physical lanes learn independently, and no-history falls back safely.
- [ ] Run regression and confirm RED.
- [ ] Implement bounded rolling profile store and conservative controller.
- [ ] Wire Batch Layer physical results into measurement without prompt-content telemetry.
- [ ] Apply the recommendation to Builder physical multiplex member count only; preserve logical slice coverage.
- [ ] Run focused and Builder regressions.

### Task 2: Continuable lifecycle workload primitive

**Files:**
- Create: `nexus/continuable-work.js`
- Modify: `nexus/work-director.js`
- Test: `tests/nexus-065-hotfix46-continuable-lifecycle-regression.mjs`

**Interfaces:**
- Consumes: stable work ID, owner, source proof, ordered unit IDs, owner freshness callback, execution opportunity.
- Produces: resumable progress snapshots and terminal `complete/stale/cancelled/superseded` states without publishing semantic result.

- [ ] Write failing regression for multi-opportunity completion, foreground yield, stale-source invalidation, single-worker eventual completion, and no partial publication.
- [ ] Run regression and confirm RED.
- [ ] Implement progress/checkpoint state and owner-controlled continuation.
- [ ] Add Work Director helper for bounded execution opportunities without moving semantic authority into Director.
- [ ] Run focused regressions.

### Task 3: Change Gate authority-reuse work plan

**Files:**
- Create: `retrieval/reuse-plan.js`
- Modify: `retrieval/execution-plan.js`
- Modify: `retrieval/retriever.js`
- Test: `tests/nexus-065-hotfix46-change-gate-reuse-regression.mjs`

**Interfaces:**
- Consumes: existing semantic gate, Scene Scanner deltas, prior region/node/injection refs, owner-authorized reusable refs/domains.
- Produces: execution-only reuse/workload plan containing preserve/refresh domains, reuse ratio, dirty units, targeted/full escalation policy.

- [ ] Write failing regression: NO_CHANGE remains cheap; MINOR 80% reuse targets dirty subset; MAJOR ~60% authority can target refresh; low/no valid reuse escalates full.
- [ ] Run regression and confirm RED.
- [ ] Implement authority-based reuse plan helper.
- [ ] Extend retrieval execution planning to accept owner-authorized regional reuse for MAJOR without changing the semantic class.
- [ ] Wire Retrieval to generate conservative owner-authorized evidence from existing validated state + Scene Scanner delta, and fail closed when coverage is insufficient.
- [ ] Run focused Change Gate/retrieval regressions.

### Task 4: Combined verification and package

**Files:**
- Create: `tests/nexus-065-hotfix46-optimization-trio-regression.mjs`
- Create: `NEXUS_DEVELOPER_HOTFIX46_OPTIMIZATION_TRIO_CHECKPOINT.md`
- Create: `HOTFIX46_CHANGED_FILES.tsv`

- [ ] Add combined regression for independent semantic class/recompute percentage/physical batch size decisions.
- [ ] Run HOTFIX43/44/45 regressions.
- [ ] Run HOTFIX46 focused regressions.
- [ ] Run `npm run test:builder`.
- [ ] Run `npm run test:smoke`.
- [ ] Run `npm run test:vector-paging`.
- [ ] Run syntax/module-load/import checks.
- [ ] Produce Developer HOTFIX46 ZIP from the green tree and validate clean extraction byte-equivalence.
- [ ] Record changed shared-runtime hashes and package SHA-256.
- [ ] Do not label live accepted; SillyTavern live acceptance remains separate.
