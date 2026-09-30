import {AuthorityClass} from './contracts.js';
import {stableHash,stableJson} from './browser-runtime-utils.js';
import {
  HotSegmentKind,HotFreshness,HotChangeState,HotDependencyState,HotUpdateStatus,
  createHotSegment,createHotDependency,createHotCognitionSnapshot,createHotUpdateReceipt,assertHotAuthorityBoundary,
} from './hot-cognition-contracts.js';

const clone=(v)=>v==null?v:structuredClone(v);
const uniq=(values)=>[...new Set((values??[]).filter(x=>typeof x==='string'&&x.length))].sort();
const cap=(values,max)=>values.length<=max?values:values.slice(values.length-max);
const same=(a,b)=>stableJson(a)===stableJson(b);
const object=(v)=>v&&typeof v==='object'&&!Array.isArray(v);
const boundedText=(v,max=240)=>String(v??'').slice(0,max);
function deepFreeze(value){if(value&&typeof value==='object'&&!Object.isFrozen(value)){for(const child of Object.values(value))deepFreeze(child);Object.freeze(value);}return value;}

function refsFrom(value){
  if(!value||typeof value!=='object')return[];
  return uniq([
    ...(value.sourceRevisionRefs??value.sourceRevisionSet??[]),
    ...(value.evidenceRefs??[]),
  ]);
}
function provenanceFrom(value){
  if(!value||typeof value!=='object')return[];
  const diagnostic=value.diagnosticRefs??{};
  return uniq([
    ...(value.provenance??[]),
    ...(value.evidenceRefs??[]),
    ...(diagnostic.evidenceRefs??[]),
    ...(diagnostic.proposalIds??[]),
    ...(diagnostic.transitionIds??[]),
    ...(diagnostic.eventIds??[]),
    ...(diagnostic.boundaryDecisionRefs??[]),
  ]);
}
function identityOf(value){
  if(typeof value==='string')return value;
  if(!object(value))return null;
  return value.characterId??value.entityId??value.objectRef??value.objectId??value.threadId??value.id??value.ref??null;
}
function observationOf(value,fallback=AuthorityClass.UNRESOLVED){
  const raw=object(value)?value.observationClass??value.authorityClass??value.authority:null;
  if(raw===AuthorityClass.OBSERVED||raw==='OBSERVED')return AuthorityClass.OBSERVED;
  if(raw===AuthorityClass.INFERRED||raw==='INFERRED')return AuthorityClass.INFERRED;
  if(raw===AuthorityClass.SETTLED||raw==='SETTLED')return AuthorityClass.SETTLED;
  if(raw===AuthorityClass.SOURCE_CANON||raw==='SOURCE_CANON')return AuthorityClass.SOURCE_CANON;
  return fallback;
}
function normalizeField(value){
  if(value==null)return {value:null,authorityClass:AuthorityClass.UNRESOLVED,confidence:0,evidenceRefs:[]};
  if(object(value)&&Object.prototype.hasOwnProperty.call(value,'value')){
    return {value:clone(value.value),authorityClass:observationOf(value),confidence:Number(value.confidence??0),evidenceRefs:uniq(value.evidenceRefs??[])};
  }
  return {value:clone(value),authorityClass:observationOf(value),confidence:object(value)?Number(value.confidence??0):0,evidenceRefs:uniq(object(value)?value.evidenceRefs??[]:[])};
}
function normalizePresenceList(values=[],{excludeMentioned=true}={}){
  const rows=[];
  for(const raw of values??[]){
    if(raw==null)continue;
    const state=object(raw)?raw.state??raw.presence??null:null;
    if(excludeMentioned&&state==='MENTIONED_ONLY')continue;
    if(state&&['DEPARTED','REMOVED','DESTROYED'].includes(state))continue;
    const id=identityOf(raw);if(!id)continue;
    rows.push({
      id:String(id),
      canonicalEntityId:object(raw)&&raw.canonicalEntityId!=null?String(raw.canonicalEntityId):null,
      sourceEntityId:object(raw)&&raw.sourceEntityId!=null?String(raw.sourceEntityId):null,
      providerId:object(raw)&&raw.providerId!=null?String(raw.providerId):null,
      label:object(raw)?raw.label??raw.name??raw.canonicalName??null:null,
      state:state??'PRESENT',
      authorityClass:observationOf(raw),
      confidence:object(raw)?Number(raw.confidence??0):0,
      evidenceRefs:uniq(object(raw)?raw.evidenceRefs??[]:[]),
      sourceRevisionRefs:uniq(object(raw)?raw.sourceRevisionRefs??[]:[]),
    });
  }
  return [...new Map(rows.map(x=>[x.id,x])).values()].sort((a,b)=>a.id.localeCompare(b.id));
}
function normalizeThreads(values=[]){
  const rows=[];
  for(const raw of values??[]){
    if(raw==null)continue;
    const threadId=identityOf(raw);if(!threadId)continue;
    const status=object(raw)?String(raw.status??'ACTIVE'):'ACTIVE';
    if(['CLOSED','RESOLVED','EXPIRED'].includes(status))continue;
    rows.push({
      threadId:String(threadId),
      owner:object(raw)?String(raw.owner??raw.source??'SCENE_INTELLIGENCE'):'SCENE_INTELLIGENCE',
      source:object(raw)?String(raw.source??raw.owner??'SCENE_INTELLIGENCE'):'SCENE_INTELLIGENCE',
      evidenceRefs:uniq(object(raw)?raw.evidenceRefs??[]:[]),
      provenanceRefs:uniq(object(raw)?raw.provenanceRefs??raw.provenance??[]:[]),
      sourceRevisionRefs:uniq(object(raw)?raw.sourceRevisionRefs??[]:[]),
      revision:Number(object(raw)?raw.revision??1:1),
      status,
      authorityClass:observationOf(raw),
      objective:object(raw)?raw.objective??null:null,
      unresolvedQuestion:object(raw)?raw.unresolvedQuestion??raw.question??null:null,
      expiry:object(raw)?clone(raw.expiry??null):null,
      closureConditions:object(raw)?clone(raw.closureConditions??[]):[],
    });
  }
  return [...new Map(rows.map(x=>[x.threadId,x])).values()].sort((a,b)=>a.threadId.localeCompare(b.threadId));
}
function mergeRefs(existing=[],incoming=[],max=128){return cap(uniq([...existing,...incoming]),max);}
function defaultDependencies(){
  return {
    CORE:createHotDependency({dependencyId:'CORE',state:HotDependencyState.AVAILABLE,reason:'Hot Cognition owner is available'}),
    RUNTIME_CONTRACTS:createHotDependency({dependencyId:'RUNTIME_CONTRACTS',state:HotDependencyState.AVAILABLE,reason:'Runtime public contracts are available'}),
    SCENE:createHotDependency({dependencyId:'SCENE',state:HotDependencyState.UNAVAILABLE,reason:'No Scene signal has been consumed'}),
    MEMORY:createHotDependency({dependencyId:'MEMORY',state:HotDependencyState.UNAVAILABLE,reason:'Memory producer unavailable'}),
    LORE_STUDY:createHotDependency({dependencyId:'LORE_STUDY',state:HotDependencyState.UNAVAILABLE,reason:'Lore Study producer unavailable'}),
    SENSORY_NET:createHotDependency({dependencyId:'SENSORY_NET',state:HotDependencyState.UNAVAILABLE,reason:'Sensory producer unavailable'}),
    GRAPH_NEIGHBORHOOD:createHotDependency({dependencyId:'GRAPH_NEIGHBORHOOD',state:HotDependencyState.UNAVAILABLE,reason:'Graph producer unavailable'}),
  };
}
function initialSegment(kind,value=null,{owner='COGNITIVE_CORE',freshness=HotFreshness.UNAVAILABLE,authorityClass=AuthorityClass.UNRESOLVED}={}){
  return createHotSegment({kind,revision:0,value,owner,authorityClass,freshness,changeState:HotChangeState.UNAVAILABLE});
}
function initialSegments(){
  return {
    [HotSegmentKind.SCENE]:initialSegment(HotSegmentKind.SCENE,null,{owner:'SCENE_INTELLIGENCE'}),
    [HotSegmentKind.LOCATION]:initialSegment(HotSegmentKind.LOCATION,null,{owner:'SCENE_INTELLIGENCE'}),
    [HotSegmentKind.ACTIVE_CAST]:initialSegment(HotSegmentKind.ACTIVE_CAST,[],{owner:'SCENE_INTELLIGENCE'}),
    [HotSegmentKind.ACTIVE_ENTITIES]:initialSegment(HotSegmentKind.ACTIVE_ENTITIES,[],{owner:'SCENE_INTELLIGENCE'}),
    [HotSegmentKind.ACTIVE_THREADS]:initialSegment(HotSegmentKind.ACTIVE_THREADS,[],{owner:'SCENE_INTELLIGENCE'}),
    [HotSegmentKind.CONTINUITY]:initialSegment(HotSegmentKind.CONTINUITY,{pins:[],lateResultRefs:[]},{freshness:HotFreshness.FRESH}),
    [HotSegmentKind.RECENT_EPISODE_TAIL]:initialSegment(HotSegmentKind.RECENT_EPISODE_TAIL,[],{freshness:HotFreshness.FRESH}),
    [HotSegmentKind.WORLD_REFERENCES]:initialSegment(HotSegmentKind.WORLD_REFERENCES,[],{owner:'WORLD_STATE',freshness:HotFreshness.FRESH,authorityClass:AuthorityClass.SETTLED}),
    [HotSegmentKind.GRAPH_NEIGHBORHOOD]:initialSegment(HotSegmentKind.GRAPH_NEIGHBORHOOD,{state:HotDependencyState.UNAVAILABLE,refs:[]},{owner:'GRAPH_OWNER'}),
    [HotSegmentKind.DEPENDENCY_STATE]:initialSegment(HotSegmentKind.DEPENDENCY_STATE,defaultDependencies(),{freshness:HotFreshness.FRESH}),
  };
}

