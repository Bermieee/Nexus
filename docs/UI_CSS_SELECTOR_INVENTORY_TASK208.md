# Task #208 — UI/CSS selector inventory

Baseline: `Bermieee/Development@development` (inventory prepared before legacy deletion)

## Production loading contract

Ordinary Nexus loads only the production stylesheets from `style.css`:

- `ui/tokens.css`
- `ui/nexus-ui.css`

The four files under `tests/harness/**` are test-only and are loaded lazily by `tests/harness/test-mode-launcher.js` only after the operator opens the corresponding Test Mode surface.

## Legacy `tv2-*` family inventory

This is a conservative ownership inventory. **Live/compatibility families are not deletion candidates.** A selector becomes removable only after its markup/event-hook owner is proven absent and a regression contract is added.

| Family | Approx. selectors in style.css | Disposition | Current owner / reason |
|---|---:|---|---|
| `tv2-tree-*` | 80 | LIVE / COMPATIBILITY | Tree UI, Builder/Tree controls and event hooks |
| `tv2-character-*` | 69 | LIVE / COMPATIBILITY | Memory Bank Character workspace; #211 moves geometry to UI Core but legacy hook classes remain behavioral compatibility |
| `tv2-proposal-*` | 37 | LIVE | Proposal review / approval UI |
| `tv2-feed-*` | 28 | LIVE | Nexus Feed surfaces and diagnostics visibility |
| `tv2-uid-*` | 27 | LIVE | UID summarizer / review |
| `tv2-memory-*` | 25 | LIVE / COMPATIBILITY | Memory Bank tabs, actions, legacy fallback hooks |
| `tv2-merge-*` | 25 | LIVE | Merge review/workflow |
| `tv2-b2-*` | 24 | LIVE | Builder 2 operator workflow |
| `tv2-tv-*` | 18 | LIVE / COMPATIBILITY | Settings/card chrome |
| `tv2-window-*` | 18 | LIVE / SHARED | Shared draggable window chrome |
| `tv2-card-*` | 17 | LIVE | Character Card import/sync |
| `tv2-lore-*` | 14 | LIVE | Lore editor/routing surfaces |
| `tv2-log-*` / `tv2-diag-*` | 15 | LIVE | Diagnostics/log viewer |
| `tv2-sidecar-*` | 9 | LIVE | Sidecar settings/status cards |
| `tv2-commit-*` | 8 | LIVE | Commit/recovery visibility |
| `tv2-bank-*` | 7 | LIVE | Memory/Bank compatibility hooks |
| `tv2-test-*` | 7 | TEST/DEVELOPER ONLY | Test-mode controls; never justification for production harness CSS imports |
| `tv2-builder-*` / `tv2-builder2-*` | 12 | LIVE | Builder operator/review surfaces |
| `tv2-call-*` | 6 | LIVE | Function Gateway / call review |
| `tv2-char-*` | 6+ | LIVE EVENT HOOKS | Character behavior hooks retained under UI Core; geometry must not depend on them |
| `tv2-notebook-*` | 5 | LIVE | Notebook |
| `tv2-appearance-*` / `tv2-theme-*` | live set | LIVE | Appearance/theme settings and token bridge |
| `tv2-keyword-*` / `tv2-node-*` | live set | LIVE | Keyword/node tooling |
| `tv2-lifecycle-*` | 4 | LIVE | Lifecycle settings/status |
| `tv2-lorebook-*` | 4 | LIVE | Lorebook controls/policy |
| `tv2-story-*` | 4 | LIVE | Story scope controls |
| `tv2-main-*` / `tv2-provider-*` / `tv2-route-*` | live set | LIVE | Runtime/provider/routing controls |

## Proven retired/orphaned selectors

Task #197 already maintains the regression list for selectors proven retired. #208 does **not** broaden that deletion set. No additional `tv2-*` family is deleted solely because its styling looks old.

## #211 ownership note

Character State layout is now owned by `ui/nexus-ui.css` through `nx-character-*` components. The `tv2-char-*` classes that remain in `memory/ui.js` are event-hook compatibility classes for existing handlers, not layout authority. The left Character Bank rail and right Character State Review rail remain stable workspace surfaces.

The operator-facing center Character State surface has exactly five primary policy areas:

1. Personality
2. Relationships
3. Status / conditions / equipment
4. Goals / unresolved threads
5. Behavior changes

Non-policy profile/identity fields remain in the underlying Character State contract/storage for provenance, compatibility, Card Sync, and data safety, but they are not rendered as Character State boxes. No separate Character Details box is part of the Character State center workspace.
