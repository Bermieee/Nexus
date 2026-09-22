// Durable commit-intent journal for the narrow crash window between
// prepareCommit() and completeCommit(). This module intentionally has no ST host
// imports so the transaction service remains testable in Node and usable before
// host context hydration. In-browser persistence is deliberately fail-closed:
// mutation commits may not silently downgrade to volatile memory when durable
// storage is unavailable or corrupt. Node-only tests keep an explicit in-memory
// backend so this module remains host-independent and directly testable.
const KEY = 'tv2_nexus_commit_journal_v1';
const LOCK_KEY = `${KEY}:lock`; // legacy pseudo-lock key; no longer an authority primitive.
const EVENT_PREFIX = `${KEY}:event:`;
const EVENT_SCHEMA_KEY = `${KEY}:event-schema`;
const EVENT_SCHEMA_VERSION = 1;
const JOURNAL_RESERVE_KEY = `${KEY}:durability-reserve`;
const JOURNAL_RESERVE_CHARS = 64 * 1024;
// HOTFIX46.29: browser durability authority moves heavy commit/recovery payloads
// to IndexedDB. localStorage retains only a tiny migration/authority marker.
// The existing synchronous journal state machine runs against an in-memory
// mirror, while durability-critical public wrappers await an IndexedDB
// transaction before returning to mutation callers.
const IDB_DB_NAME = 'NexusCommitDurability';
const IDB_DB_VERSION = 1;
const IDB_STORE = 'commitJournalKv';
const IDB_META_KEY = '__nexus_commit_journal_idb_authority__';
const IDB_AUTHORITY_MARKER_KEY = `${KEY}:indexeddb-authority`;
const IDB_AUTHORITY_VERSION = 1;
let idbDatabase = null;
let idbAuthority = false;
let idbHydrated = false;
let idbStartupState = 'idle'; // idle | ready | unavailable
let idbStartupError = null;
let idbOpenPromise = null;
let idbOpenAttempt = 0;
const IDB_OPEN_TIMEOUT_MS = 4000;
let idbMirror = new Map();
let idbMirrorSortedKeys = null;
function invalidateIdbMirrorKeyOrder(){idbMirrorSortedKeys=null;}
function replaceIdbMirror(next){idbMirror=next instanceof Map?next:new Map(next||[]);invalidateIdbMirrorKeyOrder();return idbMirror;}
function sortedIdbMirrorKeys(){if(!idbMirrorSortedKeys)idbMirrorSortedKeys=[...idbMirror.keys()].sort();return idbMirrorSortedKeys;}
let idbMutationTail = Promise.resolve();
let idbWriteContext = 0;
let idbInitialization = null;
let idbMigrationInfo = null;
const REPLAY_KEY = 'tv2_nexus_commit_replay_fences_v1';
const REPLAY_ARCHIVE_PREFIX = `${REPLAY_KEY}:archive:`;
const LIMIT = 240;
const REPLAY_LIMIT = 4096;
const REPLAY_ARCHIVE_LIMIT = 4096;
let eventSequence = 0;
let lastCacheProjectionError = '';
const UNRESOLVED = new Set(['committing', 'applied', 'recovery-required']);
// A confirmed-applied row is terminal for operator recovery, but it remains a
// replay fence for the exact captured mutation identity.  Physical persistence
// already succeeded before APPLIED can be written, so allowing the same
// assumptions/input to create another intent could duplicate a mutation after a
// reload or same-session retry.
const PHYSICAL_REPLAY_FENCE = new Set(['applied', 'committed', 'reconciled-confirmed-applied', 'reconciled-diverged', 'reconciled-abandoned']);
const KNOWN_APPLIED_EFFECT = new Set(['applied', 'committed', 'reconciled-confirmed-applied']);
function unknownOutcomeState(state){ return state === 'reconciled-diverged' || state === 'reconciled-abandoned'; }
const RETENTION_PROTECTED = new Set([...UNRESOLVED]);
// APPLIED remains retention-protected until settlement projection completes, but
// its physical outcome is already known. Only COMMITTING / RECOVERY-REQUIRED
// rows still need the full canonical mutation + rollback descriptor in storage.
const STORAGE_BODY_PROTECTED = new Set(['committing','recovery-required']);
const JOURNAL_STATES = new Set(['committing','applied','committed','recovery-required','failed','reconciled-confirmed-applied','reconciled-confirmed-not-applied','reconciled-abandoned','reconciled-superseded','reconciled-diverged']);
function validateJournalRows(rows) {
    if (!Array.isArray(rows)) throw corruptError('Nexus durable commit journal payload is not an array. Refusing to overwrite unresolved recovery evidence.');
    const ids = new Set();
    for (const row of rows) {
        if (!row || typeof row !== 'object' || Array.isArray(row)) throw corruptError('Nexus durable commit journal contains a malformed row.');
        const id = String(row.id || '').trim();
        if (!id || ids.has(id)) throw corruptError('Nexus durable commit journal contains a missing or duplicate transaction identity.');
        ids.add(id);
        if (!JOURNAL_STATES.has(String(row.state || ''))) throw corruptError(`Nexus durable commit journal row ${id} has an unsupported state.`);
        if (!String(row.identity || '').trim()) throw corruptError(`Nexus durable commit journal row ${id} is missing its mutation identity.`);
        if (UNRESOLVED.has(String(row.state || '')) && !row.canonicalMutation) {
            const legacyPrewrite = row.legacyNoCanonicalMutation === true;
            if (!legacyPrewrite) throw corruptError(`Nexus unresolved commit journal row ${id} is missing canonical mutation authority.`);
        }
        validateJournalTransactionRecord(row);
    }
    return rows;
}
function validateReplayRows(rows) {
    if (!Array.isArray(rows)) throw corruptError('Nexus replay-fence store payload is not an array.');
    const identities = new Set();
    for (const row of rows) {
        if (!row || typeof row !== 'object' || Array.isArray(row)) throw corruptError('Nexus replay-fence store contains a malformed row.');
        const identity = String(row.physicalIdentity || row.identity || '').trim();
        const version = Number(row.physicalIdentityVersion || row.identityVersion || 0);
        if (!identity || !Number.isFinite(version) || version <= 0) throw corruptError('Nexus replay-fence row is missing a valid physical mutation identity.');
        const key = `${version}|${identity}`;
        if (identities.has(key)) throw corruptError('Nexus replay-fence store contains duplicate physical mutation identity rows.');
        identities.add(key);
    }
    return rows;
}
let memoryRows = [];
let memoryReplayFences = [];

function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }
function same(a,b){ try { return JSON.stringify(stable(a)) === JSON.stringify(stable(b)); } catch { return false; } }
function supportsStorageEnumeration(target) { return !!target && typeof target.key === 'function' && Number.isFinite(Number(target.length)); }
function storageKeys(target, prefix) {
    const out = [];
    if (!target || typeof target.key !== 'function' || !Number.isFinite(Number(target.length))) return out;
    for (let i = 0; i < Number(target.length); i += 1) {
        const key = target.key(i);
        if (typeof key === 'string' && key.startsWith(prefix)) out.push(key);
    }
    return out.sort();
}
function eventKey(prefix = EVENT_PREFIX) {
    eventSequence += 1;
    return `${prefix}${Date.now().toString(36)}:${eventSequence.toString(36)}:${Math.random().toString(36).slice(2)}`;
}
function normalizeResources(resources = []) { return [...new Set((Array.isArray(resources) ? resources : []).map(value => String(value || '').trim()).filter(Boolean))].sort(); }
function clip(value, max = 1000) { return String(value ?? '').slice(0, Math.max(0, Number(max) || 0)); }
function stable(value) {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
    return value;
}
function fingerprint(value) {
    const text = JSON.stringify(stable(value));
    let hash = 0xcbf29ce484222325n;
    const prime = 0x100000001b3n;
    const mask = 0xffffffffffffffffn;
    for (let i = 0; i < text.length; i += 1) {
        const code=text.charCodeAt(i);
        hash ^= BigInt(code & 0xff); hash = (hash * prime) & mask;
        hash ^= BigInt((code >>> 8) & 0xff); hash = (hash * prime) & mask;
    }
    return hash.toString(16).padStart(16, '0');
}
function physicalIdentityFromParts(mutation, assumptionsFingerprint) {
    return { version: 4, value: fingerprint({ mutation: mutation || null, assumptionsFingerprint: String(assumptionsFingerprint || fingerprint({})) }) };
}
function physicalIdentityForTransaction(transaction, mutation = null) {
    return physicalIdentityFromParts(mutation, fingerprint(transaction?.assumptions || {}));
}
function physicalIdentityForRow(row) {
    if (!row?.canonicalMutation) return null;
    return physicalIdentityFromParts(row.canonicalMutation, row.assumptionsFingerprint || fingerprint({}));
}
function storedIdentityForRow(row) {
    return physicalIdentityForRow(row) || { version: Number(row?.identityVersion || 1), value: String(row?.identity || '') };
}
function compactTransactionHistory(history = []) {
    const rows = Array.isArray(history) ? history.slice(-32) : [];
    return rows.map(item => ({
        at: Number(item?.at) || Date.now(),
        event: String(item?.event || 'journal-checkpoint'),
        state: String(item?.state || ''),
        // Full Ledger history details can contain the same Builder/Tree payloads
        // already protected by the canonical mutation/recovery authority. Keep
        // audit identity without duplicating those large payloads into localStorage.
        details: item?.details == null ? {} : { journalCompacted: true, fingerprint: fingerprint(item.details) },
    }));
}
function transactionRecordForJournal(transaction) {
    if (!transaction || typeof transaction !== 'object') return null;
    // The commit journal only needs enough typed Ledger state to reconstruct a
    // COMMITTING transaction after reload. The canonical mutation and recovery
    // descriptor already live on the journal row itself. Persisting staged and
    // mutationProposal here duplicated entire Builder Trees into every immutable
    // event and exhausted browser localStorage on large commits.
    const type = String(transaction.type || '');
    const builderTreePayload = type === 'lorebook-builder2' || type === 'lorebook-builder';
    const proposalApply = type === 'lore-proposal-apply';
    const input = proposalApply
        ? { proposalId: String(transaction?.input?.proposalId || '') }
        : clone(transaction.input || {});
    return {
        id: String(transaction.id || ''), type, state: String(transaction.state || 'committing'),
        createdAt: Number(transaction.createdAt) || Date.now(), updatedAt: Number(transaction.updatedAt) || Date.now(),
        input, assumptions: clone(transaction.assumptions || {}),
        // Builder Tree authority is in canonicalMutation + PlanStore. Lore
        // Proposal authority is in canonicalMutation plus the retained staged
        // operation. Do not store the same proposal operation again in both
        // input.operation and mutationProposal.draft on every immutable event.
        mutationProposal: (builderTreePayload || proposalApply) ? null : clone(transaction.mutationProposal || null),
        metadata: clone(transaction.metadata || {}),
        staged: builderTreePayload ? null : clone(transaction.staged ?? null),
        approval: builderTreePayload ? null : clone(transaction.approval || null),
        freshness: builderTreePayload ? null : clone(transaction.freshness || null),
        history: compactTransactionHistory(transaction.history),
        journalReconstruction: true,
    };
}
function compactTerminalJournalRow(row) {
    if (!row || typeof row !== 'object') return row;
    if (STORAGE_BODY_PROTECTED.has(String(row.state || '')) || row.dependentProjectionPending === true) return clone(row);
    const out = clone(row);
    // Terminal journal rows no longer need the physical Tree/mutation body or
    // rollback snapshot. Exact-once protection is carried by identity/version;
    // terminal diagnostics retain hashes, settlement state, and compact Ledger
    // reconstruction metadata.
    out.canonicalMutation = null;
    out.legacyNoCanonicalMutation = true;
    out.recovery = null;
    out.subwrites = [];
    out.transactionRecord = out.transactionRecord ? {
        ...out.transactionRecord,
        mutationProposal: null, staged: null, approval: null, freshness: null,
        history: compactTransactionHistory(out.transactionRecord.history),
        journalReconstruction: true,
    } : null;
    out.storageCompacted = true;
    return out;
}
function cacheProjectionRows(rows = []) {
    return (Array.isArray(rows) ? rows : []).map(row => compactTerminalJournalRow(row));
}
function validateJournalTransactionRecord(row) {
    if (row?.transactionRecord == null) return;
    const record = row.transactionRecord;
    if (!record || typeof record !== 'object' || Array.isArray(record)) throw corruptError(`Nexus commit journal row ${row.id} has a malformed transaction reconstruction record.`);
    if (Number(row.transactionRecordVersion || 0) !== 1) throw corruptError(`Nexus commit journal row ${row.id} has an unsupported transaction reconstruction version.`);
    if (String(record.id || '') !== String(row.id || '') || !String(record.type || '').trim()) throw corruptError(`Nexus commit journal row ${row.id} transaction reconstruction identity is invalid.`);
    for (const [name, value] of [['input', record.input], ['assumptions', record.assumptions], ['metadata', record.metadata]]) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw corruptError(`Nexus commit journal row ${row.id} transaction reconstruction is missing ${name}.`);
    }
    if (!Array.isArray(record.history)) throw corruptError(`Nexus commit journal row ${row.id} transaction reconstruction is missing audit history.`);
}

