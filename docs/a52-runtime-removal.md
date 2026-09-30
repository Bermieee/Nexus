# Area-52 → Nexus Runtime Removal Ledger

This ledger records runtime authorities as they are removed during the revised port. Area-52 systems are not controlled by Off/Shadow/On feature switches; each removal lands as a bisectable commit and the replacement path is exercised directly.

| Runtime / authority removed | Former storage / owner | Replacement authority | Status |
| --- | --- | --- | --- |
| Area-52 port feature-mode layer | `nexus/a52/modes.js` | No runtime mode layer; Git revert/bisect + per-turn trace | Removed |
| Area-52 Context Seal coupling in Hot Cognition | Hot sealed-snapshot/result-route hooks | Nexus Generation Frame + live per-chat Hot snapshot | Removed |
| Legacy Nexus Lore Tree persistence | `settings.trees` via `tree/store.js` | Canonical `settings.worldTree` World Tree node/edge document | Removed in World Tree authority cut 1 |
| Legacy Nexus Memory Bank persistence | `chatMetadata.tv2_memory_bank` | Chat-scoped World Tree memory nodes + memory-store-meta node | Removed in World Tree authority cut 2 (legacy payload retained read-only as migration archive) |
| Legacy Nexus Character Bank persistence | `settings.memoryBank.characterBanks.banks` | World Tree character nodes | Pending |

## Authority rule

The World Tree structure is the shared contract. Compatibility APIs may temporarily project old shapes for callers/UI, but after a row is marked **Removed**, the old store is not authoritative and must not receive new canonical writes.

## Diagnostics rule

All Area-52 runtime traces, World Tree migrations, probes, freshness rejections, candidate verdicts, walker traversals, scene updates, Green Room inferences, and Scatter/Gather receipts must enter Nexus telemetry and be visible from Diagnostics. Separate debug/probe surfaces are migration targets, not permanent owners.
