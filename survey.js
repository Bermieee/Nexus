import { builder2Fingerprint, clean } from './contracts.js';
import { packBuilder2SemanticSources } from './semantic-packing.js';

function active(source) {
    return !source.disabled && !source.removed;
}

function compactSurveyKeys(keys = [], limit = 24) {
    const seen = new Set(), out = [];
    for (const value of keys || []) {
        const key = String(value ?? '').trim(), norm = key.toLocaleLowerCase();
        if (!key || seen.has(norm)) continue;
        seen.add(norm); out.push(key);
        if (out.length >= limit) break;
    }
    return out;
}

export function buildBuilder2SurveySlices(sources = [], { maxEntries = 24, maxChars = 24000, targetInputTokens = null } = {}) {
    const rows = (sources || []).filter(active);
    return packBuilder2SemanticSources(rows, { maxEntries, maxChars, targetInputTokens }).slices.map(slice => slice.entries);
}

function normalizeContribution(raw, slice, index) {
    const allowed = new Set(slice.map(source => source.sourceKey));
    const themes = (raw?.themes || []).map((theme, themeIndex) => ({
        themeId: clean(theme.themeId) || `survey_${index}_${themeIndex}`,
        label: clean(theme.label),
        purpose: clean(theme.purpose),
        aliases: [...new Set((theme.aliases || []).map(clean).filter(Boolean))],
        evidenceSourceKeys: [...new Set((theme.evidenceSourceKeys || []).map(clean).filter(key => allowed.has(key)))],
    })).filter(theme => theme.label && theme.evidenceSourceKeys.length);
    return {
        sliceIndex: index,
        sourceKeys: slice.map(source => source.sourceKey),
        themes,
        notes: clean(raw?.notes),
    };
}

function surveyRequest(slice, index) {
    return {
        sliceIndex: index,
        entries: slice.map((source, entryIndex) => ({
            ref: `R${entryIndex + 1}`,
            sourceKey: source.sourceKey,
            title: source.title,
            keys: compactSurveyKeys(source.keys, source.content ? 24 : 36),
            content: source.content,
        })),
        sourceKeys: slice.map(source => source.sourceKey),
    };
}

export async function surveyBuilder2Corpus({
    sources = [],
    analyzeSlice,
    analyzeSlices = null,
    maxEntries = 24,
    maxChars = 24000,
    targetInputTokens = null,
    signal = null,
} = {}) {
    if (typeof analyzeSlice !== 'function' && typeof analyzeSlices !== 'function') {
        throw new Error('Builder 2 survey requires analyzeSlice() or analyzeSlices().');
    }

    const slices = buildBuilder2SurveySlices(sources, { maxEntries, maxChars, targetInputTokens });
    const requests = slices.map(surveyRequest);
    let rawResults = [];

    // The production Nexus adapter supplies analyzeSlices(), which sends all
    // independent survey slices to the real Nexus Batch Layer in one
    // scatter/gather operation. Keep the single-slice callback as a contract
    // fallback for tests/custom semantic adapters.
    if (typeof analyzeSlices === 'function' && requests.length > 1) {
        if (signal?.aborted) throw signal.reason || new DOMException('Aborted', 'AbortError');
        rawResults = await analyzeSlices({ slices: requests, signal });
        if (!Array.isArray(rawResults) || rawResults.length !== requests.length) {
            throw new Error('Builder 2 batched survey must return one result per supplied slice.');
        }
    } else {
        if (typeof analyzeSlice !== 'function') throw new Error('Builder 2 single-slice survey fallback requires analyzeSlice().');
        for (const request of requests) {
            if (signal?.aborted) throw signal.reason || new DOMException('Aborted', 'AbortError');
            rawResults.push(await analyzeSlice({ ...request, signal }));
        }
    }

    const contributions = rawResults.map((raw, index) => normalizeContribution(raw, slices[index], index));
    const merged = new Map();
    for (const contribution of contributions) {
        for (const theme of contribution.themes) {
            const key = theme.label.toLocaleLowerCase();
            const previous = merged.get(key) || {
                label: theme.label,
                purpose: theme.purpose,
                aliases: new Set(),
                evidence: new Set(),
            };
            for (const alias of theme.aliases) previous.aliases.add(alias);
            for (const evidence of theme.evidenceSourceKeys) previous.evidence.add(evidence);
            if (!previous.purpose && theme.purpose) previous.purpose = theme.purpose;
            merged.set(key, previous);
        }
    }

    const semanticMap = [...merged.values()].map(value => ({
        label: value.label,
        purpose: value.purpose,
        aliases: [...value.aliases].sort(),
        evidenceSourceKeys: [...value.evidence].sort(),
    })).sort((a, b) => a.label.localeCompare(b.label));

    return {
        contributions,
        semanticMap,
        sliceCount: slices.length,
        sourceCount: (sources || []).filter(active).length,
        surveyFingerprint: `survey:${builder2Fingerprint({ contributions, semanticMap })}`,
    };
}
