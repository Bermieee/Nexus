import { getSettings } from './settings.js';
import { getJobQueue } from './job-queue.js';
import { initTreeStore } from '../tree/store.js';
import { initProposalStore } from '../proposals/store.js';
import { refreshSidecarBus, cancelNexusSidecarBusWork } from '../sidecar/bus.js';
import { configureTelemetry, logEvent } from '../observability/telemetry.js';
import { initNexusRuntime, resetNexusRuntime } from '../nexus/runtime.js';
import { markMainGatewayConnected, snapshotMainBridgeStatus } from '../nexus/main-bridge-status.js';

let runtimeState = 'idle';
let queueGuardianTimer = null;
let nexusRuntime = null;

function stopQueueGuardian() {
    if (queueGuardianTimer != null && typeof globalThis.clearInterval === 'function') {
        try { globalThis.clearInterval(queueGuardianTimer); } catch {}
    }
    queueGuardianTimer = null;
}

function unwindRuntime(reason = 'runtime-unwind') {
    stopQueueGuardian();
    try { cancelNexusSidecarBusWork({ reason: `Nexus runtime ${reason}.` }); } catch {}
    try { getJobQueue(getSettings().jobs).cancelWhere(() => true, `Nexus runtime ${reason}.`); } catch {}
    try { nexusRuntime?.disconnectGenerationGateway?.(reason); } catch {}
    try { nexusRuntime?.functionGateway?.close?.(); } catch {}
    try { resetNexusRuntime(); } catch {}
    nexusRuntime = null;
}

export function initRuntime() {
    if (runtimeState === 'ready' && nexusRuntime) return nexusRuntime;
    if (runtimeState === 'starting') {
        const error = new Error('Nexus core runtime initialization re-entered before the first attempt settled.');
        error.name = 'TV2RuntimeInitializationReentrant';
        throw error;
    }
    runtimeState = 'starting';
    try {
        const settings = getSettings();
        configureTelemetry(settings.observability || {});
        const queue = getJobQueue({ maxConcurrent: settings.jobs.maxConcurrent });
        initTreeStore();
        initProposalStore();
        refreshSidecarBus();
        nexusRuntime = initNexusRuntime({
            executionProfile: {
                sidecarAEnabled: settings.sidecars?.A?.enabled === true,
                sidecarBEnabled: settings.sidecars?.B?.enabled === true,
                readSidecars: () => {
                    const live = getSettings();
                    return {
                        A: live.sidecars?.A?.enabled === true,
                        B: live.sidecars?.B?.enabled === true,
                    };
                },
                readMainAllowed: () => {
                    const live = getSettings();
                    return live.enabled === true
                        && live.nexus?.modelWorker?.useMain === true;
                },
            },
            callCenter: settings.nexus?.callCenter || {},
            modelWorker: settings.nexus?.modelWorker || {},
            generationGateway: { onConnected: (connected, reason) => markMainGatewayConnected(connected, reason), readMainActivity: () => snapshotMainBridgeStatus() },
        });
        // The watchdog becomes live only after every throw-capable runtime
        // component above has completed. Failed startup therefore cannot leave
        // a timer operating against a partial runtime.
        if (!queueGuardianTimer && typeof globalThis.setInterval === 'function') {
            queueGuardianTimer = globalThis.setInterval(() => queue.reconcile('periodic-watchdog'), 5000);
        }
        runtimeState = 'ready';
        logEvent('runtime', 'initialized', {
            maxConcurrent: settings.jobs.maxConcurrent,
            sidecarAEnabled: settings.sidecars?.A?.enabled === true,
            sidecarBEnabled: settings.sidecars?.B?.enabled === true,
            routing: settings.routing,
            queueGuardian: '5s local reconciliation',
            nexusProfile: nexusRuntime.executionProfile,
        });
        console.log('[Nexus] Runtime initialized');
        return nexusRuntime;
    } catch (error) {
        unwindRuntime('initialization-failed');
        runtimeState = 'failed';
        throw error;
    }
}

export function teardownRuntime(reason = 'runtime-teardown') {
    unwindRuntime(reason);
    runtimeState = 'idle';
}

export function runtimeInitializationState() { return runtimeState; }
