import { assertNexusCallTicket, assertNexusTransactionState, createNexusTransaction } from './contracts.js';
import { assertOperatorReviewScope, currentOperatorReviewScope, normalizeOperatorReviewScope, operatorReviewScopeProjection } from './review-scope.js';

const LEGACY_STORAGE_KEY = 'tv2_nexus_operator_review_v1';
const STORAGE_PREFIX = 'tv2_nexus_operator_review_v3:';
const LOCK_PREFIX = 'tv2_nexus_operator_review_v3:exclusive:';
const INVALIDATION_SUFFIX = ':invalidating';
const VERSION = 3;
const LEGACY_VERSIONS = new Set([1, 2]);
const MAX_REVIEW_TRANSACTIONS = 500;
const MAX_UNRESOLVED_REVIEW_TRANSACTIONS = 500;
const MAX_REVIEW_SERIALIZED_CHARS = 3_000_000;
const REVIEW_TRANSACTION_STATES = new Set(['staged','committing','committed','stale','aborted','failed','cancelled']);
const REVIEW_UNRESOLVED_STATES = new Set(['staged','committing']);
const REVIEW_COMPACTABLE_STATES = new Set(['committed','aborted','failed','cancelled']);
const MANUAL_REVIEW_TYPES = new Set(['uid-summary','merge','lorebook-builder','lorebook-builder2','lore-proposal-apply','character-state-proposal']);
const MAX_HISTORY = 250;
const MAX_TERMINAL_ARCHIVE = 4096;
const PRESSURE_TERMINAL_ARCHIVE_LIMIT = 256;
const PRESSURE_TERMINAL_HISTORY_LIMIT = 96;
const CALL_ACTIVE_STATES = new Set(['created','awaiting-approval','approved-deferred','running']);

