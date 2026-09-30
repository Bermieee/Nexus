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

export function getMainBridgeStatusEventName() { return EVENT_NAME; }
