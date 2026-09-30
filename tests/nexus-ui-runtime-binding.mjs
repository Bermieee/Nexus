import test from 'node:test';
import assert from 'node:assert/strict';
import {
  projectNexusRuntimeStatus,
  projectNexusSceneUiReadModel,
  projectNexusResourceStatus,
  projectNexusCharacters,
  projectNexusDiagnostics,
  projectNexusSensoryTrace,
  projectNexusTruthAssessment,
  projectNexusScatterReceipt,
  projectNexusGatherReceipt,
  createNexusUiHostBindings,
} from '../nexus-ui-bindings.js';
import { Wave13ResourceControlAdapter } from '../src/ui-core/wave13-operator-adapters.js';

test('projects bounded Nexus runtime status without subsystem translation',()=>{
  const status=projectNexusRuntimeStatus({
    settings:{sidecars:{A:{enabled:true},B:{enabled:false}}},
    queue:{
      pausedForForeground:false,
      activeGenerationId:'g1',
      queued:[{id:'q1'}],
      running:[{id:'r1'}],
      lanes:{
        A:{running:['r1'],queued:['q1'],activeJobId:'r1'},
        B:{running:[],queued:[],activeJobId:null},
      },
    },
    runtime:{
      coordinator:{active:[{planId:'p1'}],last:{planId:'p0'}},
      batch:{enabled:true,activeUnits:2,queuedUnits:3,totalOutstandingUnits:5},
      executionProfile:{mainAllowed:true},
    },
    mainBridge:{connected:true,fullyConnected:true,active:false,requested:true,boundaryAllowed:true},
  });
  assert.equal(status.kind,'NexusRuntimeStatus');
  assert.equal(status.queueDepth.jobs,1);
  assert.equal(status.queueDepth.batch,3);
  assert.equal(status.workers.coordinatorActiveRuns,1);
  assert.equal(status.lifecycle.find(row=>row.id==='sidecar-a').executionStatus,'ACTIVE');
  assert.equal(status.lifecycle.find(row=>row.id==='batch-layer').executionStatus,'ACTIVE');
  assert.equal(status.telemetry.rawPromptIncluded,false);
  assert.equal(status.telemetry.rawPayloadIncluded,false);
  assert.equal(status.dependencies.worldTree,'CANONICAL');
});



test('projects Nexus Scene Scanner without promoting references into presence',()=>{
  const model=projectNexusSceneUiReadModel({
    chatId:'chat-1',
    acceptedScene:{
      participants:['Mara'],
      location:'Lantern Tavern',
      activity:'Reviewing a road map',
      objective:'Choose the northern route',
      focus:'Bridge closure',
      timeContext:'Late evening',
    },
    references:{
      characters:[{name:'Iris',relation:'discussed'}],
      items:[{name:'Sunblade',relation:'mentioned'}],
    },
    previousScene:{participants:['Mara'],location:'Lantern Tavern'},
    delta:{objective:{changed:true}},
    scanRevision:'rev-7',
    degraded:false,
    source:'scene-scan',
    reasoning:'Iris and Sunblade are referenced but not present.',
    updatedAt:123,
  });
  assert.equal(model.kind,'SceneUiReadModel');
  assert.equal(model.location,'Lantern Tavern');
  assert.deepEqual(model.activeCast,['Mara']);
  assert.deepEqual(model.objects,[]);
  assert.deepEqual(model.activeThreads,['Choose the northern route','Bridge closure']);
  assert.equal(model.relationshipToPrior,'CHANGED');
  assert.equal(model.boundaryState.state,'TRANSITION');
  assert.equal(model.health.state,'READY');
  assert.equal(model.revision,'nexus-scene:rev-7');
});

test('host binding exposes read-only runtime and scene seams',()=>{
  const host=createNexusUiHostBindings({
    readSettings:()=>({sidecars:{A:{enabled:false},B:{enabled:false}}}),
    readQueueHealth:()=>({queued:[],running:[],lanes:{A:{queued:[],running:[]},B:{queued:[],running:[]}}}),
    readRuntimeDiagnostic:()=>({coordinator:{active:[]},batch:{}}),
    readMainBridge:()=>({connected:false,active:false}),
    readSceneSnapshot:()=>({chatId:'chat-1',acceptedScene:{participants:['Mara'],location:'Dock'},scanRevision:'r1'}),
    readWorldTree:()=>({kind:'NexusWorldTreeUiModel',worldRevision:4,nodes:[],edges:[],overlays:[]}),
    readWorldTreeDiagnostics:()=>({kind:'NexusWorldTreeDiagnostics',worldRevision:4,counts:{nodes:7},legacyWorldBridge:{installed:true},legacyLoreBridge:{installed:true}}),
  });
  for(const key of ['readHotCognition','readHotCognitionReadModel','readScatter','readScatterReceipt','readSensoryTrace','readTruth','readTruthAssessment','readGather','readGatherReceipt']){
    assert.equal(typeof host[key],'function',key+' must be exported as a read-only cognition seam');
  }
  assert.equal(host.readSceneUiReadModel({chatId:'chat-1'}).kind,'SceneUiReadModel');
  assert.equal(host.readSceneObservationRuntime({chatId:'chat-1'}).acceptedScene.location,'Dock');
  assert.equal(host.readResourceStatus().resources.length,2);
  assert.equal(host.world.read().kind,'NexusWorldTreeUiModel');
});


