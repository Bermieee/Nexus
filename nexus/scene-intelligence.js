import { publishOwnerResult } from '../scheduler/owner-steps.js';
import { getContext } from '../../../../st-context.js';
import { enqueueNexusModelWorkerJob } from './model-worker-bus.js';
import { stableRevisionHash } from './message-settle-barrier.js';
import { mutateChatMetadataDurably } from './host-durability.js';
import { logSystemEvent as logEvent } from '../observability/system-events.js';
import { BUS_PRIORITY, BUS_STAGE } from '../sidecar/bus.js';
import { isIntentionalCancellation } from '../core/cancellation.js';
import {
  BoundaryStatus, CastPresence, ObservationClass, SceneLifecycle, createFieldState,
} from './a52/scene/contracts.js';
import { createCurrentScene, scenePublicView } from './a52/scene/current-scene.js';
import { ActiveCastResolver } from './a52/scene/active-cast.js';
import { SpatialStateTracker } from './a52/scene/spatial-state.js';
import { SemanticBoundaryDetector } from './a52/scene/boundary-detector.js';
import { BoundaryVerifier } from './a52/scene/boundary-verifier.js';
import {
  buildSceneObservationPrompt, normalizeSceneObservationOutput, sceneObservationValidator,
} from './a52/scene/observation-specialist.js';
import { observeNexusHotSceneSignal } from './hot-cognition.js';
import { TASK8_POSTTURN_SITE_IDS, runTask8ChoiceDecision } from '../decision/task8-postturn-sites.js';

const KEY='nexus_a52_scene_intelligence_v1';
let state=null;
let detector=new SemanticBoundaryDetector();
let verifier=new BoundaryVerifier();
const castResolver=new ActiveCastResolver();
const spatialTracker=new SpatialStateTracker();

const clone=value=>value==null?value:structuredClone(value);
const chatIdOf=(context=getContext())=>context?.chatId??context?.chat_id??null;
const clean=value=>String(value??'').replace(/\s+/g,' ').trim();
const uniq=values=>[...new Set((values??[]).filter(Boolean).map(String))];

function observedField(value,evidenceRef,revision,{confidence=1,observationClass=ObservationClass.OBSERVED,metadata={}}={}){
  if(observationClass===ObservationClass.UNKNOWN)return createFieldState({value,confidence:0,evidenceRefs:[],observationClass,revision,metadata});
  return createFieldState({value,confidence,evidenceRefs:[String(evidenceRef)],observationClass,revision,provenance:['nexus-scene-intelligence'],metadata});
}
function unknownFieldFrom(previous,revision,metadata={}){
  return createFieldState({value:clone(previous?.value??null),confidence:0,evidenceRefs:[],observationClass:ObservationClass.UNKNOWN,revision,metadata});
}
function currentMessageIndex(context){return Math.max(0,(context?.chat?.length??1)-1);}
function scannerEvidenceRef(sceneScan){return 'scene-scan:'+String(sceneScan?.scanRevision??sceneScan?.updatedAt??Date.now());}

