let contextResolver = null;
async function currentContext() {
    if (typeof contextResolver === 'function') return contextResolver();
    try {
        const mod = await import('../../../../st-context.js');
        contextResolver = typeof mod.getContext === 'function' ? mod.getContext : (() => null);
    } catch { contextResolver = () => null; }
    return contextResolver();
}
export function __setDurabilityContextResolverForTests(resolver = null) { contextResolver = typeof resolver === 'function' ? resolver : null; }

function unavailable(message, cause = null) {
    const error = new Error(message);
    error.name = 'TV2DurabilityBarrierUnavailable';
    if (cause) error.cause = cause;
    return error;
}

function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
}

function stable(value) {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
    }
    return value;
}

function same(a, b) {
    try { return JSON.stringify(stable(a)) === JSON.stringify(stable(b)); }
    catch { return false; }
}


function rollbackIndeterminate(message, cause = null, rollbackError = null) {
    const error = new Error(message);
    error.name = 'TV2RollbackIndeterminate';
    if (cause) error.cause = cause;
    if (rollbackError) error.rollbackError = rollbackError;
    return error;
}

function restoreValuePreservingIdentity(current, before) {
    if (Array.isArray(current) && Array.isArray(before)) {
        current.splice(0, current.length, ...before.map(clone));
        return current;
    }
    if (current && before && typeof current === 'object' && typeof before === 'object' && !Array.isArray(current) && !Array.isArray(before)) {
        for (const key of Object.keys(current)) delete current[key];
        for (const [key, value] of Object.entries(before)) current[key] = clone(value);
        return current;
    }
    return clone(before);
}

function restoreExpectation(context, expectation) {
    if (!context?.chatMetadata || typeof context.chatMetadata !== 'object') {
        throw unavailable('Nexus metadata rollback could not restore the originating metadata object.');
    }
    for (const [key, row] of Object.entries(expectation || {})) {
        if (!row.exists) { delete context.chatMetadata[key]; continue; }
        const current = context.chatMetadata[key];
        context.chatMetadata[key] = restoreValuePreservingIdentity(current, row.value);
    }
}

function expectationMatchesContext(context, expectation) {
    const metadata = context?.chatMetadata && typeof context.chatMetadata === 'object' ? context.chatMetadata : {};
    for (const [key, row] of Object.entries(expectation || {})) {
        const exists = Object.prototype.hasOwnProperty.call(metadata, key);
        if (exists !== row.exists) return false;
        if (row.exists && !same(metadata[key], row.value)) return false;
    }
    return true;
}

const metadataMutationTails = new Map();
function metadataMutationResource(context) {
    return `chat:${String(context?.chatId || '').trim() || 'unknown'}`;
}
async function withMetadataMutationLock(context, task) {
    const resource = metadataMutationResource(context);
    const previous = metadataMutationTails.get(resource) || Promise.resolve();
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const tail = previous.catch(() => {}).then(() => gate);
    metadataMutationTails.set(resource, tail);
    await previous.catch(() => {});
    try { return await task(); }
    finally {
        release();
        if (metadataMutationTails.get(resource) === tail) metadataMutationTails.delete(resource);
    }
}

function targetIdentity(context, label) {
    if (!context || typeof context !== 'object') throw unavailable(`${label} durability barrier is unavailable: SillyTavern context is missing.`);
    const chatId = String(context.chatId || '').trim();
    if (!chatId) throw unavailable(`${label} durability barrier is unavailable: originating chat ID is missing.`);
    return {
        chatId,
        group: context.groupId != null && String(context.groupId).trim() !== '',
        groupId: context.groupId == null ? null : String(context.groupId),
        characterId: context.characterId == null ? null : String(context.characterId),
    };
}

async function assertStillActive(context, label) {
    const target = targetIdentity(context, label);
    const live = await currentContext();
    if (!live || String(live.chatId || '').trim() !== target.chatId) {
        throw unavailable(`${label} durability barrier refused because the originating chat is no longer active.`);
    }
    const liveGroup = live.groupId != null && String(live.groupId).trim() !== '';
    if (liveGroup !== target.group) {
        throw unavailable(`${label} durability barrier refused because the active chat type changed.`);
    }
    if (target.group && String(live.groupId) !== target.groupId) {
        throw unavailable(`${label} durability barrier refused because the active group changed.`);
    }
    if (!target.group && String(live.characterId ?? '') !== String(target.characterId ?? '')) {
        throw unavailable(`${label} durability barrier refused because the active character changed.`);
    }
    if (live.chatMetadata !== context.chatMetadata) {
        throw unavailable(`${label} durability barrier refused because the originating chat metadata object is no longer current.`);
    }
    return { live, target };
}

