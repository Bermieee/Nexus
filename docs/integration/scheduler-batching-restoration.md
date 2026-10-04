# Scheduled batching restoration — 2026-10-04

## Failure and repair

The scheduler reserved a worker before a post-turn request reached collection.
The physical request then carried `forceSlot` and `preemptible: false`, bypassing
the existing Batch Layer. The owner adapter also serialized independent slices
of explicit model-worker batches.

Compatible post-turn requests now enter the existing collector first. The
Sidecar Bus/router creates the real parent, scatters slices and acquires a
scheduler lease for each physical attempt **before** JobQueue admission. Pending
batch attempts wait through a foreground loan, avoiding scheduler/transport lock
inversion. Foreground requests retain their immediate path.

Explicit model-worker batches already own packed semantic slices and a rolling
pool, so their units bypass redundant nested collection. An in-process batch
identity lets the cooperative owner adapter run those independent slices
together. Each completion yields through Gather before returning to its owner;
the faster lane can refill while another slice is running. Ordinary owner calls
remain sequential. Canonical publication still requires its separate admission
boundary and existing owner/transaction authority.

The scheduler rechecks freshness after a host yield, before the owner can start
another slice. Stale owners cancel unfinished siblings. Already admitted writes
retain their terminal-receipt exception.

## Contracts followed

- [Task 6 plan](task-6-closure-plan.md) and [progress](task-6-progress.md):
  cooperative checkpoints, owner publication, bounded execution and freshness.
- [Foreground retrieval plumbing](foreground-retrieval-plumbing.md): preserve
  foreground access through a paused queue and sealed-generation immutability.
- [Terminal scheduler](postturn-terminal-scheduler.md): generation-fenced loans.
- [Optimization design](../superpowers/specs/2026-09-15-hotfix46-optimization-trio-design.md):
  existing adaptive policies, coverage, validation and single-worker operation.

This refines the historical statement in `completion-recheck.md` that parallel
owner requests are serialized: explicitly identified independent batch slices
can execute together, but each completion and publication remains admitted.
There is no new provider, scheduler, canonical writer or binding authority.

Compatibility includes domain, stage, role, priority, mode, deduplication
material, scheduler lane, chat, epoch, revision, generation and source-book
identity. Operator locks and configured multi-worker modes remain effective.
Collection-disabled requests keep their ordinary response shape and leases.

## Verification

`tests/scheduler-batching.mjs` runs the real Model Worker Bus, Batch Layer,
Sidecar Bus/router, batch pool, JobQueue, SidecarScheduler, owner job table,
Gather and generation delivery modules. The external host/provider,
configuration, telemetry sink and unrelated decision/topology boundaries are
doubled. Its **20 cases** cover:

- Six requests forming one real batch parent with A/B execution.
- Summary-style batch planning through an owner job row, per-call admission,
  ordered validated results and one publication.
- Fast-worker refill, separate groups sharing workers, and 25 units crossing
  bounded waves without omission or more than two simultaneous physical calls.
- Single-worker operation, disabled collection, configured multi-worker mode
  and an explicit B lock.
- Cancellation, foreground loan/pause/resume and priority, failure isolation
  and bounded timeout failover.
- Chat changes, source edits, stale-owner cancellation and book isolation.
- A/B results entering the captured host prompt exactly once through typed
  generation outlets; late results cannot amend a sealed frame.

Removing the independent-batch marker makes the owner workload regression fail
because the second physical call cannot start. The freshness regression also
reproduced an unwanted third call before the post-yield check was added.

All **123 standalone `tests/*.mjs` files passed**, each executed with
`node --experimental-vm-modules`. Changed production JavaScript files passed
`node --check`; `git diff --check` passed. An obsolete source-regex assertion
requiring only Tree to bypass nested collection was removed; executed owner
batching tests cover the updated behavior.

## Live acceptance and outstanding work

These tests capture host delivery but do not call OpenRouter or prove real
SillyTavern browser acceptance. Update the installed extension and run a workload
with multiple eligible slices. Confirm planning/scatter/gather receipts, A/B
physical assignments, refill, completion and final delivery. One eligible task
legitimately remains a single call. A batch may use distinct provider requests.

This closes the traced batching barriers, not the entire Part 4 optimization
pass. Unrelated export findings, including the `tv2_memory_bank` stale-metadata
transaction and Lore status/selected-turn reporting gaps, remain outside this
repair. No installed extension files were edited.

Follow-up: [affected-area audit](scheduler-batching-impact-audit.md) documents
three further boundary repairs and expands this execution suite from 20 to 28
cases, with all 123 standalone files passing again.
