import { getContext } from '../../../../st-context.js';
import { loadBook } from '../lore/store.js';
import { getActiveBooks } from '../lore/active-books.js';
import { getTree } from '../tree/store.js';
import { getSettings } from '../core/settings.js';
import { estimateContentTokens, resolveMainModelHint } from '../observability/token-estimator.js';
import { logEvent } from '../observability/telemetry.js';

import { rankBootstrapEntries, packBootstrapEntries, renderBootstrapPrompt, DEFAULT_BOOTSTRAP_TARGET_TOKENS, DEFAULT_BOOTSTRAP_MAX_ENTRIES } from './bootstrap-admission-policy.js';

import { prepareLorePaging, markLorePagingUsed } from '../paging/lore-runtime.js';
import { captureNexusWorkScope, isNexusWorkScopeFresh } from '../nexus/work-scope.js';
import { currentNexusLoreSourceRevision } from '../nexus/lore-source-revision.js';
import { isNarrativeSceneMessage } from './handoff-policy.js';
import { publishBootstrapLoreOutlet, clearBootstrapLoreOutlet } from '../nexus/generation-frame-ports.js';
import { NEXUS_GENERATION_OUTLET_STATUS } from '../nexus/generation-frame-contract.js';

const state = {
    generationId: null,
    text: '',
    refs: [],
    books: [],
    retainedBooks: [],
    estimatedInjectionTokens: 0,
    estimatedNativeTokens: 0,
    estimatedManagedCorpusTokens: 0,
    selectedCount: 0,
    candidateCount: 0,
    preparedAt: 0,
    policyKey: '',
    mainModel: '',
    sourceRevision: '',
    sourceBooks: [],
};

function stableStringCompare(left, right) {
    const a=String(left ?? '').normalize('NFKC'), b=String(right ?? '').normalize('NFKC');
    return a < b ? -1 : a > b ? 1 : 0;
}

function bootstrapPolicySnapshot(settings = getSettings(), context = getContext()) {
    const bootstrap = settings?.retrieval?.bootstrapAdmission || {};
    return {
        nexusEnabled: settings?.enabled === true,
        retrievalEnabled: settings?.retrieval?.enabled === true,
        bootstrapEnabled: bootstrap.enabled !== false,
        targetTokens: Math.max(500, Number(bootstrap.targetTokens ?? DEFAULT_BOOTSTRAP_TARGET_TOKENS) || DEFAULT_BOOTSTRAP_TARGET_TOKENS),
        maxEntries: Math.max(1, Math.floor(Number(bootstrap.maxEntries ?? DEFAULT_BOOTSTRAP_MAX_ENTRIES) || DEFAULT_BOOTSTRAP_MAX_ENTRIES)),
        mainModel: resolveMainModelHint(context),
        // C11-178: scene-window size changes the evidence used for bootstrap
        // selection and therefore belongs to the in-flight authority key.
        sceneMessages: Math.max(1, Number(settings?.retrieval?.contextMessages) || 10),
    };
}

function bootstrapPolicyKey(snapshot) {
    return JSON.stringify(snapshot || {});
}

function bootstrapPolicyEnabled(snapshot) {
    return snapshot?.nexusEnabled === true && snapshot?.retrievalEnabled === true && snapshot?.bootstrapEnabled === true;
}

function recentNarrative(context, maxMessages = 8) {
    const chat = Array.isArray(context?.chat) ? context.chat : [];
    return chat.filter(isNarrativeSceneMessage)
        .slice(-Math.max(1, Number(maxMessages) || 8))
        .map(row => String(row.mes || '').trim())
        .join('\n');
}

function bootstrapBookFingerprint(data) {
    return JSON.stringify(Object.values(data?.entries || {}).map(entry => ({
        uid:Number(entry?.uid), disabled:entry?.disable===true, constant:entry?.constant===true,
        title:String(entry?.comment || entry?.title || ''), content:String(entry?.content || ''),
        key:Array.isArray(entry?.key)?entry.key.map(String):[], keysecondary:Array.isArray(entry?.keysecondary)?entry.keysecondary.map(String):[],
    })).sort((a,b)=>a.uid-b.uid || stableStringCompare(a.title,b.title) || stableStringCompare(a.content,b.content)));
}

