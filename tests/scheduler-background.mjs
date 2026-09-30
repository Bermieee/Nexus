import test from 'node:test';
import assert from 'node:assert/strict';
import { BackgroundScheduler } from '../scheduler/background.js';
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const row=(id,priority,steps)=>({id,lane:'background',priority,inputs:scope=>({...scope}),steps,accept:()=>true,onResult:()=>{}});
test('loan never aborts a call; no new step starts until post-turn closes',async()=>{
 const call=deferred(), calls=[],events=[];
 const scheduler=new BackgroundScheduler({captureScope:()=>({chatId:'one'}),isFresh:()=>true,emit:(name,data)=>events.push({name,data})});
 const task=scheduler.enqueue(row('summary',10,async function*(input,ctx){calls.push('first');await call.promise;yield ctx.checkpoint({position:1});calls.push('second');return 'done';}));
 await tick();scheduler.loan('g1');call.resolve();await tick();
 assert.deepEqual(calls,['first']);assert.equal(scheduler.snapshot().state,'LOANED');assert.equal(scheduler.snapshot().checkpoints,1);
 scheduler.resume('g1');assert.equal(await task,'done');assert.deepEqual(calls,['first','second']);
 assert(events.some(e=>e.name==='scheduler.checkpoint'&&e.data.action==='save'));
});
test('resume selects highest due priority before a paused job',async()=>{
 const calls=[],scheduler=new BackgroundScheduler({captureScope:()=>({chatId:'one'}),isFresh:()=>true});
 const a=scheduler.enqueue(row('low',1,async function*(input,ctx){calls.push('low-first');scheduler.loan('g');yield ctx.checkpoint({position:1});calls.push('low-last');return 'low';}));
 await tick();const b=scheduler.enqueue(row('world',100,async function*(){calls.push('world');return 'world';}));
 scheduler.resume('g');await Promise.all([a,b]);assert.deepEqual(calls,['low-first','world','low-last']);
});
test('stale checkpoint restarts with fresh captured inputs',async()=>{
 let revision=1;const seen=[];
 const scheduler=new BackgroundScheduler({captureScope:()=>({chatId:'one',revision}),isFresh:scope=>scope.revision===revision});
 const work=scheduler.enqueue(row('index',10,async function*(input,ctx){seen.push(input.revision);if(input.revision===1){scheduler.loan('g');yield ctx.checkpoint({position:1});}return input.revision;}));
 await tick();revision=2;scheduler.resume('g');assert.equal(await work,2);assert.deepEqual(seen,[1,2]);
});
test('chat switch drops checkpoints and cannot publish a draining old call',async()=>{
 const call=deferred();let published=0;
 const scheduler=new BackgroundScheduler({captureScope:()=>({chatId:'one'}),isFresh:()=>true});
 const spec=row('index',1,async function*(input,ctx){await call.promise;yield ctx.checkpoint({position:1});return 'old';});spec.onResult=()=>published++;
 const work=scheduler.enqueue(spec);await tick();scheduler.clear('chat-changed');call.resolve();
 await assert.rejects(work,{name:'TV2ScopeInvalidated'});await tick();assert.equal(published,0);assert.equal(scheduler.snapshot().checkpoints,0);
});
test('foreground and post-turn loan identity cannot be retired by an older end',async()=>{
 const scheduler=new BackgroundScheduler();scheduler.loan('old');scheduler.loan('new');
 assert.equal(scheduler.resume('old'),false);assert.equal(scheduler.snapshot().state,'LOANED');assert.equal(scheduler.resume('new'),true);
});
