export const ResultClass=Object.freeze({REQUIRED:'REQUIRED',OPPORTUNISTIC:'OPPORTUNISTIC',DEFERRED:'DEFERRED'});
export const ResultDestination=Object.freeze({
  FOREGROUND:'FOREGROUND',
  NEXT_TURN:'NEXT_TURN',
  WARM_CACHE:'WARM_CACHE',
  NEARLINE:'NEARLINE',
  BACKGROUND:'BACKGROUND',
  DIAGNOSTIC_ONLY:'DIAGNOSTIC_ONLY',
  DROP:'DROP',
  EVALUATION:'EVALUATION',
});
export const ScatterLayer=Object.freeze({SIGNAL:'SIGNAL',EXPANSION:'EXPANSION',PRECISION:'PRECISION',BACKGROUND:'BACKGROUND'});
export const SCATTER_LAYER_ORDER=Object.freeze([ScatterLayer.SIGNAL,ScatterLayer.EXPANSION,ScatterLayer.PRECISION,ScatterLayer.BACKGROUND]);

const SIGNAL_TASKS=new Set(['NATIVE_BOUNDED_TURN','CHANGE_CLASSIFICATION','SCENE_CLASSIFICATION','EXACT_LOOKUP','HOT_STATE_LOOKUP']);
const EXPANSION_TASKS=new Set(['HISTORIAN_RETRIEVAL','GRAPH_WALK','GREEN_ROOM','DENSE_RETRIEVAL','EPISODIC_RETRIEVAL']);
const PRECISION_TASKS=new Set(['TRUTH_PRECISION','PRECISION_RERANK','CROSS_ENCODER_RERANK','CONFLICT_INTERPRETATION']);
const LANES=Object.freeze(['loreEvidence','episodicEvidence','worldState','graphResults','greenRoom','truthClassifications','precisionResults','externalGrounding']);

export function createForegroundQuorumPlan(tasks,{minimumForegroundCompletion=null,deadline=null}={}){
  const list=[...(tasks??[])];
  const required=list.filter(task=>task.resultClass===ResultClass.REQUIRED);
  const opportunistic=list.filter(task=>task.resultClass===ResultClass.OPPORTUNISTIC);
  const deferred=list.filter(task=>task.resultClass===ResultClass.DEFERRED);
  const minimum=Math.max(0,Math.min(required.length,Number(minimumForegroundCompletion??required.length)||0));
  const hard=deadline==null?(required.length?Math.max(...required.map(task=>Number(task.hardDeadline??0))):0):Number(deadline);
  return Object.freeze({
    kind:'ForegroundQuorumPlan',
    requiredTaskIds:Object.freeze(required.map(task=>task.taskId)),
    minimumForegroundCompletion:minimum,
    deadline:hard,
    fallbackReadiness:Object.freeze(Object.fromEntries(required.map(task=>[task.taskId,Boolean(task.fallbackPolicy?.type)]))),
    optionalTaskIds:Object.freeze(opportunistic.map(task=>task.taskId)),
    deferredTaskIds:Object.freeze(deferred.map(task=>task.taskId)),
    schedulingDecision:null,
    executionAuthority:false,
  });
}

export function evaluateForegroundQuorum(plan,{completedTaskIds=[],fallbackTaskIds=[],now=0}={}){
  const satisfied=new Set([...completedTaskIds,...fallbackTaskIds]);
  const requiredSatisfied=plan.requiredTaskIds.filter(id=>satisfied.has(id));
  const missing=plan.requiredTaskIds.filter(id=>!satisfied.has(id));
  const expired=Number(now)>Number(plan.deadline);
  return Object.freeze({
    satisfied:requiredSatisfied.length>=plan.minimumForegroundCompletion,
    expired,
    requiredSatisfied:Object.freeze(requiredSatisfied),
    missingRequired:Object.freeze(missing),
    closeReason:requiredSatisfied.length>=plan.minimumForegroundCompletion?'FOREGROUND_QUORUM':expired?'HARD_DEADLINE':'WAITING_REQUIRED',
    runtimeTimerAuthority:false,
  });
}

export function lateResultDestination(task,{cancelled=false,superseded=false,stale=false,failed=false,warmReusable=false,nearlineEligible=false}={}){
  if(cancelled||superseded||stale) return ResultDestination.DROP;
  if(failed) return ResultDestination.DIAGNOSTIC_ONLY;
  if(task.resultClass===ResultClass.DEFERRED) return nearlineEligible?ResultDestination.NEARLINE:ResultDestination.BACKGROUND;
  if(warmReusable) return ResultDestination.WARM_CACHE;
  if(task.resultClass===ResultClass.OPPORTUNISTIC) return ResultDestination.NEXT_TURN;
  return ResultDestination.DIAGNOSTIC_ONLY;
}