export class HotCognitionRuntime{
  constructor({
    sourceRegistry=null,getWorldRevision=()=>0,
    maxChats=8,maxDedupe=2048,maxRecentTail=32,maxActiveThreads=64,maxActiveEntities=64,
    maxContinuityRefs=64,maxGraphRefs=128,maxWorldRefs=128,maxProvenanceRefs=128,maxSealedSnapshots=64,
  }={}){
    this.sourceRegistry=sourceRegistry;this.getWorldRevision=getWorldRevision;
    this.limits={maxChats,maxDedupe,maxRecentTail,maxActiveThreads,maxActiveEntities,maxContinuityRefs,maxGraphRefs,maxWorldRefs,maxProvenanceRefs,maxSealedSnapshots};
    this.states=new Map();this.activeChatNamespace=null;this.sequence=0;this.sealedSnapshots=new Map();
  }

  get hasActiveChat(){return Boolean(this.activeChatNamespace&&this.states.has(this.activeChatNamespace));}

  activateChat(chatNamespace,{reason='CHAT_SWITCH'}={}){
    const id=String(chatNamespace??'').trim();if(!id)throw new TypeError('chatNamespace is required');
    let state=this.states.get(id);
    if(!state){state=this.#newState(id);this.states.set(id,state);this.#evictChats();}
    this.activeChatNamespace=id;state.lastAccessSequence=++this.sequence;state.reconstructionState=state.hotRevision?'REUSED_PERSISTED':'EMPTY';
    return this.snapshot(id);
  }

  newChat(chatNamespace){if(this.states.has(chatNamespace))this.states.delete(chatNamespace);return this.activateChat(chatNamespace,{reason:'NEW_CHAT'});}

  snapshot(chatNamespace=this.activeChatNamespace){
    if(!chatNamespace)return null;const state=this.states.get(chatNamespace);if(!state)return null;
    state.lastAccessSequence=++this.sequence;
    const sourceRevisionRefs=uniq(Object.values(state.segments).flatMap(x=>x.sourceRevisionRefs));
    const dependencyRevisionRefs=uniq(Object.values(state.segments).flatMap(x=>x.dependencyRevisionRefs));
    const provenanceRefs=cap(uniq(Object.values(state.segments).flatMap(x=>x.provenanceRefs)),this.limits.maxProvenanceRefs);
    const deps=state.segments[HotSegmentKind.DEPENDENCY_STATE].value??{};
    const degradedDependencies=Object.values(deps).filter(x=>[HotDependencyState.DEGRADED,HotDependencyState.STALE].includes(x.state)).map(x=>x.dependencyId);
    const unavailableDependencies=Object.values(deps).filter(x=>x.state===HotDependencyState.UNAVAILABLE).map(x=>x.dependencyId);
    const invalidationState=Object.values(state.segments).filter(x=>[HotFreshness.STALE,HotFreshness.INVALIDATED].includes(x.freshness)).map(x=>({segment:x.kind,reason:x.invalidationReason,revision:x.revision}));
    const material={stateId:state.stateId,chatNamespace:state.chatNamespace,hotRevision:state.hotRevision,sceneId:state.sceneId,sceneRevision:state.sceneRevision,worldRevision:state.worldRevision,characterStateRevision:state.characterStateRevision,segments:Object.fromEntries(Object.entries(state.segments).map(([k,v])=>[k,{revision:v.revision,value:v.value,freshness:v.freshness,authorityClass:v.authorityClass}]))};
    const snapshotId='hot-snapshot:'+stableHash(material,{length:24});
    return createHotCognitionSnapshot({
      snapshotId,stateId:state.stateId,chatNamespace:state.chatNamespace,hotRevision:state.hotRevision,
      sceneId:state.sceneId,sceneRevision:state.sceneRevision,worldRevision:state.worldRevision,characterStateRevision:state.characterStateRevision,
      segments:state.segments,sourceRevisionRefs,dependencyRevisionRefs,degradedDependencies,unavailableDependencies,
      lastAcceptedUpdateId:state.lastAcceptedUpdateId,provenanceRefs,invalidationState,counters:state.counters,reconstructionState:state.reconstructionState,
    });
  }

  hasMeaningfulState(chatNamespace=this.activeChatNamespace){
    const snapshot=this.snapshot(chatNamespace);if(!snapshot)return false;
    return Object.values(snapshot.segments).some(segment=>segment.kind!==HotSegmentKind.DEPENDENCY_STATE&&segment.freshness===HotFreshness.FRESH&&segment.value!=null&&(!Array.isArray(segment.value)||segment.value.length));
  }

  consumeSceneSignal(signal,{chatNamespace=this.activeChatNamespace??signal?.chatNamespace??signal?.chatId,updateId=null,rebuild=false}={}){
    assertHotAuthorityBoundary(signal,'SceneIntegrationSignal');
    const namespace=String(chatNamespace??'').trim();if(!namespace)throw new TypeError('consumeSceneSignal requires an active chat namespace');
    if(!this.states.has(namespace))this.activateChat(namespace,{reason:'SCENE_SIGNAL'});
    const state=this.states.get(namespace);this.activeChatNamespace=namespace;
    const priorSceneId=state.sceneId,priorSceneRevision=state.sceneRevision;
    const sceneId=String(signal?.sceneId??'').trim(),sceneRevision=Number(signal?.sceneRevision);
    if(!sceneId||!Number.isInteger(sceneRevision)||sceneRevision<1)throw new TypeError('Scene signal requires sceneId and positive sceneRevision');
    const id=updateId??('scene-signal:'+sceneId+':'+sceneRevision+':'+stableHash(signal,{length:16}));
    const duplicate=this.#duplicateReceipt(state,id,'SCENE_INTEGRATION_SIGNAL');if(duplicate)return duplicate;
    if(state.sceneId===sceneId&&sceneRevision<state.sceneRevision)return this.#stale(state,id,'SCENE_INTEGRATION_SIGNAL','scene revision '+sceneRevision+' is older than active '+state.sceneRevision,sceneRevision);
    const graphContextChanged=priorSceneId!==null&&(priorSceneId!==sceneId||priorSceneRevision!==sceneRevision);
    const sourceRevisionRefs=uniq(signal.sourceRevisionRefs??signal.sourceRevisionSet??[]),inactiveSourceRefs=this.#knownInactiveSourceRefs(sourceRevisionRefs);
    if(inactiveSourceRefs.length)return this.#stale(state,id,'SCENE_INTEGRATION_SIGNAL','Scene signal depends on inactive source revisions: '+inactiveSourceRefs.join(','),sceneRevision);
    const provenanceRefs=provenanceFrom(signal),transition=state.sceneId!==null&&state.sceneId!==sceneId,narrativeTime=normalizeField(signal.narrativeTime??null);
    const changed=[],reused=[],invalidated=[];

    const sceneValue={
      sceneId,narrativeTime:narrativeTime.value,boundaryState:clone(signal.boundaryState??null),
      uncertainFields:uniq(signal.uncertainFields??[]),conflictSignals:uniq(signal.conflictSignals??[]),
      sceneRelationship:signal.sceneRelationship??null,transitionType:signal.transitionType??signal.sceneRelationship??null,
      atmosphere:clone(signal.atmosphere??null),health:clone(signal.health??{status:'ready',reasons:[]}),
    };
    this.#setSegment(state,HotSegmentKind.SCENE,{value:sceneValue,sourceRevisionRefs,provenanceRefs:mergeRefs(provenanceRefs,narrativeTime.evidenceRefs,this.limits.maxProvenanceRefs),authorityClass:AuthorityClass.UNRESOLVED,owner:'SCENE_INTELLIGENCE',freshness:HotFreshness.FRESH,updateId:id,rebuild,changed,reused});
    const location=normalizeField(signal.location??null);
    this.#setSegment(state,HotSegmentKind.LOCATION,{value:location.value,sourceRevisionRefs,provenanceRefs:mergeRefs(provenanceRefs,location.evidenceRefs,this.limits.maxProvenanceRefs),authorityClass:location.authorityClass,owner:'SCENE_INTELLIGENCE',freshness:location.value==null?HotFreshness.UNAVAILABLE:HotFreshness.FRESH,updateId:id,rebuild,changed,reused});
    const cast=normalizePresenceList(signal.activeCast??[],{excludeMentioned:true});
    this.#setSegment(state,HotSegmentKind.ACTIVE_CAST,{value:cast,sourceRevisionRefs,provenanceRefs:mergeRefs(provenanceRefs,cast.flatMap(x=>x.evidenceRefs),this.limits.maxProvenanceRefs),authorityClass:this.#listAuthority(cast),owner:'SCENE_INTELLIGENCE',freshness:HotFreshness.FRESH,updateId:id,rebuild,changed,reused});
    const entities=cap(normalizePresenceList(signal.objects??[],{excludeMentioned:true}),this.limits.maxActiveEntities);
    this.#setSegment(state,HotSegmentKind.ACTIVE_ENTITIES,{value:entities,sourceRevisionRefs,provenanceRefs:mergeRefs(provenanceRefs,entities.flatMap(x=>x.evidenceRefs),this.limits.maxProvenanceRefs),authorityClass:this.#listAuthority(entities),owner:'SCENE_INTELLIGENCE',freshness:HotFreshness.FRESH,updateId:id,rebuild,changed,reused});
    const threads=cap(normalizeThreads(signal.activeThreads??[]),this.limits.maxActiveThreads);
    this.#setSegment(state,HotSegmentKind.ACTIVE_THREADS,{value:threads,sourceRevisionRefs:mergeRefs(sourceRevisionRefs,threads.flatMap(x=>x.sourceRevisionRefs),this.limits.maxProvenanceRefs),provenanceRefs:mergeRefs(provenanceRefs,threads.flatMap(x=>[...x.evidenceRefs,...x.provenanceRefs]),this.limits.maxProvenanceRefs),authorityClass:AuthorityClass.UNRESOLVED,owner:'SCENE_INTELLIGENCE',freshness:HotFreshness.FRESH,updateId:id,rebuild,changed,reused});

    const currentContinuity=clone(state.segments[HotSegmentKind.CONTINUITY].value??{pins:[],lateResultRefs:[]});
    const continuity={
      ...currentContinuity,
      sceneRelationship:signal.sceneRelationship??null,transitionType:signal.transitionType??signal.sceneRelationship??null,
      previousSceneRef:clone(signal.previousSceneRef??null),resumedSceneRef:clone(signal.resumedSceneRef??null),
      pins:cap(uniq([...(currentContinuity.pins??[]),...(signal.prefetchRecommendations??[]).map(identityOf).filter(Boolean)]),this.limits.maxContinuityRefs),
      objectTransitionRefs:cap(uniq([...(currentContinuity.objectTransitionRefs??[]),...(signal.objectTransitionRefs??[]).map(identityOf).filter(Boolean)]),this.limits.maxContinuityRefs),
    };
    this.#setSegment(state,HotSegmentKind.CONTINUITY,{value:continuity,sourceRevisionRefs,provenanceRefs,authorityClass:AuthorityClass.UNRESOLVED,owner:'COGNITIVE_CORE',freshness:HotFreshness.FRESH,updateId:id,rebuild,changed,reused});

    const episodeRefs=[...(signal.episodeRefs??[]),...(signal.latestEpisodeRef?[signal.latestEpisodeRef]:[])];
    if(episodeRefs.length)this.#appendEpisodeRefs(state,episodeRefs,{sourceRevisionRefs,provenanceRefs,updateId:id,rebuild,changed,reused});

    if(graphContextChanged)this.#invalidateSegments(state,[HotSegmentKind.GRAPH_NEIGHBORHOOD],{reason:'SCENE_REVISION_CHANGED',updateId:id,invalidated});
    state.sceneId=sceneId;state.sceneRevision=sceneRevision;
    this.#setDependencyInternal(state,'SCENE',HotDependencyState.AVAILABLE,{revisionRefs:[String(sceneRevision)],reason:'Scene signal consumed',updateId:id,changed,reused});
    if(transition){
      state.counters.sceneTransitions+=1;
      for(const kind of [HotSegmentKind.LOCATION,HotSegmentKind.ACTIVE_CAST,HotSegmentKind.ACTIVE_ENTITIES,HotSegmentKind.ACTIVE_THREADS])if(!changed.includes(kind)&&!reused.includes(kind))invalidated.push(kind);
    }
    return this.#commit(state,{updateId:id,eventType:'SCENE_INTEGRATION_SIGNAL',changed,reused,invalidated,sourceRevisionRefs,sceneRevision,details:{transition,rebuild}});
  }

  consumeEvent(event,{chatNamespace=this.activeChatNamespace??event?.payload?.chatNamespace??event?.payload?.chatId}={}){
    assertHotAuthorityBoundary(event,'Cognitive event');
    const namespace=String(chatNamespace??'').trim();if(!namespace)throw new TypeError('consumeEvent requires an active chat namespace');
    if(!this.states.has(namespace))this.activateChat(namespace,{reason:'COGNITIVE_EVENT'});
    const state=this.states.get(namespace);this.activeChatNamespace=namespace;
    const eventType=String(event?.eventType??''),updateId=String(event?.eventId??event?.dedupeIdentity??event?.dedupeKey??'');
    if(!eventType||!updateId)throw new TypeError('Cognitive event requires eventType and eventId/dedupe identity');
    const duplicate=this.#duplicateReceipt(state,updateId,eventType);if(duplicate)return duplicate;
    const eventSceneId=event.sceneId??event.payload?.sceneId??state.sceneId;
    const sceneRevision=Number(event.sceneRevision??event.revisionFences?.sceneRevision??event.payload?.sceneRevision??state.sceneRevision);
    if(state.sceneId&&eventSceneId===state.sceneId&&Number.isInteger(sceneRevision)&&sceneRevision<state.sceneRevision)return this.#stale(state,updateId,eventType,'event scene revision is stale',sceneRevision);
    const eventWorld=Number(event.worldRevision??event.revisionFences?.worldRevision??event.payload?.worldRevision??state.worldRevision);
    if(['STATE_SETTLED','WORLD_STATE_SETTLED','KNOWLEDGE_INVALIDATED'].includes(eventType)&&Number.isFinite(eventWorld)&&eventWorld<state.worldRevision)return this.#stale(state,updateId,eventType,'event world revision is stale',sceneRevision,eventWorld);
    const payload=clone(event.payload??{}),sourceRevisionRefs=uniq(event.sourceRevisionSet??event.sourceRevisionIds??event.revisionFences?.sourceRevisionIds??[]);
    const provenanceRefs=uniq([event.eventId,event.correlationId,event.causationId].filter(Boolean)),inactiveSourceRefs=this.#knownInactiveSourceRefs(sourceRevisionRefs);
    if(inactiveSourceRefs.length)return this.#stale(state,updateId,eventType,'event depends on inactive source revisions: '+inactiveSourceRefs.join(','),sceneRevision,eventWorld);
    const changed=[],reused=[],invalidated=[];

    if(payload.sceneSignal&&['SCENE_OPENED','SCENE_STATE_DELTA','LOCATION_CHANGED','ACTIVE_CAST_CHANGED'].includes(eventType)){
      state.dedupe.delete(updateId);
      return this.consumeSceneSignal(payload.sceneSignal,{chatNamespace:namespace,updateId});
    }

    if(eventType==='SCENE_OPENED'||eventType==='SCENE_STATE_DELTA'){
      const patch={sceneId:eventSceneId,sceneRevision,sourceRevisionRefs,provenance:provenanceRefs,
        location:payload.location??payload.changedFields?.location??state.segments[HotSegmentKind.LOCATION].value,
        activeCast:payload.activeCast??payload.changedFields?.activeCast??state.segments[HotSegmentKind.ACTIVE_CAST].value,
        objects:payload.objects??payload.changedFields?.immediateObjects??state.segments[HotSegmentKind.ACTIVE_ENTITIES].value,
        activeThreads:payload.activeThreads??payload.changedFields?.activeThreads??state.segments[HotSegmentKind.ACTIVE_THREADS].value,
        narrativeTime:payload.narrativeTime??payload.changedFields?.narrativeTime??state.segments[HotSegmentKind.SCENE].value?.narrativeTime,
        boundaryState:payload.boundaryState??payload.changedFields?.boundaryState??state.segments[HotSegmentKind.SCENE].value?.boundaryState,
        sceneRelationship:payload.sceneRelationship??payload.relationship??null,
      };
      state.dedupe.delete(updateId);return this.consumeSceneSignal(patch,{chatNamespace:namespace,updateId});
    }

    if(eventType==='LOCATION_CHANGED'){
      const field=normalizeField(payload.location??payload.to??payload.after??payload.currentLocation);
      this.#setSegment(state,HotSegmentKind.LOCATION,{value:field.value,sourceRevisionRefs:mergeRefs(sourceRevisionRefs,field.evidenceRefs,this.limits.maxProvenanceRefs),provenanceRefs:mergeRefs(provenanceRefs,field.evidenceRefs,this.limits.maxProvenanceRefs),authorityClass:field.authorityClass,owner:'SCENE_INTELLIGENCE',freshness:field.value==null?HotFreshness.UNAVAILABLE:HotFreshness.FRESH,updateId,changed,reused});
    }else if(eventType==='ACTIVE_CAST_CHANGED'){
      let cast;
      if(Array.isArray(payload.activeCast))cast=normalizePresenceList(payload.activeCast,{excludeMentioned:true});
      else{
        const existing=state.segments[HotSegmentKind.ACTIVE_CAST].value??[],map=new Map(existing.map(x=>[x.id,x]));
        for(const row of normalizePresenceList(payload.entered??[],{excludeMentioned:true}))map.set(row.id,row);
        for(const raw of payload.exited??[])map.delete(String(identityOf(raw)));
        cast=[...map.values()].sort((a,b)=>a.id.localeCompare(b.id));
      }
      this.#setSegment(state,HotSegmentKind.ACTIVE_CAST,{value:cast,sourceRevisionRefs,provenanceRefs,authorityClass:this.#listAuthority(cast),owner:'SCENE_INTELLIGENCE',freshness:HotFreshness.FRESH,updateId,changed,reused});
    }else if(eventType==='OBJECT_TRANSITION'){
      if(Array.isArray(payload.objects)){
        const entities=cap(normalizePresenceList(payload.objects,{excludeMentioned:true}),this.limits.maxActiveEntities);
        this.#setSegment(state,HotSegmentKind.ACTIVE_ENTITIES,{value:entities,sourceRevisionRefs,provenanceRefs,authorityClass:this.#listAuthority(entities),owner:'SCENE_INTELLIGENCE',freshness:HotFreshness.FRESH,updateId,changed,reused});
      }else{
        const existing=state.segments[HotSegmentKind.ACTIVE_ENTITIES].value??[],map=new Map(existing.map(x=>[x.id,x]));
        const after=payload.after??payload.object??payload;
        const id=identityOf(after)??payload.objectRef;
        const stateValue=object(after)?after.state??after.presence??null:null;
        if(id&&['DEPARTED','REMOVED','DESTROYED'].includes(stateValue))map.delete(String(id));
        else for(const row of normalizePresenceList(id?[after]:[],{excludeMentioned:true}))map.set(row.id,row);
        this.#setSegment(state,HotSegmentKind.ACTIVE_ENTITIES,{value:cap([...map.values()].sort((a,b)=>a.id.localeCompare(b.id)),this.limits.maxActiveEntities),sourceRevisionRefs,provenanceRefs,authorityClass:observationOf(after),owner:'SCENE_INTELLIGENCE',freshness:HotFreshness.FRESH,updateId,changed,reused});
      }
    }else if(eventType==='SCENE_BOUNDARY_CANDIDATE'){
      this.#rememberDedupe(state,updateId);
      return createHotUpdateReceipt({updateId,status:HotUpdateStatus.NO_CHANGE,chatNamespace:namespace,eventType,hotRevision:state.hotRevision,reusedSegments:[HotSegmentKind.SCENE,HotSegmentKind.LOCATION,HotSegmentKind.ACTIVE_CAST],sourceRevisionRefs,sceneRevision:state.sceneRevision,worldRevision:state.worldRevision,details:{reason:'boundary candidate is descriptive only; active Hot Cognition is unchanged until Scene owner confirms/opens a transition'}});
    }else if(eventType==='TIME_SHIFT_DETECTED'){
      const current=clone(state.segments[HotSegmentKind.SCENE].value??{});
      current.narrativeTime=clone(payload.narrativeTime??payload.to??payload.after??null);
      this.#setSegment(state,HotSegmentKind.SCENE,{value:current,sourceRevisionRefs,provenanceRefs,authorityClass:state.segments[HotSegmentKind.SCENE].authorityClass,owner:'SCENE_INTELLIGENCE',freshness:HotFreshness.FRESH,updateId,changed,reused});
    }else if(eventType==='PREFETCH_RECOMMENDED'){
      const current=clone(state.segments[HotSegmentKind.CONTINUITY].value??{pins:[],lateResultRefs:[]});
      const incoming=(payload.recommendations??payload.refs??[payload.artifactRef]).filter(Boolean).map(identityOf).filter(Boolean);
      current.pins=cap(uniq([...(current.pins??[]),...incoming]),this.limits.maxContinuityRefs);
      this.#setSegment(state,HotSegmentKind.CONTINUITY,{value:current,sourceRevisionRefs,provenanceRefs,authorityClass:AuthorityClass.UNRESOLVED,owner:'COGNITIVE_CORE',freshness:HotFreshness.FRESH,updateId,changed,reused});
    }else if(eventType==='SCENE_EPISODE_READY'){
      this.#appendEpisodeRefs(state,[payload.episodeRef??payload.artifactRef??payload.episode??payload].filter(Boolean),{sourceRevisionRefs,provenanceRefs,updateId,rebuild:false,changed,reused});
    }else if(eventType==='SCENE_CLOSED'){
      this.#invalidateSegments(state,[HotSegmentKind.SCENE,HotSegmentKind.LOCATION,HotSegmentKind.ACTIVE_CAST,HotSegmentKind.ACTIVE_ENTITIES,HotSegmentKind.ACTIVE_THREADS,HotSegmentKind.GRAPH_NEIGHBORHOOD],{reason:'SCENE_CLOSED',updateId,invalidated});
    }else if(eventType==='KNOWLEDGE_INVALIDATED'){
      const receipt=this.#knowledgeInvalidation(state,{updateId,eventType,sourceRevisionRefs:uniq(payload.invalidatedSourceRevisionRefs??payload.sourceRevisionRefs??sourceRevisionRefs),dependencyRevisionRefs:uniq(payload.invalidatedDependencyRevisionRefs??[]),affectedSegments:payload.affectedSegments??[],reason:payload.reason??'KNOWLEDGE_INVALIDATED'});
      return receipt;
    }else if(eventType==='STATE_SETTLED'||eventType==='WORLD_STATE_SETTLED'){
      state.dedupe.delete(updateId);
      return this.consumeOwnerWorldChange({chatNamespace:namespace,updateId,worldRevision:eventWorld,sourceRevisionRefs,artifactRefs:payload.artifactRefs??payload.settledArtifactIds??[],provenanceRefs,eventType});
    }else{
      this.#rememberDedupe(state,updateId);
      return createHotUpdateReceipt({updateId,status:HotUpdateStatus.REJECTED,chatNamespace:namespace,eventType,hotRevision:state.hotRevision,staleReason:'unsupported Hot Cognition event type'});
    }

    if(Number.isInteger(sceneRevision)&&sceneRevision>=0){state.sceneRevision=Math.max(state.sceneRevision,sceneRevision);if(eventSceneId)state.sceneId=String(eventSceneId);}
    return this.#commit(state,{updateId,eventType,changed,reused,invalidated,sourceRevisionRefs,sceneRevision:Number.isInteger(sceneRevision)?sceneRevision:null,worldRevision:Number.isFinite(eventWorld)?eventWorld:null});
  }

  consumeNarrativeEvidence(evidence,{updateId=null}={}){
    if(!evidence||evidence.kind!=='NarrativeEvidence')throw new TypeError('consumeNarrativeEvidence requires normalized NarrativeEvidence');
    const activity=String(evidence.activity??''),chatNamespace=String(evidence.chatId??'').trim();if(!chatNamespace)throw new TypeError('NarrativeEvidence.chatId is required');
    if(['CHAT_SWITCH','CHAT_LOAD','NEW_CHAT','IMPORT_OR_RELOAD'].includes(activity)){
      if(activity==='NEW_CHAT')this.newChat(chatNamespace);else this.activateChat(chatNamespace,{reason:activity});
      if(activity==='CHAT_SWITCH'||activity==='CHAT_LOAD'||activity==='NEW_CHAT'||activity==='IMPORT_OR_RELOAD'){
        const state=this.states.get(chatNamespace),id=updateId??('narrative:'+activity+':'+String(evidence.sequence??evidence.chatRevision??0));
        const dup=this.#duplicateReceipt(state,id,activity);if(dup)return dup;
        return this.#commit(state,{updateId:id,eventType:activity,changed:[],reused:[],invalidated:[],sourceRevisionRefs:uniq([evidence.sourceRevisionId].filter(Boolean)),details:{lifecycle:true}});
      }
    }
    if(!this.states.has(chatNamespace))this.activateChat(chatNamespace,{reason:'NARRATIVE_EVIDENCE'});
    this.activeChatNamespace=chatNamespace;const state=this.states.get(chatNamespace);
    const id=updateId??('narrative:'+activity+':'+String(evidence.sourceRevisionId??evidence.messageId??evidence.sequence));
    const duplicate=this.#duplicateReceipt(state,id,activity);if(duplicate)return duplicate;
    const changed=[],reused=[],invalidated=[],segment=state.segments[HotSegmentKind.RECENT_EPISODE_TAIL];
    let tail=clone(segment.value??[]);
    const invalidatedRefs=new Set(evidence.invalidates??[]);
    if(invalidatedRefs.size)tail=tail.filter(x=>!invalidatedRefs.has(x.sourceRevisionId));
    if(activity==='DELETE'&&evidence.messageId)tail=tail.filter(x=>x.messageId!==evidence.messageId);
    if(evidence.current!==false&&evidence.sourceRevisionId&&evidence.content!=null&&!['DELETE'].includes(activity)){
      tail=tail.filter(x=>x.messageId!==evidence.messageId||x.sourceRevisionId===evidence.sourceRevisionId);
      tail.push({
        refId:'recent:'+evidence.sourceRevisionId,sourceRevisionId:evidence.sourceRevisionId,messageId:evidence.messageId??null,
        messageRevision:evidence.messageRevision??null,role:evidence.role??null,activity,contentDigest:stableHash(String(evidence.content),{length:16,alreadyString:true}),
        excerpt:boundedText(evidence.content),turnId:evidence.turnId??null,sequence:Number(evidence.sequence??0),
        knownBy:uniq(evidence.knownBy??[]),publicToAll:Boolean(evidence.publicToAll),
      });
    }
    tail=cap(tail,this.limits.maxRecentTail);
    this.#setSegment(state,HotSegmentKind.RECENT_EPISODE_TAIL,{value:tail,sourceRevisionRefs:uniq(tail.map(x=>x.sourceRevisionId)),provenanceRefs:uniq([evidence.sourceRevisionId,...(evidence.invalidates??[])]),authorityClass:AuthorityClass.OBSERVED,owner:'NARRATIVE_FEED',freshness:HotFreshness.FRESH,updateId:id,changed,reused});
    return this.#commit(state,{updateId:id,eventType:activity,changed,reused,invalidated,sourceRevisionRefs:uniq([evidence.sourceRevisionId].filter(Boolean)),details:{invalidatedRefs:[...invalidatedRefs].sort()}});
  }

  consumeOwnerWorldChange({chatNamespace=this.activeChatNamespace,updateId,worldRevision=this.getWorldRevision(),sourceRevisionRefs=[],artifactRefs=[],provenanceRefs=[],eventType='STATE_SETTLED'}={}){
    if(!chatNamespace||!this.states.has(chatNamespace))return null;const state=this.states.get(chatNamespace);
    const id=String(updateId??('world:'+worldRevision+':'+stableHash(artifactRefs,{length:12}))),duplicate=this.#duplicateReceipt(state,id,eventType);if(duplicate)return duplicate;
    const revision=Number(worldRevision);if(Number.isFinite(revision)&&revision<state.worldRevision)return this.#stale(state,id,eventType,'world revision is older than active world state',state.sceneRevision,revision);
    const inactiveSourceRefs=this.#knownInactiveSourceRefs(sourceRevisionRefs);if(inactiveSourceRefs.length)return this.#stale(state,id,eventType,'world update depends on inactive source revisions: '+inactiveSourceRefs.join(','),state.sceneRevision,revision);
    const previousWorldRevision=state.worldRevision;
    const current=state.segments[HotSegmentKind.WORLD_REFERENCES].value??[],rows=artifactRefs.map(ref=>typeof ref==='string'?{ref,authorityClass:AuthorityClass.SETTLED,temporalStatus:'CURRENT'}:{...clone(ref),ref:identityOf(ref),authorityClass:observationOf(ref,AuthorityClass.SETTLED),temporalStatus:ref.temporalStatus??'CURRENT'}).filter(x=>x.ref&&x.temporalStatus==='CURRENT');
    const merged=cap([...new Map([...current,...rows].map(x=>[x.ref,x])).values()].sort((a,b)=>a.ref.localeCompare(b.ref)),this.limits.maxWorldRefs),changed=[],reused=[],invalidated=[];
    const dependencyRevisionRefs=uniq(merged.flatMap(row=>[...(row?.identityRevisionRefs??[]),...(row?.dependencyRevisionRefs??[])]));
    this.#setSegment(state,HotSegmentKind.WORLD_REFERENCES,{value:merged,sourceRevisionRefs,dependencyRevisionRefs,provenanceRefs,authorityClass:AuthorityClass.SETTLED,owner:'WORLD_STATE',freshness:HotFreshness.FRESH,updateId:id,changed,reused});
    state.worldRevision=Math.max(state.worldRevision,Number.isFinite(revision)?revision:state.worldRevision);
    if(state.worldRevision>previousWorldRevision)this.#invalidateSegments(state,[HotSegmentKind.GRAPH_NEIGHBORHOOD],{reason:'WORLD_REVISION_CHANGED',updateId:id,invalidated});
    return this.#commit(state,{updateId:id,eventType,changed,reused,invalidated,sourceRevisionRefs,worldRevision:state.worldRevision});
  }

  invalidateKnowledge({chatNamespace=this.activeChatNamespace,updateId,invalidatedSourceRevisionRefs=[],invalidatedDependencyRevisionRefs=[],affectedSegments=[],reason='KNOWLEDGE_INVALIDATED'}={}){
    if(!chatNamespace||!this.states.has(chatNamespace))return null;
    return this.#knowledgeInvalidation(this.states.get(chatNamespace),{updateId:String(updateId??('invalidate:'+stableHash([invalidatedSourceRevisionRefs,invalidatedDependencyRevisionRefs,affectedSegments],{length:16}))),eventType:'KNOWLEDGE_INVALIDATED',sourceRevisionRefs:uniq(invalidatedSourceRevisionRefs),dependencyRevisionRefs:uniq(invalidatedDependencyRevisionRefs),affectedSegments,reason});
  }

  setDependencyState(dependencyId,stateValue,{chatNamespace=this.activeChatNamespace,revisionRefs=[],reason=null,updateId=null}={}){
    if(!chatNamespace||!this.states.has(chatNamespace))return null;const state=this.states.get(chatNamespace),id=String(updateId??('dependency:'+dependencyId+':'+stateValue+':'+stableHash(revisionRefs,{length:8})));
    const duplicate=this.#duplicateReceipt(state,id,'DEPENDENCY_STATE_CHANGED');if(duplicate)return duplicate;
    const changed=[],reused=[];this.#setDependencyInternal(state,dependencyId,stateValue,{revisionRefs,reason,updateId:id,changed,reused});
    return this.#commit(state,{updateId:id,eventType:'DEPENDENCY_STATE_CHANGED',changed,reused,invalidated:[],sourceRevisionRefs:[]});
  }

  setGraphNeighborhood({chatNamespace=this.activeChatNamespace,state=HotDependencyState.UNAVAILABLE,refs=[],entries=[],sourceRevisionRefs=[],identityRevisionRefs=[],dependencyRevisionRefs=[],provenanceRefs=[],updateId=null}={}){
    if(!chatNamespace||!this.states.has(chatNamespace))return null;const hot=this.states.get(chatNamespace),id=String(updateId??('graph:'+state+':'+stableHash(refs,{length:12})));
    const duplicate=this.#duplicateReceipt(hot,id,'GRAPH_NEIGHBORHOOD_CHANGED');if(duplicate)return duplicate;
    const changed=[],reused=[];
    const boundedEntries=cap([...(new Map((entries??[]).map(row=>[String(row?.ref??''),clone(row)])).values())].filter(row=>row?.ref).sort((a,b)=>String(a.ref).localeCompare(String(b.ref))),this.limits.maxGraphRefs);
    const normalized=cap(uniq([...(refs??[]).map(identityOf).filter(Boolean),...boundedEntries.map(row=>row.ref)]),this.limits.maxGraphRefs),freshness=state===HotDependencyState.AVAILABLE?HotFreshness.FRESH:state===HotDependencyState.STALE?HotFreshness.STALE:HotFreshness.UNAVAILABLE;
    const kept=new Set(normalized),normalizedEntries=boundedEntries.filter(row=>kept.has(String(row.ref)));
    const graphDependencyRefs=uniq([...sourceRevisionRefs,...identityRevisionRefs,...dependencyRevisionRefs,...normalizedEntries.flatMap(row=>[...(row.sourceRevisionRefs??[]),...(row.identityRevisionRefs??[]),...(row.dependencyRevisionRefs??[])])]);
    this.#setSegment(hot,HotSegmentKind.GRAPH_NEIGHBORHOOD,{value:{state,refs:normalized,entries:normalizedEntries},sourceRevisionRefs,dependencyRevisionRefs:graphDependencyRefs,provenanceRefs,authorityClass:AuthorityClass.UNRESOLVED,owner:'GRAPH_OWNER',freshness,updateId:id,changed,reused});
    this.#setDependencyInternal(hot,'GRAPH_NEIGHBORHOOD',state,{revisionRefs:graphDependencyRefs,reason:state,updateId:id,changed,reused});
    return this.#commit(hot,{updateId:id,eventType:'GRAPH_NEIGHBORHOOD_CHANGED',changed,reused,invalidated:[],sourceRevisionRefs});
  }

  consumeResultRoute(received,{chatNamespace=this.activeChatNamespace}={}){
    if(!chatNamespace||!this.states.has(chatNamespace)||!received?.result||!received?.route)return null;
    const state=this.states.get(chatNamespace),result=received.result,route=received.route,id='result-route:'+route.id;
    const duplicate=this.#duplicateReceipt(state,id,'WORK_RESULT');if(duplicate)return duplicate;
    if(route.freshness!=='FRESH'||!route.accepted){state.counters.staleRejects+=1;this.#rememberDedupe(state,id);return createHotUpdateReceipt({updateId:id,status:HotUpdateStatus.STALE,chatNamespace,eventType:'WORK_RESULT',hotRevision:state.hotRevision,staleReason:route.reason??'result is not fresh',sourceRevisionRefs:result.sourceRevisionIds??[],sceneRevision:result.sceneRevision,worldRevision:result.worldRevision});}
    const changed=[],reused=[],current=clone(state.segments[HotSegmentKind.CONTINUITY].value??{pins:[],lateResultRefs:[]}),ref={resultId:result.id,resultType:result.resultType,sourceSubsystem:result.sourceSubsystem,effectiveDestination:route.effectiveDestination,late:Boolean(route.late),authorityClass:result.authorityClass,sourceRevisionIds:uniq(result.sourceRevisionIds??[])};
    if(route.late&&route.effectiveDestination==='NEXT_TURN')current.lateResultRefs=cap([...(current.lateResultRefs??[]),ref],this.limits.maxContinuityRefs);
    else if(Array.isArray(result.payload?.hotCognitionRefs))current.pins=cap(uniq([...(current.pins??[]),...result.payload.hotCognitionRefs.map(String)]),this.limits.maxContinuityRefs);
    else{this.#rememberDedupe(state,id);return createHotUpdateReceipt({updateId:id,status:HotUpdateStatus.NO_CHANGE,chatNamespace,eventType:'WORK_RESULT',hotRevision:state.hotRevision,reusedSegments:[HotSegmentKind.CONTINUITY],sourceRevisionRefs:result.sourceRevisionIds??[],sceneRevision:result.sceneRevision,worldRevision:result.worldRevision,details:{reason:'no explicit Hot Cognition reference payload'}});}
    this.#setSegment(state,HotSegmentKind.CONTINUITY,{value:current,sourceRevisionRefs:result.sourceRevisionIds??[],provenanceRefs:[result.id,route.id],authorityClass:AuthorityClass.UNRESOLVED,owner:'COGNITIVE_CORE',freshness:HotFreshness.FRESH,updateId:id,changed,reused});
    return this.#commit(state,{updateId:id,eventType:'WORK_RESULT',changed,reused,invalidated:[],sourceRevisionRefs:result.sourceRevisionIds??[],sceneRevision:result.sceneRevision,worldRevision:result.worldRevision,details:{late:Boolean(route.late),effectiveDestination:route.effectiveDestination}});
  }

  noteGenerationSeal({turnId,sealReceipt,snapshot=null}={}){
    const hot=snapshot??this.snapshot();if(!hot||!turnId)return null;
    const stored={turnId:String(turnId),contextSealId:sealReceipt?.id??null,packetHash:sealReceipt?.packetHash??null,snapshot:hot};
    this.sealedSnapshots.set(String(turnId),stored);while(this.sealedSnapshots.size>this.limits.maxSealedSnapshots)this.sealedSnapshots.delete(this.sealedSnapshots.keys().next().value);
    return deepFreeze(clone(stored));
  }
  snapshotForTurn(turnId){const row=this.sealedSnapshots.get(String(turnId));return row?deepFreeze(clone(row)):null;}

  exportState(){
    return clone({kind:'HotCognitionPersistedState',version:1,activeChatNamespace:this.activeChatNamespace,states:[...this.states.values()].map(state=>({
      stateId:state.stateId,chatNamespace:state.chatNamespace,hotRevision:state.hotRevision,sceneId:state.sceneId,sceneRevision:state.sceneRevision,worldRevision:state.worldRevision,characterStateRevision:state.characterStateRevision,segments:state.segments,lastAcceptedUpdateId:state.lastAcceptedUpdateId,counters:state.counters,reconstructionState:state.reconstructionState,dedupe:[...state.dedupe.keys()],
    }))});
  }

  restoreState(persisted,{activeSourceRevisionRefs=null,sceneRevision=null,worldRevision=null}={}){
    if(!persisted||persisted.kind!=='HotCognitionPersistedState')throw new TypeError('HotCognitionPersistedState required');
    this.states.clear();
    for(const raw of persisted.states??[]){
      const state=this.#newState(raw.chatNamespace);state.stateId=raw.stateId??state.stateId;state.hotRevision=Number(raw.hotRevision??0);state.sceneId=raw.sceneId??null;state.sceneRevision=Number(raw.sceneRevision??0);state.worldRevision=Number(raw.worldRevision??0);state.characterStateRevision=raw.characterStateRevision??null;state.segments=clone(raw.segments??initialSegments());state.lastAcceptedUpdateId=raw.lastAcceptedUpdateId??null;state.counters={...state.counters,...clone(raw.counters??{})};state.reconstructionState='RESTORED_PERSISTED';state.dedupe=new Map((raw.dedupe??[]).map(x=>[x,true]));this.states.set(state.chatNamespace,state);
    }
    this.activeChatNamespace=persisted.activeChatNamespace&&this.states.has(persisted.activeChatNamespace)?persisted.activeChatNamespace:null;
    if(this.activeChatNamespace){
      const state=this.states.get(this.activeChatNamespace),invalidated=[];
      if(sceneRevision!=null&&Number(sceneRevision)!==state.sceneRevision)this.#invalidateSegments(state,[HotSegmentKind.SCENE,HotSegmentKind.LOCATION,HotSegmentKind.ACTIVE_CAST,HotSegmentKind.ACTIVE_ENTITIES,HotSegmentKind.ACTIVE_THREADS],{reason:'RECONSTRUCTION_SCENE_REVISION_MISMATCH',updateId:'restore:scene',invalidated});
      if(worldRevision!=null&&Number(worldRevision)!==state.worldRevision)this.#invalidateSegments(state,[HotSegmentKind.WORLD_REFERENCES,HotSegmentKind.GRAPH_NEIGHBORHOOD],{reason:'RECONSTRUCTION_WORLD_REVISION_MISMATCH',updateId:'restore:world',invalidated});
      if(activeSourceRevisionRefs){
        for(const kind of Object.values(HotSegmentKind)){const seg=state.segments[kind];if(this.#knownInactiveSourceRefs(seg.sourceRevisionRefs).length)this.#invalidateSegments(state,[kind],{reason:'RECONSTRUCTION_SOURCE_REVISION_MISMATCH',updateId:'restore:source',invalidated});}
      }
      if(invalidated.length){state.hotRevision+=1;state.counters.rebuilds+=1;state.reconstructionState='RESTORED_WITH_INVALIDATION';}
    }
    return this.snapshot();
  }

  reconstruct({chatNamespace,sceneSignal=null,worldRevision=this.getWorldRevision(),dependencyStates={},graphNeighborhood=null,recentEpisodeTail=[]}={}){
    const namespace=String(chatNamespace??'').trim();if(!namespace)throw new TypeError('reconstruct requires chatNamespace');
    this.states.delete(namespace);this.activateChat(namespace,{reason:'RECONSTRUCT'});const state=this.states.get(namespace);state.reconstructionState='REBUILT_FROM_OWNERS';state.counters.rebuilds+=1;
    let receipt=null;
    if(sceneSignal)receipt=this.consumeSceneSignal(sceneSignal,{chatNamespace:namespace,updateId:'reconstruct:scene:'+String(sceneSignal.sceneRevision),rebuild:true});
    state.worldRevision=Math.max(0,Number(worldRevision)||0);
    for(const [dependencyId,dependencyState] of Object.entries(dependencyStates))this.setDependencyState(dependencyId,dependencyState,{chatNamespace:namespace,updateId:'reconstruct:dependency:'+dependencyId});
    if(graphNeighborhood)this.setGraphNeighborhood({chatNamespace:namespace,...graphNeighborhood,updateId:'reconstruct:graph'});
    if(recentEpisodeTail.length){
      const changed=[],reused=[];this.#setSegment(state,HotSegmentKind.RECENT_EPISODE_TAIL,{value:cap(clone(recentEpisodeTail),this.limits.maxRecentTail),sourceRevisionRefs:uniq(recentEpisodeTail.flatMap(x=>x.sourceRevisionId?[x.sourceRevisionId]:[])),provenanceRefs:[],authorityClass:AuthorityClass.OBSERVED,owner:'NARRATIVE_FEED',freshness:HotFreshness.FRESH,updateId:'reconstruct:tail',rebuild:true,changed,reused});this.#commit(state,{updateId:'reconstruct:tail',eventType:'RECONSTRUCTION',changed,reused,invalidated:[],sourceRevisionRefs:[]});
    }
    return {snapshot:this.snapshot(namespace),receipt};
  }

  #knownInactiveSourceRefs(refs){if(!this.sourceRegistry)return[];return uniq(refs).filter(ref=>this.sourceRegistry.getRevision?.(ref)&&!this.sourceRegistry.isActiveRevision(ref));}

  #newState(chatNamespace){
    return {stateId:'hot-state:'+stableHash(chatNamespace,{length:16,alreadyString:true}),chatNamespace,hotRevision:0,sceneId:null,sceneRevision:0,worldRevision:Math.max(0,Number(this.getWorldRevision())||0),characterStateRevision:null,segments:initialSegments(),lastAcceptedUpdateId:null,counters:{updates:0,reuses:0,invalidations:0,rebuilds:0,duplicates:0,staleRejects:0,sceneTransitions:0},reconstructionState:'EMPTY',dedupe:new Map(),lastAccessSequence:++this.sequence};
  }
  #evictChats(){while(this.states.size>this.limits.maxChats){const rows=[...this.states.values()].filter(x=>x.chatNamespace!==this.activeChatNamespace).sort((a,b)=>a.lastAccessSequence-b.lastAccessSequence);if(!rows.length)break;this.states.delete(rows[0].chatNamespace);}}
  #rememberDedupe(state,id){state.dedupe.set(id,true);while(state.dedupe.size>this.limits.maxDedupe)state.dedupe.delete(state.dedupe.keys().next().value);}
  #duplicateReceipt(state,id,eventType){if(!state.dedupe.has(id))return null;state.counters.duplicates+=1;return createHotUpdateReceipt({updateId:id,status:HotUpdateStatus.DUPLICATE,chatNamespace:state.chatNamespace,eventType,hotRevision:state.hotRevision,duplicateOf:id,sceneRevision:state.sceneRevision,worldRevision:state.worldRevision});}
  #stale(state,id,eventType,reason,sceneRevision=state.sceneRevision,worldRevision=state.worldRevision){state.counters.staleRejects+=1;this.#rememberDedupe(state,id);return createHotUpdateReceipt({updateId:id,status:HotUpdateStatus.STALE,chatNamespace:state.chatNamespace,eventType,hotRevision:state.hotRevision,staleReason:reason,sceneRevision,worldRevision});}
  #listAuthority(rows){if(rows.some(x=>x.authorityClass===AuthorityClass.INFERRED))return AuthorityClass.INFERRED;if(rows.some(x=>x.authorityClass===AuthorityClass.OBSERVED))return AuthorityClass.OBSERVED;return AuthorityClass.UNRESOLVED;}

  #setSegment(state,kind,{value,sourceRevisionRefs=[],dependencyRevisionRefs=[],provenanceRefs=[],authorityClass=AuthorityClass.UNRESOLVED,owner='COGNITIVE_CORE',freshness=HotFreshness.FRESH,updateId,rebuild=false,changed,reused}){
    const normalizedSourceRefs=uniq(sourceRevisionRefs),normalizedDependencyRefs=uniq(dependencyRevisionRefs),normalizedProvenance=cap(uniq(provenanceRefs),this.limits.maxProvenanceRefs);
    const prior=state.segments[kind],sameMaterial=prior&&same({value:prior.value,sourceRevisionRefs:prior.sourceRevisionRefs,dependencyRevisionRefs:prior.dependencyRevisionRefs,authorityClass:prior.authorityClass,owner:prior.owner,freshness:prior.freshness},{value,sourceRevisionRefs:normalizedSourceRefs,dependencyRevisionRefs:normalizedDependencyRefs,authorityClass,owner,freshness});
    if(sameMaterial){
      state.segments[kind]=createHotSegment({...prior,provenanceRefs:mergeRefs(prior.provenanceRefs,normalizedProvenance,this.limits.maxProvenanceRefs),changeState:HotChangeState.REUSED,reuseCount:prior.reuseCount+1,lastUpdate:{updateId,hotRevision:state.hotRevision+1}});
      state.counters.reuses+=1;reused.push(kind);return false;
    }
    state.segments[kind]=createHotSegment({
      kind,revision:(prior?.revision??0)+1,value,owner,authorityClass,sourceRevisionRefs:normalizedSourceRefs,dependencyRevisionRefs:normalizedDependencyRefs,provenanceRefs:normalizedProvenance,freshness,
      changeState:rebuild?HotChangeState.REBUILT:freshness===HotFreshness.UNAVAILABLE?HotChangeState.UNAVAILABLE:HotChangeState.UPDATED,
      lastUpdate:{updateId,hotRevision:state.hotRevision+1},invalidationReason:null,
      reuseCount:prior?.reuseCount??0,updateCount:(prior?.updateCount??0)+1,rebuildCount:(prior?.rebuildCount??0)+(rebuild?1:0),invalidationCount:prior?.invalidationCount??0,
    });
    changed.push(kind);return true;
  }

  #invalidateSegments(state,kinds,{reason,updateId,invalidated}){
    for(const kind of uniq(kinds)){
      if(!Object.values(HotSegmentKind).includes(kind))continue;const prior=state.segments[kind];if(!prior||prior.freshness===HotFreshness.INVALIDATED&&prior.invalidationReason===reason)continue;
      state.segments[kind]=createHotSegment({...prior,revision:prior.revision+1,freshness:HotFreshness.INVALIDATED,changeState:HotChangeState.INVALIDATED,lastUpdate:{updateId,hotRevision:state.hotRevision+1},invalidationReason:reason,invalidationCount:prior.invalidationCount+1});
      invalidated.push(kind);state.counters.invalidations+=1;
    }
  }

  #appendEpisodeRefs(state,refs,{sourceRevisionRefs=[],provenanceRefs=[],updateId,rebuild=false,changed,reused}){
    const current=state.segments[HotSegmentKind.RECENT_EPISODE_TAIL].value??[],rows=[];
    for(const raw of refs){if(raw==null)continue;const ref=identityOf(raw)??(typeof raw==='string'?raw:null);if(!ref)continue;rows.push(typeof raw==='string'?{refId:raw}:{refId:String(ref),...clone(raw)});}
    const merged=cap([...new Map([...current,...rows].map(x=>[x.refId,x])).values()],this.limits.maxRecentTail);
    this.#setSegment(state,HotSegmentKind.RECENT_EPISODE_TAIL,{value:merged,sourceRevisionRefs:mergeRefs(state.segments[HotSegmentKind.RECENT_EPISODE_TAIL].sourceRevisionRefs,sourceRevisionRefs,this.limits.maxProvenanceRefs),provenanceRefs:mergeRefs(state.segments[HotSegmentKind.RECENT_EPISODE_TAIL].provenanceRefs,provenanceRefs,this.limits.maxProvenanceRefs),authorityClass:AuthorityClass.OBSERVED,owner:'SCENE_INTELLIGENCE',freshness:HotFreshness.FRESH,updateId,rebuild,changed,reused});
  }

  #setDependencyInternal(state,dependencyId,stateValue,{revisionRefs=[],reason=null,updateId,changed,reused}){
    if(!Object.values(HotDependencyState).includes(stateValue))throw new TypeError('unsupported dependency state: '+stateValue);
    const prior=clone(state.segments[HotSegmentKind.DEPENDENCY_STATE].value??{}),priorRow=prior[dependencyId]??null,normalizedRefs=uniq(revisionRefs);
    const sameDependency=Boolean(priorRow&&priorRow.state===stateValue&&same(priorRow.revisionRefs??[],normalizedRefs)&&String(priorRow.reason??'')===String(reason??''));
    const row=createHotDependency({dependencyId,state:stateValue,revisionRefs:normalizedRefs,reason,lastUpdateId:sameDependency?priorRow.lastUpdateId:updateId});prior[dependencyId]=row;
    this.#setSegment(state,HotSegmentKind.DEPENDENCY_STATE,{value:prior,dependencyRevisionRefs:uniq(Object.values(prior).flatMap(x=>x.revisionRefs)),provenanceRefs:[],authorityClass:AuthorityClass.UNRESOLVED,owner:'COGNITIVE_CORE',freshness:HotFreshness.FRESH,updateId,changed,reused});
  }

