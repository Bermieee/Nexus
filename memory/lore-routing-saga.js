const KEY='tv2_summary_lore_parent_sagas_v1';
const LOCK_NAME=`${KEY}:mutation`;
const SCHEMA_VERSION=3;
const MAX_UNRESOLVED_PER_SCOPE=80;
const MAX_AUDIT_ROWS=4096;
const TERMINAL=new Set(['committed','rolled-back','failed']);
const STATES=new Set(['active','recovery-required','committed','rolled-back','failed']);
const clone=v=>v==null?v:JSON.parse(JSON.stringify(v));

function storage(){
    const s=globalThis?.localStorage;
    if(!s)throw Object.assign(new Error('Summary-to-Lore parent saga durability is unavailable.'),{name:'TV2LoreRoutingSagaUnavailable'});
    return s;
}
function sagaError(name,message,extra={}){return Object.assign(new Error(message),{name,...extra});}
function browserRuntime(){return typeof window!=='undefined'&&typeof document!=='undefined';}
let processMutationTail=Promise.resolve();
async function withMutationLock(fn){
    const locks=globalThis?.navigator?.locks;
    if(locks&&typeof locks.request==='function')return await locks.request(LOCK_NAME,{mode:'exclusive'},async()=>await fn());
    // Cross-tab authority may not use a last-writer-wins localStorage fallback.
    // In a real browser without Web Locks we fail closed. Tests/non-browser
    // runtimes serialize through a process-local promise chain.
    if(browserRuntime())throw sagaError('TV2LoreRoutingSagaDurabilityUnavailable','Summary-to-Lore parent saga cross-tab mutation requires the Web Locks API.');
    const prior=processMutationTail;let release;processMutationTail=new Promise(resolve=>{release=resolve;});
    await prior;try{return await fn();}finally{release();}
}

function recordFromStore(store,memoryId){
    const id=String(memoryId||'');
    const row=store?.records?.[id];
    return row&&typeof row==='object'&&!Array.isArray(row)?clone(row):null;
}
function normalizeRow(input){
    if(!input||typeof input!=='object'||Array.isArray(input))throw sagaError('TV2LoreRoutingSagaCorrupt','Summary-to-Lore parent saga store contains a malformed row.',{rawValue:clone(input)});
    const version=Number(input.version)||1;
    if(![1,2,SCHEMA_VERSION].includes(version))throw sagaError('TV2LoreRoutingSagaCorrupt',`Summary-to-Lore parent saga row ${String(input.transactionId||'(missing)')} has unsupported schema version ${version}.`,{rawValue:clone(input)});
    const transactionId=String(input.transactionId||'').trim(),memoryId=String(input.memoryId||'').trim(),state=String(input.state||'').trim();
    if(!transactionId||!memoryId||!STATES.has(state))throw sagaError('TV2LoreRoutingSagaCorrupt','Summary-to-Lore parent saga row is missing required identity/state.',{rawValue:clone(input)});
    if(!Array.isArray(input.proposalIds)||!Array.isArray(input.directWriteIds))throw sagaError('TV2LoreRoutingSagaCorrupt',`Summary-to-Lore parent saga ${transactionId} has malformed child ownership arrays.`,{rawValue:clone(input)});
    const preMemoryRecord=clone(input.preMemoryRecord??recordFromStore(input.preMemoryStore,memoryId));
    const postMemoryRecord=clone(input.postMemoryRecord??recordFromStore(input.postMemoryStore,memoryId));
    return {
        version:SCHEMA_VERSION,
        revision:Math.max(1,Number(input.revision)||1),
        transactionId,
        chatId:input.chatId==null?null:String(input.chatId),
        memoryId,
        sourceRevision:input.sourceRevision==null?null:String(input.sourceRevision),
        state,
        createdAt:Number(input.createdAt)||Date.now(),updatedAt:Number(input.updatedAt)||Date.now(),
        reasoning:String(input.reasoning||''),
        proposalIds:[...new Set(input.proposalIds.map(String).filter(Boolean))],
        directWriteIds:[...new Set(input.directWriteIds.map(String).filter(Boolean))],
        preMemoryRecord,postMemoryRecord,error:String(input.error||''),
    };
}

