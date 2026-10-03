import { NexusWorldTree } from './store.js';
import {applyPublishedWorldBuild,WORLD_BUILD_METADATA_KEY} from './builder-publication.js';
import {worldTreeStoryBinding,assertWorldTreeStoryBinding} from './story-binding.js';
import {createStoryWorldTreeView} from './story-view.js';

let activeWorldTree=new NexusWorldTree();
const ownerSubscriptions=new Map();
let contextProvider=null,scopeProvider=null,hydrating=false;const hydrated=new WeakMap(),facades=new WeakMap();
export function configureWorldTreeContextProvider(provider,readScope=null){contextProvider=provider;scopeProvider=readScope;}
function currentScope(){return scopeProvider?scopeProvider():contextProvider?.()?.chatMetadata?.tv2_story_scope_v1;}
export function readWorldTreeStoryBinding(){return worldTreeStoryBinding(contextProvider?.(),currentScope());}
export function requireWorldTreeStoryBinding(options={}){return assertWorldTreeStoryBinding(contextProvider?.(),currentScope(),options);}
function hydrateOrganization(){
  if(hydrating||!contextProvider)return;
  const context=contextProvider();if(!context?.chatId)return;
  const publication=context.chatMetadata?.[WORLD_BUILD_METADATA_KEY],binding=readWorldTreeStoryBinding();
  if(!publication||!binding||publication.chatId!==binding.chatId||publication.book!==binding.book)return;
  if(publication.binding&&(publication.binding.chatId!==binding.chatId||publication.binding.book!==binding.book))return;
  const prior=hydrated.get(activeWorldTree);if(prior?.publication===publication&&prior.revision===activeWorldTree.revision)return;
  hydrating=true;try{applyPublishedWorldBuild(activeWorldTree,publication);hydrated.set(activeWorldTree,{publication,revision:activeWorldTree.revision});}finally{hydrating=false;}
}

// Subscription follows the singleton owner, including restore/replacement.
export function subscribeNexusWorldTree(listener){
  if(typeof listener!=='function')throw new TypeError('World Tree subscriber must be a function');
  const token={listener};
  ownerSubscriptions.set(token,activeWorldTree.subscribe(listener));
  return()=>{const release=ownerSubscriptions.get(token);if(release){release();ownerSubscriptions.delete(token);}};
}

export function getNexusWorldTreeOwner(){hydrateOrganization();return activeWorldTree;}
export function getNexusWorldTree(){
  hydrateOrganization();if(!contextProvider)return activeWorldTree;
  if(!facades.has(activeWorldTree)){
    const owner=activeWorldTree;let cache=null,key=null;
    const scopeKey=()=>JSON.stringify([readWorldTreeStoryBinding(),contextProvider?.()?.chatMetadata?.[WORLD_BUILD_METADATA_KEY]??null]);
    const view=()=>{const next=scopeKey()+':'+owner.revision+':'+owner.overlayRevision;if(next!==key){cache=createStoryWorldTreeView(owner,contextProvider?.(),readWorldTreeStoryBinding());key=next;}return cache;};
    const readMethods=new Set(['getNode','getEdge','iterateNodes','iterateEdges','read','readUiModel','readLoreMetadata','exportState']);
    facades.set(owner,new Proxy(owner,{get(target,name){
      if(name==='readScopeKey')return scopeKey();
      if(['nodes','edges','overlays'].includes(name))return new Map(view()[name]);
      if(readMethods.has(name))return (...args)=>{
        const index=['getNode','getEdge'].includes(name)?1:0,options=args[index]??{},binding=readWorldTreeStoryBinding();
        if(options.chatId!=null&&options.chatId!==binding?.chatId){const empty=createStoryWorldTreeView(owner,null,null);return empty[name](...args);}
        args[index]={...options,chatId:binding?.chatId??null};const result=view()[name](...args);
        if(['read','readUiModel'].includes(name)){
          const publication=contextProvider?.()?.chatMetadata?.[WORLD_BUILD_METADATA_KEY];
          return Object.freeze({...result,worldTreeOrganizationCleared:Boolean(binding&&publication?.chatId===binding.chatId&&publication?.book===binding.book&&publication?.cleared)});
        }
        return result;
      };
      if(['upsertNode','linkEdge','removeNode','removeEdge','addEphemeralOverlay'].includes(name))return (...args)=>{
        const binding=requireWorldTreeStoryBinding();
        if(name==='upsertNode'){
          const node=args[0];if(node.scope?.type==='CHAT'?node.scope.chatId!==binding.chatId:node.data?.book!==binding.book)throw Error('World Tree mutation is outside the active story binding');
        }else if(name==='linkEdge'||name==='addEphemeralOverlay'){
          const row=args[0],ids=name==='linkEdge'?[row.from,row.to]:row.nodeIds;
          if(ids?.some(id=>!view().nodes.has(id))||(row.scope?.type==='CHAT'&&row.scope.chatId!==binding.chatId)||(row.chatId&&row.chatId!==binding.chatId))throw Error('World Tree mutation is outside the active story binding');
        }else if(!(name==='removeNode'?view().nodes:view().edges).has(args[0]))throw Error('World Tree mutation is outside the active story binding');
        return target[name](...args);
      };
      const value=Reflect.get(target,name,target);return typeof value==='function'?value.bind(target):value;
    }}));
  }
  return facades.get(activeWorldTree);
}

export function replaceNexusWorldTree(snapshot=null){
  const next=new NexusWorldTree(snapshot?{snapshot}:{});
  for(const release of ownerSubscriptions.values())release();
  activeWorldTree=next;
  for(const token of ownerSubscriptions.keys()){
    ownerSubscriptions.set(token,activeWorldTree.subscribe(token.listener));
    try{token.listener(Object.freeze({kind:'NexusWorldTreeEvent',type:'world-tree-replaced',worldRevision:next.revision,payload:{nodeId:'world:nexus',kind:'WORLD',scope:{type:'GLOBAL'}}}));}catch{}
  }
  return activeWorldTree;
}

export function readNexusWorldTree({chatId=null,includeOverlays=true,limit=1000}={}){
  return getNexusWorldTree().read({chatId,includeOverlays,limit});
}
export function readNexusWorldTreeLoreMetadata(options={}){return getNexusWorldTree().readLoreMetadata(options);}

export function readNexusWorldTreeUiModel({chatId=null,limit=600}={}){
  return getNexusWorldTree().readUiModel({chatId,limit});
}

export function exportNexusWorldTreeState(){return activeWorldTree.exportState();}

export * from './store.js';
export * from './entity-identity-registry.js';
export * from './temporal-state-graph.js';
