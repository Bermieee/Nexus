import { Builder2PlanStore } from './plan-store.js';
import { createBuilder2IndexedDbRecordStore } from './indexeddb-plan-storage.js';

const PREFIX = 'tv2_builder2_plan_v1:';
const memoryRows = new Map();
const processLocks = new Map();

function clean(value) { return String(value ?? '').trim(); }
function browserRuntime() { return typeof window !== 'undefined' && typeof document !== 'undefined'; }
function storageAvailable(storage) { return !!storage && typeof storage.getItem === 'function' && typeof storage.setItem === 'function' && typeof storage.removeItem === 'function'; }
function recordStoreAvailable(store){return !!store&&store.durable!==false&&typeof store.read==='function'&&typeof store.write==='function'&&typeof store.remove==='function'&&typeof store.listRunIds==='function';}
function key(runId) { return `${PREFIX}${encodeURIComponent(clean(runId))}`; }
function decodeLegacyKey(value){try{return decodeURIComponent(String(value).slice(PREFIX.length));}catch{return '';}}
function lockName(runId) { return `tv2-builder2-plan:${encodeURIComponent(clean(runId))}`; }

function durabilityError(message, cause = null) {
    const error = new Error(message);
    error.name = 'TV2Builder2PlanDurabilityUnavailable';
    if (cause) error.cause = cause;
    return error;
}

async function withProcessLock(name, task) {
    const previous = processLocks.get(name) || Promise.resolve();
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const tail = previous.catch(() => {}).then(() => gate);
    processLocks.set(name, tail);
    await previous.catch(() => {});
    try { return await task(); }
    finally {
        release();
        if (processLocks.get(name) === tail) processLocks.delete(name);
    }
}

function legacyRunIds(storage){
    const out=[];if(!storageAvailable(storage))return out;
    for(let i=0;i<Number(storage.length||0);i+=1){const k=storage.key(i);if(typeof k!=='string'||!k.startsWith(PREFIX))continue;const id=decodeLegacyKey(k);if(id)out.push(id);}
    return out;
}