function read(){
    let value;
    try{value=JSON.parse(storage().getItem(KEY)||'[]');}catch(error){throw sagaError('TV2LoreRoutingSagaCorrupt',`Summary-to-Lore parent saga store is unreadable: ${error?.message||error}`,{cause:error});}
    if(!Array.isArray(value))throw sagaError('TV2LoreRoutingSagaCorrupt','Summary-to-Lore parent saga store is not an array.',{rawValue:clone(value)});
    const rows=value.map(normalizeRow),ids=new Set();
    for(const row of rows){if(ids.has(row.transactionId))throw sagaError('TV2LoreRoutingSagaCorrupt',`Summary-to-Lore parent saga store contains duplicate transaction ${row.transactionId}.`);ids.add(row.transactionId);}
    return rows;
}
function write(rows){
    if(rows.length>MAX_AUDIT_ROWS)throw sagaError('TV2LoreRoutingSagaAuditCapacityExceeded',`Summary-to-Lore parent saga audit reached ${MAX_AUDIT_ROWS} rows. Export/rotate audit evidence before more parent sagas can settle.`,{limit:MAX_AUDIT_ROWS});
    try{storage().setItem(KEY,JSON.stringify(rows.map(normalizeRow)));}
    catch(error){if(error?.name==='TV2LoreRoutingSagaAuditCapacityExceeded')throw error;throw sagaError('TV2LoreRoutingSagaPersistenceFailed',`Summary-to-Lore parent saga store could not be persisted: ${error?.message||error}`,{cause:error});}
}
function sameIdentity(row,{chatId,memoryId,sourceRevision}={}){
    return String(row.chatId??'')===String(chatId??'')&&String(row.memoryId||'')===String(memoryId||'')&&String(row.sourceRevision??'')===String(sourceRevision??'');
}
function assertTransition(row,next){
    if(!STATES.has(next))throw sagaError('TV2LoreRoutingSagaInvalidState',`Unsupported Summary-to-Lore saga state ${next}.`);
    if(TERMINAL.has(row.state)&&next!==row.state)throw sagaError('TV2LoreRoutingSagaTerminal',`Summary-to-Lore parent saga ${row.transactionId} is terminal (${row.state}) and cannot be reopened or regressed.`);
}
function enforceScopeBackpressure(rows,chatId){
    const unresolved=rows.filter(row=>!TERMINAL.has(row.state)&&String(row.chatId??'')===String(chatId??''));
    if(unresolved.length>=MAX_UNRESOLVED_PER_SCOPE)throw sagaError('TV2LoreRoutingSagaBackpressure',`Summary-to-Lore parent saga scope has ${unresolved.length} unresolved rows; reconcile this chat before routing more memory.`,{limit:MAX_UNRESOLVED_PER_SCOPE,chatId:chatId??null});
}

