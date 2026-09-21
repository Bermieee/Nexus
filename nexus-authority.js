import { lorebookOperatorReviewScope } from '../nexus/review-scope.js';
import { entryFingerprint } from '../builder/content-signature.js';
import {
    createBuilder2Source,
    createBuilder2SourceRevision,
    createBuilder2TreeRevision,
} from './contracts.js';

function clean(value) { return String(value ?? '').trim(); }
function entryTitle(entry, uid) { return clean(entry?.comment || entry?.key?.[0] || `UID ${uid}`); }
function sourceKey(book, uid) { return `${book}#${Number(uid)}`; }

export function buildNexusBuilder2CorpusSources(book, data = {}) {
    const rows = Object.values(data?.entries || {})
        .filter(entry => Number.isFinite(Number(entry?.uid)))
        .sort((a, b) => Number(a.uid) - Number(b.uid));
    return rows.map(entry => createBuilder2Source({
        sourceKey: sourceKey(book, entry.uid),
        book,
        uid: Number(entry.uid),
        fingerprint: entryFingerprint(entry),
        title: entryTitle(entry, entry.uid),
        keys: Array.isArray(entry?.key) ? entry.key : [],
        content: String(entry?.content || ''),
        disabled: entry?.disable === true,
    }));
}

export function buildNexusBuilder2TreeInventory(book, tree) {
    if (!tree?.root) return { book, exists: false, nodes: [], membershipComplete: true, builderManifest: null };
    const nodes = [];
    const walk = (node, parentId = null, path = [], depth = 0) => {
        const label = clean(node?.label || 'Unnamed');
        const nextPath = [...path, label];
        nodes.push({
            id: clean(node?.id),
            parentId: parentId ? clean(parentId) : null,
            label,
            summary: clean(node?.summary),
            path: nextPath,
            depth,
            entryUids: [...new Set((node?.entryUids || []).map(Number).filter(Number.isFinite))],
            locked: node?.locked === true,
            protected: node?.protected === true,
            containerOnly: depth === 0 || node?.containerOnly === true,
        });
        for (const child of node?.children || []) walk(child, node.id, nextPath, depth + 1);
    };
    walk(tree.root);
    return {
        book,
        exists: true,
        treeVersion: Number(tree.version || 2),
        nodes,
        membershipComplete: true,
        builderManifest: structuredClone(tree.builderManifest || null),
    };
}

function treeUidHomes(treeInventory) {
    const homes = new Map();
    for (const node of treeInventory?.nodes || []) {
        for (const uid of node.entryUids || []) {
            const n = Number(uid);
            const list = homes.get(n) || [];
            list.push(node.id);
            homes.set(n, list);
        }
    }
    return homes;
}

export function inspectNexusBuilder2Authority({ book, data, tree } = {}) {
    const corpusSources = buildNexusBuilder2CorpusSources(book, data);
    const treeInventory = buildNexusBuilder2TreeInventory(book, tree);
    const byUid = new Map(corpusSources.map(row => [row.uid, row]));
    const activeByUid = new Map(corpusSources.filter(row => !row.disabled && !row.removed).map(row => [row.uid, row]));
    const homes = treeUidHomes(treeInventory);
    const rootNode = (treeInventory.nodes || []).find(node => Number(node.depth) === 0) || null;
    const rootDirectUids = [...new Set((rootNode?.entryUids || []).map(Number).filter(uid => Number.isFinite(uid) && activeByUid.has(uid)))].sort((a,b)=>a-b);
    const representedUids = [...homes.keys()].filter(uid => activeByUid.has(uid)).sort((a, b) => a - b);
    const unrepresentedUids = [...activeByUid.keys()].filter(uid => !homes.has(uid)).sort((a, b) => a - b);
    const duplicateUids = [...homes.entries()].filter(([, ids]) => ids.length > 1).map(([uid]) => uid).filter(uid => activeByUid.has(uid)).sort((a, b) => a - b);
    const orphanedTreeUids = [...homes.keys()].filter(uid => !byUid.has(uid)).sort((a, b) => a - b);
    const manifest = tree?.builderManifest || null;
    const changedUids = [];
    for (const uid of representedUids) {
        const current = activeByUid.get(uid);
        const previous = manifest?.entries?.[String(uid)];
        if (previous?.deferred === true || (previous?.fingerprint && previous.fingerprint !== current?.fingerprint)) changedUids.push(uid);
    }
    return {
        book,
        corpusSources,
        treeInventory,
        representedUids,
        unrepresentedUids,
        changedUids: [...new Set(changedUids)].sort((a, b) => a - b),
        duplicateUids,
        orphanedTreeUids,
        rootDirectUids,
        corpusRevision: createBuilder2SourceRevision(corpusSources).revisionId,
        treeRevision: createBuilder2TreeRevision(treeInventory)?.revisionId || null,
    };
}

export function determineNexusBuilder2Mode(request = {}, inspection = {}) {
    const requested = clean(request?.requestedMode || 'auto').toLowerCase();
    if (requested && requested !== 'auto') return requested;
    const activeCount = inspection.corpusSources?.filter(row => !row.disabled && !row.removed).length || 0;
    const hasTree = inspection.treeInventory?.exists === true;
    const represented = inspection.representedUids?.length || 0;
    if (!hasTree || represented === 0) {
        if (activeCount > 0) return 'full';
        return inspection.orphanedTreeUids?.length ? 'repair' : 'noop';
    }
    if ((inspection.changedUids?.length || 0) || (inspection.duplicateUids?.length || 0) || (inspection.orphanedTreeUids?.length || 0) || (inspection.rootDirectUids?.length || 0)) return 'repair';
    if (inspection.unrepresentedUids?.length) return 'incremental';
    return 'noop';
}

