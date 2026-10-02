import { KnowledgeStatus } from '../../contracts.js';
import { normalizeWorldTreeAlias } from '../../../../core/world-tree-api.js';

const uniq=(values=[])=>[...new Set((values??[]).filter(Boolean).map(String))];
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
function edgeRow({id,from,to,meaning,target,sourceRevisionRefs,authorityClass='SOURCE_CANON',temporalStatus=null,sourceKind='LORE_GRAPH'}){
  return {
    edgeId:String(id),
    fromEntityId:String(from),
    toEntityId:String(to),
    edgeMeaning:String(meaning),
    sourceRevisionRefs:uniq(sourceRevisionRefs),
    dependencyRevisionRefs:[],
    authorityClass,
    temporalStatus:temporalStatus??target?.temporalStatus??KnowledgeStatus.UNRESOLVED,
    sourceKind,
    artifactRef:target?.kind==='lore'?{
      artifactId:String(target.id),artifactType:'NexusLoreEntry',
      book:String(target?.payload?.book??''),uid:Number(target?.payload?.uid),
    }:{artifactId:String(target?.id??to),artifactType:'WorldTreeNode'},
    representationRef:String(target?.id??to),
    representationRevision:Number(target?.revision??1)||1,
    representationText:String(target?.payload?.content??target?.payload?.text??target?.payload?.title??target?.aliases?.[0]??''),
    evidenceIdentity:String(target?.id??to),
    drillbackRefs:target?.kind==='lore'?[{book:String(target?.payload?.book??''),uid:Number(target?.payload?.uid)}]:[],
  };
}

