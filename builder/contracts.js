import { deepCopy, nexusId } from '../nexus/contracts.js';

export const BUILDER_CONTRACT = 'nexus-lorebook-builder/v1';
export const BUILDER_MODE = Object.freeze({
    FULL: 'full',
    INCREMENTAL: 'incremental',
    REPAIR: 'repair',
    NOOP: 'noop',
});
export const BUILDER_PLACEMENT_ACTION = Object.freeze({
    ATTACH: 'attach',
    CREATE_AND_ATTACH: 'create_and_attach',
});

const MODES = new Set(Object.values(BUILDER_MODE));
const ACTIONS = new Set(Object.values(BUILDER_PLACEMENT_ACTION));

function clean(value) { return String(value ?? '').trim(); }
function finiteUid(value) {
    const uid = Number(value);
    if (!Number.isFinite(uid)) throw new Error(`Builder UID must be numeric: ${String(value)}`);
    return uid;
}
function uniqueStrings(values = []) { return [...new Set((values || []).map(clean).filter(Boolean))]; }

export function createBuildRequest(spec = {}) {
    const book = clean(spec.book);
    if (!book) throw new Error('Lorebook Builder requires a lorebook name.');
    const requestedMode = clean(spec.requestedMode || 'auto').toLowerCase();
    if (requestedMode !== 'auto' && !MODES.has(requestedMode)) throw new Error(`Unknown Lorebook Builder mode: ${requestedMode}`);
    return {
        contract: BUILDER_CONTRACT,
        id: clean(spec.id) || nexusId('nexus_builder_run'),
        book,
        requestedMode,
        source: clean(spec.source || 'operator'),
        validateOnly: spec.validateOnly === true,
        createdAt: Number.isFinite(Number(spec.createdAt)) ? Number(spec.createdAt) : Date.now(),
        metadata: deepCopy(spec.metadata || {}),
    };
}

export function createEntryRef(spec = {}) {
    const ref = clean(spec.ref);
    if (!ref) throw new Error('Builder EntryRef requires a local ref.');
    return {
        ref,
        book: clean(spec.book),
        uid: finiteUid(spec.uid),
        title: clean(spec.title) || `UID ${finiteUid(spec.uid)}`,
        keys: uniqueStrings(spec.keys),
        fingerprint: clean(spec.fingerprint),
        contentChars: Math.max(0, Number(spec.contentChars) || 0),
        disabled: spec.disabled === true,
    };
}

export function createLorebookInventory(spec = {}) {
    const entries = (spec.entries || []).map(createEntryRef).sort((a, b) => a.uid - b.uid);
    const activeEntries = entries.filter(entry => !entry.disabled);
    return {
        contract: BUILDER_CONTRACT,
        book: clean(spec.book),
        fingerprint: clean(spec.fingerprint),
        entryCount: entries.length,
        activeCount: activeEntries.length,
        entries,
        activeEntries,
    };
}

export function createTreeInventory(spec = {}) {
    const representedUids = [...new Set((spec.representedUids || []).map(Number).filter(Number.isFinite))].sort((a, b) => a - b);
    const unrepresentedUids = [...new Set((spec.unrepresentedUids || []).map(Number).filter(Number.isFinite))].sort((a, b) => a - b);
    const changedUids = [...new Set((spec.changedUids || []).map(Number).filter(Number.isFinite))].sort((a, b) => a - b);
    return {
        contract: BUILDER_CONTRACT,
        book: clean(spec.book),
        exists: spec.exists === true,
        treeVersion: spec.treeVersion == null ? null : Number(spec.treeVersion),
        treeFingerprint: clean(spec.treeFingerprint),
        nodeCount: Math.max(0, Number(spec.nodeCount) || 0),
        nodes: deepCopy(spec.nodes || []),
        representedUids,
        representedCount: representedUids.length,
        unrepresentedUids,
        unrepresentedCount: unrepresentedUids.length,
        changedUids,
        changedCount: changedUids.length,
        duplicateUidRefs: deepCopy(spec.duplicateUidRefs || []),
        orphanedTreeUids: [...new Set((spec.orphanedTreeUids || []).map(Number).filter(Number.isFinite))],
        uidToNodeId: deepCopy(spec.uidToNodeId || {}),
        builderManifest: deepCopy(spec.builderManifest || null),
    };
}

