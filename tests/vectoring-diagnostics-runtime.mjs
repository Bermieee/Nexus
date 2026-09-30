import test from 'node:test';
import assert from 'node:assert/strict';
import { projectVectoringCausalTrace } from '../src/ui-core/vectoring-causal-trace.js';

test('Vectoring Diagnostics projects selected-turn wake probes from live paging telemetry',()=>{
  const trace=projectVectoringCausalTrace({
    resources:[],
    telemetryEvents:[{
      id:'e1',ts:10,category:'vector-paging',name:'memory-wake-probe',
      data:{
        probeId:'p1',requestId:'gen-1',turn:7,probe:'executed',probeReason:'query-or-gate-change',
        latencyMs:12.5,queryVector:{availability:'available',attempted:true},
        exclusionEnforced:true,ordinaryRetrieval:false,nominations:[{sourceId:'m1'}],newlyAwakenedCount:1,
      },
    }],
    selection:{chatId:'chat-a',turnId:'7',generationId:'gen-1'},
  });
  assert.equal(trace.kind,'VectoringActivityTrace');
  assert.equal(trace.selectedTurn.length,1);
  assert.equal(trace.selectedTurn[0].status,'SUCCESS');
  assert.equal(trace.selectedTurn[0].latencyMs,12.5);
  assert.equal(trace.selectedTurn[0].memoryStatus,'VECTOR_RESIDENCY');
  assert.equal(trace.authority,'OBSERVABILITY_ONLY');
});

test('Vectoring Diagnostics projects background index completion telemetry',()=>{
  const trace=projectVectoringCausalTrace({
    telemetryEvents:[{
      id:'idx-1',ts:20,category:'vector-paging',name:'memory-index-slice-complete',
      data:{completedUnits:8,remainingUnits:2,sourceRevision:4,elapsedMs:33},
    }],
  });
  assert.equal(trace.background.length,1);
  assert.equal(trace.background[0].operation,'EMBED_ARTIFACT');
  assert.equal(trace.background[0].vectorCount,8);
  assert.equal(trace.background[0].latencyMs,33);
});
