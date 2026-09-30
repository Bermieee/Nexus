# Task 7 — Memory parity prerequisite

Authority: NEXUS_INTEGRATION_BRIEF_3.md Task 7. Base main305e16e. User authorized continuation after Task6c.

Intent: Memory must read through the canonical World Tree without losing hierarchy, routing, source or protection metadata. Memory writers remain the legacy/import authority during the migration. Do not switch Characters/Lore here; do not change World Tree node kinds, scopes or temporal rules, add UI/toggles, or infer live acceptance from deterministic tests.

1. Inventory Memory knowledge readers versus writer/transaction control reads. Record consumers and the live-cutover boundary.
2. Preserve the full legacy owner record inside the existing MEMORY node data payload. Make the import fingerprint include those fields so bookkeeping-only changes refresh correctly. Reconcile removed source records as retained, explicitly superseded audit nodes; do not delete canonical history.
3. Add a scope-filtered lazy node iterator to the existing owner read API. Parity must examine every Memory record, not the capped UI projection.
4. Add a pure record parity comparator: full field agreement, missing/extra records, temporal agreement and story isolation. Receipts contain counts and bounded IDs/field names only, never story text.
5. Wire pre-import and post-import parity into the existing legacy World Tree bridge and existing Gather Diagnostics channel. No additional model calls.
6. Verify missing metadata, metadata-only edits, deletions/restore, unrelated-story isolation, full iteration, serialization/reload, and metadata-only Diagnostics.
7. Commit/push the parity prerequisite. Stop for a real-chat parity receipt before any all-reader cutover. The full Memory migration is not complete at this prerequisite checkpoint.

Reader inventory: recall candidate selection/freshness; summary eligibility/hierarchy; Lore routing; Character review; paging and embeddings; UI Memory projection/inspection; owner diagnostics; explicit export. Several still read getMemoryStore().records directly. Writer/transaction previews and durability checks also consume getMemoryStore and must remain owner-side source operations. The Task7 cutover must migrate knowledge reads together, not replace the mutable writer API wholesale. Control metadata (coverage receipts, active-layer membership and summarized pointer) needs parity alongside record payloads before that cutover.
## Parity prerequisite checkpoint

Implemented complete-record preservation and fingerprints, uncapped lazy reads, explicit source-removal supersession, record comparison before/after installed imports, and sanitized Gather receipts. No Memory knowledge reader has switched yet. Control metadata remains explicitly NOT_YET_COMPARED; a record PASS does not authorize cutover.

Verification: focused Memory/World Tree/Diagnostics checks 25/25 pass. Offline checks 50/54 files and 490/490 syntax pass. The four unchanged failures are character-review-policy, performance-hotpaths, prompt-loader-adapters and summary-digest-coverage, which still assert removed legacy UI modules/startup behavior. No new failing file. Live chat parity and hosted CI remain unverified.

Next: compare active-layer membership, coverage receipts and summarized pointer before switching all Memory knowledge readers together. Retain legacy writer/import authority. Characters and Lore remain untouched by this phase.