test('projects bounded ported cognition receipts for UI.Core',()=>{
  const telemetry={events:[
    {id:'s1',ts:1,level:'info',category:'nexus.sensory',name:'candidate-envelope',data:{
      chatId:'chat-1',generationId:'g1',candidateCount:4,
      fusionReceipt:{inputNominationCount:7,inputChannelCount:3,unavailableChannels:[],degradedChannels:[]},
      channelReceipts:[{channelId:'lexical',nominationCount:3},{channelId:'graph-walker',nominationCount:1}],
      rawPrompt:'must not project',content:'lore body must not project',
    }},
    {id:'t1',ts:2,level:'debug',category:'nexus.truth',name:'candidate-verdict',data:{
      chatId:'chat-1',generationId:'g1',kind:'lore',candidateId:'lore:World:1',classification:'CURRENT',usableForIntent:true,kept:true,supportOnly:false,reasons:['CURRENT_ALLOWED'],
    }},
    {id:'t2',ts:3,level:'info',category:'nexus.truth',name:'assessment-complete',data:{
      chatId:'chat-1',generationId:'g1',kind:'lore',intent:'CURRENT',candidateCount:1,keptCount:1,droppedCount:0,
    }},
  ]};
  const sensory=projectNexusSensoryTrace(telemetry,{chatId:'chat-1',generationId:'g1'});
  assert.equal(sensory.trace.uniqueCandidates,4);
  assert.equal(sensory.trace.inputChannelCount,3);
  assert.equal(sensory.trace.metadataOnly,true);
  assert.equal('rawPrompt' in sensory.trace,false);
  assert.equal('content' in sensory.trace,false);

  const truth=projectNexusTruthAssessment(telemetry,{chatId:'chat-1',generationId:'g1'});
  assert.equal(truth.truthResults.length,1);
  assert.equal(truth.truthResults[0].classification,'CURRENT');
  assert.deepEqual(truth.admittedCandidateIds,['lore:World:1']);
  assert.equal(truth.metadataOnly,true);

  const diagnostics={
    kind:'NexusForegroundScatterGatherDiagnostics',chatId:'chat-1',generationId:'g1',planId:'plan-1',
    layers:[{layer:'SIGNAL',count:2}],
    coordinator:{jobs:[{id:'foreground-retrieval',type:'foreground-retrieval',state:'SUCCEEDED',error:null}]},
    quorum:{satisfied:true},
    gather:{closeReason:'FOREGROUND_QUORUM',acceptedResultIds:['result:g1:foreground-retrieval'],fallbacksUsed:[],missingRequired:[],lateResults:[]},
  };
  const scatter=projectNexusScatterReceipt(diagnostics);
  assert.equal(scatter.jobs.length,1);
  assert.equal(scatter.generationId,'g1');
  const gather=projectNexusGatherReceipt(diagnostics);
  assert.equal(gather.results.length,1);
  assert.equal(gather.results[0].status,'ADMITTED');
  assert.equal(gather.results[0].taskId,'foreground-retrieval');
});

test('projects Sidecar A/B as read-only UI.Core resources',()=>{
  const raw=projectNexusResourceStatus({
    settings:{sidecars:{
      A:{enabled:true,endpoint:'https://sidecar-a.example/v1',model:'model-a',format:'openai',apiKey:'secret',capabilities:{retrieval:true,summaries:true}},
      B:{enabled:false,endpoint:'',model:'',format:'openai',capabilities:{maintenance:true}},
    }},
    queue:{lanes:{A:{running:['job-1'],queued:[]},B:{running:[],queued:[]}}},
  });
  assert.equal(raw.kind,'NexusResourceStatus');
  assert.equal(raw.resources.length,2);
  assert.equal(raw.resources[0].resourceId,'nexus-sidecar-a');
  assert.equal(raw.resources[0].callable,true);
  assert.equal(raw.resources[0].currentLoad,1);
  assert.deepEqual(raw.resources[0].placements,['retrieval','summaries']);
  assert.equal(raw.resources[1].callable,false);

  const adapter=new Wave13ResourceControlAdapter({bindings:{readResourceStatus:()=>raw}});
  const read=adapter.read();
  assert.equal(read.data.resources.length,2);
  assert.equal(read.data.resources[0].kind,'SIDECAR');
  assert.equal(read.data.resources[0].connected,true);
  assert.equal(adapter.capabilities().read,true);
  assert.equal(adapter.capabilities().configure,false);
  assert.equal(adapter.capabilities().connect,false);
  assert.equal(adapter.capabilities().test,false);
});


