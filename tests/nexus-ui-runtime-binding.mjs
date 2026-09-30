import test from 'node:test';
import assert from 'node:assert/strict';
import { projectNexusRuntimeStatus, projectNexusSceneUiReadModel, createNexusUiHostBindings } from '../nexus-ui-bindings.js';

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
  assert.equal(status.dependencies.worldTree,'TRANSITION_PENDING');
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
  });
  assert.deepEqual(Object.keys(host).sort(),['readNativeBrainHostLifecycle','readRuntimeStatus','readSceneObservationRuntime','readSceneUiReadModel']);
  assert.equal(host.readSceneUiReadModel({chatId:'chat-1'}).kind,'SceneUiReadModel');
  assert.equal(host.readSceneObservationRuntime({chatId:'chat-1'}).acceptedScene.location,'Dock');
});
