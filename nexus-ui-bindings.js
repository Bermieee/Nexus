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



export function projectNexusCharacters(snapshot={}){
  const rows=Array.isArray(snapshot?.rows)?snapshot.rows:[];
  const currentIndex=Number.isInteger(Number(snapshot?.currentIndex))?Number(snapshot.currentIndex):null;
  const characters=rows.map((row,index)=>{
    const id=String(row?.avatar||row?.name||row?.id||'character-'+index);
    return Object.freeze({
      id,
      name:String(row?.name||id),
      avatar:row?.avatar==null?null:String(row.avatar),
      active:currentIndex!=null&&Number(row?.index??index)===currentIndex,
      tags:Object.freeze(Array.isArray(row?.tags)?row.tags.map(String):[]),
      characterVersion:row?.characterVersion==null?null:String(row.characterVersion),
      fingerprint:row?.fingerprint==null?null:String(row.fingerprint),
    });
  });
  const active=characters.find(row=>row.active)??null;
  return Object.freeze({
    kind:'NexusCharacterCards',
    source:'SillyTavernCharacterCards',
    installedCount:characters.length,
    activeCharacterId:active?.id??null,
    activeCharacterName:active?.name??null,
    characters:Object.freeze(characters),
    rawCharacterTextIncluded:false,
    mutationAuthority:false,
  });
}

function sceneChanged(delta={}){
  return ['participants','location','activity','objective','focus','timeContext','references']
    .some(key=>delta?.[key]?.changed===true);
}

