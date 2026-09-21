/**
 * Nexus execution-profile descriptor.
 *
 * This module describes which independent execution resources exist. It does
 * not route work. Main/ST and SC-A/SC-B are distinct execution resources. Main
 * remains a Generation-Gateway lease and never becomes a Sidecar lane; model
 * worker adapters may choose among the available resources without changing
 * subsystem ownership or completion semantics.
 */
export const NEXUS_EXECUTION_PROFILE = Object.freeze({
    LOCAL_ONLY: 'local-only',
    MAIN_ONLY: 'main-only',
    ONE_SIDECAR: 'one-sidecar',
    TWO_SIDECAR: 'two-sidecar',
    HYBRID: 'hybrid',
});

export function describeNexusExecutionProfile({
    mainConnected = false,
    mainAllowed = true,
    sidecarAEnabled = false,
    sidecarBEnabled = false,
} = {}) {
    const sidecars = {
        A: sidecarAEnabled === true,
        B: sidecarBEnabled === true,
    };
    const sidecarCount = Number(sidecars.A) + Number(sidecars.B);
    const main = mainConnected === true && mainAllowed === true;
    const kind = main
        ? (sidecarCount > 0 ? NEXUS_EXECUTION_PROFILE.HYBRID : NEXUS_EXECUTION_PROFILE.MAIN_ONLY)
        : (sidecarCount === 2 ? NEXUS_EXECUTION_PROFILE.TWO_SIDECAR
            : sidecarCount === 1 ? NEXUS_EXECUTION_PROFILE.ONE_SIDECAR
                : NEXUS_EXECUTION_PROFILE.LOCAL_ONLY);
    return Object.freeze({
        kind,
        mainConnected: main,
        sidecars: Object.freeze(sidecars),
        sidecarCount,
        internalSidecarWorkAvailable: sidecarCount > 0,
        mainBoundaryAvailable: main,
        mainWorkerAvailable: main,
        modelWorkerAvailable: main || sidecarCount > 0,
        modelWorkerCount: sidecarCount + Number(main),
        workerResources: Object.freeze([...(main ? ['MAIN'] : []), ...(sidecars.A ? ['A'] : []), ...(sidecars.B ? ['B'] : [])]),
        mainIsSidecarLane: false,
    });
}


/**
 * Build a live execution-profile reader without importing settings or gateways
 * into this pure descriptor module. The supplied readers are queried on every
 * snapshot so Sidecar enable/disable changes and Main gateway connection state
 * cannot leave a stale profile cached at runtime initialization.
 */
export function createNexusExecutionProfileResolver({
    readMainConnected = () => false,
    readMainAllowed = () => true,
    readSidecars = () => ({ A: false, B: false }),
} = {}) {
    if (typeof readMainConnected !== 'function') throw new Error('Execution profile readMainConnected must be a function.');
    if (typeof readMainAllowed !== 'function') throw new Error('Execution profile readMainAllowed must be a function.');
    if (typeof readSidecars !== 'function') throw new Error('Execution profile readSidecars must be a function.');
    return () => {
        const sidecars = readSidecars() || {};
        return describeNexusExecutionProfile({
            mainConnected: readMainConnected() === true,
            mainAllowed: readMainAllowed() === true,
            sidecarAEnabled: sidecars.A === true || sidecars.sidecarAEnabled === true,
            sidecarBEnabled: sidecars.B === true || sidecars.sidecarBEnabled === true,
        });
    };
}
