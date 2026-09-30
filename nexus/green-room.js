import { getContext } from '../../../../st-context.js';
import { enqueueNexusModelWorkerJob } from './model-worker-bus.js';
import { getNexusSceneIntelligenceView } from './scene-intelligence.js';
import { currentNexusHotSnapshot } from './hot-cognition.js';
import { getCharacterBanks } from '../memory/character-banks.js';
import { BUS_PRIORITY, BUS_STAGE } from '../sidecar/bus.js';
import { isIntentionalCancellation } from '../core/cancellation.js';
import { logEvent } from '../observability/telemetry.js';
import {
  GreenRoomStore,
  createGreenRoomBatch,
  projectGreenRoomForGeneration,
  validateGreenRoomProviderOutput,
} from './a52/green-room.js';
import { validatePromptIntegrity } from './a52/prompt-integrity.js';

let store=new GreenRoomStore({defaultTtlTurns:2,maxCharacters:16,maxHistory:48});
let activeChatId=null;
let inferenceSeq=0;

const clean=value=>String(value??'').replace(/\s+/g,' ').trim();
const uniq=values=>[...new Set((values??[]).filter(Boolean).map(String))];
const chatIdOf=(context=getContext())=>context?.chatId??context?.chat_id??null;

function assistantTurnSequence(context=getContext()){
  return (context?.chat??[]).filter(row=>row?.is_user!==true&&row?.is_system!==true&&clean(row?.mes)).length;
}
function activate(context=getContext()){
  const chatId=chatIdOf(context);
  if(chatId==null)return null;
  const id=String(chatId);
  if(activeChatId!==id){
    if(activeChatId!=null)store.invalidate({chatSwitch:true});
    store=new GreenRoomStore({defaultTtlTurns:2,maxCharacters:16,maxHistory:48});
    activeChatId=id;
    logEvent('nexus.greenroom','chat-activated',{chatId:id,ephemeral:true},'info');
  }
  return id;
}
function bankFor(name){
  const key=clean(name).toLocaleLowerCase();
  return getCharacterBanks().find(bank=>clean(bank?.character).toLocaleLowerCase()===key)??null;
}
function evidenceFromHot(snapshot){
  const tail=snapshot?.segments?.RECENT_EPISODE_TAIL?.value??[];
  return tail.map(row=>({
    ref:String(row?.sourceRevisionId??row?.refId??''),
    messageId:row?.messageId??null,
    role:row?.role??null,
    sequence:Number(row?.sequence??0),
    excerpt:clean(row?.excerpt??'').slice(0,1600),
    sourceRevisionId:String(row?.sourceRevisionId??''),
  })).filter(row=>row.ref&&row.excerpt).slice(-6);
}
function canonicalCharacterContext(names=[]){
  return names.map(name=>{
    const bank=bankFor(name);
    return{
      characterRef:String(name),
      hasCharacterBank:Boolean(bank),
      role:bank?.role??null,
      tracking:bank?.tracking??null,
      state:bank?{
        baseline:bank.state?.baseline??null,
        persistent:bank.state?.persistent??null,
        temporary:bank.state?.temporary??null,
      }:null,
    };
  });
}
function promptFor({scene,evidence,characters,prior=[]}={}){
  const allowedDimensions=['guardedness','warmth','anger','trustTrend','anxiety','latentIntent','attentionTarget','socialPressure','uncertainty'];
  const data={
    sceneRevision:Number(scene?.revision??0),
    scene:{
      sceneId:scene?.sceneId??null,
      location:scene?.location??null,
      participants:[...(scene?.participants??[])],
      activity:scene?.activity??null,
      focus:scene?.focus??null,
      threads:[...(scene?.threads??[])],
      objectives:[...(scene?.objectives??[])],
    },
    characters:canonicalCharacterContext(characters),
    evidence,
    prior:prior.map(row=>({
      characterRef:row.characterRef,
      dimensions:row.dimensions,
      confidence:row.confidence,
      directEvidenceRefs:row.directEvidenceRefs,
    })),
    allowedDimensions,
  };
  const systemPrompt='Nexus Green Room worker. Infer short-lived, non-canonical character state only for the supplied active characters and only from supplied evidence. Never mutate Character Banks, memory, lore, or canon. Do not state hard facts that the evidence does not support. Return one JSON object: {"sceneRevision":NUMBER,"authority":"INFERRED","characters":[{"characterRef":"NAME","confidence":0..1,"dimensions":{"guardedness":0..1|null,"warmth":0..1|null,"anger":0..1|null,"trustTrend":"DOWN|STABLE|UP|UNKNOWN","anxiety":0..1|null,"latentIntent":"short text"|null,"attentionTarget":"short text"|null,"socialPressure":0..1|null,"uncertainty":0..1|null},"directEvidenceRefs":["ONLY supplied evidence.ref values"],"sourceRevisionSet":["ONLY supplied evidence.sourceRevisionId values"],"expiryCondition":{"ttlTurns":2,"onSceneClose":true,"onSceneReplacement":true,"onMajorTimeShift":true,"onCharacterDeparture":true,"onContradiction":true,"onSourceRevisionInvalidation":true}}]}. Omit a character rather than guess. authority must be INFERRED. No markdown or prose.';
  return{systemPrompt,prompt:'UNTRUSTED_GREEN_ROOM_INPUT_JSON\n'+JSON.stringify({data}),data};
}
function validatorFor({sceneRevision,characters,evidence}){
  const knownEvidenceRefs=evidence.map(row=>row.ref);
  const knownSourceRefs=new Set(evidence.map(row=>row.sourceRevisionId));
  return value=>{
    try{
      const batch=validateGreenRoomProviderOutput(value,{
        sceneRevision,
        knownCharacterRefs:characters,
        knownEvidenceRefs,
      });
      for(const row of batch.characters){
        for(const ref of row.sourceRevisionSet)if(!knownSourceRefs.has(String(ref)))throw new Error('Unknown Green Room source revision: '+ref);
      }
      return{valid:true,value:batch,score:10};
    }catch(error){return{valid:false,value:null,score:0,reason:error?.message||String(error)};}
  };
}

