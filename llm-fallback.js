import { DECISION_ERROR, DECISION_PROVIDER, DECISION_PROVIDER_CLASS } from '../constants.js';
import { DecisionProviderError } from '../errors.js';
import { enqueueBusJob, BUS_STAGE, BUS_PRIORITY } from '../../sidecar/bus.js';
import { structuredSidecarOptions } from '../../nexus/batch-layer.js';

function parseJson(text) {
    const raw = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    try { return JSON.parse(raw); } catch {}
    const start = raw.indexOf('{'), end = raw.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(raw.slice(start, end + 1));
    return null;
}

export function createLlmFallbackAdapter({ dispatch = enqueueBusJob } = {}) {
    return {
        id: DECISION_PROVIDER.LLM_FALLBACK,
        providerClass: DECISION_PROVIDER_CLASS.LLM_FALLBACK,
        model: 'existing-nexus-sidecar-route',
        apiVersion: 'nexus-sidecar-bus',
        isConfigured: () => true,
        async evaluate({ state, questions, timeoutMs, signal, contractId } = {}) {
            const prompt = `Nexus bounded Decision fallback. Evaluate ONLY the supplied typed questions against the supplied state. Do not propose actions or mutations.\n\nCONTRACT ${contractId || 'unknown'}\nSTATE\n${JSON.stringify(state)}\n\nQUESTIONS\n${JSON.stringify(questions)}\n\nReturn ONLY JSON: {"answers":{"question_id":{"type":"noul|choice|score",...}}}. For noul return {"type":"noul","noul":0..1}; for choice return choice/probabilities/confidence; for score return score/probabilities/confidence.`;
            let job;
            try {
                job = dispatch(BUS_STAGE.MAINTENANCE, structuredSidecarOptions({
                    prompt,
                    systemPrompt: 'You are Nexus Decision Core LLM fallback. Return typed bounded judgments as JSON only. Never mutate or generate canonical content.',
                    maxTokens: 1200,
                    timeoutMs: Math.max(1000, Number(timeoutMs) || 10000),
                    priority: BUS_PRIORITY.MAINTENANCE,
                    preemptible: true,
                    maxAttempts: 1,
                    label: 'Decision Core fallback',
                    signal,
                    telemetry: { decisionCore: true, fallback: true, contractId },
                }));
                const response = await job.promise;
                const parsed = parseJson(response?.text);
                if (!parsed?.answers || typeof parsed.answers !== 'object') throw new DecisionProviderError(DECISION_ERROR.MALFORMED_TYPED_OUTPUT, 'LLM fallback returned malformed typed Decision output.', { provider: DECISION_PROVIDER.LLM_FALLBACK });
                return {
                    answers: parsed.answers,
                    provider: DECISION_PROVIDER.LLM_FALLBACK,
                    providerModel: response?.tv2?.model || response?.model || 'existing-nexus-sidecar-route',
                    providerApiVersion: 'nexus-sidecar-bus',
                    providerRequestId: response?.tv2?.jobId || job?.id || null,
                    usage: {
                        inputTokens: Number(response?.usageNormalized?.inputTokens ?? response?.usage?.inputTokens) || 0,
                        outputTokens: Number(response?.usageNormalized?.outputTokens ?? response?.usage?.outputTokens) || 0,
                        cost: null,
                    },
                };
            } catch (error) {
                if (error instanceof DecisionProviderError) throw error;
                throw new DecisionProviderError(DECISION_ERROR.FALLBACK_FAILED, error?.message || 'Existing LLM fallback failed.', { provider: DECISION_PROVIDER.LLM_FALLBACK });
            }
        },
    };
}
