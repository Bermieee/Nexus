import { SidecarScheduler } from '../scheduler/sidecars.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { NEXUS_MIGRATED_WORKLOAD } from '../nexus/director-migration.js';

test('terminal lifecycle releases the foreground loan before awaiting background owners',async()=>{
 const source=fs.readFileSync(new URL('../index.js',import.meta.url),'utf8'),start=source.indexOf('function scheduleAutomaticLifecycle(source)'),end=source.indexOf('async function runAutomaticLifecycle(',start);
 const callbacks=[],calls=[],scheduler=new SidecarScheduler();scheduler.loan('finished');
 let settled=false;
 const env={sidecarScheduler:scheduler,captureNexusWorkScope:()=>({epoch:1}),getContext:()=>({}),isNexusWorkScopeFresh:()=>true,logEvent:()=>{},setTimeout:fn=>{callbacks.push(fn);return 1;},clearTimeout:()=>{},
  runAutomaticLifecycle:async()=>{
   await scheduler.execute({lane:'background',run:async slot=>{calls.push(slot);return 'completed';}});
   settled=true;
  }};
 const api=new Function('env',`const {${Object.keys(env).join(',')}}=env;let automaticLifecycleTimer=null,automaticLifecycleScope=null,foregroundActive=false;const pendingAutomaticLifecycleSources=new Map();${source.slice(start,end)};return {scheduleAutomaticLifecycle};`)(env);
 try{
  api.scheduleAutomaticLifecycle('generation-end');callbacks.shift()();
  await new Promise(resolve=>setTimeout(resolve,30));
  assert.equal(settled,true,'lifecycle must complete without an external scheduler resume');
  assert.deepEqual(calls,['B']);assert.equal(scheduler.snapshot().state,'BACKGROUND');
 }finally{scheduler.clear('test-cleanup');}
});

test('an older lifecycle completion cannot resume a newer foreground generation',async()=>{
 const source=fs.readFileSync(new URL('../index.js',import.meta.url),'utf8'),start=source.indexOf('function scheduleAutomaticLifecycle(source)'),end=source.indexOf('async function runAutomaticLifecycle(',start);
 const callbacks=[],scheduler=new SidecarScheduler();scheduler.loan('old');
 let finish,started=false;const pending=new Promise(resolve=>{finish=resolve;});
 const env={sidecarScheduler:scheduler,captureNexusWorkScope:()=>({epoch:1}),getContext:()=>({}),isNexusWorkScopeFresh:()=>true,logEvent:()=>{},setTimeout:fn=>{callbacks.push(fn);return 1;},clearTimeout:()=>{},runAutomaticLifecycle:async()=>{started=true;await pending;}};
 const api=new Function('env',`const {${Object.keys(env).join(',')}}=env;let automaticLifecycleTimer=null,automaticLifecycleScope=null,foregroundActive=false;const pendingAutomaticLifecycleSources=new Map();${source.slice(start,end)};return {scheduleAutomaticLifecycle,setForeground:value=>{foregroundActive=value;}};`)(env);
 api.scheduleAutomaticLifecycle('generation-end');callbacks.shift()();
 assert.equal(started,true);assert.equal(scheduler.snapshot().state,'BACKGROUND');
 api.setForeground(true);scheduler.loan('new');finish();
 await new Promise(resolve=>setTimeout(resolve,0));
 assert.equal(scheduler.snapshot().state,'LOANED');assert.equal(scheduler.snapshot().generationId,'new');
 scheduler.clear('test-cleanup');
});

