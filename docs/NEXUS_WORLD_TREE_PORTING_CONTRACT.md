# Nexus World Tree Porting Contract

This migration makes the Area 52 World Tree the target shared data model for Nexus. The current Nexus Lore Tree, Memory Banks, and Character Banks are transitional systems and will be dismantled rather than preserved as parallel canonical stores.

## Core rule

The World Tree is the contract. UI.Core renders it and cognitive/runtime systems consume it directly. Do not introduce a second translation model whose job is to mirror permanent lore, character, or memory state.

## Node contract

Every durable node must carry enough identity to answer five questions without consulting legacy banks:

- **kind** — what the node represents (world/container, lore/fact, character, character-state, memory/event, claim, or another explicitly versioned kind);
- **scope** — where the node is valid: shared/global or chat-scoped. Shared character facts and chat-specific character state must remain distinguishable;
- **provenance** — where the node came from, including source system and source identifiers;
- **temporal status** — current, historical, superseded, contradicted, uncertain, or unresolved as appropriate;
- **revision identity** — the revision/fence needed to reject stale work and invalidate derived state.

A minimum durable shape should be able to express:

```js
{
  id,
  kind,
  parentId,
  scope: { type: 'GLOBAL' | 'CHAT', chatId: null },
  provenance: {
    sourceType,
    sourceIds: [],
    messageRefs: [],
    importedFrom: null,
  },
  temporal: {
    status: 'CURRENT',
    supersedes: [],
    supersededBy: [],
  },
  revision,
  data,
}
```

The exact schema may evolve, but scope, provenance, temporal state, and revision identity are non-optional concepts.

## Scope invariant

Lore may be shared across chats. Memories are normally chat-scoped. Character facts may be shared while character state can be chat-scoped. A consumer must never infer scope from node kind alone.

Legacy/ported claims that cannot prove their chat scope must not silently become globally visible. They should remain quarantined, unresolved, or explicitly imported under a chosen scope.

## Provenance and message invalidation

Memory nodes derived from chat messages must retain the exact source message identities/revisions required to invalidate them when messages are edited, swiped, or deleted. Importing a Memory Bank into the World Tree must preserve this correction path rather than flattening memory into detached prose.

## Temporal truth

Truth Gate classification belongs on World Tree state rather than in a separate lore-only structure. Graph/retrieval consumers must be able to distinguish current, historical, superseded, contradicted, uncertain, and unresolved knowledge without destructive deletion of older state.

## Graph Walker

World Tree parent/child structure plus explicit node relationships are the Graph Walker's graph. Lore, characters, memories, events, and claims become traversable through one identity space instead of separate banks with ad-hoc joins.

## Ephemeral cognition is not durable tree state

Green Room readings, Hot Cognition segments, speculative candidates, and other short-lived guesses must not be promoted to permanent World Tree nodes merely because they reference durable nodes. They may exist as an ephemeral overlay keyed to node IDs, chat/turn/generation, and an expiry/TTL.

Durable promotion requires the normal evidence/truth/settlement path.

## Importers required

The migration will need explicit one-way importers for:

1. existing SillyTavern/Nexus lorebooks and Lore Tree material;
2. Nexus Character Banks / character-state material;
3. Nexus Memory Banks and their message provenance.

Import must be repeatable/idempotent where practical and must preserve source identity so later corrections can be reconciled.

## Initial consumers

- **UI.Core / World workspace** renders and inspects the tree.
- **Lore ingestion/retrieval** reads/writes lore-shaped nodes rather than maintaining a parallel canonical lore tree.
- **Character state** reads shared character facts plus chat-scoped state nodes.
- **Memory** writes chat-scoped event/memory nodes with message provenance.
- **Graph Walker** traverses tree relationships and explicit edges.
- **Truth Gate** reads/writes temporal/truth labels through owner-approved settlement.
- **Context/retrieval assembly** selects scoped, current, provenance-backed nodes and can still inspect historical/unresolved state when the task calls for it.

## UI migration consequence

Do not spend migration effort recreating the legacy Nexus Lore Tree, Memory Bank, or Character Bank interfaces inside the new UI. Their replacement surface is the World Tree plus focused views/inspectors over the same underlying node model.
