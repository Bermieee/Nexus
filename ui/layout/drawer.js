import { classes, el } from '../core/dom.js';
export function drawer({ title = '', body = [], side = 'right', open = false, className = '', document } = {}) {
    return el('aside', {
        className: classes('nx-drawer', `nx-drawer--${side}`, open && 'is-open', className), document,
        attrs: { 'aria-hidden': open ? 'false' : 'true' },
    }, [el('header', { className: 'nx-drawer__header', document }, el('h3', { text: title, document })), el('div', { className: 'nx-drawer__body', document }, body)]);
}
