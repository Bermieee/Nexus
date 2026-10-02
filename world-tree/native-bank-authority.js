import { getNexusWorldTreeOwner } from './index.js';
import { NexusWorldTree } from './store.js';
import { importLegacyMemoryRecordsToWorldTree, legacyMemoryControlWorldNodeId, legacyMemoryTemporalStatus } from './import-memory-bank.js';
import { importLegacyCharacterBanksToWorldTree, legacyCharacterControlWorldNodeId } from './import-character-banks.js';
import { legacyWorldTreeMigrationStatus, persistDurableWorldTreeChat } from './durable-state.js';
import { logEvent } from '../observability/telemetry.js';

const clone=value=>value==null?value:structuredClone(value);
export function worldTreeBankAuthorityEnabled(context){return legacyWorldTreeMigrationStatus({context})?.migrated===true;}
function markNodeOwner(tree,node,{chatId,mirror}={}){
  if(!node||node.scope?.type!=='CHAT'||String(node.scope.chatId)!==String(chatId))return null;
  return tree.upsertNode({...node,scope:node.scope,provenance:node.provenance,temporal:node.temporal,data:{...clone(node.data??{}),canonicalOwner:'WORLD_TREE',compatibilityMirror:mirror}});
}
export function syncMemoryFacadeToWorldTree({context,records=[],control={},reason='memory-facade-write'}={}){
  if(!worldTreeBankAuthorityEnabled(context))return Object.freeze({skipped:true,reason:'migration-not-active'});
  const chatId=String(context?.chatId??context?.chat_id??'').trim();if(!chatId)return Object.freeze({skipped:true,reason:'no-chat'});
  const tree=getNexusWorldTreeOwner(),receipt=importLegacyMemoryRecordsToWorldTree(tree,{chatId,records,control});
  const ids=new Set((records??[]).map(row=>String(row?.id??'')).filter(Boolean));
  for(const node of tree.iterateNodes({chatId,kind:'MEMORY'})){
    const id=String(node.data?.sourceRecord?.id??'');if(id&&ids.has(id)&&node.data?.sourcePresent!==false)markNodeOwner(tree,node,{chatId,mirror:'MEMORY_BANK'});
  }
  const controlNode=tree.getNode(legacyMemoryControlWorldNodeId(chatId),{chatId});if(controlNode)markNodeOwner(tree,controlNode,{chatId,mirror:'MEMORY_BANK'});
  const persisted=persistDurableWorldTreeChat({tree,context,reason});
  logEvent('world-tree','memory-write-origin',{chatId,reason,recordCount:ids.size,worldRevision:tree.revision,persisted:persisted.persisted===true},'info');
  return Object.freeze({kind:'NexusWorldTreeMemoryWriteOrigin',chatId,receipt,persisted,worldRevision:tree.revision});
}
export function syncCharacterFacadeToWorldTree({context,banks=[],control={enabled:true},reason='character-facade-write'}={}){
  if(!worldTreeBankAuthorityEnabled(context))return Object.freeze({skipped:true,reason:'migration-not-active'});
  const chatId=String(context?.chatId??context?.chat_id??'').trim();if(!chatId)return Object.freeze({skipped:true,reason:'no-chat'});
  const tree=getNexusWorldTreeOwner(),receipt=importLegacyCharacterBanksToWorldTree(tree,{chatId,banks,control});
  const ids=new Set((banks??[]).map(row=>String(row?.id??'')).filter(Boolean));
  for(const node of tree.iterateNodes({chatId})){
    if(!['CHARACTER_STATE','CHARACTER'].includes(node.kind)||node.data?.sourcePresent===false)continue;
    const bankId=String(node.data?.sourceBank?.id??'');if(bankId&&ids.has(bankId))markNodeOwner(tree,node,{chatId,mirror:'CHARACTER_BANK'});
  }
  const controlNode=tree.getNode(legacyCharacterControlWorldNodeId(chatId),{chatId});if(controlNode)markNodeOwner(tree,controlNode,{chatId,mirror:'CHARACTER_BANK'});
  const persisted=persistDurableWorldTreeChat({tree,context,reason});
  logEvent('world-tree','character-write-origin',{chatId,reason,bankCount:ids.size,worldRevision:tree.revision,persisted:persisted.persisted===true},'info');
  return Object.freeze({kind:'NexusWorldTreeCharacterWriteOrigin',chatId,receipt,persisted,worldRevision:tree.revision});
}


export function refreshWorldTreeMemoryValidity({context,validityForRecord,reason='message-revision'}={}){
  if(!worldTreeBankAuthorityEnabled(context)||typeof validityForRecord!=='function')return Object.freeze({skipped:true,reason:'migration-not-active'});
  const chatId=String(context?.chatId??context?.chat_id??'').trim();if(!chatId)return Object.freeze({skipped:true,reason:'no-chat'});
  const tree=getNexusWorldTreeOwner();let updated=0;
  for(const node of tree.iterateNodes({chatId,kind:'MEMORY'})){
    const record=clone(node.data?.sourceRecord??null);if(!record?.id||node.data?.sourcePresent===false)continue;
    const validity=validityForRecord(record),status=legacyMemoryTemporalStatus({...record,worldTreeValidity:validity});
    const sameStatus=node.temporal?.status===status,sameValidity=JSON.stringify(node.data?.sourceValidity??null)===JSON.stringify(validity??null);
    if(sameStatus&&sameValidity)continue;
    tree.upsertNode({...node,scope:node.scope,provenance:node.provenance,temporal:{...node.temporal,status,reason:validity?.valid===false?(validity?.reason??reason):node.temporal?.reason??null},data:{...clone(node.data??{}),sourceValidity:clone(validity),canonicalOwner:'WORLD_TREE',compatibilityMirror:'MEMORY_BANK'}});
    updated++;
  }
  if(updated)persistDurableWorldTreeChat({tree,context,reason:'memory-validity:'+reason});
  return Object.freeze({kind:'NexusWorldTreeMemoryValidityRefresh',chatId,updated,worldRevision:tree.revision});
}


export function previewMemoryFacadeWorldTreeChatState({context,records=[],control={}}={}){
  const chatId=String(context?.chatId??context?.chat_id??'').trim();if(!chatId)throw new Error('World Tree memory preview requires active chat');
  const live=getNexusWorldTreeOwner(),tree=new NexusWorldTree({snapshot:live.exportState()});
  importLegacyMemoryRecordsToWorldTree(tree,{chatId,records,control});
  const ids=new Set((records??[]).map(row=>String(row?.id??'')).filter(Boolean));
  for(const node of tree.iterateNodes({chatId,kind:'MEMORY'})){
    const id=String(node.data?.sourceRecord?.id??'');if(id&&ids.has(id)&&node.data?.sourcePresent!==false)markNodeOwner(tree,node,{chatId,mirror:null});
  }
  const controlNode=tree.getNode(legacyMemoryControlWorldNodeId(chatId),{chatId});if(controlNode)markNodeOwner(tree,controlNode,{chatId,mirror:null});
  return tree.exportChatState({chatId});
}
