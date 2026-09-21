import { RETRIEVAL_CHANGE } from '../retrieval/change-gate.js';

/**
 * Smart Context no longer owns scene-change semantics. The authoritative Scene
 * Scanner observes the scene and Change Gate classifies its delta. This module
 * only translates that accepted gate into bounded warm breadth.
 */
export const WARM_TIER = Object.freeze({
    STEADY: 'steady',
    SHIFTING: 'shifting',
    BRANCHING: 'branching',
});

const TIER_POLICY = Object.freeze({
    [WARM_TIER.STEADY]: { warmBudget: 1, candidateInputLimit: 3, sceneMessages: 2 },
    [WARM_TIER.SHIFTING]: { warmBudget: 2, candidateInputLimit: 5, sceneMessages: 3 },
    [WARM_TIER.BRANCHING]: { warmBudget: 6, candidateInputLimit: 14, sceneMessages: 5 },
});

function tierFor(change = {}) {
    if (change.mode === RETRIEVAL_CHANGE.NO_CHANGE && Number(change.confidence) >= 0.75) return WARM_TIER.STEADY;
    if (change.mode === RETRIEVAL_CHANGE.MAJOR_CHANGE) return WARM_TIER.BRANCHING;
    return WARM_TIER.SHIFTING;
}

export function warmFloorForRetrievalGate(gate = null) {
    if (!gate || typeof gate !== 'object') return 0;
    if (gate.mode === RETRIEVAL_CHANGE.MAJOR_CHANGE) return 6;
    if (gate.mode === RETRIEVAL_CHANGE.MINOR_CHANGE) return 2;
    if (gate.mode === RETRIEVAL_CHANGE.NO_CHANGE) return 1;
    return 0;
}

/**
 * Warm breadth consumes the accepted Change Gate. It never rescans prose and
 * never manufactures a second NO/MINOR/MAJOR opinion.
 */
export function scanSceneForWarmBudget({ retrievalGate = null, sceneSnapshot = null, sceneBaseline = false } = {}) {
    const accepted = retrievalGate || (sceneBaseline === true ? {
        mode: RETRIEVAL_CHANGE.NO_CHANGE,
        confidence: 1,
        reason: 'scene baseline established; Smart Context consumes baseline breadth only',
    } : null);
    const tier = accepted ? tierFor(accepted) : WARM_TIER.SHIFTING;
    const policy = TIER_POLICY[tier];
    const gateFloor = warmFloorForRetrievalGate(accepted);
    const warmBudgetFloor = Math.max(policy.warmBudget, gateFloor);
    return {
        tier,
        warmBudget: warmBudgetFloor,
        warmBudgetFloor,
        candidateInputLimit: policy.candidateInputLimit,
        sceneMessages: policy.sceneMessages,
        basis: {
            mode: accepted?.mode || 'UNCLASSIFIED',
            confidence: Number(accepted?.confidence) || 0,
            reason: String(accepted?.reason || 'no accepted Change Gate classification yet'),
            foregroundGate: accepted ? {
                mode: String(accepted.mode || ''),
                confidence: Number(accepted.confidence) || 0,
                reason: String(accepted.reason || ''),
            } : null,
            gateFloor,
            sceneRevision: String(sceneSnapshot?.scanRevision || accepted?.sceneRevision || ''),
            scannerDegraded: sceneSnapshot?.degraded === true,
        },
    };
}

export function warmPolicyForTier(tier) {
    return { ...(TIER_POLICY[tier] || TIER_POLICY[WARM_TIER.SHIFTING]) };
}

export function parseSidecarWarmBudget(value, fallback = 2) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    if (parsed <= 1) return 1;
    if (parsed <= 2) return 2;
    return 6;
}
