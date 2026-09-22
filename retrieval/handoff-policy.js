export function candidateKey(book, uid) {
    return JSON.stringify([String(book),Number(uid)]);
}

export function isRejectedGenerationMarker(message) {
    if (message?.is_user) return false;
    const text = String(message?.mes || '').trim();
    return /^the request was rejected because it was considered high risk[.!]?$/i.test(text);
}

export function isNarrativeSceneMessage(message) {
    if (message?.is_system) return false;
    const text = String(message?.mes || '').trim();
    if (!text) return false;
    return !isRejectedGenerationMarker(message);
}

export function tailNarrativeSceneMessages(chat = [], maxMessages = 8) {
    const rows = Array.isArray(chat) ? chat : [];
    const rawLimit = Math.max(1, Number(maxMessages) || 8);
    const limit = Number.isFinite(rawLimit) ? Math.trunc(rawLimit) : rawLimit;
    const out = [];
    for (let index = rows.length - 1; index >= 0 && out.length < limit; index -= 1) {
        const message = rows[index];
        if (isNarrativeSceneMessage(message)) out.push(message);
    }
    out.reverse();
    return out;
}

export function resolveActiveParticipantSet(catalog = [], parsed = {}) {
    const active = new Set((Array.isArray(parsed?.activeCharacters) ? parsed.activeCharacters : [])
        .map(value => String(value || '').trim().toLowerCase())
        .filter(Boolean));
    const activeCatalog = (catalog || []).filter(item => active.has(String(item?.name || '').trim().toLowerCase()));
    const sidecarCloseDyad = parsed?.closeDyad === true;
    const effectiveCloseDyad = sidecarCloseDyad && activeCatalog.length === 2;
    return { activeCatalog, effectiveCloseDyad, sidecarCloseDyad };
}

export function normalizeExactCandidateEntryRefs(value, candidates = []) {
    const allowedKeys = new Set((candidates || []).map(row => candidateKey(row?.book, row?.uid)));
    const exactBooks = new Map();
    for (const row of candidates || []) {
        const book = String(row?.book || '').trim();
        if (book) exactBooks.set(book.toLowerCase(), book);
    }
    if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.entries)) return value;
    const entries = value.entries.map(ref => {
        if (typeof ref !== 'string') return ref;
        const match = ref.trim().match(/^\[?(.+?)\s*\|\s*UID\s+(\d+)(?:\s*\|.*)?\]?$/i);
        if (!match) return ref;
        const book = exactBooks.get(String(match[1] || '').trim().toLowerCase());
        const uid = Number(match[2]);
        if (!book || !Number.isInteger(uid) || !allowedKeys.has(candidateKey(book, uid))) return ref;
        return { book, uid };
    });
    return { ...value, entries };
}


export function buildOpaqueInjectionRefCatalog(candidates = []) {
    return (candidates || []).map((candidate, index) => ({
        refId: `R${index + 1}`,
        candidate,
    }));
}

export function validateOpaqueInjectionSelection(value, candidates = []) {
    const catalog = buildOpaqueInjectionRefCatalog(candidates);
    const allowed = new Set(catalog.map(row => row.refId));
    const errors = [];
    let score = 0;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return { valid: false, score, reason: 'Lore selection payload must be a top-level object.' };
    }
    if (!Array.isArray(value.refs)) {
        errors.push('Lore selection payload requires refs array.');
    } else {
        score += 10;
        const seen = new Set();
        for (const raw of value.refs) {
            const refId = String(raw || '').trim();
            if (!refId || !allowed.has(refId)) errors.push(`refs contains unknown selection id ${refId || '(empty)'}`);
            else if (seen.has(refId)) errors.push(`refs duplicates selection id ${refId}`);
            else { seen.add(refId); score += 2; }
        }
    }
    if (typeof value.reasoning !== 'string' || !String(value.reasoning).trim()) errors.push('reasoning must be non-empty text');
    else score += 10;
    return { valid: errors.length === 0, score, reason: errors.join('; ') || null, value };
}

