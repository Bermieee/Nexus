export const WORLD_BUILD_METADATA_KEY='nexusWorldTreeOrganizationV1';

// Durable organization contains owner references, never authored source bodies.
export function worldBuildPublicationValue(previous,plan,materialization){
  if(plan.scope.type!=='CHAT')throw Error('Installed Builder publication requires active story scope');
  const nodes=new Map((previous?.nodes??[]).map(n=>[n.id,n])),edges=new Map((previous?.edges??[]).map(e=>[e.id,e]));
  for(const operation of materialization.operations){
    if(operation.node){
      const node=operation.node;
      if(node.kind!=='LORE_GROUP')throw Error('Story build cannot rewrite authored source nodes');
      if(node.scope.type!=='CHAT'||node.scope.chatId!==plan.scope.chatId)throw Error('Story build cannot publish global categories');
      nodes.set(node.id,node);
    }else if(operation.edge)edges.set(operation.edge.id,operation.edge);
  }
  return {contract:'nexus-world-tree-organization/v1',chatId:plan.scope.chatId,revision:(previous?.revision??0)+1,
    lastRunId:plan.runId,lastFingerprint:plan.review?.approvedFingerprint??materialization.fingerprint,nodes:[...nodes.values()],edges:[...edges.values()]};
}
export function applyPublishedWorldBuild(tree,publication){
  if(!publication)return null;
  if(publication.contract!=='nexus-world-tree-organization/v1')throw Error('Invalid published World Tree organization');
  for(const node of publication.nodes){
    if(node.scope.type!=='CHAT'||node.scope.chatId!==publication.chatId)throw Error('Published group scope mismatch');
    const previous=tree.getNode(node.id,{chatId:publication.chatId});
    if(previous&&previous.kind!==node.kind)throw Error('Published group identity conflict');
    const equal=previous&&previous.parentId===node.parentId&&JSON.stringify(previous.data)===JSON.stringify(node.data);
    if(!equal)tree.upsertNode(node);
  }
  for(const edge of publication.edges){
    if(edge.scope.type!=='CHAT'||edge.scope.chatId!==publication.chatId)throw Error('Published link scope mismatch');
    if(!tree.getNode(edge.from,{chatId:publication.chatId})||!tree.getNode(edge.to,{chatId:publication.chatId}))continue;
    const previous=tree.getEdge(edge.id,{chatId:publication.chatId});
    const comparable=row=>({from:row.from,to:row.to,relation:row.relation,scope:row.scope,
      temporal:{status:row.temporal?.status??'CURRENT',validFrom:row.temporal?.validFrom??null,validUntil:row.temporal?.validUntil??null,
        supersedes:row.temporal?.supersedes??[],supersededBy:row.temporal?.supersededBy??[],contradictedBy:row.temporal?.contradictedBy??[],reason:row.temporal?.reason??null},
      data:row.data??{},evidence:[...(row.provenance?.sourceIds??[])].sort()});
    if(!previous||JSON.stringify(comparable(previous))!==JSON.stringify(comparable(edge)))tree.linkEdge(edge);
  }
  return tree.revision;
}