function indexedDbAvailable() {
    try { return !!globalThis?.indexedDB && typeof globalThis.indexedDB.open === 'function'; }
    catch { return false; }
}
function idbRequest(request) {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error('IndexedDB request failed.'));
    });
}
function closeIndexedDbConnection(db) { try { db?.close?.(); } catch {} }
function idbOpenError(message, cause = null) {
    const error = unavailableError(message);
    if (cause && !error.cause) { try { error.cause = cause; } catch {} }
    return error;
}
function idbTransactionDone(transaction) {
    return new Promise((resolve, reject) => {
        transaction.oncomplete = () => resolve(true);
        transaction.onerror = () => reject(transaction.error || new Error('IndexedDB transaction failed.'));
        transaction.onabort = () => reject(transaction.error || new Error('IndexedDB transaction was aborted.'));
    });
}
async function openCommitJournalDatabase() {
    if (idbDatabase) return idbDatabase;
    if (!indexedDbAvailable()) return null;
    if (idbOpenPromise) return await idbOpenPromise;
    const attempt = ++idbOpenAttempt;
    idbOpenPromise = new Promise((resolve, reject) => {
        const request = globalThis.indexedDB.open(IDB_DB_NAME, IDB_DB_VERSION);
        let settled = false;
        let blocked = false;
        const finish = (fn, value) => {
            if (settled) return false;
            settled = true;
            clearTimeout(timer);
            fn(value);
            return true;
        };
        const timer = setTimeout(() => {
            const detail = blocked ? ' remained blocked' : ' did not settle';
            finish(reject, idbOpenError(`Nexus IndexedDB commit journal${detail} within ${IDB_OPEN_TIMEOUT_MS} ms.`));
        }, IDB_OPEN_TIMEOUT_MS);
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db?.objectStoreNames?.contains?.(IDB_STORE)) db?.createObjectStore?.(IDB_STORE, { keyPath: 'key' });
        };
        request.onblocked = () => { blocked = true; finish(reject, idbOpenError('Nexus IndexedDB commit journal open is blocked by another connection.')); };
        request.onerror = () => finish(reject, idbOpenError('Nexus IndexedDB commit journal open failed.', request.error || null));
        request.onsuccess = () => {
            const db = request.result;
            if (settled || attempt !== idbOpenAttempt) { closeIndexedDbConnection(db); return; }
            idbDatabase = db;
            try { db.onversionchange = () => { closeIndexedDbConnection(db); if (idbDatabase === db) idbDatabase = null; idbHydrated = false; }; } catch {}
            finish(resolve, db);
        };
    });
    try { return await idbOpenPromise; }
    finally { idbOpenPromise = null; }
}
async function readIndexedDbKv() {
    const db = await openCommitJournalDatabase();
    if (!db) return new Map();
    const tx = db.transaction(IDB_STORE, 'readonly');
    const store = tx.objectStore(IDB_STORE);
    const rows = typeof store.getAll === 'function' ? await idbRequest(store.getAll()) : [];
    await idbTransactionDone(tx);
    const map = new Map();
    for (const row of Array.isArray(rows) ? rows : []) if (row && typeof row.key === 'string') map.set(row.key, String(row.value ?? ''));
    return map;
}
async function writeIndexedDbDiff(before, after, { publishMeta = true } = {}) {
    const db = await openCommitJournalDatabase();
    if (!db) throw unavailableError('IndexedDB is unavailable for Nexus commit durability.');
    const tx = db.transaction(IDB_STORE, 'readwrite');
    const store = tx.objectStore(IDB_STORE);
    const keys = new Set([...before.keys(), ...after.keys()]);
    for (const key of keys) {
        if (key === IDB_META_KEY) continue;
        const oldValue = before.get(key);
        const newValue = after.get(key);
        if (newValue === undefined) { if (oldValue !== undefined) store.delete(key); continue; }
        if (oldValue !== newValue) store.put({ key, value: String(newValue) });
    }
    if (publishMeta) store.put({ key: IDB_META_KEY, value: JSON.stringify({ version: IDB_AUTHORITY_VERSION, authority: 'indexeddb', updatedAt: Date.now() }) });
    await idbTransactionDone(tx);
    return true;
}
function legacyDurabilityKey(key) {
    const value = String(key || '');
    return value === KEY || value === LOCK_KEY || value === EVENT_SCHEMA_KEY || value === REPLAY_KEY
        || value.startsWith(EVENT_PREFIX) || value.startsWith(REPLAY_ARCHIVE_PREFIX) || value === JOURNAL_RESERVE_KEY;
}
function readLegacyLocalStorageDurability() {
    const source = (() => { try { return globalThis?.localStorage || null; } catch { return null; } })();
    const map = new Map();
    if (!source || typeof source.key !== 'function' || !Number.isFinite(Number(source.length))) return map;
    for (let i = 0; i < Number(source.length); i += 1) {
        const key = source.key(i);
        if (!legacyDurabilityKey(key) || key === JOURNAL_RESERVE_KEY) continue;
        let value = null; try { value = source.getItem(key); } catch {}
        if (value != null) map.set(String(key), String(value));
    }
    return map;
}
function legacyLocalStorageDurabilityChars() {
    const source = (() => { try { return globalThis?.localStorage || null; } catch { return null; } })();
    if (!source || typeof source.key !== 'function' || !Number.isFinite(Number(source.length))) return 0;
    let chars = 0;
    for (let i = 0; i < Number(source.length); i += 1) {
        const key = source.key(i);
        if (!legacyDurabilityKey(key)) continue;
        let value = ''; try { value = String(source.getItem(key) || ''); } catch {}
        chars += String(key || '').length + value.length;
    }
    return chars;
}
function cleanupLegacyLocalStorageDurability() {
    const source = (() => { try { return globalThis?.localStorage || null; } catch { return null; } })();
    if (!source || typeof source.key !== 'function' || !Number.isFinite(Number(source.length))) return 0;
    const keys = [];
    for (let i = 0; i < Number(source.length); i += 1) { const key = source.key(i); if (legacyDurabilityKey(key)) keys.push(String(key)); }
    for (const key of keys) { try { source.removeItem(key); } catch {} }
    try { source.setItem(IDB_AUTHORITY_MARKER_KEY, JSON.stringify({ version: IDB_AUTHORITY_VERSION, authority: 'indexeddb', migratedAt: Date.now() })); } catch {}
    return keys.length;
}
const indexedDbMirrorStorage = {
    get length() { return idbMirror.size; },
    key(index) { return sortedIdbMirrorKeys()[Number(index)] ?? null; },
    getItem(key) { const value = idbMirror.get(String(key)); return value === undefined ? null : value; },
    setItem(key, value) {
        if (idbWriteContext <= 0) throw unavailableError('Nexus IndexedDB journal mirror is read-only outside an awaited durability transaction.');
        idbMirror.set(String(key), String(value));invalidateIdbMirrorKeyOrder();
    },
    removeItem(key) {
        if (idbWriteContext <= 0) throw unavailableError('Nexus IndexedDB journal mirror is read-only outside an awaited durability transaction.');
        if(idbMirror.delete(String(key)))invalidateIdbMirrorKeyOrder();
    },
};
async function refreshIndexedDbMirror() {
    if (!idbAuthority) return false;
    const persisted = await readIndexedDbKv();
    persisted.delete(IDB_META_KEY);
    replaceIdbMirror(persisted);
    idbHydrated = true;
    return true;
}
async function runIndexedDbDurableMutation(fn) {
    if (!idbAuthority) return fn();
    const previousTail = idbMutationTail;
    let release;
    idbMutationTail = new Promise(resolve => { release = resolve; });
    await previousTail;
    try {
        await refreshIndexedDbMirror();
        const before = new Map(idbMirror);
        idbWriteContext += 1;
        let result;
        try { result = fn(); }
        catch (error) { replaceIdbMirror(before); throw error; }
        finally { idbWriteContext = Math.max(0, idbWriteContext - 1); }
        try { await writeIndexedDbDiff(before, idbMirror); }
        catch (error) { replaceIdbMirror(before); throw unavailableError(`Nexus IndexedDB commit-journal transaction failed: ${clip(error?.message || error, 500)}`); }
        return result;
    } finally { release?.(); }
}
export async function initializeNexusCommitJournalDurability() {
    if (idbInitialization) return await idbInitialization;
    idbInitialization = (async () => {
        idbStartupError = null;
        if (!browserRuntime() || !indexedDbAvailable()) {
            idbStartupState = 'ready';
            idbMigrationInfo = { mode: browserRuntime() ? 'localStorage-fallback' : 'node-test-memory', migrated: false, reason: indexedDbAvailable() ? 'non-browser-runtime' : 'indexeddb-unavailable' };
            return clone(idbMigrationInfo);
        }
        let persisted;
        try { persisted = await readIndexedDbKv(); }
        catch (error) { throw unavailableError(`Nexus IndexedDB commit journal could not open: ${clip(error?.message || error, 500)}`); }
        let meta = null;
        try { meta = JSON.parse(persisted.get(IDB_META_KEY) || 'null'); } catch {}
        const alreadyAuthoritative = !!meta && Number(meta.version) === IDB_AUTHORITY_VERSION && meta.authority === 'indexeddb';
        const legacy = readLegacyLocalStorageDurability();
        if (alreadyAuthoritative) {
            persisted.delete(IDB_META_KEY);
            replaceIdbMirror(persisted); idbAuthority = true; idbHydrated = true;
            // Validate authoritative state before legacy cleanup. No journal write
            // is permitted merely by hydration.
            loadRows(); loadReplayFences();
            const removed = cleanupLegacyLocalStorageDurability();
            idbMigrationInfo = { mode: 'indexeddb-event-authority', migrated: false, legacyKeysRemoved: removed, journalKeys: idbMirror.size };
            idbStartupState = 'ready'; idbStartupError = null;
            return clone(idbMigrationInfo);
        }
        // One-time import. Build/validate the existing event authority inside the
        // mirror first, then make IndexedDB authoritative in one committed tx.
        replaceIdbMirror(new Map(legacy)); idbAuthority = true; idbHydrated = true;
        const before = new Map();
        idbWriteContext += 1;
        try { loadRows(); loadReplayFences(); }
        catch (error) { idbAuthority = false; idbHydrated = false; replaceIdbMirror(new Map()); throw error; }
        finally { idbWriteContext = Math.max(0, idbWriteContext - 1); }
        try { await writeIndexedDbDiff(before, idbMirror, { publishMeta: true }); }
        catch (error) { idbAuthority = false; idbHydrated = false; replaceIdbMirror(new Map()); throw unavailableError(`Nexus commit-journal migration to IndexedDB failed: ${clip(error?.message || error, 500)}`); }
        const removed = cleanupLegacyLocalStorageDurability();
        idbMigrationInfo = { mode: 'indexeddb-event-authority', migrated: true, legacyKeysImported: legacy.size, legacyKeysRemoved: removed, journalKeys: idbMirror.size };
        idbStartupState = 'ready'; idbStartupError = null;
        return clone(idbMigrationInfo);
    })();
    try { return await idbInitialization; }
    catch (error) {
        idbStartupState = 'unavailable';
        idbStartupError = error;
        idbAuthority = false; idbHydrated = false; replaceIdbMirror(new Map());
        idbInitialization = null;
        throw error;
    }
}
export async function refreshNexusCommitJournalDurability() {
    if (browserRuntime() && indexedDbAvailable() && !idbAuthority) await initializeNexusCommitJournalDurability();
    else if (idbAuthority) await refreshIndexedDbMirror();
    return getNexusCommitJournalStatus();
}
export function getNexusCommitJournalDurabilityMigrationInfo() { return clone(idbMigrationInfo); }

