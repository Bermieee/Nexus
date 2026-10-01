import { NexusWorldTree } from './store.js';

let activeWorldTree=new NexusWorldTree();
const ownerSubscriptions=new Map();

// Subscription follows the singleton owner, including restore/replacement.
export function subscribeNexusWorldTree(listener){
  if(typeof listener!=='function')throw new TypeError('World Tree subscriber must be a function');
  const token={listener};
  ownerSubscriptions.set(token,activeWorldTree.subscribe(listener));
  return()=>{const release=ownerSubscriptions.get(token);if(release){release();ownerSubscriptions.delete(token);}};
}

export function getNexusWorldTree(){return activeWorldTree;}

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
  return activeWorldTree.read({chatId,includeOverlays,limit});
}
export function readNexusWorldTreeLoreMetadata(options={}){return activeWorldTree.readLoreMetadata(options);}

export function readNexusWorldTreeUiModel({chatId=null,limit=600}={}){
  return activeWorldTree.readUiModel({chatId,limit});
}

export function exportNexusWorldTreeState(){return activeWorldTree.exportState();}

export * from './store.js';
export * from './entity-identity-registry.js';
export * from './temporal-state-graph.js';
