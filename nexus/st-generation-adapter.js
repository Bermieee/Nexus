/**
 * SillyTavern Main generation boundary adapter.
 *
 * This module is intentionally dependency-injected so smoke tests can exercise
 * the exact translation without importing SillyTavern itself. Generation Gateway
 * uses it for both policy-cleared Call Tickets and internal model-worker leases.
 * It never imports or addresses Sidecar A/B.
 */

const ALLOWED_ROLES = new Set(['system', 'user', 'assistant']);
const DEFAULT_RECENT_MESSAGES = 6;
const DEFAULT_RECENT_CHARS = 12_000;
const MAX_RECENT_MESSAGES = 24;
const MAX_RECENT_CHARS = 32_000;
const MAX_RESPONSE_LENGTH = 131_072;

function clean(value) { return String(value ?? '').trim(); }
function positiveInt(value, fallback = null, max = Number.MAX_SAFE_INTEGER) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return fallback;
    return Math.min(max, Math.max(1, Math.floor(n)));
}
function deepCopy(value) {
    if (value === undefined) return undefined;
    try { return typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value)); }
    catch { return null; }
}

function normalizePromptMessages(messages = []) {
    if (!Array.isArray(messages)) return [];
    const out = [];
    for (const row of messages) {
        if (!row || typeof row !== 'object') continue;
        const role = clean(row.role).toLowerCase();
        const content = clean(row.content);
        if (!ALLOWED_ROLES.has(role) || !content) continue;
        const message = { role, content };
        const name = clean(row.name);
        if (name) message.name = name.slice(0, 128);
        out.push(message);
    }
    return out;
}

function recentContextMessages(readChat, policy = {}) {
    if (clean(policy.mode).toLowerCase() !== 'recent') return [];
    const maxMessages = positiveInt(policy.maxMessages, DEFAULT_RECENT_MESSAGES, MAX_RECENT_MESSAGES);
    const maxChars = positiveInt(policy.maxChars, DEFAULT_RECENT_CHARS, MAX_RECENT_CHARS);
    const includeSystem = policy.includeSystem === true;
    const rows = typeof readChat === 'function' ? readChat() : [];
    if (!Array.isArray(rows) || !rows.length) return [];

    const selected = [];
    let chars = 0;
    for (let i = rows.length - 1; i >= 0 && selected.length < maxMessages; i -= 1) {
        const row = rows[i];
        if (!row || (!includeSystem && row.is_system === true)) continue;
        const content = clean(row.mes ?? row.content);
        if (!content) continue;
        const role = row.is_system === true ? 'system' : row.is_user === true ? 'user' : 'assistant';
        const remaining = maxChars - chars;
        if (remaining <= 0) break;
        // Prefer newest context. If the oldest included row would exceed the
        // cap, retain only its tail because that is closest to the later turns.
        const bounded = content.length > remaining ? content.slice(-remaining) : content;
        selected.push({ role, content: bounded });
        chars += bounded.length;
    }
    return selected.reverse();
}

export function buildSillyTavernGenerationRequest(request = {}, { readChat = null } = {}) {
    const args = request?.arguments && typeof request.arguments === 'object' ? request.arguments : {};
    const contextPolicy = request?.contextPolicy && typeof request.contextPolicy === 'object' ? request.contextPolicy : {};
    const responsePolicy = request?.responsePolicy && typeof request.responsePolicy === 'object' ? request.responsePolicy : {};

    const suppliedMessages = normalizePromptMessages(args.messages);
    const promptText = clean(args.prompt ?? args.instruction ?? args.query);
    if (!suppliedMessages.length && !promptText) throw new Error('Nexus → Main ticket requires arguments.prompt, arguments.instruction, arguments.query, or arguments.messages.');

    const context = recentContextMessages(readChat, contextPolicy);
    let prompt;
    if (suppliedMessages.length || context.length) {
        prompt = [...context, ...suppliedMessages];
        if (promptText) prompt.push({ role: 'user', content: promptText });
    } else {
        prompt = promptText;
    }

    const responseLength = positiveInt(
        responsePolicy.responseLength ?? responsePolicy.maxTokens ?? args.responseLength,
        null,
        MAX_RESPONSE_LENGTH,
    );
    const jsonSchema = responsePolicy.jsonSchema && typeof responsePolicy.jsonSchema === 'object' && !Array.isArray(responsePolicy.jsonSchema)
        ? deepCopy(responsePolicy.jsonSchema)
        : null;

    return {
        prompt,
        // Intentionally omit `api`: generateRaw then uses SillyTavern's current
        // Main connection. A Call Ticket may not switch providers behind policy.
        instructOverride: responsePolicy.instructOverride === true,
        quietToLoud: responsePolicy.quietToLoud === true,
        systemPrompt: clean(args.systemPrompt ?? responsePolicy.systemPrompt),
        responseLength,
        trimNames: responsePolicy.trimNames !== false,
        prefill: clean(args.prefill ?? responsePolicy.prefill),
        jsonSchema,
    };
}

export function createSillyTavernGenerationAdapter({ generateRaw, readChat = null, onActivity = null, cancelGeneration = null } = {}) {
    if (typeof generateRaw !== 'function') throw new Error('SillyTavern Generation adapter requires generateRaw().');
    const activity = typeof onActivity === 'function' ? onActivity : null;
    const cancel = typeof cancelGeneration === 'function' ? cancelGeneration : null;

    return async function dispatchSillyTavernMain(request = {}, ticket = {}, { signal = null } = {}) {
        const ticketId = clean(request.ticketId || ticket?.id || 'unknown');
        const source = request?.metadata?.internalModelWorker === true ? `model-worker:${ticketId}` : `call-center:${ticketId}`;
        const generationRequest = buildSillyTavernGenerationRequest(request, { readChat });
        activity?.(true, 'generation-gateway-started', source);
        let cancellationRequested = false;
        const onAbort = () => {
            cancellationRequested = true;
            if (signal?.reason?.cancelPhysical !== false) { try { cancel?.(); } catch {} }
        };
        if (signal?.aborted) onAbort(); else signal?.addEventListener?.('abort', onAbort, { once: true });
        try {
            const result = await generateRaw(generationRequest);
            if (signal?.aborted || cancellationRequested) throw signal?.reason || Object.assign(new Error('Nexus Main generation cancelled.'), { name: 'AbortError' });
            return result;
        } finally {
            signal?.removeEventListener?.('abort', onAbort);
            activity?.(false, 'generation-gateway-ended', source);
        }
    };
}
