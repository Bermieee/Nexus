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
## 6c — borrowed background sidecar and result admission

User authorized the next point after 6b. Base 2297ff0. Implemented BACKGROUND / LOANED / RESUMING with ephemeral job+scope checkpoints and priority selection at completed step boundaries. A loan never cancels an in-flight provider call. Chat change clears queued work/checkpoints/late carry; the draining call keeps its reservation until physical settlement. A newer generation cannot be retired by an older end.

The existing model-worker/Sidecar bus remains the physical dispatcher. Scheduled foreground and post-turn work reserves A or an available B; background Tree summary and keyword-advisor calls use B. The routing layer never chooses Main for these scheduled requests. Existing lifecycle providers receive an injected scheduled enqueue, retaining owner leases, cadence and result shapes. A real transport timeout/unavailability can fail over once to the other immediately free slot; it cannot queue a retry behind an occupied higher-priority slot. Foreground queued calls expire before dispatch at the existing deadline.

READY / STALE / LATE / INVALID admission delegates to the existing GatherCoordinator. Foreground coordinator work is raced against its existing hard deadline so required fallback quorum can return to the existing frame sealer. Fresh late owner-created read proposals can enter a later frame only through their existing typed read ports. They never alter the prior seal or grant canonical mutation authority. Carry freshness includes chat/message/Lore source identity plus the completed owner's Scene, Memory, World Tree owner/revision and policy identity. Generation frames capture message/swipe identities, scope epoch, Scene revision and deadline metadata. Scheduler lane/checkpoint/failover and gather verdict/count receipts use the existing Diagnostics channels.

Task 6c: Ruling: a stale generic background generator restarts with fresh owner inputs; an immutable physical provider request cannot safely rewrite its already-built prompt — it rejects explicitly and leaves fresh replanning to its owner. Cost if wrong: the owner must reschedule changed work; stale text is never replayed under a new scope.
Task 6c: Ruling: foreground owners may legitimately materialize canonical read projections during execution — READY admission retains their own fences and current message/Lore scope, while next-frame carry uses the full scope captured after the owner finishes. Cost if wrong: an owner that fails its own source fence could admit stale output; carry remains fenced by the broader identity.

One fresh read-only review covered Task 6 from 4b3b0ee through this working tree. No Critical or minor findings. Final: fixed actual TV2SidecarTimeout failover, stale automatic-timer loan/edit loss, and late carry bypassing installed frame delivery — each reproduced RED then GREEN in scheduler-sidecars, scheduler-installed-boundary and scheduler-installed-routing. The carry test additionally exposed sealed-frame publication-rejection bookkeeping mutation; rejection diagnostics now stay outside a sealed record, and byte-identical seal preservation passes.

Final: Ruling: live SillyTavern acceptance was declined by the reviewer — remains unverified, to be exercised at this checkpoint. Cost if wrong: deterministic host checks may miss real host behavior.
Final: Ruling: hosted exact-head CI was declined by the reviewer — no hosted pass claimed before its run. Cost if wrong: local environment may differ from Actions.
Final: Ruling: the four obsolete UI-related baseline tests were declined by the reviewer — preserved unchanged and reported red; the user's prior authorization permits progress while UI release validation remains open. Cost if wrong: those expectations still need reconciliation before release.
Final: Ruling: legacy cap conversion was declined by the reviewer — dynamic-budget foundation remains partial, not a claim of universal cap conversion. Cost if wrong: old readers retain their documented limits.
Final: Ruling: Decision Core sites were declined by the reviewer — remain Task 8; no new direct Jev calls. Cost if wrong: those advisory decisions stay on their existing seams until that task.

Final verification on the production tree before commit: focused Task 6/integration command, 57/57 checks pass; all standalone tests, 49/53 files pass with exactly the same four failures (character-review-policy, performance-hotpaths, prompt-loader-adapters, summary-digest-coverage); 488/488 syntax commands pass. No new failing file. Evidence is in the local Temp nexus-task6c-final-evidence report/logs and nexus-task6c-final-focused.log. The standalone scatter/gather wiring check also passes. No live acceptance or hosted exact-head result claimed.

Stop at Task 6c / Task 6 checkpoint. Task 7 read-family migration and Task 8 Decision Core site registration have not started.
