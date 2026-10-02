import {
  WorldTreeNodeKind,
  WorldTreeScopeType,
  WorldTreeTemporalStatus,
} from './store.js';

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
  return JSON.stringify({version:'complete-memory-owner-v1',record:stableObject(legacyMemoryOwnerRecord(record)),validity:stableObject(record.worldTreeValidity??null)});
}

export function legacyMemoryTemporalStatus(record={}){
  if(record?.worldTreeValidity?.valid===false)return WorldTreeTemporalStatus.SUPERSEDED;
  if(record.promotedTo)return WorldTreeTemporalStatus.SUPERSEDED;
  if(record.routeState==='superseded')return WorldTreeTemporalStatus.SUPERSEDED;
  return explicitMemoryTemporalStatus(record)??WorldTreeTemporalStatus.HISTORICAL;
}

function memoryNodeId(chatId,memoryId){
  return 'memory:'+encodeURIComponent(String(chatId))+':'+encodeURIComponent(String(memoryId));
}
function memoryControlNodeId(chatId){
  return 'memory-control:'+encodeURIComponent(String(chatId));
}
function normalizeControl(control={}){
  return {
    version:Number(control?.version)||4,
    activeLayers:(control?.activeLayers??[]).map(ids=>[...new Set((ids??[]).map(String))]),
    permanentIds:[...new Set((control?.permanentIds??[]).map(String))],
    compressedIndices:[...new Set((control?.compressedIndices??[]).map(Number).filter(Number.isFinite))],
    coverageReceipts:(control?.coverageReceipts??[]).map(row=>({
      id:String(row?.id??''),
      turnRange:Array.isArray(row?.turnRange)?row.turnRange.map(Number):null,
      sourceMessageIds:(row?.sourceMessageIds??[]).map(String),
      sourceFingerprint:String(row?.sourceFingerprint??''),
      sourceMemoryId:row?.sourceMemoryId==null?null:String(row.sourceMemoryId),
      source:String(row?.source??'summary-coverage'),
      createdAt:Number(row?.createdAt)||0,
    })).filter(row=>row.id&&row.turnRange),
    summarizedUpTo:Number.isFinite(Number(control?.summarizedUpTo))?Number(control.summarizedUpTo):-1,
    effectiveSummarizedUpTo:Number.isFinite(Number(control?.effectiveSummarizedUpTo))?Number(control.effectiveSummarizedUpTo):-1,
    sequence:Math.max(0,Number(control?.sequence)||0),
    evidenceRevision:Math.max(1,Number(control?.evidenceRevision)||1),
    lastCycleId:control?.lastCycleId==null?null:String(control.lastCycleId),
    lastUpdatedAt:Math.max(0,Number(control?.lastUpdatedAt)||0),
  };
}
function memoryControlPayload(control,{chatId}){
  const normalized=normalizeControl(control);
  const fingerprint=JSON.stringify(stableObject(normalized));
  return {
    id:memoryControlNodeId(chatId),
    kind:WorldTreeNodeKind.SUMMARY,
    parentId:null,
    scope:{type:WorldTreeScopeType.CHAT,chatId:String(chatId)},
    provenance:{
      sourceType:'NEXUS_MEMORY_BANK',
      sourceIds:['memory-read-control'],
      sourceRevisionIds:[fingerprint],
      importedFrom:'legacy-memory-bank-control',
    },
    temporal:{status:WorldTreeTemporalStatus.CURRENT},
    data:{
      label:'Memory read control',
      importedFrom:'legacy-memory-bank-control',
      importFingerprint:fingerprint,
      ...normalized,
    },
  };
}

function messageRefs(record,chatId){
  return uniq(record?.sourceMessageIds).map((messageId,index)=>({
    chatId:String(chatId),
    messageId,
    messageRevision:record?.sourceFingerprint||record?.updatedAt||null,
    sourceIndex:index,
  }));
}

function nodePayload(record,{chatId}){
  const fingerprint=stableFingerprint(record);
  return {
    id:memoryNodeId(chatId,record.id),
    kind:WorldTreeNodeKind.MEMORY,
    parentId:null,
    scope:{type:WorldTreeScopeType.CHAT,chatId:String(chatId)},
    provenance:{
      sourceType:'NEXUS_MEMORY_BANK',
      sourceIds:[String(record.id)],
      sourceRevisionIds:[String(record.sourceFingerprint||record.updatedAt||fingerprint)],
      messageRefs:messageRefs(record,chatId),
      importedFrom:'legacy-memory-bank',
    },
    temporal:{
      status:legacyMemoryTemporalStatus(record),
      supersededBy:record.promotedTo?[memoryNodeId(chatId,record.promotedTo)]:[],
      reason:record?.worldTreeValidity?.valid===false
        ?String(record?.worldTreeValidity?.reason||'source-memory-invalidated')
        :(record.promotedTo?'promoted-to-parent-memory':null),
    },
    data:{
      sourceRecord:legacyMemoryOwnerRecord(record),sourcePresent:true,
      label:String(record.text||'Memory').trim().slice(0,120)||String(record.id),
      text:String(record.text||''),
      layer:Number(record.layer)||0,
      turnRange:Array.isArray(record.turnRange)?record.turnRange.map(Number):null,
      assistantTurnRange:Array.isArray(record.assistantTurnRange)?record.assistantTurnRange.map(Number):null,
      characters:uniq(record.characters),
      locations:uniq(record.locations),
      dates:uniq(record.dates),
      topics:uniq(record.topics),
      threads:uniq(record.threads),
      permanent:record.permanent===true,
      locked:record.locked===true,
      source:String(record.source||'summary'),
      sourceValidity:clone(record.worldTreeValidity??null),
      importedFrom:'legacy-memory-bank',
      importFingerprint:fingerprint,
    },
  };
}

