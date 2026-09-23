import { getContext } from '../../../../st-context.js';
import { getSettings } from '../core/settings.js';
import { getActiveBooks, isBookInCurrentStory } from '../lore/active-books.js';
import { searchTree, searchTreeMany, dedupeEntryRefs } from '../retrieval/search-engine.js';
import { BUS_STAGE, BUS_PRIORITY } from '../sidecar/bus.js';
import { enqueueNexusModelWorkerJob } from '../nexus/model-worker-bus.js';
import { structuredSidecarOptions } from '../nexus/batch-layer.js';
import { parseStructuredJsonCandidate } from '../sidecar/normalize-response.js';
import { logEvent } from '../observability/telemetry.js';
import { getCharacterWarmRefs } from '../memory/character-banks.js';
import { scanSceneForWarmBudget, parseSidecarWarmBudget } from './scene-scanner.js';
import { getSceneScannerSnapshot, sceneReferenceTerms } from '../scene/scanner.js';
import { ensureSceneAuthority } from '../scene/runtime.js';
import { getCurrentSceneChangeGate } from '../retrieval/change-gate.js';
import { getRetrievalState, requestWarmContextRefresh } from '../retrieval/state.js';
import { resolveCurrentTreeRef } from '../tree/ref-resolver.js';
import { isIntentionalCancellation } from '../core/cancellation.js';
import { currentNexusLoreSourceRevision } from '../nexus/lore-source-revision.js';
import { sceneHydrationMessages } from '../lifecycle/scene-hydration-policy.js';
import { isNarrativeSceneMessage, tailNarrativeSceneMessages } from '../retrieval/handoff-policy.js';
import { SMART_CONTEXT_WARM_REVIEW_SITE_ID, SMART_CONTEXT_DECISION_MAX_CANDIDATES, interpretSmartContextWarmReviewDecision, smartContextWarmReviewFingerprint } from './decision-site.js';
import { startDecisionSiteThroughDirector } from '../decision/work-director-bridge.js';
import { decisionAssistEnabled, decisionShadowEnabled } from '../decision/mode.js';

const META_KEY = 'tv2_smart_context';
let warmCache = null;
let warmCacheKey = '';
let warmCachePolicyKey = '';
let warmCachedAt = 0;
let lastWarmStats = null;
let warmRequestRevision = 0;
const MAX_WARM_AUTHORITY_RETRIES = 1;
const SMART_WARM_FALLBACK_DEADLINE_MS = 30000;
function armSmartWarmFallbackDeadline(job, deadlineMs = SMART_WARM_FALLBACK_DEADLINE_MS) {
    const ms = Math.max(1000, Math.floor(Number(deadlineMs) || SMART_WARM_FALLBACK_DEADLINE_MS));
    if (typeof job?.cancel !== 'function') return () => {};
    const timer = setTimeout(() => {
        const deadlineError = new Error(`Smart Context Sidecar fallback exceeded its ${Math.round(ms / 1000)}s lifecycle deadline.`);
        deadlineError.name = 'TV2SmartWarmFallbackDeadline';
        deadlineError.deadlineMs = ms;
        try { job.cancel(deadlineError); } catch {}
    }, ms);
    return () => clearTimeout(timer);
}
// HOTFIX46: exact refs that Smart Context currently authorizes as load-bearing
// continuity. Predictive warm candidates and generic pins are deliberately not
// included: warm/pinned remains a relevance hint unless the owning subsystem
// has current-scene authority for reuse.
let warmReuseAuthorityRefs = [];
let warmReuseAuthorityKey = '';

function notifySmartContextUpdated(){
    try{globalThis.window?.dispatchEvent?.(new CustomEvent('tv2-smart-context-updated'));}catch{}
}

function cleanRef(ref, fallbackSource = 'active-injection') {
    if (!ref?.book || !Number.isFinite(Number(ref.uid))) return null;
    return {
        book: String(ref.book),
        uid: Number(ref.uid),
        title: String(ref.title || ''),
        nodeId: ref.nodeId ? String(ref.nodeId) : null,
        nodeLabel: String(ref.nodeLabel || ''),
        path: Array.isArray(ref.path) ? ref.path.map(String) : [],
        source: String(ref.source || fallbackSource),
        pinnedAt: Number(ref.pinnedAt) || Date.now(),
    };
}

function metaStore() {
    const context = getContext();
    if (!context?.chatMetadata) return { activePins: [], manualPins: [], earnedPins: [], warmDecay: {}, warmStreak: {} };
    const existing = context.chatMetadata[META_KEY];
    if (!existing || typeof existing !== 'object') context.chatMetadata[META_KEY] = { activePins: [], manualPins: [], earnedPins: [], warmDecay: {}, warmStreak: {} };
    const store = context.chatMetadata[META_KEY];
    if (!Array.isArray(store.activePins)) store.activePins = [];
    if (!Array.isArray(store.manualPins)) store.manualPins = [];
    if (!Array.isArray(store.earnedPins)) store.earnedPins = [];
    // 0.7.5 Jev admission hotfix migration: activePins are derived continuity
    // state, not user-authored pins. Clear them once so a buggy build that
    // bypassed final Lore Injection review cannot seed future warm/reuse work
    // with an oversized published set. Manual and earned pins are preserved.
    if (store.activePinAuthorityMigrationV2 !== true) {
        store.activePins = [];
        store.activePinAuthorityMigrationV2 = true;
        saveMeta();
    }
    if (!store.warmDecay || typeof store.warmDecay !== 'object' || Array.isArray(store.warmDecay)) store.warmDecay = {};
    if (!store.warmStreak || typeof store.warmStreak !== 'object' || Array.isArray(store.warmStreak)) store.warmStreak = {};
    // v2 changes warm decay from current-candidate pruning to stale-cache
    // bookkeeping. Clear counters poisoned by the old semantics exactly once.
    if (store.warmDecayMigrationV2 !== true) {
        store.warmDecay = {};
        store.warmDecayMigrationV2 = true;
        saveMeta();
    }
    return store;
}

function saveMeta() {
    try { getContext()?.saveMetadataDebounced?.(); } catch {}
}

function currentScopedRefs(refs,fallbackSource){
    return dedupeEntryRefs((refs||[])
        .map(ref=>cleanRef(ref,fallbackSource))
        .filter(ref=>ref&&isBookInCurrentStory(ref.book,{access:'read'}))
        .map(ref=>resolveCurrentTreeRef(ref))
        .filter(Boolean));
}
export function getActivePinnedRefs() { return currentScopedRefs(metaStore().activePins,'active-injection'); }
export function getManualPinnedRefs() { return currentScopedRefs(metaStore().manualPins,'manual'); }
export function getEarnedPinnedRefs() { return currentScopedRefs(metaStore().earnedPins,'earned-warm'); }

export function getPinnedRefs() {
    // Manual pins win ordering, but both remain Tree-bound entry refs. A pin is a
    // relevance hint / persistence hint; it never directly injects itself.
    return dedupeEntryRefs([...getManualPinnedRefs(), ...getActivePinnedRefs(), ...getEarnedPinnedRefs()]);
}

/**
 * Active pins are exactly the entries that crossed the injection boundary on
 * the last successful prompt. They are continuity evidence for the next scan,
 * not a bypass around the Tree or Lore Injection Review.
 */
export function pinActiveInjection(refs = [], source = 'live-injection') {
    const pins = dedupeEntryRefs(refs.map(ref => cleanRef({ ...ref, source, pinnedAt: Date.now() }, source)).filter(Boolean));
    const store = metaStore();
    store.activePins = pins;
    for (const ref of pins) delete store.warmDecay[`${ref.book}:${Number(ref.uid)}`];
    store.lastPinnedAt = Date.now();
    saveMeta();
    notifySmartContextUpdated();
    logEvent('smart-context', 'active-pins-updated', {
        source,
        count: pins.length,
        refs: pins.map(({ book, uid, title, nodeId, nodeLabel }) => ({ book, uid, title, nodeId, nodeLabel })),
    }, 'info');
    return pins;
}

export function pinManualRef(ref) {
    const clean = cleanRef({ ...ref, source: 'manual', pinnedAt: Date.now() }, 'manual');
    if (!clean) throw new Error('Manual pin requires book and UID.');
    const store = metaStore();
    store.manualPins = dedupeEntryRefs([...(store.manualPins || []), clean]);
    saveMeta();
    invalidateSmartContext('manual-pin-added');
    notifySmartContextUpdated();
    logEvent('smart-context', 'manual-pin-added', clean, 'info');
    return clean;
}

export function unpinManualRef(book, uid) {
    const store = metaStore();
    const before = store.manualPins.length;
    store.manualPins = store.manualPins.filter(ref => !(String(ref?.book) === String(book) && Number(ref?.uid) === Number(uid)));
    const changed = store.manualPins.length !== before;
    if (changed) {
        saveMeta();
        invalidateSmartContext('manual-pin-removed');
        notifySmartContextUpdated();
        logEvent('smart-context', 'manual-pin-removed', { book: String(book), uid: Number(uid) }, 'info');
    }
    return changed;
}

export function clearPins(reason = 'manual', { includeManual = false } = {}) {
    const store = metaStore();
    store.activePins = [];
    store.earnedPins = [];
    store.warmStreak = {};
    if (includeManual) store.manualPins = [];
    store.lastPinnedAt = Date.now();
    saveMeta();
    invalidateSmartContext(`pins-cleared:${reason}`);
    notifySmartContextUpdated();
    logEvent('smart-context', 'pins-cleared', { reason, includeManual }, 'info');
}

