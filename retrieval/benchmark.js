function refKey(ref = {}) { return `${String(ref.book || '')}\u0000${Number(ref.uid)}`; }
function keySet(refs = []) { return new Set((Array.isArray(refs) ? refs : []).map(refKey)); }
function orderedKeys(refs = []) { return (Array.isArray(refs) ? refs : []).map(refKey); }

export function precisionAtK(ranked = [], relevant = [], k = ranked.length) {
    const limit = Math.max(0, Math.min(Number(k) || 0, ranked.length));
    if (!limit) return 0;
    const truth = keySet(relevant);
    return orderedKeys(ranked).slice(0, limit).filter(key => truth.has(key)).length / limit;
}

export function recallAtK(ranked = [], relevant = [], k = ranked.length) {
    const truth = keySet(relevant);
    if (!truth.size) return 1;
    const selected = new Set(orderedKeys(ranked).slice(0, Math.max(0, Number(k) || 0)));
    let hits = 0;
    for (const key of truth) if (selected.has(key)) hits += 1;
    return hits / truth.size;
}

export function buildRetrievalBenchmarkRecord({
    caseId = '', knownRelevant = [], critical = [], distractors = [], baseline = [], shadow = [], selected = [], published = [],
    k = 5, latencyMs = 0, usage = null, estimatedCost = null, mainContextTokenImpact = null,
} = {}) {
    const criticalSet = keySet(critical);
    const publishedSet = keySet(published);
    const selectedSet = keySet(selected);
    const distractorSet = keySet(distractors);
    const topShadow = new Set(orderedKeys(shadow).slice(0, Math.max(0, Number(k) || 0)));
    return {
        caseId: String(caseId || ''), k: Math.max(0, Number(k) || 0),
        labels: { knownRelevant: knownRelevant.length, critical: critical.length, distractors: distractors.length },
        baseline: { precisionAtK: precisionAtK(baseline, knownRelevant, k), recallAtK: recallAtK(baseline, knownRelevant, k) },
        shadow: { precisionAtK: precisionAtK(shadow, knownRelevant, k), recallAtK: recallAtK(shadow, knownRelevant, k) },
        criticalMisses: [...criticalSet].filter(key => !topShadow.has(key)),
        irrelevantSelections: [...selectedSet].filter(key => distractorSet.has(key)),
        irrelevantActualInjections: [...publishedSet].filter(key => distractorSet.has(key)),
        selectionCount: selectedSet.size,
        publicationCount: publishedSet.size,
        latencyMs: Math.max(0, Number(latencyMs) || 0),
        usage: usage || null,
        estimatedCost: estimatedCost == null ? null : Number(estimatedCost),
        mainContextTokenImpact: mainContextTokenImpact == null ? null : Number(mainContextTokenImpact),
    };
}
