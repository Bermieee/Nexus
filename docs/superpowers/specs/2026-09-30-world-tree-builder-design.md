# World Tree Builder redesign

Status: proposed specification for review. No implementation started.

## Agreed purpose

Builder has two responsibilities: organize Lore into a meaningful, navigable
structure, and design how that structure flows visually. It places selected
material within the wider canonical World Tree, rather than creating an isolated
tree for each Lorebook. The result must accommodate future Scene observations,
character-card information and evidence-backed relationships between nodes.

The current World Tree presentation is the product baseline. Its evenly spaced
radial layout should become organic: uneven branching, content-dependent cluster
sizes, useful separation and stable placement. Processing status such as READY
or STUDYING must not become the semantic organization of a build. The old Memory
Bank windows do not define the new Builder experience.

## Existing implementation and reuse

Builder 2 has survey, taxonomy, classification, gap detection, reconciliation,
quality review, resumable plans and freshness-fenced commit machinery. Preserve
these capabilities where they serve the new contract. Its Nexus materializer
currently creates the legacy tree and attaches Lore UIDs to its nodes; replace
that output path for the new build flow.

The canonical World Tree already owns scoped nodes, edges, provenance, temporal
state and entity identity. The current graph renderer has position handling.
Builder must use those owners and presentation seams rather than introducing a
second authoritative tree or a separate graph renderer. Reuse is conditional on
the new interfaces; passing legacy tests does not prove the new build works.

Expose one World Tree Builder workflow. Builder and Builder 2 may remain internal
modules during migration, but are not two competing operator experiences.

## Three distinct products of a plan

1. Organization: categories, nesting, source-entry placement and navigation links.
2. Relationships: proposed connections between entities with explicit evidence,
   provenance, story scope and temporal meaning.
3. Layout: visual branching and arrangement preferences, with positions and pins.

Organization does not assert a factual relationship. Visual closeness does not
assert either shared identity or a relationship. Layout changes must not change
retrieval authority, factual confidence or temporal status.

Default organization preserves the owner's single primary parent per node,
with additional navigation/relationship links instead of duplicate source nodes.
This is a design default to review, not an already implemented capability.

## Build flow

Select source material in the current World Tree workspace. Capture its revision
and the relevant existing world structure, scoped to the active story and its
authorized global sources. Survey the selected material against that structure.

Propose reuse of existing branches and entity identities, new branches where
needed, and source placements. Names alone are insufficient proof of identity.
Ambiguous matches are visible in the preview and require resolution; they are
not silently merged. Every selected source receives an explicit placement or a
visible unresolved/excluded disposition.

Build a layout plan for the proposed organization. Preview both the organization
and the arrangement in the existing World Tree view. Allow the operator to edit
names, placements and layout, pin important nodes, and inspect proposed links.
Review and apply the resulting plan through Nexus's canonical mutation path.

The normal operation extends or revises the selected material's placement.
A separate explicit reorganize action permits a broader redesign. Loading a
source or receiving new Scene evidence must not trigger a wholesale rebuild.

## Plan contract

A versioned build plan must contain:

- Run identity and source, world, organization and layout revision fences.
- Selected sources and their stable IDs; permitted global/story scope.
- Category and placement operations referring to existing or proposed IDs.
- Identity matches, their evidence and unresolved alternatives.
- Relationship proposals with source evidence, scope and temporal classification.
- Layout preferences, stable seed, affected nodes, positions and operator pins.
- Coverage accounting, exclusions, warnings and review decisions.
- A reviewed immutable commit fingerprint and explicit commit outcome.

The plan references source bodies through their owners; it does not replace the
authored source or promote a generated summary into factual authority. Summarizer
results may inform navigation labels or overview text while retaining their
derived status. Summarizer scheduling and windows remain separate UI work.

## Organic layout

Builder designs the branching: category hierarchy, relative cluster placement,
branch direction, spacing preferences and important-node prominence. A bounded,
deterministic layout pass resolves these preferences into drawable coordinates,
avoiding collisions and protecting readable labels. The renderer applies that
plan and owns drawing, pan, zoom, selection and interaction.

Large groups get more space; small groups remain compact. Related groups may be
placed near each other without turning proximity into a factual edge. Uniform
angular slots and identical rings are not the default arrangement.

Use persistent node IDs and a stable seed. Preserve pins and unaffected positions
when adding material. Reopening the same committed layout must reproduce its
arrangement; continuous simulation and whole-tree reshuffling are not required.
Store layout in a presentation owner keyed to canonical node IDs, separately
from factual node state. Removing a layout must not delete knowledge.

## Publication and recovery

Preview reads a staged projection and does not mutate the live World Tree.
Validate source and world revisions at review and again at commit. If authority
changes, mark the affected plan stale and re-analyze those operations; do not
apply a partially outdated build or erase unaffected operator decisions.

Publish canonical organization/approved relationship changes through the existing
mutation coordinator. Record the accepted canonical revision before publishing
its associated layout. If layout publication fails, preserve the accepted world
changes, report the layout as pending and permit retry. Never claim the complete
build succeeded when either required publication is unfinished.

Persist plans and resumable stage progress. Cancel/reload preserves authored
sources and the last committed world. Re-running a committed plan must not create
duplicate nodes or relationships.

## Future incoming knowledge

Scene and character-card ingestion use the same canonical entity IDs, provenance
and scope rules. Builder supplies the structure and layout into which their
contributions can be placed. It does not replace those ingestion owners.

New observations may extend the world locally. A Scene statement cannot silently
overwrite authored Lore; conflicting, uncertain and historical evidence remains
distinguishable. Story-local evidence must not become global through a build.

This redesign establishes the placement/relationship contracts those producers
will use. Implementing new Scene/card extraction pipelines is a subsequent task.

## Validation and acceptance

- Build material into an existing world, reusing appropriate branches rather than
  creating a parallel Lorebook tree.
- Account for every selected source and retain exact source drillback.
- Preserve distinct entities that share a name; show unresolved identity matches.
- Demonstrate organization links, factual relationships and layout independently.
- Preview and apply the same proposed organization and visual arrangement.
- Display uneven branches with readable labels and useful navigation.
- Reopen the layout unchanged; add material without moving pinned/unaffected nodes.
- Edit a source during analysis/review and reject stale publication.
- Cancel, restore and resume without duplicate writes or source loss.
- Preserve story isolation and existing temporal/provenance semantics.
- Insert representative Scene/card contributions through the agreed contract,
  without implementing or pretending to validate a new live ingestion pipeline.
- Confirm the installed World Tree UI reads the new build and layout; legacy
  Builder tests alone are insufficient acceptance evidence.

## Implementation boundaries

Plan implementation in three successive pieces: the canonical build/placement
contract and materializer; organic layout planning/persistence; then the existing
World Tree preview/review/apply wiring. Trace existing consumers before retiring
legacy adapters. Do not retain an old Lore tree as a second canonical owner.

The next artifact is an implementation plan after review of this specification.