function removalTombstone(book, uid, treeRevision) {
    return createBuilder2Source({
        sourceKey: sourceKey(book, uid),
        book,
        uid,
        fingerprint: `removed:${Number(uid)}:${clean(treeRevision) || 'no-tree'}`,
        title: `Removed UID ${Number(uid)}`,
        keys: [],
        content: '',
        removed: true,
        removalReason: 'removed-from-authoritative-lorebook',
    });
}

export function buildNexusBuilder2Workset({ book, mode, inspection } = {}) {
    const byUid = new Map((inspection?.corpusSources || []).map(row => [row.uid, row]));
    if (mode === 'full') return [...(inspection?.corpusSources || [])];
    const wanted = new Set();
    if (mode === 'incremental') for (const uid of inspection?.unrepresentedUids || []) wanted.add(Number(uid));
    if (mode === 'repair') {
        for (const uid of inspection?.unrepresentedUids || []) wanted.add(Number(uid));
        for (const uid of inspection?.changedUids || []) wanted.add(Number(uid));
        for (const uid of inspection?.duplicateUids || []) wanted.add(Number(uid));
        for (const uid of inspection?.rootDirectUids || []) wanted.add(Number(uid));
    }
    const rows = [...wanted].map(uid => byUid.get(uid)).filter(Boolean);
    if (mode === 'repair') {
        for (const uid of inspection?.orphanedTreeUids || []) rows.push(removalTombstone(book, uid, inspection.treeRevision));
    }
    return rows.sort((a, b) => a.uid - b.uid || a.sourceKey.localeCompare(b.sourceKey));
}

export function minimalNexusBuilder2WorksetAuthority(worksetSources = []) {
    return worksetSources.map(row => ({
        sourceKey: row.sourceKey,
        book: row.book,
        uid: row.uid,
        fingerprint: row.fingerprint,
        removed: row.removed === true,
        disabled: row.disabled === true,
        removalReason: row.removalReason || '',
    }));
}

function currentWorksetFromPlan(plan, corpusSources) {
    const currentByKey = new Map((corpusSources || []).map(row => [row.sourceKey, row]));
    const saved = Array.isArray(plan?.metadata?.worksetAuthority) ? plan.metadata.worksetAuthority : [];
    const keys = Array.isArray(plan?.metadata?.worksetSourceKeys) ? plan.metadata.worksetSourceKeys : saved.map(row => row.sourceKey);
    const savedByKey = new Map(saved.map(row => [row.sourceKey, row]));
    const rows = [];
    for (const key of keys) {
        const current = currentByKey.get(key);
        const prior = savedByKey.get(key);
        if (current) {
            rows.push(current);
            continue;
        }
        if (prior?.removed === true) {
            rows.push(createBuilder2Source({ ...prior, content: '', title: prior.title || `Removed UID ${prior.uid}` }));
            continue;
        }
        // The source disappeared after the plan captured it. Represent that as
        // an explicit current tombstone so sourceRevision necessarily changes.
        if (prior && Number.isFinite(Number(prior.uid))) {
            rows.push(createBuilder2Source({
                ...prior,
                fingerprint: `now-removed:${prior.fingerprint}`,
                removed: true,
                disabled: true,
                content: '',
                title: prior.title || `Removed UID ${prior.uid}`,
                removalReason: 'source-disappeared-after-plan-start',
            }));
        }
    }
    return rows;
}

export async function readNexusBuilder2LiveContext(plan, { loadBookFn, getTreeFn } = {}) {
    if (!plan?.book) throw new Error('Builder 2 live context requires a plan with book.');
    if (typeof loadBookFn !== 'function' || typeof getTreeFn !== 'function') throw new Error('Builder 2 live context requires explicit loadBookFn/getTreeFn adapters.');
    const data = await loadBookFn(plan.book);
    const tree = getTreeFn(plan.book);
    const inspection = inspectNexusBuilder2Authority({ book: plan.book, data, tree });
    const worksetSources = currentWorksetFromPlan(plan, inspection.corpusSources);
    return {
        data,
        tree,
        inspection,
        worksetSources,
        corpusSources: inspection.corpusSources,
        treeInventory: inspection.treeInventory,
    };
}

export async function readNexusBuilder2CurrentAuthority(plan, adapters = {}) {
    const ctx = await readNexusBuilder2LiveContext(plan, adapters);
    const scope = lorebookOperatorReviewScope(plan.book);
    return {
        sourceRevision: createBuilder2SourceRevision(ctx.worksetSources).revisionId,
        corpusRevision: ctx.inspection.corpusRevision,
        treeRevision: ctx.inspection.treeRevision,
        operatorReviewScope: scope.identity,
        chatId: scope.chatId,
    };
}

export function assertNexusBuilder2ReviewScope(plan) {
    const expected = clean(plan?.metadata?.operatorReviewScope);
    if (!expected) return true;
    const current = lorebookOperatorReviewScope(plan.book);
    if (clean(current.identity) === expected) return true;
    const error = new Error('Builder 2 operator review belongs to a different lorebook/Tree scope. Start or resume the Builder run for the selected lorebook.');
    error.name = 'TV2Builder2ReviewScopeStale';
    error.builder2Stale = true;
    throw error;
}
