# Proposal: a producer for chat-versus-canon conflict evidence

Status: proposal only. Nothing in this document is implemented, and it is not part of
Truth classification Task 2.

## Why this exists

Truth can already consume conflict evidence: a `truth.conflict` advice row that names two
World Tree nodes and says `REAL_CONFLICT`. When one node is verified source canon of the
active story's bound Lorebook and the other is a verified chat-established fact, Truth treats
the canon fact as disputed support for that chat only.

Today the only code that writes such rows is the post-turn pass in `decision/task8-runtime.js`,
and it only pairs lore with lore, where both are `CURRENT`. Nothing proposes
chat-fact-versus-canon pairs, so the consumer has no input in a real chat until a producer
exists. Task 2 deliberately did not add one: it would be another model-backed execution path
(a `truth.conflict` Decision call per pair) and that needs explicit approval.

## What a producer would have to do

1. Run in the post-turn lane only, never on the foreground path.
2. Choose pairs deterministically, within a fixed per-turn cap:
   - one side: a node scoped to this exact chat, authority `OBSERVED`, status `CURRENT`
     (an active-scene observation), not superseded;
   - other side: global lore of the active story's single bound Lorebook, verified as canon
     (the same `resolveNodeAuthority` rule Truth uses);
   - the two share a normalized alias (same subject), and their text differs.
3. Ask the existing `truth.conflict` Decision site for each pair. Only `REAL_CONFLICT`
   matters. The rule-based fallback must stay `UNRESOLVED`, so with no model nothing changes.
4. Store each row in the existing per-chat ephemeral advice record, with the revision of both
   nodes at judgment time (`leftRevision`, `rightRevision`). Truth already ignores a row whose
   recorded revision no longer matches the node it reads.
5. Never write to the World Tree. Nothing is stored on, or changed in, the canon node.

## Decisions needed before building it

- Whether another Decision call per pair is acceptable, and the cap (suggested: 4 per turn,
  matching the other families).
- Whether `REMEMBERED` memory facts should ever be allowed to take part. Task 2 says no:
  a remembered or quoted statement does not establish a current fact. A future marker that a
  memory was an established outcome would be needed first.
- Whether a conflict should expire when the scene that produced the chat fact closes.
  Truth already stops honoring it once the chat node is no longer `CURRENT`.

## Acceptance for a producer

- With Decision Core off or no provider, no row is produced and Truth output is unchanged.
- Rows are keyed to one chat. Another chat, or another story's Lorebook, never receives them.
- A live chat that contradicts canon on purpose produces a `CHAT_FACT_SUPERSEDES_CANON`
  verdict in Diagnostics for that chat and leaves other chats reading canon.
