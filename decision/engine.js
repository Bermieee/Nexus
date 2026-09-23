import { DECISION_ERROR, DECISION_MODE, DECISION_PROVIDER, DECISION_PROVIDER_CLASS } from './constants.js';
import { decisionErrorEnvelope, DecisionProviderError } from './errors.js';
import { validateDecisionRequest } from './contracts.js';
import { normalizeDecisionAnswers } from './normalize.js';
import { recordDecisionProviderAttempt, recordDecisionResult } from './telemetry.js';
import { diffDecisionFreshness } from './freshness.js';

function nowMs() { return Date.now(); }
function providerConfigured(adapter) { try { return adapter && (typeof adapter.isConfigured !== 'function' || adapter.isConfigured()); } catch { return false; } }
function providerOrder(selection, providers, { fallbackEnabled = true, allowProviderFallback = true } = {}) {
    const has = id => providerConfigured(providers[id]);
    const order = [];
    const add = id => { if (providers[id] && !order.includes(id)) order.push(id); };
    if (selection === DECISION_PROVIDER.DISABLED) return [];
    if (selection === DECISION_PROVIDER.LLM_FALLBACK_ONLY) { if (fallbackEnabled) add(DECISION_PROVIDER.LLM_FALLBACK); return order; }
    if (selection === DECISION_PROVIDER.OPENROUTER_JEV) {
        add(DECISION_PROVIDER.OPENROUTER_JEV);
        if (allowProviderFallback && has(DECISION_PROVIDER.TYPESAFE_DIRECT)) add(DECISION_PROVIDER.TYPESAFE_DIRECT);
    } else if (selection === DECISION_PROVIDER.TYPESAFE_DIRECT) {
        add(DECISION_PROVIDER.TYPESAFE_DIRECT);
        if (allowProviderFallback && has(DECISION_PROVIDER.OPENROUTER_JEV)) add(DECISION_PROVIDER.OPENROUTER_JEV);
    } else {
        if (has(DECISION_PROVIDER.OPENROUTER_JEV)) add(DECISION_PROVIDER.OPENROUTER_JEV);
        if (has(DECISION_PROVIDER.TYPESAFE_DIRECT)) add(DECISION_PROVIDER.TYPESAFE_DIRECT);
    }
    if (fallbackEnabled) add(DECISION_PROVIDER.LLM_FALLBACK);
    return order;
}
function baseResult(request, contract, mode) {
    return {
        ok: false,
        contractId: contract?.id || request?.contractId || null,
        contractVersion: contract?.version || request?.contractVersion || null,
        mode,
        provider: null,
        providerClass: null,
        providerModel: null,
        providerApiVersion: null,
        answers: null,
        sourceFingerprint: request?.sourceFingerprint || null,
        sourceFreshness: request?.sourceFreshness || null,
        currentSourceFreshness: null,
        staleDetails: null,
        stale: false,
        latencyMs: 0,
        usage: { inputTokens: 0, outputTokens: 0, cost: null },
        fallback: null,
        error: null,
    };
}

