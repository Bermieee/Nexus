/**
 * Prompt Loader model-family adapters.
 *
 * These adapters own Nexus presentation policy only. They never emit provider
 * chat-template tokens, change SillyTavern role serialization, select lore, or
 * mutate semantic context. Provider/host adapters remain authoritative for the
 * physical model protocol.
 *
 * Family profiles are deliberately evidence-bounded. Claude/Gemini use the
 * documented XML-structured presentation; other families retain Nexus's
 * conservative bracket format unless provider evidence and live Prompt Loader
 * telemetry justify a different presentation. All profiles keep stable material
 * before volatile scene/delta content for prefix-cache reuse.
 */

export const PROMPT_LOADER_ADAPTER_VERSION = 3;

const BRACKET_PRESENTATION = Object.freeze({
    layout: 'stable-prefix-v2',
    wrapperStyle: 'nexus-brackets',
    legendMode: 'standard',
    sectionSeparator: '\n\n',
    outletOrder: 'canonical',
    cachePolicy: 'stable-prefix-volatile-tail',
    providerTemplateOwnership: 'host',
});

const XML_PRESENTATION = Object.freeze({
    layout: 'stable-prefix-xml-v1',
    wrapperStyle: 'xml-sections',
    legendMode: 'standard',
    sectionSeparator: '\n\n',
    outletOrder: 'canonical',
    cachePolicy: 'stable-prefix-volatile-tail',
    providerTemplateOwnership: 'host',
});

function profile(id, family, modelPatterns = [], providerPatterns = [], presentation = BRACKET_PRESENTATION, evidence = {}) {
    return Object.freeze({
        version: PROMPT_LOADER_ADAPTER_VERSION,
        id,
        family,
        modelPatterns: Object.freeze([...modelPatterns]),
        providerPatterns: Object.freeze([...providerPatterns]),
        presentation,
        evidence: Object.freeze({
            structure: evidence.structure || 'conservative-default',
            cache: evidence.cache || 'conservative-prefix',
            notes: Object.freeze([...(evidence.notes || [])]),
        }),
    });
}

const FAMILY_PROFILES = Object.freeze([
    profile('deepseek-stable-prefix-v1', 'DeepSeek', [/deepseek/i, /deep[-_ ]?seek/i], [/deepseek/i]),
    profile('glm-stable-prefix-v1', 'GLM', [/(^|[\/:_.-])glm(?:[\d_.:-]|$)/i, /zhipu/i, /z[-_ ]?ai/i], [/zhipu/i, /z[-_ ]?ai/i]),
    profile('gemini-xml-stable-prefix-v1', 'Gemini', [/gemini/i], [/google/i, /gemini/i], XML_PRESENTATION, {
        structure: 'provider-documented-xml-or-markdown-delimiters',
        notes: ['Gemini guidance recommends consistent structured delimiters; Nexus uses XML consistently inside its owned frame.'],
    }),
    profile('claude-xml-stable-prefix-v1', 'Claude', [/claude/i], [/anthropic/i, /claude/i], XML_PRESENTATION, {
        structure: 'provider-documented-xml',
        notes: ['Claude guidance recommends consistent descriptive XML tags for complex mixed context.'],
    }),
    profile('mimo-stable-prefix-v1', 'MiMo', [/mimo/i, /xiaomi/i], [/xiaomi/i, /mimo/i]),
    profile('qwen-stable-prefix-v1', 'Qwen', [/qwen/i, /qwq/i], [/alibaba/i, /dashscope/i, /qwen/i]),
    profile('openai-stable-prefix-v1', 'OpenAI', [/(^|[\/:_.-])gpt[-_.:]/i, /(^|[\/:_.-])o[134](?:[-_.:]|$)/i, /codex/i], [/openai/i]),
]);

const GENERIC_PROFILE = profile('generic-stable-prefix-v3', 'Generic');

