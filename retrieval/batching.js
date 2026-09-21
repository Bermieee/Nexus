import { estimateContentTokens } from '../observability/token-estimator.js';

function normalizeTarget(value, fallback = 6000) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.max(256, Math.round(n)) : fallback;
}

const TREE_REF_PREFIX = /^\s*\[book="(?:[^"\\]|\\.)*"\s+node="(?:[^"\\]|\\.)*"(?:\s+region="(?:[^"\\]|\\.)*")?\]/;

export function isTreeOverviewUnitHeader(line='') { return TREE_REF_PREFIX.test(String(line||'')); }

export function overviewUnits(overview = '') {
    const lines = String(overview || '').split(/\r?\n/);
    const units = [];
    let bookHeader = '';
    let current = null;
    const push = () => {
        if (!current) return;
        const body = current.lines.join('\n').trim();
        if (body) units.push({ bookHeader: current.bookHeader, text: body });
        current = null;
    };
    for (const raw of lines) {
        const line = String(raw || '');
        if (/^Lorebook:\s*/.test(line)) {
            push();
            bookHeader = line.trim();
            continue;
        }
        if (isTreeOverviewUnitHeader(line)) {
            push();
            current = { bookHeader, lines: [line] };
            continue;
        }
        if (!line.trim()) {
            push();
            continue;
        }
        if (!current) current = { bookHeader, lines: [] };
        current.lines.push(line);
    }
    push();
    if (!units.length && String(overview || '').trim()) units.push({ bookHeader: '', text: String(overview).trim() });
    return units;
}

function renderUnits(units = []) {
    const out = [];
    let previousHeader = null;
    for (const unit of units) {
        const header = String(unit.bookHeader || '');
        if (header && header !== previousHeader) out.push(header);
        out.push(unit.text);
        previousHeader = header;
    }
    return out.join('\n').trim();
}

function splitOversizeUnit(unit, { buildPrompt, targetInputTokens, model }) {
    const target = normalizeTarget(targetInputTokens);
    const raw = String(unit.text || '');
    const lines = raw.split(/\r?\n/);
    let anchor = '';
    let body = '';
    let continuationPrefix = '';

    if (lines.length > 1) {
        anchor = lines[0];
        body = lines.slice(1).join('\n');
        continuationPrefix = '\n';
    } else {
        const match = raw.match(/^(\s*\[book="(?:[^"\\]|\\.)*"\s+node="(?:[^"\\]|\\.)*"(?:\s+region="(?:[^"\\]|\\.)*")?\])(.*)$/s);
        if (match) {
            anchor = match[1];
            body = match[2];
        } else {
            body = raw;
        }
    }

    if (!body) return [unit];
    const codepoints = Array.from(body);
    const chunks = [];
    let cursor = 0;
    const renderPiece = (piece) => `${anchor}${continuationPrefix}${piece}`;
    const fits = (piece) => estimateContentTokens(buildPrompt(renderUnits([{ bookHeader: unit.bookHeader, text: renderPiece(piece) }])), model) <= target;

    while (cursor < codepoints.length) {
        let lo = cursor + 1;
        let hi = codepoints.length;
        let best = cursor;
        while (lo <= hi) {
            const mid = Math.floor((lo + hi) / 2);
            const piece = codepoints.slice(cursor, mid).join('');
            if (fits(piece)) {
                best = mid;
                lo = mid + 1;
            } else {
                hi = mid - 1;
            }
        }
        if (best <= cursor) {
            const error = new Error('Nexus retrieval cannot pack even one Tree codepoint inside the requested input target.');
            error.name = 'NexusPhysicalPackingError';
            throw error;
        }
        const piece = codepoints.slice(cursor, best).join('');
        chunks.push({ bookHeader: unit.bookHeader, text: renderPiece(piece) });
        cursor = best;
    }
    return chunks.length ? chunks : [unit];
}

/**
 * Pack a Tree overview into Sidecar prompts whose estimated total input stays
 * near the configured target. The buildPrompt callback must include the shared
 * scene envelope/system instructions so repeated overhead is counted.
 */
export function buildOverviewBatches({ overview = '', buildPrompt, targetInputTokens = 6000, model = '' } = {}) {
    if (typeof buildPrompt !== 'function') throw new TypeError('Nexus overview batching requires buildPrompt().');
    const target = normalizeTarget(targetInputTokens);
    const initialUnits = overviewUnits(overview);
    const units = [];
    for (const unit of initialUnits) {
        const tokens = estimateContentTokens(buildPrompt(renderUnits([unit])), model);
        if (tokens > target) units.push(...splitOversizeUnit(unit, { buildPrompt, targetInputTokens: target, model }));
        else units.push(unit);
    }

    const batches = [];
    let current = [];
    const flush = () => {
        if (!current.length) return;
        const treeText = renderUnits(current);
        const prompt = buildPrompt(treeText);
        batches.push({
            index: batches.length,
            treeText,
            prompt,
            estimatedInputTokens: estimateContentTokens(prompt, model),
            unitCount: current.length,
        });
        current = [];
    };

    for (const unit of units) {
        const candidate = [...current, unit];
        const candidateText = renderUnits(candidate);
        const candidatePrompt = buildPrompt(candidateText);
        const tokens = estimateContentTokens(candidatePrompt, model);
        if (current.length && tokens > target) {
            flush();
            current = [unit];
        } else {
            current = candidate;
        }
    }
    flush();

    // Avoid a tiny serial tail batch only when the merge still respects the
    // configured physical packing target. Oversized units must never be
    // recombined into a prompt larger than the boundary that split them.
    if (batches.length > 1) {
        const last = batches[batches.length - 1];
        const previous = batches[batches.length - 2];
        if (last.estimatedInputTokens < target * 0.55) {
            const mergedText = `${previous.treeText}\n${last.treeText}`.trim();
            const mergedPrompt = buildPrompt(mergedText);
            const mergedTokens = estimateContentTokens(mergedPrompt, model);
            if (mergedTokens <= target) {
                batches.splice(batches.length - 2, 2, {
                    index: batches.length - 2,
                    treeText: mergedText,
                    prompt: mergedPrompt,
                    estimatedInputTokens: mergedTokens,
                    unitCount: previous.unitCount + last.unitCount,
                });
            }
        }
    }
    return batches.map((batch, index) => ({ ...batch, index }));
}

export function batchTokenSummary(batches = []) {
    const values = (batches || []).map(batch => Number(batch?.estimatedInputTokens) || 0);
    return {
        count: values.length,
        totalEstimatedInputTokens: values.reduce((sum, value) => sum + value, 0),
        maxEstimatedInputTokens: values.length ? Math.max(...values) : 0,
        minEstimatedInputTokens: values.length ? Math.min(...values) : 0,
    };
}
