# Nexus Chat Handoff — HOTFIX46 Optimization Trio

**Date:** 2026-09-15  
**Purpose:** Transfer the three newly proposed performance systems into a fresh chat without losing architecture intent or current baseline truth.

## 1. Authoritative baseline

Start from:

- `Nexus-0.6.5-DEVELOPER-HOTFIX45.zip`
- SHA-256: `9070e2dd92424bde09a82e3263144d627fc85b6e406f4b01ae59bd97d8881df8`
- Runtime version: `0.6.5`
- Current HOTFIX45 status: **offline/source green; live SillyTavern acceptance still separate**.

HOTFIX45 must remain intact, especially:

- range-scoped Post-turn recovery quarantine;
- evidence-change retry fencing;
- cancellation truth / intentional foreground deadline degradation;
- Summary-to-Lore durability recovery;
- HOTFIX43 single foreground authority;
- operator-authoritative Sidecar B;
- Generation Frame / Prompt Composer ownership;
- canonical mutation / Ledger ownership;
- Builder review/defer hardening;
- existing paging / Change Gate behavior.

### Critical correction about the interrupted HOTFIX46 attempt

A work directory exists at `/mnt/data/hf46_work/Nexus`, but verification against a fresh extraction of Developer HOTFIX45 found:

- **634 files vs 634 files**
- **0 modified files**
- **0 new files**
- **0 missing files**

Therefore **none of the three optimization systems below have actually been applied to source yet**. A prior chat update described an implementation as if it had already landed; that was inaccurate. Treat HOTFIX46 as **design-approved / implementation-not-started**.

Do not infer completion from the directory name `hf46_work`.

---

# 2. Optimization System A — Fractional / Progressive Lifecycle Work

## User intent

Do **not** make every lifecycle job span generations. Target only the **bulk** portions of expensive maintenance work.

The idea is to break a large workload into small fractions that one Sidecar can process quickly and almost invisibly across normal story use.

Example:

- bulk task has 24 units;
- generation opportunity 1 processes units 1–4;
- next opportunity processes 5–8;
- continue until complete;
- final semantic validation / mutation happens only when the owning subsystem's completion contract is satisfied.

There are no fake chat turns and no synthetic `12.5` message identity. "Micro-turn" is only the mental model.

## Architectural contract

- Owning subsystem retains semantics and completion authority.
- Work Director/Bus only schedules the next eligible fraction.
- Sidecar executes the assigned fraction; it does not own continuation semantics.
- Canonical mutation remains atomic/fail-closed where the subsystem requires it.
- Partial computation may be checkpointed; partial durable truth must **not** be invented.
- One Sidecar must be sufficient for eventual completion.
- Main/SC-B may accelerate throughput, but correctness cannot depend on them.
- Foreground RP always retains priority.

## Best first candidates

Prefer naturally sliceable background/bulk work:

- vector indexing / embedding preparation;
- Builder semantic slices;
- UID / historical summarization;
- compression work;
- Housekeeper scans;
- lore warm/cool maintenance;
- bounded Post-turn semantic enrichment where exact source authority can be captured first.

Do **not** fraction work that must be complete for the current prompt, such as:

- current-turn Change Gate decision;
- current prompt retrieval required before Main generation;
- Generation Frame seal;
- any mutation that cannot safely remain pending.

## Required progress state

Each continuable bulk workload should have durable or reconstructible state equivalent to:

- stable work ID;
- owner subsystem;
- source refs / source range;
- source revision or fingerprint;
- progress cursor / completed unit IDs;
- remaining units;
- completion state;
- freshness policy;
- cancellation / invalidation state.

Before each continuation slice, the **owning subsystem** decides whether its source remains valid.

## Backlog-pressure requirement

Fractional work must not accumulate forever.

Track at minimum:

- incoming work rate;
- completion rate;
- backlog depth / age;
- oldest pending work;
- available workers.

If backlog grows, increase slice opportunity / use optional capacity without changing correctness semantics.

---

# 3. Optimization System B — Change Gate Reuse / Workload Calculation

## User intent

`NO_CHANGE` is already nearly instant. `MINOR_CHANGE` and `MAJOR_CHANGE` can be slower because more downstream work is triggered.

The requested improvement is to stop equating **semantic magnitude** with **100% context invalidation**.

A scene may legitimately be `MAJOR_CHANGE` while still retaining, for example, ~60% reusable context.

Example:

- location changes;
- same lead characters remain;
- same active objective continues;
- relationship / identity / persistent pins remain valid;
- only regional/location/nearby-entity material needs substantial refresh.

`MAJOR_CHANGE` should describe the scene transition, not automatically mean "recompute everything."

## Ownership boundary

Scene Scanner may report observations such as:

