const MAX_HISTORY = 24;
const MAX_CANDIDATES = 80;
const stateByChat = new Map();

function clone(value) {
    if (value == null) return value;
    try { return structuredClone(value); } catch {}
    try { return JSON.parse(JSON.stringify(value)); } catch { return value; }
}
function key(chatId) { return chatId == null ? 'none' : String(chatId); }
function row(chatId) {
    const id = key(chatId);
    let state = stateByChat.get(id);
    if (!state) {
        state = { chatId: chatId ?? null, candidates: [], candidateSourceFingerprint: null, gateSourceFingerprint: null, gateShadow: null, publication: null, history: [], updatedAt: 0 };
        stateByChat.set(id, state);
    }
    return state;
}
function pushHistory(state, event) {
    state.history.push({ at: Date.now(), ...clone(event) });
    if (state.history.length > MAX_HISTORY) state.history.splice(0, state.history.length - MAX_HISTORY);
}

export function recordRetrievalCandidateDiagnostics({ chatId = null, candidates = [], sceneRevision = null, gateMode = null, sourceFingerprint = null } = {}) {
    const state = row(chatId);
    state.candidates = (Array.isArray(candidates) ? candidates : []).slice(0, MAX_CANDIDATES).map(candidate => clone(candidate));
    state.candidateSourceFingerprint = sourceFingerprint || null;
    state.updatedAt = Date.now();
    pushHistory(state, { type: 'candidate-baseline', sceneRevision, gateMode, sourceFingerprint, count: state.candidates.length });
    return getRetrievalDiagnosticsSnapshot({ chatId });
}

export function recordRetrievalCandidateShadow({ chatId = null, sourceFingerprint = null, rows = [], status = 'complete', error = null } = {}) {
    const state = row(chatId);
    if (state.candidateSourceFingerprint && sourceFingerprint && String(state.candidateSourceFingerprint) !== String(sourceFingerprint)) {
        pushHistory(state, { type: 'candidate-shadow-discarded', sourceFingerprint, status, reason: 'newer-candidate-baseline-active' });
        return getRetrievalDiagnosticsSnapshot({ chatId });
    }
    const shadowByKey = new Map((Array.isArray(rows) ? rows : []).map(item => [`${item.book}\u0000${Number(item.uid)}`, item]));
    state.candidates = state.candidates.map(candidate => {
        const shadow = shadowByKey.get(`${candidate.book}\u0000${Number(candidate.uid)}`);
        return shadow ? { ...candidate, shadow: clone(shadow) } : candidate;
    });
    state.updatedAt = Date.now();
    pushHistory(state, { type: 'candidate-shadow', sourceFingerprint, status, count: rows?.length || 0, error: error ? String(error) : null });
    return getRetrievalDiagnosticsSnapshot({ chatId });
}

export function recordChangeGateShadowDiagnostics({ chatId = null, current = null, shadow = null, agreement = null, sourceFingerprint = null, status = 'complete', error = null } = {}) {
    const state = row(chatId);
    if (status !== 'pending' && state.gateSourceFingerprint && sourceFingerprint && String(state.gateSourceFingerprint) !== String(sourceFingerprint)) {
        pushHistory(state, { type: 'change-gate-shadow-discarded', sourceFingerprint, status, reason: 'newer-gate-baseline-active' });
        return getRetrievalDiagnosticsSnapshot({ chatId });
    }
    state.gateSourceFingerprint = sourceFingerprint || state.gateSourceFingerprint || null;
    state.gateShadow = { current, shadow: clone(shadow), agreement, sourceFingerprint, status, error: error ? String(error) : null, updatedAt: Date.now() };
    state.updatedAt = Date.now();
    pushHistory(state, { type: 'change-gate-shadow', current, shadow: shadow?.classification || null, agreement, sourceFingerprint, status });
    return getRetrievalDiagnosticsSnapshot({ chatId });
}

export function recordRetrievalPublicationDiagnostics({ chatId = null, sceneRevision = null, gateMode = null, selectedRefs = [], publishedRefs = [], estimatedInjectionTokens = 0, budgetTokens = null, degraded = false, publicationAuthority = 'generation-frame' } = {}) {
    const state = row(chatId);
    const published = new Set((publishedRefs || []).map(ref => `${ref.book}\u0000${Number(ref.uid)}`));
    const selected = new Set((selectedRefs || []).map(ref => `${ref.book}\u0000${Number(ref.uid)}`));
    state.candidates = state.candidates.map(candidate => {
        const candidateId = `${candidate.book}\u0000${Number(candidate.uid)}`;
        return { ...candidate, selected: selected.has(candidateId), published: published.has(candidateId) };
    });
    state.publication = {
        sceneRevision, gateMode,
        selectedCount: selected.size,
        publishedCount: published.size,
        selectedRefs: clone(selectedRefs || []),
        publishedRefs: clone(publishedRefs || []),
        estimatedInjectionTokens: Math.max(0, Number(estimatedInjectionTokens) || 0),
        budgetTokens: budgetTokens == null ? null : Math.max(0, Number(budgetTokens) || 0),
        degraded: degraded === true,
        publicationAuthority,
        updatedAt: Date.now(),
    };
    state.updatedAt = Date.now();
    pushHistory(state, { type: 'publication', ...state.publication });
    return getRetrievalDiagnosticsSnapshot({ chatId });
}

export function getRetrievalDiagnosticsSnapshot({ chatId = null } = {}) {
    if (chatId != null) return clone(stateByChat.get(key(chatId)) || { chatId, candidates: [], candidateSourceFingerprint: null, gateSourceFingerprint: null, gateShadow: null, publication: null, history: [], updatedAt: 0 });
    const latest = [...stateByChat.values()].sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0))[0];
    return clone(latest || { chatId: null, candidates: [], candidateSourceFingerprint: null, gateSourceFingerprint: null, gateShadow: null, publication: null, history: [], updatedAt: 0 });
}

export function clearRetrievalDiagnostics({ chatId = null } = {}) {
    if (chatId == null) stateByChat.clear();
    else stateByChat.delete(key(chatId));
}
