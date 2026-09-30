import { KnowledgeStatus } from '../contracts.js';
import { getNexusWorldTree } from '../../../world-tree/index.js';

const clone=(value)=>value==null?value:structuredClone(value);
const STATUS=new Set(Object.values(KnowledgeStatus));
const TITLES=/^(?:(?:the|a|an|lady|lord|sir|dame|mr|mrs|ms|miss|dr|captain|commander|king|queen|prince|princess)\s+)+/i;
const uniq=(values=[])=>[...new Set((values??[]).filter(v=>v!=null&&String(v).trim()).map(v=>String(v).trim()))];

export function normalizeWorldTreeAlias(value){
  return String(value??'').normalize('NFKC').trim().replace(TITLES,'').replace(/\s+/g,' ').toLocaleLowerCase();
}
function normalizeStatus(value,{fallback=KnowledgeStatus.UNRESOLVED}={}){
  const text=String(value??'').trim().toUpperCase().replaceAll('-','_');
  return STATUS.has(text)?text:fallback;
}
function derivedTitleAlias(value){
  const text=String(value??'').trim();
  const match=text.match(/^(.{1,80}?)\s+(?:relationship|relationships|dynamic|bond|personality|demeanor|presence|voice|identity|role)(?:\b|\s*[:—–-])/iu);
  return match?.[1]?.trim()||null;
}
export function loreNodeId(book,uid){return `lore:${String(book)}:${Number(uid)}`;}
export function memoryNodeId(id){return `memory:${String(id)}`;}
export function characterNodeId(bank){return `character:${String(bank?.storyId??'global')}:${String(bank?.id??bank?.character??'unknown')}`;}

export function loreNodeFromEntry({book,entry,candidate=null,sourceRevisionRef=null}={}){
  const uid=Number(entry?.uid??candidate?.uid);
  if(!String(book||'').trim()||!Number.isFinite(uid))throw new TypeError('Lore World Tree node requires book and uid');
  const temporal=entry?.extensions?.nexusTemporal??entry?.nexusTemporal??{};
  const legacyStatus=entry?.temporalStatus??entry?.status??entry?.metadata?.temporalStatus??entry?.metadata?.status??null;
  let status=normalizeStatus(temporal.status??legacyStatus);
  if((temporal.supersededBy??entry?.supersededBy)!=null)status=KnowledgeStatus.SUPERSEDED;
  if(entry?.historical===true||entry?.metadata?.historical===true)status=KnowledgeStatus.HISTORICAL;
  const explicitEdges=Array.isArray(entry?.extensions?.nexusWorldTree?.edges)?entry.extensions.nexusWorldTree.edges:[];
  return Object.freeze({
    id:loreNodeId(book,uid),kind:'lore',scope:'global',
    revision:Number(entry?.extensions?.nexusWorldTree?.revision??entry?.extensions?.nexusTemporal?.revision??1)||1,
    sourceRefs:Object.freeze(uniq([sourceRevisionRef,`lore:${book}:${uid}`])),
    temporalStatus:status,supersededBy:temporal.supersededBy??entry?.supersededBy??null,
    aliases:Object.freeze(uniq([entry?.comment,entry?.title,candidate?.title,derivedTitleAlias(entry?.comment??entry?.title??candidate?.title),...(Array.isArray(entry?.key)?entry.key:[]),...(Array.isArray(entry?.keysecondary)?entry.keysecondary:[]),...(Array.isArray(entry?.extensions?.nexusWorldTree?.aliases)?entry.extensions.nexusWorldTree.aliases:[])])),
    edges:Object.freeze(explicitEdges.map(edge=>Object.freeze({to:String(edge?.to??''),meaning:String(edge?.meaning??'RELATED_TO'),sourceRefs:Object.freeze(uniq(edge?.sourceRefs??[sourceRevisionRef]))})).filter(edge=>edge.to)),
    payload:Object.freeze({book:String(book),uid,title:String(entry?.comment??entry?.title??candidate?.title??''),content:String(entry?.content??candidate?.content??''),nodeId:candidate?.nodeId??null,nodeLabel:candidate?.nodeLabel??null,path:Array.isArray(candidate?.path)?[...candidate.path]:[]}),
  });
}
export function memoryNodeFromRecord(record,{chatId=null}={}){
  if(!record?.id)throw new TypeError('Memory World Tree node requires id');
  const rawStatus=record?.temporalStatus??record?.metadata?.temporalStatus??KnowledgeStatus.HISTORICAL;
  return Object.freeze({
    id:memoryNodeId(record.id),kind:'memory',scope:chatId==null?'global':String(chatId),
    revision:Number(record?.updatedAt??record?.createdAt??1)||1,
    sourceRefs:Object.freeze(uniq(record?.sourceMessageIds??[])),
    temporalStatus:normalizeStatus(rawStatus,{fallback:KnowledgeStatus.HISTORICAL}),
    supersededBy:record?.supersededBy??null,
    aliases:Object.freeze(uniq([...(record?.characters??[]),...(record?.locations??[]),...(record?.topics??[]),...(record?.threads??[])])),
    edges:Object.freeze([]),
    payload:Object.freeze({id:String(record.id),text:String(record?.text??''),layer:Number(record?.layer??0)}),
  });
}
export function characterNodeFromBank(bank){
  if(!bank?.id&&!bank?.character)throw new TypeError('Character World Tree node requires id or character');
  return Object.freeze({
    id:characterNodeId(bank),kind:'character',scope:String(bank?.storyId??'global'),
    revision:Number(bank?.state?.revision??bank?.updatedAt??1)||1,
    sourceRefs:Object.freeze(uniq((bank?.linkedRefs??[]).map(ref=>`lore:${ref.book}:${ref.uid}`))),
    temporalStatus:KnowledgeStatus.CURRENT,supersededBy:null,
    aliases:Object.freeze(uniq([bank?.character,bank?.cardBinding?.name,...(bank?.state?.aliases??[])])),
    edges:Object.freeze((bank?.linkedRefs??[]).map(ref=>Object.freeze({to:loreNodeId(ref.book,ref.uid),meaning:'SUPPORTED_BY_LORE',sourceRefs:Object.freeze([`lore:${ref.book}:${ref.uid}`])}))),
    payload:Object.freeze({bankId:String(bank?.id??''),role:String(bank?.role??'supporting')}),
  });
}