function storage() {
    if (idbAuthority) {
        if (!idbHydrated) throw unavailableError('Nexus IndexedDB commit journal is authoritative but has not hydrated yet.');
        return indexedDbMirrorStorage;
    }
    try {
        const candidate = globalThis?.localStorage;
        if (candidate && typeof candidate.getItem === 'function' && typeof candidate.setItem === 'function') return candidate;
    } catch {}
    return null;
}
function browserRuntime() {
    return typeof globalThis?.window !== 'undefined' || typeof globalThis?.document !== 'undefined';
}
function unavailableError(message = 'Nexus durable commit journal storage is unavailable.') {
    const error = new Error(message);
    error.name = 'TV2CommitJournalUnavailable';
    return error;
}
function corruptError(message = 'Nexus durable commit journal storage is corrupt and requires operator recovery before more mutations can commit.') {
    const error = new Error(message);
    error.name = 'TV2CommitJournalCorrupt';
    return error;
}
function backend() {
    if (browserRuntime() && indexedDbAvailable() && idbStartupState === 'unavailable') {
        throw unavailableError(`Nexus commit journal is unavailable after IndexedDB initialization failure${idbStartupError?.message ? `: ${clip(idbStartupError.message, 300)}` : '.'}`);
    }
    const target = storage();
    if (target) return { target, durable: true };
    if (browserRuntime()) throw unavailableError();
    return { target: null, durable: false };
}
function parseJournalCache(target) {
    const raw = target?.getItem?.(KEY);
    if (raw == null || raw === '') return [];
    return validateJournalRows(JSON.parse(raw));
}
function eventAuthorityMode(target) {
    if (!target || !supportsStorageEnumeration(target)) return false;
    const raw = target.getItem(EVENT_SCHEMA_KEY);
    if (raw == null || raw === '') return false;
    let marker;
    try { marker = JSON.parse(raw); }
    catch (error) { throw corruptError(`Nexus commit-journal event authority marker could not be parsed: ${clip(error?.message || error, 300)}`); }
    if (!marker || typeof marker !== 'object' || Number(marker.version) !== EVENT_SCHEMA_VERSION) {
        throw corruptError(`Nexus commit-journal event authority marker version ${String(marker?.version ?? '(missing)')} is unsupported.`);
    }
    return true;
}
function quotaError(error) {
    return error?.name === 'QuotaExceededError' || Number(error?.code) === 22 || /quota/i.test(String(error?.message || ''));
}
function storagePressureSnapshot(target, limit = 6) {
    if (!target || !supportsStorageEnumeration(target)) return { approxChars: 0, keys: [] };
    const rows=[]; let approxChars=0;
    for(let i=0;i<Number(target.length);i+=1){
        const key=target.key(i); if(typeof key!=='string')continue;
        let value=''; try{value=String(target.getItem(key)||'');}catch{}
        const chars=key.length+value.length; approxChars+=chars;
        if(key.startsWith('tv2_')||key.toLowerCase().includes('nexus'))rows.push({key,chars});
    }
    rows.sort((a,b)=>b.chars-a.chars||a.key.localeCompare(b.key));
    return { approxChars, keys: rows.slice(0,Math.max(1,Number(limit)||6)) };
}
function storagePressureLabel(target){
    const snapshot=storagePressureSnapshot(target);
    const top=snapshot.keys.map(row=>`${row.key}=${row.chars}`).join(', ');
    return `approx storage ${snapshot.approxChars} chars${top?`; largest Nexus keys: ${top}`:''}`;
}
function ensureJournalReserve(target){
    if(idbAuthority)return true;
    if(!target||!supportsStorageEnumeration(target))return false;
    try{
        if(target.getItem(JOURNAL_RESERVE_KEY)!=null)return true;
        const raw='R'.repeat(JOURNAL_RESERVE_CHARS);
        target.setItem(JOURNAL_RESERVE_KEY,raw);
        return target.getItem(JOURNAL_RESERVE_KEY)===raw;
    }catch{return false;}
}
function releaseJournalReserve(target){if(idbAuthority)return;try{target?.removeItem?.(JOURNAL_RESERVE_KEY);}catch{}}
function compactProtectedJournalEventsInPlace(target, row) {
    if (!target || !supportsStorageEnumeration(target) || !eventAuthorityMode(target)) return false;
    if (!STORAGE_BODY_PROTECTED.has(String(row?.state || '')) && row?.dependentProjectionPending !== true) return false;
    const id = String(row?.id || '').trim();
    const revision = Math.max(1, Number(row?.journalRevision) || 1);
    if (!id) return false;
    const captured = loadJournalEvents(target).filter(event => String(event.id) === id);
    if (!captured.length) return false;
    mergeJournalEvents([], captured, { eventAuthority: true });
    if (captured.some(event => Number(event.revision) > revision)) return false;
    const latest = [...captured].sort((a,b)=>b.revision-a.revision)[0];
    if (!latest || Number(latest.revision) !== revision || latest.deleted === true) return false;
    const authoritativeRow = { ...clone(row), journalRevision: revision };
    if (!same(latest.row, authoritativeRow)) return false;
    if (captured.length === 1 && latest.checkpoint === true) return true;

    // Emergency/pressure-safe checkpoint promotion: reuse the latest event's
    // existing storage key instead of allocating a duplicate full mutation body.
    // The durable semantic payload (id, revision, row) is unchanged; only the
    // checkpoint marker is promoted so predecessor revisions may be removed.
    const replacement = {
        version: EVENT_SCHEMA_VERSION, id, revision, checkpoint: true, deleted: false,
        row: authoritativeRow, writtenAt: Number(latest.writtenAt) || Date.now(),
    };
    const raw = JSON.stringify(replacement);
    try {
        target.setItem(latest.storageKey, raw);
        if (target.getItem(latest.storageKey) !== raw) return false;
    } catch { return false; }

    // A concurrent newer revision uses a different immutable key and is never in
    // this deletion set. Captured predecessors are now dominated by the promoted
    // checkpoint and can be reclaimed without another allocation.
    for (const event of captured) if (event.storageKey !== latest.storageKey) target.removeItem(event.storageKey);
    return true;
}

