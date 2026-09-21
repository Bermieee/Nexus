import { getSettings, updateSettings } from '../core/settings.js';
import {
    collapsible, toggle, input, button, itemRow, badge, el, mount,
} from '../ui/index.js';
import { DECISION_MODE } from './constants.js';
import { getDecisionProviderStatus, testDecisionConnection } from './index.js';
import { getDecisionTelemetryChangeEventName, getDecisionTelemetrySnapshot, resetDecisionTelemetry } from './telemetry.js';

const MOUNT_ID = 'tv2_decision_core_settings_mount';
let telemetryBound = false;
let refreshScheduled = false;
let connectionTestUiState = { phase: 'idle', result: null, error: null };
function fmtNumber(value) { return Number(value || 0).toLocaleString(); }
function fmtMs(value) { const n = Number(value) || 0; return n >= 1000 ? `${(n / 1000).toFixed(2)}s` : `${Math.round(n)}ms`; }
function fmtCost(value) { const n = Number(value); return Number.isFinite(n) ? `$${n.toFixed(n < 0.01 ? 6 : 4)}` : 'Unavailable'; }
function fmtTime(value) { const n = Number(value); if (!n) return 'Never'; try { return new Date(n).toLocaleString(); } catch { return 'Never'; } }
function rerenderSoon() {
    if (refreshScheduled) return;
    refreshScheduled = true;
    queueMicrotask(() => {
        refreshScheduled = false;
        const target = globalThis.document?.getElementById?.(MOUNT_ID);
        if (target?.isConnected !== false) mountDecisionCoreSettings(target);
    });
}
function updateDecisionSettings(mutator) {
    updateSettings(settings => { settings.decisionCore ||= {}; settings.decisionCore.connection ||= {}; mutator(settings.decisionCore, settings); });
    rerenderSoon();
}
async function runConnectionTest(control) {
    if (control) control.disabled = true;
    const label = control?.querySelector?.('span');
    if (label) label.textContent = 'Testing…';
    connectionTestUiState = { phase: 'testing', result: null, error: null };
    try {
        const result = await testDecisionConnection();
        if (result?.ok === true) {
            connectionTestUiState = { phase: 'success', result, error: null };
            const model = result.providerModel ? ` · ${result.providerModel}` : '';
            const latency = Number.isFinite(Number(result.latencyMs)) ? ` · ${fmtMs(result.latencyMs)}` : '';
            globalThis.toastr?.success?.(`Jev connection verified${model}${latency}`, 'Decision Core');
        } else {
            const message = result?.error?.message || 'Decision provider did not accept the connectivity test.';
            connectionTestUiState = { phase: 'failure', result, error: message };
            globalThis.toastr?.error?.(message, 'Decision Core connection failed');
        }
        return result;
    } catch (error) {
        const message = error?.message || String(error);
        connectionTestUiState = { phase: 'failure', result: null, error: message };
        globalThis.toastr?.error?.(message, 'Decision Core connection failed');
        return null;
    } finally {
        if (control) control.disabled = false;
        rerenderSoon();
    }
}