export function projectNexusSceneUiReadModel(snapshot=null){
  if(!snapshot||typeof snapshot!=='object')return null;
  if(snapshot.kind==='NexusSceneIntelligenceView'){
    const participants=Array.isArray(snapshot.participants)?snapshot.participants.map(String).filter(Boolean):[];
    const objects=Array.isArray(snapshot.objects)?snapshot.objects.map(String).filter(Boolean):[];
    const threads=[...new Set([
      ...(Array.isArray(snapshot.threads)?snapshot.threads.map(String):[]),
      ...(Array.isArray(snapshot.objectives)?snapshot.objectives.map(String):[]),
      String(snapshot.focus??'').trim(),
    ].filter(Boolean))];
    const uncertain=Array.isArray(snapshot.unresolvedFields)?snapshot.unresolvedFields.map(String):[];
    return Object.freeze({
      kind:'SceneUiReadModel',
      contractVersion:'1.0.0',
      chatId:snapshot.chatId==null?null:String(snapshot.chatId),
      sceneId:snapshot.sceneId??('nexus-scene:'+String(snapshot.chatId??'current')),
      revision:'nexus-scene:'+String(snapshot.revision??'pending'),
      lifecycle:String(snapshot.lifecycle??'ACTIVE'),
      health:Object.freeze({
        state:uncertain.length?'DEGRADED':'READY',
        reasons:Object.freeze(uncertain.length?['Scene Intelligence has unresolved fields: '+uncertain.join(', ')]:[]),
      }),
      location:String(snapshot.location??'').trim()||null,
      narrativeTime:String(snapshot.narrativeTime??'').trim()||null,
      activeCast:Object.freeze(participants),
      objects:Object.freeze(objects),
      activeThreads:Object.freeze(threads),
      atmosphere:Object.freeze({
        activity:snapshot.activity??null,
        focus:snapshot.focus??null,
        relationshipFocus:snapshot.relationshipFocus===true,
      }),
      boundaryState:clone(snapshot.boundaryState)??Object.freeze({state:'STABLE',confidence:null,supportingSignals:Object.freeze([]),contradictoryEvidence:Object.freeze([])}),
      relationshipToPrior:null,
      latestEpisodeRef:null,
      latestDeltaSummary:clone(snapshot.lastObservation??null),
      prefetchState:Object.freeze({active:Object.freeze([]),count:0}),
      uncertainFields:Object.freeze(uncertain),
      provenanceRefs:Object.freeze(Array.isArray(snapshot.sourceRevisionRefs)?snapshot.sourceRevisionRefs.map(String):[]),
      diagnosticRefs:Object.freeze({
        producer:'NexusSceneIntelligence',
        source:'nexus-scene-intelligence',
        degraded:uncertain.length>0,
        baselinePending:false,
        reasoning:'',
        updatedAt:null,
        activity:String(snapshot.activity??''),
      }),
    });
  }
  const accepted=snapshot.acceptedScene&&typeof snapshot.acceptedScene==='object'?snapshot.acceptedScene:{};
  const participants=Array.isArray(accepted.participants)?accepted.participants.map(String).map(x=>x.trim()).filter(Boolean):[];
  const activity=String(accepted.activity||'').trim();
  const objective=String(accepted.objective||'').trim();
  const focus=String(accepted.focus||'').trim();
  const activeThreads=[...new Set([objective,focus].filter(Boolean))];
  const degraded=snapshot.degraded===true;
  const baselinePending=snapshot.baselinePending===true&&!snapshot.acceptedScene;
  const changed=sceneChanged(snapshot.delta??{});
  const relation=snapshot.previousScene?(changed?'CHANGED':'STABLE'):'INITIAL';
  const rawRevision=String(snapshot.scanRevision||snapshot.primedRevision||snapshot.updatedAt||'pending');
  return Object.freeze({
    kind:'SceneUiReadModel',
    contractVersion:'1.0.0',
    chatId:snapshot.chatId==null?null:String(snapshot.chatId),
    sceneId:'nexus-scene:'+String(snapshot.chatId??'current'),
    revision:'nexus-scene:'+rawRevision,
    lifecycle:baselinePending?'OBSERVING':'ACTIVE',
    health:Object.freeze({
      state:degraded?'DEGRADED':baselinePending?'WORKING':'READY',
      reasons:Object.freeze(degraded?['Nexus Scene Scanner preserved prior accepted state after a degraded scan.']:baselinePending?['Nexus Scene Scanner is establishing the first accepted scene baseline.']:[]),
    }),
    location:String(accepted.location||'').trim()||null,
    narrativeTime:String(accepted.timeContext||'').trim()||null,
    activeCast:Object.freeze(participants),
    objects:Object.freeze([]),
    activeThreads:Object.freeze(activeThreads),
    atmosphere:null,
    boundaryState:Object.freeze({
      state:changed?'TRANSITION':'STABLE',
      confidence:degraded?0.5:baselinePending?null:1,
      supportingSignals:Object.freeze([]),
      contradictoryEvidence:Object.freeze([]),
    }),
    relationshipToPrior:relation,
    latestEpisodeRef:null,
    latestDeltaSummary:clone(snapshot.delta??null),
    prefetchState:Object.freeze({active:Object.freeze([]),count:0}),
    uncertainFields:Object.freeze(degraded?['scene']:baselinePending?['baseline']:[]),
    provenanceRefs:Object.freeze([]),
    diagnosticRefs:Object.freeze({
      producer:'NexusSceneScanner',
      source:String(snapshot.source||''),
      degraded,
      baselinePending,
      reasoning:String(snapshot.reasoning||''),
      updatedAt:Number(snapshot.updatedAt)||null,
      activity,
    }),
  });
}


function sidecarPlacementLabels(profile={}){
  return Object.entries(profile?.capabilities??{})
    .filter(([,enabled])=>enabled===true)
    .map(([name])=>String(name));
}

