import { classes, el, append } from '../core/dom.js';
import { uiId } from '../core/a11y.js';

export function tabs({ items = [], active = '', onChange, className = '', document } = {}) {
    const root = el('div', { className: classes('nx-tabs', className), document });
    const list = el('div', { className: 'nx-tabs__list', role: 'tablist', document });
    const panels = el('div', { className: 'nx-tabs__panels', document });
    const state = { active: active || items[0]?.id || '' };
    const buttons = new Map();
    const panelMap = new Map();

    function activate(id, emit = true, focus = false) {
        if (!panelMap.has(id)) return;
        state.active = id;
        for (const [key, btn] of buttons) {
            const selected = key === id;
            btn.setAttribute('aria-selected', selected ? 'true' : 'false');
            btn.tabIndex = selected ? 0 : -1;
            btn.classList.toggle('is-active', selected);
            panelMap.get(key).hidden = !selected;
            if (selected && focus) btn.focus?.();
        }
        if (emit) onChange?.(id);
    }

    for (const item of items) {
        const tabId = uiId('nx-tab');
        const panelId = uiId('nx-tabpanel');
        const btn = el('button', {
            id: tabId, type: 'button', role: 'tab', className: 'nx-tabs__tab',
            document, attrs: { 'aria-controls': panelId }, on: {
                click: () => activate(item.id),
                keydown: event => {
                    const ids = items.map(entry => entry.id);
                    const index = ids.indexOf(item.id);
                    let next = null;
                    if (event.key === 'ArrowRight') next = ids[(index + 1) % ids.length];
                    if (event.key === 'ArrowLeft') next = ids[(index - 1 + ids.length) % ids.length];
                    if (event.key === 'Home') next = ids[0];
                    if (event.key === 'End') next = ids[ids.length - 1];
                    if (next !== null) { event.preventDefault?.(); activate(next, true, true); }
                },
            },
        }, [
            el('span', { className: 'nx-tabs__label', text: item.label ?? item.id, document }),
            ...(item.end || []),
        ]);
        const pane = el('section', { id: panelId, role: 'tabpanel', className: 'nx-tabs__panel', document, attrs: { 'aria-labelledby': tabId } }, item.content ?? []);
        buttons.set(item.id, btn); panelMap.set(item.id, pane); append(list, btn); append(panels, pane);
    }
    append(root, list, panels);
    activate(state.active, false);
    root.activate = activate;
    root.activeTab = () => state.active;
    return root;
}
