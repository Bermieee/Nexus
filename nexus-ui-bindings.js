const clone=value=>{
  if(value==null)return value;
  try{return structuredClone(value);}catch{}
  try{return JSON.parse(JSON.stringify(value));}catch{return null;}
};

const count=value=>Math.max(0,Number(value)||0);

function lifecycleRow({id,label,layer='HOT',state='PARKED',reason='',metadata={}}={}){
  return Object.freeze({
    id:String(id||'runtime'),
    label:String(label||id||'Runtime'),
    layer:String(layer||'HOT').toUpperCase(),
    executionStatus:String(state||'PARKED').toUpperCase(),
    reason:String(reason||''),
    metadata:clone(metadata)??{},
  });
}

export function projectNexusRuntimeStatus({settings={},queue={},runtime={},mainBridge={}}={}){
  const sidecars=settings?.sidecars??{};
  const queueLanes=queue?.lanes??{};
  const coordinator=runtime?.coordinator??{};
  const batch=runtime?.batch??{};
  const executionProfile=runtime?.executionProfile??{};
  const activeRuns=Array.isArray(coordinator?.active)?coordinator.active:[];
  const rows=[];

  const mainActive=mainBridge?.active===true;
  const mainConnected=mainBridge?.connected===true;
  rows.push(lifecycleRow({
    id:'main',
    label:'Main',
    layer:'HOT',
    state:mainActive?'ACTIVE':mainConnected?'PARKED':'PARKED',
    reason:mainActive?'SillyTavern Main is physically active.':mainConnected?'Main bridge is connected.':'Main bridge is not connected.',
    metadata:{
      connected:mainConnected,
      requested:mainBridge?.requested===true,
      fullyConnected:mainBridge?.fullyConnected===true,
      generationGatewayConnected:mainBridge?.generationGatewayConnected===true,
      lifecycleBridgeConnected:mainBridge?.lifecycleBridgeConnected===true,
    },
  }));

  for(const slot of ['A','B']){
    const lane=queueLanes?.[slot]??{};
    const enabled=sidecars?.[slot]?.enabled===true;
    const running=Array.isArray(lane.running)?lane.running.length:0;
    const queued=Array.isArray(lane.queued)?lane.queued.length:0;
    rows.push(lifecycleRow({
      id:`sidecar-${slot.toLowerCase()}`,
      label:`Sidecar ${slot}`,
      layer:'HOT',
      state:running?'ACTIVE':queued?'YIELDING':'PARKED',
      reason:running?`${running} job(s) running.`:queued?`${queued} job(s) queued.`:enabled?'Enabled and idle.':'Disabled.',
      metadata:{slot,enabled,running,queued,activeJobId:lane.activeJobId??null},
    }));
  }

  rows.push(lifecycleRow({
    id:'work-coordinator',
    label:'Work Coordinator',
    layer:'DEEP',
    state:activeRuns.length?'ACTIVE':'PARKED',
    reason:activeRuns.length?`${activeRuns.length} work plan(s) active.`:'No work plan is active.',
    metadata:{activeRuns:activeRuns.length,lastRunPresent:Boolean(coordinator?.last)},
  }));

  const batchActive=count(batch?.activeUnits);
  const batchQueued=count(batch?.queuedUnits);
  rows.push(lifecycleRow({
    id:'batch-layer',
    label:'Batch Layer',
    layer:'DEEP',
    state:batchActive?'ACTIVE':batchQueued?'YIELDING':'PARKED',
    reason:batchActive?`${batchActive} unit(s) active.`:batchQueued?`${batchQueued} unit(s) queued.`:'No batch work is active.',
    metadata:{enabled:batch?.enabled===true,activeUnits:batchActive,queuedUnits:batchQueued,totalOutstandingUnits:count(batch?.totalOutstandingUnits)},
  }));

  const queuedJobs=Array.isArray(queue?.queued)?queue.queued.length:0;
  const runningJobs=Array.isArray(queue?.running)?queue.running.length:0;
  return Object.freeze({
    kind:'NexusRuntimeStatus',
    contractVersion:'1.0.0',
    lifecycle:Object.freeze(rows),
    queueDepth:Object.freeze({
      jobs:queuedJobs,
      running:runningJobs,
      sidecarA:Array.isArray(queueLanes?.A?.queued)?queueLanes.A.queued.length:0,
      sidecarB:Array.isArray(queueLanes?.B?.queued)?queueLanes.B.queued.length:0,
      batch:batchQueued,
    }),
    resources:Object.freeze({
      main:Object.freeze({connected:mainConnected,allowed:executionProfile?.mainAllowed===true||mainBridge?.boundaryAllowed===true}),
      sidecarA:Object.freeze({enabled:sidecars?.A?.enabled===true}),
      sidecarB:Object.freeze({enabled:sidecars?.B?.enabled===true}),
    }),
    workers:Object.freeze({
      coordinatorActiveRuns:activeRuns.length,
      queuedJobs,
      runningJobs,
      batchActiveUnits:batchActive,
    }),
    dependencies:Object.freeze({worldTree:'TRANSITION_PENDING'}),
    telemetry:Object.freeze({
      producer:'NexusRuntime',
      rawPromptIncluded:false,
      rawPayloadIncluded:false,
      pausedForForeground:queue?.pausedForForeground===true,
      activeGenerationId:queue?.activeGenerationId??null,
    }),
    eventTypes:Object.freeze(['NEXUS_RUNTIME_STATUS']),
  });
}

export function createNexusUiHostBindings({
  readSettings=()=>({}),
  readQueueHealth=()=>({}),
  readRuntimeDiagnostic=()=>({}),
  readMainBridge=()=>({}),
}={}){
  const readRuntimeStatus=()=>projectNexusRuntimeStatus({
    settings:readSettings?.()??{},
    queue:readQueueHealth?.()??{},
    runtime:readRuntimeDiagnostic?.()??{},
    mainBridge:readMainBridge?.()??{},
  });
  return Object.freeze({
    readRuntimeStatus,
    readNativeBrainHostLifecycle:()=>Object.freeze({
      kind:'NexusHostLifecycle',
      mainBridge:clone(readMainBridge?.()??{}),
      rawPromptIncluded:false,
      rawPayloadIncluded:false,
    }),
  });
}
