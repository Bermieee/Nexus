import { estimateContentTokens } from '../observability/token-estimator.js';
import { parseStructuredJsonCandidate } from './normalize-response.js';

/**
 * Nexus Multi-Sidecar Bus helpers.
 *
 * This module is intentionally pure: it does not call models or mutate state.
 * The router/workload broker owns execution so Sidecars never recursively invoke
 * one another and the main RP model is never part of Sidecar coordination.
 */

export const SIDECAR_EXECUTION_MODE = Object.freeze({
    ADAPTIVE: 'adaptive',
    PARALLEL: 'parallel',
    CASCADE_AB: 'cascade-ab',
    CASCADE_BA: 'cascade-ba',
    CONSENSUS: 'consensus',
});

export function normalizeExecutionMode(value) {
    const mode = String(value || '').trim().toLowerCase();
    if (!mode) return SIDECAR_EXECUTION_MODE.ADAPTIVE;
    if (Object.values(SIDECAR_EXECUTION_MODE).includes(mode)) return mode;
    const error = new Error(`Unsupported Nexus Sidecar execution mode: ${String(value)}`);
    error.name = 'TV2InvalidExecutionMode';
    error.executionMode = String(value);
    throw error;
}

export function isMultiExecutionMode(mode) {
    return normalizeExecutionMode(mode) !== SIDECAR_EXECUTION_MODE.ADAPTIVE;
}

function clipTextByTokens(text, maxTokens) {
    const raw = String(text ?? '');
    const cap = Number(maxTokens);
    if (!Number.isFinite(cap) || cap <= 0 || estimateContentTokens(raw) <= cap) return { text: raw, truncated: false };
    let low = 0;
    let high = raw.length;
    while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (estimateContentTokens(raw.slice(0, mid)) <= cap) low = mid;
        else high = mid - 1;
    }
    return { text: raw.slice(0, Math.max(0, low)).trimEnd(), truncated: true };
}

function serializeCandidateValue(value) {
    if (typeof value === 'string') return value;
    try { return JSON.stringify(value); }
    catch { return String(value ?? ''); }
}

/**
 * Convert a worker response into the bounded candidate supplied to a second
 * worker. Structured work is parsed before synthesis; raw provider response and
 * reasoning are never copied into a review prompt.
 */
export function buildSynthesisCandidate(result = {}, {
    parseCandidate = null,
    structured = false,
    maxTokens = 2400,
    label = 'candidate',
} = {}) {
    let parsed = null;
    let kind = 'final-text';
    let parseError = null;
    try {
        if (typeof parseCandidate === 'function') {
            parsed = parseCandidate(result?.text || '', result);
            kind = 'parsed';
        } else if (structured) {
            parsed = parseStructuredJsonCandidate(result?.text || '');
            kind = 'parsed-json';
        } else {
            try {
                parsed = parseStructuredJsonCandidate(result?.text || '');
                kind = 'parsed-json-auto';
            } catch { /* ordinary prose candidate */ }
        }
    } catch (error) {
        parseError = error;
    }

    if (structured && parseError) {
        return {
            kind: 'invalid-structured-candidate',
            text: JSON.stringify({ candidate: label, valid: false, reason: String(parseError?.message || parseError) }),
            truncated: false,
            softTargetExceeded: false,
            parseError: String(parseError?.message || parseError),
        };
    }

    const serialized = serializeCandidateValue(parsed !== null ? parsed : (result?.text || ''));
    const softTargetTokens = Number(maxTokens);
    const estimatedTokens = estimateContentTokens(serialized);
    // Candidate limits are packing preferences only. Never amputate a validated
    // candidate simply because it grew beyond the historical synthesis target.
    return {
        kind,
        text: serialized,
        truncated: false,
        softTargetExceeded: Number.isFinite(softTargetTokens) && softTargetTokens > 0 && estimatedTokens > softTargetTokens,
        estimatedTokens,
        softTargetTokens: Number.isFinite(softTargetTokens) && softTargetTokens > 0 ? Math.floor(softTargetTokens) : null,
        parseError: null,
    };
}

export function buildCascadePrompt({ originalPrompt = '', firstSlot, secondSlot, firstCandidate = '', firstText = '' } = {}) {
    const candidate = String(firstCandidate || firstText || '');
    return `Nexus WORKLOAD HANDOFF\n\nYou are Sidecar ${secondSlot}, the second worker in a broker-controlled ${firstSlot} → ${secondSlot} cascade.\nThe first worker cannot call you directly; Nexus is handing you its parsed/final candidate only. Provider thinking/reasoning is deliberately excluded.\n\nYour task:\n1. Re-evaluate the ORIGINAL TASK yourself.\n2. Use the FIRST WORKER CANDIDATE as evidence/advice, not as unquestionable truth.\n3. Correct omissions, contradictions, bad Tree/lore choices, or malformed output.\n4. Return ONE final answer that obeys the exact output/JSON format requested by the ORIGINAL TASK.\n5. Do not discuss this handoff unless the original task explicitly asks for process commentary.\n\nORIGINAL TASK\n${String(originalPrompt || '')}\n\nFIRST WORKER (${firstSlot}) CANDIDATE\n${candidate}\n\nReturn only the final answer required by the ORIGINAL TASK.`;
}

export function buildParallelSynthesisPrompt({ originalPrompt = '', candidateA = '', candidateB = '', resultA = {}, resultB = {}, mode = 'parallel' } = {}) {
    const consensus = normalizeExecutionMode(mode) === SIDECAR_EXECUTION_MODE.CONSENSUS;
    const directive = consensus
        ? `Reconcile the two independent workers. Prefer facts/actions supported by both. When they disagree, independently judge the disagreement from the ORIGINAL TASK and choose the better-supported result; do not invent a compromise merely to make them agree.`
        : `Combine the strongest non-conflicting information from both independent workers. Correct omissions or malformed output. Do not include duplicate facts/actions simply because both workers mentioned them.`;
    const a = String(candidateA || resultA?.text || '');
    const b = String(candidateB || resultB?.text || '');
    return `Nexus MULTI-SIDECAR ${consensus ? 'CONSENSUS REVIEW' : 'PARALLEL SYNTHESIS'}\n\nTwo independent Sidecars completed the same task. Nexus is asking you to produce the single final result consumed by the extension. Only parsed/final candidates are supplied; provider thinking/reasoning and raw response envelopes are excluded.\n\n${directive}\n\nRules:\n1. Re-evaluate the ORIGINAL TASK yourself.\n2. Preserve the exact output/JSON format requested by the ORIGINAL TASK.\n3. Do not mention Sidecar A, Sidecar B, synthesis, voting, or this review unless the original task explicitly requests process commentary.\n4. Return only the final answer required by the ORIGINAL TASK.\n\nORIGINAL TASK\n${String(originalPrompt || '')}\n\nSIDECAR A CANDIDATE\n${a}\n\nSIDECAR B CANDIDATE\n${b}\n\nReturn only the final answer required by the ORIGINAL TASK.`;
}

export function modeLabel(mode) {
    switch (normalizeExecutionMode(mode)) {
        case SIDECAR_EXECUTION_MODE.PARALLEL: return 'A + B parallel';
        case SIDECAR_EXECUTION_MODE.CASCADE_AB: return 'A → B cascade';
        case SIDECAR_EXECUTION_MODE.CASCADE_BA: return 'B → A cascade';
        case SIDECAR_EXECUTION_MODE.CONSENSUS: return 'A + B consensus';
        default: return 'Adaptive single worker';
    }
}
