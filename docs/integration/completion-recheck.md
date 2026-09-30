# Integration completion recheck — 2026-09-30

Authority: NEXUS_INTEGRATION_BRIEF_3.md. Examined main 156a25d. The owner requested a completion recheck, then completion of Task 7, then a pause for UI wiring before resuming integration. Task 8 must not start during this phase.

## Corrected completion status

Passing regression tests establishes tested behavior; it does not establish full brief compliance. The earlier statement that Task 6 was fully implemented was too broad. Task 6 is PARTIAL. The limitations recorded below are not waivers of the brief.

| Requirement | Evidence and status |
| --- | --- |
| Baseline preservation | pre-integration tag exists. A complete fixed-cap inventory is not present in the integration ledger; original baseline reporting is not a verified cap-conversion checklist. OPEN. |
| Task 1 canonical reader | core/world-tree-api.js reads the canonical owner and refreshes on owner identity/revision changes. Legacy projection module remains a compatibility export. Implemented and deterministically tested; installed acceptance unverified. |
| Task 2 ephemeral state | Hot and Green Room use owner overlays, existing expiry and source fences; export excludes overlays. Implemented and deterministically tested; installed acceptance unverified. |
| Task 3 handoffs | All five handoffs have executable checks. Implemented. The touched continuity channel still uses slice(0,24), so the cross-task dynamic-cap obligation is incomplete. |
| Task 4 Diagnostics | Nine channels reach the existing host read and renderer; deferred metadata hook contains sink failures. Implemented. Live panel/provider acceptance unverified. |
| Task 5 owner events | Owner emits added/superseded events; subscription follows owner replacement and scope. Implemented. UI growth animation intentionally belongs to UI work. |
| 6.1 registered row contract | createPostTurnJobTable creates registered rows with input/steps/accept/onResult. However accept always returns true and onResult is empty; existing executors perform their own validation/publication internally. Not equivalent to the required admission-before-publication contract. PARTIAL. |
| 6.1 model-call step boundaries | Summary branch yields between summary, promotion and routing stages. Other rows await entire legacy executors; promotion/routing can contain multiple calls before their stage yields. A wrapper generator does not make each internal call a step. PARTIAL. |
| 6.1 checkpoints | Background generator checkpoints are keyed by job and scope, ephemeral, tested for resume/stale restart. Post-turn checkpoints are local to runJobTable and removed at completion; they do not reconstruct a multi-call owner executor after interruption. PARTIAL. |
| 6.2 planner | Deterministic gate/edit/TTL selection implemented; tests cover due jobs and affected-message behavior. Optional Decision Core advisories deferred to Task 8. |
| 6.3 routing | Existing bus executes reserved A/B requests; foreground priority, one eligible retry, no scheduled Main. Tests cover timeout/failover and physical slot drain. No live provider acceptance. |
| 6.4 scatter/envelope/quorum | Two-job layers, host yield between layers, frame metadata and deadline closure implemented/tested. |
| 6.4 result admission | SchedulerGather validates arbitrary rows, foreground typed carry is fenced, old seals remain byte-identical. Lifecycle rows still publish inside executors before this wrapper admission. Late carry uses scheduler-owned in-memory maps, not the canonical owner's ephemeral overlay. PARTIAL. |
| 6.5 borrowed B | BACKGROUND/LOANED/RESUMING and step-boundary lending implemented/tested. Installed Tree physical requests are one-call wrappers with restartOnStale:false; stale immutable prompts reject rather than restart the owning logical job with recaptured inputs. Safe rejection is not full logical-job continuation. PARTIAL. |
| 6.6 tests | Planner, gather, deadline, failover, lending, stale restart, priority, chat clear and lifecycle parity checks exist and pass. Coverage does not close the architectural gaps above. |
| Dynamic budgets | core/budget.js computes measured/time/prompt/world budgets and continuation receipts. Production lifecycle only observes durations; no beginTurn/compute integration there. Existing touched limits remain. Foundation implemented, production conversion OPEN. |
| Plain Nexus names | Compatibility paths, imports, error names and old keys still exist. A coordinated one-time stored-key migration has not been completed. OPEN; do not remove persisted keys without migration. |
| Task 7 | Complete Memory record import/parity prerequisite landed. Control metadata is not yet compared; knowledge readers have not switched. Characters/Lore parity and cutover not started. IN PROGRESS. |

## Repair and continuation order

1. Repair 6.1 at owner boundaries: expose per-model-call generator steps, captured inputs and saved position, while preserving existing leases/cadence/result shapes. Give rows real result validators and publish only after successful admission. Prove malformed/stale output cannot mutate its target.
2. Move next-frame held results to the existing World Tree ephemeral owner and prove export exclusion, chat clearing, freshness and byte-identical prior seals.
3. Register restartable logical background jobs around immutable bus calls; stale source changes recapture inputs at the owner, rather than relabeling the old prompt.
4. Complete the cap checklist and connect the shared budget manager to changed production consumers with truthful coverage/continuation. Preserve fixed correctness invariants.
5. Finish Task 7 Memory control-metadata parity, then obtain live parity before all Memory knowledge readers switch. Repeat Characters and Lore in order. Keep old stores as write/import sources during migration.
6. Stop after Task 7 for UI wiring. Do not start Task 8 or label live acceptance complete without evidence.

## Verification

Fresh focused recheck: 85/85 tests passed across canonical owner, overlays, handoffs, Diagnostics, owner events, budget foundation, scheduler and Memory record parity. Output: local Temp nexus-completion-recheck.log. Latest broad run remains 50/54 files, with the four documented legacy UI failures, and 490/490 syntax checks. No new failing file. These results do not remove the OPEN/PARTIAL classifications above. Hosted exact-head CI and real host acceptance were not verified in this recheck.
