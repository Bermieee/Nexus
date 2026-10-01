import {NexusWorldTree} from './store.js';
import {WORLD_BUILD_METADATA_KEY} from './builder-publication.js';
import {loreBookWorldNodeId} from './import-lore.js';

// Projection of the canonical owner, not another durable tree. Global imports
// remain authoritative source records, but never grant another story access.
export function createStoryWorldTreeView(owner,context,binding){
  const snapshot=owner.exportState();
  const publication=context?.chatMetadata?.[WORLD_BUILD_METADATA_KEY];
  const organization=publication&&binding&&publication.chatId===binding.chatId&&publication.book===binding.book&&(!publication.binding||(publication.binding.chatId===binding.chatId&&publication.binding.book===binding.book))?publication:null;
  const groups=new Set((organization?.nodes??[]).map(n=>n.id));
  const publishedEdges=new Set((organization?.edges??[]).map(e=>e.id));
  const characterIds=new Set(snapshot.nodes.filter(([,n])=>binding&&n.scope.type==='CHAT'&&n.scope.chatId===binding.chatId).map(([,n])=>n.data?.characterNodeId).filter(Boolean));
  const nodes=snapshot.nodes.filter(([,node])=>{
    if(!binding)return false;
    if(node.kind==='WORLD')return node.id==='world:nexus';
    if(node.scope.type==='CHAT')return node.scope.chatId===binding.chatId&&
      (!node.data?.book||node.data.book===binding.book)&&
      (node.provenance.sourceType!=='BUILDER_ORGANIZATION'||groups.has(node.id));
    if(node.kind==='CHARACTER'&&characterIds.has(node.id))return true;
    if(node.data?.book!==binding.book)return false;
    return !organization||node.provenance.sourceType!=='NEXUS_LEGACY_LORE_TREE';
  });
  const ids=new Set(nodes.map(([id])=>id));
  for(const [,node] of nodes){
    if(node.kind==='LORE_FACT'&&organization)node.parentId=loreBookWorldNodeId(binding.book);
    else if(node.parentId&&!ids.has(node.parentId))node.parentId='world:nexus';
  }
  const edges=snapshot.edges.filter(([,edge])=>binding&&ids.has(edge.from)&&ids.has(edge.to)&&
    (edge.scope.type==='GLOBAL'||edge.scope.chatId===binding.chatId)&&
    (!edge.data?.book||edge.data.book===binding.book)&&
    (!['BUILDER_ORGANIZATION','BUILDER_RELATIONSHIP'].includes(edge.provenance.sourceType)||publishedEdges.has(edge.id)));
  // A clear is durable story-local organization. Legacy imports cannot revive
  // their old parent links; source nodes remain present and buildable.
  if(organization)for(const [id,node] of nodes.filter(([,n])=>n.kind==='LORE_FACT')){
    if(!edges.some(([,e])=>e.to===id&&e.data?.primaryPlacement))edges.push([`story-flat:${binding.chatId}:${id}`,{
      id:`story-flat:${binding.chatId}:${id}`,kind:'WORLD_TREE_EDGE',from:loreBookWorldNodeId(binding.book),to:id,
      relation:'CONTAINS',scope:{type:'CHAT',chatId:binding.chatId},provenance:{sourceType:'STORY_VIEW',sourceIds:[binding.book]},temporal:{status:'CURRENT'},data:{},revision:node.revision,
    }]);
  }
  const view=new NexusWorldTree({snapshot:{...snapshot,nodes,edges,identityRegistry:null,temporalStateGraph:null}});
  // restoreState ensures a root; unbound product reads must stay completely empty.
  if(!binding)view.nodes.clear();
  view.overlays=new Map([...owner.overlays].filter(([,o])=>binding&&o.chatId===binding.chatId&&o.nodeIds.every(id=>ids.has(id))));
  view.overlayRevision=owner.overlayRevision;
  view.revision=owner.revision;
  return view;
}
