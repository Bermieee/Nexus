import { NEXUS_JOB_ROUTE, NEXUS_JOB_STATE, deepCopy } from './contracts.js';
import { NexusWorkCoordinator } from './work-coordinator.js';

export const NEXUS_MIGRATED_WORKLOAD = Object.freeze({
    SMART_WARM: 'smart-warm',
    POST_TURN_EXTRACT: 'post-turn-extract',
    NOTEBOOK_REFRESH: 'notebook-refresh',
    CHARACTER_BANK_REFRESH: 'character-bank-refresh',
    SUMMARY: 'summary',
    SUMMARY_PROMOTION: 'summary-promotion',
    LORE_ROUTING: 'lore-routing',
    MAINTENANCE: 'maintenance',
});

function normalizedWorkloads(value = []) {
    return new Set((Array.isArray(value) ? value : []).map(item => String(item || '').trim()).filter(Boolean));
}

/**
 * Select only workloads deliberately migrated behind the Director. A job whose
 * prerequisite has not also migrated is deferred rather than having that
 * dependency silently erased.
 */
export function selectMigratedDirectorPlan(plan, migratedWorkloads = []) {
    const allowed = normalizedWorkloads(migratedWorkloads);
    const sourceJobs = Array.isArray(plan?.jobs) ? plan.jobs : [];
    const selectedIds = new Set(sourceJobs.filter(job => allowed.has(String(job.type))).map(job => String(job.id)));
    const deferred = [];
    const blockedIds = new Set();
    let pending = sourceJobs.filter(job => allowed.has(String(job.type))).map(deepCopy);
    // Dependency eligibility is transitive. If a selected prerequisite is later
    // deferred, every dependent is also removed; no child survives because the
    // prerequisite happened to be present in the initial selected-ID set.
    let changed = true;
    while (changed) {
        changed = false;
        const next = [];
        for (const job of pending) {
            const missingDependencies = (job.dependencies || []).filter(id => !selectedIds.has(String(id)) || blockedIds.has(String(id)));
            if (missingDependencies.length) {
                blockedIds.add(String(job.id));
                deferred.push({ jobId: job.id, type: job.type, reason: 'dependency-not-migrated', dependencies: missingDependencies });
                changed = true;
            } else next.push(job);
        }
        pending = next;
    }
    const jobs = pending;
    return {
        ...deepCopy(plan || {}),
        id: plan?.id || null,
        jobs,
        metadata: { ...(deepCopy(plan?.metadata || {})), migrationSubset: true, migratedWorkloads: [...allowed] },
        deferred,
    };
}


function routeAvailabilityMap(value = null) {
    if (!value || typeof value !== 'object') return null;
    return {
        [NEXUS_JOB_ROUTE.LOCAL]: value[NEXUS_JOB_ROUTE.LOCAL] !== false,
        [NEXUS_JOB_ROUTE.SIDECAR]: typeof value[NEXUS_JOB_ROUTE.SIDECAR] === 'function' ? value[NEXUS_JOB_ROUTE.SIDECAR] : value[NEXUS_JOB_ROUTE.SIDECAR] !== false,
        [NEXUS_JOB_ROUTE.MODEL_WORKER]: typeof value[NEXUS_JOB_ROUTE.MODEL_WORKER] === 'function' ? value[NEXUS_JOB_ROUTE.MODEL_WORKER] : value[NEXUS_JOB_ROUTE.MODEL_WORKER] !== false,
        [NEXUS_JOB_ROUTE.TREE_BATCH_FIRE]: value[NEXUS_JOB_ROUTE.TREE_BATCH_FIRE] !== false,
    };
}

/**
 * Execution-resource filter applied after deterministic Director planning and
 * migration selection. It never reroutes a job. In particular, unavailable
 * Model-worker work is deferred only when neither Main nor a Sidecar execution resource is configured.
 * Dependencies on an unavailable route are deferred with it, while independent
 * LOCAL jobs may still run.
 */