- location changed / stable;
- time boundary changed / stable;
- same/departed/new characters;
- objective continuity;
- topic continuity;
- scene-entity deltas.

Scene Scanner **does not own** "60% of prompt context is reusable."

Each context-owning subsystem determines which of its own material retains authority.

Change Gate may aggregate the result into a **change/work plan**, but must not become a second semantic owner for Memory, Smart Context, Lore, Notebook, etc.

## Desired output shape

Keep the existing semantic class:

- `NO_CHANGE`
- `MINOR_CHANGE`
- `MAJOR_CHANGE`

Add a separate execution/reuse description, conceptually:

- reusable refs / tokens / domains;
- dirty refs / tokens / domains;
- full-refresh-required domains;
- targeted-refresh domains;
- estimated work units;
- optional expected latency / call count.

Example concept only:

```text
semanticClass: MAJOR_CHANGE
reuseRatio: 0.60
preserve: identity, relationships, active objective, persistent pins
refresh: location, regional lore, nearby entities, 2 memory refs
estimatedDirtyUnits: 8
```

## Important safety rule

Reuse must be **authority based**, not similarity based.

Do not retain prior context merely because it looks semantically similar. Reuse requires current-generation authorization/freshness for the owning outlet/ref.

Existing Generation Frame / Prompt Composer ownership and fingerprint/revision fencing should be reused rather than bypassed.

## Escalation behavior

A targeted refresh may begin from a high reuse estimate, but if downstream coverage/freshness checks show that preserved authority is insufficient, it must be able to escalate to broader/full refresh fail-closed.

No optimization may suppress required context.

---

# 4. Optimization System C — Adaptive Throughput Batch Calculation

## User intent

Current/fixed batch sizing can be suboptimal.

If Nexus chooses 10 items per call, perhaps two 5-item calls actually complete faster and more reliably than one 10-item call. Conversely, if 10 is measurably more efficient, Nexus should use 10.

The target is **fastest reliable workload completion**, not fewest calls and not largest batch.

## Core metric

Learn measured throughput per physical execution profile:

- reliable successful items / second;
- call latency;
- p50/p90 or rolling latency;
- timeout rate;
- semantic/schema failure rate;
- input/output token size;
- latency variance;
- provider/model/worker identity;
- workload type / contract version.

Recommended profile key should be close to:

`workloadType + provider/profile + model + physical worker/lane + semantic contract version`

Do **not** store one global `SC-A batchSize` because different workload types have different optimal batch shapes.

## Example

Measured:

- 5 items -> 3.5 s -> ~1.43 items/s
- 10 items -> 9.0 s -> ~1.11 items/s

For that workload/profile, Nexus should prefer 5 even though it requires more calls.

## Control behavior

Prefer conservative adaptive control:

- grow slowly after repeated healthy completions;
- shrink faster on latency degradation;
- shrink aggressively on timeout / truncation / repeated failure;
- bound min/max batch size;
- use rolling windows so one outlier does not thrash the controller;
- keep exploration small and bounded;
- never let batching policy change semantic coverage or validation rules.

Conceptual behavior:

```text
4 -> 5 -> 6 -> 7  (healthy exploration)
7 performs badly
7 -> 5            (fast reduction)
5 -> 6 -> 7       (slow recovery)
```

## Deadline/backlog interaction

Batch calculation should eventually consider:

- remaining foreground deadline/budget;
- backlog pressure;
- available lane count;
- worker-specific latency;
- recent reliability.

Example:

- active RP / tight budget -> smaller quick slice;
- idle window -> larger batch if measured throughput remains favorable;
- SC-A fast, SC-B slow -> different batch sizes for the same owning subsystem;
- only one Sidecar available -> still completes correctly, merely at lower throughput.

---

# 5. How the three systems should work together

The intended optimization chain is:

1. **Change Gate** decides semantic change class.
2. Context owners determine what prior material remains authorized/reusable.
3. Nexus calculates the **actual dirty workload**, not the theoretical whole-scene workload.
4. Bulk dirty work is represented as progress-capable fractions where safe.
5. Adaptive batching sizes each physical call using measured throughput/reliability.
6. Work Director schedules fractions across whatever capacity exists.
7. Sidecars execute transport/model calls only.
8. Owning subsystem validates completion.
9. Mutation/Ledger path remains canonical and unchanged.

In short:

**semantic change != recompute percentage != physical batch size**

Those should become three separate decisions.

---

# 6. Suggested implementation order for the next chat

## Phase 1 — Baseline and branch/worktree verification

1. Fresh-extract Developer HOTFIX45.
2. Reconfirm package SHA-256.
3. Run HOTFIX45 focused regression before edits.
4. Create a dedicated HOTFIX46 worktree/branch/package identity.
5. Do not use the current `/mnt/data/hf46_work/Nexus` as evidence of completed changes; it is byte-identical to HF45.

