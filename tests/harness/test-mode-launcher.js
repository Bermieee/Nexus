import { openCharacterBankTestHarness } from './character-banks/character-bank-launcher.js';
import { openChangeGateTestHarness } from './change-gate/change-gate-launcher.js';
import { openWorldLoadTestHarness } from './world-loads/world-load-launcher.js';
const HARNESS_STYLE_URLS = Object.freeze({
    launcher: new URL('./test-mode-launcher.css', import.meta.url).href,
    characterBanks: new URL('./character-banks/character-bank-launcher.css', import.meta.url).href,
    changeGate: new URL('./change-gate/change-gate-launcher.css', import.meta.url).href,
    worldLoads: new URL('./world-loads/world-load-launcher.css', import.meta.url).href,
});

function ensureHarnessStyle(name) {
    const href = HARNESS_STYLE_URLS[name];
    if (!href || typeof document === 'undefined') return null;
    const key = `nexus-test-harness-style-${name}`;
    let link = document.querySelector(`link[data-nexus-test-harness-style="${key}"]`);
    if (link) return link;
    link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    link.dataset.nexusTestHarnessStyle = key;
    document.head.appendChild(link);
    return link;
}


const WINDOW_ID = 'nexus-test-mode-launcher';

/**
 * Top-level Test Mode menu.
 *
 * adapter.characterBanks is passed only to the Character Bank harness.
 * adapter.changeGate is passed only to the Change Gate harness.
 * adapter.worldLoads is passed only to the World Load / Builder harness.
 * No Call Center dependency is introduced here.
 */
export function openNexusTestModeLauncher(adapter = {}) {
    ensureHarnessStyle('launcher');
    document.getElementById(WINDOW_ID)?.remove();

    const root = document.createElement('section');
    root.id = WINDOW_ID;
    root.className = 'nexus-test-mode-launcher';
    root.innerHTML = `
        <header>
            <div>
                <b>Nexus Test Mode</b>
                <span>Controlled functional test launchers</span>
            </div>
            <button type="button" data-action="close">Close</button>
        </header>
        <p>Test launchers establish controlled inputs. Nexus must still produce the real runtime outcome.</p>
        <div class="nexus-test-mode-suite-grid">
            <button type="button" data-suite="character-banks">
                <b>Character Banks</b>
                <span>Zareth + Mira, isolated Lore Tree, scene-aware bank behavior</span>
            </button>
            <button type="button" data-suite="change-gate">
                <b>Change Gate / Scene Hinges</b>
                <span>NO CHANGE, MINOR, MAJOR and every hard-transition hinge</span>
            </button>
            <button type="button" data-suite="world-loads">
                <b>World Loads / Builder</b>
                <span>384 → 3,072 entries, hostile data, growth and multi-wave Builder stress</span>
            </button>
        </div>
        <div class="nexus-test-mode-status" aria-live="polite">Ready.</div>
    `;

    const status = root.querySelector('.nexus-test-mode-status');
    const setStatus = text => { if (status) status.textContent = String(text || ''); };

    root.addEventListener('click', event => {
        const button = event.target.closest('button');
        if (!button) return;
        if (button.dataset.action === 'close') {
            root.remove();
            return;
        }
        if (button.dataset.suite === 'character-banks') {
            if (!adapter.characterBanks) return setStatus('Character Bank adapter is not wired in this build.');
            ensureHarnessStyle('characterBanks');
            openCharacterBankTestHarness(adapter.characterBanks);
            setStatus('Character Bank harness opened.');
            return;
        }
        if (button.dataset.suite === 'change-gate') {
            if (!adapter.changeGate) return setStatus('Change Gate adapter is not wired in this build.');
            ensureHarnessStyle('changeGate');
            openChangeGateTestHarness(adapter.changeGate);
            setStatus('Change Gate / Scene Hinge harness opened.');
            return;
        }
        if (button.dataset.suite === 'world-loads') {
            if (!adapter.worldLoads) return setStatus('World Load / Builder adapter is not wired in this build.');
            ensureHarnessStyle('worldLoads');
            openWorldLoadTestHarness(adapter.worldLoads);
            setStatus('World Load / Builder harness opened.');
        }
    });

    document.body.appendChild(root);
    return root;
}
