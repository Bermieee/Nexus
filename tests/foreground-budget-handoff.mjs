import test from 'node:test';
import assert from 'node:assert/strict';
import * as handoff from '../core/foreground-budget.js';
test('foreground reservations come from measured sibling jobs and host prompt room',async()=>{
  let now=0;const tracker=handoff.createForegroundBudgetTracker({now:()=>now});
  assert.deepEqual(tracker.reservations(['foreground-memory']),[]);
  await tracker.run('foreground-memory',async()=>{now=20;return{ready:true};});
  await tracker.run('foreground-bootstrap',async()=>{now=25;return{ready:true};});
  assert.deepEqual(tracker.reservations(['foreground-memory','foreground-bootstrap']),[{id:'foreground-memory',ms:20},{id:'foreground-bootstrap',ms:5}]);
  assert.deepEqual(handoff.sensoryPromptRoom({contextTokens:32000,outletTokens:4000}),{contextTokens:32000,tokenShare:.125});
  assert.equal(handoff.sensoryPromptRoom({contextTokens:null,outletTokens:0}),null);
});
