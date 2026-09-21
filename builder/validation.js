import { findNodeContainingUid } from '../tree/model.js';
import { BUILDER_MODE, createPlacementProposal, createValidationResult } from './contracts.js';

function uidCounts(node, counts = new Map()) {
    if (!node) return counts;
    for (const uid of node.entryUids || []) counts.set(Number(uid), (counts.get(Number(uid)) || 0) + 1);
    for (const child of node.children || []) uidCounts(child, counts);
    return counts;
}

export function normalizePlacementPayload(payload = {}) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Builder semantic output must be an object.');
    if (!Array.isArray(payload.placements)) throw new Error('Builder semantic output requires placements[].');
    return { placements: payload.placements.map(createPlacementProposal) };
}

export function validatePlacementCoverage({ buildPlan, payload, lorebookInventory } = {}) {
    const errors = [];
    const allowed = new Set(buildPlan.targetRefs || []);
    const seen = new Set();
    for (const placement of payload.placements || []) {
        if (!allowed.has(placement.ref)) errors.push(`Unknown placement ref ${placement.ref}.`);
        if (seen.has(placement.ref)) errors.push(`Duplicate placement ref ${placement.ref}.`);
        seen.add(placement.ref);
    }
    for (const ref of allowed) if (!seen.has(ref)) errors.push(`Missing placement for ${ref}.`);
    const knownRefs = new Set(lorebookInventory.activeEntries.map(entry => entry.ref));
    for (const ref of seen) if (!knownRefs.has(ref)) errors.push(`Placement ref ${ref} is not in authoritative inventory.`);
    return createValidationResult({ passed: errors.length === 0, errors, details: { expectedRefs: [...allowed], receivedRefs: [...seen] } });
}

export function validateMaterializedDelta({ mode, existingTree, treeInventory, lorebookInventory, delta } = {}) {
    const errors = [];
    const warnings = [];
    const counts = uidCounts(delta?.nextTree?.root);
    for (const entry of lorebookInventory.activeEntries) {
        const count = counts.get(entry.uid) || 0;
        if (mode === BUILDER_MODE.FULL && count !== 1) errors.push(`UID ${entry.uid} must be represented exactly once after full build; found ${count}.`);
        if (mode !== BUILDER_MODE.FULL && treeInventory.representedUids.includes(entry.uid) && count !== 1) errors.push(`Existing UID ${entry.uid} lost or duplicated during reconciliation; found ${count}.`);
    }
    for (const uid of treeInventory?.representedUids || []) {
        if (!existingTree?.root) continue;
        const before = findNodeContainingUid(existingTree.root, uid)?.id || null;
        const after = findNodeContainingUid(delta.nextTree.root, uid)?.id || null;
        const wasTargeted = delta.added.some(row => row.uid === uid);
        if (!wasTargeted && before !== after) errors.push(`Unchanged UID ${uid} moved from ${before} to ${after}.`);
    }
    for (const row of delta.added || []) {
        const count = counts.get(row.uid) || 0;
        if (count !== 1) errors.push(`Builder target UID ${row.uid} must be represented exactly once; found ${count}.`);
    }
    if (!delta.added?.length && mode !== BUILDER_MODE.NOOP) warnings.push('Builder produced no attachment delta.');
    for(const finding of delta.conflicts||[])if(String(finding.type||'').startsWith('builder-quality-'))warnings.push(finding.reason);
    return createValidationResult({ passed: errors.length === 0, errors, warnings, details: { counts: Object.fromEntries(counts), semanticQualityProven:false, quality:delta.quality||null } });
}
