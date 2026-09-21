/**
 * Generation Frame publication ownership contract.
 *
 * This module is intentionally host-free and declarative. Runtime Frame
 * publication is capability-gated by generation-frame-bus.js; this map is the
 * build-time ownership allowlist enforced by the HOTFIX41 regression. A Nexus
 * subsystem may not import another subsystem's typed outlet port merely because
 * the JavaScript export is technically reachable.
 */
export const NEXUS_GENERATION_PORT_OWNER_MODULES = Object.freeze({
    publishStoryScopeOutlet: Object.freeze(['nexus/generation-frame-outlets.js']),
    publishSummaryBankOutlet: Object.freeze(['nexus/generation-frame-outlets.js']),
    publishLedgerOutlet: Object.freeze(['nexus/generation-frame-outlets.js']),
    publishSmartContextOutlet: Object.freeze(['nexus/generation-frame-outlets.js']),
    publishCharacterBanksOutlet: Object.freeze(['nexus/generation-frame-outlets.js']),
    publishSceneOutlet: Object.freeze(['nexus/generation-frame-outlets.js']),
    publishChangeGateOutlet: Object.freeze(['nexus/generation-frame-outlets.js']),

    publishBootstrapLoreOutlet: Object.freeze(['retrieval/bootstrap-admission.js']),
    clearBootstrapLoreOutlet: Object.freeze(['retrieval/bootstrap-admission.js']),
    publishRetrievalLoreOutlet: Object.freeze(['retrieval/prompt-bridge.js']),
    clearRetrievalLoreOutlet: Object.freeze(['retrieval/prompt-bridge.js']),
    publishMemoryRecallOutlet: Object.freeze(['memory/recall.js']),
    clearMemoryRecallOutlet: Object.freeze(['memory/recall.js']),
    publishNotebookOutlet: Object.freeze(['memory/notebook.js']),
    clearNotebookOutlet: Object.freeze(['memory/notebook.js']),
});

export function allowedGenerationFramePortOwners(portName){
    return [...(NEXUS_GENERATION_PORT_OWNER_MODULES[String(portName||'')]||[])];
}
