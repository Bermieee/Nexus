import {AuthorityClass} from './contracts.js';

const clone=(value)=>value==null?value:structuredClone(value);
const req=(value,name)=>{if(typeof value!=='string'||!value.trim())throw new TypeError(name+' must be a non-empty string');return value.trim();};
const strings=(value,name)=>{if(!Array.isArray(value)||value.some(x=>typeof x!=='string'))throw new TypeError(name+' must be an array of strings');return[...new Set(value)].sort();};
const serial=(value,name)=>{try{JSON.stringify(value);}catch{throw new TypeError(name+' must be JSON-serializable');}return clone(value);};
const nonNegative=(value,name)=>{const n=Number(value);if(!Number.isInteger(n)||n<0)throw new TypeError(name+' must be a non-negative integer');return n;};
const enumSet=(value)=>new Set(Object.values(value));
const one=(value,set,name)=>{if(!set.has(value))throw new TypeError(name+' has unsupported value: '+value);return value;};
function deepFreeze(value){if(value&&typeof value==='object'&&!Object.isFrozen(value)){for(const child of Object.values(value))deepFreeze(child);Object.freeze(value);}return value;}
const frozen=(value)=>deepFreeze(clone(value));

export const HOT_COGNITION_CONTRACT_VERSION='1.0.0';

export const HotSegmentKind=Object.freeze({
  SCENE:'SCENE',
  LOCATION:'LOCATION',
  ACTIVE_CAST:'ACTIVE_CAST',
  ACTIVE_ENTITIES:'ACTIVE_ENTITIES',
  ACTIVE_THREADS:'ACTIVE_THREADS',
  CONTINUITY:'CONTINUITY',
  RECENT_EPISODE_TAIL:'RECENT_EPISODE_TAIL',
  WORLD_REFERENCES:'WORLD_REFERENCES',
  GRAPH_NEIGHBORHOOD:'GRAPH_NEIGHBORHOOD',
  DEPENDENCY_STATE:'DEPENDENCY_STATE',
});

export const HotFreshness=Object.freeze({
  FRESH:'FRESH',
  STALE:'STALE',
  INVALIDATED:'INVALIDATED',
  UNAVAILABLE:'UNAVAILABLE',
});

export const HotChangeState=Object.freeze({
  REUSED:'REUSED',
  UPDATED:'UPDATED',
  INVALIDATED:'INVALIDATED',
  REBUILT:'REBUILT',
  UNAVAILABLE:'UNAVAILABLE',
});

export const HotDependencyState=Object.freeze({
  AVAILABLE:'AVAILABLE',
  DEGRADED:'DEGRADED',
  UNAVAILABLE:'UNAVAILABLE',
  STALE:'STALE',
});

export const HotUpdateStatus=Object.freeze({
  APPLIED:'APPLIED',
  NO_CHANGE:'NO_CHANGE',
  DUPLICATE:'DUPLICATE',
  STALE:'STALE',
  REJECTED:'REJECTED',
});

const SEGMENT=enumSet(HotSegmentKind),FRESH=enumSet(HotFreshness),CHANGE=enumSet(HotChangeState),DEPENDENCY=enumSet(HotDependencyState),UPDATE=enumSet(HotUpdateStatus),AUTHORITY=enumSet(AuthorityClass);

export function createHotSegment({
  kind,revision=0,value=null,owner='COGNITIVE_CORE',authorityClass=AuthorityClass.UNRESOLVED,
  sourceRevisionRefs=[],dependencyRevisionRefs=[],provenanceRefs=[],freshness=HotFreshness.UNAVAILABLE,
  changeState=HotChangeState.UNAVAILABLE,lastUpdate=null,invalidationReason=null,
  reuseCount=0,updateCount=0,rebuildCount=0,invalidationCount=0,
}={}){
  return frozen({
    kind:one(kind,SEGMENT,'HotSegment.kind'),
    revision:nonNegative(revision,'HotSegment.revision'),
    value:serial(value,'HotSegment.value'),
    owner:req(owner,'HotSegment.owner'),
    authorityClass:one(authorityClass,AUTHORITY,'HotSegment.authorityClass'),
    sourceRevisionRefs:strings(sourceRevisionRefs,'HotSegment.sourceRevisionRefs'),
    dependencyRevisionRefs:strings(dependencyRevisionRefs,'HotSegment.dependencyRevisionRefs'),
    provenanceRefs:strings(provenanceRefs,'HotSegment.provenanceRefs'),
    freshness:one(freshness,FRESH,'HotSegment.freshness'),
    changeState:one(changeState,CHANGE,'HotSegment.changeState'),
    lastUpdate:lastUpdate==null?null:serial(lastUpdate,'HotSegment.lastUpdate'),
    invalidationReason:invalidationReason==null?null:req(String(invalidationReason),'HotSegment.invalidationReason'),
    reuseCount:nonNegative(reuseCount,'HotSegment.reuseCount'),
    updateCount:nonNegative(updateCount,'HotSegment.updateCount'),
    rebuildCount:nonNegative(rebuildCount,'HotSegment.rebuildCount'),
    invalidationCount:nonNegative(invalidationCount,'HotSegment.invalidationCount'),
  });
}

export function createHotDependency({dependencyId,state=HotDependencyState.UNAVAILABLE,revisionRefs=[],reason=null,lastUpdateId=null}={}){
  return frozen({
    dependencyId:req(dependencyId,'HotDependency.dependencyId'),
    state:one(state,DEPENDENCY,'HotDependency.state'),
    revisionRefs:strings(revisionRefs,'HotDependency.revisionRefs'),
    reason:reason==null?null:String(reason),
    lastUpdateId:lastUpdateId==null?null:String(lastUpdateId),
  });
}