export async function prepareBootstrapAdmission({ generationId = null } = {}) {
    const settings = getSettings();
    // C11-195: only clear an admission owned by this generation.  Another
    // foreground generation may already own a valid prompt; do not force-clear
    // it before proving ownership.
    clearBootstrapAdmission({ generationId, force:false });
    let livePolicy = bootstrapPolicySnapshot(settings, getContext());
    if (!bootstrapPolicyEnabled(livePolicy)) {
        return { skipped:true, reason:'disabled', refs:[] };
    }
    const allBooks = getActiveBooks({ requireTree:false, access:'read', injection:'tv2' });
    const books = allBooks.filter(book => !getTree(book)?.root);
    if (!books.length) return { skipped:true, reason:'no-pre-tree-books', refs:[] };
    const scope = captureNexusWorkScope(getContext(), { includeGeneration:generationId != null, generationId, includeSourceRevision:true, sourceBooks:books });
    let scene = recentNarrative(getContext(), livePolicy.sceneMessages);
    if (!scene.trim()) {
        logEvent('retrieval','bootstrap-admission-retained-native',{reason:'no-chat-context',books},'debug');
        return { skipped:true, reason:'no-chat-context', refs:[] };
    }
    const bookData = new Map();
    const failures = [];
    const loaded = await Promise.allSettled(books.map(book => loadBook(book)));
    loaded.forEach((result,index) => {
        const book = books[index];
        if (result.status === 'fulfilled') bookData.set(book, result.value);
        else failures.push({book,error:String(result.reason?.message||result.reason)});
    });
    if (!isNexusWorkScopeFresh(scope,getContext())) return {skipped:true,reason:'scope-changed',refs:[]};
    if (!bookData.size) {
        logEvent('retrieval','bootstrap-admission-retained-native',{reason:'book-load-failed',books,failures},'warn');
        return { skipped:true, reason:'book-load-failed', refs:[] };
    }
    const paging = await prepareLorePaging({books:[...bookData.keys()],bookData,requestId:generationId});
    if (!isNexusWorkScopeFresh(scope,getContext())) return {skipped:true,reason:'scope-changed',refs:[]};
    livePolicy = bootstrapPolicySnapshot(getSettings(), getContext());
    if (!bootstrapPolicyEnabled(livePolicy)) return {skipped:true,reason:'disabled-before-bootstrap-selection',refs:[]};
    let ranked = rankBootstrapEntries({ books:[...bookData.keys()], scene, bookData, eligibleIds:paging.eligibleIds, model:livePolicy.mainModel });
    const pack = rows => packBootstrapEntries(rows, {
        targetTokens: livePolicy.targetTokens,
        maxEntries: livePolicy.maxEntries,
        model: livePolicy.mainModel,
    });
    let packed = pack(ranked.rows);
    if (paging.eligibleIds && (!packed.selected.length || packed.coveredBooks.length < bookData.size)) {
        // Preserve vector eligibility in books that already produced usable rows.
        // Broaden only books with zero eligible rows; one uncovered book must not
        // collapse every healthy book back to full-corpus eligibility.
        const rankedBooks = new Set((ranked.rows || []).map(row => String(row.book)));
        const uncovered = [...bookData.keys()].filter(book => !rankedBooks.has(String(book)));
        if (uncovered.length) {
            const fallback = rankBootstrapEntries({books:uncovered,scene,bookData});
            ranked = {
                ...ranked,
                rows:[...(ranked.rows||[]),...(fallback.rows||[])].sort((a,b)=>b.score-a.score||b.relevanceScore-a.relevanceScore||Number(b.constant)-Number(a.constant)||a.book.localeCompare(b.book)||a.uid-b.uid),
                bookStats:new Map([...(ranked.bookStats||new Map()),...(fallback.bookStats||new Map())]),
            };
            packed = pack(ranked.rows);
        }
    }
    if (!await paging.validate() || !isNexusWorkScopeFresh(scope,getContext())) return {skipped:true,reason:'paging-source-changed',refs:[]};
    // Paging/provider work above can yield to the event loop.  Re-read the
    // complete bootstrap authority immediately before publication.  If the
    // operator changed the budget/model while work was in flight, repack from
    // the already validated local evidence under the new policy rather than
    // publishing the stale plan.
    const finalPolicy = bootstrapPolicySnapshot(getSettings(), getContext());
    if (!bootstrapPolicyEnabled(finalPolicy)) return {skipped:true,reason:'disabled-before-bootstrap-commit',refs:[]};
    if (bootstrapPolicyKey(finalPolicy) !== bootstrapPolicyKey(livePolicy)) {
        livePolicy = finalPolicy;
        scene = recentNarrative(getContext(), livePolicy.sceneMessages);
        if (!scene.trim()) return {skipped:true,reason:'no-chat-context-before-bootstrap-commit',refs:[]};
        ranked = rankBootstrapEntries({ books:[...bookData.keys()], scene, bookData, eligibleIds:paging.eligibleIds, model:livePolicy.mainModel });
        packed = pack(ranked.rows);
        if (paging.eligibleIds && (!packed.selected.length || packed.coveredBooks.length < bookData.size)) {
            ranked = rankBootstrapEntries({books:[...bookData.keys()],scene,bookData,model:livePolicy.mainModel});
            packed = pack(ranked.rows);
        }
    }
    const sourceBooks = [...bookData.keys()];
    const refreshed = await Promise.allSettled(sourceBooks.map(book => loadBook(book)));
    for (let index=0; index<refreshed.length; index+=1) {
        const result=refreshed[index], book=sourceBooks[index];
        if (result.status !== 'fulfilled' || bootstrapBookFingerprint(result.value) !== bootstrapBookFingerprint(bookData.get(book))) {
            logEvent('retrieval','bootstrap-admission-retained-native',{reason:'lore-source-changed',book},'warn');
            return {skipped:true,reason:'lore-source-changed',refs:[]};
        }
    }
    const currentPreTree = new Set(getActiveBooks({ requireTree:false, access:'read', injection:'tv2' }).filter(book => !getTree(book)?.root));
    if (!isNexusWorkScopeFresh(scope,getContext()) || sourceBooks.some(book => !currentPreTree.has(book))) return {skipped:true,reason:'bootstrap-authority-changed',refs:[]};
    if (!packed.selected.length || !packed.coveredBooks?.length) {
        logEvent('retrieval','bootstrap-admission-retained-native',{
            reason:'no-safe-local-candidates',books:[...bookData.keys()],candidateCount:ranked.rows.length,queryTermCount:ranked.queryTermCount,skippedBooks:packed.skippedBooks||[],failures,
        },'info');
        return { skipped:true, reason:'no-safe-local-candidates', refs:[] };
    }
    const text = renderBootstrapPrompt(packed.selected);
    const refs = packed.selected.map(row => ({ book:row.book, uid:row.uid, title:row.title }));
    if (paging.probeId) {
        const vectorIds = new Set((paging.nominationDetails || []).map(row => String(row.sourceId)));
        const passed = refs.filter(row => vectorIds.has(JSON.stringify([String(row.book), Number(row.uid)]))).map(row => ({ book:row.book, uid:Number(row.uid) }));
        logEvent('vector-paging','lore-wake-selection',{probeId:paging.probeId,requestId:generationId,turn:paging.turn??null,sourceVersions:paging.sourceVersions||{},nominatedCount:vectorIds.size,passedRetrievalCount:passed.length,passedRetrieval:passed},'info');
    }
    const coveredBooks = [...new Set(packed.coveredBooks || refs.map(ref => ref.book))];
    const retainedBooks = [...bookData.keys()].filter(book => !coveredBooks.includes(book));
    const published=publishBootstrapLoreOutlet({generationId,status:NEXUS_GENERATION_OUTLET_STATUS.READY,content:text,refs,sourceRevision:currentNexusLoreSourceRevision([...books].sort()),data:{books:coveredBooks,retainedBooks}});
    if(published?.accepted===false)return {skipped:true,reason:`generation-frame-${published.reason}`,refs:[]};
    markLorePagingUsed(refs, { probeId:paging.probeId, stage:'bootstrap-injection', selectedRefs:refs });
    Object.assign(state, {
        generationId:generationId == null ? null : String(generationId),
        text,
        refs,
        books:coveredBooks,
        retainedBooks,
        estimatedInjectionTokens:estimateContentTokens(text, livePolicy.mainModel),
        estimatedNativeTokens:ranked.estimatedNativeTokens,
        estimatedManagedCorpusTokens:ranked.estimatedManagedCorpusTokens,
        selectedCount:refs.length,
        candidateCount:ranked.rows.length,
        preparedAt:Date.now(),
        policyKey:bootstrapPolicyKey(livePolicy),
        mainModel:livePolicy.mainModel,
        sourceBooks:[...books].sort(),
        sourceRevision:currentNexusLoreSourceRevision([...books].sort()),
    });
    logEvent('retrieval','bootstrap-admission-prepared',{
        books:coveredBooks,
        selectedCount:refs.length,
        candidateCount:ranked.rows.length,
        estimatedInjectionTokens:state.estimatedInjectionTokens,
        estimatedNativeTokens:state.estimatedNativeTokens,
        estimatedManagedCorpusTokens:state.estimatedManagedCorpusTokens,
        estimatedPotentialTokensWithheld:Math.max(0,state.estimatedManagedCorpusTokens-state.estimatedInjectionTokens),
        targetTokens:packed.targetTokens,
        maxEntries:packed.maxEntries,
        minRelevanceScore:packed.minRelevanceScore,
        retainedBooks,
        skippedBooks:packed.skippedBooks||[],
        failures,
    },'info');
    return {
        bootstrap:true,
        reason:'bootstrap-admission',
        refs:refs.map(ref=>({...ref})),
        books:[...coveredBooks],
        retainedBooks:[...retainedBooks],
        estimatedInjectionTokens:state.estimatedInjectionTokens,
        estimatedNativeTokens:state.estimatedNativeTokens,
        estimatedManagedCorpusTokens:state.estimatedManagedCorpusTokens,
    };
}

