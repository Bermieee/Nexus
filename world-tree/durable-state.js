import { logEvent } from '../observability/telemetry.js';

export const WORLD_TREE_CHAT_STATE_METADATA_KEY='nexus_world_tree_chat_state_v1';
export const WORLD_TREE_LEGACY_MIGRATION_METADATA_KEY='nexus_world_tree_legacy_migration_v1';
const clone=value=>value==null?value:structuredClone(value);
function chatIdOf(context){const id=context?.chatId??context?.chat_id;return id==null?null:String(id);}
export function readDurableWorldTreeChatState({context}={}){
  const chatId=chatIdOf(context),row=context?.chatMetadata?.[WORLD_TREE_CHAT_STATE_METADATA_KEY];
  if(!chatId||!row||row.kind!=='NexusWorldTreeChatState'||String(row.chatId)!==chatId)return null;
  return clone(row);
}
export function hydrateDurableWorldTreeChat({tree,context}={}){
  const snapshot=readDurableWorldTreeChatState({context});if(!snapshot)return{hydrated:false,reason:'no-durable-chat-state'};
  const state=tree.importChatState(snapshot,{replace:true});
  logEvent('world-tree','chat-state-hydrated',{chatId:snapshot.chatId,nodeCount:snapshot.nodes?.length??0,edgeCount:snapshot.edges?.length??0,worldRevision:state.worldRevision},'info');
  return{hydrated:true,state};
}
export function persistDurableWorldTreeChat({tree,context,reason='world-tree-mutation'}={}){
  const chatId=chatIdOf(context);if(!chatId||!context?.chatMetadata||!tree?.exportChatState)return{persisted:false,reason:'no-active-chat'};
  const snapshot=tree.exportChatState({chatId});context.chatMetadata[WORLD_TREE_CHAT_STATE_METADATA_KEY]=snapshot;
  try{context.saveMetadataDebounced?.();}catch{}
  logEvent('world-tree','chat-state-persisted',{chatId,reason,nodeCount:snapshot.nodes?.length??0,edgeCount:snapshot.edges?.length??0,worldRevision:snapshot.worldRevision},'debug');
  return{persisted:true,snapshot};
}
export function retireLegacyMemoryBankMetadata({context}={}){
  const chatId=chatIdOf(context);if(!chatId||!context?.chatMetadata)return Object.freeze({retired:false,reason:'no-chat-metadata'});
  if(!Object.prototype.hasOwnProperty.call(context.chatMetadata,'tv2_memory_bank'))return Object.freeze({retired:false,reason:'already-absent'});
  delete context.chatMetadata.tv2_memory_bank;try{context.saveMetadataDebounced?.();}catch{}
  logEvent('world-tree','legacy-memory-bank-retired',{chatId,backupKey:WORLD_TREE_LEGACY_MIGRATION_METADATA_KEY},'info');
  return Object.freeze({retired:true,chatId});
}
export function legacyWorldTreeMigrationStatus({context}={}){
  const chatId=chatIdOf(context),row=context?.chatMetadata?.[WORLD_TREE_LEGACY_MIGRATION_METADATA_KEY];
  if(!chatId||!row||String(row.chatId)!==chatId)return Object.freeze({migrated:false,chatId});
  return Object.freeze(clone(row));
}
export function markLegacyWorldTreeMigrated({tree,context,memoryBackup=null,characterBackup=null}={}){
  const chatId=chatIdOf(context);if(!chatId||!context?.chatMetadata)return Object.freeze({migrated:false,chatId,skipped:true,reason:'no-chat-metadata'});
  const prior=legacyWorldTreeMigrationStatus({context});if(prior.migrated===true)return prior;
  const snapshot=tree.exportChatState({chatId});
  const row={version:1,chatId,migrated:true,migratedAt:Date.now(),worldRevision:snapshot.worldRevision,backup:{memory:clone(memoryBackup),characters:clone(characterBackup)}};
  context.chatMetadata[WORLD_TREE_LEGACY_MIGRATION_METADATA_KEY]=row;
  context.chatMetadata[WORLD_TREE_CHAT_STATE_METADATA_KEY]=snapshot;
  retireLegacyMemoryBankMetadata({context});
  try{context.saveMetadataDebounced?.();}catch{}
  logEvent('world-tree','legacy-banks-migrated',{chatId,worldRevision:snapshot.worldRevision,memoryRecords:Object.keys(memoryBackup?.records??{}).length,characterBanks:characterBackup?.banks?.length??0,rollbackBackup:true},'info');
  return Object.freeze(clone(row));
}
export function installWorldTreeChatPersistence({tree,getContext,subscribe}={}){
  if(!tree||typeof getContext!=='function'||typeof subscribe!=='function')return()=>{};
  const release=subscribe(event=>{
    if(event?.type==='CHAT_STATE_IMPORTED')return;
    const context=getContext();if(!chatIdOf(context))return;
    persistDurableWorldTreeChat({tree,context,reason:String(event?.type??'mutation')});
  });
  return()=>release?.();
}
