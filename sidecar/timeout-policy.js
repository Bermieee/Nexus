/**
 * Nexus Sidecar transport-time policy.
 *
 * A worker profile timeout is the configured BASE for that worker. Workload
 * callers may request additional headroom, but a stale local timeout hint must
 * never shorten the configured baseline. Larger planned/actual inputs and
 * large output/reasoning envelopes receive bounded extra headroom.
 */
export const DEFAULT_SIDECAR_TIMEOUT_MS = 120000;
export const WORKLOAD_TIMEOUT_BASE_TOKENS = 12000;
export const WORKLOAD_TIMEOUT_STEP_TOKENS = 12000;
export const WORKLOAD_TIMEOUT_STEP_MS = 30000;
export const OUTPUT_TIMEOUT_BASE_TOKENS = 4096;
export const OUTPUT_TIMEOUT_STEP_TOKENS = 4096;
export const OUTPUT_TIMEOUT_STEP_MS = 20000;
export const REASONING_TIMEOUT_STEP_MS = 30000;
export const WORKLOAD_TIMEOUT_MAX_MS = 300000;

function positiveMs(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

function positiveTokens(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

export function resolveSidecarTransportTimeout({
    profileTimeoutMs = null,
    requestedTimeoutMs = null,
    estimatedInputTokens = 0,
    plannedInputTokens = 0,
    plannedOutputTokens = 0,
    requestMaxTokens = 0,
    reasoningEffort = null,
} = {}) {
    const configuredBase = positiveMs(profileTimeoutMs) || DEFAULT_SIDECAR_TIMEOUT_MS;
    const requestedFloor = positiveMs(requestedTimeoutMs) || 0;
    const workloadTokens = Math.max(0, positiveTokens(estimatedInputTokens), positiveTokens(plannedInputTokens));
    const inputSteps = workloadTokens > WORKLOAD_TIMEOUT_BASE_TOKENS
        ? Math.ceil((workloadTokens - WORKLOAD_TIMEOUT_BASE_TOKENS) / WORKLOAD_TIMEOUT_STEP_TOKENS)
        : 0;
    const outputTokens = Math.max(positiveTokens(plannedOutputTokens), positiveTokens(requestMaxTokens));
    const outputSteps = outputTokens > OUTPUT_TIMEOUT_BASE_TOKENS
        ? Math.ceil((outputTokens - OUTPUT_TIMEOUT_BASE_TOKENS) / OUTPUT_TIMEOUT_STEP_TOKENS)
        : 0;
    const effort = String(reasoningEffort || '').trim().toLowerCase();
    const reasoningSteps = ['medium', 'high', 'max', 'xhigh'].includes(effort) ? 1 : 0;
    const cap = Math.max(configuredBase, WORKLOAD_TIMEOUT_MAX_MS);
    const workloadFloor = Math.min(
        cap,
        configuredBase
            + inputSteps * WORKLOAD_TIMEOUT_STEP_MS
            + outputSteps * OUTPUT_TIMEOUT_STEP_MS
            + reasoningSteps * REASONING_TIMEOUT_STEP_MS,
    );
    return Math.max(configuredBase, requestedFloor, workloadFloor);
}
