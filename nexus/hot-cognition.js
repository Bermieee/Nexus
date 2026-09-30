import { getContext } from '../../../../st-context.js';
import { HotCognitionRuntime } from './a52/hot-cognition-runtime.js';
import { HotDependencyState, HotFreshness, HotSegmentKind } from './a52/hot-cognition-contracts.js';
import { renderNexusHotNotebook } from './a52/hot-cognition-nexus.js';
import { normalizeNexusSceneObservation } from './a52/scene/nexus-observation.js';
import { stableRevisionHash } from './message-settle-barrier.js';
import { mutateChatMetadataDurably } from './host-durability.js';
import { getNexusWorldTree } from '../world-tree/index.js';
import { readWorkingState, writeWorkingState, clearWorkingState } from '../core/ephemeral-state.js';
import { logSystemEvent as logEvent } from '../observability/system-events.js';

const KEY='nexus_a52_hot_cognition_v1';
let runtime=new HotCognitionRuntime({maxRecentTail:6});
let hydratedChatId=null;
let hydratedOwner=null;
let hydratedOverlayRevision=null;
const sceneClock=new Map();

const chatIdOf=(context=getContext())=>context?.chatId??context?.chat_id??null;
const messageId=(index)=>'message:'+String(Number(index));
function messageSourceRevision(chatId,index,message){
  return stableRevisionHash({
    chatId:String(chatId??''),
    index:Number(index),
    swipeId:message?.swipe_id??null,
    isUser:message?.is_user===true,
    name:String(message?.name??''),
    text:String(message?.mes??''),
  });
}
function logReceipt(event,receipt,extra={}){
  if(!receipt)return receipt;
  storeHotWorkingState(receipt.chatNamespace??hydratedChatId);
  logEvent('nexus.hot',event,{
    chatId:receipt.chatNamespace??chatIdOf(),
    updateId:receipt.updateId??null,
    status:receipt.status??null,
    hotRevision:receipt.hotRevision??null,
    changedSegments:receipt.changedSegments??[],
    reusedSegments:receipt.reusedSegments??[],
    invalidatedSegments:receipt.invalidatedSegments??[],
    ...extra,
  },receipt.status==='STALE'||receipt.status==='REJECTED'?'warn':'debug');
  return receipt;
}

export function getNexusHotRuntime(){return runtime;}

function storeHotWorkingState(chatId=hydratedChatId){
  if(chatId==null||!runtime.hasActiveChat)return null;
  const state=runtime.exportState();
  state.states=state.states.filter(row=>String(row.chatNamespace)===String(chatId));
  const owner=getNexusWorldTree();
  const result=writeWorkingState('HOT_COGNITION',chatId,state,{worldTree:owner});
  hydratedOwner=owner;hydratedOverlayRevision=result.createdOverlayRevision;
  return result;
}

export function activateNexusHotCognition({context=getContext(),reason='CHAT_LOAD'}={}){
  const chatId=chatIdOf(context);if(chatId==null)return null;
  const id=String(chatId),owner=getNexusWorldTree();
  if(hydratedChatId===id&&hydratedOwner===owner&&hydratedOverlayRevision===owner.overlayRevision&&runtime.hasActiveChat)return runtime.snapshot(id);
  if(hydratedChatId!=null&&hydratedChatId!==id){
    clearWorkingState('HOT_COGNITION',hydratedChatId,{worldTree:hydratedOwner??owner});
    sceneClock.delete(hydratedChatId);
  }
  const ephemeral=readWorkingState('HOT_COGNITION',id,{worldTree:owner});
  const legacy=context?.chatMetadata?.[KEY];
  const state=ephemeral??(legacy?.kind==='HotCognitionPersistedState'?legacy:null);
  runtime=new HotCognitionRuntime({maxRecentTail:6});
  try{
    if(state){runtime.restoreState(state);runtime.activateChat(id,{reason});}
    else runtime.newChat(id);
  }catch(error){
    runtime=new HotCognitionRuntime({maxRecentTail:6});runtime.newChat(id);
    logEvent('nexus.hot','restore-failed',{chatId:id,error:error?.message||String(error)},'warn');
  }
  hydratedChatId=id;
  const snapshot=runtime.snapshot(id);
  if(!sceneClock.has(id))sceneClock.set(id,{key:null,revision:Number(snapshot?.sceneRevision??0)||0});
  storeHotWorkingState(id);
  // Migration deletes the old durable key; it never writes a new durable Hot key.
  if(legacy!=null)void persistNexusHotCognition({context,reason:'legacy-key-migration'});
  logEvent('nexus.hot','chat-activated',{chatId:id,reason,restored:Boolean(state),ephemeral:true,hotRevision:snapshot?.hotRevision??0},'info');
  return snapshot;
}

