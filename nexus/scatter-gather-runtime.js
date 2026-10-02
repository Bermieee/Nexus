import { SchedulerGather } from '../scheduler/gather.js';
import { sidecarScheduler } from '../scheduler/sidecars.js';
import { NEXUS_JOB_KIND, NEXUS_JOB_ROUTE, NEXUS_JOB_STATE } from './contracts.js';
import { logSystemEvent as logEvent } from '../observability/system-events.js';
import {
  GatherCoordinator,
  ResultClass,
  ScatterLayer,
  createForegroundQuorumPlan,
  evaluateForegroundQuorum,
  evaluateScatterAdmission,
  partitionScatterTasks,
} from './a52/scatter-gather.js';

const TERMINAL=new Set([
  NEXUS_JOB_STATE.SUCCEEDED,
  NEXUS_JOB_STATE.FAILED,
  NEXUS_JOB_STATE.BLOCKED,
  NEXUS_JOB_STATE.CANCELLED,
  NEXUS_JOB_STATE.SKIPPED,
]);
const TASK_ORDER=['foreground-bootstrap','foreground-retrieval','foreground-memory'];
let lastDiagnostics=null;

function taskDefinitions({startedAt,deadlineMs}={}){
  const hard=startedAt+Math.max(1000,Number(deadlineMs)||60000);
  const soft=startedAt+Math.max(250,Math.floor((hard-startedAt)*0.8));
  return [
    Object.freeze({
      taskId:'foreground-bootstrap',
      taskType:'EXACT_LOOKUP',
      name:'Foreground bootstrap admission',
      resultClass:ResultClass.REQUIRED,
      compilerLane:'loreEvidence',
      softDeadline:soft,
      hardDeadline:hard,
      fallbackPolicy:Object.freeze({type:'EMPTY_BOOTSTRAP'}),
      priority:108,
      fallbackValue:Object.freeze({skipped:true,reason:'scatter-gather-bounded-fallback',refs:[]}),
    }),
    Object.freeze({
      taskId:'foreground-retrieval',
      taskType:'HISTORIAN_RETRIEVAL',
      name:'Foreground retrieval',
      resultClass:ResultClass.REQUIRED,
      compilerLane:'loreEvidence',
      softDeadline:soft,
      hardDeadline:hard,
      fallbackPolicy:Object.freeze({type:'EMPTY_RETRIEVAL'}),
      priority:110,
      fallbackValue:Object.freeze({skipped:true,reason:'scatter-gather-bounded-fallback'}),
    }),
    Object.freeze({
      taskId:'foreground-memory',
      taskType:'EPISODIC_RETRIEVAL',
      name:'Foreground Summary Bank recall',
      resultClass:ResultClass.REQUIRED,
      compilerLane:'episodicEvidence',
      softDeadline:soft,
      hardDeadline:hard,
      fallbackPolicy:Object.freeze({type:'EMPTY_MEMORY_RECALL'}),
      priority:106,
      fallbackValue:Object.freeze({skipped:true,reason:'scatter-gather-bounded-fallback'}),
    }),
  ];
}
function layerRows(partitions=[]){
  return partitions.map(row=>({
    layer:row.layer,
    taskIds:row.tasks.map(task=>task.taskId),
    count:row.tasks.length,
  }));
}
function errorFromJob(job,task){
  const error=new Error(job?.error||('Foreground Scatter/Gather task failed: '+task.taskId));
  error.name=job?.state===NEXUS_JOB_STATE.CANCELLED?'TV2ForegroundScatterGatherCancelled':'TV2ForegroundScatterGatherTaskFailed';
  error.taskId=task.taskId;
  error.jobState=job?.state??null;
  return error;
}
function progressSnapshot({generationId,plan,snapshot,layers,admissions}={}){
  const jobs=snapshot?.jobs??[];
  const rows=TASK_ORDER.map(taskId=>{
    const job=jobs.find(row=>row.type===taskId);
    return{taskId,state:job?.state??'queued'};
  });
  return{
    generationId:String(generationId??''),
    planId:plan?.id??null,
    completedUnits:rows.filter(row=>TERMINAL.has(row.state)).length,
    totalUnits:rows.length,
    tasks:rows,
    layers,
    admissions,
  };
}

