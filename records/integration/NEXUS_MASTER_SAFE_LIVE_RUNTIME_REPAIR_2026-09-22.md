# Nexus Master-Safe Live Runtime Repair — 2026-09-22

## Authoritative source basis
- Repair workspace: `Bermieee/Development@development`.
- Before repair, the workspace was reconciled exactly to the master-integrated source tree `cfcb1054ad85627e55868766e5921912e6385020`, recorded by the master log as Development main `d6013c3d832eaf7c8e80c8e69d6e506cfda457b1`.
- The two earlier runtime-repair commits on the isolated #208/#211 branch are superseded by that reconciliation and are not part of this repair's runtime source.

## Repairs
1. **Optional Lore Injection global-condense timeout**
   - Jev candidate admission, canonical freshness, and final Lore Injection Sidecar authority are unchanged.
   - Batched Lore Injection still performs its normal global condense.
   - For generation-scoped foreground work only, that optional refinement receives a local time budget equal to the existing foreground stall-watchdog setting.
   - If that optional refinement exceeds the budget, only the condense job is cancelled and Nexus preserves the already validated complete Sidecar gather.
   - User stop, scope invalidation, chat revision invalidation, and ordinary intentional cancellation still propagate unchanged.

2. **Health-offload / JobQueue conflict**
   - Work Director/Sidecar router remains the owner of health routing.
   - When the router explicitly chooses a primary lane with `reason:'health-offload'`, JobQueue idle rehoming cannot move that primary attempt back to the degraded lane.
   - The existing adaptive fallback loop remains unchanged and may still use the other lane after a real retry-eligible primary failure.
   - JobQueue itself receives no Sidecar-health policy.

3. **Summary structured-contract reinforcement**
   - Summary semantic validation remains strict.
   - Summary transaction/coverage semantics remain unchanged and fail closed if a slice cannot recover.
   - Resource-policy token targets remain soft and Auto Sense reasoning remains unchanged.
   - Extraction, consolidation, aggregation, and recovery prompts now explicitly require `characters`, `locations`, `dates`, `topics`, and `threads` to be JSON string arrays, using `[]` when empty.

4. **World Info retention telemetry**
   - Suppression authority and transactional rollback/commit behavior are unchanged.
   - Retention telemetry now distinguishes Tree-owned World Info whose Nexus Retrieval replacement is not ready from genuinely non-Nexus-owned World Info.

## Explicit master-log protections
- No Retrieval scoring threshold, candidate authority, Jev ownership, Lore Injection authority, injection budget, or presentation order was changed.
- No Summary coverage, digest-delete coverage, transaction atomicity, or physical-execution/narrative-coverage separation was changed.
- No resource-policy soft target was promoted into a transport hard cap.
- No Sidecar routing/concurrency owner was moved into JobQueue.
- No Character State, Builder2, Housekeeper, Smart Context, Prompt Loader, paging, or mutation authority was changed.
