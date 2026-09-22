# Nexus 0.7.0 — Task #192 Jev Workflow Coverage

**Task:** Bermieee/Development#192 — More questions Jev can handle that would improve workflow  
**Branch:** `development` only  
**Runtime code head validated:** `9f582658c580ec09eddb985e89985b92c89c187a`  
**Status:** READY FOR REVIEW — live SillyTavern acceptance still pending  
**Public promotion:** NOT PERFORMED. `Bermieee/Nexus` remains untouched by this task.

## Objective

Expand Decision Core/Jev coverage across the remaining Nexus workflow seams without transferring subsystem ownership, freshness authority, transaction authority, or mutation authority to Jev.

The existing Decision Core already covered Builder taxonomy/placement, Retrieval rerank and Tree admission, Change Gate classification, Summary historical rerank and durable routing, Notebook material change, lifecycle work/evidence/canonical-home routing, Post-turn proposal warrant, Scene Scanner preflight, Tree entity alignment/merge review, and Housekeeper merge/semantic-overload decisions.

Task #192 therefore became a coverage-gap pass rather than a Decision Core redesign.

## New Decision Sites

| Site | Typed questions | Runtime boundary | Mode / authority |
|---|---|---|---|
| `character-state.review-preflight.v1` | review warranted; durability degree; conflict risk; best layer | before full Character State review | shadow only; no state mutation |
| `smart-context.warm-candidate-review.v1` | per-candidate relevance + predictive value | after deterministic warm nomination, before Sidecar warm selection | shadow only; never injects |
| `uid-summary.draft-review.v1` | preferred draft; faithfulness; coverage; retrieval utility | after validated UID drafts, before operator selection | shadow only; recommendation only |
| `tree.keyword-safety.v1` | safety; specificity; collision risk | after keyword nomination, before operator review | shadow only; inert suggestions remain operator-reviewed |
| `proposals.review-triage.v1` | attention priority; semantic risk; evidence sufficiency; likely redundancy | when Proposal review queue is opened | shadow only; never approve/reject/mutate |
| `maintenance.finding-triage.v1` | priority; semantic-review need; route | after deterministic maintenance findings, before generative advice | shadow only; advisory route only |

All new sites use bounded state, typed Noul/Choice/Score contracts, explicit source fingerprints, and Decision Core provider policy. The owner-side hooks route through the existing Work Director bridge so the added semantic work participates in normal coordination rather than becoming a second ad-hoc worker path.

## Freshness and ownership

- Character State shadow work fingerprints both source evidence and live Character State.
- Smart Context shadow work uses the same warm authority/cache key family as the owning warmer and recomputes it at settlement.
- UID draft review re-reads the live UID and recomputes the exact UID source identity before a shadow result is considered current.
- Keyword safety is conservatively fenced by the Nexus lore-source revision.
- Proposal triage fingerprints the bounded pending queue using proposal id/revision/status/operation type and recomputes from the live store.
- Maintenance triage combines the deterministic finding fingerprint with the Nexus lore-source revision.
- No new Decision site can commit lore, Tree, Character State, Proposal, Ledger, queue, prompt, or paging mutations.
- Work Director, Batch Layer, Sidecar Bus, Transaction Ledger, mutation coordinator, freshness enforcement, Prompt Loader mechanics, and physical paging remain deterministic owners.

## Changed runtime surface

New:
- `decision/site-utils.js`
- `memory/character-decision-sites.js`
- `smart-context/decision-site.js`
- `lore/uid-decision-site.js`
- `tree/keyword-decision-site.js`
- `proposals/decision-site.js`
- `maintenance/decision-site.js`

Wired:
- `memory/character-state-review.js`
- `smart-context/warmer.js`
- `lore/uid-summarizer.js`
- `tree/keyword-advisor.js`
- `proposals/ui.js`
- `maintenance/housekeeper.js`
- `index.js`

Validation:
- `tests/decision-workflow-coverage.mjs`
- `.github/workflows/decision-workflow-coverage.yml`

## Commit lineage

- `8c975aedf84eb72c818ed85a4afe52516e2e3701` — merge existing runtime-source line into lowercase `development` without creating a new branch.
- `6e074b7b85a4e527397c684c38f8ea0a6cd07cda` — add six bounded Decision sites.
- `09414ec73d8ce473af0319ebfe9783a74b445e7e` — add contract validation workflow.
- `b7aa618da1cd56f76a62e8eed649b920faaf3cea` — wire Character State + Smart Context.
- `1d65e216610ae657a7451ff5b9f17076e3360ea2` — wire UID draft review + keyword safety.
- `562f83b7066838c7c381791273a910e2ea954e30` — wire Proposal + maintenance triage.
- `c56c52faf2cdab6b397c70eeb987b7707f7642e3` — harden wiring test and correct UID freshness identity call.
- `2b0af68a292d999036a334956cc47b5e7ed24cbd` — lore-revision freshness fence for keyword shadow.
- `5539f139ac539d7c39f66183b84a259a2a33e5eb` — live Proposal-store freshness fence.
- `9f582658c580ec09eddb985e89985b92c89c187a` — lore-revision freshness fence for maintenance shadow.

## Validation evidence

GitHub Actions `Decision workflow coverage`:
- Run `35686521378` — PASS on initial six-site contract validation.
- Run `35686889806` — PASS with six owner-side wiring assertions and corrected UID freshness signature.
- Run `35687047002` — PASS after keyword freshness fence.
- Run `35687055496` — PASS after Proposal freshness fence.
- Run `35687063465` — PASS on final runtime head after maintenance freshness fence.

The workflow syntax-checks all new Decision modules, all six wired owner modules, and `index.js`, then executes the typed-contract/wiring regression. This is focused task validation, not a claim that every Nexus release gate or full live acceptance gate has passed.

## Review / live acceptance

Recommended review observations in SillyTavern:
1. Confirm each new site appears in Decision telemetry only when its owning workflow has eligible bounded work.
2. Confirm disabled/off Decision Core leaves every owning workflow behavior unchanged.
3. Confirm stale source changes produce stale/ignored Decision results rather than influencing the workflow.
4. Confirm new shadow jobs have stable Work Director route/plan/job identity and do not strand Sidecars.
5. Confirm no Proposal, lore, Tree, Character State, warm injection, or UID draft changes occur solely from these shadow results.
6. Confirm added shadow load remains acceptable under foreground generation and background maintenance.

Do not promote these new sites to Assist consequences from this task alone. Promotion should be a separate evidence-backed decision after Nexus-domain telemetry demonstrates useful calibration.

## Release disposition

Task #192 is ready for code review on `Bermieee/Development:development`. It is **not** a stable/release sign-off and does not satisfy live SillyTavern, medium-run, or long-run acceptance by itself.
