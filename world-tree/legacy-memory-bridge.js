import { getContext } from '../../../../st-context.js';
import { getAllMemoryRecords, currentMemoryStoryId, memoryRecordValidity } from '../memory/store.js';
import { getNexusWorldTree } from './index.js';
import { importLegacyMemoryRecordsToWorldTree } from './import-memory-bank.js';

let cleanupFns=[];
let installed=false;
let lastSync=null;

function safeSync(reason='manual'){
  const context=getContext?.();
  const chatId=currentMemoryStoryId(context);
  if(!chatId)return Object.freeze({kind:'NexusWorldTreeLegacyMemorySync',skipped:true,reason:'no-active-chat'});
  const tree=getNexusWorldTree();
  const records=getAllMemoryRecords().map(record=>({
    ...record,
    worldTreeValidity:memoryRecordValidity(record),
  }));
  const result=importLegacyMemoryRecordsToWorldTree(tree,{chatId,records});
  lastSync=Object.freeze({...result,reason,at:Date.now()});
  return lastSync;
}

function addWindowListener(type,handler){
  try{
    const target=globalThis.window;
    if(!target?.addEventListener)return()=>{};
    target.addEventListener(type,handler);
    return()=>{try{target.removeEventListener(type,handler);}catch{}};
  }catch{return()=>{};}
}

export function syncLegacyMemoryBankToWorldTree(reason='manual'){
  return safeSync(reason);
}

export function installLegacyMemoryWorldTreeBridge(){
  if(installed)return()=>uninstallLegacyMemoryWorldTreeBridge();
  installed=true;
  cleanupFns=[
    addWindowListener('tv2-memory-bank-updated',()=>safeSync('memory-bank-updated')),
  ];
  try{safeSync('bridge-installed');}catch{}
  return()=>uninstallLegacyMemoryWorldTreeBridge();
}

export function notifyWorldTreeChatChanged(){
  try{return safeSync('chat-changed');}catch(error){return Object.freeze({kind:'NexusWorldTreeLegacyMemorySync',skipped:true,reason:'chat-sync-error',error:error?.message||String(error)});}
}

export function notifyWorldTreeMessageRevisionChanged(reason='message-revision-invalidated'){
  try{return safeSync(reason);}catch(error){return Object.freeze({kind:'NexusWorldTreeLegacyMemorySync',skipped:true,reason:'message-sync-error',error:error?.message||String(error)});}
}

export function uninstallLegacyMemoryWorldTreeBridge(){
  for(const cleanup of cleanupFns.splice(0)){try{cleanup();}catch{}}
  installed=false;
  return true;
}

export function legacyMemoryWorldTreeBridgeStatus(){
  return Object.freeze({kind:'NexusWorldTreeLegacyMemoryBridgeStatus',installed,lastSync});
}
