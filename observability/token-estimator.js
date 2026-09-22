/**
 * Nexus lightweight token predictor.
 *
 * This is deliberately provider-agnostic and dependency-free so it can run in
 * the SillyTavern browser without shipping a tokenizer bundle. Predictions are
 * always displayed as estimates (≈). Provider-reported usage replaces them
 * after a call completes.
 */

const CJK_RE = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]/u;
const PUNCT_RE = /[{}\[\]():,.;<>/\\|=_*#`~@$%^&+!?-]/u;

export function estimateTextTokens(text, { model = '' } = {}) {
    const value = String(text || '');
    if (!value) return 0;

    let cjk = 0;
    let astral = 0;
    let punctuation = 0;
    let ordinary = 0;

    for (const ch of value) {
        const cp = ch.codePointAt(0) || 0;
        if (CJK_RE.test(ch)) cjk += 1;
        else if (cp > 0xFFFF) astral += 1;
        else {
            ordinary += 1;
            if (PUNCT_RE.test(ch)) punctuation += 1;
        }
    }

    // Most English prose for the models Nexus targets sits around 3.5–4.2 chars
    // per token. Structured JSON/code is denser, so nudge the estimate upward.
    const lowerModel = String(model || '').toLowerCase();
    let charsPerToken = 4.0;
    if (/claude|anthropic/.test(lowerModel)) charsPerToken = 3.8;
    else if (/glm|mimo|deepseek|qwen/.test(lowerModel)) charsPerToken = 3.7;
    else if (/gemini/.test(lowerModel)) charsPerToken = 4.0;
    else if (/gpt|o1|o3|o4/.test(lowerModel)) charsPerToken = 3.9;

    let estimate = ordinary / charsPerToken;
    estimate += cjk * 1.15;
    estimate += astral * 1.8;

    const punctuationRatio = ordinary > 0 ? punctuation / ordinary : 0;
    if (punctuationRatio > 0.12) estimate *= 1.10;
    if (value.includes('```') || value.trimStart().startsWith('{') || value.trimStart().startsWith('[')) estimate *= 1.05;

    return Math.max(1, Math.ceil(estimate));
}

export function estimateSidecarCall({ format = 'openai', model = '', systemPrompt = '', prompt = '', maxTokens = null } = {}) {
    const systemTokens = estimateTextTokens(systemPrompt, { model });
    const promptTokens = estimateTextTokens(prompt, { model });
    // Chat wrappers add role/message framing. Google concatenates system+user in
    // our client, so its envelope is a little smaller.
    const envelopeTokens = format === 'google'
        ? (systemPrompt ? 6 : 3)
        : (systemPrompt ? 14 : 8);
    const inputTokens = systemTokens + promptTokens + envelopeTokens;
    const explicitCeiling = Number(maxTokens);
    const outputCeilingTokens = Number.isFinite(explicitCeiling) && explicitCeiling > 0 ? explicitCeiling : null;
    return {
        systemTokens,
        promptTokens,
        envelopeTokens,
        inputTokens,
        outputCeilingTokens,
        maxTotalTokens: outputCeilingTokens == null ? null : inputTokens + outputCeilingTokens,
        systemChars: String(systemPrompt || '').length,
        promptChars: String(prompt || '').length,
    };
}

export function estimateContentTokens(text, model = '') {
    return estimateTextTokens(text, { model });
}

/**
 * Best-effort identifier for the model that will receive SillyTavern's Main
 * prompt.  Token estimation remains dependency-free, but callers that budget
 * Main-prompt material must not accidentally use a Sidecar model merely
 * because that model happened to perform the preceding selection step.
 *
 * SillyTavern/provider adapters expose the selected model under different
 * settings objects, so intentionally inspect only well-known model-shaped
 * fields and otherwise return an empty hint (the estimator's generic path).
 */
const CHAT_SOURCE_MODEL_FIELDS = Object.freeze({
    openai: ['openai_model'],
    claude: ['claude_model'],
    anthropic: ['claude_model'],
    openrouter: ['openrouter_model'],
    makersuite: ['google_model'],
    google: ['google_model'],
    vertexai: ['vertexai_model','google_model'],
    deepseek: ['deepseek_model'],
    zai: ['zai_model'],
    zhipu: ['zai_model'],
    mistralai: ['mistralai_model'],
    cohere: ['cohere_model'],
    perplexity: ['perplexity_model'],
    ai21: ['ai21_model'],
    groq: ['groq_model'],
    chutes: ['chutes_model'],
    siliconflow: ['siliconflow_model'],
    minimax: ['minimax_model'],
    electronhub: ['electronhub_model'],
    nanogpt: ['nanogpt_model'],
    aimlapi: ['aimlapi_model'],
    xai: ['xai_model'],
    pollinations: ['pollinations_model'],
    custom: ['custom_model'],
    'xiaomi-mimo': ['custom_model','model'],
    'deepseek-direct': ['custom_model','deepseek_model','model'],
    'openai-direct': ['custom_model','openai_model','model'],
    'openai-proxy': ['openai_model','model'],
    'deepseek-proxy': ['deepseek_model','model'],
    'claude-proxy': ['claude_model','model'],
    'alibaba-model-studio': ['custom_model','model'],
});

function firstString(source, fields = []) {
    if (!source || typeof source !== 'object') return '';
    for (const field of fields) {
        const value = source?.[field];
        if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return '';
}

function firstPartyProviderFromUrl(source = null) {
    const raw=firstString(source,['custom_url','customUrl','api_url','apiUrl','base_url','baseUrl','reverse_proxy']);
    if(!raw)return '';
    try{
        const host=new URL(raw).hostname.toLowerCase();
        if(host==='api.xiaomimimo.com'||host.endsWith('.xiaomimimo.com'))return 'xiaomi-mimo';
        if(host==='api.deepseek.com')return 'deepseek-direct';
        if(host==='api.openai.com')return 'openai-direct';
        if((host.endsWith('.aliyuncs.com')&&(host.startsWith('dashscope')||host.startsWith('cn-hongkong.dashscope')))||host.endsWith('.maas.aliyuncs.com'))return 'alibaba-model-studio';
    }catch{}
    return '';
}
function normalizeProviderRoute(source,raw=''){
    const provider=String(raw||'').trim();
    if(!provider)return '';
    const lower=provider.toLowerCase();
    if(lower==='custom'){
        const firstParty=firstPartyProviderFromUrl(source);
        if(firstParty)return firstParty;
        return provider;
    }
    const reverseProxy=firstString(source,['reverse_proxy','reverseProxy']);
    if(reverseProxy){
        const firstParty=firstPartyProviderFromUrl({custom_url:reverseProxy});
        if(firstParty)return firstParty;
        if(lower==='openai')return 'openai-proxy';
        if(lower==='deepseek')return 'deepseek-proxy';
        if(lower==='claude'||lower==='anthropic')return 'claude-proxy';
        return `${lower}-proxy`;
    }
    return provider;
}

export function resolveMainProviderHint(context = null) {
    const ctx = context && typeof context === 'object' ? context : {};
    const directSource = firstString(ctx, ['chat_completion_source','chatCompletionSource']);
    if (directSource) {
        const nested=ctx.chatCompletionSettings&&typeof ctx.chatCompletionSettings==='object'?ctx.chatCompletionSettings:{};
        return normalizeProviderRoute({...nested,...ctx},directSource);
    }

    const chatSources = [
        ctx.chatCompletionSettings,
        globalThis?.oai_settings,
    ].filter(value => value && typeof value === 'object');
    for (const source of chatSources) {
        const value = firstString(source, ['chat_completion_source','chatCompletionSource','provider']);
        if (value) return normalizeProviderRoute(source,value);
    }

    const directProvider=firstString(ctx,['provider']);
    if(directProvider)return normalizeProviderRoute(ctx,directProvider);

    const textSources = [
        ctx.textCompletionSettings,
        globalThis?.textgenerationwebui_settings,
    ].filter(value => value && typeof value === 'object');
    for (const source of textSources) {
        const value = firstString(source, ['provider','source','type']);
        if (value) return normalizeProviderRoute(source,value);
    }

    return typeof ctx.mainApi === 'string' && ctx.mainApi.trim() ? ctx.mainApi.trim() : '';
}

/**
 * Best-effort identifier for the exact Main model selected by SillyTavern.
 *
 * SillyTavern keeps model selections for many providers in the same settings
 * object at once. Therefore this resolver MUST be source-aware: returning the
 * first non-empty "*_model" field can classify an OpenRouter MiMo/Qwen/GLM
 * request as OpenAI simply because openai_model is also populated.
 */
export function resolveMainModelHint(context = null) {
    const ctx = context && typeof context === 'object' ? context : {};

    // Exact request/model metadata wins when SillyTavern exposes it directly.
    const direct = firstString(ctx, ['mainModel','model','modelId','model_id']);
    if (direct) return direct;

    const chatSettings = [
        ctx.chatCompletionSettings,
        globalThis?.oai_settings,
    ].filter(value => value && typeof value === 'object');
    const provider = String(resolveMainProviderHint(ctx) || '').trim().toLowerCase();
    const sourceFields = CHAT_SOURCE_MODEL_FIELDS[provider] || [];

    if (sourceFields.length) {
        for (const source of chatSettings) {
            const selected = firstString(source, sourceFields);
            if (selected) return selected;
        }
    }

    // Text-completion backends generally expose the active model directly or
    // under a backend-specific model field. Prefer explicit current values and
    // OpenRouter's selected model before any generic fallback.
    const textSources = [
        ctx.textCompletionSettings,
        globalThis?.textgenerationwebui_settings,
    ].filter(value => value && typeof value === 'object');
    for (const source of textSources) {
        const selected = firstString(source, [
            'model','modelId','model_id','openrouter_model','custom_model',
            'generic_model','ollama_model','vllm_model',
        ]);
        if (selected) return selected;
    }

    // Last-resort request-shaped fields only. Do not scan every provider model
    // slot: stale populated settings are worse than returning no hint.
    for (const source of [ctx, ...chatSettings]) {
        const selected = firstString(source, ['custom_model','model_name']);
        if (selected) return selected;
    }
    return '';
}

export function formatTokenCount(value, { approximate = false } = {}) {
    if (value === null || value === undefined || value === '' || !Number.isFinite(Number(value))) return '—';
    const n = Math.max(0, Math.round(Number(value)));
    const formatted = n >= 1_000_000
        ? `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 1 : 2)}M`
        : n >= 1_000
            ? `${(n / 1_000).toFixed(n >= 100_000 ? 0 : n >= 10_000 ? 1 : 2)}K`
            : String(n);
    return approximate ? `≈${formatted}` : formatted;
}
