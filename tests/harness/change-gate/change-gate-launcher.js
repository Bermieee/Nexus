import {
    CHANGE_GATE_HARNESS_VERSION,
    CHANGE_GATE_GROUPS,
    CHANGE_GATE_SCENARIOS,
} from './fixture-definition.js';

const WINDOW_ID = 'nexus-change-gate-test-harness';

function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}

function requireFn(adapter, name) {
    if (typeof adapter?.[name] !== 'function') throw new Error(`Change Gate test harness adapter is missing ${name}().`);
    return adapter[name].bind(adapter);
}

function findScenario(id) {
    return CHANGE_GATE_SCENARIOS.find(row => row.id === id) || null;
}

/**
 * One-click production-path scenario runner.
 *
 * The adapter must establish state through normal SillyTavern/Nexus runtime
 * behavior. It must NOT satisfy the oracle by calling classifyRetrievalChange()
 * directly or writing a classification into telemetry/state.
 *
 * Required adapter:
 *   resetScenarioSession()
 *   primeBaseline({ text, requireReusableInjection, scenarioId })
 *   submitSceneTurn({ text, scenarioId })
 *
 * Additional required operations for special fixtures:
 *   clearReusableInjection()                    // CG-MJ-001 (historical ID; bootstrap NO_CHANGE + INITIAL_FULL)
 *   reproduceNoResolvableLatestUserText()       // CG-MN-004
 *
 * Optional adapter:
 *   getNoChangeRefreshThreshold()
 *   captureDiagnostics()
 *   readLastGateObservation()
 *   log(message, details)
 */
export async function executeChangeGateScenario(adapter, scenario) {
    const resetScenarioSession = requireFn(adapter, 'resetScenarioSession');
    const primeBaseline = requireFn(adapter, 'primeBaseline');
    const submitSceneTurn = requireFn(adapter, 'submitSceneTurn');
    if (!scenario) throw new Error('Unknown Change Gate scenario.');

    await resetScenarioSession({ scenarioId: scenario.id });

    if (scenario.id === 'CG-MJ-001') {
        if (typeof adapter.clearReusableInjection !== 'function') {
            throw new Error('Cold-bootstrap fixture requires clearReusableInjection().');
        }
        await adapter.clearReusableInjection({ scenarioId: scenario.id });
        await submitSceneTurn({ text: scenario.currentText, scenarioId: scenario.id });
    } else if (scenario.id === 'CG-MN-004') {
        await primeBaseline({ text: scenario.baselineText, requireReusableInjection: true, scenarioId: scenario.id });
        if (typeof adapter.reproduceNoResolvableLatestUserText !== 'function') {
            throw new Error('No-resolvable-text hinge requires reproduceNoResolvableLatestUserText().');
        }
        await adapter.reproduceNoResolvableLatestUserText({ scenarioId: scenario.id });
    } else if (scenario.id === 'CG-MN-005') {
        await primeBaseline({ text: scenario.baselineText, requireReusableInjection: true, scenarioId: scenario.id });
        const configured = typeof adapter.getNoChangeRefreshThreshold === 'function'
            ? Number(await adapter.getNoChangeRefreshThreshold())
            : NaN;
        const repeatCount = Number.isFinite(configured) && configured > 0
            ? Math.floor(configured) + 1
            : scenario.repetitions;
        for (let index = 0; index < repeatCount; index += 1) {
            await submitSceneTurn({
                text: scenario.currentText,
                scenarioId: scenario.id,
                repetition: index + 1,
                repetitions: repeatCount,
            });
        }
    } else {
        if (scenario.primeReusableInjection) {
            await primeBaseline({ text: scenario.baselineText, requireReusableInjection: true, scenarioId: scenario.id });
        }
        await submitSceneTurn({ text: scenario.currentText, scenarioId: scenario.id });
    }

    const observation = typeof adapter.readLastGateObservation === 'function'
        ? await adapter.readLastGateObservation({ scenarioId: scenario.id })
        : null;
    adapter.log?.('change-gate-scenario-executed', {
        scenarioId: scenario.id,
        expected: scenario.expected,
        observation,
    });
    return { scenario, observation };
}

