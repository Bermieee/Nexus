# Area 52 UI -> Nexus migration

Branch: `ui/area52-transplant`

Area 52 UI source snapshot: `main@670da42fe8e6da29c6148f09ba2c2af23e40031b`.

## Direction

Area 52 UI.Core is the new Nexus presentation layer. The legacy Nexus settings window and top-level UI wiring are not compatibility targets.

This first pass intentionally does **not** force Area 52 subsystem interfaces onto Nexus subsystems. UI.Core is mounted with truthful unavailable/empty states until clean owner bindings are added in later iterations.

## Imported presentation stack

- `src/ui-core/` from Area 52 main, with visible Area 52 branding changed to Nexus;
- the complete `styles/ui-core*.css` stack;
- Area 52 root `style.css` as the Nexus extension stylesheet;
- SillyTavern Wave 12/13 host mounting and floating navigation.

The one UI dependency on Area 52 coprocessor provider adapters was reduced to the two safe metadata-normalization helpers required by the UI so the transplant does not import Area 52 execution subsystems.

## Removed from active wiring

The legacy Nexus settings template/window, `bindUI()`, draggable standalone window, old activity-feed mount, and Memory Bank UI reset are no longer part of extension initialization.

## Next integration boundary

World Tree becomes the canonical shared state model. New bindings should target World Tree/read-model contracts rather than reconnecting UI.Core to the legacy Lore Tree, Memory Banks, or Character Banks.

## Removal ledger

Legacy UI/runtime removals are tracked continuously in `docs/NEXUS_LEGACY_UI_RUNTIME_REMOVAL_LEDGER.md`.


## Current Nexus UI.Core adoption state

The transplanted presentation stack is now internally Nexus-namespaced. UI selectors, CSS variables, data attributes, UI events/state identifiers, persistence namespace, and active validation names no longer use the inherited Area 52 namespace. Area 52 remains documented only as source provenance for the transplant.

Clean live owner seams currently wired into UI.Core:

- **Runtime / Home / Brain:** read-only queue depth, Work Coordinator activity, batch activity, Main bridge state, and Sidecar lifecycle.
- **Story / Scene:** read-only projection of the authoritative Nexus Scene Scanner accepted scene. Present participants/location/time/activity/objective/focus are exposed; referenced or off-screen entities are not promoted into scene presence.
- **Characters:** read-only SillyTavern Character Card metadata (identity, active card, tags/version/fingerprint). Raw description/personality text and Character Bank state are intentionally excluded.
- **Brain resources:** read-only Sidecar A/B configuration, availability, placement labels, and current load. UI.Core resource mutation actions remain unavailable.

Intentionally unbound in this iteration:

- **Lore:** Area 52 Lore Study contracts are not being force-mapped onto Nexus lore/runtime structures.
- **Memory:** the legacy Memory Bank UI is gone; Memory remains unavailable in UI.Core until its replacement owner model is established.
- **World:** reserved for the World Tree transition rather than reconnecting the legacy Nexus Lore Tree.
- **Builder / Builder2, Maintenance, Paging, Postturn, Proposals, Smart Context, Testing, Tools:** known future UI coverage work; their old Nexus presentation surfaces are not fallback targets.

Master extension activation is owned by SillyTavern's extension manager. The retired internal Nexus master toggle is now only a compatibility projection forced true while the extension is loaded.

## Validation boundary

The active validation workflow is **Nexus UI.Core validation**. It enforces:

- no reintroduction of deleted legacy Nexus UI imports;
- internal relative-import closure;
- no inherited Area 52 UI namespace in active presentation files;
- preservation of selected runtime regressions for UID summarization, Builder2, and Decision workflows;
- read-only runtime/Scene/resource/Character projection contracts;
- full JavaScript syntax closure.


## World Tree and Diagnostics focus

Current priority has shifted from broad subsystem surface coverage to two canonical owners:

1. **World Tree** — the replacement data model for legacy Lore Tree, Memory Bank, and Character Bank state.
2. **Diagnostics** — the single UI destination for telemetry, probes, health checks, synchronization evidence, and low-level runtime diagnostics.

The World workspace now reads the canonical `world-tree/` owner directly. Transitional Memory, Character, and Lore bridges populate that owner; they do not restore any deleted legacy UI.

The Diagnostics workspace now receives a centralized, metadata-bounded Nexus diagnostics feed plus World Tree synchronization health. New telemetry/probe producers should publish through owner telemetry/diagnostic APIs that feed this surface rather than creating separate operator panels.
