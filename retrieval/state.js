import { currentNexusLoreSourceRevision } from '../nexus/lore-source-revision.js';

const state = {
    lastInjectedText: '',
    lastInjectedRefs: [],
    lastNodeRefs: [],
    lastRegionRefs: [],
    // Compatibility mirrors used by diagnostics and older callers.
    lastNodeIds: [],
    lastRegionIds: [],
    lastGate: null,
    lastGateChatLength: 0,
    noChangeStreak: 0,
    lastSuccessfulAt: 0,
    lastInjectionBudgetTokens: null,
    lastInjectionModel: '',
    lastInjectionProvider: '',
    lastLoreOrderPolicy: 'canonical',
    pendingWarmRefresh: null,
    lastReviewedWarmSignature: '',
    lastSourceRevision: '',
    lastBooks: [],
};

function cleanTreeRef(ref) {
    if (!ref) return null;
    const book = String(ref.book || '').trim();
    const nodeId = String(ref.nodeId || ref.node_id || ref.id || '').trim();
    if (!book || !nodeId) return null;
    return { book, nodeId };
}

function dedupeTreeRefs(refs = []) {
    const seen = new Set();
    const out = [];
    for (const raw of refs || []) {
        const ref = cleanTreeRef(raw);
        if (!ref) continue;
        const key = JSON.stringify([ref.book,ref.nodeId]);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(ref);
    }
    return out;
}


function cleanEntryRef(ref) {
    if (!ref) return null;
    const book = String(ref.book || '').trim();
    const uid = Number(ref.uid);
    if (!book || !Number.isFinite(uid)) return null;
    return { book, uid };
}

function dedupeEntryRefsLocal(refs = []) {
    const seen = new Set();
    const out = [];
    for (const raw of refs || []) {
        const ref = cleanEntryRef(raw);
        if (!ref) continue;
        const key = JSON.stringify([ref.book,ref.uid]);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(ref);
    }
    return out;
}

export function requestWarmContextRefresh({ signature = '', desiredRefs = [], missingRefs = [], reason = 'smart-context relevance drift', chatLength = 0 } = {}) {
    const normalizedSignature = String(signature || '').trim();
    if (!normalizedSignature) return { requested: false, reason: 'missing-signature' };
    if (normalizedSignature === state.lastReviewedWarmSignature) {
        const current = new Set((state.lastInjectedRefs || []).map(ref => JSON.stringify([ref.book, Number(ref.uid)])));
        const missing = dedupeEntryRefsLocal(missingRefs);
        if (!missing.length || missing.every(ref => current.has(JSON.stringify([ref.book, Number(ref.uid)])))) {
            return { requested: false, reason: 'already-reviewed-and-satisfied' };
        }
    }
    if (state.pendingWarmRefresh?.signature === normalizedSignature) return { requested: false, reason: 'already-pending' };
    state.pendingWarmRefresh = {
        signature: normalizedSignature,
        desiredRefs: dedupeEntryRefsLocal(desiredRefs),
        missingRefs: dedupeEntryRefsLocal(missingRefs),
        reason: String(reason || 'smart-context relevance drift'),
        requestedAt: Date.now(),
        chatLength: Math.max(0, Number(chatLength) || 0),
    };
    return { requested: true, pending: { ...state.pendingWarmRefresh, desiredRefs: state.pendingWarmRefresh.desiredRefs.map(r => ({ ...r })), missingRefs: state.pendingWarmRefresh.missingRefs.map(r => ({ ...r })) } };
}

export function getPendingWarmContextRefresh() {
    const pending = state.pendingWarmRefresh;
    if (!pending) return null;
    return { ...pending, desiredRefs: pending.desiredRefs.map(r => ({ ...r })), missingRefs: pending.missingRefs.map(r => ({ ...r })) };
}

