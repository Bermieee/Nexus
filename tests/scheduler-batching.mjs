// Real Model Worker Bus -> Batch Layer -> Sidecar Bus/Router -> JobQueue.
// Only the host, settings, telemetry sink, and external provider are doubled.
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
if (!vm.SourceTextModule) {
  const run=spawnSync(process.execPath,['--experimental-vm-modules',fileURLToPath(import.meta.url)],{stdio:'inherit'});
  process.exit(run.status??1);
}
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const gate=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const tick=()=>new Promise(r=>setTimeout(r,0));
async function until(predicate){for(let i=0;i<300;i++){if(predicate())return;await new Promise(r=>setTimeout(r,2));}assert.fail('execution did not reach expected boundary');}
async function fixture(provider=async(_slot,options)=>({text:options.prompt}),{lifecycle=false}={}) {
  let context={chatId:'story-a',chat:[],chatMetadata:{}};
  const calls=[],events=[],prompts=[],profiles=Object.fromEntries(['A','B'].map(slot=>[slot,{slot,enabled:true,format:'openai',endpoint:'https://test.invalid/'+slot,model:'test-'+slot,capabilities:{}}]));
  const settings={enabled:true,nexus:{callCenter:{mainModelAccess:false},batchLayer:{enabled:true,coalesceMs:10,maxBatchItems:10,targetInputTokens:7000}},routing:{retrieval:'A',summaries:'A',fallback:true,loadBalance:true,modes:{},locks:{}},jobs:{}};
  const record=(category,name,data,level)=>events.push({category,name,data,level});
  const topology={executionProfile:{workerResources:['A','B'],modelWorkerCount:2,sidecarCount:2}};
  const stubs={
    '../../../st-context.js':{getContext:()=>context},
    '../../../../script.js':{extension_prompt_types:{IN_CHAT:1},extension_prompt_roles:{SYSTEM:0},setExtensionPrompt:(key,text)=>prompts.push({key,text})},
    'core/settings.js':{getSettings:()=>settings,getSidecarProfile:slot=>profiles[slot]},
    'observability/telemetry.js':{logEvent:record,recordJobLifecycle:()=>{},recordWorkloadDecision:()=>{},recordWorkloadFallback:()=>{},recordMultiWorkloadAssignment:()=>{}},
    'observability/system-events.js':{logSystemEvent:record},
    'decision/task8-postturn-sites.js':{TASK8_POSTTURN_SITE_IDS:{},runTask8ChoiceDecision:async(_site,_input,fallback)=>({choice:fallback})},
    'nexus/runtime.js':{getNexusRuntime:()=>topology},
    'sidecar/client.js':{callSidecar:async(profile,options)=>{const call={slot:profile.slot,options,event:'started'};calls.push(call);try{return await provider(profile.slot,options);}finally{call.event='ended';}}},
  };
  let lifecycleStubs=null;
  if(lifecycle){
    settings.scheduler={enabled:true,tasks:{},intervals:{}};settings.memoryBank={enabled:true};
    const skipped=async()=>({skipped:true,reason:'fixture-no-work'});
    // Owner semantics are fixtures; the lifecycle, leases, owner steps, collector,
    // physical scheduler, router, queue and provider dispatch are production modules.
    const owner=stage=>async({enqueueSidecar})=>{
      const response=await enqueueSidecar(stage,{prompt:stage,role:stage==='scene-observation'||stage==='green-room'?'maintenance':'summaries',mainEligible:false}).promise;
      const result={updated:true,path:'sidecar',slot:response.tv2?.slot,operations:1,accepted:1,scene:{sceneId:'scene-test',revision:2}};
      return enqueueSidecar.publish?enqueueSidecar.publish(response,()=>true,()=>result):result;
    };
    lifecycleStubs={
      'postturn/pipeline.js':{drainPostTurn:owner('post-turn')},
      'lifecycle/intelligence.js':{runAutomaticPostTurnLifecycle:owner('post-turn'),runAutomaticLoreRoutingLifecycle:skipped},
      'smart-context/warmer.js':{preWarmSmartContext:skipped},
      'memory/summarizer.js':{createNextSummary:skipped,inspectSummaryEligibility:()=>({due:false}),promoteDueSummaries:skipped},
      'memory/lore-router.js':{routeUnroutedMemories:skipped,routeMemoryToLore:skipped},
      'memory/store.js':{getMemoryRecord:()=>null,memoryStats:()=>({}),currentMemoryBankRevision:()=>0},
      'maintenance/housekeeper.js':{runHousekeeper:skipped,isHousekeeperSuccessfulRun:()=>true},
      'memory/notebook.js':{refreshNotebookFromScene:owner('notebook')},
      'scene/runtime.js':{getSceneAuthority:()=>({gate:{mode:'MAJOR'},sceneScan:{acceptedScene:{participants:[]}}})},
      'nexus/scene-intelligence.js':{runNexusSceneObservationPostTurn:owner('scene-observation'),retractNexusSceneMessage:()=>{}},
      'nexus/green-room.js':{runNexusGreenRoomPostTurn:owner('green-room'),isNexusGreenRoomRefreshDue:()=>true,invalidateNexusGreenRoomForSourceChange:()=>{}},
      'decision/task8-advice.js':{clearTask8PostTurnAdvice:()=>{}},
      'decision/task8-runtime.js':{runTask8PostTurnAdvisoryPass:skipped},
      'retrieval/source-plan.js':{clearRetrievalSourcePlan:()=>{}},
      'world-tree/intake/runtime.js':{drainWorldTreeContributions:skipped},
      'world-tree/card-contribution.js':{runWorldTreeCardContributionJob:skipped},
      'world-tree/scene-contribution.js':{runWorldTreeSceneContributionJob:skipped},
      'world-tree/character-memory.js':{invalidateCharacterMemoriesForMessage:skipped,runCharacterMemoryJob:skipped},
      'world-tree/memory-contribution.js':{runWorldTreeMemoryContributionJob:skipped},
      'nexus/host-durability.js':{mutateChatMetadataDurably:async(_context,_label,_options,mutate)=>mutate()},
      'lore/active-books.js':{getActiveBooks:()=>[]},
      'nexus/lore-source-revision.js':{currentNexusLoreSourceRevision:()=>0},
    };
  }
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
  const linker=(specifier,parent)=>{
    const name=resolve(specifier,parent),stub=['lifecycle/scheduler.js','lifecycle/execution-guard.js'].includes(parent.identifier)?lifecycleStubs?.[name]:null;
    if(!stub)return load(name);
    const key='fixture-lifecycle/'+name;if(cache.has(key))return cache.get(key);
    const mod=new vm.SyntheticModule(Object.keys(stub),function(){for(const [key,value]of Object.entries(stub))this.setExport(key,value);},{identifier:key});cache.set(key,mod);return mod;
  };
  const entry=new vm.SourceTextModule("export * as worker from '../nexus/model-worker-bus.js'; export * as batch from '../nexus/batch-layer.js'; export * as scheduler from '../scheduler/sidecars.js'; export * as queue from '../core/job-queue.js'; export * as scope from '../nexus/work-scope.js'; export * as sidecar from '../sidecar/bus.js'; export * as frame from '../nexus/generation-frame-bus.js'; export * as delivery from '../nexus/generation-frame.js'; export * as ports from '../nexus/generation-frame-ports.js'; export * as jobs from '../scheduler/jobs.js'; export * as runtime from '../scheduler/runtime.js';"+(lifecycle?"export * as lifecycle from '../lifecycle/scheduler.js';":''),{identifier:'tests/entry.js'});
  await entry.link(linker);await entry.evaluate();
  const api=entry.namespace,scheduler=api.scheduler.sidecarScheduler;
  api.scheduler.configureSidecarScheduler({captureScope:()=>api.scope.captureNexusWorkScope(context),isFresh:scope=>api.scope.isNexusWorkScopeFresh(scope,context),emit:(name,data)=>record('scheduler',name,data)});
  const scope=()=>api.scope.captureNexusWorkScope(context);
  const enqueue=(prompt,options={})=>api.worker.enqueueNexusModelWorkerJob('reasoning','search-reasoning',{role:'retrieval',prompt,schedulerLane:'postTurn',preemptible:false,mainEligible:false,nexusScope:scope(),...options});
  return {...api,scheduler,calls,events,prompts,settings,profiles,topology,captureScope:scope,enqueue,queue:api.queue.getJobQueue(settings.jobs),setContext:value=>{context=value;}};
}

