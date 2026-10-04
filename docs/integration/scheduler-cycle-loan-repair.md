# Lifecycle loan and batching circular wait

## Reproduction

The reported hang is present at `b91c13c` and the subsequent activity-feed head
`66290ff`. `runLifecycleCycle()` loans the background scheduler until its final
cleanup. Scheduled batch slices wait for that scheduler to stop being LOANED
before creating physical queue jobs. The cycle awaits those slices before
reaching the cleanup that would release the loan: zero provider calls, with
post-turn work and the cycle both pending.

The earlier audit tested foreground generation loans and owner requests in
isolation. It did not join the actual lifecycle's self-held loan to the restored
collector/router. Its passing suites were not evidence that this combination
completed. `scheduler-batching-impact-audit.md` records that correction.

## Repair

Loans now carry an explicit purpose. Existing callers default to `foreground`;
the lifecycle cycle declares `lifecycle`. The background scheduler remains the
single owner of the loan identity and purpose, clearing both together.

Only post-turn batch requests can proceed through a lifecycle loan. Unrelated
background owners remain paused. Foreground generation loans still block new
post-turn batch attempts before JobQueue admission. If a new generation loans
the scheduler, an old cycle's completion cannot release that newer loan.
Unknown purposes are treated as foreground; no ID-prefix inference or broad
removal of the loan wait is used.

Scope freshness, physical capacity, operator locks, cancellation, owner/Gather
admission, publication and story/Lorebook mutation authority are unchanged.

## Executed evidence

`tests/scheduler-batching.mjs` adds:

- Four compatible requests under a held lifecycle loan: one real collected
  workload completes with A 2 / B 2, without externally resuming its loan.
- Actual `runLifecycleCycle()` and production execution leases, job table,
  owner steps, Model Worker Bus, Batch Layer, Sidecar router and JobQueue:
  Scene, Green Room, Notebook and post-turn extraction all settle, leaving
  no waiting requests, occupied slots, active logical cycles or physical leases.
- Unrelated background work stays paused through the lifecycle loan and runs
  on B after the cycle releases it.
- A new foreground loan during a cycle batch lets existing calls drain, holds
  pending slices, admits an urgent foreground request, and survives an old
  cycle's attempt to resume. Pending slices finish after the new loan ends.

The first two regressions were executed before production changes and failed
with bounded stall errors. The external provider and semantic owner operations
are fixtures; lifecycle orchestration and physical scheduling are real modules.
The test does not claim to exercise those owners' extraction semantics.
Existing suites continue to cover foreground pause/resume, cancellation,
source edits, timeout failover, binding isolation and sealed delivery.

`tests/scheduler-background.mjs` also covers explicit purpose, default and
unknown-purpose behavior, clearing, and protection against an older resume.

Final local validation: all **123 standalone test files pass**, including
**32 batching cases** and **6 background scheduler cases**. Changed production
JavaScript passes `node --check`, and `git diff --check` passes.
Live provider acceptance still requires an installed generation.
