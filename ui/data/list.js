import { classes, el } from '../core/dom.js';
export function list({ items = [], renderItem = item => String(item), empty = null, className = '', document } = {}) {
    if (!items.length && empty) return empty;
    return el('div', { className: classes('nx-list', className), role: 'list', document }, items.map((item, index) => {
        const content = renderItem(item, index);
        return el('div', { className: 'nx-list__item', role: 'listitem', document }, content);
    }));
}
