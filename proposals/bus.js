import { getContext } from '../../../../st-context.js';
import { loadBook, findEntryByUid, clone } from '../lore/store.js';
import { getTree, treeBaseline } from '../tree/store.js';
import { currentNodeForUid } from '../tree/ops.js';
import { enqueueProposal } from './store.js';
import { OP } from './types.js';
import { assertWritableBook } from '../lore/policy.js';
import { revisionFromMessages } from '../nexus/message-settle-barrier.js';

function origin() {
    const context = getContext();
    const idx = Math.max(0, (context?.chat?.length || 1) - 1);
    return { chatId: context?.chatId || null, messageId: context?.chat?.[idx]?.extra?.tv2_message_id || String(idx), sourceRevision: revisionFromMessages(context?.chat||[],{chatId:context?.chatId??null},{includeAll:true}) };
}
function meta(m = {}) { return { ...m, origin: m.origin || origin(), execution: { kind: 'tv2-universal-mutation', ...(m.execution || {}) } }; }
export function entryBaselineFromEntry(uid, entry) {
    if (!entry) throw new Error(`UID ${uid} baseline entry is unavailable.`);
    return clone({ uid: Number(uid), content: entry.content, comment: entry.comment, key: entry.key || [], constant: entry.constant === true, disable: entry.disable === true });
}
async function entryBaseline(book, uid) {
    const data = await loadBook(book); const entry = findEntryByUid(data.entries, uid);
    if (!entry) throw new Error(`UID ${uid} not found in "${book}".`);
    return entryBaselineFromEntry(uid, entry);
}
function nodeOf(book, uid) { const tree = getTree(book); return currentNodeForUid(tree, uid)?.id || null; }

export async function proposeCreate(book, params, m = {}) {
    assertWritableBook(book);
    const keys = [...new Set((Array.isArray(params.keys) ? params.keys : []).map(String).map(x => x.trim()).filter(Boolean))];
    return await enqueueProposal({ type: OP.ENTRY_CREATE, book, title: params.title, content: params.content, keys, constant: params.constant === true, targetNodeId: params.targetNodeId || null, expectedTree: treeBaseline(book) }, meta(m));
}
export async function proposeUpdate(book, uid, patch, m = {}, options = {}) {
    assertWritableBook(book);
    const proposalMeta=meta(m);
    const safePatch=clone(patch)||{};
    if (safePatch.keys !== undefined) safePatch.keys = [...new Set((Array.isArray(safePatch.keys) ? safePatch.keys : []).map(String).map(x => x.trim()).filter(Boolean))];
    const expected = options?.expectedEntry ? clone(options.expectedEntry) : await entryBaseline(book, uid);
    const hasExpectedNode=Object.prototype.hasOwnProperty.call(options||{},'expectedNodeId');
    const hasExpectedTree=Object.prototype.hasOwnProperty.call(options||{},'expectedTree');
    const expectedNodeId=hasExpectedNode?options.expectedNodeId:nodeOf(book,uid);
    const expectedTree=safePatch.targetNodeId!==undefined?(hasExpectedTree?clone(options.expectedTree):treeBaseline(book)):undefined;
    return await enqueueProposal({ type: OP.ENTRY_UPDATE, book, uid: Number(uid), patch: safePatch, targetNodeId: safePatch.targetNodeId ?? undefined, expected, expectedNodeId, expectedTree }, proposalMeta);
}
export async function proposeDelete(book, uid, { hardDelete = false, reason = '' } = {}, m = {}) {
    assertWritableBook(book);
    const proposalMeta=meta(m);
    return await enqueueProposal({ type: OP.ENTRY_DELETE, book, uid: Number(uid), hardDelete: hardDelete === true, reason, expected: await entryBaseline(book, uid), expectedNodeId: nodeOf(book, uid), expectedTree: treeBaseline(book) }, proposalMeta);
}
export async function proposeMerge(book, keepUid, removeUid, options = {}, m = {}) {
    assertWritableBook(book);
    const proposalMeta=meta(m);
    return await enqueueProposal({ type: OP.ENTRY_MERGE, book, keepUid: Number(keepUid), removeUid: Number(removeUid), title: options.title, content: options.content, hardDelete: options.hardDelete === true, treePolicy: options.treePolicy || 'keep', targetNodeId: options.targetNodeId || null, expectedKeep: await entryBaseline(book, keepUid), expectedRemove: await entryBaseline(book, removeUid), expectedTree: treeBaseline(book) }, proposalMeta);
}
export async function proposeSplit(book, uid, params, m = {}) {
    assertWritableBook(book);
    const proposalMeta=meta(m);
    return await enqueueProposal({ type: OP.ENTRY_SPLIT, book, uid: Number(uid), keepTitle: params.keepTitle, keepContent: params.keepContent, newTitle: params.newTitle, newContent: params.newContent, newTargetNodeId: params.newTargetNodeId || null, expected: await entryBaseline(book, uid), expectedNodeId: nodeOf(book, uid), expectedTree: treeBaseline(book) }, proposalMeta);
}
export async function proposeMoveEntry(book, uid, targetNodeId, m = {}) {
    assertWritableBook(book);
    const proposalMeta=meta(m);
    return await enqueueProposal({ type: OP.ENTRY_MOVE, book, uid: Number(uid), targetNodeId, expected: await entryBaseline(book, uid), expectedNodeId: nodeOf(book, uid), expectedTree: treeBaseline(book) }, proposalMeta);
}
export async function proposeCreateCategory(book, params, m = {}) { assertWritableBook(book); return await enqueueProposal({ type: OP.TREE_NODE_CREATE, book, label: params.label, summary: params.summary || '', parentNodeId: params.parentNodeId || null, expectedTree: treeBaseline(book) }, meta(m)); }
export async function proposeRenameCategory(book, nodeId, patch, m = {}) { assertWritableBook(book); return await enqueueProposal({ type: OP.TREE_NODE_RENAME, book, nodeId, label: patch.label, summary: patch.summary, expectedTree: treeBaseline(book) }, meta(m)); }
export async function proposeMoveCategory(book, nodeId, newParentNodeId, m = {}) { assertWritableBook(book); return await enqueueProposal({ type: OP.TREE_NODE_MOVE, book, nodeId, newParentNodeId, expectedTree: treeBaseline(book) }, meta(m)); }
export async function proposeDeleteCategory(book, nodeId, options = {}, m = {}) { assertWritableBook(book); return await enqueueProposal({ type: OP.TREE_NODE_DELETE, book, nodeId, mode: options.mode || 'promote_children', expectedTree: treeBaseline(book) }, meta(m)); }
export async function proposeTreeReplace(book, tree, m = {}) { assertWritableBook(book); return await enqueueProposal({ type: OP.TREE_REPLACE, book, tree: clone(tree), expectedTree: treeBaseline(book), ...(m.mutationKind?{mutationKind:String(m.mutationKind)}:{}) }, meta(m)); }
export async function proposeTreeDelete(book, m = {}) { assertWritableBook(book); return await enqueueProposal({ type: OP.TREE_DELETE, book, expectedTree: treeBaseline(book) }, meta(m)); }
