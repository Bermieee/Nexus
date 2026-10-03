import {getNexusWorldTree,getNexusWorldTreeOwner,readWorldTreeStoryBinding} from '../index.js';
import {worldTreeStoryBinding} from '../story-binding.js';

// Synthetic injected owners may have unbooked fixture nodes. Authored book
// records always require a matching story binding, including injected owners.
export function contributionStoryScope(tree,context,{chatId=null,characterIds=[]}={}){
  const singleton=tree===getNexusWorldTreeOwner();
  const production=singleton&&getNexusWorldTree()!==tree;
  const read=()=>singleton?readWorldTreeStoryBinding():(worldTreeStoryBinding(context,context?.chatMetadata?.tv2_story_scope_v1)??readWorldTreeStoryBinding());
  const binding=read();
  if(production&&!binding)throw new Error('WORLD_TREE_CONTRIBUTION_STORY_BINDING_REQUIRED');
  if(binding&&chatId!=null&&binding.chatId!==String(chatId))throw new Error('WORLD_TREE_CONTRIBUTION_CHAT_SCOPE_MISMATCH');
  const permittedCharacters=new Set(characterIds);
  if(binding)for(const node of tree.iterateNodes({chatId:binding.chatId}))if(node.scope.type==='CHAT'&&node.scope.chatId===binding.chatId&&node.data?.characterNodeId)permittedCharacters.add(node.data.characterNodeId);
  const visible=node=>{
    if(!node||node.temporal?.status==='SUPERSEDED')return false;
    if(node.scope.type==='CHAT')return node.scope.chatId===String(chatId??binding?.chatId??'')&&(!node.data?.book||node.data.book===binding?.book);
    if(node.id==='world:nexus')return true;
    if(node.data?.book)return Boolean(binding&&node.data.book===binding.book);
    if(!binding)return !production;
    return node.kind==='CHARACTER'&&permittedCharacters.has(node.id);
  };
  const assertFresh=()=>{
    if(JSON.stringify(read())!==JSON.stringify(binding))throw new Error('WORLD_TREE_CONTRIBUTION_BINDING_CHANGED');
    if(binding&&context?.chatId!=null&&String(context.chatId)!==binding.chatId)throw new Error('WORLD_TREE_CONTRIBUTION_BINDING_CHANGED');
  };
  const getNode=id=>{const node=tree.getNode(id,{chatId:chatId??binding?.chatId??null});return visible(node)?node:null;};
  return {binding,visible,getNode,assertFresh,iterateNodes:()=>[...tree.iterateNodes({chatId:chatId??binding?.chatId??null})].filter(visible)};
}
