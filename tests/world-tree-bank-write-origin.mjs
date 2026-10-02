import test from 'node:test';
import assert from 'node:assert/strict';
import { replaceNexusWorldTree, getNexusWorldTreeOwner } from '../world-tree/index.js';
import { importLegacyMemoryRecordsToWorldTree } from '../world-tree/import-memory-bank.js';
import { importLegacyCharacterBanksToWorldTree } from '../world-tree/import-character-banks.js';
import { markLegacyWorldTreeMigrated } from '../world-tree/durable-state.js';
import { syncMemoryFacadeToWorldTree, syncCharacterFacadeToWorldTree, worldTreeBankAuthorityEnabled } from '../world-tree/native-bank-authority.js';

const ctx=()=>({chatId:'chat-a',chatMetadata:{},saveMetadataDebounced(){}});
const memory=id=>({id,layer:0,text:'Memory '+id,turnRange:[0,1],assistantTurnRange:[1,1],sourceMessageIds:['m0','m1'],sourceFingerprint:'fp',characters:[],locations:[],dates:[],topics:[],threads:[],childIds:[],parentId:null,promotedTo:null,routeState:'unrouted',routeProposalIds:[],routeReasoning:'',routeEvaluation:null,createdAt:1,updatedAt:2,permanent:false,locked:false});
const bank=id=>({id,storyId:'chat-a',enabled:true,character:'Mara',role:'lead',sceneAware:true,cardBinding:null,linkedRefs:[],memoryIds:[],memoryRefs:[],profile:{personality:'steady',appearance:'',clothingArmor:''},state:{baseline:{personality:'steady'},persistent:{relationships:''},temporary:{}},stateProposals:[],changeHistory:[],fieldProvenance:{},cardSync:{},tracking:{personality:true,relationships:true,status:true,goals:true,behavior:true}});

test('post-migration Memory compatibility write settles into persisted World Tree authority',()=>{
  const context=ctx(),tree=replaceNexusWorldTree(),m1=memory('m1');
  importLegacyMemoryRecordsToWorldTree(tree,{chatId:'chat-a',records:[m1],control:{activeLayers:[['m1']]}});
  markLegacyWorldTreeMigrated({tree,context,memoryBackup:{records:{m1}},characterBackup:{enabled:true,banks:[]}});
  assert.equal(worldTreeBankAuthorityEnabled(context),true);
  const m2={...m1,text:'Updated memory',updatedAt:3};
  const receipt=syncMemoryFacadeToWorldTree({context,records:[m2],control:{activeLayers:[['m1']],lastUpdatedAt:3},reason:'test'});
  assert.equal(receipt.kind,'NexusWorldTreeMemoryWriteOrigin');
  const node=[...getNexusWorldTreeOwner().iterateNodes({chatId:'chat-a',kind:'MEMORY'})].find(row=>row.data?.sourceRecord?.id==='m1');
  assert.equal(node.data.sourceRecord.text,'Updated memory');assert.equal(node.data.canonicalOwner,'WORLD_TREE');assert.equal(node.data.compatibilityMirror,'MEMORY_BANK');
  assert.ok(context.chatMetadata.nexus_world_tree_chat_state_v1);
});

test('post-migration Character compatibility write settles Character State into persisted World Tree authority',()=>{
  const context=ctx(),tree=replaceNexusWorldTree(),b1=bank('c1');
  importLegacyCharacterBanksToWorldTree(tree,{chatId:'chat-a',banks:[b1],control:{enabled:true}});
  markLegacyWorldTreeMigrated({tree,context,memoryBackup:{records:{}},characterBackup:{enabled:true,banks:[b1]}});
  const b2={...b1,state:{...b1.state,persistent:{relationships:'Mara trusts Lili.'}}};
  const receipt=syncCharacterFacadeToWorldTree({context,banks:[b2],control:{enabled:true},reason:'test'});
  assert.equal(receipt.kind,'NexusWorldTreeCharacterWriteOrigin');
  const state=[...getNexusWorldTreeOwner().iterateNodes({chatId:'chat-a',kind:'CHARACTER_STATE'})].find(row=>row.data?.sourceBank?.id==='c1');
  assert.equal(state.data.sourceBank.state.persistent.relationships,'Mara trusts Lili.');assert.equal(state.data.canonicalOwner,'WORLD_TREE');assert.equal(state.data.compatibilityMirror,'CHARACTER_BANK');
  assert.ok(context.chatMetadata.nexus_world_tree_chat_state_v1);
});