function scanFields(sceneScan,evidenceRef,revision){
  const scan=sceneScan?.acceptedScene??{};
  const participants=uniq(scan.participants??[]);
  const previousCast=state?.current?.fields?.activeCast?.value??[];
  const presentSet=new Set(participants.map(name=>String(name).toLocaleLowerCase()));
  const castObservations=[
    ...participants.map(characterId=>({characterId,state:CastPresence.PRESENT,confidence:1,evidenceRefs:[evidenceRef],reason:'Nexus Scene Scanner',explicit:true})),
    ...previousCast.filter(row=>row?.characterId&&!presentSet.has(String(row.characterId).toLocaleLowerCase())).map(row=>({characterId:row.characterId,state:CastPresence.DEPARTED,confidence:1,evidenceRefs:[evidenceRef],reason:'Nexus Scene Scanner absence',explicit:true})),
  ];
  const cast=castResolver.resolve({
    previous:previousCast,observations:castObservations,
    revision,evidenceRefs:[evidenceRef],
  });
  const spatial=spatialTracker.update({
    previous:state?.current?.fields?.location,
    revision,evidenceRefs:[evidenceRef],
    proposal:clean(scan.location)?{location:clean(scan.location),observationClass:ObservationClass.OBSERVED,confidence:1}:{observationClass:ObservationClass.UNKNOWN},
  });
  const threads=uniq([scan.objective,scan.focus]).map(threadId=>({threadId}));
  return{
    location:spatial,
    narrativeTime:clean(scan.timeContext)?observedField(clean(scan.timeContext),evidenceRef,revision):unknownFieldFrom(state?.current?.fields?.narrativeTime,revision),
    activeCast:cast,
    immediateObjects:unknownFieldFrom(state?.current?.fields?.immediateObjects,revision),
    activeRelationships:scan.relationshipFocus===true
      ? observedField([{relationshipType:'FOCUS',state:'ACTIVE'}],evidenceRef,revision)
      : unknownFieldFrom(state?.current?.fields?.activeRelationships,revision),
    activeThreads:threads.length?observedField(threads,evidenceRef,revision):unknownFieldFrom(state?.current?.fields?.activeThreads,revision),
    activeObjectives:clean(scan.objective)?observedField([{objective:clean(scan.objective)}],evidenceRef,revision):unknownFieldFrom(state?.current?.fields?.activeObjectives,revision),
    atmosphere:(clean(scan.activity)||clean(scan.focus))?observedField({activity:clean(scan.activity)||null,focus:clean(scan.focus)||null,relationshipFocus:scan.relationshipFocus===true},evidenceRef,revision):unknownFieldFrom(state?.current?.fields?.atmosphere,revision),
  };
}

function phaseABoundarySignals(gate,sceneScan){
  const delta=sceneScan?.delta??sceneScan?.sceneDelta??{};
  const mode=String(gate?.mode??'').toUpperCase();
  return{
    explicitBreak:mode.includes('MAJOR')?1:0,
    locationTransition:delta?.location?.changed===true?.95:0,
    majorTimeJump:delta?.timeContext?.changed===true?.9:0,
    castReplacement:(delta?.participants?.added?.length||delta?.participants?.removed?.length)?Math.min(1,((delta.participants.added?.length||0)+(delta.participants.removed?.length||0))/3):0,
  };
}

function boundaryDecision(signals,evidenceRef,{force=false}={}){
  if(!state?.current)return null;
  const candidate=detector.detect({sceneId:state.current.sceneId,evidenceRefs:[evidenceRef],signals});
  if(!candidate)return null;
  let decision=verifier.submit(candidate);
  if(decision.status===BoundaryStatus.PENDING){
    const support=Math.max(force?1:0,...Object.values(signals??{}).map(row=>typeof row==='number'?row:Number(row?.strength??0)));
    decision=verifier.observe(candidate.candidateId,{support,evidenceRefs:[evidenceRef]});
  }
  return decision;
}

function createSceneFromFields(fields,{sceneId,revision=1,sourceRevisionRefs=[],sourceRange=null,provenance=[]}={}){
  return createCurrentScene({
    sceneId,revision,lifecycle:SceneLifecycle.OPEN,
    sourceRange:sourceRange??{start:null,end:null},
    sourceRevisionRefs:uniq(sourceRevisionRefs),
    fields,provenance:uniq(provenance),
    unresolvedFields:Object.entries(fields).filter(([,field])=>[ObservationClass.UNKNOWN,ObservationClass.UNRESOLVED].includes(field?.observationClass)).map(([name])=>name),
  });
}

function openScene(fields,{evidenceRef,sourceRevisionId,reason='boundary'}={}){
  if(state.current){
    const closed={...clone(state.current),lifecycle:SceneLifecycle.CLOSED,updatedAt:Date.now()};
    state.history.push(closed);while(state.history.length>24)state.history.shift();
  }
  state.sceneSequence+=1;
  const sceneId='nexus-scene:'+state.chatId+':'+state.sceneSequence;
  const revision=1;
  const normalized=Object.fromEntries(Object.entries(fields).map(([name,field])=>[name,{...clone(field),revision}]));
  state.current=createSceneFromFields(normalized,{
    sceneId,revision,sourceRevisionRefs:[sourceRevisionId],
    sourceRange:{start:currentMessageIndex(getContext()),end:currentMessageIndex(getContext())},
    provenance:[evidenceRef,reason],
  });
  state.lastBoundary={sceneId,boundaryAt:Date.now(),reason,evidenceRef};
  return state.current;
}

