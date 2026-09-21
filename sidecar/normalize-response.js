function firstTextPart(parts) {
    if (!Array.isArray(parts)) return '';
    return parts.map(p => typeof p === 'string' ? p : p?.text || '').filter(Boolean).join('');
}

function balancedJsonSlices(text = '') {
    // Linear, top-level-only scanner. Nexus accepts a complete provider final or
    // a disjoint top-level JSON value surrounded by prose/fences; it never walks
    // every opener or promotes a nested fragment out of an invalid outer answer.
    const raw = String(text || '');
    const rows = [];
    let start = -1;
    const stack = [];
    let inString = false;
    let escaped = false;
    for (let index = 0; index < raw.length; index += 1) {
        const char = raw[index];
        if (start < 0) {
            if (char !== '{' && char !== '[') continue;
            start = index;
            stack.push(char);
            inString = false;
            escaped = false;
            continue;
        }
        if (inString) {
            if (escaped) escaped = false;
            else if (char === '\\') escaped = true;
            else if (char === '"') inString = false;
            continue;
        }
        if (char === '"') { inString = true; continue; }
        if (char === '{' || char === '[') { stack.push(char); continue; }
        if (char !== '}' && char !== ']') continue;
        const expected = char === '}' ? '{' : '[';
        if (stack.at(-1) !== expected) {
            // Malformed outer candidate. Discard it as a unit; do not restart at
            // nested openers already consumed inside it.
            start = -1;
            stack.length = 0;
            inString = false;
            escaped = false;
            continue;
        }
        stack.pop();
        if (stack.length) continue;
        const slice = raw.slice(start, index + 1);
        try { rows.push({ start, end: index + 1, slice, value: JSON.parse(slice) }); } catch {}
        start = -1;
        inString = false;
        escaped = false;
    }
    return rows;
}

function validationVerdict(validator, value, meta = {}) {
    if (typeof validator !== 'function') return { valid: true, score: 0, value, reason: null };
    try {
        const raw = validator(value, meta);
        if (raw === true) return { valid: true, score: 1, value, reason: null };
        if (raw == null || raw === false) return { valid: false, score: 0, value, reason: 'Structured validator did not explicitly accept the payload.' };
        if (typeof raw === 'string') return { valid: false, score: 0, value, reason: raw };
        if (typeof raw === 'object') {
            const hasExplicitVerdict = raw.valid !== undefined || raw.passed !== undefined;
            const valid = hasExplicitVerdict && raw.valid !== false && raw.passed !== false && (raw.valid === true || raw.passed === true);
            return {
                valid,
                score: Number.isFinite(Number(raw.score)) ? Number(raw.score) : (valid ? 1 : 0),
                value: raw.value === undefined ? value : raw.value,
                reason: raw.reason ? String(raw.reason) : null,
                details: raw.details || raw.checks || null,
            };
        }
        return { valid: !!raw, score: raw ? 1 : 0, value, reason: raw ? null : 'Structured payload did not satisfy the expected domain contract.' };
    } catch (error) {
        return { valid: false, score: 0, value, reason: error?.message || String(error), error };
    }
}

const REJECTED_OUTPUT_SAMPLE_CHARS = 1600;
const REJECTED_CANDIDATE_SAMPLE_CHARS = 420;

function boundedRejectedSample(value, limit = REJECTED_OUTPUT_SAMPLE_CHARS) {
    const text = String(value ?? '');
    const cap = Math.max(160, Number(limit) || REJECTED_OUTPUT_SAMPLE_CHARS);
    if (text.length <= cap) return text;
    const half = Math.max(1, Math.floor((cap - 72) / 2));
    return `${text.slice(0, half)}\n… [${text.length - (half * 2)} rejected chars omitted] …\n${text.slice(-half)}`;
}

function semanticError(message, details = {}) {
    const error = new Error(message);
    error.name = 'NexusSemanticValidationError';
    error.semantic = true;
    error.validation = details;
    if (details?.rejectedOutputSample !== undefined) error.rejectedOutputSample = String(details.rejectedOutputSample || '');
    if (Number.isFinite(Number(details?.rejectedOutputChars))) error.rejectedOutputChars = Number(details.rejectedOutputChars);
    return error;
}

