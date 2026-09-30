import {HotSegmentKind,HotFreshness} from './hot-cognition-contracts.js';

const clone=(v)=>v==null?v:structuredClone(v);
const uniq=(xs)=>[...new Set((xs??[]).filter(x=>typeof x==='string'&&x.length))].sort();
function deepFreeze(value){if(value&&typeof value==='object'&&!Object.isFrozen(value)){for(const child of Object.values(value))deepFreeze(child);Object.freeze(value);}return value;}
const frozen=(v)=>deepFreeze(clone(v));

function ids(value=[]){return(value??[]).map(x=>typeof x==='string'?x:x?.id??x?.threadId??x?.refId??x?.ref??null).filter(Boolean);}
export function createHotCognitionReadModel(snapshot){
  if(!snapshot?.snapshotId)throw new TypeError('HotCognitionSnapshot is required');
  const segments=snapshot.segments,dependencyRows=segments[HotSegmentKind.DEPENDENCY_STATE]?.value??{};
  const freshness=Object.fromEntries(Object.values(HotSegmentKind).map(kind=>[kind,segments[kind]?.freshness??HotFreshness.UNAVAILABLE]));
  const location=segments[HotSegmentKind.LOCATION]?.value??null,cast=segments[HotSegmentKind.ACTIVE_CAST]?.value??[],entities=segments[HotSegmentKind.ACTIVE_ENTITIES]?.value??[],threads=segments[HotSegmentKind.ACTIVE_THREADS]?.value??[];
  return frozen({
    kind:'HotCognitionReadModel',contractVersion:'1.0.0',snapshotId:snapshot.snapshotId,stateId:snapshot.stateId,chatNamespace:snapshot.chatNamespace,
    hotRevision:snapshot.hotRevision,sceneId:snapshot.sceneId,sceneRevision:snapshot.sceneRevision,worldRevision:snapshot.worldRevision,
    locationSummary:clone(location),activeCastSummary:ids(cast),activeEntitySummary:ids(entities),activeThreadSummary:ids(threads),
    segmentFreshness:freshness,degradedDependencies:uniq(snapshot.degradedDependencies),unavailableDependencies:uniq(snapshot.unavailableDependencies),
    dependencyStates:Object.fromEntries(Object.entries(dependencyRows).map(([id,row])=>[id,row.state])),
    lastUpdateCause:snapshot.lastAcceptedUpdateId,reuseCount:Number(snapshot.counters?.reuses??0),updateCount:Number(snapshot.counters?.updates??0),
    rebuildCount:Number(snapshot.counters?.rebuilds??0),staleRejects:Number(snapshot.counters?.staleRejects??0),
    duplicateCount:Number(snapshot.counters?.duplicates??0),invalidationCount:Number(snapshot.counters?.invalidations??0),
    reconstructionState:snapshot.reconstructionState,sourceRevisionRefs:uniq(snapshot.sourceRevisionRefs),dependencyRevisionRefs:uniq(snapshot.dependencyRevisionRefs),
    provenanceRefs:uniq(snapshot.provenanceRefs),authority:'READ_ONLY',readOnly:true,mutationAuthority:false,
  });
}
