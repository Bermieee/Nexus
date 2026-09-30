# Task 6 integration ledger

Spec: NEXUS_INTEGRATION_BRIEF_3.md, received after Task 5.
Base: main 4b3b0ee. Tasks 1–5 are already landed; do not repeat them.

The new spec adds dynamic budgets and Decision Core sites. The budget prerequisite is being added separately before 6a. Existing cap conversion remains outstanding: this foundation does not claim that every existing reader already uses it. New scheduler work must report deferred work rather than dropping it. Sidecar concurrency, maximum two providers, watchdog and Green Room TTL remain invariants.

Budget foundation: rolling measured per-unit costs, remaining time and reservations, prompt room, world size and plan multipliers; explicit examined/total/deferred continuation receipts; high sanity ceiling emits an error. Three focused checks pass. No live acceptance claimed.

6a in progress: preserve existing executors, cadence, manual behavior, output shape, failure isolation and summary→promotion→routing ordering. The job table replaces dispatch selection, not subsystem authority. Scene/Green Room remain on their existing path until 6b. Stop after 6a for live parity confirmation.

Hosted baseline: Task 5 World Tree CI succeeded; release validation failed in Offline regression and syntax sweep. User explicitly authorized starting Task 6 with that failure unresolved. It is not represented as green.
