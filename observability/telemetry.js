import { isIntentionalCancellation } from '../core/cancellation.js';
import { formatTokenCount } from './token-estimator.js';
import { currentNexusChatEpoch } from '../nexus/work-scope.js';
import { createAdaptiveProfileKey, recordThroughputSample, getThroughputProfileSnapshot } from '../nexus/adaptive-throughput.js';

const STORAGE_KEY = 'tv2:telemetry:v1';
const CHANGE_EVENT = 'tv2:telemetry-changed';
const DEFAULT_CONFIG = Object.freeze({
    maxEvents: 500,
    captureChars: 4000,
    persistSession: true,
    capturePayloads: true,
});

let config = { ...DEFAULT_CONFIG };
let sequence = 0;
let loaded = false;
let persistTimer = null;
const listeners = new Set();

function emptySidecar(slot) {
    return {
        slot,
        calls: 0,
        successes: 0,
        failures: 0,
        cancellations: 0,
        estimatedInputTokens: 0,
        estimatedObservedTokens: 0,
        actualInputTokens: 0,
        outputTokens: 0,
        visibleOutputTokens: 0,
        reasoningTokens: 0,
        cachedInputTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 0,
        latencyMs: 0,
        maxLatencyMs: 0,
        assignedJobs: 0,
        preferredJobs: 0,
        offloadsReceived: 0,
        offloadsSent: 0,
        fallbacksReceived: 0,
        fallbacksSent: 0,
        multiAssignments: 0,
        reviewAssignments: 0,
        cascadeAssignments: 0,
        currentPlan: null,
        active: null,
        last: null,
    };
}

function emptyLatestDiagnostics() {
    return {
        promptLoader: { chatCompletion: null, textCompletion: null, adapterVerification: null },
        generationFrameApplied: null,
        retrievalPresentationCache: null,
        mainContext: null,
    };
}

function emptyWarmInjectionMetrics() {
    return {
        samples: 0,
        freshSamples: 0,
        reuseSamples: 0,
        warmObserved: 0,
        injectedObserved: 0,
        warmInjected: 0,
        unusedWarm: 0,
        injectedOutsideWarm: 0,
        freshWarmObserved: 0,
        freshInjectedObserved: 0,
        freshWarmInjected: 0,
        warmUseRatePct: null,
        injectionFromWarmPct: null,
        freshWarmUseRatePct: null,
        freshInjectionFromWarmPct: null,
        last: null,
    };
}

const state = {
    events: [],
    sidecars: { A: emptySidecar('A'), B: emptySidecar('B') },
    metrics: { warmInjection: emptyWarmInjectionMetrics() },
    // Critical latest observations live outside the bounded event ring so a
    // noisy post-turn cycle cannot erase the last real Main-prompt evidence.
    latest: emptyLatestDiagnostics(),
};

function clone(v) {
    try { return structuredClone(v); } catch {}
    try { return JSON.parse(JSON.stringify(v)); } catch { return v; }
}

function clip(value, limit = config.captureChars) {
    const text = String(value ?? '');
    if (!limit || text.length <= limit) return text;
    const half = Math.max(1, Math.floor((limit - 80) / 2));
    return `${text.slice(0, half)}\n… [${text.length - (half * 2)} chars omitted] …\n${text.slice(-half)}`;
}

const SECRET_KEYS = new Set(['apikey', 'api_key', 'authorization', 'x-api-key', 'x_api_key', 'secret', 'password', 'bearer', 'token', 'access_token', 'refresh_token']);
const PAYLOAD_KEYS = new Set(['prompt','systemprompt','response','reasoning','providerresponse','providererror','responsepreview','rejectedoutputsample','raw','body']);

