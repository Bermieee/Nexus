# Nexus UI Core

Nexus UI Core is the shared presentation and interaction layer for the Nexus extension.

## Ownership contract

**UI Core owns:** visual tokens, DOM composition helpers, accessibility defaults, responsive layout behavior, reusable controls, common empty/loading/error states, and generic interaction patterns.

**UI Core does not own:** subsystem semantics, persistence, mutation authority, scheduling, retrieval, proposal meaning, or recovery policy.

A component may display `queued`, `running`, `conflict`, or `approved`, but the subsystem supplying that state remains the authority for what the state means and when it changes.

## Migration rule

UI Core is introduced beside the current hand-built UI. Existing subsystems are not implicitly migrated. A subsystem becomes a consumer only through an explicit, separately tested migration checkpoint.

### Shared-component rule

**Subsystems must use the shared UI components and design tokens. Keep local CSS limited to subsystem-specific layout. Improve or extend the shared component when something is missing, instead of creating another local version.**

Local migration CSS may control composition only: grid/flex placement, spans, ordering, bounded sizing, and responsive arrangement. Visual grammar belongs to UI Core: surfaces, borders, colors, typography, radii, pills, buttons, fields, tabs, collapsibles, rows, notices, hover/focus states, and status treatments.

### Adaptive sizing contract

UI Core standardizes **how components size**, not one fixed width for every component. The shared contract is:

- semantic pills/badges hug their content, expand for longer labels, and may wrap only when the available container becomes narrower than the label;
- buttons are content-sized by default and may opt into the shared `fill` variant when a layout deliberately needs a full-width action;
- inputs, selects, search fields, and textareas fill the grid/column assigned by the owning layout rather than carrying subsystem-specific pixel widths;
- panels/collapsibles/rails fill their container, while their vertical size remains content-driven;
- labels/help/readouts use shared typography tokens and wrap instead of forcing neighboring controls to stretch;
- subsystem CSS may choose the grid fractions or responsive stacking for its workflow, but it must not redefine shared component font, padding, radius, border, or intrinsic-sizing behavior.

**Same visual grammar, adaptive dimensions.** Longer words are expected to produce wider pills/buttons when space permits; different workflows are expected to allocate different column widths without producing visually different controls.

## Package layout

- `tokens.css` — design tokens mapped to SillyTavern theme variables.
- `nexus-ui.css` — scoped component and shell styles.
- `core/` — DOM and accessibility helpers.
- `primitives/` — buttons, inputs, toggles, badges, tooltips.
- `layout/` — panels, tabs, collapsibles, rails, split panes, modal/drawer, toolbars.
- `data/` — lists, tables, search, history, progress, diff and empty states.
- `nexus/` — reusable Nexus-flavored presentation widgets with no subsystem ownership.
- `shell/` — page/workspace composition.
- `gallery.js` — development-only isolated component gallery; not mounted by runtime.


## Appearance integration

**Nexus Appearance is the visual source of truth.** `theme.js` owns the selected preset/custom palette plus font and shape settings and publishes them through the existing `--tv2-*` variables. UI Core bridges those raw Appearance values into semantic `--nx-*` tokens such as `--nx-heading`, `--nx-input-bg`, `--nx-selected-bg`, and `--nx-border-strong`.

Migrated subsystems must not hard-code brand colors, literal purple/blue/gold roles, custom radii, or private font stacks. They consume UI Core semantic tokens/components. Status colors such as success/warning/error may remain stable semantic colors, while their surrounding surfaces and text treatment inherit the active Appearance palette.

Changing a Nexus Appearance preset or custom color therefore updates every UI Core consumer without a subsystem-specific theme patch.

## CSS scope

All visual rules are scoped beneath `.nexus-ui`. Loading UI Core CSS must not restyle legacy Nexus or SillyTavern markup.

## DOM contract

Components return DOM nodes. They do not persist state. Local presentation state such as an open tab or collapsed panel may live in the DOM instance; durable state must be passed in by the owning subsystem.
