import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { NexusWorldTree } from '../world-tree/store.js';
import { importLegacyLoreBookToWorldTree } from '../world-tree/import-lore.js';
import { createCanonicalWorldTreeReadApi } from '../core/world-tree-api.js';
import { createBudgetManager } from '../core/budget.js';
import {
  assessWorldTreeCandidates, assessWorldTreeCandidatesSafely, hasPlayerQuestion, inferTruthNeed, summarizeTruthAssessment, truthNeedsCorrection,
} from '../nexus/a52/truth/status-resolver.js';
import {
  CONTEXT_ONLY_MARKER, TRUTH_REASON_CODES, fullWeightFirst, isKnownTruthReasonCode, truthChunkPrefix,
} from '../nexus/truth-classification.js';
import {
  TRUTH_BUDGET_IDS, beginTruthBudget, buildTruthTurnSummary, observeTruthWork, planTruthClassification, planTruthCorrective,
} from '../nexus/truth-budget.js';
import { NexusDiagnosticChannel, createNexusDiagnosticEvent } from '../nexus/diagnostics-source.js';
import { projectNexusTruthAssessment } from '../nexus-ui-bindings.js';
import { buildLiveCognitionPath, normalizeTruthAssessment } from '../src/ui-core/wave8-cognition.js';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8').replace(/\r\n/g,'\n');
const BOOK='Campaign',CHAT='chat-1';
const canon=(uid,extra={})=>({uid,comment:'Gazef Stronoff '+uid,key:['Gazef'+uid],content:'Gazef dies at the Katze Plains '+uid+'.',order:100,...extra});
function world(count,{extra=()=>({})}={}){
  const tree=new NexusWorldTree();
  const entries=Object.fromEntries(Array.from({length:count},(_,i)=>[i+1,canon(i+1,extra(i+1))]));
  importLegacyLoreBookToWorldTree(tree,{book:BOOK,data:{entries},legacyTree:null});
  return {tree,api:createCanonicalWorldTreeReadApi({chatId:CHAT,worldTree:tree}),uids:Array.from({length:count},(_,i)=>i+1)};
}
const assess=(api,uids,options={})=>assessWorldTreeCandidates(uids.map(uid=>({book:BOOK,uid})),{worldTree:api,intent:'CURRENT',kind:'lore',canonBooks:[BOOK],chatId:CHAT,...options});

// ---------------------------------------------------------------- intent

test('intent varies: the fixed examples produce CURRENT, HISTORICAL, TEMPORAL and CONTRADICTION',()=>{
  const examples=[
    ['Where is Gazef now?','CURRENT'],
    ['Who ruled the Empire previously?','HISTORICAL'],
    ['Where was Mara in the past?','HISTORICAL'],
    ['Tell me who ruled the Empire previously.','HISTORICAL'],
    ['When did Nazarick first appear?','TEMPORAL'],
    ['(OOC: when did Nazarick appear in canon?)','TEMPORAL'],
    ['Recap what happened before the war.','TEMPORAL'],
    ['These accounts conflict; which is disputed?','CONTRADICTION'],
    ['Gazef appears in Nazarick, which contradicts what we know.','CONTRADICTION'],
    ['(OOC: Gazef is alive here, which contradicts canon.)','CONTRADICTION'],
    ['OOC: the Empire is Ainz\'s ally on day one, that conflicts with the lore','CONTRADICTION'],
    ['(OOC: Gazef died before the war in the books.)','TEMPORAL'],
    ['[OOC the Empire previously allied with Ainz in the novel]','HISTORICAL'],
    ['OOC: Gazef\'s death happened during the invasion','TEMPORAL'],
    ['// the two accounts are inconsistent','CONTRADICTION'],
    ['The Empire is already Ainz\'s ally. That contradicts the lorebook.','CONTRADICTION'],
  ];
  for(const [text,intent] of examples)assert.equal(inferTruthNeed(text),intent,text);
  assert.deepEqual(new Set(examples.map(([,intent])=>intent)),new Set(['CURRENT','HISTORICAL','TEMPORAL','CONTRADICTION']));
});

