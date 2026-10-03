import { getNexusWorldTreeOwner } from './index.js';
import { NexusWorldTree } from './store.js';
import { memoryTemporalStatus } from './memory-schema.js';
import { applyWorldTreeMemoryRecordState, buildWorldTreeMemoryRecordContribution } from './memory-contribution.js';
import { applyDeterministicWorldTreeContribution } from './intake/runtime.js';
import { applyWorldTreeCharacterState } from './character-state-contribution.js';
import { legacyWorldTreeMigrationStatus, persistDurableWorldTreeChat } from './durable-state.js';
import { logEvent } from '../observability/telemetry.js';

const clone=value=>value==null?value:structuredClone(value);
export function worldTreeBankAuthorityEnabled(context){return legacyWorldTreeMigrationStatus({context})?.migrated===true;}
export function syncMemoryFacadeToWorldTree({context,records=[],control={},reason='memory-facade-write'}={}){
  if(!worldTreeBankAuthorityEnabled(context))return Object.freeze({skipped:true,reason:'migration-not-active'});
  const chatId=String(context?.chatId??context?.chat_id??'').trim();if(!chatId)return Object.freeze({skipped:true,reason:'no-chat'});
  const tree=getNexusWorldTreeOwner(),receipt=applyWorldTreeMemoryRecordState({tree,context,records,control});
  const persisted=persistDurableWorldTreeChat({tree,context,reason});
  logEvent('world-tree','memory-write-origin',{chatId,reason,recordCount:(records??[]).length,worldRevision:tree.revision,persisted:persisted.persisted===true},'info');
  return Object.freeze({kind:'NexusWorldTreeMemoryWriteOrigin',chatId,receipt,persisted,worldRevision:tree.revision});
}
export function syncCharacterFacadeToWorldTree({context,banks=[],control={enabled:true},reason='character-facade-write'}={}){
  if(!worldTreeBankAuthorityEnabled(context))return Object.freeze({skipped:true,reason:'migration-not-active'});
  const chatId=String(context?.chatId??context?.chat_id??'').trim();if(!chatId)return Object.freeze({skipped:true,reason:'no-chat'});
  const tree=getNexusWorldTreeOwner(),receipt=applyWorldTreeCharacterState({tree,context,banks,control});
  const persisted=persistDurableWorldTreeChat({tree,context,reason});
  logEvent('world-tree','character-write-origin',{chatId,reason,bankCount:(banks??[]).length,worldRevision:tree.revision,persisted:persisted.persisted===true},'info');
  return Object.freeze({kind:'NexusWorldTreeCharacterWriteOrigin',chatId,receipt,persisted,worldRevision:tree.revision});
}


export function refreshWorldTreeMemoryValidity({context,validityForRecord,reason='message-revision'}={}){
  if(!worldTreeBankAuthorityEnabled(context)||typeof validityForRecord!=='function')return Object.freeze({skipped:true,reason:'migration-not-active'});
  const chatId=String(context?.chatId??context?.chat_id??'').trim();if(!chatId)return Object.freeze({skipped:true,reason:'no-chat'});
  const tree=getNexusWorldTreeOwner();let updated=0;
  for(const node of tree.iterateNodes({chatId,kind:'MEMORY'})){
    const record=clone(node.data?.sourceRecord??null);if(!record?.id||node.data?.sourcePresent===false)continue;
    const validity=validityForRecord(record),status=memoryTemporalStatus({...record,worldTreeValidity:validity});
    const sameStatus=node.temporal?.status===status,sameValidity=JSON.stringify(node.data?.sourceValidity??null)===JSON.stringify(validity??null);
    if(sameStatus&&sameValidity)continue;
    const next={...record,worldTreeValidity:validity};
    applyDeterministicWorldTreeContribution(buildWorldTreeMemoryRecordContribution({record:next,chatId}),{tree,context});updated++;
  }
  if(updated)persistDurableWorldTreeChat({tree,context,reason:'memory-validity:'+reason});
  return Object.freeze({kind:'NexusWorldTreeMemoryValidityRefresh',chatId,updated,worldRevision:tree.revision});
}


export function previewMemoryFacadeWorldTreeChatState({context,records=[],control={}}={}){
  const chatId=String(context?.chatId??context?.chat_id??'').trim();if(!chatId)throw new Error('World Tree memory preview requires active chat');
  const live=getNexusWorldTreeOwner(),tree=new NexusWorldTree({snapshot:live.exportState()});
  applyWorldTreeMemoryRecordState({tree,context,records,control});
  return tree.exportChatState({chatId});
}
