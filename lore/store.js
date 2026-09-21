import * as worldInfoHost from '../../../../world-info.js';
import { logEvent } from '../observability/telemetry.js';
import { clearRetrievalState } from '../retrieval/state.js';
import { invalidateSearchIndex } from '../retrieval/search-index-cache.js';
import { clearRetrievalPrompt } from '../retrieval/prompt-bridge.js';
import { bumpNexusLoreSourceRevision } from '../nexus/lore-source-revision.js';
import { hostLorebookExists } from './host-inventory.js';

function requireWorldInfoCapability(name) {
    const fn = worldInfoHost?.[name];
    if (typeof fn === 'function') return fn;
    const error = new Error(`This SillyTavern build does not expose the World Info capability "${name}" required for this operation.`);
    error.name = 'TV2HostCapabilityUnavailable';
    error.capability = name;
    throw error;
}
const loadWorldInfo = (...args) => requireWorldInfoCapability('loadWorldInfo')(...args);
const saveWorldInfo = (...args) => requireWorldInfoCapability('saveWorldInfo')(...args);
const createWorldInfoEntry = (...args) => requireWorldInfoCapability('createWorldInfoEntry')(...args);
const deleteWorldInfoEntry = (...args) => requireWorldInfoCapability('deleteWorldInfoEntry')(...args);

export function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }

export function buildEntryUidMap(entries) {
    const map = new Map();
    const ambiguous = new Set();
    for (const entry of Object.values(entries || {})) {
        const uid = Number(entry?.uid);
        if (!Number.isFinite(uid)) continue;
        if (map.has(uid)) { ambiguous.add(uid); map.set(uid, null); }
        else if (!ambiguous.has(uid)) map.set(uid, entry);
    }
    return map;
}

export function findEntryByUid(entries, uid) {
    const n = Number(uid);
    if (!Number.isFinite(n)) return null;
    if (entries?.__tv2UidMap instanceof Map) return entries.__tv2UidMap.get(n) || null;
    let found = null;
    for (const entry of Object.values(entries || {})) {
        if (Number(entry?.uid) !== n) continue;
        if (found) return null; // duplicate UID is ambiguous authority; fail closed
        found = entry;
    }
    return found;
}

export async function loadBook(book) {
    const name=String(book||'').trim();
    if(!hostLorebookExists(name)){ const err=new Error(`Lorebook "${name}" is not present in SillyTavern World Info.`); err.name='TV2LorebookHostMissing'; logEvent('lore','host-book-missing',{book:name},'warn'); throw err; }
    const data = await loadWorldInfo(name);
    if (!data?.entries) { const err=new Error(`Lorebook "${book}" could not be loaded.`); logEvent('lore','load-failed',{book,error:err},'error'); throw err; }
    logEvent('lore','loaded',{book:name,entryCount:Object.keys(data.entries||{}).length},'debug');
    return data;
}

export async function saveBook(book, data) { await saveWorldInfo(book, data, true); clearRetrievalPrompt({force:true}); clearRetrievalState(); invalidateSearchIndex(book); bumpNexusLoreSourceRevision({book,reason:'lore-saved'}); try{globalThis.window?.dispatchEvent?.(new CustomEvent('nexus-lore-source-updated',{detail:{book}}));}catch{} logEvent('lore','saved',{book,entryCount:Object.keys(data?.entries||{}).length,retrievalReuseInvalidated:true,physicalPromptInvalidated:true},'debug'); }

export async function createEntryInBook(book, data, { title, content, keys = [], constant = false, beforeSave = null }) {
    if (!String(title || '').trim() || !String(content || '').trim()) throw new Error('Entry title and content are required.');
    // World Info saves replace the host book document. Rebase create work onto
    // the freshest available book immediately before assigning a UID so an
    // unrelated edit that landed after the operation snapshot is preserved.
    data = clone(await loadBook(book));
    const entry = createWorldInfoEntry(book, data);
    if (!entry) throw new Error('SillyTavern did not create a World Info entry.');
    const marker = `tv2_create_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    entry.comment = String(title).trim();
    entry.content = String(content).trim();
    entry.key = Array.isArray(keys) ? keys.map(String).map(s => s.trim()).filter(Boolean) : [];
    entry.selective = false;
    entry.constant = constant === true;
    entry.disable = false;
    // Resolve the exact UID assigned by SillyTavern. Object identity cannot
    // survive a JSON reload and title/content are not unique under concurrent
    // creates, so neither is a safe post-save identity.
    const createdUid = Number(entry.uid);
    if (!Number.isFinite(createdUid)) throw new Error(`SillyTavern created an entry without a stable UID (${marker}).`);
    if (typeof beforeSave === 'function') await beforeSave();
    await saveBook(book, data);
    const fresh = await loadBook(book);
    const finalized = findEntryByUid(fresh.entries, createdUid);
    if (!finalized) throw new Error(`Created UID ${createdUid} "${entry.comment}" could not be resolved after save (${marker}).`);
    logEvent('lore','entry-created',{book,uid:Number(finalized.uid),title:finalized.comment||'',contentChars:String(finalized.content||'').length,keyCount:(finalized.key||[]).length},'info');
    return { data: fresh, entry: finalized };
}

export async function deleteEntryFromBook(book, data, uid, hardDelete) {
    const entry = findEntryByUid(data.entries, uid);
    if (!entry) throw new Error(`UID ${uid} not found in "${book}".`);
    if (hardDelete) {
        // Older SillyTavern builds may not export this cache-cleanup helper.
        // Fail before any physical delete rather than link-failing the entire
        // extension or performing a partial hard delete without host cleanup.
        const clearOriginalData = requireWorldInfoCapability('deleteWIOriginalDataValue');
        await deleteWorldInfoEntry(data, Number(uid), { silent: true });
        clearOriginalData(data, Number(uid));
    } else {
        entry.disable = true;
    }
    logEvent('lore',hardDelete?'entry-hard-deleted':'entry-disabled',{book,uid:Number(uid),title:entry.comment||''},hardDelete?'warn':'info');
    return entry;
}
