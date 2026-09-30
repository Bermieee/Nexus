import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  NEXUS_DIAGNOSTICS_CONTRACT_VERSION,
  NexusDiagnosticCategory,
  NexusDiagnosticChannel,
  NexusDiagnosticTelemetryAccumulator,
  createNexusDiagnosticEvent,
  isNexusDiagnosticProbe,
  isNexusDiagnosticStaleSignal,
  reduceNexusDiagnosticTelemetry,
  projectNexusDiagnosticTelemetryFromObservability,
} from '../nexus/diagnostics-source.js';

{
  assert.equal(NEXUS_DIAGNOSTICS_CONTRACT_VERSION,'1.0.0');
  const event=createNexusDiagnosticEvent({
    id:'evt-1',
    ts:10,
    level:'warn',
    channelId:NexusDiagnosticChannel.GRAPH_WALKER,
    name:'traversal-complete',
    selection:{
      chatId:'chat-1',
      turnId:'turn-7',
      generationId:'gen-3',
      correlationId:'corr-4',
      sceneRevision:8,
      sourceRevisionRefs:['lore:world:1','lore:world:2'],
    },
    metrics:{
      status:'STALE',
      elapsedMs:12.4,
      anchorCount:3,
      traversedNodeCount:9,
      traversedEdgeCount:14,
      staleRejectedCount:2,
      providerCount:1,
      maxDepth:3,
      rawPrompt:'DO NOT RETAIN THIS',
      content:'story body',
      loreBody:'lore body',
      reasoning:'hidden chain',
      responseBody:'provider body',
    },
  });

  assert.deepEqual(Object.keys(event).sort(),['category','data','id','level','name','ts']);
  assert.equal(event.category,NexusDiagnosticCategory.COGNITION);
  assert.equal(event.data.channelId,'graph-walker');
  assert.equal(event.data.selection.generationId,'gen-3');
  assert.equal(event.data.staleRejectedCount,2);
  assert.equal(event.data.rawPrompt,undefined);
  assert.equal(event.data.content,undefined);
  assert.equal(event.data.loreBody,undefined);
  assert.equal(event.data.reasoning,undefined);
  assert.equal(event.data.responseBody,undefined);
  assert.equal(isNexusDiagnosticStaleSignal(event),true);
}

{
  const truth=createNexusDiagnosticEvent({
    channelId:NexusDiagnosticChannel.TRUTH,
    name:'assessment-complete',
    selection:{generationId:'g1'},
    metrics:{
      intent:'CURRENT',
      candidateCount:5,
      keptCount:3,
      droppedCount:2,
      unresolvedCount:1,
      disputedCount:1,
      classifications:{CURRENT:2,HISTORICAL:1,SUPERSEDED:1,CONTRADICTED:1},
      prompt:'raw prompt',
      story:'story text',
    },
  });
  assert.equal(truth.category,NexusDiagnosticCategory.CONTEXT);
  assert.equal(truth.data.classifications.CURRENT,2);
  assert.equal(truth.data.prompt,undefined);
  assert.equal(truth.data.story,undefined);
}

{
  const sensory=createNexusDiagnosticEvent({
    channelId:NexusDiagnosticChannel.SENSORY,
    name:'candidate-envelope',
    metrics:{
      candidateCount:8,
      inputChannelCount:6,
      unavailableChannelCount:1,
      degradedChannelCount:0,
      addedCount:2,
      droppedCount:1,
      rerankedCount:4,
      channelIds:['tree-traversal','lexical','scene-anchor','reuse','paging','graph-walker'],
      candidateBodies:['must never survive'],
    },
  });
  assert.equal(sensory.category,NexusDiagnosticCategory.CONTEXT);
  assert.deepEqual(sensory.data.channelIds,['tree-traversal','lexical','scene-anchor','reuse','paging','graph-walker']);
  assert.equal(sensory.data.candidateBodies,undefined);
}

{
  const probe=createNexusDiagnosticEvent({
    channelId:NexusDiagnosticChannel.RESOURCE_PROBE,
    name:'health-check',
    metrics:{
      resourceId:'sidecar-a',
      displayName:'Sidecar A',
      health:'HEALTHY',
      callable:true,
      lastHealthLatencyMs:45,
      capabilityCount:3,
      apiKey:'secret',
      requestBody:'provider request',
    },
  });
  assert.equal(probe.category,NexusDiagnosticCategory.RESOURCE);
  assert.equal(probe.data.displayName,'Sidecar A');
  assert.equal(isNexusDiagnosticProbe(probe),true);
  assert.equal(probe.data.apiKey,undefined);
  assert.equal(probe.data.requestBody,undefined);
}

