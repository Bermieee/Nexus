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

let lastMigration=null;
function cloneLegacyMemoryBackup(){
  const control=getMemoryOwnerReadControlSnapshot(),records=getMemoryOwnerRecords();
  return {...structuredClone(control),records:Object.fromEntries(records.map(row=>[String(row.id),structuredClone(row)]))};
}
function currentChatId(){
  return currentMemoryStoryId(getContext?.())||currentCharacterBankStoryId(getContext?.())||String(getContext?.()?.chatId??'').trim()||null;
}
function diagnosticParity(tree,{chatId}={}){
  const memoryRecords=getMemoryOwnerRecords().map(record=>({...record,worldTreeValidity:memoryRecordValidity(record)})),memoryControl=getMemoryOwnerReadControlSnapshot();
  const memoryParity=compareMemoryRecordParity(tree,{chatId,records:memoryRecords,control:memoryControl});
  const characterBanks=getCharacterOwnerBanks({allStories:false,includeLegacy:false}),characterControl=getCharacterOwnerControlSnapshot();
  const characterParity=compareCharacterBankParity(tree,{chatId,banks:characterBanks,control:characterControl});
  return{memoryRecords,memoryControl,memoryParity,characterBanks,characterControl,characterParity};
}
export function migrateLegacyWorldSourcesToWorldTree(reason='startup'){
  const chatId=currentChatId();if(!chatId)return Object.freeze({kind:'NexusWorldTreeLegacyMigration',skipped:true,reason:'no-active-chat'});
  const tree=getNexusWorldTreeOwner(),context=getContext?.(),migration=legacyWorldTreeMigrationStatus({context});
  if(migration.migrated===true){
    retireLegacyMemoryBankMetadata({context});retireLegacyCharacterBankSettingsForCurrentStory();
    const state=diagnosticParity(tree,{chatId}),memoryReadAuthority=getMemoryReadAuthorityStatus(),characterReadAuthority=getCharacterReadAuthorityStatus();
    logSystemEvent('nexus.gather','memory.read-parity',{...state.memoryParity,phase:'MIGRATED_AUTHORITY_CHECK',jobId:'memory-record-parity',verdict:state.memoryParity.status,readersSwitched:true,readAuthority:'WORLD_TREE'});
    logSystemEvent('nexus.gather','character.read-parity',{...state.characterParity,phase:'MIGRATED_AUTHORITY_CHECK',jobId:'character-bank-parity',verdict:state.characterParity.status,readersSwitched:true,readAuthority:'WORLD_TREE'});
    lastMigration=Object.freeze({kind:'NexusWorldTreeLegacyMigration',chatId,reason,at:Date.now(),skipped:true,migration,
      memory:{skipped:true,reason:'already-migrated'},character:{skipped:true,reason:'already-migrated'},
      memoryParity:{before:state.memoryParity,after:state.memoryParity},memoryReadAuthority,
      characterParity:{before:state.characterParity,after:state.characterParity},characterReadAuthority});
    return lastMigration;
  }
  const memoryRecords=getMemoryOwnerRecords().map(record=>({...record,worldTreeValidity:memoryRecordValidity(record)})),memoryControl=getMemoryOwnerReadControlSnapshot();
  const before=compareMemoryRecordParity(tree,{chatId,records:memoryRecords,control:memoryControl});
  const memory=importLegacyMemoryRecordsToWorldTree(tree,{chatId,records:memoryRecords,control:memoryControl});
  const after=compareMemoryRecordParity(tree,{chatId,records:memoryRecords,control:memoryControl}),memoryReadAuthority=getMemoryReadAuthorityStatus();
  for(const [phase,receipt] of [['PRE_IMPORT',before],['POST_IMPORT',after]])logSystemEvent('nexus.gather','memory.read-parity',{...receipt,phase,jobId:'memory-record-parity',verdict:receipt.status,readersSwitched:phase==='POST_IMPORT'&&memoryReadAuthority.readersSwitched===true,readAuthority:phase==='POST_IMPORT'?memoryReadAuthority.authority:'OWNER_IMPORT'});
  const characterBanks=getCharacterOwnerBanks({allStories:false,includeLegacy:false}),characterControl=getCharacterOwnerControlSnapshot();
  const characterBefore=compareCharacterBankParity(tree,{chatId,banks:characterBanks,control:characterControl});
  const character=importLegacyCharacterBanksToWorldTree(tree,{chatId,banks:characterBanks,control:characterControl});
  const characterAfter=compareCharacterBankParity(tree,{chatId,banks:characterBanks,control:characterControl}),characterReadAuthority=getCharacterReadAuthorityStatus();
  for(const [phase,receipt] of [['PRE_IMPORT',characterBefore],['POST_IMPORT',characterAfter]])logSystemEvent('nexus.gather','character.read-parity',{...receipt,phase,jobId:'character-bank-parity',verdict:receipt.status,readersSwitched:phase==='POST_IMPORT'&&characterReadAuthority.readersSwitched===true,readAuthority:phase==='POST_IMPORT'?characterReadAuthority.authority:'OWNER_IMPORT'});
  const migrationStatus=markLegacyWorldTreeMigrated({tree,context,memoryBackup:cloneLegacyMemoryBackup(),characterBackup:{enabled:characterControl.enabled!==false,banks:characterBanks}});
  retireLegacyCharacterBankSettingsForCurrentStory();persistDurableWorldTreeChat({tree,context,reason:'legacy-migration:'+reason});
  lastMigration=Object.freeze({kind:'NexusWorldTreeLegacyMigration',chatId,reason,at:Date.now(),memory,character,migration:migrationStatus,
    memoryParity:{before,after},memoryReadAuthority,characterParity:{before:characterBefore,after:characterAfter},characterReadAuthority});
  return lastMigration;
}
export function notifyWorldTreeChatChanged(){
  try{return migrateLegacyWorldSourcesToWorldTree('chat-changed');}
  catch(error){return Object.freeze({kind:'NexusWorldTreeLegacyMigration',skipped:true,reason:'chat-migration-error',error:error?.message||String(error)});}
}
export function notifyWorldTreeMessageRevisionChanged(reason='message-revision-invalidated'){
  try{
    const context=getContext?.(),migration=legacyWorldTreeMigrationStatus({context});
    if(migration.migrated===true)return refreshWorldTreeMemoryValidity({context,validityForRecord:memoryRecordValidity,reason});
    return migrateLegacyWorldSourcesToWorldTree(reason);
  }catch(error){return Object.freeze({kind:'NexusWorldTreeMemoryValidityRefresh',skipped:true,reason:'message-validity-error',error:error?.message||String(error)});}
}
export function legacyWorldTreeMigrationRuntimeStatus(){return Object.freeze({kind:'NexusWorldTreeLegacyMigrationStatus',lastMigration});}
