import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkDirector } from '../nexus/work-director.js';
import { planLifecycleJobs } from '../scheduler/planner.js';

test('Director delegates lifecycle planning to the shared planner without changing its decisions',()=>{
  const director=new WorkDirector({now:()=>123});
  const plan=director.buildPlan({previous:{assistantTurns:0},current:{assistantTurns:1,changeClass:'major',notebookDue:true,summaryDue:true,promotionDue:true,loreRoutingDue:true,maintenanceDue:true,activeActors:['Mara']}});
  assert.deepEqual(plan.jobs.map(row=>row.type),['smart-warm','post-turn-extract','notebook-refresh','character-bank-refresh','summary','summary-promotion','lore-routing','maintenance']);
  assert.deepEqual(plan.jobs.map(row=>row.priority),[80,70,65,60,55,52,50,25]);
  assert.deepEqual(plan.jobs.find(row=>row.type==='summary-promotion').dependencies,[plan.jobs.find(row=>row.type==='summary').id]);
  assert.deepEqual(plan.jobs.find(row=>row.type==='lore-routing').dependencies,[plan.jobs.find(row=>row.type==='summary-promotion').id]);
  assert.equal(typeof planLifecycleJobs,'function');
  assert.equal(plan.metadata.plannedAt,123);
  assert.equal(director.snapshot().length,1);
});
test('stable scene cadence and disabled policies retain old behavior',()=>{
  const director=new WorkDirector();
  const current={changeClass:'none',assistantTurns:1,smartWarmDue:false,postTurnDue:false};
  assert.equal(director.buildPlan({previous:{assistantTurns:1},current}).jobs.length,0);
  const plan=director.buildPlan({current:{...current,postTurnDue:true},policy:{postTurn:false}});
  assert.equal(plan.jobs.length,0);
  assert.ok(plan.decisions.some(row=>row.job==='post-turn-extract'&&row.reason==='disabled by policy'));
});
