import {
  WorldTreeNodeKind,
  WorldTreeScopeType,
  WorldTreeTemporalStatus,
} from './store.js';

const clone=value=>value==null?value:structuredClone(value);
const safe=value=>encodeURIComponent(String(value??''));
const uniq=values=>[...new Set((values??[]).map(v=>String(v??'').trim()).filter(Boolean))];
const list=value=>Array.isArray(value)?value:(value==null?[]:[value]);
const TEMPORAL_STATUSES=new Set(Object.values(WorldTreeTemporalStatus));

function importedTemporalStatus(value){
  const status=String(value??'').trim().toUpperCase().replaceAll('-','_');
  return TEMPORAL_STATUSES.has(status)?status:WorldTreeTemporalStatus.UNRESOLVED;
}

function temporalForEntry(entry={}){
  const temporal=entry?.extensions?.nexusTemporal??entry?.nexusTemporal??{};
  const metadata=entry?.metadata??{};
  const supersededBy=uniq(list(temporal.supersededBy??entry?.supersededBy));
  const supersedes=uniq(list(temporal.supersedes??entry?.supersedes));
  const contradictedBy=uniq(list(temporal.contradictedBy??entry?.contradictedBy));
  let status=importedTemporalStatus(
    temporal.status??entry?.temporalStatus??entry?.status??metadata?.temporalStatus??metadata?.status??null
  );
  if(supersededBy.length)status=WorldTreeTemporalStatus.SUPERSEDED;
  else if(entry?.historical===true||metadata?.historical===true)status=WorldTreeTemporalStatus.HISTORICAL;
  else if(contradictedBy.length)status=WorldTreeTemporalStatus.CONTRADICTED;
  return {
    status,
    validFrom:temporal.validFrom??entry?.validFrom??null,
    validUntil:temporal.validUntil??entry?.validUntil??null,
    supersedes,
    supersededBy,
    contradictedBy,
    reason:temporal.reason??entry?.temporalReason??null,
  };
}

export function loreBookWorldNodeId(book){return 'lorebook:'+safe(book);}
export function loreGroupWorldNodeId(book,groupId){return 'lore-group:'+safe(book)+':'+safe(groupId);}
export function loreFactWorldNodeId(book,uid){return 'lore-fact:'+safe(book)+':'+safe(uid);}

function entryFingerprint(entry={}){
  return JSON.stringify({
    uid:Number(entry.uid),
    comment:String(entry.comment??''),
    content:String(entry.content??''),
    key:Array.isArray(entry.key)?entry.key.map(String):[],
    constant:entry.constant===true,
    selective:entry.selective===true,
    disable:entry.disable===true,
    order:Number(entry.order)||0,
    position:entry.position??null,
    depth:entry.depth??null,
    probability:entry.probability??null,
    useProbability:entry.useProbability===true,
  });
}

function groupFingerprint(node={}){
  return JSON.stringify({
    id:String(node.id??''),
    label:String(node.label??''),
    summary:String(node.summary??''),
    keywords:uniq(node.keywords),
    entryUids:(node.entryUids??[]).map(Number).filter(Number.isFinite).sort((a,b)=>a-b),
  });
}

function upsertIfChanged(tree,payload,{chatId=null}={}){
  const existing=tree.getNode(payload.id,{chatId});
  const nextFp=payload?.data?.importFingerprint??null;
  const same=existing
    &&existing.temporal?.status===payload.temporal?.status
    &&existing.parentId===payload.parentId
    &&(!nextFp||existing.data?.importFingerprint===nextFp);
  if(same)return{status:'unchanged',id:payload.id};
  tree.upsertNode(payload);
  return{status:existing?'updated':'created',id:payload.id};
}

function ensureContainsEdge(tree,{book,from,to,scope={type:WorldTreeScopeType.GLOBAL},sourceIds=[]}){
  const id='lore-contains:'+safe(book)+':'+safe(from)+'->'+safe(to);
  if(!tree.getEdge(id,{chatId:null}))tree.linkEdge({
    id,from,to,relation:'CONTAINS',scope,
    provenance:{sourceType:'LEGACY_LORE_IMPORT',sourceIds:uniq([book,...sourceIds]),importedFrom:'legacy-lorebook'},
    temporal:{status:WorldTreeTemporalStatus.CURRENT},
    data:{book:String(book),importedFrom:'legacy-lorebook'},
  });
  return id;
}

function flattenLegacyGroups(root,book,parentWorldId,rows=[],uidHomes=new Map()){
  if(!root)return{rows,uidHomes};
  const worldId=loreGroupWorldNodeId(book,root.id||root.label||rows.length);
  const row={source:root,worldId,parentWorldId};
  rows.push(row);
  for(const uid of root.entryUids??[]){
    const n=Number(uid);if(Number.isFinite(n))uidHomes.set(n,worldId);
  }
  for(const child of root.children??[])flattenLegacyGroups(child,book,worldId,rows,uidHomes);
  return{rows,uidHomes};
}

function markMissingImportedLoreAsSuperseded(tree,{book,liveIds}){
  const snapshot=tree.read({chatId:null,includeOverlays:false,limit:5000});
  const touched=[];
  for(const node of snapshot.nodes){
    if(node?.data?.importedFrom!=='legacy-lorebook')continue;
    if(String(node?.data?.book??'')!==String(book))continue;
    if(liveIds.has(node.id))continue;
    if(node.temporal?.status===WorldTreeTemporalStatus.SUPERSEDED)continue;
    tree.upsertNode({
      ...node,
      scope:node.scope,
      provenance:node.provenance,
      temporal:{...node.temporal,status:WorldTreeTemporalStatus.SUPERSEDED,reason:'legacy-lore-source-missing'},
      data:node.data,
    });
    touched.push(node.id);
  }
  return touched;
}

