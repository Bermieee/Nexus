# Nexus Task #198 — Smart Context Jev Warm Admission

**Integration target:** `Bermieee/Nexus` → `Development`  
**Workspace source:** `Bermieee/Development` → `development`  
**Date:** 2026-09-22

## Summary

Task #198 promotes the existing Smart Context Jev Decision Core review from shadow-only observation into the normal bounded predictive warm-admission path.

The optimization removes duplicate semantic ranking when Jev has already produced a fresh, valid typed decision, while preserving Nexus's core Smart Context behavior: **warming remains a moving predictive frontier, not a cumulative list and not merely a set of obvious/current cards.**

This quality rule is non-negotiable. Jev is allowed to reduce duplicated judgment; it is not allowed to reduce the narrative usefulness or diversity of the context delivered to Main.

## Previous behavior

Smart Context previously:

1. built a deterministic warm candidate pool;
2. launched Jev as a shadow review;
3. ignored the Jev result operationally;
4. ran the Sidecar warm reranker over substantially the same evidence.

This meant Decision Core could observe the decision but could not save the duplicate semantic model pass.

## New behavior

### 1. Jev is authoritative only for bounded predictive admission

The Smart Context decision site now runs in Decision Core Assist mode for this exact contract.

Jev may:

- score/re-rank the already-nominated predictive candidate window;
- decide bounded predictive breadth;
- identify current-scene continuity among those predictive candidates;
- admit/prune only within that bounded predictive set.

Jev may **not**:

- discover arbitrary new lore;
- mutate lore, memory, pins, Character State, or canonical state;
- override Scene Scanner or Change Gate;
- bypass Lore Injection or any mutation/publication protocol;
- prune manual pins, active continuity pins, Character Bank continuity, or existing earned pins.

### 2. Successful Jev handling skips duplicate Sidecar ranking

When the Jev result is:

- fresh;
- valid typed Decision Core output;
- sufficiently decisive;
- produced for the current Smart Context / scene / Change Gate fingerprint;

Smart Context consumes that bounded admission result directly and **does not run the redundant Sidecar warm reranker for the same decision**.

### 3. Failure remains fail-open

The pre-existing Sidecar reranker remains the safe worker path.

Smart Context falls back to Sidecar when Jev is:

- disabled or unavailable;
- stale;
- malformed;
- non-typed / non-Jev fallback output;
- low confidence or semantically ambiguous;
- otherwise unable to satisfy the contract.

The optimization therefore removes duplicate work only when Decision Core actually owns a valid decision.

### 4. Moving-frontier quality fence

The selection contract now evaluates three independent concerns:

- candidate relevance;
- **current-scene / current-place value**;
- **next-beat predictive value**.

A separate typed warm-budget decision controls breadth.

If the evidence supports a current-scene card and a **distinct plausible next-beat card**, Smart Context will not allow a nominal one-card budget to collapse those two roles onto one obvious/current card. The frontier widens to preserve both where supported.

Branching scenes can retain the existing six-card predictive floor.

This directly protects the #198 invariant:

> Smart Context must remain a moving predictive frontier. Jev can reduce duplicate ranking, but cannot collapse warming into only obvious/current cards or suppress current-place/next-beat diversity.

### 5. Protected pin authority remains outside Jev

Existing earned pins are removed from Jev's pruneable candidate input.

Manual pins, active continuity pins, Character Bank continuity, and earned pins remain governed by their existing Smart Context lifecycle/ownership rules.

A Jev omission cannot directly cause an already-earned pin to decay.

New earned-pin promotion still requires semantic selection rather than merely occupying deterministic floor-fill capacity.

### 6. Scene and source freshness fencing

Jev warm decisions are bound to:

- Smart Context input/cache authority;
- accepted Scene Scanner revision;
- Change Gate mode/confidence;
- the exact bounded predictive candidate identities.

A result that returns after those inputs change is stale and cannot publish.

### 7. Explicit continuity lane retained

Successful Jev handling now preserves a separate current-scene continuity selection.

That continuity is used only for Smart Context's existing reuse/drift authority. Predictive warming does not automatically become continuity authority.

### 8. Telemetry

Smart Context telemetry now exposes the intended work-removal path, including:

- deterministic offered count;
- Jev selected count;
- deterministic fill count;
- Jev fallback count/reason;
- protected earned candidates outside Jev;
- Sidecar fallback use;
- final predictive/warm count;
- current-scene seed;
- next-beat seed;
- continuity count;
- Jev provider/latency.

This distinguishes work **removed** from work silently skipped.

## Files integrated

- `smart-context/decision-site.js`
- `smart-context/warmer.js`
- `tests/decision-workflow-coverage.mjs`
- `tests/smart-context-jev-admission.mjs`
- `records/integration/NEXUS_TASK198_SMART_CONTEXT_JEV_WARM_ADMISSION_CHANGELOG.md`

## Regression coverage

Focused tests cover:

- Decision Site promotion from shadow to bounded Assist authority;
- candidate-window bounding up to the scanner branching window;
- current-scene + distinct next-beat diversity at a nominal warm floor of one;
- six-card branching breadth;
- deterministic floor fill;
- stale Decision Core output;
- low-confidence / ambiguous Decision Core output;
- low-confidence breadth decisions;
- non-Jev / fallback-provider rejection;
- Sidecar fail-open wiring;
- earned-pin exclusion from Jev pruning;
- earned-pin lifecycle authority preservation;
- scene / Change Gate freshness fencing;
- explicit Jev continuity-lane preservation;
- telemetry contract presence.

## Workbench validation

The final #198 workbench head was:

`592a3c33762d27222b2ff2e010123be1e326a4b4`

The **Nexus 0.7.5 Release Validation** workflow passed on that exact head, including:

- release identity;
- full offline regression suite;
- JavaScript syntax sweep;
- browser-critical retrieval syntax smoke;
- internal relative-import closure;
- Git whitespace validation;
- validation evidence artifact generation.

## Migration exclusions

This migration intentionally does **not** copy unrelated workbench changes from tasks #201, #204, or #205.

It also omits the separate pre-#198 `activePinAuthorityMigrationV2` one-time repair block from the workbench warmer because that hotfix was not part of Nexus `Development`'s #198 baseline and is not required to implement this decision contract.

## Remaining live acceptance

The code is ready for live testing, but final issue acceptance still requires a real SillyTavern run demonstrating:

1. 20+ turns of warm-frontier rotation rather than monotonic accumulation;
2. successful Jev path with no duplicate Sidecar rerank;
3. forced Jev failure/staleness falling back to Sidecar;
4. current-place, character-continuity, and next-beat diversity remaining healthy;
5. no narrative/context-quality regression versus the pre-change baseline.

