# Fresh Story Generation Repair Closure

Date: 2026-10-03

## Scope

This repair addresses the fresh-story failures captured in the worker package without weakening Story Scope isolation or turning temporary chat-local state into canonical World Tree authority.

- Starting SHA: `14b60bef37a5d9cb140b5c7afdbd311e1e26f530`
- Final runtime repair SHA: `942e081795d7a2be5ad0fa8b3c88a674a63c0451`
- Review branch: `fix/fresh-story-generation-plumbing`
- The closure-document commit follows the runtime SHA and changes documentation only.
- No merge, deployment, live story mutation, Lorebook attachment, model-gateway enablement, `mainModelAccess` enablement, or automatic-post-turn enablement is part of this repair.

The prior Hot/Memory repairs at `ab92ad25a1b47258e48bd71d8ed84bd25568c498` and `14b60bef37a5d9cb140b5c7afdbd311e1e26f530` remain architectural prerequisites.

## Live evidence reproduced from the worker package

The captures showed two fresh-story generations with host delivery present. Scene -> Hot -> next-turn Notebook continuity was already working and is intentionally preserved.

The remaining failures separated into independent seams:

1. Frame/owner diagnostics could erase independent evidence when one reader threw.
2. Hot diagnostics exposed a live snapshot with World revision 0 while the generation frame expected World revision 1, and the live snapshot did not carry the selected generation/turn identity.
3. The Character Bank outlet failed in an unbound chat.
4. Foreground retrieval on the second generation failed because the active story had no explicit Lorebook binding; Gather then admitted a bounded fallback.
5. The first post-response learning receipt was FAILED with zero steps.
6. Exact selected-turn Jev execution existed, but the turn summary counted resource-health rows and reported zero optional physical attempts.

The saved chat did not contain `tv2_story_scope_v1`. That remains an explicit configuration state, not authority to infer a globally enabled or editor-selected Lorebook.

## Repairs

### 1. Diagnostics fault isolation and truthful status

`nexus-ui-bindings.js` now isolates frame identity and frame diagnostics independently. A valid generation identity remains usable when the frame diagnostics reader throws; the selected-turn receipt becomes `DEGRADED`, records the failed owner as `generationFrame / FAILED_READ`, and preserves readable PromptPlan, Gather, delivery and other owner evidence.

Retrieval state is now derived from the actual foreground retrieval job when available. An admitted `BOUNDED_FALLBACK` remains separately visible and cannot relabel a failed retrieval job as success.

Learning receipts preserve their actual terminal state. The Wave13 operational adapter maps failed/degraded learning to `DEGRADED`, pending/running learning to `WORKING`, disabled/skipped learning to idle, and only successful terminal evidence to live.

Owner-reader error projection is metadata-safe. The known Story Scope refusal maps to `STORY_BINDING_REQUIRED` with a bounded operator-safe explanation; unknown reader exceptions do not expose arbitrary exception messages.

### 2. Hot real revision authority and consumed-generation evidence

Installed Hot now receives World revision from `getNexusWorldTreeOwner().revision` through its narrow chat-local path. Generic ephemeral-state defaults remain story-bound.

Restored and already-hydrated Hot state rechecks the live World revision. A revision advance invalidates only World-derived Hot segments (`WORLD_REFERENCES` and `GRAPH_NEIGHBORHOOD`) while preserving valid chat-local Scene/recent-tail state.

Notebook publication now captures the exact Hot snapshot offered to a generation. The capture is fenced by chat, generation, World revision and Scene revision when the generation-frame identity provides them. Selected-turn diagnostics read only that generation-scoped receipt; they do not fall back to the latest live Hot snapshot.

If a Hot snapshot fails the generation fence, it is not rendered into the generation Notebook. Generation evidence is bounded in memory, chat-scoped, owner-scoped, cleared on chat/reset paths, and cannot be borrowed by another chat or owner.

A binding appearance/change still invalidates book-derived Hot state without clearing chat-local narrative continuity.

### 3. Character Bank / Green Room publication

The failed Character Bank path traced to Green Room activation/rehydration: its temporary working-store binding used the generic story-bound ephemeral facade, so a nominal projection read could attempt an ephemeral overlay mutation through the Story Scope guard in an unbound chat.

Green Room now passes `getNexusWorldTreeOwner()` explicitly only for its transient working-state read/write/cleanup path. This mirrors the narrow Hot exception without changing generic ephemeral defaults or canonical Lore/World authority.

Production-style context-provider regression coverage now exercises Green Room while the story is unbound, binding appearance/replacement, chat switching, stale pending inference, and durable-export exclusion. A separate outlet regression verifies a valid empty/unbound Character Bank projection is `EMPTY`, not `FAILED`.

