// Real Model Worker Bus -> Batch Layer -> Sidecar Bus/Router -> JobQueue.
// Only the host, settings, telemetry sink, and external provider are doubled.
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
if (!vm.SourceTextModule) {
  const run=spawnSync(process.execPath,['--experimental-vm-modules',fileURLToPath(import.meta.url)],{stdio:'inherit'});
  process.exit(run.status??1);
}
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const gate=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const tick=()=>new Promise(r=>setTimeout(r,0));
async function until(predicate){for(let i=0;i<300;i++){if(predicate())return;await new Promise(r=>setTimeout(r,2));}assert.fail('execution did not reach expected boundary');}
async function fixture(provider=async(_slot,options)=>({text:options.prompt})) {
  let context={chatId:'story-a',chat:[],chatMetadata:{}};
  const calls=[],events=[],prompts=[],profiles=Object.fromEntries(['A','B'].map(slot=>[slot,{slot,enabled:true,format:'openai',endpoint:'https://test.invalid/'+slot,model:'test-'+slot,capabilities:{}}]));
  const settings={enabled:true,nexus:{callCenter:{mainModelAccess:false},batchLayer:{enabled:true,coalesceMs:10,maxBatchItems:10,targetInputTokens:7000}},routing:{retrieval:'A',summaries:'A',fallback:true,loadBalance:true,modes:{},locks:{}},jobs:{}};
  const record=(category,name,data,level)=>events.push({category,name,data,level});
  const stubs={
    '../../../st-context.js':{getContext:()=>context},
    '../../../../script.js':{extension_prompt_types:{IN_CHAT:1},extension_prompt_roles:{SYSTEM:0},setExtensionPrompt:(key,text)=>prompts.push({key,text})},
    'core/settings.js':{getSettings:()=>settings,getSidecarProfile:slot=>profiles[slot]},
    'observability/telemetry.js':{logEvent:record,recordJobLifecycle:()=>{},recordWorkloadDecision:()=>{},recordWorkloadFallback:()=>{},recordMultiWorkloadAssignment:()=>{}},
    'observability/system-events.js':{logSystemEvent:record},
    'decision/task8-postturn-sites.js':{TASK8_POSTTURN_SITE_IDS:{},runTask8ChoiceDecision:async(_site,_input,fallback)=>({choice:fallback})},
    'nexus/runtime.js':{getNexusRuntime:()=>({executionProfile:{workerResources:['A','B'],modelWorkerCount:2,sidecarCount:2}})},
    'sidecar/client.js':{callSidecar:async(profile,options)=>{const call={slot:profile.slot,options,event:'started'};calls.push(call);try{return await provider(profile.slot,options);}finally{call.event='ended';}}},
  };
  const cache=new Map();
  const resolve=(specifier,parent)=>path.posix.normalize(path.posix.join(path.posix.dirname(parent.identifier),specifier));
  function load(name){
    if(cache.has(name))return cache.get(name);
    const stub=stubs[name];
    const mod=stub?new vm.SyntheticModule(Object.keys(stub),function(){for(const [key,value]of Object.entries(stub))this.setExport(key,value);},{identifier:name}):new vm.SourceTextModule(fs.readFileSync(path.join(root,name),'utf8'),{identifier:name,importModuleDynamically:async(specifier,parent)=>{
      const imported=load(resolve(specifier,parent));if(imported.status==='unlinked')await imported.link(linker);if(imported.status==='linked')await imported.evaluate();return imported;
    }});
    cache.set(name,mod);return mod;
  }
  const linker=(specifier,parent)=>load(resolve(specifier,parent));
  const entry=new vm.SourceTextModule("export * as worker from '../nexus/model-worker-bus.js'; export * as batch from '../nexus/batch-layer.js'; export * as scheduler from '../scheduler/sidecars.js'; export * as queue from '../core/job-queue.js'; export * as scope from '../nexus/work-scope.js'; export * as sidecar from '../sidecar/bus.js'; export * as frame from '../nexus/generation-frame-bus.js'; export * as delivery from '../nexus/generation-frame.js'; export * as ports from '../nexus/generation-frame-ports.js'; export * as jobs from '../scheduler/jobs.js'; export * as runtime from '../scheduler/runtime.js';",{identifier:'tests/entry.js'});
  await entry.link(linker);await entry.evaluate();
  const api=entry.namespace,scheduler=api.scheduler.sidecarScheduler;
  api.scheduler.configureSidecarScheduler({captureScope:()=>api.scope.captureNexusWorkScope(context),isFresh:scope=>api.scope.isNexusWorkScopeFresh(scope,context),emit:(name,data)=>record('scheduler',name,data)});
  const scope=()=>api.scope.captureNexusWorkScope(context);
  const enqueue=(prompt,options={})=>api.worker.enqueueNexusModelWorkerJob('reasoning','search-reasoning',{role:'retrieval',prompt,schedulerLane:'postTurn',preemptible:false,mainEligible:false,nexusScope:scope(),...options});
  return {...api,scheduler,calls,events,prompts,settings,profiles,captureScope:scope,enqueue,queue:api.queue.getJobQueue(settings.jobs),setContext:value=>{context=value;}};
}

