# Nexus 0.7.0 Task #193 — Builder 2 Consolidated Tree Flow

## Scope

Issue #193: improve Tree Builder speed and reduce the operator-facing build flow from the historical multi-review sequence to one or two meaningful review stages.

Implementation remains on the existing lowercase `development` branch. No new branch was created. `Bermieee/Nexus` was not modified.

## Audit result

Builder 2 already contained the newer Nexus throughput systems:

- adaptive logical semantic slicing through `builder2/semantic-packing.js`;
- token-targeted source packing;
- dynamic Model Worker dispatch through the current MAIN / Sidecar worker pool;
- bounded physical slice multiplexing in `builder2/nexus-semantic.js`;
- adaptive physical request geometry;
- durable PlanStore resume/recovery;
- source / corpus / Tree freshness fencing;
- artifact reuse across compatible runs.

The main remaining performance and usability problem was the review topology. The durable internal pipeline still exposed taxonomy, placement, gap, reconciliation/cleanup, quality, and final preview as separate human stops.

## New product flow

New product Builder runs default to `reviewFlow: consolidated`.

The durable internal phase machine is preserved for crash/reload recovery, diagnostics, and compatibility. An explicit `reviewFlow: phased` request retains the historical staged behavior.

Normal operator flow is now:

1. **Tree Draft Review**
   - Builder has already surveyed the lorebook using adaptive slices/workers.
   - Builder has already drafted the taxonomy.
   - Batched classification has already placed clear entries.
   - Jev is used only on the ambiguous classification tail.
   - Remaining placement exceptions and category gaps appear on the same page.
   - The drafted category structure is editable on that same page.
   - No canonical Tree mutation has occurred.

2. **Final Tree Preview**
   - only invalidated classifications are rerun after Draft Review edits;
   - deterministic quality executes internally;
   - passing quality no longer requires a separate operator click;
   - materialization produces the normal final Tree diff/preview;
   - canonical commit remains explicit and Ledger-controlled.

Blocked quality or new ambiguity produced by operator changes can still surface an exception review instead of forcing unsafe continuation.

## Performance changes

### Adaptive worker classification before Jev

The prior small-taxonomy path could attempt one Jev parent-placement decision per source before batched semantic classification.

Consolidated mode now reverses that order:

1. adaptive Model Worker slices classify the corpus in high-throughput batches;
2. only worker-returned ambiguous classifications are sent to bounded Jev hierarchical classification;
3. unresolved Jev cases become Draft Review exceptions.

Legacy phased mode retains the old behavior for compatibility.

This removes a potentially large serial typed-decision pre-pass from normal full lorebook builds.

### Existing dynamic slicing retained

No replacement slicing system was invented. The current Builder 2 semantic packing and Model Worker transport were already the right primitives:

- logical slices remain bounded independently from provider calls;
- physical bundles remain bounded;
- worker selection remains dynamic;
- resume retains durable semantic artifacts;
- unchanged compatible runs can reuse survey/taxonomy/classification work.

## Durable phase changes

Added internal phase:

`draft-review`

It has its own freshness-bound review token and supports:

- `gap-review → draft-review`;
- `draft-review → reclassification`;
- `reclassification → draft-review` when targeted reruns create new exceptions.

The new phase combines operator category edits, ambiguous placement decisions, and gap decisions without weakening the underlying durable ownership boundaries.

## Decision Core / Jev

Added assist interpreter for the existing:

`builder.hierarchical-classification.v1`

Jev may resolve a worker-returned ambiguous classification only when:

- bounded evidence is sufficient;
- the selected result is one of the supplied legal candidate taxa;
- returned choice confidence, when available, is at least the configured initial floor.

Jev does not invent categories, commit Tree changes, or own mutation authority.

## UI

Standalone Builder now presents a three-part progress strip:

- Analyze + Draft
- Review
- Save

The Tree workspace and standalone Builder share the same consolidated Draft Review renderer and decision collector.

Historical phased review renderers remain present for explicit compatibility/debug flows, but are no longer the normal product path.

## Ownership preserved

- Builder 2 retains semantic taxonomy/classification/gap ownership.
- Work Director / Model Worker systems retain scheduling and provider-neutral execution.
- Jev performs bounded semantic judgment only.
- PlanStore retains durable crash/reload authority.
- freshness fences remain authoritative.
- deterministic quality remains mandatory.
- operator review remains mandatory before canonical commit.
- Transaction Ledger / Nexus mutation authority remains unchanged.

## Validation

Validated runtime head:

`0f8765f374632d44e7beca67f9f1aeb2a4054d2b`

GitHub Actions:

- workflow: `Builder2 consolidated flow`
- run: `35691058873`
- job: `106627946965`
- Syntax: PASS
- Consolidated Builder regression: PASS

The regression verifies:

- durable `draft-review` phase transitions;
- draft review token creation;
- consolidated Draft Review rendering;
- category-edit surface;
- product default is consolidated while phased remains explicit;
- standalone Builder three-part flow;
- Tree workspace Draft Review wiring;
- adaptive logical slicing remains present;
- dynamic Model Worker dispatch remains present;
- bounded physical slice multiplexing remains present;
- Jev-first per-source pre-pass is bypassed in consolidated mode;
- actual mocked pipeline execution reaches `draft-review` first;
- approving a clean draft runs deterministic quality internally;
- actual mocked pipeline execution then reaches `preview` directly.

## Live acceptance

**NOT LIVE-ACCEPTED / NOT GREEN.**

Live SillyTavern checks should include:

- a fresh large lorebook build;
- a clean two-review Draft → Final Preview run;
- a lorebook containing ambiguous placements;
- category edit that invalidates existing placements and triggers only targeted reclassification;
- a category gap create / merge / defer cycle;
- cancellation and reload/resume from Draft Review;
- reload/resume during semantic slicing;
- adaptive MAIN / Sidecar worker changes under real latency;
- Jev unavailable / low-confidence behavior;
- final Tree preview and Ledger commit;
- medium/large lorebooks sufficient to compare wall-clock time and provider-call count against the former phased flow.

