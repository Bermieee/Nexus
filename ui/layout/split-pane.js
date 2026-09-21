import { classes, el } from '../core/dom.js';
export function splitPane({ primary = [], secondary = [], ratio = '1fr 1fr', className = '', document } = {}) {
    const root = el('div', { className: classes('nx-split-pane', className), document }, [
        el('div', { className: 'nx-split-pane__primary', document }, primary),
        el('div', { className: 'nx-split-pane__secondary', document }, secondary),
    ]);
    root.style.gridTemplateColumns = ratio;
    return root;
}
