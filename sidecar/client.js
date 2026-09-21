import { normalizeOpenAIResponse, normalizeAnthropicResponse, normalizeGoogleResponse, assertProviderTerminalState, assertFinalContent, separateVisibleThinking } from './normalize-response.js';
import { estimateSidecarCall, estimateContentTokens } from '../observability/token-estimator.js';
import { recordSidecarPlan, recordSidecarStart, recordSidecarResult, recordSidecarError, logEvent } from '../observability/telemetry.js';
import { isForegroundAbort, isIntentionalCancellation, resolveAbortReason } from '../core/cancellation.js';
import { currentNexusChatEpoch } from '../nexus/work-scope.js';
import { resolveSidecarTransportTimeout } from './timeout-policy.js';
import { resolveAutoReasoningEffort } from './reasoning-auto.js';

const PROVIDER_CAPABILITY_CACHE_LIMIT = 64;
export const PROVIDER_CAPABILITY_CACHE_TTL_MS = 30 * 60 * 1000;
const providerCapabilityCache = new Map();

function smallIdentityHash(value = '') {
    let hash = 2166136261;
    for (const ch of String(value || '')) { hash ^= ch.charCodeAt(0); hash = Math.imul(hash, 16777619); }
    return (hash >>> 0).toString(36);
}

function endpointIdentity(endpoint) {
    const raw = String(endpoint || '').trim();
    if (!raw) return '';
    try {
        const url = new URL(raw);
        // URL host/scheme normalization is safe. Path case and query routing are
        // intentionally preserved because gateways may route them differently.
        const path = url.pathname.replace(/\/+$/, '') || '/';
        return `${url.protocol.toLowerCase()}//${url.host.toLowerCase()}${path}${url.search}`;
    } catch {
        return raw.replace(/\/+$/, '');
    }
}

function credentialIdentity(profile = {}) {
    const explicit = String(profile?.credentialIdentity || profile?.credentialId || '').trim();
    if (explicit) return explicit;
    return profile?.apiKey ? `key:${smallIdentityHash(profile.apiKey)}` : 'anonymous';
}

export function providerCapabilityKey(profile, endpoint) {
    return `${String(profile?.format || 'openai').toLowerCase()}|${endpointIdentity(endpoint)}|${String(profile?.model || '').trim().toLowerCase()}|${credentialIdentity(profile)}`;
}

function providerCapability(profile, endpoint) {
    const key = providerCapabilityKey(profile, endpoint);
    const cached = providerCapabilityCache.get(key) || null;
    if (!cached) return null;
    if (Date.now() - Number(cached.learnedAt || 0) > PROVIDER_CAPABILITY_CACHE_TTL_MS) {
        providerCapabilityCache.delete(key);
        return null;
    }
    return cached;
}

function rememberProviderCapability(profile, endpoint, patch = {}) {
    const key = providerCapabilityKey(profile, endpoint);
    const prior = providerCapability(profile, endpoint) || {};
    const next = { ...prior, ...patch, learnedAt: Date.now() };
    providerCapabilityCache.delete(key);
    providerCapabilityCache.set(key, next);
    while (providerCapabilityCache.size > PROVIDER_CAPABILITY_CACHE_LIMIT) providerCapabilityCache.delete(providerCapabilityCache.keys().next().value);
    return next;
}

function rememberReasoningMandatory(profile, endpoint) {
    return rememberProviderCapability(profile, endpoint, { reasoningMandatory: true });
}

function timeoutSignal(parentSignal, timeoutMs) {
    const controller = new AbortController();
    let timedOut = false;
    const onAbort = () => controller.abort(parentSignal?.reason || new Error('Cancelled'));
    if (parentSignal) {
        if (parentSignal.aborted) onAbort();
        else parentSignal.addEventListener('abort', onAbort, { once: true });
    }
    const timer = setTimeout(() => {
        // Parent cancellation wins a race with the timeout timer. Never rewrite
        // an intentional abort into a retryable timeout after the composed
        // signal has already been settled.
        if (controller.signal.aborted) return;
        timedOut = true;
        const error = new Error(`Sidecar timed out after ${Math.round(timeoutMs / 1000)}s`);
        error.name = 'TV2SidecarTimeout';
        controller.abort(error);
    }, timeoutMs);
    return {
        signal: controller.signal,
        cleanup() { clearTimeout(timer); parentSignal?.removeEventListener?.('abort', onAbort); },
        didTimeout() { return timedOut; },
    };
}

