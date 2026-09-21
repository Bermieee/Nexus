# Nexus Decision Site Adapter Contract — CP005

Decision Core is the stable provider-neutral socket for bounded semantic judgments.
Destination subsystems plug into it through registered **Decision Sites**. A Decision
Site describes the question; it never implements Jev/OpenRouter/TypeSafe transport.

## Ownership

A destination subsystem owns:
- the site ID and semantic contract;
- bounded state/evidence construction;
- Noul / Choice / Score question meaning;
- destination-owned source fingerprint and freshness recheck;
- interpretation of a normalized result;
- every threshold, policy consequence, mutation, review, or escalation after the result.

Decision Core owns:
- provider selection and adapters;
- credentials and provider health;
- timeout/error/fallback handling;
- typed normalization;
- stale-result rejection using the subsystem-supplied fingerprint;
- Decision Core telemetry.

Work Director owns deterministic planning/admission only. Work Coordinator executes the
registered local `semantic-decision` job. Neither layer selects a Decision provider.

## Registration pattern

Keep the adapter in the destination subsystem, for example:

```js
import { registerDecisionSite } from '../decision/site-registry.js';

export const SITE = registerDecisionSite({
  id: 'retrieval.rerank.v1',
  subsystem: 'retrieval',
  contract: {
    id: 'retrieval.rerank.v1',
    version: 1,
    subsystem: 'retrieval',
    questions: {
      candidate_fit: { type: 'score' },
    },
  },
  mode: 'shadow',
  priority: 80,
  buildState(context) {
    return { query: context.query, candidate: context.candidate };
  },
  buildQuestions() {
    return {
      candidate_fit: {
        type: 'score',
        instructions: 'How well does the candidate satisfy the current retrieval need?',
        criteria: ['Not relevant', 'Weak', 'Useful', 'Strong', 'Essential'],
      },
    };
  },
  getSourceFingerprint(context) {
    return context.sourceFingerprint;
  },
  getCurrentSourceFingerprint(context) {
    return context.readCurrentSourceFingerprint();
  },
  interpret(result, context) {
    // Optional explicit policy handoff. Registration never invokes this automatically.
    return { score: result.answers.candidate_fit.score };
  },
});
```

A site ID has exactly one owner. Duplicate registration fails instead of silently
replacing another subsystem's adapter.

## Execution

Direct provider-neutral evaluation:

```js
import { DecisionSites } from '../decision/index.js';
const result = await DecisionSites.evaluate('retrieval.rerank.v1', context);
```

Director/Coordinator-managed execution:

```js
import { runDecisionSiteThroughDirector } from '../decision/work-director-bridge.js';
const run = await runDecisionSiteThroughDirector('retrieval.rerank.v1', context);
```

Detached shadow execution:

```js
import { startDecisionSiteThroughDirector } from '../decision/work-director-bridge.js';
const handle = startDecisionSiteThroughDirector('retrieval.rerank.v1', context);
```

The Work Director plan contains only site/contract/subsystem metadata. It must not
contain state, questions, API keys, provider choice, or canonical mutation authority.

## Hard rules

- Subsystem adapters must not import TypeSafe/OpenRouter schemas or endpoints.
- Do not add Jev as a Sidecar lane.
- Do not put subsystem thresholds into global Decision Core Settings.
- Keep evidence bounded for provider work while fingerprints cover destination authority.
- Every semantic site is freshness-aware unless explicitly declared otherwise.
- Decision Site interpretation is explicit; Decision Core never auto-applies it.
- Provider disabled/not configured is a skipped Decision job, not subsystem failure.
- Stale results are skipped and cannot be interpreted/applied.
- Provider failures remain truthful in Work Coordinator diagnostics.
- CP005 still exposes Off/Shadow only. No broad authoritative mode is added here.

## First implementation

`maintenance/housekeeper-decision-site.js` is the reference adapter. Housekeeper owns
its six entity-alignment questions and freshness logic. Decision Core owns provider
execution; the Work Director/Coordinator bridge schedules the shadow work; Housekeeper's
existing result remains authoritative.