function compactStoredProtectedEventsInPlace(target, { maxRows = LIMIT } = {}) {
    if (!target || !supportsStorageEnumeration(target) || !eventAuthorityMode(target)) return 0;
    const rows = mergeJournalEvents([], loadJournalEvents(target), { eventAuthority: true });
    let compacted = 0;
    for (const row of rows) {
        if (compacted >= maxRows) break;
        if (!STORAGE_BODY_PROTECTED.has(String(row?.state || '')) && row?.dependentProjectionPending !== true) continue;
        if (compactProtectedJournalEventsInPlace(target, row)) compacted += 1;
    }
    return compacted;
}

function compactStoredTerminalEvents(target, { maxRows = 64 } = {}) {
    if (!target || !supportsStorageEnumeration(target) || !eventAuthorityMode(target)) return 0;
    const events = loadJournalEvents(target);
    const grouped = new Map();
    for (const event of events) { const list = grouped.get(event.id) || []; list.push(event); grouped.set(event.id, list); }
    let compacted = 0;
    for (const [id, list] of grouped) {
        if (compacted >= maxRows) break;
        const ordered = [...list].sort((a,b)=>a.revision-b.revision);
        const latest = ordered[ordered.length - 1];
        const row = latest?.deleted === true ? null : latest?.row;
        if (!row || STORAGE_BODY_PROTECTED.has(String(row.state || '')) || row.dependentProjectionPending === true || row.storageCompacted === true) continue;
        // Validate the captured chain before maintenance. A compact terminal
        // checkpoint is a new revision, never an overwrite of immutable history.
        mergeJournalEvents([], ordered, { eventAuthority: true });
        const compactRow = compactTerminalJournalRow(row);
        const revision = Number(latest.revision) + 1;
        compactRow.journalRevision = revision;
        const replacement = { version: EVENT_SCHEMA_VERSION, id, revision, checkpoint: true, deleted: false, row: compactRow, writtenAt: Date.now() };
        const key = eventKey();
        const raw = JSON.stringify(replacement);
        try {
            target.setItem(key, raw);
            if (target.getItem(key) !== raw) { target.removeItem(key); continue; }
        } catch { continue; }
        for (const event of ordered) target.removeItem(event.storageKey);
        compacted += 1;
    }
    return compacted;
}
function relieveJournalQuota(target) {
    if (!target || !supportsStorageEnumeration(target)) return;
    // Once event authority exists the whole-snapshot key is only a cache. Drop
    // it first because it can duplicate every large row and is safe to rebuild.
    try { if (eventAuthorityMode(target)) target.removeItem(KEY); } catch {}
    try { pruneDeletedJournalEvents(target); } catch {}
    try { compactStoredProtectedEventsInPlace(target, { maxRows: LIMIT }); } catch {}
    try { compactStoredTerminalEvents(target, { maxRows: LIMIT }); } catch {}
}
function writeJournalEvent(target, event, { maintenance = true } = {}) {
    const key = eventKey();
    const row = event?.deleted === true ? null : compactTerminalJournalRow(event?.row);
    const normalized = row ? { ...event, row, revision: Number(event.revision), id: String(event.id) } : event;
    const raw = JSON.stringify(normalized);
    // Compact/prune before a durability-critical write instead of waiting until
    // localStorage is already full. A small reserve keeps enough emergency room
    // for one canonical journal checkpoint even if review/proposal state grows.
    if(maintenance){ try { relieveJournalQuota(target); } catch {} }
    ensureJournalReserve(target);
    try { target.setItem(key, raw); }
    catch (error) {
        if (!quotaError(error)) throw error;
        releaseJournalReserve(target);
        if(maintenance)relieveJournalQuota(target);
        try { target.setItem(key, raw); }
        catch (retryError) {
            if (!quotaError(retryError)) throw retryError;
            throw unavailableError(`Nexus commit-journal quota remained exhausted after safe compaction/reserve release (${storagePressureLabel(target)}).`);
        }
    }
    if (target.getItem(key) !== raw) throw unavailableError('Nexus commit-journal immutable event could not be verified after persistence.');
    return { ...clone(normalized), storageKey: key };
}
function ensureEventAuthority(target) {
    if (!target || !supportsStorageEnumeration(target)) return false;
    if (eventAuthorityMode(target)) return true;
    // One-time migration: turn every legacy snapshot row into an immutable
    // checkpoint before the marker is published. Concurrent migrations may write
    // duplicate checkpoint events, but identical same-revision payloads merge
    // deterministically and no writer can make the cache authoritative again.
    const base = parseJournalCache(target);
    const existing = loadJournalEvents(target);
    const idsWithEvents = new Set(existing.map(event => String(event.id)));
    for (const row of base) {
        const id = String(row.id);
        if (idsWithEvents.has(id)) continue;
        const revision = Math.max(1, Number(row.journalRevision) || 1);
        writeJournalEvent(target, {
            version: EVENT_SCHEMA_VERSION, id, revision, checkpoint: true, deleted: false,
            row: { ...clone(row), journalRevision: revision }, writtenAt: Date.now(),
        });
    }
    const marker = JSON.stringify({ version: EVENT_SCHEMA_VERSION, migratedAt: Date.now() });
    target.setItem(EVENT_SCHEMA_KEY, marker);
    if (target.getItem(EVENT_SCHEMA_KEY) !== marker) throw unavailableError('Nexus commit-journal event authority marker could not be verified after persistence.');
    return true;
}
function loadJournalEvents(target) {
    const events = [];
    for (const key of storageKeys(target, EVENT_PREFIX)) {
        let event;
        try { event = JSON.parse(target.getItem(key) || 'null'); }
        catch (error) { throw corruptError(`Nexus commit-journal event ${key} could not be parsed: ${clip(error?.message || error, 300)}`); }
        if (!event || typeof event !== 'object' || Array.isArray(event)) throw corruptError(`Nexus commit-journal event ${key} is malformed.`);
        if (Number(event.version) !== EVENT_SCHEMA_VERSION) throw corruptError(`Nexus commit-journal event ${key} has unsupported schema version ${String(event.version ?? '(missing)')}.`);
        const id = String(event.id || '').trim();
        const revision = Number(event.revision);
        if (!id || !Number.isInteger(revision) || revision <= 0 || (event.deleted !== true && (!event.row || typeof event.row !== 'object' || Array.isArray(event.row)))) {
            throw corruptError(`Nexus commit-journal event ${key} is missing durable identity/revision authority.`);
        }
        if (event.deleted !== true) {
            if (String(event.row?.id || '').trim() !== id || Number(event.row?.journalRevision || 0) !== revision) {
                throw corruptError(`Nexus commit-journal event ${key} does not match its row identity/revision authority.`);
            }
        }
        events.push({ ...event, id, revision, checkpoint: event.checkpoint === true, storageKey: key });
    }
    return events;
}
function mergeJournalEvents(baseRows, events, { eventAuthority = false } = {}) {
    const grouped = new Map();
    for (const event of events || []) {
        if (!grouped.has(event.id)) grouped.set(event.id, new Map());
        const revisions = grouped.get(event.id);
        const existing = revisions.get(event.revision);
        const semantic = { deleted: event.deleted === true, row: event.deleted === true ? null : clone(event.row) };
        if (existing && !same({ deleted: existing.deleted, row: existing.row }, semantic)) {
            const error = corruptError(`Nexus commit journal contains conflicting immutable events for transaction ${event.id} revision ${event.revision}.`);
            error.name = 'TV2CommitJournalConflict';
            throw error;
        }
        revisions.set(event.revision, { ...semantic, checkpoint: existing?.checkpoint === true || event.checkpoint === true });
    }

    const byId = new Map();
    // Before event-authority migration, the legacy whole-snapshot cache remains
    // the compatibility base. Afterwards, immutable events are authoritative and
    // a stale older Nexus tab cannot resurrect a row merely by rewriting KEY.
    if (!eventAuthority) {
        for (const row of validateJournalRows(baseRows || [])) {
            const copy = clone(row);
            copy.journalRevision = Math.max(0, Number(copy.journalRevision) || 0);
            byId.set(String(copy.id), { revision: copy.journalRevision, row: copy, deleted: false, source: 'cache' });
        }
    }

    for (const [id, revisions] of grouped) {
        const current = byId.get(id) || { revision: 0, row: null, deleted: false };
        for (const revision of [...revisions.keys()].sort((a,b)=>a-b)) {
            if (revision <= current.revision) continue;
            const payload = revisions.get(revision);
            if (revision !== current.revision + 1 && !(payload.checkpoint === true && revision > current.revision)) {
                throw corruptError(`Nexus commit journal transaction ${id} has a non-contiguous immutable revision sequence.`);
            }
            current.revision = revision; current.deleted = payload.deleted; current.row = payload.row ? clone(payload.row) : null;
            if (current.row) current.row.journalRevision = revision;
        }
        byId.set(id, current);
    }
    return validateJournalRows([...byId.values()].filter(item => !item.deleted && item.row).map(item => item.row));
}
function compactTerminalJournalEvents(target, row) {
    if (!target || !supportsStorageEnumeration(target) || !eventAuthorityMode(target)) return;
    // Only terminal rows may be collapsed to a checkpoint. COMMITTING and
    // RECOVERY-REQUIRED rows still carry the canonical mutation/recovery body;
    // checkpointing them duplicates the largest durability payload exactly when
    // browser storage is under the most pressure. This was the live Notebook
    // quota deadlock: revision N persisted, then maintenance tried to allocate a
    // second full copy of revision N before freeing anything.
    if (STORAGE_BODY_PROTECTED.has(String(row?.state || '')) || row?.dependentProjectionPending === true) {
        compactProtectedJournalEventsInPlace(target, row);
        return;
    }
    const id = String(row?.id || '').trim();
    const revision = Math.max(1, Number(row?.journalRevision) || 1);
    if (!id) return;
    const old = loadJournalEvents(target).filter(event => String(event.id) === id);
    if (old.length <= 1 && old[0]?.checkpoint === true && old[0]?.revision === revision) return;
    // Validate the exact captured chain before deleting any predecessor. More
    // importantly, never compact across a revision newer than the row this caller
    // proved. Another tab can append after mutate() verifies its own event but
    // before this maintenance step begins. That newer revision must survive.
    mergeJournalEvents([], old, { eventAuthority: true });
    if (old.some(event => Number(event.revision) > revision)) return;
    const checkpoint = writeJournalEvent(target, {
        version: EVENT_SCHEMA_VERSION, id, revision, checkpoint: true, deleted: false,
        row: { ...clone(row), journalRevision: revision }, writtenAt: Date.now(),
    }, { maintenance: false });
    // The checkpoint is durable before any captured predecessor is removed. Any
    // event arriving after `old` was captured is not in this deletion set; any
    // event already newer caused the early return above.
    for (const event of old) if (event.storageKey !== checkpoint.storageKey) target.removeItem(event.storageKey);
}
function pruneDeletedJournalEvents(target) {
    if (!target || !supportsStorageEnumeration(target) || !eventAuthorityMode(target)) return;
    const events = loadJournalEvents(target);
    const grouped = new Map();
    for (const event of events) {
        const list = grouped.get(event.id) || []; list.push(event); grouped.set(event.id, list);
    }
    for (const list of grouped.values()) {
        const latest = [...list].sort((a,b)=>b.revision-a.revision)[0];
        if (latest?.deleted !== true) continue;
        for (const event of list) target.removeItem(event.storageKey);
    }
}
function loadRows() {
    const { target } = backend();
    if (!target) return validateJournalRows(memoryRows.map(clone));
    try {
        if (supportsStorageEnumeration(target)) {
            ensureEventAuthority(target);
            const events = loadJournalEvents(target);
            return mergeJournalEvents([], events, { eventAuthority: true });
        }
        // Non-enumerable storage is a Node/test compatibility backend only. Real
        // browser localStorage is enumerable; do not claim cross-tab event safety
        // when the backend cannot discover immutable event keys.
        return parseJournalCache(target);
    } catch (error) {
        if (error?.name === 'TV2CommitJournalCorrupt' || error?.name === 'TV2CommitJournalConflict') throw error;
        throw corruptError(`Nexus durable commit journal could not be parsed: ${clip(error?.message || error, 300)}`);
    }
}
function saveRows(rows) {
    validateJournalRows(rows);
    memoryRows = rows.map(clone);
    const { target } = backend();
    if (!target) return;
    const eventAuthority = supportsStorageEnumeration(target) && eventAuthorityMode(target);
    const raw = JSON.stringify(eventAuthority ? cacheProjectionRows(rows) : rows);
    if (eventAuthority) {
        // Immutable events are authoritative after migration. KEY is retained only
        // as a compatibility/diagnostic projection for older code. Never report
        // an already-durable journal transition as failed merely because this
        // secondary cache is stale, quota-limited, or otherwise unwritable.
        try {
            target.setItem(KEY, raw);
            if (target.getItem(KEY) !== raw) throw new Error('compatibility cache read-back mismatch');
            lastCacheProjectionError = '';
        } catch (error) {
            lastCacheProjectionError = clip(error?.message || error || 'compatibility cache projection failed', 500);
        }
        // Event-chain corruption is authority corruption, not a cache problem.
        // Keep that failure visible and fail closed.
        pruneDeletedJournalEvents(target);
        return;
    }
    try {
        target.setItem(KEY, raw);
        if (target.getItem(KEY) !== raw) throw unavailableError('Nexus durable commit journal compatibility store could not be verified after persistence.');
        lastCacheProjectionError = '';
    } catch (error) {
        if (error?.name === 'TV2CommitJournalUnavailable' || error?.name === 'TV2CommitJournalCorrupt' || error?.name === 'TV2CommitJournalConflict') throw error;
        throw unavailableError(`Nexus durable commit journal could not be persisted: ${clip(error?.message || error, 300)}`);
    }
}
function appendJournalEvent(row, { deleted = false, revision = null } = {}) {
    const id = String(row?.id || '').trim();
    if (!id) throw new Error('Commit journal event requires a transaction ID.');
    const currentRevision = Math.max(0, Number(row?.journalRevision) || 0);
    const nextRevision = revision == null ? currentRevision + 1 : Number(revision);
    if (!Number.isInteger(nextRevision) || nextRevision <= 0) throw new Error('Commit journal event requires a positive revision.');
    const authoritativeRow = deleted === true ? null : compactTerminalJournalRow({ ...clone(row), journalRevision: nextRevision });
    const event = { version: 1, id, revision: nextRevision, deleted: deleted === true, row: authoritativeRow, writtenAt: Date.now() };
    const { target } = backend();
    if (!target) {
        if (deleted) memoryRows = memoryRows.filter(item => String(item.id) !== id);
        else { const rows=memoryRows.filter(item=>String(item.id)!==id); rows.push(event.row); memoryRows=rows; }
        return clone(event);
    }
    try {
        if (supportsStorageEnumeration(target)) ensureEventAuthority(target);
        return writeJournalEvent(target, event);
    } catch (error) {
        if (error?.name === 'TV2CommitJournalUnavailable') throw error;
        throw unavailableError(`Nexus commit-journal immutable event could not be persisted: ${clip(error?.message || error, 300)}`);
    }
}
function replayArchiveKey(identity) {
    return `${REPLAY_ARCHIVE_PREFIX}${Number(identity?.version || 1)}:${encodeURIComponent(String(identity?.value || ''))}`;
}
function loadArchivedReplayFence(identity) {
    const { target } = backend();
    if (!target || !identity?.value) return null;
    const raw = target.getItem(replayArchiveKey(identity));
    if (!raw) return null;
    try {
        const row = JSON.parse(raw);
        validateReplayRows([row]);
        const stored = { version: Number(row?.physicalIdentityVersion || row?.identityVersion || 1), value: String(row?.physicalIdentity || row?.identity || '') };
        if (stored.version !== Number(identity.version) || stored.value !== String(identity.value)) throw corruptError('Nexus archived replay-fence key and row identity disagree.');
        return row;
    } catch (error) {
        if (error?.name === 'TV2CommitJournalCorrupt') throw error;
        throw corruptError(`Nexus archived replay fence could not be parsed: ${clip(error?.message || error, 300)}`);
    }
}
function replayCapacityError(message = `Nexus replay archive reached its ${REPLAY_ARCHIVE_LIMIT}-identity safety bound. Reconcile/export history before admitting mutations that would discard exact-once authority.`) {
    const error = new Error(message); error.name = 'TV2CommitReplayCapacity'; error.limit = REPLAY_ARCHIVE_LIMIT; return error;
}
function archiveReplayFence(row) {
    const identity = {
        version: Number(row?.physicalIdentityVersion || row?.identityVersion || 1),
        value: String(row?.physicalIdentity || row?.identity || ''),
    };
    if (!identity.value) return;
    const { target } = backend();
    if (!target) return;
    const key = replayArchiveKey(identity);
    const raw = JSON.stringify(row);
    try {
        if (target.getItem(key) == null && storageKeys(target, REPLAY_ARCHIVE_PREFIX).length >= REPLAY_ARCHIVE_LIMIT) throw replayCapacityError();
        target.setItem(key, raw);
        if (target.getItem(key) !== raw) throw unavailableError('Nexus replay archive write could not be verified.');
    } catch (error) {
        if (error?.name === 'TV2CommitJournalUnavailable' || error?.name === 'TV2CommitReplayCapacity') throw error;
        throw unavailableError(`Nexus replay archive could not be persisted: ${clip(error?.message || error, 300)}`);
    }
}
function loadReplayFences() {
    const { target } = backend();
    if (!target) return validateReplayRows(memoryReplayFences.map(clone));
    try { const parsed=JSON.parse(target.getItem(REPLAY_KEY)||'[]'); return validateReplayRows(parsed); }
    catch (error) { if(error?.name==='TV2CommitJournalCorrupt')throw error; throw corruptError(`Nexus replay-fence store could not be parsed: ${clip(error?.message||error,300)}`); }
}
function saveReplayFences(rows) {
    const { target } = backend();
    const input = validateReplayRows(Array.isArray(rows) ? rows : []);
    const overflow = input.length > REPLAY_LIMIT ? input.slice(0, input.length - REPLAY_LIMIT) : [];
    const bounded = input.slice(-REPLAY_LIMIT);
    // The hot replay set remains bounded, but evicted exact-once authority is
    // moved to durable per-identity archive keys rather than forgotten.
    for (const row of overflow) archiveReplayFence(row);
    memoryReplayFences = bounded.map(clone);
    if (!target) return;
    try {
        const raw = JSON.stringify(bounded);
        target.setItem(REPLAY_KEY, raw);
        if (target.getItem(REPLAY_KEY) !== raw) throw unavailableError('Nexus replay-fence store write could not be verified.');
    } catch (error) {
        if (error?.name === 'TV2CommitJournalUnavailable' || error?.name === 'TV2CommitReplayCapacity') throw error;
        throw unavailableError(`Nexus replay-fence store could not be persisted: ${clip(error?.message||error,300)}`);
    }
}
function addReplayFence(row) {
    const identity = storedIdentityForRow(row);
    if (!identity.value) return;
    const fences = loadReplayFences();
    const key = `${identity.version}|${identity.value}`;
    const filtered = fences.filter(item => `${Number(item.physicalIdentityVersion || item.identityVersion || 1)}|${String(item.physicalIdentity || item.identity || '')}` !== key);
    filtered.push({
        id: String(row.id || ''),
        physicalIdentity: String(identity.value),
        physicalIdentityVersion: Number(identity.version),
        resolvedAt: Date.now(),
        type: String(row.type || 'unknown'),
        chatId: row.chatId ?? null,
        supersededAt: null,
        supersededBy: null,
        outcome: String(row.state || '') === 'reconciled-diverged' ? 'unknown-diverged' : (String(row.state || '') === 'reconciled-abandoned' ? 'unknown-abandoned' : 'applied'),
    });
    saveReplayFences(filtered);
}
function replayFenceFor(identity){
    const hot = loadReplayFences().find(row => Number(row.physicalIdentityVersion || row.identityVersion || 1) === identity.version && String(row.physicalIdentity || row.identity || '') === identity.value) || null;
    const row = hot || loadArchivedReplayFence(identity);
    return row && !row.supersededAt ? row : null;
}
function assertReplayCapacityForJournalAdmission(rows) {
    if (!Array.isArray(rows) || rows.length < LIMIT) return true;
    const evictable = rows.find(row => !RETENTION_PROTECTED.has(String(row?.state || '')));
    if (!evictable || !PHYSICAL_REPLAY_FENCE.has(String(evictable?.state || ''))) return true;
    const physical = storedIdentityForRow(evictable);
    if (!physical.value) return true;
    const hot = loadReplayFences();
    const physicalKey = `${physical.version}|${physical.value}`;
    if (hot.some(row => `${Number(row.physicalIdentityVersion || row.identityVersion || 1)}|${String(row.physicalIdentity || row.identity || '')}` === physicalKey)) return true;
    if (hot.length < REPLAY_LIMIT) return true;
    const oldest = hot[0];
    const oldestIdentity = { version: Number(oldest?.physicalIdentityVersion || oldest?.identityVersion || 1), value: String(oldest?.physicalIdentity || oldest?.identity || '') };
    const { target } = backend();
    if (!target || !supportsStorageEnumeration(target) || !oldestIdentity.value) return true;
    if (target.getItem(replayArchiveKey(oldestIdentity)) != null) return true;
    if (storageKeys(target, REPLAY_ARCHIVE_PREFIX).length >= REPLAY_ARCHIVE_LIMIT) throw replayCapacityError();
    return true;
}
function supersedeReplayFence(identity, { byTransactionId = null, note = '' } = {}) {
    if (!identity?.value) return false;
    const now = Date.now();
    let changed = false;
    const fences = loadReplayFences().map(row => {
        if (Number(row.physicalIdentityVersion || row.identityVersion || 1) !== identity.version || String(row.physicalIdentity || row.identity || '') !== identity.value) return row;
        changed = true;
        return { ...row, supersededAt: now, supersededBy: byTransactionId ? String(byTransactionId) : null, supersessionNote: clip(note, 500) };
    });
    if (changed) saveReplayFences(fences);
    const archived = loadArchivedReplayFence(identity);
    if (archived) {
        archiveReplayFence({ ...archived, supersededAt: now, supersededBy: byTransactionId ? String(byTransactionId) : null, supersessionNote: clip(note, 500) });
        changed = true;
    }
    return changed;
}

