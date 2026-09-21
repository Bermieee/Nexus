import { loadBook, saveBook, findEntryByUid, createEntryInBook, deleteEntryFromBook, clone } from '../lore/store.js';
import { assertWritableBook } from '../lore/policy.js';
import { getTree, setTreeDirect, deleteTreeDirect, treeBaseline, setTreeBundleDirect } from '../tree/store.js';
import { createTree, collectUids, validateCanonicalTreeIdentity, findNode } from '../tree/model.js';
import { assignEntry, removeEntryEverywhere, createCategory, renameCategory, moveCategory, deleteCategory, currentNodeForUid } from '../tree/ops.js';
import { OP } from '../proposals/types.js';
import {
    assertNexusMutationAuthority,
    loreMutationResource,
    treeMutationResource,
    metadataMutationResource,
} from './mutation-lock.js';
import { flushSettingsPersistence } from '../core/settings.js';
import { flushChatMetadataPersistence } from './host-durability.js';
import { applyMutationRecoveryPreStateUnsafe } from './mutation-recovery.js';

export const INTERNAL_MUTATION = Object.freeze({ RECOVERY_RESTORE: 'nexus.recovery.restore', TREE_IMPORT_BUNDLE: 'tree.import.bundle' });

const ENTRY_OPS = new Set([OP.ENTRY_CREATE, OP.ENTRY_UPDATE, OP.ENTRY_DELETE, OP.ENTRY_MERGE, OP.ENTRY_SPLIT, OP.ENTRY_MOVE]);
const TREE_OPS = new Set([OP.TREE_NODE_CREATE, OP.TREE_NODE_RENAME, OP.TREE_NODE_MOVE, OP.TREE_NODE_DELETE, OP.TREE_ENTRY_ASSIGN, OP.TREE_ENTRY_UNASSIGN, OP.TREE_REPLACE, OP.TREE_DELETE]);
const ENTRY_TREE_OPS = new Set([OP.ENTRY_CREATE, OP.ENTRY_DELETE, OP.ENTRY_MERGE, OP.ENTRY_SPLIT, OP.ENTRY_MOVE]);

function same(a, b) { return JSON.stringify(a ?? null) === JSON.stringify(b ?? null); }
function stale(message) { const error = new Error(message); error.name = 'TV2MutationStale'; error.tv2PreMutationStale = true; return error; }
function indeterminate(message, details = {}) {
    const error = new Error(message);
    error.name = 'TV2RollbackIndeterminate';
    Object.assign(error, details);
    return error;
}
async function beginPersistence(onPhysicalPersistenceBegin, details = {}) {
    if (typeof onPhysicalPersistenceBegin === 'function') await onPhysicalPersistenceBegin(details);
}

function assertEntryExpected(entry, expected, uid) {
    if (!entry) throw stale(`UID ${uid} no longer exists.`);
    if (!expected) return;
    const current = {
        uid: Number(uid),
        content: entry.content,
        comment: entry.comment,
        key: entry.key || [],
        constant: entry.constant === true,
        disable: entry.disable === true,
    };
    if (!same(current, expected)) throw stale(`UID ${uid} changed while this mutation was pending.`);
}
function assertTreeExpected(book, expected) {
    if (expected !== undefined && !same(treeBaseline(book), expected)) {
        throw stale('Tree changed while this mutation was pending. Refresh and re-stage the operation.');
    }
}
function nodeIdForUid(tree, uid) {
    return currentNodeForUid(tree, Number(uid))?.id || null;
}
function assertPlacementFresh(book, { uid = null, expectedNodeId = undefined, targetNodeId = undefined } = {}) {
    const tree = getTree(book);
    if (expectedNodeId !== undefined && uid != null) {
        const currentNodeId = nodeIdForUid(tree, uid);
        const expected = expectedNodeId == null ? null : String(expectedNodeId);
        if (String(currentNodeId ?? '') !== String(expected ?? '')) {
            throw stale(`UID ${uid} Tree placement changed while this mutation was pending.`);
        }
    }
    if (targetNodeId !== undefined && targetNodeId !== null && targetNodeId !== '__unassigned__') {
        if (!tree?.root || !findNode(tree.root, String(targetNodeId))) {
            throw stale(`Tree destination ${targetNodeId} no longer exists. Refresh and re-stage the operation.`);
        }
    }
}
function explicitBook(op) {
    const book = String(op?.book || '').trim();
    if (!book) throw new Error(`${op?.type || 'Mutation'} requires an explicit lorebook.`);
    return book;
}
function recoveryResources(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') throw new Error('Recovery restore requires a recovery descriptor.');
    if (snapshot.kind === 'metadata-mutation') return [metadataMutationResource(snapshot.chatId)];
    const book = String(snapshot.book || '').trim();
    if (!book) throw new Error('Recovery restore requires an explicit lorebook or chat identity.');
    const type = String(snapshot.opType || '');
    if (snapshot.kind === 'legacy-whole-book') return [loreMutationResource(book), treeMutationResource(book)];
    if (ENTRY_OPS.has(type)) {
        const touchesTree = snapshot.structuralTree === true || snapshot.tracksAssignments === true || ENTRY_TREE_OPS.has(type);
        return touchesTree ? [loreMutationResource(book), treeMutationResource(book)] : [loreMutationResource(book)];
    }
    if (TREE_OPS.has(type)) return [treeMutationResource(book)];
    return [loreMutationResource(book), treeMutationResource(book)];
}

