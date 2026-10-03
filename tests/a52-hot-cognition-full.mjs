import assert from 'node:assert/strict';
import fs from 'node:fs';
import { HotCognitionRuntime } from '../nexus/a52/hot-cognition-runtime.js';
import { HotDependencyState, HotFreshness, HotSegmentKind } from '../nexus/a52/hot-cognition-contracts.js';
import { renderNexusHotNotebook } from '../nexus/a52/hot-cognition-nexus.js';
import { normalizeNexusSceneObservation } from '../nexus/a52/scene/nexus-observation.js';

const hot=new HotCognitionRuntime({maxRecentTail:6});
hot.activateChat('chat-1');

{
  const signal=normalizeNexusSceneObservation({
    acceptedScene:{
      participants:['Mara','Iris'],
      location:'Ember Tavern',
      activeThreads:['Find the silver key'],
    },
  },{
    chatId:'chat-1',
    sceneId:'nexus-scene:chat-1',
    sceneRevision:1,
    sourceRevisionRefs:['scene:rev-1'],
  });
  const receipt=hot.consumeSceneSignal(signal,{chatNamespace:'chat-1'});
  assert.equal(receipt.status,'APPLIED');
  const snapshot=hot.snapshot('chat-1');
  assert.equal(snapshot.segments[HotSegmentKind.SCENE].freshness,HotFreshness.FRESH);
  assert.equal(snapshot.segments[HotSegmentKind.ACTIVE_CAST].value.length,2);
  assert.equal(snapshot.segments[HotSegmentKind.CONTINUITY].freshness,HotFreshness.FRESH);
}

{
  for(let i=0;i<7;i++){
    hot.consumeNarrativeEvidence({
      kind:'NarrativeEvidence',
      chatId:'chat-1',
      activity:'APPEND',
      sourceRevisionId:'message-rev:'+i,
      messageId:'message:'+i,
      role:i%2?'assistant':'user',
      content:'Turn '+i,
      sequence:i,
      current:true,
      invalidates:[],
    });
  }
  const tail=hot.snapshot('chat-1').segments[HotSegmentKind.RECENT_EPISODE_TAIL];
  assert.equal(tail.freshness,HotFreshness.FRESH);
  assert.equal(tail.value.length,6,'Hot recent tail must remain bounded to six messages for Nexus phase A');
  assert.equal(tail.value[0].messageId,'message:1');
}

{
  const receipt=hot.setGraphNeighborhood({
    chatNamespace:'chat-1',
    state:HotDependencyState.AVAILABLE,
    refs:['NEXUS_WORLD_TREE|edge-1'],
    entries:[{
      ref:'NEXUS_WORLD_TREE|edge-1',
      sourceRevisionRefs:['lore-rev:1'],
      identityRevisionRefs:[],
      dependencyRevisionRefs:[],
    }],
    sourceRevisionRefs:['lore-rev:1'],
    updateId:'graph:1',
  });
  assert.equal(receipt.status,'APPLIED');
  const graph=hot.snapshot('chat-1').segments[HotSegmentKind.GRAPH_NEIGHBORHOOD];
  assert.equal(graph.freshness,HotFreshness.FRESH);
  assert.equal(graph.value.refs.length,1);
}

{
  const state=hot.exportState();
  const restored=new HotCognitionRuntime({maxRecentTail:6});
  restored.restoreState(state);
  restored.activateChat('chat-1');
  assert.equal(restored.snapshot('chat-1').hotRevision,hot.snapshot('chat-1').hotRevision);
  assert.equal(restored.snapshotForTurn().chatNamespace,'chat-1');
  const rendered=renderNexusHotNotebook(restored.snapshot('chat-1'));
  assert.match(rendered,/\[HOT COGNITION\]/);
  assert.match(rendered,/Active cast:/);
  assert.match(rendered,/Recent episode tail:/);
}

{
  const runtimeSource=fs.readFileSync(new URL('../nexus/a52/hot-cognition-runtime.js',import.meta.url),'utf8');
  const wiring=fs.readFileSync(new URL('../nexus/hot-cognition.js',import.meta.url),'utf8');
  const sceneRuntime=fs.readFileSync(new URL('../scene/runtime.js',import.meta.url),'utf8');
  const sceneIntelligence=fs.readFileSync(new URL('../nexus/scene-intelligence.js',import.meta.url),'utf8');
  const notebook=fs.readFileSync(new URL('../memory/notebook.js',import.meta.url),'utf8');
  const memoryRecall=fs.readFileSync(new URL('../memory/recall.js',import.meta.url),'utf8');
  const retrieval=fs.readFileSync(new URL('../retrieval/retriever.js',import.meta.url),'utf8');
  const index=fs.readFileSync(new URL('../index.js',import.meta.url),'utf8');

  assert.ok(!runtimeSource.includes('noteGenerationSeal('),'Context Seal coupling must not survive the Nexus port');
  assert.ok(!runtimeSource.includes('consumeResultRoute('),'coprocessor result-route coupling must not survive the Nexus port');
  assert.ok(runtimeSource.includes('snapshotForTurn(){ return this.snapshot(); }'));

  assert.ok(sceneRuntime.includes('observeNexusSceneAuthority'));
  assert.ok(sceneIntelligence.includes('observeNexusHotSceneSignal'));
  assert.ok(retrieval.includes("channelId:'hot-continuity'"));
  assert.ok(retrieval.includes('observeNexusHotGraphNeighborhood(walkerReceipt'));
  assert.ok(notebook.includes('renderCurrentNexusHotNotebook'));
  assert.ok(notebook.includes("outlet:'NOTEBOOK'"));
  assert.ok(!notebook.includes("NEXUS_GENERATION_OUTLET.HOT"));

  assert.ok(index.includes('observeNexusHotNarrativeMessage'));
  assert.ok(index.includes('invalidateNexusHotMessage'));
  assert.ok(index.includes('persistNexusHotCognition'));
  assert.ok(index.includes("reason:'CHAT_SWITCH'"));

  assert.ok(wiring.includes("maxRecentTail:6"));
  assert.ok(wiring.includes("logEvent('nexus.hot'"));
  assert.ok(wiring.includes("KEY='nexus_a52_hot_cognition_v1'"));
  assert.ok(wiring.includes('getNexusWorldTreeOwner'),'Hot working state must use the unfiltered owner through the narrow ephemeral path');
  assert.ok(wiring.includes('readWorldTreeStoryBinding'),'Hot must observe binding changes without acquiring mutation authority');
  assert.ok(wiring.includes('nexusBindingKey'),'Hot working state must retain the binding identity used to derive book-backed state');
  assert.ok(wiring.includes('STORY_BINDING_CHANGED'),'book-derived Hot state must be invalidated when the story binding changes');
  assert.ok(wiring.includes('HotSegmentKind.WORLD_REFERENCES,HotSegmentKind.GRAPH_NEIGHBORHOOD'),'binding invalidation must target book-derived state instead of clearing chat-local Scene/tail state');
  assert.ok(!wiring.includes('getNexusWorldTree()'),'Hot working state must not require a Lorebook-bound facade');
  assert.ok(memoryRecall.includes("'hot-read-fallback'"),'Memory recall must degrade cleanly if Hot cannot be read');
}

console.log('Area-52 revised Hot Cognition wiring: PASS');
