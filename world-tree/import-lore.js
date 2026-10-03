import {
  WorldTreeNodeKind,
  WorldTreeScopeType,
  WorldTreeTemporalStatus,
} from './store.js';
import {applyDeterministicWorldTreeContribution,applyWorldTreeContribution,readPendingGlobalContributions} from './intake/runtime.js';
import {stableHash,stableStringify} from './intake/contribution.js';

const clone=value=>value==null?value:structuredClone(value);
const safe=value=>encodeURIComponent(String(value??''));
const uniq=values=>[...new Set((values??[]).map(v=>String(v??'').trim()).filter(Boolean))];
const list=value=>Array.isArray(value)?value:(value==null?[]:[value]);
const TEMPORAL_STATUSES=new Set(Object.values(WorldTreeTemporalStatus));
function stableObject(value){
  if(Array.isArray(value))return value.map(stableObject);
  if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(key=>[key,stableObject(value[key])]));
  return value;
}
function bookMetadata(data={}){
  const copy=clone(data??{});if(copy&&typeof copy==='object')delete copy.entries;return copy??{};
}

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

function entryFingerprint(entry={}){return JSON.stringify({version:'complete-lore-entry-v1',entry:stableObject(clone(entry))});}

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
    id,from,to,relation:'contains',scope,
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
      data:{...node.data,sourcePresent:false},
    });
    touched.push(node.id);
  }
  return touched;
}

