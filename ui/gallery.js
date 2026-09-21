import { el, ensureUiRoot } from './core/dom.js';
import { button } from './primitives/button.js';
import { badge } from './primitives/badge.js';
import { input } from './primitives/input.js';
import { select } from './primitives/select.js';
import { toggle, checkbox } from './primitives/toggle.js';
import { panel } from './layout/panel.js';
import { collapsible } from './layout/collapsible.js';
import { tabs } from './layout/tabs.js';
import { toolbar } from './layout/toolbar.js';
import { emptyState } from './data/empty-state.js';
import { notice } from './data/notice.js';
import { itemRow } from './data/item-row.js';
import { progressRow } from './data/progress.js';
import { diffView } from './data/diff.js';
import { proposalCard } from './nexus/proposal-card.js';
import { workloadStatus } from './nexus/workload-status.js';
import { sidecarStatus } from './nexus/sidecar-status.js';
import { evidenceBlock } from './nexus/evidence-block.js';
import { provenanceRow } from './nexus/provenance-row.js';
import { uidChip } from './nexus/uid-chip.js';
import { workspace } from './shell/workspace.js';

export function renderUiGallery({ document = globalThis.document } = {}) {
    const controls = panel({ title: 'Primitives', subtitle: 'Shared controls and state language.', document, body: [
        toolbar({ document, start: [button({ label: 'Primary', variant: 'primary', document }), button({ label: 'Secondary', document }), button({ label: 'Danger', variant: 'danger', document })], end: [badge({ label: 'READY', tone: 'success', document }), badge({ label: 'CONFLICT', tone: 'warning', document })] }),
        el('div', { className: 'nx-gallery-grid', document }, [input({ label: 'Search', placeholder: 'Type something…', document }), select({ label: 'Mode', options: ['Simple', 'Technical'], document }), toggle({ label: 'Enabled', checked: true, document }), checkbox({ label: 'Persistent option', checked: true, document })]),
    ] });

    const components = tabs({ document, items: [
        { id: 'proposal', label: 'Proposal', content: proposalCard({ classification: 'conflict', title: 'Equipment change', detail: 'Evidence disagrees with current state.', source: 'Summary · SC-12', current: 'Sword', proposed: 'Staff', onApprove() {}, onReject() {}, onInspect() {}, document }) },
        { id: 'diff', label: 'Diff', content: diffView({ before: 'Current text', after: 'Proposed text', document }) },
        { id: 'empty', label: 'Empty', content: emptyState({ title: 'Nothing pending', message: 'This is a successful empty state.', document }) },
        { id: 'rows', label: 'Rows', end: [el('span', { className: 'nx-text-muted', text: 'Shared', document })], content: el('div', { className: 'nx-stack', document }, [notice({ title: 'Shared notice', message: 'Warnings, errors, and information use one component contract.', tone: 'info', document }), itemRow({ title: 'Shared data row', meta: 'Primary copy owns the flexible width.', leading: [badge({ label: 'PENDING', tone: 'warning', document }), uidChip({ book: 'Example Book', uid: 31, document })], trailing: [button({ label: 'Action', size: 'sm', document })], document })]) },
    ] });

    const status = panel({ title: 'Execution & evidence', document, body: [
        workloadStatus({ name: 'Summary promotion', state: 'running', executor: 'Sidecar A', detail: 'slice 2/4', document }),
        sidecarStatus({ name: 'Sidecar A', state: 'active', model: 'provider/model', workload: 'Summary', document }),
        progressRow({ label: 'Batch progress', value: 7, max: 10, detail: '7 / 10', document }),
        evidenceBlock({ source: 'Summary', title: 'Evidence', excerpt: 'A durable fact supported by source evidence.', refs: ['SC-12', 'UID 31'], document }),
        provenanceRow({ source: 'Lore', id: 'UID 31', time: 'Now', note: 'Exact source', document }),
        uidChip({ book: 'Example Book', uid: 31, document }),
    ] });

    const center = [controls, collapsible({ title: 'Structural widgets', subtitle: 'Collapsible behavior belongs to UI Core.', open: true, document, body: [components] }), status];
    return ensureUiRoot(workspace({ document, header: [el('div', { document }, [el('h2', { text: 'Nexus UI Core Gallery', document }), el('p', { text: 'Development-only isolated component surface. No subsystem semantics.', document })])], center }));
}
