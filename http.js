import { DECISION_ERROR } from '../constants.js';
import { DecisionProviderError, mapHttpDecisionError } from '../errors.js';

export async function postDecisionJson({ endpoint, headers = {}, body, timeoutMs = 10000, signal = null, fetchImpl = globalThis.fetch, provider = null } = {}) {
    if (typeof fetchImpl !== 'function') throw new DecisionProviderError(DECISION_ERROR.NETWORK, 'Fetch is unavailable for the Decision provider.', { provider });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort('decision-timeout'), Math.max(250, Number(timeoutMs) || 10000));
    const abortExternal = () => controller.abort(signal?.reason || 'aborted');
    if (signal?.aborted) abortExternal(); else signal?.addEventListener?.('abort', abortExternal, { once: true });
    try {
        let response;
        try {
            response = await fetchImpl(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal: controller.signal });
        } catch (error) {
            if (controller.signal.aborted) throw new DecisionProviderError(DECISION_ERROR.TIMEOUT, 'Decision provider request timed out or was cancelled.', { provider, retryable: true });
            throw new DecisionProviderError(DECISION_ERROR.NETWORK, error?.message || 'Decision provider network failure.', { provider, retryable: true });
        }
        let payload = null;
        try { payload = await response.json(); } catch {
            if (response.ok) throw new DecisionProviderError(DECISION_ERROR.API_DRIFT, 'Decision provider returned a non-JSON success response.', { provider, httpStatus: response.status });
        }
        if (!response.ok) throw mapHttpDecisionError(response.status, { provider, body: payload });
        if (!payload || typeof payload !== 'object') throw new DecisionProviderError(DECISION_ERROR.API_DRIFT, 'Decision provider returned an empty or unknown response schema.', { provider, httpStatus: response.status });
        return { payload, status: response.status, headers: response.headers };
    } finally {
        clearTimeout(timeout);
        signal?.removeEventListener?.('abort', abortExternal);
    }
}
