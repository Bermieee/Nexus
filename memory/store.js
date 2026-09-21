import { getContext } from '../../../../st-context.js';
import { logEvent } from '../observability/telemetry.js';
import { mutateChatMetadataDurably } from '../nexus/host-durability.js';

const META_KEY = 'tv2_memory_bank';
const STORE_VERSION = 3;
const normalizedStoreIdentities = new WeakSet();

function clone(v){ return v == null ? v : JSON.parse(JSON.stringify(v)); }
function now(){ return Date.now(); }
function hashText(text=''){
    let h=2166136261>>>0;
    const value=String(text||'');
    for(let i=0;i<value.length;i++){h^=value.charCodeAt(i);h=Math.imul(h,16777619);}
    return (h>>>0).toString(16).padStart(8,'0');
}
function narrativeMessage(m){return !!m&&!m.is_system&&String(m.mes||'').trim().length>0;}
function sourceMessageIdsForRange(chat,start,end){
    const ids=[];
    for(let i=Math.max(0,start);i<=Math.min(chat.length-1,end);i++){const m=chat[i];if(!narrativeMessage(m))continue;ids.push(String(m?.extra?.tv2_message_id||i));}
    return ids;
}
function sourceFingerprintForRange(chat,start,end){
    return hashText(chat.slice(Math.max(0,start),Math.min(chat.length-1,end)+1).map(m=>`${m?.is_user?'u':'a'}:${m?.mes||''}`).join('\n'));
}

function freshStore(){
    return {
        version: STORE_VERSION,
        summarizedUpTo: -1,
        records: {},
        activeLayers: [],
        permanentIds: [],
        compressedIndices: [],
        coverageReceipts: [],
        sequence: 0,
        lastCycleId: null,
        lastUpdatedAt: 0,
    };
}

function normalizeRouteEvaluation(raw=null){
    if(!raw||typeof raw!=='object'||Array.isArray(raw))return null;
    const scores=raw.scores&&typeof raw.scores==='object'&&!Array.isArray(raw.scores)?{
        lore:Number.isFinite(Number(raw.scores.lore))?Number(raw.scores.lore):null,
        characterState:Number.isFinite(Number(raw.scores.characterState))?Number(raw.scores.characterState):null,
        primarilyTemporary:Number.isFinite(Number(raw.scores.primarilyTemporary))?Number(raw.scores.primarilyTemporary):null,
    }:null;
    return {
        contractId:String(raw.contractId||''),
        sourceFingerprint:String(raw.sourceFingerprint||''),
        disposition:String(raw.disposition||''),
        reason:String(raw.reason||''),
        classification:String(raw.classification||''),
        scores,
        evaluatedAt:Math.max(0,Number(raw.evaluatedAt)||0),
    };
}

function normalizeRecord(raw={}){
    const layer=Math.max(0,Number(raw.layer)||0);
    const range=Array.isArray(raw.turnRange)&&raw.turnRange.length>=2
        ? [Number(raw.turnRange[0]),Number(raw.turnRange[1])]
        : null;
    const assistantRange=Array.isArray(raw.assistantTurnRange)&&raw.assistantTurnRange.length>=2
        ? [Number(raw.assistantTurnRange[0]),Number(raw.assistantTurnRange[1])]
        : null;
    return {
        id:String(raw.id||''),
        layer,
        text:String(raw.text||''),
        turnRange:range,
        assistantTurnRange:assistantRange,
        createdAt:Number(raw.createdAt||raw.timestamp)||now(),
        updatedAt:Number(raw.updatedAt)||Number(raw.createdAt||raw.timestamp)||now(),
        sourceMessageIds:Array.isArray(raw.sourceMessageIds)?raw.sourceMessageIds.map(String):[],
        sourceFingerprint:String(raw.sourceFingerprint||''),
        childIds:Array.isArray(raw.childIds)?raw.childIds.map(String):[],
        parentId:raw.parentId?String(raw.parentId):null,
        promotedTo:raw.promotedTo?String(raw.promotedTo):null,
        characters:Array.isArray(raw.characters)?raw.characters.map(String).filter(Boolean):[],
        locations:Array.isArray(raw.locations)?raw.locations.map(String).filter(Boolean):[],
        dates:Array.isArray(raw.dates)?raw.dates.map(String).filter(Boolean):[],
        topics:Array.isArray(raw.topics)?raw.topics.map(String).filter(Boolean):[],
        threads:Array.isArray(raw.threads)?raw.threads.map(String).filter(Boolean):[],
        routeState:String(raw.routeState||'unrouted'),
        routeProposalIds:Array.isArray(raw.routeProposalIds)?raw.routeProposalIds.map(String):[],
        routeReasoning:String(raw.routeReasoning||''),
        routeEvaluation:normalizeRouteEvaluation(raw.routeEvaluation),
        source:String(raw.source||'summary'),
        sidecarSlot:raw.sidecarSlot?String(raw.sidecarSlot):null,
        cycleId:raw.cycleId?String(raw.cycleId):null,
        permanent:raw.permanent===true,
        locked:raw.locked===true,
        revisions:Array.isArray(raw.revisions)?raw.revisions.slice(-12):[],
    };
}