export function openChangeGateTestHarness(adapter) {
    requireFn(adapter, 'resetScenarioSession');
    requireFn(adapter, 'primeBaseline');
    requireFn(adapter, 'submitSceneTurn');

    document.getElementById(WINDOW_ID)?.remove();

    const root = document.createElement('section');
    root.id = WINDOW_ID;
    root.className = 'nexus-test-harness-window nexus-change-gate-harness';
    root.innerHTML = `
        <header class="nexus-test-harness-head">
            <div>
                <b>Nexus Change Gate / Scene Hinge Harness</b>
                <span>Fixture ${esc(CHANGE_GATE_HARNESS_VERSION)}</span>
            </div>
            <button type="button" data-action="close">Close</button>
        </header>
        <div class="nexus-test-harness-warning">
            TEST MODE ONLY. Buttons create controlled scene inputs through the normal runtime path. They do not manufacture Nexus gate results.
        </div>
        <div class="nexus-test-harness-toolbar">
            <button type="button" data-action="reset">Reset scenario state</button>
            <button type="button" data-action="diagnostics">Capture diagnostics</button>
            <button type="button" data-action="observation">Read last gate observation</button>
        </div>
        <div class="nexus-change-gate-summary">
            ${CHANGE_GATE_GROUPS.map(group => `
                <button type="button" class="gate-group-jump" data-jump="${esc(group.id)}">
                    <b>${esc(group.label)}</b>
                    <span>${CHANGE_GATE_SCENARIOS.filter(row => row.group === group.id).length} fixtures</span>
                </button>
            `).join('')}
        </div>
        ${CHANGE_GATE_GROUPS.map(group => `
            <details open data-group="${esc(group.id)}">
                <summary><b>${esc(group.label)}</b> — ${esc(group.description)}</summary>
                <div class="nexus-test-harness-command-list">
                    ${CHANGE_GATE_SCENARIOS.filter(row => row.group === group.id).map(row => `
                        <article class="nexus-test-harness-command" data-scenario="${esc(row.id)}">
                            <div class="scenario-title"><b>${esc(row.label)}</b><span>${esc(row.id)}</span></div>
                            <div class="scenario-oracle">Expected: <code>${esc(row.expected.mode || `NOT ${row.expected.notMode}`)}</code></div>
                            ${Array.isArray(row.expected.signals) && row.expected.signals.length
                                ? `<div class="scenario-signals">Signal: ${esc(row.expected.signals.join(', '))}</div>` : ''}
                            <details>
                                <summary>Input / oracle</summary>
                                <p><b>Baseline:</b> ${esc(row.baselineText || '(special fixture)')}</p>
                                <p><b>Command turn:</b> ${esc(row.currentText || '(special no-resolvable-text fixture)')}</p>
                                <pre>${esc(JSON.stringify(row.expected, null, 2))}</pre>
                                ${row.notes ? `<p><b>Notes:</b> ${esc(row.notes)}</p>` : ''}
                            </details>
                            <button type="button" data-run-scenario="${esc(row.id)}">Run hinge</button>
                        </article>
                    `).join('')}
                </div>
            </details>
        `).join('')}
        <div class="nexus-test-harness-status" aria-live="polite">Ready.</div>
    `;

    const status = root.querySelector('.nexus-test-harness-status');
    const setStatus = (text, failed = false) => {
        if (!status) return;
        status.textContent = String(text || '');
        status.dataset.failed = failed ? 'true' : 'false';
    };

    const run = async (label, fn) => {
        setStatus(`${label}...`);
        try {
            const result = await fn();
            const observedMode = result?.observation?.mode || result?.mode || '';
            const observedPlan = result?.observation?.retrievalPlan?.mode || result?.retrievalPlan?.mode || '';
            const observed = [observedMode, observedPlan].filter(Boolean).join(' / ');
            setStatus(`${label}: complete${observed ? ` — observed ${observed}` : ''}`);
            adapter.log?.(label, result);
            return result;
        } catch (error) {
            setStatus(`${label}: FAILED — ${error?.message || error}`, true);
            adapter.log?.(`${label}: failed`, { error: error?.stack || String(error) });
            throw error;
        }
    };

    root.addEventListener('click', event => {
        const button = event.target.closest('button');
        if (!button) return;
        if (button.dataset.action === 'close') {
            root.remove();
            return;
        }
        if (button.dataset.action === 'reset') {
            void run('Reset scenario state', () => adapter.resetScenarioSession({ reason: 'manual' }));
            return;
        }
        if (button.dataset.action === 'diagnostics') {
            if (typeof adapter.captureDiagnostics !== 'function') return setStatus('Diagnostic capture is not wired in this build.', true);
            void run('Capture diagnostics', () => adapter.captureDiagnostics());
            return;
        }
        if (button.dataset.action === 'observation') {
            if (typeof adapter.readLastGateObservation !== 'function') return setStatus('Gate observation reader is not wired in this build.', true);
            void run('Read last gate observation', () => adapter.readLastGateObservation());
            return;
        }
        if (button.dataset.jump) {
            root.querySelector(`[data-group="${CSS.escape(button.dataset.jump)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            return;
        }
        if (button.dataset.runScenario) {
            const scenario = findScenario(button.dataset.runScenario);
            if (!scenario) return setStatus(`Unknown scenario ${button.dataset.runScenario}`, true);
            void run(`${scenario.id} ${scenario.label}`, () => executeChangeGateScenario(adapter, scenario));
        }
    });

    document.body.appendChild(root);
    return root;
}