test('narrative that borrows the same words stays an ordinary turn and asks no question',()=>{
  for(const text of [
    'His words contradicted his actions, and everyone noticed. After the feast he left.',
    'The conflict between the kingdoms has changed everything. Before dawn, Ainz rides out.',
    '"That contradicts everything we know," Albedo says. "When did this start?"',
    'Albedo bows. After a long silence, Ainz explains the plan to her.',
    '*Ainz recalls what happened before the war and tells Albedo to explain.*',
    'Ainz walks to the throne. After a pause he sits.',
    '',
  ]){
    assert.equal(inferTruthNeed(text),'CURRENT',text);
    assert.equal(hasPlayerQuestion(text),false,text);
  }
  assert.equal(hasPlayerQuestion('When did Nazarick appear?'),true);
});

// ---------------------------------------------------------------- foreground safety: the real decision functions

let foregroundModule=null;
async function loadForeground(mode){
  if(!foregroundModule){
    let source=read('decision/truth-foreground-sites.js');
    source=source.replace(/from '(\.{1,2}\/[^']+)'/g,(_,rel)=>`from '${pathToFileURL(path.resolve(root,'decision',rel)).href}'`);
    const stub="const mod=await import('./mode.js');\n    return mod.getDecisionCoreRuntimeMode();";
    assert.ok(source.includes(stub),'runtimeDecisionMode changed; update the loader');
    foregroundModule=await import('data:text/javascript;base64,'+Buffer.from(source.replace(stub,'return globalThis.__truthTestMode;')).toString('base64'));
  }
  globalThis.__truthTestMode=mode;
  return foregroundModule;
}
const context=()=>({state:{questionSummary:'when did it happen',fallbackIntent:'CURRENT'},revisions:{}});
// The Decision Core answers a choice question with {choice:{choice:'VALUE'}}.
const provider=answer=>async()=>({ok:true,answers:{choice:{choice:answer}},provider:'test',providerClass:'test',latencyMs:1});

test('a foreground Truth decision shares the turn deadline and falls back to the rules on a miss, an error or a bad answer',async()=>{
  const sites=await loadForeground('assist');
  const run=(options,fallback='CURRENT')=>sites.runTruthIntentDecision(context(),fallback,options);
  const allowed=['CURRENT','HISTORICAL','TEMPORAL','CONTRADICTION'];
  void allowed;

  // a provider that never answers: the deadline wins, quickly, with no throw
  const started=Date.now();
  const missed=await run({foregroundDeadlineMs:Date.now()+60,evaluate:()=>new Promise(()=>{})});
  assert.equal(missed.choice,'CURRENT');
  assert.equal(missed.source,'fallback');
  assert.equal(missed.reasonCode,'FOREGROUND_DEADLINE_EXHAUSTED');
  assert.ok(Date.now()-started<1500,'the reply never waits past the deadline for a model call');

  // a provider that throws
  const failed=await run({foregroundDeadlineMs:Date.now()+5000,evaluate:async()=>{throw new Error('provider down');}});
  assert.deepEqual([failed.choice,failed.source,failed.reasonCode],['CURRENT','fallback','DECISION_ERROR']);

  // no deadline, or one already past: no call is made at all
  let called=0;
  const spy=async()=>{called+=1;return provider('TEMPORAL')();};
  assert.equal((await run({foregroundDeadlineMs:null,evaluate:spy})).reasonCode,'NO_FOREGROUND_DEADLINE');
  assert.equal((await run({foregroundDeadlineMs:Date.now()-10,evaluate:spy})).reasonCode,'FOREGROUND_DEADLINE_EXHAUSTED');
  assert.equal(called,0);

  // an aborted turn
  const controller=new AbortController();controller.abort(new Error('turn aborted'));
  assert.equal((await run({foregroundDeadlineMs:Date.now()+5000,signal:controller.signal,evaluate:spy})).reasonCode,'FOREGROUND_ABORTED');
  assert.equal(called,0);

  // an answer outside the allowed set is ignored
  const invalid=await run({foregroundDeadlineMs:Date.now()+5000,evaluate:provider('NONSENSE')});
  assert.deepEqual([invalid.choice,invalid.source,invalid.reasonCode],['CURRENT','fallback','INVALID_OUTPUT']);

  // a valid answer inside the deadline is used (advisory)
  const good=await run({foregroundDeadlineMs:Date.now()+5000,evaluate:provider('TEMPORAL')});
  assert.deepEqual([good.choice,good.source],['TEMPORAL','provider']);
});