function normalizeCoverageReceipt(raw={}){
    const range=Array.isArray(raw.turnRange)&&raw.turnRange.length>=2
        ? [Number(raw.turnRange[0]),Number(raw.turnRange[1])]
        : null;
    return {
        id:String(raw.id||''),
        turnRange:range,
        sourceMessageIds:Array.isArray(raw.sourceMessageIds)?raw.sourceMessageIds.map(String):[],
        sourceFingerprint:String(raw.sourceFingerprint||''),
        sourceMemoryId:raw.sourceMemoryId?String(raw.sourceMemoryId):null,
        source:String(raw.source||'summary-coverage'),
        createdAt:Number(raw.createdAt)||now(),
    };
}

function coverageReceiptFromRecord(record){
    if(!record||record.layer!==0||!record.turnRange)return null;
    return normalizeCoverageReceipt({
        id:`coverage:${record.id}`,
        turnRange:record.turnRange,
        sourceMessageIds:record.sourceMessageIds,
        sourceFingerprint:record.sourceFingerprint,
        sourceMemoryId:record.id,
        source:'layer0-summary',
        createdAt:record.createdAt,
    });
}

function upsertCoverageReceiptForRecord(store,record){
    const receipt=coverageReceiptFromRecord(record);if(!receipt)return false;
    if(!Array.isArray(store.coverageReceipts))store.coverageReceipts=[];
    const index=store.coverageReceipts.findIndex(row=>String(row?.id||'')===receipt.id);
    if(index>=0)store.coverageReceipts[index]=receipt;else store.coverageReceipts.push(receipt);
    return true;
}

function coverageReceiptValidity(receipt,chat){
    if(!receipt?.turnRange)return {valid:false,reason:'missing-range'};
    const [start,end]=receipt.turnRange;
    if(!Number.isFinite(start)||!Number.isFinite(end)||start<0||end<start||end>=chat.length)return {valid:false,reason:'source-range-missing'};
    const currentIds=sourceMessageIdsForRange(chat,start,end),storedIds=(receipt.sourceMessageIds||[]).map(String);
    if(storedIds.length&&JSON.stringify(storedIds)!==JSON.stringify(currentIds))return {valid:false,reason:'source-message-identity-changed'};
    if(receipt.sourceFingerprint&&receipt.sourceFingerprint!==sourceFingerprintForRange(chat,start,end))return {valid:false,reason:'source-fingerprint-changed'};
    return {valid:true,reason:'valid'};
}

function effectiveCoverageEnd(store,chat=getContext()?.chat||[]){
    const rows=(store?.coverageReceipts||[]).filter(r=>r?.turnRange).sort((a,b)=>a.turnRange[0]-b.turnRange[0]||a.turnRange[1]-b.turnRange[1]);
    let end=-1;
    for(const receipt of rows){
        const validity=coverageReceiptValidity(receipt,chat);if(!validity.valid)continue;
        const [start,receiptEnd]=receipt.turnRange;if(start>end+1)break;if(start<=end+1)end=Math.max(end,receiptEnd);
    }
    return end;
}

function historicalCoverageEndFromRecords(store,chat=getContext()?.chat||[]){
    const memo=new Map();
    const rows=Object.values(store?.records||{}).filter(record=>record?.turnRange&&(record.layer===0||(record.childIds||[]).length>0)).filter(record=>memoryValidityInternal(record,store,chat,memo,new Set()).valid).sort((a,b)=>a.turnRange[0]-b.turnRange[0]||a.turnRange[1]-b.turnRange[1]);
    let end=-1;
    for(const record of rows){const [start,recordEnd]=record.turnRange;if(start>end+1)break;if(start<=end+1)end=Math.max(end,recordEnd);}
    return end;
}

function ensureCoverageLedger(store,chat=getContext()?.chat||[]){
    let changed=false;
    if(!Array.isArray(store.coverageReceipts)){store.coverageReceipts=[];changed=true;}
    for(const record of Object.values(store.records||{}))if(record?.layer===0&&record?.turnRange){
        const id=`coverage:${record.id}`;
        if(!store.coverageReceipts.some(row=>String(row?.id||'')===id)){store.coverageReceipts.push(coverageReceiptFromRecord(record));changed=true;}
    }
    let covered=effectiveCoverageEnd(store,chat);
    const historical=historicalCoverageEndFromRecords(store,chat);
    const storedPointer=Number.isFinite(Number(store.summarizedUpTo))?Number(store.summarizedUpTo):-1;
    const target=Math.min(chat.length-1,Math.max(storedPointer,historical));
    if(target>covered){
        const start=covered+1,end=target;
        store.coverageReceipts.push(normalizeCoverageReceipt({
            id:`coverage:legacy:${start}:${end}:${hashText(sourceMessageIdsForRange(chat,start,end).join('|'))}`,
            turnRange:[start,end],sourceMessageIds:sourceMessageIdsForRange(chat,start,end),sourceFingerprint:sourceFingerprintForRange(chat,start,end),source:'legacy-coverage-migration',createdAt:now(),
        }));
        changed=true;covered=effectiveCoverageEnd(store,chat);
    }
    if(store.summarizedUpTo!==covered){store.summarizedUpTo=covered;changed=true;}
    return changed;
}