export function importLegacyLoreBookToWorldTree(tree,{book,data,legacyTree=null}={}){
  if(!tree?.upsertNode)throw new TypeError('NexusWorldTree instance is required');
  const name=String(book??'').trim();
  if(!name)throw new TypeError('Lore import requires book');
  const entries=Object.values(data?.entries??{}).filter(entry=>Number.isFinite(Number(entry?.uid)));
  const liveIds=new Set(),created=[],updated=[],unchanged=[],edges=[];

  const bookNode={
    id:loreBookWorldNodeId(name),
    kind:WorldTreeNodeKind.LORE_SOURCE,
    parentId:'world:nexus',
    scope:{type:WorldTreeScopeType.GLOBAL},
    provenance:{sourceType:'SILLYTAVERN_LOREBOOK',sourceIds:[name],sourceRevisionIds:[String(legacyTree?.lastBuilt??entries.length)],importedFrom:'legacy-lorebook'},
    temporal:{status:WorldTreeTemporalStatus.CURRENT},
    data:{label:name,book:name,entryCount:entries.length,importedFrom:'legacy-lorebook',importFingerprint:JSON.stringify({name,entryCount:entries.length,lastBuilt:legacyTree?.lastBuilt??null})},
  };
  liveIds.add(bookNode.id);
  const bookResult=upsertIfChanged(tree,bookNode);
  ({created,updated,unchanged}[bookResult.status]??unchanged).push(bookResult.id);
  edges.push(ensureContainsEdge(tree,{book:name,from:'world:nexus',to:bookNode.id,sourceIds:[name]}));

  const groupRows=[],uidHomes=new Map();
  if(legacyTree?.root)flattenLegacyGroups(legacyTree.root,name,bookNode.id,groupRows,uidHomes);
  for(const {source,worldId,parentWorldId} of groupRows){
    const payload={
      id:worldId,
      kind:WorldTreeNodeKind.LORE_GROUP,
      parentId:parentWorldId,
      scope:{type:WorldTreeScopeType.GLOBAL},
      provenance:{sourceType:'NEXUS_LEGACY_LORE_TREE',sourceIds:[name,String(source.id??source.label??worldId)],sourceRevisionIds:[String(legacyTree?.lastBuilt??'legacy-tree')],importedFrom:'legacy-lorebook'},
      temporal:{status:WorldTreeTemporalStatus.CURRENT},
      data:{
        label:String(source.label||'Lore group'),
        summary:String(source.summary||''),
        keywords:uniq(source.keywords),
        book:name,
        structuralOnly:true,
        importedFrom:'legacy-lorebook',
        importFingerprint:groupFingerprint(source),
      },
    };
    liveIds.add(payload.id);
    const result=upsertIfChanged(tree,payload);
    ({created,updated,unchanged}[result.status]??unchanged).push(result.id);
    edges.push(ensureContainsEdge(tree,{book:name,from:parentWorldId,to:payload.id,sourceIds:[String(source.id??'group')]}));
  }

  for(const entry of entries){
    const uid=Number(entry.uid),id=loreFactWorldNodeId(name,uid),parentId=uidHomes.get(uid)??bookNode.id;
    const payload={
      id,
      kind:WorldTreeNodeKind.LORE_FACT,
      parentId,
      scope:{type:WorldTreeScopeType.GLOBAL},
      provenance:{
        sourceType:'SILLYTAVERN_WORLD_INFO',
        sourceIds:[name,String(uid)],
        sourceRevisionIds:[entryFingerprint(entry)],
        importedFrom:'legacy-lorebook',
      },
      temporal:temporalForEntry(entry),
      data:{
        label:String(entry.comment||entry.key?.[0]||('Lore UID '+uid)),
        content:String(entry.content||''),
        keys:Array.isArray(entry.key)?entry.key.map(String):[],
        constant:entry.constant===true,
        selective:entry.selective===true,
        disabled:entry.disable===true,
        order:Number(entry.order)||0,
        book:name,
        uid,
        importedFrom:'legacy-lorebook',
        importFingerprint:entryFingerprint(entry),
      },
    };
    liveIds.add(id);
    const result=upsertIfChanged(tree,payload);
    ({created,updated,unchanged}[result.status]??unchanged).push(result.id);
    edges.push(ensureContainsEdge(tree,{book:name,from:parentId,to:id,sourceIds:[String(uid)]}));
  }

  const superseded=markMissingImportedLoreAsSuperseded(tree,{book:name,liveIds});
  return Object.freeze({
    kind:'NexusWorldTreeLegacyLoreImport',
    book:name,
    entryCount:entries.length,
    groupCount:groupRows.length,
    created:Object.freeze(created),
    updated:Object.freeze(updated),
    unchanged:Object.freeze(unchanged),
    superseded:Object.freeze(superseded),
    edges:Object.freeze(edges),
  });
}

export async function importLegacyLoreCorpusToWorldTree(tree,{books=[],loadBook,getTree}={}){
  if(typeof loadBook!=='function')throw new TypeError('Lore corpus import requires loadBook');
  const results=[];
  for(const book of uniq(books)){
    const data=await loadBook(book);
    const legacyTree=typeof getTree==='function'?getTree(book):null;
    results.push(importLegacyLoreBookToWorldTree(tree,{book,data,legacyTree}));
  }
  return Object.freeze({kind:'NexusWorldTreeLegacyLoreCorpusImport',books:Object.freeze(results.map(row=>row.book)),results:Object.freeze(results)});
}
