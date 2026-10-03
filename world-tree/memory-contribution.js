import { createBudgetManager } from '../core/budget.js';
import { isIntentionalCancellation } from '../core/cancellation.js';
import { logEvent } from '../observability/telemetry.js';
import { getNexusWorldTreeOwner } from './index.js';
import { memoryOwnerRecord, memoryTemporalStatus, memoryWorldNodeId, memoryControlWorldNodeId, normalizeMemoryControl, memoryRecordFields, memoryPromotionEdgeId } from './memory-schema.js';
import { contributionLedgerKey, contributionLineageKey, stableHash } from './intake/contribution.js';
import { applyDeterministicWorldTreeContribution, enqueueWorldTreeContribution, readWorldTreeContributionQueue } from './intake/runtime.js';

const budget=createBudgetManager({emit:logEvent});
const MEMORY_STAGE='postturn-memory';
const MEMORY_PRIORITY=70;
const clean=value=>String(value??'').replace(/\s+/g,' ').trim();
const normalized=value=>clean(value).toLocaleLowerCase();
const uniq=values=>[...new Set((values??[]).filter(value=>value!=null&&clean(value)).map(value=>clean(value)))];
const safeId=value=>encodeURIComponent(String(value??''));
const clone=value=>value==null?value:structuredClone(value);

