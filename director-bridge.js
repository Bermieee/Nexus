import { NEXUS_JOB_KIND, NEXUS_JOB_ROUTE } from '../nexus/contracts.js';
import { BUILDER_MODE, createBuildPlan } from './contracts.js';
import { refsForUids } from './inventory.js';
import { estimateContentTokens } from '../observability/token-estimator.js';

function semanticEntryTokens(entry, contentByRef = new Map()) {
    const payload = {
        ref: entry?.ref || '',
        title: entry?.title || '',
        keys: Array.isArray(entry?.keys) ? entry.keys : [],
        content: contentByRef.get(entry?.ref) || '',
    };
    const measured = estimateContentTokens(JSON.stringify(payload));
    if (measured > 0) return measured;
    return Math.max(1, Math.ceil((Number(entry?.contentChars) || 0) / 4));
}

/**
 * Pack lore entries into model-visible semantic requests. This is deliberately
 * separate from Nexus Batch Layer wave packing: entries/request controls what a
 * model sees together; jobs/wave controls A/B execution concurrency. The token
 * target is soft: one oversized lore entry is allowed to travel alone.
 */
export function packLorebookSemanticEntries(items = [], { maxEntriesPerJob, semanticInputTargetTokens, sourceEntries = [] } = {}) {
    const parsedEntryLimit = Number(maxEntriesPerJob);
    if (!Number.isFinite(parsedEntryLimit) || parsedEntryLimit < 1) throw new Error('Lorebook Builder semantic plan requires maxEntriesPerJob >= 1.');
    const entryLimit = Math.min(50, Math.floor(parsedEntryLimit));
    const parsedTokenTarget = Number(semanticInputTargetTokens);
    if (!Number.isFinite(parsedTokenTarget) || parsedTokenTarget < 1000) throw new Error('Lorebook Builder semantic plan requires semanticInputTargetTokens >= 1000.');
    const tokenTarget = Math.min(100000, Math.floor(parsedTokenTarget));
    const contentByRef = new Map((sourceEntries || []).map(row => [row.ref, String(row.content || '')]));
    const slices = [];
    let current = null;
    for (const entry of items || []) {
        const estimatedInputTokens = semanticEntryTokens(entry, contentByRef);
        const overEntries = !!current && current.entries.length >= entryLimit;
        const overTokens = !!current && current.entries.length > 0 && current.estimatedInputTokens + estimatedInputTokens > tokenTarget;
        if (!current || overEntries || overTokens) {
            current = { index: slices.length, entries: [], estimatedInputTokens: 0, oversized: estimatedInputTokens > tokenTarget };
            slices.push(current);
        }
        current.entries.push(entry);
        current.estimatedInputTokens += estimatedInputTokens;
    }
    return {
        entryCount: (items || []).length,
        sliceCount: slices.length,
        maxEntriesPerJob: entryLimit,
        semanticInputTargetTokens: tokenTarget,
        slices,
    };
}

export function buildLorebookBuilderPlan({ request, mode, lorebookInventory, treeInventory, director, maxEntriesPerJob, semanticInputTargetTokens, maxJobsPerWave = null, waveTargetInputTokens = null, semanticResource = 'sidecar' } = {}) {
    if (!director || typeof director.buildRequestedPlan !== 'function') {
        throw new Error('Lorebook Builder requires WorkDirector.buildRequestedPlan(); execution may not bypass the Work Director.');
    }
    let targets = [];
    if (mode === BUILDER_MODE.FULL) targets = lorebookInventory.activeEntries;
    else if (mode === BUILDER_MODE.INCREMENTAL) targets = refsForUids(lorebookInventory, treeInventory.unrepresentedUids);
    else if (mode === BUILDER_MODE.REPAIR) targets = refsForUids(lorebookInventory, [...treeInventory.unrepresentedUids, ...treeInventory.changedUids]);

    const semanticPacking = packLorebookSemanticEntries(targets, {
        maxEntriesPerJob,
        semanticInputTargetTokens,
        sourceEntries: lorebookInventory?._sourceEntries || [],
    });
    const targetChunks = semanticPacking.slices;
    const jobType = mode === BUILDER_MODE.FULL ? 'lorebook-builder-classify' : 'lorebook-builder-place';
    const semanticRoute = semanticResource === 'main' ? NEXUS_JOB_ROUTE.LOCAL : NEXUS_JOB_ROUTE.SIDECAR;
    const jobs = targetChunks.map((slice, index) => {
        const chunk = slice.entries;
        return {
            type: `${jobType}-${index + 1}`,
            name: mode === BUILDER_MODE.FULL ? `Builder classify entries ${index + 1}/${targetChunks.length}` : `Builder reconcile entries ${index + 1}/${targetChunks.length}`,
            kind: NEXUS_JOB_KIND.ROUTE,
            route: semanticRoute,
            priority: 18,
            transactionRequired: true,
            // Nexus Main has a single physical lease. When Builder deliberately
            // targets Main, serialize semantic slices in the Director plan itself
            // instead of racing sibling LOCAL jobs and letting the Gateway reject
            // whichever loses admission. Sidecar jobs remain independent so the
            // Sidecar Bus can use A/B concurrency.
            dependencies: semanticResource === 'main' && index > 0 ? [`${jobType}-${index}`] : [],
            metadata: { builder: true, mode, refs: chunk.map(entry => entry.ref), entryCount: chunk.length, estimatedInputTokens: slice.estimatedInputTokens, oversizedSemanticSlice: slice.oversized === true, semanticInputTargetTokens: semanticPacking.semanticInputTargetTokens, semanticResource, boundaryTarget: semanticResource === 'main' ? 'st-main' : null },
        };
    });
    if (targets.length) {
        jobs.push({
            type: 'lorebook-builder-validate',
            name: 'Builder validate proposed Tree delta',
            kind: NEXUS_JOB_KIND.INSPECT,
            route: NEXUS_JOB_ROUTE.LOCAL,
            priority: 19,
            transactionRequired: true,
            dependencies: jobs.map(job => job.type),
            metadata: { builder: true, mode, targetCount: targets.length },
        });
    }
    const directorPlan = director.buildRequestedPlan({
        source: 'lorebook-builder',
        classification: { subsystem: 'lorebook-builder', mode, book: request.book, targetCount: targets.length },
        decisions: jobs.map(job => ({ action: 'run', job: job.type, route: job.route, reason: 'Lorebook Builder semantic/reconciliation plan' })),
        jobs,
        metadata: { builderRunId: request.id, book: request.book, mode, semanticSliceCount: semanticPacking.sliceCount, maxEntriesPerSemanticSlice: semanticPacking.maxEntriesPerJob, semanticInputTargetTokens: semanticPacking.semanticInputTargetTokens, maxJobsPerWave, waveTargetInputTokens },
    });
    return createBuildPlan({
        runId: request.id,
        book: request.book,
        mode,
        targetRefs: targets.map(entry => entry.ref),
        jobs,
        directorPlan,
        metadata: { maxEntriesPerJob: semanticPacking.maxEntriesPerJob, maxEntriesPerSemanticSlice: semanticPacking.maxEntriesPerJob, semanticInputTargetTokens: semanticPacking.semanticInputTargetTokens, semanticSliceCount: semanticPacking.sliceCount, semanticSliceEntryCounts: semanticPacking.slices.map(slice => slice.entries.length), maxJobsPerWave, waveTargetInputTokens, semanticResource },
    });
}