function canonicalProjectedId(node){
  const kind=String(node?.kind??'').toUpperCase();
  const data=node?.data??{};
  if(kind==='LORE_FACT'&&String(data.book??'').trim()&&Number.isFinite(Number(data.uid))){
    return loreNodeId(data.book,Number(data.uid));
  }
  if(kind==='MEMORY'){
    const sourceId=node?.provenance?.sourceIds?.[0]??data?.id??null;
    if(sourceId!=null&&String(sourceId).trim())return memoryNodeId(sourceId);
  }
  return String(node?.id??'');
}
function canonicalKind(node){
  const kind=String(node?.kind??'').toUpperCase();
  if(kind==='LORE_FACT')return'lore';
  if(kind==='MEMORY')return'memory';
  if(kind==='CHARACTER'||kind==='CHARACTER_STATE')return'character';
  if(kind==='LOCATION')return'location';
  if(kind==='ITEM')return'item';
  if(kind==='THREAD')return'thread';
  if(kind==='SCENE')return'scene';
  return kind.toLocaleLowerCase().replaceAll('_','-');
}
function canonicalScope(node){
  return String(node?.scope?.type??'').toUpperCase()==='GLOBAL'?'global':String(node?.scope?.chatId??'');
}
function canonicalSourceRefs(node){
  return uniq([
    ...(node?.provenance?.sourceRevisionIds??[]),
    ...(node?.provenance?.sourceIds??[]),
    ...(node?.provenance?.provenanceRefs??[]),
    ...(node?.provenance?.messageRefs??[]).flatMap(ref=>[ref?.messageId,ref?.messageRevision]),
  ]);
}
function canonicalAliases(node){
  const data=node?.data??{};
  const kind=String(node?.kind??'').toUpperCase();
  if(kind==='LORE_FACT')return uniq([data.label,derivedTitleAlias(data.label),...(data.keys??[])]);
  if(kind==='MEMORY')return uniq([...(data.characters??[]),...(data.locations??[]),...(data.topics??[]),...(data.threads??[])]);
  if(kind==='CHARACTER'||kind==='CHARACTER_STATE')return uniq([data.label,data.cardName,data.name,...(data.aliases??[])]);
  return uniq([data.label,data.name,data.title,...(data.aliases??[])]);
}
function canonicalPayload(node){
  const data=node?.data??{},kind=String(node?.kind??'').toUpperCase();
  if(kind==='LORE_FACT')return Object.freeze({
    canonicalId:String(node.id),
    book:String(data.book??''),
    uid:Number(data.uid),
    title:String(data.label??''),
    content:String(data.content??''),
    nodeId:node.parentId??null,
    nodeLabel:null,
    path:[],
  });
  if(kind==='MEMORY')return Object.freeze({
    canonicalId:String(node.id),
    id:String(node?.provenance?.sourceIds?.[0]??''),
    text:String(data.text??''),
    layer:Number(data.layer??0),
  });
  if(kind==='CHARACTER'||kind==='CHARACTER_STATE')return Object.freeze({
    canonicalId:String(node.id),
    bankId:String(node?.provenance?.sourceIds?.[0]??''),
    role:String(data.role??'supporting'),
  });
  return Object.freeze({canonicalId:String(node.id),...clone(data)});
}
function projectCanonicalSnapshot(snapshot={}){
  const nodes=Array.isArray(snapshot?.nodes)?snapshot.nodes:[];
  const edges=Array.isArray(snapshot?.edges)?snapshot.edges:[];
  const idMap=new Map(nodes.map(node=>[String(node.id),canonicalProjectedId(node)]));
  const outgoing=new Map();
  for(const edge of edges){
    const key=String(edge?.from??'');
    if(!outgoing.has(key))outgoing.set(key,[]);
    outgoing.get(key).push(edge);
  }
  return nodes.map(node=>{
    const id=idMap.get(String(node.id))||String(node.id);
    const projectedEdges=(outgoing.get(String(node.id))??[]).map(edge=>Object.freeze({
      to:idMap.get(String(edge.to))||String(edge.to),
      meaning:String(edge.relation??'RELATED_TO'),
      sourceRefs:Object.freeze(uniq([
        ...(edge?.provenance?.sourceRevisionIds??[]),
        ...(edge?.provenance?.sourceIds??[]),
        ...(edge?.provenance?.provenanceRefs??[]),
      ])),
    }));
    return Object.freeze({
      id,
      canonicalId:String(node.id),
      kind:canonicalKind(node),
      scope:canonicalScope(node),
      revision:Number(node.revision??1)||1,
      sourceRefs:Object.freeze(canonicalSourceRefs(node)),
      temporalStatus:normalizeStatus(node?.temporal?.status),
      supersededBy:node?.temporal?.supersededBy?.[0]??null,
      aliases:Object.freeze(canonicalAliases(node)),
      edges:Object.freeze(projectedEdges),
      payload:canonicalPayload(node),
    });
  });
}

