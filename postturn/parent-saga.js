import { mutateChatMetadataDurably } from '../nexus/host-durability.js';

export const POSTTURN_PARENT_SAGA_KEY='tv2_postturn_parent_sagas_v1';
export const POSTTURN_PARENT_SAGA_VERSION=1;
const MAX_UNRESOLVED=64;
const MAX_ROWS=2048;
const TERMINAL=new Set(['committed','rolled-back','failed']);
const STATES=new Set(['active','recovery-required','committed','rolled-back','failed']);
const activeLeases=new Map();
const LEASE_STORAGE_PREFIX='tv2_postturn_drain_lease_v2:';
const LEASE_LOCK_PREFIX='tv2:postturn-drain-lease:';
const LEASE_TTL_MS=10*60*1000;
const clone=v=>v==null?v:JSON.parse(JSON.stringify(v));
function err(name,message,extra={}){return Object.assign(new Error(message),{name,...extra});}
function token(){return globalThis.crypto?.randomUUID?.()||`${Date.now()}_${Math.random().toString(36).slice(2)}`;}
function localStorageSafe(){try{return globalThis?.localStorage||null;}catch{return null;}}
function browserRuntime(){return typeof window!=='undefined'&&typeof document!=='undefined';}
const leaseMutationTails=new Map();
async function withLeaseMutationLock(chatId,task){
    const key=String(chatId??''),name=`${LEASE_LOCK_PREFIX}${key}`;
    const locks=globalThis?.navigator?.locks;
    if(locks&&typeof locks.request==='function')return await locks.request(name,{mode:'exclusive'},async()=>await task());
    // A localStorage compare/read-back sequence is not atomic across tabs. In a
    // browser without Web Locks, pretending to own a drain would re-open the
    // exact duplicate-child race this lease exists to prevent, so fail closed.
    if(browserRuntime())throw err('TV2PostTurnLeaseUnavailable','Cross-tab Post-turn drain ownership requires the Web Locks API.');
    const prior=leaseMutationTails.get(key)||Promise.resolve();let release;
    const gate=new Promise(resolve=>{release=resolve;});const tail=prior.catch(()=>{}).then(()=>gate);leaseMutationTails.set(key,tail);
    await prior.catch(()=>{});try{return await task();}finally{release();if(leaseMutationTails.get(key)===tail)leaseMutationTails.delete(key);}
}
function leaseStorageKey(chatId){return `${LEASE_STORAGE_PREFIX}${encodeURIComponent(String(chatId??''))}`;}
function readLease(chatId){const s=localStorageSafe();if(!s)return null;try{const row=JSON.parse(s.getItem(leaseStorageKey(chatId))||'null');return row&&typeof row==='object'&&!Array.isArray(row)?row:null;}catch{return null;}}
function writeLease(chatId,row){const s=localStorageSafe();if(!s)return;if(row==null)s.removeItem(leaseStorageKey(chatId));else s.setItem(leaseStorageKey(chatId),JSON.stringify(row));}
export async function acquirePostTurnDrainLease(chatId){
    const key=String(chatId??'');if(!key)throw err('TV2PostTurnLeaseUnavailable','Post-turn drain requires an active chat identity.');
    if(activeLeases.has(key))throw err('TV2PostTurnDrainBusy',`Post-turn drain for chat ${key} is already active in this runtime.`);
    const owner=token();
    await withLeaseMutationLock(key,async()=>{
        const now=Date.now(),held=readLease(key);
        if(held&&Number(held.expiresAt)>now&&String(held.owner||'')!==owner)throw err('TV2PostTurnDrainBusy',`Post-turn drain for chat ${key} is already owned by another runtime.`,{owner:held.owner||null});
        writeLease(key,{owner,expiresAt:now+LEASE_TTL_MS});
        const confirmed=readLease(key);if(!confirmed||String(confirmed.owner||'')!==owner)throw err('TV2PostTurnDrainBusy',`Post-turn drain lease for chat ${key} lost cross-tab ownership.`);
    });
    activeLeases.set(key,owner);return {chatId:key,owner};
}
export async function renewPostTurnDrainLease(lease){
    if(!lease)return false;const key=String(lease.chatId||''),owner=String(lease.owner||'');if(activeLeases.get(key)!==owner)return false;
    return await withLeaseMutationLock(key,async()=>{const held=readLease(key);if(!held||String(held.owner||'')!==owner){activeLeases.delete(key);return false;}writeLease(key,{...held,owner,expiresAt:Date.now()+LEASE_TTL_MS});return true;});
}
export async function releasePostTurnDrainLease(lease){
    if(!lease)return false;const key=String(lease.chatId||''),owner=String(lease.owner||'');if(activeLeases.get(key)===owner)activeLeases.delete(key);
    return await withLeaseMutationLock(key,async()=>{const held=readLease(key);if(held&&String(held.owner||'')===owner){writeLease(key,null);return true;}return false;});
}