export function createWorldTreeGraphProvider({
  worldTree,
  sceneScan=null,
  chatId=null,
  sourceRevisionRefs=[],
  maxDerivedEdges=384,
  anchorAdvice={},
}={}){
  if(!worldTree)throw new TypeError('worldTree is required');
  const nodes=worldTree.allNodes();
  const byId=new Map(nodes.map(node=>[String(node.id),node]));
  const edges=[];
  const seen=new Set();
  const add=(row)=>{
    if(!row?.fromEntityId||!row?.toEntityId||row.fromEntityId===row.toEntityId)return;
    const key=[row.fromEntityId,row.toEntityId,row.edgeMeaning,row.evidenceIdentity].join('|');
    if(seen.has(key)||edges.length>=Math.max(32,Number(maxDerivedEdges)||384))return;
    seen.add(key);edges.push(row);
  };
  const addPair=(from,to,meaning,sourceKind='LORE_GRAPH',authorityClass='SOURCE_CANON')=>{
    const a=byId.get(String(from)),b=byId.get(String(to));if(!a||!b)return;
    const refs=uniq(sourceRevisionRefs.length?sourceRevisionRefs:[...nodeRevisionRefs(a),...nodeRevisionRefs(b)]);
    add(edgeRow({id:meaning+':'+a.id+':'+b.id,from:a.id,to:b.id,meaning,target:b,sourceRevisionRefs:refs,authorityClass,sourceKind}));
    add(edgeRow({id:meaning+'_REVERSE:'+b.id+':'+a.id,from:b.id,to:a.id,meaning:meaning+'_REVERSE',target:a,sourceRevisionRefs:refs,authorityClass,sourceKind}));
  };

  // Explicit World Tree edges (Character Bank links already arrive here).
  for(const node of nodes){
    for(const edge of node.edges??[]){
      if(byId.has(String(edge?.to)))addPair(node.id,String(edge.to),String(edge?.meaning??'RELATED_TO'),'WORLD_TREE_EDGE',node.kind==='character'?'SOURCE_CANON':'INFERRED');
    }
  }

  // Build a token-gated alias index, then derive bounded lore cross-references.
  const aliasRows=[];
  const aliasByToken=new Map();
  for(const node of nodes){
    for(const raw of node.aliases??[]){
      const alias=normalizeWorldTreeAlias(raw);
      if(!visibleAlias(alias))continue;
      const first=[...words(alias)][0];if(!first)continue;
      const row={nodeId:String(node.id),alias};
      aliasRows.push(row);
      if(!aliasByToken.has(first))aliasByToken.set(first,[]);
      aliasByToken.get(first).push(row);
    }
  }
  for(const source of nodes.filter(node=>node.kind==='lore')){
    const material=[source?.payload?.title,source?.payload?.content].filter(Boolean).join(' ');
    const sourceWords=words(material);
    const candidates=new Map();
    for(const token of sourceWords){
      for(const row of aliasByToken.get(token)??[]){
        if(row.nodeId!==source.id&&!candidates.has(row.nodeId))candidates.set(row.nodeId,row);
      }
    }
    let derived=0;
    for(const row of candidates.values()){
      if(derived>=12||edges.length>=maxDerivedEdges)break;
      const target=byId.get(row.nodeId);if(!target||!containsAlias(material,row.alias))continue;
      const relation=relationTitle.test(String(source?.payload?.title??''))?'RELATIONSHIP_MENTION':'LORE_CROSS_REFERENCE';
      addPair(source.id,target.id,relation,'LORE_GRAPH','INFERRED');
      derived++;
    }
  }

  // Scene co-presence and location links, resolved through the World Tree alias table.
  const scene=sceneScan?.acceptedScene??sceneScan?.scene??null;
  const resolveOne=(name)=>{
    const scoped=identityAnchorRows(worldTree.findByAlias(name,chatId)??[]);
    const rows=scoped.length?scoped:identityAnchorRows(worldTree.findByAlias(name,null)??[]);
    if(rows.length===1)return rows[0];
    if(rows.length>1){
      const advised=anchorAdvice?.[normalizeWorldTreeAlias(name)]?.choice;
      return advised&&advised!=='SKIP'?rows.find(row=>String(row.id)===String(advised))??null:null;
    }
    return null;
  };
  const participants=uniq(scene?.participants??[]).map(resolveOne).filter(Boolean);
  for(let i=0;i<participants.length;i++)for(let j=i+1;j<participants.length;j++)addPair(participants[i].id,participants[j].id,'SCENE_CO_PRESENT','SCENE_OBSERVATION','OBSERVED');
  const location=resolveOne(scene?.location);
  if(location)for(const actor of participants)addPair(actor.id,location.id,'SCENE_LOCATION','SCENE_OBSERVATION','OBSERVED');

  const adjacency=new Map();
  for(const edge of edges){
    for(const id of [edge.fromEntityId,edge.toEntityId]){
      if(!adjacency.has(id))adjacency.set(id,[]);
      adjacency.get(id).push(edge);
    }
  }
  const currentRefs=new Set(sourceRevisionRefs.map(String));
  const query=(request={})=>{
    const maxEdges=Math.max(1,Math.min(Number(request.maxEdges)||192,192));
    const maxDepth=Math.max(1,Math.min(Number(request.maxDepth)||3,3));
    const anchors=uniq(request.anchorEntityIds??[]).filter(id=>adjacency.has(id));
    const queue=anchors.map(id=>({id,depth:0})),visited=new Set(anchors),picked=[],edgeIds=new Set();
    while(queue.length&&picked.length<maxEdges){
      const current=queue.shift();if(current.depth>=maxDepth)continue;
      for(const edge of adjacency.get(current.id)??[]){
        if(picked.length>=maxEdges)break;
        if(!edgeIds.has(edge.edgeId)){edgeIds.add(edge.edgeId);picked.push(edge);}
        const next=edge.fromEntityId===current.id?edge.toEntityId:edge.fromEntityId;
        if(!visited.has(next)){visited.add(next);queue.push({id:next,depth:current.depth+1});}
      }
    }
    return picked;
  };
  return Object.freeze({
    providerId:'NEXUS_WORLD_TREE',
    owner:'NEXUS_WORLD_TREE',
    query,
    isRevisionCurrent(ref){return currentRefs.size?currentRefs.has(String(ref)):true;},
    semanticsVersion:'NEXUS_WORLD_TREE_V1',
    metadata:{sourceKind:'LORE_GRAPH',edgeCount:edges.length,synchronous:true},
    diagnostics(){return {edgeCount:edges.length,nodeCount:nodes.length,anchorsIndexed:adjacency.size};},
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