function semanticLineageId(chatId,memoryId){return 'memory-semantic:'+String(chatId)+':'+String(memoryId);}
function recordLineageId(chatId,memoryId){return 'memory-record:'+String(chatId)+':'+String(memoryId);}
function semanticRevision(record={}){
  return stableHash({id:String(record.id??''),text:String(record.text??''),turnRange:record.turnRange??null,sourceMessageIds:record.sourceMessageIds??[],sourceFingerprint:record.sourceFingerprint??null,
    characters:uniq(record.characters),locations:uniq(record.locations),topics:uniq(record.topics),threads:uniq(record.threads),temporalStatus:memoryTemporalStatus(record),validity:record.worldTreeValidity??null});
}
function sourceRefs(record,{chatId,memoryId=record?.id,revision=semanticRevision(record)}={}){
  const refs=[{memoryLineageId:semanticLineageId(chatId,memoryId),memoryId:String(memoryId),revision}];
  for(const [index,messageId] of uniq(record?.sourceMessageIds).entries())refs.push({messageId,messageRevision:record?.sourceFingerprint??revision,sourceIndex:index});
  return refs;
}
function contributionKey(record,{chatId,memoryId=record?.id,removed=false}={}){
  const revision=removed?stableHash(['removed',String(memoryId)]):semanticRevision(record);
  return 'memory:'+safeId(memoryId)+':'+(removed?'removed:':'')+revision;
}
function parsePayload(response){
  const value=response?.structuredPayload??response?.json??response?.text??response;
  if(value&&typeof value==='object'&&!Array.isArray(value))return value;
  if(typeof value!=='string')throw new Error('WORLD_TREE_MEMORY_EXTRACTION_INVALID_PAYLOAD');
  try{const parsed=JSON.parse(value);if(parsed&&typeof parsed==='object'&&!Array.isArray(parsed))return parsed;}catch{}
  throw new Error('WORLD_TREE_MEMORY_EXTRACTION_INVALID_JSON');
}
function supportedName(name,record){
  const key=normalized(name);if(!key)return false;
  if(uniq(record?.characters).some(value=>normalized(value)===key))return true;
  return normalized(record?.text).includes(key);
}
function subtype(value){
  const out=clean(value).toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu,'-').replace(/^-+|-+$/g,'').slice(0,80);
  if(!out)throw new Error('WORLD_TREE_MEMORY_RELATIONSHIP_SUBTYPE_INVALID');return out;
}
export function validateWorldTreeMemoryExtraction(raw,{record}={}){
  if(!raw||typeof raw!=='object'||Array.isArray(raw)||!Array.isArray(raw.relationships))throw new Error('WORLD_TREE_MEMORY_EXTRACTION_SCHEMA');
  const text=String(record?.text??''),seen=new Set(),relationships=[];
  for(const [index,row] of raw.relationships.slice(0,12).entries()){
    if(!row||typeof row!=='object'||Array.isArray(row))throw new Error('WORLD_TREE_MEMORY_RELATIONSHIP_INVALID:'+index);
    const from=clean(row.from),to=clean(row.to),kind=subtype(row.subtype),snippet=String(row.snippet??'').trim();
    if(!from||!to||normalized(from)===normalized(to)||from.length>120||to.length>120)throw new Error('WORLD_TREE_MEMORY_RELATIONSHIP_ENDPOINT_INVALID:'+index);
    if(!supportedName(from,record)||!supportedName(to,record))throw new Error('WORLD_TREE_MEMORY_RELATIONSHIP_UNSUPPORTED_ENDPOINT:'+index);
    if(!snippet||snippet.length>240||!normalized(text).includes(normalized(snippet)))throw new Error('WORLD_TREE_MEMORY_RELATIONSHIP_SNIPPET_INVALID:'+index);
    const key=[normalized(from),normalized(to),kind].join('|');if(seen.has(key))continue;seen.add(key);relationships.push({from,to,subtype:kind,snippet});
  }
  return Object.freeze({relationships:Object.freeze(relationships)});
}
function extractionPrompt(record){
  return {systemPrompt:'Extract only explicit character-to-character relationship changes stated in this Nexus Memory summary. Do not infer. Return strict JSON only.',
    prompt:JSON.stringify({memorySummary:String(record?.text??''),characters:uniq(record?.characters),contract:{relationships:[{from:'explicit character name',to:'explicit character name',subtype:'short relationship change in kebab-case',snippet:'exact short substring from memorySummary'}]}})};
}
function validFrom(record){
  const start=Array.isArray(record?.turnRange)?Number(record.turnRange[0]):NaN;
  if(Number.isFinite(start))return'message:'+String(start);
  const first=uniq(record?.sourceMessageIds)[0];return first??null;
}
function mentionBuilder(record){
  const mentions=[],byKey=new Map();
  const add=(text,kindHint,field)=>{
    const label=clean(text);if(!label)return null;const key=String(kindHint)+':'+normalized(label);
    if(byKey.has(key))return byKey.get(key);
    const mentionId=field+':'+stableHash([kindHint,normalized(label)]);byKey.set(key,mentionId);mentions.push({mentionId,text:label,kindHint,contextSnippetHash:stableHash([String(record.id),field,normalized(label)])});return mentionId;
  };
  return{mentions,add};
}
function recordRevision(record={},removed=false){
  return stableHash({kind:'memory-record-v1',removed:Boolean(removed),record:memoryOwnerRecord(record),validity:record?.worldTreeValidity??null});
}
function recordSourceRefs(record,{chatId,revision}={}){
  const refs=[{memoryLineageId:recordLineageId(chatId,record.id),memoryId:String(record.id),revision}];
  for(const [index,messageId] of uniq(record?.sourceMessageIds).entries())refs.push({messageId,messageRevision:record?.sourceFingerprint??revision,sourceIndex:index});
  return refs;
}
export function buildWorldTreeMemoryRecordContribution({record,chatId,removed=false,includePromotion=false}={}){
  const id=String(record?.id??'').trim(),story=String(chatId??'').trim();if(!id||!story)throw new Error('WORLD_TREE_MEMORY_IDENTITY_INCOMPLETE');
  const revision=recordRevision(record,removed),nodeId=memoryWorldNodeId(story,id),status=removed?'SUPERSEDED':memoryTemporalStatus(record);
  const fields=memoryRecordFields(record,{canonicalOwner:'WORLD_TREE',compatibilityMirror:null,sourcePresent:!removed});
  const edges=[];
  if(!removed&&includePromotion&&record?.parentId)edges.push({edgeId:memoryPromotionEdgeId(story,id,record.parentId),from:nodeId,to:memoryWorldNodeId(story,record.parentId),meaning:'promoted-into',authority:'REMEMBERED',subtype:'memory-promotion'});
  return{kind:'Contribution',source:'memory',scope:{type:'CHAT',chatId:story},sourceRefs:recordSourceRefs(record,{chatId:story,revision}),key:'memory-record:'+safeId(id)+':'+revision,mentions:[],
    nodes:[{tempId:nodeId,kind:'MEMORY',label:String(record?.text||'Memory').trim().slice(0,120)||id,authority:'REMEMBERED',temporalStatus:status,
      temporalReason:status==='SUPERSEDED'?(record?.worldTreeValidity?.reason??(record?.promotedTo?'promoted':record?.routeState==='superseded'?'route-superseded':removed?'source-removed':null)):null,fields}],edges};
}
export function buildWorldTreeMemoryControlContribution({control={},chatId}={}){
  const story=String(chatId??'').trim();if(!story)throw new Error('WORLD_TREE_MEMORY_CONTROL_CHAT_REQUIRED');
  const normalized=normalizeMemoryControl(control),revision=stableHash({kind:'memory-control-v1',control:normalized});
  return{kind:'Contribution',source:'owner',scope:{type:'CHAT',chatId:story},sourceRefs:[{memoryControlLineageId:'memory-control:'+story,revision}],key:'memory-control:'+revision,mentions:[],edges:[],
    nodes:[{tempId:memoryControlWorldNodeId(story),kind:'SUMMARY',label:'Memory read control',authority:'CANON',fields:{...normalized,canonicalOwner:'WORLD_TREE',compatibilityMirror:null}}]};
}
export function applyWorldTreeMemoryRecordState({tree=getNexusWorldTreeOwner(),context=null,records=[],control={}}={}){
  const chatId=String(context?.chatId??context?.chat_id??'').trim();if(!chatId)throw new Error('WORLD_TREE_MEMORY_CHAT_REQUIRED');
  const input=(records??[]).filter(row=>row&&String(row.id??'').trim()),ids=new Set(input.map(row=>String(row.id))),receipts=[];
  const ordered=[...input].sort((a,b)=>(Number(b.layer)||0)-(Number(a.layer)||0)||String(a.id).localeCompare(String(b.id)));
  for(const record of ordered){
    const includePromotion=Boolean(record?.parentId)&&(ids.has(String(record.parentId))||Boolean(tree.getNode(memoryWorldNodeId(chatId,record.parentId),{chatId})));
    receipts.push(applyDeterministicWorldTreeContribution(buildWorldTreeMemoryRecordContribution({record,chatId,includePromotion}),{tree,context}));
  }
  for(const node of tree.iterateNodes({chatId,kind:'MEMORY'})){
    const id=String(node.data?.sourceRecord?.id??'');if(node.scope?.chatId!==chatId||!id||ids.has(id)||node.data?.sourcePresent===false)continue;
    if(node.data?.canonicalOwner!=='WORLD_TREE'&&node.data?.importedFrom!=='legacy-memory-bank')continue;
    const prior={...(node.data?.sourceRecord??{}),id,worldTreeValidity:{valid:false,reason:'source-removed'}};
    receipts.push(applyDeterministicWorldTreeContribution(buildWorldTreeMemoryRecordContribution({record:prior,chatId,removed:true}),{tree,context}));
  }
  const controlReceipt=applyDeterministicWorldTreeContribution(buildWorldTreeMemoryControlContribution({control,chatId}),{tree,context});
  return Object.freeze({kind:'NexusWorldTreeMemoryRecordState',chatId,recordCount:input.length,receipts:Object.freeze(receipts),controlReceipt,worldRevision:tree.revision,intakeOwned:true});
}

