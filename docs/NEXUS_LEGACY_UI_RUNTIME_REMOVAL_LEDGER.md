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

## Removed / disconnected — subsystem presentation cluster

| Legacy runtime or module | Removal state | Previous role | Replacement / disposition |
|---|---|---|---|
| `activity-feed.js` | DELETED | Legacy Nexus activity feed window and launch surface | UI.Core activity, Brain, diagnostics, and turn-log surfaces |
| `memory/ui.js` | DELETED | Memory Bank / Notebook / Character Bank legacy operator window | World Tree target model + future focused UI.Core views; memory runtime modules remain for later dismantling |
| `observability/ui.js` | DELETED | Legacy diagnostics/telemetry panel | UI.Core diagnostics, forensics, Brain and turn-log workspaces |
| `paging/ui.js` | DELETED | Vector/lore paging settings and controls | Paging runtime remains headless until represented in UI.Core |
| `proposals/ui.js` | DELETED | Legacy proposal review panel | UI.Core review/inspection surfaces; proposal runtime remains pending later convergence |
| `smart-context/ui.js` | DELETED | Legacy Smart Context panel/badges | Smart Context runtime remains headless pending UI.Core representation |
| `testing/ui.js` | DELETED | Legacy development/test-mode operator UI | No production replacement; future developer workspace is a known gap |
| `tree/ui.js` | DELETED | Legacy Nexus Lore Tree editor/workspace | World Tree + Area 52 UI.Core World/Lore surfaces |
| `decision/settings-ui.js` | DELETED | Legacy Decision Core settings UI | Future UI.Core resource/Brain controls |
| `retrieval/settings-ui.js` | DELETED | Legacy retrieval settings UI | Future UI.Core Brain/retrieval controls |
| `builder/ui.js` | DELETED | Legacy Builder operator UI | Future UI.Core Builder workspace; known coverage gap |
| `builder/quality-ui.js` | DELETED | Builder quality-report presentation helpers | Future UI.Core Builder workspace |
| `builder/builder2-operator-ui.js` | DELETED | Builder2 review/taxonomy/gap operator markup | Future UI.Core Builder2 workspace |
| `tree/ui-core-adapter.js` | DELETED | Adapter that upgraded legacy Tree buttons with old Nexus UI primitives | Obsolete because legacy Tree UI was removed |
| `ui/` legacy component package (41 files) | DELETED | Nexus-specific primitives, layouts, shell, gallery, tokens, and component CSS | Replaced wholesale by Area 52 `src/ui-core/` + `styles/ui-core*.css` |
| `lore/uid-summarizer.js::openUidSummarizer()` | REMOVED | Draggable UID Summarizer popup/review window | Headless `summarizeUid()` runtime retained; future review surface belongs in UI.Core |
| Legacy UI contract tests | DELETED | Asserted removed Nexus settings/Tree/Memory UI files and selectors | Replaced by `tests/area52-ui-transplant-contract.mjs` |
| Legacy test harness launcher surfaces | DELETED | Change Gate, Character Bank, World Load, and test-mode browser launcher UI | Non-UI fixtures/oracles retained |
| `.github/workflows/task208-211-ui-validation.yml` | DELETED | CI dedicated to legacy Nexus UI contracts | UI transplant contract + surviving runtime workflows |
| Builder/Decision/Prompt Loader legacy UI CI steps | REMOVED | Syntax/regression checks for deleted UI modules | Runtime checks retained; UI checks now target Area 52 transplant boundary |
| `maintenance/housekeeper-diagnostics.js` | DELETED | Legacy Developer Diagnostics renderer built entirely on removed Nexus `ui/` primitives and old Tree review UI | Housekeeper runtime/state retained; future diagnostics belong in UI.Core |
| `testing/test-mode-adapter.js` | DELETED | Development Test Mode adapter that directly opened legacy Memory Bank and Builder UI surfaces | Test fixtures/oracles remain; no product UI replacement required |
| `observability/sidecar-status.js` | DELETED | Legacy DOM renderer/binder for Main + Sidecar status strips | UI.Core Brain/resource/status surfaces own presentation; telemetry/runtime sources remain |

| legacy `settings.enabled` master switch | RETIRED AS AUTHORITY | Internal UI toggle that could disable the whole extension | SillyTavern extension manager owns master activation; compatibility field is forced true while loaded |
| `nexus/main-bridge-status.js::mainBridgeStatusHtml()` | REMOVED | Legacy HTML formatter for the old Main/Sidecar runtime strip | Read-only `snapshotMainBridgeStatus()` + status event remain for future UI.Core adapters |

## Presentation-removal checkpoint

The old Nexus presentation layer is structurally removed. The branch validator reports no unresolved imports into deleted UI, and the only production DOM creation outside UI.Core is limited to intentional file-download helpers in telemetry export and Character Card export.

Further work should focus on adopting UI.Core bindings and the World Tree transition rather than preserving or reconstructing Nexus presentation code.

## Pending removal audit

No known legacy product UI runtime remains active. Runtime/business modules are not deleted merely because their legacy UI is gone.

The Lore Tree, Memory Bank, and Character Bank runtime/data systems will be dismantled separately as the World Tree replaces them; those removals must not be conflated with UI-only deletion.