function sidecarHealthState(profile={}){
  if(profile?.enabled!==true)return{state:'UNAVAILABLE',health:'UNAVAILABLE',reasonCode:'SIDECAR_DISABLED',reason:'Sidecar is disabled.'};
  const endpoint=String(profile?.endpoint||'').trim(),model=String(profile?.model||'').trim();
  if(!endpoint||!model)return{state:'DEGRADED',health:'DEGRADED',reasonCode:'SIDECAR_CONFIGURATION_INCOMPLETE',reason:'Sidecar is enabled but endpoint or model configuration is incomplete.'};
  if(profile?.lastHealth?.ok===false)return{state:'DEGRADED',health:'DEGRADED',reasonCode:'SIDECAR_LAST_HEALTH_FAILED',reason:String(profile?.lastHealth?.message||profile?.lastHealth?.error||'The most recent Sidecar health check failed.')};
  return{state:'READY',health:'HEALTHY',reasonCode:'SIDECAR_CONFIGURED',reason:'Sidecar is configured for on-demand execution.'};
}

export function projectNexusResourceStatus({settings={},queue={}}={}){
  const sidecars=settings?.sidecars??{},lanes=queue?.lanes??{};
  const resources=['A','B'].map(slot=>{
    const profile=sidecars?.[slot]??{},lane=lanes?.[slot]??{};
    const health=sidecarHealthState(profile);
    const endpoint=String(profile?.endpoint||'').trim()||null;
    const modelId=String(profile?.model||'').trim()||null;
    const callable=profile?.enabled===true&&Boolean(endpoint)&&Boolean(modelId);
    const running=Array.isArray(lane?.running)?lane.running.length:0;
    const placements=sidecarPlacementLabels(profile);
    return Object.freeze({
      resourceId:'nexus-sidecar-'+slot.toLowerCase(),
      displayName:'Sidecar '+slot,
      kind:'OPENAI_COMPATIBLE',
      providerId:String(profile?.format||'provider'),
      providerProfileId:'nexus-sidecar-profile-'+slot.toLowerCase(),
      workerId:'nexus-sidecar-worker-'+slot.toLowerCase(),
      modelId,
      endpoint,
      state:health.state,
      health:health.health,
      availability:callable?'AVAILABLE':'UNAVAILABLE',
      connected:callable,
      callable,
      capabilities:Object.freeze(['STRUCTURED_EXTRACTION']),
      declaredCapabilities:Object.freeze(['STRUCTURED_EXTRACTION']),
      activeCapabilities:Object.freeze(callable?['STRUCTURED_EXTRACTION']:[]),
      qualifiedCapabilities:Object.freeze(callable?['STRUCTURED_EXTRACTION']:[]),
      routableCapabilities:Object.freeze(callable?['STRUCTURED_EXTRACTION']:[]),
      placements:Object.freeze(placements),
      currentLoad:running,
      concurrencyCapacity:1,
      credentialConfigured:Boolean(String(profile?.apiKey||'').trim()),
      credentialRequired:false,
      reasonCode:health.reasonCode,
      reason:health.reason,
      lastHealthResult:clone(profile?.lastHealth??null),
      lastHealthLatencyMs:Number(profile?.lastHealth?.latencyMs)||null,
      local:false,
    });
  });
  return Object.freeze({
    kind:'NexusResourceStatus',
    nativePathRequired:false,
    resources:Object.freeze(resources),
  });
}


const SENSITIVE_DIAGNOSTIC_KEY=/(?:api.?key|credential|secret|authorization|raw.?prompt|prompt(?:text|body)?|exact.?authored.?text|representation.?text|provider.?body|hidden.?reasoning|request.?body|response.?body)/i;

function sanitizeDiagnosticValue(value,depth=0){
  if(value==null||typeof value==='number'||typeof value==='boolean')return value;
  if(typeof value==='string')return value.length>1200?value.slice(0,1200)+'…':value;
  if(depth>=7)return'[nested diagnostic metadata omitted]';
  if(Array.isArray(value))return value.slice(-256).map(row=>sanitizeDiagnosticValue(row,depth+1));
  if(typeof value!=='object')return String(value);
  const out={};
  for(const [key,row] of Object.entries(value)){
    if(SENSITIVE_DIAGNOSTIC_KEY.test(key)){out[key]='[redacted]';continue;}
    out[key]=sanitizeDiagnosticValue(row,depth+1);
  }
  return out;
}