function buildExpectation(context, { keys = null, absentKeys = null, expected = null } = {}) {
    if (expected && typeof expected === 'object') {
        return Object.fromEntries(Object.entries(expected).map(([key, row]) => [String(key), {
            exists: row?.exists !== false,
            value: row?.exists === false ? null : clone(row?.value),
        }]));
    }
    const metadata = context?.chatMetadata && typeof context.chatMetadata === 'object' ? context.chatMetadata : {};
    const selected = Array.isArray(keys) && keys.length ? keys.map(String) : Object.keys(metadata);
    const out = {};
    for (const key of selected) {
        const exists = Object.prototype.hasOwnProperty.call(metadata, key);
        out[key] = { exists, value: exists ? clone(metadata[key]) : null };
    }
    for (const key of Array.isArray(absentKeys) ? absentKeys.map(String) : []) {
        out[key] = { exists: false, value: null };
    }
    return out;
}

function readRequest(context, target, label) {
    if (typeof context.getRequestHeaders !== 'function') {
        throw unavailable(`${label} durability barrier is unavailable: SillyTavern request headers are missing.`);
    }
    if (target.group) {
        return { endpoint: '/api/chats/group/get', body: JSON.stringify({ id: target.chatId }) };
    }
    const character = context.characters?.[context.characterId];
    if (!character || !character.name || !character.avatar) {
        throw unavailable(`${label} durability barrier is unavailable: originating character identity is missing.`);
    }
    return {
        endpoint: '/api/chats/get',
        body: JSON.stringify({
            ch_name: character.name,
            file_name: target.chatId,
            avatar_url: character.avatar,
        }),
    };
}

function chatFileIdentity(value) {
    return String(value || '').replace(/\.jsonl$/i, '');
}

async function readPersistedMetadataFromRecent(context, target, label) {
    const character = context.characters?.[context.characterId];
    const expectedAvatar = String(character?.avatar || '').trim();
    if (!expectedAvatar) {
        throw unavailable(`${label} durability barrier could not prove persisted chat metadata from the alternate server response.`);
    }
    let response;
    try {
        response = await fetch('/api/chats/recent', {
            method: 'POST',
            cache: 'no-cache',
            headers: context.getRequestHeaders(),
            body: JSON.stringify({ metadata: true }),
        });
    } catch (error) {
        throw unavailable(`${label} durability barrier failed while performing the alternate originating-chat verification read.`, error);
    }
    if (!response?.ok) {
        throw unavailable(`${label} durability barrier failed: SillyTavern rejected the alternate originating-chat verification read.`);
    }
    let data;
    try { data = await response.json(); }
    catch (error) { throw unavailable(`${label} durability barrier received unreadable alternate chat verification data.`, error); }
    const expectedChat = chatFileIdentity(target.chatId);
    const matches = Array.isArray(data) ? data.filter(row => {
        if (!row || typeof row !== 'object') return false;
        const rowChat = chatFileIdentity(row.file_id || row.file_name);
        return rowChat === expectedChat && String(row.avatar || '').trim() === expectedAvatar;
    }) : [];
    if (matches.length !== 1 || typeof matches[0]?.chat_metadata !== 'object' || matches[0].chat_metadata === null) {
        throw unavailable(`${label} durability barrier could not prove persisted chat metadata from the alternate server response.`);
    }
    return matches[0].chat_metadata;
}

async function readPersistedMetadata(context, target, label) {
    const request = readRequest(context, target, label);
    let response;
    try {
        response = await fetch(request.endpoint, {
            method: 'POST',
            cache: 'no-cache',
            headers: context.getRequestHeaders(),
            body: request.body,
        });
    } catch (error) {
        throw unavailable(`${label} durability barrier failed while verifying the originating chat.`, error);
    }
    if (!response?.ok) {
        throw unavailable(`${label} durability barrier failed: SillyTavern rejected the originating-chat verification read.`);
    }
    let data;
    try { data = await response.json(); }
    catch (error) { throw unavailable(`${label} durability barrier received unreadable chat verification data.`, error); }
    // SillyTavern can return HTTP 200 with {} / [] for some failed or ambiguous
    // /api/chats/get reads. A regular character chat may use /api/chats/recent
    // exactly once for this proof attempt, but only when that primary read was
    // successful yet ambiguous. The alternate result must identify the exact
    // chat file + avatar and expose metadata; otherwise durability still fails
    // closed. Group chats retain their existing exact /group/get contract.
    if (!Array.isArray(data) || !data.length || !data[0] || typeof data[0].chat_metadata !== 'object') {
        if (!target.group) return await readPersistedMetadataFromRecent(context, target, label);
        throw unavailable(`${label} durability barrier could not prove persisted chat metadata from the server response.`);
    }
    return data[0].chat_metadata;
}

const PROJECTION_SETTLE_ATTEMPTS = 5;
const PROJECTION_SETTLE_DELAY_MS = 50;

function settleableProjectionMismatch(message) {
    const error = unavailable(message);
    error.tv2ProjectionSettleable = true;
    return error;
}

function verifyProjection(persisted, expectation, context, label) {
    const localIntegrity = context?.chatMetadata?.integrity;
    if (localIntegrity != null && String(persisted?.integrity ?? '') !== String(localIntegrity)) {
        throw unavailable(`${label} durability barrier refused because persisted chat integrity identity diverged.`);
    }
    for (const [key, row] of Object.entries(expectation || {})) {
        const exists = Object.prototype.hasOwnProperty.call(persisted, key);
        if (exists !== row.exists) {
            throw settleableProjectionMismatch(`${label} durability barrier could not prove metadata "${key}" reached the originating chat.`);
        }
        if (row.exists && !same(persisted[key], row.value)) {
            throw settleableProjectionMismatch(`${label} durability barrier found divergent persisted metadata for "${key}".`);
        }
    }
}