function splitEndpoint(endpoint) {
    const raw = String(endpoint || '').trim();
    if (!raw) return { base: '', suffix: '' };
    const match = raw.match(/^([^?#]*)([?#][\s\S]*)?$/);
    return { base: String(match?.[1] || raw).replace(/\/+$/, ''), suffix: match?.[2] || '' };
}

/**
 * Accept either a complete Chat Completions URL or the base URLs commonly
 * shown by OpenAI-compatible providers (OpenRouter, LM Studio, Ollama,
 * Together, Groq, Mistral, vLLM, etc.). Unknown non-versioned paths are
 * treated as provider base paths and receive /chat/completions.
 */
export function normalizeOpenAIEndpoint(endpoint) {
    const { base, suffix } = splitEndpoint(endpoint);
    if (!base) return '';
    if (/\/chat\/completions$/i.test(base)) return `${base}${suffix}`;
    if (/\/responses$/i.test(base)) {
        throw new Error('Nexus Sidecars use the OpenAI-compatible Chat Completions API. Enter the provider base URL or its /chat/completions endpoint, not /responses.');
    }
    if (/\/completions$/i.test(base)) return `${base.replace(/\/completions$/i, '/chat/completions')}${suffix}`;
    if (/\/v\d+$/i.test(base) || /\/api$/i.test(base)) return `${base}${/\/api$/i.test(base) ? '/v1' : ''}/chat/completions${suffix}`;
    try {
        const parsed = new URL(base);
        if (!parsed.pathname || parsed.pathname === '/') return `${base}/v1/chat/completions${suffix}`;
    } catch { /* custom relative gateways are still accepted below */ }
    return `${base}/chat/completions${suffix}`;
}

function replaceEndpointPath(endpoint, transform) {
    const raw = String(endpoint || '').trim();
    if (!raw) return '';
    try {
        const url = new URL(raw);
        url.pathname = transform(url.pathname.replace(/\/+$/, '') || '/');
        return url.toString();
    } catch {
        const { base, suffix } = splitEndpoint(raw);
        return `${transform(base)}${suffix}`;
    }
}

function appendEndpointPath(endpoint, suffix) {
    return replaceEndpointPath(endpoint, path => `${path.replace(/\/+$/, '')}${suffix.startsWith('/') ? suffix : `/${suffix}`}`);
}

function withQueryParam(endpoint, name, value) {
    if (value == null || value === '') return endpoint;
    try {
        const url = new URL(endpoint);
        if (!url.searchParams.has(name)) url.searchParams.set(name, String(value));
        return url.toString();
    } catch {
        const join = String(endpoint).includes('?') ? '&' : '?';
        return `${endpoint}${join}${encodeURIComponent(name)}=${encodeURIComponent(value)}`;
    }
}

export function openAIModelsEndpoint(endpoint) {
    const normalized = normalizeOpenAIEndpoint(endpoint);
    if (!normalized) return '';
    return replaceEndpointPath(normalized, path => path.replace(/\/chat\/completions$/i, '/models'));
}

function googleModelsBase(endpoint) {
    return replaceEndpointPath(endpoint, path => /\/models$/i.test(path) ? path : `${path.replace(/\/+$/, '')}/models`);
}

function anthropicBase(endpoint) {
    return replaceEndpointPath(endpoint, path => path.replace(/\/(messages|models)$/i, ''));
}

function providerAuthHeaders(profile, endpoint, { json = false } = {}) {
    const headers = json ? { 'content-type': 'application/json' } : {};
    if (profile?.apiKey) {
        headers.authorization = `Bearer ${profile.apiKey}`;
        if (/\.openai\.azure\.com/i.test(endpoint)) headers['api-key'] = profile.apiKey;
    }
    if (/openrouter\.ai/i.test(endpoint)) {
        headers['HTTP-Referer'] = 'https://sillytavern.app';
        headers['X-OpenRouter-Title'] = 'Nexus';
    }
    return headers;
}

/** Load model identifiers when the configured provider exposes a Models API. */
export async function listSidecarModels(profile, { signal, timeoutMs = 30000 } = {}) {
    if (!profile?.endpoint) throw new Error('Enter a Sidecar endpoint before loading models.');
    const format = String(profile.format || 'openai').toLowerCase();
    if (!['openai', 'anthropic', 'google'].includes(format)) throw new Error(`Unsupported Sidecar provider format: ${format}`);
    let endpoint;
    let headers = {};
    if (format === 'google') {
        endpoint = withQueryParam(googleModelsBase(profile.endpoint), 'key', profile.apiKey || '');
    } else if (format === 'anthropic') {
        endpoint = appendEndpointPath(anthropicBase(profile.endpoint), '/models');
        headers = { 'anthropic-version': '2023-06-01' };
        if (profile.apiKey) headers['x-api-key'] = profile.apiKey;
    } else {
        endpoint = openAIModelsEndpoint(profile.endpoint);
        headers = providerAuthHeaders(profile, endpoint);
    }

    const models = [];
    let pageUrl = endpoint;
    for (let page = 0; page < 20 && pageUrl; page += 1) {
        const data = await fetchJson(pageUrl, { method: 'GET', headers }, { signal, timeoutMs, label: 'Sidecar model discovery' });
        const rows = Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : [];
        models.push(...rows.map(row => String(row?.id || row?.name || '').replace(/^models\//, '').trim()).filter(Boolean));
        if (format === 'google' && data?.nextPageToken) {
            pageUrl = withQueryParam(endpoint, 'pageToken', data.nextPageToken);
        } else if (format === 'anthropic' && data?.has_more && data?.last_id) {
            pageUrl = withQueryParam(endpoint, 'after_id', data.last_id);
        } else if (format === 'openai' && data?.has_more && (data?.last_id || rows.at(-1)?.id)) {
            pageUrl = withQueryParam(endpoint, 'after', data.last_id || rows.at(-1).id);
        } else pageUrl = null;
    }
    return [...new Set(models)].sort((a, b) => a.localeCompare(b));
}

function selectedHttpHeaders(response) {
    const selectedHeaders = {};
    for (const name of ['content-type','x-request-id','request-id','cf-ray','x-ratelimit-limit-requests','x-ratelimit-remaining-requests','x-ratelimit-reset-requests','retry-after']) {
        const value = response?.headers?.get?.(name);
        if (value) selectedHeaders[name] = value;
    }
    return selectedHeaders;
}

async function fetchJson(url, options, { signal, timeoutMs, label }) {
    const scoped = timeoutSignal(signal, timeoutMs);
    try {
        const response = await fetch(url, { ...options, signal: scoped.signal });
        const bodyText = await response.text();
        const httpMeta = { status: response.status, statusText: response.statusText || '', headers: selectedHttpHeaders(response) };
        let data = null;
        try { data = bodyText ? JSON.parse(bodyText) : {}; }
        catch {
            const err = new Error(`${label} returned non-JSON response: ${bodyText.slice(0, 300)}`);
            err.httpStatus = response.status;
            err.http = httpMeta;
            err.responsePreview = bodyText.slice(0, 1000);
            throw err;
        }
        if (!response.ok) {
            const detail = data?.error?.message || bodyText.slice(0, 500);
            const err = new Error(`${label} HTTP ${response.status}${detail ? ` — ${detail}` : ''}`);
            err.httpStatus = response.status;
            err.http = httpMeta;
            err.providerError = data?.error || null;
            err.responsePreview = bodyText.slice(0, 1000);
            throw err;
        }
        if (data && typeof data === 'object') data.__tv2Http = httpMeta;
        return data;
    } catch (err) {
        if (scoped.didTimeout()) {
            const timeoutError = new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s.`);
            timeoutError.name = 'TV2SidecarTimeout';
            throw timeoutError;
        }
        if (signal?.aborted) throw resolveAbortReason(err, signal);
        throw err;
    } finally {
        scoped.cleanup();
    }
}

function normalizedEffort(profile = {}, { directReasoningModel = false } = {}) {
    const raw = String(profile.reasoningEffort || '').trim().toLowerCase();
    if (!raw || raw === 'auto' || raw === 'default' || raw === 'max') return 'medium';
    if (raw === 'none' && directReasoningModel) return 'low';
    return raw;
}

function reasoningModelFamily(model = '') {
    return /(^|[\/:_-])(gpt-5|o1|o3|o4)([\/:_.-]|$)/i.test(String(model || ''));
}

function qwenOrGlmFamily(model = '') {
    return /(^|[\/:_-])(qwen|glm)(?=\d|[\/:_.-]|$)/i.test(String(model || ''));
}

function reasoningPayload(profile, endpoint, { exclude = false, requestMaxTokens = null } = {}) {
    const model = String(profile.model || '').toLowerCase();
    const directReasoning = reasoningModelFamily(model);
    const effort = normalizedEffort(profile, { directReasoningModel: directReasoning });
    const learned = providerCapability(profile, endpoint);
    if (/openrouter\.ai/i.test(endpoint)) {
        if (String(profile.reasoningEffort || '').toLowerCase() === 'none' && learned?.reasoningMandatory) {
            const reasoningBudget = boundedMandatoryReasoningTokens(requestMaxTokens);
            return { reasoning: reasoningBudget
                ? { max_tokens: reasoningBudget, exclude: exclude === true }
                : { effort: 'minimal', exclude: exclude === true } };
        }
        if (String(profile.reasoningEffort || '').toLowerCase() === 'none') return { reasoning: { enabled: false, effort: 'none', exclude: true } };
        return { reasoning: { effort, exclude: exclude === true } };
    }
    // Qwen/GLM hybrid-thinking endpoints use the OpenAI-compatible top-level
    // enable_thinking switch. Sending generic reasoning_effort='none' leaves
    // thinking enabled on several current implementations.
    if (qwenOrGlmFamily(model) && String(profile.reasoningEffort || '').toLowerCase() === 'none') {
        return { enable_thinking: false };
    }
    if (directReasoning || /(^|[\/:_-])(deepseek-r1|reasoning)([\/:_.-]|$)/i.test(model)) {
        return { reasoning_effort: effort };
    }
    return {};
}

function openAIUsesCompletionTokens(model = '') {
    return reasoningModelFamily(model);
}

function openAIInstructionRole(model = '') {
    return /(^|[\/:_-])(o1|o3|o4|gpt-5)([\/:_.-]|$)/i.test(String(model || '')) ? 'developer' : 'system';
}

function openAISupportsTemperature(model = '') {
    return !reasoningModelFamily(model);
}

function googleThinkingConfig(effective = {}) {
    const raw = String(effective.reasoningEffort || '').trim().toLowerCase();
    if (!raw || raw === 'auto' || raw === 'default') return null;
    if (raw === 'none') return { thinkingBudget: 0, includeThoughts: false };
    const level = raw === 'max' ? 'high' : raw;
    return { thinkingLevel: level, includeThoughts: effective.excludeReasoning !== true };
}

function anthropicThinkingConfig(effective = {}) {
    const raw = String(effective.reasoningEffort || '').trim().toLowerCase();
    if (!raw || raw === 'auto' || raw === 'default' || raw === 'none') return null;
    return { type: 'adaptive' };
}

function provider400ControlText(error) {
    const parts = [
        error?.message,
        error?.providerError?.message,
        error?.providerError?.code,
        error?.responsePreview,
    ].filter(Boolean);
    return parts.join(' ').toLowerCase();
}

function classifyOptionalControl400(error, requestBody = {}) {
    if (error?.httpStatus !== 400) return null;
    const text = provider400ControlText(error);
    const mentionsReasoning = /\b(reasoning|thinking)\b/.test(text);
    const reasoningMandatory = mentionsReasoning && /mandatory|required|cannot be disabled|can't be disabled|must be enabled|disable(?:d|ment)?[^.]{0,40}(?:unsupported|not supported|forbidden)/.test(text);
    if (reasoningMandatory && (requestBody.reasoning || requestBody.reasoning_effort != null || requestBody.enable_thinking === false)) {
        return { control: 'reasoning-disabled', kind: 'reasoning-mandatory' };
    }
    if ((requestBody.response_format || requestBody?.generationConfig?.responseMimeType || requestBody?.output_config?.format)
        && /response[_ -]?format|response format|json[_ -]?object|json mode|structured output|output[_ -]?config/.test(text)) {
        return { control: 'response_format', kind: 'unsupported-control' };
    }
    if (requestBody.temperature != null && /temperature/.test(text)) return { control: 'temperature', kind: 'unsupported-control' };
    if (requestBody?.generationConfig?.temperature != null && /temperature/.test(text)) return { control: 'temperature', kind: 'unsupported-control' };
    if (mentionsReasoning && (requestBody.reasoning || requestBody.reasoning_effort != null || requestBody.enable_thinking != null || requestBody.thinking || requestBody?.generationConfig?.thinkingConfig)) {
        return { control: 'reasoning', kind: 'unsupported-control' };
    }
    return null;
}

export const UNKNOWN_PROVIDER_CONTEXT_CIRCUIT_BREAKER_TOKENS = 262144;
export const UNKNOWN_PROVIDER_OUTPUT_CIRCUIT_BREAKER_TOKENS = 65536;

function positiveTokenValue(...values) {
    for (const value of values) {
        const n = Number(value);
        if (Number.isFinite(n) && n > 0) return Math.floor(n);
    }
    return null;
}

/**
 * Resolve the only transport-time token boundary Nexus is allowed to impose.
 * Workload targets do not participate here. The request maximum comes from:
 *   1) known provider/model physical context/output capacity;
 *   2) explicit non-zero user cost caps on the Sidecar profile; or
 *   3) a generous emergency breaker when provider capacity is unknown.
 */
export function resolveSidecarPhysicalRequestBoundary(profile = {}, { estimatedInputTokens = 0 } = {}) {
    const input = Math.max(0, Math.floor(Number(estimatedInputTokens) || 0));
    const providerContextTokens = positiveTokenValue(
        profile?.providerContextTokens,
        profile?.contextWindowTokens,
        profile?.contextLengthTokens,
        profile?.context_length,
    );
    const providerOutputTokens = positiveTokenValue(
        profile?.providerMaxTokens,
        profile?.maxOutputTokens,
        profile?.maxCompletionTokens,
        profile?.max_output_tokens,
    );
    const userOutputCostLimitTokens = positiveTokenValue(profile?.outputCeilingTokens);
    const userTotalCostLimitTokens = positiveTokenValue(profile?.totalBudgetTokens);
    const emergencyContextTokens = positiveTokenValue(profile?.emergencyContextTokens)
        || UNKNOWN_PROVIDER_CONTEXT_CIRCUIT_BREAKER_TOKENS;
    const emergencyOutputTokens = positiveTokenValue(profile?.emergencyOutputTokens)
        || UNKNOWN_PROVIDER_OUTPUT_CIRCUIT_BREAKER_TOKENS;

    const contextLimitTokens = providerContextTokens || emergencyContextTokens;
    const contextLimitKind = providerContextTokens ? 'provider-context' : 'emergency-context';
    const remainingContextTokens = contextLimitTokens - input;
    if (remainingContextTokens <= 0) {
        return {
            allowed: false,
            stopKind: providerContextTokens ? 'provider-boundary' : 'emergency-circuit-breaker',
            reason: `${contextLimitKind}-exhausted`,
            estimatedInputTokens: input,
            providerContextTokens,
            providerOutputTokens,
            contextLimitTokens,
            remainingContextTokens,
            userOutputCostLimitTokens,
            userTotalCostLimitTokens,
            physicalRequestMaxTokens: 0,
            sources: [contextLimitKind],
        };
    }

    let physicalRequestMaxTokens = providerOutputTokens || emergencyOutputTokens;
    const sources = [providerOutputTokens ? 'provider-output' : 'emergency-output', contextLimitKind];
    physicalRequestMaxTokens = Math.min(physicalRequestMaxTokens, remainingContextTokens);
    // Emergency breakers are Nexus observation/runaway boundaries, not evidence
    // of a provider-supported max_tokens value. Only known physical limits or
    // explicit user cost caps become a transport request maximum.
    let transportRequestMaxTokens = providerOutputTokens ? Math.min(providerOutputTokens, remainingContextTokens) : null;
    if (!transportRequestMaxTokens && providerContextTokens) transportRequestMaxTokens = remainingContextTokens;

    if (userOutputCostLimitTokens) {
        physicalRequestMaxTokens = Math.min(physicalRequestMaxTokens, userOutputCostLimitTokens);
        transportRequestMaxTokens = transportRequestMaxTokens == null
            ? userOutputCostLimitTokens
            : Math.min(transportRequestMaxTokens, userOutputCostLimitTokens);
        sources.push('user-output-cost-cap');
    }
    if (userTotalCostLimitTokens) {
        const remainingCostTokens = userTotalCostLimitTokens - input;
        if (remainingCostTokens <= 0) {
            return {
                allowed: false,
                stopKind: 'user-cost-limit',
                reason: 'user-total-cost-cap-exhausted',
                estimatedInputTokens: input,
                providerContextTokens,
                providerOutputTokens,
                contextLimitTokens,
                remainingContextTokens,
                userOutputCostLimitTokens,
                userTotalCostLimitTokens,
                physicalRequestMaxTokens: 0,
                sources: [...sources, 'user-total-cost-cap'],
            };
        }
        physicalRequestMaxTokens = Math.min(physicalRequestMaxTokens, remainingCostTokens);
        transportRequestMaxTokens = transportRequestMaxTokens == null
            ? remainingCostTokens
            : Math.min(transportRequestMaxTokens, remainingCostTokens);
        sources.push('user-total-cost-cap');
    }

    return {
        allowed: physicalRequestMaxTokens > 0,
        stopKind: physicalRequestMaxTokens > 0 ? null : 'provider-boundary',
        reason: physicalRequestMaxTokens > 0 ? null : 'no-output-capacity-remaining',
        estimatedInputTokens: input,
        providerContextTokens,
        providerOutputTokens,
        contextLimitTokens,
        remainingContextTokens,
        userOutputCostLimitTokens,
        userTotalCostLimitTokens,
        physicalRequestMaxTokens: Math.max(0, Math.floor(physicalRequestMaxTokens)),
        transportRequestMaxTokens: transportRequestMaxTokens == null ? null : Math.max(1, Math.floor(transportRequestMaxTokens)),
        sources,
        providerCapabilityKnown: !!(providerContextTokens || providerOutputTokens),
        emergencyCircuitBreakerUsed: !(providerContextTokens && providerOutputTokens),
    };
}

function boundedMandatoryReasoningTokens(physicalRequestMaxTokens) {
    const capacity = Number(physicalRequestMaxTokens);
    if (!Number.isFinite(capacity) || capacity <= 1) return null;
    // This is a no-progress guard, not a workload ceiling. Providers that make
    // reasoning mandatory still get room to think, while most of the real
    // physical completion capacity remains available for the final payload.
    const finalReserve = Math.max(1, Math.ceil(capacity * 0.60));
    const availableForReasoning = Math.max(1, Math.floor(capacity - finalReserve));
    return Math.max(1, Math.min(Math.floor(capacity * 0.25), availableForReasoning));
}

function describeRetryControls(body = {}) {
    const reasoning = body.reasoning && typeof body.reasoning === 'object' ? body.reasoning : null;
    return {
        responseFormat: body.response_format?.type || null,
        reasoningControl: !!(reasoning || body.reasoning_effort != null),
        reasoningEnabled: reasoning?.enabled ?? null,
        reasoningEffort: reasoning?.effort ?? body.reasoning_effort ?? null,
        reasoningMaxTokens: reasoning?.max_tokens != null && Number.isFinite(Number(reasoning.max_tokens)) ? Number(reasoning.max_tokens) : null,
        reasoningExclude: reasoning?.exclude === true,
        maxTokens: body.max_tokens != null && Number.isFinite(Number(body.max_tokens)) ? Number(body.max_tokens) : null,
    };
}

function buildOptionalControlRetry({ error, requestBody, effective, endpoint }) {
    const rejection = classifyOptionalControl400(error, requestBody);
    if (!rejection) return null;
    const fallbackBody = structuredClone(requestBody);
    const removedControls = [];

    if (rejection.control === 'response_format') {
        delete fallbackBody.response_format;
        if (fallbackBody.generationConfig) delete fallbackBody.generationConfig.responseMimeType;
        if (fallbackBody.output_config) {
            delete fallbackBody.output_config.format;
            if (!Object.keys(fallbackBody.output_config).length) delete fallbackBody.output_config;
        }
        removedControls.push('response_format');
    } else if (rejection.control === 'temperature') {
        delete fallbackBody.temperature;
        if (fallbackBody.generationConfig) delete fallbackBody.generationConfig.temperature;
        removedControls.push('temperature');
    } else if (rejection.control === 'reasoning-disabled' && /openrouter\.ai/i.test(endpoint) && fallbackBody.reasoning) {
        const reasoningBudget = boundedMandatoryReasoningTokens(effective.requestMaxTokens || effective.physicalRequestMaxTokens);
        fallbackBody.reasoning = reasoningBudget
            ? { max_tokens: reasoningBudget, exclude: effective.excludeReasoning === true }
            : { effort: 'minimal', exclude: effective.excludeReasoning === true };
        removedControls.push('reasoning.enabled=false', 'reasoning.effort=none');
    } else {
        // Generic reasoning-control rejection is not safe to adapt for a request
        // whose caller explicitly requires reasoning exclusion.
        if (effective.excludeReasoning === true) return null;
        delete fallbackBody.reasoning;
        delete fallbackBody.reasoning_effort;
        delete fallbackBody.enable_thinking;
        delete fallbackBody.thinking;
        if (fallbackBody.generationConfig) delete fallbackBody.generationConfig.thinkingConfig;
        removedControls.push('reasoning');
    }

    return {
        fallbackBody,
        rejectedControl: rejection.control,
        rejectionKind: rejection.kind,
        removedControls,
        retainedControls: describeRetryControls(fallbackBody),
        originalControls: describeRetryControls(requestBody),
    };
}

async function fetchJsonWithOptionalControlAdaptation({ profile, endpoint, headers, requestBody, effective, signal, timeoutMs, label, meta }) {
    let body = structuredClone(requestBody);
    const learned = providerCapability(profile, endpoint);
    if (learned?.responseFormatUnsupported) {
        delete body.response_format;
        if (body.generationConfig) delete body.generationConfig.responseMimeType;
        if (body.output_config) {
            delete body.output_config.format;
            if (!Object.keys(body.output_config).length) delete body.output_config;
        }
    }
    if (learned?.temperatureUnsupported) {
        delete body.temperature;
        if (body.generationConfig) delete body.generationConfig.temperature;
    }

    for (let adaptation = 0; adaptation <= 3; adaptation += 1) {
        try {
            return await fetchJson(endpoint, { method: 'POST', headers, body: JSON.stringify(body) }, { signal, timeoutMs, label });
        } catch (error) {
            if (adaptation >= 3) throw error;
            const retryPlan = buildOptionalControlRetry({ error, requestBody: body, effective, endpoint });
            if (!retryPlan) throw error;
            if (retryPlan.rejectionKind === 'reasoning-mandatory') {
                const next = rememberReasoningMandatory(profile, endpoint);
                logEvent('sidecar', 'provider-capability-learned', { ...meta, capability: 'reasoning-mandatory', learnedAt: next.learnedAt }, 'info');
            }
            if (retryPlan.rejectedControl === 'response_format') rememberProviderCapability(profile, endpoint, { responseFormatUnsupported: true });
            if (retryPlan.rejectedControl === 'temperature') rememberProviderCapability(profile, endpoint, { temperatureUnsupported: true });
            logEvent('sidecar', 'structured-control-fallback', {
                ...meta,
                adaptation: adaptation + 1,
                provider400Control: retryPlan.rejectedControl,
                provider400Kind: retryPlan.rejectionKind,
                provider400Reason: error?.message || String(error),
                removedControls: retryPlan.removedControls,
                retainedControls: retryPlan.retainedControls,
                originalControls: retryPlan.originalControls,
            }, 'warn');
            body = retryPlan.fallbackBody;
        }
    }
    throw new Error(`${label} exhausted optional-control adaptations.`);
}

function reasoningExhaustionError(normalized, effective, label) {
    const usage = normalized?.usageNormalized || {};
    const reasoningTokens = Number(usage.reasoningTokens);
    const visibleOutputTokens = Number(usage.visibleOutputTokens);
    const providerOutputTokens = Number(usage.outputTokens);
    const finishReason = String(normalized?.finishReason || '').toLowerCase();
    if (!['length', 'max_tokens', 'max_output_tokens'].includes(finishReason)) return null;
    if (!Number.isFinite(reasoningTokens) || reasoningTokens <= 0) return null;
    const visible = Number.isFinite(visibleOutputTokens) ? Math.max(0, visibleOutputTokens) : 0;
    const observedCompletion = Number.isFinite(providerOutputTokens) && providerOutputTokens > 0
        ? providerOutputTokens
        : reasoningTokens + visible;
    const reasoningDominated = observedCompletion > 0 && reasoningTokens >= Math.floor(observedCompletion * 0.90);
    const finalStarved = visible <= Math.max(16, Math.ceil(observedCompletion * 0.02));
    if (!reasoningDominated || !finalStarved) return null;

    const error = new Error(`${label} reached a provider completion boundary with no structural progress: ${reasoningTokens} reasoning tokens and ${visible} visible final tokens.`);
    error.name = 'NexusSidecarReasoningExhausted';
    error.reasoningExhaustion = {
        finishReason: normalized?.finishReason || null,
        physicalRequestMaxTokens: positiveTokenValue(effective?.physicalRequestMaxTokens),
        providerOutputTokens: Number.isFinite(providerOutputTokens) ? providerOutputTokens : null,
        reasoningTokens,
        visibleOutputTokens: visible,
        finalOutputStarved: true,
    };
    error.sidecarResult = {
        ...normalized,
        text: '',
        reasoning: '',
        raw: null,
    };
    return error;
}

function runawayCompletionError(normalized, label) {
    const finishReason = String(normalized?.finishReason || '').toLowerCase();
    if (!['length', 'max_tokens', 'max_output_tokens'].includes(finishReason)) return null;
    const text = String(normalized?.text || '');
    if (text.length < 4096) return null;
    const tail = text.slice(-8192);
    const unitSize = 192;
    if (tail.length < unitSize * 6) return null;
    const unit = tail.slice(-unitSize);
    if (!unit.trim()) return null;
    let repeats = 0;
    let cursor = tail.length;
    while (cursor >= unitSize && tail.slice(cursor - unitSize, cursor) === unit) {
        repeats += 1;
        cursor -= unitSize;
    }
    if (repeats < 6) return null;
    const error = new Error(`${label} was stopped as runaway output after ${repeats} identical trailing blocks with no structural progress.`);
    error.name = 'NexusSidecarRunawayDetected';
    error.runaway = { kind: 'repeated-tail', repeats, unitChars: unitSize, finishReason: normalized?.finishReason || null };
    error.sidecarResult = { ...normalized, text: '', reasoning: '', raw: null };
    return error;
}

function telemetryBase(telemetry, effective, label, estimate) {
    return {
        slot: String(telemetry?.slot || '?').toUpperCase(),
        role: telemetry?.role || 'direct',
        bus: telemetry?.bus || telemetry?.role || 'direct',
        routeId: telemetry?.routeId || null,
        jobId: telemetry?.jobId || null,
        parentJobId: telemetry?.parentJobId || null,
        attempt: telemetry?.attempt || null,
        executionMode: telemetry?.executionMode || null,
        phase: telemetry?.phase || null,
        nexusBatchDomain: telemetry?.nexusBatchDomain || null,
        adaptiveWorkloadType: telemetry?.adaptiveWorkloadType || null,
        adaptiveBatchItems: Number(telemetry?.adaptiveBatchItems) || 0,
        adaptiveContractVersion: telemetry?.adaptiveContractVersion || null,
        resourcePolicy: telemetry?.resourcePolicy || null,
        nexusChatEpoch: currentNexusChatEpoch(),
        label,
        model: effective.model,
        format: effective.format,
        endpointHost: (() => { try { return new URL(effective.endpoint).host; } catch { return effective.endpoint; } })(),
        providerMaxTokens: effective.providerMaxTokens,
        providerContextTokens: effective.providerContextTokens,
        softInputTargetTokens: effective.softInputTargetTokens,
        softOutputTargetTokens: effective.softOutputTargetTokens,
        softTotalTargetTokens: effective.softTotalTargetTokens,
        requestedMaxTokens: effective.requestedMaxTokens,
        userOutputCostLimitTokens: effective.userOutputCostLimitTokens,
        userTotalCostLimitTokens: effective.userTotalCostLimitTokens,
        physicalContextLimitTokens: effective.physicalContextLimitTokens,
        physicalRequestMaxTokens: effective.physicalRequestMaxTokens,
        requestMaxTokens: effective.requestMaxTokens,
        enforceRequestedMaxTokens: effective.enforceRequestedMaxTokens === true,
        physicalBoundarySources: effective.physicalBoundarySources || [],
        temperature: effective.temperature,
        requestedReasoningEffort: effective.requestedReasoningEffort || effective.reasoningEffort,
        reasoningEffort: effective.reasoningEffort,
        reasoningDecision: effective.reasoningDecision || null,
        recoverableSemanticAttempt: telemetry?.recoverableSemanticAttempt === true,
        excludeReasoning: effective.excludeReasoning,
        responseFormat: effective.responseFormat,
        timeoutMs: effective.timeoutMs,
        estimate,
    };
}

export async function callSidecar(profile, {
    prompt,
    systemPrompt = '',
    maxTokens,
    inputBudgetTokens: jobInputBudgetTokens,
    totalBudgetTokens: jobTotalBudgetTokens,
    temperature,
    reasoningEffort,
    excludeReasoning = false,
    // `json_object` is used only by structured Nexus worker transforms. The
    // OpenAI-compatible path below retries once without it when an older
    // provider rejects response_format, so the feature never makes a Sidecar
    // unusable by itself.
    responseFormat = null,
    structuredValidator = null,
    structuredCandidateComposer = null,
    timeoutMs,
    signal,
    label = 'Nexus Sidecar',
    telemetry = {},
} = {}) {
    const startedAt = globalThis.performance?.now?.() ?? Date.now();
    let meta = {
        slot: String(telemetry?.slot || '?').toUpperCase(),
        role: telemetry?.role || 'direct',
        bus: telemetry?.bus || telemetry?.role || 'direct',
        routeId: telemetry?.routeId || null,
        jobId: telemetry?.jobId || null,
        label,
        nexusChatEpoch: currentNexusChatEpoch(),
    };

    try {
        if (!profile?.enabled) throw new Error(`${label} is disabled.`);
        if (!profile.endpoint || !profile.model) throw new Error(`${label} is missing endpoint/model configuration.`);
        const positiveOrNull = value => { const n = Number(value); return Number.isFinite(n) && n > 0 ? Math.floor(n) : null; };
        // Workload maxTokens and job budgets are SOFT planning targets. They may
        // be exceeded by a valid completion and never become transport stops.
        const requestedMax = positiveOrNull(maxTokens);
        const profileInputTarget = positiveOrNull(profile.inputBudgetTokens);
        const jobInputTarget = positiveOrNull(jobInputBudgetTokens);
        const softInputTargetTokens = profileInputTarget && jobInputTarget
            ? Math.min(profileInputTarget, jobInputTarget)
            : (jobInputTarget || profileInputTarget);
        const jobTotalTarget = positiveOrNull(jobTotalBudgetTokens);
        const softTotalTargetTokens = jobTotalTarget;
        const userOutputCostLimitTokens = positiveOrNull(profile.outputCeilingTokens);
        const userTotalCostLimitTokens = positiveOrNull(profile.totalBudgetTokens);
        const configuredProviderMax = positiveOrNull(profile.providerMaxTokens);
        const configuredProviderContext = positiveOrNull(
            profile.providerContextTokens
            ?? profile.contextWindowTokens
            ?? profile.contextLengthTokens
            ?? profile.context_length,
        );
        const effective = {
            ...profile,
            providerMaxTokens: configuredProviderMax,
            providerContextTokens: configuredProviderContext,
            softInputTargetTokens,
            softOutputTargetTokens: requestedMax,
            softTotalTargetTokens,
            requestedMaxTokens: requestedMax,
            userOutputCostLimitTokens,
            userTotalCostLimitTokens,
            physicalContextLimitTokens: null,
            physicalRequestMaxTokens: null,
            requestMaxTokens: null,
            // Caller/workload maxTokens is always advisory. Explicit user caps
            // are already folded into resolveSidecarPhysicalRequestBoundary().
            enforceRequestedMaxTokens: false,
            physicalBoundarySources: [],
            temperature: temperature ?? profile.temperature ?? 0.3,
            reasoningEffort: reasoningEffort ?? profile.reasoningEffort ?? 'auto',
            excludeReasoning: excludeReasoning === true,
            responseFormat: responseFormat === 'json_object' ? 'json_object' : null,
            structuredValidator: typeof structuredValidator === 'function' ? structuredValidator : null,
            structuredCandidateComposer: typeof structuredCandidateComposer === 'function' ? structuredCandidateComposer : null,
            // Resolved after input estimation so workload size can extend the
            // configured worker baseline. Caller values are minimum requested
            // headroom, never a lower transport ceiling.
            timeoutMs: null,
        };
        const format = String(effective.format || 'openai').toLowerCase();
        if (!['openai', 'anthropic', 'google'].includes(format)) throw new Error(`Unsupported Sidecar provider format: ${format}`);
        const inputEstimate = estimateSidecarCall({ format, model: effective.model, systemPrompt, prompt, maxTokens: null });
        const physical = resolveSidecarPhysicalRequestBoundary(effective, { estimatedInputTokens: inputEstimate.inputTokens });
        if (!physical.allowed) {
            const message = physical.stopKind === 'user-cost-limit'
                ? `${label} cannot run within the explicit Sidecar user cost limit (${physical.estimatedInputTokens} estimated input tokens).`
                : physical.stopKind === 'emergency-circuit-breaker'
                    ? `${label} exceeded Nexus's emergency unknown-provider context circuit breaker (${physical.estimatedInputTokens} estimated input / ${physical.contextLimitTokens} emergency tokens).`
                    : `${label} exceeds the known provider/model context boundary (${physical.estimatedInputTokens} estimated input / ${physical.contextLimitTokens} available context tokens).`;
            const err = new Error(message);
            err.name = physical.stopKind === 'user-cost-limit'
                ? 'NexusSidecarCostLimitError'
                : physical.stopKind === 'emergency-circuit-breaker'
                    ? 'NexusSidecarRunawayDetected'
                    : 'NexusSidecarProviderBoundaryError';
            err.physicalBoundary = physical;
            if (err.name === 'NexusSidecarRunawayDetected') err.runaway = { kind: 'unknown-provider-context-circuit-breaker', ...physical };
            throw err;
        }
        effective.physicalContextLimitTokens = physical.contextLimitTokens;
        effective.physicalRequestMaxTokens = physical.physicalRequestMaxTokens;
        effective.requestMaxTokens = physical.transportRequestMaxTokens;
        const reasoningDecision = resolveAutoReasoningEffort({
            requested: effective.reasoningEffort,
            role: telemetry?.role,
            bus: telemetry?.bus,
            domain: telemetry?.nexusBatchDomain,
            phase: telemetry?.phase,
            attempt: telemetry?.attempt,
            inputTokens: inputEstimate.inputTokens,
            plannedOutputTokens: requestedMax || telemetry?.resourcePolicy?.softOutputTargetTokens || 0,
            responseFormat: effective.responseFormat,
            structuredValidator: effective.structuredValidator,
            prompt,
            systemPrompt,
            providerCapability: providerCapability(effective, normalizeOpenAIEndpoint(effective.endpoint)),
        });
        effective.requestedReasoningEffort = reasoningDecision.requested;
        effective.reasoningEffort = reasoningDecision.effective;
        effective.reasoningDecision = reasoningDecision;
        effective.timeoutMs = resolveSidecarTransportTimeout({
            profileTimeoutMs: profile.timeoutMs,
            requestedTimeoutMs: timeoutMs,
            estimatedInputTokens: inputEstimate.inputTokens,
            plannedInputTokens: telemetry?.resourcePolicy?.softInputTargetTokens || softInputTargetTokens || 0,
            plannedOutputTokens: requestedMax || telemetry?.resourcePolicy?.softOutputTargetTokens || 0,
            requestMaxTokens: effective.requestMaxTokens || 0,
            reasoningEffort: effective.reasoningEffort,
        });
        effective.physicalBoundarySources = physical.sources;
        effective.providerCapabilityKnown = physical.providerCapabilityKnown;
        effective.emergencyCircuitBreakerUsed = physical.emergencyCircuitBreakerUsed;
        const providerRequestCeiling = effective.requestMaxTokens;
        const estimate = estimateSidecarCall({ format, model: effective.model, systemPrompt, prompt, maxTokens: providerRequestCeiling });
        meta = telemetryBase(telemetry, effective, label, estimate);
        if (telemetry?.capturePayloads !== false) {
            meta.systemPrompt = systemPrompt;
            meta.prompt = prompt;
        }
        recordSidecarPlan(meta);
        recordSidecarStart(meta);

        let normalized;
        if (format === 'anthropic') {
            const endpoint = appendEndpointPath(anthropicBase(effective.endpoint), '/messages');
            const headers = { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' };
            if (effective.apiKey) headers['x-api-key'] = effective.apiKey;
            if (!effective.requestMaxTokens) {
                // Anthropic requires max_tokens. Do not fabricate an unknown
                // provider maximum from Nexus's emergency breaker.
                throw Object.assign(new Error(`${label}: Anthropic Messages requires a known provider output/context boundary or explicit user output/total cap.`), { name: 'NexusSidecarProviderBoundaryError' });
            }
            const thinking = anthropicThinkingConfig(effective);
            const body = {
                model: effective.model,
                system: systemPrompt || undefined,
                messages: [{ role: 'user', content: prompt }],
                max_tokens: effective.requestMaxTokens,
            };
            if (effective.temperature != null && !thinking) body.temperature = effective.temperature;
            if (thinking) {
                body.thinking = thinking;
                body.output_config = { ...(body.output_config || {}), effort: normalizedEffort(effective) };
            }
            if (effective.responseFormat === 'json_object') {
                body.output_config = {
                    ...(body.output_config || {}),
                    format: { type: 'json_schema', schema: { type: 'object', additionalProperties: true } },
                };
            }
            const data = await fetchJsonWithOptionalControlAdaptation({
                profile: effective, endpoint, headers, requestBody: body, effective,
                signal, timeoutMs: effective.timeoutMs, label, meta,
            });
            normalized = normalizeAnthropicResponse(data);
        } else if (format === 'google') {
            let endpoint = appendEndpointPath(googleModelsBase(effective.endpoint), `/${effective.model}:generateContent`);
            endpoint = withQueryParam(endpoint, 'key', effective.apiKey || '');
            const generationConfig = {};
            if (effective.temperature != null) generationConfig.temperature = effective.temperature;
            if (effective.requestMaxTokens) generationConfig.maxOutputTokens = effective.requestMaxTokens;
            if (effective.responseFormat === 'json_object') generationConfig.responseMimeType = 'application/json';
            const thinkingConfig = googleThinkingConfig(effective);
            if (thinkingConfig) generationConfig.thinkingConfig = thinkingConfig;
            const body = {
                contents: [{ role: 'user', parts: [{ text: prompt }] }],
                generationConfig,
            };
            if (systemPrompt) body.systemInstruction = { parts: [{ text: systemPrompt }] };
            const data = await fetchJsonWithOptionalControlAdaptation({
                profile: effective, endpoint, headers: { 'content-type': 'application/json' }, requestBody: body, effective,
                signal, timeoutMs: effective.timeoutMs, label, meta,
            });
            normalized = normalizeGoogleResponse(data);
        } else {
            const endpoint = normalizeOpenAIEndpoint(effective.endpoint);
            const headers = providerAuthHeaders(effective, endpoint, { json: true });
            const messages = [];
            if (systemPrompt) messages.push({ role: openAIInstructionRole(effective.model), content: systemPrompt });
            messages.push({ role: 'user', content: prompt });
            const profileForReasoning = { ...effective, reasoningEffort: effective.reasoningEffort };
            const learnedCapability = providerCapability(profileForReasoning, endpoint);
            if (learnedCapability?.reasoningMandatory) {
                logEvent('sidecar', 'provider-capability-reused', { ...meta, capability: 'reasoning-mandatory', learnedAt: learnedCapability.learnedAt }, 'debug');
            }
            const requestBody = { model: effective.model, messages, ...reasoningPayload(profileForReasoning, endpoint, { exclude: effective.excludeReasoning, requestMaxTokens: effective.requestMaxTokens || effective.physicalRequestMaxTokens }) };
            if (effective.temperature != null && openAISupportsTemperature(effective.model)) requestBody.temperature = effective.temperature;
            if (effective.requestMaxTokens) {
                if (openAIUsesCompletionTokens(effective.model)) requestBody.max_completion_tokens = effective.requestMaxTokens;
                else requestBody.max_tokens = effective.requestMaxTokens;
            }
            if (effective.responseFormat === 'json_object') requestBody.response_format = { type: 'json_object' };
            const data = await fetchJsonWithOptionalControlAdaptation({
                profile: profileForReasoning, endpoint, headers, requestBody, effective,
                signal, timeoutMs: effective.timeoutMs, label, meta,
            });
            normalized = normalizeOpenAIResponse(data);
        }

        // HTTP success does not imply a final assistant answer. Provider
        // terminal/refusal/safety/tool states must fail closed before any
        // semantic parser can reinterpret partial text as valid workload data.
        assertProviderTerminalState(normalized, label);
        const exhaustion = reasoningExhaustionError(normalized, effective, label);
        if (exhaustion) throw exhaustion;
        const runaway = runawayCompletionError(normalized, label);
        if (runaway) throw runaway;

        // Treat only explicit response-format instructions as structured intent.
        // Ordinary prose such as "this function will return a JSON object" must
        // not silently switch semantic parsing modes (C03-37).
        const structuredInstruction = text => /(?:^|\n)\s*(?:please\s+)?(?:return|respond|reply|output|emit)\s+(?:only\s+)?(?:valid\s+|strict\s+|exact\s+)?json\b|\bjson[- ]only\b/i.test(String(text || ''));
        const structuredExpected = effective.responseFormat === 'json_object'
            || typeof effective.structuredValidator === 'function'
            || structuredInstruction(systemPrompt)
            || structuredInstruction(prompt);
        let separated;
        try {
            separated = separateVisibleThinking(normalized.text, {
                structured: structuredExpected,
                validator: structuredExpected ? effective.structuredValidator : null,
                candidateComposer: structuredExpected ? effective.structuredCandidateComposer : null,
                label,
            });
        } catch (error) {
            // Semantic rejection occurs after a real provider response exists.
            // Preserve usage/finish/http metadata for diagnostics, but never
            // expose the raw unvalidated provider envelope as a usable result.
            // The semantic error itself carries only a bounded rejected-final
            // sample plus validator reasons for operator diagnosis.
            if (error?.semantic === true && !error.sidecarResult) {
                error.sidecarResult = {
                    ...normalized,
                    text: '',
                    reasoning: '',
                    raw: null,
                };
            }
            throw error;
        }
        if (structuredExpected && separated.value !== undefined) {
            normalized.structuredPayload = separated.value;
            normalized.structuredValidated = true;
        }
        if (separated.separated) {
            normalized.text = separated.text;
            normalized.reasoning = [normalized.reasoning, separated.reasoning].filter(Boolean).join('\n\n').trim();
            normalized.thinkingSeparated = true;
            logEvent('sidecar', 'visible-thinking-separated', {
                ...meta,
                finalChars: normalized.text.length,
                separatedReasoningChars: separated.reasoning.length,
                responseFormat: effective.responseFormat,
                structuredExpected,
            }, 'debug');
        }

        normalized.usageEstimated = {
            inputTokens: estimate.inputTokens,
            visibleOutputTokens: estimateContentTokens(normalized.text || '', effective.model),
            reasoningTokens: estimateContentTokens(normalized.reasoning || '', effective.model),
        };
        normalized.usageEstimated.outputTokens = normalized.usageEstimated.visibleOutputTokens + normalized.usageEstimated.reasoningTokens;
        normalized.usageEstimated.totalTokens = normalized.usageEstimated.inputTokens + normalized.usageEstimated.outputTokens;
        const result = assertFinalContent(normalized, label);

        // Workload output targets are observations only. A valid completion may
        // exceed 1600/2048/3072/etc. without being rejected. Hard enforcement is
        // limited to explicit user cost limits; provider/context boundaries were
        // already applied before transport, and runaway/no-progress checks run
        // before semantic parsing.
        const physicalMax = positiveOrNull(effective.physicalRequestMaxTokens);
        const softTarget = positiveOrNull(effective.softOutputTargetTokens);
        const providerOutputTokens = positiveOrNull(result?.usageNormalized?.outputTokens);
        const finalEstimatedTokens = positiveOrNull(result?.usageEstimated?.visibleOutputTokens) || 0;
        const reasoningEstimatedTokens = positiveOrNull(result?.usageEstimated?.reasoningTokens) || 0;
        const estimatedOutputTokens = positiveOrNull(result?.usageEstimated?.outputTokens) || (finalEstimatedTokens + reasoningEstimatedTokens);
        const estimatedTotalTokens = positiveOrNull(result?.usageEstimated?.totalTokens) || ((positiveOrNull(result?.usageEstimated?.inputTokens) || 0) + estimatedOutputTokens);
        const softTargetExceeded = !!(softTarget && finalEstimatedTokens > softTarget);
        const userOutputCostLimit = positiveOrNull(effective.userOutputCostLimitTokens);
        const userTotalCostLimit = positiveOrNull(effective.userTotalCostLimitTokens);
        const providerTotalTokens = positiveOrNull(result?.usageNormalized?.totalTokens);
        // Providers are not allowed to bypass explicit user cost caps merely by
        // omitting usage. Fall back to Nexus's conservative local estimate.
        const accountedOutputTokens = providerOutputTokens || estimatedOutputTokens;
        const accountedTotalTokens = providerTotalTokens || estimatedTotalTokens;
        const outputCostOverrun = !!(userOutputCostLimit && accountedOutputTokens > userOutputCostLimit);
        const totalCostOverrun = !!(userTotalCostLimit && accountedTotalTokens > userTotalCostLimit);
        const userCostOverrun = outputCostOverrun || totalCostOverrun;
        result.resourceCompliance = {
            softOutputTargetTokens: softTarget,
            softTargetExceeded,
            physicalRequestMaxTokens: physicalMax,
            requestMaxTokens: positiveOrNull(effective.requestMaxTokens),
            enforceRequestedMaxTokens: effective.enforceRequestedMaxTokens === true,
            physicalContextLimitTokens: positiveOrNull(effective.physicalContextLimitTokens),
            providerOutputTokens,
            accountedOutputTokens,
            finalEstimatedTokens,
            reasoningEstimatedTokens,
            userOutputCostLimitTokens: userOutputCostLimit,
            userTotalCostLimitTokens: userTotalCostLimit,
            providerTotalTokens,
            accountedTotalTokens,
            outputCostOverrun,
            totalCostOverrun,
            userCostOverrun,
            emergencyCircuitBreakerUsed: effective.emergencyCircuitBreakerUsed === true,
            thinkingSeparated: result.thinkingSeparated === true,
        };
        if (softTargetExceeded) {
            logEvent('sidecar', 'soft-output-target-exceeded', {
                ...meta,
                softOutputTargetTokens: softTarget,
                finalEstimatedTokens,
                providerOutputTokens,
                physicalRequestMaxTokens: physicalMax,
                requestMaxTokens: positiveOrNull(effective.requestMaxTokens),
                enforceRequestedMaxTokens: effective.enforceRequestedMaxTokens === true,
                note: effective.enforceRequestedMaxTokens === true ? 'Structured transport is bounded by the requested max.' : 'Accepted: workload token targets are planning hints, not hard stops.',
            }, 'debug');
        }
        if (userCostOverrun) {
            const totalMessage=totalCostOverrun?`${accountedTotalTokens} accounted total tokens / ${userTotalCostLimit} allowed`:null;
            const outputMessage=outputCostOverrun?`${accountedOutputTokens} accounted output tokens / ${userOutputCostLimit} allowed`:null;
            const error = new Error(`${label} exceeded the explicit user ${totalCostOverrun?'total':'output'} cost limit (${[totalMessage,outputMessage].filter(Boolean).join('; ')}).`);
            error.name = 'NexusSidecarCostLimitError';
            error.sidecarResult = result;
            error.costLimit = {
                kind: totalCostOverrun ? 'total' : 'output',
                providerOutputTokens: accountedOutputTokens,
                providerTotalTokens: accountedTotalTokens,
                outputAllowedTokens: userOutputCostLimit,
                totalAllowedTokens: userTotalCostLimit,
            };
            throw error;
        }
        const elapsed = (globalThis.performance?.now?.() ?? Date.now()) - startedAt;
        result.tv2 = {
            ...(result.tv2 || {}),
            requestedReasoningEffort: effective.requestedReasoningEffort || 'auto',
            effectiveReasoningEffort: effective.reasoningEffort || null,
            reasoningDecision: effective.reasoningDecision || null,
        };
        recordSidecarResult(meta, result, elapsed);
        return result;
    } catch (err) {
        const elapsed = (globalThis.performance?.now?.() ?? Date.now()) - startedAt;
        recordSidecarError(meta, err, elapsed);
        const cancelled = isIntentionalCancellation(err, signal);
        const foregroundAbort = isForegroundAbort(err, signal);
        const semanticRepair=meta?.recoverableSemanticAttempt===true&&err?.semantic===true;
        logEvent('sidecar', cancelled ? (foregroundAbort ? 'call-preempted' : 'call-cancelled') : (semanticRepair?'call-semantic-repair-needed':'call-threw'), { ...meta, error: err }, cancelled ? 'debug' : (semanticRepair?'warn':'error'));
        throw err;
    }
}