function clean(value) { return String(value ?? '').trim(); }
function matches(value, patterns = []) {
    const text = clean(value);
    return !!text && patterns.some(pattern => pattern.test(text));
}
function providerCacheEvidence({ family = 'Generic', provider = '' } = {}) {
    const p = clean(provider).toLowerCase();
    if (!p) return { cache: 'provider-unidentified', note: 'Cache behavior is not attributed until the actual provider route is known.' };
    if (/openrouter/.test(p)) return { cache: 'router-dependent-unverified', note: 'OpenRouter cache behavior depends on the routed provider/model path; Nexus does not inherit first-party cache guarantees.' };
    if (/custom|proxy|reverse/.test(p)) return { cache: 'custom-endpoint-unverified', note: 'Custom/proxy endpoint cache semantics are unknown to Nexus.' };
    if (family === 'DeepSeek' && /deepseek/.test(p)) return { cache: 'provider-documented-prefix-cache', note: 'DeepSeek documents automatic cache hits on matching request prefixes.' };
    if (family === 'OpenAI' && /^(?:openai|openai-direct)$/.test(p)) return { cache: 'provider-documented-prompt-cache', note: 'OpenAI documents prompt caching for reusable request prefixes.' };
    if (family === 'MiMo' && /xiaomi|mimo/.test(p)) return { cache: 'provider-documented-prefix-cache', note: 'Xiaomi MiMo documents Prompt Cache hits for repeated request prefixes and reports cached_tokens.' };
    if ((family === 'Qwen' || family === 'GLM') && /dashscope|alibaba|model[-_ ]?studio|aliyun|qwen/.test(p)) return { cache: 'provider-documented-prefix-cache', note: 'Alibaba Model Studio documents implicit common-prefix caching for supported Qwen and hosted GLM models.' };
    return { cache: 'provider-route-unverified', note: 'No first-party cache contract is attached to this provider/model route.' };
}
function cloneProfile(row, { model = '', provider = '', matchedBy = 'generic' } = {}) {
    const routeEvidence = providerCacheEvidence({ family: row.family, provider });
    return Object.freeze({
        version: row.version,
        id: row.id,
        family: row.family,
        model: clean(model) || null,
        provider: clean(provider) || null,
        matchedBy,
        presentation: Object.freeze({ ...row.presentation }),
        evidence: Object.freeze({
            structure: row.evidence?.structure || 'conservative-default',
            cache: routeEvidence.cache,
            notes: Object.freeze([...(row.evidence?.notes || []), routeEvidence.note].filter(Boolean)),
        }),
    });
}

export function listPromptLoaderAdapters() {
    return FAMILY_PROFILES.map(row => cloneProfile(row));
}

export function resolvePromptLoaderAdapter({ model = '', provider = '' } = {}) {
    const modelHint = clean(model);
    const providerHint = clean(provider);
    for (const row of FAMILY_PROFILES) {
        if (matches(modelHint, row.modelPatterns)) return cloneProfile(row, { model: modelHint, provider: providerHint, matchedBy: 'model' });
    }
    for (const row of FAMILY_PROFILES) {
        if (matches(providerHint, row.providerPatterns)) return cloneProfile(row, { model: modelHint, provider: providerHint, matchedBy: 'provider' });
    }
    return cloneProfile(GENERIC_PROFILE, { model: modelHint, provider: providerHint, matchedBy: 'generic' });
}

export function promptLoaderAdapterSignature(adapter = null) {
    const row = adapter && typeof adapter === 'object' ? adapter : {};
    return [
        Number(row.version) || PROMPT_LOADER_ADAPTER_VERSION,
        clean(row.id) || 'generic-stable-prefix-v3',
        clean(row.model),
        clean(row.provider),
    ].join('|');
}