function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }
function storageAvailable(storage) { return !!storage && typeof storage.getItem === 'function' && typeof storage.setItem === 'function'; }
function enumerableStorage(storage) { return storageAvailable(storage) && typeof storage.key === 'function' && Number.isFinite(Number(storage.length)); }
function storageKeys(storage, prefix = '') {
    if (!enumerableStorage(storage)) return [];
    const out=[];
    for(let i=0;i<Number(storage.length);i+=1){const key=storage.key(i);if(typeof key==='string'&&key.startsWith(prefix))out.push(key);}
    return out.sort();
}
function approxStorageChars(storage) {
    if (!enumerableStorage(storage)) return 0;
    let chars=0;
    for(let i=0;i<Number(storage.length);i+=1){const key=storage.key(i);if(typeof key!=='string')continue;let value='';try{value=String(storage.getItem(key)||'');}catch{}chars+=key.length+value.length;}
    return chars;
}
function same(a, b) { try { return JSON.stringify(a ?? null) === JSON.stringify(b ?? null); } catch { return false; } }
function browserRuntime() { return typeof globalThis?.window !== 'undefined' || typeof globalThis?.document !== 'undefined'; }
function stableHash(text) {
    let hash = 0xcbf29ce484222325n, prime = 0x100000001b3n, mask = 0xffffffffffffffffn;
    for (let i = 0; i < String(text).length; i += 1) { const c=String(text).charCodeAt(i); hash ^= BigInt(c & 0xff); hash=(hash*prime)&mask; hash ^= BigInt((c>>>8)&0xff); hash=(hash*prime)&mask; }
    return hash.toString(16).padStart(16,'0');
}
function reviewStoreError(name, message, rawPayload = null, cause = null) {
    const error = new Error(message); error.name = name;
    if (rawPayload != null) error.rawPayload = String(rawPayload);
    if (cause) error.cause = cause;
    return error;
}
function storageKeyForScope(scope) { return `${STORAGE_PREFIX}${stableHash(normalizeOperatorReviewScope(scope).identity)}`; }
function lockNameForScope(scope) { return `${LOCK_PREFIX}${stableHash(normalizeOperatorReviewScope(scope).identity)}`; }
function emptySnapshot({ durable = true, scope, generation = 0 } = {}) {
    const normalized = normalizeOperatorReviewScope(scope || currentOperatorReviewScope());
    return { version: VERSION, scope: operatorReviewScopeProjection(normalized, generation), generation: Math.max(0, Number(generation)||0), revision: 0, savedAt: 0, writeToken: null, callAuthority: null, transactions: [], terminalArchive: [], durable };
}
function scopeError(message, rawPayload = null) { return reviewStoreError('TV2OperatorReviewScopeMismatch', message, rawPayload); }
function assertScopeProjection(raw, expected, rawPayload) {
    const scope = normalizeOperatorReviewScope(raw || {});
    if (scope.identity !== expected.identity) throw scopeError('Nexus operator-review durable snapshot belongs to a different chat/story scope.', rawPayload);
    return scope;
}
function validateTicketRow(row, expectedScope, generation, rawPayload, { pending = false } = {}) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw reviewStoreError('TV2OperatorReviewStoreCorrupt', 'Nexus operator-review Call Center row is malformed.', rawPayload);
    try { assertNexusCallTicket(row.ticket); } catch (cause) { throw reviewStoreError('TV2OperatorReviewStoreCorrupt', `Nexus operator-review Call Ticket is invalid: ${cause?.message || cause}`, rawPayload, cause); }
    const tagged = row.ticket?.metadata?.reviewScope;
    if (!tagged || normalizeOperatorReviewScope(tagged).identity !== expectedScope.identity) throw scopeError(`Nexus operator-review Call Ticket ${row.ticket.id} does not belong to the durable review scope.`, rawPayload);
    const rowGeneration = Number(row.ticket?.metadata?.reviewScopeGeneration);
    if (!Number.isInteger(rowGeneration) || rowGeneration !== generation) throw scopeError(`Nexus operator-review Call Ticket ${row.ticket.id} belongs to a stale review-scope generation.`, rawPayload);
    if (pending && !['awaiting-approval','approved-deferred'].includes(String(row.state || ''))) throw reviewStoreError('TV2OperatorReviewStoreCorrupt', `Nexus operator-review pending approval ${row.ticket.id} has an invalid state.`, rawPayload);
    return row;
}
function validateAuthorityShape(callAuthority, expectedScope, generation, rawPayload) {
    if (callAuthority == null) return null;
    if (typeof callAuthority !== 'object' || Array.isArray(callAuthority)) throw reviewStoreError('TV2OperatorReviewStoreCorrupt', 'Nexus operator-review call authority is malformed.', rawPayload);
    if (callAuthority.history != null && !Array.isArray(callAuthority.history)) throw reviewStoreError('TV2OperatorReviewStoreCorrupt', 'Nexus operator-review history is malformed.', rawPayload);
    if (callAuthority.pendingApprovals != null && !Array.isArray(callAuthority.pendingApprovals)) throw reviewStoreError('TV2OperatorReviewStoreCorrupt', 'Nexus operator-review pending approvals are malformed.', rawPayload);
    const history = Array.isArray(callAuthority.history) ? callAuthority.history : [];
    const pending = Array.isArray(callAuthority.pendingApprovals) ? callAuthority.pendingApprovals : [];
    const seenHistory = new Set();
    for (const row of history) {
        validateTicketRow(row, expectedScope, generation, rawPayload);
        const id=String(row.ticket.id); if (seenHistory.has(id)) throw reviewStoreError('TV2OperatorReviewStoreCorrupt', `Nexus operator-review history contains duplicate Call Ticket ${id}.`, rawPayload); seenHistory.add(id);
    }
    const seenPending = new Set();
    for (const row of pending) {
        validateTicketRow(row, expectedScope, generation, rawPayload, { pending: true });
        const id=String(row.ticket.id); if (seenPending.has(id)) throw reviewStoreError('TV2OperatorReviewStoreCorrupt', `Nexus operator-review pending approvals contain duplicate Call Ticket ${id}.`, rawPayload); seenPending.add(id);
        const unresolvedHistory=history.filter(item=>String(item?.ticket?.id||'')===id&&['awaiting-approval','approved-deferred'].includes(String(item?.state||'')));
        if (unresolvedHistory.length>1 || (unresolvedHistory.length===1 && !same(unresolvedHistory[0],row))) throw reviewStoreError('TV2OperatorReviewStoreCorrupt', `Nexus operator-review Call Ticket ${id} has detached/mismatched pending and history authority.`, rawPayload);
    }
    const activeHistory=history.filter(row=>CALL_ACTIVE_STATES.has(String(row?.state||'')));
    const terminalBudget=Math.max(0,MAX_HISTORY-activeHistory.length);
    const terminal=history.filter(row=>!activeHistory.includes(row));
    const terminalKeep=new Set((terminalBudget?terminal.slice(-terminalBudget):[]).map(row=>rowFingerprint(row)));
    return { history: history.filter(row=>activeHistory.includes(row)||terminalKeep.has(rowFingerprint(row))).map(clone), pendingApprovals: pending.map(clone) };
}
function isRecognizedReviewTransaction(row) {
    if (row?.metadata?.source === 'main-function-gateway' && String(row?.type || '').startsWith('external:')) return true;
    return MANUAL_REVIEW_TYPES.has(String(row?.type || ''));
}
function transactionScopeIdentity(row) {
    const tagged=row?.metadata?.reviewScope;
    if (tagged) return normalizeOperatorReviewScope(tagged).identity;
    const assumptionIdentity=String(row?.assumptions?.operatorReviewScope||'').trim();
    return assumptionIdentity || '';
}
function transactionBelongsToScope(row, scope) {
    if (!row || !scope) return false;
    const identity=transactionScopeIdentity(row);
    if (!identity || identity!==scope.identity) return false;
    if(scope.kind==='lorebook'){
        const book=String(row?.assumptions?.book ?? row?.input?.book ?? row?.metadata?.book ?? '').trim();
        return !!book && book===String(scope.book||'');
    }
    const chatId=row?.assumptions?.chatId ?? row?.metadata?.reviewScope?.chatId ?? null;
    return chatId == null ? false : String(chatId)===String(scope.chatId);
}
function assertTransactionBelongsToScope(row, scope) {
    if (transactionBelongsToScope(row, scope)) return row;
    throw scopeError(`Nexus operator-review transaction ${String(row?.id||'(missing)')} belongs to a different or untyped review scope.`);
}
function reviewTransactionReceipt(row){
    const raw=JSON.stringify(row??null);
    return {
        kind:'review-transaction',id:String(row?.id||''),state:String(row?.state||''),type:String(row?.type||''),
        at:Number(row?.updatedAt||row?.createdAt||Date.now()),createdAt:Number(row?.createdAt)||0,
        error:row?.error?String(row.error).slice(0,1000):'',reviewScope:clone(row?.metadata?.reviewScope||null),
        projectionFingerprint:stableHash(raw),
    };
}
export function compactOperatorReviewTransactions(rows=[],archive=[]){
    const live=[],receipts=[];
    for(const row of rows||[]){
        const compactable=REVIEW_COMPACTABLE_STATES.has(String(row?.state||''))&&row?.metadata?.canonicalRecoveryRequired!==true;
        if(compactable)receipts.push(reviewTransactionReceipt(row));else live.push(clone(row));
    }
    const merged=mergeArchive(archive||[],[],receipts);
    return {transactions:live,archive:merged};
}
function retainReviewTransactions(rows) {
    const unresolved = rows.filter(row => REVIEW_UNRESOLVED_STATES.has(String(row?.state || '')) || row?.metadata?.canonicalRecoveryRequired === true);
    const terminalBudget = Math.max(0, MAX_REVIEW_TRANSACTIONS - unresolved.length);
    const terminalRows = rows.filter(row => !unresolved.includes(row));
    const terminalKeep = new Set((terminalBudget > 0 ? terminalRows.slice(-terminalBudget) : []).map(row => String(row.id)));
    return rows.filter(row => unresolved.includes(row) || terminalKeep.has(String(row.id)));
}