export function selectAvailableDirectorPlan(plan, routeAvailability = null) {
    const availability = routeAvailabilityMap(routeAvailability);
    if (!availability) return { ...deepCopy(plan || {}), deferred: [...(plan?.deferred || [])], resourceBlockedTypes: [] };
    const sourceJobs = Array.isArray(plan?.jobs) ? plan.jobs : [];
    const deferred = [...(plan?.deferred || [])];
    const unavailableIds = new Set();
    const resourceBlockedTypes = new Set();
    const prelim = [];
    for (const job of sourceJobs) {
        let available = availability[job.route] !== false;
        if (typeof availability[job.route] === 'function') {
            try { available = availability[job.route](job) === true; } catch { available = false; }
        }
        if (!available) {
            unavailableIds.add(String(job.id));
            resourceBlockedTypes.add(String(job.type || ''));
            deferred.push({ jobId: job.id, type: job.type, route: job.route, reason: 'route-unavailable' });
            continue;
        }
        prelim.push(deepCopy(job));
    }
    const kept = [];
    let changed = true;
    const blockedIds = new Set(unavailableIds);
    let pending = prelim;
    while (changed) {
        changed = false;
        const next = [];
        for (const job of pending) {
            const blockedDeps = (job.dependencies || []).filter(id => blockedIds.has(String(id)));
            if (blockedDeps.length) {
                blockedIds.add(String(job.id));
                resourceBlockedTypes.add(String(job.type || ''));
                deferred.push({ jobId: job.id, type: job.type, route: job.route, reason: 'dependency-route-unavailable', dependencies: blockedDeps });
                changed = true;
            } else next.push(job);
        }
        pending = next;
    }
    kept.push(...pending);
    return {
        ...deepCopy(plan || {}),
        jobs: kept,
        deferred,
        resourceBlockedTypes: [...resourceBlockedTypes].filter(Boolean),
        metadata: { ...(deepCopy(plan?.metadata || {})), routeAvailability: Object.fromEntries(Object.entries(availability).map(([route,value])=>[route,typeof value==='function'?'per-workload':value])) },
    };
}


/**
 * Decide whether the legacy lifecycle implementation should still run for a
 * workload after a Director migration attempt. Shadow/disabled/unselected work
 * always leaves legacy behavior intact. Successfully handled migrated work is
 * suppressed. Failed/blocked migrated work may fall back only when the
 * migration policy explicitly allows it.
 */
export function shouldRunLegacyWorkload(directorResult, workloadType) {
    const type = String(workloadType || '').trim();
    if (!type) return true;
    if (!directorResult || directorResult.shadow === true) return true;
    if ((directorResult.authorityBlockedTypes || []).includes(type)) return false;
    // Attempt-level staleness/scope invalidation fences the originating event.
    if (directorResult.stale === true || directorResult.scopeInvalidated === true) return false;
    if (['scope-invalidated','message-not-settled','automatic-trigger-stale','revision-in-flight'].includes(String(directorResult.reason || ''))) return false;
    // The same settled revision can be observed through more than one ST event
    // (for example generation-end followed by message-received-after-end). Once
    // the Director has already planned that revision, a second legacy cycle must
    // not resurrect the whole workload set.
    if (directorResult.reason === 'revision-already-planned') return false;
    const decision = (directorResult.plan?.decisions || []).find(row => String(row?.job || '') === type);
    // In active Director mode, an explicit deterministic skip is authoritative
    // for this settled revision. Legacy execution may not reinterpret it as due.
    if (decision?.action === 'skip') return false;
    if (!directorResult.migration) return true;
    if ((directorResult.migration.resourceBlockedTypes || []).includes(type)) return false;
    const rows = directorResult.migration.execution?.jobs || [];
    const row = rows.find(job => String(job?.type || '') === type);
    if (!row) return decision?.action === 'run' ? directorResult.useLegacyFallback !== false : true;
    if (row.state === NEXUS_JOB_STATE.SUCCEEDED) return false;
    if (row.state === NEXUS_JOB_STATE.SKIPPED) {
        const value = row?.result?.value || null;
        // A deferred/stale executor did not actually handle the workload. It
        // must not suppress the legacy fallback merely because Coordinator
        // represents `{skipped:true}` with the SKIPPED terminal state.
        if (value?.stale === true || value?.scopeInvalidated === true) return false;
        if (['scope-invalidated','message-not-settled'].includes(String(value?.reason || ''))) return false;
        if (value?.deferred === true) return directorResult.useLegacyFallback !== false;
        return false;
    }
    if (row?.result?.metadata?.legacyFallbackAllowed === false) return false;
    return directorResult.useLegacyFallback !== false;
}

export async function runMigratedDirectorPlan(plan, {
    migratedWorkloads = [],
    executors = {},
    coordinator = new NexusWorkCoordinator(),
    onChange = null,
    routeAvailability = null,
    signal = null,
    isFresh = null,
} = {}) {
    const selected = selectMigratedDirectorPlan(plan, migratedWorkloads);
    const subset = selectAvailableDirectorPlan(selected, routeAvailability);
    if (!subset.jobs.length) return { skipped: true, reason: subset.deferred.length ? 'migrated-jobs-deferred' : 'no-migrated-jobs', plan: subset, deferred: subset.deferred, resourceBlockedTypes: subset.resourceBlockedTypes || [] };
    const execution = await coordinator.run(subset, { executors, onChange, signal, isFresh });
    const handledTypes = [...new Set(execution.jobs.filter(job => job.state === NEXUS_JOB_STATE.SUCCEEDED || (job.state === NEXUS_JOB_STATE.SKIPPED && job?.result?.value?.deferred !== true && job?.result?.value?.stale !== true)).map(job => job.type))];
    return { skipped: false, plan: subset, execution, deferred: subset.deferred, handledTypes, resourceBlockedTypes: subset.resourceBlockedTypes || [] };
}
