import assert from 'node:assert/strict';
import fs from 'node:fs';
import { interpretSmartContextWarmReviewDecision, SMART_CONTEXT_DECISION_MAX_CANDIDATES } from '../smart-context/decision-site.js';

const candidates=Array.from({length:6},(_,index)=>({book:'Lore',uid:index+1,title:`C${index+1}`,score:100-index}));
const answer=value=>({type:'noul',value,probability:value});
const score=(value,confidence=0.9)=>({type:'score',value,score:value,confidence});
const result={
  ok:true,stale:false,provider:'openrouter-jev',providerClass:'typed-decision',
  answers:{
    warm_budget:{type:'choice',value:'FLOOR',choice:'FLOOR',confidence:0.9},
    candidate_1_relevant:answer(0.91),candidate_1_current_scene_value:answer(0.94),candidate_1_next_beat_value:score(1),
    candidate_2_relevant:answer(0.88),candidate_2_current_scene_value:answer(0.22),candidate_2_next_beat_value:score(4),
    candidate_3_relevant:answer(0.75),candidate_3_current_scene_value:answer(0.35),candidate_3_next_beat_value:score(3),
    candidate_4_relevant:answer(0.18),candidate_4_current_scene_value:answer(0.12),candidate_4_next_beat_value:score(0),
    candidate_5_relevant:answer(0.20),candidate_5_current_scene_value:answer(0.14),candidate_5_next_beat_value:score(1),
    candidate_6_relevant:answer(0.15),candidate_6_current_scene_value:answer(0.10),candidate_6_next_beat_value:score(0),
  },
};
const interpreted=interpretSmartContextWarmReviewDecision(result,{candidates,warmBudget:1,warmBudgetFloor:1});
assert.equal(interpreted.handled,true);
assert.equal(interpreted.warmBudget,2,'distinct current-scene and next-beat evidence must be allowed to widen a nominal floor of one');
assert.deepEqual(interpreted.selected.map(row=>row.uid),[1,2],'quality fence must preserve current-place and next-beat diversity');
assert.deepEqual(interpreted.semanticSelected.map(row=>row.uid),[1,2]);
assert.equal(interpreted.deterministicFill.length,0);

const overlapResult={...result,answers:{...result.answers,
  candidate_1_next_beat_value:score(4),
  candidate_2_next_beat_value:score(3),
}};
const overlap=interpretSmartContextWarmReviewDecision(overlapResult,{candidates,warmBudget:1,warmBudgetFloor:1});
assert.equal(overlap.warmBudget,2,'one obvious current card may not satisfy both current and next-beat lanes when a distinct next beat is supported');
assert.deepEqual(overlap.selected.map(row=>row.uid),[1,2]);
assert.ok(overlap.continuitySelected.some(row=>row.uid===1),'Jev success must retain an explicit current-scene continuity lane');

const lowBudgetOnly={...result,answers:{...result.answers,warm_budget:{type:'choice',value:'FLOOR',choice:'FLOOR',confidence:0.2}}};
const lowBudget=interpretSmartContextWarmReviewDecision(lowBudgetOnly,{candidates,warmBudget:1,warmBudgetFloor:1});
assert.equal(lowBudget.handled,false,'low-confidence breadth must fail open even when candidate scores look decisive');
assert.equal(lowBudget.reason,'low-confidence');

const broad={...result,answers:{...result.answers,warm_budget:{type:'choice',value:'SIX',choice:'SIX',confidence:0.9}}};
const broadResult=interpretSmartContextWarmReviewDecision(broad,{candidates,warmBudget:2,warmBudgetFloor:2});
assert.equal(broadResult.warmBudget,6);
assert.equal(broadResult.selected.length,6,'Jev broadening must preserve the physical warm frontier with deterministic fill');
assert.ok(broadResult.semanticSelected.some(row=>row.uid===1));
assert.ok(broadResult.semanticSelected.some(row=>row.uid===2));

const ambiguousAnswers={warm_budget:{type:'choice',value:'FLOOR',choice:'FLOOR',confidence:0.4}};
for(let i=1;i<=3;i+=1){
  ambiguousAnswers[`candidate_${i}_relevant`]=answer(0.5);
  ambiguousAnswers[`candidate_${i}_current_scene_value`]=answer(0.5);
  ambiguousAnswers[`candidate_${i}_next_beat_value`]=score(2,0.2);
}
const low=interpretSmartContextWarmReviewDecision({ok:true,stale:false,provider:'openrouter-jev',providerClass:'typed-decision',answers:ambiguousAnswers},{candidates:candidates.slice(0,3),warmBudget:2,warmBudgetFloor:2});
assert.equal(low.handled,false);
assert.equal(low.reason,'low-confidence','low-confidence Jev must fail open to Sidecar');

const stale=interpretSmartContextWarmReviewDecision({...result,ok:false,stale:true},{candidates,warmBudget:2,warmBudgetFloor:2});
assert.equal(stale.handled,false);
assert.equal(stale.reason,'stale');

const decisionSource=fs.readFileSync(new URL('../smart-context/decision-site.js',import.meta.url),'utf8');
assert.ok(decisionSource.includes("providerPolicy:{fallbackEnabled:false"),'Smart Context Jev authority must not silently fall through to the generic LLM fallback provider');
assert.ok(decisionSource.includes("authority:'bounded-predictive-admission-only'"),'Decision Core authority must remain bounded to predictive admission');

const warmer=fs.readFileSync(new URL('../smart-context/warmer.js',import.meta.url),'utf8');
assert.ok(warmer.includes('protectedOutsideJevCount'),'telemetry must expose that protected authority stayed outside Jev');
assert.ok(warmer.includes('.filter(row => !earnedPinKeys.has(refKey(row)))'),'earned pins must not be offered to Jev as pruneable candidates');
assert.ok(warmer.includes('jevProtectedEarnedKeys'),'Jev omission must not directly decay an already-earned pin');
assert.ok(warmer.includes('decisionFingerprintFor'),'Decision freshness must include the accepted scene/gate fingerprint');
assert.ok(warmer.includes('sceneRevision:'),'Decision freshness must change when accepted Scene Scanner authority changes');
assert.ok(warmer.includes('continuityRefs = interpreted.continuitySelected || []'),'Jev success must preserve the explicit current-scene continuity lane');
assert.ok(warmer.includes('sidecarFallbackUsed: shouldUseSidecar'),'fallback path must remain observable');
assert.ok(SMART_CONTEXT_DECISION_MAX_CANDIDATES>=14,'Jev bound must cover the scanner branching window without truncating diversity');
console.log('Smart Context Jev admission/diversity/fallback: PASS');