function normalizeStore(store){
    if(!store||typeof store!=='object')store=freshStore();
    if(!store.records||typeof store.records!=='object'||Array.isArray(store.records))store.records={};
    if(!Array.isArray(store.activeLayers))store.activeLayers=[];
    if(!Array.isArray(store.permanentIds))store.permanentIds=[];
    if(!Array.isArray(store.compressedIndices))store.compressedIndices=[];
    if(!Array.isArray(store.coverageReceipts))store.coverageReceipts=[];
    store.version=STORE_VERSION;
    store.summarizedUpTo=Number.isFinite(Number(store.summarizedUpTo))?Number(store.summarizedUpTo):-1;
    store.sequence=Math.max(0,Number(store.sequence)||0);
    for(const [id,raw] of Object.entries(store.records)){
        const record=normalizeRecord({...raw,id:raw?.id||id});
        if(!record.id){delete store.records[id];continue;}
        if(record.id!==id){delete store.records[id];store.records[record.id]=record;}else store.records[id]=record;
    }
    const permanentIds=new Set(store.permanentIds.map(String).filter(id=>!!store.records[id]));
    for(const record of Object.values(store.records))if(record.permanent===true)permanentIds.add(record.id);
    store.permanentIds=[...permanentIds];
    for(const record of Object.values(store.records))record.permanent=permanentIds.has(record.id);
    for(let i=0;i<store.activeLayers.length;i++){
        if(!Array.isArray(store.activeLayers[i]))store.activeLayers[i]=[];
        store.activeLayers[i]=[...new Set(store.activeLayers[i].map(String).filter(id=>!!store.records[id]))];
    }
    store.coverageReceipts=(store.coverageReceipts||[]).map(normalizeCoverageReceipt).filter(r=>r.id&&r.turnRange);
    const coverageIds=new Set();
    store.coverageReceipts=store.coverageReceipts.filter(r=>coverageIds.has(r.id)?false:(coverageIds.add(r.id),true));
    return store;
}

export function currentMemoryStoryId(context=getContext()){
    const id=String(context?.chatId ?? context?.chat_id ?? '').trim();
    return id || null;
}
export function hasActiveMemoryStory(context=getContext()){
    return currentMemoryStoryId(context) !== null;
}

export function getMemoryStore(){
    const ctx=getContext();
    if(!hasActiveMemoryStory(ctx))return freshStore();
    if(!ctx?.chatMetadata)return freshStore();
    if(!ctx.chatMetadata[META_KEY])ctx.chatMetadata[META_KEY]=freshStore();
    const store=ctx.chatMetadata[META_KEY];
    if(!normalizedStoreIdentities.has(store)){
        normalizeStore(store);
        const migrated=ensureCoverageLedger(store,ctx?.chat||[]);
        normalizedStoreIdentities.add(store);
        if(migrated){try{ctx?.saveMetadataDebounced?.();}catch{}logEvent('memory','coverage-ledger-migrated',{summarizedUpTo:store.summarizedUpTo,coverageReceipts:store.coverageReceipts.length},'info');}
    }
    return store;
}

export function saveMemoryStore({notify=true,debounce=true}={}){
    const store=getMemoryStore();
    store.lastUpdatedAt=now();
    if(debounce)try{getContext()?.saveMetadataDebounced?.();}catch{}
    if(notify)try{globalThis.window?.dispatchEvent?.(new CustomEvent('tv2-memory-bank-updated'));}catch{}
    return store;
}
function notifyMemoryStore(){try{globalThis.window?.dispatchEvent?.(new CustomEvent('tv2-memory-bank-updated'));}catch{}}

function nextIdForStore(store,prefix='mem'){
    store.sequence=(Number(store.sequence)||0)+1;
    return `tv2_${prefix}_${now()}_${store.sequence}`;
}
function nextId(prefix='mem'){ return nextIdForStore(getMemoryStore(),prefix); }
function contiguousLayerZeroEnd(store){
    return effectiveCoverageEnd(store,getContext()?.chat||[]);
}

export function previewMemoryRecordCreate(data={},baseStore=getMemoryStore()){
    const store=normalizeStore(clone(baseStore));
    const id=String(data.id||nextIdForStore(store,'mem'));
    const record=normalizeRecord({...data,id,createdAt:data.createdAt||now(),updatedAt:now()});
    store.records[id]=record;
    if(!Array.isArray(store.activeLayers[record.layer]))store.activeLayers[record.layer]=[];
    if(!store.activeLayers[record.layer].includes(id))store.activeLayers[record.layer].push(id);
    upsertCoverageReceiptForRecord(store,record);
    if(record.turnRange)store.summarizedUpTo=contiguousLayerZeroEnd(store);
    store.lastUpdatedAt=now();
    return {store:clone(store),record:clone(record)};
}

export function createMemoryRecordLocal(data={}){
    const store=getMemoryStore();
    const id=String(data.id||nextId('mem'));
    const record=normalizeRecord({...data,id,createdAt:data.createdAt||now(),updatedAt:now()});
    store.records[id]=record;
    if(!Array.isArray(store.activeLayers[record.layer]))store.activeLayers[record.layer]=[];
    if(!store.activeLayers[record.layer].includes(id))store.activeLayers[record.layer].push(id);
    upsertCoverageReceiptForRecord(store,record);
    if(record.turnRange)store.summarizedUpTo=contiguousLayerZeroEnd(store);
    saveMemoryStore({notify:false});
    logEvent('memory','record-created',{id,layer:record.layer,turnRange:record.turnRange,textChars:record.text.length,cycleId:record.cycleId,sidecarSlot:record.sidecarSlot},'info');
    return clone(record);
}

