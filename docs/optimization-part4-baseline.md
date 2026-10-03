# Part 4 optimization: baseline and execution record

Work order: `Nexus brief Truth Gate classification.pdf`, pages 10–13.
Starting revision: `9656ae3eacad4d8215462b8ab96756a6c6f6811f` on Nexus main.

## Status and boundaries

The fixed ten-generation script was executed on installed/main revision
`9198f9b5ac7eae6ee96aa2505e3f1f51d9e77c35`, after the Activity Feed repair.
This is a **fresh bootstrap observation**, not a complete established-story
baseline: the copied Lorebook has source entries but no compiled legacy Tree,
and automatic post-turn processing was disabled in the owner's existing settings.
That preserves the settings but does not exercise normal Tree retrieval or
settled learning/retraction. Part 4 is **in progress, not complete**.

The first retained optimization defers closed workspace rendering and disables
rendering the detached Quick Dash in floating-navigation mode. Owner work,
evidence capture, the Activity Feed, and subscriptions remain active. Its gain
is measured at the UI boundary below; live story-load improvement remains to
be checked after updating the installed extension. Tasks 1–6 are not declared
closed by this narrow UI change.

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

## October 3 execution and measurement

Run identity and settings are recorded outside the repository in
`optimization-live-run.json`; private diagnostic exports and story prose are
not committed. The disposable chat is
`Ainz Ooal Gown - 2026-10-03@16h30m37s841ms`, bound only to the separate
`Nexus_Optimization_20261003_Baseline` copy. The original story and Lorebook
were preserved. No Builder categories were manufactured for the test.

The profiler was enabled for the script and disabled after capture 10.
Diagnostics was closed while generating and opened between generations to
export each exact selection. Main remained `mimo-v2.6-flash`; Sidecars A/B
remained `z-ai/glm-5.3-flash`. Post-turn, model gateway, main-model access and
automatic access were not enabled as performance work.

| Fresh bootstrap observation | Value |
| --- | --- |
| Unique generations / chats | 10 / 1 |
| Wait before Main, mean | 2,602.3 ms |
| Provider response, mean | 25,406.7 ms |
| Total, mean | 28,009 ms |
| Pre-insertion heap delta, mean | 8,902,947.7 bytes |
| World Tree counts during the script | 151 nodes / 148 edges |
| Pending post-turn messages at the end | 9; automatic post-turn disabled |

These numbers cannot establish that the prior 32-second established-story wait
was repaired: this fresh chat took a different bootstrap path. The edit left
older assistant prose and the following user message saying blue; the swipe
recognized a red/blue inconsistency. With post-turn disabled, this is not a
validation of learned-source retraction. Durable-write counts, emitted-event
totals, startup timing, main-thread long tasks and provider cache attribution
remain unavailable, not zero. UI metrics cover a bounded retained export-time
window; they are not exclusive per-generation timings.

`tools/optimization-baseline.mjs` reads exports without importing the extension,
preserves missing measurements as null, deduplicates repeated exports, and
checks the chat/generation (plus supplied turn/correlation) of each performance,
heap, operational and frame source. A selected historical turn cannot borrow
live-turn timings. Ten exports alone never set `controlledBaselineVerified`.

## Closed-workspace optimization

Story changes emit many owner/host invalidations. Previously each scheduled
refresh rebuilt the selected workspace even when its panel was closed. Floating
navigation also detached the legacy Quick Dash DOM while its controller kept
reading snapshots and rendering it. Those render paths now wait until their
contents can be shown; opening or restoring a panel flushes one refresh against
the current owners. There is no cached story data to reuse across story switches.

Replay compares the old shell at `9198f9b5` and the new shell, using the same
final exported operational snapshot for a representative render callback:

| 100 hidden invalidations, then open | Before | After |
| --- | --- | --- |
| Hidden workspace renders | 100 | 0 |
| Renders after opening | 101 total | 1 total |
| Snapshot-clone callback time | 106.701 ms | 0.046 ms |
| Current pane after opening | Same | Same |

This is a deterministic component replay, **not browser paint timing or a
measured end-to-end story-load speedup**. Callback timings are machine-specific;
the useful invariant is removing 100 hidden renders while retaining the latest
visible result. Learning, injected sections, tree mutations, deferred jobs,
receipts, and their scheduling paths are unchanged by this edit. Five behavior
tests cover closed refresh coalescing, workspace changes, removed workspaces,
floating Quick Dash suppression and non-floating default behavior.

