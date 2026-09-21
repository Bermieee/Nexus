import { loadBook } from '../lore/store.js';
import { getTree } from '../tree/store.js';
import { currentNodeForUid } from '../tree/ops.js';
import { DECISION_MODE, DECISION_PROVIDER_CLASS } from '../decision/constants.js';
import { registerDecisionSite, evaluateDecisionSite } from '../decision/site-registry.js';
import { recordDecisionShadowComparison } from '../decision/telemetry.js';

export const HOUSEKEEPER_ENTITY_ALIGNMENT_SITE_ID = 'housekeeper.entity-alignment.v1';
export const HOUSEKEEPER_SEMANTIC_OVERLOAD_SITE_ID = 'housekeeper.semantic-overload.v1';
export const HOUSEKEEPER_SEMANTIC_OVERLOAD_MAX_CONTENT_CHARS = 24000;

function stableObject(value) {
    if (Array.isArray(value)) return value.map(stableObject);
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableObject(value[key])]));
    return value;
}
function hashFingerprint(prefix, value) {
    const text = JSON.stringify(stableObject(value));
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i += 1) { hash ^= text.charCodeAt(i); hash = Math.imul(hash, 0x01000193) >>> 0; }
    return `${prefix}-${hash.toString(16).padStart(8, '0')}-${text.length}`;
}
export function housekeeperPairFingerprint({ book, left, right } = {}) {
    return hashFingerprint('hk-pair', { book: String(book || ''), left: { uid: Number(left?.uid), title: String(left?.title || ''), content: String(left?.content || ''), nodeId: left?.nodeId || null }, right: { uid: Number(right?.uid), title: String(right?.title || ''), content: String(right?.content || ''), nodeId: right?.nodeId || null } });
}
export function housekeeperEntityAlignmentQuestions() {
    return {
        same_concept: { type: 'noul', instructions: 'Are the left and right lore entries fundamentally about the same entity, event, state, rule, relationship, or concept rather than merely sharing words?' },
        meaningful_overlap: { type: 'score', instructions: 'How much durable semantic content overlaps between the two entries?', criteria: ['No durable overlap', 'Small incidental overlap', 'Moderate shared facts', 'Strong overlap with some distinct facts', 'Near-duplicate durable content'] },
        left_has_unique_facts: { type: 'noul', instructions: 'Does the left entry contain durable facts that are not represented by the right entry?' },
        right_has_unique_facts: { type: 'noul', instructions: 'Does the right entry contain durable facts that are not represented by the left entry?' },
        contradiction: { type: 'noul', instructions: 'Do the entries make materially incompatible claims that should be reviewed as a conflict rather than silently merged?' },
        safe_to_escalate_for_merge: { type: 'noul', instructions: 'Is this pair suitable to escalate to a separate merge-synthesis/review step, where another system or operator would still own the final merge policy and canonical write?' },
    };
}
export function housekeeperSemanticOverloadQuestions() {
    return {
        semantically_overloaded: { type: 'noul', instructions: 'Does this lore entry contain more distinct durable semantic responsibilities than one retrieval unit should normally carry?' },
        separable_concepts: { type: 'noul', instructions: 'Does the entry contain two or more coherent concepts that could be separated without inventing information or losing their meaning?' },
        semantic_overload_degree: { type: 'score', instructions: 'How semantically overloaded is this entry as a single retrieval unit?', criteria: ['Single focused concept', 'Mostly focused with minor tangents', 'Several related responsibilities', 'Multiple clearly distinct concepts', 'Strongly overloaded and structurally separable'] },
        split_likely_improves_retrieval: { type: 'noul', instructions: 'Would separating the entry into coherent concept-specific units likely improve retrieval specificity without sacrificing necessary context?' },
    };
}

