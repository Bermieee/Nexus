import { classes, el } from '../core/dom.js';

export function notice({ title = '', message = '', tone = 'neutral', actions = [], icon = '', className = '', document } = {}) {
    return el('div', { className: classes('nx-notice', `nx-notice--${tone}`, className), role: tone === 'danger' ? 'alert' : 'status', document }, [
        icon ? el('span', { className: 'nx-notice__icon', text: icon, document, attrs: { 'aria-hidden': 'true' } }) : null,
        el('div', { className: 'nx-notice__copy', document }, [
            title ? el('strong', { text: title, document }) : null,
            message ? el('span', { text: message, document }) : null,
        ]),
        actions?.length ? el('div', { className: 'nx-notice__actions', document }, actions) : null,
    ]);
}
