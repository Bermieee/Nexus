# Area-52 → Nexus Port List

This branch extends the original seven-system port with the supporting world-model systems they depend on. The rule is unchanged: port capability cores and contracts, not Area-52 deployment, ownership, settlement, audit, certification, Context Seal, native-brain, framework-kernel, or memory plumbing.

## Primary systems

1. Truth Gate — truth-gate.js
2. Sensory Net — candidate-bus.js, candidate-bus-contracts.js, retrieval-channel-registry.js
3. Graph Walker — graph-neighborhood-retriever.js
4. Hot Cognition — hot-cognition-*
5. Scene Intelligence — isolated scene model, boundary, transition, and Nexus observation adapter
6. Green Room — inferred-only character state
7. Scatter / Gather — layered admission, foreground quorum, gather routing

## Supporting systems now in the port list

- Lore temporal rules — automatic supersession/conflict/attribution semantics for studied lore.
- Entity identity registry — canonical entity IDs, aliases, provider/source links, and story isolation for Graph Walker and World Tree.
- Temporal state graph — current/historical/superseded claim state beneath World Tree and Truth Gate.
- Lore world ontology — read-only learned-lore nodes, relationship edges, communities, and source revision fences.
- Lore Study — engine, runtime, and source/derived registry so existing lorebooks can populate the learned world model automatically.
- Scene-to-Lore handoff — bounded scene-driven retrieval/update candidate handoff; integration remains later because it crosses the scene/lore mutation boundary.
- Structured output validation — provider-neutral parse/type/semantic/normalize validation for Scene phase B, Green Room, and later structured sidecar outputs.
- Prompt integrity checks — Nexus-native seal-time checks for inferred material in current-fact lanes, historical facts missing a past label, and Green Room authority escalation.

## Landing and hookup order

Supporting cores land isolated first. Runtime promotion still follows the original order: Truth Gate → Sensory Net + Graph Walker → Hot Cognition → Scene Intelligence → Green Room → Scatter/Gather. Identity + temporal graph are prerequisites for the Graph Walker promotion. Lore temporal rules and Lore Study feed the temporal graph/ontology but do not write directly to the prompt. Scene-to-Lore is activated only after Scene Intelligence and the lore owner adapter are stable.

Every runtime step remains Off / Shadow / On and preserves Nexus generation-frame publication, scope/epoch freshness, sidecar bus, Work Director, memory, summaries, and provider selection.

## Explicitly left behind

Area-52 Context Seal, audit/ledger/certification layers, settlement orchestration, Jev, native brain, framework kernel, deployment/resource-connections/generation-publication/owner-* plumbing, and Area-52 memory stack are not part of this port.
