import { classes, el, ensureUiRoot } from '../core/dom.js';
export function diagnosticsPage({ title = 'Diagnostics', toolbar = [], summary = [], content = [], inspector = [], className = '', document } = {}) {
    return ensureUiRoot(el('section', { className: classes('nx-diagnostics-page', className), document }, [
        el('header', { className: 'nx-page-header', document }, [el('h2', { text: title, document }), ...toolbar]),
        summary?.length ? el('section', { className: 'nx-diagnostics-page__summary', document }, summary) : null,
        el('div', { className: 'nx-diagnostics-page__grid', document }, [
            el('main', { className: 'nx-diagnostics-page__content', document }, content),
            inspector?.length ? el('aside', { className: 'nx-diagnostics-page__inspector', document }, inspector) : null,
        ]),
    ]));
}
