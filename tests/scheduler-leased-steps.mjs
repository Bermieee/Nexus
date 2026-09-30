import test from 'node:test';
import assert from 'node:assert/strict';
import { leasedSteps } from '../scheduler/leased-steps.js';

test('step checkpoints preserve one physical lease across an ordered owner branch',async()=>{
  let leased=false,releases=0;const seen=[];
  const lease=async execute=>{leased=true;try{return await execute();}finally{leased=false;releases++;}};
  const iterator=leasedSteps(async function*(){seen.push('summary');yield {phase:'promotion'};seen.push('promotion');yield {phase:'routing'};seen.push('routing');return {complete:true};},lease);
  assert.deepEqual((await iterator.next()).value,{phase:'promotion'});assert.equal(leased,true);
  assert.deepEqual(seen,['summary']);
  assert.deepEqual((await iterator.next()).value,{phase:'routing'});assert.equal(leased,true);
  assert.deepEqual(await iterator.next(),{value:{complete:true},done:true});assert.equal(leased,false);assert.equal(releases,1);
});
test('closing a paused generator releases its lease and never starts the next call',async()=>{
  let released=false,calls=0;
  const iterator=leasedSteps(async function*(){calls++;yield {};calls++;},async execute=>{try{return await execute();}finally{released=true;}});
  await iterator.next();await iterator.return();assert.equal(calls,1);assert.equal(released,true);
});
