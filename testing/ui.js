import { isNexusDevelopmentBuild } from '../core/build-info.js';
import { getSettings } from '../core/settings.js';
import { runLifecycleTask, getSchedulerState } from '../lifecycle/scheduler.js';
import { createCallCenterTestHarness } from '../nexus/call-center-test-harness.js';
import { getNexusRuntime } from '../nexus/runtime.js';
import { getTelemetrySnapshot, logEvent } from '../observability/telemetry.js';
import { getProposals } from '../proposals/store.js';
import { openNexusTestModeLauncher } from '../tests/harness/test-mode-launcher.js';
import { createNexusTestModeAdapter } from './test-mode-adapter.js';

const RESULT_STRING_LIMIT = 2400;
const RESULT_ARRAY_LIMIT = 120;
const RESULT_OBJECT_LIMIT = 160;
const RESULT_DEPTH_LIMIT = 7;
const SENSITIVE_KEY = /(api.?key|authorization|password|secret|credential|bearer)/i;
let nexusTestModeAdapter = null;

function getNexusTestModeAdapter() {
    if (!nexusTestModeAdapter) nexusTestModeAdapter = createNexusTestModeAdapter();
    return nexusTestModeAdapter;
}

export function openNexusTestMode() {
    if (!isNexusDevelopmentBuild()) throw new Error('Nexus Test Mode is available only in development/testing builds.');
    return openNexusTestModeLauncher(getNexusTestModeAdapter());
}

export async function restoreNexusTestModeState() {
    if (!nexusTestModeAdapter) return { restored: false, reason: 'no-active-test-mode-session' };
    const result = await nexusTestModeAdapter.restore();
    nexusTestModeAdapter = null;
    return result;
}

const COMMANDS = Object.freeze([
    { id: 'snapshot.runtime', label: 'Snapshot · Runtime / coordination', mode: 'read-only', description: 'Capture the current Nexus runtime coordination, transaction, call, execution-profile, and batch snapshot.', defaultArgs: {} },
    { id: 'snapshot.telemetry', label: 'Snapshot · Telemetry / Sidecars', mode: 'read-only', description: 'Capture the current bounded telemetry and Sidecar counters without clearing them.', defaultArgs: {} },
    { id: 'snapshot.scheduler', label: 'Snapshot · Lifecycle scheduler', mode: 'read-only', description: 'Capture the active and last lifecycle cycle state.', defaultArgs: {} },
    { id: 'snapshot.proposals', label: 'Snapshot · Lore proposals', mode: 'read-only', description: 'Capture the current Lore Proposal queue for acceptance evidence.', defaultArgs: {} },
    { id: 'call-center.loopback', label: 'Test · Call Center loopback', mode: 'local-test', description: 'Run the existing provider-free Call Center loopback. The local loopback test route must already be enabled.', defaultArgs: { capability: 'search', approved: false } },
    { id: 'lifecycle.post-turn', label: 'Live · Run Post-Turn', mode: 'live', task: 'post-turn', description: 'Run the existing manual Post-Turn scheduler path against current live chat state.', defaultArgs: {} },
    { id: 'lifecycle.summary-check', label: 'Live · Summary Check', mode: 'live', task: 'summary-check', description: 'Run the existing manual Summary eligibility check through the lifecycle scheduler.', defaultArgs: {} },
    { id: 'lifecycle.summary-create', label: 'Live · Create Summary', mode: 'live', task: 'summary-create', description: 'Run the existing manual Summary creation path. Optional scheduler options may be supplied as JSON.', defaultArgs: {} },
    { id: 'lifecycle.summary-backlog', label: 'Live · Process Summary Backlog', mode: 'live', task: 'summary-backlog', description: 'Run the existing manual Summary backlog path.', defaultArgs: {} },
    { id: 'lifecycle.summary-promote', label: 'Live · Promote Due Summaries', mode: 'live', task: 'summary-promote', description: 'Run the existing manual Summary promotion path.', defaultArgs: {} },
    { id: 'lifecycle.lore-route', label: 'Live · Route Unrouted Summary Lore', mode: 'live', task: 'lore-route', description: 'Run the existing manual Summary → Lore routing path under the configured write valve and transaction policy.', defaultArgs: {} },
    { id: 'lifecycle.smart-warm', label: 'Live · Warm Smart Context', mode: 'live', task: 'smart-warm', description: 'Run the existing manual Smart Context warm path.', defaultArgs: {} },
    { id: 'lifecycle.housekeeper', label: 'Live · Run Housekeeper', mode: 'live', task: 'housekeeper', description: 'Run the existing manual Housekeeper scan path.', defaultArgs: {} },
    { id: 'lifecycle.full-cycle', label: 'Live · Run Full Lifecycle', mode: 'live', task: 'full-cycle', description: 'Run the existing manual full lifecycle cycle against current live state.', defaultArgs: {} },
]);

function commandById(id) {
    return COMMANDS.find(command => command.id === id) || null;
}

