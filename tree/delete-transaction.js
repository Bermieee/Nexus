import { getTree, treeBaseline } from './store.js';
import { OP } from '../proposals/types.js';
import { assertWritableBook } from '../lore/policy.js';
import {
    getNexusLedger,
    approveNexusTransaction,
} from '../nexus/transaction-service.js';
import { commitCanonicalNexusMutation } from '../nexus/mutation-coordinator.js';

export function buildTreeDeleteAssumptions(book) {
    const normalizedBook = String(book || '');
    const tree = getTree(normalizedBook);
    return {
        book: normalizedBook,
        tree: treeBaseline(normalizedBook),
        treeInstanceRevision: Number(tree?.lastBuilt) || 0,
    };
}

export function stageTreeDeleteTransaction(book, { surface = 'tree-workspace', metadata = {} } = {}) {
    const normalizedBook = String(book || '').trim();
    if (!normalizedBook) throw new Error('A lorebook is required to trash its Tree.');
    assertWritableBook(normalizedBook);
    const tree = getTree(normalizedBook);
    if (!tree?.root) throw new Error(`No Nexus Tree exists for "${normalizedBook}".`);

    const ledger = getNexusLedger();
    const assumptions = buildTreeDeleteAssumptions(normalizedBook);
    let tx = ledger.begin({
        type: 'tree-delete',
        input: { book: normalizedBook },
        snapshot: { tree },
        assumptions,
        metadata: { surface, ...metadata },
    });
    ledger.executing(tx.id);
    ledger.parsed(tx.id, { book: normalizedBook, action: 'delete-tree' }, { local: true });
    ledger.validated(tx.id, { passed: true, reason: 'Operator-requested Tree deletion targets a currently existing Tree.' });
    tx = ledger.staged(tx.id, { book: normalizedBook, expectedTree: assumptions.tree }, {
        mutationProposal: {
            transactionId: tx.id,
            type: 'tree-delete',
            target: { book: normalizedBook },
            draft: { deleteTree: true },
            assumptions,
            approvalRequired: true,
            metadata: { surface, ...metadata },
            state: 'staged',
        },
    });
    return tx;
}

export async function approveAndCommitTreeDelete(transactionId, { by = 'operator', surface = 'tree-workspace' } = {}) {
    const ledger = getNexusLedger();
    const approved = approveNexusTransaction(transactionId, { by, metadata: { surface } });
    if (approved.state !== 'staged') throw new Error(`Tree delete transaction is not staged; current state is ${approved.state}.`);
    const book = String(approved.input?.book || approved.staged?.book || '').trim();
    if (!book) throw new Error('Tree delete transaction lost its lorebook identity.');

    const mutation = { type: OP.TREE_DELETE, book, expectedTree: approved.staged?.expectedTree };
    return commitCanonicalNexusMutation(transactionId, mutation, {
        preflight: () => { assertWritableBook(book); },
        currentAssumptions: () => buildTreeDeleteAssumptions(book),
        targetLedger: ledger,
        metadata: { surface, operation: 'tree.delete' },
        committed: result => ({ book, deleted: true, result }),
    });
}

export async function trashTreeWithConfirmation(book, { surface = 'tree-workspace', confirmFn = globalThis.confirm } = {}) {
    const normalizedBook = String(book || '').trim();
    if (!normalizedBook || !getTree(normalizedBook)?.root) return { ok: false, reason: 'no-tree' };
    const confirmed = typeof confirmFn === 'function'
        ? confirmFn(`Trash the Nexus Tree for "${normalizedBook}"?\n\nThis removes only Nexus's Tree structure and summaries. It does NOT delete or disable the SillyTavern lorebook entries. You can rebuild the Tree afterward.`)
        : false;
    if (!confirmed) return { ok: false, reason: 'cancelled' };

    const staged = stageTreeDeleteTransaction(normalizedBook, { surface });
    const committed = await approveAndCommitTreeDelete(staged.id, { surface });
    if (committed.state === 'stale') return { ok: false, stale: true, transactionId: staged.id };
    return { ok: committed.state === 'committed', transactionId: staged.id, transaction: committed };
}
