import assert from 'node:assert/strict';
import fs from 'node:fs';
import { WorkDirector } from '../nexus/work-director.js';
import { NexusWorkCoordinator } from '../nexus/work-coordinator.js';
import { runNexusForegroundScatterGather } from '../nexus/scatter-gather-runtime.js';

{
  const runtime={director:new WorkDirector(),coordinator:new NexusWorkCoordinator()};
  const progress=[],executorContexts=[];
  const result=await runNexusForegroundScatterGather({
    generationId:'g1',
    runtime,
    deadlineMs:5000,
    isFresh:()=>true,
    onProgress:value=>progress.push(value),
    executors:{
      'foreground-bootstrap':async context=>{executorContexts.push(context);return {ready:true,refs:[{book:'world',uid:1}]};},
      'foreground-retrieval':async context=>{executorContexts.push(context);return {ready:true,selected:[{book:'world',uid:2}]};},
      'foreground-memory':async context=>{executorContexts.push(context);return {ready:true,selected:[{id:'m1'}]};},
    },
  });
  assert.equal(result.quorum.satisfied,true);
  assert.deepEqual(result.settled.map(row=>row.status),['fulfilled','fulfilled','fulfilled']);
  assert.equal(result.bundle.loreEvidence.length,2);
  assert.equal(result.bundle.episodicEvidence.length,1);
  assert.equal(result.diagnostics.schedulerAuthority,'NEXUS_WORK_DIRECTOR_COORDINATOR');
  assert.equal(result.diagnostics.sealAuthority,false);
  assert.equal(result.diagnostics.settlementAuthority,false);
  assert.ok(result.diagnostics.layers.some(row=>row.layer==='SIGNAL'&&row.taskIds.includes('foreground-bootstrap')));
  assert.ok(result.diagnostics.layers.some(row=>row.layer==='EXPANSION'&&row.taskIds.includes('foreground-retrieval')));
  assert.ok(progress.length>0);
  assert.equal(executorContexts.length,3);assert.ok(executorContexts.every(row=>row.planId===result.plan.id&&row.generationId==='g1'&&row.taskId));
  const plan=runtime.director.snapshot().at(-1);
  assert.equal(plan.source,'a52-scatter-gather-foreground');
  assert.equal(plan.jobs.length,3);
  assert.ok(plan.jobs.every(job=>job.route==='local'));
}

{
  const runtime={director:new WorkDirector(),coordinator:new NexusWorkCoordinator()};
  const result=await runNexusForegroundScatterGather({
    generationId:'g2',
    runtime,
    deadlineMs:5000,
    isFresh:()=>true,
    executors:{
      'foreground-bootstrap':async()=>({ready:true,refs:[]}),
      'foreground-retrieval':async()=>{throw new Error('retrieval failed');},
      'foreground-memory':async()=>({ready:true,selected:[]}),
    },
  });
  assert.equal(result.settled[1].status,'rejected');
  assert.equal(result.quorum.satisfied,true,'required failed owner should be represented by bounded fallback');
  assert.ok(result.bundle.fallbacksUsed.some(row=>row.taskId==='foreground-retrieval'));
  assert.equal(result.bundle.missingRequired.length,0);
  assert.equal(result.diagnostics.coordinator.failed,1);
}

{
  const adapter=fs.readFileSync(new URL('../nexus/scatter-gather-runtime.js',import.meta.url),'utf8');
  const index=fs.readFileSync(new URL('../index.js',import.meta.url),'utf8');
  const frame=fs.readFileSync(new URL('../nexus/generation-frame.js',import.meta.url),'utf8');

  assert.ok(adapter.includes('runtime.director.buildRequestedPlan'));
  assert.ok(adapter.includes('runtime.coordinator.run'));
  assert.ok(adapter.includes('partitionScatterTasks'));
  assert.ok(adapter.includes('evaluateScatterAdmission'));
  assert.ok(adapter.includes('GatherCoordinator'));
  assert.ok(adapter.includes('createForegroundQuorumPlan'));
  assert.ok(adapter.includes("sealAuthority:false"));
  assert.ok(adapter.includes("settlementAuthority:false"));

  assert.ok(index.includes('runNexusForegroundScatterGather'));
  assert.ok(index.includes("'foreground-bootstrap':schedulerContext=>prepareBootstrapAdmission"));
  assert.ok(index.includes("'foreground-retrieval':schedulerContext=>runRetrieval"));
  assert.ok(index.includes("'foreground-memory':schedulerContext=>prepareMemoryRecall"));
  assert.ok(!index.includes('const settled=await Promise.allSettled(work);'),'manual foreground Promise.allSettled fan-out must be replaced');

  assert.ok(frame.includes('export function sealAndApplyGenerationFrame'));
  assert.ok(!adapter.includes('sealAndApplyGenerationFrame'));
  assert.ok(!adapter.includes('setExtensionPrompt'));
  assert.ok(!adapter.includes('Context Seal'));
  assert.ok(!adapter.includes('A52Mode.SHADOW'));
  assert.ok(!adapter.includes('A52Mode.ON'));
}

console.log('Area-52 revised Scatter/Gather wiring: PASS');