function validateTransactions(rows, expectedScope, generation, rawPayload) {
    if (!Array.isArray(rows)) throw reviewStoreError('TV2OperatorReviewStoreCorrupt', 'Nexus operator-review transactions are malformed.', rawPayload);
    const ids = new Set();
    const validated = rows.map(row => {
        const id = String(row?.id || '').trim();
        if (!row || typeof row !== 'object' || Array.isArray(row) || !id || ids.has(id)) throw reviewStoreError('TV2OperatorReviewStoreCorrupt', 'Nexus operator-review transactions contain a missing or duplicate transaction identity.', rawPayload);
        ids.add(id);
        try { assertNexusTransactionState(row.state); } catch (cause) { throw reviewStoreError('TV2OperatorReviewStoreCorrupt', `Nexus operator-review transaction ${id} has an invalid state.`, rawPayload, cause); }
        if (!REVIEW_TRANSACTION_STATES.has(String(row.state || '')) || !isRecognizedReviewTransaction(row)) throw reviewStoreError('TV2OperatorReviewStoreCorrupt', `Nexus operator-review transaction ${id} is not a recognized review transaction.`, rawPayload);
        for (const [name,value] of [['input',row.input],['assumptions',row.assumptions],['metadata',row.metadata]]) {
            if (!value || typeof value!=='object' || Array.isArray(value)) throw reviewStoreError('TV2OperatorReviewStoreCorrupt', `Nexus operator-review transaction ${id} is missing its ${name} object.`, rawPayload);
        }
        if (!Array.isArray(row.history)) throw reviewStoreError('TV2OperatorReviewStoreCorrupt', `Nexus operator-review transaction ${id} is missing its audit history.`, rawPayload);
        if (!Number.isFinite(Number(row.createdAt)) || !Number.isFinite(Number(row.updatedAt))) throw reviewStoreError('TV2OperatorReviewStoreCorrupt', `Nexus operator-review transaction ${id} is missing valid timestamps.`, rawPayload);
        if (Object.keys(row.assumptions).length===0) throw reviewStoreError('TV2OperatorReviewStoreCorrupt', `Nexus protected operator-review transaction ${id} has empty freshness assumptions.`, rawPayload);
        try { createNexusTransaction(row); } catch (cause) { throw reviewStoreError('TV2OperatorReviewStoreCorrupt', `Nexus operator-review transaction ${id} fails the typed transaction contract: ${cause?.message||cause}`, rawPayload, cause); }
        const tagged = row?.metadata?.reviewScope;
        if (!tagged || normalizeOperatorReviewScope(tagged).identity !== expectedScope.identity) throw scopeError(`Nexus operator-review transaction ${id} does not belong to the durable review scope.`, rawPayload);
        const rowGeneration=Number(row?.metadata?.reviewScopeGeneration);
        if (!Number.isInteger(rowGeneration) || rowGeneration !== generation) throw scopeError(`Nexus operator-review transaction ${id} belongs to a stale review-scope generation.`, rawPayload);
        return clone(row);
    });
    return retainReviewTransactions(validated);
}
function validateArchive(rows, rawPayload) {
    if (rows == null) return [];
    if (!Array.isArray(rows)) throw reviewStoreError('TV2OperatorReviewStoreCorrupt', 'Nexus operator-review terminal archive is malformed.', rawPayload);
    if (rows.length > MAX_TERMINAL_ARCHIVE) throw reviewStoreError('TV2OperatorReviewAuditCapacityExceeded', 'Nexus operator-review terminal audit archive reached its supported capacity; export/rotate audit evidence before more terminal history is compacted.', rawPayload);
    const ids=new Set(); return rows.map(row=>{ if(!row||typeof row!=='object'||Array.isArray(row)||!String(row.id||'').trim())throw reviewStoreError('TV2OperatorReviewStoreCorrupt','Nexus operator-review terminal audit archive contains a malformed receipt.',rawPayload); const key=`${row.kind||''}:${row.id}:${row.at||''}`;if(ids.has(key))throw reviewStoreError('TV2OperatorReviewStoreCorrupt','Nexus operator-review terminal audit archive contains duplicate receipt identity.',rawPayload);ids.add(key);return clone(row);});
}
function normalizeEnvelope(raw, rawPayload, expectedScope, { durable = true } = {}) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw reviewStoreError('TV2OperatorReviewStoreCorrupt', 'Nexus operator-review authority envelope is malformed.', rawPayload);
    if (Number(raw.version) !== VERSION) throw reviewStoreError('TV2OperatorReviewStoreVersionUnsupported', `Nexus operator-review scoped authority version ${String(raw.version ?? '(missing)')} is unsupported.`, rawPayload);
    assertScopeProjection(raw.scope, expectedScope, rawPayload);
    const generation=Number(raw.generation ?? raw.scope?.generation);
    if(!Number.isInteger(generation)||generation<0)throw reviewStoreError('TV2OperatorReviewStoreCorrupt','Nexus operator-review scope generation is malformed.',rawPayload);
    return {
        version: VERSION, scope: operatorReviewScopeProjection(expectedScope,generation), generation,
        revision: Number.isFinite(Number(raw.revision)) && Number(raw.revision)>=0 ? Number(raw.revision):0,
        savedAt:Number(raw.savedAt)||0, writeToken:raw.writeToken?String(raw.writeToken):null,
        callAuthority:validateAuthorityShape(raw.callAuthority||null,expectedScope,generation,rawPayload),
        transactions:validateTransactions(raw.transactions||[],expectedScope,generation,rawPayload),
        terminalArchive:validateArchive(raw.terminalArchive,rawPayload), durable,
    };
}
function hasLegacyUnresolved(raw) {
    const tx = Array.isArray(raw?.transactions) ? raw.transactions : [];
    const pending = Array.isArray(raw?.callAuthority?.pendingApprovals) ? raw.callAuthority.pendingApprovals : [];
    return pending.length > 0 || tx.some(row=>REVIEW_UNRESOLVED_STATES.has(String(row?.state||'')));
}
function mapPending(authority) { return new Map((authority?.pendingApprovals || []).map(row => [String(row?.ticket?.id || ''), clone(row)]).filter(([id]) => id)); }
function mapTransactions(rows) { return new Map((rows || []).map(row => [String(row?.id || ''), clone(row)]).filter(([id]) => id)); }
function rowFingerprint(row) { try { return JSON.stringify(row ?? null); } catch { return String(row); } }
function callHistoryReceipt(row){return{id:String(row?.ticket?.id||''),kind:'call-ticket',state:String(row?.state||''),capability:String(row?.ticket?.capability||''),direction:String(row?.ticket?.direction||''),at:Number(row?.at||0),resolvedAt:Number(row?.resolvedAt||row?.completedAt||0)||null,error:row?.error?String(row.error).slice(0,500):'',reviewScope:clone(row?.ticket?.metadata?.reviewScope||null)};}
function mergeHistory(latest=[],base=[],local=[]) {
    // Call Center history contains one mutable record per Call Ticket. Retention
    // may make a local snapshot omit older terminal rows, so absence is NOT a
    // delete request. Merge only explicit new/changed IDs and CAS changes that
    // were based on a prior durable row.
    const byId=rows=>new Map((rows||[]).map(row=>[String(row?.ticket?.id||''),row]).filter(([id])=>id));
    const baseMap=byId(base), latestMap=byId(latest), localMap=byId(local);
    const out=new Map([...latestMap.entries()].map(([id,row])=>[id,clone(row)]));
    for(const [id,localRow] of localMap){
        const baseRow=baseMap.get(id), latestRow=latestMap.get(id);
        if(baseRow){
            if(same(localRow,baseRow))continue;
            if(!latestRow)throw reviewStoreError('TV2OperatorReviewConflict',`Nexus operator-review Call Ticket history ${id} was concurrently removed/archived before this state transition.`);
            if(!same(latestRow,baseRow)&&!same(latestRow,localRow))throw reviewStoreError('TV2OperatorReviewConflict',`Nexus operator-review Call Ticket history ${id} was concurrently modified in another tab.`);
        }else if(latestRow&&!same(latestRow,localRow)){
            throw reviewStoreError('TV2OperatorReviewConflict',`Nexus operator-review Call Ticket history ${id} already exists with different authority in another tab.`);
        }
        out.set(id,clone(localRow));
    }
    const rows=[...out.values()].sort((a,b)=>Number(a?.at||a?.updatedAt||0)-Number(b?.at||b?.updatedAt||0));
    const active=rows.filter(row=>CALL_ACTIVE_STATES.has(String(row?.state||'')));
    const activeIds=new Set(active.map(row=>String(row?.ticket?.id||'')));
    const terminal=rows.filter(row=>!activeIds.has(String(row?.ticket?.id||'')));
    const terminalBudget=Math.max(0,MAX_HISTORY-active.length);
    const terminalKeepIds=new Set((terminalBudget?terminal.slice(-terminalBudget):[]).map(row=>String(row?.ticket?.id||'')));
    const history=rows.filter(row=>activeIds.has(String(row?.ticket?.id||''))||terminalKeepIds.has(String(row?.ticket?.id||'')));
    const evictedTerminal=terminal.filter(row=>!terminalKeepIds.has(String(row?.ticket?.id||''))).map(callHistoryReceipt);
    return{history,evictedTerminal};
}
function applyMapDelta(kind,baseMap,localMap,latestMap){const out=new Map([...latestMap.entries()].map(([id,row])=>[id,clone(row)]));for(const[id,baseRow]of baseMap){const localHas=localMap.has(id),latestHas=latestMap.has(id),latestRow=latestMap.get(id);if(!localHas){if(!latestHas||same(latestRow,baseRow)){out.delete(id);continue;}throw reviewStoreError('TV2OperatorReviewConflict',`Nexus operator-review ${kind} ${id} changed in another tab before this removal could commit.`);}}for(const[id,localRow]of localMap){const baseHas=baseMap.has(id),baseRow=baseMap.get(id);if(baseHas&&same(localRow,baseRow))continue;const latestHas=latestMap.has(id),latestRow=latestMap.get(id);if(baseHas){if(!latestHas)throw reviewStoreError('TV2OperatorReviewConflict',`Nexus operator-review ${kind} ${id} was removed in another tab; stale state may not resurrect it.`);if(!same(latestRow,baseRow)&&!same(latestRow,localRow))throw reviewStoreError('TV2OperatorReviewConflict',`Nexus operator-review ${kind} ${id} was concurrently modified in another tab.`);}else if(latestHas&&!same(latestRow,localRow))throw reviewStoreError('TV2OperatorReviewConflict',`Nexus operator-review ${kind} ${id} already exists with different authority in another tab.`);out.set(id,clone(localRow));}return out;}
function mergeArchive(latest=[],base=[],local=[]){const baseSet=new Set(base.map(rowFingerprint));const out=[...latest.map(clone)],seen=new Set(out.map(rowFingerprint));for(const row of local){const fp=rowFingerprint(row);if(baseSet.has(fp)||seen.has(fp))continue;seen.add(fp);out.push(clone(row));}if(out.length>MAX_TERMINAL_ARCHIVE)throw reviewStoreError('TV2OperatorReviewAuditCapacityExceeded','Nexus operator-review terminal audit archive is full; authority persistence is blocked rather than deleting audit lineage.');return out;}
function mergeDelta(base,local,latest){
    if(Number(base.generation)!==Number(latest.generation))throw reviewStoreError('TV2OperatorReviewScopeInvalidated','Nexus operator-review scope generation changed; stale authority may not be persisted or resurrected.');
    const pending=applyMapDelta('ticket',mapPending(base.callAuthority),mapPending(local.callAuthority),mapPending(latest.callAuthority));
    const transactions=applyMapDelta('transaction',mapTransactions(base.transactions),mapTransactions(local.transactions),mapTransactions(latest.transactions));
    const historyMerge=mergeHistory(latest.callAuthority?.history||[],base.callAuthority?.history||[],local.callAuthority?.history||[]);
    const archive=mergeArchive(latest.terminalArchive||[],base.terminalArchive||[],[...(local.terminalArchive||[]),...historyMerge.evictedTerminal]);
    return{callAuthority:(historyMerge.history.length||pending.size)?{history:historyMerge.history,pendingApprovals:[...pending.values()].map(clone)}:null,transactions:retainReviewTransactions([...transactions.values()].map(clone)),terminalArchive:archive};
}

