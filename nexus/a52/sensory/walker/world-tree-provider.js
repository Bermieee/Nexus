import { KnowledgeStatus } from '../../contracts.js';
import { normalizeWorldTreeAlias } from '../../../../core/world-tree-api.js';
import { stableHash } from '../../browser-runtime-utils.js';
import { captureSensorySource, sensorySourceCurrent } from '../source-continuation.js';

const uniq=(values=[])=>[...new Set((values??[]).filter(Boolean).map(String))];
const cloneTraversal=(value)=>structuredClone(value);
const clean=(value)=>String(value??'').normalize('NFKC').replace(/\s+/g,' ').trim();
const words=(value)=>new Set(normalizeWorldTreeAlias(value).match(/[\p{L}\p{N}][\p{L}\p{N}'_-]{1,}/gu)??[]);
const relationTitle=/\b(relationship|relationships|dynamic|bond|marriage|relation|relations|beziehung|lien|mariage)\b/i;

function visibleAlias(alias){
  const value=normalizeWorldTreeAlias(alias);
  return value.length>=3&&!/^(?:the|and|for|with|from|into|this|that|current|history|lore)$/.test(value);
}
function containsAlias(text,alias){
  const hay=' '+normalizeWorldTreeAlias(text)+' ';
  const needle=' '+normalizeWorldTreeAlias(alias)+' ';
  return needle.length>3&&hay.includes(needle);
}
function nodeRevisionRefs(node,fallback=[]){
  return uniq(fallback.length?fallback:(node?.sourceRefs??[]));
}
function identityAnchorRows(rows=[]){
  const identityKinds=new Set(['character','entity','location','item','lore']);
  const eligible=(rows??[]).filter(row=>identityKinds.has(String(row?.kind??'').toLocaleLowerCase()));
  return eligible.length?eligible:[];
}
function graphAuthority(value){
  const authority=String(value??'').toUpperCase();
  if(authority==='CANON'||authority==='CARD')return'SOURCE_CANON';
  if(authority==='OBSERVED')return'OBSERVED';
  if(authority==='REMEMBERED')return'DERIVED';
  if(authority==='INFERRED')return'INFERRED';
  return'UNRESOLVED';
}
function edgeRow({id,from,to,meaning,target,sourceRevisionRefs,authorityClass='SOURCE_CANON',temporalStatus=null,temporal=null,sourceKind='LORE_GRAPH',subtype=null,weight=null,sourceValidation=null}){
  const targetText=String(target?.payload?.content??target?.payload?.text??target?.payload?.summary??target?.payload?.title??target?.aliases?.[0]??'');
  return {
    edgeId:String(id),
    sourceValidation,
    fromEntityId:String(from),
    toEntityId:String(to),
    edgeMeaning:String(meaning),
    sourceRevisionRefs:uniq(sourceRevisionRefs),
    dependencyRevisionRefs:[],
    authorityClass,
    temporalStatus:temporalStatus??target?.temporalStatus??KnowledgeStatus.UNRESOLVED,
    temporal:temporal??null,
    sourceKind,
    relationshipRefs:subtype?[String(subtype)]:[],
    providerWeight:Number(weight??1)||1,
    artifactRef:target?.kind==='lore'?{
      artifactId:String(target.id),artifactType:'NexusLoreEntry',
      book:String(target?.payload?.book??''),uid:Number(target?.payload?.uid),
    }:{artifactId:String(target?.id??to),artifactType:'WorldTreeNode'},
    representationRef:String(target?.id??to),
    representationRevision:Number(target?.revision??1)||1,
    representationText:subtype?String(meaning)+' ['+String(subtype)+'] '+targetText:targetText,
    evidenceIdentity:String(target?.id??to),
    drillbackRefs:target?.kind==='lore'?[{book:String(target?.payload?.book??''),uid:Number(target?.payload?.uid)}]:[],
  };
}

export function createWorldTreeGraphProvider({worldTree,sceneScan=null,chatId=null,sourceRevisionRefs=[],maxDerivedEdges=384,anchorAdvice={}}={}){
  if(!worldTree)throw new TypeError('worldTree is required');
  const nodes=worldTree.allNodes(),byId=new Map(nodes.map(node=>[String(node.id),node]));
  const explicit=new Map(),adjacency=new Map(),derived=new Map(),materials=new Map();
  const counters={examinedUnits:0,materializedEdges:0,materialScans:0};
  const pairRows=(from,to,meaning,sourceKind='LORE_GRAPH',authorityClass='SOURCE_CANON',metadata={})=>{
    const a=byId.get(String(from)),b=byId.get(String(to));if(!a||!b||a.id===b.id)return[];
    const refs=uniq(metadata.sourceRevisionRefs?.length?metadata.sourceRevisionRefs:[...nodeRevisionRefs(a),...nodeRevisionRefs(b),...sourceRevisionRefs]);
    const statuses=[a.temporalStatus,b.temporalStatus,metadata.temporalStatus].filter(Boolean);
    const constrainedStatus=['SUPERSEDED','HISTORICAL','CONTRADICTED','UNCERTAIN','UNRESOLVED'].find(status=>statuses.includes(status))??metadata.temporalStatus??null;
    const common={sourceRevisionRefs:refs,authorityClass,sourceKind,subtype:metadata.subtype??null,weight:metadata.weight??null,temporalStatus:constrainedStatus,temporal:metadata.temporal??null,
      sourceValidation:captureSensorySource(worldTree,[a.id,b.id],metadata.edgeId?[{from:a.id,id:metadata.edgeId,revision:metadata.edgeRevision}]:[])};
    const forwardId=metadata.edgeId??(meaning+':'+a.id+':'+b.id),reverseId=metadata.edgeId?(String(metadata.edgeId)+':reverse'):(meaning+'_REVERSE:'+b.id+':'+a.id);
    return [edgeRow({id:forwardId,from:a.id,to:b.id,meaning,target:b,...common}),edgeRow({id:reverseId,from:b.id,to:a.id,meaning:meaning+'_REVERSE',target:a,...common})];
  };
  // Canonical topology is already owner-authored. Alias-derived topology is
  // never expanded in this constructor (duplicate aliases can form N squared pairs).
  for(const node of nodes)for(const edge of node.edges??[])for(const row of pairRows(node.id,edge.to,String(edge.meaning??'relationship'),'WORLD_TREE_EDGE',graphAuthority(edge.authority),{
    edgeId:edge.id,edgeRevision:edge.revision??1,sourceRevisionRefs:edge.sourceRefs??[],subtype:edge.subtype??null,weight:edge.weight??null,temporalStatus:edge.temporalStatus??null,temporal:edge.temporal??null,
  })){
    if(explicit.has(row.edgeId))continue;explicit.set(row.edgeId,row);
    for(const id of [row.fromEntityId,row.toEntityId]){if(!adjacency.has(id))adjacency.set(id,[]);adjacency.get(id).push(row);}
  }
  const aliasRows=[];
  for(const node of nodes)for(const raw of node.aliases??[]){const alias=normalizeWorldTreeAlias(raw);if(visibleAlias(alias))aliasRows.push({nodeId:node.id,alias,key:JSON.stringify([node.id,alias])});}
  const aliasPositions=new Map(aliasRows.map((row,index)=>[row.key,index])),loreNodes=nodes.filter(node=>node.kind==='lore'),lorePositions=new Map(loreNodes.map((node,index)=>[node.id,index]));
  const material=id=>{if(!materials.has(id)){const node=byId.get(id);materials.set(id,[node?.payload?.title,node?.payload?.content].filter(Boolean).join(' '));counters.materialScans++;}return materials.get(id);};
  const edgeVersion=edge=>stableHash(edge.sourceValidation,{length:32});
  const topology=id=>stableHash((adjacency.get(id)??[]).map(edge=>[edge.edgeId,edgeVersion(edge)]),{length:32});
  const currentRefs=new Set(uniq([...sourceRevisionRefs,...nodes.flatMap(node=>node.sourceRefs??[]),...nodes.flatMap(node=>(node.edges??[]).flatMap(edge=>edge.sourceRefs??[]))]));
  const bindingKey=worldTree.readScopeKey??chatId;
  let lastCoverage=null;
  const query=(request={})=>{
    const started=globalThis.performance?.now?.()??Date.now(),clock=()=>globalThis.performance?.now?.()??Date.now();
    const maxEdges=Math.max(0,Math.min(request.maxEdges!=null&&Number.isFinite(Number(request.maxEdges))?Math.floor(Number(request.maxEdges)):192,8192));
    const maxDepth=Math.max(1,Math.min(Math.floor(Number(request.maxDepth)||3),12));
    const constructionGrant=Math.max(0,Math.min(Math.floor(Number(request.maxConstructionUnits??request.maxEdges??maxDerivedEdges)||0),8192));
    const latency=request.latencyBudgetMs==null?null:Math.max(0,Number(request.latencyBudgetMs)||0);
    const anchors=uniq(request.anchorEntityIds??[]).filter(id=>byId.has(id)),key=JSON.stringify([bindingKey,anchors]);
    const saved=request.continuation?.key===key?request.continuation:null;
    const queue=saved?cloneTraversal(saved.queue).filter(row=>byId.has(row.id)):anchors.map(id=>({id,depth:0,explicitCursor:0,outIndex:0,inIndex:0,pendingRows:[],matchedTargets:[]}));
    const visited=new Set(saved?.visited??anchors),edgeVersions={...(saved?.edgeVersions??{})},edgeSources={...(saved?.edgeSources??{})};
    const picked=[],frontier=[];let examinedUnits=0,budgetStopped=false;
    const admit=(edge,current)=>{
      if(!sensorySourceCurrent(edge.sourceValidation,worldTree))return;
      const version=edgeVersion(edge);if(edgeVersions[edge.edgeId]!==version){edgeVersions[edge.edgeId]=version;edgeSources[edge.edgeId]=edge.sourceValidation;picked.push(edge);}
      const next=edge.fromEntityId===current.id?edge.toEntityId:edge.fromEntityId;
      if(!visited.has(next)){visited.add(next);queue.push({id:next,depth:current.depth+1,explicitCursor:0,outIndex:0,inIndex:0,pendingRows:[],matchedTargets:[]});}
    };
    const build=(source,target)=>{
      const relation=relationTitle.test(String(byId.get(source)?.payload?.title??''))?'RELATIONSHIP_MENTION':'LORE_CROSS_REFERENCE';
      const rows=pairRows(source,target,relation,'LORE_GRAPH','INFERRED');
      for(const row of rows)if(!derived.has(row.edgeId)){derived.set(row.edgeId,row);counters.materializedEdges++;}
      return rows;
    };
    while(queue.length&&picked.length<maxEdges){
      const current=queue.shift(),node=byId.get(current.id);
      if(current.depth>=maxDepth){frontier.push(current);continue;}
      const signature=topology(current.id);
      if(current.topology&&current.topology!==signature)current.explicitCursor=0;current.topology=signature;
      if(current.nodeRevision!=null&&current.nodeRevision!==node.revision){current.outIndex=0;current.inIndex=0;current.outAfter=null;current.inAfter=null;current.matchedTargets=[];current.pendingRows=[];}
      current.nodeRevision=node.revision;
      if(current.outAfter&&aliasPositions.has(current.outAfter))current.outIndex=aliasPositions.get(current.outAfter)+1;
      if(current.inAfter&&lorePositions.has(current.inAfter))current.inIndex=lorePositions.get(current.inAfter)+1;
      const adjacent=adjacency.get(current.id)??[];
      let unfinished=false;
      while(picked.length<maxEdges){
        if(latency!==null&&clock()-started>=latency){budgetStopped=true;unfinished=true;break;}
        if(current.pendingRows?.length){admit(current.pendingRows.shift(),current);continue;}
        if((current.explicitCursor??0)<adjacent.length){admit(adjacent[current.explicitCursor++],current);continue;}
        const outgoing=node.kind==='lore'&&current.outIndex<aliasRows.length;
        const incoming=current.inIndex<loreNodes.length&&(node.aliases??[]).some(visibleAlias);
        if(!outgoing&&!incoming)break;
        if(examinedUnits>=constructionGrant){budgetStopped=true;unfinished=true;break;}
        examinedUnits++;counters.examinedUnits++;
        if(outgoing){
          const target=aliasRows[current.outIndex++];current.outAfter=target.key;
          if(target.nodeId!==current.id&&!current.matchedTargets.includes(target.nodeId)&&containsAlias(material(current.id),target.alias)){
            current.matchedTargets.push(target.nodeId);current.pendingRows=build(current.id,target.nodeId);
          }
        }else{
          const source=loreNodes[current.inIndex++];current.inAfter=source.id;
          if(source.id!==current.id&&(node.aliases??[]).some(alias=>visibleAlias(alias)&&containsAlias(material(source.id),alias)))current.pendingRows=build(source.id,current.id);
        }
      }
      const remains=(current.pendingRows?.length??0)>0||(current.explicitCursor??0)<adjacent.length||(node.kind==='lore'&&current.outIndex<aliasRows.length)||((node.aliases??[]).some(visibleAlias)&&current.inIndex<loreNodes.length);
      if(remains)queue.unshift(current);
      if(unfinished)break;
    }
    const pending=[...queue,...frontier];
    // Depth-frontier nodes with no possible source work do not need a page.
    const meaningful=pending.filter(row=>(adjacency.get(row.id)??[]).some(edge=>edgeVersions[edge.edgeId]!==edgeVersion(edge))||((byId.get(row.id)?.kind==='lore'&&aliasRows.length>1)||loreNodes.length>0));
    const complete=meaningful.length===0;
    const constructionComplete=meaningful.every(row=>{const node=byId.get(row.id);return !(node?.kind==='lore'&&row.outIndex<aliasRows.length)&&!((node?.aliases??[]).some(visibleAlias)&&row.inIndex<loreNodes.length);});
    const continuation=complete?null:{key,queue:meaningful,visited:[...visited],edgeVersions,edgeSources,requiresDepth:frontier.length?maxDepth+1:null};
    const coverage={complete,examined:Object.keys(edgeVersions).length,total:complete?Object.keys(edgeVersions).length:null,totalKnown:complete,deferred:complete?0:null,frontierNodes:meaningful.length,maxDepth,maxEdges,budgetStopped,
      construction:{complete:constructionComplete,examinedUnits,allowedUnits:constructionGrant,materializedEdges:counters.materializedEdges,totalKnown:constructionComplete},ceilingHit:Number(request.maxDepth)>12||Number(request.maxEdges)>8192||Number(request.maxConstructionUnits)>8192};
    lastCoverage=coverage;Object.assign(picked,{coverage,continuation});return picked;
  };
  return Object.freeze({providerId:'NEXUS_WORLD_TREE',owner:'NEXUS_WORLD_TREE',query,
    revalidateEdge(edge){
      if(!sensorySourceCurrent(edge.sourceValidation,worldTree))return null;
      const current=explicit.get(edge.edgeId);
      if(current)return edgeVersion(current)===edgeVersion(edge)?cloneTraversal(current):null;
      if(edge.sourceKind!=='LORE_GRAPH'||!byId.has(edge.fromEntityId)||!byId.has(edge.toEntityId))return null;
      return {...cloneTraversal(edge),sourceRevisionRefs:uniq([...sourceRevisionRefs,...edge.sourceValidation.nodes.flatMap(ref=>byId.get(ref.id)?.sourceRefs??[])])};
    },
    isRevisionCurrent(ref){return currentRefs.size?currentRefs.has(String(ref)):true;},semanticsVersion:'NEXUS_WORLD_TREE_V1',
    metadata:{sourceKind:'LORE_GRAPH',edgeCount:explicit.size,derivedIndexLazy:true,synchronous:true},
    diagnostics(){return {edgeCount:explicit.size+derived.size,nodeCount:nodes.length,anchorsIndexed:byId.size,derivation:{...counters},coverage:lastCoverage};},
  });
}

export function resolveWorldTreeAnchors(worldTree,sceneScan,{chatId=null,extraNames=[],anchorAdvice={}}={}){
  if(!worldTree)return[];
  const scene=sceneScan?.acceptedScene??sceneScan?.scene??{};
  const referenceNames=[
    ...(scene?.participants??[]),
    scene?.location,
    ...(sceneScan?.references?.characters??[]).map(row=>row?.name??row),
    ...(sceneScan?.references?.locations??[]).map(row=>row?.name??row),
    ...extraNames,
  ].filter(Boolean);
  const ids=[];
  for(const name of referenceNames){
    const rows=identityAnchorRows(worldTree.findByAlias(name,chatId));
    if(rows.length===1){ids.push(rows[0].id);continue;}
    if(rows.length>1){
      const advised=anchorAdvice?.[normalizeWorldTreeAlias(name)]?.choice;
      if(advised&&advised!=='SKIP'&&rows.some(row=>String(row.id)===String(advised)))ids.push(advised);
    }
  }
  return uniq(ids);
}