export function resolveOpaqueInjectionRefs(candidates = [], refIds = []) {
    const catalog = new Map(buildOpaqueInjectionRefCatalog(candidates).map(row => [row.refId, row.candidate]));
    const selected = [];
    const seen = new Set();
    for (const raw of refIds || []) {
        const refId = String(raw || '').trim();
        const candidate = catalog.get(refId);
        if (!candidate) continue;
        const key = candidateKey(candidate?.book, candidate?.uid);
        if (seen.has(key)) continue;
        seen.add(key);
        selected.push(candidate);
    }
    return selected;
}

export function treeCoreCandidates(candidates = []) {
    return (candidates || []).filter(candidate => candidate?.sceneAnchor !== true);
}

export function selectRequestedCandidates(candidates = [], requested = []) {
    const allowed = new Map((candidates || []).map(candidate => [candidateKey(candidate?.book, candidate?.uid), candidate]));
    const selected = [];
    const seen = new Set();
    for (const ref of requested || []) {
        const key = candidateKey(ref?.book || '', ref?.uid);
        const candidate = allowed.get(key);
        if (!candidate || seen.has(key)) continue;
        seen.add(key);
        selected.push(candidate);
    }
    return selected;
}

export function mergeInjectionSliceSelections({ batches = [], successfulSelections = [], failures = [] } = {}) {
    const selectedMap = new Map();
    const successful = [];
    for (const completed of successfulSelections || []) {
        const index = Number.isInteger(completed?.index) ? completed.index : Number(completed?.batchIndex);
        const batch = batches[index] || completed?.batch;
        if (!batch) continue;
        const selected = selectRequestedCandidates(batch.candidates || [], completed?.requested || completed?.selected || []);
        for (const candidate of selected) {
            const key = candidateKey(candidate.book, candidate.uid);
            if (!selectedMap.has(key)) successful.push({ batchIndex: index, candidate });
            selectedMap.set(key, candidate);
        }
    }
    // Failed slices have no model authority. The batch layer gets the bounded
    // recovery opportunity; if a slice still fails afterward, successful sibling
    // selections remain retained but replacement coverage is explicitly incomplete.
    const failedSlices = [];
    for (const failure of failures || []) {
        const index = Number.isInteger(failure?.index) ? failure.index : Number(failure?.batchIndex);
        const batch = batches[index] || failure?.batch;
        const sliceCandidates = batch?.candidates || [];
        if (!sliceCandidates.length) continue;
        failedSlices.push({
            batchIndex:index,
            candidateCount:sliceCandidates.length,
            candidateRefs:sliceCandidates.map(candidate=>({book:candidate?.book,uid:candidate?.uid})),
        });
    }
    return {
        selected:[...selectedMap.values()],
        successful,
        fallback:[],
        recoverableTreeCore:[],
        unrecoverableFailures:failedSlices,
        coverageIncomplete:failedSlices.length>0,
    };
}

export function validateAuthoritativeSelection(candidates = [], selected = []) {
    const allowed = new Map((candidates || []).map(candidate => [candidateKey(candidate?.book, candidate?.uid), candidate]));
    const normalized = [];
    const seen = new Set();
    const invalid = [];
    for (const ref of selected || []) {
        const key = candidateKey(ref?.book || '', ref?.uid);
        const candidate = allowed.get(key);
        if (!candidate) {
            invalid.push({ book: String(ref?.book || ''), uid: Number(ref?.uid) });
            continue;
        }
        if (seen.has(key)) continue;
        seen.add(key);
        normalized.push(candidate);
    }
    return { valid: invalid.length === 0, selected: normalized, invalid };
}


export function shouldCondenseInjectionGather({ degraded = false, selectedCount = 0, minCandidates = 0 } = {}) {
    return degraded !== true && Number(selectedCount) >= Math.max(0, Number(minCandidates) || 0);
}

export function missingRequiredCandidates(included = [], required = []) {
    const includedKeys = new Set((included || []).map(row => candidateKey(row?.book, row?.uid)));
    return (required || []).filter(row => !includedKeys.has(candidateKey(row?.book, row?.uid)));
}

export function emptyReplacementDisposition({ gateMode = '', hasReusable = false } = {}) {
    if (String(gateMode) === 'MINOR_CHANGE' && hasReusable === true) return 'reuse-previous';
    return 'no-valid-replacement';
}
