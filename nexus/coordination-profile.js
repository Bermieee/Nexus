import { NEXUS_JOB_ROUTE } from './contracts.js';
import { NEXUS_MIGRATED_WORKLOAD } from './director-migration.js';
import { isBatchLayerSidecarExecutor, isModelWorkerExecutor } from './sidecar-job-adapter.js';

export const NEXUS_COORDINATION_MODE = Object.freeze({
    LEGACY: 'legacy',
    SHADOW: 'shadow',
    FULL: 'full',
    HYBRID: 'hybrid',
});

export const NEXUS_DIRECTOR_LIFECYCLE_WORKLOADS = Object.freeze([
    NEXUS_MIGRATED_WORKLOAD.SMART_WARM,
    NEXUS_MIGRATED_WORKLOAD.POST_TURN_EXTRACT,
    NEXUS_MIGRATED_WORKLOAD.NOTEBOOK_REFRESH,
    NEXUS_MIGRATED_WORKLOAD.CHARACTER_BANK_REFRESH,
    NEXUS_MIGRATED_WORKLOAD.SUMMARY,
    NEXUS_MIGRATED_WORKLOAD.SUMMARY_PROMOTION,
    NEXUS_MIGRATED_WORKLOAD.LORE_ROUTING,
    NEXUS_MIGRATED_WORKLOAD.MAINTENANCE,
]);

export const NEXUS_DIRECTOR_WORKLOAD_ROUTES = Object.freeze({
    [NEXUS_MIGRATED_WORKLOAD.SMART_WARM]: NEXUS_JOB_ROUTE.MODEL_WORKER,
    [NEXUS_MIGRATED_WORKLOAD.POST_TURN_EXTRACT]: NEXUS_JOB_ROUTE.MODEL_WORKER,
    [NEXUS_MIGRATED_WORKLOAD.NOTEBOOK_REFRESH]: NEXUS_JOB_ROUTE.MODEL_WORKER,
    [NEXUS_MIGRATED_WORKLOAD.CHARACTER_BANK_REFRESH]: NEXUS_JOB_ROUTE.LOCAL,
    [NEXUS_MIGRATED_WORKLOAD.SUMMARY]: NEXUS_JOB_ROUTE.MODEL_WORKER,
    [NEXUS_MIGRATED_WORKLOAD.SUMMARY_PROMOTION]: NEXUS_JOB_ROUTE.MODEL_WORKER,
    [NEXUS_MIGRATED_WORKLOAD.LORE_ROUTING]: NEXUS_JOB_ROUTE.MODEL_WORKER,
    [NEXUS_MIGRATED_WORKLOAD.MAINTENANCE]: NEXUS_JOB_ROUTE.MODEL_WORKER,
});

function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
}

function normalizedKnownWorkloads(value = []) {
    const known = new Set(NEXUS_DIRECTOR_LIFECYCLE_WORKLOADS);
    return [...new Set((Array.isArray(value) ? value : [])
        .map(item => String(item || '').trim())
        .filter(item => known.has(item)))];
}

function sameWorkloadSet(a = [], b = []) {
    const left = normalizedKnownWorkloads(a);
    const right = normalizedKnownWorkloads(b);
    return left.length === right.length && left.every(item => right.includes(item));
}

/**
 * Infer the effective coordination mode from the real gates rather than a
 * separate mode flag. This keeps upgrades safe: partially migrated stored
 * settings remain HYBRID instead of being silently rewritten to a preset.
 */
export function inferNexusCoordinationMode(nexus = {}) {
    const director = nexus?.workDirector || {};
    const migrated = normalizedKnownWorkloads(nexus?.migration?.migratedWorkloads || []);
    const nexusEnabled = nexus?.enabled === true;
    const directorEnabled = director.enabled === true;
    const shadowOnly = director.shadowOnly !== false;

    if (!nexusEnabled && !directorEnabled && migrated.length === 0) return NEXUS_COORDINATION_MODE.LEGACY;
    if (nexusEnabled && directorEnabled && shadowOnly && migrated.length === 0) return NEXUS_COORDINATION_MODE.SHADOW;
    if (
        nexusEnabled
        && directorEnabled
        && !shadowOnly
        && nexus?.transactionLedger?.enabled === true
        && nexus?.executionEngine?.enabled === true
        && sameWorkloadSet(migrated, NEXUS_DIRECTOR_LIFECYCLE_WORKLOADS)
    ) return NEXUS_COORDINATION_MODE.FULL;
    return NEXUS_COORDINATION_MODE.HYBRID;
}

