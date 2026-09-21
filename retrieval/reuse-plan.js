import { RETRIEVAL_CHANGE } from './change-gate.js';

function cleanRef(ref){const book=String(ref?.book||'').trim(),uid=Number(ref?.uid);return book&&Number.isFinite(uid)?{book,uid}:null;}
function key(ref){const row=cleanRef(ref);return row?JSON.stringify([row.book,row.uid]):'';}
function dedupe(refs=[]){const seen=new Set(),out=[];for(const raw of Array.isArray(refs)?refs:[]){const row=cleanRef(raw),id=key(row);if(!row||seen.has(id))continue;seen.add(id);out.push(row);}return out;}
function changed(delta,keyName){return delta?.[keyName]?.changed===true;}

/**
 * Build Retrieval's owner-authorized reuse plan. Scene Scanner observations are
 * inputs only: authorization comes from exact refs supplied by the owning
 * context system (pins/warm/retrieval state) and current source-revision fences.
 */
export function buildRetrievalReusePlan({gate=null,previousRefs=[],authorizedRefs=[],sceneDelta=null,minimumReuseRatio=0.4}={}){
  const prior=dedupe(previousRefs),authorizedSet=new Set(dedupe(authorizedRefs).map(key));
  const preservedRefs=prior.filter(ref=>authorizedSet.has(key(ref)));
  const dirtyRefs=prior.filter(ref=>!authorizedSet.has(key(ref)));
  const total=prior.length;
  const reuseRatio=total?preservedRefs.length/total:0;
  const delta=sceneDelta||gate?.sceneDelta||{};
  const locationDirty=changed(delta,'location'),timeDirty=changed(delta,'timeContext');
  const participantDirty=changed(delta,'participants'),activityDirty=changed(delta,'activity'),objectiveDirty=changed(delta,'objective'),focusDirty=changed(delta,'focus');
  const dirtyDomains=[];
  if(locationDirty)dirtyDomains.push('location','regional-lore','nearby-entities');
  if(timeDirty)dirtyDomains.push('time-context','time-bound-memory');
  if(participantDirty)dirtyDomains.push('participants','character-candidates');
  if(activityDirty)dirtyDomains.push('scene-activity');
  if(objectiveDirty)dirtyDomains.push('active-objective');
  if(focusDirty)dirtyDomains.push('scene-focus');
  if(dirtyRefs.length)dirtyDomains.push('injection-refs');
  const preserveDomains=[];
  if(preservedRefs.length)preserveDomains.push('authorized-injection-refs');
  if(!locationDirty)preserveDomains.push('regional-routing');
  const threshold=Math.max(0,Math.min(1,Number(minimumReuseRatio)||0));
  const semanticClass=String(gate?.mode||'');
  const transition=[RETRIEVAL_CHANGE.MINOR_CHANGE,RETRIEVAL_CHANGE.MAJOR_CHANGE].includes(semanticClass);
  const escalateFullRefresh=transition&&total>0&&reuseRatio<threshold;
  const reuseRegions=!locationDirty&&!timeDirty&&!escalateFullRefresh;
  const workloadUnits={
    refReview:escalateFullRefresh?total:dirtyRefs.length,
    regionalRouting:(locationDirty||timeDirty)?1:0,
    participantRefresh:participantDirty?1:0,
    activityRefresh:activityDirty?1:0,
    objectiveRefresh:objectiveDirty?1:0,
    focusRefresh:focusDirty?1:0,
  };
  const estimatedWorkUnits=Object.values(workloadUnits).reduce((sum,value)=>sum+Math.max(0,Number(value)||0),0);
  return {
    semanticClass,
    source:'retrieval-owner-authority',
    authorityBased:true,
    reuseRatio:Number(reuseRatio.toFixed(4)),
    previousRefCount:total,
    preservedRefs,
    dirtyRefs,
    preserveDomains:[...new Set(preserveDomains)],
    dirtyDomains:[...new Set(dirtyDomains)],
    reuseRegions,
    fullRegionalRequired:locationDirty||timeDirty||escalateFullRefresh,
    // Falling below the configured reuse floor means the optimization has
    // lost enough authority that Retrieval must re-review the whole candidate
    // surface. Keep preservedRefs for diagnostics, but do not bypass review.
    preserveAuthorizedRefs:preservedRefs.length>0&&!escalateFullRefresh,
    estimatedDirtyUnits:dirtyRefs.length,
    estimatedWorkUnits,
    workloadUnits,
    minimumReuseRatio:threshold,
    escalateFullRefresh,
  };
}
