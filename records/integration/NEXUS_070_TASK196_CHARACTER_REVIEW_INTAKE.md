# Nexus 0.7.0 Task #196 — Character Review / Character Card Intake Checkpoint

## Scope

Issue #196: improve Character Card / Character State ability to gather useful details from chat or Summary without automatic character learning.

All implementation remains on the existing lowercase `development` branch. No new branch was created. `Bermieee/Nexus` was not modified.

## Product rule

Character learning remains explicitly operator-invoked.

Nexus does **not** automatically turn ordinary narrative behavior into Character State. A Summary or recent-chat range is reviewed only when the operator chooses Review. The existing Character State Review rail remains the final human approval authority.

## Tracking Policy is now authoritative

The five existing operator-facing Tracking Policy toggles are the hard semantic intake boundary:

- Personality
- Relationships
- Status / conditions / equipment
- Goals / unresolved threads
- Behavior changes

Summary/chat Character State review now receives only fields belonging to enabled policies. The structured Sidecar validator rejects any returned field outside the enabled set.

Fields without one of these five tracking domains can still be edited manually or populated by explicit Character Card import/reconciliation, but Summary/chat review does not manufacture proposals for them.

### Current field routing

- Personality → `baseline.personality`
- Relationships → `persistent.relationships`
- Status / conditions / equipment → clothing/gear, abilities/combat, equipment, conditions, titles/status/affiliations, lasting physical changes, current outfit, injuries, temporary magical effects, carried items, immediate physical condition
- Goals / unresolved threads → `persistent.goalsMotivations`
- Behavior changes → `persistent.behaviorPatterns`, temporary mood, scene notes

A dedicated bank-only `persistent.behaviorPatterns` field was added so meaningful recurring behavior does not have to be incorrectly stored as Personality.

## Manual review surfaces

Character workspace now supports:

1. **Review Recent Chat** with bounded 10 / 25 / 50 / 100 message windows.
2. **Review** on each Character-linked Summary.
3. Existing Summary Bank **Review for Character Bank…** continues to work.

All three converge on the same Character State comparison/proposal pipeline.

## Jev agreement checkpoint

Added Decision site:

`character-state.proposal-agreement.v1`

Boundary:

Sidecar draft → Jev agreement → Character State Review publication → operator approval → Character Bank mutation → optional explicit Card Sync.

For each proposed change, Jev asks three independent Noul questions:

- Is the proposed value directly supported by the bounded evidence?
- Does it genuinely fit the enabled Tracking Policy domain / allowed field?
- Is it a meaningful Character State delta rather than redundant flavor or overgeneralization?

The Decision site is assist-mode, provider-neutral through Decision Core, and explicitly disables LLM fallback so this checkpoint is Jev / typed-decision only.

Initial Nexus routing thresholds:

- below `0.35` on any agreement dimension: do not publish the draft to Character State Review;
- `0.35–0.70`: publish as **Jev uncertain** for explicit human judgment;
- at least `0.70` on all dimensions: publish as **Jev agreed**.

These are calibration starting points, not a claim of domain-optimal thresholds.

If Jev is unavailable, the manual review workflow fails open only to the **human review rail**: the proposal is marked **Jev unavailable** and still requires operator approval. Jev never approves or mutates Character State.

Freshness fencing covers the evidence revision, live Character State, Tracking Policy, allowed fields, and Sidecar draft candidate set.

## Character workspace

- Character Details now exposes the full Character State field set, including fields that previously could receive state but were not visible in the normal editor.
- The Character State Review rail surfaces Jev agreed / uncertain / unavailable status.
- No new CSS dependency was introduced for the review workflow; controls use existing UI Core primitives / existing Character classes.

## Ownership preserved

- Tracking Policy owns intake eligibility.
- Sidecar owns generative draft text.
- Decision Core / Jev owns bounded semantic judgments only.
- Character State Review remains human approval authority.
- Character Bank owns state/provenance/history.
- Ledger retains transaction/mutation safety.
- Character Card write-back remains explicit, fingerprint-gated, diff-based, and operator-triggered.

No automatic Summary → Character mutation and no automatic Card Sync were added.

## Validation

Task-specific workflow: `Decision workflow coverage`

Validated runtime head:

`170f1afe461ea577103ef4884bbfb09ff766b6a4`

GitHub Actions run:

- run `35688780230`
- job `106621134305`
- Syntax: PASS
- Decision contracts: PASS
- Character review policy: PASS

The Character review policy regression verifies:

- exactly five operator-facing tracking domains;
- disabled-domain field exclusion;
- behavior-pattern destination;
- Jev assist contract and no-LLM-fallback policy;
- Jev agreed vs uncertain routing;
- manual recent-chat wiring;
- manual Character-linked Summary wiring;
- Jev review visibility in the Character review UI.

Earlier runtime commits also passed the existing Decision workflow before the full task gate.

## Live acceptance

**NOT LIVE-ACCEPTED / NOT GREEN.**

Required live SillyTavern checks include:

- review a Summary with a subset of Tracking Policy switches disabled and confirm no disabled-domain proposals appear;
- review recent chat containing conspicuous but one-off behavior and confirm it is not promoted as a durable pattern without support;
- verify Jev agreed / uncertain / unavailable presentation;
- verify low-support Jev-rejected drafts do not reach the review rail;
- approve/reject proposals and verify provenance/history;
- verify optional Character Card sync remains explicit and preserves operator-authored card material;
- repeat across medium/long story use to assess threshold calibration and accumulated Character State quality.

