import { estimateContentTokens } from '../observability/token-estimator.js';
import { resolveNexusSidecarResourcePolicy } from './resource-policy.js';

export const LOGICAL_SOFT_PACKING_TARGET = 16000;

export function hashLogicalSource(text = '') {
    const value = String(text ?? '');
    let h = 2166136261 >>> 0;
    for (let i = 0; i < value.length; i += 1) {
        h ^= value.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * Resolve a conservative physical prompt target. 16k is only a soft logical
 * packing trigger; the actual payload target reserves room for invariant
 * prompt text, schema/instructions, provider wrapping, output, provenance and
 * estimator tolerance before any slice is built.
 */
export function resolvePhysicalPackingBudget({
    role = '',
    stage = '',
    domain = '',
    phase = '',
    requestedMaxTokens = null,
    systemPrompt = '',
    sliceInstructions = '',
    fixedPromptTokens = 0,
    providerEnvelopeTokens = 320,
    expectedOutputTokens = null,
    aggregationMetadataTokens = 192,
    estimatorToleranceTokens = 256,
    extraReserveTokens = 0,
    settings = null,
} = {}) {
    const resolved = resolveNexusSidecarResourcePolicy({
        role,
        stage,
        domain,
        phase,
        requestedMaxTokens,
        settings: settings || {},
    });
    const inputBudget = Number(resolved.softInputTargetTokens ?? resolved.inputBudgetTokens) || LOGICAL_SOFT_PACKING_TARGET;
    const outputAllowance = Math.max(0, Math.floor(Number(expectedOutputTokens ?? resolved.softOutputTargetTokens ?? resolved.outputCeilingTokens) || 0));
    const invariantTokens = estimateContentTokens(`${systemPrompt || ''}\n${sliceInstructions || ''}`) + Math.max(0, Math.floor(Number(fixedPromptTokens) || 0));
    const reserveTokens = invariantTokens
        + Math.max(0, Math.floor(Number(providerEnvelopeTokens) || 0))
        + outputAllowance
        + Math.max(0, Math.floor(Number(aggregationMetadataTokens) || 0))
        + Math.max(0, Math.floor(Number(estimatorToleranceTokens) || 0))
        + Math.max(0, Math.floor(Number(extraReserveTokens) || 0));
    const promptTargetTokens = Math.max(1200, Math.min(LOGICAL_SOFT_PACKING_TARGET, inputBudget - reserveTokens));
    return {
        promptTargetTokens,
        inputBudgetTokens: inputBudget,
        outputAllowanceTokens: outputAllowance,
        invariantTokens,
        reserveTokens,
        resourcePolicy: resolved,
    };
}

export function physicalPackingTarget(options = {}) {
    return resolvePhysicalPackingBudget(options).promptTargetTokens;
}

function sentencePieces(text = '') {
    const raw = String(text || '').trim();
    if (!raw) return [];
    const paragraphs = raw.split(/\n\s*\n/).map(value => value.trim()).filter(Boolean);
    const output = [];
    for (const paragraph of paragraphs) {
        if (estimateContentTokens(paragraph) <= 1200) {
            output.push(paragraph);
            continue;
        }
        const sentences = paragraph.match(/[^.!?\n]+(?:[.!?]+|$)/g)?.map(value => value.trim()).filter(Boolean) || [];
        if (sentences.length > 1) output.push(...sentences);
        else {
            const lines = paragraph.split(/\n+/).map(value => value.trim()).filter(Boolean);
            if (lines.length > 1) output.push(...lines);
            else output.push(paragraph);
        }
    }
    return output;
}


function splitByCodepointBoundary(source, fits) {
    let remaining=[...String(source||'')];
    const rows=[];
    while(remaining.length){
        const whole=remaining.join('');if(fits(whole)){rows.push(whole);break;}
        let low=1,high=remaining.length,best=0;
        while(low<=high){const mid=Math.floor((low+high)/2),candidate=remaining.slice(0,mid).join('');if(fits(candidate)){best=mid;low=mid+1;}else high=mid-1;}
        if(best<=0){const error=new Error('Nexus cannot pack even one source codepoint inside the resolved physical prompt target.');error.name='NexusPhysicalPackingError';throw error;}
        rows.push(remaining.slice(0,best).join(''));remaining=remaining.slice(best);
    }
    return rows;
}

function splitOversizedPiece(piece, fits) {
    const source = String(piece || '').trim();
    if (!source) return [];
    if (fits(source)) return [source];
    const words = source.split(/\s+/).filter(Boolean);
    if (words.length <= 1) return splitByCodepointBoundary(source, fits);
    const rows = [];
    let current = '';
    for (const word of words) {
        const next = current ? `${current} ${word}` : word;
        if (fits(next)) current = next;
        else {
            if (!current) { rows.push(...splitByCodepointBoundary(word, fits)); current = ''; continue; }
            rows.push(current);
            current = word;
            if (!fits(current)) { rows.push(...splitByCodepointBoundary(current, fits)); current = ''; }
        }
    }
    if (current) rows.push(current);
    return rows;
}

/** Split prose at semantic boundaries while proving every built prompt fits. */
export function sliceSemanticText({ text = '', buildPrompt, targetTokens, label = 'logical source' } = {}) {
    if (typeof buildPrompt !== 'function') throw new Error('sliceSemanticText requires buildPrompt.');
    const target = Math.max(1200, Math.floor(Number(targetTokens) || LOGICAL_SOFT_PACKING_TARGET));
    const rawPieces = sentencePieces(text);
    if (!rawPieces.length) return [];
    const fixedPromptTokens = estimateContentTokens(buildPrompt(''));
    // A planning target can be smaller than immutable prompt/baseline overhead
    // (notably a large Notebook baseline). In that case no source codepoint can
    // possibly make the prompt fit, so preserve the semantic source instead of
    // throwing or clipping it. Real provider boundaries are enforced separately.
    if (fixedPromptTokens > target) {
        return rawPieces.map((content, index) => ({
            index, content,
            estimatedInputTokens: estimateContentTokens(buildPrompt(content)),
            targetTokens: target,
            softTargetExceeded: true,
        }));
    }
    const fits = candidate => estimateContentTokens(buildPrompt(candidate)) <= target;
    const pieces = rawPieces.flatMap(piece => splitOversizedPiece(piece, fits));
    const slices = [];
    let current = '';
    for (const piece of pieces) {
        const next = current ? `${current}\n\n${piece}` : piece;
        if (fits(next)) current = next;
        else {
            if (!current) { slices.push(piece); current = ''; continue; }
            slices.push(current);
            current = piece;
        }
    }
    if (current) slices.push(current);
    return slices.map((content, index) => ({
        index,
        content,
        estimatedInputTokens: estimateContentTokens(buildPrompt(content)),
        targetTokens: target,
        softTargetExceeded: estimateContentTokens(buildPrompt(content)) > target,
    }));
}

/** Chronological message packing. Each source message remains whole whenever possible. */
export function sliceChronologicalRows({ rows = [], renderRow, buildPrompt, targetTokens, label = 'message range' } = {}) {
    if (typeof renderRow !== 'function' || typeof buildPrompt !== 'function') throw new Error('sliceChronologicalRows requires renderRow and buildPrompt.');
    const target = Math.max(1200, Math.floor(Number(targetTokens) || LOGICAL_SOFT_PACKING_TARGET));
    const normalized = (Array.isArray(rows) ? rows : []).map((row, index) => ({ ...row, __logicalIndex: index }));
    const slices = [];
    let current = [];
    const fits = candidateRows => estimateContentTokens(buildPrompt(candidateRows.map(renderRow).join('\n\n'), candidateRows)) <= target;
    const pushCurrent = () => {
        if (!current.length) return;
        const passage = current.map(renderRow).join('\n\n');
        slices.push({
            index: slices.length,
            rows: current,
            passage,
            estimatedInputTokens: estimateContentTokens(buildPrompt(passage, current)),
            targetTokens: target,
        });
        current = [];
    };
    for (const row of normalized) {
        if (fits([...current, row])) { current.push(row); continue; }
        pushCurrent();
        if (fits([row])) { current.push(row); continue; }
        const rendered = renderRow(row);
        const fragments = sliceSemanticText({
            text: String(row.text ?? rendered),
            buildPrompt: fragment => buildPrompt(renderRow({ ...row, text: fragment, fragment: true }), [{ ...row, text: fragment, fragment: true }]),
            targetTokens: target,
            label,
        });
        for (const fragment of fragments) {
            slices.push({
                index: slices.length,
                rows: [{ ...row, text: fragment.content, fragment: true }],
                passage: renderRow({ ...row, text: fragment.content, fragment: true }),
                estimatedInputTokens: fragment.estimatedInputTokens,
                targetTokens: target,
            });
        }
    }
    pushCurrent();
    return slices;
}

/** Pack already-validated semantic objects into bounded aggregation groups. */
export function packValidatedItems({ items = [], buildPrompt, targetTokens, label = 'aggregation input' } = {}) {
    if (typeof buildPrompt !== 'function') throw new Error('packValidatedItems requires buildPrompt.');
    const target = Math.max(1200, Math.floor(Number(targetTokens) || LOGICAL_SOFT_PACKING_TARGET));
    const source = Array.isArray(items) ? items : [];
    const groups = [];
    let current = [];
    const fits = rows => estimateContentTokens(buildPrompt(rows)) <= target;
    for (const item of source) {
        const next = [...current, item];
        if (fits(next)) { current = next; continue; }
        if (current.length) groups.push(current);
        current = [];
        current = [item];
    }
    if (current.length) groups.push(current);
    return groups.map((rows, index) => {
        const estimatedInputTokens = estimateContentTokens(buildPrompt(rows));
        return {
            index,
            items: rows,
            estimatedInputTokens,
            targetTokens: target,
            softTargetExceeded: estimatedInputTokens > target,
        };
    });
}

/**
 * Historical callers use this helper after reshaping. The target is now soft:
 * crossing it is observable but never a workload rejection. A caller may pass
 * a real hardLimitTokens only when it represents provider/context capacity.
 */
export function assertPhysicalPromptBounded(prompt, targetTokens, label = 'Sidecar request', { hardLimitTokens = null } = {}) {
    const estimated = estimateContentTokens(String(prompt || ''));
    const hard = Number(hardLimitTokens);
    if (Number.isFinite(hard) && hard > 0 && estimated > hard) {
        const error = new Error(`${label} exceeds the real provider/context boundary (${estimated} estimated input tokens / ${Math.floor(hard)} allowed).`);
        error.name = 'NexusSidecarProviderBoundaryError';
        error.estimatedInputTokens = estimated;
        error.hardLimitTokens = Math.floor(hard);
        throw error;
    }
    return estimated;
}
