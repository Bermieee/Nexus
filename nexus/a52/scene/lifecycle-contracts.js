const freeze=(v)=>Object.freeze(v);
const clone=(v)=>v==null?v:structuredClone(v);
const req=(v,n)=>{if(typeof v!=='string'||!v)throw new TypeError(`${n} must be a non-empty string`);return v;};
const arr=(v,n)=>{if(!Array.isArray(v))throw new TypeError(`${n} must be an array`);return [...v];};
const sarr=(v,n)=>[...new Set(arr(v,n).map((x)=>req(x,n)))];
const one=(v,e,n)=>{if(!Object.values(e).includes(v))throw new TypeError(`${n} unsupported: ${v}`);return v;};
const rev=(v,n)=>{if(!Number.isInteger(v)||v<1)throw new TypeError(`${n} must be a positive integer`);return v;};

export const SceneRelationship=freeze({CONTINUES:'CONTINUES',PRECEDES:'PRECEDES',PARALLEL_TO:'PARALLEL_TO',FLASHBACK_OF:'FLASHBACK_OF',INTERRUPTS:'INTERRUPTS',RESUMES:'RESUMES',ISOLATED:'ISOLATED'});
export const TransitionStatus=freeze({COMPLETE:'COMPLETE',EPISODE_PENDING:'EPISODE_PENDING',TRANSITION_PARTIAL:'TRANSITION_PARTIAL',STALE:'STALE',DUPLICATE:'DUPLICATE',REJECTED:'REJECTED'});
export const RetrievalQuality=freeze({HIGH:'HIGH',MIXED:'MIXED',LOW:'LOW'});
export const HostActivity=freeze({USER_SEND:'USER_SEND',ASSISTANT_GENERATION_COMPLETE:'ASSISTANT_GENERATION_COMPLETE',REGENERATE:'REGENERATE',SWIPE_SELECTED:'SWIPE_SELECTED',EDIT:'EDIT',DELETE:'DELETE',CONTINUE:'CONTINUE',CHAT_LOAD:'CHAT_LOAD',CHAT_SWITCH:'CHAT_SWITCH',NEW_CHAT:'NEW_CHAT',IMPORT_OR_RELOAD:'IMPORT_OR_RELOAD',LORE_CHANGE:'LORE_CHANGE'});
export const HostEventStatus=freeze({ACCEPTED:'ACCEPTED',DUPLICATE:'DUPLICATE',INVALID:'HOST_EVENT_INVALID',UNSUPPORTED:'HOST_EVENT_UNSUPPORTED',PARTIAL:'HOST_EVENT_PARTIAL'});
export const SceneEventType=freeze({SCENE_STATE_DELTA:'SCENE_STATE_DELTA',LOCATION_CHANGED:'LOCATION_CHANGED',TIME_SHIFT_DETECTED:'TIME_SHIFT_DETECTED',ACTIVE_CAST_CHANGED:'ACTIVE_CAST_CHANGED',RELATIONSHIP_SIGNAL:'RELATIONSHIP_SIGNAL',SCENE_BOUNDARY_CANDIDATE:'SCENE_BOUNDARY_CANDIDATE',SCENE_BOUNDARY_CONFIRMED:'SCENE_BOUNDARY_CONFIRMED',SCENE_CLOSED:'SCENE_CLOSED',SCENE_OPENED:'SCENE_OPENED',VIBE_CHANGED:'VIBE_CHANGED',SCENE_EPISODE_READY:'SCENE_EPISODE_READY',PREFETCH_RECOMMENDED:'PREFETCH_RECOMMENDED',OBJECT_TRANSITION:'OBJECT_TRANSITION'});
export const SceneGraphEdgeType=freeze({SCENE_PRECEDES:'SCENE_PRECEDES',SCENE_CONTINUES:'SCENE_CONTINUES',SCENE_PARALLEL:'SCENE_PARALLEL',SCENE_FLASHBACK:'SCENE_FLASHBACK',SCENE_INTERRUPTS:'SCENE_INTERRUPTS',SCENE_RESUMES:'SCENE_RESUMES',ENTITY_IN_SCENE:'ENTITY_IN_SCENE',EVENT_IN_SCENE:'EVENT_IN_SCENE',OBJECT_IN_SCENE:'OBJECT_IN_SCENE',THREAD_IN_SCENE:'THREAD_IN_SCENE',EVIDENCE_CAUSES:'EVIDENCE_CAUSES',EVIDENCE_SUPPORTS:'EVIDENCE_SUPPORTS'});