export async function createMemoryRecord(data={}){
    const context=getContext();
    const record=await mutateChatMetadataDurably(context,'Memory record create',{keys:[META_KEY]},()=>createMemoryRecordLocal(data));
    notifyMemoryStore();
    return record;
}

export function getMemoryRecord(id){return clone(getMemoryStore().records?.[String(id)]||null);}

export function memoryRecordVersion(record){
    if(!record)return null;
    const view={};
    for(const key of ['id','layer','text','turnRange','assistantTurnRange','sourceMessageIds','sourceFingerprint','childIds','parentId','promotedTo','characters','locations','dates','topics','threads','routeState','routeProposalIds','routeReasoning','source','sidecarSlot','cycleId','permanent','locked','updatedAt'])view[key]=clone(record[key]);
    return JSON.stringify(view);
}

function joinVersionParts(values=[]){
    return values.map(value=>Array.isArray(value)?value.map(String).join('\u001f'):String(value??'')).join('\u001e');
}

// Semantic vector identity intentionally excludes protection/audit metadata.
// Lock/permanent/route bookkeeping can change residency policy without paying
// to re-embed byte-identical semantic text.
export function memoryEmbeddingVersion(record){
    if(!record)return null;
    return hashText(joinVersionParts([record.text,record.characters,record.locations,record.topics]));
}

// Foreground paging needs a content-sensitive but allocation-light freshness
// stamp. This catches same-ID/same-length direct edits while avoiding repeated
// broad clone+JSON serialization of the whole canonical record projection.
export function memoryPagingFreshnessStamp(record){
    if(!record)return null;
    return hashText(joinVersionParts([
        record.id,record.layer,record.text,record.turnRange,record.assistantTurnRange,
        record.sourceMessageIds,record.sourceFingerprint,record.characters,record.locations,
        record.dates,record.topics,record.threads,record.routeProposalIds,record.permanent===true,
        record.locked===true,record.updatedAt,
    ]));
}

export function getPermanentMemoryRecords(){const s=getMemoryStore();return (s.permanentIds||[]).map(id=>s.records[id]).filter(r=>r&&isMemoryRecordValidForCurrentChat(r)).map(clone);}
function setMemoryPermanentLocal(id,permanent=true){const s=getMemoryStore();const record=s.records?.[String(id)];if(!record)return null;const ids=new Set((s.permanentIds||[]).map(String));if(permanent)ids.add(record.id);else ids.delete(record.id);s.permanentIds=[...ids];record.permanent=permanent===true;record.updatedAt=now();saveMemoryStore({notify:false});return clone(record);}
export async function setMemoryPermanent(id,permanent=true){const context=getContext();const record=await mutateChatMetadataDurably(context,'Memory permanent state',{keys:[META_KEY]},()=>setMemoryPermanentLocal(id,permanent));if(record){notifyMemoryStore();logEvent('memory',permanent?'permanent-saved':'permanent-removed',{id:record.id,layer:record.layer,turnRange:record.turnRange,durable:true},'info');}return record;}
export async function toggleMemoryPermanent(id){const record=getMemoryStore().records?.[String(id)];return record?await setMemoryPermanent(id,record.permanent!==true):null;}
function setMemoryPermanentProtectedLocal(id,permanent=true){const s=getMemoryStore(),record=s.records?.[String(id)];if(!record)return null;const keep=permanent===true,ids=new Set((s.permanentIds||[]).map(String));if(keep)ids.add(record.id);else ids.delete(record.id);s.permanentIds=[...ids];record.permanent=keep;record.locked=keep;record.updatedAt=now();saveMemoryStore({notify:false});return clone(record);}
export async function setMemoryPermanentProtected(id,permanent=true){const context=getContext();const record=await mutateChatMetadataDurably(context,'Memory permanent protection',{keys:[META_KEY]},()=>setMemoryPermanentProtectedLocal(id,permanent));if(record){notifyMemoryStore();logEvent('memory',record.permanent?'permanent-protected':'permanent-unprotected',{id:record.id,layer:record.layer,durable:true},'info');}return record;}
export async function toggleMemoryPermanentProtected(id){const record=getMemoryStore().records?.[String(id)];return record?await setMemoryPermanentProtected(id,record.permanent!==true):null;}
function deleteMemoryRecordLocal(id){const store=getMemoryStore();id=String(id||'');const record=store.records?.[id];if(!record)return null;for(const layer of store.activeLayers||[]){if(!Array.isArray(layer))continue;for(let i=layer.length-1;i>=0;i--)if(String(layer[i])===id)layer.splice(i,1);}store.permanentIds=(store.permanentIds||[]).map(String).filter(value=>value!==id);for(const row of Object.values(store.records||{})){if(!row||String(row.id)===id)continue;if(Array.isArray(row.childIds))row.childIds=row.childIds.map(String).filter(value=>value!==id);if(String(row.parentId||'')===id)row.parentId=null;if(String(row.promotedTo||'')===id)row.promotedTo=null;}delete store.records[id];saveMemoryStore({notify:false});return clone(record);}
export async function deleteMemoryRecord(id,{reason='operator'}={}){const context=getContext();const record=await mutateChatMetadataDurably(context,'Memory record delete',{keys:[META_KEY]},()=>deleteMemoryRecordLocal(id));if(record){notifyMemoryStore();logEvent('memory','record-deleted',{id:record.id,layer:record.layer,reason:String(reason||'operator'),summarizedUpTo:getMemoryStore().summarizedUpTo,durable:true},'info');}return record;}
function setMemoryLockedLocal(id,locked=true){const s=getMemoryStore(),record=s.records?.[String(id)];if(!record)return null;record.locked=locked===true;record.updatedAt=now();saveMemoryStore({notify:false});return clone(record);}
export async function setMemoryLocked(id,locked=true){const context=getContext();const record=await mutateChatMetadataDurably(context,'Memory lock state',{keys:[META_KEY]},()=>setMemoryLockedLocal(id,locked));if(record){notifyMemoryStore();logEvent('memory',record.locked?'locked':'unlocked',{id:record.id,layer:record.layer,durable:true},'info');}return record;}
export async function toggleMemoryLocked(id){const record=getMemoryStore().records?.[String(id)];return record?await setMemoryLocked(id,record.locked!==true):null;}
export function reviseMemoryRecordLocal(id,patch={},reason='regenerated',{expectedVersion=null}={}){
    const s=getMemoryStore(),record=s.records?.[String(id)];if(!record)throw new Error(`Memory ${id} was not found.`);if(record.locked)throw new Error('Unlock this memory before regenerating it.');
    if(expectedVersion!=null&&memoryRecordVersion(record)!==String(expectedVersion)){const error=new Error(`Memory ${id} changed while regeneration was in flight.`);error.name='TV2MemoryRegenerationStale';throw error;}
    record.revisions=[...(record.revisions||[]),{at:now(),reason,text:record.text,characters:record.characters,locations:record.locations,dates:record.dates,topics:record.topics,threads:record.threads,sidecarSlot:record.sidecarSlot}].slice(-12);
    for(const key of ['text','characters','locations','dates','topics','threads','sidecarSlot'])if(patch[key]!==undefined)record[key]=clone(patch[key]);record.updatedAt=now();saveMemoryStore({notify:false});return clone(record);
}
export async function reviseMemoryRecord(id,patch={},reason='regenerated',{expectedVersion=null}={}){const context=getContext();const record=await mutateChatMetadataDurably(context,'Memory revision',{keys:[META_KEY]},()=>reviseMemoryRecordLocal(id,patch,reason,{expectedVersion}));notifyMemoryStore();logEvent('memory','revised',{id:record.id,reason,revisionCount:record.revisions.length,durable:true},'info');return record;}
function rollbackMemoryRevisionLocal(id){const s=getMemoryStore(),record=s.records?.[String(id)];if(!record||!Array.isArray(record.revisions)||!record.revisions.length)throw new Error('No previous revision is available for this memory.');if(record.locked)throw new Error('Unlock this memory before rollback.');const revision=record.revisions.pop();for(const key of ['text','characters','locations','dates','topics','threads','sidecarSlot'])if(revision[key]!==undefined)record[key]=clone(revision[key]);record.updatedAt=now();saveMemoryStore({notify:false});return clone(record);}
export async function rollbackMemoryRevision(id){const context=getContext();const record=await mutateChatMetadataDurably(context,'Memory revision rollback',{keys:[META_KEY]},()=>rollbackMemoryRevisionLocal(id));notifyMemoryStore();logEvent('memory','revision-rolled-back',{id:record.id,remainingRevisions:record.revisions.length,durable:true},'warn');return record;}