async function bounded(work,label){
  let timer;try{return await Promise.race([work,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(label+' stalled')),1000);})]);}
  finally{clearTimeout(timer);}
}

for(const active of ['A','B'])test(`non-collected scheduled jobs use the configured ${active} worker`,async()=>{
  const f=await fixture(async(_slot,options)=>{await new Promise(r=>setTimeout(r,15));return{text:options.prompt};});
  f.profiles[active==='A'?'B':'A'].enabled=false;
  const results=await Promise.all(['first','second'].map(prompt=>f.enqueue(prompt,{batchable:false}).promise));
  assert.deepEqual(results.map(r=>r.text),['first','second']);assert(f.calls.every(c=>c.slot===active));
  assert(f.calls.every(c=>c.options.telemetry.schedulerJobId));
});

test('configured Main-only scheduled work preserves its explicit Main eligibility',async()=>{
  const f=await fixture();f.profiles.A.enabled=false;f.profiles.B.enabled=false;f.settings.nexus.callCenter.mainModelAccess=true;
  f.topology.executionProfile={workerResources:['MAIN'],modelWorkerCount:1,sidecarCount:0};
  const calls=[];f.topology.generationGateway={isConnected:()=>true,snapshot:()=>({busy:false}),dispatchWorker:async request=>{calls.push(request);return{text:request.prompt};}};
  const result=await f.enqueue('Main scheduled',{mainEligible:true}).promise;
  assert.equal(result.text,'Main scheduled');assert.equal(calls.length,1);assert.equal(f.calls.length,0);
});

