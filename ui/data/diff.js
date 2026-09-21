import { el } from '../core/dom.js';
export function diffView({ before = '', after = '', beforeLabel = 'Current', afterLabel = 'Proposed', document } = {}) {
    return el('div', { className: 'nx-diff', document }, [
        el('section', { className: 'nx-diff__side nx-diff__side--before', document }, [el('strong', { text: beforeLabel, document }), el('pre', { text: before, document })]),
        el('section', { className: 'nx-diff__side nx-diff__side--after', document }, [el('strong', { text: afterLabel, document }), el('pre', { text: after, document })]),
    ]);
}
