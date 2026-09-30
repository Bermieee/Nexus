import test from 'node:test';
import assert from 'node:assert/strict';
import { selectSceneJobs } from '../scheduler/planner.js';
import { createPostTurnJobTable } from '../scheduler/jobs.js';
import { runJobTable } from '../scheduler/runtime.js';

test('gate selects Scene and Green Room independently of legacy review',()=>{
  assert.deepEqual(selectSceneJobs({gate:{mode:'NO_CHANGE'}}).jobIds,[]);
  assert.deepEqual(selectSceneJobs({gate:{mode:'NO_CHANGE'},greenRoomDue:true}).jobIds,['greenroom.infer']);
  for(const mode of ['MINOR_CHANGE','MAJOR_CHANGE'])assert.deepEqual(selectSceneJobs({gate:{mode}}).jobIds,['scene.observe','greenroom.infer']);
  const edit=selectSceneJobs({eventType:'MESSAGE_EDITED',messageIndex:3});
  assert.equal(edit.messageIndex,3);assert.equal(edit.invalidateFirst,true);
  assert.deepEqual(selectSceneJobs({eventType:'CHAT_CHANGED'}).jobIds,[]);
});
test('Green Room waits for Scene to finish while all jobs stay inside two-job dispatch',async()=>{
  let sceneDone=false,active=0,peak=0;
  const work=async()=>{active++;peak=Math.max(peak,active);await new Promise(resolve=>setTimeout(resolve,1));active--;};
  const result=await runJobTable(createPostTurnJobTable({
    'scene.observe':async()=>{await work();sceneDone=true;return {sceneRevision:2};},
    'greenroom.infer':async()=>{assert.equal(sceneDone,true);await work();return {accepted:1};},
    'postturn.review':async()=>{await work();return {};},
  }),{scope:{},isFresh:()=>true,yieldHost:async()=>{}});
  assert.equal(peak,2);assert.deepEqual(result.map(row=>row.id),['scene.observe','greenroom.infer','postturn.review']);
  assert.ok(result.every(row=>row.status==='fulfilled'));
});
test('invalidation after Scene prevents Green Room from starting',async()=>{
  let fresh=true,calls=0;
  const result=await runJobTable(createPostTurnJobTable({
    'scene.observe':async()=>{fresh=false;return {};},'greenroom.infer':async()=>{calls++;return {};},
  }),{scope:{},isFresh:()=>fresh,yieldHost:async()=>{}});
  assert.equal(calls,0);assert.equal(result[1].value.stale,true);
});
