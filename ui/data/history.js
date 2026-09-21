import { el } from '../core/dom.js';
import { badge } from '../primitives/badge.js';
export function historyRow({ time = '', type = '', title = '', detail = '', status = '', tone = 'neutral', document } = {}) {
    return el('div', { className: 'nx-history-row', document }, [
        el('time', { className: 'nx-history-row__time', text: time, document }),
        type ? el('span', { className: 'nx-history-row__type nx-text-muted', text: type, document }) : null,
        el('div', { className: 'nx-history-row__copy', document }, [el('strong', { text: title, document }), detail ? el('small', { text: detail, document }) : null]),
        status ? badge({ label: status, tone, document }) : null,
    ]);
}
