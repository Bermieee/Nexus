import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createBudgetManager } from '../core/budget.js';
import { createSensoryTurnPlan } from '../retrieval/source-plan.js';
import { NativeGraphNeighborhoodRetriever } from '../nexus/a52/graph-neighborhood-retriever.js';
import { NexusSensoryBackbone } from '../nexus/a52/sensory/backbone.js';

const read=path=>fs.readFileSync(new URL('../'+path,import.meta.url),'utf8');

test('Task 8 foreground Truth sites are registered as bounded Assist Choice sites',()=>{
  const sites=read('decision/truth-foreground-sites.js');
  assert.ok(sites.includes("INTENT:'truth.intent'"));
  assert.ok(sites.includes("CORRECTIVE:'truth.corrective'"));
  assert.ok(sites.includes('mode:DECISION_MODE.ASSIST'));
  assert.ok(sites.includes("subsystem:'truth'"));
  assert.ok(sites.includes("authority:'advisory-only'"));
  assert.ok(sites.includes('canonicalMutation:false'));
  assert.ok(sites.includes("phase:'foreground'"));
  assert.ok(sites.includes('sharesTurnDeadline:true'));
  assert.ok(sites.includes('createDecisionFreshnessContract'));
  assert.ok(!/openrouter-jev|typesafe-direct|llm-fallback/.test(sites),'foreground sites must not call Jev/providers directly');
});

test('truth.intent uses the required enum and inferTruthNeed regex fallback',()=>{
  const sites=read('decision/truth-foreground-sites.js');
  for(const choice of ['CURRENT','HISTORICAL','TEMPORAL','CONTRADICTION'])assert.ok(sites.includes("'"+choice+"'"),'missing intent choice '+choice);
  const resolver=read('nexus/a52/truth/status-resolver.js');
  assert.ok(resolver.includes('export function inferTruthNeed'));
  const retrieval=read('retrieval/retriever.js');
  assert.ok(retrieval.includes('fallbackTruthIntent=inferTruthNeed(latestUserTruthText(context))'),'the regex fallback reads the player message only');
  assert.ok(retrieval.includes('runTruthIntentDecision(intentContext,fallbackTruthIntent'),'the regex answer is still the Decision Core fallback');
  assert.ok(retrieval.includes('runTruthIntentDecision'));
  assert.ok(retrieval.includes('questionSummary'));
  assert.ok(retrieval.includes('intentSource:intentDecision.source'));
});

test('foreground decisions share the existing foreground hard deadline and fail closed to fallback',()=>{
  const sites=read('decision/truth-foreground-sites.js');
  assert.ok(sites.includes('foregroundDeadlineMs'));
  assert.ok(sites.includes("NO_FOREGROUND_DEADLINE"));
  assert.ok(sites.includes("FOREGROUND_DEADLINE_EXHAUSTED"));
  assert.ok(sites.includes('Promise.race'));
  assert.ok(sites.includes('controller.abort'));
  const index=read('index.js');
  assert.ok(index.includes('foregroundDeadlineMs:sidecarScheduler.foregroundDeadline'));
  const retrieval=read('retrieval/retriever.js');
  assert.ok(retrieval.includes('foregroundDeadlineMs = null'));
});

test('truth.corrective executes only with time remaining and accepts only an improving second pass',()=>{
  const sites=read('decision/truth-foreground-sites.js');
  for(const choice of ['NONE','GRAPH_EXPANSION','TEMPORAL_NARROWING','ENTITY_CONSTRAINED_SEARCH','REFORMULATE'])assert.ok(sites.includes("'"+choice+"'"),'missing corrective choice '+choice);
  const retrieval=read('retrieval/retriever.js');
  assert.ok(retrieval.includes('runTruthCorrectiveDecision'));
  assert.ok(retrieval.includes('Number(foregroundDeadlineMs)>Date.now()'));
  assert.ok(retrieval.includes('truthCorrectionImproves'));
  assert.ok(retrieval.includes("correctiveDecision.choice==='GRAPH_EXPANSION'"));
  assert.ok(retrieval.includes("correctiveDecision.choice==='TEMPORAL_NARROWING'"));
  assert.ok(retrieval.includes("correctiveDecision.choice==='ENTITY_CONSTRAINED_SEARCH'"));
  assert.ok(retrieval.includes("correctiveDecision.choice==='REFORMULATE'"));
  assert.ok(retrieval.includes("logEvent('nexus.truth','corrective-pass'"));
});

test('corrective graph work stays inside dynamic budgets and Sensory supports bounded graphTraversal overrides',()=>{
  const manager=createBudgetManager({now:()=>0});
  const plan=createSensoryTurnPlan({budgetManager:manager,timeMs:100,worldSize:2000,promptTokens:100,tokenShare:.5,tokensPerCandidate:10,sourcePlan:{walker:'skip'}});
  assert.equal(plan.walkerLimits.latencyBudgetMs,0);
  assert.ok(plan.correctiveWalkerLimits.latencyBudgetMs>0);
  assert.ok(plan.correctiveWalkerLimits.maxCandidates<=5);
  for(const suffix of ['depth','nodes','edges','candidates','milliseconds'])assert.ok(plan.receipts.some(row=>row.id==='truth.corrective.walker.'+suffix));
  const walker=new NativeGraphNeighborhoodRetriever({temporalGraph:{allClaims:()=>[]}});
  walker.registerProvider({providerId:'test',owner:'WORLD_TREE',isRevisionCurrent:()=>true,query:()=>Array.from({length:4},(_,i)=>({edgeId:'edge:'+i,fromEntityId:'hub',toEntityId:'leaf:'+i,edgeMeaning:'relationship',sourceRevisionRefs:['current'],temporalStatus:'CURRENT'}))});
  const result=new NexusSensoryBackbone().register(walker).retrieveEnvelope({anchorEntityIds:['hub'],latencyBudgetMs:10000,candidateLimit:10,graphTraversal:{maxDepth:2,maxNodes:10,maxEdges:10,maxCandidates:2,latencyBudgetMs:10000}});
  assert.equal(result.candidates.length,2);
  assert.equal(result.envelope.metadata.coverage.complete,false);
  assert.ok(result.envelope.metadata.continuation);
});
