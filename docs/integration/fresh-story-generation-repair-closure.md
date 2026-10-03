# Fresh-story generation repair closure

Date: 2026-10-03. Implemented directly by the primary agent in `C:\Nexus` on the existing `main` branch, following the user's instruction to take over from the worker.

- Starting main: `14b60bef37a5d9cb140b5c7afdbd311e1e26f530`.
- Repair code commit: `81176288fc536573237dc86af8a471d6b356039e` — `Repair fresh-story generation ownership and diagnostic plumbing`.
- This closure is a subsequent documentation-only commit. Its hash can be obtained from `git log -1 --format=%H -- docs/integration/fresh-story-generation-repair-closure.md`.
- No new branch/worktree or delegated worker. No push, merge, installation, paid model calls, live settings changes, or user story/book/card mutations.
- Installed extension remains at `14b60be`; local implementation is not a claim of real-host acceptance.

## Evidence and scope

Investigated the fresh Ainz chat's first and second generations from `Nexus-Diagnostics-20261003-005933.json`/`005934.zip` and `Nexus-Diagnostics-20261003-010201.json`/`010202.zip`.

The saved chat had no explicit `tv2_story_scope_v1` binding. The second generation delivered the prior Scene and a larger notebook, so that working Scene-to-next-turn handoff was preserved. Retained errors were not counted as unique new defects. Absent second-turn learning settlement was not fabricated into a failure, and an empty young world was not filled with invented canon.

## Repairs and demonstrated causes

### 1. Diagnostic isolation and truthful status

A valid generation identity plus a throwing frame diagnostic reader previously caused the selected-turn aggregation itself to throw, before its per-owner isolation wrappers ran. Independent Gather and observed host-delivery evidence was lost.

`nexus-ui-bindings.js` now isolates the initial frame/selection reads, preserves independent host delivery, and collects the packet-hash read failure before freezing failure metadata. The selected-turn result degrades with identified failed readers while retaining healthy evidence. Existing isolation for a Hot exception remains intact.

The Runtime projection now retains failed jobs and required fallback counts. An admitted fallback remains an admitted fallback; it does not make failed retrieval green. Learning `FAILED`/`PARTIAL` is degraded, disabled/skipped work remains idle, and pending work remains working.

Regressions: `tests/nexus-diagnostics-owner-wiring.mjs`, including the original failing frame-reader fixture, existing Hot failure, learning status variants, and actual Scatter/Gather fallback projection.

### 2. Actual Hot revision and consumed generation evidence

The installed Hot adapter constructed its runtime without a World Tree revision provider. A fresh owner at revision 1 therefore produced a Hot snapshot at revision 0. The regression reproduced this mismatch using the production context/binding provider.

`nexus/hot-cognition.js` supplies the actual owner revision during construction/reset and checks owner changes on activation/hydration. Its existing narrow raw-owner working-state path is preserved; the general ephemeral API was not made raw-owner-backed.

The notebook publisher now captures the actual Hot snapshot it consumed in the existing typed notebook outlet. `readGenerationFrameHotSnapshot()` reads that captured input for the applied generation. `nexus-ui-host.js` uses it for selected-generation diagnostics instead of labeling a later live snapshot as consumed evidence. It validates chat/world/Scene identity. The consuming frame's source fence and the original Hot input references are kept separately; the existing UI source fence still rejects incompatible queries.

The capture remains in the current generation frame only. This does not create a durable Hot history or make arbitrary old turns inspectable after their frame is replaced.

Regressions: `tests/ephemeral-working-state.mjs`, `tests/generation-hot-evidence.mjs`. They cover actual notebook publication, post-publication live changes, clone safety, foreign chat, wrong world/Scene revisions, incompatible source fences, binding appearance/replacement/removal, chat switch, owner replacement, reset, and legacy hydration. Existing full Hot tests also pass.

### 3. Empty Green Room / Character Bank publication

