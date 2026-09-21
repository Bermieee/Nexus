function clampNumber(value, low, high, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.max(low, Math.min(high, Math.floor(number)));
}

export function packNexusBatchItems({ items = [], estimateInputTokens = item => item?.estimatedInputTokens, maxBatchItems = 10, targetInputTokens = 7000 } = {}) {
    const itemLimit = clampNumber(maxBatchItems, 1, 50, 10);
    const tokenLimit = clampNumber(targetInputTokens, 1000, 100000, 7000);
    const source = Array.isArray(items) ? items.filter(item => item != null) : [];
    const batches = [];
    let current = null;
    for (const item of source) {
        const estimate = Number(estimateInputTokens(item));
        const estimatedInputTokens = Number.isFinite(estimate) && estimate >= 0 ? Math.floor(estimate) : 0;
        const wouldExceedItems = !!current && current.items.length >= itemLimit;
        const wouldExceedTokens = !!current && current.items.length > 0 && current.estimatedInputTokens + estimatedInputTokens > tokenLimit;
        if (!current || wouldExceedItems || wouldExceedTokens) {
            current = { index: batches.length, items: [], estimatedInputTokens: 0, oversized: estimatedInputTokens > tokenLimit };
            batches.push(current);
        }
        current.items.push({ item, estimatedInputTokens });
        current.estimatedInputTokens += estimatedInputTokens;
    }
    return { itemCount: source.length, batchCount: batches.length, maxBatchItems: itemLimit, targetInputTokens: tokenLimit, batches };
}

export function groupNexusDispatchUnits(units = [], canScatter = true) {
    const source = Array.isArray(units) ? units.filter(Boolean) : [];
    return canScatter && source.length > 1 ? [source] : source.map(unit => [unit]);
}

export function packNexusRollingDispatchGroups({ items = [], maxBatchItems = 10 } = {}) {
    const itemLimit = clampNumber(maxBatchItems, 1, 50, 10);
    const source = Array.isArray(items) ? items.filter(item => item != null) : [];
    const groups = [];
    for (let index = 0; index < source.length; index += itemLimit) groups.push(source.slice(index, index + itemLimit));
    return { itemCount: source.length, groupCount: groups.length, maxBatchItems: itemLimit, groups };
}
