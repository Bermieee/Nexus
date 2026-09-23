import { loadBook } from '../lore/store.js';
import { getTree } from '../tree/store.js';
import { currentNodeForUid } from '../tree/ops.js';
import { DECISION_MODE, DECISION_PROVIDER_CLASS } from '../decision/constants.js';
import { registerDecisionSite, evaluateDecisionSite } from '../decision/site-registry.js';
import { recordDecisionShadowComparison } from '../decision/telemetry.js';
import { createDecisionFreshnessContract, decisionFreshnessSnapshot } from '../decision/freshness.js';
import { currentNexusLoreSourceRevision } from '../nexus/lore-source-revision.js';

export const HOUSEKEEPER_ENTITY_ALIGNMENT_SITE_ID = 'housekeeper.entity-alignment.v1';
export const HOUSEKEEPER_SEMANTIC_OVERLOAD_SITE_ID = 'housekeeper.semantic-overload.v1';
export const HOUSEKEEPER_SEMANTIC_OVERLOAD_MAX_CONTENT_CHARS = 24000;

function pairFreshnessInput({book,left,right,sourceRevision=null}={}){const normalizedBook=String(book||'');return{revisions:{loreTree:String(sourceRevision??currentNexusLoreSourceRevision(normalizedBook?[normalizedBook]:[]))},material:{book:normalizedBook,left:{uid:Number(left?.uid),title:String(left?.title||''),content:String(left?.content||''),nodeId:left?.nodeId||null},right:{uid:Number(right?.uid),title:String(right?.title||''),content:String(right?.content||''),nodeId:right?.nodeId||null}}};}
export function housekeeperPairFingerprint(context={}){return decisionFreshnessSnapshot(HOUSEKEEPER_ENTITY_ALIGNMENT_SITE_ID,pairFreshnessInput(context)).fingerprint;}
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

async function currentPairContext(pair){const data=await loadBook(pair.book),entries=Object.values(data?.entries||{}),byUid=new Map(entries.map(entry=>[Number(entry?.uid),entry])),left=byUid.get(Number(pair.left.uid)),right=byUid.get(Number(pair.right.uid));if(!left||!right)return{...pair,sourceRevision:`missing:${pair.book}:${pair.left.uid}:${pair.right.uid}`};const tree=getTree(pair.book);return{...pair,sourceRevision:currentNexusLoreSourceRevision([pair.book]),left:{uid:Number(left.uid),title:left.comment||'',content:left.content||'',nodeId:currentNodeForUid(tree,Number(left.uid))?.id||null},right:{uid:Number(right.uid),title:right.comment||'',content:right.content||'',nodeId:currentNodeForUid(tree,Number(right.uid))?.id||null}};}

function boundedEvidence(entry, maxChars = 12000) {
    const content = String(entry?.content || '');
    return { uid: Number(entry?.uid), title: String(entry?.title || ''), nodeId: entry?.nodeId || null, content: content.length <= maxChars ? content : `${content.slice(0, maxChars)}\n[bounded evidence: ${content.length - maxChars} chars omitted]` };
}

