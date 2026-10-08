# Nexus architecture and saved-data audit — 2026-10-08

## Verdict

Nexus has the intended core systems, but the migration is not complete at several storage and reporting boundaries. The most urgent defects are in durable Memory and Character State publication. Passing the existing test suite does not close those defects: isolated executions of the current production modules reproduced them during this audit.

The saved data examined does **not** show books being merged or stories crossing their configured bindings. That is a limited, positive finding about the files examined, not certification of every live browser path.

This pass changes documentation only. No installed extension, story, Lorebook, settings, credentials, browser database or production module was changed. No provider calls, new checkout, branch or delegated worker was used.

## Baseline and coverage

| Item | Evidence |
| --- | --- |
| Source checkout | `C:/Nexus`, `main@ecad8c542eff3b1ee42078a35355028d756bf789` |
| GitHub main | Read-only remote check returned that same commit |
| Installed extension | `cc3760871d98ddcfb3e82286c1d913bb567f5aef`; it lacks the final Scene persistence, advisory-overlay and feed repair in `ecad8c5` |
| Repository inventory before this report | 736 files; 637 JavaScript/module files; 65 Markdown documents |
| Documentation review | All Markdown files indexed by contents, headings and open-item markers; detailed review of the current contracts, integration/repair notes, Notebook and optimization records; both supplied briefs and the 21-page porting map/13-page Truth brief reviewed |
| Offline verification | All 123 standalone test files pass with `node --experimental-vm-modules`; all 637 modules parse as ECMAScript modules |
| Saved host files | All 12 chat JSONL files parsed, including 540 message rows; all 8 Lorebook JSON files parsed, covering 698 entries; Nexus settings storage inventoried without exporting credentials |
| Additional probes | Seven defect/contract probes using disposable in-memory state and production modules; see the evidence JSON and findings below |

This is a repository-wide inventory and focused architectural trace, not a claim that every source line received a manual review. Browser IndexedDB contents, active in-memory state, multi-tab behavior and actual provider execution were not directly inspected. Existing exports and repair notes provide historical live evidence, not proof of the current installed session.

## What Nexus is supposed to be

The user's current requirements take priority over older plans. The current design is:

1. **A story has one exact Lorebook binding.** Runtime reads, graph relationships, retrieval and mutations stay within that story's authority. An enabled-book list or a saved picker never supplies implicit story authority.
2. **The World Tree owns durable knowledge.** Lore sources, characters, character states, memories, relationships, scenes, events and summaries belong to the same canonical model. Compatibility facades can project it; they cannot become a second permanent knowledge store.
3. **The world grows from evidence.** Discoveries remain local to the story unless separately approved as authored/global knowledge. Identity resolution, unresolved candidates, provenance, temporal state and edit/swipe/delete invalidation govern growth. Example taverns and rooms are not product presets.
4. **Builder organizes knowledge and its presentation.** It proposes meaningful navigation and an organic layout. Organization, layout and authored source content have distinct ownership. Explicit book authoring works without a chat and does not attach that book to any story. Trash removes the selected organization, preserving authored entries. Review and recovery remain fenced.
5. **Scene Intelligence supplies accepted scene state.** Sidecars perform model work for it; a returned worker response is not owner acceptance. Scene feeds Hot and the active cast feeds Green Room. Reduced extraction is disclosed.
6. **Hot and Green Room are temporary context.** They are scoped working overlays, excluded from durable World Tree export. Green Room remains inferred and expires. The later integration brief supersedes the early porting map's suggestion of durable Hot storage.
7. **One scheduling architecture coordinates work.** Existing job rows, A/B leases, physical batching, Scatter/Gather, deadlines, cancellation and freshness determine what can execute and publish. A running provider call drains before lending. Late fresh work is held for later; it cannot modify a sealed frame.
8. **Retrieval remains attributable.** Scene/Hot anchors feed Sensory channels and Graph Walker; their candidates reach Truth, admission and Gather before the typed generation frame. Candidates, accepted context and observed host delivery are different facts.
9. **Jev is optional advice.** Correctness does not require enabling it or Main access. Missing configuration must not be disguised as an execution attempt.
10. **The feed explains useful work.** Separate expandable activities and the Main/A/B/Running/Queued strip are the current user decision. The older Truth PDF's one-row-per-turn and single-dot design is superseded. Internal plumbing belongs in Diagnostics; useful Scene, retrieval, learning and actual graph growth remain visible.

