import { BUILDER2_CLASSIFICATION_DECISION, createBuilder2Classification, clean } from './contracts.js';
import { packBuilder2SemanticSources } from './semantic-packing.js';

function active(source) {
    return !source.disabled && !source.removed;
}

function locallyStructural(source) {
    // Empty records with no trigger keys carry no semantic lore payload. They
    // are section dividers/placeholders, so resolving them locally avoids a
    // provider round-trip and prevents decorative headers becoming gap work.
    return active(source) && !clean(source?.content) && !(source?.keys || []).some(key => clean(key));
}

function childrenMap(nodes) {
    const map = new Map();
    for (const node of nodes) {
        const parent = node.parentTaxonId || '__ROOT__';
        const children = map.get(parent) || [];
        children.push(node);
        map.set(parent, children);
    }
    for (const children of map.values()) {
        children.sort((a, b) => a.label.localeCompare(b.label) || a.taxonId.localeCompare(b.taxonId));
    }
    return map;
}

function descendants(id, map, out = new Set()) {
    for (const node of map.get(id) || []) {
        out.add(node.taxonId);
        descendants(node.taxonId, map, out);
    }
    return out;
}

function nodeView(node) {
    return {
        taxonId: node.taxonId,
        parentTaxonId: node.parentTaxonId,
        label: node.label,
        purpose: node.purpose,
        aliases: node.aliases,
        entryPolicy: node.entryPolicy,
    };
}


function semanticTokens(value) {
    return [...new Set(String(value ?? '')
        .toLocaleLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .split(/\s+/)
        .filter(token => token.length >= 3))];
}

function branchRoots(nodes = []) {
    const kids = childrenMap(nodes);
    const roots = kids.get('__ROOT__') || [];
    if (roots.length === 1) {
        const children = kids.get(roots[0].taxonId) || [];
        if (children.length) return { anchors: roots, branches: children };
    }
    return { anchors: [], branches: roots };
}

function localBranchScore(entries, branch, nodesById, kids) {
    const entryText = (entries || []).map(entry => [entry?.title, ...(entry?.keys || []), String(entry?.content || '').slice(0, 4000)].join(' ')).join(' ');
    const entryLower = entryText.toLocaleLowerCase();
    const entryTokens = new Set(semanticTokens(entryText));
    const ids = [branch.taxonId, ...descendants(branch.taxonId, kids)];
    let score = 0;
    for (const id of ids) {
        const node = nodesById.get(id);
        if (!node) continue;
        const label = clean(node.label).toLocaleLowerCase();
        if (label && entryLower.includes(label)) score += 18;
        for (const alias of node.aliases || []) {
            const a = clean(alias).toLocaleLowerCase();
            if (a && entryLower.includes(a)) score += 10;
        }
        const weighted = [
            ...semanticTokens(node.label).map(token => [token, 5]),
            ...(node.aliases || []).flatMap(alias => semanticTokens(alias).map(token => [token, 4])),
            ...semanticTokens(node.purpose).map(token => [token, 1]),
        ];
        for (const [token, weight] of weighted) if (entryTokens.has(token)) score += weight;
    }
    return score;
}

function selectLocalTaxonomyBranches({ entries = [], taxonomy, targetTaxa = 32 } = {}) {
    const nodes = taxonomy?.nodes || [];
    if (!nodes.length) return [];
    const byId = new Map(nodes.map(node => [node.taxonId, node]));
    const kids = childrenMap(nodes);
    const { anchors, branches } = branchRoots(nodes);
    if (!branches.length) return [];
    const ranked = branches.map(branch => ({
        branch,
        score: localBranchScore(entries, branch, byId, kids),
    })).sort((a, b) => b.score - a.score || a.branch.taxonId.localeCompare(b.branch.taxonId));
    if (!(ranked[0]?.score > 0)) return [];
    const best = ranked[0].score;
    const chosen = ranked.filter((row, index) => index < 3 && row.score >= Math.max(3, best * 0.32));
    if (!chosen.length) chosen.push(ranked[0]);
    const ids = new Set(anchors.map(node => node.taxonId));
    for (const { branch } of chosen) {
        ids.add(branch.taxonId);
        for (const id of descendants(branch.taxonId, kids)) ids.add(id);
    }
    if (ids.size > targetTaxa) return [];
    return [...ids].map(id => byId.get(id)).filter(Boolean).sort((a, b) => a.taxonId.localeCompare(b.taxonId));
}