test('actual installed generation-end boundary schedules Scene even if Director owns every legacy job',async()=>{
  const source=fs.readFileSync(new URL('../index.js',import.meta.url),'utf8');
  const start=source.indexOf('async function runAutomaticLifecycle(');
  const end=source.indexOf('\nfunction foregroundGenerationAuthorityOpen',start);
  const fn=source.slice(start,end);
  const calls=[];
  const env={NEXUS_MIGRATED_WORKLOAD,validLoadedSourceMessages:()=>[{mes:'reply'}],getContext:()=>({chatId:'one'}),
    ensureSceneAuthority:async()=>{},getSettings:()=>({scheduler:{enabled:true,automatic:true}}),
    planSettledNexusLifecycle:async()=>({handledTypes:Object.values(NEXUS_MIGRATED_WORKLOAD)}),
    shouldRunLegacyWorkload:()=>false,finalizeNexusLifecycleAttempt:()=>{},logEvent:()=>{},
    runLifecycleCycle:async options=>{calls.push(options);return {status:'complete'};}};
  const run=new Function('env',`const {${Object.keys(env).join(',')}}=env;${fn};return runAutomaticLifecycle;`)(env);
  await run('generation-end');
  assert.equal(calls.length,1);assert.equal(calls[0].includePostTurn,false);
  assert.equal(calls[0].includeScene,true);assert.equal(calls[0].includeGreenRoom,true);
  calls.length=0;await run('maintenance');assert.equal(calls.length,0);
  await run('scene-edit',{eventType:'MESSAGE_EDITED',messageIndex:2});
  assert.equal(calls.length,1);assert.equal(calls[0].eventType,'MESSAGE_EDITED');assert.equal(calls[0].messageIndex,2);
  assert.equal(calls[0].includePostTurn,false);assert.equal(calls[0].includeSummary,false);
});

test('installed quiet dispatch retains edits during generation and later runs every affected message',async()=>{
  const source=fs.readFileSync(new URL('../index.js',import.meta.url),'utf8');
  const start=source.indexOf('function scheduleAutomaticLifecycle(source)');
  const end=source.indexOf('async function runAutomaticLifecycle(',start);
  const callbacks=[],calls=[];
  const env={sidecarScheduler:new SidecarScheduler(),captureNexusWorkScope:()=>({epoch:1}),getContext:()=>({chatId:'one'}),isNexusWorkScopeFresh:()=>true,
    logEvent:()=>{},setTimeout:fn=>{callbacks.push(fn);return callbacks.length;},clearTimeout:()=>{},
    runAutomaticLifecycle:async(...args)=>{calls.push(args);}};
  const api=new Function('env',`const {${Object.keys(env).join(',')}}=env;let automaticLifecycleTimer=null,automaticLifecycleScope=null,foregroundActive=true;const pendingAutomaticLifecycleSources=new Map();${source.slice(start,end)};return {scheduleAutomaticLifecycle,setForeground:value=>{foregroundActive=value;}};`)(env);
  api.scheduleAutomaticLifecycle({source:'scene-edit',eventType:'MESSAGE_EDITED',messageIndex:1});
  callbacks.shift()();assert.equal(calls.length,0);
  api.setForeground(false);api.scheduleAutomaticLifecycle({source:'scene-edit',eventType:'MESSAGE_SWIPED',messageIndex:3});
  callbacks.shift()();await new Promise(resolve=>setTimeout(resolve,0));
  assert.deepEqual(calls.map(row=>row[1].messageIndex),[1,3]);
});
test('stale generation-end timer preserves a fresh edit and retires its loan',async()=>{
 const source=fs.readFileSync(new URL('../index.js',import.meta.url),'utf8'),start=source.indexOf('function scheduleAutomaticLifecycle(source)'),end=source.indexOf('async function runAutomaticLifecycle(',start);
 let revision=1;const callbacks=[],calls=[],scheduler=new SidecarScheduler();scheduler.loan('g');
 const env={sidecarScheduler:scheduler,captureNexusWorkScope:()=>({revision}),getContext:()=>({}),isNexusWorkScopeFresh:scope=>scope.revision===revision,logEvent:()=>{},setTimeout:fn=>{callbacks.push(fn);return 1;},clearTimeout:()=>{},runAutomaticLifecycle:async(...args)=>calls.push(args)};
 const api=new Function('env',`const {${Object.keys(env).join(',')}}=env;let automaticLifecycleTimer=null,automaticLifecycleScope=null,foregroundActive=false;const pendingAutomaticLifecycleSources=new Map();${source.slice(start,end)};return {scheduleAutomaticLifecycle};`)(env);
 api.scheduleAutomaticLifecycle('generation-end');revision=2;api.scheduleAutomaticLifecycle({source:'scene-edit',eventType:'MESSAGE_EDITED',messageIndex:1});callbacks.shift()();await new Promise(r=>setTimeout(r,5));
 assert.equal(calls.length,1);assert.equal(calls[0][1].messageIndex,1);assert.equal(scheduler.snapshot().state,'BACKGROUND');
});