  #knowledgeInvalidation(state,{updateId,eventType,sourceRevisionRefs=[],dependencyRevisionRefs=[],affectedSegments=[],reason}){
    const duplicate=this.#duplicateReceipt(state,updateId,eventType);if(duplicate)return duplicate;const source=new Set(sourceRevisionRefs),deps=new Set(dependencyRevisionRefs),invalidated=[];
    const explicit=new Set(affectedSegments);
    for(const kind of Object.values(HotSegmentKind)){
      if(kind===HotSegmentKind.DEPENDENCY_STATE)continue;const seg=state.segments[kind];
      const hit=explicit.has(kind)||seg.sourceRevisionRefs.some(x=>source.has(x))||seg.dependencyRevisionRefs.some(x=>deps.has(x));
      if(hit)this.#invalidateSegments(state,[kind],{reason,updateId,invalidated});
    }
    if(!invalidated.length){this.#rememberDedupe(state,updateId);return createHotUpdateReceipt({updateId,status:HotUpdateStatus.NO_CHANGE,chatNamespace:state.chatNamespace,eventType,hotRevision:state.hotRevision,sourceRevisionRefs,sceneRevision:state.sceneRevision,worldRevision:state.worldRevision,details:{reason:'no dependent Hot Cognition segment'}});}
    return this.#commit(state,{updateId,eventType,changed:[],reused:[],invalidated,sourceRevisionRefs,sceneRevision:state.sceneRevision,worldRevision:state.worldRevision,details:{dependencyRevisionRefs,reason}});
  }

  #commit(state,{updateId,eventType,changed=[],reused=[],invalidated=[],sourceRevisionRefs=[],sceneRevision=null,worldRevision=null,details={}}){
    this.#rememberDedupe(state,updateId);state.hotRevision+=1;state.lastAcceptedUpdateId=updateId;state.counters.updates+=1;state.lastAccessSequence=++this.sequence;if(state.reconstructionState==='EMPTY')state.reconstructionState='LIVE';
    return createHotUpdateReceipt({updateId,status:changed.length||invalidated.length?HotUpdateStatus.APPLIED:HotUpdateStatus.NO_CHANGE,chatNamespace:state.chatNamespace,eventType,hotRevision:state.hotRevision,changedSegments:uniq(changed),reusedSegments:uniq(reused),invalidatedSegments:uniq(invalidated),sourceRevisionRefs:uniq(sourceRevisionRefs),sceneRevision:sceneRevision==null?state.sceneRevision:sceneRevision,worldRevision:worldRevision==null?state.worldRevision:worldRevision,details});
  }
}