export function acknowledgeWarmContextRefresh(reason = 'retrieval-reviewed', { satisfiedRefs = [], force = false } = {}) {
    const pending = state.pendingWarmRefresh;
    if (!pending) return null;
    if (!force && pending.missingRefs?.length) {
        const satisfied = new Set(dedupeEntryRefsLocal(satisfiedRefs).map(ref => JSON.stringify([ref.book, ref.uid])));
        if (!pending.missingRefs.every(ref => satisfied.has(JSON.stringify([ref.book, ref.uid])))) return null;
    }
    state.lastReviewedWarmSignature = String(pending.signature || '');
    state.pendingWarmRefresh = null;
    return { ...pending, acknowledgedReason: String(reason || 'retrieval-reviewed') };
}

export function getRetrievalState() { return state; }
export function hasReusableInjection({ books = null } = {}) {
    if (!state.lastInjectedText || state.lastInjectedRefs.length === 0) return false;
    const sourceBooks = Array.isArray(state.lastBooks) ? state.lastBooks : [];
    if (!state.lastSourceRevision || state.lastSourceRevision !== currentNexusLoreSourceRevision(sourceBooks)) return false;
    if (books == null) return true;
    const required = [...new Set((Array.isArray(books) ? books : [books]).map(value => String(value || '').trim()).filter(Boolean))];
    if (!required.length) return true;
    const covered = new Set(state.lastInjectedRefs.map(ref => String(ref.book || '')));
    return required.every(book => sourceBooks.includes(book) && covered.has(book));
}

export function rememberSuccessfulRetrieval({ text = '', refs = [], nodeRefs = [], regionRefs = [], nodeIds = [], regionIds = [], gate = null, budgetTokens = null, model = '', provider = '', loreOrderPolicy = 'canonical', books = [] } = {}) {
    state.lastInjectedText = String(text || '');
    state.lastInjectedRefs = Array.isArray(refs) ? refs.map(r => ({ ...r })) : [];

    // Prefer book-scoped refs. Legacy ID-only arrays are preserved as mirrors only;
    // cross-lorebook routing should never depend on a naked node ID.
    state.lastNodeRefs = dedupeTreeRefs(nodeRefs);
    state.lastRegionRefs = dedupeTreeRefs(regionRefs);
    state.lastNodeIds = state.lastNodeRefs.length
        ? [...new Set(state.lastNodeRefs.map(r => r.nodeId))]
        : [...new Set((nodeIds || []).map(String))];
    state.lastRegionIds = state.lastRegionRefs.length
        ? [...new Set(state.lastRegionRefs.map(r => r.nodeId))]
        : [...new Set((regionIds || []).map(String))];
    state.lastGate = gate ? { ...gate } : null;
    state.lastSuccessfulAt = Date.now();
    state.lastInjectionBudgetTokens = Number.isFinite(Number(budgetTokens)) ? Math.max(0, Number(budgetTokens)) : null;
    state.lastInjectionModel = String(model || '');
    state.lastInjectionProvider = String(provider || '');
    state.lastLoreOrderPolicy = String(loreOrderPolicy || 'canonical');
    state.lastBooks = [...new Set((books || []).map(value => String(value || '').trim()).filter(Boolean))].sort();
    state.lastSourceRevision = currentNexusLoreSourceRevision(state.lastBooks);
    acknowledgeWarmContextRefresh('successful-retrieval',{satisfiedRefs:state.lastInjectedRefs});
}

export function clearRetrievalState() {
    state.lastInjectedText = '';
    state.lastInjectedRefs = [];
    state.lastNodeRefs = [];
    state.lastRegionRefs = [];
    state.lastNodeIds = [];
    state.lastRegionIds = [];
    state.lastGate = null;
    state.lastGateChatLength = 0;
    state.noChangeStreak = 0;
    state.lastSuccessfulAt = 0;
    state.lastInjectionBudgetTokens = null;
    state.lastInjectionModel = '';
    state.lastInjectionProvider = '';
    state.lastLoreOrderPolicy = 'canonical';
    state.pendingWarmRefresh = null;
    state.lastReviewedWarmSignature = '';
    state.lastSourceRevision = '';
    state.lastBooks = [];
}

export { cleanTreeRef, dedupeTreeRefs };