## Phase 2 — Instrument before adapting

Implement read-only measurement first:

- per workload/profile call duration;
- item count;
- input/output tokens if available;
- timeout/failure classification;
- successful-item throughput;
- rolling profile diagnostics.

No batch-size changes yet.

Prove telemetry is bounded and does not expose prompt content.

## Phase 3 — Adaptive batch policy

Use the measured history to recommend physical slice size.

Start with one well-bounded workload such as Builder semantic slices, because Builder already has explicit slice identity/recovery contracts.

Add tests proving at least:

- 5-item profile can beat 10-item profile;
- timeout shrinks next recommendation;
- healthy history grows only gradually;
- SC-A and SC-B may receive different sizes;
- missing history falls back to current safe defaults;
- semantic coverage remains exact.

## Phase 4 — Fractional lifecycle work

Choose one safe background workload first rather than making the entire lifecycle continuable at once.

Recommended first pilot:

- Builder large-run semantic queue **or** vector indexing/maintenance,

because both are naturally divisible and do not require current prompt completion.

Prove:

- one Sidecar eventually completes the whole task;
- progress survives normal generation boundaries;
- foreground arrival does not lose completed work;
- stale source cancels/replans safely;
- backlog cannot silently disappear;
- optional second capacity accelerates but is not required.

## Phase 5 — Change Gate reuse planning

Add continuity/work-plan data without changing semantic classification first.

Then selectively allow one existing outlet/path to preserve authorized refs across MINOR/MAJOR transitions.

Suggested first proof:

- genuine MAJOR location transition;
- same characters/objective remain;
- persistent character/relationship refs retain authority;
- location/regional refs are invalidated;
- downstream coverage can still force full refresh.

## Phase 6 — Combined tests

Required combined scenarios:

1. `NO_CHANGE` remains near-zero extra work.
2. `MINOR_CHANGE` with 80% reuse refreshes only dirty subset.
3. `MAJOR_CHANGE` with ~60% reusable authority does not automatically full-rebuild.
4. `MAJOR_CHANGE` with low/no valid reuse escalates to full refresh.
5. Single Sidecar processes fractional dirty work over multiple opportunities.
6. Adaptive batch size converges differently for fast and slow lanes.
7. Timeout shrinks the offending lane's physical batch without changing task correctness.
8. Foreground generation preempts/yields correctly.
9. No late/stale fraction may publish to a retired Generation Frame.
10. No optimization bypasses mutation/Ledger ownership.

---

# 7. Files/subsystems likely relevant

Inspect before editing; do not assume exact responsibility until tracing current call paths.

Likely areas:

- `retrieval/change-gate.js`
- `retrieval/execution-plan.js`
- `retrieval/retriever.js`
- `scene/scanner.js`
- `scene/runtime.js`
- `nexus/generation-frame.js`
- `nexus/generation-frame-outlets.js`
- `nexus/work-director.js`
- `nexus/work-coordinator.js`
- `nexus/batch-layer.js`
- `nexus/batch-planner.js`
- `nexus/model-worker-bus.js`
- `sidecar/router.js`
- `sidecar/batch-pool.js`
- `builder/sidecar-executor.js`
- `builder2/semantic-packing.js`
- `postturn/pipeline.js`
- `lifecycle/scheduler.js`
- `paging/*`
- `maintenance/*`
- `observability/telemetry.js`

Preserve current tests for HOTFIX43–45, Builder, Sidecar symmetry/re-entry, vector paging, and canonical mutation behavior.

---

# 8. Acceptance / promotion rule

Developer first.

Do not promote to Demo until:

- focused HOTFIX46 tests pass;
- HOTFIX43/44/45 regressions remain green;
- full Builder suite passes;
- `npm run test:smoke` passes;
- vector-paging suite passes;
- syntax/module-load/import checks pass;
- clean package extraction matches tested source;
- changed shared runtime files are identified and hashed.

After Developer is sealed, promote only the validated shared runtime delta into the current Demo line and repeat Demo package/extract validation.

**Do not call HOTFIX46 live accepted until it is exercised in SillyTavern.**

---

# 9. Current handoff status

**Baseline:** Developer HOTFIX45  
**HOTFIX46:** DESIGN READY / SOURCE NOT MODIFIED  
**Three requested systems:**

1. Fractional / progressive bulk lifecycle work — **not implemented**
2. Change Gate reuse/workload calculation — **not implemented**
3. Adaptive throughput batch calculation — **not implemented**

The next chat can start implementation immediately from this checkpoint without needing to reconstruct the design discussion.
