import { classes, el, ensureUiRoot } from '../core/dom.js';
export function workspace({ header = [], left = [], center = [], right = [], footer = [], className = '', document } = {}) {
    const root = ensureUiRoot(el('section', { className: classes('nx-workspace', className), document }, [
        header?.length ? el('header', { className: 'nx-workspace__header', document }, header) : null,
        el('div', { className: 'nx-workspace__grid', document }, [
            left?.length ? el('aside', { className: 'nx-workspace__left', document }, left) : null,
            el('main', { className: 'nx-workspace__center', document }, center),
            right?.length ? el('aside', { className: 'nx-workspace__right', document }, right) : null,
        ]),
        footer?.length ? el('footer', { className: 'nx-workspace__footer', document }, footer) : null,
    ]));
    if (!left?.length) root.classList.add('nx-workspace--no-left');
    if (!right?.length) root.classList.add('nx-workspace--no-right');
    return root;
}