export async function runNexusGreenRoomPostTurn({context=getContext()}={}){
  const chatId=activate(context);if(chatId==null)return{skipped:true,reason:'no-chat'};
  const scene=getNexusSceneIntelligenceView({chatId});if(!scene)return{skipped:true,reason:'no-scene'};
  const characters=uniq(scene.participants??[]).slice(0,16);
  if(!characters.length){store.invalidate({sceneReplaced:true});return{skipped:true,reason:'no-active-cast'};}
  const hot=currentNexusHotSnapshot({context}),evidence=evidenceFromHot(hot);
  if(!evidence.length)return{skipped:true,reason:'no-recent-evidence'};
  const turnSequence=assistantTurnSequence(context);
  const prior=store.active({turnSequence,sceneRevision:scene.revision,activeCharacterRefs:characters});
  const built=promptFor({scene,evidence,characters,prior});
  const validate=validatorFor({sceneRevision:scene.revision,characters,evidence});
  try{
    const job=enqueueNexusModelWorkerJob('green-room',BUS_STAGE.GREEN_ROOM,{
      prompt:built.prompt,
      systemPrompt:built.systemPrompt,
      responseFormat:'json_object',
      excludeReasoning:true,
      reasoningEffort:'low',
      priority:BUS_PRIORITY.GREEN_ROOM,
      role:'maintenance',
      foregroundAdjacent:false,
      preemptible:true,
      maxAttempts:1,
      dedupKey:'green-room:'+chatId+':'+scene.sceneId+':'+scene.revision+':'+turnSequence,
      label:'Green Room inference',
      telemetry:{greenRoom:true,sceneId:scene.sceneId,sceneRevision:scene.revision,activeCharacters:characters.length,evidenceCount:evidence.length},
    });
    const response=await job.promise;
    const raw=response?.structuredPayload??response?.text??'';
    const checked=validate(typeof raw==='string'?raw:raw);
    if(!checked.valid)throw new Error(checked.reason||'Green Room output failed validation');
    const batch=checked.value?.kind==='GreenRoomBatch'?checked.value:createGreenRoomBatch(checked.value);
    const accepted=store.putBatch(batch,{turnSequence,activeCharacterRefs:characters});
    const active=store.active({turnSequence,sceneRevision:scene.revision,activeCharacterRefs:characters});
    logEvent('nexus.greenroom','inference-complete',{
      chatId,sceneId:scene.sceneId,sceneRevision:scene.revision,turnSequence,
      requestedCharacters:characters,accepted,activeCount:active.length,
      slot:response?.tv2?.slot??null,authority:'INFERRED',
    },'info');
    return{updated:accepted>0,accepted,activeCount:active.length,slot:response?.tv2?.slot??null};
  }catch(error){
    if(isIntentionalCancellation(error))return{deferred:true,cancelled:true,reason:error?.name||'cancelled'};
    logEvent('nexus.greenroom','inference-skipped',{chatId,sceneId:scene.sceneId,sceneRevision:scene.revision,error:error?.message||String(error),fallback:'SKIP_GREEN_ROOM'},'warn');
    return{skipped:true,reason:'inference-failed',error};
  }
}

