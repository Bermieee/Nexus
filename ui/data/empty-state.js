import { el } from '../core/dom.js';
export function emptyState({ title = 'Nothing here yet', message = '', action = null, icon = '•', document } = {}) {
    return el('div', { className: 'nx-empty-state', document }, [
        el('div', { className: 'nx-empty-state__icon', text: icon, document }),
        el('strong', { text: title, document }),
        message ? el('p', { text: message, document }) : null,
        action,
    ]);
}