The main specification sources are [World Tree contract](../NEXUS_WORLD_TREE_PORTING_CONTRACT.md), [port scope](../a52-port-list.md), the supplied Integration and Contributions briefs, and the supplied porting map. Later [book authoring](../world-tree-book-authoring-repair.md), [growth](world-tree-growth-repair-20261002.md), [Notebook](../notebook.md), [feed](../activity-feed-story.md) and [scheduler repair](../integration/scheduler-batching-impact-audit.md) records refine the implementation. Historical checkpoint prose is not current completion evidence.

## Saved-data findings

| Check | Result |
| --- | --- |
| Unreadable chat headers, message JSON rows or books | 0 |
| Duplicate entry UIDs within a Lorebook | 0 |
| Configured bindings | 4; each names exactly one readable book, with no different write book and the expected chat key |
| Chats with Nexus metadata | 10 |
| Chats marked migrated | 3 |
| Older chats retaining legacy Memory metadata | 5; these are not automatically corruption or proof of a second active authority |
| Saved canonical chat snapshots | 3; one contains 12 chat nodes and 37 chat edges, two contain no chat-local nodes/edges |
| Wrong snapshot/node/edge chat scope | 0 |
| Foreign-chat message provenance references | 0 |
| Duplicate node/edge IDs or serialized Map key/record-ID disagreements | 0 |
| Noncanonical stored relationship meanings | 0 |
| Missing node source type/source IDs in these snapshots | 0 |

Chat snapshots serialize Maps as `[id, record]` tuples; those tuples were decoded before validation. Relationships use `relation`. An initial scanner assumption was corrected before accepting any data finding.

The empty chat-local snapshots do not mean authored Lore disappeared. Global Lore is reconstructed from its qualified book sources; it is not supposed to be duplicated into each chat snapshot. Similarly, five separate saved book organization assets in settings are not five simultaneously active story corpora.

These checks do not establish the semantic truth of every entry, freshness of every retained historical reference, completeness of candidates, or absence of a runtime leakage path. In particular, the restore validation defect below exists even though these files do not contain the malformed payload used to reproduce it.

## Confirmed implementation defects

### A1 — P1: Memory transactions still target a retired store

**Locations:** `memory/store.js:323`, `memory/store.js:412`, `memory/lore-router.js:263`, `:384`, `:610`; `nexus/host-durability.js:322`; `nexus/mutation-engine.js:510`.

Migrated `getMemoryStore()` returns a World Tree facade. `saveMemoryStore()` writes canonical contributions and the `nexus_world_tree_chat_state_v1` snapshot. However, create/edit/delete/permanence/coverage/revision wrappers still tell the durability helper to protect only `tv2_memory_bank`. That key has been retired from migrated chats.

**Executed reproduction:** load the real Memory store, canonical contribution/intake owner and durability barrier with a disposable migrated story. Make the first host save fail and allow the rollback save to succeed. `createMemoryRecord()` rejects and the error says `tv2RollbackRestored=true`. The new memory nevertheless remains canonical, and the rollback save persists it. The barrier restored and verified the wrong metadata key. The existing 123-file suite does not catch this combination.

The Lore router has a related, directly traced mismatch: three parent/recovery transactions still write `tv2_memory_bank` with `expected: beforeStore`. In a retired chat, the actual metadata value is absent, so the canonical engine's expected-state check rejects it as stale. If a legacy value were present, writing it would still not update the authoritative tree. This is separate from whether the model produced a useful routing answer.