export function createArtifactRef({artifactId,artifactType,revision,sourceRevisionRefs=[],sliceIdentity=null,digest=null,provenance=[],owner='SCENE_INTELLIGENCE',storageDomain='artifacts',sceneRevision=revision,sliceSelector=null,expiry=null}){
  const sourceRevisionSet=sarr(sourceRevisionRefs,'ArtifactReference.sourceRevisionSet').sort();
  const contentHash=digest==null?null:req(digest,'ArtifactReference.contentHash');
  return Object.freeze({
    kind:'ArtifactReference',contractVersion:'1.0.0',
    artifactId:req(artifactId,'ArtifactReference.artifactId'),artifactType:req(artifactType,'ArtifactReference.artifactType'),
    owner:req(owner,'ArtifactReference.owner'),revision:rev(revision,'ArtifactReference.revision'),storageDomain:req(storageDomain,'ArtifactReference.storageDomain'),
    sourceRevisionSet,worldRevision:null,sceneRevision:Number(sceneRevision),contentHash,
    sliceSelector:sliceSelector==null?null:clone(sliceSelector),provenanceRef:null,expiry:expiry==null?null:clone(expiry),
    authorityGranted:false,settlementAuthority:false,contextSealBypass:false,
    sourceRevisionRefs:[...sourceRevisionSet],sliceIdentity:sliceIdentity==null?null:req(sliceIdentity,'ArtifactReference.sliceIdentity'),
    digest:contentHash,provenance:sarr(provenance,'ArtifactReference.provenance')
  });
}

export function createSceneFrame({sceneId,relationshipToPrior=SceneRelationship.CONTINUES,suspended=false,resumable=true,parentSceneId=null,interruptedSceneId=null,sourceRevisionRefs=[],evidenceRefs=[]}){
  return {kind:'SceneFrame',sceneId:req(sceneId,'SceneFrame.sceneId'),relationshipToPrior:one(relationshipToPrior,SceneRelationship,'SceneFrame.relationshipToPrior'),suspended:Boolean(suspended),resumable:Boolean(resumable),parentSceneId:parentSceneId==null?null:req(parentSceneId,'SceneFrame.parentSceneId'),interruptedSceneId:interruptedSceneId==null?null:req(interruptedSceneId,'SceneFrame.interruptedSceneId'),sourceRevisionRefs:sarr(sourceRevisionRefs,'SceneFrame.sourceRevisionRefs'),evidenceRefs:sarr(evidenceRefs,'SceneFrame.evidenceRefs')};
}

export function createSceneEpisode({episodeId,sceneId,sceneRevision,sourceRange,sourceRevisionRefs=[],participants=[],location=null,narrativeTime=null,events=[],claims=[],relationshipSignals=[],stateTransitions=[],objectTransitions=[],threadsOpened=[],threadsResolved=[],threadsCarried=[],atmosphereTrajectory=[],sceneRelationships=[],compactSummary='',retrievalRefs=[],graphRefs=[],provenance=[],observationSummary={},artifactRef=null}){
  return {kind:'SceneEpisode',authority:'DERIVED',episodeId:req(episodeId,'SceneEpisode.episodeId'),sceneId:req(sceneId,'SceneEpisode.sceneId'),sceneRevision:rev(sceneRevision,'SceneEpisode.sceneRevision'),sourceRange:clone(sourceRange),sourceRevisionRefs:sarr(sourceRevisionRefs,'SceneEpisode.sourceRevisionRefs'),participants:clone(participants),location:clone(location),narrativeTime:clone(narrativeTime),events:clone(events),claims:clone(claims),relationshipSignals:clone(relationshipSignals),stateTransitions:clone(stateTransitions),objectTransitions:clone(objectTransitions),threadsOpened:clone(threadsOpened),threadsResolved:clone(threadsResolved),threadsCarried:clone(threadsCarried),atmosphereTrajectory:clone(atmosphereTrajectory),sceneRelationships:clone(sceneRelationships),compactSummary:String(compactSummary??''),retrievalRefs:clone(retrievalRefs),graphRefs:clone(graphRefs),provenance:sarr(provenance,'SceneEpisode.provenance'),observationSummary:clone(observationSummary),artifactRef:artifactRef?clone(artifactRef):null};
}

export function createSceneEventEnvelope({eventId,eventType,sceneId,sceneRevision,sourceRevisionRefs=[],payload={},version='1.0',producer='SCENE_INTELLIGENCE',chatId=null,correlationId=null,causationId=null,turnId=null,generationId=null,sequence=0,dedupeKey=null,createdAt=Date.now()}){
  const sourceRevisionSet=sarr(sourceRevisionRefs,'SceneEvent.sourceRevisionSet').sort();
  return Object.freeze({kind:'CognitiveEventEnvelope',eventId:req(eventId,'SceneEvent.eventId'),eventType:one(eventType,SceneEventType,'SceneEvent.eventType'),eventVersion:'1.0.0',schemaVersion:String(version),producer:req(producer,'SceneEvent.producer'),chatId:chatId==null?null:String(chatId),correlationId,causationId,turnId,generationId:generationId==null?null:String(generationId),taskId:null,sceneId:req(sceneId,'SceneEvent.sceneId'),sceneRevision:rev(sceneRevision,'SceneEvent.sceneRevision'),sourceRevisionSet,worldRevision:null,revisionFences:{sourceRevisionIds:[...sourceRevisionSet],sourceRevisions:Object.fromEntries(sourceRevisionSet.map((x)=>[x,x])),worldRevision:null,sceneRevision},sourceRevisions:Object.fromEntries(sourceRevisionSet.map((x)=>[x,x])),sequence:Number(sequence),createdSequence:Number(sequence),time:Number(createdAt),createdAt:Number(createdAt),dedupeIdentity:dedupeKey,dedupeKey,payload:clone(payload),payloadSchemaVersion:'1.0.0'});
}
