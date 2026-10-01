export const WORLD_BUILD_METADATA_KEY='nexusWorldTreeOrganizationV1';

// Durable organization contains owner references, never authored source bodies.
export function worldBuildPublicationValue(previous,plan,materialization){
  if(plan.scope.type!=='CHAT')throw Error('Installed Builder publication requires active story scope');
  const books=[...new Set(plan.sources.map(s=>s.book))];
  if(books.length!==1)throw Error('Story build requires exactly one bound Lorebook');
  const compatible=previous?.chatId===plan.scope.chatId&&previous.book===books[0];
  const nodes=new Map((compatible?previous?.nodes??[]:[]).map(n=>[n.id,n])),edges=new Map((compatible?previous?.edges??[]:[]).map(e=>[e.id,e]));
  for(const operation of materialization.operations){
    if(operation.node){
      const node=operation.node;
      if(node.kind!=='LORE_GROUP')throw Error('Story build cannot rewrite authored source nodes');
      if(node.scope.type!=='CHAT'||node.scope.chatId!==plan.scope.chatId)throw Error('Story build cannot publish global categories');
      nodes.set(node.id,node);
    }else if(operation.edge)edges.set(operation.edge.id,operation.edge);
  }
  return {contract:'nexus-world-tree-organization/v1',chatId:plan.scope.chatId,book:books[0],binding:plan.binding??null,revision:(previous?.revision??0)+1,
    clearedLayoutFingerprint:compatible?previous?.clearedLayoutFingerprint:undefined,
    lastRunId:plan.runId,lastFingerprint:plan.review?.approvedFingerprint??materialization.fingerprint,nodes:[...nodes.values()],edges:[...edges.values()]};
}
export function applyPublishedWorldBuild(tree,publication){
  if(!publication)return null;
  if(publication.contract!=='nexus-world-tree-organization/v1')throw Error('Invalid published World Tree organization');
  const allEdges=new Map(tree.exportState().edges);
  const allNodes=new Map(tree.exportState().nodes);
  if(publication.book){
    const proposed=new Map((publication.nodes??[]).map(n=>[n.id,n]));
    const permitted=id=>{
      const n=proposed.get(id)??allNodes.get(id);if(!n)return false;
      if(n.scope.type==='CHAT')return n.scope.chatId===publication.chatId&&(!n.data?.book||n.data.book===publication.book);
      if(n.id==='world:nexus')return true;
      if(n.kind==='CHARACTER')return [...allNodes.values()].some(state=>state.scope.type==='CHAT'&&state.scope.chatId===publication.chatId&&state.data?.characterNodeId===n.id);
      return n.data?.book===publication.book;
    };
    for(const node of publication.nodes){
      if((node.parentId&&!permitted(node.parentId))||(node.data?.book&&node.data.book!==publication.book)||(node.provenance?.sourceIds??[]).some(id=>String(id).includes('#')&&!String(id).startsWith(publication.book+'#')))throw Error('Published group violates story binding');
    }
    for(const edge of publication.edges)if(!permitted(edge.from)||!permitted(edge.to))throw Error('Published link violates story binding');
  }
  for(const node of publication.nodes){
    const old=allNodes.get(node.id);
    if(node.kind!=='LORE_GROUP'||node.scope.type!=='CHAT'||node.scope.chatId!==publication.chatId)throw Error('Published group scope mismatch');
    if(old&&(old.kind!==node.kind||old.scope.type!==node.scope.type||old.scope.chatId!==node.scope.chatId||old.provenance?.sourceType!==node.provenance?.sourceType))throw Error(`Group ownership conflict ${node.id}`);
  }
  for(const edge of publication.edges){
    const old=allEdges.get(edge.id);
    if(edge.scope.type!=='CHAT'||edge.scope.chatId!==publication.chatId)throw Error('Published link scope mismatch');
    if(old&&(old.scope.type!==edge.scope.type||old.scope.chatId!==edge.scope.chatId||old.provenance?.sourceType!==edge.provenance?.sourceType))throw Error(`Edge ownership conflict ${edge.id}`);
  }
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