// Redaction must follow credentials even when providers embed them inside a
// free-form Error/message/string instead of a well-named object field. Keep the
// patterns deliberately credential-shaped so ordinary prose is not erased.
function redactSecretText(input) {
    let text = String(input ?? '');
    text = text.replace(/(\bBearer\s+)[A-Za-z0-9._~+\/=-]+/gi, '$1[REDACTED]');
    text = text.replace(/(\b(?:api[_-]?key|x-api-key|authorization|access[_-]?token|refresh[_-]?token|secret|password)\b\s*[:=]\s*)([\"']?)([^\s,;&\"']+)(\2)/gi, '$1$2[REDACTED]$4');
    text = text.replace(/([?&](?:api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password)=)[^&#\s]*/gi, '$1[REDACTED]');
    text = text.replace(/(https?:\/\/[^\s\/@:]+:)[^@\s/]+@/gi, '$1[REDACTED]@');
    text = text.replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[REDACTED]');
    return text;
}
function sanitize(value, depth = 0, keyName = '') {
    if (depth > 7) return '[depth-limit]';
    const normalizedKey = String(keyName || '').toLowerCase();
    if (SECRET_KEYS.has(normalizedKey)) return '[REDACTED]';
    if (!config.capturePayloads && PAYLOAD_KEYS.has(normalizedKey)) return undefined;
    if (typeof value === 'string') return clip(redactSecretText(value));
    if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
    if (value instanceof Error) {
        const out = { name: redactSecretText(value.name), message: clip(redactSecretText(value.message)), stack: clip(redactSecretText(value.stack || ''), 2000) };
        for (const key of ['httpStatus', 'http', 'providerError', 'responsePreview', 'code', 'cause', 'semantic', 'validation', 'rejectedOutputSample', 'rejectedOutputChars', 'reasoningExhaustion']) {
            if (value[key] !== undefined) { const safe = sanitize(value[key], depth + 1, key); if (safe !== undefined) out[key] = safe; }
        }
        return out;
    }
    if (Array.isArray(value)) return value.slice(0, 100).map(v => sanitize(v, depth + 1));
    if (typeof value === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(value)) { const safe = sanitize(v, depth + 1, k); if (safe !== undefined) out[k] = safe; }
        return out;
    }
    return clip(redactSecretText(String(value)));
}

function safeSessionStorage() {
    try { return globalThis?.sessionStorage || null; } catch { return null; }
}

function persistNow() {
    if (!config.persistSession) return;
    const storage = safeSessionStorage();
    if (!storage) return;
    try {
        const payload = JSON.stringify({ sequence, events: state.events, sidecars: state.sidecars, metrics: state.metrics, latest: state.latest });
        storage.setItem(STORAGE_KEY, payload);
    } catch {
        // Session storage quotas vary. Preserve the most recent half rather than
        // allowing diagnostics themselves to destabilize the extension.
        if (state.events.length > 50) {
            state.events.splice(0, Math.ceil(state.events.length / 2));
            try { storage.setItem(STORAGE_KEY, JSON.stringify({ sequence, events: state.events, sidecars: state.sidecars, metrics: state.metrics, latest: state.latest })); } catch {}
        }
    }
}

function schedulePersist({ immediate = false } = {}) {
    if (!config.persistSession || !safeSessionStorage()) return;
    if (immediate) {
        if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
        persistNow();
        return;
    }
    if (persistTimer) return;
    persistTimer = setTimeout(() => { persistTimer = null; persistNow(); }, 250);
}

function loadOnce() {
    if (loaded) return;
    loaded = true;
    if (!config.persistSession) return;
    const storage = safeSessionStorage();
    if (!storage) return;
    try {
        const raw = storage.getItem(STORAGE_KEY);
        if (!raw) return;
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed?.events)) state.events = parsed.events.slice(-config.maxEvents);
        if (parsed?.sidecars?.A) state.sidecars.A = { ...emptySidecar('A'), ...parsed.sidecars.A, active: null, currentPlan: null };
        if (parsed?.sidecars?.B) state.sidecars.B = { ...emptySidecar('B'), ...parsed.sidecars.B, active: null, currentPlan: null };
        if (parsed?.metrics?.warmInjection) state.metrics.warmInjection = { ...emptyWarmInjectionMetrics(), ...parsed.metrics.warmInjection };
        if (parsed?.latest && typeof parsed.latest === 'object') {
            state.latest = {
                ...emptyLatestDiagnostics(),
                ...parsed.latest,
                promptLoader: { ...emptyLatestDiagnostics().promptLoader, ...(parsed.latest.promptLoader || {}) },
            };
        }
        sequence = Number(parsed?.sequence) || state.events.length;
    } catch {}
}

function notify(record = null) {
    // Most listeners only need an invalidation signal. Build a full diagnostics
    // snapshot lazily only for the rare two-argument listener that explicitly
    // consumes it, instead of cloning megabytes once per telemetry event.
    let snapshot = null;
    for (const fn of listeners) {
        try {
            if (fn.length >= 2) { snapshot ||= getTelemetrySnapshot(); fn(record, snapshot); }
            else fn(record);
        } catch {}
    }
    try { globalThis.window?.dispatchEvent?.(new CustomEvent(CHANGE_EVENT, { detail: { record } })); } catch {}
}

export function configureTelemetry(next = {}) {
    config = {
        ...config,
        ...next,
        maxEvents: Math.max(50, Math.min(5000, Number(next.maxEvents ?? config.maxEvents) || DEFAULT_CONFIG.maxEvents)),
        captureChars: Math.max(0, Math.min(50000, Number.isFinite(Number(next.captureChars ?? config.captureChars)) ? Number(next.captureChars ?? config.captureChars) : DEFAULT_CONFIG.captureChars)),
    };
    loadOnce();
    if (state.events.length > config.maxEvents) state.events.splice(0, state.events.length - config.maxEvents);
    schedulePersist({ immediate: true });
}

export function getTelemetryChangeEventName() { return CHANGE_EVENT; }
export function onTelemetryChange(fn) { loadOnce(); listeners.add(fn); return () => listeners.delete(fn); }

export function logEvent(category, name, data = {}, level = 'info') {
    loadOnce();
    const record = {
        id: `tv2_evt_${Date.now()}_${++sequence}`,
        ts: Date.now(),
        level: ['debug', 'info', 'warn', 'error'].includes(level) ? level : 'info',
        category: String(category || 'general'),
        name: String(name || 'event'),
        data: sanitize(data),
    };
    state.events.push(record);
    // Preserve only actual (non-dry-run) final prompt observations here. Dry
    // runs remain in the event ring for debugging but must not replace the last
    // physical Main request shown in diagnostics.
    if (record.category === 'prompt-loader' && record.name === 'chat-completion-ready' && record.data?.dryRun !== true) state.latest.promptLoader.chatCompletion = clone(record);
    if (record.category === 'prompt-loader' && record.name === 'text-completion-ready' && record.data?.dryRun !== true) state.latest.promptLoader.textCompletion = clone(record);
    if (record.category === 'prompt-loader' && (record.name === 'adapter-verified' || record.name === 'adapter-mismatch')) state.latest.promptLoader.adapterVerification = clone(record);
    if (record.category === 'generation-frame' && record.name === 'applied') state.latest.generationFrameApplied = clone(record);
    if (record.category === 'retrieval' && (record.name === 'presentation-cache-analysis' || record.name === 'presentation-cache-shadow')) state.latest.retrievalPresentationCache = clone(record);
    if (record.category === 'main-context' && /^cache-epoch-/.test(record.name)) state.latest.mainContext = clone(record);
    while (state.events.length > config.maxEvents) state.events.shift();
    schedulePersist();
    notify(record);
    return record;
}

function canonicalLoreRefKey(ref) {
    const book = String(ref?.book || '');
    const uid = Number(ref?.uid);
    return book && Number.isFinite(uid) ? JSON.stringify([book, uid]) : '';
}

export function recordWarmInjectionUtilization({
    warmRefs = [],
    injectedRefs = [],
    reused = false,
    generationId = null,
    sceneRevision = null,
    gateMode = null,
    source = 'retrieval',
} = {}) {
    loadOnce();
    const warmKeys = new Set((Array.isArray(warmRefs) ? warmRefs : []).map(canonicalLoreRefKey).filter(Boolean));
    const injectedKeys = new Set((Array.isArray(injectedRefs) ? injectedRefs : []).map(canonicalLoreRefKey).filter(Boolean));
    let overlap = 0;
    for (const key of warmKeys) if (injectedKeys.has(key)) overlap += 1;
    const warmCount = warmKeys.size;
    const injectedCount = injectedKeys.size;
    const unusedWarmCount = Math.max(0, warmCount - overlap);
    const outsideWarmInjectedCount = Math.max(0, injectedCount - overlap);
    const warmUseRatePct = warmCount ? Math.round((overlap / warmCount) * 1000) / 10 : null;
    const injectionFromWarmPct = injectedCount ? Math.round((overlap / injectedCount) * 1000) / 10 : null;
    const sample = sanitize({
        source,
        reused: reused === true,
        generationId,
        sceneRevision,
        gateMode,
        warmCount,
        injectedCount,
        warmInjectedCount: overlap,
        unusedWarmCount,
        outsideWarmInjectedCount,
        warmUseRatePct,
        injectionFromWarmPct,
        recordedAt: Date.now(),
    });
    const metrics = state.metrics.warmInjection || (state.metrics.warmInjection = emptyWarmInjectionMetrics());
    metrics.samples += 1;
    if (reused) metrics.reuseSamples += 1;
    else metrics.freshSamples += 1;
    metrics.warmObserved += warmCount;
    metrics.injectedObserved += injectedCount;
    metrics.warmInjected += overlap;
    metrics.unusedWarm += unusedWarmCount;
    metrics.injectedOutsideWarm += outsideWarmInjectedCount;
    metrics.warmUseRatePct = metrics.warmObserved ? Math.round((metrics.warmInjected / metrics.warmObserved) * 1000) / 10 : null;
    metrics.injectionFromWarmPct = metrics.injectedObserved ? Math.round((metrics.warmInjected / metrics.injectedObserved) * 1000) / 10 : null;
    if (!reused) {
        metrics.freshWarmObserved = Number(metrics.freshWarmObserved || 0) + warmCount;
        metrics.freshInjectedObserved = Number(metrics.freshInjectedObserved || 0) + injectedCount;
        metrics.freshWarmInjected = Number(metrics.freshWarmInjected || 0) + overlap;
        metrics.freshWarmUseRatePct = metrics.freshWarmObserved ? Math.round((metrics.freshWarmInjected / metrics.freshWarmObserved) * 1000) / 10 : null;
        metrics.freshInjectionFromWarmPct = metrics.freshInjectedObserved ? Math.round((metrics.freshWarmInjected / metrics.freshInjectedObserved) * 1000) / 10 : null;
    }
    metrics.last = sample;
    // Diagnostics need this trace, but the ordinary Nexus Feed does not need a
    // new row every turn. The cumulative metrics are exported in the snapshot.
    logEvent('smart-context', 'warm-injection-utilization', sample, 'debug');
    schedulePersist();
    return clone(sample);
}


export function recordWorkloadDecision(decision = {}) {
    loadOnce();
    const preferred = String(decision.preferredSlot || '').toUpperCase();
    const assigned = String(decision.assignedSlot || '').toUpperCase();
    if (assigned === 'A' || assigned === 'B') {
        const assignedStats = state.sidecars[assigned] || (state.sidecars[assigned] = emptySidecar(assigned));
        assignedStats.assignedJobs += 1;
        if (assigned === preferred) assignedStats.preferredJobs += 1;
        else assignedStats.offloadsReceived += 1;
    }
    if ((preferred === 'A' || preferred === 'B') && assigned && assigned !== preferred) {
        const preferredStats = state.sidecars[preferred] || (state.sidecars[preferred] = emptySidecar(preferred));
        preferredStats.offloadsSent += 1;
    }
    return logEvent('workload', decision.offloaded ? 'job-offloaded' : 'job-assigned', decision, decision.offloaded ? 'info' : 'debug');
}

export function recordMultiWorkloadAssignment(event = {}) {
    loadOnce();
    const slot = String(event.assignedSlot || event.slot || '').toUpperCase();
    if (slot === 'A' || slot === 'B') {
        const stats = state.sidecars[slot] || (state.sidecars[slot] = emptySidecar(slot));
        stats.assignedJobs += 1;
        stats.multiAssignments += 1;
        const phase = String(event.phase || '').toLowerCase();
        if (phase.includes('review') || phase.includes('synthesis')) stats.reviewAssignments += 1;
        if (phase.includes('cascade')) stats.cascadeAssignments += 1;
    }
    return logEvent('workload', 'multi-job-assigned', event, 'debug');
}

export function recordWorkloadFallback(event = {}) {
    loadOnce();
    const from = String(event.fromSlot || '').toUpperCase();
    const to = String(event.toSlot || '').toUpperCase();
    if (from === 'A' || from === 'B') {
        const stats = state.sidecars[from] || (state.sidecars[from] = emptySidecar(from));
        stats.fallbacksSent += 1;
    }
    if (to === 'A' || to === 'B') {
        const stats = state.sidecars[to] || (state.sidecars[to] = emptySidecar(to));
        stats.fallbacksReceived += 1;
    }
    return logEvent('workload', 'failure-fallback', event, 'warn');
}

export function recordSidecarPlan(meta = {}) {
    if (staleTelemetryMeta(meta)) return null;
    loadOnce();
    const slot = String(meta.slot || 'A').toUpperCase();
    const stats = state.sidecars[slot] || (state.sidecars[slot] = emptySidecar(slot));
    const source = config.capturePayloads ? meta : (({ prompt, systemPrompt, ...rest }) => rest)(meta);
    const plan = sanitize({ ...source, plannedAt: Date.now() });
    stats.currentPlan = plan;
    stats.estimatedInputTokens += Number(meta.estimate?.inputTokens) || 0;
    logEvent(`sidecar-${slot.toLowerCase()}`, 'plan', plan, 'debug');
}

export function recordSidecarStart(meta = {}) {
    if (staleTelemetryMeta(meta)) return null;
    loadOnce();
    const slot = String(meta.slot || 'A').toUpperCase();
    const stats = state.sidecars[slot] || (state.sidecars[slot] = emptySidecar(slot));
    const source = config.capturePayloads ? meta : (({ prompt, systemPrompt, ...rest }) => rest)(meta);
    stats.active = sanitize({ ...source, startedAt: Date.now() });
    stats.currentPlan = stats.currentPlan || sanitize(source);
    logEvent(`sidecar-${slot.toLowerCase()}`, 'request-start', source, 'info');
}

function staleTelemetryMeta(meta = {}) {
    const epoch=Number(meta?.nexusChatEpoch);
    return Number.isFinite(epoch) && epoch > 0 && epoch !== currentNexusChatEpoch();
}

function numberOrZero(v) { return Number.isFinite(Number(v)) ? Number(v) : 0; }

function recordAdaptiveSidecarThroughput(meta = {}, { latencyMs = 0, outcome = 'success', successfulItems = null } = {}) {
    const workloadType = String(meta?.adaptiveWorkloadType || '').trim();
    const batchItems = Math.max(0, Number(meta?.adaptiveBatchItems) || 0);
    if (!workloadType || !batchItems) return;
    const contractVersion = String(meta?.adaptiveContractVersion || 'v1');
    const sample = {
        batchSize: batchItems,
        successfulItems: successfulItems == null ? (outcome === 'success' ? batchItems : 0) : Math.max(0, Number(successfulItems) || 0),
        latencyMs: Math.max(0, Number(latencyMs) || 0),
        outcome,
        inputTokens: numberOrZero(meta?.adaptiveObservedInputTokens ?? meta?.estimate?.inputTokens),
        outputTokens: numberOrZero(meta?.adaptiveObservedOutputTokens),
        providerContextTokens: numberOrZero(meta?.providerContextTokens ?? meta?.physicalContextLimitTokens),
        requestMaxTokens: numberOrZero(meta?.physicalRequestMaxTokens ?? meta?.requestMaxTokens),
    };
    recordThroughputSample({
        profileKey:createAdaptiveProfileKey({
            workloadType,
            provider:String(meta?.format || 'unknown'),
            profile:String(meta?.endpointHost || 'unknown'),
            model:String(meta?.model || 'unknown'),
            worker:String(meta?.slot || 'AUTO'),
            contractVersion,
        }),
        ...sample,
    });
    // Fleet aggregate is retained for workloads whose physical envelope must be
    // composed before the Bus selects a lane. Lane-aware dispatchers should use
    // their exact physical profile instead.
    recordThroughputSample({
        profileKey:createAdaptiveProfileKey({workloadType,provider:'AUTO',profile:'AUTO',model:'AUTO',worker:'AUTO',contractVersion}),
        ...sample,
    });
}
function sidecarFailureKind(error){
    const name=String(error?.name||''),message=String(error?.message||''),status=Number(error?.httpStatus??error?.status??error?.http?.status);
    if(isIntentionalCancellation(error))return 'caller-cancellation';
    if(name==='TV2SidecarTimeout')return 'transport-deadline';
    if(name==='NexusSidecarReasoningExhausted')return 'reasoning-exhaustion';
    if(name==='TV2SidecarTruncated'||/output boundary/i.test(message))return 'output-boundary';
    if(Number.isFinite(status)&&status===429)return 'provider-capacity-or-rate-limit';
    if(Number.isFinite(status)&&[400,404,405,413,415,422].includes(status))return 'request-shape-compatibility';
    if(name==='TypeError'&&/fetch|network|socket|connection|proxy/i.test(message))return 'network-or-proxy';
    if(Number.isFinite(status)&&status>=500)return 'provider-server';
    return 'provider-or-transport';
}

export function recordSidecarResult(meta = {}, result = {}, latencyMs = 0) {
    if (staleTelemetryMeta(meta)) return null;
    loadOnce();
    const slot = String(meta.slot || 'A').toUpperCase();
    const stats = state.sidecars[slot] || (state.sidecars[slot] = emptySidecar(slot));
    const usage = result?.usageNormalized || {};
    stats.calls += 1;
    stats.successes += 1;
    stats.actualInputTokens += numberOrZero(usage.inputTokens);
    stats.outputTokens += numberOrZero(usage.outputTokens);
    stats.visibleOutputTokens += numberOrZero(usage.visibleOutputTokens);
    stats.reasoningTokens += numberOrZero(usage.reasoningTokens);
    stats.cachedInputTokens += numberOrZero(usage.cachedInputTokens);
    stats.cacheWriteTokens += numberOrZero(usage.cacheWriteTokens);
    stats.totalTokens += numberOrZero(usage.totalTokens);
    stats.estimatedObservedTokens += numberOrZero(result?.usageEstimated?.totalTokens);
    stats.latencyMs += numberOrZero(latencyMs);
    stats.maxLatencyMs = Math.max(stats.maxLatencyMs, numberOrZero(latencyMs));
    stats.last = sanitize({
        ok: true,
        ...meta,
        latencyMs,
        finishReason: result?.finishReason || null,
        http: result?.http || null,
        usage,
        usageEstimated: result?.usageEstimated || null,
        resourceCompliance: result?.resourceCompliance || null,
        responseChars: String(result?.text || '').length,
        reasoningChars: String(result?.reasoning || '').length,
        response: config.capturePayloads ? result?.text || '' : undefined,
        reasoning: config.capturePayloads ? result?.reasoning || '' : undefined,
        providerResponse: config.capturePayloads ? result?.raw || null : undefined,
        endedAt: Date.now(),
    });
    stats.active = null;
    stats.currentPlan = null;
    recordAdaptiveSidecarThroughput({
        ...meta,
        adaptiveObservedInputTokens: numberOrZero(usage.inputTokens) || numberOrZero(meta?.estimate?.inputTokens),
        adaptiveObservedOutputTokens: numberOrZero(usage.outputTokens) || numberOrZero(result?.usageEstimated?.outputTokens),
    },{latencyMs,outcome:'success',successfulItems:Number(meta?.adaptiveBatchItems)||1});
    logEvent(`sidecar-${slot.toLowerCase()}`, 'request-success', stats.last, 'info');
}

export function recordSidecarError(meta = {}, error, latencyMs = 0) {
    if (staleTelemetryMeta(meta)) return null;
    loadOnce();
    const slot = String(meta.slot || 'A').toUpperCase();
    const stats = state.sidecars[slot] || (state.sidecars[slot] = emptySidecar(slot));
    stats.calls += 1;
    const cancelled = isIntentionalCancellation(error);
    const recoverableSemantic = meta?.recoverableSemanticAttempt === true && error?.semantic === true;
    if (cancelled) stats.cancellations += 1;
    else if (recoverableSemantic) stats.recoverableSemanticFailures = numberOrZero(stats.recoverableSemanticFailures) + 1;
    else stats.failures += 1;
    const failedResult = error?.sidecarResult || null;
    const usage = failedResult?.usageNormalized || {};
    stats.actualInputTokens += numberOrZero(usage.inputTokens);
    stats.outputTokens += numberOrZero(usage.outputTokens);
    stats.visibleOutputTokens += numberOrZero(usage.visibleOutputTokens);
    stats.reasoningTokens += numberOrZero(usage.reasoningTokens);
    stats.cachedInputTokens += numberOrZero(usage.cachedInputTokens);
    stats.cacheWriteTokens += numberOrZero(usage.cacheWriteTokens);
    stats.totalTokens += numberOrZero(usage.totalTokens);
    stats.estimatedObservedTokens += numberOrZero(failedResult?.usageEstimated?.totalTokens);
    stats.latencyMs += numberOrZero(latencyMs);
    stats.maxLatencyMs = Math.max(stats.maxLatencyMs, numberOrZero(latencyMs));
    stats.last = sanitize({
        ok: false,
        cancelled,
        recoverableSemanticFailure: recoverableSemantic,
        failureKind: sidecarFailureKind(error),
        ...meta,
        latencyMs,
        error,
        semanticValidation: error?.validation || null,
        reasoningExhaustion: error?.reasoningExhaustion || null,
        rejectedOutputChars: Number.isFinite(Number(error?.rejectedOutputChars)) ? Number(error.rejectedOutputChars) : null,
        rejectedOutputSample: config.capturePayloads ? (error?.rejectedOutputSample || error?.validation?.rejectedOutputSample || '') : undefined,
        finishReason: failedResult?.finishReason || null,
        http: failedResult?.http || error?.http || (error?.httpStatus ? {status:error.httpStatus} : null),
        usage,
        usageEstimated: failedResult?.usageEstimated || null,
        resourceCompliance: failedResult?.resourceCompliance || null,
        responseChars: String(failedResult?.text || '').length,
        reasoningChars: String(failedResult?.reasoning || '').length,
        response: config.capturePayloads ? failedResult?.text || '' : undefined,
        reasoning: config.capturePayloads ? failedResult?.reasoning || '' : undefined,
        providerResponse: config.capturePayloads ? failedResult?.raw || null : undefined,
        endedAt: Date.now(),
    });
    stats.active = null;
    stats.currentPlan = null;
    const adaptiveFailureKind = sidecarFailureKind(error);
    const adaptiveOutcome = cancelled ? 'cancelled' : (adaptiveFailureKind === 'transport-deadline' ? 'timeout' : (adaptiveFailureKind === 'output-boundary' ? 'truncated' : 'failure'));
    if (!cancelled && !recoverableSemantic) recordAdaptiveSidecarThroughput({
        ...meta,
        adaptiveObservedInputTokens: numberOrZero(usage.inputTokens) || numberOrZero(meta?.estimate?.inputTokens),
        adaptiveObservedOutputTokens: numberOrZero(usage.outputTokens) || numberOrZero(failedResult?.usageEstimated?.outputTokens),
    },{latencyMs,outcome:adaptiveOutcome,successfulItems:0});
    const eventName = cancelled ? 'request-cancelled' : (recoverableSemantic ? 'request-semantic-repair-needed' : 'request-failure');
    const eventLevel = cancelled ? 'debug' : (recoverableSemantic ? 'warn' : 'error');
    logEvent(`sidecar-${slot.toLowerCase()}`, eventName, stats.last, eventLevel);
}

export function recordJobLifecycle(job = {}) {
    const data = {
        id: job.id,
        label: job.label,
        state: job.state,
        priority: job.priority,
        resourceKey: job.resourceKey,
        attempts: job.attempts,
        maxAttempts: job.maxAttempts,
        foregroundAdjacent: job.foregroundAdjacent,
        createdAt: job.createdAt,
        startedAt: job.startedAt,
        endedAt: job.endedAt,
        durationMs: job.startedAt && job.endedAt ? Math.max(0, job.endedAt - job.startedAt) : null,
        meta: job.meta || null,
        error: job.error || null,
    };
    const recoverableSemantic = job.state === 'failed' && job.meta?.recoverableSemanticAttempt === true && job.error?.semantic === true;
    const level = recoverableSemantic ? 'warn' : (job.state === 'failed' ? 'error' : job.state === 'cancelled' ? 'warn' : 'debug');
    return logEvent('scheduler', `job-${job.state || 'changed'}`, data, level);
}

export function getTelemetrySnapshot() {
    loadOnce();
    return clone({
        config,
        events: state.events,
        sidecars: state.sidecars,
        metrics: state.metrics,
        latest: state.latest,
        adaptiveThroughput: getThroughputProfileSnapshot(),
    });
}

// Activity Feed does not need metrics/latest/adaptive-throughput state. Keep its
// normal render path on a smaller clone, and give the closed badge an even
// lighter metadata-only view so diagnostics cannot become foreground work.
export function getTelemetryActivitySnapshot({ metadataOnly = false } = {}) {
    loadOnce();
    const sidecarStatus = slot => {
        const row = state.sidecars?.[slot] || emptySidecar(slot);
        return metadataOnly ? {
            active: row.active ? { id:row.active.id || null } : null,
            totalTokens: numberOrZero(row.totalTokens),
            last: row.last ? { ok: row.last.ok !== false } : null,
        } : row;
    };
    const events = metadataOnly
        ? state.events.map(evt => ({ ts:evt.ts, level:evt.level, category:evt.category, name:evt.name }))
        : state.events;
    const snapshot = {
        events,
        sidecars: { A:sidecarStatus('A'), B:sidecarStatus('B') },
    };
    return metadataOnly ? snapshot : clone(snapshot);
}

export function getTelemetrySidecarSnapshot() {
    loadOnce();
    return clone({ sidecars: state.sidecars });
}

export function clearTelemetry({ keepTotals = false } = {}) {
    loadOnce();
    state.events.length = 0;
    if (!keepTotals) {
        state.sidecars.A = emptySidecar('A');
        state.sidecars.B = emptySidecar('B');
        state.metrics.warmInjection = emptyWarmInjectionMetrics();
        state.latest = emptyLatestDiagnostics();
    }
    try { sessionStorage.removeItem(STORAGE_KEY); } catch {}
    schedulePersist({ immediate: true });
    notify(null);
}

export function exportTelemetryObject() {
    const snapshot = getTelemetrySnapshot();
    return {
        exportedAt: new Date().toISOString(),
        version: 'tv2-telemetry-v1',
        ...snapshot,
    };
}

export function downloadTelemetryExport() {
    const payload = JSON.stringify(exportTelemetryObject(), null, 2);
    if (typeof document === 'undefined' || typeof Blob === 'undefined') return payload;
    const blob = new Blob([payload], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Nexus-diagnostics-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return payload;
}


export function exportSidecarTelemetryObject(slot) {
    const normalized=String(slot||'').toUpperCase();
    if(!['A','B'].includes(normalized))throw new Error(`Unknown Sidecar slot: ${slot}`);
    const snapshot=getTelemetrySnapshot();
    const events=(snapshot.events||[]).filter(evt=>{
        const category=String(evt?.category||'').toLowerCase();
        const eventSlot=String(evt?.data?.slot||'').toUpperCase();
        return eventSlot===normalized || category===`sidecar-${normalized.toLowerCase()}`;
    });
    return {
        exportedAt:new Date().toISOString(),
        version:'tv2-sidecar-telemetry-v1',
        slot:normalized,
        config:snapshot.config,
        sidecar:snapshot.sidecars?.[normalized]||emptySidecar(normalized),
        events,
    };
}

export function downloadSidecarTelemetryExport(slot) {
    const payload=JSON.stringify(exportSidecarTelemetryObject(slot),null,2);
    if(typeof document==='undefined'||typeof Blob==='undefined')return payload;
    const normalized=String(slot||'').toUpperCase();
    const blob=new Blob([payload],{type:'application/json'});
    const url=URL.createObjectURL(blob);
    const a=document.createElement('a');
    a.href=url;
    a.download=`Nexus-sidecar-${normalized}-${new Date().toISOString().replace(/[:.]/g,'-')}.json`;
    document.body.appendChild(a);a.click();a.remove();
    setTimeout(()=>URL.revokeObjectURL(url),1000);
    return payload;
}

export function sidecarStatsText(slot) {
    const stats = getTelemetrySnapshot().sidecars?.[String(slot).toUpperCase()] || emptySidecar(slot);
    const avg = stats.calls ? Math.round(stats.latencyMs / stats.calls) : 0;
    return `${stats.calls} calls · ${formatTokenCount(stats.totalTokens)} tokens · ${avg ? `${avg}ms avg` : 'no latency yet'} · ${stats.failures} failed`;
}
