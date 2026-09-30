# Area 52 UI -> Nexus migration

Branch: `ui/area52-transplant`

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
