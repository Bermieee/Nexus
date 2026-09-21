import { SCENE_COMMANDS, TEST_BOOK, CHARACTER_BANK_TEST_FIXTURE_VERSION } from './fixture-definition.js';

const WINDOW_ID = 'nexus-character-bank-test-harness';

function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}

function requireFn(adapter, name) {
    if (typeof adapter?.[name] !== 'function') throw new Error(`Character Bank test harness adapter is missing ${name}().`);
    return adapter[name].bind(adapter);
}

/**
 * Test-only Character Bank command launcher.
 *
 * This module deliberately has no Call Center dependency. The host integration
 * adapter is responsible for establishing scene state through the normal
 * SillyTavern/Nexus surface used by the build under test.
 *
 * Required adapter functions:
 *   seedFixture({book})
 *   resetFixture({book})
 *   putSceneTurn({id,label,text,expected})
 *
 * Strongly recommended adapter functions:
 *   restoreFixture({book})
 *   triggerGenerationEnd()
 *   openCharacterBanks()
 *   captureDiagnostics()
 *   setBankEnabled(character, enabled)
 *   setBankRole(character, role)
 *   log(message, details)
 */
export function openCharacterBankTestHarness(adapter) {
    requireFn(adapter, 'seedFixture');
    requireFn(adapter, 'resetFixture');
    requireFn(adapter, 'putSceneTurn');

    document.getElementById(WINDOW_ID)?.remove();

    const root = document.createElement('section');
    root.id = WINDOW_ID;
    root.className = 'nexus-test-harness-window';
    root.innerHTML = `
        <header class="nexus-test-harness-head">
            <div>
                <b>Nexus Character Bank Test Harness</b>
                <span>Fixture ${esc(CHARACTER_BANK_TEST_FIXTURE_VERSION)} · ${esc(TEST_BOOK)}</span>
            </div>
            <button type="button" data-action="close">Close</button>
        </header>
        <div class="nexus-test-harness-warning">
            TEST MODE ONLY. Commands establish controlled scene state; they do not fabricate Nexus classifications, warm state, retrieval, injection, or memory outcomes.
        </div>
        <div class="nexus-test-harness-toolbar">
            <button type="button" data-action="seed">Seed / repair test world</button>
            <button type="button" data-action="reset">Reset fixture</button>
            <button type="button" data-action="restore">Restore pre-test state</button>
            <button type="button" data-action="open-banks">Open Character Banks</button>
            <button type="button" data-action="generation-end">Trigger generation-end</button>
            <button type="button" data-action="diagnostics">Capture diagnostics</button>
        </div>
        <details open>
            <summary><b>Scene commands</b></summary>
            <div class="nexus-test-harness-command-list">
                ${SCENE_COMMANDS.map(cmd => `
                    <article class="nexus-test-harness-command" data-command="${esc(cmd.id)}">
                        <div><b>${esc(cmd.label)}</b><span>${esc(cmd.id)}</span></div>
                        <p>${esc(cmd.text)}</p>
                        <small>Expected oracle: ${esc(JSON.stringify(cmd.expected))}</small>
                        <button type="button" data-run-command="${esc(cmd.id)}">Put in scene</button>
                    </article>
                `).join('')}
            </div>
        </details>
        <details>
            <summary><b>Bank controls</b></summary>
            <div class="nexus-test-harness-bank-controls">
                <button type="button" data-bank-enabled="Zareth Vale:true">Enable Zareth</button>
                <button type="button" data-bank-enabled="Zareth Vale:false">Disable Zareth</button>
                <button type="button" data-bank-enabled="Mira Vey:true">Enable Mira</button>
                <button type="button" data-bank-enabled="Mira Vey:false">Disable Mira</button>
                <button type="button" data-bank-role="Zareth Vale:lead">Zareth -> Lead</button>
                <button type="button" data-bank-role="Zareth Vale:supporting">Zareth -> Supporting</button>
                <button type="button" data-bank-role="Zareth Vale:background">Zareth -> Background</button>
                <button type="button" data-bank-role="Mira Vey:lead">Mira -> Lead</button>
                <button type="button" data-bank-role="Mira Vey:supporting">Mira -> Supporting</button>
                <button type="button" data-bank-role="Mira Vey:background">Mira -> Background</button>
            </div>
        </details>
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
            setStatus(`${label}: complete`);
            adapter?.log?.(label, result);
            return result;
        } catch (error) {
            setStatus(`${label}: FAILED — ${error?.message || error}`, true);
            adapter?.log?.(`${label}: failed`, { error: error?.stack || String(error) });
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
        if (button.dataset.action === 'seed') {
            void run('Seed test world', () => adapter.seedFixture({ book: TEST_BOOK }));
            return;
        }
        if (button.dataset.action === 'reset') {
            void run('Reset fixture', () => adapter.resetFixture({ book: TEST_BOOK }));
            return;
        }
        if (button.dataset.action === 'restore') {
            if (typeof adapter.restoreFixture !== 'function') return setStatus('Restore is not wired. Do not run against real Character Banks until teardown is available.', true);
            void run('Restore pre-test state', () => adapter.restoreFixture({ book: TEST_BOOK }));
            return;
        }
        if (button.dataset.action === 'open-banks') {
            if (typeof adapter.openCharacterBanks !== 'function') return setStatus('Open Character Banks is not wired in this build.', true);
            void run('Open Character Banks', () => adapter.openCharacterBanks());
            return;
        }
        if (button.dataset.action === 'generation-end') {
            if (typeof adapter.triggerGenerationEnd !== 'function') return setStatus('Generation-end trigger is not wired in this build.', true);
            void run('Trigger generation-end', () => adapter.triggerGenerationEnd());
            return;
        }
        if (button.dataset.action === 'diagnostics') {
            if (typeof adapter.captureDiagnostics !== 'function') return setStatus('Diagnostic capture is not wired in this build.', true);
            void run('Capture diagnostics', () => adapter.captureDiagnostics());
            return;
        }
        if (button.dataset.runCommand) {
            const command = SCENE_COMMANDS.find(row => row.id === button.dataset.runCommand);
            if (!command) return setStatus(`Unknown command ${button.dataset.runCommand}`, true);
            void run(`Scene: ${command.label}`, () => adapter.putSceneTurn({ ...command }));
            return;
        }
        if (button.dataset.bankEnabled) {
            if (typeof adapter.setBankEnabled !== 'function') return setStatus('Bank enable/disable control is not wired in this build.', true);
            const [character, raw] = button.dataset.bankEnabled.split(':');
            void run(`${raw === 'true' ? 'Enable' : 'Disable'} ${character}`, () => adapter.setBankEnabled(character, raw === 'true'));
            return;
        }
        if (button.dataset.bankRole) {
            if (typeof adapter.setBankRole !== 'function') return setStatus('Bank role control is not wired in this build.', true);
            const [character, role] = button.dataset.bankRole.split(':');
            void run(`${character} -> ${role}`, () => adapter.setBankRole(character, role));
        }
    });

    document.body.appendChild(root);
    return root;
}