export function buildWorldTreeMemoryContribution({record,chatId,extraction={relationships:[]},removed=false}={}){
  const id=String(record?.id??'').trim();if(!id||!String(chatId??'').trim())throw new Error('WORLD_TREE_MEMORY_IDENTITY_INCOMPLETE');
  const revision=removed?stableHash(['removed',id]):semanticRevision(record),lineage=semanticLineageId(chatId,id),memoryNodeId=memoryWorldNodeId(chatId,id),refs=sourceRefs(record,{chatId,memoryId:id,revision});
  const status=removed?'SUPERSEDED':memoryTemporalStatus(record),builder=mentionBuilder(record),edges=[];
  if(status!=='SUPERSEDED'){
    for(const name of uniq(record.characters)){const target=builder.add(name,'CHARACTER','character');if(target)edges.push({from:memoryNodeId,to:target,meaning:'about',authority:'REMEMBERED',sourceField:'characters'});}
    for(const name of uniq(record.locations)){const target=builder.add(name,'LOCATION','location');if(target)edges.push({from:memoryNodeId,to:target,meaning:'about',authority:'REMEMBERED',sourceField:'locations'});}
    for(const name of uniq([...(record.topics??[]),...(record.threads??[])])){const target=builder.add(name,'ENTITY','topic');if(target)edges.push({from:memoryNodeId,to:target,meaning:'mentions',authority:'REMEMBERED',sourceField:'topics'});}
    const validated=validateWorldTreeMemoryExtraction({relationships:extraction?.relationships??[]},{record});
    for(const relationship of validated.relationships){
      const from=builder.add(relationship.from,'CHARACTER','relationship'),to=builder.add(relationship.to,'CHARACTER','relationship');
      edges.push({from,to,meaning:'relationship',subtype:relationship.subtype,authority:'REMEMBERED',validFrom:validFrom(record),sourceField:'text',sourceSnippetHash:stableHash(relationship.snippet)});
    }
  }
  return{kind:'Contribution',source:'memory',scope:{type:'CHAT',chatId:String(chatId)},sourceRefs:refs,key:contributionKey(record,{chatId,memoryId:id,removed}),mentions:builder.mentions,nodes:[],edges,
    memoryLineageId:lineage};
}
function skeleton(record,{chatId,removed=false}={}){return buildWorldTreeMemoryContribution({record,chatId,removed,extraction:{relationships:[]}});}
function currentSemanticContribution(tree,contribution,queuedKeys){
  const ledgerKey=contributionLedgerKey(contribution);if(queuedKeys.has(ledgerKey))return true;
  const row=tree.contributionRecord?.(ledgerKey),head=tree.latestContributionRecord?.(contributionLineageKey(contribution));
  return Boolean(row&&head?.ledgerKey===ledgerKey);
}
function shouldExtractRelationships(record){return memoryTemporalStatus(record)!=='SUPERSEDED'&&uniq(record?.characters).length>=2&&clean(record?.text).length>0;}

