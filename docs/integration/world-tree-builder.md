# Canonical World Tree Builder

Builder now organizes selected Lore inside Nexus's existing canonical World Tree and previews a separate organic layout. It no longer creates an independent Lorebook tree. The finished transplanted Lore workspace remains the product surface; Merge and the UID Summarizer retain their existing owners.

## Operator flow

Load the World Tree source, open Builder, and analyze its placement. Review category labels, source placements, unresolved identity candidates, any relationship proposals, and layout warnings. Dragging a preview node changes the proposal's pins only. Apply approves the exact proposal fingerprint, commits story organization through Nexus's existing mutation coordinator, then publishes presentation separately.

The installed action selects the complete canonical inventory for the chosen book, rather than the UI's bounded snapshot. Opening Builder discovers unfinished runs for the active story. Committed/cancelled runs allow another build. Stale analysis can be refreshed, retaining labels, pins, and placements/dispositions for unchanged sources where their parents remain valid. All refreshed proposals require approval again.

Organization survives layout failure. Retry never repeats an organization commit. If presentation changed, Review refreshed layout creates another presentation proposal requiring approval. Lost plan outcomes recover from the durable organization receipt. A committing run without a matching receipt remains blocked pending canonical transaction reconciliation; it is not blindly replayed.

## Ownership and persistence

- Authored Lore retains its book-qualified UID, content, provenance, and temporal state. Story organization uses scoped navigation edges instead of rewriting global authored parents. Existing global/foreign category and edge identities cannot be replaced by story proposals.
- Organization references live in story metadata `nexusWorldTreeOrganizationV1`, committed through the existing ledger/coordinator and projected idempotently into the singleton World Tree. Owner reads hydrate this projection before retrieval/Scene/UI use, independently of opening Builder.
- Presentation lives separately in `nexusWorldTreeLayoutV1`. Partial selections retain unrelated saved coordinates and pins. The planner uses weighted branches and deterministic variation, preserves pins, and bounds collision work.
- Plans use the existing durable Builder storage backend in a separate namespace. Every record transition advances a record revision; locked compare-and-swap prevents late approval from resurrecting cancellation. Cancellation aborts active analysis and cannot claim to cancel an admitted commit.
- Missing durable storage disables Builder capability without preventing unrelated Nexus UI from mounting.

## Design rulings and costs if wrong

1. Native PowerShell progress setup replaces Unix helper scripts on this Windows host. Cost: tooling portability; no product behavior change.
2. An ordinary Git worktree provides isolation because the desktop worktree tool targets a different calling workspace. Cost: cleanup is manual; source ownership is unchanged.
3. Global authored nodes receive story navigation placement rather than story-specific global parents. Cost: canonical readers must respect scoped placement; prevents another story's organization changing.
4. Existing recoverable `metadata.set` is the durability authority for organization references, with an idempotent canonical projection. Cost: hydration remains mandatory and is now attached to owner reads; there is no separate competing knowledge store.
5. The production owner assembly and inline review console were added; planned layout belongs to the reviewed fingerprint and preview drag never changes live pins. Cost: changes to layout require renewed approval.
6. Builds remain story-scoped. Global authored-tree reorganization and new Scene/card extraction pipelines are excluded. Cost: this release does not offer a global destructive reorganization action.
7. Final review prompted one consolidated correction pass for identity ownership, presentation preservation, record CAS, stale analysis, persisted-run discovery, pending layout review, owner hydration, complete selection, preview information, and missing-storage isolation. No second reviewer was dispatched. Cost: acceptance still requires a real-host run.

## Validation and remaining acceptance

The focused Builder/UI/diagnostics/UID-Summarizer checkpoint passes 68 tests. The final offline report is stored under `C:/Users/cacon/AppData/Local/Temp/nexus-world-builder-land-20261001`: 71/75 test files pass and 530/530 syntax checks pass. Earlier and final pre-landing runs retain the four known baseline failures: `character-review-policy.mjs`, `performance-hotpaths.mjs`, `prompt-loader-adapters.mjs`, and `summary-digest-coverage.mjs`. They were not represented as green or repaired by this feature.

The tests exercise the actual controller, operator adapter, console and SVG renderer with injected analysis/persistence boundaries, plus production host capability and complete source inventory. The real provider-backed assembled analysis path and real SillyTavern/browser durability have not been live-tested. Verify analysis, Apply, reload recovery, story switching, and pin persistence in the installed extension before treating live acceptance as complete.

No minor final-review findings were deferred. Existing baseline failures and future Scene/character-card extraction remain separate work.
