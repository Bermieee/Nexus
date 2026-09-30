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

function stableFingerprint(record={}){
  const view={
    id:String(record.id??''),
    layer:Number(record.layer)||0,
    text:String(record.text??''),
    turnRange:Array.isArray(record.turnRange)?record.turnRange.map(Number):null,
    assistantTurnRange:Array.isArray(record.assistantTurnRange)?record.assistantTurnRange.map(Number):null,
    sourceMessageIds:uniq(record.sourceMessageIds),
    sourceFingerprint:String(record.sourceFingerprint??''),
    childIds:uniq(record.childIds),
    parentId:record.parentId==null?null:String(record.parentId),
    promotedTo:record.promotedTo==null?null:String(record.promotedTo),
    characters:uniq(record.characters),
    locations:uniq(record.locations),
    dates:uniq(record.dates),
    topics:uniq(record.topics),
    threads:uniq(record.threads),
    source:String(record.source??'summary'),
    permanent:record.permanent===true,
    locked:record.locked===true,
    updatedAt:Number(record.updatedAt)||0,
  };
  return JSON.stringify(view);
}

function memoryTemporalStatus(record={}){
  if(record?.worldTreeValidity?.valid===false)return WorldTreeTemporalStatus.SUPERSEDED;
  if(record.promotedTo)return WorldTreeTemporalStatus.SUPERSEDED;
  if(record.routeState==='superseded')return WorldTreeTemporalStatus.SUPERSEDED;
  return explicitMemoryTemporalStatus(record)??WorldTreeTemporalStatus.HISTORICAL;
}

function memoryNodeId(chatId,memoryId){
  return 'memory:'+encodeURIComponent(String(chatId))+':'+encodeURIComponent(String(memoryId));
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
      status:memoryTemporalStatus(record),
      supersededBy:record.promotedTo?[memoryNodeId(chatId,record.promotedTo)]:[],
      reason:record?.worldTreeValidity?.valid===false
        ?String(record?.worldTreeValidity?.reason||'source-memory-invalidated')
        :(record.promotedTo?'promoted-to-parent-memory':null),
    },
    data:{
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
  return existing?.data?.importedFrom==='legacy-memory-bank'
    &&existing?.data?.importFingerprint===payload?.data?.importFingerprint
    &&existing?.temporal?.status===payload?.temporal?.status;
}

export function importLegacyMemoryRecordsToWorldTree(tree,{chatId,records=[]}={}){
  if(!tree?.upsertNode)throw new TypeError('NexusWorldTree instance is required');
  const storyId=String(chatId??'').trim();
  if(!storyId)throw new TypeError('Memory import requires chatId');
  const input=(Array.isArray(records)?records:[]).filter(row=>row&&String(row.id??'').trim());
  const importedIds=new Set(input.map(row=>memoryNodeId(storyId,row.id)));
  const created=[],updated=[],unchanged=[],edges=[];

  for(const record of input){
    const payload=nodePayload(record,{chatId:storyId});
    const existing=tree.getNode(payload.id,{chatId:storyId});
    if(sameImportedNode(existing,payload)){unchanged.push(payload.id);continue;}
    tree.upsertNode(payload);
    (existing?updated:created).push(payload.id);
  }

  for(const record of input){
    const edge=edgePayload(record,{chatId:storyId});
    if(!edge)continue;
    if(!importedIds.has(edge.from)||!importedIds.has(edge.to))continue;
    const existing=tree.getEdge?.(edge.id,{chatId:storyId})??null;
    if(!existing)tree.linkEdge(edge);
    edges.push(edge.id);
  }

  return Object.freeze({
    kind:'NexusWorldTreeLegacyMemoryImport',
    chatId:storyId,
    inputCount:input.length,
    created:Object.freeze(created),
    updated:Object.freeze(updated),
    unchanged:Object.freeze(unchanged),
    edges:Object.freeze(edges),
  });
}

export function legacyMemoryWorldNodeId(chatId,memoryId){
  return memoryNodeId(chatId,memoryId);
}