export function hardDeadlineDisposition(task){
  if(task.resultClass===ResultClass.REQUIRED) return Object.freeze({action:'BOUNDED_FALLBACK',blocksSeal:false});
  if(task.resultClass===ResultClass.OPPORTUNISTIC) return Object.freeze({action:'CONTINUE_AND_ROUTE_LATE',blocksSeal:false});
  return Object.freeze({action:'BACKGROUND_ACCOUNTING',blocksSeal:false});
}

export function classifyScatterLayer(task={}){
  if(task.placement==='DEEP'||task.resultClass===ResultClass.DEFERRED) return ScatterLayer.BACKGROUND;
  const declared=String(task.metadata?.scatterLayer??'').toUpperCase();
  if(Object.values(ScatterLayer).includes(declared)) return declared;
  const type=String(task.taskType??'').toUpperCase();
  const role=String(task.metadata?.roleId??'').toLowerCase();
  if(PRECISION_TASKS.has(type)||role.includes('truth')||role.includes('precision')) return ScatterLayer.PRECISION;
  if(EXPANSION_TASKS.has(type)||role.includes('graph')||role.includes('historian')||role.includes('green-room')||role.includes('dense')||role.includes('episodic')) return ScatterLayer.EXPANSION;
  if(SIGNAL_TASKS.has(type)||task.cognitiveLayer==='L0') return ScatterLayer.SIGNAL;
  return ScatterLayer.SIGNAL;
}

export function partitionScatterTasks(tasks=[]){
  const buckets=new Map(SCATTER_LAYER_ORDER.map(layer=>[layer,[]]));
  for(const task of tasks) buckets.get(classifyScatterLayer(task)).push(task);
  return Object.freeze(SCATTER_LAYER_ORDER.map(layer=>Object.freeze({layer,tasks:Object.freeze([...buckets.get(layer)])})));
}

export function evaluateScatterAdmission(task,{now=Date.now(),minFreshWindowMs=12}={}){
  const layer=classifyScatterLayer(task);
  if(layer===ScatterLayer.BACKGROUND) return freeze({decision:'DEFER',layer,reason:'BACKGROUND_OUTSIDE_FOREGROUND_DEADLINE'});
  const remaining=Math.max(0,Number(task.hardDeadline??now)-Number(now));
  const pastSoft=Number.isFinite(Number(task.softDeadline))&&Number(now)>=Number(task.softDeadline);
  if(task.resultClass===ResultClass.OPPORTUNISTIC&&(pastSoft||remaining<=Math.max(0,Number(minFreshWindowMs)||0))){
    return freeze({decision:'SKIP',layer,reason:pastSoft?'OPPORTUNISTIC_SOFT_DEADLINE':'OPPORTUNISTIC_FRESHNESS_GUARD',remainingMs:remaining});
  }
  const reason=layer===ScatterLayer.SIGNAL?'EARLY_SIGNAL':layer===ScatterLayer.EXPANSION?'PRECEDING_SIGNAL_NOMINATED':'UNRESOLVED_HIGH_VALUE_NOMINATION';
  return freeze({decision:'ADMIT',layer,reason,remainingMs:remaining});
}

export function boundedLayerConcurrency(value=2){
  const n=Number(value);
  if(!Number.isInteger(n)||n<1) return 2;
  return Math.min(8,n);
}

export async function yieldScatterHost(){
  const scheduler=globalThis.scheduler;
  if(typeof scheduler?.yield==='function'){await scheduler.yield();return;}
  if(typeof scheduler?.postTask==='function'){await scheduler.postTask(()=>{},{priority:'user-visible'});return;}
  await new Promise(resolve=>setTimeout(resolve,0));
}

export function isFreshResult(result,currentRevisionSet={}){
  const freshness=result?.freshnessIdentity??result?.revisionSet??{};
  if(freshness.sceneRevision!=null&&currentRevisionSet.sceneRevision!=null&&Number(freshness.sceneRevision)!==Number(currentRevisionSet.sceneRevision)) return false;
  if(freshness.worldRevision!=null&&currentRevisionSet.worldRevision!=null&&Number(freshness.worldRevision)!==Number(currentRevisionSet.worldRevision)) return false;
  const currentSources=currentRevisionSet.sourceRevisionSet?new Set(currentRevisionSet.sourceRevisionSet.map(String)):null;
  if(currentSources&&(freshness.sourceRevisionSet??freshness.sourceRevisionRefs??[]).some(ref=>!currentSources.has(String(ref)))) return false;
  return true;
}

export class GatherCoordinator{
  constructor({turnEvent,plan,currentRevisionSet=turnEvent,validateResult=null}={}){
    if(!turnEvent||!plan) throw new TypeError('GatherCoordinator requires turnEvent and plan');
    this.turnEvent=turnEvent;
    this.plan=plan;
    this.currentRevisionSet=currentRevisionSet;
    this.validateResult=validateResult;
    this.tasks=new Map((plan.tasks??[]).map(task=>[task.taskId,task]));
    this.accepted=new Map();
    this.seenResultIds=new Set();
    this.rejected=[];
    this.stale=[];
    this.failures=[];
    this.fallbacks=[];
    this.late=[];
    this.closed=false;
    this.sealed=false;
    this.closedAt=null;
    this.closeReason=null;
    this.sealReceipt=null;
  }

