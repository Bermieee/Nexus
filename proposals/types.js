export const OP = Object.freeze({
    ENTRY_CREATE: 'entry.create',
    ENTRY_UPDATE: 'entry.update',
    ENTRY_DELETE: 'entry.delete',
    ENTRY_MERGE: 'entry.merge',
    ENTRY_SPLIT: 'entry.split',
    ENTRY_MOVE: 'entry.move',
    TREE_NODE_CREATE: 'tree.node.create',
    TREE_NODE_RENAME: 'tree.node.rename',
    TREE_NODE_MOVE: 'tree.node.move',
    TREE_NODE_DELETE: 'tree.node.delete',
    TREE_ENTRY_ASSIGN: 'tree.entry.assign',
    TREE_ENTRY_UNASSIGN: 'tree.entry.unassign',
    TREE_REPLACE: 'tree.replace',
    TREE_DELETE: 'tree.delete',
    SCENE_ARCHIVE: 'scene.archive',
    METADATA_SET: 'metadata.set',
});

export const MUTATING_OPS = new Set(Object.values(OP));

export function validateOp(op) {
    if (!op || typeof op !== 'object') throw new Error('Proposal operation must be an object.');
    if (!MUTATING_OPS.has(op.type)) throw new Error(`Unsupported Nexus proposal operation: ${op.type}`);
    if (!op.book && op.type !== OP.METADATA_SET) throw new Error(`${op.type} requires a lorebook.`);
    return op;
}