// Cross-tab correctness no longer depends on the old localStorage read/set/read
// pseudo-lock. Every journal state transition is first appended as an immutable,
// uniquely keyed event. Whole-snapshot KEY writes are only a compatibility/cache
// projection and may be overwritten without losing authority.
function withJournalLock(fn) { return fn(); }
function compactRows(rows) {
    const working = [...rows];
    while (working.length > LIMIT) {
        const index = working.findIndex(row => !RETENTION_PROTECTED.has(String(row?.state || '')));
        if (index < 0) break;
        const [removed] = working.splice(index, 1);
        if (removed && PHYSICAL_REPLAY_FENCE.has(String(removed.state || ''))) addReplayFence(removed);
        if (removed) appendJournalEvent(removed, { deleted: true, revision: Math.max(0, Number(removed.journalRevision)||0) + 1 });
    }
    return working;
}
function mutate(id, fn) {
    const rows = loadRows();
    const row = rows.find(item => item.id === String(id));
    if (!row) return null;
    const beforeRevision = Math.max(0, Number(row.journalRevision) || 0);
    fn(row, rows);
    const event = appendJournalEvent(row, { revision: beforeRevision + 1 });
    const { target } = backend();
    const reconciled = compactRows(target && supportsStorageEnumeration(target)
        ? loadRows()
        : rows.map(item => String(item.id) === String(id) ? clone(event.row) : clone(item)));
    const authoritative = reconciled.find(item => String(item.id) === String(id));
    if (!authoritative || Number(authoritative.journalRevision || 0) !== Number(event.revision) || !same(authoritative, event.row)) {
        const error = new Error(`Nexus commit journal transition for ${id} lost revision ownership before acknowledgement.`);
        error.name = 'TV2CommitJournalConflict';
        throw error;
    }
    saveRows(reconciled);
    compactTerminalJournalEvents(target, authoritative);
    return clone(authoritative);
}

