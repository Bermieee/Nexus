import { NexusWorldTree } from './store.js';
import {applyPublishedWorldBuild,WORLD_BUILD_METADATA_KEY} from './builder-publication.js';

let activeWorldTree=new NexusWorldTree();
const ownerSubscriptions=new Map();
let contextProvider=null,hydrating=false;const hydrated=new WeakMap();
export function configureWorldTreeContextProvider(provider){contextProvider=provider;}
function hydrateOrganization(){
  if(hydrating||!contextProvider)return;
  const context=contextProvider();if(!context?.chatId)return;
  const publication=context.chatMetadata?.[WORLD_BUILD_METADATA_KEY];if(!publication||publication.chatId!==context.chatId)return;
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

export function getNexusWorldTree(){hydrateOrganization();return activeWorldTree;}

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
