import { getContext } from '../../../../st-context.js';
import { getAllMemoryRecords, currentMemoryStoryId, memoryRecordValidity } from '../memory/store.js';
import { getCharacterBanks, currentCharacterBankStoryId } from '../memory/character-banks.js';
import { getNexusWorldTree } from './index.js';
import { importLegacyMemoryRecordsToWorldTree } from './import-memory-bank.js';
import { importLegacyCharacterBanksToWorldTree } from './import-character-banks.js';

let cleanupFns=[];
let installed=false;
let lastSync=null;

function addWindowListener(type,handler){
  try{
    const target=globalThis.window;
    if(!target?.addEventListener)return()=>{};
    target.addEventListener(type,handler);
    return()=>{try{target.removeEventListener(type,handler);}catch{}};
  }catch{return()=>{};}
}

function currentChatId(){
  return currentMemoryStoryId(getContext?.())||currentCharacterBankStoryId(getContext?.())||String(getContext?.()?.chatId??'').trim()||null;
}

function safeSync(reason='manual'){
  const chatId=currentChatId();
  if(!chatId)return Object.freeze({kind:'NexusWorldTreeLegacySync',skipped:true,reason:'no-active-chat'});
  const tree=getNexusWorldTree();
  const memoryRecords=getAllMemoryRecords().map(record=>({
    ...record,
    worldTreeValidity:memoryRecordValidity(record),
  }));
  const memory=importLegacyMemoryRecordsToWorldTree(tree,{chatId,records:memoryRecords});
  const character=importLegacyCharacterBanksToWorldTree(tree,{
    chatId,
    banks:getCharacterBanks({allStories:false,includeLegacy:false}),
  });
  lastSync=Object.freeze({kind:'NexusWorldTreeLegacySync',chatId,reason,at:Date.now(),memory,character});
  return lastSync;
}

export function syncLegacyWorldSourcesToWorldTree(reason='manual'){
  return safeSync(reason);
}

export function installLegacyWorldTreeBridge(){
  if(installed)return()=>uninstallLegacyWorldTreeBridge();
  installed=true;
  cleanupFns=[
    addWindowListener('tv2-memory-bank-updated',()=>safeSync('memory-bank-updated')),
    addWindowListener('tv2-character-banks-updated',()=>safeSync('character-banks-updated')),
  ];
  try{safeSync('bridge-installed');}catch{}
  return()=>uninstallLegacyWorldTreeBridge();
}

export function notifyWorldTreeChatChanged(){
  try{return safeSync('chat-changed');}catch(error){return Object.freeze({kind:'NexusWorldTreeLegacySync',skipped:true,reason:'chat-sync-error',error:error?.message||String(error)});}
}

export function notifyWorldTreeMessageRevisionChanged(reason='message-revision-invalidated'){
  try{return safeSync(reason);}catch(error){return Object.freeze({kind:'NexusWorldTreeLegacySync',skipped:true,reason:'message-sync-error',error:error?.message||String(error)});}
}

export function uninstallLegacyWorldTreeBridge(){
  for(const cleanup of cleanupFns.splice(0)){try{cleanup();}catch{}}
  installed=false;
  return true;
}

export function legacyWorldTreeBridgeStatus(){
  return Object.freeze({kind:'NexusWorldTreeLegacyBridgeStatus',installed,lastSync});
}
