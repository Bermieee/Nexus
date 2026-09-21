import { el } from '../core/dom.js';

/** UID/reference identity is metadata, not semantic state; render it as compact monospace text rather than a status pill. */
export function uidChip({ book = '', uid = '', label = '', document } = {}) {
    const text = label || [book, uid !== '' ? `UID ${uid}` : ''].filter(Boolean).join(' · ');
    return el('span', {
        className: 'nx-uid-chip nx-text-muted',
        text,
        title: book && uid !== '' ? `${book} / UID ${uid}` : text,
        document,
    });
}