const processLockTails=new WeakMap();
async function withProcessStorageLock(storage,key,task){let byKey=processLockTails.get(storage);if(!byKey){byKey=new Map();processLockTails.set(storage,byKey);}const previous=byKey.get(key)||Promise.resolve();let release;const gate=new Promise(resolve=>{release=resolve;});const tail=previous.catch(()=>{}).then(()=>gate);byKey.set(key,tail);await previous.catch(()=>{});try{return await task();}finally{release();if(byKey.get(key)===tail)byKey.delete(key);}}

export class OperatorReviewStore {
    constructor({ storage = globalThis.localStorage, lockManager = globalThis.navigator?.locks || null, eventTarget = globalThis.window || null, scope = null, allowInvalidating = false } = {}) {
        this.scope=assertOperatorReviewScope(scope||currentOperatorReviewScope());
        this.storage=storageAvailable(storage)?storage:null;this.lockManager=lockManager&&typeof lockManager.request==='function'?lockManager:null;this.eventTarget=eventTarget&&typeof eventTarget.addEventListener==='function'?eventTarget:null;
        this.storageKey=storageKeyForScope(this.scope);this.invalidationKey=`${this.storageKey}${INVALIDATION_SUFFIX}`;this.lockName=lockNameForScope(this.scope);this.allowInvalidating=allowInvalidating===true;this.base=emptySnapshot({durable:!!this.storage,scope:this.scope});this.unwatch=null;
    }
    get available(){return!!this.storage;}
    _assertStorage(){if(!this.storage)throw reviewStoreError('TV2OperatorReviewDurabilityUnavailable','Nexus Operator Review durable storage is unavailable; review authority is blocked rather than becoming memory-only.');}
    _assertNotInvalidating(){if(this.allowInvalidating)return;const marker=this.storage?.getItem?.(this.invalidationKey);if(marker){const error=reviewStoreError('TV2OperatorReviewScopeInvalidating','Nexus Operator Review scope invalidation is durable but not yet fully settled; old authority remains blocked.',marker);throw error;}}
    _readLegacyIfRelevant(){const payload=this.storage?.getItem?.(LEGACY_STORAGE_KEY);if(!payload)return null;let raw;try{raw=JSON.parse(payload);}catch(cause){throw reviewStoreError('TV2OperatorReviewStoreCorrupt','Legacy Nexus Operator Review authority is present but unreadable; it cannot be silently discarded during scoped-store migration.',payload,cause);}if(!LEGACY_VERSIONS.has(Number(raw?.version)))throw reviewStoreError('TV2OperatorReviewStoreVersionUnsupported',`Legacy Nexus Operator Review authority version ${String(raw?.version??'(missing)')} is unsupported and requires explicit migration/recovery.`,payload);if(hasLegacyUnresolved(raw)){const error=reviewStoreError('TV2OperatorReviewScopeMigrationRequired','Legacy unscoped Operator Review authority is unresolved. It cannot be rebound to the current chat/story automatically; reconcile/export it before using review mutations.',payload);error.legacyVersion=Number(raw.version);throw error;}return null;}
    _readLatest({adopt=false}={}){this._assertStorage();this._assertNotInvalidating();const rawPayload=this.storage.getItem(this.storageKey);if(rawPayload==null||rawPayload===''){this._readLegacyIfRelevant();const empty=emptySnapshot({durable:true,scope:this.scope});if(adopt)this.base=clone(empty);return empty;}let raw;try{raw=JSON.parse(rawPayload);}catch(cause){throw reviewStoreError('TV2OperatorReviewStoreCorrupt','Nexus operator-review authority could not be read from durable storage.',rawPayload,cause);}const normalized=normalizeEnvelope(raw,rawPayload,this.scope,{durable:true});if(adopt)this.base=clone(normalized);return normalized;}
    load(){return this._readLatest({adopt:true});}
    async compactTerminalAuthority({ pressure = false } = {}){
        return await this._exclusive(async()=>{
            const latest=this._readLatest({adopt:false});
            const compacted=compactOperatorReviewTransactions(latest.transactions||[],latest.terminalArchive||[]);
            let terminalArchive=compacted.archive;
            let callAuthority=latest.callAuthority?clone(latest.callAuthority):null;
            if(pressure){
                if(terminalArchive.length>PRESSURE_TERMINAL_ARCHIVE_LIMIT)terminalArchive=terminalArchive.slice(-PRESSURE_TERMINAL_ARCHIVE_LIMIT);
                if(callAuthority?.history?.length){
                    const active=callAuthority.history.filter(row=>CALL_ACTIVE_STATES.has(String(row?.state||'')));
                    const activeIds=new Set(active.map(row=>String(row?.ticket?.id||'')));
                    const terminal=callAuthority.history.filter(row=>!activeIds.has(String(row?.ticket?.id||'')));
                    callAuthority.history=[...active,...terminal.slice(-PRESSURE_TERMINAL_HISTORY_LIMIT)].sort((a,b)=>Number(a?.at||a?.updatedAt||0)-Number(b?.at||b?.updatedAt||0));
                }
            }
            const changed=compacted.transactions.length!==(latest.transactions||[]).length||!same(terminalArchive,latest.terminalArchive||[])||!same(callAuthority,latest.callAuthority||null);
            if(!changed){this.base=clone(latest);return {changed:false,transactions:compacted.transactions.length,archive:terminalArchive.length};}
            const saved=await this._writeSnapshot({version:VERSION,generation:latest.generation,revision:Number(latest.revision||0)+1,callAuthority,transactions:compacted.transactions,terminalArchive});
            return {...saved,changed:true,transactions:compacted.transactions.length,archive:terminalArchive.length};
        });
    }
    watch(listener){this.unwatch?.();this.unwatch=null;if(!this.eventTarget||!this.storage||typeof listener!=='function')return()=>{};const handler=event=>{if(event?.key!==this.storageKey)return;try{listener(this._readLatest({adopt:true}));}catch(error){listener(null,error);}};this.eventTarget.addEventListener('storage',handler);this.unwatch=()=>{try{this.eventTarget?.removeEventListener?.('storage',handler);}catch{}};return this.unwatch;}
    close(){this.unwatch?.();this.unwatch=null;}
    scopeProjection(){return operatorReviewScopeProjection(this.scope,this.base.generation);}
    _tagTicketRecord(row,generation){const copy=clone(row);if(!copy?.ticket)return copy;copy.ticket.metadata={...(copy.ticket.metadata||{}),reviewScope:operatorReviewScopeProjection(this.scope,generation),reviewScopeGeneration:generation};return copy;}
    _tagTransaction(row,generation){assertTransactionBelongsToScope(row,this.scope);const copy=clone(row);copy.metadata={...(copy.metadata||{}),reviewScope:operatorReviewScopeProjection(this.scope,generation),reviewScopeGeneration:generation};return copy;}
    _localSnapshot(callCenter,ledger,{transactionOverrides=[]}={}){const generation=Number(this.base.generation)||0;const rawAuthority=callCenter?.exportAuthority?.()||null;const callAuthority=rawAuthority?{history:(rawAuthority.history||[]).map(row=>this._tagTicketRecord(row,generation)),pendingApprovals:(rawAuthority.pendingApprovals||[]).map(row=>this._tagTicketRecord(row,generation))}:null;const listed=[];for(const state of REVIEW_TRANSACTION_STATES)for(const tx of ledger?.list?.({state})||[])listed.push(tx);const transactionMap=new Map(listed.filter(tx=>isRecognizedReviewTransaction(tx)&&REVIEW_TRANSACTION_STATES.has(String(tx?.state||''))&&transactionBelongsToScope(tx,this.scope)).map(tx=>[String(tx.id),this._tagTransaction(tx,generation)]));for(const row of Array.isArray(transactionOverrides)?transactionOverrides:[]){if(!row?.id)continue;assertTransactionBelongsToScope(row,this.scope);transactionMap.set(String(row.id),this._tagTransaction(row,generation));}const transactions=[...transactionMap.values()].sort((a,b)=>Number(a?.updatedAt||a?.createdAt||0)-Number(b?.updatedAt||b?.createdAt||0));const terminalArchive=(rawAuthority?.terminalArchive||[]).map(clone);return{callAuthority:validateAuthorityShape(callAuthority,this.scope,generation,null),transactions:validateTransactions(transactions,this.scope,generation,null),terminalArchive:validateArchive(terminalArchive,null)};}
    _assertAdmissionCapacity(local,latest){const latestUnresolved=new Set((latest.transactions||[]).filter(row=>REVIEW_UNRESOLVED_STATES.has(String(row?.state||''))||row?.metadata?.canonicalRecoveryRequired===true).map(row=>String(row.id)));const localUnresolved=(local.transactions||[]).filter(row=>REVIEW_UNRESOLVED_STATES.has(String(row?.state||''))||row?.metadata?.canonicalRecoveryRequired===true);const added=localUnresolved.filter(row=>!latestUnresolved.has(String(row.id)));if(added.length&&latestUnresolved.size+added.length>MAX_UNRESOLVED_REVIEW_TRANSACTIONS){const error=reviewStoreError('TV2OperatorReviewBackpressure',`Nexus Operator Review reached its ${MAX_UNRESOLVED_REVIEW_TRANSACTIONS}-transaction unresolved safety bound. Resolve existing review authority before staging more.`);error.unresolved=latestUnresolved.size;error.added=added.map(row=>String(row.id));throw error;}let chars=0;try{chars=JSON.stringify(local).length;}catch{chars=MAX_REVIEW_SERIALIZED_CHARS+1;}if(added.length&&chars>MAX_REVIEW_SERIALIZED_CHARS){const error=reviewStoreError('TV2OperatorReviewBackpressure','Nexus Operator Review unresolved authority reached its durable serialized-size safety bound. Resolve existing review authority before staging more.');error.authorityChars=chars;error.maxAuthorityChars=MAX_REVIEW_SERIALIZED_CHARS;throw error;}}
    async _exclusive(task){this._assertStorage();if(this.lockManager)return await this.lockManager.request(this.lockName,{mode:'exclusive'},task);if(browserRuntime())throw reviewStoreError('TV2OperatorReviewDurabilityUnavailable','Nexus operator-review cross-tab persistence requires the browser Web Locks API; unsafe last-writer-wins fallback is disabled.');return await withProcessStorageLock(this.storage,this.lockName,task);}
    async _writeSnapshot(snapshot){const writeToken=`tv2_review_${Date.now()}_${Math.random().toString(36).slice(2)}`;const payload={...clone(snapshot),version:VERSION,scope:operatorReviewScopeProjection(this.scope,snapshot.generation),writeToken,savedAt:Date.now()};try{this.storage.setItem(this.storageKey,JSON.stringify(payload));}catch(cause){throw reviewStoreError('TV2OperatorReviewDurabilityUnavailable','Nexus operator-review authority could not be durably persisted.',null,cause);}const confirmed=this._readLatest({adopt:false});if(confirmed.writeToken!==writeToken||Number(confirmed.revision)!==Number(payload.revision)||Number(confirmed.generation)!==Number(payload.generation))throw reviewStoreError('TV2OperatorReviewConflict','Nexus operator-review persistence lost ownership before its durable write could be verified.');this.base=clone(confirmed);return clone(confirmed);}
    async persist(callCenter,ledger,options={}){this._assertStorage();const authorityGuard=typeof options?.authorityGuard==='function'?options.authorityGuard:null;authorityGuard?.();const local=this._localSnapshot(callCenter,ledger,options);return await this._exclusive(async()=>{authorityGuard?.();const latest=this._readLatest({adopt:false});this._assertAdmissionCapacity(local,latest);const merged=mergeDelta(this.base,local,latest);authorityGuard?.();return await this._writeSnapshot({version:VERSION,generation:latest.generation,revision:Number(latest.revision||0)+1,callAuthority:merged.callAuthority,transactions:merged.transactions,terminalArchive:merged.terminalArchive});});}
    async persistSupersession(callCenter,ledger,priorProjection,replacementProjection){
        this._assertStorage();
        const priorId=String(priorProjection?.id||''),replacementId=String(replacementProjection?.id||'');
        if(!priorId||!replacementId||priorId===replacementId)throw reviewStoreError('TV2OperatorReviewStateConflict','Operator Review supersession requires distinct prior and replacement transaction identities.');
        if(String(priorProjection?.state||'')!=='cancelled'||String(replacementProjection?.state||'')!=='staged')throw reviewStoreError('TV2OperatorReviewStateConflict','Operator Review supersession requires a CANCELLED prior projection and STAGED replacement projection.');
        const local=this._localSnapshot(callCenter,ledger,{transactionOverrides:[clone(priorProjection),clone(replacementProjection)]});
        return await this._exclusive(async()=>{
            const latest=this._readLatest({adopt:false});
            const durablePrior=(latest.transactions||[]).find(row=>String(row?.id||'')===priorId)||null;
            if(!durablePrior||String(durablePrior.state||'')!=='staged')throw reviewStoreError('TV2OperatorReviewStateConflict',`Operator Review transaction ${priorId} no longer owns a STAGED review; concurrent supersession must restage from current durable authority.`);
            const durableReplacement=(latest.transactions||[]).find(row=>String(row?.id||'')===replacementId)||null;
            if(durableReplacement&&String(durableReplacement.state||'')!=='staged')throw reviewStoreError('TV2OperatorReviewStateConflict',`Operator Review replacement ${replacementId} already has conflicting durable state ${durableReplacement.state}.`);
            this._assertAdmissionCapacity(local,latest);
            const merged=mergeDelta(this.base,local,latest);
            return await this._writeSnapshot({version:VERSION,generation:latest.generation,revision:Number(latest.revision||0)+1,callAuthority:merged.callAuthority,transactions:merged.transactions,terminalArchive:merged.terminalArchive});
        });
    }
    async invalidate(reason='Operator Review scope invalidated.'){this._assertStorage();return await this._exclusive(async()=>{const latest=this._readLatest({adopt:false});const nextGeneration=Number(latest.generation||0)+1;const history=(latest.callAuthority?.history||[]).map(clone);const byId=new Map(history.map(row=>[String(row?.ticket?.id||''),row]));for(const pending of latest.callAuthority?.pendingApprovals||[]){const id=String(pending?.ticket?.id||'');let row=byId.get(id);if(!row){row=clone(pending);history.push(row);byId.set(id,row);}row.state='scope-invalidated';row.error=String(reason);row.resolvedAt=Date.now();row.ticket.metadata={...(row.ticket.metadata||{}),reviewScope:operatorReviewScopeProjection(this.scope,nextGeneration),reviewScopeGeneration:nextGeneration};}
            for(const row of history){if(row?.ticket){row.ticket.metadata={...(row.ticket.metadata||{}),reviewScope:operatorReviewScopeProjection(this.scope,nextGeneration),reviewScopeGeneration:nextGeneration};}}
            const transactions=(latest.transactions||[]).map(row=>{const out=this._tagTransaction(row,nextGeneration);if(out.state==='staged'){out.state='cancelled';out.error=String(reason);out.updatedAt=Date.now();}else if(out.state==='committing'){out.metadata={...(out.metadata||{}),reviewScopeInvalidated:true,reviewScopeInvalidatedReason:String(reason),reviewScopeInvalidatedAt:Date.now()};}return out;});
            const archive=[...(latest.terminalArchive||[])];for(const row of latest.callAuthority?.pendingApprovals||[])archive.push({kind:'call-ticket-scope-invalidation',id:String(row?.ticket?.id||''),state:'scope-invalidated',at:Date.now(),reason:String(reason)});if(archive.length>MAX_TERMINAL_ARCHIVE)throw reviewStoreError('TV2OperatorReviewAuditCapacityExceeded','Operator Review audit archive is full; scope invalidation cannot silently discard audit lineage.');
            const nextAuthority=history.length?validateAuthorityShape({history,pendingApprovals:[]},this.scope,nextGeneration,null):null;
            const retainedTransactions=retainReviewTransactions(transactions);
            return await this._writeSnapshot({version:VERSION,generation:nextGeneration,revision:Number(latest.revision||0)+1,callAuthority:nextAuthority,transactions:retainedTransactions,terminalArchive:archive});});}
    inspectTransaction(id){const target=String(id||'').trim();if(!target)return null;const latest=this._readLatest({adopt:false});return clone((latest.transactions||[]).find(row=>String(row?.id||'')===target)||null);}
    inspectTransactionReceipt(id){const target=String(id||'').trim();if(!target)return null;const latest=this._readLatest({adopt:false});return clone([...(latest.terminalArchive||[])].reverse().find(row=>row?.kind==='review-transaction'&&String(row?.id||'')===target)||null);}
    provesTerminalTransactionProjection(transaction){
        if(!transaction?.id)return false;const latest=this._readLatest({adopt:false}),generation=Number(latest.generation)||0,tagged=this._tagTransaction(transaction,generation),fingerprint=stableHash(JSON.stringify(tagged));
        return (latest.terminalArchive||[]).some(row=>row?.kind==='review-transaction'&&String(row?.id||'')===String(transaction.id)&&String(row?.state||'')===String(transaction.state||'')&&String(row?.projectionFingerprint||'')===fingerprint);
    }
    inspectCallTicket(id){const target=String(id||'').trim();if(!target)return null;const latest=this._readLatest({adopt:false});const pending=(latest.callAuthority?.pendingApprovals||[]).find(row=>String(row?.ticket?.id||'')===target)||null;const history=[...(latest.callAuthority?.history||[])].reverse().find(row=>String(row?.ticket?.id||'')===target)||null;return clone(pending||history||null);}
    async persistTransactionProjection(callCenter,ledger,transaction,options={}){if(!transaction?.id)throw new Error('Operator Review transaction projection requires an ID.');return await this.persist(callCenter,ledger,{...options,transactionOverrides:[clone(transaction)]});}
}

