import { el } from '../core/dom.js';
export function table({ columns = [], rows = [], caption = '', document } = {}) {
    const head = el('thead', { document }, el('tr', { document }, columns.map(col => el('th', { text: col.label ?? col.key, document, attrs: { scope: 'col' } }))));
    const body = el('tbody', { document }, rows.map(row => el('tr', { document }, columns.map(col => el('td', { document }, col.render ? col.render(row[col.key], row) : String(row[col.key] ?? ''))))));
    return el('div', { className: 'nx-table-wrap', document }, el('table', { className: 'nx-table', document }, [caption ? el('caption', { text: caption, document }) : null, head, body]));
}