test('scheduled compatible jobs form a real Sidecar Bus batch before reserving A/B',async()=>{
  const f=await fixture();const jobs=Array.from({length:6},(_,i)=>f.enqueue('slice-'+i));
  const results=await Promise.all(jobs.map(job=>job.promise));
  assert.deepEqual(results.map(row=>row.text),Array.from({length:6},(_,i)=>'slice-'+i));
  const batches=f.events.filter(row=>row.category==='batch-bus'&&row.name==='batch-job-created');
  assert.equal(batches.length,1,'compatible scheduled work must reach the real batch router as one parent');
  assert.equal(batches[0].data.batchCount,6);
  assert.deepEqual([...new Set(f.calls.map(row=>row.slot))].sort(),['A','B']);
  assert(f.calls.every(row=>row.options.telemetry.batchParentJobId),'physical attempts carry real batch-parent attribution');
  assert.equal(f.scheduler.busy.size,0);assert.equal(f.queue.running.size,0);
});

test('an owner bulk workload scatters independent slices and admits each completion before publication',async()=>{
  const slow=gate(),fast=gate();
  const f=await fixture(async(slot,options)=>{await (slot==='A'?slow:fast).promise;return {text:JSON.stringify({text:options.prompt})};});
  let writes=0;
  const rows=f.jobs.createPostTurnJobTable({'memory.summaryBranch':async(_input,ctx)=>{
    const results=await f.batch.runNexusModelWorkerBatch({domain:'memory-bank',stage:'summary',role:'summaries',requestedBatch:true,
      items:Array.from({length:5},(_,i)=>'summary-'+i),
      buildRequest:item=>({prompt:item,schedulerLane:'postTurn',preemptible:false,mainEligible:false,nexusScope:f.captureScope()}),
      parse:text=>JSON.parse(text),validate:(value,item)=>value.text===item,
      dispatchUnits:input=>f.worker.dispatchNexusModelWorkerUnits({...input,enqueue:(_domain,stage,options)=>ctx.enqueue(stage,options)})});
    return ctx.enqueue.publish(results,result=>result.completed.length===5&&!result.failed.length,()=>{writes++;return {summaries:results.completed.map(row=>row.value.text)};});
  }});
  const running=f.runtime.runJobTable(rows,{scope:f.captureScope(),enqueue:(stage,options)=>f.worker.enqueueNexusModelWorkerJob('memory-bank',stage,options),yieldHost:async()=>{},emit:(category,name,data)=>f.events.push({category,name,data})});
  try{
    await until(()=>f.calls.length===2);
    assert.deepEqual([...new Set(f.calls.map(call=>call.slot))].sort(),['A','B']);
    fast.resolve();await until(()=>f.calls.length===5);
    assert.equal(f.calls.find(call=>call.slot==='A').event,'started');assert.equal(writes,0);
  }finally{fast.resolve();slow.resolve();}
  const result=await running;
  assert.equal(result[0].status,'fulfilled');assert.deepEqual([...result[0].value.summaries],Array.from({length:5},(_,i)=>'summary-'+i));assert.equal(writes,1);
  assert.equal(f.events.filter(row=>row.name==='gather.verdict').length,7,'five call boundaries, publication, and final result are independently admitted');
  assert.equal(f.scheduler.busy.size,0);
});

