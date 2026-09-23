import assert from 'node:assert/strict';
import { ContinuableWorkStore } from '../nexus/continuable-work.js';

// Completed execution units survive hydration and are never replayed.
let durable=[];let executed=[];
const persist=async(_record,snapshot)=>{durable=structuredClone(snapshot)};
let store=new ContinuableWorkStore({onCheckpoint:persist,now:(()=>{let n=100;return()=>++n;})()});
store.create({workId:'w1',ownerSubsystem:'smart-warm',sourceProof:{rev:'a'},units:['u1','u2']});
let r=await store.advance('w1',{maxUnits:1,isFresh:proof=>proof.rev==='a',executeUnit:async id=>{executed.push(id);return {id};}});
assert.deepEqual(executed,['u1']);
assert.deepEqual(r.completedUnitIds,['u1']);
store=new ContinuableWorkStore({initialRecords:durable,onCheckpoint:persist});
r=await store.advance('w1',{maxUnits:2,isFresh:proof=>proof.rev==='a',executeUnit:async id=>{executed.push(id);return {id};}});
assert.deepEqual(executed,['u1','u2']);
assert.equal(r.state,'complete');

// A failed PRE-execution checkpoint never calls the executor.
let preCalls=0;
store=new ContinuableWorkStore({onCheckpoint:async(_record,_snapshot,meta)=>{if(meta.phase==='unit-execution-intent')throw new Error('quota');}});
store.create({workId:'pre',ownerSubsystem:'housekeeper',units:['scan']});
await assert.rejects(()=>store.advance('pre',{executeUnit:async()=>{preCalls++;}}),e=>e.name==='TV2ContinuableCheckpointUnavailable'&&!e.effectMayHaveCommitted);
assert.equal(preCalls,0);

// A failed POST-effect checkpoint becomes recovery-required. Reload must not
// turn the indeterminate unit back into replayable pending work.
let persisted=[];let calls=0;let failCompletion=true;
const fragile=async(_record,snapshot,meta)=>{
  if(meta.phase==='unit-complete'&&failCompletion){failCompletion=false;throw new Error('storage full');}
  persisted=structuredClone(snapshot);
};
store=new ContinuableWorkStore({onCheckpoint:fragile});
store.create({workId:'post',ownerSubsystem:'housekeeper',units:['book:A']});
await assert.rejects(()=>store.advance('post',{executeUnit:async()=>{calls++;return {reviewed:true};}}),e=>e.name==='TV2ContinuableCheckpointUnavailable'&&e.effectMayHaveCommitted);
assert.equal(calls,1);
assert.equal(store.get('post').state,'recovery-required');
store=new ContinuableWorkStore({initialRecords:persisted,onCheckpoint:fragile});
assert.equal(store.get('post').state,'recovery-required');
const deferred=await store.advance('post',{executeUnit:async()=>{calls++;}});
assert.equal(deferred.recoveryRequired,true);
assert.equal(calls,1);
await store.resolveRecovery('post','book:A',{outcome:'complete',result:{reviewed:true},receipt:{verified:true}});
const finished=await store.advance('post',{executeUnit:async()=>{calls++;}});
assert.equal(finished.state,'complete');
assert.equal(calls,1);

// Once execution has started, an unknown thrown failure is indeterminate by
// default. It cannot silently become replayable pending work.
let indeterminateCalls=0;let indeterminateDurable=[];
store=new ContinuableWorkStore({onCheckpoint:async(_record,snapshot)=>{indeterminateDurable=structuredClone(snapshot);}});
store.create({workId:'indeterminate',ownerSubsystem:'housekeeper',units:['review']});
await assert.rejects(()=>store.advance('indeterminate',{executeUnit:async()=>{indeterminateCalls++;throw new Error('connection dropped after send');}}),/connection dropped/);
assert.equal(store.get('indeterminate').state,'recovery-required');
store=new ContinuableWorkStore({initialRecords:indeterminateDurable});
const held=await store.advance('indeterminate',{executeUnit:async()=>{indeterminateCalls++;}});
assert.equal(held.recoveryRequired,true);
assert.equal(indeterminateCalls,1);

console.log('PASS #202 continuable work durability / no replay');
