# Truth classification (Part 1): open items

Part 1 (Tasks 0 to 4) is implemented on branch `claude/vigilant-albattani-62ddb6`, head
`adf8cb2e90bd977815d66e272a0f1960592d337d` at the time of writing. Nothing has been merged. This
records what is still open so Part 2 onward does not lose it.

## Live checks still owed (owner)

- **After Task 2:** in a new Overlord chat, a few ordinary turns, then one that contradicts canon on
  purpose (for example Gazef appears in Nazarick). Export Diagnostics and confirm: most lore resolves
  as current canon, not `UNRESOLVED`; the injected lore amount is about the same as before; the reply
  waits no longer than before. The "contradicting entries flagged with a reason code" item cannot pass
  until a conflict producer exists (below).
- **After Task 4:** check the Diagnostics panel's Truth stage in a live chat: per-turn totals, deferred
  count, time used against the budget, corrective state. Confirm whether the ~5 s foreground gap
  disappears (still a hypothesis).
- Live delivery of the context-only marker: token cost and how the main model reads it.

## Deferred capabilities (not implemented, not authorized)

- **Chat-versus-canon conflict producer** (`docs/truth-chat-canon-conflict-producer-proposal.md`).
- **Campaign time, direction/occurrence, and a producer for them**
  (`docs/truth-campaign-time-future-design.md`). Task 3 is **partially implemented**: the consumer is
  tested; live campaign-time classification is deferred; the original requirement is not closed.

## Known limits

- Retriever and Memory recall wiring has source-text checks only (SillyTavern-coupled).
- A contradiction stated in plain narrative, with no out-of-character marker and no reference to what
  is established, is read as an ordinary turn.
- The `pre-truth-classification` tag exists only locally (the remote refused the push).
- Part 1's integration handoff to `main` is deliberately skipped for now.