export async function runNexusForegroundScatterGather({
  generationId,
  chatId=null,
  executors={},
  runtime,
  isFresh=()=>true,
  scope=null,
  isScopeFresh=isFresh,
  takeLateProposal=()=>null,
  captureResultScope=()=>scope,
  admitLate=null,
  onProgress=null,
  deadlineMs=60000,
}={}){
  if(!generationId)throw new TypeError('runNexusForegroundScatterGather requires generationId');
  if(!runtime?.director?.buildRequestedPlan||!runtime?.coordinator?.run)throw new Error('Nexus Work Director/Coordinator runtime is required');
  const startedAt=Date.now();
  const tasks=taskDefinitions({startedAt,deadlineMs});
  const partitions=partitionScatterTasks(tasks);
  const layers=layerRows(partitions);
  const admissions=tasks.map(task=>({taskId:task.taskId,...evaluateScatterAdmission(task,{now:startedAt,minFreshWindowMs:12})}));
  const admitted=tasks.filter(task=>admissions.find(row=>row.taskId===task.taskId)?.decision==='ADMIT');
  const decisions=admissions.map(row=>({
    action:row.decision==='ADMIT'?'run':row.decision.toLowerCase(),
    job:row.taskId,
    route:NEXUS_JOB_ROUTE.LOCAL,
    reason:row.reason,
    scatterLayer:row.layer,
  }));
  const jobs=admitted.map(task=>({
    id:task.taskId,
    type:task.taskId,
    name:task.name,
    kind:NEXUS_JOB_KIND.INSPECT,
    route:NEXUS_JOB_ROUTE.LOCAL,
    priority:task.priority,
    transactionRequired:false,
    dependencies:[],
    metadata:{
      scatterGather:true,
      scatterLayer:admissions.find(row=>row.taskId===task.taskId)?.layer??ScatterLayer.SIGNAL,
      resultClass:task.resultClass,
      compilerLane:task.compilerLane,
      generationId:String(generationId),
      ownerExecution:true,
    },
  }));
  const plan=runtime.director.buildRequestedPlan({
    source:'a52-scatter-gather-foreground',
    eventId:'scatter-gather:'+String(generationId),
    classification:{subsystem:'foreground-context',generationId:String(generationId),requiredTasks:tasks.length},
    decisions,
    jobs,
    metadata:{scatterGather:true,generationId:String(generationId),layers},
  });
  const quorumPlan=createForegroundQuorumPlan(tasks,{deadline:Math.max(...tasks.map(task=>task.hardDeadline))});
  const gather=new SchedulerGather(tasks.map(task=>({id:task.taskId,accept:packet=>packet?.ownerResult?.failed!==true&&(packet?.ownerResult?.stale!==true||!!packet?.proposal)})),{
    scope:scope??{generationId:String(generationId)},deadline:quorumPlan.deadline,isFresh:isScopeFresh,
    coordinatorClass:GatherCoordinator,tasks,late:sidecarScheduler.lateResults,envelope:{turnId:String(generationId),correlationId:String(generationId),eventId:'foreground:'+String(generationId)},
    emit:(name,data)=>logEvent('nexus.gather',name,{generationId:String(generationId),...data},'debug'),
  });
  const coordinatorExecutors={};
  for(const task of admitted){
    const execute=executors[task.taskId];
    coordinatorExecutors[task.taskId]=async()=>{
      if(typeof execute!=='function')throw new Error('No foreground owner executor registered for '+task.taskId);
      const ownerResult=await execute(Object.freeze({taskId:task.taskId,planId:plan.id,generationId:String(generationId),chatId:chatId==null?null:String(chatId)}));
      const proposal=takeLateProposal(task.taskId,generationId);
      await gather.accept(task.taskId,{ownerResult,proposal,sourceScope:captureResultScope()});
      return{ownerResult};
    };
  }
  logEvent('nexus.scatter','foreground-plan',{
    generationId:String(generationId),chatId:chatId==null?null:String(chatId),
    planId:plan.id,
    layers,
    admissions,
    quorum:{requiredTaskIds:quorumPlan.requiredTaskIds,minimumForegroundCompletion:quorumPlan.minimumForegroundCompletion,deadline:quorumPlan.deadline},
    executionOwner:'NEXUS_WORK_COORDINATOR',
    sealAuthority:false,
  },'info');

  let latestSnapshot={jobs:[]};
  const coordinatorWork=runtime.coordinator.run(plan,{
    executors:coordinatorExecutors,
    isFresh,
    onChange:(job,snap)=>{
      latestSnapshot=snap;
      const progress=progressSnapshot({generationId,plan,snapshot:snap,layers,admissions});
      try{onProgress?.(progress);}catch{}
      logEvent('nexus.scatter','foreground-progress',{
        generationId:String(generationId),chatId:chatId==null?null:String(chatId),planId:plan.id,
        taskId:job?.type??null,state:job?.state??null,
        completedUnits:progress.completedUnits,totalUnits:progress.totalUnits,
      },'debug');
    },
  });
  // Reuse the Director/Coordinator execution, but never wait beyond the
  // existing foreground deadline to return the gather to the frame sealer.
  let deadlineTimer;
  const expired=new Promise(resolve=>{deadlineTimer=setTimeout(()=>{
    gather.close({at:Date.now(),reason:'HARD_DEADLINE'});resolve(latestSnapshot);
  },Math.max(0,quorumPlan.deadline-Date.now()));});
  let snapshot;
  try{snapshot=await Promise.race([coordinatorWork,expired]);}finally{clearTimeout(deadlineTimer);}
  latestSnapshot=snapshot;

  const settled=[];
  const completedTaskIds=[];
  const fallbackTaskIds=[];
  for(const task of tasks){
    const admission=admissions.find(row=>row.taskId===task.taskId);
    const job=snapshot.jobs?.find(row=>row.type===task.taskId)??null;
    if(admission?.decision!=='ADMIT'||!gather.has(task.taskId)){
      const reason=job?errorFromJob(job,task):new Error('Foreground Scatter/Gather task was not admitted: '+task.taskId);
      const held=gather.peekLate(task.taskId);let carried=false;
      try{carried=!!held&&gather.fresh()&&admitLate?.(task.taskId,held)===true;}catch{}
      const carriedResult=held?.ownerResult??held;
      if(carried){gather.takeLate(task.taskId);settled.push({status:'fulfilled',value:carriedResult});}
      else settled.push({status:'rejected',reason});
      const fallback={
        resultId:'fallback:'+String(generationId)+':'+task.taskId,
        taskId:task.taskId,
        payload:carried?carriedResult:task.fallbackValue,
        freshnessIdentity:{},
        completedAt:Date.now(),
      };
      gather.addFallback(task.taskId,fallback);
      fallbackTaskIds.push(task.taskId);
      continue;
    }
    const value=gather.owner.accepted.get(task.taskId)?.payload?.ownerResult;
    settled.push({status:'fulfilled',value});completedTaskIds.push(task.taskId);
  }
  const quorum=evaluateForegroundQuorum(quorumPlan,{completedTaskIds,fallbackTaskIds,now:Date.now()});
  const bundle=gather.close({at:Date.now(),reason:quorum.satisfied?'FOREGROUND_QUORUM':quorum.closeReason});
  const diagnostics={
    kind:'NexusForegroundScatterGatherDiagnostics',
    generationId:String(generationId),
    chatId:chatId==null?null:String(chatId),
    planId:plan.id,
    layers,
    admissions,
    coordinator:{
      succeeded:snapshot.succeeded,
      failed:snapshot.failed,
      blocked:snapshot.blocked,
      skipped:snapshot.skipped,
      cancelled:snapshot.cancelled,
      jobs:(snapshot.jobs??[]).map(job=>({id:job.id,type:job.type,state:job.state,error:job.error??null})),
    },
    quorum,
    gather:{
      closeReason:bundle.closeReason,
      acceptedResultIds:bundle.acceptedResultIds,
      candidateAttribution:[...gather.owner.accepted.values()].map(result=>({resultId:result.resultId,candidateIds:(result.payload?.ownerResult?.candidateIds??[]).slice(0,96).map(String)})).filter(row=>row.candidateIds.length),
      fallbacksUsed:bundle.fallbacksUsed,
      missingRequired:bundle.missingRequired,
      lateResults:bundle.lateResults,
      lanes:{
        loreEvidence:bundle.loreEvidence.length,
        episodicEvidence:bundle.episodicEvidence.length,
      },
    },
    sealAuthority:false,
    settlementAuthority:false,
    schedulerAuthority:'NEXUS_WORK_DIRECTOR_COORDINATOR',
    elapsedMs:Math.max(0,Date.now()-startedAt),
  };
  lastDiagnostics=structuredClone(diagnostics);
  logEvent('nexus.gather','foreground-complete',diagnostics,quorum.satisfied?'info':'warn');
  try{onProgress?.(progressSnapshot({generationId,plan,snapshot:latestSnapshot,layers,admissions}));}catch{}
  return{settled,bundle,quorum,plan,snapshot,diagnostics};
}

export function nexusForegroundScatterGatherDiagnostics(){
  return lastDiagnostics?structuredClone(lastDiagnostics):null;
}