test('projects bounded Character Card metadata without raw card text',()=>{
  const projected=projectNexusCharacters({
    currentIndex:1,
    rows:[
      {index:0,avatar:'mara.png',name:'Mara',tags:['merchant'],characterVersion:'1.0',fingerprint:'fp-mara',description:'must not leak'},
      {index:1,avatar:'iris.png',name:'Iris',tags:['mage'],characterVersion:'2.0',fingerprint:'fp-iris',personality:'must not leak'},
    ],
  });
  assert.equal(projected.kind,'NexusCharacterCards');
  assert.equal(projected.installedCount,2);
  assert.equal(projected.activeCharacterName,'Iris');
  assert.equal(projected.characters[1].active,true);
  assert.equal(projected.rawCharacterTextIncluded,false);
  assert.equal(projected.mutationAuthority,false);
  assert.equal('description' in projected.characters[0],false);
  assert.equal('personality' in projected.characters[1],false);
});


test('centralizes telemetry and probes into Diagnostics with sensitive fields redacted',()=>{
  const projected=projectNexusDiagnostics({
    selection:{chatId:'chat-1',turnId:'turn-4'},
    telemetry:{
      events:[
        {ts:1,category:'prompt-loader',name:'chat-completion-ready',level:'info',data:{prompt:'secret prompt',promptTokens:123}},
        {ts:2,category:'sidecar-a',name:'health',level:'info',data:{authorization:'Bearer hidden'}},
      ],
      metrics:{warmInjection:{hits:3}},
      latest:{requestBody:'must redact'},
    },
    decision:{totalDecisions:7,providerFailures:1,lastDecision:{hiddenReasoning:'private'}},
    retrieval:{candidates:[{id:'c1',representationText:'lore body must redact'}],history:[{id:'h1'}]},
    runtime:{coordinator:{active:[{planId:'p1'}]}},
    queue:{queued:[{id:'q1'}],running:[]},
    mainBridge:{connected:true,fullyConnected:true,generationGatewayConnected:true,lifecycleBridgeConnected:true},
    scene:{acceptedScene:{location:'Dock'},reasoning:'scanner diagnostic metadata'},
    resources:{resources:[{
      resourceId:'nexus-sidecar-a',displayName:'Sidecar A',state:'READY',health:'HEALTHY',callable:true,
      lastHealthResult:{ok:true,latencyMs:44,apiKey:'should redact'},lastHealthLatencyMs:44,
    }]},
    generationFrame:{state:'sealed',rawPrompt:'do not expose'},
  });
  assert.equal(projected.kind,'NexusDiagnostics');
  assert.equal(projected.safety.metadataOnly,true);
  assert.equal(projected.safety.rawPrompts,false);
  assert.equal(projected.telemetry.observability.events.length,2);
  assert.equal(projected.telemetry.observability.events[0].data.prompt,'[redacted]');
  assert.equal(projected.telemetry.observability.events[1].data.authorization,'[redacted]');
  assert.equal(projected.telemetry.retrieval.candidates[0].representationText,'[redacted]');
  assert.equal(projected.telemetry.generationFrame.rawPrompt,'[redacted]');
  assert.equal(projected.probes.resources[0].lastHealthResult.apiKey,'[redacted]');
  assert.equal(projected.probes.mainBridge.fullyConnected,true);
});

test('host Diagnostics feed aggregates owner telemetry through one read seam',()=>{
  const host=createNexusUiHostBindings({
    readSettings:()=>({sidecars:{A:{enabled:true,endpoint:'x',model:'m'},B:{enabled:false}}}),
    readQueueHealth:()=>({queued:[],running:[],lanes:{A:{queued:[],running:[]},B:{queued:[],running:[]}}}),
    readRuntimeDiagnostic:()=>({coordinator:{active:[]},batch:{}}),
    readMainBridge:()=>({connected:true}),
    readSceneSnapshot:()=>({chatId:'chat-1',acceptedScene:{location:'Dock'}}),
    readTelemetry:()=>({events:[{category:'prompt-loader',name:'ready'}]}),
    readDecisionTelemetry:()=>({totalDecisions:2}),
    readRetrievalDiagnostics:()=>({candidates:[{id:'c1'}]}),
    readGenerationFrameDiagnostics:()=>({state:'open'}),
    readWorldTreeDiagnostics:()=>({kind:'NexusWorldTreeDiagnostics',worldRevision:4,counts:{nodes:7},legacyWorldBridge:{installed:true},legacyLoreBridge:{installed:true}}),
  });
  const diagnostics=host.readDiagnosticsTelemetry({chatId:'chat-1'});
  assert.equal(diagnostics.kind,'NexusDiagnostics');
  assert.equal(diagnostics.telemetry.observability.events[0].category,'prompt-loader');
  assert.equal(diagnostics.telemetry.decision.totalDecisions,2);
  assert.equal(diagnostics.telemetry.retrieval.candidates.length,1);
  assert.equal(diagnostics.telemetry.generationFrame.state,'open');
  assert.equal(diagnostics.telemetry.worldTree.worldRevision,4);
  assert.equal(diagnostics.telemetry.worldTree.counts.nodes,7);
});
