import { DEFAULT_TYPESAFE_MODEL, DECISION_ERROR, DECISION_PROVIDER, DECISION_PROVIDER_CLASS, TYPESAFE_SYSTEMONE_ENDPOINT } from '../constants.js';
import { DecisionProviderError } from '../errors.js';
import { postDecisionJson } from './http.js';

export function createTypeSafeDirectAdapter({ apiKey = '', model = DEFAULT_TYPESAFE_MODEL, endpoint = TYPESAFE_SYSTEMONE_ENDPOINT, fetchImpl = globalThis.fetch } = {}) {
    const key = String(apiKey || '').trim();
    const providerModel = String(model || DEFAULT_TYPESAFE_MODEL).trim() || DEFAULT_TYPESAFE_MODEL;
    return {
        id: DECISION_PROVIDER.TYPESAFE_DIRECT,
        providerClass: DECISION_PROVIDER_CLASS.TYPED_DECISION,
        model: providerModel,
        apiVersion: 'v1/systemone',
        isConfigured: () => Boolean(key),
        async evaluate({ state, questions, timeoutMs, signal } = {}) {
            if (!key) throw new DecisionProviderError(DECISION_ERROR.NOT_CONFIGURED, 'TypeSafe Direct Jev is not configured.', { provider: DECISION_PROVIDER.TYPESAFE_DIRECT });
            const { payload } = await postDecisionJson({
                endpoint, fetchImpl, timeoutMs, signal, provider: DECISION_PROVIDER.TYPESAFE_DIRECT,
                headers: { Authorization: `Bearer ${key}` },
                body: { state, model: providerModel, questions },
            });
            if (!payload.answers || typeof payload.answers !== 'object') throw new DecisionProviderError(DECISION_ERROR.API_DRIFT, 'TypeSafe Direct response no longer contains an answers object.', { provider: DECISION_PROVIDER.TYPESAFE_DIRECT });
            const inputTokens = Number(payload.usage?.input_tokens) || 0;
            return {
                answers: payload.answers,
                provider: DECISION_PROVIDER.TYPESAFE_DIRECT,
                providerModel: String(payload.model || providerModel),
                providerApiVersion: 'v1/systemone',
                providerRequestId: payload.id || null,
                usage: {
                    inputTokens,
                    outputTokens: Number(payload.usage?.output_tokens) || 0,
                    cost: null,
                    // Live TypeSafe model reference (2026-09-19): Jev 1.13
                    // is $0.042 per million input tokens; outputs are free.
                    estimatedCost: inputTokens * 0.042 / 1_000_000,
                },
            };
        },
    };
}