**Required repair:** use the existing canonical coordinator and verified World Tree snapshot pre/post-images for every affected path. Restore the authoritative owner and invalidate its facades on failure. Preserve routing saga/child settlement rules. Do not resurrect the retired bank or weaken expected-state checks. Summary creation/promotion already use World Tree snapshot transactions; do not rewrite those indiscriminately.

### A2 — P1: Character State reports durable success without verified persistence

**Locations:** `memory/character-banks.js:329`, `:356`; `world-tree/native-bank-authority.js:20`; `world-tree/durable-state.js:18`.

`updateCharacterBankDurably()` now applies a facade patch and calls `notify()`. That synchronizes canonical state and requests a debounced save. It does not await a verified save or capture a rollback pre-image, yet emits `bank-updated-durable`. Character review and Card sync/recovery callers await this function as their persistence boundary.

**Executed reproduction:** the real Character facade/native-bank/intake path returns the requested update even when every debounced save request throws. The verified host save is never called. A separate helper probe confirms `persistDurableWorldTreeChat()` returns `persisted:true` when its save request throws.

**Required repair:** restore an awaited canonical persistence contract for authority-bearing Character updates, including review and Card recovery state. Distinguish an in-memory snapshot/save request from verified durable success. Keep migration backups and source/binding fences. This finding does not imply every writer lacks durability: Scene, Notebook and canonical mutation paths have stronger barriers.

### A3 — P2: Chat hydration trusts the payload's internal scopes

**Locations:** `world-tree/durable-state.js:7`, `:12`; `world-tree/store.js:509`.

The outer snapshot chat ID is checked, but `importChatState()` directly inserts the serialized nodes, edges, decisions and ledger rows. It does not first validate their scopes, provenance, IDs or collisions with existing records. It removes the receiving chat's current rows before loading the payload.

**Executed reproduction:** a snapshot whose header says story A but contains a valid story-B node is accepted through `hydrateDurableWorldTreeChat()`. The foreign node enters the owner. No such foreign record was found in the scanned user snapshots.

**Required repair:** stage and validate the entire snapshot before replacement; reject foreign/global rows, inconsistent tuple IDs, cross-scope references and identity collisions. Edges may legitimately reference the receiving story's bound global Lore; validation must account for source hydration order instead of rejecting all external endpoints. Preserve the existing owner on rejection. Test malformed, copied and partially invalid snapshots, not just valid round trips.

### A4 — P2: Memory and Character facade caches omit owner identity

**Locations:** `memory/store.js:293`, `:323`; `memory/character-banks.js:143`, `:193`.

These caches use chat/revision values without the World Tree object's identity. Replacement or hydration can change content without increasing the numeric revision used by a cached facade. `importChatState()` uses `Math.max` for revision, so revision equality alone is not a reload fence.

**Executed reproduction:** prime the real Memory facade, replace the World Tree with a different snapshot at the same revision, and read again. The exact old facade object returns old memory text while the canonical owner contains the replacement text. The Character facade has the same cache-key pattern; its replacement case was traced but not independently executed here.

**Required repair:** include owner and hydration/content identity, invalidate on replacement/import, and check the family read caches as well as writable facades. Never replay a stale facade into a restored owner. The shared canonical read API already handles owner identity and need not be replaced.

### A5 — P2: Chat persistence loses registered identity metadata

**Locations:** `world-tree/store.js:397`, `:498`, `:509`, `:532`; `world-tree/intake/runtime.js:106`.

Full-owner export preserves the identity registry. The ordinary durable chat snapshot does not export or rebuild the chat's registered identity records. Node aliases and registry aliases are not necessarily the same data.

**Executed reproduction:** register a chat entity with an additional authoritative alias, export its chat state and import into a fresh owner. The node survives but the registered alias no longer resolves. Full-owner export retains the registry. Simple aliases already stored on nodes can still resolve through normal lookup; this is not a claim that all identity resolution stops after reload.

