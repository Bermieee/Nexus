import { el } from '../core/dom.js';
export function evidenceBlock({ source = '', title = '', excerpt = '', refs = [], document } = {}) {
    return el('section', { className: 'nx-evidence', document }, [
        el('header', { className: 'nx-evidence__header', document }, [title ? el('strong', { text: title, document }) : null, source ? el('span', { className: 'nx-evidence__source nx-text-muted', text: source, document }) : null]),
        excerpt ? el('blockquote', { text: excerpt, document }) : null,
        refs?.length ? el('div', { className: 'nx-evidence__refs', document }, refs.map(ref => el('code', { className: 'nx-evidence__ref', text: ref, document }))) : null,
    ]);
}