export function createDecisionCoreEngine({ getConfig = () => ({}), providers = {}, clock = nowMs, telemetry = { recordAttempt: recordDecisionProviderAttempt, recordResult: recordDecisionResult } } = {}) {
    return {
        async evaluate(input = {}, runtime = {}) {
            const started = clock();
            let contract;
            let request;
            let mode = DECISION_MODE.OFF;
            try {
                const validated = validateDecisionRequest(input);
                contract = validated.contract; request = validated.request;
                const config = getConfig() || {};
                mode = String(request.mode || config.mode || DECISION_MODE.OFF).toLowerCase();
                const result = baseResult(request, contract, mode);
                if (config.enabled !== true || mode === DECISION_MODE.OFF) {
                    result.error = { category: DECISION_ERROR.PROVIDER_DISABLED, message: 'Decision Core is disabled or operating mode is Off.' };
                    result.latencyMs = Math.max(0, clock() - started); telemetry.recordResult(result); return result;
                }
                if (![DECISION_MODE.SHADOW, DECISION_MODE.ASSIST].includes(mode)) throw new DecisionProviderError(DECISION_ERROR.VALIDATION, `Unsupported Decision Core mode: ${mode}`);
                if (typeof contract.deterministic === 'function') {
                    const deterministic = await contract.deterministic(request.state, request.questions);
                    if (deterministic) {
                        result.ok = true; result.provider = DECISION_PROVIDER.DETERMINISTIC; result.providerClass = DECISION_PROVIDER_CLASS.DETERMINISTIC; result.providerModel = 'nexus-code'; result.providerApiVersion = 'local';
                        result.answers = normalizeDecisionAnswers(deterministic, request.questions); result.latencyMs = Math.max(0, clock() - started); telemetry.recordResult(result); return result;
                    }
                }
                const policy = { ...(config.providerPolicy || {}), ...(request.providerPolicy || {}) };
                const selection = String(policy.provider || config.provider || DECISION_PROVIDER.AUTO).toLowerCase();
                const fallbackEnabled = policy.fallbackEnabled ?? config.fallbackEnabled ?? true;
                const chain = providerOrder(selection, providers, { fallbackEnabled, allowProviderFallback: policy.allowProviderFallback !== false });
                if (!chain.length) {
                    result.error = { category: selection === DECISION_PROVIDER.DISABLED ? DECISION_ERROR.PROVIDER_DISABLED : DECISION_ERROR.NOT_CONFIGURED, message: selection === DECISION_PROVIDER.DISABLED ? 'Decision provider is disabled.' : 'No configured Decision provider is available.' };
                    result.latencyMs = Math.max(0, clock() - started); telemetry.recordResult(result); return result;
                }
                const attempts = [];
                for (const providerId of chain) {
                    const adapter = providers[providerId];
                    const attemptStarted = clock();
                    if (!providerConfigured(adapter)) {
                        const err = { category: DECISION_ERROR.NOT_CONFIGURED, message: `${providerId} is not configured.`, provider: providerId };
                        attempts.push({ provider: providerId, ok: false, error: err });
                        telemetry.recordAttempt({ provider: providerId, ok: false, latencyMs: 0, errorCategory: err.category });
                        continue;
                    }
                    try {
                        const raw = await adapter.evaluate({ state: request.state, questions: request.questions, contractId: contract.id, contractVersion: contract.version, timeoutMs: Number(policy.timeoutMs ?? config.timeoutMs) || 10000, signal: runtime.signal || null });
                        const answers = normalizeDecisionAnswers(raw.answers, request.questions);
                        const attemptLatency = Math.max(0, clock() - attemptStarted);
                        telemetry.recordAttempt({ provider: providerId, ok: true, latencyMs: attemptLatency, usage: raw.usage });
                        attempts.push({ provider: providerId, ok: true, latencyMs: attemptLatency });
                        let currentFreshness = null, currentFingerprint = request.sourceFingerprint;
                        try {
                            if (typeof runtime.getCurrentSourceFreshness === 'function') { currentFreshness = await runtime.getCurrentSourceFreshness(); currentFingerprint = currentFreshness?.fingerprint || ''; }
                            else if (typeof runtime.getCurrentSourceFingerprint === 'function') currentFingerprint = await runtime.getCurrentSourceFingerprint();
                        } catch (freshnessError) {
                            result.provider = raw.provider || providerId; result.providerClass = raw.providerClass || adapter.providerClass || null; result.providerModel = raw.providerModel || adapter.model || null; result.providerApiVersion = raw.providerApiVersion || adapter.apiVersion || null;
                            result.usage = raw.usage || result.usage; result.stale = true;
                            result.error = { category: DECISION_ERROR.STALE_RESULT, message: 'Decision freshness could not be revalidated before consumption.', details: { reason: freshnessError?.message || String(freshnessError) } };
                            result.staleDetails = { changed:true,revalidationFailed:true,reason:freshnessError?.message||String(freshnessError),revisionChanges:[],materialChanged:null };
                            result.fallback = attempts.length > 1 ? { used:true,reason:attempts.find(a=>!a.ok)?.error?.category||null,attempts } : { used:false,reason:null,attempts };
                            result.latencyMs=Math.max(0,clock()-started); telemetry.recordResult(result); return result;
                        }
                        if (String(currentFingerprint || '') !== String(request.sourceFingerprint || '')) {
                            result.provider = raw.provider || providerId; result.providerClass = raw.providerClass || adapter.providerClass || null; result.providerModel = raw.providerModel || adapter.model || null; result.providerApiVersion = raw.providerApiVersion || adapter.apiVersion || null;
                            result.usage=raw.usage||result.usage; result.stale=true; result.currentSourceFreshness=currentFreshness;
                            result.staleDetails=request.sourceFreshness&&currentFreshness?diffDecisionFreshness(request.sourceFreshness,currentFreshness):{changed:true,revisionChanges:[],materialChanged:null};
                            result.error={category:DECISION_ERROR.STALE_RESULT,message:'Decision source changed before the result could be consumed.',details:result.staleDetails};
                            result.fallback=attempts.length>1?{used:true,reason:attempts.find(a=>!a.ok)?.error?.category||null,attempts}:{used:false,reason:null,attempts};
                            result.latencyMs=Math.max(0,clock()-started); telemetry.recordResult(result); return result;
                        }
                        result.currentSourceFreshness=currentFreshness;
                        result.ok = true; result.provider = raw.provider || providerId; result.providerClass = raw.providerClass || adapter.providerClass || null; result.providerModel = raw.providerModel || adapter.model || null; result.providerApiVersion = raw.providerApiVersion || adapter.apiVersion || null;
                        result.providerRequestId = raw.providerRequestId || null; result.upstreamProvider = raw.upstreamProvider || null; result.answers = answers; result.usage = raw.usage || result.usage;
                        const failedAttempt = attempts.find(a => !a.ok);
                        result.fallback = failedAttempt ? { used: true, from: failedAttempt.provider, to: providerId, reason: failedAttempt.error?.category || null, attempts } : { used: false, reason: null, attempts };
                        result.latencyMs = Math.max(0, clock() - started); telemetry.recordResult(result); return result;
                    } catch (error) {
                        const attemptLatency = Math.max(0, clock() - attemptStarted);
                        const envelope = decisionErrorEnvelope(error, error instanceof DecisionProviderError ? error.category : DECISION_ERROR.NETWORK);
                        attempts.push({ provider: providerId, ok: false, latencyMs: attemptLatency, error: envelope });
                        telemetry.recordAttempt({ provider: providerId, ok: false, latencyMs: attemptLatency, errorCategory: envelope.category });
                        if (envelope.category === DECISION_ERROR.STALE_RESULT) break;
                    }
                }
                const last = attempts.at(-1)?.error || { category: DECISION_ERROR.FALLBACK_FAILED, message: 'Decision provider chain failed.' };
                result.error = last;
                result.fallback = { used: attempts.length > 1, reason: attempts.find(a => !a.ok)?.error?.category || last.category, attempts };
                result.latencyMs = Math.max(0, clock() - started); telemetry.recordResult(result); return result;
            } catch (error) {
                const result = baseResult(input, contract, mode);
                result.error = decisionErrorEnvelope(error, error?.category || DECISION_ERROR.VALIDATION);
                result.latencyMs = Math.max(0, clock() - started); telemetry.recordResult(result); return result;
            }
        },
    };
}
