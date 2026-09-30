import test from 'node:test';
import assert from 'node:assert/strict';
import { ownerSteps } from '../scheduler/owner-steps.js';
import { runJobTable } from '../scheduler/runtime.js';
import { createPostTurnJobTable } from '../scheduler/jobs.js';
test('two internal model calls yield separately and publication waits for admission',async()=>{
 const calls=[];let writes=0;
 const execute=async({enqueue})=>{
  const a=await enqueue('a',{}).promise;calls.push(a);
  const b=await enqueue('b',{}).promise;calls.push(b);
  return enqueue.publish({valid:true,value:b},value=>value.valid,()=>{writes++;return {value:b};});
 };
 const iterator=ownerSteps(execute,{enqueue:stage=>({promise:Promise.resolve(stage)})});
 const first=await iterator.next();assert.equal(first.value.kind,'MODEL_CALL');assert.deepEqual(calls,[]);
 const second=await iterator.next();assert.equal(second.value.kind,'MODEL_CALL');assert.deepEqual(calls,['a']);
 const third=await iterator.next();assert.equal(third.value.kind,'PUBLICATION');assert.equal(writes,0);
 assert.equal(await third.value.accept(),true);await third.value.publish();
 const done=await iterator.next();assert.equal(done.done,true);assert.equal(writes,1);assert.deepEqual(done.value,{value:'b'});
});
test('scheduler rejects malformed publication before its owner write',async()=>{
 let writes=0;
 const executor=()=>ownerSteps(async({enqueue})=>enqueue.publish({valid:false},value=>value.valid,()=>{writes++;return{};}),{});
 const result=await runJobTable(createPostTurnJobTable({'postturn.review':executor}),{scope:{chatId:'one'},yieldHost:async()=>{}});
 assert.equal(writes,0);assert.equal(result[0].value.reason,'invalid-result');
});
test('installed job table gates every call and owner publication through Gather',async()=>{
 let writes=0;const calls=[],events=[];
 const table=createPostTurnJobTable({'postturn.review':async(_input,ctx)=>{
  await ctx.enqueue('first',{}).promise;await ctx.enqueue('second',{}).promise;
  return ctx.enqueue.publish({valid:true},value=>value.valid,()=>{writes++;return {updated:true};});
 }});
 const result=await runJobTable(table,{scope:{chatId:'one'},enqueue:stage=>({promise:Promise.resolve({stage})}),yieldHost:async()=>calls.push('yield'),emit:(category,name,data)=>events.push({name,data})});
 assert.equal(writes,1);assert.equal(result[0].value.updated,true);
 assert.equal(events.filter(row=>row.name==='gather.verdict').length,4);assert.equal(calls.length,3);
});
test('editing while publication validator runs prevents its owner write',async()=>{
 let fresh=true,writes=0,release;const pending=new Promise(resolve=>release=resolve);
 const executor=()=>ownerSteps(async({enqueue})=>enqueue.publish({valid:true},async()=>{fresh=false;release();await pending;return true;},()=>{writes++;return{};}),{});
 await runJobTable(createPostTurnJobTable({'postturn.review':executor}),{scope:{chatId:'one'},isFresh:()=>fresh,yieldHost:async()=>{}});
 assert.equal(writes,0);
});
test('parallel requests inside an owner start only one physical call per generator step',async()=>{
 const started=[];
 const iterator=ownerSteps(async({enqueue})=>Promise.all([enqueue('a',{}).promise,enqueue('b',{}).promise]),{enqueue:stage=>{started.push(stage);return {promise:Promise.resolve(stage)};}});
 await iterator.next();assert.deepEqual(started,['a']);await iterator.next();assert.deepEqual(started,['a','b']);
 assert.deepEqual((await iterator.next()).value,['a','b']);
});
test('failed calls also yield before an owner retry starts',async()=>{
 const started=[];
 const iterator=ownerSteps(async({enqueue})=>{try{await enqueue('bad',{}).promise;}catch{}return enqueue('retry',{}).promise;},{enqueue:stage=>{started.push(stage);return {promise:stage==='bad'?Promise.reject(new Error('provider')):Promise.resolve('ok')};}});
 await iterator.next();assert.deepEqual(started,['bad']);await iterator.next();assert.deepEqual(started,['bad','retry']);assert.equal((await iterator.next()).value,'ok');
});

test('publication failure closes the owner iterator and releases its lease',async()=>{
 let released=false;
 const rows=createPostTurnJobTable({'postturn.review':async(_input,ctx)=>{
  try{return await ctx.enqueue.publish({},()=>true,()=>{throw new Error('write failed');});}
  finally{released=true;}
 }});
 const result=await runJobTable(rows,{scope:{chatId:'one'},enqueue:()=>({promise:Promise.resolve({})}),yieldHost:async()=>{}});
 assert.equal(result[0].status,'rejected');assert.equal(released,true);
});

test('post-turn completion does not relabel an admitted owner write as stale',async()=>{
 let revision=1,writes=0;
 const rows=createPostTurnJobTable({'postturn.review':async(_input,ctx)=>ctx.enqueue.publish({},()=>true,()=>{revision++;writes++;return {updated:true};})});
 const result=await runJobTable(rows,{scope:{chatId:'one',revision:1},isFresh:()=>revision===1,enqueue:()=>({promise:Promise.resolve({})}),yieldHost:async()=>{}});
 assert.equal(writes,1);assert.equal(result[0].value.updated,true);
});