**Required repair:** define a scoped durable identity representation or a complete, deterministic reconstruction that preserves supported alias/source-link/history semantics. Prove ordinary chat save/reload, not only full-owner export/reload. Temporal registry persistence should be included in that design review; its live effect was not independently established in this pass.

### A6 — P2: One contribution repeatedly serializes the whole chat

**Locations:** `world-tree/store.js:254`, `:323`; `world-tree/durable-state.js:49`.

Contribution commit stages the final node/edge Maps atomically, then emits one mutation event per changed row. The persistence subscriber exports and clones the entire chat snapshot for each event. Overlay and duplicate lowercase UI events are already skipped; the remaining uppercase events are distinct notifications of the same completed contribution.

**Executed reproduction:** one contribution creating 20 nodes causes 20 full chat exports and 20 debounced save requests. Those are request counts, not measurements of 20 physical disk writes. This demonstrates repeated serialization work; it does not quantify the full live story-load/attachment delay.

**Required repair:** coalesce at the canonical contribution/publication boundary while preserving immediate owner visibility, all subscriber events, verified save/rollback semantics and deferred work. Measure existing-story attachment/load with the same inputs before and after. Do not throttle away mutations or remove freshness checks to obtain a faster number.

## Reporting and acceptance gaps

### A7 — Selected-turn evidence remains incomplete

The latest retained live trace, documented in [Scene/Hot/Walker repair](../integration/scene-hot-walker-live-repair.md), showed actual traversal nominations alongside missing candidate-level Sensory/Truth evidence and Lore revision 1707 being rejected against selected generation revision 1704.

Current `nexus-ui-bindings.js:788` still reads live Lore state for a query rather than a retained generation-time Lore snapshot. Strict historical fences correctly reject incompatible current state. Relaxing those fences would fabricate historical evidence.

The selected-turn assembler isolates failures, which is good, but optional attribution and causal-stage completeness are not equivalent to actual execution. `NO_EVIDENCE`, an evicted event, an idle optional provider, a failed owner read and a failed job need distinct interpretations. Twenty-seven warnings are not automatically twenty-seven independent defects.

**Required work:** retain bounded metadata for the evidence actually consumed by each generation and trace candidate identities through Sensory → Truth → Gather → frame → observed host request. Keep historical snapshots separate from current owner views. Do not fabricate Jev or Sidecar attempts from a deterministic scheduler plan. The Activity Feed is presentation, not the authoritative execution ledger.

### A8 — Live completion and whole-extension optimization remain open

The [optimization record](../optimization-part4-baseline.md) explicitly leaves Part 4 in progress. Its ten-generation run used a fresh bootstrap path with automatic post-turn processing disabled. It cannot prove established-story retrieval, learning, retraction, complete background drain or durable-write equivalence. Component replay improvements are valid within their measured scope; they are not a complete before/after story-load benchmark.

The batching/cycle-loan repair has real local orchestration tests across A/B, loans, cancellation, stale input and delivery. Real provider acceptance and the porting map's representative 30-turn run remain unclosed. This audit did not reproduce the repaired loan hang; the relevant current tests pass.

## Current contract matrix