function commitIdentity(transaction, { mutation = null } = {}) {
    if (mutation && typeof mutation === 'object') return physicalIdentityForTransaction(transaction, mutation);
    return {
        version: 1,
        value: fingerprint({
            type: transaction?.type,
            chatId: transaction?.assumptions?.chatId ?? null,
            assumptions: transaction?.assumptions || {},
            input: transaction?.input || {},
        }),
    };
}
function rowMatchesIdentity(row, identity, mutation = null) {
    if (mutation && typeof mutation === 'object') {
        const physical = physicalIdentityForRow(row);
        if (physical) return physical.version === identity.version && physical.value === identity.value;
        // Terminal storage compaction intentionally drops canonicalMutation. Its
        // identity was computed from that exact mutation at admission and remains
        // sufficient replay authority after the physical effect is terminal.
        return Number(row?.identityVersion || 1) === identity.version && String(row?.identity || '') === identity.value;
    }
    return Number(row?.identityVersion || 1) === identity.version && String(row?.identity || '') === identity.value;
}

export function findMatchingNexusCommitIntents(transaction, { states = ['committing', 'recovery-required'], mutation = null, recovery = null } = {}) {
    const wanted = new Set((Array.isArray(states) ? states : []).map(String));
    const identity = commitIdentity(transaction, { mutation, recovery });
    return loadRows().filter(row => wanted.has(String(row?.state || '')) && rowMatchesIdentity(row, identity, mutation)).map(clone);
}

