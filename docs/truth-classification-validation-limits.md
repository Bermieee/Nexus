# Truth classification: recorded validation limits

Task 2 scope is frozen at commit `d3ca0e728950446993d262469950a5d17317be80`. It is not
reopened unless later work shows a concrete failure.

## What is verified

- Outcomes, reason codes, authority derivation, verified-conflict consumption, intent
  inference and the Lore and Memory delivery rules are covered by `tests/truth-support-only.mjs`
  and `tests/truth-authority-timing.mjs`. Both render paths are exercised as real functions
  extracted from `retrieval/retriever.js` and `memory/recall.js`.

## Known limits

1. **Three wiring points have source-text checks only.** The retriever's intent input
   (`inferTruthNeed(latestUserTruthText(context))`), the corrective-narrowing assessment intent
   (`correctedAssessmentIntent`), and Memory recall's intent input (`latestPlayerText`) live
   inside functions that import SillyTavern modules and cannot be loaded in the offline tests.
   The inference they call is tested directly; the call sites are checked as source text.
2. **Live delivery is unverified.** No live chat has yet shown the injected token cost of the
   context-only marker, how the main model reads it, or how Truth behaves against the real
   Overlord lorebook. A live generation should confirm this, not be needed to find defects
   already identified.
3. **The automatic chat-versus-canon conflict producer is deferred.** Truth consumes existing
   conflict evidence, but nothing proposes chat-fact-versus-canon pairs, so
   `CHAT_FACT_SUPERSEDES_CANON` does not appear in a live chat until a producer is approved.
   See `docs/truth-chat-canon-conflict-producer-proposal.md`.
4. **The ~5 s foreground gap is still a hypothesis** (the corrective pass firing every turn
   because canon was UNRESOLVED) until a real export confirms or refutes it.
5. Intent inference ignores imperatives without a question mark ("Recap what happened before
   the war."). That fails safe (an ordinary turn). A fuller redesign belongs to Task 4.

## Task 3 status (recorded)

Task 3 is **partially implemented**. The consumer is tested, but live campaign-time
classification is deferred, and the original requirement is not closed. `DIFFERENT_TIME` is not
"not yet happened"; reference is support-only for every intent. The missing capabilities (campaign
time, direction/occurrence, and a producer) are one future design decision:
`docs/truth-campaign-time-future-design.md`.