export function createHotCognitionSnapshot({
  snapshotId,stateId,chatNamespace,hotRevision=0,sceneId=null,sceneRevision=0,worldRevision=0,characterStateRevision=null,
  segments={},sourceRevisionRefs=[],dependencyRevisionRefs=[],degradedDependencies=[],unavailableDependencies=[],
  lastAcceptedUpdateId=null,provenanceRefs=[],invalidationState=[],counters={},reconstructionState='LIVE',
}={}){
  const normalizedSegments={};
  for(const kind of Object.values(HotSegmentKind)){
    const segment=segments[kind];
    if(!segment)throw new TypeError('HotCognitionSnapshot missing segment '+kind);
    normalizedSegments[kind]=segment.kind===kind?clone(segment):createHotSegment({...segment,kind});
  }
  const snapshot={
    kind:'HotCognitionSnapshot',contractVersion:HOT_COGNITION_CONTRACT_VERSION,
    snapshotId:req(snapshotId,'HotCognitionSnapshot.snapshotId'),stateId:req(stateId,'HotCognitionSnapshot.stateId'),
    chatNamespace:req(chatNamespace,'HotCognitionSnapshot.chatNamespace'),hotRevision:nonNegative(hotRevision,'HotCognitionSnapshot.hotRevision'),
    sceneId:sceneId==null?null:String(sceneId),sceneRevision:nonNegative(sceneRevision,'HotCognitionSnapshot.sceneRevision'),
    worldRevision:nonNegative(worldRevision,'HotCognitionSnapshot.worldRevision'),
    characterStateRevision:characterStateRevision==null?null:nonNegative(characterStateRevision,'HotCognitionSnapshot.characterStateRevision'),
    segments:normalizedSegments,
    sourceRevisionRefs:strings(sourceRevisionRefs,'HotCognitionSnapshot.sourceRevisionRefs'),
    dependencyRevisionRefs:strings(dependencyRevisionRefs,'HotCognitionSnapshot.dependencyRevisionRefs'),
    degradedDependencies:strings(degradedDependencies,'HotCognitionSnapshot.degradedDependencies'),
    unavailableDependencies:strings(unavailableDependencies,'HotCognitionSnapshot.unavailableDependencies'),
    lastAcceptedUpdateId:lastAcceptedUpdateId==null?null:String(lastAcceptedUpdateId),
    provenanceRefs:strings(provenanceRefs,'HotCognitionSnapshot.provenanceRefs'),
    invalidationState:serial(invalidationState,'HotCognitionSnapshot.invalidationState'),
    counters:serial(counters,'HotCognitionSnapshot.counters'),
    reconstructionState:req(reconstructionState,'HotCognitionSnapshot.reconstructionState'),
    authority:'WORKING_PROJECTION',authorityGranted:false,settlementAuthority:false,canonicalMutationAuthority:false,contextSealBypass:false,
  };
  return frozen(snapshot);
}

export function createHotUpdateReceipt({
  updateId,status,chatNamespace,eventType=null,hotRevision=0,changedSegments=[],reusedSegments=[],invalidatedSegments=[],
  staleReason=null,duplicateOf=null,sourceRevisionRefs=[],sceneRevision=null,worldRevision=null,details={},
}={}){
  return frozen({
    kind:'HotCognitionUpdateReceipt',contractVersion:HOT_COGNITION_CONTRACT_VERSION,
    updateId:req(updateId,'HotCognitionUpdateReceipt.updateId'),
    status:one(status,UPDATE,'HotCognitionUpdateReceipt.status'),
    chatNamespace:req(chatNamespace,'HotCognitionUpdateReceipt.chatNamespace'),
    eventType:eventType==null?null:String(eventType),hotRevision:nonNegative(hotRevision,'HotCognitionUpdateReceipt.hotRevision'),
    changedSegments:strings(changedSegments,'HotCognitionUpdateReceipt.changedSegments'),
    reusedSegments:strings(reusedSegments,'HotCognitionUpdateReceipt.reusedSegments'),
    invalidatedSegments:strings(invalidatedSegments,'HotCognitionUpdateReceipt.invalidatedSegments'),
    staleReason:staleReason==null?null:String(staleReason),duplicateOf:duplicateOf==null?null:String(duplicateOf),
    sourceRevisionRefs:strings(sourceRevisionRefs,'HotCognitionUpdateReceipt.sourceRevisionRefs'),
    sceneRevision:sceneRevision==null?null:nonNegative(sceneRevision,'HotCognitionUpdateReceipt.sceneRevision'),
    worldRevision:worldRevision==null?null:nonNegative(worldRevision,'HotCognitionUpdateReceipt.worldRevision'),
    details:serial(details,'HotCognitionUpdateReceipt.details'),
    authorityGranted:false,settlementAuthority:false,canonicalMutationAuthority:false,
  });
}

export function assertHotAuthorityBoundary(value,name='Hot Cognition input'){
  if(!value||typeof value!=='object')return true;
  if(value.authorityGranted===true||value.settlementAuthority===true||value.canonicalMutationAuthority===true||value.contextSealBypass===true){
    const error=new Error(name+' attempted to grant authority');error.code='HOT_AUTHORITY_VIOLATION';throw error;
  }
  return true;
}
