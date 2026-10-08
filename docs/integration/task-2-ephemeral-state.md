# Task 2 — ephemeral working state

Hot Cognition and Green Room now use the canonical World Tree overlay map as their backing store through core/ephemeral-state.js. Overlay identity includes system kind, chat id and canonical node id. Chat-wide state uses the existing world:nexus root as its node anchor; this creates no durable nodes and changes no World Tree schema. Segment and character identities remain within each owner's working state.

The Hot runtime and Green Room store remain computation owners. Their state is hydrated from ephemeral overlays; clearing or replacing the World Tree defeats stale local caches. Hot saves update an overlay instead of chat metadata. The former nexus_a52_hot_cognition_v1 key is read once into the ephemeral layer and deleted through the existing durability barrier. No replacement durable Hot key is written. If deletion cannot be verified, the old key remains for retry and a migration-failed event is reported.

Green Room still applies its existing TTL (valid through the second subsequent turn), source invalidation, scene revision and departure rules. Chat switch/reset clears its working overlay. A pending inference cannot publish after its store/chat/World Tree owner changes. Hot chat switch clears old working state. Durable World Tree export and restore exclude both systems' overlays.

Verification: four new checks exercise overlay isolation, durable export/reload exclusion, Green Room expiry/invalidation, the actual Hot adapter's legacy-key migration, and the actual Green Room adapter's late chat-switch result. Host dependencies are mocked; production adapter code is executed. Existing Hot, Green Room and Scene focused scripts pass. World Tree reader/invariant checks pass. No UI/live provider acceptance claimed. Owner deferred live checks. Hosted CI status remains unverified; no workflow runs were returned for the prior Task 1 SHA by the connector.

Task 3 is not included in this commit.

## Accepted inference continuity — 2026-10-08

Accepted Green Room inference may survive an increasing Scene revision within the same explicit `sceneId`, subject to its original turn TTL, active cast, evidence invalidation, correction, closure and replacement rules. It retains its original source revision and inferred status. Legacy rows without scene identity retain strict revision expiry. A pending provider result still requires the exact requested Scene revision, chat, binding, store and World Tree owner at publication; this change does not admit late results. See [core repair validation](../validation/nexus-core-repair-20261008.md).
