import { getTree } from './store.js';
import { currentNodeForUid } from './ops.js';

function pathForNode(root, nodeId, path = []) {
    if (!root) return null;
    const next = [...path, String(root.label || 'Unnamed')];
    if (String(root.id) === String(nodeId)) return next;
    for (const child of root.children || []) {
        const found = pathForNode(child, nodeId, next);
        if (found) return found;
    }
    return null;
}

/**
 * UID identity is canonical. nodeId/path are display/routing metadata and must
 * be re-resolved from the current Tree after moves/replacements/reloads.
 */
export function resolveCurrentTreeRef(ref) {
    const book = String(ref?.book || '').trim();
    const uid = Number(ref?.uid);
    if (!book || !Number.isFinite(uid)) return null;
    const tree = getTree(book);
    if (!tree?.root) return null;
    const node = currentNodeForUid(tree, uid);
    if (!node) return null;
    return {
        ...ref,
        book,
        uid,
        nodeId: String(node.id),
        nodeLabel: String(node.label || ''),
        path: pathForNode(tree.root, node.id) || [],
    };
}