test('migration marker makes compatibility drift diagnostic instead of read authority',()=>{
  const source=String.raw`import { getContext } from '../../../../st-context.js';
import { logEvent } from '../observability/telemetry.js';
import { mutateChatMetadataDurably } from '../nexus/host-durability.js';
import { currentNexusChatEpoch } from '../nexus/work-scope.js';
import { getNexusWorldTreeOwner } from '../world-tree/index.js';
import { legacyMemoryControlWorldNodeId } from '../world-tree/import-memory-bank.js';
import { compareMemoryRecordParity } from '../world-tree/memory-read-parity.js';
import { syncMemoryFacadeToWorldTree } from '../world-tree/native-bank-authority.js';
import { legacyWorldTreeMigrationStatus } from '../world-tree/durable-state.js';

const META_KEY = 'tv2_memory_bank';
const STORE_VERSION = 4;
const normalizedStoreIdentities = new WeakSet();
let memoryInspectionCache = null;
let memoryReadAuthorityCache = null;
let memoryReadAuthorityLastSource = null;

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
    return hashText(chat.slice(Math.max(0,start),Math.min(chat.length-1,end)+1).map(m=>\`\${m?.is_user?'u':'a'}:\${m?.mes||''}\`).join('\n'));
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
        evidenceRevision: 1,
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
        id:\`coverage:\${record.id}\`,
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
        const id=\`coverage:\${record.id}\`;
        if(!store.coverageReceipts.some(row=>String(row?.id||'')===id)){store.coverageReceipts.push(coverageReceiptFromRecord(record));changed=true;}
    }
    let covered=effectiveCoverageEnd(store,chat);
    const historical=historicalCoverageEndFromRecords(store,chat);
    const storedPointer=Number.isFinite(Number(store.summarizedUpTo))?Number(store.summarizedUpTo):-1;
    const target=Math.min(chat.length-1,Math.max(storedPointer,historical));
    if(target>covered){
        const start=covered+1,end=target;
        store.coverageReceipts.push(normalizeCoverageReceipt({
            id:\`coverage:legacy:\${start}:\${end}:\${hashText(sourceMessageIdsForRange(chat,start,end).join('|'))}\`,
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
    store.evidenceRevision=Math.max(1,Number(store.evidenceRevision)||1);
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

function ownerMemoryRecords(){
    return Object.values(getMemoryStore().records||{}).map(clone);
}
export function getMemoryOwnerRecords(){return ownerMemoryRecords();}
export function getMemoryOwnerRecord(id){return clone(getMemoryStore().records?.[String(id)]||null);}
function ownerMemoryReadControlSnapshot(){
    const store=getMemoryStore();
    return clone({
        version:Number(store.version)||STORE_VERSION,
        activeLayers:(store.activeLayers||[]).map(ids=>[...(ids||[])].map(String)),
        permanentIds:[...(store.permanentIds||[])].map(String),
        compressedIndices:[...(store.compressedIndices||[])].map(Number).filter(Number.isFinite),
        coverageReceipts:[...(store.coverageReceipts||[])].map(normalizeCoverageReceipt),
        summarizedUpTo:Number.isFinite(Number(store.summarizedUpTo))?Number(store.summarizedUpTo):-1,
        effectiveSummarizedUpTo:getMemoryInspectionIndex().index.effectiveSummarizedUpTo,
        sequence:Math.max(0,Number(store.sequence)||0),
        evidenceRevision:Math.max(1,Number(store.evidenceRevision)||1),
        lastCycleId:store.lastCycleId==null?null:String(store.lastCycleId),
        lastUpdatedAt:Math.max(0,Number(store.lastUpdatedAt)||0),
    });
}
export function getMemoryOwnerReadControlSnapshot(){return ownerMemoryReadControlSnapshot();}
function memoryTreeReadSnapshot(tree,chatId,parity){
    const controlNode=tree.getNode(legacyMemoryControlWorldNodeId(chatId),{chatId});
    const control=controlNode?.data??{};
    const records={},validityById={};
    for(const node of tree.iterateNodes({chatId,kind:'MEMORY'})){
        if(node.scope?.chatId!==String(chatId)||(node.data?.importedFrom!=='legacy-memory-bank'&&node.data?.canonicalOwner!=='WORLD_TREE')||node.data?.sourcePresent===false)continue;
        const record=clone(node.data?.sourceRecord??null);if(!record?.id)continue;
        records[String(record.id)]=record;
        validityById[String(record.id)]=clone(node.data?.sourceValidity??{valid:node.temporal?.status!=='SUPERSEDED',reason:node.temporal?.reason??'world-tree'});
    }
    return {
        version:Number(control.version)||STORE_VERSION,
        summarizedUpTo:Number.isFinite(Number(control.summarizedUpTo))?Number(control.summarizedUpTo):-1,
        effectiveSummarizedUpTo:Number.isFinite(Number(control.effectiveSummarizedUpTo))?Number(control.effectiveSummarizedUpTo):-1,
        records,
        activeLayers:(control.activeLayers??[]).map(ids=>[...(ids??[])].map(String)),
        permanentIds:[...(control.permanentIds??[])].map(String),
        compressedIndices:[...(control.compressedIndices??[])].map(Number).filter(Number.isFinite),
        coverageReceipts:clone(control.coverageReceipts??[]),
        sequence:Math.max(0,Number(control.sequence)||0),
        evidenceRevision:Math.max(1,Number(control.evidenceRevision)||1),
        lastCycleId:control.lastCycleId==null?null:String(control.lastCycleId),
        lastUpdatedAt:Math.max(0,Number(control.lastUpdatedAt)||0),
        validityById,
        authority:'WORLD_TREE',
        parity,
    };
}
function ownerMemoryReadSnapshot(parity=null){
    const store=getMemoryStore(),control=ownerMemoryReadControlSnapshot(),records=clone(store.records||{}),validityById={};
    for(const record of Object.values(store.records||{}))validityById[String(record.id)]=memoryRecordValidity(record,{store,chat:getContext()?.chat||[]});
    return {...clone(control),records,validityById,authority:'OWNER_IMPORT',parity};
}
function memoryReadAuthoritySnapshot(){
    const chatId=currentMemoryStoryId();
    if(!chatId)return ownerMemoryReadSnapshot(null);
    const store=getMemoryStore(),tree=getNexusWorldTreeOwner();
    const key=[chatId,Math.max(1,Number(store.evidenceRevision)||1),Number(store.lastUpdatedAt)||0,tree.revision].join('|');
    if(memoryReadAuthorityCache?.key===key)return memoryReadAuthorityCache.snapshot;
    const records=ownerMemoryRecords().map(record=>({...record,worldTreeValidity:memoryRecordValidity(record,{store,chat:getContext()?.chat||[]})}));
    const control=ownerMemoryReadControlSnapshot();
    const parity=compareMemoryRecordParity(tree,{chatId,records,control});
    const parityAllowsWorldTree=parity.status==='PASS'&&parity.controlMetadata==='PASS';
    const migrated=legacyWorldTreeMigrationStatus({context:getContext()})?.migrated===true;
    const snapshot=(migrated||parityAllowsWorldTree)
        ?memoryTreeReadSnapshot(tree,chatId,parity)
        :ownerMemoryReadSnapshot(parity);
    memoryReadAuthorityCache={key,snapshot};
    if(memoryReadAuthorityLastSource!==snapshot.authority){
        memoryReadAuthorityLastSource=snapshot.authority;
        logEvent('nexus.gather','memory.read-cutover',{
            chatId,authority:snapshot.authority,verdict:parity.status,controlMetadata:parity.controlMetadata,
            readersSwitched:snapshot.authority==='WORLD_TREE',counts:parity.counts,controlMismatches:parity.controlMismatches,
        },snapshot.authority==='WORLD_TREE'?'info':'warn');
    }
    return snapshot;
}
export function getMemoryReadAuthorityStatus(){
    const snapshot=memoryReadAuthoritySnapshot();
    return clone({authority:snapshot.authority,parity:snapshot.parity??null,readersSwitched:snapshot.authority==='WORLD_TREE'});
}
export function getMemoryReadSnapshot(){
    const snapshot=memoryReadAuthoritySnapshot();
    const {validityById,parity,authority,...publicSnapshot}=snapshot;
    return clone({...publicSnapshot,readAuthority:authority});
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
        if(migrated){store.evidenceRevision=Math.max(1,Number(store.evidenceRevision)||1)+1;memoryInspectionCache=null;try{ctx?.saveMetadataDebounced?.();}catch{}logEvent('memory','coverage-ledger-migrated',{summarizedUpTo:store.summarizedUpTo,coverageReceipts:store.coverageReceipts.length,evidenceRevision:store.evidenceRevision},'info');}
    }
    return store;
}

export function syncMemoryFacadeToWorldTreeNow(reason='memory-facade-write'){
    const context=getContext(),store=getMemoryStore();
    try{return syncMemoryFacadeToWorldTree({context,records:Object.values(store.records||{}).map(clone),control:ownerMemoryReadControlSnapshot(),reason});}
    catch(error){logEvent('world-tree','memory-write-origin-failed',{reason,error:error?.message||String(error)},'error');throw error;}
}
export function saveMemoryStore({notify=true,debounce=true,affectsInspection=true}={}){
    const store=getMemoryStore();
    store.lastUpdatedAt=now();
    if(affectsInspection){
        store.evidenceRevision=Math.max(1,Number(store.evidenceRevision)||1)+1;
        memoryInspectionCache=null;
    }
    if(debounce)try{getContext()?.saveMetadataDebounced?.();}catch{}
    syncMemoryFacadeToWorldTreeNow('memory-store-save');
    if(notify)try{globalThis.window?.dispatchEvent?.(new CustomEvent('tv2-memory-bank-updated'));}catch{}
    return store;
}
export function currentMemoryBankRevision(){
    const store=getMemoryStore();
    return \`m:\${Math.max(1,Number(store.evidenceRevision)||1)}|e:\${currentNexusChatEpoch()}\`;
}
function notifyMemoryStore(){try{globalThis.window?.dispatchEvent?.(new CustomEvent('tv2-memory-bank-updated'));}catch{}}

function nextIdForStore(store,prefix='mem'){
    store.sequence=(Number(store.sequence)||0)+1;
    return \`tv2_\${prefix}_\${now()}_\${store.sequence}\`;
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

export function getMemoryRecord(id){return clone(memoryReadAuthoritySnapshot().records?.[String(id)]||null);}

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

export function getPermanentMemoryRecords(){const s=memoryReadAuthoritySnapshot();return (s.permanentIds||[]).map(id=>s.records?.[String(id)]).filter(r=>r&&s.validityById?.[String(r.id)]?.valid===true).map(clone);}
function setMemoryPermanentLocal(id,permanent=true){const s=getMemoryStore();const record=s.records?.[String(id)];if(!record)return null;const ids=new Set((s.permanentIds||[]).map(String));if(permanent)ids.add(record.id);else ids.delete(record.id);s.permanentIds=[...ids];record.permanent=permanent===true;record.updatedAt=now();saveMemoryStore({notify:false});return clone(record);}
export async function setMemoryPermanent(id,permanent=true){const context=getContext();const record=await mutateChatMetadataDurably(context,'Memory permanent state',{keys:[META_KEY]},()=>setMemoryPermanentLocal(id,permanent));if(record){notifyMemoryStore();logEvent('memory',permanent?'permanent-saved':'permanent-removed',{id:record.id,layer:record.layer,turnRange:record.turnRange,durable:true},'info');}return record;}
export async function toggleMemoryPermanent(id){const record=getMemoryStore().records?.[String(id)];return record?await setMemoryPermanent(id,record.permanent!==true):null;}
function setMemoryPermanentProtectedLocal(id,permanent=true){const s=getMemoryStore(),record=s.records?.[String(id)];if(!record)return null;const keep=permanent===true,ids=new Set((s.permanentIds||[]).map(String));if(keep)ids.add(record.id);else ids.delete(record.id);s.permanentIds=[...ids];record.permanent=keep;record.locked=keep;record.updatedAt=now();saveMemoryStore({notify:false});return clone(record);}
export async function setMemoryPermanentProtected(id,permanent=true){const context=getContext();const record=await mutateChatMetadataDurably(context,'Memory permanent protection',{keys:[META_KEY]},()=>setMemoryPermanentProtectedLocal(id,permanent));if(record){notifyMemoryStore();logEvent('memory',record.permanent?'permanent-protected':'permanent-unprotected',{id:record.id,layer:record.layer,durable:true},'info');}return record;}
export async function toggleMemoryPermanentProtected(id){const record=getMemoryStore().records?.[String(id)];return record?await setMemoryPermanentProtected(id,record.permanent!==true):null;}
function deleteMemoryRecordLocal(id,{preserveCoverage=false}={}){
    const store=getMemoryStore();id=String(id||'');const record=store.records?.[id];if(!record)return null;
    for(const layer of store.activeLayers||[]){if(!Array.isArray(layer))continue;for(let i=layer.length-1;i>=0;i--)if(String(layer[i])===id)layer.splice(i,1);}
    store.permanentIds=(store.permanentIds||[]).map(String).filter(value=>value!==id);
    for(const row of Object.values(store.records||{})){if(!row||String(row.id)===id)continue;if(Array.isArray(row.childIds))row.childIds=row.childIds.map(String).filter(value=>value!==id);if(String(row.parentId||'')===id)row.parentId=null;if(String(row.promotedTo||'')===id)row.promotedTo=null;}
    if(record.layer===0&&preserveCoverage!==true){const coverageId=\`coverage:\${id}\`;store.coverageReceipts=(store.coverageReceipts||[]).filter(receipt=>String(receipt?.sourceMemoryId||'')!==id&&String(receipt?.id||'')!==coverageId);}
    delete store.records[id];
    store.summarizedUpTo=effectiveCoverageEnd(store,getContext()?.chat||[]);
    saveMemoryStore({notify:false});return clone(record);
}
export async function deleteMemoryRecord(id,{reason='operator',preserveCoverage=false}={}){const context=getContext();const record=await mutateChatMetadataDurably(context,'Memory record delete',{keys:[META_KEY]},()=>deleteMemoryRecordLocal(id,{preserveCoverage}));if(record){notifyMemoryStore();logEvent('memory','record-deleted',{id:record.id,layer:record.layer,reason:String(reason||'operator'),preserveCoverage:preserveCoverage===true,summarizedUpTo:getMemoryStore().summarizedUpTo,durable:true},'info');}return record;}
function restoreMemoryCoverageFromRecordLocal(record,{source='digested-summary-coverage'}={}){
    const store=getMemoryStore();
    const normalized=normalizeRecord(record||{});
    if(!normalized.id||normalized.layer!==0||!normalized.turnRange)return {restored:false,reason:'not-layer0-summary',recordId:normalized.id||null};
    const receipt=coverageReceiptFromRecord(normalized);
    if(!receipt)return {restored:false,reason:'missing-coverage-evidence',recordId:normalized.id};
    receipt.source=String(source||'digested-summary-coverage');
    const chat=getContext()?.chat||[];
    const validity=coverageReceiptValidity(receipt,chat);
    if(!validity.valid)return {restored:false,reason:validity.reason,recordId:normalized.id,turnRange:normalized.turnRange};
    const before=effectiveCoverageEnd(store,chat);
    if(!Array.isArray(store.coverageReceipts))store.coverageReceipts=[];
    const index=store.coverageReceipts.findIndex(row=>String(row?.id||'')===receipt.id);
    const prior=index>=0?store.coverageReceipts[index]:null;
    const unchanged=prior&&JSON.stringify(prior)===JSON.stringify(receipt);
    if(index>=0)store.coverageReceipts[index]=receipt;else store.coverageReceipts.push(receipt);
    store.summarizedUpTo=effectiveCoverageEnd(store,chat);
    if(!unchanged)saveMemoryStore({notify:false});
    return {restored:!unchanged,reason:unchanged?'already-covered':'coverage-restored',recordId:normalized.id,turnRange:normalized.turnRange,before,after:store.summarizedUpTo,receipt:clone(receipt)};
}
export async function restoreMemoryCoverageFromRecord(record,{source='digested-summary-coverage'}={}){
    const context=getContext();
    const result=await mutateChatMetadataDurably(context,'Memory coverage restore',{keys:[META_KEY]},()=>restoreMemoryCoverageFromRecordLocal(record,{source}));
    if(result?.restored){notifyMemoryStore();logEvent('memory','coverage-restored',{recordId:result.recordId,turnRange:result.turnRange,before:result.before,after:result.after,source,durable:true},'warn');}
    return result;
}
function setMemoryLockedLocal(id,locked=true){const s=getMemoryStore(),record=s.records?.[String(id)];if(!record)return null;record.locked=locked===true;record.updatedAt=now();saveMemoryStore({notify:false});return clone(record);}
export async function setMemoryLocked(id,locked=true){const context=getContext();const record=await mutateChatMetadataDurably(context,'Memory lock state',{keys:[META_KEY]},()=>setMemoryLockedLocal(id,locked));if(record){notifyMemoryStore();logEvent('memory',record.locked?'locked':'unlocked',{id:record.id,layer:record.layer,durable:true},'info');}return record;}
export async function toggleMemoryLocked(id){const record=getMemoryStore().records?.[String(id)];return record?await setMemoryLocked(id,record.locked!==true):null;}
export function reviseMemoryRecordLocal(id,patch={},reason='regenerated',{expectedVersion=null}={}){
    const s=getMemoryStore(),record=s.records?.[String(id)];if(!record)throw new Error(\`Memory \${id} was not found.\`);if(record.locked)throw new Error('Unlock this memory before regenerating it.');
    if(expectedVersion!=null&&memoryRecordVersion(record)!==String(expectedVersion)){const error=new Error(\`Memory \${id} changed while regeneration was in flight.\`);error.name='TV2MemoryRegenerationStale';throw error;}
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

function buildMemoryInspectionIndex(store,chat){
    const records=Object.values(store.records||{});
    const memo=new Map(),validityById=new Map(),invalid=[];
    let maxReferencedEnd=-1;
    for(const record of records){
        const validity=memoryValidityInternal(record,store,chat,memo,new Set());
        validityById.set(String(record.id),validity);
        if(!validity.valid)invalid.push({id:record.id,layer:record.layer,turnRange:record.turnRange,...validity});
        if(Array.isArray(record.turnRange)&&Number.isFinite(Number(record.turnRange[1])))maxReferencedEnd=Math.max(maxReferencedEnd,Number(record.turnRange[1]));
    }

    const coverageValidityById=new Map();
    const coverageRows=(store.coverageReceipts||[]).filter(receipt=>receipt?.turnRange).slice().sort((a,b)=>a.turnRange[0]-b.turnRange[0]||a.turnRange[1]-b.turnRange[1]);
    for(const receipt of coverageRows){
        const validity=coverageReceiptValidity(receipt,chat);
        coverageValidityById.set(String(receipt.id||''),validity);
        if(Number.isFinite(Number(receipt.turnRange?.[1])))maxReferencedEnd=Math.max(maxReferencedEnd,Number(receipt.turnRange[1]));
    }
    let effectiveSummarizedUpTo=-1;
    for(const receipt of coverageRows){
        const validity=coverageValidityById.get(String(receipt.id||''));
        if(!validity?.valid)continue;
        const [start,end]=receipt.turnRange;
        if(start>effectiveSummarizedUpTo+1)break;
        if(start<=effectiveSummarizedUpTo+1)effectiveSummarizedUpTo=Math.max(effectiveSummarizedUpTo,end);
    }

    const issues=[];
    const base=records.filter(record=>record.layer===0&&record.turnRange).sort((a,b)=>a.turnRange[0]-b.turnRange[0]||a.turnRange[1]-b.turnRange[1]);
    let priorEnd=-1;
    for(const record of base){
        const [start,end]=record.turnRange;
        if(!Number.isFinite(start)||!Number.isFinite(end)||start<0||end<start||end>=chat.length)issues.push({kind:'invalid-range',memoryId:record.id,detail:\`Invalid message range \${start}–\${end}.\`});
        if(priorEnd<0&&start>0)issues.push({kind:'gap',memoryId:record.id,range:[0,start-1],detail:\`Unsummarized gap before the first record (messages 0–\${start-1}).\`});
        else if(start<=priorEnd)issues.push({kind:'overlap',memoryId:record.id,detail:\`Message range \${start}–\${end} overlaps a previous summary.\`});
        else if(priorEnd>=0&&start>priorEnd+1)issues.push({kind:'gap',memoryId:record.id,range:[priorEnd+1,start-1],detail:\`Unsummarized gap between messages \${priorEnd+1} and \${start-1}.\`});
        priorEnd=Math.max(priorEnd,end);
    }
    for(const row of invalid)issues.push({kind:'stale-source',memoryId:row.id,detail:\`Memory source is stale (\${row.reason}).\`});
    for(const record of records){
        for(const childId of record.childIds||[])if(!store.records?.[childId])issues.push({kind:'missing-child',memoryId:record.id,detail:\`Missing child memory \${childId}.\`});
        if(record.parentId&&!store.records?.[record.parentId])issues.push({kind:'missing-parent',memoryId:record.id,detail:\`Missing parent memory \${record.parentId}.\`});
        if(['failed','partial'].includes(record.routeState))issues.push({kind:'routing',memoryId:record.id,detail:\`Lore review is \${record.routeState}.\`});
        if(!String(record.text||'').trim())issues.push({kind:'empty',memoryId:record.id,detail:'Memory text is empty.'});
    }
    for(const receipt of coverageRows){
        const validity=coverageValidityById.get(String(receipt.id||''));
        if(!validity?.valid)issues.push({kind:'stale-coverage',coverageId:receipt.id,detail:\`Summary coverage source is stale (\${validity?.reason||'invalid'}).\`});
    }
    if(effectiveSummarizedUpTo!==store.summarizedUpTo)issues.push({kind:'pointer',detail:\`Stored summary pointer is \${store.summarizedUpTo}; current valid contiguous source ends at \${effectiveSummarizedUpTo}.\`});

    const layerCounts=(store.activeLayers||[]).map(ids=>(ids||[]).length);
    const stats={
        summarizedUpTo:store.summarizedUpTo,
        effectiveSummarizedUpTo,
        staleRecords:invalid.length,
        records:records.length,
        active:layerCounts.reduce((a,b)=>a+b,0),
        digested:records.filter(record=>!!record.promotedTo).length,
        layers:layerCounts.length,
        layerCounts,
        compressedCount:(store.compressedIndices||[]).length,
        coverageReceipts:(store.coverageReceipts||[]).length,
        unrouted:records.filter(record=>record.routeState==='unrouted'&&!record.promotedTo).length,
        permanent:(store.permanentIds||[]).length,
        locked:records.filter(record=>record.locked===true).length,
    };
    return {
        storyId:currentMemoryStoryId(),
        evidenceRevision:Math.max(1,Number(store.evidenceRevision)||1),
        structureEpoch:currentNexusChatEpoch(),
        chatLength:chat.length,
        maxReferencedEnd,
        validityById,
        validityReport:{valid:invalid.length===0,invalid},
        effectiveSummarizedUpTo,
        stats,
        issues,
    };
}
function memoryInspectionCanReuse(index,store,chat){
    if(!index)return false;
    if(index.storyId!==currentMemoryStoryId())return false;
    if(index.evidenceRevision!==Math.max(1,Number(store.evidenceRevision)||1))return false;
    if(index.structureEpoch!==currentNexusChatEpoch())return false;
    if(index.chatLength===chat.length)return true;
    // Plain append cannot alter any already-referenced Memory source range.
    // Reuse remains legal only when every referenced range ended inside the
    // previously inspected prefix; structural edits advance the chat epoch.
    return chat.length>index.chatLength&&index.maxReferencedEnd<index.chatLength;
}
function getMemoryInspectionIndex(){
    const store=getMemoryStore(),chat=getContext()?.chat||[];
    if(memoryInspectionCanReuse(memoryInspectionCache,store,chat)){
        memoryInspectionCache.chatLength=chat.length;
        return {index:memoryInspectionCache,reused:true};
    }
    memoryInspectionCache=buildMemoryInspectionIndex(store,chat);
    return {index:memoryInspectionCache,reused:false};
}

export function memoryRecordValidity(record,{store=getMemoryStore(),chat=getContext()?.chat||[]}={}){return clone(memoryValidityInternal(record,store,chat,new Map(),new Set()));}
export function isMemoryRecordValidForCurrentChat(record){
    const store=getMemoryStore();
    if(record?.id&&store.records?.[String(record.id)]===record){
        const {index}=getMemoryInspectionIndex();
        return index.validityById.get(String(record.id))?.valid===true;
    }
    return memoryRecordValidity(record,{store,chat:getContext()?.chat||[]}).valid===true;
}
export function getMemoryValidityReport(){
    const s=memoryReadAuthoritySnapshot();
    const invalid=Object.entries(s.validityById??{}).filter(([,value])=>value?.valid!==true).map(([id,value])=>({id,...clone(value)}));
    return clone({valid:invalid.length===0,invalid});
}
export function getEffectiveSummarizedUpTo(){return memoryReadAuthoritySnapshot().effectiveSummarizedUpTo;}

export function getAllMemoryRecords(){return Object.values(memoryReadAuthoritySnapshot().records||{}).map(clone);}
export function getMemoryReadControlSnapshot(){
    const s=memoryReadAuthoritySnapshot();
    return clone({
        version:s.version,activeLayers:s.activeLayers,permanentIds:s.permanentIds,compressedIndices:s.compressedIndices,
        coverageReceipts:s.coverageReceipts,summarizedUpTo:s.summarizedUpTo,effectiveSummarizedUpTo:s.effectiveSummarizedUpTo,
        sequence:s.sequence,evidenceRevision:s.evidenceRevision,lastCycleId:s.lastCycleId,lastUpdatedAt:s.lastUpdatedAt,
        readAuthority:s.authority,
    });
}
export function getActiveLayerIds(layer){return [...(memoryReadAuthoritySnapshot().activeLayers?.[Number(layer)]||[])];}
export function getActiveLayerRecords(layer){
    const s=memoryReadAuthoritySnapshot();
    return getActiveLayerIds(layer).map(id=>s.records?.[String(id)]).filter(r=>r&&s.validityById?.[String(r.id)]?.valid===true).map(clone);
}
export function getActiveMemories(){
    const s=memoryReadAuthoritySnapshot();
    return (s.activeLayers||[]).flatMap((ids,layer)=>(ids||[]).map(id=>s.records?.[String(id)]).filter(r=>r&&s.validityById?.[String(r.id)]?.valid===true).map(r=>clone({...r,layer})));
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
        const error=new Error(\`Memory \${id} changed before lifecycle route assessment could settle.\`);
        error.name='TV2MemoryRouteAssessmentStale';
        error.code='MEMORY_ROUTE_ASSESSMENT_STALE';
        throw error;
    }
    // This receipt is non-semantic routing metadata. Do not change updatedAt:
    // memoryRecordVersion intentionally represents the Summary source, and the
    // assessment must not invalidate its own exact source/comparison fingerprint.
    record.routeEvaluation=assessment?normalizeRouteEvaluation(assessment):null;
    saveMemoryStore({notify:false,affectsInspection:false});
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

export function setLastCycleId(cycleId){const s=getMemoryStore();s.lastCycleId=cycleId?String(cycleId):null;saveMemoryStore({affectsInspection:false});}

export function memoryStats(){return clone(getMemoryInspectionIndex().index.stats);}

export function scanMemoryBank(){
    // Inspection is intentionally read-only. Repair is a distinct mutation
    // surface and must never run implicitly from Housekeeper/manual scan.
    const chat=getContext()?.chat||[];
    const {index,reused}=getMemoryInspectionIndex();
    const stats=clone(index.stats),issues=clone(index.issues);
    logEvent('memory','bank-scan-complete',{
        issueCount:issues.length,
        records:stats.records,
        active:stats.active,
        unrouted:stats.unrouted,
        indexReused:reused,
        evidenceRevision:index.evidenceRevision,
        structureEpoch:index.structureEpoch,
    },issues.length?'warn':'info');
    return {ok:issues.length===0,scannedAt:Date.now(),chatMessages:chat.length,stats,issues,indexReused:reused,evidenceRevision:index.evidenceRevision};
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
`;
  assert.ok(source.includes("const migrated=legacyWorldTreeMigrationStatus({context:getContext()})?.migrated===true"));
  assert.ok(source.includes("const snapshot=(migrated||parityAllowsWorldTree)"));
  const characterSource=String.raw`import { characterPresentInText } from './character-match.js';
import { getContext } from '../../../../st-context.js';
import { getSettings, updateSettings, updateAuthoritySettingsDurably } from '../core/settings.js';
import { getActiveBooks, isBookInCurrentStory } from '../lore/active-books.js';
import { canReadBook, isBookEnabled, isTv2InjectionBook } from '../lore/policy.js';
import { buildTreeEntryIndex, searchTree } from '../retrieval/search-engine.js';
import { getTree } from '../tree/store.js';
import { resolveCurrentTreeRef } from '../tree/ref-resolver.js';
import { logEvent } from '../observability/telemetry.js';
import { getAllMemoryRecords } from './store.js';
import { getNexusWorldTreeOwner } from '../world-tree/index.js';
import { legacyCharacterControlWorldNodeId } from '../world-tree/import-character-banks.js';
import { compareCharacterBankParity } from '../world-tree/character-read-parity.js';
import { syncCharacterFacadeToWorldTree } from '../world-tree/native-bank-authority.js';
import { legacyWorldTreeMigrationStatus } from '../world-tree/durable-state.js';
import {
    normalizeCharacterState,
    characterStateToLegacyProfile,
    normalizeCharacterStateProposals,
    normalizeCharacterChangeHistory,
    normalizeCharacterFieldProvenance,
    normalizeCharacterCardSync,
} from './character-state-contract.js';

const ROLES = new Set(['lead', 'supporting', 'background']);
const DEFAULT_TRACKING = Object.freeze({
    personality: true,
    relationships: true,
    status: true,
    goals: true,
    behavior: true,
});
let characterReadAuthorityCache=null;
let characterReadAuthorityLastSource=null;

function clone(value){ return value == null ? value : JSON.parse(JSON.stringify(value)); }
function uid(){ return \`tv2_charbank_\${Date.now()}_\${Math.random().toString(36).slice(2,8)}\`; }
function cleanText(value){ return String(value ?? '').replace(/\s+/g, ' ').trim(); }
const LEGACY_CHARACTER_BANK_STORY = '__unassigned__';
export function currentCharacterBankStoryId(context = getContext()){
    const id = cleanText(context?.chatId ?? context?.chat_id);
    return id || null;
}
function normalizeCharacterBankStoryId(value){ return cleanText(value) || LEGACY_CHARACTER_BANK_STORY; }
function characterBankBelongsToCurrentStory(bank, context = getContext()){
    const storyId = currentCharacterBankStoryId(context);
    return !!storyId && normalizeCharacterBankStoryId(bank?.storyId) === storyId;
}
function escRe(value){ return String(value).replace(/[.*+?^\${}()|[\]\\]/g, '\\$&'); }
function normalizeCardBinding(raw = null){
    if (!raw || typeof raw !== 'object') return null;
    const avatar = cleanText(raw.avatar);
    if (!avatar) return null;
    return {
        source: cleanText(raw.source) || 'sillytavern',
        avatar,
        name: cleanText(raw.name),
        fingerprint: cleanText(raw.fingerprint),
        boundAt: Number(raw.boundAt) || 0,
        lastScannedAt: Number(raw.lastScannedAt) || Number(raw.boundAt) || 0,
    };
}

export function normalizeCharacterBank(raw = {}){
    const role = ROLES.has(String(raw.role)) ? String(raw.role) : 'supporting';
    const state = normalizeCharacterState(raw.state || raw.characterState || {}, raw.profile || {});
    const profile = characterStateToLegacyProfile(state);
    const refs = Array.isArray(raw.linkedRefs) ? raw.linkedRefs : [];
    const seen = new Set();
    const linkedRefs = [];
    for (const ref of refs) {
        const book = cleanText(ref?.book);
        const n = Number(ref?.uid);
        if (!book || !Number.isFinite(n)) continue;
        const key = JSON.stringify([book,n]);
        if (seen.has(key)) continue;
        seen.add(key);
        linkedRefs.push({
            book,
            uid: n,
            title: cleanText(ref?.title),
            nodeId: ref?.nodeId ? String(ref.nodeId) : null,
            nodeLabel: cleanText(ref?.nodeLabel),
            path: Array.isArray(ref?.path) ? ref.path.map(String) : [],
        });
    }
    return {
        id: cleanText(raw.id) || uid(),
        storyId: normalizeCharacterBankStoryId(raw.storyId),
        enabled: raw.enabled !== false,
        character: cleanText(raw.character),
        role,
        sceneAware: raw.sceneAware !== false,
        cardBinding: normalizeCardBinding(raw.cardBinding),
        linkedRefs,
        memoryIds: [...new Set((Array.isArray(raw.memoryIds) ? raw.memoryIds : []).map(String).filter(Boolean))],
        memoryRefs: [...new Map((Array.isArray(raw.memoryRefs) ? raw.memoryRefs : []).map(ref => {
            const chatId = cleanText(ref?.chatId);
            const id = cleanText(ref?.id || ref?.memoryId);
            return chatId && id ? [\`\${chatId}|\${id}\`, { chatId, id }] : null;
        }).filter(Boolean)).values()],
        // \`profile\` remains as a compatibility projection for the existing
        // Summary focus/runtime surfaces. Character State v1 is authoritative.
        profile,
        state,
        stateProposals: normalizeCharacterStateProposals(raw.stateProposals || raw.characterStateProposals || []),
        changeHistory: normalizeCharacterChangeHistory(raw.changeHistory || raw.characterChangeHistory || []),
        fieldProvenance: normalizeCharacterFieldProvenance(raw.fieldProvenance || {}),
        cardSync: normalizeCharacterCardSync(raw.cardSync || {}),
        tracking: {
            personality: raw.tracking?.personality !== false,
            relationships: raw.tracking?.relationships !== false,
            status: raw.tracking?.status !== false,
            goals: raw.tracking?.goals !== false,
            behavior: raw.tracking?.behavior !== false,
        },
    };
}


function dedupeCharacterBankIds(banks = []){
    const used=new Set();
    return (Array.isArray(banks)?banks:[]).map((raw,index)=>{
        const bank=normalizeCharacterBank(raw);
        const base=cleanText(bank.id)||\`tv2_charbank_\${index+1}\`;
        let candidate=base,suffix=2;
        while(used.has(candidate))candidate=\`\${base}__\${suffix++}\`;
        used.add(candidate);bank.id=candidate;return bank;
    });
}

function normalizeAll(){
    const s = getSettings();
    s.memoryBank = s.memoryBank || {};
    s.memoryBank.characterBanks = s.memoryBank.characterBanks || { enabled: true, banks: [] };
    if (!Array.isArray(s.memoryBank.characterBanks.banks)) s.memoryBank.characterBanks.banks = [];
    s.memoryBank.characterBanks.banks = dedupeCharacterBankIds(s.memoryBank.characterBanks.banks);
    if (s.memoryBank.characterBanks.enabled === undefined) s.memoryBank.characterBanks.enabled = true;
    return s.memoryBank.characterBanks;
}

function ownerCharacterBanks({allStories=false,includeLegacy=false}={}){
    const banks=normalizeAll().banks;
    if(allStories)return clone(banks);
    const storyId=currentCharacterBankStoryId();if(!storyId)return[];
    return clone(banks.filter(bank=>characterBankBelongsToCurrentStory(bank)||(includeLegacy&&bank.storyId===LEGACY_CHARACTER_BANK_STORY)));
}
export function getCharacterOwnerBanks(options={}){return ownerCharacterBanks(options);}
export function getCharacterOwnerControlSnapshot(){return clone({enabled:normalizeAll().enabled!==false});}
function characterTreeReadSnapshot(tree,storyId,parity){
    const control=tree.getNode(legacyCharacterControlWorldNodeId(storyId),{chatId:storyId});
    const rows=[];
    for(const node of tree.iterateNodes({chatId:storyId,kind:'CHARACTER_STATE'})){
        if(node.scope?.chatId!==String(storyId)||(node.data?.importedFrom!=='legacy-character-bank'&&node.data?.canonicalOwner!=='WORLD_TREE')||node.data?.sourcePresent===false)continue;
        const bank=clone(node.data?.sourceBank??null);if(!bank?.id)continue;
        rows.push({order:Math.max(0,Number(node.data?.sourceOrder)||0),bank});
    }
    rows.sort((a,b)=>a.order-b.order||String(a.bank.id).localeCompare(String(b.bank.id)));
    return{banks:rows.map(row=>row.bank),enabled:control?.data?.enabled!==false,authority:'WORLD_TREE',parity};
}
function ownerCharacterReadSnapshot(parity=null){return{banks:ownerCharacterBanks(),enabled:normalizeAll().enabled!==false,authority:'OWNER_IMPORT',parity};}
function characterReadAuthoritySnapshot(){
    const storyId=currentCharacterBankStoryId();if(!storyId)return ownerCharacterReadSnapshot(null);
    const tree=getNexusWorldTreeOwner(),banks=ownerCharacterBanks(),control=getCharacterOwnerControlSnapshot();
    const key=storyId+'|'+tree.revision+'|'+JSON.stringify({control,banks});
    if(characterReadAuthorityCache?.key===key)return characterReadAuthorityCache.snapshot;
    const parity=compareCharacterBankParity(tree,{chatId:storyId,banks,control});
    const parityAllowsWorldTree=parity.status==='PASS'&&parity.controlMetadata==='PASS';
    const migrated=legacyWorldTreeMigrationStatus({context:getContext()})?.migrated===true;
    const snapshot=(migrated||parityAllowsWorldTree)?characterTreeReadSnapshot(tree,storyId,parity):ownerCharacterReadSnapshot(parity);
    characterReadAuthorityCache={key,snapshot};
    if(characterReadAuthorityLastSource!==snapshot.authority){
        characterReadAuthorityLastSource=snapshot.authority;
        logEvent('nexus.gather','character.read-cutover',{
            chatId:storyId,authority:snapshot.authority,verdict:parity.status,controlMetadata:parity.controlMetadata,
            readersSwitched:snapshot.authority==='WORLD_TREE',counts:parity.counts,
        },snapshot.authority==='WORLD_TREE'?'info':'warn');
    }
    return snapshot;
}
export function getCharacterReadAuthorityStatus(){const s=characterReadAuthoritySnapshot();return clone({authority:s.authority,parity:s.parity??null,readersSwitched:s.authority==='WORLD_TREE'});}
export function getCharacterReadControlSnapshot(){const s=characterReadAuthoritySnapshot();return clone({enabled:s.enabled,readAuthority:s.authority});}
export function getCharacterBanks({ allStories = false, includeLegacy = false } = {}){
    if(allStories||includeLegacy)return ownerCharacterBanks({allStories,includeLegacy});
    return clone(characterReadAuthoritySnapshot().banks);
}
export function getCharacterBank(id){ return getCharacterBanks().find(bank => bank.id === String(id)) || null; }
export function getLegacyCharacterBanks(){ return clone(normalizeAll().banks.filter(bank => bank.storyId === LEGACY_CHARACTER_BANK_STORY)); }

export function findCharacterBankByCardAvatar(avatar){
    const wanted = cleanText(avatar);
    if (!wanted) return null;
    return getCharacterBanks().find(bank => cleanText(bank.cardBinding?.avatar) === wanted) || null;
}

export function characterBankCardStatus(bankOrId){
    const bank = typeof bankOrId === 'string' ? getCharacterBank(bankOrId) : normalizeCharacterBank(bankOrId || {});
    const binding = bank?.cardBinding;
    if (!binding?.avatar) return { state:'none', bound:false, installed:false, active:false, binding:null };
    const ctx = getContext?.();
    const characters = Array.isArray(ctx?.characters) ? ctx.characters : [];
    const installed = characters.some(character => cleanText(character?.avatar || character?.data?.avatar) === binding.avatar);
    const activeCharacter = Number.isInteger(Number(ctx?.characterId)) && Number(ctx.characterId) >= 0 ? characters[Number(ctx.characterId)] : null;
    const activeAvatar = cleanText(activeCharacter?.avatar || activeCharacter?.data?.avatar);
    const active = installed && activeAvatar === binding.avatar;
    return { state:installed?'bound':'unbound', bound:true, installed, active, binding:clone(binding) };
}

export function bindCharacterBankCard(bankId, binding){
    const bank = getCharacterBank(bankId);
    if (!bank) throw new Error('Character Bank not found.');
    const normalized = normalizeCardBinding(binding);
    if (!normalized) throw new Error('A stable SillyTavern character-card avatar identity is required.');
    const collision = getCharacterBanks().find(other => other.id !== bank.id && cleanText(other.cardBinding?.avatar) === normalized.avatar);
    if (collision) throw new Error(\`This SillyTavern card is already bound to Character Bank "\${collision.character || collision.id}".\`);
    const updated = updateCharacterBank(bankId,{cardBinding:normalized});
    if (updated) logEvent('character-memory','card-bound',{
        bankId:updated.id,
        character:updated.character || normalized.name,
        cardName:normalized.name,
        avatar:normalized.avatar,
        fingerprint:normalized.fingerprint || null,
        linkedCount:updated.linkedRefs?.length || 0,
    },'info');
    return updated;
}

export function addCharacterBank(seed = {}){
    const storyId = cleanText(seed?.storyId) || currentCharacterBankStoryId();
    if (!storyId) {
        const error = new Error('Select a chat before creating a Character Bank.');
        error.name = 'TV2CharacterBankScopeUnavailable';
        throw error;
    }
    const bank = normalizeCharacterBank({ ...seed, storyId });
    updateSettings(s => {
        s.memoryBank = s.memoryBank || {};
        s.memoryBank.characterBanks = s.memoryBank.characterBanks || { enabled: true, banks: [] };
        s.memoryBank.characterBanks.banks = Array.isArray(s.memoryBank.characterBanks.banks) ? s.memoryBank.characterBanks.banks : [];
        s.memoryBank.characterBanks.banks.push(bank);
    });
    notify();
    logEvent('character-memory','bank-created',{id:bank.id,storyId:bank.storyId,character:bank.character,role:bank.role},'info');
    if (bank.cardBinding?.avatar) logEvent('character-memory','card-bound',{
        bankId:bank.id,
        character:bank.character || bank.cardBinding.name,
        cardName:bank.cardBinding.name,
        avatar:bank.cardBinding.avatar,
        fingerprint:bank.cardBinding.fingerprint || null,
        linkedCount:bank.linkedRefs?.length || 0,
    },'info');
    return clone(bank);
}


function applyCharacterBankPatchToList(list, id, patch = {}, storyId = currentCharacterBankStoryId()) {
    const index = list.findIndex(bank => String(bank?.id) === String(id) && normalizeCharacterBankStoryId(bank?.storyId) === storyId);
    if (index < 0) return null;
    const base = normalizeCharacterBank(list[index]);
    let statePatch = patch.state === undefined && patch.characterState === undefined ? base.state : (patch.state || patch.characterState);
    if (patch.profile && patch.state === undefined && patch.characterState === undefined) {
        statePatch = normalizeCharacterState({
            ...base.state,
            baseline: {
                ...base.state?.baseline,
                ...(Object.prototype.hasOwnProperty.call(patch.profile, 'personality') ? { personality: patch.profile.personality } : {}),
                ...(Object.prototype.hasOwnProperty.call(patch.profile, 'appearance') ? { appearance: patch.profile.appearance } : {}),
                ...(Object.prototype.hasOwnProperty.call(patch.profile, 'clothingArmor') ? { clothingGear: patch.profile.clothingArmor } : {}),
            },
        }, patch.profile);
    }
    const merged = {
        ...base,
        ...patch,
        tracking: { ...base.tracking, ...(patch.tracking || {}) },
        profile: { ...base.profile, ...(patch.profile || {}) },
        state: statePatch,
        stateProposals: patch.stateProposals === undefined ? base.stateProposals : patch.stateProposals,
        changeHistory: patch.changeHistory === undefined ? base.changeHistory : patch.changeHistory,
        fieldProvenance: patch.fieldProvenance === undefined ? base.fieldProvenance : patch.fieldProvenance,
        cardSync: patch.cardSync === undefined ? base.cardSync : { ...base.cardSync, ...(patch.cardSync || {}) },
        linkedRefs: patch.linkedRefs === undefined ? base.linkedRefs : patch.linkedRefs,
        memoryIds: patch.memoryIds === undefined ? base.memoryIds : patch.memoryIds,
        memoryRefs: patch.memoryRefs === undefined ? base.memoryRefs : patch.memoryRefs,
    };
    const updated = normalizeCharacterBank(merged);
    list[index] = updated;
    return updated;
}

export function updateCharacterBank(id, patch = {}){
    let updated = null;
    updateSettings(s => {
        s.memoryBank = s.memoryBank || {};
        s.memoryBank.characterBanks = s.memoryBank.characterBanks || { enabled: true, banks: [] };
        const list = Array.isArray(s.memoryBank.characterBanks.banks) ? s.memoryBank.characterBanks.banks : [];
        updated = applyCharacterBankPatchToList(list, id, patch, currentCharacterBankStoryId());
        s.memoryBank.characterBanks.banks = list;
    });
    if (updated) {
        notify();
        logEvent('character-memory','bank-updated',{id:updated.id,storyId:updated.storyId,character:updated.character,role:updated.role,enabled:updated.enabled,linkedCount:updated.linkedRefs.length},'debug');
    }
    return clone(updated);
}

/**
 * Authority-bearing Character Bank persistence. Model-produced Character State
 * changes and Character Card reconciliation use this awaited path so the live
 * settings object is not treated as durable merely because it was mutated.
 */
export async function updateCharacterBankDurably(id, patch = {}, { label = 'Character Bank state' } = {}) {
    const storyId = currentCharacterBankStoryId();
    if (!storyId) throw new Error('Select a chat before mutating Character State.');
    let updated = null;
    await updateAuthoritySettingsDurably(label, [['memoryBank','characterBanks','banks']], settings => {
        settings.memoryBank = settings.memoryBank || {};
        settings.memoryBank.characterBanks = settings.memoryBank.characterBanks || { enabled: true, banks: [] };
        const list = Array.isArray(settings.memoryBank.characterBanks.banks) ? settings.memoryBank.characterBanks.banks : [];
        updated = applyCharacterBankPatchToList(list, id, patch, storyId);
        if (!updated) throw new Error('Character Bank not found or no longer belongs to the active story.');
        settings.memoryBank.characterBanks.banks = list;
    });
    notify();
    logEvent('character-memory','bank-updated-durable',{id:updated.id,storyId:updated.storyId,character:updated.character,linkedCount:updated.linkedRefs.length,label},'info');
    return clone(updated);
}

export function removeCharacterBank(id){
    let removed = null;
    updateSettings(s => {
        const list = s.memoryBank?.characterBanks?.banks;
        if (!Array.isArray(list)) return;
        const storyId = currentCharacterBankStoryId();
        const index = list.findIndex(bank => String(bank?.id) === String(id) && normalizeCharacterBankStoryId(bank?.storyId) === storyId);
        if (index < 0) return;
        removed = list[index];
        list.splice(index, 1);
    });
    if (removed) {
        notify();
        logEvent('character-memory','bank-removed',{id:String(id),storyId:normalizeCharacterBankStoryId(removed?.storyId),character:removed.character||''},'info');
    }
    return !!removed;
}

export function setCharacterBanksEnabled(enabled){
    updateSettings(s => {
        s.memoryBank = s.memoryBank || {};
        s.memoryBank.characterBanks = s.memoryBank.characterBanks || { enabled: true, banks: [] };
        s.memoryBank.characterBanks.enabled = enabled === true;
    });
    notify();
}

function notify(){
    try{syncCharacterFacadeToWorldTree({context:getContext(),banks:ownerCharacterBanks(),control:getCharacterOwnerControlSnapshot(),reason:'character-bank-save'});}
    catch(error){logEvent('world-tree','character-write-origin-failed',{error:error?.message||String(error)},'error');throw error;}
    try { globalThis.window?.dispatchEvent?.(new CustomEvent('tv2-character-banks-updated')); } catch {}
    try { globalThis.window?.dispatchEvent?.(new CustomEvent('tv2-memory-bank-updated')); } catch {}
}

function recentChatText(maxMessages = 8){
    return (getContext()?.chat || []).slice(-Math.max(1, Number(maxMessages)||8)).map(m => String(m?.mes || '')).join('\n');
}

let lastRuntimeReconciliation = null;
let lastCardRuntimeTrace = new Map();

function normalizedActorNames(value = []){
    return [...new Set((Array.isArray(value) ? value : []).map(value => cleanText(value).toLowerCase()).filter(Boolean))].sort((a,b)=>a.localeCompare(b));
}

function sceneParticipantNames(sceneSnapshot = null){
    const values = sceneSnapshot?.acceptedScene?.participants;
    if (!Array.isArray(values)) return null;
    return normalizedActorNames(values);
}
function sceneReferencedCharacterNames(sceneSnapshot = null){
    const rows = sceneSnapshot?.references?.characters;
    if (!Array.isArray(rows)) return [];
    return normalizedActorNames(rows.map(row => row?.name));
}

/**
 * Deterministic scene view for Character Banks. No model calls and no settings
 * mutation occur here. The Work Director may use activeActors as planning data.
 */
export function getCharacterBankSceneSnapshot({ chatText = null, sceneSnapshot = null } = {}){
    const control=getCharacterReadControlSnapshot();
    const sourceBanks = getCharacterBanks();
    const cfg = {
        enabled: control.enabled !== false,
        banks: sourceBanks.map((bank,index) => normalizeCharacterBank({ ...bank, id: cleanText(bank?.id) || \`runtime-bank-\${index}\` })),
    };
    const text = chatText == null ? recentChatText(8) : String(chatText || '');
    const banks = cfg.banks.map(bank => getCharacterBankRuntime(bank,{chatText:text,sceneSnapshot}));
    const activeActors = normalizedActorNames(banks.filter(bank => bank.enabled && bank.present).map(bank => bank.character));
    const warmActors = normalizedActorNames(banks.filter(bank => bank.enabled && bank.warm).map(bank => bank.character));
    const bankStates = banks.map(bank => ({
        id: bank.id,
        character: bank.character,
        role: bank.role,
        enabled: bank.enabled,
        present: bank.present,
        warm: bank.warm,
        status: bank.status,
        cardBindingState: bank.cardBindingState,
        cardActive: bank.cardActive === true,
        cardInstalled: bank.cardInstalled === true,
        cardAvatar: bank.cardBinding?.avatar || '',
        cardName: bank.cardBinding?.name || '',
        textPresent: bank.textPresent === true,
        linkedRefs: bank.linkedRefs?.length || 0,
    }));
    const state = {
        enabled: cfg.enabled !== false,
        activeActors,
        warmActors,
        bankStates,
    };
    return { ...state, fingerprint: JSON.stringify(state) };
}

function traceBoundCharacterCards(current, source = 'runtime'){
    const next = new Map();
    for (const bank of current?.bankStates || []) {
        const prior = lastCardRuntimeTrace.get(bank.id) || null;
        const snapshot = {
            cardActive: bank.cardActive === true,
            textPresent: bank.textPresent === true,
            cardBindingState: bank.cardBindingState || 'none',
            cardAvatar: bank.cardAvatar || '',
        };
        next.set(bank.id, snapshot);
        if (bank.cardBindingState !== 'bound') continue;
        if (snapshot.cardActive && !prior?.cardActive) {
            logEvent('character-memory','card-active-detected',{
                source,
                bankId:bank.id,
                character:bank.character,
                role:bank.role,
                cardName:bank.cardName || bank.character,
                avatar:bank.cardAvatar,
                linkedCount:bank.linkedRefs || 0,
            },'info');
        }
        if (snapshot.textPresent && !prior?.textPresent) {
            logEvent('character-memory','card-scene-triggered',{
                source,
                bankId:bank.id,
                character:bank.character,
                role:bank.role,
                cardName:bank.cardName || bank.character,
                avatar:bank.cardAvatar,
                trigger:'scene-mention',
                linkedCount:bank.linkedRefs || 0,
            },'info');
        }
    }
    lastCardRuntimeTrace = next;
}

/**
 * Reconcile only ephemeral Character Bank runtime state. Persistent Character
 * Bank configuration remains operator-owned, so this route never enters the
 * Transaction Ledger and never calls a Sidecar.
 */
export function reconcileCharacterBankRuntime({ chatText = null, sceneSnapshot = null, expectedActiveActors = null, source = 'runtime' } = {}){
    const current = getCharacterBankSceneSnapshot({ chatText, sceneSnapshot });
    traceBoundCharacterCards(current, source);
    const expected = expectedActiveActors == null ? null : normalizedActorNames(expectedActiveActors);
    const actorsMatch = expected == null || JSON.stringify(expected) === JSON.stringify(current.activeActors);
    const previous = lastRuntimeReconciliation ? clone(lastRuntimeReconciliation) : null;
    if (!actorsMatch) {
        logEvent('character-memory','runtime-reconcile-skipped',{
            source,
            reason:'scene-actors-changed',
            expectedActiveActors:expected,
            currentActiveActors:current.activeActors,
        },'debug');
        return { skipped:true, reason:'scene-actors-changed', expectedActiveActors:expected, previous, current };
    }
    const changed = !previous || previous.fingerprint !== current.fingerprint;
    lastRuntimeReconciliation = clone(current);
    logEvent('character-memory','runtime-reconciled',{
        source,
        changed,
        activeActors:current.activeActors,
        warmActors:current.warmActors,
        banks:current.bankStates.length,
    }, changed ? 'info' : 'debug');
    return { skipped:false, changed, previous, current };
}

export function getCharacterBankReconciliationState(){
    return lastRuntimeReconciliation ? clone(lastRuntimeReconciliation) : null;
}

export function resetCharacterBankReconciliation(){
    lastRuntimeReconciliation = null;
    lastCardRuntimeTrace = new Map();
}

export function getCharacterBankRuntime(bank, { chatText = null, sceneSnapshot = null } = {}){
    const b = normalizeCharacterBank(bank);
    const cardStatus = characterBankCardStatus(b);
    const text = chatText == null ? recentChatText(8) : String(chatText || '');
    const textPresent = !!b.character && characterPresentInText(b.character, text);
    const participants = sceneParticipantNames(sceneSnapshot);
    const references = sceneReferencedCharacterNames(sceneSnapshot);
    const characterKey = cleanText(b.character).toLowerCase();
    const scannerPresent = participants == null ? null : participants.includes(characterKey);
    const scannerReferenced = references.includes(characterKey);
    // Once Scene Scanner has an accepted snapshot it is authoritative for
    // physical presence. Selecting a SillyTavern card does not prove that the
    // character is physically present in an NPC-only/cutaway scene. Raw text
    // and active-card identity remain fallback/warm evidence only.
    const present = scannerPresent == null ? (textPresent || cardStatus.active === true) : scannerPresent;
    let warm = false;
    let status = 'DORMANT';
    if (!b.enabled || !b.character) status = 'OFF';
    else if (b.role === 'lead') { warm = true; status = present ? 'LEAD · PRESENT' : cardStatus.active ? 'LEAD · ACTIVE CARD' : 'LEAD · WARM'; }
    else if (b.role === 'supporting') {
        warm = b.sceneAware ? (present || scannerReferenced || cardStatus.active === true) : true;
        status = present ? 'SUPPORT · PRESENT' : scannerReferenced ? 'SUPPORT · REFERENCED' : warm ? (cardStatus.active ? 'SUPPORT · ACTIVE CARD' : 'SUPPORT · WARM') : 'SUPPORT · DORMANT';
    } else {
        warm = present || scannerReferenced || cardStatus.active === true;
        status = present ? 'BACKGROUND · PRESENT' : scannerReferenced ? 'BACKGROUND · REFERENCED' : warm && cardStatus.active ? 'BACKGROUND · ACTIVE CARD' : 'BACKGROUND';
    }
    return { ...b, present, textPresent, scannerPresent:scannerPresent===true, scannerReferenced, warm, status, cardBindingState:cardStatus.state, cardInstalled:cardStatus.installed, cardActive:cardStatus.active };
}

function treeContainsUid(book, uid){
    const tree=getTree(book);if(!tree?.root)return false;const target=Number(uid);let found=false;
    const walk=node=>{if(found||!node)return;if((node.entryUids||[]).some(value=>Number(value)===target)){found=true;return;}for(const child of node.children||[])walk(child);};
    walk(tree.root);return found;
}

export function getCharacterWarmRefs({ chatText = null, sceneSnapshot = null } = {}){
    const cfg = getCharacterReadControlSnapshot();
    if (cfg.enabled === false) return [];
    const text = chatText == null ? recentChatText(8) : String(chatText || '');
    const out = [];
    const seen = new Set();
    for (const bank of getCharacterBanks().map(b => getCharacterBankRuntime(b,{chatText:text,sceneSnapshot}))) {
        if (!bank.warm) continue;
        for (const ref of bank.linkedRefs || []) {
            if (!isBookEnabled(ref.book) || !canReadBook(ref.book) || !isTv2InjectionBook(ref.book) || !isBookInCurrentStory(ref.book,{access:'read'})) continue;
            const resolved=resolveCurrentTreeRef(ref);
            if (!resolved || !treeContainsUid(ref.book, ref.uid)) {
                logEvent('character-memory','dangling-lore-link-skipped',{bankId:bank.id,character:bank.character,book:ref.book,uid:Number(ref.uid)},'warn');
                continue;
            }
            const key = \`\${resolved.book}:\${Number(resolved.uid)}\`;
            if (seen.has(key)) continue;
            seen.add(key);
            out.push({
                ...resolved,
                source:\`character-bank:\${bank.id}\`,
                characterBankId:bank.id,
                character:bank.character,
                characterRole:bank.role,
                characterCardBound:bank.cardBindingState === 'bound',
                characterCardActive:bank.cardActive === true,
                characterTextPresent:bank.textPresent === true,
                characterScannerPresent:bank.scannerPresent === true,
                characterScannerReferenced:bank.scannerReferenced === true,
                characterTrigger:bank.scannerPresent ? 'scene-participant' : bank.scannerReferenced ? 'scene-reference' : bank.cardActive ? 'active-card' : (bank.textPresent ? 'scene-mention-fallback' : \`\${bank.role}-policy\`),
                persistentWarm:true,
            });
        }
    }
    return out;
}

export async function resolveCharacterLoreRef(book, uidValue){
    const uidNumber = Number(uidValue);
    const name = cleanText(book);
    if (!name || !Number.isFinite(uidNumber)) throw new Error('A lorebook and numeric UID are required.');
    if (!isBookEnabled(name) || !canReadBook(name) || !isTv2InjectionBook(name)) throw new Error(\`Lorebook "\${name}" must be Nexus enabled, readable, and use Nexus injection to become a Character Bank warm link.\`);
    if (!isBookInCurrentStory(name,{access:'read'})) throw new Error(\`Lorebook "\${name}" is not readable in the current Story Scope.\`);
    const rows = await buildTreeEntryIndex({ books:[name] });
    const row = rows.find(entry => Number(entry.uid) === uidNumber);
    if (!row) throw new Error(\`UID \${uidNumber} was not found in the Nexus Tree for "\${name}".\`);
    return { book:name, uid:uidNumber, title:row.title||'', nodeId:row.nodeId||null, nodeLabel:row.nodeLabel||'', path:Array.isArray(row.path)?row.path:[] };
}

export async function scanCharacterLore(character){
    const name = cleanText(character);
    if (!name) throw new Error('Enter a character name before scanning lore.');
    const books = getActiveBooks({ requireTree:true, access:'read', injection:'tv2' });
    if (!books.length) return [];
    const scanScope = JSON.stringify([...books].map(String).sort());
    // Character scans need a ranked candidate surface, not every matching lore
    // row in memory. searchTree's positive limit is a bounded top-N collector,
    // so very large Trees remain safe before the relevance floor is applied.
    const rows = await searchTree({ query:name, books, includeContent:false, limit:256 });
    const liveBooks=getActiveBooks({ requireTree:true, access:'read', injection:'tv2' });
    const liveScope=JSON.stringify([...liveBooks].map(String).sort());
    if(liveScope!==scanScope){logEvent('character-memory','lore-scan-stale-scope',{character:name,startedBooks:books,currentBooks:liveBooks},'warn');return [];}
    const liveBookSet=new Set(liveBooks.map(String));
    if (!rows.length) return [];
    const best = Math.max(...rows.map(row => Number(row.score)||0), 1);
    const floor = Math.max(5, best * 0.22);
    const kept = rows.filter(row => liveBookSet.has(String(row.book)) && (Number(row.score) >= floor || (row.matched||[]).some(match => ['title-exact','title-phrase','tree-path-phrase','node-summary-phrase'].includes(match))));
    const result = kept.map(row => ({
        book:row.book,
        uid:Number(row.uid),
        title:row.title||'',
        nodeId:row.nodeId||null,
        nodeLabel:row.nodeLabel||'',
        path:Array.isArray(row.path)?row.path:[],
        score:Number(row.score)||0,
        percent:Math.max(1,Math.min(100,Math.round(((Number(row.score)||0)/best)*100))),
        matched:Array.isArray(row.matched)?row.matched:[],
    }));
    logEvent('character-memory','lore-scan',{character:name,books,results:result.length,bestScore:best,scoreFloor:floor},'info');
    return result;
}

export function linkCharacterLore(bankId, ref){
    const bank = getCharacterBank(bankId);
    if (!bank) throw new Error('Character Bank not found.');
    const book=cleanText(ref?.book), uidNumber=Number(ref?.uid);
    if(!book||!Number.isFinite(uidNumber))throw new Error('A current lorebook and numeric UID are required.');
    if(!isBookEnabled(book)||!canReadBook(book)||!isTv2InjectionBook(book)||!isBookInCurrentStory(book,{access:'read'}))throw new Error(\`Lorebook "\${book}" is no longer legal in the current Story Scope.\`);
    if(!treeContainsUid(book,uidNumber))throw new Error(\`UID \${uidNumber} is no longer present in the current Nexus Tree for "\${book}".\`);
    const normalized = normalizeCharacterBank({ ...bank, linkedRefs:[...(bank.linkedRefs||[]), {...ref,book,uid:uidNumber}] });
    return updateCharacterBank(bankId,{linkedRefs:normalized.linkedRefs});
}

export function unlinkCharacterLore(bankId, book, uidValue){
    const bank = getCharacterBank(bankId);
    if (!bank) return null;
    const linkedRefs = (bank.linkedRefs||[]).filter(ref => !(String(ref.book)===String(book)&&Number(ref.uid)===Number(uidValue)));
    return updateCharacterBank(bankId,{linkedRefs});
}

export function linkCharacterMemory(bankId,memoryId){
    const bank=getCharacterBank(bankId);
    if(!bank)throw new Error('Character Bank not found.');
    const id=String(memoryId||''),chatId=String(getContext()?.chatId??'');
    if(!chatId)throw new Error('An active chat is required to link a chat-scoped memory.');
    if(!id||!getAllMemoryRecords().some(record=>record.id===id))throw new Error('Memory record not found.');
    const refs=[...(bank.memoryRefs||[]),{chatId,id}];
    return updateCharacterBank(bankId,{memoryRefs:refs,memoryIds:[...new Set([...(bank.memoryIds||[]),id])]});
}

export function unlinkCharacterMemory(bankId,memoryId){
    const bank=getCharacterBank(bankId);
    if(!bank)return null;
    const id=String(memoryId),chatId=String(getContext()?.chatId??'');
    return updateCharacterBank(bankId,{memoryRefs:(bank.memoryRefs||[]).filter(ref=>!(String(ref.chatId)===chatId&&String(ref.id)===id)),memoryIds:(bank.memoryIds||[]).filter(value=>value!==id)});
}

export function unlinkCharacterMemoryEverywhere(memoryId){
    const id=String(memoryId||''),chatId=String(getContext()?.chatId??'');
    if(!id||!chatId)return [];
    const changed=[];
    for(const bank of getCharacterBanks()){
        const memoryRefs=(bank.memoryRefs||[]).filter(ref=>!(String(ref.chatId)===chatId&&String(ref.id)===id));
        const memoryIds=(bank.memoryIds||[]).filter(value=>String(value)!==id);
        if(memoryRefs.length===(bank.memoryRefs||[]).length&&memoryIds.length===(bank.memoryIds||[]).length)continue;
        const updated=updateCharacterBank(bank.id,{memoryRefs,memoryIds});
        if(updated)changed.push(updated.id);
    }
    if(changed.length)logEvent('character-memory','summary-links-pruned',{memoryId:id,chatId,bankIds:changed},'info');
    return changed;
}

export function isCharacterMemoryExplicitlyLinked(bankOrId,memoryId,{chatId=currentCharacterBankStoryId()}={}){
    const bank=typeof bankOrId==='string'?getCharacterBank(bankOrId):normalizeCharacterBank(bankOrId||{});
    const id=String(memoryId||''),scope=String(chatId||'');
    if(!bank||!id||!scope)return false;
    if((bank.memoryRefs||[]).some(ref=>String(ref.chatId)===scope&&String(ref.id)===id))return true;
    return (bank.memoryIds||[]).some(value=>String(value)===id);
}

export function getCharacterBankMemories(bankOrId){
    const bank = typeof bankOrId === 'string' ? getCharacterBank(bankOrId) : normalizeCharacterBank(bankOrId||{});
    if (!bank?.character) return [];
    const name = bank.character.toLowerCase();
    const chatId=String(getContext()?.chatId??'');
    const explicit=new Set((bank.memoryRefs||[]).filter(ref=>String(ref.chatId)===chatId).map(ref=>String(ref.id)));
    return getAllMemoryRecords().filter(record => {
        if(explicit.has(record.id))return true;
        if ((record.characters||[]).some(value => String(value).toLowerCase() === name)) return true;
        return characterPresentInText(bank.character, record.text||'');
    }).sort((a,b) => (b.updatedAt||b.createdAt||0)-(a.updatedAt||a.createdAt||0));
}

export function characterBankSummary(){
    const cfg = getCharacterReadControlSnapshot();
    const banks = getCharacterBanks().map(bank => getCharacterBankRuntime(bank));
    return {
        enabled: cfg.enabled !== false,
        count: banks.length,
        enabledCount: banks.filter(b=>b.enabled).length,
        leadCount: banks.filter(b=>b.enabled&&b.role==='lead').length,
        warmCount: banks.filter(b=>b.enabled&&b.warm).length,
        linkedRefs: banks.reduce((sum,b)=>sum+(b.linkedRefs?.length||0),0),
    };
}

export function buildCharacterSummaryDirective(){
    const cfg = getCharacterReadControlSnapshot();
    if (cfg.enabled === false) return '';
    const banks = getCharacterBanks().filter(bank => bank.enabled && bank.character);
    if (!banks.length) return '';
    const lines = banks.map(bank => {
        const focus = Object.entries({
            personality:'personality changes', relationships:'relationship changes', status:'status/injuries/equipment', goals:'goals/unresolved threads', behavior:'meaningful behavior changes',
        }).filter(([key])=>bank.tracking?.[key]!==false).map(([,label])=>label).join(', ');
        const reference = [
            bank.profile?.personality ? \`baseline personality: \${bank.profile.personality}\` : '',
            bank.profile?.appearance ? \`appearance: \${bank.profile.appearance}\` : '',
            bank.profile?.clothingArmor ? \`clothing/armor/equipment: \${bank.profile.clothingArmor}\` : '',
        ].filter(Boolean).join('; ');
        return \`- \${bank.character} [\${bank.role.toUpperCase()}]: preserve \${focus || 'durable character changes'}.\${reference ? \` User reference only (do not treat as a new change): \${reference}.\` : ''}\`;
    });
    return \`\nCHARACTER MEMORY BANK FOCUS\nThe user explicitly tracks these characters. When the NEW PASSAGE establishes a durable change about them, preserve it in the summary and include the exact character name in the characters array. Do not invent changes and do not force a character into the summary if nothing changed.\n\${lines.join('\n')}\n\`;
}
`;
  assert.ok(characterSource.includes("const snapshot=(migrated||parityAllowsWorldTree)?characterTreeReadSnapshot"));
});
