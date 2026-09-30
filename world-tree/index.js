import { NexusWorldTree } from './store.js';

let activeWorldTree=new NexusWorldTree();

export function getNexusWorldTree(){return activeWorldTree;}

export function replaceNexusWorldTree(snapshot=null){
  activeWorldTree=new NexusWorldTree(snapshot?{snapshot}:{});
  return activeWorldTree;
}

export function readNexusWorldTree({chatId=null,includeOverlays=true,limit=1000}={}){
  return activeWorldTree.read({chatId,includeOverlays,limit});
}

export function readNexusWorldTreeUiModel({chatId=null,limit=600}={}){
  return activeWorldTree.readUiModel({chatId,limit});
}

export function exportNexusWorldTreeState(){return activeWorldTree.exportState();}

export * from './store.js';
export * from './entity-identity-registry.js';
export * from './temporal-state-graph.js';
