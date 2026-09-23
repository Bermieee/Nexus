# Nexus Tree Builder non-blocking workspace repair — 2026-09-22

## Live issue
While Builder 2 was analyzing/building a lorebook, the Tree workspace occupied a full-screen modal overlay (96vw × 92vh). Closing the window also cancelled the active Builder review/run, leaving no safe way to inspect other Nexus UI while long Builder work continued.

## Repair
- Added **Minimize / Restore** to the Tree workspace header.
- Minimize is presentation-only. It does not call Builder cancellation, run-lifetime, transaction, Sidecar, or mutation APIs.
- A minimized Tree becomes a small bottom-right live status window.
- The full-screen overlay becomes transparent and click-through while minimized, so Memory Bank, diagnostics, settings, and other SillyTavern/Nexus surfaces remain usable.
- Builder Preview / Resume status remains visible in the minimized window so completion/review readiness is still observable.
- Restore returns the exact existing Tree workspace.
- **Close remains unchanged** and is still the explicit path that cancels Tree-window-owned Builder review/work.

## Authority guard
No Builder 2 pipeline, PlanStore, Coordinator, Sidecar execution, run durability, review, approval, mutation, Ledger, or Tree authority semantics changed.
