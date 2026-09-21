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
export function resolveMainModelHint(context = null) {
    const ctx = context && typeof context === 'object' ? context : {};
    const sources = [
        ctx,
        ctx.chatCompletionSettings,
        ctx.textCompletionSettings,
        ctx.settings,
        globalThis?.oai_settings,
        globalThis?.textgenerationwebui_settings,
        globalThis?.nai_settings,
    ].filter(value => value && typeof value === 'object');
    const fields = [
        'mainModel', 'model', 'modelId', 'model_id', 'custom_model',
        'openai_model', 'claude_model', 'google_model', 'gemini_model',
        'mistralai_model', 'cohere_model', 'perplexity_model', 'ai21_model',
    ];
    for (const source of sources) {
        for (const field of fields) {
            const value = source?.[field];
            if (typeof value === 'string' && value.trim()) return value.trim();
        }
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