test('a stale owner batch cancels its unfinished sibling before any durable publication',async()=>{
  const slow=gate(),fast=gate();let fresh=true,writes=0;
  const f=await fixture(async(slot,options)=>{await (slot==='A'?slow:fast).promise;return {text:options.prompt};});
  const rows=f.jobs.createPostTurnJobTable({'memory.summaryBranch':async(_input,ctx)=>{
    const results=await f.worker.dispatchNexusModelWorkerUnits({domain:'memory-bank',stage:'summary',role:'summaries',
      units:Array.from({length:4},(_,i)=>({id:'slice-'+i,request:{prompt:'slice-'+i,schedulerLane:'postTurn',preemptible:false,mainEligible:false,nexusScope:f.captureScope()}})),
      enqueue:(_domain,stage,options)=>ctx.enqueue(stage,options)});
    return ctx.enqueue.publish(results,()=>true,()=>{writes++;return {updated:true};});
  }});
  const running=f.runtime.runJobTable(rows,{scope:f.captureScope(),isFresh:()=>fresh,enqueue:(stage,options)=>f.worker.enqueueNexusModelWorkerJob('memory-bank',stage,options),yieldHost:async()=>{fresh=false;}});
  await until(()=>f.calls.length===2);fast.resolve();
  const result=await running;slow.resolve();
  assert.equal(result[0].value.stale,true);assert.equal(writes,0);assert.equal(f.calls.length,2);
  await until(()=>f.scheduler.busy.size===0&&f.queue.running.size===0);
  assert.equal(f.scheduler.waiters.length,0);
});

test('uneven batches refill the fast sidecar while the slow sidecar still works',async()=>{
  const slow=gate(),fast=gate();
  const f=await fixture(async(slot,options)=>{await (slot==='A'?slow:fast).promise;return {text:options.prompt};});
  const jobs=['slow','fast','next-1','next-2','next-3'].map(prompt=>f.enqueue(prompt));
  await until(()=>f.calls.length===2);
  assert.equal(f.scheduler.busy.size,2,'both physical worker leases belong to the scheduler');
  fast.resolve();await until(()=>f.calls.length===5);
  const slowCall=f.calls.find(row=>row.slot==='A');assert.equal(slowCall.event,'started');
  assert(f.calls.slice(2).every(row=>row.slot==='B'));
  slow.resolve();const results=await Promise.all(jobs.map(row=>row.promise));
  assert.deepEqual(results.map(row=>row.text),['slow','fast','next-1','next-2','next-3']);
});

test('separate compatible groups use a free peer instead of queuing every parent on A',async()=>{
  const blocker=gate();const f=await fixture(async(_slot,options)=>{await blocker.promise;return {text:options.prompt};});
  const jobs=[f.enqueue('retrieval-work'),f.worker.enqueueNexusModelWorkerJob('memory-bank','summary',{prompt:'summary-work',role:'summaries',schedulerLane:'postTurn',mainEligible:false,nexusScope:f.captureScope()})];
  try{await until(()=>f.calls.length===2);assert.deepEqual([...new Set(f.calls.map(call=>call.slot))].sort(),['A','B']);}
  finally{blocker.resolve();await Promise.all(jobs.map(job=>job.promise));}
});

test('configured multi-worker mode bypasses adaptive collection without a batch mode conflict',async()=>{
  const f=await fixture();f.settings.routing.modes.retrieval='parallel';
  const result=await f.enqueue('configured-mode').promise;
  assert.equal(result.text,'configured-mode');assert.equal(f.events.filter(row=>row.name==='batch-mode-conflict').length,0);
});

test('an explicit operator lock keeps every collected slice on B',async()=>{
  const f=await fixture();f.settings.routing.locks.retrieval='B';
  const results=await Promise.all(['locked-1','locked-2','locked-3'].map(prompt=>f.enqueue(prompt).promise));
  assert.deepEqual(results.map(result=>result.text),['locked-1','locked-2','locked-3']);
  assert(f.calls.every(call=>call.slot==='B'));assert.equal(f.scheduler.busy.size,0);
});

test('cancelling one slice preserves siblings and cancels queued physical reservations',async()=>{
  const blocker=gate();const f=await fixture(async(_slot,options)=>{await blocker.promise;return {text:options.prompt};});
  const prompts=['one','two','cancel-me','four'],jobs=prompts.map(prompt=>f.enqueue(prompt));
  await until(()=>f.calls.length===2);
  const index=prompts.findIndex(prompt=>!f.calls.some(row=>row.options.prompt===prompt));
  const cancelled=assert.rejects(jobs[index].promise);jobs[index].cancel('operator cancelled this slice');
  await cancelled;blocker.resolve();await Promise.all(jobs.filter((_row,i)=>i!==index).map(row=>row.promise));
  assert(!f.calls.some(row=>row.options.prompt===prompts[index]));
  assert.equal(f.scheduler.busy.size,0);assert.equal(f.scheduler.waiters.length,0);assert.equal(f.queue.running.size,0);
});

