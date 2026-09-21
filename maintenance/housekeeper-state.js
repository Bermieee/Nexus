import { getContext } from '../../../../st-context.js';

const META_KEY = 'tv2_housekeeper_diagnostics';
const LEGACY_META_KEY = 'tv2_housekeeper_review';
const STATE_VERSION = 2;
const MAX_HISTORY = 8;
const MAX_FINDINGS_PER_RUN = 120;
const MAX_LATEST_FINDINGS = 480;
let volatileState = null;

function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }
function now() { return Date.now(); }
function notify() { try { globalThis.window?.dispatchEvent?.(new CustomEvent('tv2-housekeeper-updated')); } catch {} }
function freshState() { return { version: STATE_VERSION, history: [], latestFindings: {}, lastAttemptAt: 0, lastSuccessfulRunAt: 0, updatedAt: 0 }; }
function boundedFindingMap(value) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    return Object.fromEntries(Object.entries(source).sort((a, b) => Number(b[1]?.detectedAt || 0) - Number(a[1]?.detectedAt || 0)).slice(0, MAX_LATEST_FINDINGS));
}
function normalizeState(raw) {
    const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : freshState();
    const state = {
        version: STATE_VERSION,
        history: Array.isArray(source.history) ? source.history.slice(-MAX_HISTORY) : [],
        latestFindings: boundedFindingMap(source.latestFindings),
        lastAttemptAt: Math.max(0, Number(source.lastAttemptAt) || 0),
        lastSuccessfulRunAt: Math.max(0, Number(source.lastSuccessfulRunAt) || 0),
        updatedAt: Math.max(0, Number(source.updatedAt) || 0),
    };
    // CP001 briefly persisted a Housekeeper-specific reviewQueue. That queue was
    // supervisory UI state, not canonical review authority, so v2 deliberately
    // does not carry it forward as actionable state.
    return state;
}
function stateRef() {
    const ctx = getContext();
    if (!ctx?.chatMetadata) {
        if (!volatileState) volatileState = freshState();
        volatileState = normalizeState(volatileState);
        return volatileState;
    }
    const raw = ctx.chatMetadata[META_KEY] ?? ctx.chatMetadata[LEGACY_META_KEY];
    const normalized = normalizeState(raw);
    ctx.chatMetadata[META_KEY] = normalized;
    if (Object.prototype.hasOwnProperty.call(ctx.chatMetadata, LEGACY_META_KEY)) delete ctx.chatMetadata[LEGACY_META_KEY];
    return normalized;
}
function save(state) {
    state.updatedAt = now();
    const ctx = getContext();
    if (ctx?.chatMetadata) {
        ctx.chatMetadata[META_KEY] = state;
        try { ctx.saveMetadataDebounced?.(); } catch {}
    } else volatileState = state;
    notify();
    return state;
}
function findingSnapshot(finding = {}) {
    return clone({
        id: String(finding.id || ''),
        category: String(finding.category || 'REVIEW'),
        title: String(finding.title || finding.id || 'Finding'),
        book: finding.book == null ? null : String(finding.book),
        sourceFingerprint: String(finding.sourceFingerprint || ''),
        currentSourceFingerprint: finding.currentSourceFingerprint == null ? null : String(finding.currentSourceFingerprint),
        freshness: String(finding.freshness || 'CURRENT'),
        provenance: finding.provenance || null,
        deterministicEvidence: finding.deterministicEvidence || null,
        decisionShadow: finding.decisionShadow || null,
        detectedAt: Number(finding.detectedAt) || now(),
    });
}
function historyFindingSnapshot(finding = {}) {
    const row = findingSnapshot(finding);
    if (row.decisionShadow?.answers) row.decisionShadow.answers = clone(row.decisionShadow.answers);
    return row;
}

/**
 * Bounded developer-diagnostic state only. This is not cadence authority and
 * contains no Housekeeper-specific operator review queue.
 */
export function getHousekeeperDiagnosticState() { return clone(normalizeState(stateRef())); }
export function getHousekeeperRunHistory() { return getHousekeeperDiagnosticState().history; }

