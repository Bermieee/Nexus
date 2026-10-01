import {builder2Fingerprint,createBuilder2Source} from './contracts.js';
import {worldBuildSourceId} from './world-plan.js';

export function readBuilderWorldContext({worldTree,chatId=null,selectedSources=[],authorizedSourceIds=[]}={}) {
  if (!worldTree?.iterateNodes) throw new TypeError('Canonical World Tree owner is required');
  const allowed=new Set(authorizedSourceIds), sources=[], excluded=[];
  for(const input of selectedSources){
    const sourceId=worldBuildSourceId(input.book,input.uid);
    if(!allowed.has(sourceId)){excluded.push({sourceId,reason:'UNAUTHORIZED_SOURCE'});continue;}
    sources.push({...structuredClone(input),sourceId,sourceKey:sourceId});
  }
  const visible=[...worldTree.iterateNodes({chatId})].filter(node=>{
    if(node.kind==='WORLD'||node.kind==='LORE_GROUP'||node.kind==='LORE_SOURCE')return true;
    if(node.kind==='LORE_FACT')return allowed.has(worldBuildSourceId(node.data.book,node.data.uid));
    return node.scope.type==='CHAT' ? node.scope.chatId===chatId : (node.provenance.sourceIds??[]).some(id=>allowed.has(id));
  });
  const ids=new Set(visible.map(n=>n.id));
  const relationships=(worldTree.exportState().edges??[]).filter(edge=>ids.has(edge.from)&&ids.has(edge.to)&&(edge.scope.type==='GLOBAL'||edge.scope.chatId===chatId));
  const groups=visible.filter(n=>n.kind==='LORE_GROUP'||n.kind==='WORLD');
  const entities=visible.filter(n=>['CHARACTER','ENTITY','LOCATION','ITEM'].includes(n.kind));
  const identityMatches=[];
  for(const source of sources)for(const entity of entities){
    const name=entity.data.label??entity.data.name;
    if(name&&String(name).toLocaleLowerCase()===String(source.title).toLocaleLowerCase()) identityMatches.push({sourceId:source.sourceId,candidateId:entity.id,status:'UNRESOLVED',reason:'Name similarity requires identity evidence'});
  }
  return {scope:{type:chatId?'CHAT':'GLOBAL',chatId},sources,groups,entities,relationships,nodes:visible,
    identityMatches,worldRevision:worldTree.revision,
    sourceFence:builder2Fingerprint(sources.map(s=>({sourceId:s.sourceId,fingerprint:s.fingerprint})).sort((a,b)=>a.sourceId.localeCompare(b.sourceId))),
    coverage:{requested:selectedSources.length,authorized:sources.length,excluded,complete:true}};
}

export function adaptWorldContextForBuilder2(context){
  const sources=context.sources.map(s=>createBuilder2Source({...s,sourceKey:s.sourceId}));
  const byId=new Map(context.groups.map(n=>[n.id,n]));
  const nodes=context.groups.map(group=>{
    const path=[],seen=new Set(); let current=group;
    while(current&&!seen.has(current.id)){seen.add(current.id);path.unshift(current.data?.label??current.data?.name??current.id);current=byId.get(current.parentId);}
    return {id:group.id,parentId:group.parentId,label:group.data?.label??group.data?.name??group.id,path,depth:path.length-1,entryUids:[],containerOnly:group.kind==='WORLD',canonicalNodeId:group.id};
  });
  return {book:'World Tree',worksetSources:sources,corpusSources:sources,worldRevision:context.worldRevision,sourceFence:context.sourceFence,
    treeInventory:{exists:true,nodes,membershipComplete:true,projectionOnly:true},worldContext:structuredClone(context)};
}