export function importLegacyLoreBookToWorldTree(tree,{book,data,legacyTree=null}={}){
  if(!tree?.upsertNode)throw new TypeError('NexusWorldTree instance is required');
  const name=String(book??'').trim();
  if(!name)throw new TypeError('Lore import requires book');
  const entryRows=Object.entries(data?.entries??{}).filter(([,entry])=>Number.isFinite(Number(entry?.uid)));
  const entries=entryRows.map(([,entry])=>entry);
  const liveIds=new Set(),created=[],updated=[],unchanged=[],edges=[];
  const sourceBookMetadata=bookMetadata(data);
  const bookFingerprint=JSON.stringify({version:'complete-lore-book-v1',metadata:stableObject(sourceBookMetadata),tree:stableObject(clone(legacyTree??null)),entryKeys:entryRows.map(([key,entry])=>[String(key),Number(entry.uid)])});

  const bookNode={
    id:loreBookWorldNodeId(name),
    kind:WorldTreeNodeKind.LORE_SOURCE,
    parentId:'world:nexus',
    scope:{type:WorldTreeScopeType.GLOBAL},
    provenance:{sourceType:'SILLYTAVERN_LOREBOOK',sourceIds:[name],sourceRevisionIds:[bookFingerprint],importedFrom:'legacy-lorebook'},
    temporal:{status:WorldTreeTemporalStatus.CURRENT},
    data:{
      label:name,book:name,entryCount:entries.length,sourcePresent:true,
      sourceBookMetadata,sourceTree:clone(legacyTree??null),
      importedFrom:'legacy-lorebook',importFingerprint:bookFingerprint,
    },
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
        sourcePresent:true,
        sourceGroup:clone(source),
        entryUids:(source.entryUids??[]).map(Number).filter(Number.isFinite),
        importedFrom:'legacy-lorebook',
        importFingerprint:groupFingerprint(source),
      },
    };
    liveIds.add(payload.id);
    const result=upsertIfChanged(tree,payload);
    ({created,updated,unchanged}[result.status]??unchanged).push(result.id);
    edges.push(ensureContainsEdge(tree,{book:name,from:parentWorldId,to:payload.id,sourceIds:[String(source.id??'group')]}));
  }

  for(const [sourceEntryKey,entry] of entryRows){
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
        sourcePresent:true,
        sourceEntryKey:String(sourceEntryKey),
        sourceEntry:clone(entry),
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

export function legacyLoreTemporal(entry={}){return clone(temporalForEntry(entry));}

function contributionForLoreNode(payload,{lineageId,revision,edges=[]}={}){
  return {kind:'Contribution',source:'lore',scope:{type:'GLOBAL'},sourceRefs:[{loreLineageId:lineageId,book:payload.data.book,revision}],key:lineageId+':'+revision,mentions:[],
    nodes:[{tempId:payload.id,kind:payload.kind,label:payload.data.label,fields:{...clone(payload.data),parentId:payload.parentId},temporal:clone(payload.temporal),sourceProvenance:clone(payload.provenance),authority:'CANON'}],edges};
}
function containsContributionEdge(book,from,to,{removed=false}={}){
  return {edgeId:'lore-contains:'+safe(book)+':'+safe(from)+'->'+safe(to),from,to,meaning:'contains',authority:'CANON',...(removed?{temporalStatus:'SUPERSEDED'}:{})};
}
function loreEntryPayload(name,key,entry,parentId,{existing=null,removed=false}={}){
  const uid=Number(entry.uid),fingerprint=entryFingerprint(entry);
  return {id:loreFactWorldNodeId(name,uid),kind:'LORE_FACT',parentId,scope:{type:'GLOBAL'},
    provenance:{sourceType:'SILLYTAVERN_WORLD_INFO',sourceIds:[name,String(uid)],sourceRevisionIds:[fingerprint],importedFrom:'legacy-lorebook'},
    temporal:removed?{...clone(existing?.temporal??temporalForEntry(entry)),status:'SUPERSEDED',reason:'legacy-lore-source-missing'}:temporalForEntry(entry),
    data:{...clone(existing?.data??{}),label:String(entry.comment||entry.key?.[0]||('Lore UID '+uid)),content:String(entry.content||''),keys:Array.isArray(entry.key)?entry.key.map(String):[],
      constant:entry.constant===true,selective:entry.selective===true,disabled:entry.disable===true,order:Number(entry.order)||0,book:name,uid,sourcePresent:!removed,sourceEntryKey:String(key),sourceEntry:clone(entry),importedFrom:'legacy-lorebook',importFingerprint:fingerprint}};
}
function aliasesInLoreText(text,alias){
  const normalize=value=>' '+String(value??'').normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim()+' ';
  return String(alias??'').trim().length>=3&&normalize(text).includes(normalize(alias));
}
function buildLoreSemanticContribution(tree,{book,entry,removed=false}={}){
  const id=loreFactWorldNodeId(book,entry.uid),revision=stableHash({entry,removed}),lineage='lore-semantic:'+book+':'+entry.uid,mentions=[],edges=[],seenAliases=new Set();
  if(!removed)for(const node of tree.iterateNodes({chatId:null})){
    if(node.id===id||node.data?.book!==book||node.temporal?.status==='SUPERSEDED'||!['LORE_FACT','ENTITY','LOCATION','ITEM','CHARACTER'].includes(node.kind))continue;
    const alias=[node.data?.label,node.data?.name,...(node.data?.keys??[]),...(node.data?.aliases??[])].filter(Boolean).find(value=>aliasesInLoreText(entry.content,value));if(!alias)continue;
    const aliasKey=String(alias).normalize('NFKC').toLocaleLowerCase();if(seenAliases.has(aliasKey))continue;seenAliases.add(aliasKey);
    const mentionId='lore-mention:'+stableHash(aliasKey);mentions.push({mentionId,text:String(alias),kindHint:node.kind,contextSnippetHash:stableHash([entry.uid,entry.content,alias])});
    edges.push({from:id,to:mentionId,meaning:'about',authority:'CANON',sourceField:'content',sourceSnippetHash:stableHash([entry.content,alias])});
  }
  return {kind:'Contribution',source:'lore',scope:{type:'GLOBAL'},sourceRefs:[{loreLineageId:lineage,book,uid:Number(entry.uid),revision}],key:lineage+':'+revision,nodes:[],mentions,edges};
}

// Whole-book host reads are needed to compare source fingerprints. Only changed
// source rows and structural controls are written; semantic extraction is limited
// to the entries named by this delta, with no globally invented identities.
export async function reconcileLoreBookContributions(tree,{book,data,legacyTree=null,context=null,assertFresh=()=>{}}={}){
  const name=String(book??'').trim();if(!name)throw new TypeError('Lore reconciliation requires book');assertFresh();
  const entryRows=Object.entries(data?.entries??{}).filter(([,entry])=>Number.isFinite(Number(entry?.uid))),byUid=new Map();
  for(const [key,entry] of entryRows){const uid=Number(entry.uid);if(byUid.has(uid))throw new Error('WORLD_TREE_LORE_AMBIGUOUS_UID:'+uid);byUid.set(uid,{key,entry});}
  const bookId=loreBookWorldNodeId(name),source=tree.getNode(bookId),groups=[],uidHomes=new Map();
  if(legacyTree?.root)flattenLegacyGroups(legacyTree.root,name,bookId,groups,uidHomes);
  const receipts=[],changed=[],removed=[],controls=[];const fresh=()=>{assertFresh();return true;};
  const sourceBookMetadata=bookMetadata(data),bookFingerprint=JSON.stringify({version:'complete-lore-book-v1',metadata:stableObject(sourceBookMetadata),tree:stableObject(clone(legacyTree??null)),entryKeys:entryRows.map(([key,entry])=>[String(key),Number(entry.uid)])});
  if(!source||source.data?.importFingerprint!==bookFingerprint||source.data?.sourcePresent===false){
    const payload={id:bookId,kind:'LORE_SOURCE',parentId:'world:nexus',scope:{type:'GLOBAL'},temporal:{status:'CURRENT'},
      provenance:{sourceType:'SILLYTAVERN_LOREBOOK',sourceIds:[name],sourceRevisionIds:[bookFingerprint],importedFrom:'legacy-lorebook'},
      data:{label:name,book:name,entryCount:entryRows.length,sourcePresent:true,sourceBookMetadata,sourceTree:clone(legacyTree),importedFrom:'legacy-lorebook',importFingerprint:bookFingerprint}};
    receipts.push(applyDeterministicWorldTreeContribution(contributionForLoreNode(payload,{lineageId:'lore-book:'+name,revision:stableHash(bookFingerprint),edges:[containsContributionEdge(name,'world:nexus',bookId)]}),{tree,context,isFresh:fresh}));controls.push(bookId);
  }
  const liveGroupIds=new Set();
  for(const {source:group,worldId,parentWorldId} of groups){
    liveGroupIds.add(worldId);const existing=tree.getNode(worldId),fingerprint=groupFingerprint(group);
    if(existing?.data?.importFingerprint===fingerprint&&existing.parentId===parentWorldId&&existing.data?.sourcePresent!==false)continue;
    const payload={id:worldId,kind:'LORE_GROUP',parentId:parentWorldId,scope:{type:'GLOBAL'},temporal:{status:'CURRENT'},
      provenance:{sourceType:'NEXUS_LEGACY_LORE_TREE',sourceIds:[name,String(group.id??group.label??worldId)],sourceRevisionIds:[String(legacyTree?.lastBuilt??'legacy-tree')],importedFrom:'legacy-lorebook'},
      data:{label:String(group.label||'Lore group'),summary:String(group.summary||''),keywords:uniq(group.keywords),book:name,structuralOnly:true,sourcePresent:true,sourceGroup:clone(group),entryUids:(group.entryUids??[]).map(Number).filter(Number.isFinite),importedFrom:'legacy-lorebook',importFingerprint:fingerprint}};
    receipts.push(applyDeterministicWorldTreeContribution(contributionForLoreNode(payload,{lineageId:'lore-group:'+name+':'+worldId,revision:stableHash([fingerprint,parentWorldId]),edges:[containsContributionEdge(name,parentWorldId,worldId)]}),{tree,context,isFresh:fresh}));controls.push(worldId);
  }
  for(const existing of tree.iterateNodes({chatId:null,kind:'LORE_GROUP'})){
    if(existing.data?.book!==name||existing.data?.sourcePresent===false||liveGroupIds.has(existing.id))continue;
    const payload={...existing,temporal:{...existing.temporal,status:'SUPERSEDED',reason:'legacy-lore-source-missing'},data:{...existing.data,sourcePresent:false}};
    receipts.push(applyDeterministicWorldTreeContribution(contributionForLoreNode(payload,{lineageId:'lore-group:'+name+':'+existing.id,revision:stableHash(['removed',existing.data.importFingerprint]),edges:[containsContributionEdge(name,existing.parentId,existing.id,{removed:true})]}),{tree,context,isFresh:fresh}));controls.push(existing.id);
  }
  for(const {key,entry} of byUid.values()){
    const existing=tree.getNode(loreFactWorldNodeId(name,entry.uid)),parent=uidHomes.get(Number(entry.uid))??bookId,payload=loreEntryPayload(name,key,entry,parent,{existing});
    if(existing?.data?.sourcePresent!==false&&existing?.data?.importFingerprint===payload.data.importFingerprint&&existing.parentId===parent&&existing.data.sourceEntryKey===String(key)&&stableStringify(existing.data.sourceEntry)===stableStringify(entry)&&stableStringify(existing.temporal)===stableStringify(payload.temporal))continue;
    changed.push({key,entry});
    const revision=stableHash([payload.data.importFingerprint,key,parent]);
    const edges=[containsContributionEdge(name,parent,payload.id)];
    if(existing?.parentId&&existing.parentId!==parent)edges.push(containsContributionEdge(name,existing.parentId,payload.id,{removed:true}));
    receipts.push(applyDeterministicWorldTreeContribution(contributionForLoreNode(payload,{lineageId:'lore-record:'+name+':'+entry.uid,revision,edges}),{tree,context,isFresh:fresh}));
  }
  for(const existing of tree.iterateNodes({chatId:null,kind:'LORE_FACT'})){
    if(existing.data?.book!==name||existing.data?.sourcePresent===false||byUid.has(Number(existing.data.uid)))continue;
    const entry=existing.data.sourceEntry??{uid:existing.data.uid},payload=loreEntryPayload(name,existing.data.sourceEntryKey??entry.uid,entry,existing.parentId??bookId,{existing,removed:true});removed.push({entry});
    const incoming=[...tree.iterateEdges({chatId:null})].filter(edge=>edge.scope.type==='GLOBAL'&&edge.to===payload.id&&edge.relation!=='contains'&&edge.temporal.status==='CURRENT'&&tree.getNode(edge.from)?.data?.book===name).map(edge=>({edgeId:edge.id,from:edge.from,to:payload.id,meaning:edge.relation,subtype:edge.data?.subtype??null,authority:'CANON',temporalStatus:'SUPERSEDED'}));
    receipts.push(applyDeterministicWorldTreeContribution(contributionForLoreNode(payload,{lineageId:'lore-record:'+name+':'+entry.uid,revision:stableHash(['removed',payload.data.importFingerprint]),edges:[containsContributionEdge(name,payload.parentId,payload.id,{removed:true}),...incoming]}),{tree,context,isFresh:fresh}));
  }
  for(const row of [...changed,...removed]){assertFresh();receipts.push(await applyWorldTreeContribution(buildLoreSemanticContribution(tree,{book:name,entry:row.entry,removed:removed.includes(row)}),{tree,context,isFresh:fresh}));}
  for(const [ledgerKey,pending] of Object.entries(readPendingGlobalContributions({context}))){
    if(pending.book!==name||pending.contribution?.source!=='lore'||pending.lastAttemptedRevision===tree.revision||tree.latestContributionRecord(pending.lineageKey)?.ledgerKey!==ledgerKey)continue;
    assertFresh();receipts.push(await applyWorldTreeContribution(pending.contribution,{tree,context,isFresh:fresh,generationId:pending.generationId}));
  }
  assertFresh();
  return Object.freeze({kind:'NexusWorldTreeLoreDeltaReconciliation',book:name,changedUids:Object.freeze(changed.map(row=>Number(row.entry.uid))),removedUids:Object.freeze(removed.map(row=>Number(row.entry.uid))),controlNodeIds:Object.freeze(controls),receipts:Object.freeze(receipts),entryCount:byUid.size});
}