The Green Room working-store proxy writes back after nominal store reads. With a configured production context provider, reading an empty unbound projection/metrics could attempt a binding-protected write. A valid empty state could therefore fail the Character Bank generation outlet.

`nexus/green-room.js` projects the empty case without proxy writeback and obtains diagnostic metrics from a plain imported snapshot. Clear/reset/switch do not invoke proxy mutation first. Tracking reads use the exact bound World Tree facade rather than the raw owner's potentially foreign cast.

The adapter tracks the facade's scope key, clears prior inference when binding changes, and rechecks the captured key before and inside asynchronous owner publication. An old-book result cannot populate a replacement binding even when the facade object itself is unchanged.

The actual `settleGenerationFrameSubsystemOutlets()` and typed Character Bank port are exercised with the repaired Green Room and a disposable empty bank: publication is accepted with status `empty`, rather than failing a protected write. A real Character Bank exception remains a failed outlet.

Regressions: `tests/ephemeral-working-state.mjs`, plus existing Character Bank, Green Room, story-binding and integration handoff suites. No canonical mutation guard was weakened.

### 4. Retrieval corpus and exact attachment

The legacy corpus authority could select a book through an inferred single-book scope while the canonical World Tree facade correctly refused the same unbound chat. This mismatch was reproduced. Story-purpose corpus selection now requires `worldTreeStoryBinding()` and filters to that exact book. Missing binding is an ordinary skipped retrieval with reason `story-unbound`; it is not an automatic import or an excuse to combine enabled books. Maintenance/authoring selection remains separate.

The real Story Scope service and `attachWorldTreeStoryBook()` were verified in a disposable host fixture: explicit attachment persists only the chosen book, survives metadata reload, and fails closed when metadata is copied to another chat. Attachment already worked and was not replaced with implicit binding.

Regressions: `tests/fresh-story-corpus.mjs`, existing foreground retrieval, story-binding and subsystem plumbing suites, and the fallback diagnostic regression.

**Evidence limit:** the retained live capture does not contain the precise original foreground retrieval exception. The corpus/facade mismatch is independently reproduced and repaired; the original live failure still requires a new post-install capture to confirm resolution. It is not claimed to have been proven by a fabricated error trace.

### 5. First-generation learning startup

Lifecycle `beginCycle()` called `setLastCycleId()`, which writes the canonical Memory store, before entering any actual learning steps. On a fresh story without Memory migration/binding this throws `NexusWorldTreeMigrationRequired`, explaining the reproduced zero-step/no-returned-cycle failure shape.

Lifecycle cycle identity remains with its existing operational scheduler owner. Startup no longer writes it into canonical Memory. With the real Memory store in the fixture, the old write is demonstrably blocked and permitted Scene processing now proceeds without inventing Memory records or attaching a book.

`createLifecycleLearningReceipt()` exposes safe reason codes, failed step names and exact step counts for settlement. It excludes exception messages and provider payloads. Terminal cycles retain the error's name for this projection. Partial failure does not erase successful Scene work; pending/disabled states are not represented as successful learning.

Regressions: `tests/scheduler-lifecycle-parity.mjs` and diagnostic learning tests. Existing lifecycle leases, disabled processing, Scene freshness, and World Tree contribution suites pass. Those existing contribution suites retain weak-evidence waiting, accepted contribution/replay/reload/isolation behavior; no production growth policy or story canon was changed.

### 6. Jev execution accounting

The live second generation contains returned native `truth.intent` advice (`tv2_evt_1791003645724_1400`) while the selected-turn summary reports zero optional attempts. The summary read optional-resource registry execution rows, whereas this call used the native decision path. Additionally, Wave 8 normalization stripped explicit physical-attempt/return and identity fields before the journal saw the receipt.

Wave 8 now preserves explicit physical proof and identity. The evidence journal accepts a native Jev attempt only with its receipt ID, affirmative `physicalAttempt`, exact chat/turn/generation, and compatible revision fence. It deduplicates a matching registry execution. Configuration, inferred invocation, unrelated-turn advice and qualification probes do not create selected-turn native attempts.