export function createOperatorReviewStore(options={}){return new OperatorReviewStore(options);}
export async function compactOperatorReviewScope(scope,options={}){
    const store=createOperatorReviewStore({...options,scope});
    try{store.load();return await store.compactTerminalAuthority({pressure:true});}finally{store.close();}
}
export function operatorReviewStorageKey(scope=null){return scope?storageKeyForScope(scope):LEGACY_STORAGE_KEY;}
export function operatorReviewScopedStorageKey(scope){return storageKeyForScope(assertOperatorReviewScope(scope));}
export function operatorReviewStorageVersion(){return VERSION;}
export async function invalidateOperatorReviewScope(scope,options={}){
    const normalized=assertOperatorReviewScope(scope);const storage=storageAvailable(options.storage)?options.storage:storageAvailable(globalThis.localStorage)?globalThis.localStorage:null;
    if(!storage)throw reviewStoreError('TV2OperatorReviewDurabilityUnavailable','Nexus Operator Review scope invalidation cannot be made durable because storage is unavailable.');
    const invalidationKey=`${storageKeyForScope(normalized)}${INVALIDATION_SUFFIX}`;const marker=JSON.stringify({version:1,scope:operatorReviewScopeProjection(normalized,0),reason:String(options.reason||'Operator Review scope invalidated.'),startedAt:Date.now(),token:`invalidate_${Date.now()}_${Math.random().toString(36).slice(2)}`});
    try{storage.setItem(invalidationKey,marker);}catch(cause){throw reviewStoreError('TV2OperatorReviewDurabilityUnavailable','Nexus Operator Review invalidation tombstone could not be persisted.',null,cause);}
    if(storage.getItem(invalidationKey)!==marker)throw reviewStoreError('TV2OperatorReviewDurabilityUnavailable','Nexus Operator Review invalidation tombstone could not be verified.');
    const store=createOperatorReviewStore({...options,storage,scope:normalized,allowInvalidating:true});
    try{
        const result=await store.invalidate(options.reason||'Operator Review scope invalidated.');
        storage.removeItem(invalidationKey);
        if(storage.getItem(invalidationKey)!=null)throw reviewStoreError('TV2OperatorReviewDurabilityUnavailable','Nexus Operator Review invalidation completed, but its blocking tombstone could not be cleared safely.');
        return result;
    }finally{store.close();}
}

