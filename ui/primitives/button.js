import { classes, el, append, icon } from '../core/dom.js';

export function button({ label, variant = 'secondary', size = 'md', fill = false, iconClass = '', disabled = false, title = '', onClick, className = '', document } = {}) {
    const node = el('button', {
        className: classes('nx-button', `nx-button--${variant}`, `nx-button--${size}`, fill && 'nx-button--fill', className),
        type: 'button', disabled, title, document,
        on: { click: onClick },
    });
    if (iconClass) append(node, icon(iconClass, { document }));
    append(node, el('span', { text: label ?? '', document }));
    return node;
}
