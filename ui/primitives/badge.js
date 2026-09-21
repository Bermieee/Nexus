import { classes, el } from '../core/dom.js';

/**
 * Shared Nexus pill/badge primitive.
 * Use for short semantic state flags (for example CLEAN, PENDING, CARD ELIGIBLE). Ordinary counts, roles, tokens, IDs and readouts should remain plain text.
 */
export function badge({ label, tone = 'neutral', variant = 'soft', size = 'sm', title = '', className = '', document } = {}) {
    return el('span', {
        className: classes('nx-badge', `nx-badge--${tone}`, `nx-badge--${variant}`, `nx-badge--${size}`, className),
        text: label ?? '', title, document,
    });
}
export function statusDot({ state = 'idle', label = '', document } = {}) {
    return el('span', {
        className: `nx-status-dot nx-status-dot--${state}`,
        title: label,
        document,
        attrs: { 'aria-label': label || state },
    });
}
