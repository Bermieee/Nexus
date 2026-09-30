import test from 'node:test';
import assert from 'node:assert/strict';
import { SchedulerGather } from '../scheduler/gather.js';
const row={id:'scene',accept:value=>!value?.partial};
test('READY publishes once, INVALID keeps no partial result, STALE drops',async()=>{
 let fresh=true;const gather=new SchedulerGather([row],{scope:{chatId:'one'},isFresh:()=>fresh});
 assert.equal((await gather.accept('scene',{partial:true})).verdict,'INVALID');assert.equal(gather.bundle().acceptedResultIds.length,0);
 fresh=false;assert.equal((await gather.accept('scene',{ok:true})).verdict,'STALE');assert.equal(gather.bundle().acceptedResultIds.length,0);
 fresh=true;assert.equal((await gather.accept('scene',{ok:true})).verdict,'READY');assert.equal(gather.bundle().acceptedResultIds.length,1);
});
test('deadline closes quorum, retains fresh LATE output for a subsequent frame only',async()=>{
 let now=0,fresh=true;const late=new Map(),gather=new SchedulerGather([row],{scope:{chatId:'one'},deadline:10,now:()=>now,isFresh:()=>fresh,late});
 now=11;assert.equal((await gather.accept('scene',{ok:true})).verdict,'LATE');assert.equal(gather.bundle().acceptedResultIds.length,0);assert.equal(gather.bundle().closeReason,'HARD_DEADLINE');
 assert.deepEqual(gather.takeLate('scene'),{ok:true});assert.equal(gather.takeLate('scene'),null);
 await gather.accept('scene',{ok:'later'});fresh=false;assert.equal(gather.takeLate('scene'),null);assert.equal(late.size,0);
});
test('an edit while async validation runs cannot publish its old result',async()=>{
 let fresh=true,release;const wait=new Promise(r=>release=r);
 const gather=new SchedulerGather([{id:'scene',accept:async()=>{await wait;return true;}}],{scope:{},isFresh:()=>fresh});
 const accepting=gather.accept('scene',{ok:true});fresh=false;release();assert.equal((await accepting).verdict,'STALE');assert.equal(gather.bundle().acceptedResultIds.length,0);
});
