import { getSettings } from '../core/settings.js';
import { canDispatchSidecarWork } from '../sidecar/bus.js';
import { snapshotMainBridgeStatus } from '../nexus/main-bridge-status.js';
import { enqueueNexusModelWorkerJob, dispatchNexusModelWorkerUnits, isNexusMainWorkerEnabled } from '../nexus/model-worker-bus.js';
import { runNexusModelWorkerBatch } from '../nexus/batch-layer.js';

/**
 * Lane A consumes the canonical Nexus Model Worker abstraction without owning
 * Work Director or Sidecar routing policy.  An injected enqueue function is
 * expected to already be a model-worker executor supplied by the Coordinator.
 */
export function enqueueLaneAModelWorkerJob(domain, stage, options = {}, enqueue = null) {
    return typeof enqueue === 'function'
        ? enqueue(stage, options)
        : enqueueNexusModelWorkerJob(domain, stage, options);
}

export function runLaneAModelWorkerBatch(options = {}, enqueue = null) {
    const { laneAEnqueue = null, ...batchOptions } = options || {};
    const selectedEnqueue = typeof laneAEnqueue === 'function' ? laneAEnqueue : enqueue;
    const injected = typeof selectedEnqueue === 'function'
        ? (_domain, stage, request) => selectedEnqueue(stage, request)
        : null;
    return runNexusModelWorkerBatch({
        ...batchOptions,
        dispatchUnits: input => dispatchNexusModelWorkerUnits({
            ...input,
            ...(injected ? { enqueue: injected } : {}),
        }),
    });
}

/** Presentation-only snapshot.  This reports execution resources from the
 * existing policy surfaces; it does not select a worker or redefine policy. */
export function snapshotLaneAModelWorkers(stage, { role = 'summaries' } = {}) {
    const settings = getSettings();
    const main = snapshotMainBridgeStatus();
    const mainConfigured = isNexusMainWorkerEnabled(settings);
    const mainReady = mainConfigured && main.fullyConnected === true;
    const sidecarAvailable = canDispatchSidecarWork(stage, { role }) === true;
    const configuredSidecarLabels = ['A', 'B'].filter(slot => settings.sidecars?.[slot]?.enabled !== false
        && settings.sidecars?.[slot]?.capabilities?.summaries !== false).map(slot => `SC-${slot}`);
    const labels = [];
    if (mainReady) labels.push(main.mode === 'active' ? 'Main (busy)' : 'Main');
    if (sidecarAvailable) labels.push('Sidecar pool');
    return {
        available: mainReady || sidecarAvailable,
        labels: [...new Set(labels)],
        mainConfigured,
        mainReady,
        mainMode: main.mode,
        sidecarAvailable,
        sidecarLabels: configuredSidecarLabels,
    };
}
