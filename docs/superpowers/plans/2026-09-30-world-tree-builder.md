# World Tree Builder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task in this session. Steps use checkbox syntax for tracking.

**Goal:** Build meaningful organization and organic visual flow into the existing canonical World Tree, using the finished UI.

**Architecture:** Adapt Builder 2's analysis/review pipeline to a versioned canonical-world placement plan. Publish organization through Nexus's existing mutation boundary and publish associated layout separately after its accepted world revision is durable. Extend the existing World Tree renderer and operator adapter; do not create a second tree owner or separate renderer.

**Tech Stack:** JavaScript ES modules, existing Nexus Director/Coordinator/transaction ledger, native SVG, existing durable Builder plan storage, Node tests.

**Spec:** `docs/superpowers/specs/2026-09-30-world-tree-builder-design.md`

## Global constraints

- Builder has two responsibilities: organize Lore into a meaningful, navigable structure, and design how that structure flows visually.
- Organization does not assert a factual relationship. Visual closeness does not assert either shared identity or a relationship.
- Preview reads a staged projection and does not mutate the live World Tree.
- A Scene statement cannot silently overwrite authored Lore.
- Story-local evidence must not become global through a build.
- Removing a layout must not delete knowledge.
- No new Scene/card extraction pipeline, replacement Summarizer, legacy UI resurrection or automatic whole-world rebuilding.
- Keep source IDs stable; statuses READY/STUDYING are badges, not semantic categories.
- Plan approval is distinct from canonical commit approval in the product.

## Finished UI baseline

Remote main at inspection: `dec36cf`. The UID Summarizer window, its operator actions and its tests are present. `src/ui-core/lore-neural-graph.js` owns SVG rendering, drag positions and a currently disabled Rebuild button. `nexus-ui-host.js` owns product bindings. `Wave13LoreStudyUIAdapter` already exposes source loading, Merge and Summarizer actions. Extend these seams without changing their unrelated behavior.

## File boundaries

- `builder2/world-plan.js`: canonical build contract and validation.
- `builder2/world-context.js`: scoped source/world inventory and revision fences.
- `builder2/world-materializer.js`: staged canonical node/placement/link operations.
- `builder2/world-controller.js`: analysis/review/resume/commit orchestration.
- `world-tree/layout.js`: deterministic organic layout planning.
- `world-tree/layout-store.js`: separate presentation state and retryable publication.
- Existing Builder 2 pipeline/authority modules: analysis adapter, not legacy publication.
- Existing host/operator/graph files: one preview/review/apply experience.

## Review focus

1. Same UID in different Lorebooks: preserve distinct stable source IDs (Tasks 1/2).
2. Same entity name in different stories: never automatically merge identities (Tasks 2/3).
3. Source changes while preview is open: reject stale apply and preserve review edits (Task 4).
4. Layout save fails after world commit: report pending layout and retry without replaying world mutations (Tasks 4/5).
5. Many entries, empty categories, or pinned collisions: report coverage and unresolved overlap honestly; never silently omit sources or move pins (Tasks 3/5/6).

## Task 1: Canonical build contract

**Files:** Create `builder2/world-plan.js`; test `tests/world-tree-builder-plan.mjs`.

**Interfaces:** `createWorldBuildPlan(input) -> plan`, `validateWorldBuildPlan(plan) -> {valid,errors}`, `worldBuildFingerprint(plan) -> string`.
Plan contract `nexus-world-tree-builder/v1`; fields `runId`, `planRevision`, `scope`, `sourceFence`, `worldRevision`, `layoutRevision`, `sources`, `organization`, `identityMatches`, `relationshipProposals`, `layout`, `coverage`, `review`, `phase`. Organization contains `groups`, `placements`, `navigationLinks`; source IDs include book and UID, not UID alone. Every source has one disposition: PLACED, UNRESOLVED or EXCLUDED. All proposed relationships require source evidence and explicit scope.

- [ ] Write failing tests: two books with UID 1 remain distinct; missing source dispositions and organization cycles fail; processing-status categories fail; a relationship without evidence fails; a layout edge cannot become a factual operation.
- [ ] Run `node --test tests/world-tree-builder-plan.mjs`; confirm the new contract tests fail.
- [ ] Implement validation/fingerprinting; freeze or clone external inputs so review edits cannot mutate an approved fingerprint.
- [ ] Run the test and `node --check builder2/world-plan.js`; require zero failures.
- [ ] Commit the independently tested contract.

## Task 2: Read the existing world as Builder context

**Files:** Create `builder2/world-context.js`; modify `builder2/nexus-authority.js` and `builder2/pipeline.js`; test `tests/world-tree-builder-context.mjs`.