Returned advisory execution does not grant owner acceptance or settlement. The native entry remains identified as `TYPED_ADVISORY` with owner acceptance unproven. This is evidence accounting for the retained decision receipt, not enumeration of every provider call: the raw pipeline's cumulative counts and a bounded selected-turn receipt are distinct measurements.

Regressions: `tests/jev-selected-turn-plumbing.mjs`, using the actual decision engine/producer, host wiring, Wave 8 normalization and selected-turn journal/summary. Existing timeout/cancellation/terminal-lease checks remain green in the offline suite.

## Verification

Original failing regressions and successive repair logs are retained under:

`C:\Users\cacon\Documents\Codex\2026-09-24\files-pasted-by-the-user-area\outputs\nexus-diagnostics-20261003`

On repair code commit `81176288fc536573237dc86af8a471d6b356039e`, the supported `tools/run-offline-checks.mjs` gate completed:

- **111/111 standalone test files passed.**
- **609/609 ES module checks passed.**
- Evidence: `verified-code-head-offline/report.json` and per-file logs in that output directory.
- `git diff --check` / staged whitespace verification passed for the final repair.
- Hosted GitHub Actions and real SillyTavern acceptance were not run.

## Remaining live acceptance

After separately authorized installation/publication, explicitly attach the intended book if the story remains unbound, then run first/second generations and capture diagnostics after lifecycle settlement. Confirm:

1. Empty Character Bank state publishes normally; a real error retains its reason.
2. Scene and notebook continuity reaches the next prompt; selected Hot evidence names the consumed generation and actual revisions.
3. Unbound retrieval skips clearly; bound retrieval either succeeds or retains the actual error and any fallback separately.
4. Learning settlement carries a cycle ID and safe reason/step evidence when appropriate; disabled processing stays disabled.
5. Native Jev physical evidence reaches the selected-turn summary without being mistaken for canonical settlement.
6. Canonical world growth follows accepted story-local evidence over time; no node is required on every reply and other stories remain isolated.

The original retrieval exception and real-host acceptance remain open until those captures exist. No user's world was populated or modified to manufacture a passing result.

## Follow-up: 2026-10-03 10:57 diagnostics

The JSON and ZIP select the same `tv2_generation_1791039281415_6`, World revision 229 and Scene revision 3. Foreground bootstrap, retrieval and Memory jobs succeeded; retrieval Lore was ready and host delivery was injected. This supersedes the earlier capture's unbound-retrieval failure for this generation, without claiming every live acceptance item is complete.

The Needs Attention badge reproduces as 24 retained WARN/ERROR timeline rows plus one current Cognition read error: 20 NO_EVIDENCE rows, two Scene DEGRADED rows, and three presentations of the same Sensory read failure. The bounded timeline spans two generations. In the complete selected-turn history, ten of fourteen initially missing causal owner stages have subsequent owner evidence. Host observation, vectoring, learning and Memory causal receipts remain absent; absence alone does not establish execution failure. Scene reports `immediateObjects` unresolved.

Root cause of the Sensory false-stale error: the metadata producer passes absent revision values as null, and its numeric sanitizer converted null to zero. The deferred telemetry path then exposed Scene revision zero to the strict reader, which rejected it against revision three. Numeric sanitization now preserves absent values; the Sensory projection also leaves an unpublished revision unknown instead of borrowing the current selection's clock. Explicit stale/future revisions still fail the existing guards. Missing producer revision metadata remains unknown, not proof of freshness.

The regression in `tests/system-diagnostics-wiring.mjs` failed before the repair and passes through deferred emission, repeated projection, the host Sensory reader and strict live binding afterward. The offline gate passed 111/111 test files and 609/609 module checks; evidence is in `sensory-warning-checks` under the output root above. No story data or runtime processing configuration was changed. A fresh installed-host capture is still needed to verify live reporting; retained historical warnings are preserved.

## Activity Feed follow-up

