import { KnowledgeStatus } from '../contracts.js';

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
    aliases:Object.freeze(uniq([entry?.comment,entry?.title,candidate?.title,...(Array.isArray(entry?.key)?entry.key:[]),...(Array.isArray(entry?.keysecondary)?entry.keysecondary:[]),...(Array.isArray(entry?.extensions?.nexusWorldTree?.aliases)?entry.extensions.nexusWorldTree.aliases:[])])),
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
export class NexusWorldTreeReadApi{
  #nodes=new Map();#aliasIndex=new Map();#sourceIndex=new Map();
  constructor({nodes=[]}={}){for(const node of nodes)this.upsertNode(node);}
  clear(){this.#nodes.clear();this.#aliasIndex.clear();this.#sourceIndex.clear();}
  upsertNode(node){
    if(!node?.id)throw new TypeError('World Tree node id is required');
    const copy=clone(node);this.#nodes.set(String(copy.id),copy);
    for(const alias of copy.aliases??[]){const key=normalizeWorldTreeAlias(alias);if(!key)continue;if(!this.#aliasIndex.has(key))this.#aliasIndex.set(key,new Set());this.#aliasIndex.get(key).add(String(copy.id));}
    for(const ref of copy.sourceRefs??[]){const key=String(ref);if(!this.#sourceIndex.has(key))this.#sourceIndex.set(key,new Set());this.#sourceIndex.get(key).add(String(copy.id));}
    return this.getNode(copy.id);
  }
  getNode(id){const node=this.#nodes.get(String(id));return node?clone(node):null;}
  findByAlias(name,scope=null){const ids=[...(this.#aliasIndex.get(normalizeWorldTreeAlias(name))??[])];return ids.map(id=>this.#nodes.get(id)).filter(Boolean).filter(node=>scope==null||node.scope==='global'||String(node.scope)===String(scope)).map(clone);}
  edgesFrom(id){return(this.#nodes.get(String(id))?.edges??[]).map(clone);}
  nodesFor(sourceRef){return[...(this.#sourceIndex.get(String(sourceRef))??[])].map(id=>this.getNode(id)).filter(Boolean);}
  temporalStatus(id){return this.#nodes.get(String(id))?.temporalStatus??KnowledgeStatus.UNRESOLVED;}
  allNodes(){return[...this.#nodes.values()].map(clone);}
}