export async function persistNexusHotCognition({context=getContext(),reason='generation-end'}={}){
  const chatId=chatIdOf(context);
  if(chatId==null||String(chatId)!==hydratedChatId||!runtime.hasActiveChat)return {skipped:true,reason:'no-active-chat'};
  storeHotWorkingState(String(chatId));
  if(!Object.prototype.hasOwnProperty.call(context?.chatMetadata??{},KEY))return {ephemeral:true};
  try{
    await mutateChatMetadataDurably(context,'Hot Cognition legacy key removal',{keys:[KEY]},()=>{
      delete context.chatMetadata[KEY];
    });
    logEvent('nexus.hot','legacy-key-removed',{chatId:String(chatId),reason},'debug');
    return {ephemeral:true,migrated:true};
  }catch(error){
    logEvent('nexus.hot','migration-failed',{chatId:String(chatId),reason,error:error?.message||String(error)},'warn');
    return {ephemeral:true,failed:true,error};
  }
}

function nextSceneRevision(chatId,sceneScan){
  const id=String(chatId),key=String(sceneScan?.scanRevision??sceneScan?.updatedAt??'');
  const prior=sceneClock.get(id)??{key:null,revision:Number(runtime.snapshot(id)?.sceneRevision??0)||0};
  if(key&&prior.key===key&&prior.revision>0)return prior.revision;
  const revision=Math.max(1,prior.revision+1);
  sceneClock.set(id,{key,revision});
  return revision;
}

export function observeNexusHotSceneSignal({signal,context=getContext()}={}){
  const chatId=chatIdOf(context);if(chatId==null||!signal)return null;
  activateNexusHotCognition({context,reason:'SCENE_INTELLIGENCE'});
  return logReceipt('scene-signal',runtime.consumeSceneSignal(signal,{chatNamespace:String(chatId)}),{
    sceneId:signal.sceneId??null,sceneRevision:signal.sceneRevision??null,source:'scene-intelligence',
  });
}

export function observeNexusHotSceneAuthority({sceneScan,context=getContext()}={}){
  const chatId=chatIdOf(context);if(chatId==null||!sceneScan?.acceptedScene)return null;
  activateNexusHotCognition({context,reason:'SCENE_AUTHORITY'});
  const revision=nextSceneRevision(chatId,sceneScan);
  const sourceRef='scene:'+String(sceneScan.scanRevision??revision);
  const signal=normalizeNexusSceneObservation({
    scanRevision:revision,
    acceptedScene:{
      ...sceneScan.acceptedScene,
      activeThreads:sceneScan.acceptedScene.activeThreads??[],
      objects:sceneScan.acceptedScene.objects??[],
    },
  },{
    chatId:String(chatId),
    sceneId:'nexus-scene:'+String(chatId),
    sceneRevision:revision,
    sourceRevisionRefs:[sourceRef],
  });
  return logReceipt('scene-signal',runtime.consumeSceneSignal(signal,{chatNamespace:String(chatId)}),{
    scanRevision:sceneScan.scanRevision??null,
    location:sceneScan.acceptedScene.location??null,
    activeCast:sceneScan.acceptedScene.participants??[],
  });
}

export function observeNexusHotNarrativeMessage({messageIndex,message=null,activity='APPEND',context=getContext()}={}){
  const chatId=chatIdOf(context),index=Number(messageIndex);
  if(chatId==null||!Number.isFinite(index))return null;
  const row=message??context?.chat?.[index];
  if(!row||row?.is_system===true||!String(row?.mes??'').trim())return null;
  activateNexusHotCognition({context,reason:'NARRATIVE_EVIDENCE'});
  const sourceRevisionId=messageSourceRevision(chatId,index,row);
  const evidence={
    kind:'NarrativeEvidence',
    chatId:String(chatId),
    activity:String(activity||'APPEND').toUpperCase(),
    sourceRevisionId,
    messageId:messageId(index),
    messageRevision:row?.swipe_id??null,
    role:row?.is_user===true?'user':'assistant',
    content:String(row?.mes??''),
    sequence:index,
    current:true,
    invalidates:[],
  };
  return logReceipt('narrative-evidence',runtime.consumeNarrativeEvidence(evidence),{messageIndex:index,role:evidence.role,sourceRevisionId});
}

