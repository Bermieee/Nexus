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


## Implemented on ui/area52-transplant

The first canonical owner is now live under `world-tree/`.

Implemented invariants:

- durable nodes require explicit GLOBAL or CHAT scope;
- message-derived nodes are forbidden from GLOBAL scope;
- chat-local edges cannot cross chat identities;
- GLOBAL edges cannot point into chat-local state;
- source-message invalidation can supersede affected nodes without deleting history;
- Green Room, Hot Cognition, speculative, and runtime overlays are held in a separate non-durable overlay store;
- durable World Tree export intentionally excludes ephemeral overlays;
- Area 52 Entity Identity Registry and Temporal State Graph primitives are ported into the World Tree owner with source provenance pinned to Area 52 `main@670da42fe8e6da29c6148f09ba2c2af23e40031b`.

Transitional importers now populate the World Tree:

- **Memory Bank importer**: chat-scoped memory nodes, exact source-message provenance, validity-aware supersession, promotion hierarchy edges;
- **Character Bank importer**: global identity only for stable bound SillyTavern cards, chat-scoped character state, unbound legacy characters kept chat-scoped, explicit Character↔Memory links become graph edges;
- **Lore importer**: SillyTavern World Info entries become durable global `LORE_FACT` nodes; the old Nexus Tree contributes only `LORE_GROUP` structure; removed entries are superseded instead of deleted.

Legacy stores remain transition write sources for now. The World Tree is the canonical target and UI read owner; later migration cuts should replace subsystem reads/writes one owner at a time rather than preserving parallel models.

## Diagnostics rule

All telemetry, probes, health checks, and low-level owner diagnostics must route to the Nexus Diagnostics surface.

The centralized Diagnostics envelope currently includes:

- general observability telemetry, including Prompt Loader and Main-request events;
- Decision telemetry;
- Retrieval diagnostics;
- Runtime and Job Queue snapshots;
- Generation Frame diagnostics;
- Scene Scanner diagnostics;
- Main bridge status;
- Sidecar resource probe/health results;
- World Tree revision/counts and legacy importer/bridge synchronization status.

Diagnostics sanitizes the envelope before UI presentation. Raw prompts, provider request/response bodies, credentials, hidden reasoning, representation/story/lore bodies, and other sensitive payload fields are redacted.

## Rendering policy

Nexus now installs an extension-wide rendering policy before `index.js` loads. It owns native SVG element creation, SMIL animation startup, animation capability reporting, and SYSTEM/FULL/REDUCED motion policy. SYSTEM mode respects the operating/browser `prefers-reduced-motion` setting. UI.Core and the World Tree neural graph consume this shared extension policy rather than maintaining private SVG/motion rules.
