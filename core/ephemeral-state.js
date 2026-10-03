import { getNexusWorldTreeOwner } from '../world-tree/index.js';

// The world root is the canonical anchor for chat-wide working state. Individual
// records retain their entity/segment identities inside the scoped overlay.
export function workingStateKey(kind,chatId,nodeId='world:nexus'){
  return JSON.stringify(['nexus-working-state',String(kind),String(chatId),String(nodeId)]);
}
export function readWorkingState(kind,chatId,{worldTree=getNexusWorldTreeOwner(),nodeId='world:nexus'}={}){
  const row=worldTree.overlays.get(workingStateKey(kind,chatId,nodeId));
  return row&&row.chatId===String(chatId)?structuredClone(row.data):null;
}
export function writeWorkingState(kind,chatId,data,{worldTree=getNexusWorldTreeOwner(),nodeId='world:nexus'}={}){
  return worldTree.addEphemeralOverlay({
    id:workingStateKey(kind,chatId,nodeId),kind,chatId:String(chatId),nodeIds:[nodeId],
    generationId:workingStateKey(kind,chatId,nodeId),data,
  });
}
export function clearWorkingState(kind,chatId,{worldTree=getNexusWorldTreeOwner(),nodeId='world:nexus'}={}){
  return worldTree.expireEphemeral({chatId:String(chatId),clearGenerationId:workingStateKey(kind,chatId,nodeId)});
}

// Computation stays with the existing owner. Its cache is rehydrated from the
// ephemeral layer on every operation so clearing/replacing that layer wins.
export function bindWorkingStore(store,kind,chatId,{worldTree=null,nodeId='world:nexus'}={}){
  const empty=store.exportState();
  const options=()=>({worldTree:worldTree??getNexusWorldTreeOwner(),nodeId});
  return new Proxy(store,{
    get(target,key){
      const value=Reflect.get(target,key,target);
      if(typeof value!=='function')return value;
      return(...args)=>{
        target.importState(readWorkingState(kind,chatId,options())??structuredClone(empty));
        const result=value.apply(target,args);
        writeWorkingState(kind,chatId,target.exportState(),options());
        return result;
      };
    },
  });
}