function memoryValidityInternal(record,store,chat,memo=new Map(),stack=new Set()){
    if(!record?.id)return {valid:false,reason:'missing-record-id'};
    if(memo.has(record.id))return memo.get(record.id);
    if(stack.has(record.id)){const out={valid:false,reason:'memory-cycle'};memo.set(record.id,out);return out;}
    stack.add(record.id);
    let out={valid:true,reason:'valid'};
    if(record.layer===0&&record.turnRange){
        const [start,end]=record.turnRange;
        if(!Number.isFinite(start)||!Number.isFinite(end)||start<0||end<start||end>=chat.length)out={valid:false,reason:'source-range-missing'};
        else{
            const currentIds=sourceMessageIdsForRange(chat,start,end),storedIds=(record.sourceMessageIds||[]).map(String);
            if(storedIds.length&&JSON.stringify(storedIds)!==JSON.stringify(currentIds))out={valid:false,reason:'source-message-identity-changed'};
            else if(record.sourceFingerprint&&record.sourceFingerprint!==sourceFingerprintForRange(chat,start,end))out={valid:false,reason:'source-fingerprint-changed'};
        }
    }else if((record.childIds||[]).length){
        for(const childId of record.childIds){const child=store.records?.[childId];if(!child){out={valid:false,reason:'missing-child',childId};break;}const childValidity=memoryValidityInternal(child,store,chat,memo,stack);if(!childValidity.valid){out={valid:false,reason:'stale-child',childId,childReason:childValidity.reason};break;}}
    }
    stack.delete(record.id);memo.set(record.id,out);return out;
}

export function memoryRecordValidity(record,{store=getMemoryStore(),chat=getContext()?.chat||[]}={}){return clone(memoryValidityInternal(record,store,chat,new Map(),new Set()));}
export function isMemoryRecordValidForCurrentChat(record){return memoryRecordValidity(record).valid===true;}
export function getMemoryValidityReport(){
    const store=getMemoryStore(),chat=getContext()?.chat||[],memo=new Map(),rows=[];
    for(const record of Object.values(store.records||{})){const validity=memoryValidityInternal(record,store,chat,memo,new Set());if(!validity.valid)rows.push({id:record.id,layer:record.layer,turnRange:record.turnRange,...validity});}
    return {valid:rows.length===0,invalid:rows};
}
export function getEffectiveSummarizedUpTo(){
    const store=getMemoryStore(),chat=getContext()?.chat||[];
    return effectiveCoverageEnd(store,chat);
}

