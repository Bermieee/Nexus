import test from 'node:test';
import assert from 'node:assert/strict';
import { createPostTurnJobTable } from '../scheduler/jobs.js';
import { runJobTable } from '../scheduler/runtime.js';
import { projectNexusDiagnosticTelemetryFromObservability } from '../nexus/diagnostics-source.js';

test('post-turn rows preserve results, independent failure isolation and summary branch ordering',async()=>{
  const calls=[];
  const executors={
    'postturn.review':async()=>{calls.push('review');return {operations:2};},
    'notebook.refresh':async()=>{throw new Error('notebook failed');},
    'context.warm':async()=>({refs:['x']}),
    'maintenance.housekeeper':async()=>({status:'complete'}),
    'memory.summaryBranch':async()=>{calls.push('summary','promotion','routing');return {summary:{id:'s'},promotion:{id:'p'},routing:{id:'r'}};},
  };
  const table=createPostTurnJobTable(executors);
  const result=await runJobTable(table,{scope:{chatId:'one'},isFresh:()=>true,yieldHost:async()=>{}});
  assert.deepEqual(result.map(row=>row.id),Object.keys(executors));
  assert.deepEqual(result[0].value,{operations:2});
  assert.equal(result[1].status,'rejected');
  assert.equal(result[1].reason.message,'notebook failed');
  assert.deepEqual(result[4].value.routing,{id:'r'});
  assert.deepEqual(calls,['review','summary','promotion','routing']);
});
test('scheduler runs at most two jobs per layer and yields to host between layers',async()=>{
  let active=0,maxActive=0,yields=0;
  const table=createPostTurnJobTable(Object.fromEntries(['postturn.review','notebook.refresh','context.warm','maintenance.housekeeper','memory.summaryBranch'].map(id=>[id,async()=>{
    active++;maxActive=Math.max(maxActive,active);await new Promise(resolve=>setTimeout(resolve,1));active--;return id;
  }])));
  await runJobTable(table,{scope:{},isFresh:()=>true,yieldHost:async()=>{yields++;}});
  assert.equal(maxActive,2);assert.equal(yields,2);
});
test('stale scope defers queued jobs without calling their executors',async()=>{
  let calls=0;const table=createPostTurnJobTable({'postturn.review':async()=>{calls++;return{};}});
  const result=await runJobTable(table,{scope:{},isFresh:()=>false,yieldHost:async()=>{}});
  assert.equal(calls,0);assert.equal(result[0].value.stale,true);
});
test('inputs are captured before execution and checkpoints stay local to a run',async()=>{
  let revision=1;const seen=[];
  const rows=[{id:'first',lane:'postTurn',priority:2,inputs:scope=>({revision:scope.revision}),
    async *steps(input,ctx){revision=2;yield ctx.checkpoint({position:1});return input;},accept:()=>true,onResult:result=>seen.push(result)},
    {id:'second',lane:'postTurn',priority:1,inputs:scope=>({revision:scope.revision}),async *steps(input,ctx){yield ctx.checkpoint({position:1});return input;},accept:()=>true,onResult:result=>seen.push(result)}];
  await runJobTable(rows,{scope:{revision},isFresh:()=>true,yieldHost:async()=>{}});
  assert.deepEqual(seen,[{revision:1},{revision:1}]);
});
test('existing gather validation rejects an invalid result before publication',async()=>{
  let published=0;
  const row={id:'invalid',lane:'postTurn',priority:1,inputs:()=>({}),async *steps(){return {partial:true};},accept:()=>false,onResult:()=>{published++;}};
  const result=await runJobTable([row],{scope:{},isFresh:()=>true});
  assert.equal(published,0);assert.equal(result[0].value.reason,'invalid-result');
});
test('scheduler selection and gather verdict reach existing Diagnostics channels',async()=>{
  const events=[];
  await runJobTable(createPostTurnJobTable({'postturn.review':async()=>({done:true})}),{scope:{chatId:'one'},emit:(category,name,data)=>events.push({category,name,data})});
  const diagnostics=projectNexusDiagnosticTelemetryFromObservability({events});
  assert.deepEqual(diagnostics.events.find(row=>row.name==='scheduler.plan').data.jobIds,['postturn.review']);
  assert.equal(diagnostics.events.find(row=>row.name==='gather.verdict').data.verdict,'READY');
});
