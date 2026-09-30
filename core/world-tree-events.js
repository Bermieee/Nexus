import { getNexusWorldTree, subscribeNexusWorldTree } from '../world-tree/index.js';

const TYPES=new Set(['node-added','edge-added','node-superseded','world-tree-replaced']);
export function subscribeWorldTreeUi(listener,{getChatId=()=>null,schedule=fn=>setTimeout(fn,0)}={}){
  if(typeof listener!=='function')throw new TypeError('World Tree UI listener must be a function');
  let active=true,scheduled=false;const pending=new Map();
  function flush(){
    scheduled=false;if(!active)return;
    const rows=[...pending.values()];pending.clear();
    for(const {owner,event} of rows){
      if(owner!==getNexusWorldTree())continue;
      let chatId;try{chatId=getChatId();}catch{continue;}
      if(event.payload.scope.type==='CHAT'&&String(event.payload.scope.chatId)!==String(chatId))continue;
      try{listener(event);}catch{}
    }
  }
  const release=subscribeNexusWorldTree(raw=>{
    if(!active||!TYPES.has(raw.type))return;
    const p=raw.payload??{},scope=p.scope??{};
    const event=Object.freeze({kind:'NexusWorldTreeEvent',type:raw.type,worldRevision:raw.worldRevision,
      payload:Object.freeze({nodeId:p.nodeId??null,edgeId:p.edgeId??null,kind:p.kind,
        scope:Object.freeze({type:scope.type,chatId:scope.chatId??null})})});
    pending.set(JSON.stringify([event.type,event.payload.nodeId,event.payload.edgeId]),{owner:getNexusWorldTree(),event});
    if(!scheduled){scheduled=true;try{schedule(flush);}catch{scheduled=false;pending.clear();}}
  });
  return()=>{active=false;pending.clear();release();};
}