function updateScene(fields,{evidenceRef,sourceRevisionId,reason='observation'}={}){
  if(!state.current)return openScene(fields,{evidenceRef,sourceRevisionId,reason:'initial'});
  const revision=state.current.revision+1;
  const merged={};
  for(const [name,prior] of Object.entries(state.current.fields??{}))merged[name]=clone(prior);
  for(const [name,field] of Object.entries(fields??{}))merged[name]={...clone(field),revision};
  state.current=createSceneFromFields(merged,{
    sceneId:state.current.sceneId,revision,
    sourceRevisionRefs:uniq([...(state.current.sourceRevisionRefs??[]),sourceRevisionId]),
    sourceRange:{start:state.current.sourceRange?.start??currentMessageIndex(getContext()),end:currentMessageIndex(getContext())},
    provenance:uniq([...(state.current.provenance??[]),evidenceRef,reason]),
  });
  return state.current;
}

function persistedState(){
  return{kind:'NexusSceneIntelligencePersistedState',version:1,chatId:state?.chatId??null,sceneSequence:state?.sceneSequence??0,current:clone(state?.current??null),history:clone(state?.history??[]),sourceByMessage:clone(state?.sourceByMessage??{}),lastBoundary:clone(state?.lastBoundary??null),lastObservation:clone(state?.lastObservation??null)};
}

export function activateNexusSceneIntelligence({context=getContext(),reason='CHAT_LOAD'}={}){
  const chatId=chatIdOf(context);if(chatId==null)return null;
  const id=String(chatId);if(state?.chatId===id)return getNexusSceneIntelligenceView({chatId:id});
  const persisted=context?.chatMetadata?.[KEY];
  if(persisted?.kind==='NexusSceneIntelligencePersistedState'&&String(persisted.chatId)===id){
    state={chatId:id,sceneSequence:Number(persisted.sceneSequence??0)||0,current:clone(persisted.current),history:clone(persisted.history??[]).slice(-24),sourceByMessage:clone(persisted.sourceByMessage??{}),lastBoundary:clone(persisted.lastBoundary??null),lastObservation:clone(persisted.lastObservation??null)};
  }else state={chatId:id,sceneSequence:0,current:null,history:[],sourceByMessage:{},lastBoundary:null,lastObservation:null};
  detector=new SemanticBoundaryDetector();verifier=new BoundaryVerifier();
  logEvent('nexus.scene','chat-activated',{chatId:id,reason,restored:Boolean(persisted),sceneId:state.current?.sceneId??null,revision:state.current?.revision??0},'info');
  return getNexusSceneIntelligenceView({chatId:id});
}

export async function persistNexusSceneIntelligence({context=getContext(),reason='post-turn'}={}){
  const chatId=chatIdOf(context);if(chatId==null||!state||String(state.chatId)!==String(chatId))return{skipped:true,reason:'no-active-scene'};
  const value=persistedState();
  try{
    await mutateChatMetadataDurably(context,'Scene Intelligence persistence',{keys:[KEY],expected:{[KEY]:value}},()=>{
      context.chatMetadata=context.chatMetadata||{};context.chatMetadata[KEY]=value;return value;
    });
    logEvent('nexus.scene','persisted',{chatId:String(chatId),reason,sceneId:state.current?.sceneId??null,revision:state.current?.revision??0},'debug');
    return{persisted:true};
  }catch(error){logEvent('nexus.scene','persist-failed',{chatId:String(chatId),reason,error:error?.message||String(error)},'warn');return{failed:true,error};}
}

