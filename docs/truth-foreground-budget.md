# Truth foreground time and per-turn Diagnostics (Task 4)

## What runs on the foreground path

Truth's foreground work is rule-based and cheap. Only two things can be slow, and both are
bounded:

1. **`truth.intent`** (a Decision Core call). It is skipped when the player asked or stated
   nothing: the rule answer (CURRENT) is final, reason `NO_PLAYER_QUESTION`. Otherwise it shares the
   turn deadline: no deadline, a past deadline, an abort, an error, a miss or an invalid answer all
   return the rule result without throwing.
2. **`truth.corrective`** (a Decision call plus a second retrieval and assessment). It runs only if
   it fits what `core/budget.js` says is left, using observed durations. Otherwise it is deferred and
   reported (`corrective-deferred`, state `DEFERRED_OVER_BUDGET`).

Classification itself is bounded by the same budget manager. Candidates that do not fit are
**deferred, not dropped**: they continue as support-only context (`DEFERRED_OVER_BUDGET`), in fusion
order, and the coverage receipt records `total / assessed / deferred / continuation`. A deferral is
not an open question, so it never triggers more foreground work. `assessWorldTreeCandidatesSafely`
is the only foreground entry point; if assessment fails, every candidate continues as support-only
(`TRUTH_UNAVAILABLE`) and the error is reported. Truth never throws into generation.

With no foreground deadline there is no budget to enforce: the turn is reported as `UNBOUNDED`
(`budgetMs: null`, `budgetSource: UNBOUNDED`) rather than with an invented number.

## Per-turn Diagnostics

`assessment-complete` carries totals over **all** candidates: candidates per classification, kept,
full-weight, support-only, dropped, deferred, unresolved, unspecified-timing, canon-reference, outcome
and reason-code counts, the coverage receipt, `timeUsedMs` against `budgetMs`, and the corrective state.
Only the per-candidate list is capped (96), and `verdictsOmitted` says by how much. The Diagnostics
projection and the Truth stage show the totals.

## Intent

Cues count only in text the player addressed to the system: a question, an out-of-character span, a
request to recall ("recap ...", "tell me ..."), or a stated contradiction of what is established
("... contradicts canon / the lore / what we know"). Narrative prose that uses the same words stays an
ordinary turn.

## Limits

- The retriever and Memory recall wiring is covered by source-text checks only (they import
  SillyTavern modules). Everything they call is tested by execution.
- A contradiction stated in plain narrative with no out-of-character marker and no reference to what is
  established is read as an ordinary turn.
- Live timing is unmeasured; the ~5 s explanation remains a hypothesis until a real export.
