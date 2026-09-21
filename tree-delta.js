import { clone, createTree, findNode } from '../tree/model.js';
import { assignEntry, createCategory, currentNodeForUid } from '../tree/ops.js';
import { createTreeDelta, BUILDER_MODE } from './contracts.js';
import { reconcileCanonicalPlacementPaths } from './canonical-paths.js';
import { inspectBuilderTreeQuality } from './navigation-policy.js';

function childByLabel(parent, label) {
    const target = String(label || '').trim().toLowerCase();
    return (parent?.children || []).find(child => String(child?.label || '').trim().toLowerCase() === target) || null;
}

function ensurePath(tree, labels = [], newNodes = []) {
    let parent = tree.root;
    for (const raw of labels) {
        const label = String(raw || '').trim();
        if (!label || label.toLowerCase() === 'root') continue;
        let node = childByLabel(parent, label);
        if (!node) {
            node = createCategory(tree, { label, parentNodeId: parent.id });
            newNodes.push({ nodeId: node.id, label: node.label, parentNodeId: parent.id, parentLabel: parent.label });
        }
        parent = node;
    }
    return parent;
}

export function materializeTreeDelta({ book, mode, existingTree, lorebookInventory, treeInventory, placements = [], now = Date.now() } = {}) {
    const tree = mode === BUILDER_MODE.FULL || !existingTree?.root ? createTree(book) : clone(existingTree);
    const refMap = new Map(lorebookInventory.activeEntries.map(entry => [entry.ref, entry]));
    const newNodes = [];
    const added = [];
    const reconciled = reconcileCanonicalPlacementPaths({ placements, lorebookInventory, existingTree });

    for (const placement of reconciled.placements) {
        const entry = refMap.get(placement.ref);
        if (!entry) throw new Error(`Builder placement references unknown local ref ${placement.ref}.`);
        let node = null;
        if (placement.existingNodeId) node = findNode(tree.root, placement.existingNodeId);
        if (!node && placement.path?.length) node = ensurePath(tree, placement.path, newNodes);
        if (!node && placement.newNodeLabel) {
            const parent = placement.parentNodeId ? findNode(tree.root, placement.parentNodeId) : tree.root;
            if (!parent) throw new Error(`Builder placement ${placement.ref} references unknown parent node ${placement.parentNodeId}.`);
            node = childByLabel(parent, placement.newNodeLabel) || createCategory(tree, { label: placement.newNodeLabel, parentNodeId: parent.id });
            if (!newNodes.some(row => row.nodeId === node.id) && !(existingTree && findNode(existingTree.root, node.id))) {
                newNodes.push({ nodeId: node.id, label: node.label, parentNodeId: parent.id, parentLabel: parent.label });
            }
        }
        if (!node) throw new Error(`Builder placement ${placement.ref} could not resolve a destination node.`);
        const priorNode = existingTree?.root ? currentNodeForUid(existingTree, entry.uid) : null;
        assignEntry(tree, entry.uid, node.id);
        added.push({ ref: entry.ref, uid: entry.uid, title: entry.title, nodeId: node.id, nodeLabel: node.label, priorNodeId: priorNode?.id || null });
    }

    const manifestEntries = {};
    for (const entry of lorebookInventory.activeEntries) {
        const node = currentNodeForUid(tree, entry.uid);
        if (!node) continue;
        manifestEntries[String(entry.uid)] = { uid: entry.uid, title: entry.title, fingerprint: entry.fingerprint, nodeId: node.id, nodeLabel: node.label };
    }
    tree.builderManifest = {
        schema: 'nexus-lorebook-builder-manifest/v1',
        book,
        bookFingerprint: lorebookInventory.fingerprint,
        reconciledAt: now,
        entries: manifestEntries,
    };
    tree.lastBuilt = now;

    const quality=inspectBuilderTreeQuality({tree,lorebookInventory,placements:reconciled.placements});
    return createTreeDelta({
        book,
        mode,
        unchangedCount: mode === BUILDER_MODE.FULL ? 0 : treeInventory?.representedCount || 0,
        added,
        newNodes,
        updatedSummaries: [],
        conflicts: [...reconciled.aliases.map(row => ({ type: 'canonical-path-alias-reconciled', ...row })), ...quality.issues],
        quality: quality.metrics,
        nextTree: tree,
    });
}
