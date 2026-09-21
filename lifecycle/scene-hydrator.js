import { getContext } from '../../../../st-context.js';
import { getSettings } from '../core/settings.js';
import { getStoryScopeStatus } from '../lore/active-books.js';
import { revisionFromMessages } from '../nexus/message-settle-barrier.js';
import { primeSceneScannerContext } from '../scene/scanner.js';
import { logEvent } from '../observability/telemetry.js';
import { sceneHydrationMessages } from './scene-hydration-policy.js';
export { sceneHydrationMessages } from './scene-hydration-policy.js';

const EVENT='nexus-chat-context-ready';
let last=null;

function clean(value){return String(value??'').trim();}
function clone(value){return value==null?value:JSON.parse(JSON.stringify(value));}
function policySnapshot(settings=getSettings()){
  return {
    retrievalEnabled:settings.retrieval?.enabled===true,
    changeGateEnabled:settings.retrieval?.changeGateEnabled!==false,
    smartContextEnabled:settings.smartContext?.enabled!==false,
    vectorMode:String(settings.vectorPaging?.mode||'off'),
    memoryEnabled:settings.memoryBank?.enabled!==false,
    notebookEnabled:settings.notebook?.enabled!==false,
  };
}
function fingerprint(value){return JSON.stringify(value??null);}

/**
 * Local chat-connect hydration only. No Sidecar/provider call is permitted here.
 * The resulting event is a baseline signal; individual features decide whether
 * their own later background work is eligible.
 */
export async function hydrateConnectedChatContext({context=getContext(),limit=10,source='chat-connected'}={}){
  const chatId=context?.chatId??context?.chat_id??null;
  const chat=Array.isArray(context?.chat)?context.chat:[];
  const story=getStoryScopeStatus();
  const policy=policySnapshot();
  const revision=revisionFromMessages(chat,{chatId},{includeAll:true});
  const rows=sceneHydrationMessages(chat,limit);
  // Hydration owns only cold/resumed context discovery. Scene semantics are
  // established by Scene Scanner on the first normal scene evaluation.
  const captured={chatId:chatId==null?null:String(chatId),revision:String(revision||''),story:clone(story),policy:clone(policy)};
  const live=getContext();
  const liveRevision=revisionFromMessages(live?.chat||[],{chatId:live?.chatId??null},{includeAll:true});
  const stale=String(live?.chatId??'')!==String(captured.chatId??'')
    || String(liveRevision||'')!==captured.revision
    || fingerprint(getStoryScopeStatus())!==fingerprint(captured.story)
    || fingerprint(policySnapshot())!==fingerprint(captured.policy);
  if(stale){
    logEvent('lifecycle','chat-context-hydration-discarded',{source,chatId:captured.chatId,reason:'scope-or-policy-changed'},'debug');
    return {ready:false,stale:true,cold:true,usableMessages:0,...captured};
  }
  primeSceneScannerContext({chatId:captured.chatId,messages:chat,cold:rows.length===0,source:'chat-hydration'});
  const smartWarmHydration={skipped:true,reason:'scene-hydrator-cold-start-only',count:0};
  const post=getContext();
  const postRevision=revisionFromMessages(post?.chat||[],{chatId:post?.chatId??null},{includeAll:true});
  const postStale=String(post?.chatId??'')!==String(captured.chatId??'')
    || String(postRevision||'')!==captured.revision
    || fingerprint(getStoryScopeStatus())!==fingerprint(captured.story)
    || fingerprint(policySnapshot())!==fingerprint(captured.policy);
  if(postStale){
    logEvent('lifecycle','chat-context-hydration-discarded',{source,chatId:captured.chatId,reason:'scope-or-policy-changed-during-local-warm'},'debug');
    return {ready:false,stale:true,cold:true,usableMessages:0,...captured};
  }
  const result=Object.freeze({
    version:1,source:String(source||'chat-connected'),ready:true,cold:rows.length===0,usableMessages:rows.length,
    messages:clone(rows),gate:null,warm:null,smartWarmHydration:clone(smartWarmHydration),...captured,hydratedAt:Date.now(),sidecarCalled:false,
  });
  last=result;
  logEvent('lifecycle','chat-context-ready',{source:result.source,chatId:result.chatId,revision:result.revision,usableMessages:result.usableMessages,cold:result.cold,sceneScannerPrimed:true,sidecarCalled:false},result.cold?'debug':'info');
  try{globalThis.window?.dispatchEvent?.(new CustomEvent(EVENT,{detail:clone(result)}));}catch{}
  return result;
}

export function getChatContextHydration(){return last?clone(last):null;}
export function hasHydratedChatContext(context=getContext()){
  if(!last?.ready||last.cold||last.usableMessages<=0)return false;
  return String(context?.chatId??context?.chat_id??'')===String(last.chatId??'');
}
export function clearChatContextHydration(reason='cleared'){const prior=last;last=null;if(prior)logEvent('lifecycle','chat-context-hydration-cleared',{reason,chatId:prior.chatId},'debug');return prior?clone(prior):null;}
export function chatContextReadyEventName(){return EVENT;}