function clipString(value) {
    const text = String(value ?? '');
    return text.length > RESULT_STRING_LIMIT ? `${text.slice(0, RESULT_STRING_LIMIT)}… [clipped ${text.length - RESULT_STRING_LIMIT} chars]` : text;
}

function sanitizeValue(value, depth = 0, seen = new WeakSet()) {
    if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
    if (typeof value === 'string') return clipString(value);
    if (typeof value === 'bigint') return String(value);
    if (typeof value === 'function') return '[function omitted]';
    if (value instanceof Error) return { name: value.name || 'Error', message: clipString(value.message || String(value)) };
    if (depth >= RESULT_DEPTH_LIMIT) return '[depth clipped]';
    if (typeof value !== 'object') return clipString(value);
    if (seen.has(value)) return '[circular]';
    seen.add(value);
    if (Array.isArray(value)) {
        const out = value.slice(0, RESULT_ARRAY_LIMIT).map(item => sanitizeValue(item, depth + 1, seen));
        if (value.length > RESULT_ARRAY_LIMIT) out.push(`[${value.length - RESULT_ARRAY_LIMIT} more item(s) clipped]`);
        return out;
    }
    const out = {};
    const entries = Object.entries(value);
    for (const [key, child] of entries.slice(0, RESULT_OBJECT_LIMIT)) {
        out[key] = SENSITIVE_KEY.test(key) ? '[redacted]' : sanitizeValue(child, depth + 1, seen);
    }
    if (entries.length > RESULT_OBJECT_LIMIT) out.__clippedKeys = entries.length - RESULT_OBJECT_LIMIT;
    return out;
}

function parseArgs(raw) {
    const text = String(raw ?? '').trim();
    if (!text) return {};
    const parsed = JSON.parse(text);
    if (parsed == null) return {};
    if (Array.isArray(parsed) || typeof parsed !== 'object') throw new Error('Command arguments must be a JSON object.');
    return parsed;
}

async function execute(command, args) {
    switch (command.id) {
        case 'snapshot.runtime': return getNexusRuntime().diagnosticSnapshot();
        case 'snapshot.telemetry': return getTelemetrySnapshot();
        case 'snapshot.scheduler': return getSchedulerState();
        case 'snapshot.proposals': return getProposals('all');
        case 'call-center.loopback': {
            const settings = getSettings().nexus?.callCenter || {};
            const harness = createCallCenterTestHarness(settings);
            return harness.test({ capability: args.capability || 'search', approved: args.approved === true });
        }
        default:
            if (command.task) return runLifecycleTask(command.task, args);
            throw new Error(`Unsupported testing command: ${command.id}`);
    }
}

export function listNexusTestingCommands() {
    return COMMANDS.map(({ id, label, mode, description, defaultArgs }) => ({ id, label, mode, description, defaultArgs: sanitizeValue(defaultArgs) }));
}

export async function runNexusTestingCommand(commandId, args = {}, { allowLive = false } = {}) {
    const command = commandById(String(commandId || ''));
    if (!command) throw new Error(`Unknown testing command: ${commandId || '(empty)'}`);
    if (command.mode === 'live' && allowLive !== true) throw new Error('Live test commands are locked. Enable “Allow live test commands” for this session first.');
    const startedAt = new Date().toISOString();
    const started = globalThis.performance?.now?.() ?? Date.now();
    logEvent('test-harness', 'command-start', { command: command.id, mode: command.mode }, 'info');
    try {
        const result = await execute(command, args || {});
        const finishedAt = new Date().toISOString();
        const durationMs = Math.max(0, Math.round((globalThis.performance?.now?.() ?? Date.now()) - started));
        const envelope = sanitizeValue({ schemaVersion: 1, surface: 'nexus-live-test-console', command: command.id, mode: command.mode, startedAt, finishedAt, durationMs, ok: true, args, result });
        logEvent('test-harness', 'command-complete', { command: command.id, mode: command.mode, durationMs, ok: true }, 'info');
        return envelope;
    } catch (error) {
        const finishedAt = new Date().toISOString();
        const durationMs = Math.max(0, Math.round((globalThis.performance?.now?.() ?? Date.now()) - started));
        logEvent('test-harness', 'command-failed', { command: command.id, mode: command.mode, durationMs, error: error?.message || String(error) }, 'error');
        return sanitizeValue({ schemaVersion: 1, surface: 'nexus-live-test-console', command: command.id, mode: command.mode, startedAt, finishedAt, durationMs, ok: false, args, error: { name: error?.name || 'Error', message: error?.message || String(error) } });
    }
}

function copyText(text) {
    if (globalThis.navigator?.clipboard?.writeText) return globalThis.navigator.clipboard.writeText(text);
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const copied = document.execCommand?.('copy') === true;
    area.remove();
    if (!copied) throw new Error('Clipboard is unavailable in this browser context.');
    return Promise.resolve();
}

