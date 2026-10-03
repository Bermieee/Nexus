import test from 'node:test';
import assert from 'node:assert/strict';
import { SidecarScheduler } from '../scheduler/sidecars.js';
const tick=()=>new Promise(r=>setTimeout(r,0));
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
test('a running background call occupies B; foreground uses A and never waits for the loan',async()=>{
 const gate=deferred(),slots=[];const scheduler=new SidecarScheduler();
 const bg=scheduler.execute({id:'bg',lane:'background',scope:{},run:async slot=>{slots.push(slot);await gate.promise;return 'bg';}});
 await tick();scheduler.loan('g');
 assert.equal(await scheduler.execute({id:'fg',lane:'foreground',scope:{},run:async slot=>{slots.push(slot);return 'fg';}}),'fg');
 assert.deepEqual(slots,['B','A']);gate.resolve();await tick();scheduler.resume('g');assert.equal(await bg,'bg');
});
test('provider failure fails over once to the other free slot',async()=>{
 const slots=[],events=[];const scheduler=new SidecarScheduler({emit:(name,data)=>events.push({name,data})});
 const value=await scheduler.execute({id:'turn',lane:'foreground',scope:{},run:async slot=>{slots.push(slot);if(slot==='A'){const e=new Error('unavailable');e.name='TV2SidecarWorkerUnavailable';throw e;}return 'ok';}});
 assert.equal(value,'ok');assert.deepEqual(slots,['A','B']);assert(events.some(e=>e.name==='scheduler.failover'));
});
test('failover does not queue behind an occupied higher priority slot',async()=>{
 const gate=deferred(),scheduler=new SidecarScheduler();scheduler.loan('g');
 const a=scheduler.execute({id:'high-a',lane:'foreground',priority:100,scope:{},run:()=>gate.promise});
 const b=scheduler.execute({id:'low-b',lane:'postTurn',priority:1,scope:{},run:async()=>{const e=new Error('unavailable');e.name='TV2SidecarWorkerUnavailable';throw e;}});
 await assert.rejects(b,{name:'TV2SidecarWorkerUnavailable'});gate.resolve('done');await a;
});
test('a queued foreground job expires without starting a provider call',async()=>{
 const gate=deferred(),scheduler=new SidecarScheduler();scheduler.loan('g');let calls=0;
 const a=scheduler.execute({lane:'foreground',scope:{},run:()=>gate.promise});const b=scheduler.execute({lane:'foreground',scope:{},run:()=>gate.promise});
 await assert.rejects(scheduler.execute({lane:'foreground',scope:{},deadline:Date.now()+15,run:async()=>{calls++;}}),{name:'NexusSchedulerDeadline'});
 assert.equal(calls,0);gate.resolve();await Promise.all([a,b]);
});
test('captured request inputs are never rebound and replayed after an edit',async()=>{
 let revision=1,calls=0;const scheduler=new SidecarScheduler({isFresh:scope=>scope.revision===revision});scheduler.loan('g');
 const request=scheduler.execute({id:'old',lane:'background',scope:{revision:1},run:async()=>{calls++;return 'old';}});
 revision=2;scheduler.resume('g');await assert.rejects(request,{name:'TV2ScopeInvalidated'});assert.equal(calls,0);
});
test('real transport timeouts fail over to a free sidecar',async()=>{
 const calls=[],scheduler=new SidecarScheduler();
 assert.equal(await scheduler.execute({lane:'foreground',scope:{},run:async slot=>{calls.push(slot);if(slot==='A')throw Object.assign(new Error('timeout'),{name:'TV2SidecarTimeout'});return 'recovered';}}),'recovered');assert.deepEqual(calls,['A','B']);
});
test('logical background owner restarts after edit with fresh inputs and does not publish the old result',async()=>{
 let revision=1,writes=[];const calls=[],gate=deferred();
 const scheduler=new SidecarScheduler({captureScope:()=>({chatId:'one',revision}),isFresh:scope=>scope.revision===revision});
 const work=scheduler.enqueueOwner({id:'logical',inputs:scope=>({...scope}),
  enqueue:(stage,options)=>({promise:scheduler.execute({id:'physical',lane:'background',logicalStep:true,scope:options.nexusScope,run:async()=>{calls.push(options.nexusScope.revision);if(options.nexusScope.revision===1)await gate.promise;return options.nexusScope.revision;}})}),
  execute:async(input,enqueue)=>{const value=await enqueue('model',{}).promise;return enqueue.publish(value,value=>value===revision,()=>{writes.push(value);return value;});},
 });
 await tick();scheduler.loan('g');gate.resolve();await tick();revision=2;scheduler.resume('g');
 assert.equal(await work,2);assert.deepEqual(calls,[1,2]);assert.deepEqual(writes,[2]);
});

test('a completed owner publication reports success even when its own write advances the scope',async()=>{
 let revision=1,writes=0;
 const scheduler=new SidecarScheduler({captureScope:()=>({chatId:'one',revision}),isFresh:scope=>scope.revision===revision});
 const work=scheduler.enqueueOwner({id:'self-write',inputs:scope=>({...scope}),enqueue:()=>({promise:Promise.resolve({})}),
 execute:async(_input,enqueue)=>enqueue.publish({},()=>true,()=>{writes++;revision++;if(writes>1)throw new Error('replayed committed publication');return {updated:true};})});
 assert.deepEqual(await work,{updated:true});assert.equal(writes,1);
});

test('post-turn upkeep prefers B, uses A only while B is busy, and fails over to the other slot',async()=>{
 const slots=[];const scheduler=new SidecarScheduler({emit:()=>{}});
 assert.equal(await scheduler.execute({id:'notebook',lane:'postTurn',scope:{},run:async slot=>{slots.push(slot);return 'ok';}}),'ok');
 assert.deepEqual(slots,['B'],'idle sidecars: background upkeep goes to B, not A');
 const gate=deferred(),busy=[];
 const holder=scheduler.execute({id:'holder',lane:'postTurn',scope:{},run:async slot=>{busy.push(slot);await gate.promise;return 'held';}});
 await tick();
 assert.equal(await scheduler.execute({id:'second',lane:'postTurn',scope:{},run:async slot=>{busy.push(slot);return 'second';}}),'second');
 assert.deepEqual(busy,['B','A'],'with B busy the next upkeep job uses A rather than waiting');
 gate.resolve();await holder;
 const tried=[],events=[];const failing=new SidecarScheduler({emit:(name,data)=>events.push(name)});
 assert.equal(await failing.execute({id:'f',lane:'postTurn',scope:{},run:async slot=>{tried.push(slot);if(slot==='B')throw Object.assign(new Error('unavailable'),{name:'TV2SidecarWorkerUnavailable'});return 'recovered';}}),'recovered');
 assert.deepEqual(tried,['B','A']);assert.ok(events.includes('scheduler.failover'));
});
test('the turn in progress still takes A first',async()=>{
 const slots=[];const scheduler=new SidecarScheduler();
 await scheduler.execute({id:'turn',lane:'foreground',scope:{},run:async slot=>{slots.push(slot);return 1;}});
 assert.deepEqual(slots,['A']);
});