  async accept(rawResult,{arrivalAt=rawResult?.completedAt??0}={}){
    const resultId=rawResult?.resultId;
    if(resultId&&this.seenResultIds.has(resultId)) return {accepted:false,duplicate:true,destination:ResultDestination.EVALUATION};
    if(resultId) this.seenResultIds.add(resultId);
    const task=this.tasks.get(rawResult?.taskId);
    if(!task){
      this.rejected.push({resultId:resultId??null,reason:'unknown-task'});
      return {accepted:false,destination:ResultDestination.EVALUATION,reason:'unknown-task'};
    }
    if(typeof this.validateResult==='function'){
      const verdict=await this.validateResult(rawResult,task,this.currentRevisionSet);
      if(verdict===false||verdict?.valid===false){
        this.failures.push(verdict?.failure??{taskId:task.taskId,code:'INVALID'});
        return {accepted:false,destination:ResultDestination.EVALUATION,validation:verdict};
      }
    }
    if(!isFreshResult(rawResult,this.currentRevisionSet)){
      this.stale.push(resultId??task.taskId);
      return {accepted:false,stale:true,destination:ResultDestination.EVALUATION};
    }
    if(this.accepted.has(task.taskId)) return {accepted:false,duplicateTask:true,destination:ResultDestination.EVALUATION};
    if(this.closed||this.sealed||task.resultClass===ResultClass.DEFERRED){
      const destination=task.resultClass===ResultClass.DEFERRED?ResultDestination.BACKGROUND:ResultDestination.NEXT_TURN;
      this.late.push({resultId:resultId??null,taskId:task.taskId,destination,arrivalAt});
      return {accepted:false,late:true,destination};
    }
    this.accepted.set(task.taskId,structuredClone(rawResult));
    return {accepted:true,destination:ResultDestination.FOREGROUND};
  }

  addFallback(taskId,result){
    const task=this.tasks.get(taskId);
    if(!task) throw new Error('Unknown task: '+taskId);
    this.accepted.set(taskId,result);
    this.fallbacks.push({taskId,resultId:result?.resultId??null,policy:task.fallbackPolicy?.type??null});
    return result;
  }

  requiredTasks(){return [...this.tasks.values()].filter(task=>task.resultClass===ResultClass.REQUIRED);}
  missingRequired(){return this.requiredTasks().filter(task=>!this.accepted.has(task.taskId));}
  quorumSatisfied(){return this.missingRequired().length===0;}

  close({at,reason=this.quorumSatisfied()?'FOREGROUND_QUORUM':'HARD_DEADLINE'}={}){
    if(this.closed) return this.bundle();
    this.closed=true;
    this.closedAt=Number(at??0);
    this.closeReason=reason;
    return this.bundle();
  }

  markSealed(receipt){this.sealed=true;this.sealReceipt=receipt??null;}

  bundle(){
    const lanes=Object.fromEntries(LANES.map(lane=>[lane,[]]));
    for(const [taskId,result] of this.accepted){
      const task=this.tasks.get(taskId);
      const lane=LANES.includes(task.compilerLane)?task.compilerLane:'externalGrounding';
      lanes[lane].push(structuredClone(result.payload??result));
    }
    return structuredClone({
      kind:'GatherBundle',
      turnIdentity:{turnId:this.turnEvent.turnId,correlationId:this.turnEvent.correlationId,eventId:this.turnEvent.eventId},
      ...lanes,
      missingRequired:this.missingRequired().map(task=>task.taskId),
      fallbacksUsed:this.fallbacks,
      lateResults:this.late,
      acceptedResultIds:[...this.accepted.values()].map(result=>result.resultId).filter(Boolean).sort(),
      rejectedResultIds:this.rejected.map(item=>item.resultId).filter(Boolean).sort(),
      staleResultIds:[...this.stale].sort(),
      closeReason:this.closeReason,
      closedAt:this.closedAt,
      sealed:this.sealed,
    });
  }
}

export function normalizeProviderList(values=[]){
  return Object.freeze((values??[]).filter(Boolean).map((value,index)=>{
    if(typeof value==='string') return Object.freeze({id:value,priority:index});
    return Object.freeze({id:String(value.id??value.name??'provider-'+index),priority:Number(value.priority??index),...value});
  }));
}

function freeze(value){
  if(!value||typeof value!=='object'||Object.isFrozen(value)) return value;
  Object.freeze(value);
  for(const child of Object.values(value)) freeze(child);
  return value;
}