/**
 * Parse structured provider content without letting a nested trailing value
 * replace the complete domain object. The whole provider final is attempted
 * first. If it is valid for the supplied workload schema it wins immediately.
 * Otherwise balanced JSON candidates are ranked by validator score and only
 * then by size as a final tie-breaker.
 */
export function selectStructuredJsonCandidate(text = '', { validator = null, candidateComposer = null, label = 'Sidecar structured output' } = {}) {
    const raw = String(text ?? '');
    const trimmed = raw.trim();
    let wholeParsed;
    let wholeValidation = null;
    try {
        wholeParsed = JSON.parse(trimmed);
        wholeValidation = validationVerdict(validator, wholeParsed, { whole: true, text: trimmed });
        if (wholeValidation.valid) {
            return {
                text: trimmed,
                value: wholeValidation.value,
                start: raw.indexOf(trimmed),
                end: raw.indexOf(trimmed) + trimmed.length,
                score: wholeValidation.score,
                whole: true,
                validation: wholeValidation,
            };
        }
    } catch { /* balanced-candidate pass below */ }

    const rows = balancedJsonSlices(raw).map(row => ({
        ...row,
        validation: validationVerdict(validator, row.value, { whole: false, text: row.slice, start: row.start, end: row.end }),
    }));
    if (!rows.length) throw semanticError(`${label} contained no parseable JSON candidate.`, {
        candidateCount: 0,
        rejectedOutputChars: raw.length,
        rejectedOutputSample: boundedRejectedSample(raw),
    });
    const ranked = rows.filter(row => row.validation.valid);
    const topLevelRows = rows.filter(row => !rows.some(other => other !== row && other.start < row.start && other.end > row.end));
    const validTopLevel = topLevelRows.filter(row => row.validation.valid);
    if (validTopLevel.length > 1) {
        throw semanticError(`${label} contained multiple independently valid top-level JSON answers.`, {
            candidateCount: rows.length, validTopLevelCount: validTopLevel.length, ambiguous: true,
            rejectedOutputChars: raw.length, rejectedOutputSample: boundedRejectedSample(raw),
        });
    }
    if (!ranked.length && typeof candidateComposer === 'function') {
        let composed = null;
        try { composed = candidateComposer(topLevelRows.map(row=>row.value), { rows:topLevelRows, label, raw }); } catch { composed = null; }
        if (composed != null) {
            const composedValidation = validationVerdict(validator, composed, { composed:true, rows:topLevelRows });
            if (composedValidation.valid) {
                const start = topLevelRows.length ? Math.min(...topLevelRows.map(row=>row.start)) : 0;
                const end = topLevelRows.length ? Math.max(...topLevelRows.map(row=>row.end)) : raw.length;
                const value = composedValidation.value;
                return {
                    text: JSON.stringify(value), value, start, end,
                    score: composedValidation.score, whole:false, composed:true,
                    validation: composedValidation,
                };
            }
        }
    }
    if (!ranked.length) {
        const reasons = [wholeValidation?.reason, ...rows.map(row => row.validation.reason)].filter(Boolean);
        const rejectedCandidates = rows.slice(0, 6).map(row => ({
            start: row.start,
            end: row.end,
            chars: row.slice.length,
            score: Number(row.validation.score || 0),
            reason: row.validation.reason || 'Structured payload did not satisfy the expected domain contract.',
            sample: boundedRejectedSample(row.slice, REJECTED_CANDIDATE_SAMPLE_CHARS),
        }));
        throw semanticError(`${label} contained JSON, but no candidate satisfied the expected domain contract.`, {
            candidateCount: rows.length,
            reasons: [...new Set(reasons)].slice(0, 8),
            rejectedCandidates,
            rejectedOutputChars: raw.length,
            rejectedOutputSample: boundedRejectedSample(raw),
        });
    }
    ranked.sort((a, b) => {
        const scoreDelta = Number(b.validation.score || 0) - Number(a.validation.score || 0);
        if (scoreDelta) return scoreDelta;
        const sizeDelta = b.slice.length - a.slice.length;
        if (sizeDelta) return sizeDelta;
        return a.start - b.start;
    });
    const selected = ranked[0];
    return {
        text: selected.slice.trim(),
        value: selected.validation.value,
        start: selected.start,
        end: selected.end,
        score: selected.validation.score,
        whole: false,
        validation: selected.validation,
    };
}

export function parseStructuredJsonCandidate(text = '', options = {}) {
    return selectStructuredJsonCandidate(text, options).value;
}

