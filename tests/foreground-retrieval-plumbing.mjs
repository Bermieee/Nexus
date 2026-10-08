import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { SidecarScheduler } from '../scheduler/sidecars.js';

const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
function replaceFunction(source,name,body){
 const start=source.indexOf(`async function ${name}(`);assert(start>=0);const open=source.indexOf('){',start)+1;
 let depth=1,end=open+1;for(;depth&&end<source.length;end++){if(source[end]==='{')depth++;else if(source[end]==='}')depth--;}
 return source.slice(0,open+1)+body+source.slice(end-1);
}
let fixtureSequence=0;
async function fixture({provider=async()=>({text:'ok'}),fresh=()=>true}={}){
 const id=++fixtureSequence,key='foregroundPlumbing'+id,calls=[],requests=[];
 let queueCode=fs.readFileSync(new URL('../core/job-queue.js',import.meta.url),'utf8');
 queueCode=queueCode.replace("import { logEvent, recordJobLifecycle } from '../observability/telemetry.js';",'const logEvent=()=>{},recordJobLifecycle=()=>{};');
 const cancellationImport="import { isIntentionalCancellation } from "+"'./cancellation.js';";
 queueCode=queueCode.replace(cancellationImport,`import { isIntentionalCancellation } from '${new URL('../core/cancellation.js',import.meta.url).href}';`);
 const {JobQueue}=await import('data:text/javascript;base64,'+Buffer.from(queueCode).toString('base64'));
 const queue=new JobQueue(),scheduler=new SidecarScheduler({isFresh:fresh});
 queue.foregroundStarted('generation');scheduler.loan('generation');
 globalThis[key]={sidecarScheduler:scheduler,logEvent:()=>{},captureNexusWorkScope:()=>({chatId:'one',generationId:'generation'}),isNexusWorkScopeFresh:fresh,currentNexusChatEpoch:()=>1,
  estimateSidecarCall:()=>({}),resolveAutoReasoningEffort:()=> 'low',resolveSidecarTransportTimeout:()=>1000,
  recordAdaptivePhysicalWorkerSample:()=>{},recommendAdaptivePhysicalWorkerPlan:()=>({}),chooseNexusModelWorkerResource:()=> 'sidecar',isNexusMainPreferredWorker:()=>false,resolveNexusModelWorkerPoolPlan:()=>({}),resolveNexusModelWorkerLanePreference:()=>false,
  dispatch:(_domain,_stage,options)=>{
   requests.push(options);
   return queue.enqueue(async ({signal})=>{calls.push(options.forceSlot);return {...await provider(options.forceSlot,signal),tv2:{slot:options.forceSlot}};},
    {label:options.label,resourceKey:'sidecar:'+options.forceSlot,foregroundAdjacent:options.foregroundAdjacent,generationId:options.nexusScope?.generationId,preemptible:options.preemptible});
  }};
 let code=fs.readFileSync(new URL('../nexus/model-worker-bus.js',import.meta.url),'utf8');
 code=code.replace(/import\s*\{([^}]+)\}\s*from\s*'[^']+';/g,(_,names)=>`const {${names}}=globalThis.${key};`).replace(/export\s*\{[^}]+\}\s*from\s*'[^']+';/g,'');
 code=replaceFunction(code,'getModelWorkerHostContext','return {};');
 code=replaceFunction(code,'canDispatchModelWorkerSidecar','return true;');
 code=code.replace('let sidecarBusModulePromise = null;',"let sidecarBusModulePromise = Promise.resolve({availableSidecarWorkSlots:()=>['A','B'],canBatchSidecarWork:()=>false});");
 code=replaceFunction(code,'runtimeSnapshot','return {runtime:null,gateway:null,snap:{}};');
 code=replaceFunction(code,'enqueueModelWorkerSidecar',`return globalThis.${key}.dispatch(domain,stage,options);`);
 const bus=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
 return {queue,scheduler,calls,requests,enqueue:(options={})=>bus.enqueueNexusModelWorkerJob('reasoning','scene-scan',{label:'Scene Scanner',foregroundAdjacent:true,nexusScope:{chatId:'one',generationId:'generation',schedulerTaskId:'foreground-retrieval',schedulerPlanId:'plan-1'},mainEligible:false,...options}),dispose:()=>delete globalThis[key]};
}

test('foreground Scene scan reaches the actual paused physical queue without deadlocking',async()=>{
 const f=await fixture(),job=f.enqueue();
 try{
  for(let i=0;i<5;i++)await tick();
  assert.deepEqual(f.calls,['A'],'scheduler admission must retain foreground access at the physical queue');
  assert.equal((await job.promise).text,'ok');assert.equal(f.requests[0].foregroundAdjacent,true);
  assert.equal(f.requests[0].telemetry.chatId,'one');assert.equal(f.requests[0].telemetry.generationId,'generation');
  assert.equal(f.requests[0].telemetry.schedulerTaskId,'foreground-retrieval');assert.equal(f.requests[0].telemetry.schedulerPlanId,'plan-1');
  assert.equal(f.queue.pausedForForeground,true);assert.equal(f.scheduler.busy.size,0);
 }finally{job.cancel();await job.promise.catch(()=>{});f.dispose();}
});

test('foreground failover also retains physical queue access on B',async()=>{
 const f=await fixture({provider:async slot=>{if(slot==='A')throw Object.assign(new Error('unavailable'),{name:'TV2SidecarWorkerUnavailable'});return {text:'recovered'};}}),job=f.enqueue();
 try{for(let i=0;i<5;i++)await tick();assert.deepEqual(f.calls,['A','B']);assert.equal((await job.promise).text,'recovered');assert(f.requests.every(row=>row.foregroundAdjacent===true));}
 finally{job.cancel();await job.promise.catch(()=>{});f.dispose();}
});

test('background physical work remains paused while a generation owns foreground',async()=>{
 const f=await fixture(),job=f.enqueue({foregroundAdjacent:false,schedulerLane:'background'});
 try{await tick();assert.deepEqual(f.calls,[]);f.queue.foregroundEnded('generation');f.scheduler.resume('generation');assert.equal((await job.promise).text,'ok');assert.deepEqual(f.calls,['B']);assert.equal(f.requests[0].foregroundAdjacent,false);}
 finally{job.cancel();await job.promise.catch(()=>{});f.dispose();}
});

test('cancelling foreground provider work releases scheduler and physical queue leases',async()=>{
 const f=await fixture({provider:(_slot,signal)=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}))}),job=f.enqueue();
 try{for(let i=0;i<5;i++)await tick();assert.deepEqual(f.calls,['A']);job.cancel(new Error('host stopped'));await assert.rejects(job.promise,/host stopped/);for(let i=0;i<3;i++)await tick();assert.equal(f.scheduler.busy.size,0);assert.equal(f.queue.running.size,0);}
 finally{job.cancel();await job.promise.catch(()=>{});f.dispose();}
});

test('a source edit during execution cannot publish a stale provider result',async()=>{
 let current=true;const gate=deferred(),f=await fixture({fresh:()=>current,provider:async()=>{await gate.promise;return {text:'old'};}}),job=f.enqueue();
 try{for(let i=0;i<5;i++)await tick();assert.deepEqual(f.calls,['A']);current=false;gate.resolve();await assert.rejects(job.promise,{name:'TV2ScopeInvalidated'});assert.equal(f.scheduler.busy.size,0);}
 finally{gate.resolve();job.cancel();await job.promise.catch(()=>{});f.dispose();}
});
