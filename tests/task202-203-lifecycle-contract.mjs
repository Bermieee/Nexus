import fs from 'node:fs';
import assert from 'node:assert/strict';
const read=path=>fs.readFileSync(new URL('../'+path,import.meta.url),'utf8');
const bridge=read('nexus/lifecycle-bridge.js');
const scheduler=read('lifecycle/scheduler.js');
const guard=read('lifecycle/execution-guard.js');
const memory=read('memory/store.js');

assert.match(bridge,/runCheckpointedLifecycleTask/);
assert.match(bridge,/NEXUS_MIGRATED_WORKLOAD\.SMART_WARM\|\|type===NEXUS_MIGRATED_WORKLOAD\.MAINTENANCE/);
assert.doesNotMatch(bridge,/completedWorkMemo/);
assert.match(bridge,/runLifecyclePhysicalLease/);

assert.match(scheduler,/const activeCycles=new Map\(\)/);
assert.match(scheduler,/physicalLeases:getLifecyclePhysicalLeaseSnapshot\(\)/);
assert.doesNotMatch(scheduler,/if\(activeCycle\)return null/);
assert.doesNotMatch(scheduler,/reason:'already-running'/);
assert.doesNotMatch(scheduler,/pendingAutomaticCycle|queueAutomaticCatchup|dispatchAutomaticCatchup/);
assert.match(scheduler,/runCheckpointedTask\(cycle,'smart-warm'/);
assert.match(scheduler,/runCheckpointedTask\(cycle,'housekeeper'/);
assert.match(scheduler,/runTaskWithPhysicalLease\(cycle,'summary'/);

// Generic execution completion is explicitly not Summary/Digest coverage.
assert.match(guard,/CHECKPOINTABLE_LIFECYCLE_TASKS[^\n]+smart-warm[^\n]+maintenance[^\n]+housekeeper/);
assert.doesNotMatch(guard,/CHECKPOINTABLE_LIFECYCLE_TASKS[^\n]+summary/);
assert.match(guard,/coverageAuthority:false/);
assert.doesNotMatch(guard,/lc-authority'\s*,\s*\{session:/,'durable completion identity must not be runtime-session scoped');
assert.match(guard,/lc-authority'\s*,\s*\{caller:/,'checkpoint authority must remain stable across reload');
assert.match(memory,/coverageReceipts/);
assert.match(memory,/preserveCoverage/);
assert.match(memory,/restoreMemoryCoverageFromRecord/);

console.log('PASS #202/#203 lifecycle ownership + coverage boundary contract');