test('Main-only scheduling cannot grant Main access to a sidecar-only owner',async()=>{
  const f=await fixture();f.profiles.A.enabled=false;f.profiles.B.enabled=false;f.settings.nexus.callCenter.mainModelAccess=true;
  let calls=0;f.topology.generationGateway={isConnected:()=>true,snapshot:()=>({busy:false}),dispatchWorker:async()=>{calls++;return{text:'forbidden'};}};
  await assert.rejects(f.enqueue('Sidecar only',{mainEligible:false}).promise);assert.equal(calls,0);
});

test('A-only background work settles without waiting for an unavailable B lease',async()=>{
  const f=await fixture();f.profiles.B.enabled=false;
  const job=f.enqueue('background A',{schedulerLane:'background',batchable:false});
  try{assert.equal((await bounded(job.promise,'A-only background')).text,'background A');assert.equal(f.calls[0].slot,'A');}
  finally{job.cancel();await Promise.allSettled([job.promise]);}
});

test('four collected post-turn jobs complete on A/B while their lifecycle loan is still held',async()=>{
  const f=await fixture();f.scheduler.loan('cycle-reproduction',{kind:'lifecycle'});
  const jobs=Array.from({length:4},(_,i)=>f.enqueue('cycle-'+i)),work=Promise.all(jobs.map(job=>job.promise));
  try{
    const result=await bounded(work,'cycle-loan batch');
    assert.equal(result.length,4);assert.equal(f.calls.filter(call=>call.slot==='A').length,2);assert.equal(f.calls.filter(call=>call.slot==='B').length,2);
    assert.equal(f.scheduler.snapshot().state,'LOANED');assert.equal(f.scheduler.snapshot().generationId,'cycle-reproduction');
    assert.equal(f.scheduler.busy.size,0);assert.equal(f.scheduler.waiters.length,0);
  }finally{for(const job of jobs)job.cancel();f.scheduler.resume('cycle-reproduction');await Promise.allSettled(jobs.map(job=>job.promise));}
});

