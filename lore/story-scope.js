import { getContext } from '../../../../st-context.js';
import { selected_world_info } from '../../../../world-info.js';
import { logEvent } from '../observability/telemetry.js';
import { mutateChatMetadataDurably } from '../nexus/host-durability.js';
import { bumpNexusLoreSourceRevision } from '../nexus/lore-source-revision.js';

const META_KEY = 'tv2_story_scope_v1';
const VERSION = 2;
const listeners = new Set();

function dedupeNames(values = []) {
    return [...new Set((values || []).map(value => String(value || '').trim()).filter(Boolean))];
}

function managedSet(managedBooks = []) { return new Set(dedupeNames(managedBooks)); }
function keepManaged(values, managed) { return dedupeNames(values).filter(name => managed.has(name)); }
function cloneScope(scope) { return scope ? JSON.parse(JSON.stringify(scope)) : null; }
function chatKey(context=getContext()){ return String(context?.chatId || context?.chat_id || '').trim(); }
function hostSelectedManaged(managedBooks=[]){ const managed=managedSet(managedBooks); return dedupeNames(selected_world_info || []).filter(name=>managed.has(name)); }

function rawScope(context = getContext()) {
    const value = context?.chatMetadata?.[META_KEY];
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function normalizedExplicitScope(raw, managedBooks = [], context = getContext()) {
    const managed = managedSet(managedBooks);
    const currentChatKey = chatKey(context);
    const storedChatKey = String(raw?.chatKey || '').trim();
    let readBooks = keepManaged(raw?.readBooks, managed);
    let writeBooks = keepManaged(raw?.writeBooks, managed);
    let mode = 'explicit';

    // Story Scope v1 was not bound to the chat that created it. Imported/cloned
    // chats can therefore carry an unrelated book into a new story. When a
    // legacy scope has no binding proof, the host's currently selected World
    // Info set is the only safe migration authority. This preserves deliberate
    // multi-book host stories while pruning stale Nexus-enabled books.
    if (!storedChatKey && Number(raw?.version || 1) < VERSION) {
        const hostBooks = hostSelectedManaged(managedBooks);
        if (hostBooks.length) {
            const host = new Set(hostBooks);
            readBooks = readBooks.filter(name=>host.has(name));
            writeBooks = writeBooks.filter(name=>host.has(name));
            if (!readBooks.length && !writeBooks.length) {
                readBooks = [...hostBooks];
                writeBooks = [...hostBooks];
            }
            mode = 'legacy-host-reconciled';
        }
    }

    // A v2+ explicit scope belongs only to the exact chat that authored it.
    // A copied/imported metadata object must not bring another story's books.
    if (storedChatKey && currentChatKey && storedChatKey !== currentChatKey) return null;

    const primaryCandidate = String(raw?.primaryWriteBook || '').trim();
    const primaryWriteBook = writeBooks.includes(primaryCandidate) ? primaryCandidate : (writeBooks[0] || null);
    return {
        version: VERSION,
        configured: true,
        mode,
        chatKey: currentChatKey || storedChatKey || null,
        revision: Math.max(1, Number(raw?.revision) || 1),
        readBooks,
        writeBooks,
        primaryWriteBook,
        updatedAt: Number(raw?.updatedAt) || 0,
    };
}

function inferredScope(managedBooks = []) {
    const managed = managedSet(managedBooks);
    const selected = dedupeNames(selected_world_info || []).filter(name => managed.has(name));
    let books = [];
    let mode = 'unscoped';
    if (selected.length === 1) {
        books = selected;
        mode = 'inferred-single-st-book';
    } else if (managed.size === 1) {
        books = [...managed];
        mode = 'inferred-single-managed-book';
    } else if (selected.length > 1 || managed.size > 1) {
        mode = 'ambiguous-requires-scope';
    }
    return {
        version: VERSION,
        configured: false,
        mode,
        revision: 0,
        readBooks: [...books],
        writeBooks: [...books],
        primaryWriteBook: books[0] || null,
        updatedAt: 0,
    };
}

/**
 * Return the current chat/story's lorebook boundary.
 *
 * Global Nexus enablement is deliberately NOT enough to make a book part of a
 * story. Existing single-book installs get a safe inference. Ambiguous
 * multi-book installs fail closed until the operator explicitly attaches books.
 */
export function getCurrentStoryScope({ managedBooks = [] } = {}) {
    const context = getContext();
    const raw = rawScope(context);
    if (raw?.configured === true) {
        const explicit = normalizedExplicitScope(raw, managedBooks, context);
        if (explicit) return explicit;
    }
    return inferredScope(managedBooks);
}

export function hasExplicitStoryScope(context = getContext()) {
    const raw=rawScope(context);if(raw?.configured!==true)return false;
    const stored=String(raw?.chatKey||'').trim(),current=chatKey(context);
    if(stored&&current&&stored!==current)return false;
    return true;
}

function emitChange(previous, next, reason = 'story-scope-updated') {
    const detail = { previous: cloneScope(previous), next: cloneScope(next), reason: String(reason || 'story-scope-updated') };
    for (const listener of [...listeners]) {
        try { listener(detail); } catch {}
    }
    try { globalThis.window?.dispatchEvent?.(new CustomEvent('tv2-story-scope-changed', { detail })); } catch {}
    bumpNexusLoreSourceRevision({reason:`story-scope:${detail.reason}`,broad:true});
    logEvent('story-scope', 'changed', {
        reason: detail.reason,
        revision: next?.revision || 0,
        readBooks: next?.readBooks || [],
        writeBooks: next?.writeBooks || [],
        primaryWriteBook: next?.primaryWriteBook || null,
    }, 'info');
}

export function onStoryScopeChange(listener) {
    if (typeof listener !== 'function') return () => {};
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export async function configureCurrentStoryScope({ readBooks = [], writeBooks = [], primaryWriteBook = null, reason = 'operator-configured' } = {}, { managedBooks = [] } = {}) {
    const context = getContext();
    if (!context?.chatMetadata) throw new Error('No active SillyTavern chat metadata is available for Story Scope.');
    const managed = managedSet(managedBooks);
    const previous = getCurrentStoryScope({ managedBooks });
    const read = keepManaged(readBooks, managed);
    const write = keepManaged(writeBooks, managed);
    const primary = write.includes(String(primaryWriteBook || '').trim())
        ? String(primaryWriteBook).trim()
        : (write[0] || null);
    const previousRevision = Number(rawScope(context)?.revision) || 0;
    const next = {
        version: VERSION,
        configured: true,
        chatKey: chatKey(context) || null,
        revision: previousRevision + 1,
        readBooks: read,
        writeBooks: write,
        primaryWriteBook: primary,
        updatedAt: Date.now(),
    };
    const saved = await mutateChatMetadataDurably(context, 'Story Scope', { keys: [META_KEY] }, () => { context.chatMetadata[META_KEY] = next; return { ...next, mode: 'explicit' }; });
    emitChange(previous, saved, reason);
    return saved;
}

export async function setBookInCurrentStory(book, { read = true, write = true, primary = false, reason = 'operator-book-scope-change' } = {}, { managedBooks = [] } = {}) {
    const name = String(book || '').trim();
    if (!name) throw new Error('Story Scope requires a lorebook name.');
    const managed = managedSet(managedBooks);
    if (!managed.has(name)) throw new Error(`Lorebook "${name}" is not currently managed by Nexus.`);
    const current = getCurrentStoryScope({ managedBooks });
    const readBooks = new Set(current.configured ? current.readBooks : []);
    const writeBooks = new Set(current.configured ? current.writeBooks : []);
    if (read) readBooks.add(name); else readBooks.delete(name);
    if (write) writeBooks.add(name); else writeBooks.delete(name);
    const primaryWriteBook = primary && write ? name : (writeBooks.has(current.primaryWriteBook) ? current.primaryWriteBook : ([...writeBooks][0] || null));
    return await configureCurrentStoryScope({ readBooks:[...readBooks], writeBooks:[...writeBooks], primaryWriteBook, reason }, { managedBooks });
}

export async function removeBookFromCurrentStory(book, { managedBooks = [], reason = 'operator-book-detached' } = {}) {
    const name = String(book || '').trim();
    const current = getCurrentStoryScope({ managedBooks });
    const readBooks = current.readBooks.filter(row => row !== name);
    const writeBooks = current.writeBooks.filter(row => row !== name);
    const primaryWriteBook = current.primaryWriteBook === name ? (writeBooks[0] || null) : current.primaryWriteBook;
    return await configureCurrentStoryScope({ readBooks, writeBooks, primaryWriteBook, reason }, { managedBooks });
}

export async function clearCurrentStoryScope({ managedBooks = [], reason = 'operator-scope-cleared' } = {}) {
    const context = getContext();
    if (!context?.chatMetadata) return getCurrentStoryScope({ managedBooks });
    const previous = getCurrentStoryScope({ managedBooks });
    const next = await mutateChatMetadataDurably(context, 'Story Scope clear', { keys: [META_KEY], expected: { [META_KEY]: { exists: false, value: null } } }, () => { delete context.chatMetadata[META_KEY]; return getCurrentStoryScope({ managedBooks }); });
    emitChange(previous, next, reason);
    return next;
}

export function storyScopeMetaKey() { return META_KEY; }
