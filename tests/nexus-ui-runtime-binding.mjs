import test from 'node:test';
import assert from 'node:assert/strict';
import { projectNexusRuntimeStatus, createNexusUiHostBindings } from '../nexus-ui-bindings.js';

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

test('host binding exposes only read-only runtime lifecycle seams',()=>{
  const host=createNexusUiHostBindings({
    readSettings:()=>({sidecars:{A:{enabled:false},B:{enabled:false}}}),
    readQueueHealth:()=>({queued:[],running:[],lanes:{A:{queued:[],running:[]},B:{queued:[],running:[]}}}),
    readRuntimeDiagnostic:()=>({coordinator:{active:[]},batch:{}}),
    readMainBridge:()=>({connected:false,active:false}),
  });
  assert.deepEqual(Object.keys(host).sort(),['readNativeBrainHostLifecycle','readRuntimeStatus']);
  assert.equal(host.readRuntimeStatus().telemetry.rawPromptIncluded,false);
  assert.equal(host.readNativeBrainHostLifecycle().rawPayloadIncluded,false);
});
