import { semanticSnapshot } from './model.js';
import { compactTreeSummaryFingerprint, treeSummarySourceKey } from './summary-source.js';
import { createMutationProposal, deepCopy } from '../nexus/contracts.js';
import { getNexusLedger } from '../nexus/transaction-service.js';

function normalizeNodeIds(nodeIds = []) {
    return [...new Set((nodeIds || []).map(value => String(value || '').trim()).filter(Boolean))].sort();
}

function normalizeUpdates(updates = []) {
    return (updates || []).map(([nodeId, summary]) => [String(nodeId || ''), String(summary || '').trim()]);
}

export function buildTreeSummaryCommitAssumptions({ book, tree, sourceSnapshot, nodeIds = [] } = {}) {
    const ids = normalizeNodeIds(nodeIds);
    return {
        book: String(book || ''),
        nodeIds: ids,
        treeSemanticFingerprint: compactTreeSummaryFingerprint(semanticSnapshot(tree)),
        loreSourceFingerprint: treeSummarySourceKey(sourceSnapshot, ids),
    };
}

export function stageTreeSummaryCommitTransaction({ book, tree, sourceSnapshot, updates = [], metadata = {}, ledger = getNexusLedger() } = {}) {
    const normalizedUpdates = normalizeUpdates(updates);
    if (!normalizedUpdates.length) throw new Error('Tree summary transaction requires at least one summary update.');
    const nodeIds = normalizeNodeIds(normalizedUpdates.map(([nodeId]) => nodeId));
    if (nodeIds.length !== normalizedUpdates.length) throw new Error('Tree summary transaction contains duplicate or empty node IDs.');
    if (normalizedUpdates.some(([, summary]) => !summary)) throw new Error('Tree summary transaction contains an empty summary.');
    const assumptions = buildTreeSummaryCommitAssumptions({ book, tree, sourceSnapshot, nodeIds });
    const input = { book: String(book || ''), nodeIds, updates: deepCopy(normalizedUpdates) };
    const tx = ledger.begin({
        type: 'tree-summary-update',
        input,
        snapshot: { assumptions: deepCopy(assumptions) },
        assumptions,
        metadata: { source: 'tree-summary', ...deepCopy(metadata || {}) },
    });
    ledger.executing(tx.id);
    ledger.parsed(tx.id, { updates: deepCopy(normalizedUpdates) }, { kind: 'locally-validated-tree-summary-updates' });
    const checked = ledger.validated(tx.id, {
        passed: true,
        checks: { updateCount: normalizedUpdates.length, uniqueNodeIds: nodeIds.length },
    });
    if (checked.state !== 'validated') return checked;
    return ledger.staged(tx.id, { book: String(book || ''), updates: deepCopy(normalizedUpdates) }, {
        mutationProposal: createMutationProposal({
            transactionId: tx.id,
            type: 'tree-summary-update',
            target: { book: String(book || ''), tree: true, nodeIds },
            draft: { updates: deepCopy(normalizedUpdates) },
            assumptions,
            approvalRequired: false,
            metadata: { source: 'tree-summary', ...deepCopy(metadata || {}) },
        }),
    });
}
