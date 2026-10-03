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
test('scheduler runs at most two jobs at once and yields to the host as rows finish',async()=>{
  let active=0,maxActive=0,yields=0;
  const table=createPostTurnJobTable(Object.fromEntries(['postturn.review','notebook.refresh','context.warm','maintenance.housekeeper','memory.summaryBranch'].map(id=>[id,async()=>{
    active++;maxActive=Math.max(maxActive,active);await new Promise(resolve=>setTimeout(resolve,1));active--;return id;
  }])));
  await runJobTable(table,{scope:{},isFresh:()=>true,yieldHost:async()=>{yields++;}});
  assert.equal(maxActive,2,'one job per sidecar stays the invariant');
  assert.ok(yields>=2&&yields<=5,'the host gets control back while more rows remain: '+yields);
});
const timed=(id,priority,ms,log,extra={})=>({id,lane:'postTurn',priority,...extra,inputs:()=>({}),
  async *steps(){log.push({id,at:Date.now(),event:'start'});await new Promise(resolve=>setTimeout(resolve,ms));log.push({id,at:Date.now(),event:'end'});return {id};},accept:()=>true,onResult:()=>{}});
const when=(log,id,event)=>log.find(row=>row.id===id&&row.event===event).at;
test('a place that frees up is refilled at once instead of waiting for the slower row of a pair',async()=>{
  const log=[];
  await runJobTable([timed('slow',10,120,log),timed('quick',9,10,log),timed('next',8,40,log),timed('last',7,40,log)],{scope:{},isFresh:()=>true,yieldHost:async()=>{}});
  assert.ok(when(log,'next','start')<when(log,'slow','end')-40,'next starts when quick finishes, long before slow does');
  assert.ok(when(log,'last','start')<when(log,'slow','end'),'the freed place keeps being used');
});
test('a row with nothing to do gives its place straight back',async()=>{
  const log=[];
  const instant={id:'instant',lane:'postTurn',priority:9,inputs:()=>({}),async *steps(){return {skipped:true};},accept:()=>true,onResult:()=>{}};
  await runJobTable([timed('slow-one',10,100,log),instant,timed('slow-two',8,100,log)],{scope:{},isFresh:()=>true,yieldHost:async()=>{}});
  assert.ok(Math.abs(when(log,'slow-two','start')-when(log,'slow-one','start'))<40,'both real rows run together; the instant row did not hold a place');
});
test('dependencies are still honoured while independent rows keep both places busy',async()=>{
  const log=[];
  await runJobTable([timed('parent',10,60,log),timed('child',9,20,log,{dependencies:['parent']}),timed('other',8,60,log)],{scope:{},isFresh:()=>true,yieldHost:async()=>{}});
  assert.ok(when(log,'child','start')>=when(log,'parent','end'),'child waits for parent');
  assert.ok(when(log,'other','start')<when(log,'parent','end'),'an independent row runs beside the parent');
});
test('the real post-turn table no longer leaves a sidecar waiting behind the Scene → Green Room chain',async()=>{
  const log=[];
  const make=(id,ms)=>async()=>{log.push({id,at:Date.now(),event:'start'});await new Promise(resolve=>setTimeout(resolve,ms));log.push({id,at:Date.now(),event:'end'});return {id};};
  const none=async()=>({skipped:true});
  const table=createPostTurnJobTable({
    'scene.observe':make('scene.observe',120),'greenroom.infer':make('greenroom.infer',100),
    'worldtree.contribute.card':none,'worldtree.contribute.scene':none,
    'character.memory':make('character.memory',80),'notebook.refresh':make('notebook.refresh',180),'context.warm':make('context.warm',60),
    'decision.postTurn':none,'worldtree.intake':none,
  });
  const started=Date.now();
  await runJobTable(table,{scope:{},isFresh:()=>true,yieldHost:async()=>{}});
  assert.ok(when(log,'notebook.refresh','start')<when(log,'scene.observe','end'),'the Notebook starts while the Scene chain is still running');
  assert.ok(when(log,'greenroom.infer','start')>=when(log,'scene.observe','end'),'Green Room still follows Scene observation');
  assert.ok(Date.now()-started<560,'wall time is shorter than running the rows one after another');
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