export function invalidateNexusHotMessage({messageIndex,eventName='MESSAGE_EDITED',reason='message-mutated',context=getContext()}={}){
  const chatId=chatIdOf(context),index=Number(messageIndex);
  if(chatId==null||!Number.isFinite(index))return null;
  activateNexusHotCognition({context,reason:eventName});
  const snapshot=runtime.snapshot(String(chatId));
  const tail=snapshot?.segments?.[HotSegmentKind.RECENT_EPISODE_TAIL]?.value??[];
  const refs=tail.filter(row=>String(row?.messageId??'')===messageId(index)).map(row=>row.sourceRevisionId).filter(Boolean);
  let receipt=null;
  if(refs.length)receipt=runtime.invalidateKnowledge({
    chatNamespace:String(chatId),
    invalidatedSourceRevisionRefs:refs,
    reason:String(reason),
    updateId:'message-invalidate:'+String(eventName)+':'+index+':'+refs.join('|'),
  });
  logReceipt('message-invalidated',receipt,{messageIndex:index,eventName,reason,sourceRevisionRefs:refs});
  if(eventName!=='MESSAGE_DELETED'){
    const current=context?.chat?.[index];
    if(current&&String(current?.mes??'').trim())observeNexusHotNarrativeMessage({messageIndex:index,message:current,activity:eventName==='MESSAGE_SWIPED'?'SWIPE':'EDIT',context});
  }
  return receipt;
}

export function observeNexusHotGraphNeighborhood(receipt,{context=getContext()}={}){
  const chatId=chatIdOf(context);if(chatId==null)return null;
  activateNexusHotCognition({context,reason:'GRAPH_NEIGHBORHOOD'});
  const rows=receipt?.hotNeighborhoodSummary??[];
  const state=rows.length?HotDependencyState.AVAILABLE:HotDependencyState.UNAVAILABLE;
  return logReceipt('graph-neighborhood',runtime.setGraphNeighborhood({
    chatNamespace:String(chatId),
    state,
    refs:receipt?.hotNeighborhoodRefs??[],
    entries:rows,
    sourceRevisionRefs:receipt?.hotNeighborhoodSourceRevisionRefs??[],
    identityRevisionRefs:receipt?.hotNeighborhoodIdentityRevisionRefs??[],
    dependencyRevisionRefs:receipt?.hotNeighborhoodDependencyRevisionRefs??[],
    provenanceRefs:receipt?.hotNeighborhoodRefs??[],
    updateId:'graph-neighborhood:'+String(receipt?.intentId??'turn')+':'+String(receipt?.elapsedMs??0)+':'+String(receipt?.traversedEdgeCount??0),
  }),{traversedEdgeCount:receipt?.traversedEdgeCount??0,elapsedMs:receipt?.elapsedMs??0});
}

export function currentNexusHotSnapshot({context=getContext()}={}){
  const chatId=chatIdOf(context);if(chatId==null)return null;
  activateNexusHotCognition({context,reason:'READ'});
  return runtime.snapshot(String(chatId));
}

export function renderCurrentNexusHotNotebook({context=getContext(),maxChars=5000}={}){
  const snapshot=currentNexusHotSnapshot({context});
  if(!snapshot)return'';
  const text=renderNexusHotNotebook(snapshot,{maxChars});
  return text;
}

export function resetNexusHotCognition({context=getContext(),reason='reset'}={}){
  const chatId=chatIdOf(context);
  if(hydratedChatId!=null)clearWorkingState('HOT_COGNITION',hydratedChatId,{worldTree:hydratedOwner??getNexusWorldTree()});
  if(chatId==null){runtime=new HotCognitionRuntime({maxRecentTail:6});hydratedChatId=null;sceneClock.clear();return null;}
  runtime.newChat(String(chatId));hydratedChatId=String(chatId);sceneClock.set(String(chatId),{key:null,revision:0});
  storeHotWorkingState(String(chatId));
  logEvent('nexus.hot','cleared',{chatId:String(chatId),reason},'info');
  return runtime.snapshot(String(chatId));
}

export function hotCognitionDiagnostics({context=getContext()}={}){
  const snapshot=currentNexusHotSnapshot({context});
  if(!snapshot)return null;
  const segments={};
  for(const kind of [HotSegmentKind.SCENE,HotSegmentKind.ACTIVE_CAST,HotSegmentKind.CONTINUITY,HotSegmentKind.RECENT_EPISODE_TAIL,HotSegmentKind.GRAPH_NEIGHBORHOOD]){
    const segment=snapshot.segments?.[kind];
    segments[kind]=segment?{revision:segment.revision,freshness:segment.freshness,value:segment.value}:null;
  }
  return {chatId:snapshot.chatNamespace,hotRevision:snapshot.hotRevision,sceneRevision:snapshot.sceneRevision,segments};
}
