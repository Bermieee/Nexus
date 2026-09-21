import { RETRIEVAL_CHANGE } from './change-gate.js';

/**
 * Operational retrieval strategy. This module deliberately does not classify
 * narrative change. Change Gate owns NO_CHANGE / MINOR_CHANGE / MAJOR_CHANGE;
 * this planner only decides how much retrieval work is required to satisfy the
 * current cache/coverage state.
 */
export const RETRIEVAL_EXECUTION = Object.freeze({
    REUSE: 'REUSE',
    TARGETED_REFRESH: 'TARGETED_REFRESH',
    FULL_REROUTE: 'FULL_REROUTE',
    INITIAL_FULL: 'INITIAL_FULL',
});

export function planRetrievalExecution({
    gate = null,
    hasReusableInjection = false,
    hasReusableRegions = false,
    forceFullRouting = false,
    forceTargetedRefresh = false,
    forceReason = '',
    reusePlan = null,
} = {}) {
    const mode = String(gate?.mode || '');
    const reuse = reusePlan && typeof reusePlan === 'object' ? reusePlan : null;
    const reuseMeta = {
        semanticClass: mode || null,
        reuseRatio: Number.isFinite(Number(reuse?.reuseRatio)) ? Number(reuse.reuseRatio) : null,
        estimatedDirtyUnits: Number.isFinite(Number(reuse?.estimatedDirtyUnits)) ? Number(reuse.estimatedDirtyUnits) : null,
        estimatedWorkUnits: Number.isFinite(Number(reuse?.estimatedWorkUnits)) ? Number(reuse.estimatedWorkUnits) : null,
        workloadUnits: reuse?.workloadUnits && typeof reuse.workloadUnits === 'object' ? { ...reuse.workloadUnits } : null,
        preserveAuthorizedRefs: reuse?.preserveAuthorizedRefs === true,
        preservedRefs: Array.isArray(reuse?.preservedRefs) ? reuse.preservedRefs.map(ref => ({ ...ref })) : [],
        dirtyRefs: Array.isArray(reuse?.dirtyRefs) ? reuse.dirtyRefs.map(ref => ({ ...ref })) : [],
        dirtyDomains: Array.isArray(reuse?.dirtyDomains) ? [...reuse.dirtyDomains] : [],
    };

    // Cache absence is never a narrative transition. It only means Nexus must
    // build its first validated retrieval result before future reuse is possible.
    if (!hasReusableInjection) {
        return {
            mode: RETRIEVAL_EXECUTION.INITIAL_FULL,
            fullRegional: true,
            reuseInjection: false,
            reuseRegions: false,
            reason: 'no validated Nexus injection exists yet; build the initial retrieval without changing scene classification',
            ...reuseMeta,
        };
    }

    if (forceFullRouting) {
        return {
            mode: RETRIEVAL_EXECUTION.FULL_REROUTE,
            fullRegional: true,
            reuseInjection: false,
            reuseRegions: false,
            reason: String(forceReason || 'fresh routing required by retrieval coverage state'),
            ...reuseMeta,
        };
    }

    // Operational policy changes can require rebuilding the injection without
    // manufacturing a semantic Change Gate transition. Reuse prior regions when
    // they remain authoritative; otherwise fall back to a full reroute.
    if (forceTargetedRefresh) {
        if (hasReusableRegions) {
            return {
                mode: RETRIEVAL_EXECUTION.TARGETED_REFRESH,
                fullRegional: false,
                reuseInjection: false,
                reuseRegions: true,
                reason: String(forceReason || 'retrieval execution policy changed; refresh within reusable regions'),
                ...reuseMeta,
            };
        }
        return {
            mode: RETRIEVAL_EXECUTION.FULL_REROUTE,
            fullRegional: true,
            reuseInjection: false,
            reuseRegions: false,
            reason: String(forceReason || 'retrieval execution policy changed and no reusable regions remain'),
            ...reuseMeta,
        };
    }

    if (mode === RETRIEVAL_CHANGE.NO_CHANGE) {
        return {
            mode: RETRIEVAL_EXECUTION.REUSE,
            fullRegional: false,
            reuseInjection: true,
            reuseRegions: true,
            reason: 'Change Gate found stable continuity and a validated injection is reusable',
            ...reuseMeta,
        };
    }

    if (reuse?.escalateFullRefresh === true) {
        return {
            mode: RETRIEVAL_EXECUTION.FULL_REROUTE,
            fullRegional: true, reuseInjection: false, reuseRegions: false,
            reason: 'owner-authorized context reuse fell below the safe threshold; escalate to full retrieval',
            ...reuseMeta,
        };
    }

    if (mode === RETRIEVAL_CHANGE.MINOR_CHANGE && hasReusableRegions) {
        return {
            mode: RETRIEVAL_EXECUTION.TARGETED_REFRESH,
            fullRegional: false,
            reuseInjection: false,
            reuseRegions: true,
            reason: 'Change Gate requested a targeted refresh and prior regional routing remains available',
            ...reuseMeta,
        };
    }


    if (mode === RETRIEVAL_CHANGE.MAJOR_CHANGE && hasReusableRegions && reuse?.reuseRegions === true && reuse?.preserveAuthorizedRefs === true) {
        return {
            mode: RETRIEVAL_EXECUTION.TARGETED_REFRESH,
            fullRegional: false,
            reuseInjection: false,
            reuseRegions: true,
            reason: 'Change Gate detected a major semantic transition, but Retrieval owner authority preserves regional routing and a validated context subset',
            ...reuseMeta,
        };
    }

    return {
        mode: RETRIEVAL_EXECUTION.FULL_REROUTE,
        fullRegional: true,
        reuseInjection: false,
        reuseRegions: false,
        reason: mode === RETRIEVAL_CHANGE.MAJOR_CHANGE
            ? 'Change Gate detected a structural scene transition'
            : 'targeted refresh has no reusable regional routing; perform a fresh routing pass without promoting the Change Gate',
        ...reuseMeta,
    };
}