export function getAllMemoryRecords(){return Object.values(getMemoryStore().records||{}).map(clone);}
export function getActiveLayerIds(layer){return [...(getMemoryStore().activeLayers?.[Number(layer)]||[])];}
export function getActiveLayerRecords(layer){const s=getMemoryStore();return getActiveLayerIds(layer).map(id=>s.records[id]).filter(r=>r&&isMemoryRecordValidForCurrentChat(r)).map(clone);}
export function getActiveMemories(){
    const s=getMemoryStore();
    return (s.activeLayers||[]).flatMap((ids,layer)=>(ids||[]).map(id=>s.records[id]).filter(r=>r&&isMemoryRecordValidForCurrentChat(r)).map(r=>clone({...r,layer})));
}

export function previewMemoryPromotion(childIds=[],parentData={},baseStore=getMemoryStore()){
    const store=normalizeStore(clone(baseStore));
    const children=[...new Set((childIds||[]).map(String))].map(id=>store.records[id]).filter(Boolean);
    if(!children.length)throw new Error('Promotion requires at least one source memory.');
    if(children.some(r=>r.locked))throw new Error('Locked memories are protected from automatic promotion.');
    const sourceLayer=children[0].layer;
    if(children.some(r=>r.layer!==sourceLayer))throw new Error('Promotion source memories must be from one layer.');
    const parentLayer=sourceLayer+1;
    const start=Math.min(...children.map(r=>r.turnRange?.[0]).filter(Number.isFinite));
    const end=Math.max(...children.map(r=>r.turnRange?.[1]).filter(Number.isFinite));
    const assistantStart=Math.min(...children.map(r=>r.assistantTurnRange?.[0]).filter(Number.isFinite));
    const assistantEnd=Math.max(...children.map(r=>r.assistantTurnRange?.[1]).filter(Number.isFinite));
    const id=String(parentData.id||nextIdForStore(store,'meta'));
    const parent=normalizeRecord({...parentData,id,layer:parentLayer,turnRange:Number.isFinite(start)&&Number.isFinite(end)?[start,end]:null,assistantTurnRange:Number.isFinite(assistantStart)&&Number.isFinite(assistantEnd)?[assistantStart,assistantEnd]:null,childIds:children.map(r=>r.id),source:'promotion'});
    store.records[id]=parent;
    if(!Array.isArray(store.activeLayers[parentLayer]))store.activeLayers[parentLayer]=[];
    store.activeLayers[parentLayer].push(id);
    store.activeLayers[sourceLayer]=(store.activeLayers[sourceLayer]||[]).filter(x=>!children.some(r=>r.id===x));
    for(const child of children){child.promotedTo=id;child.parentId=id;child.updatedAt=now();}
    store.lastUpdatedAt=now();
    return {store:clone(store),parent:clone(parent)};
}

export function promoteMemoryRecords(childIds=[],parentData={}){
    const preview=previewMemoryPromotion(childIds,parentData,getMemoryStore());
    const live=getMemoryStore();
    for(const key of Object.keys(live))delete live[key];
    Object.assign(live,clone(preview.store));
    saveMemoryStore();
    const parent=preview.parent;
    const children=(childIds||[]).map(id=>live.records?.[String(id)]).filter(Boolean);
    const sourceLayer=children[0]?.layer ?? Math.max(0,(parent?.layer||1)-1);
    const parentLayer=parent?.layer ?? sourceLayer+1;
    logEvent('memory','promotion-committed',{sourceLayer,targetLayer:parentLayer,childIds:children.map(r=>r.id),parentId:parent.id,turnRange:parent.turnRange,cycleId:parent.cycleId},'info');
    return clone(parent);
}

function setMemoryRouteEvaluationLocal(id,assessment=null,{expectedVersion=null}={}){
    const store=getMemoryStore();
    const record=store.records?.[String(id)];
    if(!record)return null;
    if(expectedVersion!=null&&memoryRecordVersion(record)!==String(expectedVersion)){
        const error=new Error(`Memory ${id} changed before lifecycle route assessment could settle.`);
        error.name='TV2MemoryRouteAssessmentStale';
        error.code='MEMORY_ROUTE_ASSESSMENT_STALE';
        throw error;
    }
    // This receipt is non-semantic routing metadata. Do not change updatedAt:
    // memoryRecordVersion intentionally represents the Summary source, and the
    // assessment must not invalidate its own exact source/comparison fingerprint.
    record.routeEvaluation=assessment?normalizeRouteEvaluation(assessment):null;
    saveMemoryStore({notify:false});
    return clone(record);
}

export async function setMemoryRouteEvaluation(id,assessment=null,{expectedVersion=null}={}){
    const context=getContext();
    const record=await mutateChatMetadataDurably(context,'Memory lifecycle route assessment',{keys:[META_KEY]},()=>setMemoryRouteEvaluationLocal(id,assessment,{expectedVersion}));
    if(record){
        notifyMemoryStore();
        logEvent('memory','lifecycle-route-assessment',{
            id:record.id,
            disposition:record.routeEvaluation?.disposition||null,
            sourceFingerprint:record.routeEvaluation?.sourceFingerprint||null,
            durable:true,
        },'info');
    }
    return record;
}