The operator requested separate readable actions for each function, with expandable detail boxes as in the older feed. The existing feed projection and controller now keep functional milestones such as candidates considered, Truth assessment, Sidecar start/return and Lore entries delivered. Ordinary candidate verdicts, budget plans and known repetitive plumbing steps are grouped into the relevant action's processing details. WARN/ERROR events remain standalone. Named Truth, Sensory, Graph Walker, Hot Cognition, Scatter and Gather sources replace generic namespace labels; Gather summaries no longer appear as story summarizer work.

Grouping is presentation-only and uses chat/generation and physical job identity when available. Budget cost-profile IDs are not mistaken for physical jobs. Unscoped records group only consecutively and cannot join a bound story's action. Sanitized detail fields retain outcomes, source references, counts and timing; prompts, authored Lore bodies, provider responses, secrets and reasoning text are excluded. Both action and nested processing boxes retain their open state across updates. Clearing the visible feed leaves owner telemetry intact.

The original flood and noninteractive rows failed the new regressions before implementation. Focused activity/telemetry checks and the final offline gate pass: 111/111 test files and 609/609 module checks, recorded in `activity-feed-publish-checks`. A local browser fixture using the actual controller/projection verified click expansion, keyboard collapse, 52 verdicts inside one Truth action, and preservation of both open boxes when another action arrived. The preview screenshot uses test events, not a live generation. Installed SillyTavern acceptance remains a user update/check.

## Refresh follow-up: stale no-chat Lore paging target

The 11:55 refresh screenshot records a new `lore.loaded` event for Mushoku two seconds after `runtime.extension-loaded`. The capture has no active chat, no pending Lore bridge sync, and zero story World Tree nodes/edges/overlays. The installed checkout matches `c178730`; the persisted legacy `tv2.selectedLorebook` is Mushoku. `initLorePaging()` schedules maintenance after two seconds, and its no-chat corpus previously used that saved legacy picker. The new authoring picker never wrote that field, so this was a stale background read target rather than proof of cross-story publication.

No-chat maintenance now uses only a successfully loaded authoring book in the current session. Browser refresh starts with no automatic maintenance target; an explicit maintenance request can still supply its book. Authoring-selection changes invalidate/reset paging and wake it for the selected book. Failed and superseded authoring loads cannot redirect maintenance. Story retrieval continues to use the exact story binding independently of authoring. The legacy saved setting and all authored/story data are left intact.

The Activity Feed now identifies ordinary `lore.loaded` events as `Lorebook · Source read`; actual World Tree synchronization retains its World Tree label. Regression coverage reproduces the stale saved-picker failure, explicit selection, late-load fencing, reset/failure behavior, explicit maintenance requests, and source-read attribution. The full offline gate passed 111/111 standalone test files and 609/609 module checks, recorded in `lore-refresh-checks`. Live refresh acceptance remains a user update/check.

## Builder recovery follow-up: product toolbar

The reported `COMMITTING` screen exposed a presentation gap: the retired Builder console had `Recover commit` and refreshed-layout controls, but the actual World Tree graph toolbar did not. Its phase guards disabled Approve, Re-run and Trash during COMMITTING, leaving no recovery action even when the durable organization receipt could prove the write succeeded.

The actual toolbar now offers `Recover build` for COMMITTING, `Retry layout` for LAYOUT_PENDING, and `Review layout` for rebuilding/reviewing a stale layout. Recovery uses the existing exact-book owner contract and publication receipt; it never discards the saved run or repeats a proven completed organization write. After an apply error, the UI rereads the saved owner phase instead of retaining an obsolete APPROVED presentation. Unknown physical commit outcomes remain blocked with their existing reconciliation error; this UI change does not bypass the durable journal or claim such outcomes are resolved.

After a browser restart, explicitly select/load the same authoring Lorebook. The adapter restores that book's pending run. Interrupted analysis offers `Resume analysis`; reviewed work retains approval; COMMITTING offers `Recover build`; an already-saved organization offers layout retry/review. No story is implicitly attached.

