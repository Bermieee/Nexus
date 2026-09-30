import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { NEXUS_MIGRATED_WORKLOAD } from '../nexus/director-migration.js';

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
  const env={captureNexusWorkScope:()=>({epoch:1}),getContext:()=>({chatId:'one'}),isNexusWorkScopeFresh:()=>true,
    logEvent:()=>{},setTimeout:fn=>{callbacks.push(fn);return callbacks.length;},clearTimeout:()=>{},
    runAutomaticLifecycle:async(...args)=>{calls.push(args);}};
  const api=new Function('env',`const {${Object.keys(env).join(',')}}=env;let automaticLifecycleTimer=null,automaticLifecycleScope=null,foregroundActive=true;const pendingAutomaticLifecycleSources=new Map();${source.slice(start,end)};return {scheduleAutomaticLifecycle,setForeground:value=>{foregroundActive=value;}};`)(env);
  api.scheduleAutomaticLifecycle({source:'scene-edit',eventType:'MESSAGE_EDITED',messageIndex:1});
  callbacks.shift()();assert.equal(calls.length,0);
  api.setForeground(false);api.scheduleAutomaticLifecycle({source:'scene-edit',eventType:'MESSAGE_SWIPED',messageIndex:3});
  callbacks.shift()();await new Promise(resolve=>setTimeout(resolve,0));
  assert.deepEqual(calls.map(row=>row[1].messageIndex),[1,3]);
});