/** Resolve the exact persistent resources a canonical operation can read/write atomically. */
export function resolveNexusMutationResources(op, context = null) {
    if (!op || typeof op !== 'object') throw new Error('Canonical Nexus mutation requires an operation object.');
    const type = String(op.type || '');
    if (type === OP.METADATA_SET) {
        const chatId = String(op.chatId ?? '').trim();
        if (!chatId) throw new Error('metadata.set requires an immutable explicit chatId.');
        return [metadataMutationResource(chatId)];
    }
    if (type === INTERNAL_MUTATION.RECOVERY_RESTORE) return recoveryResources(op.recovery);
    if (type === INTERNAL_MUTATION.TREE_IMPORT_BUNDLE) {
        const plans = Array.isArray(op.plans) ? op.plans : [];
        if (!plans.length) throw new Error('tree.import.bundle requires at least one Tree plan.');
        const seen = new Set();
        const resources = [];
        for (const plan of plans) {
            const book = String(plan?.book || '').trim();
            if (!book) throw new Error('tree.import.bundle requires an explicit lorebook for every plan.');
            if (seen.has(book)) throw new Error(`tree.import.bundle contains duplicate lorebook "${book}".`);
            seen.add(book);
            // Imported Trees are derived from lore UID identity, so the bundle
            // owns both lore and Tree authority for every target book.
            resources.push(loreMutationResource(book), treeMutationResource(book));
        }
        return resources;
    }
    if (ENTRY_OPS.has(type)) {
        const book = explicitBook(op);
        const touchesTree = ENTRY_TREE_OPS.has(type) || (type === OP.ENTRY_UPDATE && op.targetNodeId !== undefined);
        return touchesTree ? [loreMutationResource(book), treeMutationResource(book)] : [loreMutationResource(book)];
    }
    if (TREE_OPS.has(type)) {
        const book = explicitBook(op);
        return op.loreDependency === true ? [loreMutationResource(book), treeMutationResource(book)] : [treeMutationResource(book)];
    }
    throw new Error(`Canonical mutation engine does not implement ${type || '(missing type)'}.`);
}