function recentChat(maxMessages = 8) {
    const chat = getContext()?.chat || [];
    return tailNarrativeSceneMessages(chat, Math.max(1, Number(maxMessages) || 8))
        .map(m => `[${m.is_user ? 'User' : 'Assistant'}]: ${String(m.mes || '')}`)
        .join('\n\n');
}

function hydratedRecentMessages(maxMessages = 10) {
    return sceneHydrationMessages(getContext()?.chat || [], maxMessages)
        .map(row => ({ is_system: false, is_user: row.role === 'user', mes: row.text }));
}

function chatTextFromMessages(messages = []) {
    return (messages || []).map(m => `[${m.is_user ? 'User' : 'Assistant'}]: ${String(m.mes || '')}`).join('\n\n');
}

function tailText(value, limit) {
    const text = String(value || '');
    const cap=Math.max(0,Number(limit)||0);
    if(!cap)return '';
    // Array.from iterates Unicode code points rather than UTF-16 code units,
    // so a predictive-scene truncation can never split a surrogate pair.
    const chars=Array.from(text);
    return chars.length > cap ? `…${chars.slice(-cap).join('')}` : text;
}


function currentForegroundGateForWarm(sceneSnapshot = null) {
    const context = getContext();
    const currentGate = getCurrentSceneChangeGate({ chatId: context?.chatId ?? context?.chat_id ?? null });
    if (!currentGate) return null;
    if (sceneSnapshot?.scanRevision && currentGate.sceneRevision && String(currentGate.sceneRevision) !== String(sceneSnapshot.scanRevision)) return null;
    return { ...currentGate };
}

function predictiveSceneText(maxMessages = 4) {
    const slice = tailNarrativeSceneMessages(getContext()?.chat || [], Math.max(2, Math.min(6, Number(maxMessages) || 4)));
    if (!slice.length) return '';
    return slice.map((m, idx) => {
        const current = idx === slice.length - 1;
        const limit = current ? 6000 : idx === slice.length - 2 ? 5000 : 2200;
        return `[${m.is_user ? 'User' : 'Assistant'}${current ? ' · CURRENT' : ''}]: ${tailText(m.mes, limit)}`;
    }).join('\n\n');
}

