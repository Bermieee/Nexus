import { classes, el, append } from '../core/dom.js';
export function panel({ title = '', subtitle = '', actions = [], body = [], footer = [], tone = 'default', density = 'normal', className = '', document } = {}) {
    const node = el('section', { className: classes('nx-panel', `nx-panel--${tone}`, `nx-panel--${density}`, className), document });
    if (title || subtitle || actions.length) {
        const head = el('header', { className: 'nx-panel__header', document });
        const copy = el('div', { className: 'nx-panel__copy', document });
        append(copy,
            title ? el('h3', { className: 'nx-panel__title', text: title, document }) : null,
            subtitle ? el('p', { className: 'nx-panel__subtitle', text: subtitle, document }) : null,
        );
        append(head, copy, el('div', { className: 'nx-panel__actions', document }, actions));
        append(node, head);
    }
    append(node, el('div', { className: 'nx-panel__body', document }, body));
    if (footer?.length) append(node, el('footer', { className: 'nx-panel__footer', document }, footer));
    return node;
}