export function observeNexusSceneAuthority({sceneScan,gate,context=getContext()}={}){
  const chatId=chatIdOf(context);if(chatId==null||!sceneScan?.acceptedScene)return null;
  activateNexusSceneIntelligence({context,reason:'SCENE_AUTHORITY'});
  const evidenceRef=scannerEvidenceRef(sceneScan),sourceRevisionId=evidenceRef;
  if(String(gate?.mode??'').toUpperCase().includes('NO_CHANGE')&&state.current){
    state.lastObservation={path:'scanner-reuse',evidenceRef,at:Date.now()};
    try{observeNexusHotSceneSignal({signal:nexusSceneIntegrationSignal({chatId:String(chatId)}),context});}catch{}
    logEvent('nexus.scene','scanner-reused',{chatId:String(chatId),sceneId:state.current.sceneId,revision:state.current.revision,gateMode:gate?.mode??null},'debug');
    return getNexusSceneIntelligenceView({chatId:String(chatId)});
  }
  const nextRevision=state.current?state.current.revision+1:1;
  const fields=scanFields(sceneScan,evidenceRef,nextRevision);
  const signals=phaseABoundarySignals(gate,sceneScan);
  const decision=state.current?boundaryDecision(signals,evidenceRef,{force:String(gate?.mode??'').toUpperCase().includes('MAJOR')}):null;
  const boundaryConfirmed=decision?.status===BoundaryStatus.CONFIRMED||String(gate?.mode??'').toUpperCase().includes('MAJOR');
  const scene=boundaryConfirmed
    ? openScene(fields,{evidenceRef,sourceRevisionId,reason:'change-gate:'+String(gate?.mode??'MAJOR')})
    : updateScene(fields,{evidenceRef,sourceRevisionId,reason:'change-gate:'+String(gate?.mode??'SCAN')});
  state.lastObservation={path:'scanner',evidenceRef,at:Date.now(),gateMode:gate?.mode??null,boundaryDecision:clone(decision)};
  try{observeNexusHotSceneSignal({signal:nexusSceneIntegrationSignal({chatId:String(chatId)}),context});}catch{}
  logEvent('nexus.scene','scanner-observed',{chatId:String(chatId),sceneId:scene.sceneId,revision:scene.revision,gateMode:gate?.mode??null,boundaryConfirmed,path:'scanner'},'info');
  return getNexusSceneIntelligenceView({chatId:String(chatId)});
}

function deterministicObservation({narrative,sceneScan,evidenceRef}={}){
  const scan=sceneScan?.acceptedScene??{};
  const fields={};
  if(clean(scan.location))fields.location={value:{location:clean(scan.location)},confidence:1,observationClass:'OBSERVED'};
  if(clean(scan.timeContext))fields.narrativeTime={value:clean(scan.timeContext),confidence:1,observationClass:'OBSERVED'};
  if((scan.participants??[]).length)fields.activeCast={value:uniq(scan.participants).map(characterId=>({characterId,state:'PRESENT'})),confidence:1,observationClass:'OBSERVED'};
  const threads=uniq([scan.objective,scan.focus]);if(threads.length)fields.activeThreads={value:threads.map(threadId=>({threadId})),confidence:.9,observationClass:'OBSERVED'};
  if(clean(scan.objective))fields.activeObjectives={value:[{objective:clean(scan.objective)}],confidence:.9,observationClass:'OBSERVED'};
  if(clean(scan.activity)||clean(scan.focus))fields.atmosphere={value:{activity:clean(scan.activity)||null,focus:clean(scan.focus)||null},confidence:.8,observationClass:'OBSERVED'};
  const objects=[];
  const re=/\b(?:holds?|holding|carries|carrying|wears?|wields?|takes?|picked up|grabs?)\s+(?:the\s+|a\s+|an\s+)?([\p{L}\p{N}'-]+(?:\s+[\p{L}\p{N}'-]+){0,3})/giu;
  for(const match of String(narrative??'').matchAll(re)){const name=clean(match[1]).replace(/[.!?,;:].*$/,'');if(name&&name.length<=80&&!objects.some(row=>row.objectId.toLocaleLowerCase()===name.toLocaleLowerCase()))objects.push({objectId:name,state:'PRESENT'});if(objects.length>=12)break;}
  if(objects.length)fields.immediateObjects={value:objects,confidence:.7,observationClass:'OBSERVED'};
  const delta=sceneScan?.delta??{};
  const boundarySignals={
    ...(delta?.location?.changed===true?{locationTransition:{strength:.9}}:{}),
    ...(delta?.timeContext?.changed===true?{majorTimeJump:{strength:.8}}:{}),
  };
  return normalizeSceneObservationOutput({fields,boundarySignals});
}

