# Scene, Hot and Walker live trace — 2026-10-04

Source: user-provided `Nexus-Diagnostics-20261004-175722.json`, selected generation
`tv2_generation_1791150816915_2` in the Ainz chat. The corresponding ZIP and screenshots
are corroborating exports, not instructions. No live chat, installed extension, Lorebook
or story data was modified during this repair.

## Observed behavior

- Graph traversal evidence is selected to the generation: 14 traversed relationships and
  14 graph nominations. The graph trace does not prove those nominations reached Truth,
  Gather or the seal individually. Five Lore entries were delivered in the screenshot.
- Scene owner state identifies the Great Tomb of Nazarick — Treasury Antechamber, Ainz
  and Treasury Entrance Guards. The post-response receipt uses extractor fallback and
  explicitly reports `PERSISTENCE_FAILED`; this is not a fully successful Scene run.
- Hot receipts show applied narrative/scene updates. A current Notebook projection exists,
  but its old telemetry lacks chat identity and has no generation ID. It cannot prove the
  selected generation's exact Hot contribution. The Notebook section itself was delivered.
- The post-turn advisory step fails on `Unsupported World Tree overlay kind:
  RETRIEVAL_SOURCE_PLAN`. Its later `TASK8_POSTTURN_ADVICE` kind is also absent from the
  allowlist, so repairing only the first exception would expose another failure.
- Selected-turn Lore diagnostics reject current World Tree revision 1707 against the
  generation's revision 1704. That fence prevents current state being presented as
  historical turn evidence. This export alone does not prove cross-book contamination.

## Repairs

1. Scene persistence now supplies the declared `{exists:true,value}` post-image expected
   by `mutateChatMetadataDurably`. Previously the raw Scene value was misinterpreted by
   the barrier, causing a declared-post-state failure and indeterminate rollback report.
   The barrier and originating-chat checks are unchanged.
2. Register the two existing advisory overlay kinds. They stay transient and chat-scoped
   through the existing bound facade, do not enter canonical nodes or durable payloads,
   and keep source-plan Scene revision checks and explicit invalidation. Unknown kinds
   still throw. This does not enable a provider, change decisions or bypass binding.
3. Preserve useful Scene reuse, Hot accepted updates/Notebook preparation and actual
   Walker nomination/partial-search metadata in the activity feed. Worker responses and
   owner acceptance remain distinct. Candidates and prepared context do not claim delivery.

## Verification and limits

Regression tests execute the real Scene owner and durability barrier with host save/read
boundaries doubled: successful save verifies persisted state; a failed host save restores
the prior metadata. Existing stale chat/source/binding tests remain in force. The actual
post-turn advisory runtime executes through real plan/advice storage with deterministic
advisory decisions and controlled unrelated owner inputs. Overlay tests prove exact chat
isolation, Scene revision rejection, cleanup, unchanged canonical revision and exclusion of
advisory data from durable export. Feed tests cross the real producer schema, useful history,
projection and expandable UI; Notebook tests distinguish preview from generation publication.

All 123 standalone test files passed with `node --experimental-vm-modules` on the repaired
working tree. Changed production JavaScript passed `node --check`; `git diff --check` passed.
These are deterministic repository checks, not a claim of installed-host acceptance.

The Lore revision read gap remains unresolved here; its fence was not relaxed. Reduced
Scene extraction and missing candidate-level Sensory/Truth/optional-resource attribution
also need separate investigation. The screenshots' warning count is not a count of
independent production defects. A new installed-host generation is needed to verify live
save completion, advisory completion and arrival of the new activity rows after update.
