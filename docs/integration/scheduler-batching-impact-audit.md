# Batching impact audit — 2026-10-04

## Scope

**Correction following the cycle-loan reproduction:** the original audit did not
exercise `runLifecycleCycle()` through the restored physical batch path while
that cycle held its own scheduler loan. Passing owner/parity tests did not prove
that combination. The hang was present in both `b91c13c` and `66290ff`.
The [cycle-loan repair](scheduler-cycle-loan-repair.md) now reproduces and tests
that path explicitly; the original lifecycle coverage claim was insufficient.

Follow-up to `8189046`, requested to check other areas using the repaired worker
bus and scheduler. Traced production callers in Builder 2, Tree summaries and
keywords, Memory/Notebook, lifecycle scheduling, Scene Intelligence/Green Room,
World Tree contributions, foreground retrieval and historical recall. Used the
[Task 6 contracts](task-6-progress.md),
[batching closure](scheduler-batching-restoration.md), and existing
[fresh-story binding/ownership rules](fresh-story-generation-repair-closure.md).

## Confirmed findings and repairs

### Cancellation listener regression

Scheduled collection replaces the request's transport signal with the internal
controller signal. Cleanup and the abort callback still referred to the mutable
`options.signal`, leaving a listener on the original caller signal after the
job completed and potentially losing the caller's cancellation reason.

The bus now captures the caller signal once, uses it for callback registration,
reason lookup and cleanup, and keeps the internal transport signal separate.
The regression inspects the actual signal listener count after completion.

### Captured scope lost during asynchronous routing

A scheduled request without an explicit `nexusScope` captured its original chat
in Model Worker Bus. Physical dispatch did not forward that captured scope, so
Batch Layer could recapture another chat after an asynchronous routing boundary.
The bus eventually rejected the result, but a provider call had already happened
under the new chat's authority with the old request's prompt.

The bus now forwards the original immutable scope into physical dispatch.
The test switches chats during the actual runtime topology read: the request
rejects before a batch parent or provider call is created. Independent authoring
scopes still permit no-chat Builder work and survive unrelated chat selection.

### Existing producer-domain mismatch

The collector accepts its documented physical domains. Several production
callers instead supplied their subsystem/task names, causing
`TV2UnknownBatchDomain` before provider execution. This mismatch predates the
batching repair. The Model Worker boundary now translates only known producer
identities, retaining the original identity in attribution:

| Producer identity | Physical batch domain |
| --- | --- |
| `green-room` | `reasoning` |
| `world-tree-card`, `worldtree-card` | `lorebook` |
| `world-tree-memory`, `worldtree-memory`, `character-memory` | `memory-bank` |

The corresponding direct and lifecycle spelling variants are exercised through
the real bus/collector/router. An unrecognized producer still fails before any
provider call. This translation is scheduling categorization; it does not select
a Lorebook, change a binding, or grant canonical mutation authority.

## Areas checked

| Area | Trace and executed evidence |
| --- | --- |
| Builder 2 | Authoring `scopeKind`, resource policy and source fences traced. Actual worker-batch execution tested without a chat, across unrelated chat selection, and in Main-only fixture topology. Existing Builder planning/controller/materialization/recovery tests pass. |
| Tree summaries/keywords | Background owner path traced; actual independent batch executes on B, holds completion/publication during a foreground loan, permits foreground A work and resumes once. Existing Tree owner tests pass. |
| Summary/Notebook and lifecycle | Original audit: injected owner executor and physical lease handoff traced; existing owner/parity tests passed but missed the cycle-loan hang. Follow-up: actual `runLifecycleCycle` and execution leases now drive Scene, Green Room, Notebook and extraction fixture owners through the production bus/collector/router/queue, completing without an external resume. See the cycle-loan repair for the failing reproduction and validation. |
| Scene/Green Room | Source/Scene revisions and captured World Tree binding key remain owner publication guards. Scene's physical domain was already supported; Green Room's domain mismatch is repaired. Scene/handoff tests pass. |
| World Tree card, character and story memories | Direct fallback and lifecycle producer spellings traced and tested at the physical boundary. Intake, relationship rules, exact book binding and owner mutation paths are unchanged. Existing contribution/intake/binding tests pass. |
| Foreground retrieval/recall/delivery | Immediate foreground queue access, deadline/failover, typed result ports and sealed-frame immutability retain their existing paths. Existing foreground and delivery tests pass. |

No additional Builder layout, Tree storage, owner publication or prompt-building
change was needed for this audit.

## Validation and limits

- Affected-area run: **59 test files passed, 0 failed**.
- Full standalone run: **123 test files passed, 0 failed**, each executed with
  `node --experimental-vm-modules`.
- `tests/scheduler-batching.mjs` now has **28 execution cases**, including eight
  new cases for the findings and adjacent routing/background/authoring paths.
- Changed production JavaScript passes `node --check`; whitespace check passes.

The three repaired findings were reproduced before their implementation changes.
Execution fixtures retain real local orchestration and replace external provider
and host boundaries. Main access was enabled only in an isolated test fixture;
no installed settings, extension files or Lorebooks were modified.

These results do not establish live acceptance of every subsystem. A new
installed generation/diagnostic export is still needed. The earlier
`tv2_memory_bank` stale-metadata transaction and Lore/selected-turn reporting
findings are not claimed fixed by this audit, nor is the entire Part 4
optimization pass declared complete.
