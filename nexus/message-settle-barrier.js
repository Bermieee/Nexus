import { deepCopy } from './contracts.js';

let revisionGeneration = 1;
const fullRevisionCache = new WeakMap();

export function markMessageRevisionDirty(reason = 'message-mutated') {
    revisionGeneration += 1;
    return { generation: revisionGeneration, reason: String(reason || 'message-mutated') };
}

export function currentMessageRevisionGeneration() { return revisionGeneration; }

/**
 * Dependency-free message-settle barrier.
 *
 * A revision is sampled, Nexus waits a short deterministic quiet window, then
 * samples again. Only an unchanged revision is considered settled. This keeps
 * Director planning ahead of model work while preventing a plan from being
 * built against a message that SillyTavern is still replacing/finalizing.
 */
export function stableRevisionHash(value) {
    const text = typeof value === 'string' ? value : JSON.stringify(value ?? null);
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i += 1) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return `rev-${hash.toString(16).padStart(8, '0')}-${text.length}`;
}

export function revisionFromMessages(messages = [], metadata = {}, { tailCount = 4, includeAll = false } = {}) {
    const source = Array.isArray(messages) ? messages : [];
    const metadataCopy = deepCopy(metadata || {});
    // Full-history authority checks are hot. Lifecycle hooks advance the global
    // revision generation on edit/swipe/delete/chat changes, while appends also
    // change source.length. Reuse the expensive full serialization/hash until
    // either signal changes. This preserves same-length historical edit safety
    // without repeatedly hashing multi-million-character chats on the foreground.
    if (includeAll && source && typeof source === 'object') {
        const metadataKey = JSON.stringify(metadataCopy);
        const cached = fullRevisionCache.get(source);
        if (cached && cached.generation === revisionGeneration && cached.length === source.length && cached.metadataKey === metadataKey) return cached.revision;
        const rows = source.map((message, index) => ({
            index, isUser: message?.is_user === true, isSystem: message?.is_system === true,
            mes: String(message?.mes || ''), swipeId: message?.swipe_id ?? null, name: String(message?.name || ''),
        }));
        const revision = stableRevisionHash({ totalMessages: source.length, rows, metadata: metadataCopy });
        fullRevisionCache.set(source, { generation: revisionGeneration, length: source.length, metadataKey, revision });
        return revision;
    }
    const count = Math.max(1, Math.min(16, Math.floor(Number(tailCount) || 4)));
    const start = Math.max(0, source.length - count);
    const rows = source.slice(start).map((message, offset) => ({
        index: start + offset,
        isUser: message?.is_user === true,
        isSystem: message?.is_system === true,
        mes: String(message?.mes || ''),
        swipeId: message?.swipe_id ?? null,
        name: String(message?.name || ''),
    }));
    return stableRevisionHash({ totalMessages: source.length, rows, metadata: metadataCopy });
}

export async function awaitMessageSettle({ snapshot, delayMs = 60, attempts = 2, sleep = null } = {}) {
    if (typeof snapshot !== 'function') throw new Error('Message settle barrier requires snapshot().');
    const wait = sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
    const quietMs = Math.max(0, Math.min(2000, Number(delayMs) || 0));
    const maxAttempts = Math.max(1, Math.min(10, Math.floor(Number(attempts) || 1)));
    let before = await snapshot();
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        if (quietMs > 0) await wait(quietMs);
        const after = await snapshot();
        if (String(before?.revision || '') && String(before?.revision || '') === String(after?.revision || '')) {
            return { settled: true, attempt, revision: String(after.revision), snapshot: deepCopy(after) };
        }
        before = after;
    }
    return { settled: false, attempt: maxAttempts, revision: String(before?.revision || ''), snapshot: deepCopy(before) };
}
