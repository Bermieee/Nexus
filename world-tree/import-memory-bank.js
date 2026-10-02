import { applyDeterministicWorldTreeContribution } from './intake/runtime.js';
import { stableHash } from './intake/contribution.js';
import { WorldTreeTemporalStatus } from './store.js';

const clone=value=>value==null?value:structuredClone(value);
const uniq=values=>[...new Set((values??[]).map(v=>String(v??'').trim()).filter(Boolean))];
const TEMPORAL_STATUSES=new Set(Object.values(WorldTreeTemporalStatus));

function explicitMemoryTemporalStatus(record={}){
  const value=record?.temporalStatus??record?.metadata?.temporalStatus??record?.status??null;
  if(value==null)return null;
  const status=String(value).trim().toUpperCase().replaceAll('-','_');
  return TEMPORAL_STATUSES.has(status)?status:null;
}
function stableObject(value){
  if(Array.isArray(value))return value.map(stableObject);
  if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(key=>[key,stableObject(value[key])]));
  return value;
}
export function legacyMemoryOwnerRecord(record={}){const source=clone(record);delete source.worldTreeValidity;return source;}
function stableFingerprint(record={}){
  return JSON.stringify({version:'complete-memory-owner-v2-intake',record:stableObject(legacyMemoryOwnerRecord(record)),validity:stableObject(record.worldTreeValidity??null)});
}
export function legacyMemoryTemporalStatus(record={}){
  if(record?.worldTreeValidity?.valid===false)return WorldTreeTemporalStatus.SUPERSEDED;
  if(record.promotedTo)return WorldTreeTemporalStatus.SUPERSEDED;
  if(record.routeState==='superseded')return WorldTreeTemporalStatus.SUPERSEDED;
  return explicitMemoryTemporalStatus(record)??WorldTreeTemporalStatus.HISTORICAL;
}
function safeId(value){return encodeURIComponent(String(value??''));}
function memoryNodeId(chatId,memoryId){return 'memory:'+safeId(chatId)+':'+safeId(memoryId);}
function memoryControlNodeId(chatId){return 'memory-control:'+safeId(chatId);}
function memoryLineageId(chatId,memoryId){return 'legacy-memory:'+String(chatId)+':'+String(memoryId);}
function normalizeControl(control={}){
  return {
    version:Number(control?.version)||4,
    activeLayers:(control?.activeLayers??[]).map(ids=>[...new Set((ids??[]).map(String))]),
    permanentIds:[...new Set((control?.permanentIds??[]).map(String))],
    compressedIndices:[...new Set((control?.compressedIndices??[]).map(Number).filter(Number.isFinite))],
    coverageReceipts:(control?.coverageReceipts??[]).map(row=>({
      id:String(row?.id??''),turnRange:Array.isArray(row?.turnRange)?row.turnRange.map(Number):null,
      sourceMessageIds:(row?.sourceMessageIds??[]).map(String),sourceFingerprint:String(row?.sourceFingerprint??''),
      sourceMemoryId:row?.sourceMemoryId==null?null:String(row.sourceMemoryId),source:String(row?.source??'summary-coverage'),createdAt:Number(row?.createdAt)||0,
    })).filter(row=>row.id&&row.turnRange),
    summarizedUpTo:Number.isFinite(Number(control?.summarizedUpTo))?Number(control.summarizedUpTo):-1,
    effectiveSummarizedUpTo:Number.isFinite(Number(control?.effectiveSummarizedUpTo))?Number(control.effectiveSummarizedUpTo):-1,
    sequence:Math.max(0,Number(control?.sequence)||0),evidenceRevision:Math.max(1,Number(control?.evidenceRevision)||1),
    lastCycleId:control?.lastCycleId==null?null:String(control.lastCycleId),lastUpdatedAt:Math.max(0,Number(control?.lastUpdatedAt)||0),
  };
}
function messageSourceRefs(record){
  return uniq(record?.sourceMessageIds).map((messageId,index)=>({messageId,messageRevision:record?.sourceFingerprint||record?.updatedAt||null,sourceIndex:index}));
}
function memoryFields(record,fingerprint){
  return {
    sourceRecord:legacyMemoryOwnerRecord(record),sourcePresent:true,
    label:String(record.text||'Memory').trim().slice(0,120)||String(record.id),text:String(record.text||''),layer:Number(record.layer)||0,
    turnRange:Array.isArray(record.turnRange)?record.turnRange.map(Number):null,assistantTurnRange:Array.isArray(record.assistantTurnRange)?record.assistantTurnRange.map(Number):null,
    characters:uniq(record.characters),locations:uniq(record.locations),dates:uniq(record.dates),topics:uniq(record.topics),threads:uniq(record.threads),
    permanent:record.permanent===true,locked:record.locked===true,source:String(record.source||'summary'),sourceValidity:clone(record.worldTreeValidity??null),
    importedFrom:'legacy-memory-bank',importFingerprint:fingerprint,
  };
}
function memoryContribution(record,{chatId,inputIds,includePromotion=true}={}){
  const fingerprint=stableFingerprint(record),lineage=memoryLineageId(chatId,record.id),nodeId=memoryNodeId(chatId,record.id),status=legacyMemoryTemporalStatus(record);
  const refs=[{legacyMemoryLineageId:lineage,memoryId:String(record.id),revision:stableHash(fingerprint)},...messageSourceRefs(record)];
  const edges=[];
  if(includePromotion&&record?.parentId&&inputIds?.has(String(record.parentId))){
    edges.push({edgeId:'memory-edge:'+safeId(chatId)+':'+safeId(record.id)+'->'+safeId(record.parentId),from:nodeId,to:memoryNodeId(chatId,record.parentId),meaning:'promoted-into',authority:'REMEMBERED',subtype:'legacy-memory-promotion'});
  }
  return {kind:'Contribution',source:'owner',scope:{type:'CHAT',chatId:String(chatId)},sourceRefs:refs,key:'legacy-memory-bank:'+safeId(record.id)+':'+stableHash(fingerprint),mentions:[],
    nodes:[{tempId:nodeId,kind:'MEMORY',label:String(record.text||'Memory').trim().slice(0,120)||String(record.id),authority:'REMEMBERED',temporalStatus:status,temporalReason:status==='SUPERSEDED'?(record?.worldTreeValidity?.reason??(record.promotedTo?'promoted':record.routeState==='superseded'?'route-superseded':null)):null,fields:memoryFields(record,fingerprint)}],edges};
}
function removedContribution(node,{chatId,revision}={}){
  const memoryId=String(node?.data?.sourceRecord?.id??node?.provenance?.sourceIds?.[0]??node?.id??''),lineage=memoryLineageId(chatId,memoryId);
  return {kind:'Contribution',source:'owner',scope:{type:'CHAT',chatId:String(chatId)},sourceRefs:[{legacyMemoryLineageId:lineage,memoryId,revision}],key:'legacy-memory-bank:'+safeId(memoryId)+':removed:'+revision,mentions:[],edges:[],
    nodes:[{tempId:node.id,kind:'MEMORY',label:String(node.data?.label??memoryId??'Memory'),authority:'REMEMBERED',temporalStatus:'SUPERSEDED',fields:{...clone(node.data??{}),sourcePresent:false}}]};
}
function controlContribution(control,{chatId}={}){
  const normalized=normalizeControl(control),fingerprint=JSON.stringify(stableObject(normalized));
  return {kind:'Contribution',source:'owner',scope:{type:'CHAT',chatId:String(chatId)},sourceRefs:[{memoryControlLineageId:'memory-control:'+String(chatId),revision:stableHash(fingerprint)}],
    key:'legacy-memory-control:'+stableHash(fingerprint),mentions:[],edges:[],nodes:[{tempId:memoryControlNodeId(chatId),kind:'SUMMARY',label:'Memory read control',authority:'CANON',fields:{importedFrom:'legacy-memory-bank-control',importFingerprint:fingerprint,...normalized}}]};
}
export function importLegacyMemoryRecordsToWorldTree(tree,{chatId,records=[],control={}}={}){
  if(!tree?.applyContributionRevision)throw new TypeError('NexusWorldTree instance is required');
  const storyId=String(chatId??'').trim();if(!storyId)throw new TypeError('Memory import requires chatId');
  const input=(Array.isArray(records)?records:[]).filter(row=>row&&String(row.id??'').trim());
  const inputIds=new Set(input.map(row=>String(row.id))),created=[],updated=[],unchanged=[],edges=[],removed=[];
  const ordered=[...input].sort((a,b)=>(Number(b.layer)||0)-(Number(a.layer)||0)||String(a.id).localeCompare(String(b.id)));
  for(const record of ordered){
    const id=memoryNodeId(storyId,record.id),existed=Boolean(tree.getNode(id,{chatId:storyId})),contribution=memoryContribution(record,{chatId:storyId,inputIds});
    const receipt=applyDeterministicWorldTreeContribution(contribution,{tree,context:{chatId:storyId}});
    if(receipt.noOp)unchanged.push(id);else if(existed)updated.push(id);else created.push(id);
    edges.push(...receipt.createdEdgeIds,...receipt.updatedEdgeIds);
  }
  for(const node of tree.iterateNodes({chatId:storyId,kind:'MEMORY'})){
    const memoryId=String(node.data?.sourceRecord?.id??'');
    if(node.scope?.chatId!==storyId||node.data?.importedFrom!=='legacy-memory-bank'||!memoryId||inputIds.has(memoryId)||node.data?.sourcePresent===false)continue;
    const revision=stableHash({removed:true,memoryId,importFingerprint:node.data?.importFingerprint??null});
    const receipt=applyDeterministicWorldTreeContribution(removedContribution(node,{chatId:storyId,revision}),{tree,context:{chatId:storyId}});
    if(!receipt.noOp){updated.push(node.id);removed.push(node.id);}
    edges.push(...receipt.updatedEdgeIds,...receipt.supersededEdgeIds);
  }
  const controlReceipt=applyDeterministicWorldTreeContribution(controlContribution(control,{chatId:storyId}),{tree,context:{chatId:storyId}});
  return Object.freeze({kind:'NexusWorldTreeLegacyMemoryImport',chatId:storyId,inputCount:input.length,created:Object.freeze(uniq(created)),updated:Object.freeze(uniq(updated)),unchanged:Object.freeze(uniq(unchanged)),
    edges:Object.freeze(uniq(edges)),removed:Object.freeze(uniq(removed)),controlNodeId:memoryControlNodeId(storyId),controlNoOp:controlReceipt.noOp===true,intakeOwned:true});
}
export function legacyMemoryWorldNodeId(chatId,memoryId){return memoryNodeId(chatId,memoryId);}
export function legacyMemoryControlWorldNodeId(chatId){return memoryControlNodeId(chatId);}
