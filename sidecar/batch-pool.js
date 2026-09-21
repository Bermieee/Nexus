/**
 * Nexus cooperative batch worker pool.
 *
 * This module is transport-agnostic. The caller supplies a dispatch function
 * that pins one batch to one Sidecar slot. The pool keeps at most one active
 * batch per slot, starts A+B together when both are available, and gives the
 * next pending batch to whichever slot becomes free first.
 */


function isIntentionalBatchCancellation(error) {
    const name = String(error?.name || '');
    return ['AbortError','TV2BatchCancelled','TV2GenerationStopped','TV2ForegroundAbort','TV2ScopeInvalidated','TV2WorkStale'].includes(name);
}

function normalizeSlots(slots = []) {
    return [...new Set((slots || []).map(s => String(s || '').toUpperCase()).filter(s => s === 'A' || s === 'B'))];
}

export function describeInitialScatter({ slots = [], batchCount = 0, queueLoads = {} } = {}) {
    const normalized = normalizeSlots(slots);
    const idle = normalized.filter(slot => queueLoads?.[slot]?.idle !== false);
    return {
        slots: normalized,
        idleSlots: idle,
        dualIdle: Number(batchCount) >= 2 && idle.includes('A') && idle.includes('B'),
        initialFanout: Math.min(Math.max(0, Number(batchCount) || 0), normalized.length),
    };
}

export async function runBatchPool({
    batches = [],
    slots = ['A', 'B'],
    dispatch,
    fallback = true,
    allowPartial = false,
    shouldRetry = null,
    onAttemptStart = null,
    onAttemptSuccess = null,
    onAttemptFailure = null,
    onWorkerIdle = null,
    isWorkerEligible = null,
} = {}) {
    if (typeof dispatch !== 'function') throw new TypeError('Nexus batch pool requires a dispatch function.');
    const workers = normalizeSlots(slots);
    if (!workers.length) throw new Error('Nexus batch pool has no eligible Sidecar workers.');

    const items = (Array.isArray(batches) ? batches : []).map((batch, index) => ({
        index,
        batch,
        attempts: [],
        errors: [],
    }));
    if (!items.length) return { results: [], failures: [], slots: workers };

    const pending = [...items];
    const active = new Map();
    const settled = new Array(items.length).fill(null);

    return await new Promise((resolve, reject) => {
        let finished = false;

        const finishIfDone = () => {
            if (finished || pending.length || active.size) return false;
            finished = true;
            const results = settled.filter(row => row?.ok === true);
            const failures = settled.filter(row => row?.ok === false);
            const intentionalFailures = failures.filter(row => isIntentionalBatchCancellation(row.error));
            if (failures.length && intentionalFailures.length === failures.length && results.length === 0) {
                const error = intentionalFailures[0].error || Object.assign(new Error('Nexus batch work cancelled.'), { name: 'TV2BatchCancelled' });
                error.batchFailures = failures;
                error.batchResults = results;
                reject(error);
            } else if (failures.length && !allowPartial) {
                if (intentionalFailures.length === failures.length) {
                    const error = intentionalFailures[0].error;
                    error.batchFailures = failures;
                    error.batchResults = results;
                    reject(error);
                } else {
                    const error = new AggregateError(failures.map(row => row.error), `Nexus batch job failed ${failures.length}/${settled.length} batch(es).`);
                    error.batchFailures = failures;
                    error.batchResults = results;
                    reject(error);
                }
            } else {
                resolve({ results, failures, slots: workers });
            }
            return true;
        };

        const nextEligibleIndex = slot => {
            for (let i = 0; i < pending.length; i++) {
                const item = pending[i];
                if (item.attempts.includes(slot)) continue;
                if (typeof isWorkerEligible === 'function') {
                    let eligible = true;
                    try { eligible = isWorkerEligible({ slot, item, pending: [...pending], active: new Map(active), workers: [...workers] }) !== false; }
                    catch { eligible = false; }
                    if (!eligible) continue;
                }
                return i;
            }
            return -1;
        };

        const pump = () => {
            if (finished) return;
            for (const slot of workers) {
                if (active.has(slot)) continue;
                const pendingIndex = nextEligibleIndex(slot);
                if (pendingIndex < 0) { try { onWorkerIdle?.(slot); } catch {} continue; }
                const item = pending.splice(pendingIndex, 1)[0];
                item.attempts.push(slot);
                active.set(slot, item.index);
                const attempt = item.attempts.length;
                try { onAttemptStart?.({ slot, index: item.index, batch: item.batch, attempt, attemptedSlots: [...item.attempts] }); } catch {}

                const attemptStartedAt = Date.now();
                let dispatched;
                try {
                    dispatched = dispatch({ slot, index: item.index, batch: item.batch, attempt, attemptedSlots: [...item.attempts] });
                } catch (error) {
                    dispatched = Promise.reject(error);
                }
                Promise.resolve(dispatched)
                    .then(value => {
                        const durationMs = Math.max(0, Date.now() - attemptStartedAt);
                        settled[item.index] = { ok: true, index: item.index, batch: item.batch, slot, attempts: [...item.attempts], value, durationMs };
                        try { onAttemptSuccess?.({ slot, index: item.index, batch: item.batch, attempt, value, attemptedSlots: [...item.attempts], durationMs }); } catch {}
                    })
                    .catch(error => {
                        const durationMs = Math.max(0, Date.now() - attemptStartedAt);
                        item.errors.push(error);
                        const hasAlternateWorker = workers.some(worker => !item.attempts.includes(worker));
                        let retryAllowed = true;
                        let policyError = null;
                        if (typeof shouldRetry === 'function') {
                            try {
                                retryAllowed = shouldRetry({
                                    slot,
                                    index: item.index,
                                    batch: item.batch,
                                    attempt,
                                    error,
                                    attemptedSlots: [...item.attempts],
                                    workers: [...workers],
                                }) !== false;
                            } catch (classifiedError) {
                                // Retry policy is execution authority. A classifier
                                // failure cannot authorize fallback provider work, and
                                // it remains attached to the one physical-attempt record.
                                retryAllowed = false;
                                policyError = classifiedError;
                                item.errors.push(classifiedError);
                            }
                        }
                        const canRetryElsewhere = fallback && hasAlternateWorker && retryAllowed;
                        try { onAttemptFailure?.({
                            slot, index: item.index, batch: item.batch, attempt,
                            error, willRetry: canRetryElsewhere, attemptedSlots: [...item.attempts],
                            policyFailure: !!policyError,
                            policyError,
                            durationMs,
                        }); } catch {}
                        if (canRetryElsewhere) {
                            // Requeue only the failed slice. The slot that just failed
                            // is immediately free to claim a different eligible batch.
                            pending.unshift(item);
                        } else {
                            const settledError = policyError
                                ? Object.assign(new AggregateError([error, policyError], 'Provider attempt failed and retry-policy classification also failed.'), {
                                    name: 'TV2RetryPolicyFailure',
                                    providerError: error,
                                    retryPolicyError: policyError,
                                })
                                : error;
                            settled[item.index] = { ok: false, index: item.index, batch: item.batch, slot, attempts: [...item.attempts], error: settledError, errors: [...item.errors] };
                        }
                    })
                    .finally(() => {
                        active.delete(slot);
                        if (!finishIfDone()) pump();
                    });
            }
            finishIfDone();
        };

        pump();
    });
}