export function projectNexusDiagnostics({
  selection={},
  telemetry={},
  decision={},
  retrieval={},
  runtime={},
  queue={},
  mainBridge={},
  scene=null,
  resources={},
  generationFrame={},
  worldTree={},
  systems={},
}={}){
  const resourceRows=Array.isArray(resources?.resources)?resources.resources:[];
  const probes=resourceRows.map(row=>Object.freeze({
    resourceId:row.resourceId??row.id??null,
    displayName:row.displayName??null,
    state:row.state??null,
    health:row.health??null,
    callable:Boolean(row.callable),
    reasonCode:row.reasonCode??null,
    reason:row.reason??null,
    lastHealthResult:sanitizeDiagnosticValue(row.lastHealthResult??null),
    lastHealthLatencyMs:Number(row.lastHealthLatencyMs)||null,
    lastTest:sanitizeDiagnosticValue(row.lastTest??null),
  }));
  const events=(Array.isArray(telemetry?.events)?telemetry.events:[]).slice(-256).map(event=>sanitizeDiagnosticValue(event));
  return Object.freeze({
    kind:'NexusDiagnostics',
    contractVersion:'1.0.0',
    selection:sanitizeDiagnosticValue(selection),
    telemetry:Object.freeze({
      observability:sanitizeDiagnosticValue({...telemetry,events}),
      decision:sanitizeDiagnosticValue(decision),
      retrieval:sanitizeDiagnosticValue(retrieval),
      runtime:sanitizeDiagnosticValue(runtime),
      queue:sanitizeDiagnosticValue(queue),
      generationFrame:sanitizeDiagnosticValue(generationFrame),
      mainBridge:sanitizeDiagnosticValue(mainBridge),
      scene:sanitizeDiagnosticValue(scene),
      worldTree:sanitizeDiagnosticValue(worldTree),
      systems:sanitizeDiagnosticValue(systems),
    }),
    probes:Object.freeze({
      resources:Object.freeze(probes),
      mainBridge:Object.freeze({
        connected:Boolean(mainBridge?.connected),
        fullyConnected:Boolean(mainBridge?.fullyConnected),
        active:Boolean(mainBridge?.active),
        generationGatewayConnected:Boolean(mainBridge?.generationGatewayConnected),
        lifecycleBridgeConnected:Boolean(mainBridge?.lifecycleBridgeConnected),
      }),
    }),
    safety:Object.freeze({
      metadataOnly:true,
      rawPrompts:false,
      providerBodies:false,
      credentials:false,
      hiddenReasoning:false,
      storyLoreBodies:false,
    }),
  });
}


function telemetryIdentity(event={}){
  const data=event?.data??{};
  return{
    chatId:data.chatId??data.chatNamespace??null,
    generationId:data.generationId??null,
    turnId:data.turnId??data.turnSequence??null,
  };
}
function eventMatchesSelection(event,selection={}){
  const actual=telemetryIdentity(event);
  for(const key of ['chatId','generationId','turnId']){
    const expected=selection?.[key];
    if(expected!=null&&actual[key]!=null&&String(expected)!==String(actual[key]))return false;
  }
  return true;
}
function latestTelemetryEvent(telemetry={},categories=[],name=null,selection={}){
  const wanted=new Set((Array.isArray(categories)?categories:[categories]).map(String));
  const events=Array.isArray(telemetry?.events)?telemetry.events:[];
  for(let i=events.length-1;i>=0;i-=1){
    const event=events[i];
    if(!wanted.has(String(event?.category??'')))continue;
    if(name!=null&&String(event?.name??'')!==String(name))continue;
    if(!eventMatchesSelection(event,selection))continue;
    return event;
  }
  return null;
}
function taskIdFromResultId(value){
  const parts=String(value??'').split(':');
  return parts.length>=3?parts.slice(2).join(':'):null;
}