Green Room inference remains chat-local/noncanonical. A same-chat binding change cannot promote its inferred warmth/state into the durable World Tree.

### 4. Foreground retrieval and explicit story attachment

The second-generation retrieval failure is an expected Story Scope refusal, not a reason to introduce implicit book selection. Diagnostics now preserve the underlying failure reason (`World Tree requires one Lorebook bound to the active story`) while also retaining `BOUNDED_FALLBACK` as the fallback reason.

No automatic attach/global enabled-book/editor-selection fallback was added.

Existing explicit attachment continues to write through the durable Story Scope authority. The regression now verifies the selected chat/book persists through a simulated reload and resolves through the public World Tree binding contract. Existing binding tests continue to reject missing, ambiguous, copied, foreign and multi-book authority and isolate UID collisions.

### 5. Post-response learning and gradual growth

The zero-step first-generation failure is consistent with the Green Room pre-step read seam: lifecycle scheduling asks whether Green Room refresh is due before later lifecycle steps are recorded. The old story-bound transient read could throw in an unbound fresh story before a normal step list existed. The Green Room repair removes that failure path.

When a lifecycle really fails, the learning receipt now publishes bounded metadata-only failure identity (`reasonCode`, `failedStage`, `failureType`) rather than raw exception text. Pending completion remains pending in the UI rather than being turned into success or fabricated failure.

No disabled processing was enabled.

Gradual World growth rules are unchanged. Existing `world-tree-intake` coverage already establishes the desired behavior: unresolved mentions remain outside the tree until separate-turn evidence reaches the existing promotion rule, contribution replay is idempotent, and cross-chat contributions reject atomically. Existing scheduler parity coverage also keeps successful notebook/summary work when a separate optional review step fails.

### 6. Jev execution accounting

The captured generation contained exact selected-turn Jev physical execution evidence. The zero-attempt mismatch came from `turn-log-diagnostics.js`: `optionalAttempts` was counting resource-health lifecycle rows instead of exact selected-turn cognition execution.

The turn summary now takes physical attempt counts only from an exact selection-matched operational receipt (`physicalExecutionAttempts`). Resource-health attempts remain separately labeled as `resourceHealthAttempts` and cannot become selected-turn execution evidence.

The regression verifies three exact selected-turn physical attempts are reported even when health rows say `attempted:false`, and foreign-generation operational evidence is ignored.

Existing foreground execution tests continue to cover provider failover, cancellation lease release, background/foreground ownership, and stale-result rejection after source changes.

## Contract changes

- Story Scope remains the sole canonical Lorebook/World authority.
- `core/ephemeral-state.js` default behavior remains story-bound.
- Hot and Green Room use explicit raw-owner access only for their named chat-local transient working stores.
- Selected-turn Hot diagnostics require an exact generation-consumed snapshot.
- Failed retrieval plus admitted fallback is represented as two facts, not success.
- Learning receipt presence alone is not success.
- Resource health is not physical execution evidence.
- No current/live state is relabeled with a selected generation identity merely to satisfy a diagnostic fence.

## Regression coverage added or strengthened

Changed regression files:

- `tests/ephemeral-working-state.mjs`
- `tests/world-tree-story-binding.mjs`
- `tests/nexus-diagnostics-owner-wiring.mjs`
- `tests/jev-selected-turn-plumbing.mjs`
- `tests/a52-hot-cognition-full.mjs`

The added assertions cover:

- frame-diagnostics exception isolation with healthy independent evidence;
- failed learning, pending learning, failed retrieval plus bounded fallback;
- sanitized owner-read failure projection;
- real World revision in installed Hot;
- exact generation-scoped Hot capture and no latest-state borrowing;
- foreign-chat/owner rejection and frame-fence rejection;
- mid-chat World revision invalidation without losing narrative tail;
- unbound Green Room transient state with the production World Tree context provider;
- binding appearance/replacement without canonical leakage;
- fresh-story Character Bank `EMPTY` classification;
- explicit attachment surviving reload;
- exact selected-turn Jev attempt attribution and foreign-turn exclusion.

## Verification performed on the final runtime SHA

A syntax/coherence sweep fetched every changed production module and regression file from `942e081795d7a2be5ad0fa8b3c88a674a63c0451` and parsed their module bodies. All changed production files and tests passed. `tests/jev-selected-turn-plumbing.mjs` contains legitimate top-level `await`; it passed the async-module-body parse after the ordinary script parser correctly rejected top-level await.