/**
 * Apply an explicit operator-selected coordination preset. HYBRID is inferred
 * only and is deliberately not writable so an existing partial migration can
 * never be flattened by an unrelated settings save.
 */
export function applyNexusCoordinationMode(nexus = {}, mode = NEXUS_COORDINATION_MODE.LEGACY) {
    const selected = String(mode || '').trim();
    if (selected === NEXUS_COORDINATION_MODE.HYBRID) return clone(nexus || {});
    if (![NEXUS_COORDINATION_MODE.LEGACY, NEXUS_COORDINATION_MODE.SHADOW, NEXUS_COORDINATION_MODE.FULL].includes(selected)) {
        throw new Error(`Unknown Nexus coordination mode: ${mode}`);
    }
    const next = clone(nexus || {}) || {};
    next.useLegacyFallback = next.useLegacyFallback !== false;
    next.workDirector = { ...(next.workDirector || {}) };
    next.transactionLedger = { ...(next.transactionLedger || {}) };
    next.executionEngine = { ...(next.executionEngine || {}) };
    next.migration = { ...(next.migration || {}) };

    if (selected === NEXUS_COORDINATION_MODE.LEGACY) {
        next.enabled = false;
        next.workDirector.enabled = false;
        next.workDirector.shadowOnly = true;
        next.transactionLedger.enabled = false;
        next.executionEngine.enabled = false;
        next.migration.migratedWorkloads = [];
        return next;
    }
    if (selected === NEXUS_COORDINATION_MODE.SHADOW) {
        next.enabled = true;
        next.workDirector.enabled = true;
        next.workDirector.shadowOnly = true;
        next.transactionLedger.enabled = false;
        next.executionEngine.enabled = false;
        next.migration.migratedWorkloads = [];
        return next;
    }

    next.enabled = true;
    next.workDirector.enabled = true;
    next.workDirector.shadowOnly = false;
    next.transactionLedger.enabled = true;
    next.executionEngine.enabled = true;
    next.migration.migratedWorkloads = [...NEXUS_DIRECTOR_LIFECYCLE_WORKLOADS];
    return next;
}

/**
 * Runtime guard for Full Director mode. Presence alone is not enough: every
 * Model workloads must be marked model-worker executors, while the one
 * deterministic Character Bank reconciliation remains LOCAL.
 */
export function inspectDirectorMigrationCoverage(executors = {}) {
    const missing = [];
    const invalid = [];
    const covered = [];
    for (const workload of NEXUS_DIRECTOR_LIFECYCLE_WORKLOADS) {
        const executor = executors?.[workload];
        if (typeof executor !== 'function') {
            missing.push(workload);
            continue;
        }
        const expectedRoute = NEXUS_DIRECTOR_WORKLOAD_ROUTES[workload];
        if (expectedRoute === NEXUS_JOB_ROUTE.SIDECAR && !isBatchLayerSidecarExecutor(executor)) {
            invalid.push({ workload, reason: 'sidecar-executor-not-batch-layer-marked' });
            continue;
        }
        if (expectedRoute === NEXUS_JOB_ROUTE.MODEL_WORKER && !isModelWorkerExecutor(executor)) {
            invalid.push({ workload, reason: 'model-worker-executor-not-marked' });
            continue;
        }
        if (expectedRoute === NEXUS_JOB_ROUTE.LOCAL && isBatchLayerSidecarExecutor(executor)) {
            invalid.push({ workload, reason: 'local-executor-must-not-use-sidecar-batch-layer' });
            continue;
        }
        covered.push(workload);
    }
    return {
        complete: missing.length === 0 && invalid.length === 0,
        expected: [...NEXUS_DIRECTOR_LIFECYCLE_WORKLOADS],
        covered,
        missing,
        invalid,
    };
}