export function projectNexusSensoryTrace(telemetry={},selection={}){
  const event=latestTelemetryEvent(telemetry,['nexus.sensory','a52.sensory'],'candidate-envelope',selection);
  if(!event)return null;
  const data=event.data??{},fusion=data.fusionReceipt??{};
  const channelReceipts=Array.isArray(data.channelReceipts)?data.channelReceipts:[];
  const perChannelCounts={};
  for(const row of channelReceipts){
    const id=String(row?.channelId??row?.providerId??'').trim();
    if(!id)continue;
    perChannelCounts[id]=count(row?.nominationCount??row?.candidateCount??row?.count);
  }
  return Object.freeze({
    kind:'NexusSensoryTrace',
    chatId:data.chatId??selection?.chatId??null,
    generationId:data.generationId??selection?.generationId??null,
    sceneRevision:data.sceneRevision??selection?.sceneRevision??null,
    trace:Object.freeze({
      receiptId:event.id??null,
      freshness:String(fusion.freshness??'CURRENT'),
      inputNominationCount:count(fusion.inputNominationCount),
      uniqueCandidates:count(data.candidateCount??fusion.deduplicatedCandidateCount),
      inputChannelCount:count(fusion.inputChannelCount??channelReceipts.length),
      perChannelCounts:Object.freeze(perChannelCounts),
      unavailableChannels:Object.freeze(Array.isArray(fusion.unavailableChannels)?fusion.unavailableChannels.map(String):[]),
      degradedChannels:Object.freeze(Array.isArray(fusion.degradedChannels)?fusion.degradedChannels.map(String):[]),
      sourceRevisionRefs:Object.freeze(Array.isArray(data.sourceRevisionRefs)?data.sourceRevisionRefs.map(String):[]),
      worldRevision:data.worldRevision??null,
      sceneRevision:data.sceneRevision??selection?.sceneRevision??null,
      candidates:Object.freeze([]),
      metadataOnly:true,
    }),
  });
}

export function projectNexusTruthAssessment(telemetry={},selection={}){
  const events=Array.isArray(telemetry?.events)?telemetry.events:[];
  let completeIndex=-1,complete=null;
  for(let i=events.length-1;i>=0;i-=1){
    const event=events[i],category=String(event?.category??'');
    if(!['nexus.truth','a52.truth'].includes(category)||String(event?.name??'')!=='assessment-complete')continue;
    if(String(event?.data?.kind??'lore')!=='lore')continue;
    if(!eventMatchesSelection(event,selection))continue;
    completeIndex=i;complete=event;break;
  }
  if(!complete)return null;
  const target=telemetryIdentity(complete),kind=String(complete?.data?.kind??'lore');
  const truthResults=[];
  for(let i=completeIndex-1;i>=0&&truthResults.length<96;i-=1){
    const event=events[i],category=String(event?.category??'');
    if(!['nexus.truth','a52.truth'].includes(category))continue;
    if(String(event?.name??'')==='assessment-complete'){
      const identity=telemetryIdentity(event);
      if(String(event?.data?.kind??'lore')===kind
        &&String(identity.generationId??'')===String(target.generationId??'')
        &&String(identity.chatId??'')===String(target.chatId??''))break;
      continue;
    }
    if(String(event?.name??'')!=='candidate-verdict'||String(event?.data?.kind??'lore')!==kind)continue;
    const identity=telemetryIdentity(event);
    if(target.generationId!=null&&identity.generationId!=null&&String(identity.generationId)!==String(target.generationId))continue;
    if(target.chatId!=null&&identity.chatId!=null&&String(identity.chatId)!==String(target.chatId))continue;
    const data=event.data??{};
    truthResults.push(Object.freeze({
      candidateId:data.candidateId??null,
      classification:data.classification??'UNRESOLVED',
      usableForIntent:data.usableForIntent??null,
      reasons:Object.freeze(Array.isArray(data.reasons)?data.reasons.map(String).slice(0,16):[]),
      kept:data.kept===true,
      supportOnly:data.supportOnly===true,
    }));
  }
  truthResults.reverse();
  const data=complete.data??{};
  return Object.freeze({
    kind:'NexusTruthAssessment',
    id:complete.id??null,
    chatId:data.chatId??selection?.chatId??null,
    generationId:data.generationId??selection?.generationId??null,
    intent:data.intent??null,
    truthResults:Object.freeze(truthResults),
    admittedCandidateIds:Object.freeze(truthResults.filter(row=>row.kept&&!row.supportOnly).map(row=>row.candidateId).filter(Boolean)),
    supportCandidateIds:Object.freeze(truthResults.filter(row=>row.kept&&row.supportOnly).map(row=>row.candidateId).filter(Boolean)),
    metadataOnly:true,
  });
}