/**
 * Cross-scope storage-pressure maintenance. Scoped Operator Review snapshots are
 * independent durable authorities, so quota relief must discover every v3
 * scope rather than only the currently active chat/lorebooks. Each snapshot is
 * compacted through its normal exclusive lock and validation path; unresolved
 * STAGED/COMMITTING/recovery-required ownership is never removed.
 */
export async function compactAllOperatorReviewStoragePressure(options={}){
    const storage=storageAvailable(options.storage)?options.storage:storageAvailable(globalThis.localStorage)?globalThis.localStorage:null;
    const lockManager=options.lockManager ?? globalThis.navigator?.locks ?? null;
    const thresholdChars=Math.max(0,Number(options.thresholdChars??4_000_000)||0);
    const force=options.force===true;
    if(!enumerableStorage(storage))return {scanned:0,changed:0,reclaimedChars:0,beforeChars:0,afterChars:0,skipped:true,reason:'storage-not-enumerable',failures:[]};
    const beforeChars=approxStorageChars(storage);
    if(!force&&beforeChars<thresholdChars)return {scanned:0,changed:0,reclaimedChars:0,beforeChars,afterChars:beforeChars,skipped:true,reason:'below-threshold',failures:[]};
    const keys=storageKeys(storage,STORAGE_PREFIX).filter(key=>!key.endsWith(INVALIDATION_SUFFIX));
    let scanned=0,changed=0;
    const failures=[];
    for(const key of keys){
        const rawPayload=storage.getItem(key);
        if(!rawPayload)continue;
        let raw;
        try{raw=JSON.parse(rawPayload);}catch(error){failures.push({key,error:`unreadable:${error?.message||error}`});continue;}
        if(Number(raw?.version)!==VERSION||!raw?.scope){failures.push({key,error:'unsupported-or-missing-scope'});continue;}
        let scope;
        try{scope=assertOperatorReviewScope(raw.scope);if(storageKeyForScope(scope)!==key)throw new Error('scope-key-mismatch');}
        catch(error){failures.push({key,error:String(error?.message||error)});continue;}
        scanned+=1;
        const before=String(rawPayload).length;
        const store=createOperatorReviewStore({storage,lockManager,eventTarget:null,scope});
        try{
            store.load();
            await store.compactTerminalAuthority({pressure:true});
            const after=String(storage.getItem(key)||'').length;
            if(after<before)changed+=1;
        }catch(error){failures.push({key,error:String(error?.message||error),name:String(error?.name||'Error')});}
        finally{store.close();}
    }
    const afterChars=approxStorageChars(storage);
    return {scanned,changed,reclaimedChars:Math.max(0,beforeChars-afterChars),beforeChars,afterChars,skipped:false,reason:null,failures};
}