export function createBuildPlan(spec = {}) {
    const mode = clean(spec.mode).toLowerCase();
    if (!MODES.has(mode)) throw new Error(`Invalid Builder BuildPlan mode: ${mode}`);
    return {
        contract: BUILDER_CONTRACT,
        id: clean(spec.id) || nexusId('nexus_builder_plan'),
        runId: clean(spec.runId),
        book: clean(spec.book),
        mode,
        targetRefs: uniqueStrings(spec.targetRefs),
        jobs: deepCopy(spec.jobs || []),
        directorPlan: deepCopy(spec.directorPlan || null),
        createdAt: Number.isFinite(Number(spec.createdAt)) ? Number(spec.createdAt) : Date.now(),
        metadata: deepCopy(spec.metadata || {}),
    };
}

export function createPlacementProposal(spec = {}) {
    const ref = clean(spec.ref);
    if (!ref) throw new Error('PlacementProposal requires ref.');
    const rawAction = clean(spec.action || BUILDER_PLACEMENT_ACTION.ATTACH).toLowerCase();
    // `create` was an easy, reasonable model inference from the original prompt.
    // Treat it as a compatibility alias for the canonical create_and_attach action
    // while keeping the persisted/output contract unambiguous.
    const action = rawAction === 'create' ? BUILDER_PLACEMENT_ACTION.CREATE_AND_ATTACH : rawAction;
    if (!ACTIONS.has(action)) throw new Error(`Unknown Builder placement action: ${rawAction}`);
    const path = uniqueStrings(spec.path);
    const existingNodeId = clean(spec.existingNodeId) || null;
    const parentNodeId = clean(spec.parentNodeId) || null;
    const newNodeLabel = clean(spec.newNodeLabel) || null;
    if (action === BUILDER_PLACEMENT_ACTION.ATTACH && !existingNodeId && !path.length) {
        throw new Error(`Placement ${ref} must identify an existing node or a path.`);
    }
    if (action === BUILDER_PLACEMENT_ACTION.CREATE_AND_ATTACH && !newNodeLabel && !path.length) {
        throw new Error(`Placement ${ref} must identify a new node label or a path.`);
    }
    return {
        contract: BUILDER_CONTRACT,
        ref,
        action,
        existingNodeId,
        parentNodeId,
        newNodeLabel,
        path,
        reasoning: clean(spec.reasoning),
        confidence: Number.isFinite(Number(spec.confidence)) ? Math.max(0, Math.min(1, Number(spec.confidence))) : null,
    };
}

export function createTreeDelta(spec = {}) {
    return {
        contract: BUILDER_CONTRACT,
        book: clean(spec.book),
        mode: clean(spec.mode),
        unchangedCount: Math.max(0, Number(spec.unchangedCount) || 0),
        added: deepCopy(spec.added || []),
        newNodes: deepCopy(spec.newNodes || []),
        updatedSummaries: deepCopy(spec.updatedSummaries || []),
        conflicts: deepCopy(spec.conflicts || []),
        quality: deepCopy(spec.quality || null),
        nextTree: deepCopy(spec.nextTree || null),
    };
}

export function createValidationResult(spec = {}) {
    const errors = uniqueStrings(spec.errors);
    const warnings = uniqueStrings(spec.warnings);
    return {
        contract: BUILDER_CONTRACT,
        passed: spec.passed !== false && errors.length === 0,
        errors,
        warnings,
        details: deepCopy(spec.details || {}),
    };
}

export function createLedgerMutationPlan(spec = {}) {
    return {
        contract: BUILDER_CONTRACT,
        type: 'lorebook-builder-tree-delta',
        book: clean(spec.book),
        mode: clean(spec.mode),
        operations: deepCopy(spec.operations || []),
        assumptions: deepCopy(spec.assumptions || {}),
        delta: deepCopy(spec.delta || null),
    };
}