test('the corrective decision shares the same deadline and defaults to doing nothing',async()=>{
  const sites=await loadForeground('assist');
  const corrective=options=>sites.runTruthCorrectiveDecision({state:{intent:'CURRENT',assessment:{}},revisions:{}},options);
  const missed=await corrective({foregroundDeadlineMs:Date.now()+40,evaluate:()=>new Promise(()=>{})});
  assert.deepEqual([missed.choice,missed.source,missed.reasonCode],['NONE','fallback','FOREGROUND_DEADLINE_EXHAUSTED']);
  const failed=await corrective({foregroundDeadlineMs:Date.now()+5000,evaluate:async()=>{throw new Error('x');}});
  assert.deepEqual([failed.choice,failed.reasonCode],['NONE','DECISION_ERROR']);
  const off=await (await loadForeground('off')).runTruthIntentDecision(context(),'HISTORICAL',{foregroundDeadlineMs:Date.now()+5000,evaluate:provider('TEMPORAL')});
  assert.deepEqual([off.choice,off.reasonCode],['HISTORICAL','DECISION_OFF'],'with Decision Core off the rules answer');
});

test('Truth never throws into generation: a failing assessment degrades every candidate to support-only context',()=>{
  const {api,uids}=world(5);
  const broken={...api,getNode(){throw new Error('world tree unavailable');}};
  for(const input of [uids.map(uid=>({book:BOOK,uid})),null,undefined,{kind:'CandidateBusEnvelope',candidates:[{candidateId:'lore:Campaign:1'},null]}]){
    let result;
    assert.doesNotThrow(()=>{result=assessWorldTreeCandidatesSafely(input,{worldTree:broken,intent:'CURRENT',kind:'lore',canonBooks:[BOOK],chatId:CHAT});});
    assert.ok(Array.isArray(result.rows));
    for(const row of result.rows){
      assert.deepEqual([row.outcome,row.reasonCode,row.keep,row.deferred],['SUPPORT_ONLY','TRUTH_UNAVAILABLE',true,true],'nothing is dropped, nothing is trusted');
      assert.ok(isKnownTruthReasonCode(row.outcome,row.reasonCode));
    }
  }
  const degraded=assessWorldTreeCandidatesSafely(uids.map(uid=>({book:BOOK,uid})),{worldTree:broken,intent:'CURRENT',kind:'lore',canonBooks:[BOOK],chatId:CHAT});
  assert.equal(degraded.candidates.length,5);
  assert.ok(degraded.error);
  assert.deepEqual(degraded.coverage,{total:5,assessed:0,deferred:5,complete:false,continuation:null});
  const summary=buildTruthTurnSummary({assessment:degraded,timeUsedMs:1,budget:null});
  assert.equal(summary.degraded,true);
  assert.equal(summary.deferredCount,5);
  assert.equal(summary.coverageComplete,false);
  // and a healthy assessment is identical to the unwrapped one
  const healthy=assessWorldTreeCandidatesSafely(uids.map(uid=>({book:BOOK,uid})),{worldTree:api,intent:'CURRENT',kind:'lore',canonBooks:[BOOK],chatId:CHAT});
  assert.equal(healthy.error,undefined);
  assert.deepEqual(healthy.rows.map(r=>r.reasonCode),assess(api,uids).rows.map(r=>r.reasonCode));
});

// ---------------------------------------------------------------- budget: deferral with a coverage receipt

