/**
 * Durable Operator Review scope is an explicit typed identity, separate from the
 * transient work-scope epoch. Chat-bound authority and lorebook-maintenance
 * authority intentionally use different namespaces.
 */
let scopeProvider = () => ({ chatId: null, story: { mode: 'unbound', readBooks: [], writeBooks: [] } });

function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }
function stable(value) {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
    return value;
}
function normalizedBooks(value) { return [...new Set((Array.isArray(value) ? value : []).map(v => String(v || '').trim()).filter(Boolean))].sort(); }

export function normalizeOperatorReviewScope(raw = {}) {
    const kind = String(raw?.kind || raw?.scopeKind || '').toLowerCase() === 'lorebook' ? 'lorebook' : 'chat';
    const chatId = raw?.chatId == null ? null : String(raw.chatId).trim() || null;
    const storyRaw = raw?.story && typeof raw.story === 'object' ? raw.story : raw?.storyScope && typeof raw.storyScope === 'object' ? raw.storyScope : {};
    const storyIdCandidate = raw?.storyId ?? storyRaw?.storyId ?? storyRaw?.id ?? null;
    const storyId = storyIdCandidate == null ? null : String(storyIdCandidate).trim() || null;
    const story = {
        mode: String(storyRaw.mode || 'unknown'),
        readBooks: normalizedBooks(storyRaw.readBooks),
        writeBooks: normalizedBooks(storyRaw.writeBooks),
    };
    const book = raw?.book == null ? null : String(raw.book).trim() || null;
    const treeIdentity = raw?.treeIdentity == null ? null : String(raw.treeIdentity).trim() || null;
    // Preserve the historical chat identity byte-for-byte. Lore maintenance is
    // namespaced separately so it survives chat switches and can exist with no
    // active chat without weakening chat-bound mutation authority.
    const identity = kind === 'lorebook'
        ? JSON.stringify(stable({ version: 3, kind: 'lorebook', book, treeIdentity }))
        : JSON.stringify(stable({ version: 2, chatId, storyId }));
    return Object.freeze({ version: kind === 'lorebook' ? 3 : 2, kind, chatId: kind === 'lorebook' ? null : chatId, storyId: kind === 'lorebook' ? null : storyId, story: Object.freeze(story), book, treeIdentity, identity });
}

export function lorebookOperatorReviewScope(book, { treeIdentity = null } = {}) {
    return normalizeOperatorReviewScope({ kind: 'lorebook', book: String(book || '').trim(), treeIdentity });
}

export function configureOperatorReviewScopeProvider(provider) {
    scopeProvider = typeof provider === 'function' ? provider : scopeProvider;
}

export function currentOperatorReviewScope() {
    return normalizeOperatorReviewScope(scopeProvider?.() || {});
}

export function sameOperatorReviewScope(a, b) {
    return normalizeOperatorReviewScope(a).identity === normalizeOperatorReviewScope(b).identity;
}

export function assertOperatorReviewScope(raw, { requireChat = true } = {}) {
    const scope = normalizeOperatorReviewScope(raw);
    if (scope.kind === 'lorebook') {
        if (!scope.book) {
            const error = new Error('Nexus lorebook Operator Review requires a stable lorebook identity.');
            error.name = 'TV2OperatorReviewScopeUnavailable';
            throw error;
        }
        return scope;
    }
    if (requireChat && !scope.chatId) {
        const error = new Error('Nexus Operator Review requires an active durable chat identity.');
        error.name = 'TV2OperatorReviewScopeUnavailable';
        throw error;
    }
    return scope;
}

export function operatorReviewScopeProjection(scope = currentOperatorReviewScope(), generation = 0) {
    const normalized = normalizeOperatorReviewScope(scope);
    return clone({ version: normalized.version, kind: normalized.kind, chatId: normalized.chatId, storyId: normalized.storyId, story: normalized.story, book: normalized.book, treeIdentity: normalized.treeIdentity, identity: normalized.identity, generation: Math.max(0, Number(generation) || 0) });
}
