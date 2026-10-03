# Notebook

The Notebook is one rolling working-state document per chat: current scene, goals, unresolved
questions, commitments, near-term hooks. It is working state, not canon. It never writes the World
Tree; the only World Tree effect is that digesting a Summary marks that Summary as digested.

## Where things live

| Piece | File |
| --- | --- |
| Document, revisions, last-refresh status | `memory/notebook-document.js` |
| One-time key migration (the only file naming the retired keys) | `memory/notebook-migration.js` |
| Size from the main model context, through `core/budget.js` | `memory/notebook-budget.js` |
| What the NOTEBOOK outlet sends (shared by the prompt and the tab) | `memory/notebook-outlet.js` |
| Evidence check | `memory/notebook-evidence.js` |
| Refresh gate: rule, then Decision Core, then the rule's answer | `memory/notebook-gate.js` |
| Host: chat metadata, durability, refresh, digest, outlet publish | `memory/notebook.js` |
| What the tab can ask of the host | `memory/notebook-binding.js` |
| The tab (the World rail item) | `src/ui-core/notebook-workspace.js` |

## Rules

- **Evidence.** A rewrite must cite a `[M#]` message that was in the scene it was asked about. Without
  one it is rejected, the old Notebook is kept, and the reason is recorded as the last refresh result.
- **Refresh gate.** Automatic refreshes first apply a rule (nothing new since the last refresh, or only
  trivial new text, is not a material change), then ask the registered Decision Core site
  `notebook.material-change.v1`. If Decision Core cannot answer, the rule's answer stands and the
  refresh runs. A manual Refresh never asks.
- **Size.** Target and hard ceiling start at 1,400 / 1,800 tokens at a 16,384-token context and scale
  with the main model's context (10% / 13% share), between a 400-token floor and a 4,000 / 6,000
  sanity ceiling. A rewrite over the ceiling is rejected with a stated reason. If the ceiling later
  shrinks below the stored text, the stored text is untouched and the outlet carries a compacted copy,
  core state first, with a visible note that N blocks were held back and a `prompt-compacted` event.
- **Characters.** Names come from the World Tree's tracked characters
  (`trackedCharacterLabels` in `world-tree/tracking.js`), not from Character Banks.
- **Digest.** Digesting a Summary writes the Notebook and marks the Summary `superseded` with the
  reason `digested-to-notebook`. The World Tree node becomes SUPERSEDED with that reason. Nothing is
  deleted; coverage is unchanged.
- **Storage.** The document lives under `nexus_notebook_v1` in chat metadata, the last refresh result
  under `nexus_notebook_refresh_v1`. The retired keys are read once, written to the new key, and
  dropped.

## Refresh paths

- Automatic: the `notebook.refresh` row of the post-turn job table, run by the lifecycle scheduler at
  generation end.
- Manual: the tab's Refresh calls `runLifecycleTask('notebook')`, a scheduler cycle with the same
  physical lease and cadence accounting as the other manual tasks. It is not a job-table row.

## Known limits

- `response.tv2` (sidecar response) and `error.tv2RollbackRestored` (durability error) are shared
  contract fields the Notebook reads through three small accessors. Renaming them touches every
  sidecar consumer and is outside this work.
- The cold-start brief keeps its own 700-token cap; it is not scaled by context.
- Compaction keeps blocks by a keyword priority (current, scene, goal, hook, …), then document order.
- The migration is persisted with the debounced chat-metadata save, not a durable transaction.
- There is no UI control for digesting a Summary; the function and its tests exist.