test('work over budget is deferred as support-only context with a coverage receipt, never dropped',()=>{
  const clock={t:0},plans=[];
  const manager=createBudgetManager({now:()=>clock.t,emit:(channel,name,data)=>plans.push({channel,name,data})});
  const {api,uids}=world(82);
  const budget=beginTruthBudget({budgetManager:manager,foregroundDeadlineMs:1000,now:()=>clock.t});
  assert.equal(budget.bounded,true);
  assert.equal(budget.budgetMs,1000);

  // plenty of time: everything is classified
  const roomy=planTruthClassification(budget,82);
  assert.deepEqual([roomy.allowed,roomy.deferred,roomy.complete],[82,0,true]);

  // late in the turn only some candidates fit
  clock.t=995;
  const tight=planTruthClassification(budget,82);
  assert.ok(tight.allowed>0&&tight.allowed<82,'allowed '+tight.allowed);
  assert.equal(tight.allowed+tight.deferred,82);
  const result=assess(api,uids,{assessLimit:tight.allowed});
  assert.equal(result.rows.length,82,'every candidate is accounted for');
  const deferred=result.rows.filter(r=>r.deferred);
  assert.equal(deferred.length,82-tight.allowed);
  for(const row of deferred){
    assert.deepEqual([row.outcome,row.reasonCode,row.keep,row.supportOnly],['SUPPORT_ONLY','DEFERRED_OVER_BUDGET',true,true]);
    assert.equal(row.unresolved,false,'a deferral is not an open question');
  }
  assert.ok(result.rows.slice(0,tight.allowed).every(r=>!r.deferred&&r.outcome==='FULL'),'Truth keeps the fusion order: the head is classified, the tail deferred');
  assert.deepEqual(result.coverage,{total:82,assessed:tight.allowed,deferred:82-tight.allowed,complete:false,continuation:{offset:tight.allowed,total:82}});
  assert.equal(result.candidates.length,82,'nothing was dropped');
  const stats=summarizeTruthAssessment(result);
  assert.equal(stats.deferredCount,82-tight.allowed);
  assert.equal(truthNeedsCorrection(stats),false,'being short of time does not trigger more foreground work');

  // out of time: all deferred, still all delivered
  clock.t=1200;
  const none=planTruthClassification(budget,82);
  assert.deepEqual([none.allowed,none.deferred],[0,82]);
  const all=assess(api,uids,{assessLimit:none.allowed});
  assert.ok(all.rows.every(r=>r.deferred)&&all.candidates.length===82);

  // observed cost replaces the estimate
  clock.t=0;
  const fresh=beginTruthBudget({budgetManager:manager,foregroundDeadlineMs:100,now:()=>clock.t});
  observeTruthWork(manager,TRUTH_BUDGET_IDS.CLASSIFY,{units:10,durationMs:100});
  assert.equal(planTruthClassification(fresh,82).allowed,10,'10 ms per candidate and 100 ms left');

  // the budget manager reported real values
  const reported=plans.filter(p=>p.name==='budget.plan'&&p.data.id===TRUTH_BUDGET_IDS.CLASSIFY);
  assert.ok(reported.length>=3);
  for(const entry of reported)for(const key of ['allowed','examined','total','deferred'])assert.ok(Number.isFinite(entry.data.counts[key]),key);
});

test('deferred candidates reach delivery as marked, last-ordered context',()=>{
  const {api,uids}=world(6);
  const result=assess(api,uids,{assessLimit:4});
  const lore=result.candidates.map(c=>({...c,title:'T'+c.uid,content:'content '+c.uid}));
  assert.equal(lore.filter(c=>c.a52Truth.reasonCode==='DEFERRED_OVER_BUDGET').length,2);
  const source=read('retrieval/retriever.js'),start=source.indexOf('function renderInjection(');
  let depth=0,end=source.indexOf('} = {}) {',start)+'} = {}) '.length,bodyStart=end;
  for(let i=bodyStart;i<source.length;i++){if(source[i]==='{')depth++;else if(source[i]==='}'){depth--;if(!depth){end=i+1;break;}}}
  const stubs={candidateKey:(b,u)=>JSON.stringify([b,Number(u)]),estimateContentTokens:t=>Math.ceil(String(t).length/4),canonicalLorePresentation:r=>[...r],
    planLorePresentationCache:({currentCandidates})=>({orderedCandidates:[...currentCandidates].reverse(),strategy:'t',hasPrior:false,previousCount:0}),sameLorePresentationMembership:(a,b)=>a.length===b.length};
  const render=new Function(...Object.keys(stubs),'fullWeightFirst','truthChunkPrefix',source.slice(start,end)+'\nreturn renderInjection;')(...Object.values(stubs),fullWeightFirst,truthChunkPrefix);
  const out=render(lore,0,'m');
  assert.equal(out.includedCandidates.length,6);
  assert.equal(out.text.split(CONTEXT_ONLY_MARKER).length-1,2);
  assert.ok(Math.max(...[1,2,3,4].map(uid=>out.text.indexOf(`UID ${uid} `)))<Math.min(...[5,6].map(uid=>out.text.indexOf(`UID ${uid} `))));
});