export function previewMemoryRouteState(id,{state='routed',proposalIds=[],reasoning=''}={},baseStore=getMemoryStore()){
    const store=normalizeStore(clone(baseStore));const record=store.records[String(id)];if(!record)return {store:clone(store),record:null};
    record.routeState=String(state||'routed');
    record.routeProposalIds=[...new Set((proposalIds||[]).map(String))];
    record.routeReasoning=String(reasoning||'');
    record.updatedAt=now();store.lastUpdatedAt=now();
    return {store:clone(store),record:clone(record)};
}

export function markMemoryRouted(id,{state='routed',proposalIds=[],reasoning=''}={}){
    const preview=previewMemoryRouteState(id,{state,proposalIds,reasoning},getMemoryStore());
    const record=preview.record;if(!record)return null;
    const store=getMemoryStore();for(const key of Object.keys(store))delete store[key];Object.assign(store,clone(preview.store));
    saveMemoryStore();
    logEvent('memory','lore-route-state',{id:record.id,state:record.routeState,proposalCount:record.routeProposalIds.length},record.routeState==='failed'?'warn':'info');
    return clone(record);
}

export function setLastCycleId(cycleId){const s=getMemoryStore();s.lastCycleId=cycleId?String(cycleId):null;saveMemoryStore();}

export function memoryStats(){
    const store=getMemoryStore();
    const layerCounts=(store.activeLayers||[]).map(ids=>(ids||[]).length);
    return {
        summarizedUpTo:store.summarizedUpTo,
        effectiveSummarizedUpTo:getEffectiveSummarizedUpTo(),
        staleRecords:getMemoryValidityReport().invalid.length,
        records:Object.keys(store.records||{}).length,
        active:layerCounts.reduce((a,b)=>a+b,0),
        digested:Object.values(store.records||{}).filter(r=>!!r.promotedTo).length,
        layers:layerCounts.length,
        layerCounts,
        compressedCount:(store.compressedIndices||[]).length,
        coverageReceipts:(store.coverageReceipts||[]).length,
        unrouted:Object.values(store.records||{}).filter(r=>r.routeState==='unrouted'&&!r.promotedTo).length,
        permanent:(store.permanentIds||[]).length,
        locked:Object.values(store.records||{}).filter(r=>r.locked===true).length,
    };
}

export function scanMemoryBank(){
    // Inspection is intentionally read-only. Repair is a distinct mutation
    // surface and must never run implicitly from Housekeeper/manual scan.
    const chat=getContext()?.chat||[];const store=getMemoryStore();const records=Object.values(store.records||{});
    const issues=[];const base=records.filter(r=>r.layer===0&&r.turnRange).sort((a,b)=>a.turnRange[0]-b.turnRange[0]||a.turnRange[1]-b.turnRange[1]);
    let priorEnd=-1;
    for(const record of base){
        const [start,end]=record.turnRange;
        if(!Number.isFinite(start)||!Number.isFinite(end)||start<0||end<start||end>=chat.length)issues.push({kind:'invalid-range',memoryId:record.id,detail:`Invalid message range ${start}–${end}.`});
        if(priorEnd<0&&start>0)issues.push({kind:'gap',memoryId:record.id,range:[0,start-1],detail:`Unsummarized gap before the first record (messages 0–${start-1}).`});
        else if(start<=priorEnd)issues.push({kind:'overlap',memoryId:record.id,detail:`Message range ${start}–${end} overlaps a previous summary.`});
        else if(priorEnd>=0&&start>priorEnd+1)issues.push({kind:'gap',memoryId:record.id,range:[priorEnd+1,start-1],detail:`Unsummarized gap between messages ${priorEnd+1} and ${start-1}.`});
        priorEnd=Math.max(priorEnd,end);
    }
    const validity=getMemoryValidityReport();
    for(const invalid of validity.invalid)issues.push({kind:'stale-source',memoryId:invalid.id,detail:`Memory source is stale (${invalid.reason}).`});
    for(const record of records){
        for(const childId of record.childIds||[])if(!store.records?.[childId])issues.push({kind:'missing-child',memoryId:record.id,detail:`Missing child memory ${childId}.`});
        if(record.parentId&&!store.records?.[record.parentId])issues.push({kind:'missing-parent',memoryId:record.id,detail:`Missing parent memory ${record.parentId}.`});
        if(['failed','partial'].includes(record.routeState))issues.push({kind:'routing',memoryId:record.id,detail:`Lore review is ${record.routeState}.`});
        if(!String(record.text||'').trim())issues.push({kind:'empty',memoryId:record.id,detail:'Memory text is empty.'});
    }
    for(const receipt of store.coverageReceipts||[]){const validity=coverageReceiptValidity(receipt,chat);if(!validity.valid)issues.push({kind:'stale-coverage',coverageId:receipt.id,detail:`Summary coverage source is stale (${validity.reason}).`});}
    const computedEnd=getEffectiveSummarizedUpTo();
    if(computedEnd!==store.summarizedUpTo)issues.push({kind:'pointer',detail:`Stored summary pointer is ${store.summarizedUpTo}; current valid contiguous source ends at ${computedEnd}.`});
    const stats=memoryStats();
    logEvent('memory','bank-scan-complete',{issueCount:issues.length,records:stats.records,active:stats.active,unrouted:stats.unrouted},issues.length?'warn':'info');
    return {ok:issues.length===0,scannedAt:Date.now(),chatMessages:chat.length,stats,issues};
}

