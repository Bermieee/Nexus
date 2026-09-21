import { WorkDirector } from './work-director.js';
import { NexusWorkCoordinator } from './work-coordinator.js';
import { TransactionLedger } from './transaction-ledger.js';
import { getNexusLedger } from './transaction-service.js';
import { CallCenter } from './call-center.js';
import { CallCenterLogicGate } from './logic-gate.js';
import { CapabilityRegistry } from './capability-registry.js';
import { FunctionGateway } from './function-gateway.js';
import { GenerationGateway } from './generation-gateway.js';
import { NEXUS_CALL_TARGET } from './contracts.js';
import { NexusBatchLayer } from './batch-layer.js';
import { createNexusExecutionProfileResolver } from './execution-profile.js';

/**
 * Nexus 0.6.2 composition root.
 *
 * This remains inert until a migration adapter explicitly feeds events/plans
 * into it. Main stays a distinct Generation-Gateway lease rather than a Sidecar
 * lane; model-worker adapters may use it when policy allows and foreground Main
 * is idle. The Work Coordinator still has no Call Center dependency.
 */
export function createNexusRuntime(options = {}) {
    const ledger = options.ledger instanceof TransactionLedger ? options.ledger : getNexusLedger();
    const logicGate = new CallCenterLogicGate(options.callCenter?.logicGate || options.callCenter || {});
    const callCenter = new CallCenter({ policy: options.callCenter?.policy || {}, logicGate });
    const capabilityRegistry = options.capabilityRegistry instanceof CapabilityRegistry
        ? options.capabilityRegistry
        : new CapabilityRegistry(options.capabilities || []);
    const functionGateway = new FunctionGateway({ registry: capabilityRegistry, callCenter, ledger });
    const generationGateway = new GenerationGateway(options.generationGateway || {});
    // Register the boundary adapter object once. Connection state remains on the
    // Generation Gateway itself so an adapter may be attached/detached at
    // runtime without reconstructing Call Center or touching Sidecar routing.
    callCenter.registerAdapter(NEXUS_CALL_TARGET.ST_MAIN, generationGateway.adapter());
    callCenter.registerAdapter(NEXUS_CALL_TARGET.ST_RAW, generationGateway.adapter());

    const coordinator = new NexusWorkCoordinator();
    const batchLayer = new NexusBatchLayer();
    const fixedSidecars = {
        A: options.executionProfile?.sidecarAEnabled === true,
        B: options.executionProfile?.sidecarBEnabled === true,
    };
    const readSidecars = typeof options.executionProfile?.readSidecars === 'function'
        ? options.executionProfile.readSidecars
        : () => fixedSidecars;
    const fixedMainAllowed = options.modelWorker?.useMain === true;
    const readMainAllowed = typeof options.executionProfile?.readMainAllowed === 'function'
        ? options.executionProfile.readMainAllowed
        : () => fixedMainAllowed;
    const readExecutionProfile = createNexusExecutionProfileResolver({
        readMainConnected: () => generationGateway.isConnected(),
        readMainAllowed,
        readSidecars,
    });
    return {
        director: new WorkDirector(options.director),
        coordinator,
        // Compatibility alias for 0.6 framework callers. It is no longer an
        // A/B scheduler; Sidecar Bus owns SC-A/SC-B scheduling.
        execution: coordinator,
        batchLayer,
        ledger,
        logicGate,
        callCenter,
        capabilityRegistry,
        functionGateway,
        generationGateway,
        connectGenerationGateway(generate, reason = 'runtime-connect') {
            generationGateway.connect(generate, reason);
            return this.executionProfile;
        },
        disconnectGenerationGateway(reason = 'runtime-disconnect') {
            generationGateway.disconnect(reason);
            return this.executionProfile;
        },
        configureCallCenter(config = {}) {
            callCenter.configure({ policy: config?.policy || {}, logic: config || {} });
            return {
                policy: callCenter.policyGate?.snapshot?.() || null,
                logic: logicGate.snapshot(),
            };
        },
        get executionProfile() { return readExecutionProfile(); },
        diagnosticSnapshot() {
            return {
                plans: this.director.snapshot(),
                transactions: ledger.list(),
                calls: callCenter.snapshot(),
                capabilities: capabilityRegistry.list(),
                executionProfile: this.executionProfile,
                generationGateway: generationGateway.snapshot(),
                coordinator: coordinator.diagnosticSnapshot(),
                batch: batchLayer.status(),
            };
        },
    };
}

let sharedRuntime = null;

/** Initialize the process-wide Nexus coordination runtime used by SillyTavern. */
export function initNexusRuntime(options = {}) {
    if (!sharedRuntime) sharedRuntime = createNexusRuntime(options);
    return sharedRuntime;
}

export function getNexusRuntime() {
    return sharedRuntime || initNexusRuntime();
}

/** Test/development hook. Production callers should not reset a live runtime. */
export function resetNexusRuntime() {
    try { sharedRuntime?.disconnectGenerationGateway?.('runtime-reset'); } catch {}
    try { sharedRuntime?.functionGateway?.close?.(); } catch {}
    sharedRuntime = null;
}
