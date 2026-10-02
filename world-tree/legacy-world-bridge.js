import { compareMemoryRecordParity } from './memory-read-parity.js';
import { compareCharacterBankParity } from './character-read-parity.js';
import { logSystemEvent } from '../observability/system-events.js';
import { getContext } from '../../../../st-context.js';
import { getMemoryOwnerRecords, getMemoryOwnerReadControlSnapshot, getMemoryReadAuthorityStatus, currentMemoryStoryId, memoryRecordValidity } from '../memory/store.js';
import { getCharacterOwnerBanks, getCharacterOwnerControlSnapshot, getCharacterReadAuthorityStatus, currentCharacterBankStoryId, retireLegacyCharacterBankSettingsForCurrentStory } from '../memory/character-banks.js';
import { getNexusWorldTreeOwner } from './index.js';
import { importLegacyMemoryRecordsToWorldTree } from './import-memory-bank.js';
import { importLegacyCharacterBanksToWorldTree } from './import-character-banks.js';
import { markLegacyWorldTreeMigrated, persistDurableWorldTreeChat, legacyWorldTreeMigrationStatus, retireLegacyMemoryBankMetadata } from './durable-state.js';
import { refreshWorldTreeMemoryValidity } from './native-bank-authority.js';

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

function cloneLegacyMemoryBackup(){
  const control=getMemoryOwnerReadControlSnapshot(),records=getMemoryOwnerRecords();
  return {...structuredClone(control),records:Object.fromEntries(records.map(row=>[String(row.id),structuredClone(row)]))};
}

function currentChatId(){
  return currentMemoryStoryId(getContext?.())||currentCharacterBankStoryId(getContext?.())||String(getContext?.()?.chatId??'').trim()||null;
}

function safeSync(reason='manual'){
  const chatId=currentChatId();
  if(!chatId)return Object.freeze({kind:'NexusWorldTreeLegacySync',skipped:true,reason:'no-active-chat'});
  const tree=getNexusWorldTreeOwner(),context=getContext?.(),migration=legacyWorldTreeMigrationStatus({context});
  if(migration.migrated===true){
    retireLegacyMemoryBankMetadata({context});retireLegacyCharacterBankSettingsForCurrentStory();
    const validity=refreshWorldTreeMemoryValidity({context,validityForRecord:memoryRecordValidity,reason});
    const memoryRecords=getMemoryOwnerRecords().map(record=>({...record,worldTreeValidity:memoryRecordValidity(record)}));
    const memoryControl=getMemoryOwnerReadControlSnapshot(),memoryParity=compareMemoryRecordParity(tree,{chatId,records:memoryRecords,control:memoryControl});
    const characterBanks=getCharacterOwnerBanks({allStories:false,includeLegacy:false}),characterControl=getCharacterOwnerControlSnapshot(),characterParity=compareCharacterBankParity(tree,{chatId,banks:characterBanks,control:characterControl});
    const memoryReadAuthority=getMemoryReadAuthorityStatus(),characterReadAuthority=getCharacterReadAuthorityStatus();
    logSystemEvent('nexus.gather','memory.read-parity',{...memoryParity,phase:'MIRROR_CHECK',jobId:'memory-record-parity',verdict:memoryParity.status,readersSwitched:true,readAuthority:'WORLD_TREE'});
    logSystemEvent('nexus.gather','character.read-parity',{...characterParity,phase:'MIRROR_CHECK',jobId:'character-bank-parity',verdict:characterParity.status,readersSwitched:true,readAuthority:'WORLD_TREE'});
    lastSync=Object.freeze({
      kind:'NexusWorldTreeLegacySync',chatId,reason,at:Date.now(),
      memory:{skipped:true,reason:'world-tree-authority'},character:{skipped:true,reason:'world-tree-authority'},migration,validity,
      memoryParity:{before:memoryParity,after:memoryParity},memoryReadAuthority,
      characterParity:{before:characterParity,after:characterParity},characterReadAuthority,
    });
    return lastSync;
  }
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
  const migrationStatus=markLegacyWorldTreeMigrated({
    tree,context,
    memoryBackup:cloneLegacyMemoryBackup(),
    characterBackup:{enabled:characterControl.enabled!==false,banks:characterBanks},
  });
  retireLegacyCharacterBankSettingsForCurrentStory();
  persistDurableWorldTreeChat({tree,context,reason:'legacy-sync:'+reason});
  lastSync=Object.freeze({
    kind:'NexusWorldTreeLegacySync',chatId,reason,at:Date.now(),memory,character,migration:migrationStatus,
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