**Interfaces:** `readBuilderWorldContext({worldTree,chatId,selectedSources,authorizedSourceIds}) -> {scope,sources,groups,entities,relationships,worldRevision,sourceFence,coverage}`; `adaptWorldContextForBuilder2(context) -> analysisContext`. Task 1 defines source/placement identity; selected sources are exact authored references. Existing tree-shaped taxonomy inputs may be derived working projections, never a second stored authoritative tree.

- [ ] Write failing tests: existing appropriate groups appear as reuse candidates; foreign-chat nodes and unauthorized sources do not appear; matching names produce possible matches rather than automatic identity merges; more sources than one physical analysis batch remain fully accounted for.
- [ ] Run `node --test tests/world-tree-builder-context.mjs`; confirm failure before implementation.
- [ ] Implement scoped iteration using World Tree owner APIs; adapt survey/taxonomy/classification context to see the wider existing structure. Do not load only the selected Lorebook's legacy tree.
- [ ] Run the new tests plus `node tests/builder2-consolidated-flow.mjs` and `node tests/builder2-taxonomy-hedge.mjs`.
- [ ] Commit the context/analysis integration.

## Task 3: Materialize canonical organization and preview

**Files:** Create `builder2/world-materializer.js`; modify `builder2/structural-handoff.js`; test `tests/world-tree-builder-materialization.mjs`.

**Interfaces:** `materializeWorldBuildPlan(plan,context) -> {operations,preview,coverage,fingerprint}`; `validateWorldBuildMaterialization(result,context) -> {valid,errors}`. Operations use canonical IDs and existing World Tree `upsertNode`/parent/link semantics. Preview is a staged owner snapshot, preserving source bodies and provenance through references. Existing `nexus-materializer.js` remains available only to untouched legacy consumers during migration.

- [ ] Write failing tests: extend an existing group; move a source once without copying it; create a required new group; represent navigation and evidenced relationship links separately; unresolved identity proposals cannot silently merge nodes; every source remains reachable or explicitly unresolved/excluded; input owner snapshot stays unchanged.
- [ ] Run `node --test tests/world-tree-builder-materialization.mjs`; confirm failure.
- [ ] Implement canonical operations and staged preview, preserving primary-parent identity and temporal/provenance state. Exclusion affects this build's placement, not authored-source deletion.
- [ ] Run new tests plus `node --test tests/world-tree-core.mjs tests/world-tree-reader.mjs`.
- [ ] Commit canonical materialization.

## Task 4: Review, persistence and canonical publication

**Files:** Create `builder2/world-controller.js`; modify `builder2/nexus-controller.js`, `builder2/nexus-plan-store.js`, `builder2/nexus-commit-adapter.js`; test `tests/world-tree-builder-controller.mjs`.

**Interfaces:** `WorldTreeBuilderController` receives injected analysis, context, plan-store, mutation and layout adapters. Public methods: `start({sourceIds,chatId,mode='EXTEND'})`, `read(runId)`, `revise(runId,{planRevision,changes})`, `approve(runId,{fingerprint,by})`, `apply(runId)`, `cancel(runId)`, `resume(runId)`, `retryLayout(runId)`. Results include phase, preview, coverage, canonicalRevision and layout status. Mode REORGANIZE requires explicit operator selection.

- [ ] Write failing tests: analysis cancellation/reload resumes without duplicate provider work where durable stage output exists; changed source/world/review fingerprint blocks commit; successful replay returns the original commit; layout failure yields LAYOUT_PENDING after canonical commit; retryLayout does not repeat canonical mutations; a chat switch fences old work.
- [ ] Run `node --test tests/world-tree-builder-controller.mjs`; confirm failure.
- [ ] Reuse the existing pipeline's staged analysis and review lifecycle with Tasks 1–3. Use existing mutation coordinator admission and durability hooks; confirm its rollback/recovery adapter handles canonical World Tree changes before enabling Apply. Persist the accepted world revision before invoking Task 5's layout publication. Keep canonical commit and layout retry states explicit.
- [ ] Run new tests and existing Builder 2 consolidated and worker-pool tests. Inject persistence/abort failures at the owner boundary, not only in the UI.
- [ ] Commit controller/publication integration.

## Task 5: Organic layout and separate presentation persistence

**Files:** Create `world-tree/layout.js`, `world-tree/layout-store.js`; test `tests/world-tree-builder-layout.mjs`.