test('real lifecycle cycle settles Scene, Green Room, Notebook and extraction through scheduled batches',async()=>{
  const f=await fixture(undefined,{lifecycle:true});
  const work=f.lifecycle.runLifecycleCycle({source:'generation-end',includeNotebook:true,includeSummary:false,includePromotion:false,includeLoreRouting:false,includeSmartWarm:false,includeHousekeeper:false});
  try{
    const cycle=await bounded(work,'installed lifecycle');
    assert.equal(cycle.status,'complete',JSON.stringify(cycle.steps));
    for(const name of ['scene-observation','green-room','notebook','post-turn'])assert(cycle.steps.some(step=>step.name===name&&step.status==='complete'),name);
    assert.deepEqual(f.calls.map(call=>call.options.prompt).sort(),['green-room','notebook','post-turn','scene-observation']);
    assert(f.calls.every(call=>call.options.telemetry.batchParentJobId),'every owner request uses the restored batch path');
    assert.equal(f.scheduler.snapshot().state,'BACKGROUND');assert.equal(f.scheduler.waiters.length,0);assert.equal(f.scheduler.busy.size,0);
    assert.equal(f.queue.running.size,0);assert.equal(f.lifecycle.getSchedulerStatusSummary().activeLogicalCycles,0);
    assert.equal(f.lifecycle.getSchedulerStatusSummary().physicalLeaseCount,0);
  }finally{f.scope.invalidateNexusChatScope('fixture-ended');f.scheduler.clear('fixture-ended');await work;}
});

test('a lifecycle loan still pauses unrelated background work until its cycle settles',async()=>{
  const f=await fixture();f.scheduler.loan('cycle-background',{kind:'lifecycle'});const calls=[];
  const background=f.scheduler.execute({id:'unrelated-background',lane:'background',scope:f.captureScope(),run:async slot=>{calls.push(slot);return 'background';}});
  try{
    assert.equal((await bounded(f.enqueue('cycle-work').promise,'cycle-work')).text,'cycle-work');
    assert.deepEqual(calls,[]);assert.equal(f.scheduler.snapshot().state,'LOANED');
    f.scheduler.resume('cycle-background');assert.equal(await bounded(background,'background resume'),'background');assert.deepEqual(calls,['B']);
  }finally{f.scheduler.clear('fixture-ended');await Promise.allSettled([background]);}
});

test('a new foreground loan holds remaining lifecycle batch slices and cannot be released by the old cycle',async()=>{
  const held=gate(),f=await fixture(async(_slot,options)=>{if(options.prompt!=='urgent')await held.promise;return {text:options.prompt};});
  f.scheduler.loan('old-cycle',{kind:'lifecycle'});
  const jobs=Array.from({length:4},(_,i)=>f.enqueue('cycle-preempt-'+i)),work=Promise.all(jobs.map(job=>job.promise));
  try{
    await until(()=>f.calls.length===2);f.scheduler.loan('new-generation');f.queue.foregroundStarted('new-generation');held.resolve();
    await until(()=>f.scheduler.waiters.length===2&&f.scheduler.busy.size===0);
    assert.equal(f.calls.length,2,'only already-running calls may drain while the new foreground owns the loan');
    assert.equal(f.scheduler.resume('old-cycle'),false);assert.equal(f.scheduler.snapshot().loanKind,'foreground');
    assert.equal((await f.enqueue('urgent',{schedulerLane:'foreground',foregroundAdjacent:true}).promise).text,'urgent');
    assert.equal(f.calls.length,3,'the generation takes a free slot ahead of pending cycle work');
    f.queue.foregroundEnded('new-generation');f.scheduler.resume('new-generation');await bounded(work,'preempted lifecycle batch');
    assert.equal(f.calls.length,5);assert.equal(f.scheduler.waiters.length,0);assert.equal(f.scheduler.busy.size,0);
  }finally{held.resolve();for(const job of jobs)job.cancel();f.queue.foregroundEnded('new-generation');f.scheduler.clear('fixture-ended');await Promise.allSettled(jobs.map(job=>job.promise));}
});

