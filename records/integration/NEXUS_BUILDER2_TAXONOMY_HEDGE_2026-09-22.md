# Nexus Builder 2 Taxonomy-Plan Hedge — 2026-09-22

## Live evidence
The post-coalescer-repair 105-entry Builder run completed successfully in about 5m04s. Tree rolling-pool dispatch delays were removed, and classification completed 14 slices in about 42s. The remaining dominant serial stage was the centralized taxonomy architect: one valid taxonomy-plan request occupied about 83s while the second healthy Sidecar was idle. The preceding run had shown the same stage reach the 180s transport timeout before fallback.

## Repair
- Taxonomy planning remains one logical Builder 2 semantic job owned by Work Director/WorkCoordinator.
- The normal adaptive primary request starts exactly as before.
- The Model Worker handle now exposes the Sidecar lane that the canonical router actually assigned. This is observational metadata only; Builder does not choose the primary lane.
- If taxonomy-plan has not produced a validated result after 45 seconds and the primary is on Sidecar A/B, Builder launches an identical read-only taxonomy request on the other Sidecar.
- Both attempts use the same system prompt, input, temperature, structured response contract, and taxonomy validator.
- The first validated result wins. The slower attempt is cancelled inside the same executor.
- If the primary is on Main or its Sidecar lane is not observable, the hedge is skipped and the original request proceeds unchanged.
- Existing 180s transport timeout and adaptive fallback remain unchanged.

## Preserved authority
No change to:
- survey/taxonomy-seed semantic evidence or packing;
- taxonomy architect prompt or validation authority;
- Work Director primary routing/health selection;
- PlanStore phases or freshness;
- review/approval/materialization/mutation/Ledger ownership;
- Sidecar health penalties for ordinary failures;
- Builder semantic behavior outside taxonomy-plan.

The hedge is speculative read-only physical redundancy for one serial architect stage; it cannot create a second logical Builder result or commit.