export function buildDecisionCoreSettings({ document = globalThis.document } = {}) {
    const settings = getSettings();
    const config = settings.decisionCore || {};
    const status = getDecisionProviderStatus(settings);
    const telemetry = getDecisionTelemetrySnapshot();
    const connection = status.connection || {};
    const savedKey = Boolean(connection.configured || String(config.connection?.apiKey || '').trim());
    const lastTest = connection.lastTest || null;

    const masterToggle = toggle({
        label: 'Enable Decision Core', checked: config.enabled === true, document,
        onChange: event => updateDecisionSettings(dc => {
            const enabled = event.currentTarget.checked === true;
            dc.enabled = enabled;
            dc.mode = enabled ? DECISION_MODE.ASSIST : DECISION_MODE.OFF;
        }),
    });
    const fallbackToggle = toggle({
        label: 'Enable existing LLM fallback', checked: config.fallbackEnabled !== false, document,
        onChange: event => updateDecisionSettings(dc => { dc.fallbackEnabled = event.currentTarget.checked === true; }),
    });
    const endpoint = input({
        label: 'Endpoint', value: connection.endpoint || config.connection?.endpoint || '',
        placeholder: 'https://api.typesafe.ai/v1/systemone', document,
        help: 'Use the Decision/Jev endpoint. OpenRouter endpoints are detected automatically.',
        onChange: event => updateDecisionSettings(dc => { dc.connection ||= {}; dc.connection.endpoint = String(event.currentTarget.value || '').trim(); dc.connection.lastTest = null; }),
    });
    const apiKey = input({
        label: 'API key', value: '', type: 'password',
        placeholder: savedKey ? 'Saved key configured — enter a new key to replace it' : 'Enter API key', document,
        help: connection.provider === 'openrouter-jev' ? 'Use a dedicated OpenRouter API key (sk-or-…). TypeSafe keys are not valid here, and Sidecar A/B credentials are never borrowed.' : 'Use the API key issued for this Decision Core endpoint.',
        onChange: event => {
            const value = String(event.currentTarget.value || '').trim();
            if (!value) return;
            updateDecisionSettings(dc => { dc.connection ||= {}; dc.connection.apiKey = value; dc.connection.lastTest = null; });
            event.currentTarget.value = '';
        },
    });
    const model = input({
        label: 'Model', value: connection.model || config.connection?.model || 'jev-latest',
        placeholder: 'jev-latest', document,
        onChange: event => updateDecisionSettings(dc => { dc.connection ||= {}; dc.connection.model = String(event.currentTarget.value || '').trim() || 'jev-latest'; dc.connection.lastTest = null; }),
    });
    const testButton = button({ label: connectionTestUiState.phase === 'testing' ? 'Testing…' : 'Test Connection', variant: 'secondary', disabled: connectionTestUiState.phase === 'testing', document });
    testButton.addEventListener('click', () => runConnectionTest(testButton));
    const clearKey = button({
        label: 'Clear Saved Key', variant: 'ghost', size: 'sm', disabled: !savedKey, document,
        onClick: () => {
            if (globalThis.confirm && !globalThis.confirm('Clear the saved Decision Core API key?')) return;
            updateDecisionSettings(dc => { dc.connection ||= {}; dc.connection.apiKey = ''; dc.connection.lastTest = null; });
        },
    });
    const effectiveTest = connectionTestUiState.phase === 'success'
        ? { ok: true, ...(connectionTestUiState.result || {}) }
        : connectionTestUiState.phase === 'failure'
            ? { ok: false, errorMessage: connectionTestUiState.error, ...(connectionTestUiState.result || {}) }
            : lastTest;
    const connectionState = connectionTestUiState.phase === 'testing' ? 'testing' : effectiveTest?.ok === true ? 'success' : (effectiveTest?.errorCategory || effectiveTest?.error || effectiveTest?.errorMessage) ? 'failure' : 'untested';
    const stateBadge = badge({
        label: connectionState === 'testing' ? 'TESTING' : connectionState === 'success' ? 'CONNECTED' : connectionState === 'failure' ? 'FAILED' : 'NOT TESTED',
        tone: connectionState === 'success' ? 'success' : connectionState === 'failure' ? 'danger' : connectionState === 'testing' ? 'info' : 'neutral',
        document,
    });
    const providerLabel = effectiveTest?.provider || connection.provider;
    const modelLabel = effectiveTest?.providerModel || effectiveTest?.model || connection.model;
    const latencyValue = effectiveTest?.latencyMs;
    const failureText = effectiveTest?.error?.message || effectiveTest?.errorMessage || effectiveTest?.errorCategory || '';
    const detailParts = [];
    if (providerLabel && providerLabel !== 'auto') detailParts.push(providerLabel);
    if (modelLabel) detailParts.push(modelLabel);
    if (Number.isFinite(Number(latencyValue))) detailParts.push(fmtMs(latencyValue));
    if (connectionState === 'success') detailParts.push(`Verified ${fmtTime(effectiveTest?.successAt || effectiveTest?.checkedAt || Date.now())}`);
    else if (connectionState === 'failure' && failureText) detailParts.push(failureText);
    else if (connectionState === 'untested') detailParts.push(connection.configured ? 'Ready to test' : 'Enter endpoint and API key');
    const connectionStatus = el('div', { className: 'nx-decision-connection-status nx-row', document }, [
        stateBadge,
        el('span', { className: connectionState === 'failure' ? 'nx-inline-error' : 'nx-text-muted', text: detailParts.join(' · '), document }),
    ]);

    const telemetryRows = [
        ['Telemetry window started', fmtTime(telemetry.windowStartedAt)],
        ['Total decisions', telemetry.totalDecisions], ['Jev calls', telemetry.jevCalls], ['LLM fallback calls', telemetry.llmFallbackCalls],
        ['Shadow agreements', telemetry.shadowAgreements], ['Shadow disagreements', telemetry.shadowDisagreements], ['Provider failures', telemetry.providerFailures],
        ['Average latency', fmtMs(telemetry.averageLatencyMs)], ['Input tokens', telemetry.inputTokens], ['Stale results', telemetry.staleResults],
        ['Provider-reported actual cost', fmtCost(telemetry.actualReportedCost)], ['Estimated Jev cost', fmtCost(telemetry.estimatedJevCost)],
        ['Potential full LLM calls avoided', telemetry.potentialExpensiveLlmCallsAvoided],
    ].map(([title, value]) => itemRow({ title, trailing: [el('span', { className: 'nx-readout', text: typeof value === 'number' ? fmtNumber(value) : String(value), document })], document }));

    const resetTelemetryButton = button({ label: 'Reset telemetry window', variant: 'secondary', size: 'sm', document, onClick: () => { resetDecisionTelemetry({ source: 'settings-ui' }); globalThis.toastr?.success?.('Decision telemetry counters reset for a new measurement window.', 'Decision Core'); rerenderSoon(); } });
    const telemetryActions = el('div', { className: 'nx-action-row nx-decision-telemetry-actions', document }, [resetTelemetryButton, el('span', { className: 'nx-text-muted', text: 'Resets counters only; provider settings and connection state are unchanged.', document })]);
    const telemetryPanel = collapsible({ title: 'Telemetry', open: false, body: [telemetryActions, ...telemetryRows], document });
    return el('div', { className: 'nexus-ui nx-decision-core-settings nx-stack', document }, [
        masterToggle,
        endpoint,
        apiKey,
        model,
        el('div', { className: 'nx-action-row nx-decision-connection-actions', document }, [testButton, clearKey, connectionStatus]),
        fallbackToggle,
        telemetryPanel,
    ]);
}

export function mountDecisionCoreSettings(target = globalThis.document?.getElementById?.(MOUNT_ID)) {
    if (!target) return null;
    const document = target.ownerDocument || globalThis.document;
    const page = buildDecisionCoreSettings({ document });
    mount(target, page);
    if (!telemetryBound && globalThis.window?.addEventListener) {
        telemetryBound = true;
        globalThis.window.addEventListener(getDecisionTelemetryChangeEventName(), () => rerenderSoon());
    }
    return page;
}
