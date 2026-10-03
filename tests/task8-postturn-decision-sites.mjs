import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createBudgetManager } from '../core/budget.js';
import { createSensoryTurnPlan } from '../retrieval/source-plan.js';

const read=path=>fs.readFileSync(new URL('../'+path,import.meta.url),'utf8');

test('Task 8 post-turn Decision Core sites are registered as bounded advisory Assist sites',()=>{
  const sites=read('decision/task8-postturn-sites.js');
  for(const id of [
    'scheduler.runGreenRoom','scheduler.observeOnMinor','scheduler.backgroundOrder',
    'truth.conflict','walker.anchor','scene.boundary','scene.pathConflict',
    'hot.threadState','greenroom.surface','greenroom.reflect',
    'worldtree.supersede','worldtree.identity','worldtree.suggestTrack','retrieval.sourcePlan',
  ])assert.ok(sites.includes("'"+id+"'"),'missing Task 8 site '+id);
  assert.ok(sites.includes('mode:DECISION_MODE.ASSIST'));
  assert.ok(sites.includes("authority:'advisory-only'"));
  assert.ok(sites.includes('canonicalMutation:false'));
  assert.ok(sites.includes('createDecisionFreshnessContract'));
  assert.ok(sites.includes('POST_TURN_TIMEOUT_MS=5000'));
});

test('retrieval source plan remains ephemeral, invalidatable and budget-scaling rather than absolute',()=>{
  const plan=read('retrieval/source-plan.js');
  for(const token of [
    "NO_CHANGE","hot:'lead'","walker:'shallow'","vector:'narrow'",
    "MAJOR","hot:'light'","walker:'deep'","vector:'wide'",
    "HISTORICAL","TEMPORAL","CONTRADICTION",
    "clearWorkingState(RETRIEVAL_SOURCE_PLAN_KIND",
  ])assert.ok(plan.includes(token),'source-plan contract missing '+token);
  assert.ok(plan.includes("skip:0"),'skip must be a multiplier that removes source work');
  const retriever=read('retrieval/retriever.js');
  assert.ok(retriever.includes("createBudgetManager"));
  const manager=createBudgetManager({now:()=>0});
  const input={budgetManager:manager,timeMs:10000,worldSize:2000,promptTokens:10000,channelTotals:{lexical:200}};
  const shallow=createSensoryTurnPlan({...input,sourcePlan:{walker:'shallow'}}),deep=createSensoryTurnPlan({...input,sourcePlan:{walker:'deep'}}),skip=createSensoryTurnPlan({...input,sourcePlan:{walker:'skip'}});
  assert.ok(deep.walkerLimits.maxNodes>shallow.walkerLimits.maxNodes);
  assert.equal(skip.walkerLimits.latencyBudgetMs,0);
  assert.ok(skip.channelCandidateLimits.lexical>0);
  assert.equal(skip.latencyBudgetMs,input.timeMs);
  for(const suffix of ['depth','nodes','edges','candidates','milliseconds'])assert.ok(deep.receipts.some(row=>row.id==='walker.'+suffix));
  assert.ok(retriever.includes("channelWeights"));
  const paging=read('paging/lore-paging.js');
  assert.ok(paging.includes("compute('vector.wake'"));
  assert.ok(paging.includes('vectorMultiplier'));
});

test('Task 8 advice is actually consumed and invalidated at freshness boundaries',()=>{
  const lifecycle=read('lifecycle/scheduler.js');
  for(const token of ['OBSERVE_ON_MINOR','RUN_GREEN_ROOM','runTask8PostTurnAdvisoryPass'])assert.ok(lifecycle.includes(token),'scheduler wiring missing '+token);
  assert.ok(lifecycle.includes('return await runTask8ChoiceDecision(siteId,context,fallbackChoice,options)'),'scheduler Task 8 wrapper must call the imported Decision Core executor');
  assert.ok(!lifecycle.includes('try{return await task8Choice(siteId,context,fallbackChoice,options);}'),'scheduler Task 8 wrapper must not recurse into itself');
  const background=read('scheduler/background.js');
  assert.ok(background.includes('BACKGROUND_ORDER'));
  const scene=read('nexus/scene-intelligence.js');
  assert.ok(scene.includes('SCENE_BOUNDARY'));
  assert.ok(scene.includes('SCENE_PATH_CONFLICT'));
  const walker=read('nexus/a52/sensory/walker/world-tree-provider.js');
  assert.ok(walker.includes("advised&&advised!=='SKIP'"));
  const truth=read('nexus/a52/truth/status-resolver.js');
  assert.ok(truth.includes("choice==='REAL_CONFLICT'"));
  const hot=read('nexus/hot-cognition.js');
  assert.ok(hot.includes("choice!=='RESOLVED'"));
  const green=read('nexus/green-room.js');
  assert.ok(green.includes("choice==='INCLUDE'"));
  const task8=read('decision/task8-runtime.js');assert.ok(task8.includes('WORLDTREE_SUGGEST_TRACK'));assert.ok(task8.includes('recordWorldTreeTrackSuggestion'));
  const index=read('index.js');
  assert.ok(index.includes('clearRetrievalSourcePlan'));
  assert.ok(index.includes('clearTask8PostTurnAdvice'));
});

test('post-turn job row stays local and follows Scene/Green Room when present',()=>{
  const jobs=read('scheduler/jobs.js');
  assert.ok(jobs.includes("id:'decision.postTurn'"));
  assert.ok(jobs.includes("needsSidecar:false"));
  assert.ok(jobs.includes("row.id==='decision.postTurn'"));
});