export async function beginLoreRoutingSaga({transactionId,chatId,memoryId,sourceRevision=null,preMemoryStore,reasoning=''}={}){
    return await withMutationLock(async()=>{
        const rows=read(),id=String(transactionId||'').trim(),mid=String(memoryId||'').trim();
        if(!id||!mid)throw new Error('Summary-to-Lore parent saga requires transactionId and memoryId.');
        const identity={chatId:chatId==null?null:String(chatId),memoryId:mid,sourceRevision:sourceRevision==null?null:String(sourceRevision)};
        const existing=rows.find(row=>row.transactionId===id);
        if(existing){if(!sameIdentity(existing,identity))throw sagaError('TV2LoreRoutingSagaIdentityConflict',`Summary-to-Lore transaction ${id} is already bound to another chat/memory/source revision.`);return clone(existing);}
        const competing=rows.find(row=>!TERMINAL.has(row.state)&&String(row.chatId??'')===String(identity.chatId??'')&&row.memoryId===mid);
        if(competing)throw sagaError('TV2LoreRoutingSagaAdmissionFence',`Memory ${mid} already has unresolved Summary-to-Lore parent saga ${competing.transactionId}.`,{transactionId:competing.transactionId,chatId:identity.chatId,memoryId:mid});
        enforceScopeBackpressure(rows,identity.chatId);
        const now=Date.now();
        const row={version:SCHEMA_VERSION,revision:1,transactionId:id,...identity,state:'active',createdAt:now,updatedAt:now,reasoning:String(reasoning||''),proposalIds:[],directWriteIds:[],preMemoryRecord:recordFromStore(preMemoryStore,mid),postMemoryRecord:null,error:''};
        rows.push(row);write(rows);return clone(row);
    });
}
export async function updateLoreRoutingSaga(transactionId,patch={}){
    return await withMutationLock(async()=>{
        const rows=read(),row=rows.find(item=>item.transactionId===String(transactionId));if(!row)throw new Error(`Summary-to-Lore parent saga ${transactionId} was not found.`);
        for(const identityKey of ['chatId','memoryId','sourceRevision'])if(Object.prototype.hasOwnProperty.call(patch,identityKey)&&String(patch[identityKey]??'')!==String(row[identityKey]??''))throw sagaError('TV2LoreRoutingSagaIdentityConflict',`Summary-to-Lore parent saga ${transactionId} identity is immutable.`);
        if(patch.state!==undefined){const next=String(patch.state??'');assertTransition(row,next);row.state=next;}
        for(const key of ['reasoning','error'])if(patch[key]!==undefined)row[key]=String(patch[key]??'');
        // Child ownership is monotonic. A stale writer may add an ID, but can never
        // erase an ID observed by another tab or an earlier recovery pass.
        for(const key of ['proposalIds','directWriteIds'])if(patch[key]!==undefined)row[key]=[...new Set([...(row[key]||[]),...(patch[key]||[]).map(String).filter(Boolean)])];
        if(Object.prototype.hasOwnProperty.call(patch,'postMemoryStore'))row.postMemoryRecord=recordFromStore(patch.postMemoryStore,row.memoryId);
        if(Object.prototype.hasOwnProperty.call(patch,'postMemoryRecord'))row.postMemoryRecord=clone(patch.postMemoryRecord);
        row.revision=Math.max(1,Number(row.revision)||1)+1;row.updatedAt=Date.now();write(rows);return clone(row);
    });
}
export async function compactLoreRoutingSagaStore(){
    return await withMutationLock(async()=>{const rows=read();write(rows);return {count:rows.length,version:SCHEMA_VERSION};});
}
export function getLoreRoutingSagas({unresolvedOnly=false,chatId=undefined}={}){return read().filter(row=>(!unresolvedOnly||!TERMINAL.has(row.state))&&(chatId===undefined||String(row.chatId??'')===String(chatId??''))).map(clone);}
export function getLoreRoutingSaga(transactionId){return clone(read().find(row=>row.transactionId===String(transactionId))||null);}
export function hasUnresolvedLoreRoutingSaga(memoryId,{chatId=undefined}={}){const id=String(memoryId||'');return read().some(row=>!TERMINAL.has(row.state)&&row.memoryId===id&&(chatId===undefined||String(row.chatId??'')===String(chatId??'')));}
export async function resolveLoreRoutingSaga(transactionId,state,{error=''}={}){return await updateLoreRoutingSaga(transactionId,{state,error});}
export function isLoreRoutingSagaTerminal(state){return TERMINAL.has(String(state||''));}
export const LORE_ROUTING_SAGA_SCHEMA_VERSION=SCHEMA_VERSION;
