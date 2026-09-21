import { createNode, findNode, findParent, findNodeContainingUid, collectUids } from './model.js';

export function removeEntryEverywhere(root, uid) {
    const id = Number(uid);
    let changed = false;
    const walk = node => {
        const before = node.entryUids.length;
        node.entryUids = node.entryUids.filter(v => Number(v) !== id);
        if (before !== node.entryUids.length) changed = true;
        for (const child of node.children || []) walk(child);
    };
    walk(root);
    return changed;
}

export function assignEntry(tree, uid, nodeId = null) {
    if (!tree?.root) throw new Error('Tree has no root.');
    const target = nodeId ? findNode(tree.root, nodeId) : tree.root;
    if (!target) throw new Error(`Tree node ${nodeId} not found.`);
    removeEntryEverywhere(tree.root, uid);
    target.entryUids.push(Number(uid));
    return { uid: Number(uid), nodeId: target.id, nodeLabel: target.label };
}

export function createCategory(tree, { label, summary = '', parentNodeId = null }) {
    if (!String(label || '').trim()) throw new Error('Category label is required.');
    const parent = parentNodeId ? findNode(tree.root, parentNodeId) : tree.root;
    if (!parent) throw new Error(`Parent node ${parentNodeId} not found.`);
    const node = createNode(String(label).trim(), String(summary || '').trim());
    parent.children.push(node);
    return node;
}

export function renameCategory(tree, nodeId, { label, summary } = {}) {
    const node = findNode(tree.root, nodeId);
    if (!node || node === tree.root) throw new Error('Category not found or Root cannot be renamed by this operation.');
    if (label !== undefined) {
        if (!String(label).trim()) throw new Error('Category label cannot be empty.');
        node.label = String(label).trim();
    }
    if (summary !== undefined) node.summary = String(summary || '').trim();
    return node;
}

export function moveCategory(tree, nodeId, newParentNodeId) {
    if (nodeId === tree.root.id) throw new Error('Root cannot be moved.');
    const node = findNode(tree.root, nodeId);
    const oldParent = findParent(tree.root, nodeId);
    const newParent = findNode(tree.root, newParentNodeId);
    if (!node || !oldParent || !newParent) throw new Error('Move category references an unknown node.');
    if (findNode(node, newParentNodeId)) throw new Error('A category cannot be moved into its own descendant.');
    oldParent.children = oldParent.children.filter(child => child.id !== nodeId);
    newParent.children.push(node);
    return node;
}

export function deleteCategory(tree, nodeId, { mode = 'promote_children' } = {}) {
    if (nodeId === tree.root.id) throw new Error('Root cannot be deleted.');
    const node = findNode(tree.root, nodeId);
    const parent = findParent(tree.root, nodeId);
    if (!node || !parent) throw new Error(`Category ${nodeId} not found.`);
    const affectedUids = collectUids(node);
    const idx = parent.children.findIndex(child => child.id === nodeId);
    if (mode === 'promote_children') {
        // Direct entries move to parent; child categories are lifted intact.
        for (const uid of node.entryUids || []) if (!parent.entryUids.includes(uid)) parent.entryUids.push(uid);
        parent.children.splice(idx, 1, ...(node.children || []));
    } else if (mode === 'move_entries_to_parent') {
        for (const uid of affectedUids) if (!parent.entryUids.includes(uid)) parent.entryUids.push(uid);
        parent.children.splice(idx, 1);
    } else if (mode === 'delete_subtree') {
        parent.children.splice(idx, 1);
    } else {
        throw new Error(`Unknown category delete mode: ${mode}`);
    }
    return { nodeId, affectedUids, mode };
}

export function currentNodeForUid(tree, uid) {
    return findNodeContainingUid(tree?.root, Number(uid));
}

function normalizeMoveNodeIds(tree, nodeIds = []) {
    if (!tree?.root) throw new Error('Tree has no root.');
    const requested = [...new Set((nodeIds || []).map(value => String(value || '').trim()).filter(Boolean))];
    if (requested.includes(String(tree.root.id))) throw new Error('Root cannot be moved.');
    for (const nodeId of requested) if (!findNode(tree.root, nodeId)) throw new Error(`Tree node ${nodeId} not found.`);
    const selected = new Set(requested);
    return requested.filter(nodeId => {
        let parent = findParent(tree.root, nodeId);
        while (parent) {
            if (selected.has(String(parent.id))) return false;
            parent = findParent(tree.root, parent.id);
        }
        return true;
    });
}

/**
 * Move a mixed Tree selection into one destination as a single in-memory edit.
 * The caller remains responsible for committing the resulting Tree through the
 * canonical Tree mutation path. Nested selected categories collapse to their
 * highest selected ancestor so a subtree is never accidentally flattened.
 */
export function moveTreeItems(tree, { nodeIds = [], uids = [], targetNodeId = null } = {}) {
    if (!tree?.root) throw new Error('Tree has no root.');
    const targetId = String(targetNodeId || '').trim();
    const target = findNode(tree.root, targetId);
    if (!target) throw new Error(`Tree node ${targetId || '(blank)'} not found.`);

    const moveNodes = normalizeMoveNodeIds(tree, nodeIds);
    for (const nodeId of moveNodes) {
        const node = findNode(tree.root, nodeId);
        if (!node) throw new Error(`Tree node ${nodeId} not found.`);
        if (String(node.id) === targetId || findNode(node, targetId)) {
            throw new Error('A category cannot be moved into itself or its own descendant.');
        }
    }

    const coveredUids = new Set();
    for (const nodeId of moveNodes) {
        const node = findNode(tree.root, nodeId);
        for (const uid of collectUids(node)) coveredUids.add(Number(uid));
    }
    const moveUids = [...new Set((uids || []).map(Number).filter(Number.isFinite))].filter(uid => !coveredUids.has(uid));

    // Validation above is complete before the first mutation, so invalid group
    // moves fail closed instead of leaving a partially moved in-memory Tree.
    for (const nodeId of moveNodes) moveCategory(tree, nodeId, targetId);
    for (const uid of moveUids) assignEntry(tree, uid, targetId);

    return {
        targetNodeId: targetId,
        nodeIds: moveNodes,
        uids: moveUids,
        skippedCoveredUids: [...coveredUids].filter(uid => (uids || []).map(Number).includes(uid)),
    };
}