export function normalizePromptLoaderPresentation(adapter = null) {
    const supplied = adapter && typeof adapter === 'object' ? adapter : null;
    const alreadyNormalized = !!supplied && !supplied.presentation && (
        supplied.adapterId || supplied.wrapperStyle || supplied.layout || supplied.cachePolicy
    );
    const resolved = supplied?.presentation ? supplied : (alreadyNormalized ? supplied : resolvePromptLoaderAdapter());
    const input = resolved.presentation || resolved || BRACKET_PRESENTATION;
    return Object.freeze({
        adapterVersion: Number(resolved.version ?? resolved.adapterVersion) || PROMPT_LOADER_ADAPTER_VERSION,
        adapterId: clean(resolved.id ?? resolved.adapterId) || 'generic-stable-prefix-v3',
        family: clean(resolved.family) || 'Generic',
        model: clean(resolved.model) || null,
        provider: clean(resolved.provider) || null,
        matchedBy: clean(resolved.matchedBy) || 'generic',
        layout: clean(input.layout) || BRACKET_PRESENTATION.layout,
        wrapperStyle: clean(input.wrapperStyle) || BRACKET_PRESENTATION.wrapperStyle,
        legendMode: clean(input.legendMode) || BRACKET_PRESENTATION.legendMode,
        sectionSeparator: typeof input.sectionSeparator === 'string' ? input.sectionSeparator : BRACKET_PRESENTATION.sectionSeparator,
        outletOrder: clean(input.outletOrder) || BRACKET_PRESENTATION.outletOrder,
        cachePolicy: clean(input.cachePolicy) || BRACKET_PRESENTATION.cachePolicy,
        providerTemplateOwnership: 'host',
        evidence: Object.freeze({
            structure: clean(resolved.evidence?.structure ?? input.evidence?.structure) || 'conservative-default',
            cache: clean(resolved.evidence?.cache ?? input.evidence?.cache) || 'conservative-prefix',
            notes: Object.freeze([...(resolved.evidence?.notes || input.evidence?.notes || [])].map(clean).filter(Boolean)),
        }),
    });
}
function xmlAttribute(value='') {
    return String(value ?? '').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

export function promptLoaderPresentationKey(adapter = null) {
    const row = normalizePromptLoaderPresentation(adapter);
    // Cache by rendered presentation contract, not model-family identity.
    // Families that serialize the same bytes (DeepSeek/MiMo/Qwen/etc. bracket
    // format or Claude/Gemini XML format) may safely reuse compiled sections.
    return [
        row.adapterVersion,
        row.layout,
        row.wrapperStyle,
        row.legendMode,
        row.sectionSeparator,
        row.outletOrder,
        row.cachePolicy,
    ].join('|');
}

export function promptLoaderPresentationsCompatible(left = null, right = null) {
    return promptLoaderPresentationKey(left) === promptLoaderPresentationKey(right);
}

export function renderPromptLoaderLegend(legend = '', adapter = null) {
    const presentation = normalizePromptLoaderPresentation(adapter);
    const text = String(legend ?? '');
    if (presentation.wrapperStyle !== 'xml-sections') return text;
    return `<nexus_context_legend version="1">\n${text}\n</nexus_context_legend>`;
}

export function renderPromptLoaderSection({ name = '', label = '', content = '' } = {}, adapter = null) {
    const presentation = normalizePromptLoaderPresentation(adapter);
    const body = String(content ?? '');
    if (!body) return '';
    if (presentation.wrapperStyle === 'xml-sections') {
        return `<nexus_section id="${xmlAttribute(name)}" label="${xmlAttribute(label)}">\n${body}\n</nexus_section>`;
    }
    return `[NEXUS:${String(label ?? '')}]\n${body}\n[/NEXUS:${String(label ?? '')}]`;
}

export function resolvePromptLoaderLoreOrderPolicy(adapter = null) {
    const row = adapter && typeof adapter === 'object' && adapter.evidence
        ? adapter
        : resolvePromptLoaderAdapter();
    const cache = clean(row.evidence?.cache);
    return /^provider-documented-(?:prefix-cache|prompt-cache)$/.test(cache)
        ? 'stable-survivors-append'
        : 'canonical';
}

export function comparePromptLoaderAdapterSelection(sealedAdapter = null, { model = '', provider = '' } = {}) {
    const sealed = normalizePromptLoaderPresentation(sealedAdapter);
    const actualProfile = resolvePromptLoaderAdapter({ model, provider });
    const actual = normalizePromptLoaderPresentation(actualProfile);
    const matched = sealed.adapterId === actual.adapterId
        && sealed.family === actual.family
        && sealed.wrapperStyle === actual.wrapperStyle;
    return Object.freeze({
        matched,
        sealed: Object.freeze({
            adapterId: sealed.adapterId,
            family: sealed.family,
            model: sealed.model,
            provider: sealed.provider,
            wrapperStyle: sealed.wrapperStyle,
            layout: sealed.layout,
        }),
        actual: Object.freeze({
            adapterId: actual.adapterId,
            family: actual.family,
            model: actual.model,
            provider: actual.provider,
            wrapperStyle: actual.wrapperStyle,
            layout: actual.layout,
        }),
        reason: matched ? 'adapter-match' : 'adapter-selection-mismatch',
    });
}