GitHub reported **zero check runs and zero workflow runs** for the frozen runtime SHA on this review branch. Therefore this closure does **not** claim hosted CI or the full Node test suite passed at this SHA.

The worker-package verification commands still need to be executed from a real checkout at the runtime SHA:

```bash
node --test tests/ephemeral-working-state.mjs tests/world-tree-story-binding.mjs tests/nexus-diagnostics-owner-wiring.mjs tests/jev-selected-turn-plumbing.mjs tests/foreground-retrieval-plumbing.mjs tests/world-tree-subsystem-plumbing.mjs
node tests/a52-hot-cognition-full.mjs
node --experimental-vm-modules tools/check-es-modules.mjs
```

Applicable additional suites should include at least:

```bash
node --test tests/scheduler-lifecycle-parity.mjs tests/world-tree-intake.mjs tests/system-diagnostics-wiring.mjs
```

The package reports 41 focused tests plus `tests/a52-hot-cognition-full.mjs` passed at the starting installed head. Those earlier results are useful baseline evidence but are not represented here as proof for the repaired runtime SHA.

## Remaining live acceptance

Do not mutate the existing story to manufacture acceptance.

For the captured Ainz/Overlord-style live scenario, if the story is still unbound the operator must explicitly choose the intended Lorebook and use **Attach Lorebook to this story**. That action is deliberately not automated by this repair.

After explicit attachment, live acceptance requires:

1. Generate a first turn and a second turn.
2. Take diagnostics only after post-response lifecycle settlement for each turn.
3. Confirm independent owner evidence survives any single diagnostic reader failure.
4. Confirm the Character Bank outlet is `READY` or truthfully `EMPTY/DISABLED`, not a binding-induced exception.
5. Confirm foreground retrieval either succeeds under the bound story or reports its real failure; a Gather fallback must remain separately identified.
6. Confirm selected-turn Hot reports the generation-consumed identity/revisions and never borrows later live state.
7. Confirm learning is `PENDING` before settlement and records the actual terminal state afterward.
8. Confirm Jev selected-turn physical attempts match exact execution evidence and resource-health counters remain separate.
9. Confirm Scene -> Hot -> next-turn Notebook continuity remains intact.

Real-host acceptance remains pending until those live steps are performed.

## Reviewable commit list

- `7688b25d2960` Isolate frame diagnostics and preserve failed stage truth
- `387331659ef8` Render learning receipts by their actual terminal state
- `f5913f6dc3f0` Cover degraded frame, learning, and retrieval diagnostics
- `b80e5aed5626` Stamp Hot from World owner and retain consumed generation snapshots
- `dc4fa85154e5` Advance restored Hot world revision after invalidation
- `13c94d239f27` Restore Hot against the live World revision
- `d2a7fa9ce64f` Capture the exact Hot snapshot consumed by each generation
- `74c4b3054828` Read generation-consumed Hot evidence for selected turns
- `8fcca887dc1e` Cover live World revision and generation-scoped Hot evidence
- `3625e5953efe` Keep Green Room ephemeral state chat-local while unbound
- `8d4c15bd21eb` Reproduce Green Room publication while story binding is absent
- `a7c6490ad999` Keep story-binding refusal as retrieval failure reason
- `ffedaa7960d9` Assert retrieval fallback does not hide story-binding failure
- `dd771c32cdb3` Publish actionable post-turn learning failure metadata
- `b91680c38fb0` Fence consumed Hot receipts to exact generation authority
- `0a26c54e2aa4` Fence Hot generation capture to the active frame identity
- `71b71131a2f5` Count selected-turn Jev execution from exact cognition evidence
- `2abb5ac50e8d` Cover selected-turn Jev attempt attribution
- `a5e7d2842dd1` Synchronize live Hot state when World revision advances
- `ed1c45ee1c23` Refresh Hot world fence on live owner revision changes
- `83f0b9a2c3fa` Cover Hot world revision advance and generation immutability
- `9af2da63f2d3` Fence turn summary execution evidence to requested selection
- `bde0d59922b7` Sanitize owner read failures and retain fallback reason
- `2e39a6779925` Keep learning failure telemetry metadata-only
- `a945ddadce31` Cover safe failures, fallback identity, and pending learning
- `8358a94a9855` Harden fresh-story Hot and Character outlet regressions
- `48af6e6d93d8` Verify explicit story attachment survives reload
- `c7de0991e83d` Assert reloaded binding through its public contract
- `f86b8aa1aeaf` Do not render Hot state rejected by generation fences
- `942e081795d7` Assert consumed Hot generation fences in wiring check
