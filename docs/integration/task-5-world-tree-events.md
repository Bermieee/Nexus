# Task 5 — World Tree owner events and UI subscription

World Tree emits node-added and edge-added on first insertion, with id, kind and scope. node-superseded is emitted only when an existing node transitions to SUPERSEDED; repeated updates in that state do not emit another supersession. Existing uppercase owner events remain for compatibility. New event payloads carry no node/story/source bodies. World Tree invariants and stored schema are unchanged.

subscribeNexusWorldTree follows the singleton owner across restore/replacement and releases listeners from the old instance. The UI subscription adapter defers delivery to a macrotask, coalesces repeated same-id/type notifications, drops queued events from a replaced owner, filters chat-scoped events against the chat active at delivery, and catches listener failures. Unsubscription clears pending notifications and detaches the owner listener.

The Nexus host exposes the subscription through both world.subscribe and the existing general host subscription. SillyTavernSelectionBridge therefore sends these changes through the existing live-binding refresh path. No new UI panels or growth animation; this is the subscription point requested by the brief. An owner-replacement notification additionally refreshes the view after restore.

Verification: five new checks cover event payloads and transition behavior, deferred scope-filtered delivery, teardown, replacement, actual host-binding/selection-bridge wiring, and subscriber exception containment. Focused World Tree/UI/runtime/hand-off/Diagnostics checks pass. No real SillyTavern animation or installed acceptance claimed. Hosted CI remains unverified.

Stop at Task 5 checkpoint. Task 6 scheduler work is not started.