**Interfaces:** `planWorldTreeLayout({nodes,organization,relationships,previousLayout,pins,seed,mode='EXTEND'}) -> {positions,branches,pins,coverage,warnings}`; `WorldTreeLayoutStore` with `read(scope)`, `publish({scope,worldRevision,expectedLayoutRevision,layout})`, `exportState()`, `restore(state)`. Scope contains story and world identity; layout publication has no factual mutation authority.

- [ ] Write failing tests: uneven category sizes produce uneven branch spacing; identical input/seed reproduces positions; adding a source preserves unaffected positions and pins; REORGANIZE may move unpinned nodes; overlapping pins remain fixed and produce warnings; deleting presentation state leaves canonical facts untouched; stale layout revision blocks overwrite; round-trip restore preserves positions.
- [ ] Run `node --test tests/world-tree-builder-layout.mjs`; confirm failure.
- [ ] Implement deterministic branching with seeded angular offsets, space weighted by descendant counts and bounded collision resolution for affected unpinned nodes. Report unresolved overlap instead of running an endless simulation. Keep layout data separate from canonical factual revisions.
- [ ] Wire layout durability using injected owner storage and existing scoped save machinery; test failed saves and retry. Validate finite coordinates before publication.
- [ ] Run the layout and controller tests; require zero failures.
- [ ] Commit layout planning/persistence.

## Task 6: Wire the finished World Tree UI and prove the installed flow

**Files:** Modify `nexus-ui-host.js`, `src/ui-core/wave13-operator-adapters.js`, `src/ui-core/wave13-operator-surfaces.js`, `src/ui-core/lore-neural-graph.js`; create `src/ui-core/world-tree-builder-console.js`; test `tests/world-tree-builder-ui-runtime.mjs`; extend `.github/workflows/nexus-ui-core-validation.yml`.

**Interfaces:** Host bindings `startWorldTreeBuild`, `readWorldTreeBuild`, `reviseWorldTreeBuild`, `approveWorldTreeBuild`, `applyWorldTreeBuild`, `cancelWorldTreeBuild`, `resumeWorldTreeBuild`, `retryWorldTreeBuildLayout`, `readWorldTreeLayout`, `saveWorldTreeLayoutPins`. All delegate to Tasks 4/5. Add corresponding adapter methods/capabilities; unavailable owners keep actions disabled with explicit reasons.

- [ ] Write failing tests through the actual host and operator adapter: selected source opens one Builder console; preview reads the staged graph without modifying canonical data; review edits change the preview; Apply checks the approved fingerprint; cancellation leaves the published world unchanged; no duplicate handler publication; chat switch cannot reuse prior preview; Summarizer and Merge retain their existing behavior.
- [ ] Run `node --test tests/world-tree-builder-ui-runtime.mjs`; confirm failure.
- [ ] Wire the existing disabled Rebuild control to the new Builder capability, using EXTEND by default and explicit REORGANIZE selection. Preview in the existing renderer, with a visible preview indicator, coverage/unresolved results and Apply/Cancel actions. Do not embed a second graph implementation in the console.
- [ ] Apply owner layout coordinates to rendered nodes before local drag overrides; save operator pins through Task 5, not only `renderState.nodePositions`. Missing layout uses the existing fallback until a reviewed build is published.
- [ ] Run new UI tests plus `node --test tests/uid-summarizer-ui-runtime.mjs tests/lore-world-tree-ui-runtime.mjs tests/nexus-ui-runtime-binding.mjs tests/nexus-diagnostics-owner-wiring.mjs`.
- [ ] Commit UI integration and CI coverage.

## Final verification and handoff

- [ ] Run all six new test files against the final code and the existing Builder, World Tree, Scene, Sensory and Summarizer focused suites.
- [ ] Run `node tools/run-offline-checks.mjs <unique-evidence-directory>` once after the final functional changes; compare failures to the recorded baseline rather than claiming the repository is universally green.
- [ ] Inspect the final diff for legacy canonical tree writes, source destruction, unauthorized identity merges and layout fields changing factual authority.
- [ ] Record SHAs, evidence paths, migration limits and live acceptance instructions in `docs/integration/world-tree-builder.md`.
- [ ] Live acceptance: build into an existing world, review/apply, reload, add another source, verify stable pins and navigation, and inspect story isolation. State explicitly if real browser/provider execution is unavailable.

## Self-review

All spec sections map to Tasks 1–6. Future Scene/card inputs are contract fixtures, not a new extraction implementation. Source identity, relationship evidence and layout publication are distinct. Layout failure recovery does not replay factual writes. The UI baseline is the completed Summarizer/World Tree surface, not a pre-merge snapshot. The five Review Focus cases each have an owning task and a named test condition.