/**
 * Separate provider-visible thinking from final content before any downstream
 * parser or multi-worker synthesis sees the response. Structured jobs use a
 * workload validator so parseable nested arrays/objects cannot displace the
 * complete semantic payload.
 */
export function separateVisibleThinking(text = '', { structured = false, validator = null, candidateComposer = null, label = 'Sidecar structured output' } = {}) {
    const original = String(text || '').trim();
    if (structured) {
        const selected = selectStructuredJsonCandidate(original, { validator, candidateComposer, label });
        const reasoning = [
            original.slice(0, selected.start).replace(/^```(?:json)?\s*/i, '').trim(),
            original.slice(selected.end).replace(/\s*```$/i, '').trim(),
        ].filter(Boolean).join('\n\n').trim();
        return {
            text: selected.text,
            value: selected.value,
            validation: selected.validation,
            reasoning,
            separated: reasoning.length > 0,
        };
    }

    let working = original;
    const reasoning = [];
    const tagged = /<(think|thinking|analysis|reasoning)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/gi;
    working = working.replace(tagged, (_match, _tag, body) => {
        const clean = String(body || '').trim();
        if (clean) reasoning.push(clean);
        return '\n';
    }).trim();

    const finalMarker = /(?:^|\n)\s*(?:#{1,6}\s*)?(?:final answer|final output|final response|answer)\s*:?\s*\n/i;
    const marker = finalMarker.exec(working);
    if (marker && marker.index > 0) {
        const before = working.slice(0, marker.index).trim();
        if (/thinking process|analysis|reasoning|thought process/i.test(before)) {
            reasoning.push(before);
            working = working.slice(marker.index + marker[0].length).trim();
        }
    }
    return { text: working.trim(), reasoning: reasoning.join('\n\n').trim(), separated: reasoning.length > 0 };
}

function finiteOrNull(v) { return Number.isFinite(Number(v)) ? Number(v) : null; }
function nonNegative(v) { const n = finiteOrNull(v); return n == null ? null : Math.max(0, n); }

export function normalizeUsage(usage, provider = 'openai') {
    const u = usage || {};
    if (provider === 'anthropic') {
        const inputTokens = nonNegative(u.input_tokens);
        const outputTokens = nonNegative(u.output_tokens);
        const cachedInputTokens = nonNegative(u.cache_read_input_tokens);
        const cacheWriteTokens = nonNegative(u.cache_creation_input_tokens);
        // Anthropic reports cache creation/read separately from uncached input.
        // Include them in total accounting so explicit user total-cost limits and
        // telemetry reflect the provider's full input work.
        const totalTokens = inputTokens != null || outputTokens != null || cachedInputTokens != null || cacheWriteTokens != null
            ? (inputTokens || 0) + (cachedInputTokens || 0) + (cacheWriteTokens || 0) + (outputTokens || 0)
            : null;
        return { inputTokens, outputTokens, visibleOutputTokens: outputTokens, reasoningTokens: nonNegative(u.reasoning_tokens ?? u.thinking_tokens), cachedInputTokens, cacheWriteTokens, totalTokens, providerReported: Object.keys(u).length > 0 };
    }
    if (provider === 'google') {
        const inputTokens = nonNegative(u.promptTokenCount ?? u.prompt_token_count);
        const visibleOutputTokens = nonNegative(u.candidatesTokenCount ?? u.candidates_token_count);
        const reasoningTokens = nonNegative(u.thoughtsTokenCount ?? u.thoughts_token_count);
        const outputTokens = visibleOutputTokens != null || reasoningTokens != null ? (visibleOutputTokens || 0) + (reasoningTokens || 0) : null;
        const totalTokens = nonNegative(u.totalTokenCount ?? u.total_token_count) ?? (inputTokens != null || outputTokens != null ? (inputTokens || 0) + (outputTokens || 0) : null);
        return { inputTokens, outputTokens, visibleOutputTokens, reasoningTokens, cachedInputTokens: nonNegative(u.cachedContentTokenCount ?? u.cached_content_token_count), cacheWriteTokens: null, totalTokens, providerReported: Object.keys(u).length > 0 };
    }
    const inputTokens = nonNegative(u.prompt_tokens ?? u.input_tokens);
    const outputTokens = nonNegative(u.completion_tokens ?? u.output_tokens);
    const reasoningTokens = nonNegative(u.completion_tokens_details?.reasoning_tokens ?? u.output_tokens_details?.reasoning_tokens ?? u.reasoning_tokens);
    const visibleOutputTokens = outputTokens != null ? Math.max(0, outputTokens - (reasoningTokens || 0)) : null;
    const totalTokens = nonNegative(u.total_tokens) ?? (inputTokens != null || outputTokens != null ? (inputTokens || 0) + (outputTokens || 0) : null);
    return { inputTokens, outputTokens, visibleOutputTokens, reasoningTokens, cachedInputTokens: nonNegative(u.prompt_tokens_details?.cached_tokens ?? u.cached_tokens), cacheWriteTokens: nonNegative(u.prompt_tokens_details?.cache_write_tokens ?? u.cache_write_tokens), totalTokens, providerReported: Object.keys(u).length > 0 };
}

export function normalizeOpenAIResponse(data) {
    const choice = data?.choices?.[0] || {};
    const message = choice?.message || {};
    const text = typeof message.content === 'string' ? message.content : firstTextPart(message.content);
    const reasoning = message.reasoning_content || message.reasoning || choice.reasoning || '';
    const refusal = message?.refusal ?? null;
    const toolCalls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
    const functionCall = message?.function_call ?? null;
    return {
        text: String(text || '').trim(),
        reasoning: String(reasoning || '').trim(),
        finishReason: choice.finish_reason || null,
        terminalEvidence: {
            provider: 'openai',
            refusal: refusal == null ? null : String(typeof refusal === 'string' ? refusal : JSON.stringify(refusal)),
            toolCallCount: toolCalls.length,
            functionCall: !!functionCall,
        },
        usage: data?.usage || null,
        usageNormalized: normalizeUsage(data?.usage || {}, 'openai'),
        http: data?.__tv2Http || null,
        raw: data,
    };
}

export function normalizeAnthropicResponse(data) {
    const blocks = Array.isArray(data?.content) ? data.content : [];
    const text = blocks.filter(b => b?.type === 'text').map(b => b.text || '').join('').trim();
    const reasoning = blocks.filter(b => ['thinking', 'reasoning'].includes(b?.type)).map(b => b.thinking || b.text || '').join('\n').trim();
    const blockTypes = blocks.map(b => String(b?.type || '').trim().toLowerCase()).filter(Boolean);
    const refusalBlocks = blocks.filter(b => ['refusal', 'blocked'].includes(String(b?.type || '').toLowerCase()));
    return {
        text,
        reasoning,
        finishReason: data?.stop_reason || null,
        terminalEvidence: {
            provider: 'anthropic',
            blockTypes,
            refusal: refusalBlocks.length ? refusalBlocks.map(b => b?.text || b?.refusal || b?.reason || '').filter(Boolean).join('\n') : null,
        },
        usage: data?.usage || null,
        usageNormalized: normalizeUsage(data?.usage || {}, 'anthropic'),
        http: data?.__tv2Http || null,
        raw: data,
    };
}

export function normalizeGoogleResponse(data) {
    const candidate = data?.candidates?.[0] || {};
    const parts = candidate?.content?.parts || [];
    const text = parts.filter(p => !p?.thought).map(p => p?.text || '').join('').trim();
    const reasoning = parts.filter(p => p?.thought).map(p => p?.text || '').join('\n').trim();
    const promptFeedback = data?.promptFeedback || data?.prompt_feedback || null;
    return {
        text,
        reasoning,
        finishReason: candidate?.finishReason || candidate?.finish_reason || null,
        terminalEvidence: {
            provider: 'google',
            promptBlockReason: promptFeedback?.blockReason || promptFeedback?.block_reason || null,
            safetyRatings: candidate?.safetyRatings || candidate?.safety_ratings || promptFeedback?.safetyRatings || promptFeedback?.safety_ratings || null,
        },
        usage: data?.usageMetadata || null,
        usageNormalized: normalizeUsage(data?.usageMetadata || {}, 'google'),
        http: data?.__tv2Http || null,
        raw: data,
    };
}

function providerTerminalError(result, label = 'Sidecar') {
    const finishReason = String(result?.finishReason || '').trim().toLowerCase();
    const evidence = result?.terminalEvidence || {};
    const provider = String(evidence?.provider || '').toLowerCase();
    const make = (name, message, { retryable = true, policy = false } = {}) => {
        const error = new Error(message);
        error.name = name;
        error.sidecarResult = result;
        error.finishReason = result?.finishReason || null;
        error.terminalEvidence = evidence;
        error.retryable = retryable;
        if (policy) error.policyTerminal = true;
        return error;
    };

    if (provider === 'openai') {
        if (evidence?.refusal) return make('TV2SidecarProviderRefusal', `${label} returned an assistant refusal; refusal text is never accepted as task output.`, { retryable: false, policy: true });
        if (finishReason === 'content_filter') return make('TV2SidecarProviderBlocked', `${label} was stopped by the provider content filter; partial text is never accepted as complete.`, { retryable: false, policy: true });
        if (['tool_calls', 'function_call'].includes(finishReason) || Number(evidence?.toolCallCount || 0) > 0 || evidence?.functionCall) {
            return make('TV2SidecarNonFinalToolCall', `${label} terminated in a tool/function call; partial assistant text is not a final workload result.`, { retryable: false });
        }
    }

    if (provider === 'anthropic') {
        if (finishReason === 'refusal' || evidence?.refusal) return make('TV2SidecarProviderRefusal', `${label} returned a provider refusal; partial text is never accepted as task output.`, { retryable: false, policy: true });
        if (finishReason === 'model_context_window_exceeded') return make('TV2SidecarProviderContextWindow', `${label} exceeded the provider context window; partial output is never accepted as complete.`);
        if (['tool_use', 'pause_turn'].includes(finishReason) || (evidence?.blockTypes || []).some(type => ['tool_use', 'server_tool_use'].includes(type))) {
            return make('TV2SidecarNonFinalToolCall', `${label} terminated in tool use/pause_turn; partial text is not a final workload result.`, { retryable: false });
        }
    }

    if (provider === 'google') {
        const promptBlockReason = String(evidence?.promptBlockReason || '').trim();
        const policyReasons = new Set(['safety', 'blocked_reason_unspecified', 'prohibited_content', 'blocklist', 'spi', 'image_safety']);
        if (promptBlockReason) {
            const policy = policyReasons.has(promptBlockReason.toLowerCase());
            return make('TV2SidecarProviderBlocked', `${label} prompt was blocked by the provider (${promptBlockReason}); no blocked response may be accepted as task output.`, { retryable: !policy, policy });
        }
        if (['safety', 'blocklist', 'prohibited_content', 'spi', 'image_safety'].includes(finishReason)) {
            return make('TV2SidecarProviderBlocked', `${label} was stopped by provider safety policy (finish=${result.finishReason}); partial text is never accepted as complete.`, { retryable: false, policy: true });
        }
    }
    return null;
}

export function assertProviderTerminalState(result, label = 'Sidecar') {
    const terminal = providerTerminalError(result, label);
    if (terminal) throw terminal;
    return result;
}

export function assertFinalContent(result, label = 'Sidecar') {
    assertProviderTerminalState(result, label);
    const finishReason = String(result?.finishReason || '').trim().toLowerCase();
    if (['length','max_tokens','max_output_tokens','max_tokens_reached','length_exceeded'].includes(finishReason)) {
        const error = new Error(`${label} stopped at the provider output boundary (finish=${result.finishReason}); truncated output is never accepted as complete.`);
        error.name = 'TV2SidecarTruncated';
        error.sidecarResult = result;
        error.finishReason = result?.finishReason || null;
        throw error;
    }
    if (result?.text?.trim()) return result;
    const bits = [];
    if (result?.finishReason) bits.push(`finish=${result.finishReason}`);
    const reasoningTokens = result?.usageNormalized?.reasoningTokens ?? result?.usage?.completion_tokens_details?.reasoning_tokens ?? result?.usage?.reasoning_tokens;
    if (Number.isFinite(reasoningTokens)) bits.push(`reasoning_tokens=${reasoningTokens}`);
    if (result?.reasoning?.trim()) {
        const error = new Error(`${label} produced reasoning but no final content${bits.length ? ` (${bits.join(', ')})` : ''}.`);
        error.name = 'TV2SidecarEmptyFinal';
        error.sidecarResult = result;
        throw error;
    }
    const error = new Error(`${label} returned no final content${bits.length ? ` (${bits.join(', ')})` : ''}.`);
    error.name = 'TV2SidecarEmptyFinal';
    error.sidecarResult = result;
    throw error;
}
