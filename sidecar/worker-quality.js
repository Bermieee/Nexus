/**
 * Pure helpers for automatic Tree Builder scatter fairness, quality scoring,
 * and temporary lane rehabilitation. Kept transport-agnostic so policy can be
 * regression-tested without a SillyTavern host environment.
 */
export function evaluateTreeBuildWorkerQuality(own = {}, peer = {}) {
    const ownAttempts = Math.max(0, Number(own?.attempts) || 0);
    const peerAttempts = Math.max(0, Number(peer?.attempts) || 0);
    const ownSemanticFailures = Math.max(0, Number(own?.semanticFailures) || 0);
    const ownSemanticRate = Math.max(0, Number(own?.semanticFailureRate) || 0);
    const peerSemanticRate = Math.max(0, Number(peer?.semanticFailureRate) || 0);
    const ownLatencySamples = Math.max(0, Number(own?.latencySamples) || 0);
    const peerLatencySamples = Math.max(0, Number(peer?.latencySamples) || 0);
    const ownMedian = Number(own?.medianLatencyMs);
    const peerMedian = Number(peer?.medianLatencyMs);

    const semanticBad = ownAttempts >= 2
        && peerAttempts >= 1
        && ownSemanticFailures >= 2
        && ownSemanticRate >= 0.5
        && ownSemanticRate >= peerSemanticRate + 0.34;
    const latencyBad = ownLatencySamples >= 2
        && peerLatencySamples >= 2
        && Number.isFinite(ownMedian)
        && Number.isFinite(peerMedian)
        && ownMedian >= 20000
        && ownMedian >= peerMedian * 2;

    return {
        deprioritize: semanticBad || latencyBad,
        semanticBad,
        latencyBad,
        reason: semanticBad && latencyBad
            ? 'semantic-quality-and-latency'
            : semanticBad
                ? 'semantic-quality'
                : latencyBad
                    ? 'relative-latency'
                    : null,
    };
}

const TREE_BUILD_PROBE_BACKOFF = Object.freeze([
    Object.freeze({ requiredPeerSuccesses: 3, cooldownMs: 30000 }),
    Object.freeze({ requiredPeerSuccesses: 6, cooldownMs: 60000 }),
    Object.freeze({ requiredPeerSuccesses: 12, cooldownMs: 120000 }),
]);

export function treeBuildWorkerProbePolicy(backoffLevel = 0) {
    const index = Math.max(0, Math.min(TREE_BUILD_PROBE_BACKOFF.length - 1, Math.floor(Number(backoffLevel) || 0)));
    return { ...TREE_BUILD_PROBE_BACKOFF[index], backoffLevel: index };
}

export function shouldProbeTreeBuildWorker({
    peerSuccessesSinceDemotion = 0,
    deprioritizedAt = 0,
    now = Date.now(),
    backoffLevel = 0,
} = {}) {
    const policy = treeBuildWorkerProbePolicy(backoffLevel);
    const elapsedMs = Math.max(0, Number(now) - Number(deprioritizedAt || 0));
    const peerSuccesses = Math.max(0, Number(peerSuccessesSinceDemotion) || 0);
    const successGateMet = peerSuccesses >= policy.requiredPeerSuccesses;
    const timeGateMet = elapsedMs >= policy.cooldownMs;
    return {
        eligible: successGateMet || timeGateMet,
        successGateMet,
        timeGateMet,
        elapsedMs,
        peerSuccessesSinceDemotion: peerSuccesses,
        ...policy,
    };
}

export function evaluateTreeBuildWorkerProbe({ success = false, durationMs = null, semanticFailure = false } = {}, peer = {}) {
    if (!success) {
        return {
            recover: false,
            reason: semanticFailure ? 'semantic-failure' : 'request-failure',
            latencyThresholdMs: null,
        };
    }
    const duration = Number(durationMs);
    const peerMedian = Number(peer?.medianLatencyMs);
    const latencyThresholdMs = Number.isFinite(peerMedian)
        ? Math.min(45000, Math.max(20000, peerMedian * 2))
        : 45000;
    const latencyHealthy = !Number.isFinite(duration) || duration <= latencyThresholdMs;
    return {
        recover: latencyHealthy,
        reason: latencyHealthy ? 'probe-passed' : 'probe-still-slow',
        latencyThresholdMs,
        peerMedianLatencyMs: Number.isFinite(peerMedian) ? peerMedian : null,
    };
}

export function treeBuildScatterLead(preferredSlot = 'B', sequence = 1) {
    const preferred = String(preferredSlot || '').toUpperCase() === 'A' ? 'A' : 'B';
    return Math.max(1, Number(sequence) || 1) % 2 === 1
        ? preferred
        : (preferred === 'A' ? 'B' : 'A');
}