export function projectNexusScatterReceipt(diagnostics=null){
  if(!diagnostics||typeof diagnostics!=='object')return null;
  const jobs=Array.isArray(diagnostics?.coordinator?.jobs)?diagnostics.coordinator.jobs:[];
  return Object.freeze({
    kind:'NexusScatterReceipt',
    receiptId:diagnostics.planId??null,
    chatId:diagnostics.chatId??null,
    turnId:diagnostics.generationId??null,
    generationId:diagnostics.generationId??null,
    correlationId:diagnostics.generationId??null,
    jobs:Object.freeze(jobs.map(job=>Object.freeze({
      jobId:job?.id??job?.type??null,
      taskId:job?.type??job?.id??null,
      capability:job?.type??'Foreground task',
      state:job?.state??'UNKNOWN',
      reason:job?.error??null,
    }))),
    layeredTelemetry:Object.freeze((Array.isArray(diagnostics.layers)?diagnostics.layers:[]).map((row,index)=>Object.freeze({
      waveId:row?.layer??row?.id??String(index+1),
      trigger:'FOREGROUND_CONTEXT',
      jobs:count(row?.count??row?.tasks?.length),
      deferred:0,
    }))),
    authority:'READ_ONLY',
  });
}

export function projectNexusGatherReceipt(diagnostics=null){
  if(!diagnostics||typeof diagnostics!=='object')return null;
  const gather=diagnostics.gather??{},fallbackById=new Map();
  for(const row of Array.isArray(gather.fallbacksUsed)?gather.fallbacksUsed:[]){
    if(row?.resultId)fallbackById.set(String(row.resultId),row);
  }
  const results=[];
  for(const resultId of Array.isArray(gather.acceptedResultIds)?gather.acceptedResultIds:[]){
    const fallback=fallbackById.get(String(resultId));
    results.push(Object.freeze({
      resultId:String(resultId),
      taskId:fallback?.taskId??taskIdFromResultId(resultId),
      status:'ADMITTED',
      accepted:true,
      reason:fallback?'BOUNDED_FALLBACK':null,
      freshness:'FRESH',
    }));
  }
  for(const row of Array.isArray(gather.lateResults)?gather.lateResults:[]){
    results.push(Object.freeze({
      resultId:row?.resultId??null,
      taskId:row?.taskId??null,
      status:'LATE',
      accepted:false,
      late:true,
      reason:row?.destination??'LATE_RESULT',
      destination:row?.destination??null,
    }));
  }
  return Object.freeze({
    kind:'NexusGatherReceipt',
    receiptId:diagnostics.planId??null,
    chatId:diagnostics.chatId??null,
    turnId:diagnostics.generationId??null,
    generationId:diagnostics.generationId??null,
    correlationId:diagnostics.generationId??null,
    results:Object.freeze(results),
    rejectedResultIds:Object.freeze((Array.isArray(gather.missingRequired)?gather.missingRequired:[]).map(String)),
    reason:gather.closeReason??diagnostics?.quorum?.closeReason??null,
    failed:diagnostics?.quorum?.satisfied===false,
    authority:'READ_ONLY',
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
    dependencies:Object.freeze({worldTree:'CANONICAL'}),
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
  readSceneSnapshot=()=>null,
  readCharacterCards=()=>({rows:[],currentIndex:null}),
  readTelemetry=()=>({}),
  readDecisionTelemetry=()=>({}),
  readRetrievalDiagnostics=()=>({}),
  readGenerationFrameDiagnostics=()=>({}),
  readWorldTree=()=>null,
  readWorldTreeDiagnostics=()=>({}),
  readSystemDiagnostics=()=>({}),
  readHotCognition=()=>null,
  readScatter=()=>null,
  readSensoryTrace=()=>null,
  readTruthAssessment=()=>null,
  readGather=()=>null,
}={}){
  const readRuntimeStatus=()=>projectNexusRuntimeStatus({
    settings:readSettings?.()??{},
    queue:readQueueHealth?.()??{},
    runtime:readRuntimeDiagnostic?.()??{},
    mainBridge:readMainBridge?.()??{},
  });
  const readSceneUiReadModel=(selection={})=>projectNexusSceneUiReadModel(readSceneSnapshot?.(selection)??null);
  const readSceneObservationRuntime=(selection={})=>clone(readSceneSnapshot?.(selection)??null);
  const readResourceStatus=()=>projectNexusResourceStatus({settings:readSettings?.()??{},queue:readQueueHealth?.()??{}});
  const characters=()=>projectNexusCharacters(readCharacterCards?.()??{});
  const world=Object.freeze({read:()=>clone(readWorldTree?.()??null)});
  const cognitionReader=(reader)=>(selection={})=>clone(reader?.(selection)??null);
  const readHotCognitionReadModel=cognitionReader(readHotCognition);
  const readScatterReceipt=cognitionReader(readScatter);
  const readSensoryTraceModel=cognitionReader(readSensoryTrace);
  const readTruthAssessmentModel=cognitionReader(readTruthAssessment);
  const readGatherReceipt=cognitionReader(readGather);

  const readDiagnosticsTelemetry=(selection={})=>{
    const settings=readSettings?.()??{},queue=readQueueHealth?.()??{},runtime=readRuntimeDiagnostic?.()??{},mainBridge=readMainBridge?.()??{};
    const scene=readSceneSnapshot?.(selection)??null,resources=projectNexusResourceStatus({settings,queue});
    return projectNexusDiagnostics({
      selection,
      telemetry:readTelemetry?.()??{},
      decision:readDecisionTelemetry?.()??{},
      retrieval:readRetrievalDiagnostics?.(selection)??{},
      runtime,queue,mainBridge,scene,resources,
      generationFrame:readGenerationFrameDiagnostics?.(selection)??{},
      worldTree:readWorldTreeDiagnostics?.(selection)??{},
      systems:readSystemDiagnostics?.(selection)??{},
    });
  };
  return Object.freeze({
    readRuntimeStatus,
    readSceneUiReadModel,
    readSceneObservationRuntime,
    readResourceStatus,
    readDiagnosticsTelemetry,
    readHotCognition:readHotCognitionReadModel,
    readHotCognitionReadModel,
    readScatter:readScatterReceipt,
    readScatterReceipt,
    readSensoryTrace:readSensoryTraceModel,
    readTruth:readTruthAssessmentModel,
    readTruthAssessment:readTruthAssessmentModel,
    readGather:readGatherReceipt,
    readGatherReceipt,
    characters,
    world,
    readNativeBrainHostLifecycle:()=>Object.freeze({
      kind:'NexusHostLifecycle',
      mainBridge:clone(readMainBridge?.()??{}),
      rawPromptIncluded:false,
      rawPayloadIncluded:false,
    }),
  });
}