async function persistTreeDurably(book, tree, tracker = null, onPhysicalPersistenceBegin = null, onSubwriteCheckpoint = null, { mutationKind = 'semantic', invalidateRetrieval = true, invalidateSearch = true } = {}) {
    await beginPersistence(onPhysicalPersistenceBegin, { resource: treeMutationResource(book), operation: 'tree.write' });
    const written = setTreeDirect(book, tree, { mutationKind, invalidateRetrieval, invalidateSearch });
    if (tracker) { tracker.treeWritten = true; tracker.knownTreePost = clone(written); }
    await flushSettingsPersistence(`Tree "${book}"`, { expected: [{ path: ['trees', String(book)], exists: true, value: written }] });
    const current = getTree(book);
    if (typeof onSubwriteCheckpoint === 'function') await onSubwriteCheckpoint({ domain: 'tree', book: String(book), operation: 'tree.write', postTree: clone(current) });
    return current;
}
async function deleteTreeDurably(book, tracker = null, onPhysicalPersistenceBegin = null, onSubwriteCheckpoint = null) {
    await beginPersistence(onPhysicalPersistenceBegin, { resource: treeMutationResource(book), operation: 'tree.delete' });
    deleteTreeDirect(book);
    if (tracker) { tracker.treeWritten = true; tracker.knownTreePost = null; }
    await flushSettingsPersistence(`Tree "${book}"`, { expected: [{ path: ['trees', String(book)], exists: false, value: null }] });
    if (typeof onSubwriteCheckpoint === 'function') await onSubwriteCheckpoint({ domain: 'tree', book: String(book), operation: 'tree.delete', postTree: null });
}
function entryAuthority(entry) {
    if (!entry) return null;
    return { uid: Number(entry.uid), content: entry.content, comment: entry.comment, key: entry.key || [], constant: entry.constant === true, disable: entry.disable === true };
}
function entryKeyByUid(entries, uid) {
    const n = Number(uid);
    return Object.keys(entries || {}).find(key => Number(entries?.[key]?.uid) === n) ?? null;
}
function rebaseTouchedLoreRows(latest, candidate, base, touchedUids = []) {
    const touched = new Set((touchedUids || []).map(Number).filter(Number.isFinite));
    const next = clone(candidate);
    next.entries = clone(latest?.entries || {});
    for (const uid of touched) {
        const baseEntry = findEntryByUid(base?.entries, uid);
        const latestEntry = findEntryByUid(latest?.entries, uid);
        if (!same(entryAuthority(latestEntry), entryAuthority(baseEntry))) {
            throw stale(`UID ${uid} changed in the host while this lore mutation was preparing to persist.`);
        }
        const latestKey = entryKeyByUid(next.entries, uid);
        if (latestKey != null) delete next.entries[latestKey];
        const candidateEntry = findEntryByUid(candidate?.entries, uid);
        if (candidateEntry) {
            const candidateKey = entryKeyByUid(candidate?.entries, uid) ?? String(uid);
            next.entries[candidateKey] = clone(candidateEntry);
        }
    }
    return next;
}
async function saveBookTracked(book, data, tracker, onPhysicalPersistenceBegin = null, onSubwriteCheckpoint = null, { baseBook = null, touchedUids = [] } = {}) {
    const latest = clone(await loadBook(book));
    const next = baseBook ? rebaseTouchedLoreRows(latest, data, baseBook, touchedUids) : clone(data);
    await beginPersistence(onPhysicalPersistenceBegin, { resource: loreMutationResource(book), operation: 'lore.write' });
    await saveBook(book, next);
    tracker.bookWritten = true;
    tracker.bookTouchedUids = [...new Set([...(tracker.bookTouchedUids || []), ...touchedUids.map(Number).filter(Number.isFinite)])];
    tracker.knownBookPost = clone(await loadBook(book));
    if (typeof onSubwriteCheckpoint === 'function') await onSubwriteCheckpoint({ domain: 'lore', book: String(book), operation: 'lore.write', touchedUids: [...touchedUids], postBook: clone(tracker.knownBookPost) });
    return tracker.knownBookPost;
}

async function restoreTouchedLoreRows(book, originalBook, knownPost, touchedUids = []) {
    const latest = clone(await loadBook(book));
    const next = clone(latest);
    next.entries = clone(latest?.entries || {});
    for (const uid of [...new Set((touchedUids || []).map(Number).filter(Number.isFinite))]) {
        const currentEntry = findEntryByUid(latest?.entries, uid);
        const postEntry = findEntryByUid(knownPost?.entries, uid);
        if (!same(entryAuthority(currentEntry), entryAuthority(postEntry))) {
            const error = new Error(`UID ${uid} diverged after Nexus wrote it; rollback will not erase the newer lore edit.`);
            error.name = 'TV2RollbackIndeterminate';
            throw error;
        }
        const currentKey = entryKeyByUid(next.entries, uid);
        if (currentKey != null) delete next.entries[currentKey];
        const beforeEntry = findEntryByUid(originalBook?.entries, uid);
        if (beforeEntry) {
            const beforeKey = entryKeyByUid(originalBook?.entries, uid) ?? String(uid);
            next.entries[beforeKey] = clone(beforeEntry);
        }
    }
    await saveBook(book, next);
    return clone(await loadBook(book));
}

async function rollbackWrittenResources(book, originalBook, originalTree, tracker) {
    const conflicts = [];
    const failures = [];

    if (tracker.bookWritten) {
        try {
            await restoreTouchedLoreRows(book, originalBook, tracker.knownBookPost, tracker.bookTouchedUids || []);
        } catch (error) {
            if (error?.name === 'TV2RollbackIndeterminate') conflicts.push('lorebook-diverged-after-nexus-write');
            else failures.push({ resource: 'lorebook', error });
        }
    }

    if (tracker.treeWritten) {
        try {
            const currentTree = clone(getTree(book));
            if (!same(currentTree, originalTree)) {
                if (!same(currentTree, tracker.knownTreePost)) conflicts.push('tree-diverged-after-nexus-write');
                else if (originalTree == null) await deleteTreeDurably(book);
                else await persistTreeDurably(book, clone(originalTree));
            }
        } catch (error) { failures.push({ resource: 'tree', error }); }
    }

    if (conflicts.length || failures.length) {
        throw indeterminate(`Rollback for "${book}" refused or failed because canonical state no longer matched Nexus's last-known write.`, {
            rollbackConflicts: conflicts,
            rollbackFailures: failures,
        });
    }
    return true;
}