function compactKeys(keys = [], limit = 24) {
    const seen = new Set(), out = [];
    for (const value of keys || []) {
        const key = clean(value);
        const norm = key.toLocaleLowerCase();
        if (!key || seen.has(norm)) continue;
        seen.add(norm);out.push(key);
        if (out.length >= limit) break;
    }
    return out;
}

export function rebaseBuilder2ClassificationsForTaxonomy(classifications = [], taxonomy, {
    remapTaxonIds = {},
    dirtySourceKeys = [],
    assignments = {},
} = {}) {
    const dirty = new Set(dirtySourceKeys || []);
    const knownById = new Map((taxonomy?.nodes || []).map(node => [node.taxonId, node]));
    const known = new Set(knownById.keys());
    const out = [], invalidated = new Set();
    for (const row of classifications || []) {
        if (dirty.has(row.sourceKey)) { invalidated.add(row.sourceKey); continue; }
        const assigned = clean(assignments?.[row.sourceKey]);
        if (assigned) {
            if (!known.has(assigned)) throw new Error(`Builder 2 local classification assignment references unknown taxon ${assigned}.`);
            if (knownById.get(assigned)?.entryPolicy === 'container-only') throw new Error(`Builder 2 local classification assignment cannot target container-only taxon ${assigned}.`);
            out.push(createBuilder2Classification({
                ...row,
                taxonomyRevision: taxonomy.revisionId,
                classificationRevision: taxonomy.classificationRevisionId,
                decision: BUILDER2_CLASSIFICATION_DECISION.CLASSIFIED,
                taxonId: assigned,
                candidates: [],
                confidence: 1,
                reason: 'operator-approved-taxonomy-resolution',
                metadata: { ...(row.metadata || {}), localArtifactPromotion: true, semanticReplay: false },
            }));
            continue;
        }
        let taxonId = clean(row.taxonId) || null;
        if (taxonId && remapTaxonIds[taxonId]) taxonId = clean(remapTaxonIds[taxonId]);
        const candidates = (row.candidates || []).map(candidate => ({
            ...candidate,
            taxonId: clean(remapTaxonIds[candidate.taxonId] || candidate.taxonId),
        })).filter(candidate => known.has(candidate.taxonId));
        if (row.decision === BUILDER2_CLASSIFICATION_DECISION.CLASSIFIED && (!taxonId || !known.has(taxonId) || knownById.get(taxonId)?.entryPolicy === 'container-only')) {
            invalidated.add(row.sourceKey);continue;
        }
        if (row.decision === BUILDER2_CLASSIFICATION_DECISION.AMBIGUOUS && candidates.length < 2) {
            invalidated.add(row.sourceKey);continue;
        }
        out.push(createBuilder2Classification({
            ...row,
            taxonomyRevision: taxonomy.revisionId,
            classificationRevision: taxonomy.classificationRevisionId,
            taxonId,
            candidates,
            metadata: { ...(row.metadata || {}), localArtifactRebase: true },
        }));
    }
    return { classifications: out, invalidatedSourceKeys: [...invalidated] };
}

