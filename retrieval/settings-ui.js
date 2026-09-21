import {
    collapsible as nxCollapsible,
    el as nxEl,
    ensureUiRoot,
    input as nxInput,
    toggle as nxToggle,
} from '../ui/index.js';

function controlId(wrapper, id, attrs = {}) {
    const control = wrapper?.controlElement;
    if (!control) return wrapper;
    control.id = id;
    for (const [key, value] of Object.entries(attrs)) {
        if (value === undefined || value === null) continue;
        if (key === 'inputMode') control.inputMode = value;
        else control.setAttribute(key, String(value));
    }
    return wrapper;
}

function numberField(id, label, { min, max, step, help = '' } = {}) {
    return controlId(nxInput({ label, type: 'number', help }), id, { min, max, step, inputMode: 'numeric' });
}

function toggleField(id, label) {
    return controlId(nxToggle({ label }), id);
}

function formGrid(children, className = '') {
    return nxEl('div', { className: `nx-form-grid ${className}`.trim() }, children);
}

function settingsColumns(toggles = [], fields = []) {
    return nxEl('div', { className: 'nx-settings-columns' }, [
        nxEl('div', { className: 'nx-settings-toggle-column' }, toggles),
        nxEl('div', { className: 'nx-settings-field-column' }, [formGrid(fields)]),
    ]);
}

function scenePolicyPanel() {
    return nxCollapsible({
        title: 'Scene classification & retrieval',
        open: false,
        body: [settingsColumns(
            [toggleField('tv2_change_gate_enabled', 'Change Gate enabled')],
            [
                numberField('tv2_retrieval_messages', 'Retrieval chat messages', { min: 1 }),
                numberField('tv2_nochange_refresh', 'Refresh after NO_CHANGE turns', { min: 0 }),
                numberField('tv2_region_preview_depth', 'Regional preview depth', { min: 0, max: 4 }),
                numberField('tv2_injection_budget', 'Optional lore publication budget', {
                    min: 0,
                    help: '0 = no explicit token budget; Nexus still publishes whole entries through Generation Frame budgeting.',
                }),
            ],
        )],
        className: 'nx-retrieval-settings-panel',
    });
}

function bootstrapPanel() {
    return nxCollapsible({
        title: 'Pre-Tree prompt admission',
        open: false,
        body: [settingsColumns(
            [toggleField('tv2_bootstrap_admission_enabled', 'Reduce native World Info before the Tree exists')],
            [
                numberField('tv2_bootstrap_admission_tokens', 'Bootstrap target tokens', {
                    min: 500, max: 16000, step: 250,
                    help: 'Soft whole-entry target for temporary pre-Tree context.',
                }),
                numberField('tv2_bootstrap_admission_entries', 'Bootstrap max entries', { min: 1, max: 100 }),
            ],
        )],
        className: 'nx-retrieval-settings-panel',
    });
}

function batchPanel() {
    return nxCollapsible({
        title: 'Batch Fire Retrieval',
        open: false,
        body: [settingsColumns(
            [
                toggleField('tv2_batch_fire_enabled', 'Batch-fire large regional / node scans'),
                toggleField('tv2_batch_condense', 'Condense broad gathered batch results'),
                toggleField('tv2_batch_reroute_failure', 'Reroute timeout / context-pressure calls through Batch Fire'),
                toggleField('tv2_batch_lore_injection', 'Batch-fire oversized Lore Injection reviews'),
                toggleField('tv2_batch_allow_partial', 'Continue with successful slices after bounded worker recovery'),
            ],
            [
                numberField('tv2_batch_activation_tokens', 'Batch activation input tokens', {
                    min: 1200, step: 250,
                    help: 'Below this estimate Nexus uses one compatible model worker; above it the request may be physically split.',
                }),
                numberField('tv2_batch_target_tokens', 'Target input tokens per batch', { min: 1200, step: 250 }),
                numberField('tv2_batch_condense_min', 'Condense when gathered refs ≥', { min: 2, step: 1 }),
            ],
        )],
        className: 'nx-retrieval-settings-panel',
    });
}

function smartContextPanel() {
    return nxCollapsible({
        title: 'Smart Context',
        open: false,
        body: [settingsColumns(
            [
                toggleField('tv2_smart_context_enabled', 'Smart Context warmer enabled'),
                toggleField('tv2_smart_context_rerank', 'Allow model-worker semantic reranking'),
                toggleField('tv2_smart_context_decay', 'Decay repeatedly unpinned warm cards'),
            ],
            [
                numberField('tv2_smart_context_messages', 'Smart Context messages', { min: 1 }),
                numberField('tv2_smart_context_pool', 'Optional hard warm count', {
                    min: 0,
                    help: '0 = no hard count; Smart Context prunes adaptively by relevance.',
                }),
                numberField('tv2_smart_context_cache_age', 'Warm cache max age ms', { min: 1000 }),
                numberField('tv2_smart_context_decay_misses', 'Misses before decay', { min: 1, max: 20 }),
            ],
        )],
        className: 'nx-retrieval-settings-panel',
    });
}

export function mountRetrievalSettingsUI(root = document) {
    const mount = root?.getElementById?.('tv2_retrieval_settings_mount');
    if (!mount) return null;
    if (mount.dataset.nexusMounted === 'true') return mount.firstElementChild || null;

    const surface = nxCollapsible({
        title: 'Global Retrieval Policy',
        open: false,
        body: [scenePolicyPanel(), bootstrapPanel(), batchPanel(), smartContextPanel()],
        className: 'nx-retrieval-settings nx-settings-category',
        document: root,
    });
    const uiRoot = ensureUiRoot(nxEl('div', { className: 'nx-retrieval-settings-root', document: root }, [surface]));
    mount.replaceChildren(uiRoot);
    mount.dataset.nexusMounted = 'true';
    return surface;
}