function validateRow(input){
    if(!input||typeof input!=='object'||Array.isArray(input))throw err('TV2PostTurnSagaCorrupt','Post-turn parent saga contains a malformed row.');
    const id=String(input.transactionId||'').trim(),state=String(input.state||'');
    if(Number(input.version)!==POSTTURN_PARENT_SAGA_VERSION||!id||!STATES.has(state)||!Array.isArray(input.proposalIds)||!Array.isArray(input.directWriteIds)||!Array.isArray(input.sourceRange))throw err('TV2PostTurnSagaCorrupt',`Post-turn parent saga ${id||'(missing)'} has invalid schema/state.`);
    return {...clone(input),version:POSTTURN_PARENT_SAGA_VERSION,transactionId:id,chatId:String(input.chatId??''),state,proposalIds:[...new Set(input.proposalIds.map(String).filter(Boolean))],directWriteIds:[...new Set(input.directWriteIds.map(String).filter(Boolean))],sourceRange:input.sourceRange.slice(0,2).map(Number),sourceMessageKeys:[...new Set((input.sourceMessageKeys||[]).map(String).filter(Boolean))],revision:Math.max(1,Number(input.revision)||1)};
}
function rows(context,create=true){
    if(!context?.chatMetadata){if(!create)return[];throw err('TV2PostTurnSagaUnavailable','Post-turn parent saga requires chat metadata.');}
    if(!Object.prototype.hasOwnProperty.call(context.chatMetadata,POSTTURN_PARENT_SAGA_KEY)){if(!create)return[];context.chatMetadata[POSTTURN_PARENT_SAGA_KEY]=[];}
    const value=context.chatMetadata[POSTTURN_PARENT_SAGA_KEY];if(!Array.isArray(value))throw err('TV2PostTurnSagaCorrupt','Post-turn parent saga store is not an array.');
    const normalized=value.map(validateRow),ids=new Set();for(const row of normalized){if(ids.has(row.transactionId))throw err('TV2PostTurnSagaCorrupt',`Duplicate Post-turn parent saga ${row.transactionId}.`);ids.add(row.transactionId);}return normalized;
}
function install(context,next){if(next.length>MAX_ROWS)throw err('TV2PostTurnSagaAuditCapacityExceeded',`Post-turn parent saga audit reached ${MAX_ROWS} rows; export/rotate evidence before continuing.`);context.chatMetadata[POSTTURN_PARENT_SAGA_KEY]=next.map(validateRow);}
function sameArray(a,b){return JSON.stringify(a||[])===JSON.stringify(b||[]);}
export function getPostTurnParentSagas({context,unresolvedOnly=false}={}){return rows(context,false).filter(row=>!unresolvedOnly||!TERMINAL.has(row.state)).map(clone);}
export function getQuarantinedPostTurnMessageIds({context}={}){
    const ids=new Set();
    for(const row of rows(context,false)){
        if(String(row?.state||'')!=='recovery-required'||!row?.recoveryQuarantine)continue;
        const durable=Array.isArray(row.recoveryQuarantine?.sourceMessageIds)?row.recoveryQuarantine.sourceMessageIds:[];
        const fallback=(Array.isArray(row?.sourceEligibility)?row.sourceEligibility:[]).map(item=>item?.messageId);
        for(const id of [...durable,...fallback]){const value=String(id||'').trim();if(value)ids.add(value);}
    }
    return [...ids];
}
export async function beginPostTurnParentSaga({context,transactionId,chatId,sourceRange,sourceMessageKeys=[],preBacklog,sourceEligibility=[]}={}){
    const id=String(transactionId||'').trim(),cid=String(chatId??'');if(!id||!cid)throw err('TV2PostTurnSagaIdentity','Post-turn parent saga requires transactionId and chatId.');
    return await mutateChatMetadataDurably(context,'Nexus Post-turn parent saga begin',{keys:[POSTTURN_PARENT_SAGA_KEY]},()=>{
        const list=rows(context,true),existing=list.find(row=>row.transactionId===id);
        if(existing){if(existing.chatId!==cid||!sameArray(existing.sourceRange,sourceRange)||!sameArray(existing.sourceMessageKeys,sourceMessageKeys))throw err('TV2PostTurnSagaIdentityConflict',`Post-turn transaction ${id} is already bound to another source unit.`);return clone(existing);}
        const competing=list.find(row=>!TERMINAL.has(row.state)&&row.chatId===cid&&row.sourceMessageKeys.some(key=>sourceMessageKeys.includes(key)));
        if(competing)throw err('TV2PostTurnSagaAdmissionFence',`Post-turn source unit is already owned by unresolved parent ${competing.transactionId}.`,{transactionId:competing.transactionId});
        const unresolved=list.filter(row=>!TERMINAL.has(row.state)&&row.chatId===cid);if(unresolved.length>=MAX_UNRESOLVED)throw err('TV2PostTurnSagaBackpressure',`Chat ${cid} has ${unresolved.length} unresolved Post-turn parent sagas.`,{limit:MAX_UNRESOLVED});
        const now=Date.now(),row={version:POSTTURN_PARENT_SAGA_VERSION,revision:1,transactionId:id,chatId:cid,state:'active',createdAt:now,updatedAt:now,sourceRange:[...(sourceRange||[])],sourceMessageKeys:[...sourceMessageKeys],sourceEligibility:clone(sourceEligibility||[]),proposalIds:[],directWriteIds:[],preBacklog:clone(preBacklog),postBacklog:null,error:''};
        list.push(row);install(context,list);return clone(row);
    });
}
export async function updatePostTurnParentSaga(transactionId,patch={}, {context}={}){
    return await mutateChatMetadataDurably(context,'Nexus Post-turn parent saga update',{keys:[POSTTURN_PARENT_SAGA_KEY]},()=>{
        const list=rows(context,true),row=list.find(item=>item.transactionId===String(transactionId));if(!row)throw err('TV2PostTurnSagaMissing',`Post-turn parent saga ${transactionId} was not found.`);
        if(patch.state!==undefined){const next=String(patch.state||'');if(!STATES.has(next))throw err('TV2PostTurnSagaInvalidState',`Unsupported Post-turn parent saga state ${next}.`);if(TERMINAL.has(row.state)&&next!==row.state)throw err('TV2PostTurnSagaTerminal',`Post-turn parent saga ${transactionId} is terminal and cannot be reopened.`);row.state=next;}
        for(const key of ['proposalIds','directWriteIds'])if(patch[key]!==undefined)row[key]=[...new Set([...(row[key]||[]),...(patch[key]||[]).map(String).filter(Boolean)])];
        if(Object.prototype.hasOwnProperty.call(patch,'postBacklog'))row.postBacklog=clone(patch.postBacklog);
        if(Object.prototype.hasOwnProperty.call(patch,'recoveryQuarantine'))row.recoveryQuarantine=patch.recoveryQuarantine==null?null:clone(patch.recoveryQuarantine);
        if(patch.error!==undefined)row.error=String(patch.error||'');row.revision+=1;row.updatedAt=Date.now();install(context,list);return clone(row);
    });
}
export async function resolvePostTurnParentSaga(transactionId,state,{context,error=''}={}){return updatePostTurnParentSaga(transactionId,{state,error},{context});}
