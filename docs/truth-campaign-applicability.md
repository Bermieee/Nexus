# Truth: canon reference versus campaign occurrence (Task 3)

Status: **partially implemented.** The consumer is implemented and tested: it reads verified
story-scoped evidence and qualifies canon as reference. Live campaign-time classification
(deciding whether a canon event has happened, has not happened, or is later than the campaign's
present) is **deferred**; the original requirement is not closed. The missing capabilities are
collected in `docs/truth-campaign-time-future-design.md`. No storage, clock or producer was added.

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
- `DIFFERENT_TIME` is not a direction. A `CHANGE_OVER_TIME` verdict says the two descriptions
  concern different times; it does not say the canon event is in the future, has not happened,
  has happened, or happened in this campaign. Nothing in Truth treats it as any of those.
- Delivery of reference is `SUPPORT_ONLY` for **every** intent (`CANON_REFERENCE_NOT_CURRENT`,
  labelled `[Canon reference]`, marked context-only, ordered and budgeted after full-weight lore
  and memory). A historical or temporal question does not promote it: promotion would need
  evidence for the requested timeline (a direction, or a placement against a campaign clock),
  and existing contracts cannot supply that.
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

Closing it is a storage and execution-path decision. See
`docs/truth-campaign-time-future-design.md`.
