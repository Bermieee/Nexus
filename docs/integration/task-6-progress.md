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