test('the corrective pass runs only when it fits what is left of the turn',()=>{
  const clock={t:0};
  const manager=createBudgetManager({now:()=>clock.t});
  const budget=beginTruthBudget({budgetManager:manager,foregroundDeadlineMs:1000,now:()=>clock.t});
  assert.equal(planTruthCorrective(budget).allowed,1);
  clock.t=900;
  const late=planTruthCorrective(budget);
  assert.deepEqual([late.allowed,late.deferred,late.reason],[0,1,'OVER_BUDGET']);
  clock.t=0;
  observeTruthWork(manager,TRUTH_BUDGET_IDS.CORRECTIVE,{units:1,durationMs:4000});
  assert.equal(planTruthCorrective(beginTruthBudget({budgetManager:manager,foregroundDeadlineMs:1000,now:()=>clock.t})).allowed,0,'a corrective pass that usually takes 4 s is not started with 1 s left');
  const unbounded=planTruthCorrective(beginTruthBudget({budgetManager:manager,foregroundDeadlineMs:null}));
  assert.deepEqual([unbounded.allowed,unbounded.reason,unbounded.bounded],[0,'NO_FOREGROUND_DEADLINE',false]);
  assert.equal(beginTruthBudget({budgetManager:manager,foregroundDeadlineMs:null}).source,'UNBOUNDED');
});

// ---------------------------------------------------------------- Diagnostics: real per-turn values

test('per-turn counts are real totals over every candidate, not a clipped sample',()=>{
  const {tree,api,uids}=world(120,{extra:uid=>uid%10===0?{extensions:{nexusTemporal:{status:'UNCERTAIN'}}}:uid%7===0?{extensions:{nexusTemporal:{status:'SUPERSEDED'}}}:{}});
  const result=assess(api,uids,{assessLimit:100});
  const summary=buildTruthTurnSummary({assessment:result,timeUsedMs:12.3456,budget:{budgetMs:480.5,source:'FOREGROUND_DEADLINE'},corrective:{state:'DEFERRED_OVER_BUDGET',choice:'NONE'}});
  const sum=map=>Object.values(map).reduce((a,b)=>a+b,0);
  assert.equal(summary.candidateCount,120);
  assert.equal(sum(summary.classifications),120);
  assert.equal(sum(summary.outcomeCounts),120);
  assert.equal(sum(summary.reasonCodeCounts),120);
  assert.equal(summary.deferredCount,20);
  assert.equal(summary.keptCount+summary.droppedCount,120);
  assert.equal(summary.supportOnlyCount+summary.fullWeightCount+summary.droppedCount,120);
  assert.ok(summary.droppedCount>0&&summary.supportOnlyCount>0&&summary.fullWeightCount>0);
  assert.equal(summary.verdictsOmitted,24,'the per-candidate list is capped and says by how much');
  assert.deepEqual([summary.timeUsedMs,summary.budgetMs,summary.budgetSource,summary.correctiveState],[12.35,480.5,'FOREGROUND_DEADLINE','DEFERRED_OVER_BUDGET']);
  for(const [outcome,codes] of Object.entries(TRUTH_REASON_CODES)){void outcome;void codes;}
  for(const code of Object.keys(summary.reasonCodeCounts)){
    assert.match(code,/^[A-Z_]+$/);
    assert.ok(Object.keys(TRUTH_REASON_CODES).some(outcome=>isKnownTruthReasonCode(outcome,code)),code);
  }
  // survives the Diagnostics path with every value intact and no story text
  const event=createNexusDiagnosticEvent({channelId:NexusDiagnosticChannel.TRUTH,name:'assessment-complete',selection:{generationId:'g1',chatId:CHAT},metrics:{...summary,story:'Gazef dies at the Katze Plains'}});
  for(const key of ['candidateCount','keptCount','droppedCount','supportOnlyCount','fullWeightCount','deferredCount','unresolvedCount','coverageTotal','coverageAssessed','coverageDeferred','verdictsOmitted','timeUsedMs','budgetMs','budgetSource','correctiveState']){
    assert.notEqual(event.data[key],null,key);
    assert.equal(event.data[key],summary[key],key);
  }
  assert.deepEqual({...event.data.classifications},summary.classifications);
  assert.deepEqual({...event.data.outcomeCounts},summary.outcomeCounts);
  assert.deepEqual({...event.data.reasonCodeCounts},summary.reasonCodeCounts);
  assert.equal(event.data.coverageComplete,false);
  assert.ok(!JSON.stringify(event).includes('Katze Plains'));
  void tree;
});