function edgePayload(record,{chatId}){
  if(!record?.parentId)return null;
  return {
    id:'memory-edge:'+encodeURIComponent(String(chatId))+':'+encodeURIComponent(String(record.id))+'->'+encodeURIComponent(String(record.parentId)),
    from:memoryNodeId(chatId,record.id),
    to:memoryNodeId(chatId,record.parentId),
    relation:'PROMOTED_INTO',
    scope:{type:WorldTreeScopeType.CHAT,chatId:String(chatId)},
    provenance:{
      sourceType:'NEXUS_MEMORY_BANK',
      sourceIds:[String(record.id),String(record.parentId)],
      sourceRevisionIds:[String(record.sourceFingerprint||record.updatedAt||'legacy-memory')],
      importedFrom:'legacy-memory-bank',
    },
    temporal:{status:WorldTreeTemporalStatus.CURRENT},
    data:{importedFrom:'legacy-memory-bank'},
  };
}

function sameImportedNode(existing,payload){
  return existing?.data?.sourcePresent===true&&existing?.data?.importedFrom==='legacy-memory-bank'
    &&existing?.data?.importFingerprint===payload?.data?.importFingerprint
    &&existing?.temporal?.status===payload?.temporal?.status;
}

export function importLegacyMemoryRecordsToWorldTree(tree,{chatId,records=[],control={}}={}){
  if(!tree?.upsertNode)throw new TypeError('NexusWorldTree instance is required');
  const storyId=String(chatId??'').trim();
  if(!storyId)throw new TypeError('Memory import requires chatId');
  const input=(Array.isArray(records)?records:[]).filter(row=>row&&String(row.id??'').trim());
  const importedIds=new Set(input.map(row=>memoryNodeId(storyId,row.id)));
  const created=[],updated=[],unchanged=[],edges=[],removed=[];

  for(const record of input){
    const payload=nodePayload(record,{chatId:storyId});
    const existing=tree.getNode(payload.id,{chatId:storyId});
    if(sameImportedNode(existing,payload)){unchanged.push(payload.id);continue;}
    tree.upsertNode(payload);
    (existing?updated:created).push(payload.id);
  }

  // Retain audit history while withdrawing deleted import sources from the
  // Memory read family. Other stories and non-import authorities are untouched.
  for(const node of tree.iterateNodes({chatId:storyId,kind:WorldTreeNodeKind.MEMORY})){
    if(node.scope?.chatId!==storyId||node.data?.importedFrom!=='legacy-memory-bank'||importedIds.has(node.id)||node.data?.sourcePresent===false)continue;
    tree.upsertNode({...node,temporal:{...node.temporal,status:WorldTreeTemporalStatus.SUPERSEDED,reason:'legacy-memory-source-removed'},data:{...node.data,sourcePresent:false}});
    removed.push(node.id);
  }

  for(const record of input){
    const edge=edgePayload(record,{chatId:storyId});
    if(!edge)continue;
    if(!importedIds.has(edge.from)||!importedIds.has(edge.to))continue;
    const existing=tree.getEdge?.(edge.id,{chatId:storyId})??null;
    if(!existing)tree.linkEdge(edge);
    edges.push(edge.id);
  }

  const controlPayload=memoryControlPayload(control,{chatId:storyId});
  const controlExisting=tree.getNode(controlPayload.id,{chatId:storyId});
  if(!controlExisting||controlExisting.data?.importFingerprint!==controlPayload.data.importFingerprint)tree.upsertNode(controlPayload);

  return Object.freeze({
    kind:'NexusWorldTreeLegacyMemoryImport',
    chatId:storyId,
    inputCount:input.length,
    created:Object.freeze(created),
    updated:Object.freeze(updated),
    unchanged:Object.freeze(unchanged),
    edges:Object.freeze(edges),
    removed:Object.freeze(removed),
    controlNodeId:controlPayload.id,
  });
}

export function legacyMemoryWorldNodeId(chatId,memoryId){
  return memoryNodeId(chatId,memoryId);
}
export function legacyMemoryControlWorldNodeId(chatId){
  return memoryControlNodeId(chatId);
}
