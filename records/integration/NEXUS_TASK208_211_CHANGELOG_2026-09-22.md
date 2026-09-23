# Nexus Tasks #208 / #211 — Change Log
Date: 2026-09-22
Branch: development
Base commit: b00977a2bfddf8b563a8c844ec1aebf441ac51b6

## #208 — production CSS / legacy selector inventory
- Removed all four test-harness stylesheet imports from production `style.css`.
- Added lazy Test Mode stylesheet loading. The launcher stylesheet loads only when Test Mode opens; each suite stylesheet loads only when that suite opens.
- Added `docs/UI_CSS_SELECTOR_INVENTORY_TASK208.md` before any broader legacy cleanup.
- No new `tv2-*` family was blindly deleted. Existing behavioral/event-hook compatibility classes remain.

## #211 — Character State Review workspace
- Corrected the initial implementation after live-layout review; the earlier full-width State Review subview is superseded.
- Preserved the three-surface Character workspace: Character Banks remain in the left rail, Character State Review remains in the right rail, and the selected character stays in the center.
- Removed all visible non-policy Character State/Character Details boxes from the center. Their underlying stored fields remain intact for compatibility/data safety.
- The center Character State surface now contains exactly five collapsible policy boxes: Personality, Relationships, Status / conditions / equipment, Goals / unresolved threads, and Behavior changes.
- Tracking toggles live directly on those five policy boxes. No separate Tracking Policy box exists.
- Character State Review groups remain in the right rail. Each review policy group has an Open state control that returns the center to State, expands the matching policy box, and scrolls it into view.
- Review Recent Chat and Clear Temporary State remain available as compact toolbar controls rather than additional center boxes.
- Linked Content, Change Log, and Card Sync remain available as center tabs without displacing either rail.
- Widened the Memory Bank shell to up to 1380px / 98vw so the right review rail can be readable without cannibalizing the center or left rail.
- Preserved tracking-policy values when changing tabs so inactive subviews cannot zero disabled policies.
- No Character State contract, Jev decision, freshness, mutation, proposal, Ledger, Card Sync, or publication-authority semantics changed.

## Validation added
- `tests/task208-211-ui-contract.mjs`
- `.github/workflows/task208-211-ui-validation.yml` on lowercase `development`
- Existing Task #197 UI authority regression and Character State policy regression are rerun by the workflow.

## Live acceptance still required
Source/CI checks cannot substitute for live SillyTavern visual acceptance. Verify normal Memory Bank widths, a narrow resized window, populated Character State proposals, approval/rejection, policy toggle persistence, and Test Mode CSS loading before closing the issues.