async function executeLoreTreeOp(op, { onPhysicalPersistenceBegin = null, onSubwriteCheckpoint = null } = {}) {
    const book = explicitBook(op);
    const originalBook = clone(await loadBook(book));
    const originalTree = clone(getTree(book));
    const tracker = { bookWritten: false, treeWritten: false, bookTouchedUids: [], knownBookPost: null, knownTreePost: null };

    try {
        let data = clone(originalBook);
        let tree = originalTree ? clone(originalTree) : null;
        const requireTree = () => { if (!tree) tree = createTree(book); return tree; };
        let result = '';
        let createdUid = null;

        switch (op.type) {
            case OP.ENTRY_CREATE: {
                // HOTFIX34: an entry create owns the new UID plus its requested
                // placement, not the entire pre-existing Tree.  Unrelated Tree
                // edits must not invalidate every pending create proposal.
                assertPlacementFresh(book, { targetNodeId: op.targetNodeId });
                const created = await createEntryInBook(book, data, { title: op.title, content: op.content, keys: op.keys || [], constant: op.constant === true, beforeSave: async () => await beginPersistence(onPhysicalPersistenceBegin, { resource: loreMutationResource(book), operation: 'lore.create' }) });
                data = clone(created.data);
                tracker.bookWritten = true;
                tracker.knownBookPost = clone(data);
                createdUid = Number(created.entry.uid);
                tracker.bookTouchedUids = [createdUid];
                if (typeof onSubwriteCheckpoint === 'function') await onSubwriteCheckpoint({ domain: 'lore', book: String(book), operation: 'lore.create', touchedUids: [createdUid], createdUid, postBook: clone(data) });
                tree = getTree(book) || requireTree();
                assignEntry(tree, createdUid, op.targetNodeId || null);
                await persistTreeDurably(book, tree, tracker, onPhysicalPersistenceBegin, onSubwriteCheckpoint);
                result = `Created UID ${createdUid} "${created.entry.comment}" in ${currentNodeForUid(tree, createdUid)?.label || 'Root'}`;
                break;
            }
            case OP.ENTRY_UPDATE: {
                if (op.targetNodeId !== undefined) assertPlacementFresh(book, { uid: op.uid, expectedNodeId: op.expectedNodeId, targetNodeId: op.targetNodeId });
                const entry = findEntryByUid(data.entries, op.uid);
                assertEntryExpected(entry, op.expected, op.uid);
                const patch = op.patch || {};
                if (patch.content !== undefined) {
                    if (!String(patch.content).trim()) throw new Error('Updated content cannot be empty.');
                    entry.content = String(patch.content).trim();
                }
                if (patch.title !== undefined || patch.comment !== undefined) {
                    const title = patch.title ?? patch.comment;
                    if (!String(title).trim()) throw new Error('Updated title cannot be empty.');
                    entry.comment = String(title).trim();
                }
                if (patch.keys !== undefined) entry.key = [...new Set((Array.isArray(patch.keys) ? patch.keys : []).map(String).map(x => x.trim()).filter(Boolean))];
                if (patch.constant !== undefined) entry.constant = patch.constant === true;
                if (patch.disable !== undefined) entry.disable = patch.disable === true;
                data = await saveBookTracked(book, data, tracker, onPhysicalPersistenceBegin, onSubwriteCheckpoint, { baseBook: originalBook, touchedUids: [op.uid] });
                if (op.targetNodeId !== undefined) {
                    const writableTree = requireTree();
                    if (op.targetNodeId === '__unassigned__') removeEntryEverywhere(writableTree.root, op.uid);
                    else assignEntry(writableTree, op.uid, op.targetNodeId || null);
                    await persistTreeDurably(book, writableTree, tracker, onPhysicalPersistenceBegin, onSubwriteCheckpoint);
                }
                result = `Updated UID ${op.uid}${op.targetNodeId !== undefined ? ' and its Tree placement' : ''}`;
                break;
            }
            case OP.ENTRY_DELETE: {
                const entry = findEntryByUid(data.entries, op.uid);
                assertEntryExpected(entry, op.expected, op.uid);
                await deleteEntryFromBook(book, data, op.uid, op.hardDelete === true);
                data = await saveBookTracked(book, data, tracker, onPhysicalPersistenceBegin, onSubwriteCheckpoint, { baseBook: originalBook, touchedUids: [op.uid] });
                if (tree) {
                    removeEntryEverywhere(tree.root, op.uid);
                    await persistTreeDurably(book, tree, tracker, onPhysicalPersistenceBegin, onSubwriteCheckpoint);
                }
                result = `${op.hardDelete ? 'Deleted' : 'Disabled'} UID ${op.uid} and removed it from the Tree`;
                break;
            }
            case OP.ENTRY_MOVE: {
                const entry = findEntryByUid(data.entries, op.uid);
                assertEntryExpected(entry, op.expected, op.uid);
                assertPlacementFresh(book, { uid: op.uid, expectedNodeId: op.expectedNodeId, targetNodeId: op.targetNodeId });
                const moved = assignEntry(requireTree(), op.uid, op.targetNodeId);
                await persistTreeDurably(book, tree, tracker, onPhysicalPersistenceBegin, onSubwriteCheckpoint);
                result = `Moved UID ${op.uid} to ${moved.nodeLabel}`;
                break;
            }
            case OP.ENTRY_MERGE: {
                const keep = findEntryByUid(data.entries, op.keepUid);
                const remove = findEntryByUid(data.entries, op.removeUid);
                assertEntryExpected(keep, op.expectedKeep, op.keepUid);
                assertEntryExpected(remove, op.expectedRemove, op.removeUid);
                if (Number(op.keepUid) === Number(op.removeUid)) throw new Error('Cannot merge an entry into itself.');
                // Merge placement semantics depend only on the two participating
                // entries (and an explicit target, when supplied), not unrelated
                // Tree branches. Derive their staged placements from expectedTree
                // so older proposal descriptors remain compatible.
                assertPlacementFresh(book, { uid: op.keepUid, expectedNodeId: nodeIdForUid(op.expectedTree, op.keepUid), targetNodeId: op.targetNodeId || undefined });
                assertPlacementFresh(book, { uid: op.removeUid, expectedNodeId: nodeIdForUid(op.expectedTree, op.removeUid) });
                keep.content = String(op.content || `${keep.content || ''}\n\n---\n\n${remove.content || ''}`).trim();
                if (op.title !== undefined && String(op.title).trim()) keep.comment = String(op.title).trim();
                await deleteEntryFromBook(book, data, op.removeUid, op.hardDelete === true);
                data = await saveBookTracked(book, data, tracker, onPhysicalPersistenceBegin, onSubwriteCheckpoint, { baseBook: originalBook, touchedUids: [op.keepUid, op.removeUid] });
                const keepNode = tree ? currentNodeForUid(tree, op.keepUid)?.id || null : null;
                const removeNode = tree ? currentNodeForUid(tree, op.removeUid)?.id || null : null;
                if (tree) {
                    removeEntryEverywhere(tree.root, op.removeUid);
                    if (op.targetNodeId) assignEntry(tree, op.keepUid, op.targetNodeId);
                    else if (op.treePolicy === 'removed' && removeNode) assignEntry(tree, op.keepUid, removeNode);
                    else if (!keepNode && removeNode) assignEntry(tree, op.keepUid, removeNode);
                    await persistTreeDurably(book, tree, tracker, onPhysicalPersistenceBegin, onSubwriteCheckpoint);
                }
                result = `Merged UID ${op.removeUid} into UID ${op.keepUid}; Tree assignment preserved`;
                break;
            }
            case OP.ENTRY_SPLIT: {
                const original = findEntryByUid(data.entries, op.uid);
                assertEntryExpected(original, op.expected, op.uid);
                assertPlacementFresh(book, { uid: op.uid, expectedNodeId: op.expectedNodeId, targetNodeId: op.newTargetNodeId || op.expectedNodeId || undefined });
                if (!String(op.keepContent || '').trim() || !String(op.newContent || '').trim() || !String(op.newTitle || '').trim()) {
                    throw new Error('Split requires non-empty keep/new content and a new title.');
                }
                original.content = String(op.keepContent).trim();
                if (op.keepTitle !== undefined && String(op.keepTitle).trim()) original.comment = String(op.keepTitle).trim();
                data = await saveBookTracked(book, data, tracker, onPhysicalPersistenceBegin, onSubwriteCheckpoint, { baseBook: originalBook, touchedUids: [op.uid] });
                const created = await createEntryInBook(book, clone(data), { title: op.newTitle, content: op.newContent, beforeSave: async () => await beginPersistence(onPhysicalPersistenceBegin, { resource: loreMutationResource(book), operation: 'lore.create' }) });
                data = clone(created.data);
                tracker.bookWritten = true;
                tracker.knownBookPost = clone(data);
                createdUid = Number(created.entry.uid);
                tracker.bookTouchedUids = [...new Set([...(tracker.bookTouchedUids || []), createdUid])];
                if (typeof onSubwriteCheckpoint === 'function') await onSubwriteCheckpoint({ domain: 'lore', book: String(book), operation: 'lore.create', touchedUids: [op.uid, createdUid], createdUid, postBook: clone(data) });
                const inherited = op.newTargetNodeId || op.expectedNodeId || null;
                tree = getTree(book) || tree;
                if (tree || inherited) {
                    const writableTree = tree || requireTree();
                    assignEntry(writableTree, createdUid, inherited);
                    await persistTreeDurably(book, writableTree, tracker, onPhysicalPersistenceBegin, onSubwriteCheckpoint);
                }
                result = `Split UID ${op.uid}; created UID ${createdUid}${tree ? ` in ${currentNodeForUid(tree, createdUid)?.label || 'Root'}` : ''}`;
                break;
            }
            default: throw new Error(`Not a lore+tree mutation: ${op.type}`);
        }

        return { message: result, book, createdUid };
    } catch (error) {
        try {
            await rollbackWrittenResources(book, originalBook, originalTree, tracker);
            error.tv2RollbackRestored = true;
        } catch (rollbackError) {
            const wrapped = indeterminate(`${error?.message || error}; ${rollbackError?.message || rollbackError}`, {
                cause: error,
                rollbackError,
            });
            throw wrapped;
        }
        throw error;
    }
}

