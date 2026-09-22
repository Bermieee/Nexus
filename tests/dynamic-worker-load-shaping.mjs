import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JobQueue } from '../core/job-queue.js';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

const queue = new JobQueue({ maxConcurrent: 2, terminalHistoryLimit: 20 });
let releaseA;
const blocker = queue.enqueue(() => new Promise(resolve => { releaseA = resolve; }), {
  label: 'block A',
  priority: 50,
  resourceKey: 'sidecar:A',
  meta: { assignedSlot:'A' },
});
await wait(0);

const adaptive = queue.enqueue(async ({ job }) => job.resourceKey, {
  label: 'adaptive maintenance',
  priority: 25,
  resourceKey: 'sidecar:A',
  meta: {
    preferredSlot:'A',
    assignedSlot:'A',
    dynamicResource:true,
    resourceCandidates:['sidecar:A','sidecar:B'],
  },
});

const executedResource = await Promise.race([
  adaptive.promise,
  wait(1000).then(() => { throw new Error('Adaptive job stayed queued while Sidecar B was idle.'); }),
]);
assert.equal(executedResource, 'sidecar:B');
assert.equal(adaptive.meta.assignedSlot, 'B');
assert.equal(adaptive.meta.assignmentReason, 'queued-idle-rehome');

releaseA();
await blocker.promise;

const router = fs.readFileSync(new URL('../sidecar/router.js', import.meta.url), 'utf8');
assert.match(router, /dynamicRehome: index === 0 && candidates\.length > 1/);
assert.match(router, /dynamicCandidateSlots: index === 0 \? candidates : \[slot\]/);
assert.match(router, /available\.includes\(slot\)/);

const batch = fs.readFileSync(new URL('../nexus/batch-layer.js', import.meta.url), 'utf8');
assert.match(batch, /const continuousPoolDispatch = rollingDispatch && units\.length > 1/);
assert.match(batch, /physicalShapeReason/);
assert.match(batch, /independent-rolling-pool/);
assert.match(batch, /const recoveryContinuousPool = canScatter && recoveryUnits\.length > 1/);

console.log('Dynamic worker rehome and rolling workload shaping: PASS');