test('chat changes discard a collected batch before any physical call',async()=>{
  const f=await fixture();const jobs=['old-one','old-two'].map(prompt=>f.enqueue(prompt));
  const settled=Promise.allSettled(jobs.map(row=>row.promise));
  f.setContext({chatId:'story-b',chat:[],chatMetadata:{}});f.scope.invalidateNexusChatScope('chat-changed');
  const results=await settled;assert(results.every(row=>row.status==='rejected'));assert.equal(f.calls.length,0);
});

test('foreground work gets the next free slot ahead of queued batch slices',async()=>{
  const slow=gate(),fast=gate(),foreground=gate();
  const f=await fixture(async(slot,options)=>{await (options.prompt==='foreground'?foreground:slot==='A'?slow:fast).promise;return {text:options.prompt};});
  const jobs=['slow','fast','next'].map(prompt=>f.enqueue(prompt));await until(()=>f.calls.length===2);
  const urgent=f.enqueue('foreground',{schedulerLane:'foreground',foregroundAdjacent:true,priority:100});
  await until(()=>f.scheduler.waiters.some(row=>row.request.lane==='foreground'));fast.resolve();
  await until(()=>f.calls.length===3);assert.equal(f.calls[2].options.prompt,'foreground');
  foreground.resolve();slow.resolve();await Promise.all([...jobs.map(row=>row.promise),urgent.promise]);
});

test('gathered A/B results reach the typed generation outlet once and cannot amend a sealed frame',async()=>{
  const f=await fixture();f.delivery.beginGenerationFrame({generationId:'delivery'});
  const responses=await Promise.all(['fact-A','fact-B'].map(text=>f.enqueue(text).promise));
  assert.deepEqual([...new Set(responses.map(row=>row.tv2.slot))].sort(),['A','B']);
  const content=responses.map(row=>row.text).join('\n');
  assert.equal(f.ports.publishRetrievalLoreOutlet({generationId:'delivery',status:'ready',content,refs:[{book:'book-a',uid:1},{book:'book-a',uid:2}]}).accepted,true);
  f.delivery.sealAndApplyGenerationFrame({generationId:'delivery'});
  const sealed=f.frame.getGenerationFrameSnapshot();
  assert.equal(sealed.outlets['retrieval-lore'].content,content);
  const before=JSON.stringify(f.frame.getGenerationFrameSnapshot());
  assert.equal(f.ports.publishRetrievalLoreOutlet({generationId:'delivery',status:'ready',content:'late replacement'}).accepted,false);
  assert.equal(JSON.stringify(f.frame.getGenerationFrameSnapshot()),before);
  const delivered=f.prompts.filter(row=>row.text);
  assert.equal(delivered.length,1,'the real frame authority inserts one host prompt');
  assert.equal(delivered[0].text.split('fact-A').length-1,1);
  assert.equal(delivered[0].text.split('fact-B').length-1,1);
});

test('a burst larger than one wave retains every slice within bounded physical batches',async()=>{
  let active=0,max=0;const f=await fixture(async(_slot,options)=>{active++;max=Math.max(max,active);await tick();active--;return {text:options.prompt};});
  const expected=Array.from({length:25},(_,i)=>'large-'+i),results=await Promise.all(expected.map(text=>f.enqueue(text).promise));
  assert.deepEqual(results.map(row=>row.text),expected);assert.equal(f.calls.length,25);assert.equal(max,2);
  const batches=f.events.filter(row=>row.name==='batch-job-created');
  assert(batches.length>=3);assert(batches.every(row=>row.data.batchCount<=10));
  assert.equal(batches.reduce((sum,row)=>sum+row.data.batchCount,0),25);
  assert(f.events.some(row=>row.name==='adaptive-wave-observed'&&row.data.successfulItems>1));
});

test('one available sidecar completes the whole batch without losing coverage',async()=>{
  const f=await fixture();f.profiles.B.enabled=false;
  const results=await Promise.all(Array.from({length:5},(_,i)=>f.enqueue('single-'+i).promise));
  assert.equal(results.length,5);assert(f.calls.every(row=>row.slot==='A'));assert.equal(f.calls.length,5);
});