## Story-load trace and remaining work

- `CHAT_CHANGED` cancels old work, clears telemetry, hydrates the chat-scoped
  World Tree, synchronizes the bound Lorebook, reconciles durable recovery, then
  hydrates Scene and Hot. These authority/recovery steps must not be removed.
- UI host invalidations reach `ApplicationShell.refreshCurrentWorkspace`; the
  hidden rendering found on that path is addressed above.
- Evidence capture still reads operations, selected-turn receipts, cognition,
  journal diagnostics and PromptPlan. It was deliberately retained; capture
  cost needs a separate measurement before changing its retention semantics.
- World Tree persistence now skips transient overlay events and duplicate UI
  notifications; the measurements and durability checks are recorded below.
- Connected-chat Scene hydration computes full message revisions at three
  fences. Those checks protect against edits/chat switches; no unsafe removal
  is justified by elapsed timestamp gaps alone.
- Foreground bootstrap/retrieval/Memory already use the shared Scatter/Gather
  path; retrieval has change-gate reuse and consumes existing post-turn advice.
  Moving required calls to a disabled post-turn lane would change behavior.
  Established-story critical-path measurements and held-result equivalence
  remain necessary before retaining a foreground scheduling change.
- Incremental visible panel updates, first-open module loading, cache inputs,
  debug-event policy, persistence coalescing and code cleanup remain open.
  Retired stored keys/shared contracts are not renamed without migrations.

Validation: the hidden-render tests failed before the production change and
pass after it. The offline report has nine passing tests including historical
attribution. All 121 repository test files passed after the final attribution
correction; changed production JavaScript and the measurement tool also passed
syntax checks, and `git diff --check` reported no whitespace errors.
A separate read-only review found no UI production defect and identified the
report attribution issue, which was fixed rather than labeling incorrect
historical metrics as measurements. The installed extension was updated to
`c69ca55`; the subsequent follow-up changes still need an installed comparison.

## Follow-up: owner reads and persistence

An operational projection previously read Scene, Runtime, Coprocessor and
PromptPlan twice: once for stages and again for counts/inspection. A synchronous
projection now shares each read, including failures, within that call only. The
next projection reads fresh owners; there is no retained story/generation cache.
Replay of 100 projections using the ten captured diagnostic inputs produced
deep-equal outputs, reduced these calls from eight to four per projection, and
took 20.528 ms before versus 17.462 ms after. These are component timings, not
live loading measurements. Four regressions cover freshness, failure isolation
and the waiting-for-turn path.

Overlays do not change the durable chat export. Four overlay updates plus expiry
previously made five identical exports/save requests; they now make zero. Their
owner events still publish. Real mutations still update metadata synchronously.
The local overlay replay preserved the durable snapshot and all owner events
(2.148 ms before, 0.122 ms after). Save requests are not physical disk writes.

Each new node/edge also publishes a lowercase UI notification immediately after
its uppercase mutation event, at the same revision. Persistence previously ran
for both. It now saves on the mutation and skips the second notification. In a
147-source import replay, exports/save requests fell from 592 to 296, with
53.302 ms before and 34.053 ms after. Receipts, full owner state, final durable
metadata and all owner events were deep-equal. The regression checks metadata
already matches the owner when each UI notification is delivered. This removes
confirmed duplicate work, but does not prove the reported large live attachment
stall is fully resolved.

## Follow-up: apparently missing World Tree

The owner reported a blank World Tree workspace with only the collapsed Memory
review visible. The original story's 147-node tree remained available. Opening
the workspace with no chat also rendered its source chooser in the test browser.

An isolated browser layout replay reproduced a matching blank view: a broad
direct-child CSS rule gave the collapsed Memory review a full viewport height,
and restored scroll could place the entire tree above the viewport. The repair
restricts that height rule to the tree and allows normal scrolling to the review.
At a 600-pixel viewport, collapsed Memory height fell from 600 to 18 pixels;
restoring bottom scroll then retained the tree in view instead of hiding it.
The empty workspace markup came from the actual no-chat panel. No Lorebook,
binding, nodes, relationships or Builder state were mutated by this repair.

Validation after these follow-ups: all 122 test files passed, changed JavaScript
passed syntax checks, and `git diff --check` passed. The new layout regression
and duplicate-persistence regression failed against their previous behavior.
The live attachment stall and complete Part 4 acceptance remain open.
