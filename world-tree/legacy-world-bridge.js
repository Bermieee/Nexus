import { compareMemoryRecordParity } from './memory-read-parity.js';
import { compareCharacterBankParity } from './character-read-parity.js';
import { logSystemEvent } from '../observability/system-events.js';
import { getContext } from '../../../../st-context.js';
import { getMemoryOwnerRecords, getMemoryOwnerReadControlSnapshot, getMemoryReadAuthorityStatus, currentMemoryStoryId, memoryRecordValidity } from '../memory/store.js';
import { getCharacterOwnerBanks, getCharacterOwnerControlSnapshot, getCharacterReadAuthorityStatus, currentCharacterBankStoryId } from '../memory/character-banks.js';
import { getNexusWorldTreeOwner } from './index.js';
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
  const tree=getNexusWorldTreeOwner();
  const memoryRecords=getMemoryOwnerRecords().map(record=>({
    ...record,
    worldTreeValidity:memoryRecordValidity(record),
  }));
  const memoryControl=getMemoryOwnerReadControlSnapshot();
  const before=compareMemoryRecordParity(tree,{chatId,records:memoryRecords,control:memoryControl});
  const memory=importLegacyMemoryRecordsToWorldTree(tree,{chatId,records:memoryRecords,control:memoryControl});
  const after=compareMemoryRecordParity(tree,{chatId,records:memoryRecords,control:memoryControl});
  const memoryReadAuthority=getMemoryReadAuthorityStatus();
  for(const [phase,receipt] of [['PRE_IMPORT',before],['POST_IMPORT',after]]){
    logSystemEvent('nexus.gather','memory.read-parity',{
      ...receipt,phase,jobId:'memory-record-parity',verdict:receipt.status,
      readersSwitched:phase==='POST_IMPORT'&&memoryReadAuthority.readersSwitched===true,
      readAuthority:phase==='POST_IMPORT'?memoryReadAuthority.authority:'OWNER_IMPORT',
    });
  }
  const characterBanks=getCharacterOwnerBanks({allStories:false,includeLegacy:false});
  const characterControl=getCharacterOwnerControlSnapshot();
  const characterBefore=compareCharacterBankParity(tree,{chatId,banks:characterBanks,control:characterControl});
  const character=importLegacyCharacterBanksToWorldTree(tree,{chatId,banks:characterBanks,control:characterControl});
  const characterAfter=compareCharacterBankParity(tree,{chatId,banks:characterBanks,control:characterControl});
  const characterReadAuthority=getCharacterReadAuthorityStatus();
  for(const [phase,receipt] of [['PRE_IMPORT',characterBefore],['POST_IMPORT',characterAfter]]){
    logSystemEvent('nexus.gather','character.read-parity',{
      ...receipt,phase,jobId:'character-bank-parity',verdict:receipt.status,
      readersSwitched:phase==='POST_IMPORT'&&characterReadAuthority.readersSwitched===true,
      readAuthority:phase==='POST_IMPORT'?characterReadAuthority.authority:'OWNER_IMPORT',
    });
  }
  lastSync=Object.freeze({
    kind:'NexusWorldTreeLegacySync',chatId,reason,at:Date.now(),memory,character,
    memoryParity:{before,after},memoryReadAuthority,
    characterParity:{before:characterBefore,after:characterAfter},characterReadAuthority,
  });
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