{
  const accumulator=new NexusDiagnosticTelemetryAccumulator({maxEvents:16});
  accumulator.ingest({
    channelId:NexusDiagnosticChannel.HOT_COGNITION,
    name:'scene-signal',
    metrics:{hotRevision:4,sceneRevision:2,changedSegmentCount:2,changedSegments:['SCENE','ACTIVE_CAST']},
  });
  accumulator.ingest({
    channelId:NexusDiagnosticChannel.SCENE_INTELLIGENCE,
    name:'post-response-observed',
    metrics:{sceneId:'scene-2',revision:3,path:'SIDECAR',boundaryConfirmed:false,fieldCount:4,fieldNames:['LOCATION','ACTIVE_CAST']},
  });
  accumulator.ingest({
    channelId:NexusDiagnosticChannel.GREEN_ROOM,
    name:'inference-complete',
    metrics:{sceneId:'scene-2',sceneRevision:3,requestedCharacterCount:2,acceptedCount:2,activeCount:2,authority:'INFERRED'},
  });
  accumulator.ingest({
    channelId:NexusDiagnosticChannel.SCATTER,
    name:'foreground-plan',
    metrics:{planId:'plan-1',taskCount:3,admittedCount:3,layers:{SIGNAL:1,EXPANSION:2}},
  });
  accumulator.ingest({
    channelId:NexusDiagnosticChannel.GATHER,
    name:'foreground-complete',
    metrics:{planId:'plan-1',quorumSatisfied:true,completedCount:3,fallbackCount:0,missingRequiredCount:0,lateResultCount:0},
  });

  const snapshot=accumulator.snapshot();
  assert.equal(snapshot.events.length,5);
  assert.equal(snapshot.channels['hot-cognition'].name,'scene-signal');
  assert.equal(snapshot.channels['scene-intelligence'].name,'post-response-observed');
  assert.equal(snapshot.channels['green-room'].name,'inference-complete');
  assert.equal(snapshot.channels.scatter.category,NexusDiagnosticCategory.RUNTIME);
  assert.equal(snapshot.channels.gather.category,NexusDiagnosticCategory.GATHER);
  assert.deepEqual(snapshot.counts,{events:5,warnings:0,errors:0,probes:0,stale:0});
  assert.deepEqual(snapshot.safety,{
    metadataOnly:true,
    rawPrompts:false,
    storyLoreBodies:false,
    providerBodies:false,
    credentials:false,
    hiddenReasoning:false,
  });

  const reduced=reduceNexusDiagnosticTelemetry(snapshot.events,{maxEvents:16});
  assert.deepEqual(reduced.events,snapshot.events);
}

{
  const projected=projectNexusDiagnosticTelemetryFromObservability({
    events:[
      {
        id:'tv2_evt_1',ts:1,level:'info',category:'nexus.sensory',name:'candidate-envelope',
        data:{
          generationId:'g1',candidateCount:7,
          fusionReceipt:{inputChannelCount:4,unavailableChannels:['dense']},
          channelReceipts:[{channelId:'lexical'},{channelId:'graph-walker'}],
          added:[{id:'safe-count-only'}],dropped:[],reranked:[1,2],
          rawPrompt:'must not survive',content:'story body',
        },
      },
      {
        id:'tv2_evt_2',ts:2,level:'warn',category:'nexus.walker',name:'traversal',
        data:{generationId:'g1',anchors:['lore:World:1'],receipt:{elapsedMs:9,staleRejectedCount:1,nodeCount:5,edgeCount:8},provider:{nodeCount:5,edgeCount:8}},
      },
    ],
  });
  assert.equal(projected.events.length,2);
  assert.equal(projected.channels.sensory.data.candidateCount,7);
  assert.equal(projected.channels.sensory.data.rawPrompt,undefined);
  assert.equal(projected.channels['graph-walker'].data.staleRejectedCount,1);
  assert.equal(projected.counts.stale,1);
}

{
  const source=fs.readFileSync(new URL('../nexus/diagnostics-source.js',import.meta.url),'utf8');
  const telemetry=fs.readFileSync(new URL('../observability/telemetry.js',import.meta.url),'utf8');
  const uiHost=fs.readFileSync(new URL('../nexus-ui-host.js',import.meta.url),'utf8');
  const bindings=fs.readFileSync(new URL('../nexus-ui-bindings.js',import.meta.url),'utf8');

  assert.ok(!source.includes('rawPrompt:'),'raw prompt must not exist in producer schema');
  assert.ok(!source.includes('loreBody:'),'lore body must not exist in producer schema');
  assert.ok(!source.includes('reasoning:'),'reasoning text must not exist in producer schema');
  assert.ok(source.includes("HOST:'HOST'"));
  assert.ok(source.includes("COGNITION:'COGNITION'"));
  assert.ok(source.includes("GATHER:'GATHER'"));
  assert.ok(source.includes("RESOURCE:'RESOURCE'"));
  assert.ok(source.includes('projectNexusDiagnosticTelemetryFromObservability'));

  assert.ok(!telemetry.includes("from '../nexus/diagnostics-source.js'"),'Diagnostics must consume the existing observability stream rather than create a second logger');
  assert.ok(uiHost.includes("from './nexus/diagnostics-source.js'"),'the sole Nexus UI host must consume the bounded Diagnostics producer');
  assert.ok(uiHost.includes('readSystemDiagnostics:()=>projectNexusDiagnosticTelemetryFromObservability'));
  assert.ok(bindings.includes('systems:sanitizeDiagnosticValue(systems)'),'ported diagnostics must still pass the UI sanitiser boundary');
}

console.log('Nexus merged Diagnostics telemetry producer: PASS');