async function routeCandidateChunks({ entries, candidates, routeTaxonomy, limit, signal }) {
    if (candidates.length <= limit) {
        const raw = await routeTaxonomy({ entries, candidates: candidates.map(nodeView), signal });
        return [...new Set((raw?.taxonIds || [raw?.taxonId])
            .map(clean)
            .filter(id => candidates.some(candidate => candidate.taxonId === id)))];
    }

    // Candidate chunks at one taxonomy depth are independent. Dispatch them
    // concurrently so the Nexus semantic adapter can schedule both Sidecars;
    // the next depth still waits for this complete union, preserving routing
    // semantics and deterministic branch selection.
    const chunks = [];
    for (let index = 0; index < candidates.length; index += limit) chunks.push(candidates.slice(index, index + limit));
    const selectedByChunk = await Promise.all(chunks.map(async chunk => {
        const raw = await routeTaxonomy({ entries, candidates: chunk.map(nodeView), signal });
        return (raw?.taxonIds || [raw?.taxonId])
            .map(clean)
            .filter(Boolean)
            .filter(id => chunk.some(candidate => candidate.taxonId === id));
    }));
    return [...new Set(selectedByChunk.flat())];
}

export async function selectBuilder2TaxonomyWindow({
    entries,
    taxonomy,
    routeTaxonomy,
    maxTaxa = 96,
    routeCandidateLimit = 48,
    maxDepth = 16,
    signal = null,
} = {}) {
    const nodes = taxonomy.nodes || [];
    const localTargetTaxa = Math.max(1, Math.min(maxTaxa, 32));
    if (nodes.length > localTargetTaxa) {
        const local = selectLocalTaxonomyBranches({ entries, taxonomy, targetTaxa: localTargetTaxa });
        if (local.length) return local;
    }
    if (nodes.length <= localTargetTaxa) return nodes;
    if (typeof routeTaxonomy !== 'function') {
        if (nodes.length <= maxTaxa) return nodes;
        throw new Error(`Builder 2 large taxonomy (${nodes.length}) requires routeTaxonomy().`);
    }

    const byId = new Map(nodes.map(node => [node.taxonId, node]));
    const kids = childrenMap(nodes);
    let frontier = kids.get('__ROOT__') || [];
    const ancestors = new Set();
    let depth = 0;

    while (depth++ < maxDepth) {
        if (!frontier.length) break;
        const chosenIds = await routeCandidateChunks({
            entries,
            candidates: frontier,
            routeTaxonomy,
            limit: routeCandidateLimit,
            signal,
        });
        if (!chosenIds.length) throw new Error('Builder 2 taxonomy router returned no legal branch.');

        const union = new Set();
        for (const id of chosenIds) {
            union.add(id);
            for (const descendant of descendants(id, kids)) union.add(descendant);
        }
        for (const id of ancestors) union.add(id);
        if (union.size <= maxTaxa) {
            return [...union]
                .map(id => byId.get(id))
                .filter(Boolean)
                .sort((a, b) => a.taxonId.localeCompare(b.taxonId));
        }

        const next = [];
        for (const id of chosenIds) {
            ancestors.add(id);
            const children = kids.get(id) || [];
            if (children.length) next.push(...children);
            else next.push(byId.get(id));
        }
        frontier = next.filter(Boolean);
    }

    // Fail closed rather than silently truncate taxonomy eligibility. A caller
    // can lower its slice size or provide a more discriminating router.
    throw new Error(`Builder 2 taxonomy routing could not reduce candidate window below ${maxTaxa} taxa.`);
}

function validateRaw(raw, source, taxonomy, allowedTaxa) {
    if (raw?.path || raw?.newNodeLabel || raw?.parentNodeId) {
        throw new Error(`Builder 2 classifier ${source.sourceKey} attempted to invent structure.`);
    }
    const knownById = new Map(taxonomy.nodes.map(node => [node.taxonId, node]));
    const known = new Set(knownById.keys());
    const allowed = new Set(allowedTaxa.map(node => node.taxonId));
    const decision = clean(raw?.decision);
    if (decision === BUILDER2_CLASSIFICATION_DECISION.CLASSIFIED) {
        if (!known.has(clean(raw.taxonId))) throw new Error(`Builder 2 classifier ${source.sourceKey} chose unknown taxon ${raw.taxonId}.`);
        if (!allowed.has(clean(raw.taxonId))) throw new Error(`Builder 2 classifier ${source.sourceKey} escaped its routed taxonomy window with ${raw.taxonId}.`);
        if (knownById.get(clean(raw.taxonId))?.entryPolicy === 'container-only') throw new Error(`Builder 2 classifier ${source.sourceKey} chose container-only taxon ${raw.taxonId}.`);
    }
    for (const candidate of raw?.candidates || []) {
        if (!known.has(clean(candidate.taxonId))) throw new Error(`Builder 2 classifier ${source.sourceKey} proposed unknown candidate ${candidate.taxonId}.`);
        if (!allowed.has(clean(candidate.taxonId))) throw new Error(`Builder 2 classifier ${source.sourceKey} proposed candidate outside its routed taxonomy window: ${candidate.taxonId}.`);
    }
    return createBuilder2Classification({
        sourceKey: source.sourceKey,
        sourceFingerprint: source.fingerprint,
        taxonomyRevision: taxonomy.revisionId,
        classificationRevision: taxonomy.classificationRevisionId,
        decision,
        taxonId: raw?.taxonId,
        candidates: raw?.candidates,
        reason: raw?.reason,
        confidence: raw?.confidence,
        metadata: { semantic: true, routedTaxonCount: allowedTaxa.length },
    });
}

