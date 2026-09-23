import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = path => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');

const batch=read('nexus/batch-layer.js');
const workers=read('nexus/model-worker-bus.js');
const semantic=read('builder2/nexus-semantic.js');
const packing=read('builder2/semantic-packing.js');

// Outer Builder/Batch ownership stays intact.
assert.match(semantic,/packSemanticPhysicalBundles/);
assert.match(semantic,/dispatchNexusModelWorkerUnits/);
assert.match(packing,/targetInputTokens/);
assert.match(batch,/const treeRollingDispatch = normalizedDomain === NEXUS_BATCH_DOMAIN\.TREE && rollingDispatch/);
assert.match(batch,/const continuousPoolDispatch = rollingDispatch && units\.length > 1/);
assert.match(batch,/nexusBatchTreeRollingDispatch: treeRollingDispatch/);

// Only an already-packed Tree rolling-pool physical unit bypasses the nested
// debounce/coalescing queue. It still enters the canonical Sidecar Bus/router.
assert.match(workers,/const directTreePhysicalDispatch=String\(domain\|\|''\)\.trim\(\)\.toLowerCase\(\)==='tree'/);
assert.match(workers,/telemetry\?\.nexusBatchTreeRollingDispatch===true/);
assert.match(workers,/batchable:directTreePhysicalDispatch\?false:unit\.request\?\.batchable/);
assert.match(workers,/modelWorkerDirectTreePhysicalDispatch:directTreePhysicalDispatch/);
assert.match(batch,/options\.batchable === false/);
assert.match(batch,/return enqueueBusJob\(stage,/);

// Do not replace the physical worker pool, routing, adaptive health, or
// validation/recovery authority while removing the redundant wait.
assert.match(workers,/recommendAdaptivePhysicalWorkerPlan/);
assert.match(workers,/const response=await handle\.promise/);
assert.match(workers,/recordAdaptivePhysicalWorkerSample/);
assert.match(batch,/reconcileDispatchRows/);
assert.match(batch,/slice-recovery-start/);

console.log('PASS Tree continuous-pool direct physical dispatch contract');
