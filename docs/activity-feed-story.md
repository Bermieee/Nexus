# Activity Feed: useful work and results

The feed shows separate expandable activities rather than one collapsed counter per turn.
Each row keeps the familiar icon, source, short description, time, and expand arrow.

Show what Nexus did for the story: a scene update, relevant lore retrieved, memories recalled,
a summary saved, working notes updated, or entries and connections committed to the World Tree.
Named background work and problems appear too. Scheduler ticks, Scatter lanes, individual
candidate verdicts, budget planning, growth decisions and persistence writes stay in Diagnostics.
A growth decision alone does not prove that a node was created.

Expanded rows show lore titles, recalled excerpts, summary previews, committed node names and
connections, or sections prepared for the reply. Missing descriptions fall back to honest counts.
Technical metadata is optional, bounded and created on expansion. Prompt bodies, full memory
bodies, provider responses, reasoning and credentials are excluded. Context preparation does
not claim the host has already transmitted or received a response.

## Status and filters

Main / A / B / Running / Queued are visible. The strip reads current bridge and queue state;
Sidecar activity also shows working when its provider call runs outside the job queue. Running
and Queued are job queue counts. Main disabled means its bridge is disabled, not a story failure.
Story is the default, with Memory, Proposals and Problems views. System events open Diagnostics.
Pending and recovery-required proposals remain pinned until acted on, even after clearing history.

## Identity and retention

The host passes the active chat ID. Only events carrying that exact identity appear when a chat
is selected; unscoped history is never assigned to the nearest story by time. Summary, Notebook,
generation-frame and World Tree producers publish their originating chat IDs. Start and completion
update one activity only with an explicit shared task ID and the same chat, generation and worker.
Independent tasks and regenerations stay separate.

`observability/activity-events.js` owns selection and approved metadata. Telemetry retains the
latest 240 useful events separately from its diagnostic ring, restoring them through its existing
session persistence. Raw-event noise cannot evict useful history. Raw diagnostic retention and
portable exports keep their existing contracts. UI projection filters before its 240-row limit;
the controller renders at most 120 activities per view. These limits concern presentation only.

The `activities` projection is the product list; `turns` remains for older readers. Clear hides
previous activity in the UI without clearing telemetry or mutating the story.

## Validation

Behavior tests cover expandable rows, exact story isolation, recalled excerpts, committed World
Tree labels and connections, pending proposals, visible worker state, malformed optional metadata,
bounded retention, reload, and exclusion of transport bodies. A browser preview verifies layout,
expansion and filters without a paid generation. Live receipt arrival still needs a generation
in the installed extension. Source-reading Truth tests normalize Windows line endings; their
production behavior assertions are unchanged.