async function assertTreeLoreUidsExist(book, tree) {
    validateCanonicalTreeIdentity(tree, { label: `Tree for ${book}` });
    const data = await loadBook(book);
    const valid = new Set(Object.values(data?.entries || {}).map(entry => Number(entry?.uid)).filter(Number.isFinite));
    const missing = collectUids(tree?.root).map(Number).filter(uid => Number.isFinite(uid) && !valid.has(uid));
    if (missing.length) {
        const error = new Error(`Tree for "${book}" references unknown lore UID(s): ${[...new Set(missing)].slice(0, 20).join(', ')}.`);
        error.name = 'TV2TreeUnknownLoreUid';
        throw error;
    }
    return data;
}

async function assertLoreUidExists(book, uid) {
    const data = await loadBook(book);
    if (!findEntryByUid(data.entries, Number(uid))) {
        const error = new Error(`UID ${uid} does not exist in lorebook "${book}".`);
        error.name = 'TV2TreeUnknownLoreUid';
        throw error;
    }
    return data;
}

async function executeTreeOp(op, { onPhysicalPersistenceBegin = null, onSubwriteCheckpoint = null } = {}) {
    const book = explicitBook(op);
    assertTreeExpected(book, op.expectedTree);
    const originalTree = clone(getTree(book));
    const tracker = { treeWritten: false, knownTreePost: null };
    let tree = originalTree ? clone(originalTree) : createTree(book);
    let message = '';
    try {
        switch (op.type) {
            case OP.TREE_NODE_CREATE: { const node = createCategory(tree, { label: op.label, summary: op.summary, parentNodeId: op.parentNodeId }); await persistTreeDurably(book, tree, tracker, onPhysicalPersistenceBegin, onSubwriteCheckpoint); message = `Created category "${node.label}"`; break; }
            case OP.TREE_NODE_RENAME: { const node = renameCategory(tree, op.nodeId, { label: op.label, summary: op.summary }); await persistTreeDurably(book, tree, tracker, onPhysicalPersistenceBegin, onSubwriteCheckpoint); message = `Updated category "${node.label}"`; break; }
            case OP.TREE_NODE_MOVE: { const node = moveCategory(tree, op.nodeId, op.newParentNodeId); await persistTreeDurably(book, tree, tracker, onPhysicalPersistenceBegin, onSubwriteCheckpoint); message = `Moved category "${node.label}"`; break; }
            case OP.TREE_NODE_DELETE: { const out = deleteCategory(tree, op.nodeId, { mode: op.mode }); await persistTreeDurably(book, tree, tracker, onPhysicalPersistenceBegin, onSubwriteCheckpoint); message = `Deleted category ${op.nodeId} (${out.mode}; ${out.affectedUids.length} affected UID(s))`; break; }
            case OP.TREE_ENTRY_ASSIGN: { await assertLoreUidExists(book, op.uid); const out = assignEntry(tree, op.uid, op.nodeId); await persistTreeDurably(book, tree, tracker, onPhysicalPersistenceBegin, onSubwriteCheckpoint); message = `Assigned UID ${op.uid} to ${out.nodeLabel}`; break; }
            case OP.TREE_ENTRY_UNASSIGN: { removeEntryEverywhere(tree.root, op.uid); await persistTreeDurably(book, tree, tracker, onPhysicalPersistenceBegin, onSubwriteCheckpoint); message = `Unassigned UID ${op.uid} from the Tree`; break; }
            case OP.TREE_REPLACE: { await assertTreeLoreUidsExist(book, op.tree); const kind = String(op.mutationKind || 'semantic'); const presentationOnly = kind === 'presentation-only', summaryOnly = kind === 'summary-only'; await persistTreeDurably(book, op.tree, tracker, onPhysicalPersistenceBegin, onSubwriteCheckpoint, { mutationKind: presentationOnly ? 'presentation-only' : summaryOnly ? 'summary-only' : 'semantic', invalidateRetrieval: !(presentationOnly || summaryOnly), invalidateSearch: !presentationOnly }); message = `Replaced Tree for "${book}"`; break; }
            case OP.TREE_DELETE: { await deleteTreeDurably(book, tracker, onPhysicalPersistenceBegin, onSubwriteCheckpoint); message = `Deleted Tree for "${book}"`; break; }
            default: throw new Error(`Not a Tree mutation: ${op.type}`);
        }
        return { message, book, tree: getTree(book) };
    } catch (error) {
        if (!tracker.treeWritten) { error.tv2RollbackRestored = true; throw error; }
        try {
            const current = clone(getTree(book));
            if (!same(current, originalTree)) {
                if (!same(current, tracker.knownTreePost)) throw indeterminate(`Tree rollback for "${book}" refused because the Tree diverged after Nexus wrote it.`);
                if (originalTree == null) await deleteTreeDurably(book);
                else await persistTreeDurably(book, originalTree);
            }
            error.tv2RollbackRestored = true;
        } catch (rollbackError) {
            throw indeterminate(`${error?.message || error}; ${rollbackError?.message || rollbackError}`, { cause: error, rollbackError });
        }
        throw error;
    }
}