async function applyWorkerObservation(payload,{messageIndex,evidenceRef,sourceRevisionId,path,gate=null,context=getContext()}={}){
  activateNexusSceneIntelligence({context,reason:'POST_RESPONSE'});
  if(!state.current)return null;
  const revision=state.current.revision+1,fields={};
  for(const [name,row] of Object.entries(payload?.fields??{})){
    const classification=ObservationClass[String(row.observationClass??'UNKNOWN')]??ObservationClass.UNKNOWN;
    fields[name]=classification===ObservationClass.UNKNOWN
      ? unknownFieldFrom(state.current.fields?.[name],revision,{postResponse:true,path})
      : observedField(clone(row.value),evidenceRef,revision,{confidence:Number(row.confidence??0),observationClass:classification,metadata:{postResponse:true,path}});
  }
  const decision=boundaryDecision(payload?.boundarySignals??{},evidenceRef);
  let boundaryConfirmed=decision?.status===BoundaryStatus.CONFIRMED;
  const gateMode=String(gate?.mode??'').toUpperCase();
  const gateBoundary=gateMode.includes('MAJOR');
  if((gateMode.includes('MINOR')||gateMode.includes('MAJOR'))&&boundaryConfirmed!==gateBoundary){
    const fallback=gateBoundary?'SCENE_CUT':'MINOR_SHIFT';
    const boundaryRun=await runTask8ChoiceDecision(TASK8_POSTTURN_SITE_IDS.SCENE_BOUNDARY,{
      state:{gate:gateMode,observationBoundary:boundaryConfirmed?'SCENE_CUT':'MINOR_SHIFT',boundarySignals:payload?.boundarySignals??{},sceneId:state.current?.sceneId??null,sceneRevision:state.current?.revision??0},
    },fallback,{reasonCode:'CHANGE_GATE_VERDICT',telemetrySelection:{chatId:state.chatId}});
    boundaryConfirmed=boundaryRun.choice==='SCENE_CUT';
  }
  const next=boundaryConfirmed
    ? openScene({...Object.fromEntries(Object.entries(state.current.fields).map(([name,field])=>[name,clone(field)])),...fields},{evidenceRef,sourceRevisionId,reason:'post-response-boundary'})
    : updateScene(fields,{evidenceRef,sourceRevisionId,reason:'post-response:'+path});
  state.sourceByMessage[String(messageIndex)]=uniq([...(state.sourceByMessage[String(messageIndex)]??[]),sourceRevisionId]);
  state.lastObservation={path,evidenceRef,sourceRevisionId,messageIndex,at:Date.now(),boundaryDecision:clone(decision)};
  try{observeNexusHotSceneSignal({signal:nexusSceneIntegrationSignal({chatId:state.chatId}),context});}catch{}
  logEvent('nexus.scene','post-response-observed',{chatId:state.chatId,sceneId:next.sceneId,revision:next.revision,messageIndex,path,boundaryConfirmed,fieldNames:Object.keys(fields)},path==='extractor'?'warn':'info');
  return getNexusSceneIntelligenceView({chatId:state.chatId});
}