export async function runWorldTreeMemoryContributionJob({context=null,tree=getNexusWorldTreeOwner(),records=null,enqueueSidecar=null,isFresh=()=>true,budgetManager=budget}={}){
  const chatId=String(context?.chatId??context?.chat_id??'').trim();if(!chatId)return{kind:'NexusWorldTreeMemoryContributionJob',skipped:true,reason:'no-chat',queuedCount:0,noOpCount:0,deferredCount:0,failedCount:0};
  let sourceRecords=records;
  if(!Array.isArray(sourceRecords)){
    const memory=await import('../memory/store.js');
    sourceRecords=memory.getMemoryOwnerRecords().map(record=>({...record,worldTreeValidity:memory.memoryRecordValidity(record)}));
  }
  const input=(sourceRecords??[]).filter(row=>row&&String(row.id??'').trim()),liveIds=new Set(input.map(row=>String(row.id))),queuedKeys=new Set(readWorldTreeContributionQueue({context}).map(row=>row.id)),changed=[];let noOpCount=0;
  for(const record of input){
    const contribution=skeleton(record,{chatId});
    if(currentSemanticContribution(tree,contribution,queuedKeys)){noOpCount++;continue;}
    changed.push({record,removed:false,contribution});
  }
  for(const node of tree.iterateNodes({chatId,kind:'MEMORY'})){
    const memoryId=String(node?.data?.sourceRecord?.id??'');if(node.scope?.chatId!==chatId||(node.data?.importedFrom!=='legacy-memory-bank'&&node.data?.canonicalOwner!=='WORLD_TREE')||node.data?.sourcePresent!==false||!memoryId||liveIds.has(memoryId))continue;
    const record={id:memoryId,text:'',characters:[],locations:[],topics:[],threads:[],sourceMessageIds:[],worldTreeValidity:{valid:false,reason:'source-removed'}},contribution=skeleton(record,{chatId,removed:true});
    if(currentSemanticContribution(tree,contribution,queuedKeys)){noOpCount++;continue;}changed.push({record,removed:true,contribution});
  }
  if(!changed.length)return{kind:'NexusWorldTreeMemoryContributionJob',skipped:true,reason:'no-memory-revision',queuedCount:0,noOpCount,deferredCount:0,failedCount:0};
  const frame=budgetManager.beginTurn({timeMs:5000,worldSize:changed.length}),allowance=frame.compute('worldtree.contribute.memory',{total:changed.length,defaultUnits:4,defaultWorldSize:4,msPerUnit:1});
  if(!allowance.allowed)return{kind:'NexusWorldTreeMemoryContributionJob',deferred:true,reason:'budget',queuedCount:0,noOpCount,deferredCount:changed.length,failedCount:0};
  let queuedCount=0,deferredCount=Math.max(0,changed.length-allowance.allowed),failedCount=0,lastError=null,relationshipCount=0;
  for(const row of changed.slice(0,allowance.allowed)){
    if(isFresh()===false){deferredCount+=1;continue;}
    try{
      if(!row.removed){
        const includePromotion=Boolean(row.record?.parentId)&&Boolean(tree.getNode(memoryWorldNodeId(chatId,row.record.parentId),{chatId}));
        applyDeterministicWorldTreeContribution(buildWorldTreeMemoryRecordContribution({record:row.record,chatId,includePromotion}),{tree,context});
      }
      let extraction={relationships:[]};
      if(!row.removed&&shouldExtractRelationships(row.record)){
        let dispatch=enqueueSidecar;if(!dispatch){const {enqueueNexusModelWorkerJob}=await import('../nexus/model-worker-bus.js');dispatch=(stage,options)=>enqueueNexusModelWorkerJob('world-tree-memory',stage,options);}
        const prompt=extractionPrompt(row.record),handle=dispatch(MEMORY_STAGE,{schedulerLane:'postTurn',prompt:prompt.prompt,systemPrompt:prompt.systemPrompt,responseFormat:'json_object',excludeReasoning:true,reasoningEffort:'low',priority:MEMORY_PRIORITY,role:'postTurn',foregroundAdjacent:false,preemptible:true,maxAttempts:1,
          dedupKey:'worldtree-memory:'+row.record.id+':'+semanticRevision(row.record),label:'World Tree Memory relationship extraction',telemetry:{worldTreeMemory:true,memoryIdHash:stableHash(row.record.id),memoryRevision:semanticRevision(row.record)}});
        const response=await handle.promise;if(isFresh()===false){deferredCount+=1;continue;}extraction=validateWorldTreeMemoryExtraction(parsePayload(response),{record:row.record});
      }
      const contribution=buildWorldTreeMemoryContribution({record:row.record,chatId,extraction,removed:row.removed});enqueueWorldTreeContribution(contribution,{context});queuedCount+=1;relationshipCount+=extraction.relationships.length;
    }catch(error){
      lastError=error?.message||String(error);deferredCount+=1;if(!isIntentionalCancellation(error)&&error?.deferred!==true)failedCount+=1;
      logEvent('worldtree.intake','memory-contribution-deferred',{chatIdHash:stableHash(chatId),memoryIdHash:stableHash(row.record.id),reason:error?.name||'ERROR'},failedCount?'warn':'debug');
    }
  }
  const result={kind:'NexusWorldTreeMemoryContributionJob',queuedCount,noOpCount,deferredCount,failedCount,relationshipCount,deferred:deferredCount>0,failed:failedCount>0&&queuedCount===0,error:lastError};
  logEvent('worldtree.intake','memory-contribution-job',{chatIdHash:stableHash(chatId),memoryCount:input.length,changedCount:changed.length,queuedCount,noOpCount,deferredCount,failedCount,relationshipCount},failedCount?'warn':'info');return result;
}
