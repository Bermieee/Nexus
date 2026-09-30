# Task 6 integration ledger

Spec: NEXUS_INTEGRATION_BRIEF_3.md, received after Task 5.
Base: main 4b3b0ee. Tasks 1–5 are already landed; do not repeat them.

The new spec adds dynamic budgets and Decision Core sites. The budget prerequisite is being added separately before 6a. Existing cap conversion remains outstanding: this foundation does not claim that every existing reader already uses it. New scheduler work must report deferred work rather than dropping it. Sidecar concurrency, maximum two providers, watchdog and Green Room TTL remain invariants.

Budget foundation: rolling measured per-unit costs, remaining time and reservations, prompt room, world size and plan multipliers; explicit examined/total/deferred continuation receipts; high sanity ceiling emits an error. Three focused checks pass. No live acceptance claimed.

6a implemented: the registered lifecycle table now supplies the Director planner and dispatches existing post-turn review, notebook, smart-warm, housekeeper and the ordered summary→promotion→Lore-routing branch. Executors retain their cadence, manual mode, freshness and lease authority. Summary stage boundaries yield checkpoints while retaining the branch's original conflict lease. Inputs are captured before dispatch; table jobs run in priority-ordered layers of two with a host yield between layers. Results retain the old public ordering and shape. Existing GatherCoordinator validates before row publication. Scheduler selection and gather verdict metadata reach the existing Scatter/Gather Diagnostics channels.

Important stage boundary: Scene/Green Room remain on their old path until 6b, so the two-job invariant currently covers the migrated table, not that legacy path. Routing/failover and the borrowed background state machine are not claimed complete. Checkpoints currently exist only inside a run; cross-opportunity resumption belongs to 6c. Subsystem-internal provider orchestration remains owner code, not a newly rewritten transport. Existing manual summary-backlog guard and other legacy caps remain outstanding for dynamic conversion; the budget foundation is not a claim that those readers are already converted.

Verification: new table, lease-step, planner, actual lifecycle host-stub parity and budget tests pass. The actual lifecycle check proves automatic/manual outputs, summary dependencies, disabled jobs and independent failure isolation; it fails under the old five-job dispatch. No real SillyTavern acceptance claimed. Stop at 6a for live parity confirmation; 6b and 6c have not started.

Offline sweep: 43/47 test files passed, 479/479 syntax commands reported success. The four red files are character-review-policy.mjs, performance-hotpaths.mjs, prompt-loader-adapters.mjs and summary-digest-coverage.mjs. Three read removed memory/ui.js or activity-feed.js. Prompt-loader initially failed on a missing comma in generation-frame-contract.js, already present at 4b3b0ee. A separate production fix restores module import; that test then reaches an obsolete initActivityFeed startup-order assertion. All four test expectations are preserved, not weakened. Note that node --check did not expose the missing comma in this environment; successful syntax commands alone are weaker than an actual module import.

Hosted baseline: Task 5 World Tree CI succeeded; release validation failed in Offline regression and syntax sweep. User explicitly authorized starting Task 6 with that failure unresolved. It is not represented as green.

## 6b — Scene and Green Room

User authorized continuation after 6a. Base f9e2f70.

Scene observation and Green Room inference now have separate registered post-turn rows. Scene has boundary priority; Green Room depends on Scene finishing. Both share the same two-job dispatch as the existing rows; the patched parallel Scene branch is removed. Scope checks precede execution and owner writes. The old public lifecycle result groups Scene/Green Room in its original first slot.

The planner selects both on MINOR/MAJOR, skips both on NO_CHANGE, and can refresh Green Room when its existing TTL expires. The TTL condition stays strictly greater than the stored TTL, matching the owner. A source edit/swipe invalidates dependent state first and selects only the affected message for Scene observation. Edit requests use the existing quiet lifecycle timer, retain their target identities and wait during active generation. Chat changes clear pending requests through the existing cancellation path; stale scopes never rebind to a new chat.

Installed gap fixed: generation-end and a reply received after generation-end schedule Scene/Green Room independently of whether the Director handled post-turn review. Edit/swipe cycles do not invoke unrelated review/summary/maintenance work. Late Scene observation cannot overwrite a replaced Scene; Green Room admission checks both Scene id and revision, since a replacement can restart its revision number.

Verification: 80 focused checks passed, covering earlier integration plus gate selection, dependencies, installed boundary dispatch, edit queuing, stale provider results and TTL. Real SillyTavern acceptance and hosted exact-head CI remain unverified. Existing subsystem capacity caps are not claimed converted by this scheduling migration. Decision Core registration belongs to Task 8; no direct Jev calls were added.

Broader 6b offline run: 45/49 files pass, with the same four obsolete UI-related failures named above. No new failing file. All 481 syntax commands passed. Subsequent metadata/input-capture adjustments passed the 28 directly affected checks. Scheduler receipts preserve selected job ids and rule reason codes; no story text is emitted.

Stop at 6b checkpoint. Borrowed background sidecar and cross-opportunity resume remain 6c and are not started.
