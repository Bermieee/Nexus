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
  subsystems={},
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
      subsystems:sanitizeDiagnosticValue(subsystems),
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
  const data=event.data??{},fusion=data.fusionReceipt??data;
  const channelReceipts=Array.isArray(data.channelReceipts)?data.channelReceipts:[];
  const perChannelCounts={...(data.perChannelCounts??{})};
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
  readCurrentChatId=()=>null,
  readGenerationFrameIdentity=()=>null,
  readMemorySnapshot=null,
  readLoreSnapshot=null,
  readTransactions=null,
  readSubsystemStatus=()=>({}),
  subscribeOwner=null,
  readSettings=()=>({}),
  readQueueHealth=()=>({}),
  readResources=()=>null,
  readRuntimeDiagnostic=()=>({}),
  readMainBridge=()=>({}),
  readSceneSnapshot=()=>null,
  readCharacterCards=()=>({rows:[],currentIndex:null}),
  readTelemetry=()=>({}),
  readDecisionTelemetry=()=>({}),
  readRetrievalDiagnostics=()=>({}),
  readGenerationFrameDiagnostics=()=>({}),
  readWorldTree=()=>null,
  subscribeWorldTree=()=>()=>{},
  readWorldTreeDiagnostics=()=>({}),
  readSystemDiagnostics=()=>({}),
  readHotCognition=()=>null,
  readScatter=()=>null,
  readSensoryTrace=()=>null,
  readTruthAssessment=()=>null,
  readGather=()=>null,
}={}){
  const ownerReads=createNexusOwnerDiagnosticReads({readCurrentChatId,readGenerationFrameIdentity,readGenerationFrameDiagnostics,readTelemetry,readMemorySnapshot,readLoreSnapshot,readTransactions,readScatter,readGather,readDecisionTelemetry});
  const readRuntimeStatus=()=>projectNexusRuntimeStatus({
    settings:readSettings?.()??{},
    queue:readQueueHealth?.()??{},
    runtime:readRuntimeDiagnostic?.()??{},
    mainBridge:readMainBridge?.()??{},
  });
  const readSceneUiReadModel=(selection={})=>projectNexusSceneUiReadModel(readSceneSnapshot?.(selection)??null);
  const readSceneObservationRuntime=(selection={})=>clone(readSceneSnapshot?.(selection)??null);
  const readResourceStatus=()=>{
    const owner=readResources?.();
    return clone(owner??projectNexusResourceStatus({settings:readSettings?.()??{},queue:readQueueHealth?.()??{}}));
  };
  const characters=()=>projectNexusCharacters(readCharacterCards?.()??{});
  const world=Object.freeze({read:()=>clone(readWorldTree?.()??null),subscribe:listener=>subscribeWorldTree(listener)});
  const cognitionReader=(reader)=>(selection={})=>clone(reader?.(selection)??null);
  const readHotCognitionReadModel=cognitionReader(readHotCognition);
  const readScatterReceipt=cognitionReader(readScatter);
  const readSensoryTraceModel=cognitionReader(readSensoryTrace);
  const readTruthAssessmentModel=cognitionReader(readTruthAssessment);
  const readGatherReceipt=cognitionReader(readGather);

  const safeDiagnosticsRead=(reader,...args)=>{try{return reader?.(...args)??{};}catch{return{};}};
  const readDiagnosticsTelemetry=(selection={})=>{
    const settings=readSettings?.()??{},queue=readQueueHealth?.()??{},runtime=readRuntimeDiagnostic?.()??{},mainBridge=readMainBridge?.()??{};
    const scene=readSceneSnapshot?.(selection)??null,resources=readResourceStatus();
    return projectNexusDiagnostics({
      selection,
      telemetry:safeDiagnosticsRead(readTelemetry),
      decision:readDecisionTelemetry?.()??{},
      retrieval:readRetrievalDiagnostics?.(selection)??{},
      runtime,queue,mainBridge,scene,resources,
      generationFrame:readGenerationFrameDiagnostics?.(selection)??{},
      worldTree:readWorldTreeDiagnostics?.(selection)??{},
      systems:safeDiagnosticsRead(readSystemDiagnostics,selection),
      subsystems:safeDiagnosticsRead(readSubsystemStatus,selection),
    });
  };
  return Object.freeze({
    ...ownerReads,
    subscribe:listener=>{
      const releases=[subscribeWorldTree(listener)];
      if(subscribeOwner)releases.push(subscribeOwner(event=>listener({...event,selection:ownerReads.readSelection()})));
      return()=>{for(const release of releases)release?.();};
    },
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

// Read-only translations of existing Nexus owners. No imported UI service is
// manufactured here; a missing physical receipt stays missing.
function createNexusOwnerDiagnosticReads({readCurrentChatId,readGenerationFrameIdentity,readGenerationFrameDiagnostics,readTelemetry,readMemorySnapshot,readLoreSnapshot,readTransactions,readScatter,readGather,readDecisionTelemetry}){
 const currentFrame=()=>{
  const chatId=readCurrentChatId?.()??null,identity=readGenerationFrameIdentity?.(),diagnostics=readGenerationFrameDiagnostics?.();
  const value=identity?.generationId?identity:diagnostics;
  return value?.generationId&&chatId!=null&&String(value.chatId)===String(chatId)?value:null;
 };
 const readSelection=()=>{const frame=currentFrame(),chatId=readCurrentChatId?.()??null;return {chatId,turnId:frame?.generationId??null,generationId:frame?.generationId??null,correlationId:frame?.generationId??null,worldRevision:null,sceneRevision:null,sourceRevisionRefs:[]};};
 const matches=(raw,query={})=>raw&&['chatId','generationId','turnId'].every(key=>query[key]==null||String(query[key])===String(raw[key]));
 const scopedReceipt=(reader,query={})=>{const selection=readSelection();if(!selection.generationId||!matches(selection,query))return null;const value=reader?.({...selection,...query});return value&&matches(value,{chatId:selection.chatId,generationId:selection.generationId})?value:null;};
 const frame=(query={})=>{const selection=readSelection(),value=readGenerationFrameDiagnostics?.();return matches(selection,query)&&value?.generationId===selection.generationId&&String(value?.chatId)===String(selection.chatId)?{...value,...selection}:null;};
 const readPromptPlan=(query={})=>{
  const f=frame(query);if(!f?.appliedAt)return null;
  const sections=f.sections??[],failed=f.failedOutlets??[];
  return {kind:'PromptPlanReadModel',...readSelection(),promptPlanId:'nexus-frame:'+f.generationId,contextSealId:'nexus-seal:'+f.generationId,
   status:failed.length?'DEGRADED':'READY',health:{state:failed.length?'DEGRADED':'READY'},estimatedTokens:f.promptTokens??null,budget:{allocated:f.promptTokens??null,total:null},
   sectionOrder:sections.map(row=>row.id),slotAllocation:sections.map(row=>({slot:row.id,estimatedTokens:row.tokens??null})),
   reuseDecisions:sections.map(row=>({slot:row.id,state:row.reused?'REUSED':'REBUILD',sourceSubsystem:row.id})),
   dropped:failed.map(slot=>({slot,reason:'OWNER_OUTLET_FAILED'})),sourceRevisionRefs:[],authority:'READ_ONLY',mutationAuthority:false};
 };
 const readContextSeal=(query={})=>{
  const f=frame(query);if(!f?.appliedAt)return null;
  const gather=scopedReceipt(readGather,query);
  return {kind:'NexusContextSealReceipt',...readSelection(),id:'nexus-seal:'+f.generationId,sealed:true,sealedState:true,sealedAt:f.appliedAt,packetHash:f.promptHash??null,
   admittedResultIds:(gather?.results??[]).filter(row=>row.accepted).map(row=>row.resultId),fallbackState:(gather?.results??[]).some(row=>row.reason==='BOUNDED_FALLBACK')?'BOUNDED_FALLBACK':'NONE',authority:'READ_ONLY'};
 };
 const readContextReceipt=(query={})=>{const plan=readPromptPlan(query),seal=readContextSeal(query);return plan?{kind:'ContextReceiptReadModel',...readSelection(),promptPlanId:plan.promptPlanId,contextSealId:seal.id,includedSections:plan.sectionOrder,omittedSections:plan.dropped,estimatedTokens:plan.estimatedTokens,budget:plan.budget,contextSealValid:true,fallbackState:seal.fallbackState,authority:'READ_ONLY'}:null;};
 const readHostDeliveryReceipt=(query={})=>{
  const selection=readSelection();if(!selection.generationId||!matches(selection,query))return null;
  const telemetry=readTelemetry?.()??{};
  const candidates=[...(telemetry.events??[]),telemetry.latest?.promptLoader?.chatCompletion,telemetry.latest?.promptLoader?.textCompletion].filter(Boolean);
  const event=candidates.filter(row=>row.category==='prompt-loader'&&['chat-completion-ready','text-completion-ready'].includes(row.name)&&row.data?.dryRun===false&&String(row.data?.generationId)===String(selection.generationId)&&String(row.data?.chatId)===String(selection.chatId)).sort((a,b)=>a.ts-b.ts).at(-1);
  const f=frame(query);if(!event&&!f?.appliedAt)return null;
  return {kind:'SillyTavernHostDeliveryReceipt',...selection,receiptId:event?.id??'nexus-prepared:'+selection.generationId,state:event?'OBSERVED':'PREPARED',promptPrepared:Boolean(f?.appliedAt),promptInjected:Boolean(event),hostObserved:Boolean(event),requestInjectedAt:event?.ts??null,preparedAt:f?.appliedAt??null,promptHash:event?.data?.promptHash??f?.promptHash??null,rawPromptIncluded:false};
 };
 const chatMatches=query=>query?.chatId==null||String(query.chatId)===String(readCurrentChatId?.());
 const readMemory=(query={})=>{
  if(!readMemorySnapshot||!chatMatches(query))return null;const snapshot=readMemorySnapshot(),records=Object.values(snapshot?.records??{});
  return {kind:'NexusMemoryReadModel',chatId:readCurrentChatId?.(),revision:snapshot?.evidenceRevision??snapshot?.lastUpdatedAt??null,
   summaries:records.map(row=>({id:row.id,layer:row.layer,turnRange:clone(row.turnRange),routeState:row.routeState,promotedTo:row.promotedTo??null,temporalStatus:'HISTORICAL',freshness:row.stale?'STALE':row.freshness})),
   state:{current:[],historical:[],unresolved:[]},evidence:[],episodes:[],reflections:[],readOnly:true,mutationAuthority:false,settlementAuthority:false,contextSealAuthority:false};
 };
 const readLoreStatus=(query={})=>{
  if(!readLoreSnapshot||!chatMatches(query))return null;const snapshot=readLoreSnapshot();
  return {kind:'NexusLoreReadModel',chatId:readCurrentChatId?.(),revision:snapshot?.worldRevision??null,owner:'WORLD_TREE',
   entries:(snapshot?.nodes??[]).filter(row=>row.kind==='LORE_FACT').map(row=>({sourceId:row.id,lorebookId:row.data?.book??row.provenance?.sourceIds?.[0]??null,uid:row.data?.uid??null,
    sourceRevisionId:row.provenance?.sourceRevisionIds?.[0]??String(row.revision??''),sourceState:row.temporal?.status??'UNRESOLVED',freshness:row.temporal?.status==='SUPERSEDED'?'STALE_OR_UNLEARNED':'CURRENT',
    operatorState:row.data?.disabled?'REMOVED':'ACCEPTED',retrievalReady:false,representationReady:false,learnedRevisionId:null})),
   coverage:clone(snapshot?.coverage??null),lifecycle:{active:0,due:0},capabilities:{studyEngine:false,canonicalLoreRead:true},readOnly:true};
 };
 const readCognitiveChoice=(query={})=>{
  const scatter=scopedReceipt(readScatter,query);if(!scatter)return null;
  return {kind:'NexusSchedulerChoiceReceipt',chatId:scatter.chatId,turnId:scatter.turnId,generationId:scatter.generationId,correlationId:scatter.correlationId,
   status:scatter.status??'COMPLETE',candidateJobs:(scatter.jobs??[]).map(row=>({jobId:row.jobId,taskId:row.taskId,capability:row.capability,state:row.state})),
   admittedJobs:(scatter.jobs??[]).map(row=>({jobId:row.jobId,taskId:row.taskId,capability:row.capability,state:row.state})),reasonCodes:['DETERMINISTIC_FOREGROUND_PLAN'],authority:'READ_ONLY'};
 };
 const readSelectedTurnReceipt=(query={})=>{
  const selection=readSelection();if(!selection.generationId||!matches(selection,query))return null;
  const plan=readPromptPlan(query),seal=readContextSeal(query),delivery=readHostDeliveryReceipt(query),gather=scopedReceipt(readGather,query),scatter=scopedReceipt(readScatter,query);
  return {kind:'NexusSelectedTurnReceipt',contractVersion:1,...selection,receiptId:'nexus-turn:'+selection.generationId,
   stages:[{stage:'scatter',status:scatter?'RECORDED':'NO_EVIDENCE'},{stage:'gather',status:gather?'RECORDED':'NO_EVIDENCE'},{stage:'promptPlan',status:plan?'RECORDED':'NO_EVIDENCE'},{stage:'contextSeal',status:seal?'RECORDED':'NO_EVIDENCE'}],
   delivery:{compiled:plan?{state:'COMPILED',promptPlanId:plan.promptPlanId,packetHash:frame(query)?.promptHash??null}:null,hostObserved:delivery?.promptInjected?{...delivery,state:'OBSERVED'}:{state:'UNAVAILABLE',reason:'HOST_REQUEST_NOT_OBSERVED'}},mutationAuthority:false};
 };
 const readGeneration=(query={})=>{if(typeof query==='string')query={generationId:query};const receipt=readSelectedTurnReceipt(query);return receipt?{...receipt,promptPlan:readPromptPlan(query),contextReceipt:readContextReceipt(query),sealReceipt:readContextSeal(query),hostDeliveryReceipt:readHostDeliveryReceipt(query),learningReceipt:null}:null;};
 const listTransactions=(query={})=>!readTransactions||!chatMatches(query)?[]:(readTransactions()??[]).filter(row=>String(row.assumptions?.chatId??row.metadata?.chatId??'')===String(readCurrentChatId?.())).map(row=>({id:row.id,type:row.type,state:row.state,chatId:readCurrentChatId?.(),createdAt:row.createdAt,updatedAt:row.updatedAt,authority:'READ_ONLY'}));
 const readJev=()=>null; // Connection health remains separate from turn-scoped execution.
 const readCognitionUiState=(query={})=>{
  const selection=readSelection();if(!selection.generationId||!matches(selection,query))return null;
  const jobs=scopedReceipt(readScatter,query)?.jobs??[];return {kind:'NexusCognitionUiState',...selection,activeTasks:jobs.filter(row=>row.state==='running'),decisionTelemetry:sanitizeDiagnosticValue(readDecisionTelemetry?.()??{}),physicalExecution:null,owner:'NEXUS_SCHEDULER'};
 };
 return {readSelection,readPromptPlan,readPromptPlanReadModel:readPromptPlan,readContextReceipt,readContextReceiptReadModel:readContextReceipt,readContextSeal,readContextSealReceipt:readContextSeal,readHostDeliveryReceipt,readPromptDeliveryReceipt:readHostDeliveryReceipt,
  readMemory,readMemoryStatus:readMemory,readLoreStatus,readLoreStudySurface:readLoreStatus,readCognitiveChoice,readCognitiveChoiceReceipt:readCognitiveChoice,readSelectedTurnReceipt,readGeneration,
  listGenerations:()=>{const s=readSelection();return s.generationId?[s]:[];},listTransactions,readCognitionUiState,readJev};
}
