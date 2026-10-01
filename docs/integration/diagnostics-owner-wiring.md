# Nexus owner wiring — September 30, 2026

This pass connects existing Nexus owners to the transplanted UI. It does not complete the remaining product controls or the Task 7 reader migration.

## Completed connections

| Owner | Host reader | Consumer |
| --- | --- | --- |
| Generation Frame bus | `readSelection` | Live selection bridge and retained-turn journal |
| Applied Generation Frame diagnostics | `readPromptPlan`, `readContextReceipt`, `readContextSeal` | Prompt Plan and selected-turn visibility |
| Actual non-dry prompt-loader request event | `readHostDeliveryReceipt` | Delivery visibility; preparation alone remains PREPARED |
| Memory Bank | `readMemory` | Memory surface and Diagnostics summary counts |
| Canonical World Tree Lore metadata | `readLoreStatus` | Lore surface; no manufactured learned revisions or retrieval-ready claim |
| Foreground Scatter/Gather | `readCognitiveChoice`, `readSelectedTurnReceipt`, `readGeneration` | Read-only scheduling and turn receipt visibility |
| Transaction Ledger | `listTransactions` | Chat-scoped transaction metadata |
| Housekeeper | subsystem Maintenance status | Existing Diagnostics panel |
| Vector paging | subsystem Paging status | Existing Diagnostics panel |
| Postturn backlog | subsystem Postturn status | Existing Diagnostics panel |
| Smart Context warmer | subsystem Smart Context status | Existing Diagnostics panel |
| Observability notifications | host subscription | Live reader refresh and journal capture |

Generation identity is read without cloning prompt bodies. A newly opened generation cannot borrow the previous frame's seal. Foreign chat/generation requests cannot borrow current receipts. Lore metadata reads omit source bodies and disclose bounded coverage. Space-containing SillyTavern chat names survive the diagnostics producer. Export sanitization retains scalar execution metadata at the depth boundary while continuing to redact secrets.

## Traced UI homes and remaining action boundaries

| System | Product home | Trace and remaining boundary |
| --- | --- | --- |
| Builder / Builder2 | Existing World Tree Build workflow | The transplanted reviewed-build action routes to `wave13.loreAuthoring.startTreeBuild`, then an imported authoring host. The latest graph also has a disabled Rebuild control, explicitly marked as a future feature. Nexus Builder2 is owned by `getLorebookBuilderController()` and is currently invoked through the tool gateway. These contracts are different; the UI action is **not connected to Builder2 by this pass**. Its persisted review, resume and commit stages need an explicit adapter rather than simulated Worker 4 receipts. Source loading, summarization and merge scanning already have separate Nexus host callbacks; those are preserved. |
| Builder Tree editing | World Tree authoring | Nexus commits through the mutation coordinator and Transaction Ledger. Existing Area52 settlement actions must not bypass this authority. Adapter still needed. |
| Maintenance | Brain / Diagnostics | Status connected. Manual repair controls still need action routing to the lifecycle/Housekeeper owner. |
| Paging | Brain / context diagnostics | Residency/index status connected. No independent paging workspace added. |
| Postturn | Brain activity / Diagnostics | Backlog status connected. Operator retry/flush controls still need lifecycle action routing. |
| Smart Context | Brain / context diagnostics | Warmer status connected. Configuration and manual warm controls remain unwired. |
| Testing | Developer section of Diagnostics | Existing resource probes remain in Resources/Diagnostics. A general developer test workspace is not implemented. |
| Tools | Existing authoring controls and developer Diagnostics | Nexus tool registration and gateway exist. No transplanted general Tools workspace is connected. |
| Proposals | Deferred | User explicitly deferred this UI work. |

## Limits of this verification

The new regression suite exercises the real selection bridge, receipt binding, Memory/Lore/Prompt Plan adapters, production mount callback assembly, retention journal and export. Host-only dependencies are replaced with deterministic owners in the mount test; this does not prove browser acceptance.

The changes were integrated onto `main@40f74a3`, preserving the newer resource controls, World Tree source actions and generation profiler. The selected-turn receipt combines execution evidence with the existing profiler rather than allowing one reader to replace the other.

The integrated offline sweep passes 59 of 63 standalone files and 504 of 504 syntax checks. The four failures are the unchanged baseline: `character-review-policy.mjs`, `performance-hotpaths.mjs`, `prompt-loader-adapters.mjs`, `summary-digest-coverage.mjs`.

Live acceptance remains: reload SillyTavern, generate once, confirm non-null generation selection and a retained turn, verify the actual request observation, and export Diagnostics. The previously observed foreground retrieval timeout is separate execution work and is not repaired here. Learning completion and turn-scoped Jev execution stay absent unless their owners provide real receipts; connection health is not execution evidence.
