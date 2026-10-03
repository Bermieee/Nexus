import { applyDeterministicWorldTreeContribution } from './intake/runtime.js';
import { stableHash } from './intake/contribution.js';
import { memoryOwnerRecord, memoryTemporalStatus, memoryWorldNodeId, memoryControlWorldNodeId, normalizeMemoryControl, memoryRecordFields, memoryPromotionEdgeId } from './memory-schema.js';

const clone=value=>value==null?value:structuredClone(value);
const uniq=values=>[...new Set((values??[]).map(v=>String(v??'').trim()).filter(Boolean))];
function stableObject(value){
  if(Array.isArray(value))return value.map(stableObject);
  if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(key=>[key,stableObject(value[key])]));
  return value;
}
export const legacyMemoryOwnerRecord=memoryOwnerRecord;
export const legacyMemoryTemporalStatus=memoryTemporalStatus;
const safeId=value=>encodeURIComponent(String(value??''));
function memoryLineageId(chatId,memoryId){return 'legacy-memory:'+String(chatId)+':'+String(memoryId);}
function stableFingerprint(record={}){
  return JSON.stringify({version:'complete-memory-owner-v2-intake',record:stableObject(memoryOwnerRecord(record)),validity:stableObject(record.worldTreeValidity??null)});
}
function messageSourceRefs(record){
  return uniq(record?.sourceMessageIds).map((messageId,index)=>({messageId,messageRevision:record?.sourceFingerprint||record?.updatedAt||null,sourceIndex:index}));
}
function memoryFields(record,fingerprint){return memoryRecordFields(record,{importedFrom:'legacy-memory-bank',importFingerprint:fingerprint});}
function memoryContribution(record,{chatId,inputIds,includePromotion=true}={}){
  const fingerprint=stableFingerprint(record),lineage=memoryLineageId(chatId,record.id),nodeId=memoryWorldNodeId(chatId,record.id),status=memoryTemporalStatus(record);
  const refs=[{legacyMemoryLineageId:lineage,memoryId:String(record.id),revision:stableHash(fingerprint)},...messageSourceRefs(record)];
  const edges=[];
  if(includePromotion&&record?.parentId&&inputIds?.has(String(record.parentId))){
    edges.push({edgeId:memoryPromotionEdgeId(chatId,record.id,record.parentId),from:nodeId,to:memoryWorldNodeId(chatId,record.parentId),meaning:'promoted-into',authority:'REMEMBERED',subtype:'legacy-memory-promotion'});
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
  const normalized=normalizeMemoryControl(control),fingerprint=JSON.stringify(stableObject(normalized));
  return {kind:'Contribution',source:'owner',scope:{type:'CHAT',chatId:String(chatId)},sourceRefs:[{memoryControlLineageId:'memory-control:'+String(chatId),revision:stableHash(fingerprint)}],
    key:'legacy-memory-control:'+stableHash(fingerprint),mentions:[],edges:[],nodes:[{tempId:memoryControlWorldNodeId(chatId),kind:'SUMMARY',label:'Memory read control',authority:'CANON',fields:{importedFrom:'legacy-memory-bank-control',importFingerprint:fingerprint,...normalized}}]};
}
export function importLegacyMemoryRecordsToWorldTree(tree,{chatId,records=[],control={}}={}){
  if(!tree?.applyContributionRevision)throw new TypeError('NexusWorldTree instance is required');
  const storyId=String(chatId??'').trim();if(!storyId)throw new TypeError('Memory import requires chatId');
  const input=(Array.isArray(records)?records:[]).filter(row=>row&&String(row.id??'').trim());
  const inputIds=new Set(input.map(row=>String(row.id))),created=[],updated=[],unchanged=[],edges=[],removed=[];
  const ordered=[...input].sort((a,b)=>(Number(b.layer)||0)-(Number(a.layer)||0)||String(a.id).localeCompare(String(b.id)));
  for(const record of ordered){
    const id=memoryWorldNodeId(storyId,record.id),existed=Boolean(tree.getNode(id,{chatId:storyId})),contribution=memoryContribution(record,{chatId:storyId,inputIds});
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
    edges:Object.freeze(uniq(edges)),removed:Object.freeze(uniq(removed)),controlNodeId:memoryControlWorldNodeId(storyId),controlNoOp:controlReceipt.noOp===true,intakeOwned:true});
}
export { memoryWorldNodeId as legacyMemoryWorldNodeId, memoryControlWorldNodeId as legacyMemoryControlWorldNodeId };
