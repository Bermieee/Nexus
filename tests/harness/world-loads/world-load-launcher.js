import { WORLD_LOAD_ORDER, WORLD_LOAD_PRESETS } from './world-load-presets.js';

const WINDOW_ID = 'nexus-world-load-test-harness';
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));

export function openWorldLoadTestHarness(adapter) {
    if (typeof adapter?.seedPreset !== 'function') throw new Error('World-load harness requires seedPreset().');
    if (typeof adapter?.runBuilder !== 'function') throw new Error('World-load harness requires runBuilder().');
    if (typeof adapter?.restoreSession !== 'function') throw new Error('World-load harness requires restoreSession().');
    document.getElementById(WINDOW_ID)?.remove();
    const root = document.createElement('section');
    root.id = WINDOW_ID;
    root.className = 'nexus-world-load-harness';
    root.innerHTML = `<header><div><b>Nexus World Load Harness</b><span>Medium → Massive → Hostile → Growth</span></div><button data-action="close">Close</button></header>
      <p class="warning">TEST MODE ONLY. Worlds seed real isolated lorebooks. Builder, Director, Sidecars, Ledger, and foreground responsiveness must use normal Nexus runtime behavior.</p>
      <div class="preset-grid">${WORLD_LOAD_ORDER.map(id => { const p = WORLD_LOAD_PRESETS[id]; return `<article data-preset="${esc(id)}"><b>${esc(p.label)}</b><span>${p.targetEntries} entries · ${esc(p.workload.expectedClass)}</span><p>${esc(p.purpose)}</p><button data-seed="${esc(id)}">Seed world</button><button data-build="${esc(id)}">Run Builder</button></article>`; }).join('')}</div>
      <details open><summary><b>Active session controls</b></summary><div class="controls"><button data-action="foreground-probe">Run foreground responsiveness probe</button><button data-action="mutate">Apply edit/delete/rename batch</button><button data-action="growth-next">Advance Growth phase</button><button data-action="cancel-build">Cancel active Builder work</button><button data-action="diagnostics">Capture diagnostics</button><button data-action="restore">Restore / teardown world</button></div></details>
      <div class="status" aria-live="polite">Ready.</div>`;
    const status = root.querySelector('.status');
    let activePreset = null;
    const set = (t, fail = false) => { status.textContent = String(t); status.dataset.failed = fail ? 'true' : 'false'; };
    const run = async (label, fn) => { set(`${label}...`); try { const r = await fn(); set(`${label}: complete`); adapter.log?.(label, r); return r; } catch (e) { set(`${label}: FAILED — ${e?.message || e}`, true); throw e; } };
    root.addEventListener('click', event => {
      const b = event.target.closest('button'); if (!b) return;
      if (b.dataset.action === 'close') return root.remove();
      if (b.dataset.seed) { activePreset = b.dataset.seed; void run(`Seed ${activePreset}`, () => adapter.seedPreset(activePreset)); return; }
      if (b.dataset.build) { activePreset = b.dataset.build; void run(`Builder ${activePreset}`, () => adapter.runBuilder(activePreset)); return; }
      const needsSession = ['foreground-probe','mutate','growth-next','cancel-build','restore'];
      if (needsSession.includes(b.dataset.action) && !activePreset) return set('Seed or run a preset first.', true);
      if (b.dataset.action === 'foreground-probe') { if (typeof adapter.runForegroundProbe !== 'function') return set('Foreground probe is not wired.', true); void run('Foreground responsiveness probe', () => adapter.runForegroundProbe(activePreset)); return; }
      if (b.dataset.action === 'mutate') { if (typeof adapter.applyMutationBatch !== 'function') return set('Mutation batch is not wired.', true); void run('Mutation batch', () => adapter.applyMutationBatch(activePreset)); return; }
      if (b.dataset.action === 'growth-next') { if (activePreset !== 'growth') return set('Growth phase control requires the Growth preset.', true); if (typeof adapter.advanceGrowthPhase !== 'function') return set('Growth advancement is not wired.', true); void run('Advance Growth phase', () => adapter.advanceGrowthPhase()); return; }
      if (b.dataset.action === 'cancel-build') { if (typeof adapter.cancelBuilder !== 'function') return set('Builder cancellation is not wired.', true); void run('Cancel Builder', () => adapter.cancelBuilder(activePreset)); return; }
      if (b.dataset.action === 'diagnostics') { if (typeof adapter.captureDiagnostics !== 'function') return set('Diagnostics are not wired.', true); void run('Capture diagnostics', () => adapter.captureDiagnostics()); return; }
      if (b.dataset.action === 'restore') void run('Restore test world', async () => { const r = await adapter.restoreSession(activePreset); activePreset = null; return r; });
    });
    document.body.appendChild(root);
    return root;
}
