# Selected Lorebook Builder repair — 2026-10-01

Builder now accepts one explicitly selected, loaded Lorebook without an open chat. The toolbar offers **Lorebook to build → Load selected Lorebook → Builder → Approve**. Selecting or loading a book does not attach it to a story or authorize generation to read it. Runtime World Tree, retrieval and generation retain the existing one-story/one-bound-book projection.

## Authoring and persistence

The authoring host projects only the selected book into a local World Tree view. It reads complete authored source bodies and the book's saved organization. Book policy is checked before reads and writes. Disabled entries remain authored but are excluded from Builder work.

Approved organization and layout are persisted in that book's existing Nexus Tree asset through the canonical mutation coordinator, using a typed Lorebook operator review, the Tree resource lock, expected pre-image, recovery journal and verified settings persistence. No authored entry content is rewritten by Builder or Trash. Other books and chat metadata are untouched. This book-authoring authority is separate from runtime story authority; the picker lists book names and never imports all enabled books into a shared generation corpus.

Trash saves an organization-cleared marker, removes layout, resets presentation state and renders a blank canvas with an explanatory message. Source inventory stays available for Builder; refresh/reload cannot automatically redraw a replacement tree. Approving a reviewed build clears the marker and publishes the reviewed organization and layout.

Build plans use a stable book identity so reviews survive refreshing the same book and reconstructing the host. Source fingerprints and the organization pre-image reject stale plans. Independent transient selection tickets reject reads and writes admitted before a selection change, including A → B → A. Layout recovery compares its organization receipt against the original organization fingerprint, rather than a subsequently reviewed layout fingerprint.

## Analysis defects repaired

- WORLD was emitted as a category with itself as parent, creating a self-cycle. It remains the structural anchor and is excluded from category output.
- The semantic pipeline's consolidated draft-review step was bypassed. Complete unambiguous drafts now advance through quality review and validation before outer review. Ambiguous placements and category expansions open an explicit placement review; they cannot be published until the operator chooses dispositions and the resulting preview passes quality and validation.
- `validateOnly` was passed only in metadata and overwritten by its false default. It now reaches the actual pipeline input, preventing the analysis pass from creating legacy commit artifacts.
- Successful resumed analysis retained its previous failure. Successful review clears that error.
- The toolbar announced a ready proposal for paused analysis. Notifications now reflect the returned phase. Approve also accepts a reviewed replacement layout.

## Verification and limits

The follow-up fixes the reported `1 ambiguous source(s), 2 proposed category expansion(s)` dead end. The UI presents placement/category choices, explicit deferral/exclusion, continuation to preview, cancellation and analysis refresh. An exclusion preserves authored content and is recorded separately from unresolved coverage. Pending and provider-paused runs are restored on explicit source loading; **Resume analysis** continues the saved run. Semantic review retries must match the exact saved accepted decisions. Source edits allocate fresh semantic analysis revisions rather than reopening stale runs. Legacy no-chat records are recovered only for their one qualified source book.

The starting picker lists readable host Lorebook names, including unmanaged books, without reading their contents. Only an explicitly loaded book is enabled for authoring. Placeholder selection leaves Load disabled. **Create Lorebook** uses SillyTavern's native non-overwriting creation capability, rejects invalid or colliding names, and loads the new empty book without changing a story binding. Add authored entries through SillyTavern World Info, then refresh that source before building. Book model-worker requests use independent transport scope; ordinary story requests retain chat scope. Publication still checks source, book and organization authority.

The actual semantic-pipeline regressions cover ambiguity/category approval, deferral versus exclusion, stale tokens, source edits, unchanged-provider-work continuation, crash/reload restoration, legacy paused recovery and exact accepted-review retry. Product regressions exercise no-chat load/build/approve, fresh-book controls, restored placement review and paused-run continuation, in addition to the existing authoring isolation and Trash checks. Independent review reported no remaining actionable findings and passed 85 focused/adjacent tests.

The complete offline run passes **77/81 standalone files** and **544/544 syntax checks**. The four failing files are `character-review-policy.mjs`, `performance-hotpaths.mjs`, `prompt-loader-adapters.mjs` and `summary-digest-coverage.mjs`; each was independently rerun and failed on unchanged `main@55fd74d`. Evidence: `C:\Nexus-placement-review-evidence-final\report.json`; baseline logs: `C:\Nexus-placement-review-evidence\baseline-*.log`.

Browser verification used the actual product surface and real semantic pipeline with isolated fixture sources and an offline model boundary: no-chat selection/load → one ambiguous placement/two proposals → explicit choices → validated preview → Approve; fresh empty-book controls also worked. On the real installed SillyTavern, no-chat selection and loading were verified read-only. Live provider acceptance and live native book creation were not exercised. No live book was trashed, rewritten or deleted. Merge scanning and UID summarization retain their existing story-authorized workflows; this change covers Builder, Trash and layout authoring.
