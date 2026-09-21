export function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }

export function makeNodeId() {
    if (globalThis.crypto?.randomUUID) return `tv2_node_${crypto.randomUUID()}`;
    return `tv2_node_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}


function legacyNodeIdHash(value = '') {
    let hash = 2166136261 >>> 0;
    for (const ch of String(value || '')) {
        hash ^= ch.codePointAt(0);
        hash = Math.imul(hash, 16777619) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
}

/**
 * Repair missing/duplicate legacy node IDs deterministically. This helper only
 * mutates node identity; it deliberately does not normalize labels, UID
 * placement, or other Tree semantics so getTree() can persist an identity-only
 * repair before returning a normalized read view.
 */
export function repairTreeNodeIds(tree, lorebookName = tree?.lorebookName || '') {
    if (!tree || typeof tree !== 'object' || !tree.root || typeof tree.root !== 'object') return { tree, changed: false, repairs: [] };
    const seen = new Set();
    const repairs = [];
    const book = String(lorebookName || tree.lorebookName || '');
    const walk = (node, path = '0') => {
        const requested = String(node?.id || '').trim();
        let next = requested;
        if (!requested || seen.has(requested)) {
            const base = `tv2_node_legacy_${legacyNodeIdHash(JSON.stringify([book, path, String(node?.label || '')]))}`;
            next = base;
            let suffix = 1;
            while (seen.has(next)) next = `${base}_${suffix++}`;
            repairs.push({ path, previousId: requested || null, nextId: next });
            node.id = next;
        }
        seen.add(next);
        const children = Array.isArray(node?.children) ? node.children : [];
        children.forEach((child, index) => walk(child, `${path}.${index}`));
    };
    walk(tree.root);
    return { tree, changed: repairs.length > 0, repairs };
}

export function createNode(label = 'New Category', summary = '') {
    return { id: makeNodeId(), label, summary, keywords: [], entryUids: [], children: [], collapsed: false };
}

export function createTree(lorebookName) {
    return { lorebookName, version: 2, lastBuilt: Date.now(), root: createNode('Root', `Top-level index for ${lorebookName}`) };
}

export function validateCanonicalTreeIdentity(tree,{label='Tree',allowMissingIds=false}={}){
    if(!tree?.root||typeof tree.root!=='object')throw new Error(`${label} has no root node.`);
    const nodeIds=new Set(),uidHomes=new Map();
    const walk=node=>{
        const id=String(node?.id||'').trim();
        if(!id){if(!allowMissingIds)throw new Error(`${label} contains a node without an ID.`);}else{if(nodeIds.has(id))throw new Error(`${label} contains duplicate node ID ${id}; canonical import/replacement refuses ambiguous identity.`);nodeIds.add(id);}
        for(const raw of Array.isArray(node?.entryUids)?node.entryUids:[]){
            const uid=Number(raw);if(!Number.isFinite(uid))continue;
            if(uidHomes.has(uid))throw new Error(`${label} places UID ${uid} in multiple nodes (${uidHomes.get(uid)} and ${id}); use an explicit repair transaction instead of silent dedupe.`);
            uidHomes.set(uid,id);
        }
        for(const child of Array.isArray(node?.children)?node.children:[])walk(child);
    };
    walk(tree.root);
    return {nodeCount:nodeIds.size,uidCount:uidHomes.size};
}

export function normalizeTree(tree, lorebookName = tree?.lorebookName || '') {
    if (!tree || typeof tree !== 'object') return createTree(lorebookName);
    tree.lorebookName = lorebookName || tree.lorebookName || '';
    tree.version = 2;
    if (!tree.root) tree.root = createNode('Root', `Top-level index for ${tree.lorebookName}`);
    const seen = new Set();
    repairTreeNodeIds(tree, tree.lorebookName);
    const normalizeNode = (node) => {
        node.label = String(node.label || 'Unnamed');
        node.summary = String(node.summary || '');
        node.keywords = [...new Set((Array.isArray(node.keywords) ? node.keywords : []).map(value => String(value || '').trim()).filter(Boolean))];
        node.entryUids = [...new Set((node.entryUids || []).map(Number).filter(Number.isFinite))];
        node.children = Array.isArray(node.children) ? node.children : [];
        node.collapsed = node.collapsed === true;
        for (const child of node.children) normalizeNode(child);
    };
    const dedupeDeepestFirst = (node) => {
        // Children claim a UID before their parent, so the canonical assignment
        // remains in the deepest explicit Tree node instead of drifting upward.
        for (const child of node.children || []) dedupeDeepestFirst(child);
        node.entryUids = (node.entryUids || []).filter(uid => !seen.has(uid) && seen.add(uid));
    };
    normalizeNode(tree.root);
    dedupeDeepestFirst(tree.root);
    return tree;
}

export function semanticSnapshot(tree) {
    const copy = clone(tree);
    if (!copy) return null;
    delete copy.lastBuilt;
    const walk = node => {
        if (!node) return;
        delete node.collapsed;
        for (const child of node.children || []) walk(child);
    };
    walk(copy.root);
    return copy;
}

export function findNode(root, nodeId) {
    if (!root || !nodeId) return null;
    if (root.id === nodeId) return root;
    for (const child of root.children || []) {
        const found = findNode(child, nodeId);
        if (found) return found;
    }
    return null;
}

export function findParent(root, nodeId) {
    for (const child of root?.children || []) {
        if (child.id === nodeId) return root;
        const found = findParent(child, nodeId);
        if (found) return found;
    }
    return null;
}

export function findNodeContainingUid(root, uid) {
    if ((root?.entryUids || []).includes(Number(uid))) return root;
    for (const child of root?.children || []) {
        const found = findNodeContainingUid(child, uid);
        if (found) return found;
    }
    return null;
}

export function collectUids(node) {
    const result = [...(node?.entryUids || [])];
    for (const child of node?.children || []) result.push(...collectUids(child));
    return [...new Set(result)];
}
