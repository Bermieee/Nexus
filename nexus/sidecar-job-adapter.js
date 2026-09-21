import { deepCopy } from './contracts.js';

async function resolveEnqueue(enqueue) {
    if (typeof enqueue === 'function') return enqueue;
    const module = await import('./batch-layer.js');
    return module.enqueueNexusSidecarJob;
}

/**
 * Adapter from a planned internal Nexus job to the existing Sidecar coalescer.
 * It never chooses SC-A/SC-B; the Batch Layer hands the request to Sidecar Bus.
 * The Batch Layer import is lazy so pure planner/coordinator tests stay free of
 * SillyTavern runtime dependencies.
 */
export const NEXUS_BATCH_LAYER_EXECUTOR_MARKER = Symbol.for('nexus.batch-layer-sidecar-executor');

export const NEXUS_MODEL_WORKER_EXECUTOR_MARKER = Symbol.for('nexus.model-worker-executor');

export function isModelWorkerExecutor(executor) {
    return typeof executor === 'function' && executor[NEXUS_MODEL_WORKER_EXECUTOR_MARKER] === true;
}

export function markModelWorkerExecutor(executor) {
    if (typeof executor !== 'function') throw new Error('A Nexus model-worker executor marker requires a function.');
    Object.defineProperty(executor, NEXUS_MODEL_WORKER_EXECUTOR_MARKER, { value: true, enumerable: false });
    return executor;
}


export function isBatchLayerSidecarExecutor(executor) {
    return typeof executor === 'function' && executor[NEXUS_BATCH_LAYER_EXECUTOR_MARKER] === true;
}

export function markBatchLayerSidecarExecutor(executor) {
    if (typeof executor !== 'function') throw new Error('A Nexus Batch Layer executor marker requires a function.');
    Object.defineProperty(executor, NEXUS_BATCH_LAYER_EXECUTOR_MARKER, { value: true, enumerable: false });
    // A Sidecar-only adapter is also a valid MODEL_WORKER adapter: it simply
    // represents a model-worker implementation whose selected physical resource
    // is constrained to the Sidecar pool. This preserves migration compatibility
    // while allowing the Director contract to name the abstract resource class.
    if (executor[NEXUS_MODEL_WORKER_EXECUTOR_MARKER] !== true) Object.defineProperty(executor, NEXUS_MODEL_WORKER_EXECUTOR_MARKER, { value: true, enumerable: false });
    return executor;
}

export function createBatchLayerSidecarExecutor({ domain, stage, buildOptions, enqueue = null } = {}) {
    if (!domain) throw new Error('A Nexus Sidecar executor requires a Batch Layer domain.');
    if (!stage) throw new Error('A Nexus Sidecar executor requires a Sidecar Bus stage.');
    if (typeof buildOptions !== 'function') throw new Error('A Nexus Sidecar executor requires buildOptions(job, plan).');
    if (enqueue !== null && typeof enqueue !== 'function') throw new Error('A Nexus Sidecar executor enqueue override must be a function.');

    const executor = async (job, plan, context = {}) => {
        const { signal = null, isFresh = null } = context || {};
        const cancellationError = () => {
            const reason = signal?.reason instanceof Error ? signal.reason : new Error(String(signal?.reason || 'Nexus coordinated Sidecar work cancelled.'));
            if (!reason.name || reason.name === 'Error') reason.name = 'TV2ScopeInvalidated';
            return reason;
        };
        if (signal?.aborted) throw cancellationError();
        if (typeof isFresh === 'function' && isFresh() === false) throw cancellationError();
        const enqueueFn = await resolveEnqueue(enqueue);
        if (signal?.aborted || (typeof isFresh === 'function' && isFresh() === false)) throw cancellationError();
        const options = await buildOptions(deepCopy(job), deepCopy(plan), context);
        if (signal?.aborted || (typeof isFresh === 'function' && isFresh() === false)) throw cancellationError();
        const handle = enqueueFn(domain, stage, {
            ...(options || {}),
            priority: Number.isFinite(Number(job?.priority)) ? Number(job.priority) : options?.priority,
            telemetry: {
                ...(options?.telemetry || {}),
                nexusPlanId: plan?.id || null,
                nexusDirectorJobId: job?.id || null,
                nexusDirectorJobType: job?.type || null,
                nexusInternalWorker: true,
            },
        });
        const abortPhysical = () => { try { handle.cancel?.(cancellationError()); } catch {} };
        signal?.addEventListener?.('abort', abortPhysical, { once: true });
        let response;
        try {
            if (typeof isFresh === 'function' && isFresh() === false) abortPhysical();
            response = await handle.promise;
            if (signal?.aborted || (typeof isFresh === 'function' && isFresh() === false)) {
                abortPhysical();
                throw cancellationError();
            }
        } finally {
            signal?.removeEventListener?.('abort', abortPhysical);
        }
        return {
            sidecarOnly: true,
            batchLayer: true,
            handleId: handle.id || null,
            jobId: handle.jobId || null,
            response,
        };
    };
    return markBatchLayerSidecarExecutor(executor);
}