export async function runNexusSceneObservationPostTurn({context=getContext(),sceneScan=null,gate=null,enqueueSidecar=null,messageIndex:affectedMessageIndex=null,isFresh=()=>true}={}){
  const chatId=chatIdOf(context);if(chatId==null)return{skipped:true,reason:'no-chat'};
  activateNexusSceneIntelligence({context,reason:'POST_RESPONSE'});
  if(!state.current)return{skipped:true,reason:'no-scene'};
  if(affectedMessageIndex==null&&String(gate?.mode??'').toUpperCase().includes('NO_CHANGE'))return{skipped:true,reason:'no-change'};
  const chat=Array.isArray(context?.chat)?context.chat:[];
  let messageIndex=-1,message=null;
  if(affectedMessageIndex!=null){
    if(!Number.isInteger(affectedMessageIndex)||affectedMessageIndex<0||affectedMessageIndex>=chat.length)return{skipped:true,reason:'invalid-affected-message'};
    messageIndex=affectedMessageIndex;message=chat[messageIndex];
    if(message?.is_system===true||!String(message?.mes??'').trim())return{skipped:true,reason:'no-message-evidence'};
  }else for(let i=chat.length-1;i>=0;i--){if(chat[i]?.is_user!==true&&chat[i]?.is_system!==true&&String(chat[i]?.mes??'').trim()){messageIndex=i;message=chat[i];break;}}
  if(messageIndex<0)return{skipped:true,reason:'no-assistant-reply'};
  const sceneIdentity={chatId:state.chatId,sceneId:state.current.sceneId,revision:state.current.revision};
  const sourceRevisionId=stableRevisionHash({chatId:String(chatId),messageIndex,swipeId:message?.swipe_id??null,text:String(message?.mes??'')});
  const evidenceRef='scene-observation:'+sourceRevisionId;
  const built=buildSceneObservationPrompt({narrative:String(message.mes??''),sceneId:state.current.sceneId,baseRevision:state.current.revision,evidenceRef,sourceRevisionId});
  let payload=null,path='sidecar',slot=null,error=null;
  try{
    const dispatch=typeof enqueueSidecar==='function'?enqueueSidecar:(stage,options)=>enqueueNexusModelWorkerJob('reasoning',stage,{...options,schedulerLane:'postTurn',role:'maintenance',mainPreferred:false,mainEligible:false});
    const job=dispatch(BUS_STAGE.SCENE_OBSERVATION,{
      prompt:built.prompt,systemPrompt:built.systemPrompt,responseFormat:'json_object',excludeReasoning:true,
      structuredValidator:sceneObservationValidator,reasoningEffort:'low',priority:BUS_PRIORITY.SCENE_OBSERVATION,
      foregroundAdjacent:false,preemptible:true,maxAttempts:1,
      dedupKey:'scene-observation:'+String(chatId)+':'+sourceRevisionId,label:'Scene Intelligence observation',
      telemetry:{sceneIntelligence:true,phase:'POST_RESPONSE',coverage:built.coverage},
    });
    const response=await job.promise;slot=response?.tv2?.slot??null;
    const finishReason=response?.finish_reason??response?.raw?.finish_reason??response?.providerResponse?.finish_reason??null;
    if(String(finishReason??'').toLowerCase()==='length')throw new Error('SCENE_OBSERVATION_FINISH_REASON_LENGTH');
    payload=normalizeSceneObservationOutput(response?.structuredPayload??response?.text??'');
    const extractorPayload=deterministicObservation({narrative:String(message.mes??''),sceneScan,evidenceRef});
    const summarize=value=>({
      fields:Object.fromEntries(Object.entries(value?.fields??{}).map(([name,row])=>[name,row?.value??null])),
      boundarySignals:value?.boundarySignals??{},
    });
    const sidecarSummary=summarize(payload),extractorSummary=summarize(extractorPayload);
    if(JSON.stringify(sidecarSummary)!==JSON.stringify(extractorSummary)){
      const pathRun=await runTask8ChoiceDecision(TASK8_POSTTURN_SITE_IDS.SCENE_PATH_CONFLICT,{
        state:{sidecar:sidecarSummary,extractor:extractorSummary,sceneId:sceneIdentity.sceneId,sceneRevision:sceneIdentity.revision},
      },'SIDECAR',{reasonCode:'SIDECAR_DEFAULT',telemetrySelection:{chatId}});
      if(pathRun.choice==='EXTRACTOR'){payload=extractorPayload;path='extractor-decision';}
      else path='sidecar-decision';
    }
  }catch(caught){
    if(isIntentionalCancellation(caught))return{deferred:true,cancelled:true,reason:caught?.name||'cancelled'};
    error=caught;path='extractor';payload=deterministicObservation({narrative:String(message.mes??''),sceneScan,evidenceRef});
  }
  if(!isFresh()||state?.chatId!==sceneIdentity.chatId||state?.current?.sceneId!==sceneIdentity.sceneId||state?.current?.revision!==sceneIdentity.revision)return{deferred:true,stale:true,reason:'scope-invalidated'};
  return publishOwnerResult(enqueueSidecar,payload,value=>{try{return !!normalizeSceneObservationOutput(value);}catch{return false;}},async()=>{
    if(!isFresh()||state?.chatId!==sceneIdentity.chatId||state?.current?.sceneId!==sceneIdentity.sceneId||state?.current?.revision!==sceneIdentity.revision)return {deferred:true,stale:true,reason:'scope-invalidated'};
  const view=await applyWorkerObservation(payload,{messageIndex,evidenceRef,sourceRevisionId,path,gate,context});
  await persistNexusSceneIntelligence({context,reason:'post-response'});
  logEvent('nexus.scene','post-response-complete',{chatId:String(chatId),messageIndex,path,slot,coverage:built.coverage,error:error?.message||null,sceneId:view?.sceneId??null,revision:view?.revision??0},error?'warn':'info');
  return{updated:true,path,slot,coverage:built.coverage,scene:view,error:error??null};
  });
}

