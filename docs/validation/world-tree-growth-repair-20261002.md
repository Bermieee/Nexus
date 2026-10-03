# World Tree growth repair

Requirements: `NEXUS_WORLD_TREE_CONTRIBUTIONS_BRIEF_3.md`, `NEXUS_INTEGRATION_BRIEF_3.md`, and the Nexus ← Area-52 porting map supplied by the owner. Baseline: `main@08a1aa534fa1b1e7e2fe3efdfa53c0e6db166d24`. The independent audit is saved in `C:/Nexus-validation-20261002/VALIDATION.md`.

The owner requested repairs so characters, scenes, memories, relationships, events, summaries and discoveries can grow the existing World Tree. The tavern/room screenshots are illustrative. Production behavior uses source evidence and story identity; it does not contain those example locations as presets.

## Runtime contracts

- One story's binding fences resolution and publication. A public read facade alone is not a write fence. Binding, chat and source identity are captured and rechecked after asynchronous work.
- New story discoveries stay chat-local. Explicit containment connects a discovered place to its evidenced parent; travel chronology alone does not establish containment.
- Message edits, swipes and deletions invalidate deferred evidence and supersede committed observations. They must not turn retained display values or cleanup operations into fresh evidence.
- Deferred edges retain their original source lineage. Deferred card work and witnessed character-memory input survive reload and finish through the existing intake.
- Canonical lookup is complete; a display budget cannot make an existing identity appear missing. Query grants disclose incomplete coverage and preserve resumable work.
- Skipping Walker leaves other retrieval channels available. Prompt room, sibling reservations and measured costs feed the budget plan.
- Background continuation uses the existing cooperative scheduler. It stages source-validated working results; it never changes a sealed prompt or writes graph canon.
- A new question or generation may reuse relevant evidence from an earlier delivery. Continuation accounting cannot hide fresh nominations.
- Lore edits reconcile changed UIDs and affected structural controls through intake. Initial import, explicit rebuild and migration may still import the full bound book. The SillyTavern source API still returns a whole book; semantic reconciliation is incremental.
- Watches describe possible future presence. Matching a name does not consume one. Entry is recorded after accepted current Scene presence; historical co-presence does not count.
- Decision records preserve origin generation, evidence, budget and creator/update links. Historical inspector selection reads the requested generation.

## Advisory owner review

Reflection, ambiguous identity and supersession advice now enter the existing proposal store rather than end at telemetry. Negative choices do not stage work. Independent support alone is insufficient for reflection: the dimensional readings must be compatible.

These proposals store reviewed advice through the existing `metadata.set` owner transaction. Approval does **not** merge identities, supersede canonical facts, promote discoveries to global lore, or settle an inferred reading as canon. Those actions require a separate owner-approved canonical operation. No new proposal UI or automatic canonical writer is introduced.

## Regression evidence

The repair adds production-module tests for startup, bound-book isolation, queued source invalidation, revision lineage, containment, card continuation, Lore deltas, witnessed character memories, watch transitions, generation correlation, canonical tail reads, runtime budget grants, foreground reservations, graph continuation and background publication.

The offline runner explicitly parses every JavaScript module as an ECMAScript module. The previous file-based syntax sweep missed a browser-invalid extra brace in Memory. Hosted World Tree validation now runs that strict gate and the new production-envelope regressions.

Frozen combined verification: **109/109 standalone test files** and **607/607 explicit ECMAScript module parses**, exit 0. Evidence: `C:/Nexus-validation-20261002/repair-final-verified/report.json`, dated `2026-10-03T03:05:55.357Z`. The independent reviewer additionally ran all 13 repair regression files: **104/104 tests**, with no remaining Critical or Important findings in the repair scope.

The first combined pass exposed an obsolete Scatter/Gather test that required the exact pre-measurement call spelling. Its replacement executes the actual production bootstrap/Memory callbacks and asserts generation identity, scheduler-context forwarding, and measured budget reservation. Eventual tail coverage remains asserted; new-query reuse tests replace the incompatible assumption that fresh evidence should rotate out permanently.

Review repairs additionally cover committed-memory cleanup through the real drain, current and historical Scene retraction, new-question/new-generation graph re-emission, removed Lore target status, lazy graph preparation with 4,000 duplicate aliases, shared-card book rebinding, and rejection of unscored explicit inferred nodes. Bounded graph preparation reports unknown totals until examination completes rather than inventing a complete count.

Fresh browser startup passed against installed code commit `64209bf0f23427fdeb40e7c8dd4145f8adef73ba` at `http://127.0.0.1:8000/`. SillyTavern finished initializing, Nexus mounted its navigation and World Tree panel, and the unbound view reported zero nodes with no Lorebook selected. The Lorebook selector populated without opening a chat. Browser warning/error inspection contained no errors and one host warning: `saveChat called without chat_name and no chat file found`. No chat was selected, no Lorebook was loaded or changed, and no generation or paid provider call was requested. This confirms startup, not live growth acceptance.

## Explicit remaining acceptance

- Run the finished build in a copy of a large existing chat. Check migration backup/parity, tracked characters, perspective memories, prompt delivery, edits/swipes/deletes, reload, growth and selected-generation inspection.
- Exercise real providers, timeout/cancellation/failover and at least 30 real turns as requested by the porting map. Offline fixtures do not prove this acceptance.
- Full `a52`/`tv2` naming and stored-key migration remains a separate coordinated compatibility change. It is not claimed complete by this repair.
- Full legacy-bank retirement remains subject to the existing migration acceptance. Touched importer compatibility is tested; a real-save end-state transition is not inferred from those tests.

UI redesign/animation and semantic tuning are outside this repair. Budget boundedness and mutation correctness are in scope and were reviewed. No real chat or Lorebook data and no provider configuration were changed during offline verification.