function overloadFreshnessInput({book,entry,canonicalEntry,nodeId=null,sourceRevision=null}={}){const canonical=canonicalEntry&&typeof canonicalEntry==='object'?canonicalEntry:entry||{},normalizedBook=String(book||'');return{revisions:{loreTree:String(sourceRevision??currentNexusLoreSourceRevision(normalizedBook?[normalizedBook]:[]))},material:{book:normalizedBook,nodeId:nodeId||entry?.nodeId||null,canonicalEntry:canonical}};}
export function housekeeperSemanticOverloadFingerprint(context={}){return decisionFreshnessSnapshot(HOUSEKEEPER_SEMANTIC_OVERLOAD_SITE_ID,overloadFreshnessInput(context)).fingerprint;}
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
async function currentOverloadContext(context={}){const data=await loadBook(context.book),entry=Object.values(data?.entries||{}).find(row=>Number(row?.uid)===Number(context.entry?.uid??context.canonicalEntry?.uid));if(!entry)return{...context,sourceRevision:`missing:${context.book}:${context.entry?.uid??context.canonicalEntry?.uid}`};const tree=getTree(context.book),nodeId=currentNodeForUid(tree,Number(entry.uid))?.id||null;return{...context,sourceRevision:currentNexusLoreSourceRevision([context.book]),canonicalEntry:entry,nodeId};}
const HOUSEKEEPER_PAIR_FRESHNESS=createDecisionFreshnessContract({siteId:HOUSEKEEPER_ENTITY_ALIGNMENT_SITE_ID,buildCanonicalInput:pairFreshnessInput});
const HOUSEKEEPER_OVERLOAD_FRESHNESS=createDecisionFreshnessContract({siteId:HOUSEKEEPER_SEMANTIC_OVERLOAD_SITE_ID,buildCanonicalInput:overloadFreshnessInput});

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
    freshness: HOUSEKEEPER_PAIR_FRESHNESS,
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
    freshness: HOUSEKEEPER_OVERLOAD_FRESHNESS,
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


export async function evaluateHousekeeperMergeAssist(pair, options = {}) {const context={...pair,sourceRevision:pair?.sourceRevision??currentNexusLoreSourceRevision(pair?.book?[pair.book]:[])};context.readCurrentFreshnessContext=()=>currentPairContext(context);
    const result = await evaluateDecisionSite(HOUSEKEEPER_ENTITY_ALIGNMENT_SITE_ID, context, { mode: DECISION_MODE.ASSIST, ...options });
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
    const decisionContext={...context,sourceRevision:context?.sourceRevision??currentNexusLoreSourceRevision(context?.book?[context.book]:[])};decisionContext.readCurrentFreshnessContext=()=>currentOverloadContext(decisionContext);const result = await evaluateDecisionSite(HOUSEKEEPER_SEMANTIC_OVERLOAD_SITE_ID, decisionContext, { mode: DECISION_MODE.ASSIST, ...options });
    if(!result?.ok||result?.stale)return {handled:false,result,reason:result?.stale?'stale':'decision-failed'};
    const overloaded=Number(result.answers?.semantically_overloaded?.value);
    const separable=Number(result.answers?.separable_concepts?.value);
    const useful=Number(result.answers?.split_likely_improves_retrieval?.value);
    const admitted=(Number.isFinite(overloaded)&&overloaded>=0.5)&&(Number.isFinite(separable)&&separable>=0.5)&&(Number.isFinite(useful)&&useful>=0.5);
    return {handled:true,admitted,result,reason:'assist-success'};
}
export async function evaluateHousekeeperMergeShadow(pair, options = {}) {const context={...pair,sourceRevision:pair?.sourceRevision??currentNexusLoreSourceRevision(pair?.book?[pair.book]:[])};context.readCurrentFreshnessContext=()=>currentPairContext(context);
    const result = await evaluateDecisionSite(HOUSEKEEPER_ENTITY_ALIGNMENT_SITE_ID, context, { mode: DECISION_MODE.SHADOW, ...options });
    return recordAlignmentComparison(pair, result);
}
export async function evaluateHousekeeperSemanticOverloadShadow(context, options = {}) {
    const eligibility = housekeeperSemanticOverloadEligibility(context);
    if (!eligibility.eligible) return { ok: false, deferred: true, reason: eligibility.reason, sourceFingerprint: housekeeperSemanticOverloadFingerprint(context), decisionSiteId: HOUSEKEEPER_SEMANTIC_OVERLOAD_SITE_ID };
    const decisionContext={...context,sourceRevision:context?.sourceRevision??currentNexusLoreSourceRevision(context?.book?[context.book]:[])};decisionContext.readCurrentFreshnessContext=()=>currentOverloadContext(decisionContext);const result = await evaluateDecisionSite(HOUSEKEEPER_SEMANTIC_OVERLOAD_SITE_ID, decisionContext, { mode: DECISION_MODE.SHADOW, ...options });
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