function classificationRequest(slice, index) {
    return {
        sliceIndex: index,
        slice,
        entries: slice.map((source, entryIndex) => ({
            ref: `R${entryIndex + 1}`,
            sourceKey: source.sourceKey,
            title: source.title,
            keys: compactKeys(source.keys, source.content ? 24 : 36),
            content: source.content,
        })),
    };
}

export async function classifyBuilder2Sources({
    sources = [],
    taxonomy,
    classifySlice,
    classifySlices = null,
    routeTaxonomy = null,
    maxEntries = 24,
    semanticInputTargetTokens = null,
    maxTaxa = 96,
    routeCandidateLimit = 48,
    signal = null,
    onlySourceKeys = null,
} = {}) {
    if (typeof classifySlice !== 'function' && typeof classifySlices !== 'function') {
        throw new Error('Builder 2 classification requires classifySlice() or classifySlices().');
    }

    const filter = onlySourceKeys ? new Set(onlySourceKeys) : null;
    const rows = (sources || []).filter(source => active(source) && (!filter || filter.has(source.sourceKey)));
    const local = rows.filter(locallyStructural).map(source => createBuilder2Classification({
        sourceKey: source.sourceKey, sourceFingerprint: source.fingerprint,
        taxonomyRevision: taxonomy.revisionId, classificationRevision: taxonomy.classificationRevisionId,
        decision: BUILDER2_CLASSIFICATION_DECISION.TAXONOMY_GAP, taxonId: null, candidates: [], confidence: 1,
        reason: 'local-structural-empty-record',
        metadata: { resolvedDisposition: 'nonsemantic', localStructuralDisposition: true, semanticReplay: false },
    }));
    const semanticRows = rows.filter(source => !locallyStructural(source));
    if (!semanticRows.length) return local;
    const packed = packBuilder2SemanticSources(semanticRows, { maxEntries, targetInputTokens: semanticInputTargetTokens });
    const requests = packed.slices.map(slice => classificationRequest(slice.entries, slice.index));

    // Taxonomy-window calculation is read-only for each source slice, so it is
    // safe to prepare windows concurrently. Any deeper taxonomy routing still
    // resolves each depth before descending further.
    const prepared = await Promise.all(requests.map(async request => {
        if (signal?.aborted) throw signal.reason || new DOMException('Aborted', 'AbortError');
        const window = await selectBuilder2TaxonomyWindow({
            entries: request.entries,
            taxonomy,
            routeTaxonomy,
            maxTaxa,
            routeCandidateLimit,
            signal,
        });
        return {
            ...request,
            taxonomy: window.map(nodeView),
            taxonomyWindow: window,
            taxonomyRevision: taxonomy.revisionId,
            classificationRevision: taxonomy.classificationRevisionId,
        };
    }));

    let rawResults = [];
    if (typeof classifySlices === 'function' && prepared.length > 1) {
        rawResults = await classifySlices({
            slices: prepared.map(({ slice, taxonomyWindow, ...request }) => request),
            signal,
        });
        if (!Array.isArray(rawResults) || rawResults.length !== prepared.length) {
            throw new Error('Builder 2 batched classification must return one result per supplied slice.');
        }
    } else {
        if (typeof classifySlice !== 'function') throw new Error('Builder 2 single-slice classification fallback requires classifySlice().');
        for (const request of prepared) {
            if (signal?.aborted) throw signal.reason || new DOMException('Aborted', 'AbortError');
            rawResults.push(await classifySlice({
                entries: request.entries,
                taxonomy: request.taxonomy,
                taxonomyRevision: request.taxonomyRevision,
                classificationRevision: request.classificationRevision,
                signal,
            }));
        }
    }

    const results = [];
    for (let index = 0; index < prepared.length; index += 1) {
        const request = prepared[index];
        const raw = rawResults[index];
        const byRef = new Map((raw?.classifications || []).map(row => [clean(row.ref), row]));
        for (let entryIndex = 0; entryIndex < request.slice.length; entryIndex += 1) {
            const row = byRef.get(`R${entryIndex + 1}`);
            if (!row) throw new Error(`Builder 2 classification slice omitted R${entryIndex + 1}.`);
            results.push(validateRaw(row, request.slice[entryIndex], taxonomy, request.taxonomyWindow));
        }
    }
    const bySource = new Map([...local, ...results].map(row => [row.sourceKey, row]));
    return rows.map(source => bySource.get(source.sourceKey)).filter(Boolean);
}

