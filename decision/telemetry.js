import { logEvent } from '../observability/telemetry.js';
import { DECISION_ERROR, DECISION_PROVIDER } from './constants.js';

const STORAGE_KEY = 'nexus:decision-core:telemetry:v1';
const CHANGE_EVENT = 'nexus-decision-core-telemetry';
const defaultState = () => ({
    windowStartedAt: Date.now(),
    totalDecisions: 0,
    jevCalls: 0,
    llmFallbackCalls: 0,
    shadowAgreements: 0,
    shadowDisagreements: 0,
    providerFailures: 0,
    staleResults: 0,
    totalLatencyMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    actualReportedCost: 0,
    estimatedJevCost: 0,
    potentialExpensiveLlmCallsAvoided: 0,
    lastDecisionContract: null,
    lastFallbackReason: null,
    lastDecisionAt: null,
    providers: {},
});
let state = defaultState();
let loaded = false;
function clone(value) { try { return structuredClone(value); } catch {} try { return JSON.parse(JSON.stringify(value)); } catch { return value; } }
function providerState(id) {
    state.providers[id] ||= { calls: 0, successes: 0, failures: 0, lastSuccessAt: null, lastFailureAt: null, lastErrorCategory: null, lastLatencyMs: null, rateLimited: false, overloaded: false };
    return state.providers[id];
}
function loadOnce() {
    if (loaded) return;
    loaded = true;
    try {
        const raw = globalThis.sessionStorage?.getItem?.(STORAGE_KEY);
        if (!raw) return;
        const parsed = JSON.parse(raw);
        state = { ...defaultState(), ...(parsed || {}), providers: { ...(parsed?.providers || {}) } };
    } catch {}
}
function persist() { try { globalThis.sessionStorage?.setItem?.(STORAGE_KEY, JSON.stringify(state)); } catch {} }
function notify() { try { globalThis.window?.dispatchEvent?.(new CustomEvent(CHANGE_EVENT, { detail: getDecisionTelemetrySnapshot() })); } catch {} }
function isJev(provider) { return provider === DECISION_PROVIDER.OPENROUTER_JEV || provider === DECISION_PROVIDER.TYPESAFE_DIRECT; }

export function getDecisionTelemetryChangeEventName() { return CHANGE_EVENT; }
export function getDecisionTelemetrySnapshot() {
    loadOnce();
    return { ...clone(state), averageLatencyMs: state.totalDecisions ? Math.round(state.totalLatencyMs / state.totalDecisions) : 0 };
}
export function resetDecisionTelemetry({ source = 'operator', emitLog = true } = {}) {
    state = defaultState(); loaded = true; persist(); notify();
    if (emitLog) logEvent('decision-core', 'telemetry-reset', { source, windowStartedAt: state.windowStartedAt }, 'info');
    return getDecisionTelemetrySnapshot();
}
export function resetDecisionTelemetryForTests() { return resetDecisionTelemetry({ source: 'tests', emitLog: false }); }

export function recordDecisionProviderAttempt({ provider, ok = false, latencyMs = 0, errorCategory = null, usage = null } = {}) {
    loadOnce();
    const id = String(provider || 'unknown');
    const row = providerState(id);
    row.calls += 1;
    row.lastLatencyMs = Math.max(0, Number(latencyMs) || 0);
    if (isJev(id)) state.jevCalls += 1;
    if (id === DECISION_PROVIDER.LLM_FALLBACK) state.llmFallbackCalls += 1;
    if (ok) {
        row.successes += 1; row.lastSuccessAt = Date.now(); row.lastErrorCategory = null; row.rateLimited = false; row.overloaded = false;
        state.inputTokens += Math.max(0, Number(usage?.inputTokens) || 0);
        state.outputTokens += Math.max(0, Number(usage?.outputTokens) || 0);
        if (Number.isFinite(Number(usage?.cost))) state.actualReportedCost += Math.max(0, Number(usage.cost));
        if (isJev(id) && Number.isFinite(Number(usage?.estimatedCost))) state.estimatedJevCost += Math.max(0, Number(usage.estimatedCost));
    } else {
        row.failures += 1; row.lastFailureAt = Date.now(); row.lastErrorCategory = errorCategory || 'UNKNOWN'; state.providerFailures += 1;
        row.rateLimited = errorCategory === 'RATE_LIMIT'; row.overloaded = errorCategory === 'OVERLOADED';
    }
    persist(); notify();
}

export function recordDecisionResult(result = {}) {
    loadOnce();
    state.totalDecisions += 1;
    state.totalLatencyMs += Math.max(0, Number(result.latencyMs) || 0);
    state.lastDecisionContract = result.contractId || null;
    state.lastFallbackReason = result.fallback?.reason || null;
    state.lastDecisionAt = Date.now();
    if (result.stale) state.staleResults += 1;
    persist(); notify();
    const intentionallyDisabled = result?.error?.category === DECISION_ERROR.PROVIDER_DISABLED;
    const eventName = result.ok ? 'decision-complete' : (result.stale ? 'decision-stale' : (intentionallyDisabled ? 'decision-skipped' : 'decision-failed'));
    const level = result.ok ? 'info' : (result.stale || intentionallyDisabled ? 'debug' : 'warn');
    logEvent('decision-core', eventName, {
        contractId: result.contractId,
        contractVersion: result.contractVersion,
        mode: result.mode,
        provider: result.provider,
        providerModel: result.providerModel,
        latencyMs: result.latencyMs,
        sourceFingerprint: result.sourceFingerprint,
        sourceFreshness: result.sourceFreshness ? { siteId: result.sourceFreshness.siteId || null, revisions: result.sourceFreshness.revisions || {}, materialFingerprint: result.sourceFreshness.materialFingerprint || null } : null,
        currentSourceFreshness: result.currentSourceFreshness ? { siteId: result.currentSourceFreshness.siteId || null, revisions: result.currentSourceFreshness.revisions || {}, materialFingerprint: result.currentSourceFreshness.materialFingerprint || null } : null,
        staleDetails: result.staleDetails || null,
        stale: result.stale === true,
        skipped: intentionallyDisabled,
        fallback: result.fallback,
        error: result.error,
        usage: result.usage,
    }, level);
}

export function recordDecisionShadowComparison({ contractId, provider, agreement = null, potentialExpensiveLlmCallAvoided = false, details = null } = {}) {
    loadOnce();
    if (agreement === true) state.shadowAgreements += 1;
    else if (agreement === false) state.shadowDisagreements += 1;
    if (potentialExpensiveLlmCallAvoided === true) state.potentialExpensiveLlmCallsAvoided += 1;
    persist(); notify();
    logEvent('decision-core', 'shadow-comparison', { contractId, provider, agreement, potentialExpensiveLlmCallAvoided, details }, agreement === false ? 'debug' : 'info');
}