| Contract/system | Current assessment | Evidence or remaining boundary |
| --- | --- | --- |
| Exact story/book runtime isolation | Implemented and tested; no stored violation found | `world-tree/story-binding.js`, `story-view.js`, intake story/source fences; malformed restore needs A3 |
| Separate no-chat book authoring | Implemented; product fixtures pass | Explicit book policy, typed review, resources, journal, organization/layout separation; no live destructive test performed |
| Single durable knowledge owner | Present, with incomplete publication cutover | Canonical read API and native Memory/Character contributors; A1/A2/A5 block clean migration claims |
| Evidence-based growth and relationships | Implemented and regression-tested | Intake, candidates, canonical vocabulary, lineage, containment, tracked perspective memories and edit/swipe/delete tests; long-story live acceptance remains |
| Scene → Hot; cast → Green Room | Connected and tested | Accepted owner state, source/binding fences; final Scene save repair is not yet installed locally |
| Hot/Green temporary state | Follows current contract in tested paths | Chat-keyed overlays, expiry/invalidation and durable-export exclusion; no durable Hot replacement introduced |
| Graph Walker → Hot/Sensory | Connected; execution attribution partial | Synchronous canonical graph adapter, coverage/continuation tests, retained live nominations; nomination count is not delivered Lore count |
| Sensory → Truth → retrieval admission | Connected; not fully observable per candidate | Direct envelope handoff tests; A7 and documented host-coupled wiring coverage limits remain |
| Truth authority versus timing | Partly complete by explicit design | Current-canon/support-only consumer exists; automatic chat-vs-canon producer and campaign occurrence/time producer remain deferred |
| Notebook working state | Implemented with recorded deviations | Evidence citations, revisions/rollback, dynamic main document budget, Hot projection; manual Refresh is a lifecycle task rather than a job row, fixed 700-token cold start, digest UI absent |
| Shared scheduler / A+B physical batching | Repaired and tested locally | Existing bus, collector, leases, owner steps, Gather, queue and typed delivery exercised; real provider/session acceptance open |
| Gather and sealed generation frame | Implemented in tested paths | Ready/stale/late/invalid checks, held results, once-only typed publication and immutable old seals |
| Optional Jev / model access | Intended authority preserved | Registered advisory sites and bounded fallback; no access or provider configuration changed for this audit |
| Consumer Activity Feed | Current design differs intentionally from original PDF | Separate activities, expandable detail and restored status strip; exact-chat filtering and bounded useful history tested |
| Selected-turn diagnostics | Partial | Failure isolation exists; retained/live mismatch and candidate attribution still need A7 |
| Dynamic workload capacity | Converted in several critical paths, not globally closed | Shared budgets and continuations exist; old literal bounds require classification, not bulk deletion |
| Naming/key retirement | Incomplete | 129 production files match `a52`/`tv2`/`TV2`; compatibility keys/contracts need staged migration, not search-and-replace |
| Proposals product expansion | Deferred by user | Existing advisory review plumbing is not authorization to build broader proposal UI or auto-merge canon |
| Entire optimization pass | Incomplete | Missing controlled established-story baseline/final comparison and outstanding instrumentation/UI/persistence work |

## Documentation consistency

There is no trustworthy single current completion index. Important records describe different historical baselines:

- `handoff-after-part-3.md` says Part 4 has not started; the later optimization record supersedes that status.
- `integration/task-7-memory-plan.md` and the early portion of `completion-recheck.md` predate the later native-bank cutover. Their prerequisite status is history, while their acceptance requirements remain relevant.
- Early migration/owner-wiring notes call Builder and resource actions unconnected. Later authoring and repair notes, current host bindings and tests supersede those claims.
- The Truth PDF's grouped feed and single status dot were explicitly rejected by the user. Do not reimplement them to satisfy an outdated document.
- The porting map's durable Hot suggestion and eventual Notebook replacement do not override the later ephemeral-state integration brief and restored rolling Notebook requirement.
- Plain Nexus naming remains an open contract requirement. File-name matches alone do not prove a second scheduler, writer or data leak.
- Manifest/README identify 0.7.5 while `index.js:1244` still logs extension load as 0.7.0 with `legacyFallback:true`. That hard-coded event is poor release evidence; use the verified Git revision for this audit.

Keep historical notes intact. Maintain this assessment and subsequent repair evidence as the current index, recording which requirement a change closes and what remains unverified. Do not manufacture completion by rewriting old evidence.

## Repair order and acceptance