test('disabling collection runs individual scheduler-owned calls with the normal result shape',async()=>{
  const f=await fixture();f.settings.nexus.batchLayer.enabled=false;
  const results=await Promise.all(['one','two','three'].map(text=>f.enqueue(text).promise));
  assert.deepEqual(results.map(row=>row.text),['one','two','three']);
  assert(f.events.filter(row=>row.name==='batch-job-created').every(row=>row.data.batchCount===1));
  assert.equal(f.scheduler.busy.size,0);assert.equal(f.queue.running.size,0);
});

test('a permanent slice failure does not discard or duplicate successful siblings',async()=>{
  const f=await fixture(async(_slot,options)=>{if(options.prompt==='bad')throw Object.assign(new Error('invalid candidate'),{retryable:false});return {text:options.prompt};});
  const results=await Promise.allSettled(['good-one','bad','good-two'].map(text=>f.enqueue(text).promise));
  assert.deepEqual(results.map(row=>row.status),['fulfilled','rejected','fulfilled']);
  assert.equal(f.calls.length,3);assert.equal(results[0].value.text,'good-one');assert.equal(results[2].value.text,'good-two');
  const result=f.events.find(row=>row.name==='batch-job-complete');assert.equal(result.data.completedCount,2);assert.equal(result.data.failedCount,1);
});

test('a timed out single slice recovers once on the other worker through its batch parent',async()=>{
  const f=await fixture(async(slot,options)=>{if(slot==='A')throw Object.assign(new Error('timeout'),{name:'TV2SidecarTimeout'});return {text:options.prompt};});
  assert.equal((await f.enqueue('retry').promise).text,'retry');
  assert.deepEqual(f.calls.map(row=>row.slot),['A','B']);
  assert(f.calls.every(row=>row.options.telemetry.batchParentJobId));assert.equal(f.scheduler.busy.size,0);
});

test('a foreground loan pauses a collected batch before it takes physical queue locks',async()=>{
  const f=await fixture();f.scheduler.loan('generation');f.queue.foregroundStarted('generation');
  const jobs=['held-one','held-two'].map(text=>f.enqueue(text));
  await until(()=>f.scheduler.waiters.length===2);
  assert.equal(f.calls.length,0);assert.equal(f.scheduler.busy.size,0);assert.equal(f.queue.running.size,0);
  assert.equal((await f.enqueue('urgent',{schedulerLane:'foreground',foregroundAdjacent:true}).promise).text,'urgent');
  f.queue.foregroundEnded('generation');f.scheduler.resume('generation');await Promise.all(jobs.map(row=>row.promise));
  assert.equal(f.calls.length,3);assert.equal(f.scheduler.busy.size,0);
});

test('cancelling a parent waiting for foreground leaves no reservations or provider calls',async()=>{
  const f=await fixture();f.scheduler.loan('generation');
  const jobs=['cancel-one','cancel-two'].map(text=>f.enqueue(text));const settled=Promise.allSettled(jobs.map(row=>row.promise));
  await until(()=>f.scheduler.waiters.length===2);for(const job of jobs)job.cancel();
  assert((await settled).every(row=>row.status==='rejected'));
  await until(()=>f.scheduler.waiters.length===0&&f.batch.getNexusBatchStatus().totalOutstandingUnits===0);
  assert.equal(f.calls.length,0);assert.equal(f.scheduler.busy.size,0);f.scheduler.resume('generation');
});

test('different book source identities never enter the same batch parent',async()=>{
  const f=await fixture();const jobs=['book-a','book-b'].flatMap(book=>Array.from({length:2},(_,i)=>f.enqueue(book+'-'+i,{nexusScope:{...f.captureScope(),sourceBooks:[book]}})));
  await Promise.all(jobs.map(row=>row.promise));
  const parents=new Map();for(const call of f.calls){const id=call.options.telemetry.batchParentJobId;if(!parents.has(id))parents.set(id,[]);parents.get(id).push(call.options.prompt);}
  assert.equal(parents.size,2);assert([...parents.values()].every(rows=>rows.every(text=>text.startsWith(rows[0].slice(0,6)))));
});

test('an edit while a batch is running rejects old results and never starts old pending slices',async()=>{
  const held=gate(),f=await fixture(async(_slot,options)=>{await held.promise;return {text:options.prompt};});
  const jobs=['old-1','old-2','old-3','old-4'].map(text=>f.enqueue(text)),settled=Promise.allSettled(jobs.map(row=>row.promise));
  await until(()=>f.calls.length===2);f.scope.invalidateNexusChatScope('source-edited');held.resolve();
  assert((await settled).every(row=>row.status==='rejected'));assert.equal(f.calls.length,2);assert.equal(f.scheduler.busy.size,0);
});