The product-level crash regression persists a real organization, fails the subsequent outcome checkpoint, reconstructs the host/store, restores the run through the adapter, clicks the real toolbar recovery action, and verifies only the remaining layout is written. Additional checks cover unresolved commits staying fenced, the layout review action, and rereading the stored phase after apply failure. Live installed-host recovery still requires user update/acceptance.

Validation on this recovery change passed 111/111 standalone test files and 609/609 module checks; evidence is recorded in the session output folder under builder-recovery-checks.

## Builder reconciliation follow-up: interrupted before publication

The next live recovery attempt returned `Commit recovery is pending; reconcile the durable transaction before retrying`. The controller saved its own COMMITTING checkpoint before invoking the physical transaction owner, yet accepted only a completed publication receipt during recovery. A crash before invocation, or an exception before the write, could therefore leave an approved run permanently blocked even though no physical mutation occurred. The earlier toolbar repair exposed recovery but did not close this owner-side case.

Recovery now acquires the exact book's Lore/Tree resources (or the exact story's metadata resource), checks that reviewed source/world authority and the saved run revision are unchanged, and inspects the durable journal. An empty conflict set permits retry through the ordinary canonical coordinator. A matching unresolved intent is settled only through the existing canonical PRE-state verifier as confirmed-not-applied; another run's intent, changed fingerprint, applied/unknown footprint, or unavailable journal remains fenced. The saved run returns to APPROVED with compare-and-swap before retry, so competing saved-run changes cannot resurrect an old approval. Successful existing receipts still resume layout without repeating the organization write. Authoring recovery also checks write policy and never changes the selected book/story binding.

Regressions cover a product-toolbar recovery after a pre-transaction crash/reload, a failed pre-write attempt, changed sources and selection, concurrent saved-run changes, real journal settlement and unrelated-book preservation, unknown/applied outcomes, resource release, authority changing during resource admission, unavailable journal evidence, and the real Tree PRE-state verifier rejecting changed structure. No live user data was reset or repaired outside the normal owner path. Installed-host recovery acceptance remains a user update/check.

Final reconciliation validation passed 112/112 standalone test files and 611/611 module checks. Evidence: builder-reconciliation-checks in the session diagnostics output folder.

## Builder fresh restart: permanently replay-fenced prior attempts

The subsequent operator error named an archived replay fence with a diverged/unknown outcome. That terminal fence is intentionally different from an unresolved physical transaction: an exact replay remains permanently forbidden. The user requested restarting the build process instead of retrying its old approved mutation.

COMMITTING now offers `Restart build` alongside recovery. Restart rereads the selected authoring book and its current enabled source inventory, checks exact binding/write policy and resource admission, and refuses if any physical transaction still owns those resources. It checkpoints a fresh analysis run, then durably supersedes the old run before calling analysis. The original plan/approval and its replay fence remain intact for inspection. The replacement has no inherited approval; it must produce a fresh review and receive an explicit new approval before normal canonical publication. This changes planning authority, not journal truth, and does not erase the Tree or authored entries.

A child checkpoint whose parent retirement failed stays out of the active run list and never starts provider analysis. Reload retains the original pending run; restart can be retried. Once linked, an interrupted replacement analysis restores and resumes through the existing saved-run path. The restart method is wired through the installed host's owner allowlist, composition, operator adapter and actual graph toolbar.

Product regression traverses the real installed host forwarding bridge, uses fresh added entries, verifies no pre-approval Tree write, retains the previous plan, and applies only the newly approved proposal. Further checks cover interrupted retirement, paused replacement/reload, authoring isolation, untouched archived unknown replay fences, and rejection while physical ownership remains unresolved. Live restart acceptance on the user's installation has not been run.

Restart validation: the offline gate passed 112/112 standalone files and 611/611 module checks (builder-restart-checks). A final focused rerun passed 66/66 cases, including preservation of REORGANIZE mode through the installed restart toolbar.