function descendantsOf(records,seedIds){
    const doomed=new Set(seedIds);
    let changed=true;
    while(changed){changed=false;for(const r of Object.values(records)){if(doomed.has(r.id))continue;if((r.childIds||[]).some(id=>doomed.has(id))){doomed.add(r.id);changed=true;}}}
    return doomed;
}

export function repairMemoryBankForCurrentChat(){
    const ctx=getContext();const chat=ctx?.chat||[];const store=getMemoryStore();
    if(store.summarizedUpTo<0)return {changed:false,removed:0,deactivated:0,summarizedUpTo:store.summarizedUpTo};
    const badBase=[];
    const badCoverage=[];
    for(const record of Object.values(store.records)){
        if(record.layer!==0||!record.turnRange)continue;
        const [start,end]=record.turnRange;
        if(!Number.isFinite(start)||!Number.isFinite(end)||start<0||end<start||end>=chat.length){badBase.push(record.id);continue;}
        const currentIds=sourceMessageIdsForRange(chat,start,end);
        const storedIds=(record.sourceMessageIds||[]).map(String);
        if(storedIds.length&&JSON.stringify(storedIds)!==JSON.stringify(currentIds)){badBase.push(record.id);continue;}
        if(record.sourceFingerprint&&record.sourceFingerprint!==sourceFingerprintForRange(chat,start,end)){badBase.push(record.id);continue;}
    }
    for(const receipt of store.coverageReceipts||[]){if(!coverageReceiptValidity(receipt,chat).valid)badCoverage.push(receipt.id);}
    if(!badBase.length&&!badCoverage.length&&store.summarizedUpTo<chat.length)return {changed:false,removed:0,deactivated:0,summarizedUpTo:store.summarizedUpTo};
    const doomed=descendantsOf(store.records,badBase);
    const preserved=new Set([...doomed].filter(id=>store.records[id]?.locked===true||store.records[id]?.permanent===true));
    for(const id of doomed)if(!preserved.has(id))delete store.records[id];
    store.activeLayers=(store.activeLayers||[]).map(ids=>(ids||[]).filter(id=>!doomed.has(id)&&!!store.records[id]));
    store.permanentIds=(store.permanentIds||[]).filter(id=>!!store.records[id]);
    const badCoverageSet=new Set(badCoverage.map(String));
    store.coverageReceipts=(store.coverageReceipts||[]).filter(receipt=>!badCoverageSet.has(String(receipt.id)));
    store.summarizedUpTo=effectiveCoverageEnd(store,chat);
    store.compressedIndices=(store.compressedIndices||[]).filter(i=>i<chat.length&&i<=store.summarizedUpTo);
    saveMemoryStore();
    logEvent('memory','branch-repaired',{chatLength:chat.length,invalidSourceRecords:badBase.length,invalidCoverageReceipts:badCoverage.length,removed:doomed.size-preserved.size,deactivated:preserved.size,summarizedUpTo:store.summarizedUpTo},'warn');
    return {changed:true,removed:doomed.size-preserved.size,deactivated:preserved.size,summarizedUpTo:store.summarizedUpTo};
}

export function clearMemoryBank(){
    const ctx=getContext();if(ctx?.chatMetadata)ctx.chatMetadata[META_KEY]=freshStore();saveMemoryStore();
    logEvent('memory','bank-cleared',{},'warn');
}

export function exportMemoryBank(){return clone(getMemoryStore());}
export function previewMemoryBankImport(payload,{replace=true,baseStore=null}={}){
    const incoming=normalizeStore(clone(payload||{}));
    if(replace)return clone(incoming);
    const current=normalizeStore(clone(baseStore||getMemoryStore()));
    const incomingIds=new Set(Object.keys(incoming.records||{}).map(String));
    current.activeLayers=(current.activeLayers||[]).map(ids=>(ids||[]).filter(id=>!incomingIds.has(String(id))));
    current.permanentIds=(current.permanentIds||[]).filter(id=>!incomingIds.has(String(id)));
    Object.assign(current.records,incoming.records||{});
    incoming.activeLayers.forEach((ids,layer)=>{current.activeLayers[layer]=[...new Set([...(current.activeLayers[layer]||[]),...(ids||[])])];});
    current.permanentIds=[...new Set([...(current.permanentIds||[]),...(incoming.permanentIds||[])])];
    current.summarizedUpTo=Math.max(current.summarizedUpTo,incoming.summarizedUpTo);
    return clone(normalizeStore(current));
}
export function importMemoryBank(payload,{replace=true}={}){
    const ctx=getContext();if(!ctx?.chatMetadata)throw new Error('No active chat metadata is available.');
    const incoming=normalizeStore(clone(payload||{}));
    ctx.chatMetadata[META_KEY]=previewMemoryBankImport(incoming,{replace,baseStore:getMemoryStore()});
    saveMemoryStore();
    logEvent('memory','bank-imported',{replace,records:Object.keys(incoming.records||{}).length},'info');
    return memoryStats();
}