function stableJson(value){
    if(Array.isArray(value))return `[${value.map(stableJson).join(',')}]`;
    if(value&&typeof value==='object'){return `{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;}
    return JSON.stringify(value);
}

function compactWarmHash(value=''){
    // Deterministic, non-cryptographic scene identity used only to prevent the
    // same chat revision from incrementing earned-pin streak/miss counters more
    // than once when hydration, Director and manual refresh touch it repeatedly.
    let hash=2166136261;
    for(const ch of String(value||'')){
        hash^=ch.codePointAt(0)||0;
        hash=Math.imul(hash,16777619)>>>0;
    }
    return hash.toString(36);
}

function warmSceneEvaluationKey(messages=[]){
    const context=getContext();
    const tail=(messages||[]).slice(-2).map(m=>`${m?.is_user?'u':'a'}:${String(m?.mes||'')}`).join('\n');
    return `${String(context?.chatId||'chat')}|${Number(context?.chat?.length)||0}|${compactWarmHash(tail)}`;
}

function smartContextPolicyKey(settings=getSettings()){
    // Cache/publication authority follows the complete Smart Context policy,
    // not just scene inputs.  A changed threshold, rerank toggle, warm budget,
    // decay rule, candidate window, etc. must invalidate both cached and
    // in-flight work produced under the previous policy.
    return stableJson(settings?.smartContext||{});
}

function refTuple(ref){return [String(ref?.book||''),Number(ref?.uid)];}

function cacheKeyFor(chatText, pins, books, characterWarm = [], settings = getSettings()) {
    return stableJson({
        books:[...(books||[])].map(String).sort(),
        pins:(pins||[]).map(p=>[...refTuple(p),String(p?.source||'')]).sort((a,b)=>stableJson(a).localeCompare(stableJson(b))),
        characterWarm:(characterWarm||[]).map(p=>[...refTuple(p),String(p?.characterBankId||'')]).sort((a,b)=>stableJson(a).localeCompare(stableJson(b))),
        policy:smartContextPolicyKey(settings),
        sourceAuthority:currentNexusLoreSourceRevision(books),
        source:String(chatText||''),
    });
}

function warmAuthorityState(requestRevision, startingKey, hydrationLimit = null) {
    if (requestRevision !== warmRequestRevision) return { current: false, reason: 'newer-warm-request' };
    const settings = getSettings();
    if (!settings.enabled || settings.smartContext?.enabled === false) return { current: false, reason: 'smart-context-disabled' };
    const books = getActiveBooks({ requireTree: true, access: 'read', injection: 'tv2' });
    if (!books.length) return { current: false, reason: 'tree-books-changed' };
    const chatText = hydrationLimit != null
        ? chatTextFromMessages(hydratedRecentMessages(hydrationLimit))
        : recentChat(settings.smartContext?.contextMessages || 8);
    if (!chatText.trim()) return { current: false, reason: 'chat-changed' };
    const pins = getPinnedRefs();
    const sceneSnapshot = getSceneScannerSnapshot({ chatId: getContext()?.chatId ?? getContext()?.chat_id ?? null });
    const characterWarm = getCharacterWarmRefs({ chatText, sceneSnapshot });
    const currentKey = cacheKeyFor(chatText, pins, books, characterWarm, settings);
    if (currentKey !== startingKey) return { current: false, reason: 'warm-inputs-changed' };
    return { current: true, reason: 'current' };
}

function supersededWarmResult({ source, requestRevision, stage, authority, authorityRetry = 0 }) {
    const reason = String(authority?.reason || 'superseded');
    logEvent('smart-context', 'prewarm-superseded', {
        source,
        requestRevision,
        currentRevision: warmRequestRevision,
        stage,
        reason,
        authorityRetry,
    }, 'debug');
    return { skipped: true, reason: 'superseded-by-newer-warm', supersededReason: reason, stage, authorityRetry };
}

async function resolveWarmAuthorityLoss({ source, requestRevision, stage, authority, authorityRetry = 0, retryOptions = {} }) {
    const reason = String(authority?.reason || 'superseded');
    // A changed source/policy/ref set discovered by THIS request means the stale
    // work was correctly rejected, but no newer warm owns the replacement. Give
    // the owner one bounded replan from fresh inputs so a harmless settle race
    // cannot leave Smart Context empty for the entire next generation.
    if (reason === 'warm-inputs-changed' && requestRevision === warmRequestRevision && authorityRetry < MAX_WARM_AUTHORITY_RETRIES) {
        const nextRetry = authorityRetry + 1;
        logEvent('smart-context', 'prewarm-authority-retry', {
            source,
            requestRevision,
            currentRevision: warmRequestRevision,
            stage,
            reason,
            authorityRetry: nextRetry,
            maxAuthorityRetries: MAX_WARM_AUTHORITY_RETRIES,
        }, 'info');
        return preWarmSmartContext({ ...retryOptions, source, authorityRetry: nextRetry });
    }
    return supersededWarmResult({ source, requestRevision, stage, authority, authorityRetry });
}

function oneLine(value = '') {
    return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function smartWarmOpaqueCandidates(candidates = [], pins = [], characterWarm = []) {
    const pinKeys = new Set((pins || []).map(refKey));
    const characterKeys = new Set((characterWarm || []).map(refKey));
    const rows = candidates.map((candidate, index) => {
        const refId = `R${index + 1}`;
        const key = refKey(candidate);
        const flags = [];
        if (pinKeys.has(key)) flags.push('PINNED');
        if (characterKeys.has(key)) flags.push('CHARACTER_WARM');
        return {
            refId,
            candidate,
            promptBlock: [
                `REF_ID ${refId}`,
                `BOOK ${oneLine(candidate.book)}`,
                `TITLE ${oneLine(candidate.title || '')}`,
                `TREE ${oneLine(candidate.nodeLabel || candidate.nodeId || '')}`,
                `PATH ${oneLine(Array.isArray(candidate.path) ? candidate.path.join(' > ') : '')}`,
                `SCORE ${Number.isFinite(Number(candidate.score)) ? Number(candidate.score) : 'protected'}`,
                `FLAGS ${flags.length ? flags.join(',') : 'NONE'}`,
            ].join('\n'),
        };
    });
    return {
        rows,
        byId: new Map(rows.map(row => [row.refId, row.candidate])),
        allowedIds: new Set(rows.map(row => row.refId)),
    };
}

function smartWarmSelectionValidator(allowedIds = new Set()) {
    const allowed = allowedIds instanceof Set ? allowedIds : new Set(allowedIds || []);
    return value => {
        const errors = [];
        let score = 0;
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            return { valid: false, score, reason: 'Smart Context payload must be a top-level object.' };
        }
        const validateIds = field => {
            const refs = value[field];
            if (!Array.isArray(refs)) { errors.push(`${field} must be an array of opaque REF_ID strings`); return; }
            score += 10;
            const seen = new Set();
            refs.forEach((raw, index) => {
                if (typeof raw !== 'string') { errors.push(`${field}[${index}] must be a REF_ID string`); return; }
                const refId = raw.trim();
                if (!allowed.has(refId)) errors.push(`${field}[${index}] references unknown REF_ID ${refId || '(empty)'}`);
                else if (seen.has(refId)) errors.push(`${field}[${index}] duplicates ${refId}`);
                else { seen.add(refId); score += 3; }
            });
        };
        validateIds('entries');
        validateIds('continuityEntries');
        if (![1, 2, 6].includes(Number(value.warmBudget))) errors.push('warmBudget must be exactly 1, 2, or 6');
        else score += 10;
        if (typeof value.reasoning !== 'string') errors.push('reasoning must be text');
        else score += 5;
        return { valid: errors.length === 0, score, reason: errors.join('; ') || null, value };
    };
}

function resolveOpaqueWarmRefs(ids = [], byId = new Map()) {
    const seen = new Set();
    const rows = [];
    for (const raw of ids || []) {
        const refId = String(raw || '').trim();
        if (!refId || seen.has(refId)) continue;
        const row = byId.get(refId);
        if (!row) continue;
        seen.add(refId);
        rows.push(row);
    }
    return rows;
}

function adaptiveCandidatePool(searched = [], pins = [], persistentWarm = []) {
    const pinKeys = new Set((pins || []).map(refKey));
    const warmKeys = new Set((persistentWarm || []).map(refKey));
    const finite = searched.filter(row => Number.isFinite(Number(row.score)) && Number(row.score) > 0);
    const bestScore = finite.reduce((m, row) => Math.max(m, Number(row.score) || 0), 0);
    // Relevance floor, not an entry-count cap. The stronger the best match is,
    // the more evidence weaker candidates need before we spend Sidecar context on them.
    const scoreFloor = bestScore > 0 ? Math.max(5, bestScore * 0.22) : 0;
    const strongMatchKinds = new Set(['title-exact','title-phrase','key-exact','key-phrase','tree-path-phrase','node-summary-phrase']);
    const kept = searched.filter(row => {
        const key = refKey(row);
        if (pinKeys.has(key) || warmKeys.has(key)) return true;
        const matched = Array.isArray(row.matched) ? row.matched : [];
        if (matched.some(m => strongMatchKinds.has(m))) return true;
        return Number(row.score) >= scoreFloor;
    });
    return { rows: kept, bestScore, scoreFloor, prunedCount: Math.max(0, searched.length - kept.length) };
}

function refKey(ref) { return JSON.stringify(refTuple(ref)); }

function warmRefSignature(refs = []) {
    const tuples=dedupeEntryRefs(refs).map(refTuple).filter(([,uid])=>Number.isFinite(uid));
    tuples.sort((a,b)=>stableJson(a).localeCompare(stableJson(b)));
    return stableJson(tuples);
}

/**
 * Decide whether current-scene warm relevance has moved far enough away from
 * the proven live injection to justify one targeted MINOR refresh. Explicit
 * Sidecar continuity refs are authoritative current-scene evidence; local
 * deterministic candidates use a stricter threshold so one speculative hit
 * cannot churn retrieval on an otherwise steady scene.
 */
export function assessWarmInjectionDrift({ desiredRefs = [], injectedRefs = [], characterWarmRefs = [], tier = 'steady', explicitContinuity = false } = {}) {
    const desired = dedupeEntryRefs(desiredRefs);
    const injectedKeys = new Set(dedupeEntryRefs(injectedRefs).map(refKey));
    const characterKeys = new Set(dedupeEntryRefs(characterWarmRefs).map(refKey));
    const missing = desired.filter(ref => !injectedKeys.has(refKey(ref)));
    const missingCharacter = missing.filter(ref => characterKeys.has(refKey(ref)));
    const material = missingCharacter.length > 0
        || (explicitContinuity ? missing.length > 0
            : String(tier) === 'steady' ? missing.length >= 2 : missing.length >= 1);
    return {
        material,
        signature: warmRefSignature(desired),
        desiredRefs: desired,
        missingRefs: missing,
        missingCharacterRefs: missingCharacter,
        explicitContinuity: explicitContinuity === true,
        tier: String(tier || 'steady'),
    };
}

function smartWarmConfig(settings = {}) {
    const raw = settings?.smartContext?.adaptiveWarm || {};
    return {
        enabled: raw.enabled !== false,
        promoteAfter: Math.max(2, Number(raw.promoteAfter) || 3),
        maxEarnedPins: Math.max(1, Number(raw.maxEarnedPins) || 3),
        decayEnabled: settings?.smartContext?.decay?.enabled !== false,
        maxMisses: Math.max(1, Number(settings?.smartContext?.decay?.maxMisses) || 3),
    };
}

/**
 * Repeated predictive selection earns a small, cache-stabilizing pin. Manual
 * pins are untouched. Character Bank lead warmth stays a separate policy so a
 * permanent Lead card cannot automatically consume the earned-pin allowance.
 *
 * HOTFIX28: earned pins are temporary relevance authority. Every distinct
 * scene evaluation advances their lifecycle, even when Smart Context uses only
 * the local deterministic rescore. A genuine MAJOR pivot immediately breaks
 * earned pins that are no longer selected; ordinary misses demote them after
 * maxMisses and hand them back to normal warm/cold decay.
 */
function updateEarnedPins(selected = [], characterWarm = [], settings = {}, { evaluationKey = '', gateMode = '', sceneTier = '', source = '' } = {}) {
    const config = smartWarmConfig(settings);
    const store = metaStore();
    const now = Date.now();
    if (!config.enabled) {
        if ((store.earnedPins || []).length || Object.keys(store.warmStreak || {}).length) {
            const expired=(store.earnedPins||[]).map(ref=>({...ref,reason:'adaptive-warm-disabled'}));
            store.earnedPins=[];
            store.warmStreak={};
            saveMeta();
            logEvent('smart-context','earned-pin-updated',{source,promoteAfter:config.promoteAfter,maxEarnedPins:config.maxEarnedPins,promoted:[],expired:expired.map(({book,uid,title,reason})=>({book,uid,title,reason})),activeCount:0,gateMode,sceneTier},'info');
        }
        return { promoted: [], expired: [], pins: [] };
    }
    const selectedRefs = dedupeEntryRefs(selected);
    const selectedKeys = new Set(selectedRefs.map(refKey));
    const characterKeys = new Set(characterWarm.map(refKey));
    const manualKeys = new Set(getManualPinnedRefs().map(refKey));
    const activeKeys = new Set(getActivePinnedRefs().map(refKey));
    const previousPins = new Map((store.earnedPins || []).map(ref => [refKey(ref), ref]));
    const promoted = [];
    const expired = [];
    const hardPivot = String(gateMode || '') === 'MAJOR_CHANGE';
    const evalKey = String(evaluationKey || '');

    for (const [key, state] of Object.entries(store.warmStreak || {})) {
        if (selectedKeys.has(key)) continue;
        const distinctMiss = !evalKey || String(state.lastMissEvaluation || '') !== evalKey;
        if (!distinctMiss) continue;
        state.lastMissEvaluation = evalKey;
        state.lastMissAt = now;
        if (config.decayEnabled) state.misses = Math.max(0, Number(state.misses) || 0) + 1;
        // A real hard scene pivot revokes stale earned relevance immediately.
        // Manual pins, active injection continuity and Character Bank warmth are
        // separate authorities and are never touched here.
        if (previousPins.has(key) && config.decayEnabled && (hardPivot || state.misses >= config.maxMisses)) {
            previousPins.delete(key);
            expired.push({ ...state.ref, misses: state.misses, reason: hardPivot ? 'major-scene-pivot' : 'relevance-decay' });
            delete store.warmStreak[key];
        } else if (!previousPins.has(key) && now - (Number(state.lastSeenAt) || 0) > 86_400_000) {
            delete store.warmStreak[key];
        }
    }

    for (const ref of selectedRefs) {
        const key = refKey(ref);
        if (!ref.book || !Number.isFinite(Number(ref.uid)) || characterKeys.has(key) || manualKeys.has(key) || activeKeys.has(key)) continue;
        const prior = store.warmStreak[key] || {};
        const distinctSelection = !evalKey || String(prior.lastSelectedEvaluation || '') !== evalKey;
        const nextStreak = distinctSelection ? Math.max(0, Number(prior.streak) || 0) + 1 : Math.max(0, Number(prior.streak) || 0);
        const state = store.warmStreak[key] = {
            ...prior,
            streak: nextStreak,
            misses: 0,
            lastSeenAt: distinctSelection ? now : (Number(prior.lastSeenAt) || now),
            lastSelectedEvaluation: distinctSelection ? evalKey : String(prior.lastSelectedEvaluation || ''),
            lastMissEvaluation: '',
            title: String(ref.title || prior.title || ''),
            ref: cleanRef({ ...ref, source: 'earned-warm', pinnedAt: Number(prior?.ref?.pinnedAt) || now }, 'earned-warm'),
        };
        if (state.streak >= config.promoteAfter && !previousPins.has(key) && state.ref) {
            previousPins.set(key, state.ref);
            promoted.push({ ...state.ref, streak: state.streak });
        }
    }

    const ordered = [...previousPins.values()]
        .sort((a, b) => (Number(store.warmStreak[refKey(b)]?.streak) || 0) - (Number(store.warmStreak[refKey(a)]?.streak) || 0)
            || (Number(b.pinnedAt) || 0) - (Number(a.pinnedAt) || 0))
        .slice(0, config.maxEarnedPins);
    const keptKeys = new Set(ordered.map(refKey));
    for (const [key, pin] of previousPins) if (!keptKeys.has(key)) {
        if (!expired.some(ref => refKey(ref) === key)) expired.push({ ...pin, reason: 'earned-pin-cap' });
        delete store.warmStreak[key];
    }
    store.earnedPins = ordered;
    saveMeta();
    if (promoted.length || expired.length) {
        logEvent('smart-context', 'earned-pin-updated', {
            source,
            evaluationKey: evalKey || null,
            gateMode: gateMode || null,
            sceneTier: sceneTier || null,
            decayEnabled: config.decayEnabled,
            maxMisses: config.maxMisses,
            promoteAfter: config.promoteAfter,
            maxEarnedPins: config.maxEarnedPins,
            promoted: promoted.map(({ book, uid, title, streak }) => ({ book, uid, title, streak })),
            expired: expired.map(({ book, uid, title, misses, reason }) => ({ book, uid, title, misses: misses || null, reason: reason || 'relevance-decay' })),
            activeCount: ordered.length,
        }, 'info');
    }
    return { promoted, expired, pins: dedupeEntryRefs(ordered) };
}

// Legacy warmDecay metadata is migrated/ignored. Ordinary Smart Context warm
// cycles do not mutate it: current deterministic relevance is the authority for
// candidate eligibility, while candidateInputLimit only bounds Sidecar input.

export function invalidateSmartContext(reason = 'unknown') {
    // Invalidation is also an authority barrier: an older prewarm that is still
    // awaiting Tree/Sidecar work must never repopulate a cache we just revoked.
    warmRequestRevision += 1;
    warmCache = null;
    warmCacheKey = '';
    warmCachePolicyKey = '';
    warmCachedAt = 0;
    warmReuseAuthorityRefs = [];
    warmReuseAuthorityKey = '';
    lastWarmStats = null;
    notifySmartContextUpdated();
    logEvent('smart-context', 'warm-cache-invalidated', { reason }, 'debug');
}

export function getLastWarmStats() { return lastWarmStats ? { ...lastWarmStats } : null; }

export function isSmartContextStale() {
    const settings = getSettings();
    if (!warmCache || !warmCache.length) return true;
    const rawAge = Number(settings.smartContext?.cacheMaxAgeMs);
    const maxAge = Number.isFinite(rawAge) && rawAge > 0 ? rawAge : 300000;
    return !warmCachedAt || Date.now() - warmCachedAt > maxAge;
}

export function getWarmCandidates() {
    const settings = getSettings();
    const rawAge = Number(settings.smartContext?.cacheMaxAgeMs);
    const age = Number.isFinite(rawAge) && rawAge > 0 ? rawAge : 300000;
    const sceneSnapshot = getSceneScannerSnapshot({ chatId: getContext()?.chatId ?? getContext()?.chat_id ?? null });
    const persistent = getCharacterWarmRefs({ chatText: recentChat(settings.smartContext?.contextMessages || 8), sceneSnapshot });
    const policyCurrent=warmCachePolicyKey&&warmCachePolicyKey===smartContextPolicyKey(settings);
    const cached = (!policyCurrent||!warmCache || !warmCachedAt || Date.now() - warmCachedAt > age) ? [] : warmCache.map(row => ({ ...row }));
    const resolvedCached=cached.filter(ref=>isBookInCurrentStory(ref.book,{access:'read'})).map(resolveCurrentTreeRef).filter(Boolean);
    return dedupeEntryRefs([...persistent, ...resolvedCached]);
}

function currentSceneCharacterReuseRefs(characterWarm = []) {
    // Character Bank's ordinary warm policy intentionally keeps leads and some
    // supporting cards warm even when absent. That is useful prediction, but it
    // is not enough authority to retain an already-injected ref across a scene
    // transition. Reuse requires the accepted Scene Scanner to still present or
    // explicitly reference the character.
    return dedupeEntryRefs((characterWarm || []).filter(ref =>
        ref?.characterScannerPresent === true || ref?.characterScannerReferenced === true
    ));
}

/**
 * Return only Smart Context refs that retain current-scene reuse authority.
 * Character Bank refs are recomputed against the accepted Scene Scanner state
 * on every read. Sidecar continuity refs are admitted only while the exact
 * Smart Context input/policy/source key that produced them is still current.
 * Generic pins and predictive warms are intentionally excluded.
 */
export function getWarmReuseAuthorityRefs() {
    const settings = getSettings();
    if (!settings.enabled || settings.smartContext?.enabled === false) return [];
    const books = getActiveBooks({ requireTree: true, access: 'read', injection: 'tv2' });
    if (!books.length) return [];
    const chatText = recentChat(settings.smartContext?.contextMessages || 8);
    const sceneSnapshot = getSceneScannerSnapshot({ chatId: getContext()?.chatId ?? getContext()?.chat_id ?? null });
    const characterWarm = getCharacterWarmRefs({ chatText, sceneSnapshot });
    const characterReuse = currentSceneCharacterReuseRefs(characterWarm);
    const currentKey = cacheKeyFor(chatText, getPinnedRefs(), books, characterWarm, settings);
    const continuityCurrent = warmReuseAuthorityKey
        && warmReuseAuthorityKey === currentKey
        && warmCachePolicyKey === smartContextPolicyKey(settings);
    const continuity = continuityCurrent ? warmReuseAuthorityRefs : [];
    return dedupeEntryRefs([...characterReuse, ...continuity])
        .filter(ref => isBookInCurrentStory(ref.book, { access:'read' }))
        .map(resolveCurrentTreeRef)
        .filter(Boolean);
}

export function getWarmNodeRefs() {
    const seen = new Set();
    const out = [];
    for (const c of getWarmCandidates()) {
        if (!c?.book || !c?.nodeId) continue;
        const key = JSON.stringify([String(c.book),String(c.nodeId)]);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ book: c.book, nodeId: String(c.nodeId) });
    }
    return out;
}

export function getWarmNodeIds() { return [...new Set(getWarmNodeRefs().map(ref => ref.nodeId))]; }
export function getPinnedNodeRefs() {
    const seen = new Set();
    const out = [];
    for (const c of getPinnedRefs()) {
        if (!c?.book || !c?.nodeId) continue;
        const key = JSON.stringify([String(c.book),String(c.nodeId)]);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ book: c.book, nodeId: String(c.nodeId) });
    }
    return out;
}


async function resolveSceneReferenceWarmRefs(sceneSnapshot, books = []) {
    const terms = sceneReferenceTerms(sceneSnapshot).slice(0, 8);
    if (!terms.length) return [];
    const queries = terms.map(term => ({
        query: term.name,
        limit: term.relation === 'present' || term.relation === 'current-location' ? 4 : 2,
        includeContent: false,
    }));
    const batches = await searchTreeMany({ queries, books, includeContent:false });
    const rows = [];
    for (let index = 0; index < terms.length; index += 1) {
        const term = terms[index];
        const found = batches[index] || [];
        const take = term.relation === 'present' || term.relation === 'current-location' ? 2 : 1;
        for (const row of found.filter(row => Number(row?.score) > 0).slice(0, take)) {
            rows.push({
                ...row,
                score: (Number(row.score) || 0) + Number(term.priority || 0),
                matched: [...new Set([...(Array.isArray(row.matched) ? row.matched : []), `scene-reference:${term.kind}:${term.relation}`])],
                source: 'scene-scanner-reference',
                sceneReferenceKind: term.kind,
                sceneReferenceRelation: term.relation,
                sceneReferenceName: term.name,
            });
        }
    }
    return dedupeEntryRefs(rows).slice(0, 12);
}

/**
 * Pre-warm the next retrieval candidate pool. Deterministic Tree search creates
 * the candidate universe; optional Sidecar reasoning reranks/selects only from
 * that universe through the central Sidecar Bus. The warmer never injects.
 */
export async function preWarmSmartContext({ source = 'generation-end', force = false, enqueueSidecar = null, semanticCheck = false, localOnly = false, hydrationLimit = null, sceneBaseline = false, authorityRetry = 0 } = {}) {
    // Completion order is not authority order. Every invocation supersedes older
    // in-flight work; only the newest still-valid scene evaluation may commit
    // Smart Context side effects or cache state.
    const requestRevision = ++warmRequestRevision;
    const retryOptions = { force, enqueueSidecar, semanticCheck, localOnly, hydrationLimit, sceneBaseline };
    const settings = getSettings();
    if (!settings.enabled || settings.smartContext?.enabled === false) return { skipped: true, reason: 'disabled' };
    const books = getActiveBooks({ requireTree: true, access: 'read', injection: 'tv2' });
    if (!books.length) return { skipped: true, reason: 'no-tree-books' };
    const recentMessages = hydrationLimit != null
        ? hydratedRecentMessages(hydrationLimit)
        : (getContext()?.chat || []).filter(message => !message?.is_system && String(message?.mes || '').trim());
    const chatText = hydrationLimit != null
        ? chatTextFromMessages(recentMessages)
        : recentChat(settings.smartContext?.contextMessages || 8);
    if (!chatText.trim()) return { skipped: true, reason: 'no-chat' };
    let sceneSnapshot = getSceneScannerSnapshot({ chatId: getContext()?.chatId ?? getContext()?.chat_id ?? null });
    if (localOnly !== true) {
        try {
            // Smart Context requests current scene authority but never classifies
            // scene change itself. Scanner and Change Gate remain the owners.
            const authority = await ensureSceneAuthority({ context:getContext(), messages:recentMessages, source:`${source}:scene-authority`, enqueueSidecar });
            sceneSnapshot = authority.sceneScan;
        } catch (error) {
            if (isIntentionalCancellation(error)) return { deferred:true, reason:'scene-scan-preempted', source, requestRevision, count:0 };
            logEvent('smart-context','scene-scan-unavailable',{source,error:error?.message||String(error)},'warn');
            sceneSnapshot = getSceneScannerSnapshot({ chatId:getContext()?.chatId ?? getContext()?.chat_id ?? null });
        }
    }
    const activePins = getActivePinnedRefs();
    const manualPins = getManualPinnedRefs();
    const earnedPins = getEarnedPinnedRefs();
    const protectedPins = dedupeEntryRefs([...manualPins, ...activePins]);
    const pins = dedupeEntryRefs([...protectedPins, ...earnedPins]);
    const characterWarm = getCharacterWarmRefs({ chatText, sceneSnapshot });
    const foregroundGate = currentForegroundGateForWarm(sceneSnapshot);
    const scan = scanSceneForWarmBudget({
        retrievalGate: foregroundGate,
        sceneSnapshot,
        sceneBaseline: sceneBaseline === true,
    });
    const sceneText = hydrationLimit != null
        ? chatTextFromMessages(recentMessages.slice(-Math.max(1, Math.min(scan.sceneMessages, hydrationLimit))))
        : predictiveSceneText(Math.min(scan.sceneMessages, settings.smartContext?.contextMessages || 8));
    const evaluationKey = warmSceneEvaluationKey(recentMessages);
    const key = cacheKeyFor(chatText, pins, books, characterWarm);
    const rawAge = Number(settings.smartContext?.cacheMaxAgeMs);
    const maxAge = Number.isFinite(rawAge) && rawAge > 0 ? rawAge : 300000;
    if (!force && !semanticCheck && warmCache && warmCacheKey === key && Date.now() - warmCachedAt <= maxAge) {
        logEvent('smart-context', 'prewarm-cache-hit', { source, count: warmCache.length }, 'debug');
        return { cached: true, count: warmCache.length };
    }

    if (characterWarm.length) {
        const byBank = new Map();
        for (const ref of characterWarm) {
            const bankId = String(ref.characterBankId || '');
            if (!bankId || ref.characterCardBound !== true) continue;
            const row = byBank.get(bankId) || {
                bankId,
                character:ref.character || '',
                role:ref.characterRole || '',
                trigger:ref.characterTrigger || '',
                cardActive:ref.characterCardActive === true,
                textPresent:ref.characterTextPresent === true,
                refs:[],
            };
            row.refs.push({ book:ref.book, uid:ref.uid, title:ref.title, nodeId:ref.nodeId, nodeLabel:ref.nodeLabel });
            byBank.set(bankId,row);
        }
        for (const row of byBank.values()) {
            logEvent('character-memory','card-context-warmed',{
                source,
                bankId:row.bankId,
                character:row.character,
                role:row.role,
                trigger:row.trigger,
                cardActive:row.cardActive,
                textPresent:row.textPresent,
                linkedCount:row.refs.length,
                refs:row.refs,
            },'info');
        }
    }

    // Blank/0 candidatePoolSize uses an adaptive bounded Search window. Search
    // still scores the full Tree index, but no longer materializes every match
    // before relevance pruning. Protected pins/Character warmth are merged back
    // explicitly below, so this window cannot evict required continuity refs.
    const configuredPool = Number(settings.smartContext?.candidatePoolSize);
    const adaptiveSearchWindow=Math.max(64,Math.min(512,Math.max(1,Number(scan.candidateInputLimit)||16)*8));
    const poolLimit = Number.isFinite(configuredPool) && configuredPool > 0 ? Math.floor(configuredPool) : adaptiveSearchWindow;
    const searched = await searchTree({
        query: sceneText || chatText,
        books,
        limit: poolLimit,
        includeContent: false,
        pinnedRefs: protectedPins,
        warmRefs: dedupeEntryRefs([...characterWarm, ...earnedPins]),
    });
    const afterSearchAuthority = warmAuthorityState(requestRevision, key, hydrationLimit);
    if (!afterSearchAuthority.current) return resolveWarmAuthorityLoss({ source, requestRevision, stage: 'after-tree-search', authority: afterSearchAuthority, authorityRetry, retryOptions });
    const sceneReferenceWarm = await resolveSceneReferenceWarmRefs(sceneSnapshot, books);
    const afterReferenceAuthority = warmAuthorityState(requestRevision, key, hydrationLimit);
    if (!afterReferenceAuthority.current) return resolveWarmAuthorityLoss({ source, requestRevision, stage: 'after-scene-reference-resolution', authority: afterReferenceAuthority, authorityRetry, retryOptions });
    const adaptive = adaptiveCandidatePool(searched, protectedPins, dedupeEntryRefs([...characterWarm, ...earnedPins, ...sceneReferenceWarm]));
    const byKey = new Map(adaptive.rows.map(c => [refKey(c), c]));
    for (const ref of sceneReferenceWarm) {
        const k = refKey(ref);
        const prior = byKey.get(k);
        if (!prior || Number(ref.score || 0) > Number(prior.score || 0)) byKey.set(k, { ...prior, ...ref });
    }
    // Manual and last-injection continuity pins are protected authority. Earned
    // pins are deliberately NOT force-inserted here: they receive a warm search
    // boost and must prove continuing relevance again or decay will demote them.
    for (const pin of protectedPins) {
        const k = refKey(pin);
        if (!byKey.has(k)) byKey.set(k, { ...pin, score: Number.POSITIVE_INFINITY, matched: ['pin'] });
    }
    for (const ref of characterWarm) {
        const k = refKey(ref);
        if (!byKey.has(k)) byKey.set(k, { ...ref, score: Number.POSITIVE_INFINITY, matched: ['character-bank-warm'] });
    }
    let candidates = dedupeEntryRefs([...byKey.values()]);
    const decay = { missed: [], expired: [] };

    const protectedKeys = new Set([...protectedPins, ...characterWarm].map(refKey));
    const predictive = candidates
        .filter(candidate => !protectedKeys.has(refKey(candidate)))
        .sort((a, b) => Number(b.score || 0) - Number(a.score || 0) || String(a.book).localeCompare(String(b.book)) || Number(a.uid) - Number(b.uid));
    // C11-166: the physical candidate window must be able to satisfy every legal
    // Sidecar warmBudget.  A steady scan may locally prefer three candidates, but
    // the Sidecar is allowed to broaden to six; never ask it to select refs it was
    // not actually shown.
    const sidecarCandidateLimit = Math.max(Number(scan.candidateInputLimit) || 0, 6);
    const sidecarPredictive = predictive.slice(0, sidecarCandidateLimit);
    const promptCandidates = dedupeEntryRefs([...protectedPins, ...characterWarm, ...sidecarPredictive]);
    // #198 authority fence: Decision Core may rank/prune only the bounded
    // predictive frontier. Manual/earned pins and Character Bank continuity are
    // never offered as pruneable Jev candidates.
    const earnedPinKeys = new Set(earnedPins.map(refKey));
    const decisionProtectedEarned = sidecarPredictive.filter(row => earnedPinKeys.has(refKey(row)));
    const decisionPredictive = sidecarPredictive
        .filter(row => !earnedPinKeys.has(refKey(row)))
        .slice(0, SMART_CONTEXT_DECISION_MAX_CANDIDATES);
    const decisionGate = currentForegroundGateForWarm(sceneSnapshot);
    const decisionContext = {
        sceneNeed: sceneText || chatText,
        scene:{scanRevision:sceneSnapshot?.scanRevision||null,acceptedScene:sceneSnapshot?.acceptedScene||null,references:sceneSnapshot?.references||null,delta:sceneSnapshot?.delta||null,degraded:sceneSnapshot?.degraded===true},
        changeGate:decisionGate,warmBudget:scan.warmBudget,warmBudgetFloor:scan.warmBudgetFloor||scan.warmBudget,candidates:decisionPredictive,warmKey:key,sourceRevision:currentNexusLoreSourceRevision(books),
    };
    decisionContext.sourceFingerprint=smartContextWarmReviewFingerprint(decisionContext);
    decisionContext.readCurrentFreshnessContext=()=>{
        const currentSettings=getSettings(),currentBooks=getActiveBooks({requireTree:true,access:'read',injection:'tv2'}),currentChatText=recentChat(currentSettings.smartContext?.contextMessages||8),currentScene=getSceneScannerSnapshot({chatId:getContext()?.chatId??getContext()?.chat_id??null}),currentCharacterWarm=getCharacterWarmRefs({chatText:currentChatText,sceneSnapshot:currentScene}),currentKey=cacheKeyFor(currentChatText,getPinnedRefs(),currentBooks,currentCharacterWarm,currentSettings),currentGate=currentForegroundGateForWarm(currentScene),currentScan=scanSceneForWarmBudget({retrievalGate:currentGate,sceneSnapshot:currentScene,sceneBaseline:sceneBaseline===true}),currentSceneText=predictiveSceneText(Math.min(currentScan.sceneMessages,currentSettings.smartContext?.contextMessages||8));
        return{...decisionContext,sceneNeed:currentSceneText||currentChatText,scene:{scanRevision:currentScene?.scanRevision||null,acceptedScene:currentScene?.acceptedScene||null,references:currentScene?.references||null,delta:currentScene?.delta||null,degraded:currentScene?.degraded===true},changeGate:currentGate,warmBudget:currentScan.warmBudget,warmBudgetFloor:currentScan.warmBudgetFloor||currentScan.warmBudget,warmKey:currentKey,sourceRevision:currentNexusLoreSourceRevision(currentBooks)};
    };
    if (decisionShadowEnabled() && decisionPredictive.length) {
        try {
            const handle = startDecisionSiteThroughDirector(SMART_CONTEXT_WARM_REVIEW_SITE_ID, decisionContext, {
                source: 'smart-context-warm-review-shadow',
                mode: 'shadow',
            });
            handle?.promise?.catch?.(() => {});
        } catch {}
    }

    logEvent('smart-context', 'scene-scan-ready', {
        source,
        tier: scan.tier,
        warmBudget: scan.warmBudget,
        warmBudgetFloor: scan.warmBudgetFloor || scan.warmBudget,
        candidateInputLimit: scan.candidateInputLimit,
        basis: scan.basis,
    }, 'info');
    logEvent('smart-context', 'deterministic-pool-ready', {
        source,
        searchedCount: searched.length,
        candidateCount: candidates.length,
        sidecarCandidateCount: promptCandidates.length,
        predictiveCandidateCount: predictive.length,
        prunedCount: adaptive.prunedCount,
        bestScore: adaptive.bestScore,
        scoreFloor: adaptive.scoreFloor,
        pinCount: pins.length,
        protectedPinCount: protectedPins.length,
        earnedPinCount: earnedPins.length,
        characterWarmCount: characterWarm.length,
        sceneReferenceWarmCount: sceneReferenceWarm.length,
        poolLimit,
        policy: Number.isFinite(configuredPool)&&configuredPool>0 ? 'explicit-count-limit+relevance' : 'adaptive-bounded-search+relevance',
        force,
        decayPrunedCount: 0,
        decayMissCount: decay.missed.length,
        decayExpiredCount: decay.expired.length,
        sceneTier: scan.tier,
        warmBudget: scan.warmBudget,
        warmBudgetFloor: scan.warmBudgetFloor || scan.warmBudget,
    }, 'info');
    lastWarmStats = {
        source,
        searchedCount: searched.length,
        shortlistedCount: candidates.length,
        prunedCount: adaptive.prunedCount,
        bestScore: adaptive.bestScore,
        scoreFloor: adaptive.scoreFloor,
        pinCount: pins.length,
        protectedPinCount: protectedPins.length,
        earnedPinCount: earnedPins.length,
        characterWarmCount: characterWarm.length,
        sceneReferenceWarmCount: sceneReferenceWarm.length,
        policy: Number.isFinite(configuredPool)&&configuredPool>0 ? 'explicit-count-limit+relevance' : 'adaptive-bounded-search+relevance',
        sceneTier: scan.tier,
        warmBudget: scan.warmBudget,
        warmBudgetFloor: scan.warmBudgetFloor || scan.warmBudget,
        candidateInputLimit: scan.candidateInputLimit,
        sidecarSlot: null,
        sidecarSelectedCount: null,
        reasoning: '',
        finalCount: candidates.length,
        at: Date.now(),
    };
    let selectedPredictive = predictive.slice(0, scan.warmBudget);
    const retrievalState = getRetrievalState();
    const deterministicRefreshDesired = dedupeEntryRefs([...characterWarm, ...selectedPredictive]);
    const deterministicDrift = assessWarmInjectionDrift({
        desiredRefs: deterministicRefreshDesired,
        injectedRefs: retrievalState?.lastInjectedRefs || [],
        characterWarmRefs: characterWarm,
        tier: scan.tier,
        explicitContinuity: false,
    });
    const cacheFresh = Boolean(warmCache?.length && warmCachedAt && Date.now() - warmCachedAt <= maxAge);
    const shouldUseSemanticRerank = localOnly !== true
        && settings.smartContext?.sidecarRerank !== false
        && sidecarPredictive.length > 0
        && (force || semanticCheck || !cacheFresh || scan.tier !== 'steady' || deterministicDrift.material);
    let sidecarScan = null;
    let continuityRefs = [];
    let continuityProvided = false;
    const semanticSelectedPredictiveKeys = new Set();
    let jevHandled = false;
    let jevSelectedCount = 0;
    let jevFallbackReason = shouldUseSemanticRerank && !decisionAssistEnabled() ? 'assist-off' : null;
    let jevFallbackCount = 0;
    let sidecarFallbackDeadlineHit = false;
    let sidecarFallbackFailed = false;
    if (shouldUseSemanticRerank && decisionAssistEnabled() && decisionPredictive.length) {
        try {
            const handle = startDecisionSiteThroughDirector(SMART_CONTEXT_WARM_REVIEW_SITE_ID, decisionContext, {
                source: 'smart-context-warm-review-assist',
                mode: 'assist',
            });
            const run = await handle.promise;
            const afterJevAuthority = warmAuthorityState(requestRevision, key, hydrationLimit);
            if (!afterJevAuthority.current) return resolveWarmAuthorityLoss({ source, requestRevision, stage: 'after-jev-admission', authority: afterJevAuthority, authorityRetry, retryOptions });
            const interpreted = interpretSmartContextWarmReviewDecision(run?.decision, {
                candidates: decisionPredictive,
                warmBudget: scan.warmBudget,
                warmBudgetFloor: scan.warmBudgetFloor || scan.warmBudget,
            });
            if (interpreted.handled) {
                jevHandled = true;
                selectedPredictive = interpreted.selected;
                continuityRefs = interpreted.continuitySelected || [];
                continuityProvided = true;
                jevSelectedCount = interpreted.semanticSelected.length;
                for (const row of interpreted.semanticSelected) semanticSelectedPredictiveKeys.add(refKey(row));
                sidecarScan = {
                    warmBudget: interpreted.warmBudget,
                    requestedWarmBudget: interpreted.requestedWarmBudget,
                    warmBudgetFloor: interpreted.warmBudgetFloor,
                    authority: 'scene-scanner+change-gate+decision-core',
                };
                lastWarmStats = {
                    ...(lastWarmStats || {}),
                    jevHandled: true,
                    jevProvider: run?.decision?.provider || null,
                    jevLatencyMs: Number(run?.decision?.latencyMs) || 0,
                    jevSelectedCount,
                    jevDeterministicFillCount: interpreted.deterministicFill.length,
                    jevFallbackCount: 0,
                    jevFallbackReason: null,
                    selectedBudget: interpreted.warmBudget,
                    warmBudgetFloor: interpreted.warmBudgetFloor,
                    sidecarSelectedCount: null,
                    sidecarSlot: null,
                    reasoning: '',
                    finalCount: selectedPredictive.length,
                    at: Date.now(),
                };
                logEvent('smart-context', 'jev-admission-complete', {
                    source,
                    offeredCount: decisionPredictive.length,
                    selectedCount: jevSelectedCount,
                    deterministicFillCount: interpreted.deterministicFill.length,
                    fallbackCount: 0,
                    finalPredictiveCount: selectedPredictive.length,
                    warmBudgetFloor: interpreted.warmBudgetFloor,
                    warmBudget: interpreted.warmBudget,
                    currentSceneSeed: interpreted.currentSceneSeed ? refKey(interpreted.currentSceneSeed) : null,
                    nextBeatSeed: interpreted.nextBeatSeed ? refKey(interpreted.nextBeatSeed) : null,
                    continuityCount: continuityRefs.length,
                    protectedEarnedOutsideJevCount: decisionProtectedEarned.length,
                    provider: run?.decision?.provider || null,
                    latencyMs: Number(run?.decision?.latencyMs) || 0,
                    qualityFence: 'moving-frontier+current-scene+next-beat-diversity',
                }, 'info');
            } else {
                jevFallbackReason = interpreted.reason || 'decision-unavailable';
            }
        } catch (error) {
            const failedJevAuthority = warmAuthorityState(requestRevision, key, hydrationLimit);
            if (!failedJevAuthority.current) return resolveWarmAuthorityLoss({ source, requestRevision, stage: 'jev-admission-failed', authority: failedJevAuthority, authorityRetry, retryOptions });
            jevFallbackReason = error?.name || 'decision-error';
        }
    }
    const shouldUseSidecar = shouldUseSemanticRerank && !jevHandled;
    if (shouldUseSidecar) {
        jevFallbackCount = decisionPredictive.length;
        logEvent('smart-context', 'jev-admission-fallback', {
            source,
            offeredCount: decisionPredictive.length,
            selectedCount: jevSelectedCount,
            fallbackCount: jevFallbackCount,
            reason: jevFallbackReason || 'decision-unavailable',
            sidecarCandidateCount: promptCandidates.length,
            protectedOutsideJevCount: promptCandidates.length - decisionPredictive.length,
            sidecarFallbackDeadlineMs: SMART_WARM_FALLBACK_DEADLINE_MS,
        }, 'info');
    }
    if (shouldUseSidecar) {
        const opaque = smartWarmOpaqueCandidates(promptCandidates, pins, characterWarm);
        const compact = opaque.rows;
        const structuredValidator = smartWarmSelectionValidator(opaque.allowedIds);
        const prompt = `Nexus SMART CONTEXT PREWARM

The Tree/deterministic Search service already produced the only allowed candidates below. Build a NEXT-TURN warm set, not a recap of everything recently discussed.

Evaluate candidates in TWO lanes, strictly limited to the next one or two
replies:
1. CONTINUITY — people, location, state, promises, or facts that are still actively load-bearing NOW. Return these separately in continuityEntries.
2. NEXT-BEAT PREDICTION — where the scene is moving immediately next, who is
likely to enter/continue, what action is about to happen, and what state will
probably matter on the next response. These may be warm without being current continuity.

A recently discussed topic is NOT enough by itself. Drop historical/topic cards
when the immediate scene can be written accurately without them. Do NOT warm a
card solely for a joke, a conditional promise, a hypothetical future plan, or a
possible scene change beyond the next two replies. Pins are continuity evidence,
not mandatory selections. Character Bank warm entries belong to Lead or
scene-active Supporting characters and MUST remain warm candidates, but warm
still does not mean injected. Prefer a small high-confidence warm set over
carrying an entire prior topic forward. Do not invent books, UIDs, or Tree nodes.

AUTHORITATIVE SCENE SCANNER / CHANGE-GATE INPUT
The Scene Scanner already determined what is physically present and what is only
referenced. Change Gate already classified the scene delta as ${foregroundGate?.mode || 'UNCLASSIFIED'}.
You do NOT reclassify the scene. Use this accepted state only to rank lore.
The hard minimum predictive warm budget is ${scan.warmBudgetFloor || scan.warmBudget}
for the accepted ${scan.tier} gate tier. You may raise warmBudget only when the
next one or two replies genuinely need more predictive candidates; never lower it
below the floor.

SCENE SCANNER SNAPSHOT
${JSON.stringify({scene:sceneSnapshot?.acceptedScene||null,references:sceneSnapshot?.references||null,delta:sceneSnapshot?.delta||null},null,2)}

CURRENT SCENE / NEXT-BEAT INPUT
${sceneText || chatText}

RECENT CONTINUITY CONTEXT
${tailText(chatText, 12000)}

ALLOWED TREE CANDIDATES
${compact.map(row => row.promptBlock).join('\n\n')}

OUTPUT CONTRACT
Return ONLY one JSON object with keys entries, continuityEntries, warmBudget, and reasoning.
- entries MUST be an array of opaque REF_ID strings copied exactly from ALLOWED TREE CANDIDATES.
- continuityEntries MUST be an array of opaque REF_ID strings copied exactly from ALLOWED TREE CANDIDATES and contain only cards load-bearing in the CURRENT scene, never merely predicted future cards.
- Do NOT output book/UID objects, candidate objects, titles, Tree labels, lore text, or illustrative placeholders inside either selection array.
- An intentional empty selection is valid only as an explicit empty array.
- warmBudget MUST be exactly 1, 2, or 6.
- reasoning MUST be text. Do not copy any example REF_ID; there are no illustrative selector values in this contract.`
        const dispatch = typeof enqueueSidecar === 'function'
            ? enqueueSidecar
            : (stage,options)=>enqueueNexusModelWorkerJob('reasoning',stage,{...options,role:'retrieval',mainPreferred:false,mainEligible:true});
        const job = dispatch(BUS_STAGE.SMART_WARM, structuredSidecarOptions({
            prompt,
            systemPrompt: 'You are Nexus Smart Context warming. Select only from supplied Tree-constrained candidates. Return exact JSON only.',
            reasoningEffort: 'auto',
            // Smart Warm's Sidecar pass is an optional semantic reranker over a
            // deterministic candidate/floor result. It must never hold the
            // lifecycle open for the generic 120s transport timeout; on this
            // bounded deadline the existing deterministic fallback remains
            // authoritative and the cycle can settle truthfully.
            timeoutMs: 30000,
            priority: BUS_PRIORITY.SMART_WARM,
            preemptible: true,
            maxAttempts: 1,
            dedupKey: force ? null : `smart-warm:${key}`,
            foregroundAdjacent: false,
            label: 'Smart Context prewarm',
            structuredValidator,
        }));
        const clearFallbackDeadline = armSmartWarmFallbackDeadline(job);
        try {
            const response = await job.promise;
            const afterSidecarAuthority = warmAuthorityState(requestRevision, key, hydrationLimit);
            if (!afterSidecarAuthority.current) return resolveWarmAuthorityLoss({ source, requestRevision, stage: 'after-sidecar-rerank', authority: afterSidecarAuthority, authorityRetry, retryOptions });
            const parsed = response?.structuredPayload ?? parseStructuredJsonCandidate(response.text, {
                validator: structuredValidator,
                label: 'Smart Context rerank',
            });
            const requested = parsed.entries;
            const requestedContinuity = parsed.continuityEntries;
            const selected = [];
            const selectedKeys = new Set();
            continuityRefs = resolveOpaqueWarmRefs(requestedContinuity, opaque.byId);
            continuityProvided = true;
            for (const row of resolveOpaqueWarmRefs(requested, opaque.byId)) {
                const k = refKey(row);
                if (!protectedKeys.has(k) && !selectedKeys.has(k)) { selectedKeys.add(k); semanticSelectedPredictiveKeys.add(k); selected.push(row); }
            }
            for (const row of continuityRefs) {
                const k = refKey(row);
                if (!protectedKeys.has(k) && !selectedKeys.has(k)) { selectedKeys.add(k); semanticSelectedPredictiveKeys.add(k); selected.push(row); }
            }
            const sidecarRequestedBudget = parseSidecarWarmBudget(parsed.warmBudget, scan.warmBudget);
            const warmBudgetFloor = Math.max(1, Number(scan.warmBudgetFloor || scan.warmBudget) || 1);
            const selectedBudget = Math.max(warmBudgetFloor, sidecarRequestedBudget, selected.length);
            const rankedRemainder = sidecarPredictive.filter(row => !selectedKeys.has(refKey(row)));
            selectedPredictive = [...selected, ...rankedRemainder].slice(0, selectedBudget);
            const deterministicFillCount = Math.max(0, selectedPredictive.length - selected.length);
            sidecarScan = {
                warmBudget: selectedBudget,
                requestedWarmBudget: sidecarRequestedBudget,
                warmBudgetFloor,
                authority: 'scene-scanner+change-gate',
            };
            lastWarmStats = {
                ...(lastWarmStats || {}),
                sidecarSlot: response?.tv2?.slot || null,
                sidecarSelectedCount: selected.length,
                jevHandled: false,
                jevSelectedCount,
                jevFallbackCount,
                jevFallbackReason: jevFallbackReason || 'decision-unavailable',
                selectedBudget,
                sidecarRequestedBudget,
                warmBudgetFloor,
                deterministicFillCount,
                sidecarScan,
                reasoning: parsed.reasoning || '',
                finalCount: selectedPredictive.length,
                at: Date.now(),
            };
            logEvent('smart-context', 'sidecar-rerank-complete', {
                source,
                jobId: job.id,
                slot: response?.tv2?.slot || null,
                candidateCount: compact.length,
                structuredValidated: true,
                selectionContract: 'opaque-ref-v1',
                selectedCount: selected.length,
                selectedBudget,
                sidecarRequestedBudget,
                warmBudgetFloor,
                deterministicFillCount,
                continuityCount: continuityRefs.length,
                continuityProvided,
                warmDecision: sidecarScan,
                effectivePredictiveCount: selectedPredictive.length,
                emptySelectionUsedDeterministic: selected.length === 0,
                reasoning: parsed.reasoning || '',
            }, 'info');
        } catch (error) {
            const failedSidecarAuthority = warmAuthorityState(requestRevision, key, hydrationLimit);
            if (!failedSidecarAuthority.current) return resolveWarmAuthorityLoss({ source, requestRevision, stage: 'sidecar-rerank-failed', authority: failedSidecarAuthority, authorityRetry, retryOptions });
            if (isIntentionalCancellation(error)) {
                logEvent('smart-context', 'sidecar-rerank-deferred', { source, jobId: job.id, reason: error?.name || 'foreground-preempted' }, 'debug');
                return { deferred: true, reason: 'foreground-preempted', source, requestRevision, count: 0 };
            }
            sidecarFallbackFailed = true;
            sidecarFallbackDeadlineHit = error?.name === 'TV2SmartWarmFallbackDeadline';
            if (sidecarFallbackDeadlineHit) {
                logEvent('smart-context', 'sidecar-rerank-deadline', {
                    source,
                    jobId: job.id,
                    deadlineMs: Number(error?.deadlineMs) || SMART_WARM_FALLBACK_DEADLINE_MS,
                    candidateCount: promptCandidates.length,
                    deterministicFallback: true,
                    warmBudget: scan.warmBudget,
                    selectionContract: 'opaque-ref-v1',
                }, 'warn');
            } else {
                logEvent('smart-context', 'sidecar-rerank-failed', { source, jobId: job.id, error, semantic: error?.semantic === true, validation: error?.validation || null, rejectedOutputChars: Number(error?.rejectedOutputChars) || null, deterministicFallback: true, warmBudget: scan.warmBudget, selectionContract: 'opaque-ref-v1' }, 'warn');
            }
        } finally {
            clearFallbackDeadline();
        }
    }

    if (!shouldUseSemanticRerank) {
        logEvent('smart-context', 'local-rescore-only', {
            source,
            tier: scan.tier,
            cacheFresh,
            deterministicDesiredCount: deterministicRefreshDesired.length,
            deterministicMissingCount: deterministicDrift.missingRefs.length,
            semanticCheck,
            reason: 'local relevance rescore did not require Sidecar semantic continuity check',
        }, 'debug');
    }

    const refreshDesired = continuityProvided
        ? dedupeEntryRefs([...characterWarm, ...continuityRefs])
        : dedupeEntryRefs([...characterWarm, ...selectedPredictive]);
    const finalDrift = assessWarmInjectionDrift({
        desiredRefs: refreshDesired,
        injectedRefs: retrievalState?.lastInjectedRefs || [],
        characterWarmRefs: characterWarm,
        tier: scan.tier,
        explicitContinuity: continuityProvided,
    });
    const beforeCommitAuthority = warmAuthorityState(requestRevision, key, hydrationLimit);
    if (!beforeCommitAuthority.current) return resolveWarmAuthorityLoss({ source, requestRevision, stage: 'before-shared-side-effects', authority: beforeCommitAuthority, authorityRetry, retryOptions });
    let refreshRequest = { requested: false, reason: 'not-material' };
    if ((retrievalState?.lastInjectedRefs || []).length > 0 && finalDrift.material && finalDrift.signature) {
        refreshRequest = requestWarmContextRefresh({
            signature: finalDrift.signature,
            desiredRefs: finalDrift.desiredRefs,
            missingRefs: finalDrift.missingRefs,
            reason: `smart-context continuity drift: ${finalDrift.missingRefs.length} current-scene warm ref(s) absent from live injection`,
            chatLength: Number(getContext()?.chat?.length) || 0,
        });
    }
    logEvent('smart-context', 'injection-drift-evaluated', {
        source,
        tier: finalDrift.tier,
        explicitContinuity: finalDrift.explicitContinuity,
        desiredCount: finalDrift.desiredRefs.length,
        missingCount: finalDrift.missingRefs.length,
        missingCharacterCount: finalDrift.missingCharacterRefs.length,
        material: finalDrift.material,
        signature: finalDrift.signature,
        refreshRequested: refreshRequest.requested === true,
        refreshRequestReason: refreshRequest.reason || null,
        missingRefs: finalDrift.missingRefs.map(({ book, uid, title }) => ({ book, uid, title })),
    }, finalDrift.material ? 'info' : 'debug');

    // Pin lifecycle advances on EVERY distinct warm evaluation, including cheap
    // local rescoring. Otherwise local-only cycles can keep earned pins alive
    // forever and prevent ordinary decay from ever reclaiming stale context.
    const earnedKeysBefore = new Set(earnedPins.map(refKey));
    // Jev does not own earned-pin decay. An earned pin that still survived the
    // deterministic bounded frontier may prove continuing relevance under the
    // existing Smart Context lifecycle even when Jev ranked different new warms.
    const protectedEarnedWithoutSemanticResult = (jevHandled || sidecarFallbackFailed)
        ? new Set(decisionProtectedEarned.map(refKey))
        : new Set();
    const lifecycleInput = (jevHandled || sidecarFallbackFailed)
        ? dedupeEntryRefs([...selectedPredictive, ...decisionProtectedEarned])
        : selectedPredictive;
    const lifecycleSelected = lifecycleInput.filter(ref => {
        const key = refKey(ref);
        // Semantic selection can earn NEW persistence; deterministic floor-fill
        // cannot. Existing earned pins are the narrow exception because #198
        // keeps their lifecycle outside Jev pruning, and an infrastructure
        // failure in the fail-open Sidecar must not be treated as negative
        // semantic evidence against a still-relevant earned pin.
        if (shouldUseSemanticRerank && !semanticSelectedPredictiveKeys.has(key) && !protectedEarnedWithoutSemanticResult.has(key)) return false;
        if (!earnedKeysBefore.has(key)) return true;
        if (semanticSelectedPredictiveKeys.has(key) || protectedEarnedWithoutSemanticResult.has(key)) return true;
        const matched = Array.isArray(ref?.matched) ? ref.matched : [];
        // On local-only evaluations an existing earned card must still have fresh
        // scene evidence beyond its own warm/pin boost to refresh its lifecycle.
        return matched.some(kind => kind !== 'warm-boost' && kind !== 'pinned-boost');
    });
    const earned = updateEarnedPins(lifecycleSelected, characterWarm, settings, {
        evaluationKey,
        gateMode: String(foregroundGate?.mode || scan?.basis?.mode || ''),
        sceneTier: String(scan.tier || ''),
        source,
    });
    const effectivePins = getPinnedRefs();
    candidates = dedupeEntryRefs([...effectivePins, ...characterWarm, ...selectedPredictive]);
    // Reuse authority is intentionally narrower than the warm cache. Character
    // Bank refs are current-scene deterministic authority; Sidecar refs qualify
    // only when explicitly returned through the CONTINUITY lane.
    warmReuseAuthorityRefs = dedupeEntryRefs([
        ...currentSceneCharacterReuseRefs(characterWarm),
        ...(continuityProvided ? continuityRefs : []),
    ]);
    warmReuseAuthorityKey = cacheKeyFor(chatText, effectivePins, books, characterWarm, getSettings());
    lastWarmStats = {
        ...(lastWarmStats || {}),
        sceneTier: scan.tier,
        warmBudget: sidecarScan?.warmBudget || scan.warmBudget,
        autoPins: earned.pins.length,
        earnedPinsPromoted: earned.promoted.length,
        earnedPinsDemoted: earned.expired.length,
        finalCount: candidates.length,
        at: Date.now(),
    };

    warmCache = candidates;
    // Earned-pin promotion/demotion can change persistent pin authority during
    // this pass; publish the cache under the post-lifecycle key, not the stale
    // pre-lifecycle key that started the request.
    warmCacheKey = cacheKeyFor(chatText, getPinnedRefs(), books, characterWarm);
    warmCachePolicyKey = smartContextPolicyKey(getSettings());
    warmCachedAt = Date.now();
    lastWarmStats = { ...(lastWarmStats || {}), finalCount: candidates.length, at: warmCachedAt };
    notifySmartContextUpdated();
    logEvent('smart-context', 'prewarm-complete', {
        source,
        count: candidates.length,
        pinnedCount: effectivePins.length,
        activePinCount: getActivePinnedRefs().length,
        manualPinCount: getManualPinnedRefs().length,
        earnedPinCount: getEarnedPinnedRefs().length,
        earnedPinsPromoted: earned.promoted.length,
        earnedPinsDemoted: earned.expired.length,
        characterWarmCount: characterWarm.length,
        sceneReferenceWarmCount: sceneReferenceWarm.length,
        predictiveCount: selectedPredictive.length,
        sceneTier: scan.tier,
        warmBudget: sidecarScan?.warmBudget || scan.warmBudget,
        autoPinCount: earned.pins.length,
        localRescoreOnly: !shouldUseSemanticRerank,
        semanticRerankUsed: shouldUseSemanticRerank,
        jevHandled,
        deterministicOfferedCount: decisionPredictive.length,
        protectedEarnedOutsideJevCount: decisionProtectedEarned.length,
        jevSelectedCount,
        jevFallbackCount,
        jevFallbackReason,
        sidecarFallbackUsed: shouldUseSidecar,
        sidecarFallbackDeadlineMs: shouldUseSidecar ? SMART_WARM_FALLBACK_DEADLINE_MS : null,
        sidecarFallbackDeadlineHit,
        sidecarFallbackFailed,
        finalWarmCount: candidates.length,
        semanticCheck,
        injectionRefreshRequested: refreshRequest.requested === true,
        refs: candidates.map(({ book, uid, title, nodeId, nodeLabel }) => ({ book, uid, title, nodeId, nodeLabel })),
    }, 'info');
    return { count: candidates.length, pinnedCount: effectivePins.length, characterWarmCount: characterWarm.length, predictiveCount: selectedPredictive.length, sceneTier: scan.tier, warmBudget: sidecarScan?.warmBudget || scan.warmBudget, autoPinCount: earned.pins.length, localRescoreOnly: !shouldUseSemanticRerank, semanticRerankUsed: shouldUseSemanticRerank, jevHandled, jevSelectedCount, jevFallbackCount, jevFallbackReason, sidecarFallbackUsed: shouldUseSidecar, semanticCheck, injectionRefreshRequested: refreshRequest.requested === true, slot: lastWarmStats?.sidecarSlot || null, reasoning: lastWarmStats?.reasoning || '' };
}

/** Export persistent Smart Context state. Warm candidates are intentionally not
 * exported because they are speculative/cache data and should be recomputed. */
export function exportSmartContextState({ manualOnly = false } = {}) {
    const store = metaStore();
    return {
        version: 1,
        manualPins: (store.manualPins || []).map(ref => ({ ...ref })),
        activePins: manualOnly ? [] : (store.activePins || []).map(ref => ({ ...ref })),
        lastPinnedAt: Number(store.lastPinnedAt) || 0,
    };
}

/** Build the exact persistent Smart Context projection an import would create
 * without mutating chat state. Backup-import recovery uses this to capture its
 * post-image before durable intent crosses either host domain. */
export function previewSmartContextStateImport(state = {}, { merge = true, manualOnly = false, baseState = null, at = Date.now() } = {}) {
    const base = baseState && typeof baseState === 'object' ? JSON.parse(JSON.stringify(baseState)) : exportSmartContextState({ manualOnly: false });
    const incomingManual = dedupeEntryRefs((state.manualPins || []).map(ref => cleanRef(ref, 'manual')).filter(Boolean));
    const incomingActive = manualOnly ? [] : dedupeEntryRefs((state.activePins || []).map(ref => cleanRef(ref, 'imported-active')).filter(Boolean));
    return {
        version: 1,
        manualPins: merge ? dedupeEntryRefs([...(base.manualPins || []), ...incomingManual]) : incomingManual,
        activePins: manualOnly ? [...(base.activePins || [])] : (merge ? dedupeEntryRefs([...(base.activePins || []), ...incomingActive]) : incomingActive),
        lastPinnedAt: Number(at) || Date.now(),
    };
}

/** Import persistent pins into the current chat. Active injection pins are
 * normally excluded because they describe a previous prompt boundary. */
export function importSmartContextState(state = {}, { merge = true, manualOnly = false, at = Date.now() } = {}) {
    const context = getContext();
    if (!context?.chatMetadata) throw new Error('No active chat metadata is available for Smart Context import.');
    const store = metaStore();
    const before = exportSmartContextState({ manualOnly: false });
    const preview = previewSmartContextStateImport(state,{merge,manualOnly,baseState:before,at});
    store.manualPins = preview.manualPins;
    if (!manualOnly) store.activePins = preview.activePins;
    store.lastPinnedAt = preview.lastPinnedAt;
    saveMeta();
    invalidateSmartContext('smart-context-state-import');
    const result = { manualPins: preview.manualPins.length, activePins: manualOnly ? 0 : preview.activePins.length, merge, manualOnly };
    logEvent('smart-context', 'state-imported', result, 'info');
    return result;
}
