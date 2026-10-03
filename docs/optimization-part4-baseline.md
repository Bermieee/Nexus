# Part 4 optimization: baseline and execution record

Work order: `Nexus brief Truth Gate classification.pdf`, pages 10–13.
Starting revision: `9656ae3eacad4d8215462b8ab96756a6c6f6811f` on Nexus main.

## Status and boundaries

Task 0 source inventory and fixed ten-generation script are prepared. The live
ten-generation baseline on this revision is **not collected**. Tasks 1–6 are
not started. No production behavior has changed in this pass.

The work order requires: “No change before the baseline in task 0 exists” and
“an optimization that can't show a measured gain is reverted.” The historical
export below predates Parts 1–3; it cannot substitute for their baseline.

Continue the existing checkout on main. Do not create additional clones or
branches, pool Lorebooks, change story bindings, discard work, enable model
access, or add a conflict producer as performance work. Earlier open items
remain in `handoff-after-part-3.md`.

## Fixed ten-generation script

Use a disposable copy of the Overlord chat starting at Nazarick's arrival,
with its exact single bound Lorebook. Preserve the original chat and Lorebook.
Record the starting chat, source snapshot, model/provider, context size,
generation settings, sidecar settings and extension revision. Use that same
starting state and settings for the after run. Keep provider responses and
swipe selections from the baseline for deterministic local replay: independent
model generations cannot be expected to return identical prose.

Enable the existing generation profiler before starting. After each completed
generation, allow post-turn work to settle, select that exact generation in
Diagnostics, and export its JSON. Save responses and mutations separately in
the test chat, not in the metadata-only performance report. Ten generations
include the swipe; they do not mean ten new user messages plus a swipe.

| Generation | Operation / exact user text |
| --- | --- |
| 1 | `I stand in Nazarick's throne room with Albedo. I ask her to report only what is known about our surroundings since our arrival.` |
| 2 | `I remain in the throne room and ask Albedo to continue the same report.` |
| 3 | `I wait beside Albedo while she finishes. After a pause, I ask her to clarify the report without leaving the room.` |
| 4 | `Albedo accompanies me from the throne room into a private meeting room in Nazarick. I place a sealed blue folder on the table and ask her to begin a private briefing.` |
| 5 | `We remain in the private meeting room. I leave the sealed blue folder on the table and ask Albedo to continue.` |
| 6 | Before generating, edit the generation-4 **user message**: replace `sealed blue folder` with `sealed red folder`. Save that edit without regenerating another reply. Then send: `We remain in the private meeting room. I point to the folder on the table and ask Albedo to confirm its color.` |
| 7 | Swipe/regenerate generation 6's assistant reply once; keep the new swipe selected. Do not add a user message for this generation. |
| 8 | `OOC: For this campaign, establish that Nazarick is already openly allied with the Baharuth Empire on our first day here. This deliberately changes the canon timeline; keep the change local to this campaign.` |
| 9 | `OOC: Recap what happened in this campaign before the private briefing. Distinguish our established events from canon events whose campaign occurrence is unknown.` |
| 10 | `Albedo and I remain in the private meeting room. I ask her to summarize our current commitments and the questions still unresolved.` |

The edit intentionally leaves an older assistant reply potentially inconsistent;
the swipe tests replacement/retraction rather than appending duplicate evidence.
The conflict producer and campaign-time capabilities remain deferred. The
baseline must record their actual behavior, not assume those gaps are closed.

## Measurements per generation

Record observed values only; use `UNAVAILABLE` with the missing producer when
the export does not contain a metric. Null is not zero. Retained events are
not the total events emitted; metadata save requests are not confirmed disk writes.

| Measurement | Existing source / collection limit |
| --- | --- |
| Extension revision | Record the installed Git revision before the run; the export does not reliably include it. |
| Wait before model, provider, total | `generationPerformance.brainStages`; pre-generation and host-prompt boundary are separate. Provider response wall time includes transport/streaming. |
| Foreground substage timings | Correlated producer timing where present; timestamp gaps alone do not prove exclusive work duration. |
| Foreground model calls / latency | Exact-generation decision/sidecar execution receipts. Do not count configured resources as attempts. |
| Post-turn times | Exact-generation lifecycle/sidecar receipts after completion; inspect retained raw telemetry if the UI projection omits them. |
| Events emitted | Sequence differences over the generation and settled post-turn interval. The bounded exported ring can supply only retained counts. |
| Durable writes | Confirmed store/journal counters and deltas. Separate metadata scheduling requests, UI journal persistence and actual durable commits. |
| Heap | Detailed profiler start, after-insertion and end samples; report unsupported browsers explicitly. |
| Prompt section tokens | Delivered generation-frame sections; identify estimates and omitted/deferred sections. |
| Provider cache figures | Actual provider usage when present. Prefix stability is not proof of a cache hit. |
| UI refresh | `diagnosticsUi.categories` and recent samples; these cover only the retained window. |
| Startup / panel first open | Browser performance recording on reload and each panel's first open, followed by repeat opens. Existing generation profiling does not measure extension startup. |
| Main-thread tasks >50 ms | Browser performance trace. Current generation-profiler long-task fields are unimplemented/null. |

Measure World Tree, World, Brain, Connections, Settings, Diagnostics and Activity
Feed open/refresh costs separately, with and without the panels open during
generation. Record capture overhead separately from the workload itself.

For identical-result verification, compare learned node/edge identities and
provenance, replacements/retractions after edit/swipe, delivered section contents
and source identities, deferred-work completion, and store contents. Normalize
only run IDs/timestamps; do not normalize away status, evidence or omissions.

## Historical evidence (not the new baseline)