export function retractNexusSceneMessage({messageIndex,eventName='MESSAGE_EDITED',context=getContext()}={}){
  const chatId=chatIdOf(context),index=Number(messageIndex);if(chatId==null||!Number.isFinite(index))return null;
  activateNexusSceneIntelligence({context,reason:eventName});
  const refs=new Set(state.sourceByMessage[String(index)]??[]);if(!refs.size||!state.current)return null;
  const revision=state.current.revision+1,fields={};
  let affected=0;
  for(const [name,field] of Object.entries(state.current.fields??{})){
    if((field.evidenceRefs??[]).some(ref=>refs.has(String(ref)))){fields[name]=unknownFieldFrom(field,revision,{retractedBy:eventName});affected++;}
  }
  if(affected)updateScene(fields,{evidenceRef:'scene-retract:'+eventName+':'+index,sourceRevisionId:'scene-retract:'+index,reason:'source-retraction'});
  delete state.sourceByMessage[String(index)];
  logEvent('nexus.scene','source-retracted',{chatId:String(chatId),messageIndex:index,eventName,affectedFields:affected,sourceRevisionRefs:[...refs]},'info');
  void persistNexusSceneIntelligence({context,reason:'source-retraction'});
  return{affectedFields:affected,sourceRevisionRefs:[...refs]};
}

export function getNexusSceneIntelligenceView({chatId=chatIdOf()}={}){
  if(chatId==null)return null;if(!state||String(state.chatId)!==String(chatId))activateNexusSceneIntelligence({context:getContext(),reason:'READ'});
  const scene=state?.current;if(!scene)return null;
  const cast=(scene.fields?.activeCast?.value??[]).filter(row=>row?.state===CastPresence.PRESENT||row?.presence===CastPresence.PRESENT).map(row=>row.characterId??row.id).filter(Boolean);
  const location=scene.fields?.location?.value?.location??scene.fields?.location?.value??null;
  const threads=(scene.fields?.activeThreads?.value??[]).map(row=>typeof row==='string'?row:(row?.threadId??row?.id??row?.summary)).filter(Boolean);
  const objects=(scene.fields?.immediateObjects?.value??[]).map(row=>typeof row==='string'?row:(row?.objectId??row?.id??row?.name)).filter(Boolean);
  const objectives=(scene.fields?.activeObjectives?.value??[]).map(row=>typeof row==='string'?row:(row?.objective??row?.id)).filter(Boolean);
  const atmosphere=scene.fields?.atmosphere?.value??{};
  return Object.freeze({
    kind:'NexusSceneIntelligenceView',chatId:String(chatId),sceneId:scene.sceneId,revision:scene.revision,lifecycle:scene.lifecycle,
    participants:Object.freeze(cast),location,objects:Object.freeze(objects),threads:Object.freeze(threads),objectives:Object.freeze(objectives),
    activity:atmosphere?.activity??null,focus:atmosphere?.focus??null,narrativeTime:scene.fields?.narrativeTime?.value??null,
    relationshipFocus:atmosphere?.relationshipFocus===true,
    boundaryState:clone(scene.fields?.boundaryState?.value??state.lastBoundary??null),
    sourceRevisionRefs:Object.freeze([...(scene.sourceRevisionRefs??[])]),unresolvedFields:Object.freeze([...(scene.unresolvedFields??[])]),
    lastObservation:clone(state.lastObservation),publicView:scenePublicView(scene),
  });
}