export function beginNexusCommitIntent(transaction, { mutation = null, recovery = null, metadata = null } = {}) {
    if (!transaction?.id) throw new Error('Commit journal requires a Nexus transaction ID.');
    const rows = loadRows();
    const identity = commitIdentity(transaction, { mutation, recovery });
    const existingSameId = rows.find(row => row.id === String(transaction.id));
    if (existingSameId) {
        if (!rowMatchesIdentity(existingSameId, identity, mutation)) {
            const error = new Error(`Nexus transaction ID ${transaction.id} is already bound to a different durable mutation identity.`);
            error.name = 'TV2CommitIdCollision'; error.commitIntent = clone(existingSameId); throw error;
        }
        const state = String(existingSameId.state || '');
        if (PHYSICAL_REPLAY_FENCE.has(state)) {
            const unknown = unknownOutcomeState(state);
            const error = new Error(unknown
                ? `Nexus commit intent ${existingSameId.id} owns an unknown prior physical outcome for this exact mutation identity. Exact replay is permanently fenced.`
                : `Nexus commit intent ${existingSameId.id} already applied this transaction identity.`);
            error.name = unknown ? 'TV2CommitOutcomeUnknown' : 'TV2CommitAlreadyApplied'; error.commitIntent = clone(existingSameId); throw error;
        }
        if (UNRESOLVED.has(state)) {
            const error = new Error(`Nexus commit intent ${existingSameId.id} is ${state} and must be reconciled before the same transaction ID can execute again.`);
            error.name = 'TV2CommitRecoveryRequired'; error.commitIntent = clone(existingSameId); throw error;
        }
        const error = new Error(`Nexus transaction ID ${transaction.id} already has terminal journal state ${state}; retries require a new transaction ID.`);
        error.name = 'TV2CommitIdTerminal'; error.commitIntent = clone(existingSameId); throw error;
    }
    const compactFence = replayFenceFor(identity);
    if (compactFence) {
        const unknown = String(compactFence.outcome || '').startsWith('unknown-');
        const error = new Error(unknown
            ? `Nexus replay fence ${compactFence.id || '(archived)'} owns a diverged/unknown prior outcome for this exact mutation identity. Refresh source state before creating a new mutation.`
            : `Nexus replay fence ${compactFence.id || '(archived)'} already applied this exact mutation identity.`);
        error.name = unknown ? 'TV2CommitOutcomeUnknown' : 'TV2CommitAlreadyApplied'; error.commitIntent = clone(compactFence); throw error;
    }
    const appliedTwin = rows.find(row => PHYSICAL_REPLAY_FENCE.has(String(row.state || '')) && rowMatchesIdentity(row, identity, mutation));
    if (appliedTwin) {
        const unknown = unknownOutcomeState(String(appliedTwin.state || ''));
        const error = new Error(unknown
            ? `Nexus commit intent ${appliedTwin.id} owns an unknown prior outcome for this exact mutation identity. Refresh source state; exact replay remains fenced.`
            : `Nexus commit intent ${appliedTwin.id} already applied this exact mutation identity. Refresh source state before attempting another commit.`);
        error.name = unknown ? 'TV2CommitOutcomeUnknown' : 'TV2CommitAlreadyApplied'; error.commitIntent = clone(appliedTwin); throw error;
    }
    const unresolvedTwin = rows.find(row => UNRESOLVED.has(String(row.state || '')) && rowMatchesIdentity(row, identity, mutation));
    if (unresolvedTwin) {
        const error = new Error(`Unresolved Nexus commit intent ${unresolvedTwin.id} already owns this mutation identity.`);
        error.name = 'TV2CommitRecoveryRequired'; error.commitIntent = clone(unresolvedTwin); throw error;
    }
    const protectedCount = rows.filter(row => RETENTION_PROTECTED.has(String(row?.state || ''))).length;
    if (protectedCount >= LIMIT) {
        const error = new Error(`Nexus commit journal has ${protectedCount} unresolved commit authorities, reaching its ${LIMIT}-row hot safety bound. Reconcile interrupted commits before admitting another mutation.`);
        error.name = 'TV2CommitJournalBackpressure'; error.limit = LIMIT; error.unresolved = protectedCount; throw error;
    }
    // If admitting this intent would evict an applied/committed hot row, prove
    // that its exact-once identity still has durable capacity *before* appending
    // the new intent. Capacity exhaustion therefore backpressures pre-write
    // instead of leaving a surprise recovery-required intent after the fact.
    assertReplayCapacityForJournalAdmission(rows);
    const now = Date.now();
    const durable = !!storage();
    const row = {
        id: String(transaction.id),
        type: String(transaction.type || 'unknown'),
        chatId: transaction?.assumptions?.chatId ?? null,
        identity: identity.value,
        identityVersion: identity.version,
        canonicalMutation: clone(mutation),
        legacyNoCanonicalMutation: mutation == null,
        recovery: clone(recovery),
        recoveryFingerprint: fingerprint(recovery),
        commitMetadata: clone(metadata),
        resources: normalizeResources(metadata?.resources || []),
        state: 'committing',
        commitPhase: 'intent-durable',
        physicalPersistenceBegun: false,
        subwrites: [],
        createdAt: now,
        updatedAt: now,
        appliedAt: null,
        resolvedAt: null,
        assumptionsFingerprint: fingerprint(transaction.assumptions || {}),
        inputFingerprint: fingerprint(transaction.input || {}),
        stagedFingerprint: fingerprint(transaction.staged ?? null),
        mutationTarget: clone(transaction?.mutationProposal?.target ?? null),
        resultFingerprint: null,
        transactionRecordVersion: 1,
        transactionRecord: transactionRecordForJournal(transaction),
        error: '',
        durability: durable ? 'durable' : 'node-test-memory',
        journalRevision: 0,
    };
    const createdEvent = appendJournalEvent(row, { revision: 1 });
    const { target } = backend();
    const reconciled = compactRows(target && supportsStorageEnumeration(target)
        ? loadRows()
        : [...rows.map(clone), clone(createdEvent.row)]);
    const admitted = reconciled.find(item => String(item.id) === row.id);
    if (!admitted || !rowMatchesIdentity(admitted, identity, mutation)) {
        const error = new Error(`Nexus commit intent ${row.id} lost immutable journal ownership during admission.`);
        error.name = 'TV2CommitJournalConflict'; throw error;
    }
    saveRows(reconciled);
    return clone(admitted);
}

export function updateNexusCommitIntentRecovery(id, recovery = null) {
    const row = mutate(id, item => {
        item.recovery = clone(recovery);
        item.recoveryFingerprint = fingerprint(recovery);
        item.updatedAt = Date.now();
    });
    if (!row) throw new Error(`Nexus commit intent ${id} was not found.`);
    return row;
}

export function updateNexusCommitIntentPhase(id, phase, { physicalPersistenceBegun = undefined, subwrite = null } = {}) {
    const normalized = String(phase || '').trim() || 'unknown';
    const row = mutate(id, item => {
        item.commitPhase = normalized;
        if (physicalPersistenceBegun !== undefined) item.physicalPersistenceBegun = physicalPersistenceBegun === true;
        if (subwrite) {
            const list = Array.isArray(item.subwrites) ? item.subwrites : [];
            const checkpoint = clone(subwrite);
            checkpoint.at = Number(checkpoint.at) || Date.now();
            checkpoint.sequence = list.length + 1;
            list.push(checkpoint);
            item.subwrites = list;
        }
        item.updatedAt = Date.now();
    });
    if (!row) throw new Error(`Nexus commit intent ${id} was not found.`);
    return row;
}

function resourcesForRow(row) {
    return normalizeResources(row?.resources || row?.commitMetadata?.resources || []);
}
export function findNexusCommitResourceConflicts(resources, { excludeId = null, states = [...UNRESOLVED] } = {}) {
    const wanted = new Set((Array.isArray(states) ? states : []).map(String));
    const requested = new Set(normalizeResources(resources));
    if (!requested.size) return [];
    return loadRows().filter(row => {
        if (excludeId != null && String(row.id) === String(excludeId)) return false;
        if (!wanted.has(String(row.state || ''))) return false;
        return resourcesForRow(row).some(resource => requested.has(resource));
    }).map(clone);
}

export function markNexusCommitIntentApplied(id, result = null) {
    const row = mutate(id, item => {
        item.state = 'applied'; item.commitPhase = 'applied'; item.physicalPersistenceBegun = true; item.appliedAt = Date.now(); item.updatedAt = item.appliedAt; item.resultFingerprint = fingerprint(result);
        // External Function Gateway transactions are themselves durable review
        // authority. Preserve their exact terminal value in the crash journal so
        // startup reconciliation never fabricates COMMITTED data from an older
        // STAGED projection. Internal mutation results can contain whole Trees,
        // so keep the extra durable payload deliberately scoped to external rows.
        if (String(item.type || '').startsWith('external:')) item.settlementResult = clone(result);
    });
    if (!row) throw new Error(`Nexus commit intent ${id} was not found.`);
    return row;
}

export function completeNexusCommitIntent(id, result = null) {
    const row = mutate(id, item => {
        item.state = 'committed'; item.commitPhase = 'committed'; item.updatedAt = Date.now(); item.resolvedAt = item.updatedAt; item.resultFingerprint = fingerprint(result); item.error = '';
        if (String(item.type || '').startsWith('external:')) item.settlementResult = clone(result);
    });
    if (!row) throw new Error(`Nexus commit intent ${id} was not found.`);
    return row;
}

export function failNexusCommitIntent(id, error, { recoveryRequired = false } = {}) {
    return mutate(id, item => {
        item.state = recoveryRequired ? 'recovery-required' : 'failed'; item.commitPhase = recoveryRequired ? 'recovery-required' : 'failed'; item.updatedAt = Date.now();
        item.resolvedAt = recoveryRequired ? null : item.updatedAt; item.error = clip(error?.message || error || 'Commit failed.', 1000);
    });
}

export function getNexusCommitJournal({ unresolvedOnly = false } = {}) {
    const rows = loadRows();
    return (unresolvedOnly ? rows.filter(row => UNRESOLVED.has(String(row?.state || '')) || row?.dependentProjectionPending === true) : rows).map(clone);
}

export function markNexusCommitRecoveryRequired(id, reason = 'Commit outcome requires reconciliation.') {
    return failNexusCommitIntent(id, reason, { recoveryRequired: true });
}

export function markNexusDependentProjectionPending(id, error = null) {
    const row = mutate(id, item => {
        item.dependentProjectionPending = true;
        item.dependentProjectionError = clip(error?.message || error || 'Dependent audit projection requires reconciliation.', 1000);
        item.dependentProjectionUpdatedAt = Date.now();
    });
    if (!row) throw new Error(`Nexus commit intent ${id} was not found.`);
    return row;
}
export function clearNexusDependentProjectionPending(id) {
    const row = mutate(id, item => {
        item.dependentProjectionPending = false;
        item.dependentProjectionError = '';
        item.dependentProjectionUpdatedAt = Date.now();
    });
    if (!row) throw new Error(`Nexus commit intent ${id} was not found.`);
    return row;
}

function assertRecoveryVerification(item, normalized, verification) {
    const state = String(verification?.state || '');
    const expectedFingerprint = String(item?.recoveryFingerprint || fingerprint(item?.recovery ?? null));
    const suppliedFingerprint = String(verification?.recoveryFingerprint || '');
    const fingerprintMatches = !item?.recovery || (suppliedFingerprint && suppliedFingerprint === expectedFingerprint);
    if (normalized === 'confirmed-applied') {
        if (String(item.state || '') === 'applied') return;
        if (state !== 'post' || !fingerprintMatches) {
            const error = new Error(`Commit intent ${item.id} cannot be confirmed applied without current canonical POST proof for the same recovery descriptor.`);
            error.name = 'TV2CommitRecoveryUnverified'; throw error;
        }
    }
    if (normalized === 'confirmed-not-applied' || normalized === 'superseded') {
        const provablyPreWrite = item.physicalPersistenceBegun !== true && (!Array.isArray(item.subwrites) || item.subwrites.length === 0) && !item.recovery;
        if (!provablyPreWrite && (state !== 'pre' || !fingerprintMatches)) {
            const error = new Error(`Commit intent ${item.id} cannot clear unresolved physical ownership without current canonical PRE proof.`);
            error.name = 'TV2CommitRecoveryUnverified'; throw error;
        }
    }
    if (normalized === 'abandoned') {
        // Abandon is the terminalizer for genuinely unknowable archaeology. It
        // does NOT mean "not applied". If PRE/POST/conflict is provable, use the
        // corresponding truthful disposition instead. Unknown outcome is fenced
        // forever by exact mutation identity below.
        if (verification?.compatible === true || state !== 'unknown' || (item.recovery && !fingerprintMatches)) {
            const error = new Error(`Commit intent ${item.id} can only be abandoned when canonical PRE/POST truth is genuinely unavailable.`);
            error.name = 'TV2CommitRecoveryUnverified'; throw error;
        }
    }
    if (normalized === 'diverged') {
        if (!item.recovery || state !== 'conflict' || !fingerprintMatches) {
            const error = new Error(`Commit intent ${item.id} cannot be archived as diverged without current canonical proof that it matches neither PRE nor POST for the same recovery descriptor.`);
            error.name = 'TV2CommitRecoveryUnverified'; throw error;
        }
    }
}

