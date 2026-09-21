import { el } from '../core/dom.js';
export function progressRow({ label = '', value = 0, max = 100, detail = '', document } = {}) {
    const pct = max > 0 ? Math.max(0, Math.min(100, (Number(value) / Number(max)) * 100)) : 0;
    return el('div', { className: 'nx-progress-row', document }, [
        el('div', { className: 'nx-progress-row__head', document }, [el('strong', { text: label, document }), detail ? el('span', { text: detail, document }) : null]),
        el('div', { className: 'nx-progress-row__track', document, attrs: { role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': max, 'aria-valuenow': value } }, el('span', { className: 'nx-progress-row__bar', document, attrs: { style: `width:${pct}%` } })),
    ]);
}