export function renderNexusSceneIntelligence(view=getNexusSceneIntelligenceView()){
  if(!view)return'';
  const lines=[];
  if(view.participants?.length)lines.push('Participants: '+view.participants.join(', '));
  if(clean(view.location))lines.push('Location: '+clean(view.location));
  if(view.objects?.length)lines.push('Objects: '+view.objects.join(', '));
  if(view.threads?.length)lines.push('Threads: '+view.threads.join(' | '));
  if(view.objectives?.length)lines.push('Objectives: '+view.objectives.join(' | '));
  if(clean(view.activity))lines.push('Activity: '+clean(view.activity));
  if(clean(view.focus))lines.push('Focus: '+clean(view.focus));
  if(clean(view.narrativeTime))lines.push('Time: '+clean(view.narrativeTime));
  if(view.relationshipFocus)lines.push('Relationship focus: yes');
  return lines.join('\n');
}

export function nexusSceneIntegrationSignal({chatId=chatIdOf()}={}){
  const view=getNexusSceneIntelligenceView({chatId});if(!view)return null;
  return Object.freeze({
    kind:'NexusA52SceneSignal',chatNamespace:String(view.chatId),sceneId:view.sceneId,sceneRevision:view.revision,
    location:view.location==null?null:{value:view.location,authorityClass:'OBSERVED',evidenceRefs:[...view.sourceRevisionRefs]},
    activeCast:view.participants.map(id=>({id,presence:'PRESENT',authorityClass:'OBSERVED',evidenceRefs:[...view.sourceRevisionRefs]})),
    objects:view.objects.map(id=>({id,presence:'PRESENT',authorityClass:'OBSERVED',evidenceRefs:[...view.sourceRevisionRefs]})),
    activeThreads:view.threads.map(id=>({id,summary:id,evidenceRefs:[...view.sourceRevisionRefs],sourceRevisionRefs:[...view.sourceRevisionRefs]})),
    narrativeTime:view.narrativeTime,boundaryState:view.boundaryState,sceneRelationship:null,transitionType:null,atmosphere:{activity:view.activity,focus:view.focus},
    uncertainFields:[...view.unresolvedFields],conflictSignals:[],sourceRevisionRefs:[...view.sourceRevisionRefs],provenance:['nexus-scene-intelligence'],health:{status:'ready',reasons:[]},
  });
}

export function getNexusSceneWorldTreeNodes({chatId=chatIdOf()}={}){
  const view=getNexusSceneIntelligenceView({chatId});if(!view)return[];
  const scope=String(view.chatId),sourceRefs=[...view.sourceRevisionRefs],revision=view.revision,nodes=[];
  const node=(kind,id,aliases,edges=[])=>Object.freeze({id:String(id),kind,scope,revision,sourceRefs:Object.freeze(sourceRefs),temporalStatus:'CURRENT',supersededBy:null,aliases:Object.freeze(uniq(aliases)),edges:Object.freeze(edges),payload:Object.freeze({sceneId:view.sceneId})});
  const locationId=view.location?'location:'+scope+':'+clean(view.location).toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu,'-'):null;
  if(locationId)nodes.push(node('location',locationId,[view.location]));
  for(const name of view.objects)nodes.push(node('item','item:'+scope+':'+clean(name).toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu,'-'),[name],locationId?[{to:locationId,meaning:'PRESENT_AT',sourceRefs}]:[]));
  for(const name of view.threads)nodes.push(node('thread','thread:'+scope+':'+stableRevisionHash(name),[name]));
  return nodes;
}

export function exportNexusSceneIntelligence(){return persistedState();}
export function resetNexusSceneIntelligence({context=getContext(),reason='reset'}={}){
  const chatId=chatIdOf(context);state=chatId==null?null:{chatId:String(chatId),sceneSequence:0,current:null,history:[],sourceByMessage:{},lastBoundary:null,lastObservation:null};detector=new SemanticBoundaryDetector();verifier=new BoundaryVerifier();logEvent('nexus.scene','cleared',{chatId:chatId??null,reason},'info');return null;
}
