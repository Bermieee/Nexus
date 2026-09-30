# Task 4 — Diagnostics channel wiring

All nine existing system categories now enter the existing observability logger through a bounded, metadata-only, deferred hook. The hook projects approved metadata before retaining it, queues at most 256 events, emits at most 16 per macrotask, and contains malformed data, scheduling errors and sink exceptions. No generation caller awaits the hook. Existing non-system telemetry contracts remain unchanged. This is a best-effort bounded diagnostic feed, not an authoritative execution ledger.

The existing Diagnostics readSystemDiagnostics projection recognizes these normalized events. The Diagnostics panel's existing central telemetry table shows all channel states, including No events yet. Existing event rows display channel identities. No new panel or UI redesign. The existing readTelemetry stream remains the single feed. The UI sanitizer is retained.

Truth candidate decisions and Sensory fusion counts needed by existing Cognition read models remain in the approved metadata schema. No prompts, query/story content, raw provider responses, credentials or reasoning are retained by the system hook.

checkSidecarProvider now emits resource-probe results for successful checks, failures and missing endpoints. It does not add automatic network calls or invent successful probes. The merged resource UI's control actions remain read-only where host action bindings are absent; this task does not add resource configuration/connect/test actions. Live probe-channel acceptance requires invoking a real provider check through an available host/control path.

Verification: four new checks cover all nine channels through the host binding and actual Diagnostics renderer with a minimal document fake, hostile sinks and bounded/deferred queueing, existing Cognition read models, and provider-check success/missing-endpoint events with mocked provider calls. The 32-check focused UI/runtime/hand-off suite passes. Existing Diagnostics producer, Core, Truth, Sensory/Walker, Hot, Scene, Green Room and Scatter/Gather scripts pass. Syntax and diff checks pass. Existing tests were not weakened. Hosted CI and live SillyTavern/provider acceptance are not claimed.

Stop at Task 4 checkpoint. Task 5 owner events is not started.