async function executeTreeImportBundle(op, { onPhysicalPersistenceBegin = null, onSubwriteCheckpoint = null } = {}) {
    const plans = Array.isArray(op?.plans) ? op.plans : [];
    if (!plans.length) throw new Error('tree.import.bundle requires at least one Tree plan.');
    const seen = new Set();
    for (const plan of plans) {
        const book = String(plan?.book || '').trim();
        if (!book) throw new Error('tree.import.bundle requires an explicit lorebook for every plan.');
        if (seen.has(book)) throw new Error(`tree.import.bundle contains duplicate lorebook "${book}".`);
        seen.add(book);
        assertTreeExpected(book, plan.expectedTree);
        await assertTreeLoreUidsExist(book, plan.tree);
    }

    const beforeRows = plans.map(plan => ({ book: String(plan.book), tree: clone(getTree(String(plan.book))) }));
    let written = null;
    await beginPersistence(onPhysicalPersistenceBegin, { operation: 'tree.import.bundle.write', books: plans.map(plan => String(plan.book)) });
    try {
        written = setTreeBundleDirect(plans.map(plan => ({ book: String(plan.book), tree: clone(plan.tree) })), { mutationKind: 'semantic' });
        await flushSettingsPersistence('Nexus Tree import bundle', {
            expected: written.map(row => ({ path: ['trees', row.book], exists: row.tree != null, value: row.tree })),
        });
        if (typeof onSubwriteCheckpoint === 'function') for (const row of written) await onSubwriteCheckpoint({ domain: 'tree', book: String(row.book), operation: 'tree.import.bundle.write', postTree: clone(row.tree) });
        return { message: `Imported ${written.length} Nexus Tree${written.length === 1 ? '' : 's'} atomically`, books: written.map(row => row.book), trees: written.map(row => ({ book: row.book, tree: clone(row.tree) })) };
    } catch (error) {
        try {
            const currentKnown = new Map((written || []).map(row => [row.book, row.tree]));
            for (const before of beforeRows) {
                const current = clone(getTree(before.book));
                const knownPost = currentKnown.get(before.book);
                if (knownPost !== undefined && !same(current, knownPost) && !same(current, before.tree)) {
                    throw indeterminate(`Tree import bundle rollback refused because "${before.book}" diverged after Nexus wrote the bundle.`, { book: before.book });
                }
            }
            const restored = setTreeBundleDirect(beforeRows, { mutationKind: 'semantic' });
            await flushSettingsPersistence('Nexus Tree import bundle rollback', {
                expected: restored.map(row => ({ path: ['trees', row.book], exists: row.tree != null, value: row.tree })),
            });
            error.tv2RollbackRestored = true;
        } catch (rollbackError) {
            throw indeterminate(`${error?.message || error}; ${rollbackError?.message || rollbackError}`, { cause: error, rollbackError });
        }
        throw error;
    }
}

