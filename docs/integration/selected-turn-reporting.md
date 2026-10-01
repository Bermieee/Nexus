# Selected-turn reporting repairs — 2026-09-30

The 20:45 live export confirmed successful retrieval, Sensory, Truth, Jev and
Graph Walker work, while the graph inspector had no host reader and the physical
execution panel still showed zero. These were disconnected reporting seams.

## Recorded graph traversal

Retrieval now stores the actual Walker traversal receipt as bounded metadata:
counts, provider identities, source references and at most 32 reference edges.
It omits query text, narrative, source bodies and provider payloads. Retention is
32 exact chat/generation pairs, clears with retrieval diagnostics, and readers
return independent copies. The host exports `readGraphTraversal` to the existing
inspector. A missing or foreign receipt remains missing.

This is generation-time traversal evidence. The separate on-demand
`readWorldGraphReferences` capability remains unwired; it is not fabricated from
the saved receipt or from today's graph.

## Physical cognitive execution

Captured chat/generation identity now survives Model Worker/Sidecar Bus routing
and the client's request telemetry composition. Background work without a
captured generation and connectivity probes are not assigned to the active turn.
The Cognition UI read counts actual matching request-start/success/failure,
semantic-repair and cancellation events, deduplicated by resource, route, job,
attempt and phase. Jev uses its scoped physical-attempt result evidence.

Success, failure, cancellation and still-running counts are separate. These are
physical cognitive provider attempts, not logical jobs, connection qualifications,
owner acceptance or the main chat response. Coverage is explicitly
`RETAINED_SCOPED_REQUEST_EVENTS`; anonymous calls and evicted events cannot be
reconstructed and are not counted as zero-proof executions.

## Verification

The new regression file exercises the actual graph inspector and Coprocessor UI
adapter, isolation, retention/clearing, duplicate requests, probes, failure,
cancellation, and the client's telemetry composition. The foreground queue test
also checks captured identity at actual Model Worker dispatch.

Full offline check: 62/66 standalone files and 507/507 syntax checks passed. The
same four existing removed-UI contract failures remain. After that run, the graph
retention and final UI counter assertions were added and the complete new file
passed 5/5. Evidence is at
`C:/Users/cacon/AppData/Local/Temp/nexus-reporting-20260930/report.json`.

Browser acceptance requires a new generation after reload. Old request events
that never carried selection identity cannot be retroactively assigned to a turn.