async function currentPairFingerprint(pair) {
    const data = await loadBook(pair.book);
    const entries = Object.values(data?.entries || {});
    const byUid = new Map(entries.map(entry => [Number(entry?.uid), entry]));
    const left = byUid.get(Number(pair.left.uid));
    const right = byUid.get(Number(pair.right.uid));
    if (!left || !right) return `missing:${pair.book}:${pair.left.uid}:${pair.right.uid}`;
    const tree = getTree(pair.book);
    const leftNodeId = currentNodeForUid(tree, Number(left.uid))?.id || null;
    const rightNodeId = currentNodeForUid(tree, Number(right.uid))?.id || null;
    return housekeeperPairFingerprint({ book: pair.book, left: { uid: Number(left.uid), title: left.comment || '', content: left.content || '', nodeId: leftNodeId }, right: { uid: Number(right.uid), title: right.comment || '', content: right.content || '', nodeId: rightNodeId } });
}
function boundedEvidence(entry, maxChars = 12000) {
    const content = String(entry?.content || '');
    return { uid: Number(entry?.uid), title: String(entry?.title || ''), nodeId: entry?.nodeId || null, content: content.length <= maxChars ? content : `${content.slice(0, maxChars)}\n[bounded evidence: ${content.length - maxChars} chars omitted]` };
}

export function housekeeperSemanticOverloadFingerprint({ book, entry, canonicalEntry, nodeId = null } = {}) {
    const canonical = canonicalEntry && typeof canonicalEntry === 'object' ? canonicalEntry : entry || {};
    return hashFingerprint('hk-overload', { book: String(book || ''), nodeId: nodeId || entry?.nodeId || null, canonicalEntry: canonical });
}
export function housekeeperSemanticOverloadEligibility({ entry, canonicalEntry } = {}) {
    const source = canonicalEntry && typeof canonicalEntry === 'object' ? canonicalEntry : entry || {};
    const content = String(source?.content ?? entry?.content ?? '');
    if (!content.trim()) return { eligible: false, reason: 'empty-content', contentChars: content.length, maxContentChars: HOUSEKEEPER_SEMANTIC_OVERLOAD_MAX_CONTENT_CHARS };
    if (content.length > HOUSEKEEPER_SEMANTIC_OVERLOAD_MAX_CONTENT_CHARS) return { eligible: false, reason: 'complete-content-exceeds-site-contract', contentChars: content.length, maxContentChars: HOUSEKEEPER_SEMANTIC_OVERLOAD_MAX_CONTENT_CHARS };
    return { eligible: true, reason: 'complete-content-representable', contentChars: content.length, maxContentChars: HOUSEKEEPER_SEMANTIC_OVERLOAD_MAX_CONTENT_CHARS };
}
function completeOverloadEvidence(context = {}) {
    const eligibility = housekeeperSemanticOverloadEligibility(context);
    if (!eligibility.eligible) throw new Error(`Housekeeper semantic-overload evidence deferred: ${eligibility.reason}.`);
    const source = context.canonicalEntry && typeof context.canonicalEntry === 'object' ? context.canonicalEntry : context.entry || {};
    return {
        uid: Number(source?.uid ?? context.entry?.uid),
        title: String(source?.comment ?? context.entry?.title ?? ''),
        keywords: Array.isArray(source?.key) ? source.key.map(value => String(value || '')).filter(Boolean) : [],
        nodeId: context.nodeId || context.entry?.nodeId || null,
        content: String(source?.content ?? context.entry?.content ?? ''),
        evidenceContract: { id: 'housekeeper.semantic-overload.complete-content.v1', completeness: 'complete-canonical-content', contentChars: eligibility.contentChars, maxContentChars: eligibility.maxContentChars },
    };
}
async function currentOverloadFingerprint(context = {}) {
    const data = await loadBook(context.book);
    const entry = Object.values(data?.entries || {}).find(row => Number(row?.uid) === Number(context.entry?.uid ?? context.canonicalEntry?.uid));
    if (!entry) return `missing:${context.book}:${context.entry?.uid ?? context.canonicalEntry?.uid}`;
    const tree = getTree(context.book);
    const nodeId = currentNodeForUid(tree, Number(entry.uid))?.id || null;
    return housekeeperSemanticOverloadFingerprint({ book: context.book, canonicalEntry: entry, nodeId });
}

export const HOUSEKEEPER_ENTITY_ALIGNMENT_SITE = registerDecisionSite({
    id: HOUSEKEEPER_ENTITY_ALIGNMENT_SITE_ID,
    subsystem: 'housekeeper',
    contractId: 'housekeeper.entity-alignment.v1',
    contractVersion: 1,
    mode: DECISION_MODE.ASSIST,
    priority: 25,
    buildState(pair) {
        return {
            book: pair.book,
            deterministicHousekeeperResult: 'MERGE_CANDIDATE',
            similarity: pair.similarity || null,
            left: boundedEvidence(pair.left),
            right: boundedEvidence(pair.right),
        };
    },
    buildQuestions() { return housekeeperEntityAlignmentQuestions(); },
    getSourceFingerprint(pair) { return housekeeperPairFingerprint(pair); },
    getCurrentSourceFingerprint(pair) { return currentPairFingerprint(pair); },
    metadata: { decisionClass: 'entity-alignment', shadowOnly: false, assist: true, boundary: 'after-deterministic-scan-before-housekeeper-review' },
});