export function recordHousekeeperRun(report = {}) {
    const state = stateRef();
    const prior = state.latestFindings || {};
    const currentRows = (Array.isArray(report.findings) ? report.findings : []).slice(0, MAX_FINDINGS_PER_RUN).map(findingSnapshot);
    const current = Object.fromEntries(currentRows.filter(row => row.id).map(row => [row.id, row]));
    const priorIds = new Set(Object.keys(prior));
    const currentIds = new Set(Object.keys(current));
    const added = [...currentIds].filter(id => !priorIds.has(id));
    const changed = [...currentIds].filter(id => prior[id] && String(prior[id].sourceFingerprint || '') !== String(current[id].sourceFingerprint || ''));

    // A Housekeeper pass normally scans only a rotating subset of Lore books.
    // Absence from an unscanned book is not evidence of resolution. Replace
    // findings observed in this pass, and resolve only prior findings whose
    // source scope was actually and completely rescanned.
    const reportBooks = Array.isArray(report.books) ? report.books : null;
    const scannedBooks = new Set((reportBooks || []).filter(row => row && !row.error && !row.mergeError).map(row => String(row.book || '')).filter(Boolean));
    const scopeKnown = reportBooks !== null;
    const resolutionSafe = report.deferred !== true && report.skipped !== true && report.stale !== true && report.incomplete !== true;
    const next = { ...prior, ...current };
    const resolved = [];
    if (resolutionSafe) for (const id of priorIds) {
        if (currentIds.has(id)) continue;
        const row = prior[id] || {};
        const scope = String(row.provenance?.scope || '');
        const wasRescanned = !scopeKnown || scope === 'memory' || (row.book != null && scannedBooks.has(String(row.book)));
        if (!wasRescanned) continue;
        delete next[id];
        resolved.push(id);
    }
    const bounded = Object.fromEntries(Object.entries(next).sort((a, b) => {
        const aCurrent = currentIds.has(a[0]) ? 1 : 0, bCurrent = currentIds.has(b[0]) ? 1 : 0;
        return bCurrent - aCurrent || Number(b[1]?.detectedAt || 0) - Number(a[1]?.detectedAt || 0);
    }).slice(0, MAX_LATEST_FINDINGS));
    const evicted = Object.keys(next).filter(id => !Object.prototype.hasOwnProperty.call(bounded, id));

    state.latestFindings = bounded;
    state.lastAttemptAt = Number(report.finishedAt) || now();
    if (report.successful === true) state.lastSuccessfulRunAt = state.lastAttemptAt;
    state.history.push({
        id: String(report.runId || `hk-run-${state.lastAttemptAt}`),
        startedAt: Number(report.startedAt) || state.lastAttemptAt,
        finishedAt: state.lastAttemptAt,
        status: String(report.status || (report.successful ? 'COMPLETE' : report.deferred ? 'DEFERRED' : report.skipped ? 'SKIPPED' : 'FAILED')),
        successful: report.successful === true,
        findingCount: Number(report.findingCount) || currentRows.length,
        adviceCount: Array.isArray(report.advice) ? report.advice.length : 0,
        adviceFreshness: report.adviceFreshness || null,
        books: (Array.isArray(report.books) ? report.books : []).map(row => String(row?.book || '')).filter(Boolean),
        changes: { added, resolved, changed, evicted },
        findings: currentRows.map(historyFindingSnapshot),
        reason: report.reason || report.adviceError || null,
    });
    state.history = state.history.slice(-MAX_HISTORY);
    save(state);
    return clone(state);
}

export function recordHousekeeperFindingFreshness({ findingId, freshness, currentSourceFingerprint = null } = {}) {
    const state = stateRef();
    const id = String(findingId || '');
    const live = state.latestFindings?.[id];
    if (!live) return { recorded: false, reason: 'finding-not-current' };
    live.freshness = String(freshness || 'STALE');
    live.currentSourceFingerprint = currentSourceFingerprint == null ? null : String(currentSourceFingerprint);
    state.latestFindings[id] = live;
    save(state);
    return { recorded: true, freshness: live.freshness };
}

export function recordHousekeeperDecisionShadow({ findingId, sourceFingerprint, siteId, result } = {}) {
    const state = stateRef();
    const id = String(findingId || '');
    const live = state.latestFindings?.[id];
    if (!live) return { recorded: false, reason: 'finding-not-current' };
    const fingerprintMatches = String(live.sourceFingerprint || '') === String(sourceFingerprint || result?.sourceFingerprint || '');
    const freshness = result?.stale === true || !fingerprintMatches ? 'STALE' : 'CURRENT';
    const shadow = {
        siteId: String(siteId || result?.decisionSiteId || result?.contractId || ''),
        freshness,
        sourceFingerprint: String(result?.sourceFingerprint || sourceFingerprint || ''),
        provider: result?.provider || null,
        providerClass: result?.providerClass || null,
        providerModel: result?.providerModel || null,
        latencyMs: Number(result?.latencyMs) || 0,
        answers: result?.answers || null,
        error: result?.error || null,
        observedAt: now(),
    };
    live.decisionShadow = clone(shadow);
    state.latestFindings[id] = live;
    save(state);
    return { recorded: true, freshness };
}


export function flushHousekeeperDiagnostics({scope='all'}={}) {
    const state = stateRef();
    const normalized = String(scope || 'all').toLowerCase();
    if (normalized === 'findings') {
        state.latestFindings = {};
        state.updatedAt = now();
        save(state);
        return { flushed: true, scope: 'findings', historyCount: state.history.length };
    }
    state.history = [];
    state.latestFindings = {};
    state.lastAttemptAt = 0;
    state.lastSuccessfulRunAt = 0;
    state.updatedAt = now();
    save(state);
    return { flushed: true, scope: 'all' };
}

export const HOUSEKEEPER_DIAGNOSTIC_STATE_LIMITS = Object.freeze({ history: MAX_HISTORY, findingsPerRun: MAX_FINDINGS_PER_RUN, latestFindings: MAX_LATEST_FINDINGS });
