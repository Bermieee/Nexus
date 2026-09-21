import { DEFAULT_OPENROUTER_JEV_MODEL, DECISION_ERROR, DECISION_PROVIDER, DECISION_PROVIDER_CLASS, OPENROUTER_DECISIONS_ENDPOINT } from '../constants.js';
import { DecisionProviderError, mapHttpDecisionError } from '../errors.js';
import { postDecisionJson } from './http.js';

export function normalizeOpenRouterApiKey(apiKey) {
    let value = String(apiKey || '').replace(/[\u200B-\u200D\u2060\uFEFF]/g, '').trim();
    value = value.replace(/^Bearer\s+/i, '').trim();
    return value.replace(/\s+/g, '');
}

export function normalizeOpenRouterJevModel(model) {
    const value = String(model || DEFAULT_OPENROUTER_JEV_MODEL).trim();
    if (!value) return DEFAULT_OPENROUTER_JEV_MODEL;
    if (value === 'jev-latest' || value === 'typesafe/jev-latest') return '~typesafe/jev-latest';
    if (/^jev-\d/i.test(value)) return `typesafe/${value}`;
    return value;
}


export async function probeOpenRouterCredential({ apiKey = '', fetchImpl = globalThis.fetch, timeoutMs = 10000, signal = null } = {}) {
    const key = normalizeOpenRouterApiKey(apiKey);
    if (!key) throw new DecisionProviderError(DECISION_ERROR.NOT_CONFIGURED, 'OpenRouter Decision Core API key is not configured.', { provider: DECISION_PROVIDER.OPENROUTER_JEV });
    if (typeof fetchImpl !== 'function') throw new DecisionProviderError(DECISION_ERROR.NETWORK, 'Fetch is unavailable for the OpenRouter credential probe.', { provider: DECISION_PROVIDER.OPENROUTER_JEV });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort('decision-auth-probe-timeout'), Math.max(250, Number(timeoutMs) || 10000));
    const abortExternal = () => controller.abort(signal?.reason || 'aborted');
    if (signal?.aborted) abortExternal(); else signal?.addEventListener?.('abort', abortExternal, { once: true });
    try {
        let response;
        try {
            response = await fetchImpl('https://openrouter.ai/api/v1/key', {
                method: 'GET',
                headers: { Authorization: `Bearer ${key}`, 'HTTP-Referer': 'https://sillytavern.app', 'X-OpenRouter-Title': 'Nexus' },
                signal: controller.signal,
            });
        } catch (error) {
            if (controller.signal.aborted) throw new DecisionProviderError(DECISION_ERROR.TIMEOUT, 'OpenRouter credential probe timed out or was cancelled.', { provider: DECISION_PROVIDER.OPENROUTER_JEV, retryable: true });
            throw new DecisionProviderError(DECISION_ERROR.NETWORK, error?.message || 'OpenRouter credential probe network failure.', { provider: DECISION_PROVIDER.OPENROUTER_JEV, retryable: true });
        }
        let payload = null;
        try { payload = await response.json(); } catch { payload = null; }
        if (!response.ok) {
            const mapped = mapHttpDecisionError(response.status, { provider: DECISION_PROVIDER.OPENROUTER_JEV, body: payload });
            if (mapped.category === DECISION_ERROR.AUTH) {
                throw new DecisionProviderError(DECISION_ERROR.AUTH, 'OpenRouter rejected the dedicated Decision Core API key before the Jev request. Re-enter a valid OpenRouter API key (not a key label or TypeSafe key).', { provider: DECISION_PROVIDER.OPENROUTER_JEV, httpStatus: response.status });
            }
            throw mapped;
        }
        return { ok: true, provider: DECISION_PROVIDER.OPENROUTER_JEV, keyAccepted: true, keyLabel: String(payload?.data?.label || ''), keyLength: key.length };
    } finally {
        clearTimeout(timeout);
        signal?.removeEventListener?.('abort', abortExternal);
    }
}

export function createOpenRouterJevAdapter({ apiKey = '', model = DEFAULT_OPENROUTER_JEV_MODEL, endpoint = OPENROUTER_DECISIONS_ENDPOINT, fetchImpl = globalThis.fetch } = {}) {
    const key = normalizeOpenRouterApiKey(apiKey);
    const providerModel = normalizeOpenRouterJevModel(model);
    return {
        id: DECISION_PROVIDER.OPENROUTER_JEV,
        providerClass: DECISION_PROVIDER_CLASS.TYPED_DECISION,
        model: providerModel,
        apiVersion: 'alpha/decisions',
        isConfigured: () => Boolean(key),
        async evaluate({ state, questions, timeoutMs, signal } = {}) {
            if (!key) throw new DecisionProviderError(DECISION_ERROR.NOT_CONFIGURED, 'OpenRouter Jev is not configured.', { provider: DECISION_PROVIDER.OPENROUTER_JEV });
            const { payload } = await postDecisionJson({
                endpoint, fetchImpl, timeoutMs, signal, provider: DECISION_PROVIDER.OPENROUTER_JEV,
                headers: { Authorization: `Bearer ${key}`, 'HTTP-Referer': 'https://sillytavern.app', 'X-OpenRouter-Title': 'Nexus' },
                body: { model: providerModel, state, questions },
            });
            if (!payload.answers || typeof payload.answers !== 'object') throw new DecisionProviderError(DECISION_ERROR.API_DRIFT, 'OpenRouter Decisions response no longer contains an answers object.', { provider: DECISION_PROVIDER.OPENROUTER_JEV });
            return {
                answers: payload.answers,
                provider: DECISION_PROVIDER.OPENROUTER_JEV,
                providerModel: String(payload.model || providerModel),
                providerApiVersion: 'alpha/decisions',
                upstreamProvider: payload.provider || null,
                providerRequestId: payload.id || null,
                usage: {
                    inputTokens: Number(payload.usage?.input_tokens) || 0,
                    outputTokens: Number(payload.usage?.output_tokens) || 0,
                    cost: Number.isFinite(Number(payload.usage?.cost)) ? Number(payload.usage.cost) : null,
                    estimatedCost: Number.isFinite(Number(payload.usage?.cost)) ? Number(payload.usage.cost) : null,
                },
            };
        },
    };
}