export class NexusWorldTreeReadApi{
  #nodes=new Map();#aliasIndex=new Map();#sourceIndex=new Map();#canonicalIndex=new Map();
  constructor({nodes=[],owner='STANDALONE',worldRevision=0}={}){
    this.owner=String(owner||'STANDALONE');
    this.worldRevision=Math.max(0,Number(worldRevision)||0);
    for(const node of nodes)this.upsertNode(node);
  }
  clear(){this.#nodes.clear();this.#aliasIndex.clear();this.#sourceIndex.clear();this.#canonicalIndex.clear();}
  upsertNode(node){
    if(!node?.id)throw new TypeError('World Tree node id is required');
    const copy=clone(node);this.#nodes.set(String(copy.id),copy);
    const canonicalId=String(copy?.canonicalId??copy?.payload?.canonicalId??'').trim();
    if(canonicalId)this.#canonicalIndex.set(canonicalId,String(copy.id));
    for(const alias of copy.aliases??[]){const key=normalizeWorldTreeAlias(alias);if(!key)continue;if(!this.#aliasIndex.has(key))this.#aliasIndex.set(key,new Set());this.#aliasIndex.get(key).add(String(copy.id));}
    for(const ref of copy.sourceRefs??[]){const key=String(ref);if(!this.#sourceIndex.has(key))this.#sourceIndex.set(key,new Set());this.#sourceIndex.get(key).add(String(copy.id));}
    return this.getNode(copy.id);
  }
  getNode(id){
    const key=String(id);
    const projected=this.#nodes.has(key)?key:this.#canonicalIndex.get(key);
    const node=projected?this.#nodes.get(projected):null;
    return node?clone(node):null;
  }
  findByAlias(name,scope=null){const ids=[...(this.#aliasIndex.get(normalizeWorldTreeAlias(name))??[])];return ids.map(id=>this.#nodes.get(id)).filter(Boolean).filter(node=>scope==null||node.scope==='global'||String(node.scope)===String(scope)).map(clone);}
  edgesFrom(id){return(this.getNode(id)?.edges??[]).map(clone);}
  nodesFor(sourceRef){return[...(this.#sourceIndex.get(String(sourceRef))??[])].map(id=>this.getNode(id)).filter(Boolean);}
  temporalStatus(id){return this.getNode(id)?.temporalStatus??KnowledgeStatus.UNRESOLVED;}
  allNodes(){return[...this.#nodes.values()].map(clone);}
  diagnostics(){return Object.freeze({owner:this.owner,worldRevision:this.worldRevision,nodeCount:this.#nodes.size,canonical:this.owner==='WORLD_TREE'});}
}

export function createCanonicalWorldTreeReadApi({
  chatId=null,
  worldTree=getNexusWorldTree(),
  limit=5000,
}={}){
  if(!worldTree?.read)throw new TypeError('Canonical Nexus World Tree owner is required');
  const snapshot=worldTree.read({chatId,includeOverlays:false,limit});
  return new NexusWorldTreeReadApi({
    nodes:projectCanonicalSnapshot(snapshot),
    owner:'WORLD_TREE',
    worldRevision:snapshot.worldRevision,
  });
}
