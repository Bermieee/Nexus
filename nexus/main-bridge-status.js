import { getSettings } from '../core/settings.js';

const EVENT_NAME = 'nexus-main-bridge-status';
const state = {
    lifecycleBridgeConnected: false,
    generationGatewayConnected: false,
    lifecycleActiveSources: new Set(),
    gatewayActiveSources: new Set(),
    lastEvent: null,
    updatedAt: 0,
};

function emit() {
    state.updatedAt = Date.now();
    try { globalThis.window?.dispatchEvent?.(new CustomEvent(EVENT_NAME, { detail: snapshotMainBridgeStatus() })); } catch {}
}

/** SillyTavern lifecycle hooks are installed/removed. */
export function markMainBridgeConnected(connected = true, event = 'bridge') {
    state.lifecycleBridgeConnected = connected === true;
    if (!state.lifecycleBridgeConnected) state.lifecycleActiveSources.clear();
    state.lastEvent = String(event || 'bridge');
    emit();
}

/** Generation Gateway has an actual SillyTavern Main adapter attached/detached. */
export function markMainGatewayConnected(connected = true, event = 'generation-gateway') {
    state.generationGatewayConnected = connected === true;
    if (!state.generationGatewayConnected) state.gatewayActiveSources.clear();
    state.lastEvent = String(event || 'generation-gateway');
    emit();
}

/** Foreground SillyTavern lifecycle state (normal RP generation). */
export function markMainLifecycleActive(active = true, event = 'generation', source = 'foreground-main') {
    const key = String(source || 'foreground-main');
    // Activity callbacks report work, not connectivity. A late callback after
    // detach must never resurrect a disconnected bridge.
    if (active === true && state.lifecycleBridgeConnected) state.lifecycleActiveSources.add(key);
    else if (active !== true) state.lifecycleActiveSources.delete(key);
    state.lastEvent = String(event || 'generation');
    emit();
}

/** Actual Generation Gateway activity (generateRaw is currently in flight). */
export function markMainGatewayActive(active = true, event = 'generation-gateway', source = 'call-center-main') {
    const key = String(source || 'call-center-main');
    if (active === true && state.generationGatewayConnected) state.gatewayActiveSources.add(key);
    else if (active !== true) state.gatewayActiveSources.delete(key);
    state.lastEvent = String(event || 'generation-gateway');
    emit();
}

export function snapshotMainBridgeStatus() {
    const settings=getSettings(),callCenter = settings.nexus?.callCenter || {};
    const boundaryAllowed = settings.enabled === true && callCenter.mainModelAccess === true;
    const workerRequested = boundaryAllowed;
    const functionGatewayRequested = boundaryAllowed && callCenter.enabled === true;
    const requested = workerRequested;
    const connected = state.lifecycleBridgeConnected || state.generationGatewayConnected;
    const fullyConnected = state.lifecycleBridgeConnected && state.generationGatewayConnected;
    const active = state.lifecycleActiveSources.size > 0 || state.gatewayActiveSources.size > 0;
    // Presentation follows Nexus execution authority before generic SillyTavern
    // foreground activity. Normal RP generation can make the physical Main
    // lifecycle busy even while Nexus Main access is disabled; that must not
    // render as a third active Nexus worker lane. lifecycleActive/gatewayActive
    // remain exposed for the Generation Gateway's physical busy lease.
    const mode = !requested ? 'disabled' : active ? 'active' : fullyConnected ? 'ready' : connected ? 'partial' : 'disconnected';
    return {
        connected,
        fullyConnected,
        active,
        requested,
        workerRequested,
        boundaryAllowed,
        functionGatewayRequested,
        mode,
        lifecycleBridgeConnected: state.lifecycleBridgeConnected,
        generationGatewayConnected: state.generationGatewayConnected,
        lifecycleActive: state.lifecycleActiveSources.size > 0,
        gatewayActive: state.gatewayActiveSources.size > 0,
        activeSources: [...state.lifecycleActiveSources, ...state.gatewayActiveSources],
        lastEvent: state.lastEvent,
        updatedAt: state.updatedAt,
    };
}

export function mainBridgeStatusHtml() {
    const snap = snapshotMainBridgeStatus();
    const active = snap.mode === 'active';
    const label = active ? 'Main active' : snap.mode === 'ready' ? 'Main ready' : snap.mode === 'partial' ? 'Main partial' : snap.mode === 'disabled' ? 'Main disabled' : 'Main disconnected';
    const title = active
        ? `SillyTavern Main work is physically active${snap.requested?'':' while Nexus Main policy is disabled'}.`
        : snap.mode==='disabled'
            ? `Nexus Main policy is disabled${snap.active?'; SillyTavern Main is physically busy with non-Nexus foreground work, but it is not a Nexus execution lane.':snap.connected?'; physical bridge connectivity still exists.':'.'}`
            : snap.mode==='partial'
                ? 'Only one half of the Main bridge is connected; both lifecycle and Generation Gateway connectivity are required for ready.'
                : !snap.connected
                    ? 'No SillyTavern lifecycle bridge or Generation Gateway adapter is connected.'
                    : 'SillyTavern Main bridge is fully connected and ready for foreground-safe Nexus model-worker leases.';
    return `<span class="tv2-main-runtime" data-state="${snap.mode}" title="${title.replace(/"/g,'&quot;')}"><i></i> ${label}</span>`;
}

export function getMainBridgeStatusEventName() { return EVENT_NAME; }