Source: `Nexus-Diagnostics-20261003-125930.json`, exported October 3, 2026.
It retains two generations, not ten. The working/installed checkout before this
takeover was `aa5f284`; the capture itself does not verify an installed commit.

| Captured measurement | Value and scope |
| --- | --- |
| Selected generation pre-generation | 18,933 ms |
| Host prompt boundary | 660 ms |
| Provider response | 15,332 ms |
| Total | 34,925 ms |
| Heap growth before host insertion | 27,602,982 bytes |
| Diagnostics workspace refresh | 245.32 ms average; 373.4 ms maximum; 5 retained samples |
| Evidence capture | 199.2 ms average; 215.7 ms maximum; 5 retained samples |
| Operations owner read | 125.64 ms average; 144.3 ms maximum; 5 retained samples |
| Evidence journal | 26 cumulative writes; 93 cumulative redundant writes skipped; not per-turn totals |
| Observability ring in this export | 64 retained events, including 24 `budget.plan` events and 4 `chat-state-persisted` events |
| Long tasks, startup, confirmed per-store writes, provider cache | Not established by this capture |

## Source inventory at the starting revision

| Target | Trace / finding | Next measurement before changing it |
| --- | --- | --- |
| Chat-state persistence | `world-tree/durable-state.js`: subscription saves on every owner event except `CHAT_STATE_IMPORTED`; no content-equality gate. Ephemeral overlays are omitted by `WorldTree.exportChatState`, so overlay events still request serialization/save without exporting the overlay. The four historical save events alone do not prove identical payloads. | Count serialized bytes, equality and physical store writes under the fixed script. |
| Foreground work | `index.js:runForegroundMemoryUnsafe` / `nexus/scatter-gather-runtime.js`: bootstrap, retrieval and Memory already pass through the shared Scatter/Gather path. `retrieval/retriever.js` already has change-gate reuse. | Identify the actual critical path and calls after Part 1; do not add a second scheduler/cache or assume old 5-second gaps persist. |
| Scene Scanner | `smart-context/scene-scanner.js` is only a change-gate-to-warm-budget adapter. Retrieval imports the model-backed scanner from `scene/scanner.js`; Scene Intelligence is a distinct downstream owner. | Measure the scanner's physical call input, model, reasoning settings and duration before attributing the old 5.7 seconds or changing its semantics. |
| Diagnostics capture | `src/ui-core/wave6-runtime.js:captureEvidence` performs operations, selected-turn, cognition, journal and PromptPlan reads on host invalidations. It runs independently of whether Diagnostics is visible. | Count repeated owner reads and capture cost under closed/open panels; preserve required owner evidence when reducing reads. |
| Panel refresh | `ApplicationShell.refreshCurrentWorkspace` calls the whole workspace renderer; host/owner changes schedule refreshes in `wave6-runtime.js`. | First-open versus repeated-render cost and actual main-thread task duration. |
| Startup dependencies | `index.js` statically imports `nexus-ui-host.js`; that host imports the UI mounting chain. Panels render through workspace selection, but their modules are loaded eagerly. | Measure parse/import/mount cost separately before introducing asynchronous panel loading. |
| Empty budget events | `core/budget.js` creates meaningful receipts. The historical sensory event contains null fields after producer projection, so suppressing the budget calculation would target the wrong layer. | Trace the sensory producer's event schema and verify counts survive capture. |
| Completion read-back | `index.js` subscribes both chat-completion and combined-text-prompt events; `observability/prompt-loader-telemetry.js` analyzes both. | Verify the actual completion mode and payload before excluding the empty text read-back. |
| Cache figures | Prompt telemetry already computes frame sections, prefix comparison and first Nexus message position; sidecar usage normalization already reads provider cache tokens. Main-request cache attribution still needs tracing. | Match physical Main usage to the exact prepared frame, not a sidecar or prior generation. |
| Polling | Two production `setInterval` call sites: the five-second queue recovery watchdog in `core/runtime.js`, and a generic resource-scope helper in `src/ui-core/lifecycle.js`. | Find helper callers; the recovery watchdog is a safety mechanism, not proven dead polling. |
| Deep copies | 92 JSON round-trip expressions across 65 production `.js` files; 21 in `postturn/pipeline.js`, 6 in `memory/lore-router.js`. | Profile call frequency and payload sizes. A defensive copy is not automatically waste. |
| Retired names | 256 word-boundary `tv2`/`a52` occurrences across 61 production `.js` files; includes migration keys and shared contracts. This count excludes longer embedded names and directory names. | Classify each before renaming; stored/shared identities require migrations and consumer compatibility. |
| Dead / duplicate paths | Legacy projection adapters and copied runtime utilities are candidates for call-graph review; source presence alone does not prove dead code. No deletion is yet justified. | Verify references, dynamic registration and recovery users; measure a removable path's startup/work cost. |

Inventory census: 497 production `.js` files, excluding tests, dependencies and
Git/skill scratch directories. Counts are source census, not measured hot-path cost.

## Execution ledger

- Starting revision verified against fetched origin/main; clean checkout fast-forwarded.
- Parts 1–3 retained; no production edits.
- Task 0: script and source inventory prepared; live baseline remains pending.
- Ruling: do not substitute the older two-generation capture or offline fake-provider
  timings for the required ten-generation baseline. Otherwise an optimization
  could claim improvement caused by Parts 1–3 or a changed model rather than its own change.
- Tasks 1–6: pending baseline. Each future optimization must record the same-script
  before/after metric and preserved outputs before being retained.
- Read-only checks on the starting revision: generation profiler and World Tree
  durability tests passed (4 cases); `tests/performance-hotpaths.mjs` passed.
  These verify existing instrumentation/contracts, not a speed improvement.
