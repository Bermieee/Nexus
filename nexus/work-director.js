import { planLifecycleJobs } from '../scheduler/planner.js';
import {
    NEXUS_EVENT_TYPE,
    NEXUS_JOB_KIND,
    NEXUS_JOB_ROUTE,
    createNexusEvent,
    createNexusJob,
    createNexusJobPlan,
    deepCopy,
} from './contracts.js';
import { getNexusWorkloadResourceIntent } from './resource-policy.js';

/**
 * Nexus 0.6.2 Work Director.
 *
 * Deterministic planning only. It answers whether work should exist and records
 * why. It never calls a model, enqueues Sidecar work, selects SC-A/SC-B, enters
 * Call Center, batches work, or mutates persistent state.
 */

const DEFAULT_POLICY = Object.freeze({
    smartWarm: true,
    postTurn: true,
    notebook: true,
    characterBanks: true,
    summaries: true,
    promotion: true,
    loreRouting: true,
    maintenance: true,
    coldOpen: true,
});

function normalizedActors(value) {
    return [...new Set((value || []).map(actor => String(actor || '').trim().toLowerCase()).filter(Boolean))].sort();
}

export function compareSceneState(previous = {}, current = {}) {
    const beforeActors = normalizedActors(previous.activeActors);
    const afterActors = normalizedActors(current.activeActors);
    const hasExplicitCharacterBankActors = Array.isArray(previous.characterBankActiveActors) || Array.isArray(current.characterBankActiveActors);
    // Legacy/direct planner callers historically supplied only activeActors.
    // Lifecycle snapshots now separate Scene Scanner participants from Character
    // Bank presence, but absence of the new field must not silently disable the
    // existing local reconciliation workload for non-lifecycle callers.
    const beforeBankActors = normalizedActors(hasExplicitCharacterBankActors ? previous.characterBankActiveActors : previous.activeActors);
    const afterBankActors = normalizedActors(hasExplicitCharacterBankActors ? current.characterBankActiveActors : current.activeActors);
    const rawLocationChanged = String(previous.location || '').trim() !== String(current.location || '').trim();
    const rawActorsChanged = beforeActors.join('|') !== afterActors.join('|');
    const locationChanged = typeof current.sceneLocationChanged === 'boolean' ? current.sceneLocationChanged : rawLocationChanged;
    const actorsChanged = typeof current.sceneActorsChanged === 'boolean' ? current.sceneActorsChanged : rawActorsChanged;
    const characterBankActorsChanged = beforeBankActors.join('|') !== afterBankActors.join('|');
    const assistantTurnAdvanced = Math.max(0, Number(current.assistantTurns) || 0) > Math.max(0, Number(previous.assistantTurns) || 0);
    const explicit = String(current.changeClass || '').toLowerCase();
    const hasAuthoritativeChangeClass = ['major', 'minor', 'none'].includes(explicit);
    // GitHub architecture: Scene Scanner observes and Change Gate owns the
    // semantic NO/MINOR/MAJOR decision. Director consumes that accepted class;
    // it may not independently promote/downgrade it from another snapshot.
    // Direct/legacy callers without a Change Gate class retain a compatibility
    // fallback so non-lifecycle tools are not silently reclassified as stable.
    const structuralMajor = rawLocationChanged || rawActorsChanged || current.majorBeat === true;
    const level = hasAuthoritativeChangeClass ? explicit
        : structuralMajor ? 'major'
            : current.minorBeat === true ? 'minor' : 'none';
    return {
        level,
        classificationAuthority: hasAuthoritativeChangeClass ? 'change-gate' : 'legacy-fallback',
        locationChanged,
        actorsChanged,
        activeActors: afterActors,
        characterBankActorsChanged,
        characterBankActiveActors: afterBankActors,
        assistantTurnAdvanced,
        coldStart: current.coldStart === true,
        treeMutated: current.treeMutated === true,
        smartWarmStale: current.smartWarmStale === true,
        smartWarmDue: current.smartWarmDue !== false,
        summaryDue: current.summaryDue === true,
        promotionDue: current.promotionDue === true,
        loreRoutingDue: current.loreRoutingDue === true,
        maintenanceDue: current.maintenanceDue === true,
        postTurnDue: current.postTurnDue !== false,
        notebookDue: current.notebookDue === true,
        notebookDueReason: String(current.notebookDueReason || ''),
        maintenanceDueReason: String(current.maintenanceDueReason || ''),
        maintenancePressure: deepCopy(current.maintenancePressure || null),
    };
}

