# Task 1 — canonical World Tree reads

Base main: 7125b0fd7f18c2037be759f8c21761541986dfd0, preserved by pre-integration tag.

Production World Tree projection now lives at core/world-tree-api.js. Retrieval, Memory recall, Truth identity resolution and Walker alias normalization import it. Hot anchor/continuity resolution uses retrieval's canonical API. The old module is a compatibility export only; it contains no second implementation or owner. Standalone fixture construction remains available to existing tests, but the canonical production factory returns a frozen read-only facade.

The facade refreshes its indexed projection only when the canonical owner identity or revision changes. Existing readers therefore observe node/alias/status/edge changes and owner replacement. It preserves the existing scope filtering, bounded read limit and candidate identity mapping. No World Tree invariant/schema changes. Legacy import bridges remain ingestion sources; Task 7 governs switching the other family readers.

Verification: World Tree invariant and new reader checks (17 passing); canonical runtime adapter, Truth, Sensory/Walker, Hot and Scene focused scripts passing; syntax checks passing. Hosted CI workflow added for main. Live SillyTavern/UI acceptance deferred by owner; these checks do not claim installed acceptance.

No additional abandoned port-side owner was found in tracked sources. Naming migration is not completed: existing production callers and persistence keys outside this task remain unchanged for subsequent integration work. Task 2 is not started. Stop at Task 1 checkpoint before continuing.