export function applyBuilder2ClassificationReview(classifications, decisions = {}, taxonomy) {
    const knownById = new Map(taxonomy.nodes.map(node => [node.taxonId, node]));
    const known = new Set(knownById.keys());
    return classifications.map(row => {
        const decision = decisions[row.sourceKey];
        if (!decision) return row;
        // A review disposition is operator authority.  Never allow an older
        // deferred/non-semantic marker to survive a later explicit decision.
        const { resolvedDisposition: _oldDisposition, operatorDeferred: _oldDeferred, ...baseMetadata } = row.metadata || {};
        if (decision.action === 'map') {
            if (!known.has(clean(decision.taxonId))) throw new Error(`Unknown manual-map taxon ${decision.taxonId}.`);
            if (knownById.get(clean(decision.taxonId))?.entryPolicy === 'container-only') throw new Error(`Manual placement cannot target container-only taxon ${decision.taxonId}.`);
            return createBuilder2Classification({
                ...row,
                decision: BUILDER2_CLASSIFICATION_DECISION.CLASSIFIED,
                taxonId: decision.taxonId,
                candidates: [],
                reason: decision.reason || 'operator-map',
                confidence: 1,
                metadata: { ...baseMetadata, manualOverride: true },
            });
        }
        if (decision.action === 'gap') {
            return createBuilder2Classification({
                ...row,
                decision: BUILDER2_CLASSIFICATION_DECISION.TAXONOMY_GAP,
                taxonId: null,
                candidates: [],
                reason: decision.reason || 'operator-gap',
                metadata: { ...baseMetadata, manualOverride: true },
            });
        }
        if (decision.action === 'exclude') {
            return createBuilder2Classification({
                ...row,
                decision: row.decision === BUILDER2_CLASSIFICATION_DECISION.CLASSIFIED ? BUILDER2_CLASSIFICATION_DECISION.TAXONOMY_GAP : row.decision,
                taxonId: null,
                candidates: [],
                reason: decision.reason || 'operator-nonsemantic',
                confidence: 1,
                metadata: { ...baseMetadata, manualOverride: true, resolvedDisposition: 'nonsemantic' },
            });
        }
        if (decision.action === 'defer') {
            // "Decide later" is a real disposition for this run, not a no-op.
            // The semantic result is retained for future review, but quality and
            // materialization may continue without inventing placement authority.
            return createBuilder2Classification({
                ...row,
                metadata: { ...baseMetadata, manualOverride: true, operatorDeferred: true, resolvedDisposition: 'deferred' },
            });
        }
        throw new Error(`Unknown classification review action ${decision.action}.`);
    });
}