async function executeMetadataOp(op, context, { onPhysicalPersistenceBegin = null, onSubwriteCheckpoint = null } = {}) {
    if (!context?.chatMetadata) throw new Error('No captured chat metadata context was supplied to metadata.set.');
    const chatId = String(op.chatId ?? '').trim();
    if (!chatId) throw new Error('metadata.set requires an immutable explicit chatId.');
    if (String(context.chatId ?? '') !== chatId) throw stale('Chat changed while metadata mutation was pending.');
    if (op.expected !== undefined && !same(context.chatMetadata[op.key], op.expected)) throw stale(`Metadata "${op.key}" changed while pending.`);

    const existed = Object.prototype.hasOwnProperty.call(context.chatMetadata, op.key);
    const before = existed ? clone(context.chatMetadata[op.key]) : null;
    const desiredExists = op.delete !== true;
    const desired = desiredExists ? clone(op.value) : null;
    await beginPersistence(onPhysicalPersistenceBegin, { resource: metadataMutationResource(chatId), operation: 'metadata.write', key: op.key });
    if (desiredExists) context.chatMetadata[op.key] = desired;
    else delete context.chatMetadata[op.key];

    try {
        await flushChatMetadataPersistence(context, `Nexus metadata "${op.key}"`, { expected: { [op.key]: { exists: desiredExists, value: desired } } });
    } catch (error) {
        const currentExists = Object.prototype.hasOwnProperty.call(context.chatMetadata, op.key);
        const current = currentExists ? context.chatMetadata[op.key] : null;
        if (currentExists !== desiredExists || !same(current, desired)) {
            throw indeterminate(`${error?.message || error}; metadata rollback refused because the value diverged after Nexus wrote it.`, { cause: error });
        }
        try {
            if (existed) context.chatMetadata[op.key] = clone(before);
            else delete context.chatMetadata[op.key];
            await flushChatMetadataPersistence(context, `Nexus metadata rollback "${op.key}"`, { expected: { [op.key]: { exists: existed, value: before } } });
            error.tv2RollbackRestored = true;
        } catch (rollbackError) {
            throw indeterminate(`${error?.message || error}; ${rollbackError?.message || rollbackError}`, { cause: error, rollbackError });
        }
        throw error;
    }
    if (typeof onSubwriteCheckpoint === 'function') await onSubwriteCheckpoint({ domain: 'metadata', chatId, key: op.key, operation: 'metadata.write', postView: { exists: desiredExists, value: desired } });
    return { message: `${op.delete === true ? 'Cleared' : 'Updated'} metadata "${op.key}"`, chatId, key: op.key };
}

