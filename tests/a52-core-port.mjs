import assert from 'node:assert/strict';
import {
  A52Mode,
  resolveA52Modes,
  temporalStatusFromLoreEntry,
  classifyNexusLoreCandidates,
  fuseNexusCandidateChannels,
  HotCognitionRuntime,
  HotSegmentKind,
  GreenRoomStore,
  createGreenRoomBatch,
  GatherCoordinator,
  ResultClass,
  ResultDestination,
  createForegroundQuorumPlan,
  evaluateForegroundQuorum,
  NativeGraphNeighborhoodRetriever,
  RetrievalChannelRegistry,
  createChannelNomination,
} from '../nexus/a52/index.js';
import { buildHeadTailNarrativeWindow, normalizeNexusSceneObservation } from '../nexus/a52/scene/nexus-observation.js';

{
  const modes=resolveA52Modes({a52:{truthGate:'shadow',hotCognition:{mode:'on'}}});
  assert.equal(modes.truthGate,A52Mode.SHADOW);
  assert.equal(modes.hotCognition,A52Mode.ON);
  assert.equal(modes.greenRoom,A52Mode.OFF);
}

{
  const current={book:'world',uid:1,title:'Current',content:'The bridge is open.'};
  const historical={book:'world',uid:2,title:'Old',content:'The bridge was closed.',metadata:{status:'historical'}};
  const superseded={book:'world',uid:3,title:'Older',content:'The bridge is closed.',metadata:{supersededBy:1}};
  assert.equal(temporalStatusFromLoreEntry(current),'CURRENT');
  assert.equal(temporalStatusFromLoreEntry(historical),'HISTORICAL');
  assert.equal(temporalStatusFromLoreEntry(superseded),'SUPERSEDED');
  const rows=classifyNexusLoreCandidates([current,historical,superseded],{intent:'CURRENT',sourceRevisionRefs:['lore:1']});
  assert.equal(rows[0].verdict.usableForIntent,true);
  assert.equal(rows[1].verdict.usableForIntent,false);
  assert.equal(rows[2].verdict.usableForIntent,false);
}

{
  const shared={book:'world',uid:7,title:'Shared',content:'Shared fact'};
  const lexical={book:'world',uid:8,title:'Lexical',content:'Lexical only'};
  const fused=fuseNexusCandidateChannels([
    {channelId:'traversal',candidates:[shared,lexical]},
    {channelId:'scene-anchor',candidates:[shared]},
  ],{query:'shared',sourceRevisionSet:['lore:2'],sceneRevision:4});
  assert.equal(fused.envelope.candidateCount,2);
  const sharedCandidate=fused.envelope.candidates.find(row=>row.metadata?.uid===7);
  assert.ok(sharedCandidate);
  assert.equal(sharedCandidate.channelNominations.length,2);
  assert.ok(Number(sharedCandidate.fusionScore)>0);
}

{
  const hot=new HotCognitionRuntime();
  hot.activateChat('chat-1');
  hot.consumeSceneSignal({
    sceneId:'scene-1',
    sceneRevision:1,
    location:{value:'Dock',authorityClass:'OBSERVED',evidenceRefs:[]},
    activeCast:[{id:'Mara',presence:'PRESENT',authorityClass:'OBSERVED',evidenceRefs:[]}],
    objects:[],
    activeThreads:[],
    sourceRevisionRefs:['scene:1'],
    provenance:['scan:1'],
  },{chatNamespace:'chat-1'});
  const snapshot=hot.snapshot('chat-1');
  assert.equal(snapshot.sceneId,'scene-1');
  assert.equal(snapshot.segments[HotSegmentKind.SCENE].freshness,'FRESH');
  assert.equal(snapshot.segments[HotSegmentKind.ACTIVE_CAST].value[0].id,'Mara');
  assert.ok(snapshot.segments[HotSegmentKind.CONTINUITY]);
}

{
  const longAssistant='HEAD '+('x'.repeat(5000))+' TAIL_SENTINEL';
  const window=buildHeadTailNarrativeWindow([
    {is_user:true,mes:'Where are we?'},
    {is_user:false,mes:longAssistant},
  ],{assistantHeadChars:100,assistantTailChars:100});
  assert.match(window,/HEAD/);
  assert.match(window,/TAIL_SENTINEL/);
  const signal=normalizeNexusSceneObservation({
    scanRevision:2,
    acceptedScene:{participants:['Mara'],location:'Dock',threads:['Find the key']},
  },{chatId:'chat-1'});
  assert.equal(signal.sceneRevision,2);
  assert.equal(signal.location.value,'Dock');
  assert.equal(signal.activeCast[0].id,'Mara');
  assert.equal(signal.activeThreads[0].id,'Find the key');
}

