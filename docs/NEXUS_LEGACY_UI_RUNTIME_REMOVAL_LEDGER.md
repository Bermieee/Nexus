# Nexus legacy UI runtime removal ledger

Branch: `ui/area52-transplant`

This file is the running record of legacy Nexus presentation/runtime surfaces removed during the Area 52 UI.Core transplant.

Rules for this ledger:

- Add an entry when a legacy UI runtime, mount path, event/UI bridge, or subsystem presentation module is actually removed or disconnected from active initialization.
- Do not mark a subsystem runtime removed merely because its UI is hidden. Runtime/business logic remains separate from presentation removal.
- Record blockers when a UI module still contains non-UI behavior that must be extracted before deletion.
- Replacement ownership should point to UI.Core, World Tree, or another explicit Nexus owner rather than an implicit legacy fallback.

## Removed / disconnected

| Legacy runtime or module | Removal state | Previous role | Replacement / disposition |
|---|---|---|---|
| `renderExtensionTemplateAsync(..., 'settings')` settings mount | REMOVED FROM INITIALIZATION | Rendered the legacy Nexus settings HTML | Area 52 Wave 12/13 SillyTavern host mount through `nexus-ui-host.js` |
| `standalone-ui.js` | DELETED | Mounted/opened/destroyed the standalone Nexus control window | UI.Core host-adjacent/floating product shell |
| `ui.js` | DELETED | Bound the legacy monolithic Nexus settings controls | UI.Core workspaces/actions/read models |
| `windowing.js` | DELETED | Draggable/resizable legacy standalone window behavior | UI.Core Wave 13 floating navigation/controller |
| `theme.js` | DELETED | Legacy Nexus UI theme behavior | Area 52 UI.Core stylesheet/theme system |
| legacy `bindUI()` startup path | REMOVED FROM INITIALIZATION | Activated legacy settings controls | `mountNexusUi()` |
| legacy Activity Feed UI startup via `initActivityFeed()` | DISCONNECTED | Mounted the old Nexus activity-feed presentation | UI.Core activity/diagnostic surfaces; legacy module file remains until dependency audit |
| Memory Bank UI reset hook via `resetMemoryBankUiState()` | DISCONNECTED | Reset legacy Memory Bank presentation state on chat change | No replacement UI state is created; Memory Bank is scheduled for World Tree replacement |

## Pending removal audit

These files/surfaces still exist and must be checked for non-UI responsibilities before deletion:

- `activity-feed.js`
- `memory/ui.js`
- `observability/ui.js`
- `paging/ui.js`
- `proposals/ui.js`
- `smart-context/ui.js`
- `testing/ui.js`
- `tree/ui.js`
- `decision/settings-ui.js`
- `retrieval/settings-ui.js`

The Lore Tree, Memory Bank, and Character Bank presentation paths are not preservation targets. Where one of these modules owns business/runtime behavior in addition to UI, that behavior must be extracted or allowed to disappear with the subsystem replacement plan before the UI module is deleted.
