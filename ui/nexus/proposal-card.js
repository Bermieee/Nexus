import { classes, el } from '../core/dom.js';
import { badge } from '../primitives/badge.js';
import { button } from '../primitives/button.js';
const TONES = { new: 'success', update: 'info', redundant: 'neutral', conflict: 'warning', error: 'danger' };
export function proposalCard({ classification = 'update', title = '', detail = '', source = '', current = '', proposed = '', onApprove, onReject, onInspect, disabled = false, document } = {}) {
    const kind = String(classification || 'update').toLowerCase();
    return el('article', { className: classes('nx-proposal-card', `nx-proposal-card--${kind}`), document }, [
        el('header', { className: 'nx-proposal-card__header', document }, [badge({ label: kind.toUpperCase(), tone: TONES[kind] || 'neutral', document }), el('strong', { text: title, document })]),
        detail ? el('p', { className: 'nx-proposal-card__detail', text: detail, document }) : null,
        source ? el('small', { className: 'nx-proposal-card__source', text: source, document }) : null,
        (current || proposed) ? el('div', { className: 'nx-proposal-card__compare', document }, [
            current ? el('div', { document }, [el('span', { text: 'Current', document }), el('p', { text: current, document })]) : null,
            proposed ? el('div', { document }, [el('span', { text: 'Proposed', document }), el('p', { text: proposed, document })]) : null,
        ]) : null,
        el('footer', { className: 'nx-proposal-card__actions', document }, [
            onInspect ? button({ label: 'Inspect', variant: 'ghost', size: 'sm', onClick: onInspect, disabled, document }) : null,
            onApprove ? button({ label: 'Approve', variant: 'success', size: 'sm', onClick: onApprove, disabled, document }) : null,
            onReject ? button({ label: 'Reject', variant: 'danger', size: 'sm', onClick: onReject, disabled, document }) : null,
        ]),
    ]);
}
