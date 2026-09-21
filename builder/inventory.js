import { semanticSnapshot } from '../tree/model.js';
import { createEntryRef, createLorebookInventory, createTreeInventory, BUILDER_MODE } from './contracts.js';
import { entryFingerprint, fingerprint } from './content-signature.js';

function entryTitle(entry, uid) { return String(entry?.comment || entry?.key?.[0] || `UID ${uid}`).trim(); }

export function buildLorebookInventory(book, data = {}) {
    const source = Object.values(data?.entries || {})
        .filter(entry => Number.isFinite(Number(entry?.uid)))
        .sort((a, b) => Number(a.uid) - Number(b.uid));
    const entries = source.map((entry, index) => createEntryRef({
        ref: `R${index + 1}`,
        book,
        uid: Number(entry.uid),
        title: entryTitle(entry, entry.uid),
        keys: Array.isArray(entry?.key) ? entry.key : [],
        fingerprint: entryFingerprint(entry),
        contentChars: String(entry?.content || '').length,
        disabled: entry?.disable === true,
    }));
    const fingerprintValue = fingerprint(entries.map(entry => ({ uid: entry.uid, fingerprint: entry.fingerprint, disabled: entry.disabled })));
    const inventory = createLorebookInventory({ book, entries, fingerprint: fingerprintValue });
    // Internal executor-only source text. Contracts sent to LLMs use local REFs;
    // UID/object identity remains deterministic and local to Nexus.
    inventory._sourceEntries = source.map((entry, index) => ({ ref: `R${index + 1}`, content: String(entry?.content || '') }));
    return inventory;
}

function walkTree(node, path = [], rows = [], uidRows = new Map()) {
    if (!node) return { rows, uidRows };
    const currentPath = [...path, String(node.label || 'Unnamed')];
    rows.push({
        id: String(node.id || ''),
        label: String(node.label || ''),
        summary: String(node.summary || ''),
        path: currentPath,
        entryUids: [...(node.entryUids || [])].map(Number).filter(Number.isFinite),
    });
    for (const uid of node.entryUids || []) {
        const key = Number(uid);
        const list = uidRows.get(key) || [];
        list.push(String(node.id || ''));
        uidRows.set(key, list);
    }
    for (const child of node.children || []) walkTree(child, currentPath, rows, uidRows);
    return { rows, uidRows };
}

export function buildTreeInventory(book, tree, lorebookInventory) {
    if (!tree?.root) {
        return createTreeInventory({
            book,
            exists: false,
            treeVersion: null,
            treeFingerprint: '',
            nodes: [],
            nodeCount: 0,
            representedUids: [],
            unrepresentedUids: lorebookInventory.activeEntries.map(entry => entry.uid),
            changedUids: [],
            duplicateUidRefs: [],
            orphanedTreeUids: [],
            uidToNodeId: {},
            builderManifest: null,
        });
    }
    const { rows, uidRows } = walkTree(tree.root);
    const activeByUid = new Map(lorebookInventory.activeEntries.map(entry => [entry.uid, entry]));
    const allBookUids = new Set(lorebookInventory.entries.map(entry => entry.uid));
    const representedUids = [...uidRows.keys()].filter(uid => activeByUid.has(uid)).sort((a, b) => a - b);
    const unrepresentedUids = lorebookInventory.activeEntries.filter(entry => !uidRows.has(entry.uid)).map(entry => entry.uid);
    const duplicateUidRefs = [...uidRows.entries()].filter(([, nodes]) => nodes.length > 1).map(([uid, nodeIds]) => ({ uid, nodeIds: [...nodeIds] }));
    const orphanedTreeUids = [...uidRows.keys()].filter(uid => !allBookUids.has(uid));
    const uidToNodeId = Object.fromEntries([...uidRows.entries()].filter(([, nodes]) => nodes.length).map(([uid, nodes]) => [String(uid), nodes.at(-1)]));
    const manifest = tree?.builderManifest || null;
    const changedUids = [];
    for (const uid of representedUids) {
        const current = activeByUid.get(uid);
        const previous = manifest?.entries?.[String(uid)];
        if (previous?.fingerprint && previous.fingerprint !== current?.fingerprint) changedUids.push(uid);
    }
    return createTreeInventory({
        book,
        exists: true,
        treeVersion: tree.version,
        treeFingerprint: fingerprint(semanticSnapshot(tree)),
        nodes: rows,
        nodeCount: rows.length,
        representedUids,
        unrepresentedUids,
        changedUids,
        duplicateUidRefs,
        orphanedTreeUids,
        uidToNodeId,
        builderManifest: manifest,
    });
}

export function determineBuilderMode(request, lorebookInventory, treeInventory) {
    if (request.requestedMode && request.requestedMode !== 'auto') return request.requestedMode;
    if (!lorebookInventory.activeCount) return BUILDER_MODE.NOOP;
    if (!treeInventory.exists || treeInventory.representedCount === 0) return BUILDER_MODE.FULL;
    if (treeInventory.duplicateUidRefs.length || treeInventory.orphanedTreeUids.length || treeInventory.changedCount) return BUILDER_MODE.REPAIR;
    if (treeInventory.unrepresentedCount) return BUILDER_MODE.INCREMENTAL;
    return BUILDER_MODE.NOOP;
}

export function refsForUids(lorebookInventory, uids = []) {
    const wanted = new Set((uids || []).map(Number));
    return lorebookInventory.activeEntries.filter(entry => wanted.has(entry.uid));
}
