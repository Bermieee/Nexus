# World Tree Growth Repair Implementation Plan

> **For agentic workers:** Use systematic-debugging and test-driven-development. Independent domains may use dispatching-parallel-agents; integrate and verify together.

**Goal:** Make the existing World Tree reliably grow from story-bound scenes, characters, memories, relationships and summaries, including any newly discovered place connected to its evidenced parent. The owner's room/tavern illustration supplies no hard-coded production names.

**Architecture:** Repair the existing canonical owner and contribution paths rather than add another graph. Carry story binding, source revision, generation identity and continuation through each handoff. A bounded foreground step defers unfinished work; it never silently forgets it.

**Tech Stack:** Native JavaScript ES modules, standalone Node regression files, SillyTavern host.

**Spec:** C:/Users/cacon/Downloads/NEXUS_WORLD_TREE_CONTRIBUTIONS_BRIEF_3.md; C:/Users/cacon/Downloads/NEXUS_INTEGRATION_BRIEF_3.md; C:/Nexus-validation-20261002/porting-map.txt. Audit: C:/Nexus-validation-20261002/VALIDATION.md.

## Global Constraints

- One story remains bound to its own Lorebook. Never resolve or mutate another binding's sources.
- Preserve authored Lore and existing identities; new chat discoveries stay CHAT scoped.
- Jev advises; existing owner review owns changes to canon.
- No UI redesign or new raw-narrative prompt section.
- Keep bounded steps, explicit incomplete coverage and resumable deferred work.
- Do not modify real chat/Lorebook data or make paid calls during offline verification.

## Review Focus

- Chat switches while a Scene decision or contribution is awaiting must reject the old result.
- Edits/deletes while an unresolved edge is deferred must prevent resurrection.
- Departing characters retain their already witnessed but deferred memories.
- Skipping Walker leaves unrelated retrieval channels enabled; nodes beyond display limits remain readable.
- Historical inspector selection and decision lineage survive repeated source revisions.

### Task 1: Restore startup and strengthen the smoke gate

Files: memory/store.js; tools/run-offline-checks.mjs; tests/module-startup-smoke.mjs.
Interface: explicit module parsing of source catches browser-invalid syntax independently of file-mode detection.
- [x] Add a failing real-module parse regression and observe failure on current Memory module.
- [x] Repair the extra brace and make the runner check ES modules explicitly.
- [x] Verify corrected module and reject a controlled malformed fixture.

### Task 2: Contribution identity, binding and growth

Files: world-tree/intake/*; world-tree/store.js; world-tree/scene-contribution.js; world-tree/card-contribution.js; relevant production-envelope regressions.
Interfaces: contribution lineage and captured binding are validated at resolution and commit; pending edges retain their originating contribution; candidate promotion may create CHAT LOCATION and part-of edges.
- [x] Reproduce bound Book A/Book B isolation, source edit before promotion, unresolved cards, and Back room → Ember Tavern growth.
- [x] Repair capture/resolution/commit fences and pending-work lineage without inventing global canon.
- [x] Verify drain/reload, revision supersession, exact canonical relationship vocabulary and unchanged existing-source behavior.

### Task 3: Complete reads and budgeted retrieval

Files: core/world-tree-api.js; retrieval/retriever.js; nexus/a52/sensory/*; nexus/a52/retrieval-channel-registry.js; graph-neighborhood-retriever.js; budget consumers/tests.
Interfaces: canonical lookup is complete; display/query budgets disclose partial work; Walker skip applies to Walker alone.
- [x] Reproduce tail-node absence, depth/edge clipping, nomination loss and Walker-skip channel starvation.
- [x] Repair canonical reads, budget propagation and coverage/continuation paths.
- [x] Verify actual backbone channels and graph query behavior under small/large grants.

### Task 4: Scene and character-memory freshness

Files: nexus/scene-intelligence.js; world-tree/character-memory.js; related tests.
Interfaces: post-await publication checks captured owner/scene/source identity; deferred memory retains admitted witnessed input.
- [x] Reproduce delayed decision during chat switch and witnessed-memory deferral followed by departure.
- [x] Fence Scene commit and retain/revalidate deferred character work.
- [x] Verify edit invalidation, scene closure and no cross-chat publication.

### Task 5: Decision, watch and proposal delivery

Files: decision/records.js; decision/task8-runtime.js; world-tree/decision-records.js; world-tree/watch-list.js; nexus-ui-host.js; producer metadata and owner review consumers.
Interfaces: retain creator/update decision links, normalize generation selection, consume watches only after accepted current entry, stage advice through existing review rather than apply canon.
- [x] Reproduce missing generation, wrong historical selection, lost creator links, Hot-thread shape and rejected-watch consumption.
- [x] Repair correlation/history and proposal consumers; coordinate intake/store changes with Task 2.
- [x] Verify actual producer envelopes, typed review proposals and watch expiry/entry.

### Task 6: Document coverage and integrated acceptance

Files: requirement closure ledger and any remaining document-owned integration seams.
- [x] Reconcile Lore entry delta, growth authority and compatibility migration requirements against final code; implement missing runtime behavior with failing regressions.
- [x] Run the entire standalone suite and explicit ES-module sweep; perform fresh browser startup smoke against corrected code without mutating user data.
- [x] Review combined changes independently, fix material findings and report exact evidence and remaining real-provider acceptance.

## Execution record

The supplied requirements and explicit request to fix their gaps authorize execution. Reuse the existing isolated C:/Nexus-story-binding-repair worktree, updated to main@08a1aa5. Parallel domains own separate files; shared store/intake edits are coordinated. No new design approval is needed for these repairs.