async function executeRecoveryRestore(op, context, authority, { onPhysicalPersistenceBegin = null } = {}) {
    return await applyMutationRecoveryPreStateUnsafe(op.recovery, { context, authority, onPhysicalPersistenceBegin });
}

/**
 * Physical executor only. It never acquires locks and cannot run without an
 * active coordinator-issued authority covering every required resource.
 */
export async function executeCanonicalMutation(op, { context = null, authority = null, onPhysicalPersistenceBegin = null, onSubwriteCheckpoint = null, assertCommitStillValid = null } = {}) {
    const resources = resolveNexusMutationResources(op, context);
    assertNexusMutationAuthority(authority, resources);
    const type = String(op.type || '');
    const book = (ENTRY_OPS.has(type) || TREE_OPS.has(type)) ? explicitBook(op) : null;
    const beforePersistence = async details => {
        if (typeof assertCommitStillValid === 'function') assertCommitStillValid(details);
        if (book) assertWritableBook(book);
        for (const targetBook of Array.isArray(details?.books) ? details.books : (details?.book ? [details.book] : [])) assertWritableBook(targetBook);
        await beginPersistence(onPhysicalPersistenceBegin, details);
    };
    if (type === OP.METADATA_SET) return executeMetadataOp(op, context, { onPhysicalPersistenceBegin: beforePersistence, onSubwriteCheckpoint });
    if (type === INTERNAL_MUTATION.RECOVERY_RESTORE) return executeRecoveryRestore(op, context, authority, { onPhysicalPersistenceBegin: beforePersistence });
    if (type === INTERNAL_MUTATION.TREE_IMPORT_BUNDLE) {
        for (const plan of Array.isArray(op.plans) ? op.plans : []) assertWritableBook(String(plan?.book || ''));
        return executeTreeImportBundle(op, { onPhysicalPersistenceBegin: beforePersistence, onSubwriteCheckpoint });
    }
    if (book) assertWritableBook(book);
    if (ENTRY_OPS.has(type)) return executeLoreTreeOp(op, { onPhysicalPersistenceBegin: beforePersistence, onSubwriteCheckpoint });
    if (TREE_OPS.has(type)) return executeTreeOp(op, { onPhysicalPersistenceBegin: beforePersistence, onSubwriteCheckpoint });
    throw new Error(`Canonical mutation engine does not implement ${type}.`);
}

export function isCanonicalMutationType(type) {
    return ENTRY_OPS.has(type) || TREE_OPS.has(type) || String(type || '') === OP.METADATA_SET || String(type || '') === INTERNAL_MUTATION.RECOVERY_RESTORE || String(type || '') === INTERNAL_MUTATION.TREE_IMPORT_BUNDLE;
}
