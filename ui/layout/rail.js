import { classes, el } from '../core/dom.js';
export function rail({ title = '', subtitle = '', actions = [], body = [], footer = [], side = 'left', className = '', document } = {}) {
    return el('aside', { className: classes('nx-rail', `nx-rail--${side}`, className), document }, [
        (title || subtitle || actions?.length) ? el('header', { className: 'nx-rail__header', document }, [
            el('div', { className: 'nx-rail__copy', document }, [
                title ? el('h3', { text: title, document }) : null,
                subtitle ? el('p', { text: subtitle, document }) : null,
            ]),
            actions?.length ? el('div', { className: 'nx-rail__actions', document }, actions) : null,
        ]) : null,
        el('div', { className: 'nx-rail__body', document }, body),
        footer?.length ? el('footer', { className: 'nx-rail__footer', document }, footer) : null,
    ]);
}