1. **Durable publication first:** close A1/A2 through existing canonical transaction paths, including route/no-op/recovery and Character review/Card sync. Reproduce failure, rollback, crash/reload, stale source and chat-switch cases against the actual migrated owner.
2. **Restore correctness:** close A3/A4/A5 together with valid/malformed restore and same-revision owner/hydration tests. Preserve exact binding and untouched foreign stories. Verify an established chat in a disposable copy before retiring any remaining legacy data.
3. **Trustworthy execution evidence:** close A7 using actual generation-consumed metadata. Verify Scene, Hot, Walker, Sensory, Truth, A/B physical attempts, Gather, learning and host delivery without assigning absent evidence to success or failure.
4. **Complete measured optimization:** fix A6 with save authority preserved, instrument the remaining costs, and compare the established-story script before/after. Deferred work must finish; no feature/model access is disabled or enabled to improve the numbers.
5. **Compatibility and product closure:** finish scoped naming/key migrations and remaining documented controls only after behavior is stable. Keep broader Proposals work deferred.

The installed extension being one commit behind is a deployment observation, not the root cause of A1–A6: those defects reproduce on current GitHub main. Updating alone cannot close this audit.

The next live acceptance should cover a new bound story and a large existing migrated story; explicit no-chat authoring; edits, swipes and deletes; reload during work; A/B batch refill and foreground borrowing; provider failure/cancellation; final tree, memory, Notebook and prompt results. Use copies for mutation tests and include the representative 30-turn run required by the porting map. Direct browser journal/plan-store inspection and multi-tab recovery remain separate coverage items.

## Owner clarification: selected character UID (2026-10-08)

Selecting a character UID in the World Tree must show that character's information and memories in its inspector. Character tracking policy must operate under the hood, rather than appear as the current field-level Tracking Policy checkbox panel. This clarification does not by itself remove the separate choice of which character to track.

At the audited baseline, the inspector rendered source information and graph metrics, while Character State Review separately exposed policy checkboxes and character-linked summaries. That arrangement did not satisfy this requirement.

The subsequent inspector repair adds Character and Memories tabs to the selected character UID, defaulting to Character when first selected. It reads authored character information, canonical story-local character state, relationship connections, personal scene memories, and explicitly linked or uniquely attributed story memories through the bound World Tree facade. It does not write global Lore or create another memory store. The host checks the exact requested chat/book binding again; a different authoring book or no active story cannot receive the current story's character state. Superseded/removed records are excluded; ambiguous name matches cannot borrow another identity's state or name-tagged memories. Failed reads display an unavailable message rather than claiming the memory bank is empty.

The field-level policy checkbox panel is removed. Existing saved policy settings, extraction bounds, review approval authority and the separate choice of which character to track remain in place. Tests cover canonical reads without mutation, both memory paths, authored information before learning, duplicate-name ambiguity, foreign story/book exclusion, changing selection, host-to-renderer integration, and policy controls being absent. An isolated browser smoke check verified the Character tab and expanding a scene memory with its scene and narrative time. This repair does not close the separate A1/A2 durability findings or constitute a live generation/reload test against the installed extension.

## Evidence artifacts

Subsequent implementation: [core repair validation, 2026-10-08](nexus-core-repair-20261008.md) records the A1/A2 persistence repairs, A4 owner-aware caches and the independently reproduced scheduler/Scene repairs. The findings and reproduction results above describe their original baseline. A3/A5/A6/A7 and live acceptance remain open; the later repair does not certify the entire migration.

- Portable aggregate: [nexus-architecture-audit-20261008-evidence.json](nexus-architecture-audit-20261008-evidence.json).
- Local inventory and private saved-data summaries: `C:/Users/cacon/AppData/Local/Temp/nexus-architecture-audit-20261008-inventory.json`.
- Isolated production-module reproductions: `C:/Users/cacon/AppData/Local/Temp/nexus-architecture-audit-20261008-repro.mjs` and `nexus-architecture-audit-20261008-reproductions.json` in that directory.
- Full standalone test log: `C:/Users/cacon/AppData/Local/Temp/nexus-architecture-audit-20261008-tests.log`.

The reproduction harness asserts that the defects exist at the audited revision. Its successful exit is evidence of reproduction, not a passing correctness gate. It replaces host/provider boundaries and runs in a separate process; it never opens or writes the user's story data.
