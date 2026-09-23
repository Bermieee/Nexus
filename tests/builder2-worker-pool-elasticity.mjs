import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  chooseNexusModelWorkerResource,
  resolveNexusModelWorkerPoolPlan,
} from '../nexus/model-worker-policy.js';

const read = path => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const workers = read('nexus/model-worker-bus.js');

// Required topology matrix: physical width is topology-driven, not Builder-driven.
assert.deepEqual(
  resolveNexusModelWorkerPoolPlan({ unitCount: 8, modelWorkerCount: 2, sidecarCount: 1 }),
  { width: 2, hybridMainLane: true, sidecarCount: 1, modelWorkerCount: 2 },
);
assert.deepEqual(
  resolveNexusModelWorkerPoolPlan({ unitCount: 8, modelWorkerCount: 3, sidecarCount: 2 }),
  { width: 3, hybridMainLane: true, sidecarCount: 2, modelWorkerCount: 3 },
);
assert.deepEqual(
  resolveNexusModelWorkerPoolPlan({ unitCount: 8, modelWorkerCount: 1, sidecarCount: 0 }),
  { width: 1, hybridMainLane: false, sidecarCount: 0, modelWorkerCount: 1 },
);
assert.deepEqual(
  resolveNexusModelWorkerPoolPlan({ unitCount: 8, modelWorkerCount: 1, sidecarCount: 1 }),
  { width: 1, hybridMainLane: false, sidecarCount: 1, modelWorkerCount: 1 },
);
assert.deepEqual(
  resolveNexusModelWorkerPoolPlan({ unitCount: 8, modelWorkerCount: 2, sidecarCount: 2 }),
  { width: 2, hybridMainLane: false, sidecarCount: 2, modelWorkerCount: 2 },
);

// Main busy must defer the individual unit to Sidecar without retiring Main
// from the enclosing batch's potential worker topology.
assert.equal(chooseNexusModelWorkerResource({
  mainConfigured: true,
  mainBusy: true,
  sidecarAvailable: true,
  preferMain: true,
}), 'sidecar');

// A Builder batch must remain elastic when Main is physically busy at batch
// start. Individual Model Worker jobs already re-read Main busy/policy state,
// so permanently replacing the hybrid pool with legalSidecars here would make
// Main unable to join after foreground generation releases its lease.
assert.doesNotMatch(
  workers,
  /else if\(snap\?\.busy===true&&legalSidecars\.length\)\{activeWorkers=legalSidecars/,
  'busy Main must not collapse the whole Builder batch to Sidecar-only',
);
assert.match(
  workers,
  /main-busy-elastic-pool/,
  'busy hybrid pool must remain explicitly elastic for later Main availability',
);

// Per-unit routing remains dynamic and authority-gated.
assert.match(workers, /let mainConfigured=mainEligible&&\(await mainPolicyEnabled\(\)\)/);
assert.match(workers, /const \{runtime,gateway,snap\}=await runtimeSnapshot\(\)/);
assert.match(workers, /chooseNexusModelWorkerResource\(\{mainConfigured,mainBusy,sidecarAvailable,preferMain/);
assert.match(workers, /if\(resource==='main'\)/);
assert.match(workers, /if\(resource==='sidecar'\)/);

console.log('PASS Builder 2 elastic Model Worker pool topology contract');