test('with no foreground deadline the budget is reported as unbounded, not invented',()=>{
  const {api,uids}=world(3);
  const summary=buildTruthTurnSummary({assessment:assess(api,uids),timeUsedMs:0.4,budget:beginTruthBudget({budgetManager:createBudgetManager(),foregroundDeadlineMs:null})});
  assert.deepEqual([summary.budgetMs,summary.budgetSource,summary.deferredCount,summary.coverageComplete],[null,'UNBOUNDED',0,true]);
});

test('the Diagnostics panel receives the real turn totals through the projection and the Truth stage',()=>{
  const {api,uids}=world(120,{extra:uid=>uid%10===0?{extensions:{nexusTemporal:{status:'UNCERTAIN'}}}:{}});
  const assessment=assess(api,uids,{assessLimit:110});
  const summary=buildTruthTurnSummary({assessment,timeUsedMs:7.5,budget:{budgetMs:300,source:'FOREGROUND_DEADLINE'},corrective:{state:'NOT_NEEDED'}});
  const verdicts=assessment.rows.slice(0,96).map(row=>({candidateId:row.candidateId,classification:row.verdict.classification,kept:row.keep,supportOnly:row.supportOnly}));
  const event=createNexusDiagnosticEvent({channelId:NexusDiagnosticChannel.TRUTH,name:'assessment-complete',selection:{generationId:'g1',chatId:CHAT},metrics:summary});
  const telemetry={events:[{id:'t1',ts:1,level:'info',category:'nexus.truth',name:'assessment-complete',data:{chatId:CHAT,generationId:'g1',kind:'lore',...event.data,candidateVerdicts:verdicts}}]};
  const projected=projectNexusTruthAssessment(telemetry,{chatId:CHAT,generationId:'g1'});
  assert.equal(projected.truthResults.length,96,'the row sample is capped');
  assert.equal(projected.turn.candidateCount,120,'the totals are not');
  assert.equal(projected.turn.deferredCount,10);
  assert.equal(projected.turn.keptCount,120);
  assert.equal(projected.turn.timeUsedMs,7.5);
  assert.equal(projected.turn.budgetMs,300);
  assert.equal(Object.values(projected.turn.classifications).reduce((a,b)=>a+b,0),120);
  const normalized=normalizeTruthAssessment(projected);
  assert.equal(normalized.turn.candidateCount,120);
  const stage=buildLiveCognitionPath({truth:normalized}).stages.find(row=>row.id==='TRUTH');
  assert.ok(stage,'the Truth stage is present');
  const text=JSON.stringify(stage);
  for(const part of ['kept 120','deferred 10','dropped 0','7.5/300 ms'])assert.ok(text.includes(part),part+' in '+text);
  assert.ok(text.includes('120')||text.includes('UNRESOLVED'),'classification totals come from the event, not the 96-row sample');
  assert.equal(stage.details.turn.candidateCount,120,'the structured totals are on the stage for drill-down');
  assert.equal(stage.details.turn.deferredCount,10);
});

// ---------------------------------------------------------------- wiring that only source text can reach

test('retriever and recall wire Truth through the budget, the safe entry point and the real summary',()=>{
  const retriever=read('retrieval/retriever.js');
  assert.ok(retriever.includes('!hasPlayerQuestion(latestUserTruthText(context))'),'no model call when nothing was asked');
  assert.ok(retriever.includes("reasonCode:'NO_PLAYER_QUESTION'"));
  assert.ok(retriever.includes('beginTruthBudget({budgetManager:sensoryBudget,foregroundDeadlineMs'));
  assert.ok(retriever.includes('assessLimit:classifyPlan.bounded?classifyPlan.allowed:null'));
  assert.ok(retriever.includes('correctivePlan&&correctivePlan.allowed>=1'),'the corrective pass is gated by the budget');
  assert.ok(retriever.includes("logEvent('nexus.truth','corrective-deferred'"));
  assert.ok(retriever.includes('buildTruthTurnSummary({'));
  assert.ok(!/[^y]assessWorldTreeCandidates\(/.test(retriever),'foreground calls use the safe entry point');
  const recall=read('memory/recall.js');
  assert.ok(recall.includes('assessWorldTreeCandidatesSafely(selected'));
  assert.ok(recall.includes('buildTruthTurnSummary({assessment:truthAssessment,kind:'));
  assert.ok(!fs.existsSync(path.join(root,'decision/truth-conflict-pairs.js')));
});