export function getBootstrapAdmissionState() {
    return { ...state, refs:state.refs.map(ref=>({...ref})), books:[...state.books], retainedBooks:[...state.retainedBooks] };
}
function bootstrapAdmissionIsCurrent(book, generationId = null) {
    const name = String(book || '').trim();
    if (!name || !state.text || !state.books.includes(name)) return false;
    if (generationId != null && state.generationId != null && String(generationId) !== String(state.generationId)) return false;
    if (!state.sourceRevision || state.sourceRevision !== currentNexusLoreSourceRevision(state.sourceBooks || [])) {
        clearBootstrapAdmission({ force:true });
        return false;
    }
    const livePolicy = bootstrapPolicySnapshot(getSettings(), getContext());
    if (!bootstrapPolicyEnabled(livePolicy) || !state.policyKey || state.policyKey !== bootstrapPolicyKey(livePolicy)) {
        clearBootstrapAdmission({ force:true });
        return false;
    }
    const legal = getActiveBooks({ requireTree:false, access:'read', injection:'tv2' }).includes(name);
    return legal && !getTree(name)?.root;
}
export function hasBootstrapAdmissionForBook(book, { generationId = null } = {}) {
    const name = String(book || '').trim();
    return bootstrapAdmissionIsCurrent(name,generationId) && state.refs.some(ref => ref.book === name);
}
export function hasBootstrapAdmissionForEntry(book, uid, { generationId = null } = {}) {
    const name = String(book || '').trim();
    const numericUid = Number(uid);
    if (!Number.isFinite(numericUid) || !bootstrapAdmissionIsCurrent(name,generationId)) return false;
    return state.refs.some(ref => ref.book === name && Number(ref.uid) === numericUid);
}
export function clearBootstrapAdmission({ generationId = null, force = false } = {}) {
    if (!force && generationId != null && state.generationId != null && String(generationId) !== String(state.generationId)) return false;
    const targetGeneration=generationId??state.generationId;
    if(targetGeneration!=null)clearBootstrapLoreOutlet({generationId:targetGeneration,status:NEXUS_GENERATION_OUTLET_STATUS.EMPTY,reason:'bootstrap-cleared'});
    state.generationId=null;state.text='';state.refs=[];state.books=[];state.retainedBooks=[];state.estimatedInjectionTokens=0;state.estimatedNativeTokens=0;state.estimatedManagedCorpusTokens=0;state.selectedCount=0;state.candidateCount=0;state.preparedAt=0;state.policyKey='';state.mainModel='';state.sourceRevision='';state.sourceBooks=[];
    return true;
}
