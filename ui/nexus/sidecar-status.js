import { el } from '../core/dom.js';
import { statusDot, badge } from '../primitives/badge.js';
export function sidecarStatus({ name = 'Sidecar', state = 'idle', model = '', workload = '', document } = {}) {
    return el('div', { className: 'nx-sidecar-status', document }, [
        statusDot({ state, label: `${name}: ${state}`, document }),
        el('div', { className: 'nx-sidecar-status__copy', document }, [el('strong', { text: name, document }), model ? el('small', { text: model, document }) : null]),
        workload ? el('span', { className: 'nx-sidecar-status__workload nx-text-muted', text: workload, document }) : null,
        badge({ label: state.toUpperCase(), tone: state === 'failed' ? 'danger' : state === 'active' ? 'success' : 'neutral', document }),
    ]);
}
