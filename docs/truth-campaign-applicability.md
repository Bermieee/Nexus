# Truth: canon reference versus campaign occurrence (Task 3)

Status: implemented for the evidence existing contracts can carry. The gap below is open and
reported; no storage was added.

## The distinction

Three independent facts about a canon lore entry, never collapsed into one:

| Axis | Meaning | Where it comes from |
|---|---|---|
| Source authority | The authored entry is canon of the active story's bound Lorebook. | Verified import provenance + exact bound book (Task 1). |
| Temporal status | What the entry's own timeline says (`CURRENT`, `HISTORICAL`, `UNRESOLVED`, ...). | Stored node status. Never rewritten. |
| Campaign applicability | Whether the entry describes this campaign's present. | Verified story-scoped evidence only. |

`campaignApplicability` is `UNKNOWN` by default and `DIFFERENT_TIME` only on evidence.

## Rules

- A canon description alone proves nothing about this campaign. Neither does an "Event:" title,
  nor the absence of campaign evidence. With no evidence the entry stays as it was: status
  `UNRESOLVED` is preserved and established backstory keeps normal weight.
- `DIFFERENT_TIME` requires a `CHANGE_OVER_TIME` verdict (the existing `truth.conflict` choice,
  "different times or a transition") on exactly one pair: this canon node, and an established
  chat fact. "Established" and "verified" mean exactly what they mean for chat-over-canon in
  Task 2: observed, current, unsuperseded, this exact chat, not memory-kind; both nodes
  readable now; a shared subject; recorded revisions still match; no disagreeing verdict on
  the pair. Canon must be verified canon of the single bound Lorebook.
- It qualifies only genuinely unresolved timing. Explicit `CURRENT`, `HISTORICAL`,
  `SUPERSEDED`, `UNCERTAIN` and `CONTRADICTED` entries are preserved. A real conflict on the
  same node takes precedence.
- Delivery of reference: `SUPPORT_ONLY` (`CANON_REFERENCE_NOT_CURRENT`, labelled
  `[Canon reference]`, marked context-only, ordered and budgeted after full-weight lore and
  memory) on ordinary and contradiction turns; full weight
  (`CANON_REFERENCE_MATCHES_TIME_QUESTION`) for historical and temporal questions.
- Nothing is written. The authored entry, its status and its authority are untouched, and the
  result is local to the exact chat and bound Lorebook.

## The gap (reported before adding any storage)

Existing contracts cannot compare an entry's explicit source timing with the campaign's
position in time:

1. **Source timing is a free-form value in the source's own frame.** An imported node keeps
   `temporal.validFrom` / `validUntil` exactly as authored (for example a canon year).
2. **The campaign has no orderable clock.** The only story-scoped time evidence is the Scene
   Scanner's free-text `narrativeTime` (also copied into character-memory `time.storyTime`)
   and message-position coordinates (`message:N`) on memory validity. None is on the same
   scale as a source coordinate, so "the event is later than now" cannot be decided.
3. **No producer writes chat-versus-canon verdicts.** `CHANGE_OVER_TIME` is consumed, but until
   the deferred producer (docs/truth-chat-canon-conflict-producer-proposal.md) exists, the
   evidence path stays dormant in a live chat.

What would close it, if approved, without a title convention, retagging or a campaign-start
field: a story-scoped mapping from source coordinates to campaign narrative time, stored as
chat-scoped evidence using existing node kinds, written only by an approved producer, and read
by the same verification rules above. That is a storage and execution-path decision, so it is
a proposal, not part of this task.
