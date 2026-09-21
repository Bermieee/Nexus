import { classes, el } from '../core/dom.js';
export function toolbar({ start = [], end = [], className = '', document } = {}) {
    return el('div', { className: classes('nx-toolbar', className), document }, [
        el('div', { className: 'nx-toolbar__start', document }, start),
        el('div', { className: 'nx-toolbar__end', document }, end),
    ]);
}
