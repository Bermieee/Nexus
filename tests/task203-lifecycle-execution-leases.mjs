import assert from 'node:assert/strict';
import { LifecycleExecutionLeaseRegistry } from '../lifecycle/execution-leases.js';

let releaseFirst;
const firstGate=new Promise(resolve=>{releaseFirst=resolve});
let firstRuns=0,duplicateRuns=0,newRuns=0;
const registry=new LifecycleExecutionLeaseRegistry();
const first=registry.run({workUnitId:'warm@rev1',conflictKey:'smart-warm:chat1',cycleId:'c1',task:'smart-warm',execute:async()=>{firstRuns++;await firstGate;return 'old';}});
await Promise.resolve();
const duplicate=registry.run({workUnitId:'warm@rev1',conflictKey:'smart-warm:chat1',cycleId:'c2',task:'smart-warm',execute:async()=>{duplicateRuns++;return 'dup';}});
const blocked=await registry.run({workUnitId:'warm@rev2',conflictKey:'smart-warm:chat1',cycleId:'c3',task:'smart-warm',execute:async()=>{newRuns++;return 'new';}});
assert.equal(blocked.deferred,true);
assert.equal(firstRuns,1);assert.equal(duplicateRuns,0);assert.equal(newRuns,0);
registry.invalidateCycle('c1','new revision');
assert.equal(registry.snapshot()[0].logicalInvalidated,true);
assert.equal(registry.snapshot().length,1,'logical invalidation must not release a physical lease');
releaseFirst();
const [a,b]=await Promise.all([first,duplicate]);
assert.equal(a.value,'old');assert.equal(b.value,'old');
assert.equal(registry.snapshot().length,0);
const fresh=await registry.run({workUnitId:'warm@rev2',conflictKey:'smart-warm:chat1',cycleId:'c3',task:'smart-warm',execute:async()=>{newRuns++;return 'new';}});
assert.equal(fresh.value,'new');assert.equal(newRuns,1);

// A newer conflicting unit may wait, but it cannot execute until the physical
// owner actually settles. Logical invalidation does not shorten that boundary.
let releaseWaitOwner;const waitOwnerGate=new Promise(r=>releaseWaitOwner=r);let order=[];
const waitOwner=registry.run({workUnitId:'hk@old',conflictKey:'housekeeper:chat1',cycleId:'old-cycle',task:'housekeeper',execute:async()=>{order.push('old-start');await waitOwnerGate;order.push('old-end');return 'old';}});
await Promise.resolve();
const waiter=registry.run({workUnitId:'hk@new',conflictKey:'housekeeper:chat1',cycleId:'new-cycle',task:'housekeeper',waitForConflict:true,execute:async()=>{order.push('new-start');return 'new';}});
await Promise.resolve();registry.invalidateCycle('old-cycle','superseded');await Promise.resolve();
assert.deepEqual(order,['old-start']);
releaseWaitOwner();await Promise.all([waitOwner,waiter]);
assert.deepEqual(order,['old-start','old-end','new-start']);

// Different targets remain concurrent.
let releaseA,releaseB;const gateA=new Promise(r=>releaseA=r),gateB=new Promise(r=>releaseB=r);let running=0,maxRunning=0;
const pa=registry.run({workUnitId:'a',conflictKey:'smart-warm:chat1',execute:async()=>{running++;maxRunning=Math.max(maxRunning,running);await gateA;running--;}});
const pb=registry.run({workUnitId:'b',conflictKey:'housekeeper:chat1',execute:async()=>{running++;maxRunning=Math.max(maxRunning,running);await gateB;running--;}});
await Promise.resolve();await Promise.resolve();assert.equal(maxRunning,2);releaseA();releaseB();await Promise.all([pa,pb]);
console.log('PASS #203 lifecycle logical/physical lease separation');
