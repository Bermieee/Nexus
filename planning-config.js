const TREE_BATCH_DOMAIN = 'tree';

export const LOREBOOK_BUILDER_PLANNING_DEFAULTS = Object.freeze({
    maxEntriesPerRequest: 12,
    semanticInputTargetTokens: 3500,
});

function boundedInteger(value, { min, max, fallback }) {
    if (value === null || value === undefined) return fallback;
    if (typeof value === 'string' && value.trim() === '') return fallback;
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(min, Math.min(max, Math.floor(parsed)));
}

/**
 * Canonical Lorebook Builder planning configuration.
 *
 * Tree semantic shape belongs to Builder. Generic Nexus Batch Layer settings
 * contribute only physical scheduling geometry. Main/Sidecar workers
 * never own, cache, repair, or override Tree semantic configuration.
 */
export function resolveLorebookBuilderPlanningConfig({
    settings = {},
    batchStatus = {},
    semanticResource = 'sidecar',
} = {}) {
    const semantic = settings?.nexus?.lorebookBuilder?.semanticPacking || {};
    const maxEntriesPerJob = boundedInteger(semantic.maxEntriesPerRequest, {
        min: 1,
        max: 50,
        fallback: LOREBOOK_BUILDER_PLANNING_DEFAULTS.maxEntriesPerRequest,
    });
    const semanticInputTargetTokens = boundedInteger(semantic.targetInputTokens, {
        min: 1000,
        max: 100000,
        fallback: LOREBOOK_BUILDER_PLANNING_DEFAULTS.semanticInputTargetTokens,
    });

    const pooled = semanticResource === 'sidecar' || semanticResource === 'model-worker';
    const maxJobsPerWave = pooled
        ? boundedInteger(batchStatus?.maxBatchItems, { min: 1, max: 50, fallback: 10 })
        : null;
    const waveTargetInputTokens = pooled
        ? boundedInteger(batchStatus?.targetInputTokens, { min: 1000, max: 100000, fallback: 7000 })
        : null;
    const treeDomain = pooled
        ? batchStatus?.domains?.find?.(row => row.domain === TREE_BATCH_DOMAIN)
        : null;

    return Object.freeze({
        maxEntriesPerJob,
        semanticInputTargetTokens,
        maxJobsPerWave,
        waveTargetInputTokens,
        treeBatchEnabled: pooled ? treeDomain?.enabled !== false : null,
        provenance: Object.freeze({
            semanticPacking: 'nexus.lorebookBuilder.semanticPacking',
            physicalScheduling: pooled ? 'nexus.batchLayer+modelWorker' : 'main-serialized',
        }),
    });
}

