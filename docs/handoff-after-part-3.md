# Handoff after Part 3

Work order: the four-part "Nexus brief: Truth Gate classification".

| Part | State |
| --- | --- |
| 1. Truth Gate classification (Tasks 0–4) | Done. Task 3 is partial: campaign-time classification is deferred. |
| 2. Activity Feed cleanup | Done. |
| 3. Rail cleanup and the Notebook | Done in code and tests. Live check by the owner is pending. |
| 4. Optimization pass on the whole extension | **Not started.** No Part 4 code, tests or docs exist. |

Validation at this revision: all 119 `tests/*.mjs` files pass (run with `--experimental-vm-modules`), every changed `.js` file passes `node --check`.

## Open items to carry forward

- Part 1 live checks (a real generation exercising the Truth outcomes); the ~5 s latency explanation is still a hypothesis.
- Deferred: the automatic chat-versus-canon conflict producer (`docs/truth-chat-canon-conflict-producer-proposal.md`).
- Deferred: campaign-time capabilities (`docs/truth-campaign-time-future-design.md`, `docs/truth-classification-part1-open-items.md`).
- Part 3 live check: the rail has no Memory or Lore item, World Tree holds the old Memory and Lore controls, the World tab matches what the next reply is sent (`docs/notebook.md`).
- Lorebook binding and imports stayed in the World Tree workspace (owner chose a separate rail item), not Settings.
- Manual Notebook Refresh runs as `runLifecycleTask('notebook')`, not a job-table row.
- `response.tv2` and `error.tv2RollbackRestored` are shared sidecar/durability fields still named `tv2`.
- No UI control for digesting a Summary; the cold-start brief cap (700 tokens) is not scaled by context; the Notebook key migration is saved with the debounced metadata save.
- The `pre-truth-classification` tag was never pushed (HTTP 403); it exists only in the original checkout.

## Invariants kept

Exact story-to-Lorebook isolation; temporal status kept separate from source authority; the foreground path is untouched by background work; plain Nexus names in new code; no test was weakened to pass.