function modelWorkerJob(spec = {}) {
    const resourceIntent = getNexusWorkloadResourceIntent(spec.type);
    return createNexusJob({
        ...spec,
        route: NEXUS_JOB_ROUTE.MODEL_WORKER,
        lane: null,
        metadata: {
            ...(spec.metadata || {}),
            ...(resourceIntent ? { resourceIntent } : {}),
        },
    });
}


function localJob(spec = {}) {
    return createNexusJob({ ...spec, route: NEXUS_JOB_ROUTE.LOCAL, lane: null });
}

export class WorkDirector {
    constructor({ policy = {}, now = () => Date.now() } = {}) {
        this.policy = { ...DEFAULT_POLICY, ...deepCopy(policy) };
        this.now = now;
        this.history = [];
    }

    buildPlanFromEvent(eventLike = {}, { policy = {} } = {}) {
        const event = createNexusEvent(eventLike);
        return this.buildPlan({
            previous: event.previous,
            current: event.current,
            source: event.source,
            policy,
            eventId: event.id,
            eventType: event.type,
            revision: event.revision,
        });
    }

    buildPlan({ previous = {}, current = {}, source = 'lifecycle', policy = {}, eventId = null, eventType = NEXUS_EVENT_TYPE.LIFECYCLE, revision = null } = {}) {
        const plan=planLifecycleJobs({
            gates:{...this.policy,...policy},classification:compareSceneState(previous,current),
            source,eventId,eventType,revision,now:this.now,
            normalizeJob:(job,route)=>route===NEXUS_JOB_ROUTE.LOCAL?localJob(job):modelWorkerJob(job),
        });
        this.history.push(plan);
        if (this.history.length > 100) this.history.shift();
        return plan;
    }

    /**
     * Plan an explicit subsystem workload without executing it. This is used by
     * first-class manual subsystems such as Lorebook Builder that already know
     * which semantic work exists, while preserving Director ownership of job
     * normalization, route declaration, resource intent, dependencies, and
     * plan identity. Physical dispatch remains outside the Director.
     */
    buildRequestedPlan({ source = 'manual', classification = {}, decisions = [], jobs = [], eventId = null, metadata = {} } = {}) {
        const plannedJobs = (jobs || []).map(spec => {
            const route = spec.route || NEXUS_JOB_ROUTE.MODEL_WORKER;
            if (route === NEXUS_JOB_ROUTE.LOCAL) return localJob(spec);
            if (route === NEXUS_JOB_ROUTE.MODEL_WORKER) return modelWorkerJob(spec);
            // Explicit subsystem routes (physical Sidecar and Tree Batch Fire)
            // are preserved. Main-worker abstraction is opt-in at the planner,
            // not a rewrite of Builder's already-authoritative execution path.
            return createNexusJob({ ...spec, route, lane: null });
        });
        const plan = createNexusJobPlan({
            eventId,
            source,
            classification,
            decisions,
            jobs: plannedJobs,
            metadata: { plannedAt: this.now(), planner: 'deterministic-explicit', ...deepCopy(metadata || {}) },
        });
        this.history.push(plan);
        if (this.history.length > 100) this.history.shift();
        return plan;
    }

    snapshot() { return this.history.map(deepCopy); }
}

/**
 * Allocate one bounded opportunity to already-defined resumable work. The
 * Director chooses only priority/capacity. The owning subsystem must still
 * perform its own freshness check and decides what a semantic unit means.
 */
export function planContinuableExecutionOpportunity({ workloads = [], maxUnits = 1, foregroundPending = false } = {}) {
    const limit = Math.max(1, Math.min(1000, Math.floor(Number(maxUnits) || 1)));
    if (foregroundPending) return { admitted: false, reason: 'foreground-pending', maxUnits: 0, requiresOwnerFreshnessCheck: true };
    const eligible = (Array.isArray(workloads) ? workloads : [])
        .filter(row => row && String(row.state || 'pending') === 'pending' && row.workId)
        .sort((a, b) => (Number(b.priority) || 0) - (Number(a.priority) || 0)
            || (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0)
            || String(a.workId).localeCompare(String(b.workId)));
    const selected = eligible[0];
    if (!selected) return { admitted: false, reason: 'no-eligible-continuable-work', maxUnits: 0, requiresOwnerFreshnessCheck: true };
    return {
        admitted: true,
        workId: String(selected.workId),
        ownerSubsystem: selected.ownerSubsystem ? String(selected.ownerSubsystem) : null,
        maxUnits: limit,
        priority: Number(selected.priority) || 0,
        requiresOwnerFreshnessCheck: true,
    };
}