export function resolveNexusCommitRecovery(id, { disposition = 'confirmed-not-applied', note = '', verification = null, supersededBy = null } = {}) {
    const allowed = new Set(['confirmed-applied', 'confirmed-not-applied', 'abandoned', 'superseded', 'diverged']);
    const normalized = String(disposition || '');
    if (!allowed.has(normalized)) throw new Error(`Unsupported commit recovery disposition: ${normalized}`);
    const row = mutate(id, item => {
        if (!UNRESOLVED.has(String(item.state || ''))) throw new Error(`Commit intent ${id} is already terminal.`);
        if (String(item.state || '') === 'applied' && normalized !== 'confirmed-applied') {
            const error = new Error(`Commit intent ${id} is durably APPLIED and can only be reconciled as confirmed-applied.`);
            error.name = 'TV2CommitAppliedDispositionConflict'; throw error;
        }
        assertRecoveryVerification(item, normalized, verification);
        item.state = `reconciled-${normalized}`;
        item.commitPhase = `reconciled-${normalized}`;
        item.updatedAt = Date.now(); item.resolvedAt = item.updatedAt;
        item.recoveryDisposition = normalized; item.recoveryNote = clip(note, 1000);
        item.recoveryVerification = verification ? clone(verification) : { state: item.physicalPersistenceBegun === true ? 'journal-applied' : 'pre-persistence' };
        if (normalized === 'confirmed-applied' || normalized === 'diverged' || normalized === 'abandoned') addReplayFence(item);
        if (normalized === 'superseded') {
            const identity = storedIdentityForRow(item);
            if (identity?.value) {
                addReplayFence(item);
                supersedeReplayFence(identity, { byTransactionId: supersededBy, note });
            }
            item.supersededBy = supersededBy ? String(supersededBy) : null;
        }
    });
    if (!row) throw new Error(`Nexus commit intent ${id} was not found.`);
    return row;
}

export function markNexusCommitEffectSuperseded(id, { byTransactionId = null, note = '', inverseVerified = false } = {}) {
    if (inverseVerified !== true) {
        const error = new Error('Nexus replay supersession requires a physically verified inverse.');
        error.name = 'TV2CommitSupersessionUnverified'; throw error;
    }
    const current = loadRows().find(row => String(row.id) === String(id));
    if (!current) throw new Error(`Nexus commit intent ${id} was not found.`);
    const state = String(current.state || '');
    if (!KNOWN_APPLIED_EFFECT.has(state)) {
        const error = new Error(`Nexus commit intent ${id} is ${state} and does not own an applied effect that can be superseded.`);
        error.name = 'TV2CommitSupersessionConflict'; throw error;
    }
    const identity = storedIdentityForRow(current);
    if (identity?.value) {
        addReplayFence(current);
        supersedeReplayFence(identity, { byTransactionId, note });
    }
    return mutate(id, item => {
        item.state = 'reconciled-superseded'; item.commitPhase = 'reconciled-superseded';
        item.updatedAt = Date.now(); item.resolvedAt = item.updatedAt;
        item.recoveryDisposition = 'superseded'; item.recoveryNote = clip(note, 1000);
        item.supersededBy = byTransactionId ? String(byTransactionId) : null;
    });
}

export function clearResolvedNexusCommitHistory() {
    const rows = loadRows();
    const unresolved = [];
    let removed = 0;
    for (const row of rows) {
        if (RETENTION_PROTECTED.has(String(row?.state || ''))) unresolved.push(row);
        else {
            removed += 1;
            if (PHYSICAL_REPLAY_FENCE.has(String(row?.state || ''))) addReplayFence(row);
            appendJournalEvent(row, { deleted: true, revision: Math.max(0, Number(row.journalRevision)||0) + 1 });
        }
    }
    saveRows(unresolved); return removed;
}


// Awaited browser durability wrappers. In IndexedDB mode these are the only
// supported mutation path: the synchronous state machine mutates the mirror,
// then the changed immutable-event keys are committed transactionally before
// acknowledgement. Node/tests and browsers without IndexedDB retain the legacy
// synchronous backend through the same wrapper surface.
export async function beginNexusCommitIntentDurable(transaction, options = {}) { return await runIndexedDbDurableMutation(() => beginNexusCommitIntent(transaction, options)); }
export async function updateNexusCommitIntentRecoveryDurable(id, recovery = null) { return await runIndexedDbDurableMutation(() => updateNexusCommitIntentRecovery(id, recovery)); }
export async function updateNexusCommitIntentPhaseDurable(id, phase, details = {}) { return await runIndexedDbDurableMutation(() => updateNexusCommitIntentPhase(id, phase, details)); }
export async function markNexusCommitIntentAppliedDurable(id, result = null) { return await runIndexedDbDurableMutation(() => markNexusCommitIntentApplied(id, result)); }
export async function completeNexusCommitIntentDurable(id, result = null) { return await runIndexedDbDurableMutation(() => completeNexusCommitIntent(id, result)); }
export async function failNexusCommitIntentDurable(id, error, options = {}) { return await runIndexedDbDurableMutation(() => failNexusCommitIntent(id, error, options)); }
export async function markNexusCommitRecoveryRequiredDurable(id, reason = 'Commit outcome requires reconciliation.') { return await runIndexedDbDurableMutation(() => markNexusCommitRecoveryRequired(id, reason)); }
export async function markNexusDependentProjectionPendingDurable(id, error = null) { return await runIndexedDbDurableMutation(() => markNexusDependentProjectionPending(id, error)); }
export async function clearNexusDependentProjectionPendingDurable(id) { return await runIndexedDbDurableMutation(() => clearNexusDependentProjectionPending(id)); }
export async function resolveNexusCommitRecoveryDurable(id, options = {}) { return await runIndexedDbDurableMutation(() => resolveNexusCommitRecovery(id, options)); }
export async function markNexusCommitEffectSupersededDurable(id, options = {}) { return await runIndexedDbDurableMutation(() => markNexusCommitEffectSuperseded(id, options)); }
export async function clearResolvedNexusCommitHistoryDurable() { return await runIndexedDbDurableMutation(() => clearResolvedNexusCommitHistory()); }

export function getNexusCommitJournalStatus() {
    try {
        if (browserRuntime() && indexedDbAvailable() && idbStartupState === 'unavailable') {
            return { durable: false, available: false, mode: 'indexeddb-unavailable', indexedDbStartupState: idbStartupState, error: clip(idbStartupError?.message || 'IndexedDB commit journal initialization failed.', 1000) };
        }
        const target = storage();
        if (!target) return { durable: false, available: !browserRuntime(), mode: browserRuntime() ? 'unavailable' : 'node-test-memory', error: browserRuntime() ? 'Durable browser storage is unavailable.' : '' };
        loadRows();
        const archiveCount = storageKeys(target, REPLAY_ARCHIVE_PREFIX).length;
        const pressure=storagePressureSnapshot(target);
        return { durable: true, available: true, mode: idbAuthority ? 'indexedDB-event-authority' : (supportsStorageEnumeration(target) && eventAuthorityMode(target) ? 'localStorage-event-authority' : 'localStorage-compatibility'), replayFenceCount: loadReplayFences().length, replayFenceLimit: REPLAY_LIMIT, replayArchiveCount: archiveCount, replayArchiveLimit: REPLAY_ARCHIVE_LIMIT, replayArchiveCapacityRemaining: Math.max(0, REPLAY_ARCHIVE_LIMIT - archiveCount), journalEventCount: storageKeys(target, EVENT_PREFIX).length, storageApproxChars: pressure.approxChars, largestNexusStorageKeys: pressure.keys, reservePresent: idbAuthority ? false : target.getItem(JOURNAL_RESERVE_KEY)!=null, legacyLocalStorageDurabilityChars: legacyLocalStorageDurabilityChars(), indexedDbHydrated: idbHydrated, indexedDbStartupState: idbStartupState, migration: clone(idbMigrationInfo), cacheProjectionDegraded: !!lastCacheProjectionError, cacheProjectionError: lastCacheProjectionError, error: '' };
    } catch (error) {
        return { durable: false, available: false, mode: error?.name === 'TV2CommitJournalCorrupt' ? 'corrupt' : 'unavailable', error: clip(error?.message || error, 1000) };
    }
}

// Test/recovery hook. Not exposed through UI mutation surfaces.
export function resetNexusCommitJournalForTests() {
    memoryRows = []; memoryReplayFences = []; eventSequence = 0; lastCacheProjectionError = ''; idbStartupState = 'idle'; idbStartupError = null;
    try {
        const target=storage();
        if (target) {
            for (const key of [...storageKeys(target, EVENT_PREFIX), ...storageKeys(target, REPLAY_ARCHIVE_PREFIX)]) target.removeItem(key);
            target.removeItem(KEY); target.removeItem(LOCK_KEY); target.removeItem(REPLAY_KEY); target.removeItem(EVENT_SCHEMA_KEY); target.removeItem(JOURNAL_RESERVE_KEY);
        }
    } catch {}
}
