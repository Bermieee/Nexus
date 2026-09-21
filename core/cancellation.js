/** Shared cancellation helpers for intentional foreground preemption. */
export function isForegroundAbort(error, signal = null) {
    const reason = signal?.aborted ? signal.reason : null;
    return error?.name === 'TV2ForegroundAbort' || reason?.name === 'TV2ForegroundAbort';
}

export function resolveAbortReason(error, signal = null) {
    if (signal?.aborted && signal.reason) return signal.reason;
    return error;
}

export function isIntentionalCancellation(error, signal = null) {
    const reason = signal?.aborted ? signal.reason : null;
    const name = String(error?.name || reason?.name || '');
    return ['TV2ForegroundAbort', 'TV2ForegroundPreflightTimeout', 'TV2GenerationStopped', 'TV2ScopeInvalidated', 'TV2BatchCancelled', 'TV2ExecutionProfileRetired', 'AbortError'].includes(name);
}