export function bindNexusTestingTools(root = document) {
    const host = root.getElementById?.('tv2_test_harness_tools') || document.getElementById('tv2_test_harness_tools');
    if (!isNexusDevelopmentBuild()) { host?.remove(); return false; }
    if (host) host.hidden = false;
    const select = root.getElementById?.('tv2_test_command') || document.getElementById('tv2_test_command');
    const argsArea = root.getElementById?.('tv2_test_command_args') || document.getElementById('tv2_test_command_args');
    const runButton = root.getElementById?.('tv2_test_command_run') || document.getElementById('tv2_test_command_run');
    const copyButton = root.getElementById?.('tv2_test_command_copy') || document.getElementById('tv2_test_command_copy');
    const clearButton = root.getElementById?.('tv2_test_command_clear') || document.getElementById('tv2_test_command_clear');
    const openModeButton = root.getElementById?.('tv2_test_mode_open') || document.getElementById('tv2_test_mode_open');
    const restoreModeButton = root.getElementById?.('tv2_test_mode_restore') || document.getElementById('tv2_test_mode_restore');
    const allowLive = root.getElementById?.('tv2_test_command_allow_live') || document.getElementById('tv2_test_command_allow_live');
    const resultArea = root.getElementById?.('tv2_test_command_result') || document.getElementById('tv2_test_command_result');
    const status = root.getElementById?.('tv2_test_command_status') || document.getElementById('tv2_test_command_status');
    const mode = root.getElementById?.('tv2_test_command_mode') || document.getElementById('tv2_test_command_mode');
    const description = root.getElementById?.('tv2_test_command_description') || document.getElementById('tv2_test_command_description');
    if (!select || !argsArea || !runButton || !resultArea || !status) return false;

    select.innerHTML = COMMANDS.map(command => `<option value="${command.id}">${command.label}</option>`).join('');

    const renderCommand = () => {
        const command = commandById(select.value) || COMMANDS[0];
        if (mode) {
            mode.textContent = command.mode === 'live' ? 'LIVE STATE' : command.mode === 'local-test' ? 'LOCAL TEST' : 'READ ONLY';
            mode.dataset.mode = command.mode;
        }
        if (description) description.textContent = command.description;
        argsArea.value = JSON.stringify(command.defaultArgs || {}, null, 2);
        runButton.textContent = command.mode === 'live' ? 'Run Live Command' : 'Run Command';
    };

    select.addEventListener('change', renderCommand);
    runButton.addEventListener('click', async () => {
        const command = commandById(select.value);
        if (!command) return;
        let args;
        try { args = parseArgs(argsArea.value); }
        catch (error) {
            status.textContent = `Invalid arguments: ${error.message}`;
            status.dataset.state = 'failed';
            return;
        }
        runButton.disabled = true;
        status.textContent = `${command.id} running…`;
        status.dataset.state = 'active';
        try {
            const envelope = await runNexusTestingCommand(command.id, args, { allowLive: allowLive?.checked === true });
            resultArea.value = JSON.stringify(envelope, null, 2);
            status.textContent = envelope.ok ? `${command.id} complete · ${envelope.durationMs}ms` : `${command.id} failed · ${envelope.error?.message || 'unknown error'}`;
            status.dataset.state = envelope.ok ? 'complete' : 'failed';
        } finally {
            runButton.disabled = false;
        }
    });
    copyButton?.addEventListener('click', async () => {
        if (!resultArea.value) return;
        try {
            await copyText(resultArea.value);
            status.textContent = 'Result copied to clipboard.';
            status.dataset.state = 'complete';
        } catch (error) {
            status.textContent = error?.message || String(error);
            status.dataset.state = 'failed';
        }
    });
    clearButton?.addEventListener('click', () => {
        resultArea.value = '';
        status.textContent = 'Test console ready.';
        status.dataset.state = 'idle';
    });
    allowLive?.addEventListener('change', () => {
        status.textContent = allowLive.checked ? 'Live test commands unlocked for this page session.' : 'Live test commands locked.';
        status.dataset.state = allowLive.checked ? 'warn' : 'idle';
    });
    openModeButton?.addEventListener('click', () => {
        try {
            openNexusTestMode();
            status.textContent = 'Nexus Test Mode opened. Controlled suites use isolated/temporary state until restored.';
            status.dataset.state = 'warn';
        } catch (error) {
            status.textContent = error?.message || String(error);
            status.dataset.state = 'failed';
        }
    });
    restoreModeButton?.addEventListener('click', async () => {
        restoreModeButton.disabled = true;
        status.textContent = 'Restoring pre-test Nexus state…';
        status.dataset.state = 'active';
        try {
            const result = await restoreNexusTestModeState();
            status.textContent = result?.restored ? 'Pre-test Nexus state restored.' : 'No active Test Mode state needed restoration.';
            status.dataset.state = 'complete';
        } catch (error) {
            status.textContent = `Test Mode restore failed: ${error?.message || error}`;
            status.dataset.state = 'failed';
        } finally {
            restoreModeButton.disabled = false;
        }
    });

    renderCommand();
    return true;
}
