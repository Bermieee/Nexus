import { el } from '../core/dom.js';
export function provenanceRow({ source = '', id = '', time = '', note = '', document } = {}) {
    return el('div', { className: 'nx-provenance-row', document }, [
        source ? el('span', { className: 'nx-provenance-row__source nx-text-muted', text: source, document }) : null,
        id ? el('code', { text: id, document }) : null,
        time ? el('time', { text: time, document }) : null,
        note ? el('span', { text: note, document }) : null,
    ]);
}