test('completed scheduled work removes its listener from the original caller signal',async()=>{
  const f=await fixture(),caller=new AbortController();
  await f.enqueue('complete-with-signal',{signal:caller.signal}).promise;
  assert.equal(getEventListeners(caller.signal,'abort').length,0);
});

test('cancellation during routing cannot miss the newly created physical handle',async()=>{
  const f=await fixture(),caller=new AbortController(),reason=Object.assign(new Error('operator cancelled during routing'),{name:'TV2BatchCancelled'});
  Object.defineProperty(f.topology,'executionProfile',{get(){caller.abort(reason);return {workerResources:['A','B'],modelWorkerCount:2,sidecarCount:2};}});
  const job=f.enqueue('cancel-before-physical-assignment',{signal:caller.signal});
  await assert.rejects(job.promise,error=>error===reason);
  assert.equal(f.calls.length,0);assert.equal(getEventListeners(caller.signal,'abort').length,0);
  assert.equal(f.scheduler.busy.size,0);
});

test('a chat switch during routing never recaptures the new story for an old request',async()=>{
  const f=await fixture();
  Object.defineProperty(f.topology,'executionProfile',{get(){f.setContext({chatId:'story-b',chat:[],chatMetadata:{}});return {workerResources:['A','B'],modelWorkerCount:2,sidecarCount:2};}});
  const job=f.worker.enqueueNexusModelWorkerJob('reasoning','search-reasoning',{prompt:'old-story-request',role:'retrieval',schedulerLane:'postTurn',preemptible:false,mainEligible:false});
  await assert.rejects(job.promise,error=>['TV2ScopeInvalidated','TV2BatchCancelled'].includes(error.name));
  assert.equal(f.calls.length,0,'old prompt must never be dispatched with newly captured story authority');
  const created=f.events.filter(row=>row.name==='batch-job-created');
  assert.equal(created.length,0,'the existing captured scope must fail before a physical parent is admitted');
});

test('production Scene/World Tree task domains cross the canonical batch boundary',async()=>{
  const f=await fixture();
  const requests=[['green-room','green-room','maintenance'],['world-tree-card','postturn-memory','postTurn'],['worldtree-card','postturn-memory','postTurn'],['world-tree-memory','postturn-memory','postTurn'],['worldtree-memory','postturn-memory','postTurn'],['character-memory','character-memory','summaries']];
  const results=await Promise.all(requests.map(([domain,stage,role])=>f.worker.enqueueNexusModelWorkerJob(domain,stage,{prompt:domain,role,schedulerLane:'postTurn',mainEligible:false,nexusScope:f.captureScope()}).promise));
  assert.deepEqual(results.map(result=>result.text),requests.map(row=>row[0]));assert.equal(f.calls.length,requests.length);
  assert(f.calls.every(call=>requests.some(row=>row[0]===call.options.telemetry.modelWorkerDomain)),'physical-domain adaptation preserves original producer attribution');
});

test('unrecognized producer domains still fail before a provider call',async()=>{
  const f=await fixture();
  await assert.rejects(f.worker.enqueueNexusModelWorkerJob('unregistered-producer','summary',{role:'summaries',prompt:'reject',schedulerLane:'postTurn',mainEligible:false,nexusScope:f.captureScope()}).promise,error=>error.name==='TV2UnknownBatchDomain');
  assert.equal(f.calls.length,0);
});

