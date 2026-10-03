# Future design decision: campaign time for canon lore

Status: not decided, not implemented. This collects, in one place, the capabilities Truth
classification Task 3 needs but existing contracts do not provide. Task 3 is partially
implemented without them (see `docs/truth-campaign-applicability.md`).

## What is missing

Deciding whether an authored canon event has happened, has not happened, or is later than this
campaign's present needs all three of these together. Today none exists.

1. **A way to represent campaign time.** Story-scoped time evidence today is the Scene
   Scanner's free-text `narrativeTime` (also in character-memory `time.storyTime`) and
   message-position coordinates (`message:N`). Neither is orderable, and neither is on the same
   scale as a lore entry's `validFrom` / `validUntil`, which are free-form values in the
   source's own frame. A campaign clock (or a mapping between the two scales) is missing.
   Adding one is a storage decision.
2. **A way to represent direction and occurrence.** `CHANGE_OVER_TIME` says two descriptions
   concern different times; it does not give direction, and it does not say whether an event
   occurred in this campaign. Whatever carries direction or occurrence is new data about the
   campaign, so it is also a storage decision.
3. **A producer.** Nothing writes chat-versus-canon verdicts today, and nothing would write the
   items above. A producer is another model-backed execution path, which needs explicit
   approval. A first sketch is in `docs/truth-chat-canon-conflict-producer-proposal.md`.

## Constraints any design must keep

- No "Event:" title convention, no manual retagging of the Lorebook, no reliance on the absence
  of campaign evidence, and no inference from the canon description alone.
- Occurrence unknown stays `UNRESOLVED`; established backstory stays usable.
- Authority (canon of the exact bound Lorebook), temporal status and campaign applicability stay
  separate. Global lore is never edited; results stay local to the exact chat and story.
- Promotion of reference to full weight for a historical or temporal question requires evidence
  for the requested timeline, not the question's intent alone.

## Decisions needed

- Whether to store campaign time (and where), or to keep campaign applicability evidence-only.
- Whether a producer is acceptable, with what cap and on which lane (post-turn only).
- What evidence would justify promoting reference for a time question.