function settleDelay(ms = PROJECTION_SETTLE_DELAY_MS) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Cross the SillyTavern chat-metadata durability boundary without writing a
 * captured/stale chat snapshot.
 *
 * SillyTavern's saveMetadata() delegates to saveChatConditional(), whose
 * isChatSaving gate serializes native saves for the active chat. Nexus therefore
 * requires the captured target to remain active, asks the host to save its live
 * chat state, then reads the exact target back from the server and proves only
 * the caller's intended metadata projection. A chat switch or ambiguous read is
 * recovery-relevant failure, never permission to upload an older chat body.
 */
export async function flushChatMetadataPersistence(context = null, label = 'Nexus chat metadata', expectationOptions = {}) {
    context = context || await currentContext();
    const expectation = buildExpectation(context, expectationOptions);
    const { live, target } = await assertStillActive(context, label);
    if (typeof live.saveMetadata !== 'function') {
        throw unavailable(`${label} durability barrier is unavailable: SillyTavern serialized metadata saver is missing.`);
    }
    try { await live.saveMetadata(); }
    catch (error) { throw unavailable(`${label} durability barrier failed while invoking SillyTavern's serialized metadata save.`, error); }
    await assertStillActive(context, label);
    let lastProjectionError = null;
    for (let attempt = 1; attempt <= PROJECTION_SETTLE_ATTEMPTS; attempt++) {
        const persisted = await readPersistedMetadata(context, target, label);
        await assertStillActive(context, label);
        try {
            verifyProjection(persisted, expectation, context, label);
            return true;
        } catch (error) {
            if (error?.tv2ProjectionSettleable !== true) throw error;
            lastProjectionError = error;
            if (attempt >= PROJECTION_SETTLE_ATTEMPTS) throw error;
            // saveMetadata() is invoked exactly once. The remaining bounded
            // window is read-only proof settling for hosts whose first read
            // can expose the immediately preceding persisted projection.
            await settleDelay();
            await assertStillActive(context, label);
        }
    }
    throw lastProjectionError || unavailable(`${label} durability barrier could not prove the intended metadata projection.`);
}


/**
 * Apply an internal Nexus chat-metadata mutation with an exact pre-image and a
 * verified rollback path. This is for internal metadata stores (Notebook,
 * Memory Bank, etc.) that are not canonical lore/Tree mutations but still must
 * never become durable after their Ledger transaction reports failure.
 */
export async function mutateChatMetadataDurably(context, label, expectationOptions = {}, mutator = null) {
    if (typeof mutator !== 'function') throw new TypeError(`${label} durable metadata mutation requires a mutator function.`);
    const keys = Array.isArray(expectationOptions?.keys) ? expectationOptions.keys.map(String) : [];
    if (!keys.length && !expectationOptions?.expected) {
        throw unavailable(`${label} durable metadata mutation requires an explicit metadata projection.`);
    }
    return await withMetadataMutationLock(context, async () => {
        const before = buildExpectation(context, {
            keys,
            absentKeys: expectationOptions?.absentKeys,
            expected: expectationOptions?.beforeExpected,
        });
        let value;
        let post = null;
        try {
            value = mutator();
            if (value && typeof value.then === 'function') {
                throw new TypeError(`${label} durable metadata mutator must complete synchronously so caller intent can be frozen before interleaving.`);
            }
            // Freeze the exact caller-owned post projection before the first yield.
            post = expectationOptions?.expected
                ? buildExpectation(context, { expected: expectationOptions.expected })
                : buildExpectation(context, { keys, absentKeys: expectationOptions?.absentKeys });
            if (!expectationMatchesContext(context, post)) {
                throw unavailable(`${label} durable metadata mutation did not produce its declared post-state.`);
            }
            await flushChatMetadataPersistence(context, label, { expected: post });
            return value;
        } catch (error) {
            // If the mutator itself failed synchronously, no other queued Nexus
            // mutation could have interleaved; restoring PRE is safe in-memory.
            if (post && !expectationMatchesContext(context, post)) {
                throw rollbackIndeterminate(`${label} failed after its metadata post-state diverged; rollback was refused to preserve newer data.`, error);
            }
            try { restoreExpectation(context, before); }
            catch (restoreError) {
                throw rollbackIndeterminate(`${label} failed and its in-memory metadata pre-state could not be restored.`, error, restoreError);
            }
            try {
                await flushChatMetadataPersistence(context, `${label} rollback`, { expected: before });
                try { error.tv2RollbackRestored = true; } catch {}
                throw error;
            } catch (rollbackError) {
                if (rollbackError === error || rollbackError?.tv2RollbackRestored === true) throw rollbackError;
                throw rollbackIndeterminate(`${label} failed and rollback durability could not be proven.`, error, rollbackError);
            }
        }
    });
}