test('a background owner batch retains B-only execution and holds publication through a foreground loan',async()=>{
  const first=gate();let bCalls=0,writes=0;
  const f=await fixture(async(slot,options)=>{if(slot==='B'&&++bCalls===1)await first.promise;return {text:options.prompt};});
  const owner=f.scheduler.enqueueOwner({id:'tree-background',inputs:()=>({}),
    enqueue:(stage,request)=>f.worker.enqueueNexusModelWorkerJob('tree',stage,request),
    execute:async(_input,enqueue)=>{
      const result=await f.worker.dispatchNexusModelWorkerUnits({domain:'tree',stage:'tree-build',role:'treeBuild',
        units:Array.from({length:3},(_,i)=>({id:'node-'+i,request:{prompt:'node-'+i,mainEligible:false}})),enqueue:(_domain,stage,request)=>enqueue(stage,request)});
      return enqueue.publish(result,rows=>rows.length===3&&rows.every(row=>row.response),()=>{writes++;return {processed:3};});
    }});
  await until(()=>f.calls.length===1);f.scheduler.loan('foreground-test');first.resolve();
  await until(()=>f.scheduler.background.queue[0]?.pending);
  assert.equal(f.calls.length,1);assert.equal(writes,0);
  await f.enqueue('urgent-during-background',{schedulerLane:'foreground',foregroundAdjacent:true}).promise;
  assert.equal(f.calls[1].slot,'A');assert.equal(writes,0);
  f.scheduler.resume('foreground-test');assert.equal((await owner).processed,3);
  assert(f.calls.filter(call=>call.options.prompt.startsWith('node-')).every(call=>call.slot==='B'));
  assert.equal(writes,1);assert.equal(f.scheduler.busy.size,0);
});

test('Builder-style independent batches run without a chat and survive an unrelated chat selection',async()=>{
  const hold=gate();const f=await fixture(async(_slot,options)=>{await hold.promise;return {text:JSON.stringify({node:options.prompt})};});
  f.setContext({chatId:null,chat:[],chatMetadata:{}});
  const building=f.batch.runNexusModelWorkerBatch({domain:'tree',stage:'tree-build',role:'treeBuild',scopeKind:'independent',requestedBatch:true,
    items:['node-1','node-2','node-3','node-4'],buildRequest:item=>({prompt:item,scopeKind:'independent',mainEligible:false}),
    parse:text=>JSON.parse(text),validate:(value,item)=>value.node===item,dispatchUnits:input=>f.worker.dispatchNexusModelWorkerUnits(input)});
  await until(()=>f.calls.length===2);f.setContext({chatId:'unrelated-story',chat:[],chatMetadata:{}});f.scope.invalidateNexusChatScope('selection-changed');hold.resolve();
  const result=await building;assert.equal(result.failed.length,0);assert.deepEqual([...result.completed.map(row=>row.value.node)],['node-1','node-2','node-3','node-4']);
});

test('Main-only Builder execution remains available when explicitly configured in the isolated fixture',async()=>{
  const f=await fixture();f.profiles.A.enabled=false;f.profiles.B.enabled=false;f.settings.nexus.callCenter.mainModelAccess=true;
  f.topology.executionProfile={workerResources:['MAIN'],modelWorkerCount:1,sidecarCount:0};
  const mainCalls=[];f.topology.generationGateway={isConnected:()=>true,snapshot:()=>({busy:false}),dispatchWorker:async request=>{mainCalls.push(request);return {text:JSON.stringify({node:request.prompt})};}};
  const result=await f.batch.runNexusModelWorkerBatch({domain:'tree',stage:'tree-build',role:'treeBuild',requestedBatch:true,
    items:['main-1','main-2','main-3'],buildRequest:item=>({prompt:item,mainEligible:true,nexusScope:f.captureScope()}),
    parse:text=>JSON.parse(text),validate:(value,item)=>value.node===item,dispatchUnits:input=>f.worker.dispatchNexusModelWorkerUnits(input)});
  assert.equal(result.failed.length,0);assert.equal(result.completed.length,3);assert.equal(mainCalls.length,3);assert.equal(f.calls.length,0);
});

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
