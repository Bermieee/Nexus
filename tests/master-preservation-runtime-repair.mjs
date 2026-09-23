import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = path => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');

const retriever = read('retrieval/retriever.js');
const decision = read('retrieval/decision-sites.js');
const router = read('sidecar/router.js');
const batchLayer = read('nexus/batch-layer.js');
const summarizer = read('memory/summarizer.js');
const summaryValidation = read('sidecar/semantic-validation.js');
const index = read('index.js');

// MASTER LOG GUARD — #200/#210 Retrieval freshness and Jev admission remain intact.
for (const required of [
  'candidateFreshnessInput',
  'createDecisionFreshnessContract',
  'readCurrentFreshnessContext',
  'readCurrentChatRevision',
  'partitionRetrievalDecisionCandidates',
]) assert.ok(decision.includes(required), 'Master Decision freshness contract missing: ' + required);
assert.ok(retriever.includes('candidateAssistRun = await evaluateRetrievalCandidateAdmissionAssist'),'Jev candidate admission must remain in Retrieval');
assert.ok(retriever.includes('const injectionRun = reviewCandidates.length'),'Jev may prefilter but must not replace final Lore Injection review');
assert.ok(retriever.includes('await runInjectionReview({'),'Final Lore Injection Sidecar authority must remain');

// The global condense still exists. Only its OPTIONAL foreground refinement time
// is bounded; complete validated Sidecar gather remains the fallback.
assert.ok(retriever.includes('Lore injection review · ${gate.mode} · global condense'));
assert.ok(retriever.includes('foregroundCondenseBudgetMs'));
assert.ok(retriever.includes('optionalRefinementTimeout:true'));
assert.ok(retriever.includes('preserved validated gathered selections'));
assert.ok(retriever.includes("if (isIntentionalCancellation(error) && error?.optionalRefinementTimeout !== true) throw error"),
  'User stop/stale/scope cancellation must still propagate');

// MASTER LOG GUARD — Work Director health decision remains owner; JobQueue does
// not gain health policy. Ordinary idle-equivalent rehome is still supported.
assert.ok(router.includes("assignmentDecision.reason !== 'health-offload'"));
assert.ok(router.includes('dynamicRehome: allowPrimaryIdleRehome'));
assert.ok(router.includes('dynamicCandidateSlots: allowPrimaryIdleRehome ? candidates : [slot]'));
assert.ok(router.includes('shouldRetrySidecarFailure({'),'Existing adaptive fallback policy must remain');

// MASTER LOG GUARD — resource targets stay soft and Auto Sense reasoning remains.
assert.ok(batchLayer.includes("reasoningEffort: reasoningEffort ?? 'auto'"));
assert.ok(batchLayer.includes('enforceRequestedMaxTokens: false'));
assert.ok(!summarizer.includes('enforceRequestedMaxTokens: true'));
assert.ok(!summarizer.includes("reasoningEffort: 'none'"));

// MASTER LOG GUARD — Summary remains fail-closed and atomic on unresolved slice
// failure; repair tightens the prompt rather than weakening validation/coverage.
assert.ok(summarizer.includes("Summary slice failed after its bounded recovery; completed slices were retained only as execution evidence and nothing was staged."));
assert.ok(summarizer.includes('SUMMARY_METADATA_ARRAY_RULE'));
assert.ok(summarizer.includes('Never return an object, null, boolean, or scalar for those keys.'));
assert.ok(summaryValidation.includes("Summary evidence ${field} must be a non-placeholder string array."));
assert.ok(!summaryValidation.includes('optionalSummaryMetadata'));

// World Info suppression authority is unchanged; only diagnostic reason is more truthful.
assert.ok(index.includes('const suppressionAuthorized=(treeOwnershipReady&&reusableReplacementReady)||currentBootstrapReady;'));
assert.ok(index.includes('nexus-retrieval-replacement-not-ready'));
assert.ok(index.includes('beginNativeWorldInfoSuppression({'));

console.log('PASS master-log-preserving live runtime repairs');
