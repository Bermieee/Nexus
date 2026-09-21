import { el } from '../core/dom.js';
import { badge, statusDot } from '../primitives/badge.js';
export function workloadStatus({ name = '', state = 'queued', executor = '', detail = '', count = null, document } = {}) {
    const tone = ({ completed: 'success', failed: 'danger', running: 'info', executing: 'info', stale: 'warning', cancelled: 'neutral' })[state] || 'neutral';
    return el('div', { className: 'nx-workload-status', document }, [
        statusDot({ state, label: state, document }),
        el('div', { className: 'nx-workload-status__copy', document }, [el('strong', { text: name, document }), detail ? el('small', { text: detail, document }) : null]),
        executor ? el('span', { className: 'nx-workload-status__executor', text: executor, document }) : null,
        count !== null ? el('span', { className: 'nx-workload-status__count nx-text-muted', text: String(count), document }) : null,
        badge({ label: String(state).toUpperCase(), tone, document }),
    ]);
}