{
  const store=new GreenRoomStore({defaultTtlTurns:2});
  const batch=createGreenRoomBatch({
    sceneRevision:4,
    characters:[{
      characterRef:'Mara',
      confidence:0.8,
      dimensions:{guardedness:0.4,warmth:0.7,anger:0.1,trustTrend:'UP',anxiety:0.2,latentIntent:'Protect the group',attentionTarget:'Iris',socialPressure:0.3,uncertainty:0.25},
      directEvidenceRefs:['turn:10'],
      sourceRevisionSet:['scene:4'],
    }],
  });
  store.putBatch(batch,{turnSequence:10,activeCharacterRefs:['Mara']});
  assert.equal(store.active({turnSequence:12,sceneRevision:4,activeCharacterRefs:['Mara']}).length,1);
  assert.equal(store.active({turnSequence:13,sceneRevision:4,activeCharacterRefs:['Mara']}).length,0);

  store.putBatch(batch,{turnSequence:20,activeCharacterRefs:['Mara']});
  assert.equal(store.active({turnSequence:20,sceneRevision:5,activeCharacterRefs:['Mara']}).length,0);
}

{
  const tasks=[
    {taskId:'truth',resultClass:ResultClass.REQUIRED,compilerLane:'truthClassifications',hardDeadline:120,fallbackPolicy:{type:'KEEP_UNRESOLVED'}},
    {taskId:'green',resultClass:ResultClass.OPPORTUNISTIC,compilerLane:'greenRoom',hardDeadline:120,fallbackPolicy:{type:'SKIP'}},
  ];
  const quorum=createForegroundQuorumPlan(tasks);
  assert.equal(evaluateForegroundQuorum(quorum,{completedTaskIds:[],now:20}).satisfied,false);
  assert.equal(evaluateForegroundQuorum(quorum,{completedTaskIds:['truth'],now:20}).satisfied,true);

  const coordinator=new GatherCoordinator({
    turnEvent:{turnId:'t1',correlationId:'c1',eventId:'e1',sceneRevision:4,worldRevision:2,sourceRevisionSet:['s1']},
    plan:{tasks},
  });
  const accepted=await coordinator.accept({
    resultId:'r1',taskId:'truth',payload:{ok:true},
    freshnessIdentity:{sceneRevision:4,worldRevision:2,sourceRevisionSet:['s1']},
  });
  assert.equal(accepted.accepted,true);
  coordinator.close({at:50});
  const late=await coordinator.accept({
    resultId:'r2',taskId:'green',payload:{ok:true},
    freshnessIdentity:{sceneRevision:4,worldRevision:2,sourceRevisionSet:['s1']},
  });
  assert.equal(late.late,true);
  assert.equal(late.destination,ResultDestination.NEXT_TURN);
}

{
  const temporalGraph={
    allClaims(){return[];},
    readReferences(){return{references:[]};},
  };
  const walker=new NativeGraphNeighborhoodRetriever({
    temporalGraph,
    isSourceRevisionCurrent:()=>true,
    limits:{maxDepth:3,maxNodes:96,maxEdges:192,maxCandidates:64,latencyBudgetMs:15},
  });
  walker.registerProvider({
    providerId:'LORE_LINKS',
    owner:'NEXUS_LORE',
    query(){return [{
      edgeId:'edge-1',
      fromEntityId:'Mara',
      toEntityId:'Iris',
      edgeMeaning:'RELATED_TO',
      sourceRevisionRefs:['lore:1'],
      authorityClass:'SOURCE_CANON',
      temporalStatus:'CURRENT',
      representationText:'Mara is related to Iris',
    }];},
  });
  const nominations=walker.retrieve({
    intentId:'walk-1',
    query:'Mara',
    intentKind:'CURRENT',
    entityRefs:['Mara'],
  },{
    chatId:'chat-1',
    worldRevision:1,
    sceneRevision:1,
    sourceRevisionSet:['lore:1'],
  });
  assert.equal(nominations.length,1);
  assert.equal(nominations[0].channelId,'ZZ_NATIVE_GRAPH_WALKER');
  assert.equal(walker.diagnostics().lastReceipt.staleRejectedCount,0);
}

{
  const registry=new RetrievalChannelRegistry();
  registry.register({
    descriptor:{channelId:'lexical',capabilities:['SPARSE'],supportedIntentKinds:['GENERAL'],maxCandidates:4},
    retrieve(intent){
      return [createChannelNomination({
        channelId:'lexical',
        candidateId:'lore:world:9',
        evidenceIdentity:'lore:world:9',
        retrievalIntentIds:[intent.intentId],
        normalizedRank:1,
        authorityClass:'SOURCE_CANON',
        representationRef:'lore:world:9',
      })];
    },
  });
  const result=registry.retrieveAllSync({
    intents:[{intentId:'intent-1',kind:'GENERAL'}],
    context:{latencyBudgetMs:15},
  });
  assert.equal(result.nominations.length,1);
  assert.equal(registry.manifest().channels[0].channelId,'lexical');
}

console.log('Area-52 core port scenarios: PASS');
