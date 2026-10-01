# Selected Lorebook Builder repair — 2026-10-01

Builder now accepts one explicitly selected, loaded Lorebook without an open chat. The toolbar offers **Lorebook to build → Load selected Lorebook → Builder → Approve**. Selecting or loading a book does not attach it to a story or authorize generation to read it. Runtime World Tree, retrieval and generation retain the existing one-story/one-bound-book projection.

## Authoring and persistence

The authoring host projects only the selected book into a local World Tree view. It reads complete authored source bodies and the book's saved organization. Book policy is checked before reads and writes. Disabled entries remain authored but are excluded from Builder work.

Approved organization and layout are persisted in that book's existing Nexus Tree asset through the canonical mutation coordinator, using a typed Lorebook operator review, the Tree resource lock, expected pre-image, recovery journal and verified settings persistence. No authored entry content is rewritten by Builder or Trash. Other books and chat metadata are untouched. This book-authoring authority is separate from runtime story authority; the picker lists book names and never imports all enabled books into a shared generation corpus.

Trash saves an organization-cleared marker, removes layout, resets presentation state and renders a blank canvas with an explanatory message. Source inventory stays available for Builder; refresh/reload cannot automatically redraw a replacement tree. Approving a reviewed build clears the marker and publishes the reviewed organization and layout.

Build plans use a stable book identity so reviews survive refreshing the same book and reconstructing the host. Source fingerprints and the organization pre-image reject stale plans. Independent transient selection tickets reject reads and writes admitted before a selection change, including A → B → A. Layout recovery compares its organization receipt against the original organization fingerprint, rather than a subsequently reviewed layout fingerprint.

## Analysis defects repaired

- WORLD was emitted as a category with itself as parent, creating a self-cycle. It remains the structural anchor and is excluded from category output.
- The semantic pipeline's consolidated draft-review step was bypassed. Complete unambiguous drafts now advance through quality review and validation before outer review; ambiguous/incomplete analysis reports a pause and cannot be approved.
- `validateOnly` was passed only in metadata and overwritten by its false default. It now reaches the actual pipeline input, preventing the analysis pass from creating legacy commit artifacts.
- Successful resumed analysis retained its previous failure. Successful review clears that error.
- The toolbar announced a ready proposal for paused analysis. Notifications now reflect the returned phase. Approve also accepts a reviewed replacement layout.

## Verification and limits

Twelve book-authoring regressions cover no-chat build/apply, actual toolbar load/build/approve, disabled sources, external edits, refresh, host reconstruction, selection fencing, reapproved layout, durable clear/reload, blank rendering and truthful paused notifications. Four actual semantic-pipeline regressions cover root mapping, quality validation, ambiguous analysis, validate-only behavior and resumed errors. Review independently reproduced the three authoring edge cases before repair and reran them successfully afterward.

The complete offline run passes **75/79 standalone files** and **540/540 syntax checks**. The four failing files are `character-review-policy.mjs`, `performance-hotpaths.mjs`, `prompt-loader-adapters.mjs` and `summary-digest-coverage.mjs`; each was independently rerun and failed on unchanged `main@8acbf50`. Evidence: `C:\Nexus-book-authoring-evidence-final\report.json` and the corresponding `main-*.log` files.

Live SillyTavern/provider acceptance has not been run. No live book was trashed, rewritten or deleted during verification. Merge scanning and UID summarization retain their existing story-authorized workflows; this change covers Builder, Trash and layout authoring.