export function getNexusGreenRoomProjection({context=getContext()}={}){
  const chatId=activate(context);if(chatId==null)return null;
  const scene=getNexusSceneIntelligenceView({chatId});
  if(!scene)return projectGreenRoomForGeneration([],{sceneRevision:null});
  const activeCharacterRefs=uniq(scene.participants??[]);
  const turnSequence=assistantTurnSequence(context);
  const projection=projectGreenRoomForGeneration(store,{
    sceneRevision:scene.revision,
    turnSequence,
    activeCharacterRefs,
  });
  const integrity=validatePromptIntegrity({greenRoom:projection.characters});
  if(integrity?.ok===false){
    logEvent('nexus.greenroom','prompt-integrity-rejected',{chatId,sceneId:scene.sceneId,sceneRevision:scene.revision,violations:integrity.violations},'error');
    return Object.freeze({...projection,characters:Object.freeze([]),integrity});
  }
  return Object.freeze({...projection,integrity});
}

export function renderNexusGreenRoom(projection=getNexusGreenRoomProjection()){
  const rows=projection?.characters??[];
  if(!rows.length)return'';
  const lines=['GREEN ROOM — INFERRED / NON-CANONICAL / SHORT-LIVED'];
  for(const row of rows){
    const parts=[];
    for(const [key,value] of Object.entries(row.dimensions??{})){
      if(value==null||value===''||value==='UNKNOWN')continue;
      parts.push(key+'='+String(value));
    }
    lines.push('- '+row.characterRef+' | confidence='+Number(row.confidence??0).toFixed(2)+(parts.length?' | '+parts.join(' | '):''));
  }
  lines.push('Use as tentative characterization only. Canonical lore, current scene observations, and explicit user direction outrank these inferences.');
  return lines.join('\n');
}

export function invalidateNexusGreenRoomForSourceChange({reason='source-revision-invalidated'}={}){
  if(activeChatId==null)return 0;
  const rows=store.active({});
  const refs=uniq(rows.flatMap(row=>row.sourceRevisionSet??[]));
  const count=refs.length?store.invalidate({invalidatedSourceRevisionIds:refs}):0;
  logEvent('nexus.greenroom','source-invalidated',{chatId:activeChatId,reason,count,sourceRevisionCount:refs.length},count?'info':'debug');
  return count;
}
export function resetNexusGreenRoom({reason='reset'}={}){
  const prior=activeChatId;
  if(prior!=null)store.invalidate({chatSwitch:true});
  store=new GreenRoomStore({defaultTtlTurns:2,maxCharacters:16,maxHistory:48});
  activeChatId=null;
  logEvent('nexus.greenroom','cleared',{chatId:prior,reason},'info');
  return true;
}
export function nexusGreenRoomDiagnostics({context=getContext()}={}){
  const projection=getNexusGreenRoomProjection({context});
  return{chatId:activeChatId,metrics:store.metrics(),projection};
}