export function createNexusBuilder2PlanAdapter({
    // `storage` is legacy/migration storage only in modern browsers. Builder 2
    // plan payloads are too large for Web Storage and live in IndexedDB.
    storage = globalThis?.localStorage ?? null,
    recordStore = null,
    indexedDB = globalThis?.indexedDB ?? null,
    lockManager = globalThis?.navigator?.locks ?? null,
    memory = memoryRows,
} = {}) {
    const legacy = storageAvailable(storage) ? storage : null;
    const primary = recordStoreAvailable(recordStore) ? recordStore : (indexedDB ? createBuilder2IndexedDbRecordStore({ indexedDB }) : null);
    const durable = recordStoreAvailable(primary) || !!legacy;
    if (!durable && browserRuntime()) {
        throw durabilityError('Builder 2 requires durable browser storage for crash/resume authority; memory-only fallback is disabled in production.');
    }
    const locks = lockManager && typeof lockManager.request === 'function' ? lockManager : null;

    const migrateLegacy = async runId => {
        if(!legacy||!recordStoreAvailable(primary))return null;
        const legacyKey=key(runId);let raw=null;
        try{raw=legacy.getItem(legacyKey);}catch{}
        if(raw==null)return null;
        // Migration is write-verified before the small Web Storage copy is
        // removed. Failure leaves the old row intact and readable.
        await primary.write(runId,raw);
        try{legacy.removeItem(legacyKey);}catch{}
        return raw;
    };

    const readRaw = async runId => {
        const id=clean(runId);
        if(recordStoreAvailable(primary)){
            const raw=await primary.read(id);if(raw!=null)return raw;
            const migrated=await migrateLegacy(id);if(migrated!=null)return migrated;
            return null;
        }
        if(legacy){try{return legacy.getItem(key(id));}catch(cause){throw durabilityError('Builder 2 legacy PlanStore read failed.',cause);}}
        return memory.get(key(id)) ?? null;
    };

    const listRunIdsRaw = async () => {
        const out=[];
        if(recordStoreAvailable(primary))out.push(...await primary.listRunIds());
        if(legacy)out.push(...legacyRunIds(legacy));
        if(!recordStoreAvailable(primary)&&!legacy){for(const k of memory.keys()){if(typeof k==='string'&&k.startsWith(PREFIX)){const id=decodeLegacyKey(k);if(id)out.push(id);}}}
        return [...new Set(out.map(clean).filter(Boolean))].sort();
    };

    const writeRaw = async (runId, value) => {
        const id=clean(runId),text=String(value);
        if(recordStoreAvailable(primary)){
            await primary.write(id,text);
            // Remove any migrated Web Storage copy only after verified durable
            // persistence. New large plans therefore consume zero localStorage.
            if(legacy){try{legacy.removeItem(key(id));}catch{}}
            return;
        }
        if (legacy) {
            try { legacy.setItem(key(id), text); }
            catch (cause) { throw durabilityError('Builder 2 PlanStore exhausted legacy Web Storage. IndexedDB is required for large derived plans.', cause); }
            if (legacy.getItem(key(id)) !== text) throw durabilityError('Builder 2 PlanStore write could not be verified.');
        } else memory.set(key(id), text);
    };

    const removeRaw = async runId => {
        const id=clean(runId);let removed=false;
        if(recordStoreAvailable(primary)){await primary.remove(id);removed=true;}
        if(legacy){try{legacy.removeItem(key(id));removed=true;}catch(cause){if(!recordStoreAvailable(primary))throw durabilityError('Builder 2 PlanStore could not remove its legacy derived plan.',cause);}}
        if(!recordStoreAvailable(primary)&&!legacy)removed=memory.delete(key(id));
        return removed;
    };

    const exclusive = async (runId, task) => {
        const name = lockName(runId);
        if (locks) return locks.request(name, { mode: 'exclusive' }, task);
        if (browserRuntime() && durable) {
            // Cross-tab compare-and-swap without Web Locks is not safe enough for
            // operator review ownership. Fail closed instead of last-writer wins.
            throw durabilityError('Builder 2 cross-tab PlanStore CAS requires the Web Locks API.');
        }
        return withProcessLock(name, task);
    };
    return {
        durable,
        storageMode:recordStoreAvailable(primary)?'indexeddb':legacy?'legacy-localStorage':'memory-test',
        read: async runId => readRaw(runId),
        write: async (runId, value) => exclusive(runId, async () => { await writeRaw(runId, value); }),
        writeIfRevision: async (runId, expectedRevision, value) => exclusive(runId, async () => {
            const raw = await readRaw(runId);
            if (raw == null) return false;
            let current;
            try { current = JSON.parse(raw); }
            catch (cause) { throw durabilityError(`Builder 2 PlanStore record ${runId} is corrupt.`, cause); }
            if (Number(current?.planRevision || 0) !== Number(expectedRevision)) return false;
            await writeRaw(runId, value);
            return true;
        }),
        remove: async runId => exclusive(runId, async () => removeRaw(runId)),
        listRunIds: async () => listRunIdsRaw(),
    };
}

export function createNexusBuilder2PlanStore(options = {}) {
    const adapter=createNexusBuilder2PlanAdapter(options);
    const store=new Builder2PlanStore(adapter);
    store.listRunIds=()=>adapter.listRunIds();
    store.storageMode=adapter.storageMode;
    return store;
}

export async function listNexusBuilder2Plans(store,{book=null,includeTerminal=false}={}){
    if(!store||typeof store.listRunIds!=='function')return[];
    const wanted=clean(book);const rows=[];
    for(const id of await store.listRunIds()){
        let plan=null;try{plan=await store.read(id);}catch{continue;}
        if(!plan)continue;if(wanted&&clean(plan.book)!==wanted)continue;
        if(!includeTerminal&&['committed','cancelled','stale'].includes(clean(plan.phase)))continue;
        rows.push(plan);
    }
    return rows.sort((a,b)=>Number(b.updatedAt||0)-Number(a.updatedAt||0)||Number(b.planRevision||0)-Number(a.planRevision||0));
}

export function clearNexusBuilder2PlanMemoryForTests() { memoryRows.clear(); }
export const NEXUS_BUILDER2_PLAN_STORAGE_PREFIX = PREFIX;
