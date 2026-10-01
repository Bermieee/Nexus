# World Tree story binding repair — 2026-10-01

The product World Tree is a projection for the active story and its one explicitly attached Lorebook. Globally managed books and the SillyTavern edit picker cannot authorize a read, build, placement, or clear. Missing, inferred, ambiguous, or copied bindings fail closed. The UI exposes the existing durable Story Scope writer through an explicit **Attach Lorebook to this story** action; loading sources never establishes an implicit attachment.

## Root causes and repair

- The legacy bridge imported every globally managed book. It now imports the attached book only and discards an asynchronous import if its captured binding changes.
- Canonical reads exposed all GLOBAL Lore nodes. UI, metadata, node/edge, iterator and Graph Walker compatibility reads now share a revision-cached story projection. The read cache includes the binding and publication, so a same-chat binding change invalidates it even without a tree revision change. Authored source imports remain authoritative owner records; the projection is not another durable store.
- Empty canonical UI reads fell back to legacy rows; UID-only metadata joins and retained Builder previews could expose another book. The fallback and unqualified joins are removed for canonical views; selection and previews must match the binding.
- Builder source admission, context, review actions, publication, recovered receipts and presentation enforce the active story. A same-book receipt copied from another story cannot replay its organization. Parent and edge endpoints are validated before owner publication.
- Trash previously deleted a book-level legacy tree and reimported the corpus. It now submits one story-local organization clear through the Nexus mutation coordinator. Its durable receipt suppresses old organization and layout in the story projection; authored Lore, global legacy trees and other chat metadata are untouched. Refresh and reload cannot revive the cleared organization. A pin save admitted before Trash is rejected if the organization changes before persistence.
- The unused whole-source legacy Tree summarizer is no longer exposed by the installed World Tree host. Reviewed UID summarization remains available.

Binding attachment reuses `configureCurrentStoryScope` and its existing metadata durability barrier. Its optional synchronous preflight runs under that metadata lock, preventing an attachment waiting for admission from overwriting a newer binding. Builder/Trash/layout writes retain the existing Nexus coordinator, approval, lock, journal, recovery and physical persistence path; they do not persist unrecognized review transaction types.

## Verification

- Failing reproductions preceded fixes for cross-book reads, binding cache changes, clear/reload, foreign publication endpoints, legacy UI fallback and colliding UIDs, and the pending-pin/Trash race.
- The binding regression file covers two books with colliding UIDs/aliases; unbound/inferred/ambiguous/copied scopes; foreign chat reads; story-local clear and reload; foreign/placeholder mutation targets; changes while waiting for persistence; copied same-book receipts; explicit single-book attachment; queued attachment supersession; and pending layout writes after Trash.
- Offline run: **73/77 standalone files pass; 536/536 syntax checks pass**. The four failures are `character-review-policy.mjs`, `performance-hotpaths.mjs`, `prompt-loader-adapters.mjs`, and `summary-digest-coverage.mjs`. All four were independently reproduced on unchanged `main@8fd5d10`; this repair adds no failing file. Final attachment guard changes also passed the binding/Lore UI and host binding focused checks.
- Read-only review found and drove fixes for legacy UI fallback, retained preview, inferred binding admission, copied receipt replay, an obsolete summary endpoint, and pending layout/attachment races.
- Local evidence: `C:\Nexus-story-binding-evidence-verified\report.json`; original baseline failure logs: `C:\Nexus-story-binding-evidence-release\baseline-*.log`.

Live SillyTavern acceptance has not been performed, and no live Trash operation or authored Lore deletion was executed during investigation. After updating, verify the displayed book matches the current story, clear its organization, refresh/reload, and build again. Switch to another story and confirm its own attached book and organization remain separate.
