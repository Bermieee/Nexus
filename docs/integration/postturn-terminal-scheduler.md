# Terminal lifecycle scheduler release

## Trace

The 2026-09-30 21:33 diagnostic export had three pending Post-turn messages,
no selected-turn learning/completion receipt, and no settled lifecycle plan.
Those observations alone do not prove that all three messages were due:
Post-turn still has cadence, settings, semantic routing and source-authority gates.

The installed terminal boundary had a reproducible circular wait. Generation
start loans the Sidecar Scheduler to foreground work. After generation end,
`scheduleAutomaticLifecycle()` awaited `runAutomaticLifecycle()` and resumed the
scheduler only in that promise's `finally`. The lifecycle first awaits Scene
authority and can then await background model-worker operations. Background
operations cannot run while the scheduler remains LOANED. A lifecycle needing
such an operation therefore cannot reach the completion handler that resumes it.
The physical Job Queue can already be unpaused and empty while this separate
logical scheduler remains loaned.

## Repair

After the terminal timer checks request freshness and verifies that foreground
is inactive, it resumes the captured scheduler generation **before** invoking
the lifecycle. Its existing completion cleanup remains generation-fenced.
No cadence, backlog eligibility, classification, source-freshness, publication,
or owner acceptance rule was relaxed. No backlog is marked processed by this
change; only the owners can settle it.

## Verification

The installed-boundary regression extracts the actual dispatch function and
uses the real Sidecar Scheduler. With a foreground loan held, its lifecycle
awaits a real background scheduler operation. Before the repair it cannot
complete; after the repair it runs on B and completes without an external
resume. A second test starts a new foreground generation during the old
lifecycle and proves the old completion leaves the new loan held.

Focused verification: 36 tests passed, including lifecycle owner publication,
cadence/manual routing, physical leases, foreground retrieval, background
preemption, stale edits and selected-turn reporting.

## Live acceptance and reporting limit

Run another generation and allow its automatic lifecycle to settle. Inspect
the scheduler transitions and Post-turn classification/result before deciding
whether pending messages should be consumed or remain deferred. Real provider
execution has not been tested locally.

The transplanted `readGeneration()` adapter currently returns a null
`learningReceipt`. Therefore that particular missing receipt remains a reporting
gap even when an owner successfully learns. This repair does not manufacture a
learning receipt from generation completion, a provider response or a shrinking
backlog. Pending work and receipt availability must be evaluated separately.