export const HOUSEKEEPER_SEMANTIC_OVERLOAD_SITE = registerDecisionSite({
    id: HOUSEKEEPER_SEMANTIC_OVERLOAD_SITE_ID,
    subsystem: 'housekeeper',
    contract: {
        id: HOUSEKEEPER_SEMANTIC_OVERLOAD_SITE_ID,
        version: 1,
        subsystem: 'housekeeper',
        questions: {
            semantically_overloaded: { type: 'noul' },
            separable_concepts: { type: 'noul' },
            semantic_overload_degree: { type: 'score' },
            split_likely_improves_retrieval: { type: 'noul' },
        },
    },
    mode: DECISION_MODE.ASSIST,
    priority: 25,
    buildState(context) {
        return {
            book: context.book,
            deterministicHousekeeperResult: 'OVERSIZED',
            entry: completeOverloadEvidence(context),
        };
    },
    buildQuestions() { return housekeeperSemanticOverloadQuestions(); },
    getSourceFingerprint(context) { return housekeeperSemanticOverloadFingerprint(context); },
    getCurrentSourceFingerprint(context) { return currentOverloadFingerprint(context); },
    metadata: { decisionClass: 'semantic-overload', shadowOnly: false, assist: true, boundary: 'after-deterministic-scan-before-housekeeper-review', evidenceContract: 'complete-canonical-content-v1' },
});

function recordAlignmentComparison(pair, result) {
    if (!result?.ok || result?.stale) return result;
    const escalationProbability = Number(result.answers?.safe_to_escalate_for_merge?.value);
    const agreement = Number.isFinite(escalationProbability) ? escalationProbability >= 0.5 : null;
    recordDecisionShadowComparison({
        contractId: result.contractId,
        provider: result.provider,
        agreement,
        potentialExpensiveLlmCallAvoided: result.providerClass === DECISION_PROVIDER_CLASS.TYPED_DECISION,
        details: {
            housekeeperResult: 'MERGE_CANDIDATE',
            pair: { book: pair.book, uidA: pair.left.uid, uidB: pair.right.uid, similarityPercent: pair.similarity?.percent ?? null },
            escalationProbability: Number.isFinite(escalationProbability) ? escalationProbability : null,
            comparisonBasis: 'shadow-direction-only; probability >= 0.5; never production merge policy',
            latencyMs: result.latencyMs,
            usage: result.usage,
        },
    });
    return result;
}
function recordOverloadComparison(context, result) {
    if (!result?.ok || result?.stale) return result;
    const overloadProbability = Number(result.answers?.semantically_overloaded?.value);
    const agreement = Number.isFinite(overloadProbability) ? overloadProbability >= 0.5 : null;
    recordDecisionShadowComparison({
        contractId: result.contractId,
        provider: result.provider,
        agreement,
        potentialExpensiveLlmCallAvoided: result.providerClass === DECISION_PROVIDER_CLASS.TYPED_DECISION,
        details: {
            housekeeperResult: 'OVERSIZED',
            entry: { book: context.book, uid: Number(context.entry?.uid ?? context.canonicalEntry?.uid), chars: String(context.canonicalEntry?.content ?? context.entry?.content ?? '').length },
            overloadProbability: Number.isFinite(overloadProbability) ? overloadProbability : null,
            comparisonBasis: 'shadow-direction-only; probability >= 0.5; deterministic size rule remains authoritative',
            latencyMs: result.latencyMs,
            usage: result.usage,
        },
    });
    return result;
}


