import {validateWorldBuildPlan,worldBuildFingerprint,worldBuildSourceId} from './world-plan.js';

export function materializeWorldBuildPlan(plan,context){
  const validation=validateWorldBuildPlan(plan);
  if(!validation.valid)throw new Error(validation.errors.join('; '));
  if(plan.worldRevision!==context.worldRevision||plan.sourceFence!==context.sourceFence)throw new Error('Stale World Tree build');
  const nodes=new Map(context.nodes.map(n=>[n.id,structuredClone(n)])), operations=[];
  const provenance={sourceType:'BUILDER_ORGANIZATION',sourceIds:plan.sources.map(s=>s.sourceId),provenanceRefs:[`world-build:${plan.runId}`]};
  for(const group of plan.organization.groups){
    const previous=nodes.get(group.id);
    if(previous&&previous.kind!=='LORE_GROUP'&&previous.kind!=='WORLD')throw new Error('Group identity conflicts with factual node');
    if(previous?.kind==='WORLD')continue;
    const node={...(previous??{}),id:group.id,kind:'LORE_GROUP',parentId:group.parentId??'world:nexus',scope:previous?.scope??plan.scope,
      provenance:previous?.provenance??provenance,temporal:previous?.temporal??{status:'CURRENT'},data:{...previous?.data,label:group.label}};
    if(previous?.scope.type==='GLOBAL'&&plan.scope.type==='CHAT'&&JSON.stringify(previous.data)!==JSON.stringify(node.data))throw new Error('Story build cannot rewrite a global group');
    nodes.set(node.id,node); operations.push({kind:'UPSERT_NODE',node});
  }
  for(const placement of plan.organization.placements){
    const source=plan.sources.find(s=>s.sourceId===placement.sourceId);
    const previous=context.nodes.find(n=>n.kind==='LORE_FACT'&&worldBuildSourceId(n.data.book,n.data.uid)===source.sourceId);
    if(!previous)throw new Error(`Source owner node missing: ${source.sourceId}`);
    const parent=nodes.get(placement.parentId);
    if(!parent)throw new Error(`Missing placement parent ${placement.parentId}`);
    // Global authored nodes cannot acquire a story-local primary parent.
    if(previous.scope.type==='GLOBAL'&&parent.scope.type==='CHAT'){
      const edge={id:`world-build-placement:${plan.scope.chatId}:${previous.id}`,from:parent.id,to:previous.id,relation:'NAVIGATION',scope:plan.scope,provenance,temporal:{status:'CURRENT'},data:{primaryPlacement:true}};
      operations.push({kind:'LINK_EDGE',edge}); continue;
    }
    const node={...structuredClone(previous),parentId:placement.parentId};
    nodes.set(node.id,node);operations.push({kind:'UPSERT_NODE',node});
  }
  const edges=new Map(context.relationships.map(e=>[e.id,structuredClone(e)]));
  for(const operation of operations)if(operation.edge)edges.set(operation.edge.id,operation.edge);
  for(const link of plan.organization.navigationLinks){
    const edge={id:link.id,from:link.from,to:link.to,relation:'NAVIGATION',scope:plan.scope,provenance,temporal:{status:'CURRENT'}};
    edges.set(edge.id,edge);operations.push({kind:'LINK_EDGE',edge});
  }
  for(const proposal of plan.relationshipProposals){
    if(proposal.approved!==true)continue;
    const edge={id:proposal.id,from:proposal.from,to:proposal.to,relation:proposal.relation,scope:proposal.scope,
      provenance:{sourceType:'BUILDER_RELATIONSHIP',sourceIds:proposal.evidence},temporal:proposal.temporal};
    edges.set(edge.id,edge);operations.push({kind:'LINK_EDGE',edge});
  }
  const result={operations,preview:{nodes:[...nodes.values()],edges:[...edges.values()],worldRevision:context.worldRevision,staged:true},coverage:structuredClone(plan.coverage),fingerprint:worldBuildFingerprint(plan)};
  const checked=validateWorldBuildMaterialization(result,context);
  if(!checked.valid)throw new Error(checked.errors.join('; '));
  return result;
}
export function validateWorldBuildMaterialization(result,context){
  const errors=[], nodes=new Map(result.preview.nodes.map(n=>[n.id,n]));
  for(const node of nodes.values()){
    if(node.parentId&&!nodes.has(node.parentId))errors.push(`Missing parent ${node.parentId}`);
    const visited=new Set([node.id]);let parent=node.parentId;
    while(parent&&nodes.has(parent)){if(visited.has(parent)){errors.push(`Parent cycle ${node.id}`);break;}visited.add(parent);parent=nodes.get(parent).parentId;}
    const parentNode=nodes.get(node.parentId);
    if(parentNode?.scope.type==='CHAT'&&(node.scope.type==='GLOBAL'||node.scope.chatId!==parentNode.scope.chatId))errors.push(`Parent scope mismatch ${node.id}`);
  }
  for(const edge of result.preview.edges){
    if(!nodes.has(edge.from)||!nodes.has(edge.to))errors.push(`Missing edge endpoint ${edge.id}`);
    for(const id of [edge.from,edge.to]){const node=nodes.get(id);if(node?.scope.type==='CHAT'&&(edge.scope.type!=='CHAT'||edge.scope.chatId!==node.scope.chatId))errors.push(`Edge scope mismatch ${edge.id}`);}
  }
  for(const old of context.nodes)if(!nodes.has(old.id))errors.push(`Build removed existing source ${old.id}`);
  return {valid:errors.length===0,errors};
}
