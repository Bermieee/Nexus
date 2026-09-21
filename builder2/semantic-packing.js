import { estimateContentTokens } from '../observability/token-estimator.js';

function normalizePositiveInteger(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < min) return fallback;
    return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function sourceChars(source) {
    return String(source?.content || '').length
        + String(source?.title || '').length
        + JSON.stringify(source?.keys || []).length
        + 64;
}

export function estimateBuilder2SemanticSourceTokens(source) {
    const payload = {
        ref: 'R1',
        title: source?.title || '',
        keys: Array.isArray(source?.keys) ? source.keys : [],
        content: source?.content || '',
    };
    const measured = estimateContentTokens(JSON.stringify(payload));
    if (measured > 0) return measured;
    return Math.max(1, Math.ceil(sourceChars(source) / 4));
}

export function estimateBuilder2SemanticValueTokens(value) {
    const text = JSON.stringify(value ?? null);
    const measured = estimateContentTokens(text);
    if (measured > 0) return measured;
    return Math.max(1, Math.ceil(text.length / 4));
}

/**
 * Pack arbitrary Builder semantic evidence with the same request geometry used
 * by survey/classification. Taxonomy seed rows are not lore sources, but they
 * must still obey the Builder's canonical max-entry and target-token contract
 * instead of inventing a second set of shard limits.
 */
export function packBuilder2SemanticValues(values = [], {
    maxEntries = 24,
    targetInputTokens = null,
    maxChars = null,
} = {}) {
    const entryLimit = normalizePositiveInteger(maxEntries, 24, { min: 1, max: 100000 });
    const tokenTarget = Number.isFinite(Number(targetInputTokens)) && Number(targetInputTokens) >= 1000
        ? normalizePositiveInteger(targetInputTokens, null, { min: 1000, max: 100000 })
        : null;
    const charTarget = Number.isFinite(Number(maxChars)) && Number(maxChars) > 0
        ? normalizePositiveInteger(maxChars, null, { min: 1 })
        : null;

    const slices = [];
    let current = null;
    for (const value of values || []) {
        const serialized = JSON.stringify(value ?? null);
        const estimatedInputTokens = estimateBuilder2SemanticValueTokens(value);
        const estimatedChars = serialized.length + 1;
        const overEntries = !!current && current.entries.length >= entryLimit;
        const overTokens = !!current && current.entries.length > 0 && tokenTarget != null
            && current.estimatedInputTokens + estimatedInputTokens > tokenTarget;
        const overChars = !!current && current.entries.length > 0 && charTarget != null
            && current.estimatedChars + estimatedChars > charTarget;
        if (!current || overEntries || overTokens || overChars) {
            current = {
                index: slices.length,
                entries: [],
                estimatedInputTokens: 0,
                estimatedChars: 0,
                oversized: (tokenTarget != null && estimatedInputTokens > tokenTarget)
                    || (charTarget != null && estimatedChars > charTarget),
            };
            slices.push(current);
        }
        current.entries.push(value);
        current.estimatedInputTokens += estimatedInputTokens;
        current.estimatedChars += estimatedChars;
    }

    return {
        entryCount: (values || []).length,
        sliceCount: slices.length,
        maxEntries,
        entryLimit,
        targetInputTokens: tokenTarget,
        maxChars: charTarget,
        slices,
    };
}

/**
 * Builder 2 semantic packing. This is intentionally separate from the Nexus
 * Batch Layer wave planner: this controls what one model request can see,
 * while jobs/wave controls physical A/B scheduling. The token target is soft;
 * one oversized lore entry is allowed to travel alone rather than being cut.
 */
export function packBuilder2SemanticSources(sources = [], {
    maxEntries = 24,
    targetInputTokens = null,
    maxChars = null,
} = {}) {
    const entryLimit = normalizePositiveInteger(maxEntries, 24, { min: 1, max: 100000 });
    const tokenTarget = Number.isFinite(Number(targetInputTokens)) && Number(targetInputTokens) >= 1000
        ? normalizePositiveInteger(targetInputTokens, null, { min: 1000, max: 100000 })
        : null;
    const charTarget = Number.isFinite(Number(maxChars)) && Number(maxChars) > 0
        ? normalizePositiveInteger(maxChars, null, { min: 1 })
        : null;

    const slices = [];
    let current = null;
    for (const source of sources || []) {
        const estimatedInputTokens = estimateBuilder2SemanticSourceTokens(source);
        const estimatedChars = sourceChars(source);
        const overEntries = !!current && current.entries.length >= entryLimit;
        const overTokens = !!current && current.entries.length > 0 && tokenTarget != null
            && current.estimatedInputTokens + estimatedInputTokens > tokenTarget;
        const overChars = !!current && current.entries.length > 0 && charTarget != null
            && current.estimatedChars + estimatedChars > charTarget;
        if (!current || overEntries || overTokens || overChars) {
            current = {
                index: slices.length,
                entries: [],
                estimatedInputTokens: 0,
                estimatedChars: 0,
                oversized: (tokenTarget != null && estimatedInputTokens > tokenTarget)
                    || (charTarget != null && estimatedChars > charTarget),
            };
            slices.push(current);
        }
        current.entries.push(source);
        current.estimatedInputTokens += estimatedInputTokens;
        current.estimatedChars += estimatedChars;
    }

    return {
        entryCount: (sources || []).length,
        sliceCount: slices.length,
        maxEntries,
        entryLimit,
        targetInputTokens: tokenTarget,
        maxChars: charTarget,
        slices,
    };
}