export async function evaluateHousekeeperMergeAssist(pair, options = {}) {
    const result = await evaluateDecisionSite(HOUSEKEEPER_ENTITY_ALIGNMENT_SITE_ID, pair, { mode: DECISION_MODE.ASSIST, ...options });
    if(!result?.ok||result?.stale)return {handled:false,result,reason:result?.stale?'stale':'decision-failed'};
    const same=Number(result.answers?.same_concept?.value);
    const safe=Number(result.answers?.safe_to_escalate_for_merge?.value);
    const contradiction=Number(result.answers?.contradiction?.value);
    const admitted=(Number.isFinite(same)&&same>=0.5)&&(Number.isFinite(safe)&&safe>=0.5)&&!(Number.isFinite(contradiction)&&contradiction>=0.5);
    return {handled:true,admitted,result,reason:'assist-success'};
}
export async function evaluateHousekeeperSemanticOverloadAssist(context, options = {}) {
    const eligibility = housekeeperSemanticOverloadEligibility(context);
    if (!eligibility.eligible) return {handled:false,deferred:true,reason:eligibility.reason};
    const result = await evaluateDecisionSite(HOUSEKEEPER_SEMANTIC_OVERLOAD_SITE_ID, context, { mode: DECISION_MODE.ASSIST, ...options });
    if(!result?.ok||result?.stale)return {handled:false,result,reason:result?.stale?'stale':'decision-failed'};
    const overloaded=Number(result.answers?.semantically_overloaded?.value);
    const separable=Number(result.answers?.separable_concepts?.value);
    const useful=Number(result.answers?.split_likely_improves_retrieval?.value);
    const admitted=(Number.isFinite(overloaded)&&overloaded>=0.5)&&(Number.isFinite(separable)&&separable>=0.5)&&(Number.isFinite(useful)&&useful>=0.5);
    return {handled:true,admitted,result,reason:'assist-success'};
}
export async function evaluateHousekeeperMergeShadow(pair, options = {}) {
    const result = await evaluateDecisionSite(HOUSEKEEPER_ENTITY_ALIGNMENT_SITE_ID, pair, { mode: DECISION_MODE.SHADOW, ...options });
    return recordAlignmentComparison(pair, result);
}
export async function evaluateHousekeeperSemanticOverloadShadow(context, options = {}) {
    const eligibility = housekeeperSemanticOverloadEligibility(context);
    if (!eligibility.eligible) return { ok: false, deferred: true, reason: eligibility.reason, sourceFingerprint: housekeeperSemanticOverloadFingerprint(context), decisionSiteId: HOUSEKEEPER_SEMANTIC_OVERLOAD_SITE_ID };
    const result = await evaluateDecisionSite(HOUSEKEEPER_SEMANTIC_OVERLOAD_SITE_ID, context, { mode: DECISION_MODE.SHADOW, ...options });
    return recordOverloadComparison(context, result);
}

function queueSiteThroughDirector(siteId, contexts, { maxItems = 4, source = 'housekeeper-shadow', onResult = null, recordComparison } = {}) {
    const work = (Array.isArray(contexts) ? contexts : []).slice(0, Math.max(0, Number(maxItems) || 0));
    if (!work.length) return 0;
    import('../decision/work-director-bridge.js').then(({ startDecisionSiteThroughDirector }) => {
        for (const context of work) {
            const handle = startDecisionSiteThroughDirector(siteId, context, { source, mode: DECISION_MODE.SHADOW });
            handle.promise.then(run => {
                const decision = run?.job?.result?.value?.decision || null;
                if (!decision) return;
                recordComparison?.(context, decision);
                try { onResult?.({ context, result: decision, siteId }); } catch {}
            }).catch(() => {});
        }
    }).catch(() => {});
    return work.length;
}

export function queueHousekeeperMergeShadow(pairs = [], { maxPairs = 4, onResult = null } = {}) {
    return queueSiteThroughDirector(HOUSEKEEPER_ENTITY_ALIGNMENT_SITE_ID, pairs, { maxItems: maxPairs, source: 'housekeeper-shadow', onResult, recordComparison: recordAlignmentComparison });
}
export function queueHousekeeperSemanticOverloadShadow(entries = [], { maxEntries = 4, onResult = null } = {}) {
    const eligible = (Array.isArray(entries) ? entries : []).filter(context => housekeeperSemanticOverloadEligibility(context).eligible);
    return queueSiteThroughDirector(HOUSEKEEPER_SEMANTIC_OVERLOAD_SITE_ID, eligible, { maxItems: maxEntries, source: 'housekeeper-overload-shadow', onResult, recordComparison: recordOverloadComparison });
}
