/*
 * Canonical lore/Tree source authority revision.
 *
 * Chat/message revision is not sufficient for Retrieval: native WI edits,
 * Nexus lore writes, Tree writes, policy changes, and Story Scope changes can
 * invalidate the same prompt without changing a chat message. Keep a small
 * monotonic in-process authority clock so caches and in-flight work can prove
 * they still describe the sources they were built from.
 */
let authorityRevision = 1;
const bookRevisions = new Map();
let lastChange = { at: 0, reason: 'initial', book: null, broad: false };

function cleanBook(book) { const value=String(book||'').trim(); return value || null; }
function revisionForBook(book) { return Number(bookRevisions.get(cleanBook(book)) || 1); }

export function bumpNexusLoreSourceRevision({ book = null, reason = 'lore-source-changed', broad = false } = {}) {
    const name=cleanBook(book);
    if (broad || !name) authorityRevision += 1;
    if (name) bookRevisions.set(name, revisionForBook(name) + 1);
    lastChange={at:Date.now(),reason:String(reason||'lore-source-changed'),book:name,broad:broad||!name};
    return currentNexusLoreSourceRevision(name?[name]:[]);
}

export function currentNexusLoreSourceRevision(books = []) {
    const names=[...new Set((Array.isArray(books)?books:[books]).map(cleanBook).filter(Boolean))].sort();
    return `a:${authorityRevision}|${names.map(book=>`${book}:${revisionForBook(book)}`).join(',')}`;
}

export function isNexusLoreSourceRevisionFresh(revision, books = []) {
    return String(revision||'') === currentNexusLoreSourceRevision(books);
}

export function getNexusLoreSourceRevisionStatus() {
    return { authorityRevision, books:Object.fromEntries([...bookRevisions.entries()]), lastChange:{...lastChange} };
}

export function resetNexusLoreSourceRevisionForTests() {
    authorityRevision=1; bookRevisions.clear(); lastChange={at:0,reason:'test-reset',book:null,broad:false};
}
