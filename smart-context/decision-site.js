import { DECISION_MODE, DECISION_PROVIDER_CLASS } from '../decision/constants.js';
import { registerDecisionSite, evaluateDecisionSite } from '../decision/site-registry.js';
import { clipDecisionText } from '../decision/site-utils.js';
import { createDecisionFreshnessContract, decisionFreshnessSnapshot } from '../decision/freshness.js';

export const SMART_CONTEXT_WARM_REVIEW_SITE_ID='smart-context.warm-candidate-review.v1';
export const SMART_CONTEXT_DECISION_MAX_CANDIDATES=14;
export const SMART_CONTEXT_JEV_RELEVANCE_FLOOR=0.45;
export const SMART_CONTEXT_JEV_CURRENT_SCENE_FLOOR=0.62;
export const SMART_CONTEXT_JEV_NEXT_BEAT_FLOOR=2;
export const SMART_CONTEXT_JEV_LOW_CONFIDENCE=0.45;

function clean(value){return String(value??'').trim();}
function clamp(value,min,max){const n=Number(value);return Number.isFinite(n)?Math.max(min,Math.min(max,n)):null;}
function candidate(row={},index=0){return{id:String(row.id||row.refId||`C${index+1}`),book:String(row.book||''),uid:Number(row.uid),title:String(row.title||''),nodeLabel:String(row.nodeLabel||''),path:Array.isArray(row.path)?row.path.map(String):[],keywords:Array.isArray(row.keys||row.keywords)?(row.keys||row.keywords).map(String).slice(0,12):[],matched:Array.isArray(row.matched)?row.matched.map(String).slice(0,12):[],summary:clipDecisionText(row.summary||row.content||'',2500),deterministicScore:Number.isFinite(Number(row.score))?Number(row.score):null,deterministicRank:index+1,sceneReferenceKind:clean(row.sceneReferenceKind)||null,sceneReferenceRelation:clean(row.sceneReferenceRelation)||null,sceneReferenceName:clean(row.sceneReferenceName)||null};}
function state(context={}){return{sceneNeed:clipDecisionText(context.sceneNeed||context.sceneText||'',6000),scene:context.scene?{acceptedScene:context.scene.acceptedScene||null,references:context.scene.references||null,delta:context.scene.delta||null,degraded:context.scene.degraded===true}:null,changeGate:context.changeGate||null,warmBudget:Number(context.warmBudget)||0,warmBudgetFloor:Number(context.warmBudgetFloor||context.warmBudget)||0,candidates:(context.candidates||[]).slice(0,SMART_CONTEXT_DECISION_MAX_CANDIDATES).map(candidate),policy:{predictiveFrontier:true,protectedPinsOutsideAuthority:true,preserveCurrentSceneDiversity:true,preserveNextBeatDiversity:true}};}
function contractQuestions(){const out={warm_budget:{type:'choice'}};for(let i=1;i<=SMART_CONTEXT_DECISION_MAX_CANDIDATES;i+=1){out[`candidate_${i}_relevant`]={type:'noul',required:false};out[`candidate_${i}_current_scene_value`]={type:'noul',required:false};out[`candidate_${i}_next_beat_value`]={type:'score',required:false};}return out;}
function questions(context={}){
  const out={
    warm_budget:{type:'choice',instructions:`The deterministic Smart Context warm floor is ${Math.max(1,Number(context.warmBudget)||1)}. Choose the smallest predictive breadth that preserves supported current-place/world-state continuity AND plausible next-beat diversity. Never shrink below the supplied floor. Do not reward fewer cards for its own sake.`,criteria:{FLOOR:'Use the deterministic floor; evidence does not support broader predictive breadth.',TWO:'Keep at least two predictive cards because distinct current-scene and/or next-beat context is materially useful.',SIX:'Keep a broad six-card predictive frontier because the immediate scene is branching or multiple distinct next beats are materially supported.'}},
  };
  (context.candidates||[]).slice(0,SMART_CONTEXT_DECISION_MAX_CANDIDATES).forEach((_,i)=>{
    const n=i+1;
    out[`candidate_${n}_relevant`]={type:'noul',instructions:`Evaluate only state.candidates[${i}]. Is this exact already-nominated lore candidate materially relevant enough to remain eligible for Smart Context's moving predictive frontier? Do not prefer obvious/current cards merely because they are obvious; near-term predictive value counts.`};
    out[`candidate_${n}_current_scene_value`]={type:'noul',instructions:`Evaluate only state.candidates[${i}]. Is this candidate load-bearing for the CURRENT place, world state, or active continuity right now? A mere mention is not enough.`};
    out[`candidate_${n}_next_beat_value`]={type:'score',instructions:`Evaluate only state.candidates[${i}]. How useful is this exact candidate for the next one or two replies? Reward plausible immediate next-beat context without inventing future events. A candidate may score highly even when it is not the most obvious current card.`,criteria:['No near-term value','Weak background possibility','Plausible next-beat value','Strong near-term value','Critical immediate predictive value']};
  });
  return out;
}
function warmFreshnessInput(context={}){return{revisions:{scene:String(context.scene?.scanRevision||context.sceneRevision||''),loreTree:String(context.sourceRevision||''),warmAuthority:String(context.warmKey||''),gateMode:String(context.changeGate?.mode||'')},material:state(context)};}
export function smartContextWarmReviewFingerprint(context={}){return decisionFreshnessSnapshot(SMART_CONTEXT_WARM_REVIEW_SITE_ID,warmFreshnessInput(context)).fingerprint;}
const SMART_WARM_FRESHNESS=createDecisionFreshnessContract({siteId:SMART_CONTEXT_WARM_REVIEW_SITE_ID,buildCanonicalInput:warmFreshnessInput});

export const SMART_CONTEXT_WARM_REVIEW_SITE=registerDecisionSite({
  id:SMART_CONTEXT_WARM_REVIEW_SITE_ID,subsystem:'smart-context',mode:DECISION_MODE.ASSIST,priority:92,
  contract:{id:SMART_CONTEXT_WARM_REVIEW_SITE_ID,version:2,subsystem:'smart-context',questions:contractQuestions()},
  buildState:state,buildQuestions:questions,
  freshness:SMART_WARM_FRESHNESS,
  providerPolicy:{fallbackEnabled:false,allowProviderFallback:true},
  metadata:{shadowOnly:false,assist:true,boundary:'after-deterministic-predictive-nomination-before-sidecar-selection',authority:'bounded-predictive-admission-only',protectedAuthority:'manual-active-earned-character-continuity-excluded',canonicalMutation:false,candidateLimit:SMART_CONTEXT_DECISION_MAX_CANDIDATES},
});

function warmBudgetFromChoice(choice,floor){
  const min=Math.max(1,Number(floor)||1);
  const requested=choice==='SIX'?6:choice==='TWO'?2:min;
  return Math.max(min,requested);
}
function rowScore(row){return row.relevance*0.45+row.currentScene*0.25+(row.nextBeat/4)*0.30;}
function sortGeneral(a,b){return rowScore(b)-rowScore(a)||b.nextBeat-a.nextBeat||b.currentScene-a.currentScene||b.relevance-a.relevance||a.index-b.index;}
function sortCurrent(a,b){return b.currentScene-a.currentScene||b.relevance-a.relevance||b.nextBeat-a.nextBeat||a.index-b.index;}
function sortNextBeat(a,b){return b.nextBeat-a.nextBeat||b.relevance-a.relevance||b.currentScene-a.currentScene||a.index-b.index;}

export function interpretSmartContextWarmReviewDecision(result,{candidates=[],warmBudget=1,warmBudgetFloor=warmBudget}={}){
  if(!result?.ok||result?.stale)return{handled:false,reason:result?.stale?'stale':'decision-unavailable',result};
  if(result.providerClass!==DECISION_PROVIDER_CLASS.TYPED_DECISION)return{handled:false,reason:'non-jev-provider',result};
  const bounded=(Array.isArray(candidates)?candidates:[]).slice(0,SMART_CONTEXT_DECISION_MAX_CANDIDATES);
  if(!bounded.length)return{handled:true,selected:[],semanticSelected:[],deterministicFill:[],rows:[],warmBudget:Math.max(1,Number(warmBudgetFloor)||1),reason:'empty-candidate-set',result};
  const rows=[];
  for(let index=0;index<bounded.length;index+=1){
    const relevance=clamp(result.answers?.[`candidate_${index+1}_relevant`]?.value,0,1);
    const currentScene=clamp(result.answers?.[`candidate_${index+1}_current_scene_value`]?.value,0,1);
    const nextBeat=clamp(result.answers?.[`candidate_${index+1}_next_beat_value`]?.value,0,4);
    const nextConfidence=clamp(result.answers?.[`candidate_${index+1}_next_beat_value`]?.confidence,0,1);
    if(relevance==null||currentScene==null||nextBeat==null)return{handled:false,reason:'malformed-decision',result};
    rows.push({index,candidate:bounded[index],relevance,currentScene,nextBeat,nextConfidence});
  }
  const explicit=rows.map(row=>row.nextConfidence).filter(Number.isFinite);
  const averageConfidence=explicit.length?explicit.reduce((sum,value)=>sum+value,0)/explicit.length:null;
  const budgetConfidence=clamp(result.answers?.warm_budget?.confidence,0,1);
  const ambiguous=rows.filter(row=>Math.abs(row.relevance-0.5)<0.08&&Math.abs(row.currentScene-0.5)<0.08&&Math.abs(row.nextBeat-2)<0.75).length/rows.length;
  if((budgetConfidence!=null&&budgetConfidence<0.55)||(averageConfidence!=null&&averageConfidence<SMART_CONTEXT_JEV_LOW_CONFIDENCE)||ambiguous>=0.75)return{handled:false,reason:'low-confidence',budgetConfidence,averageConfidence,ambiguousRatio:ambiguous,result};

  const floor=Math.max(1,Number(warmBudgetFloor||warmBudget)||1);
  let target=Math.min(rows.length,warmBudgetFromChoice(clean(result.answers?.warm_budget?.value),floor));
  const semanticPool=rows.filter(row=>row.relevance>=SMART_CONTEXT_JEV_RELEVANCE_FLOOR||row.currentScene>=SMART_CONTEXT_JEV_CURRENT_SCENE_FLOOR||row.nextBeat>=SMART_CONTEXT_JEV_NEXT_BEAT_FLOOR);
  const chosen=[];
  const chosenSet=new Set();
  const add=row=>{if(!row||chosenSet.has(row.index))return false;chosen.push(row);chosenSet.add(row.index);return true;};
  const currentSeed=[...semanticPool].filter(row=>row.currentScene>=SMART_CONTEXT_JEV_CURRENT_SCENE_FLOOR).sort(sortCurrent)[0]||null;
  const nextBeatCandidates=[...semanticPool].filter(row=>row.nextBeat>=SMART_CONTEXT_JEV_NEXT_BEAT_FLOOR).sort(sortNextBeat);
  // Non-negotiable moving-frontier fence: if a distinct plausible next-beat
  // candidate exists, do not let one obvious/current card satisfy both lanes.
  const nextSeed=nextBeatCandidates.find(row=>!currentSeed||row.index!==currentSeed.index)||nextBeatCandidates[0]||null;
  const continuitySelected=[...semanticPool].filter(row=>row.currentScene>=SMART_CONTEXT_JEV_CURRENT_SCENE_FLOOR).sort(sortCurrent);
  add(currentSeed);
  add(nextSeed);
  // Diversity is a quality fence: if current-scene and next-beat evidence point
  // at two different cards, a nominal floor of one may not collapse them.
  target=Math.min(rows.length,Math.max(target,chosen.length));
  for(const row of [...semanticPool].sort(sortGeneral)){if(chosen.length>=target)break;add(row);}
  const semanticSelected=[...chosen];
  const deterministicFill=[];
  for(const row of rows){if(chosen.length>=target)break;if(add(row))deterministicFill.push(row);}
  return{
    handled:true,
    reason:'assist-success',
    selected:chosen.map(row=>row.candidate),
    semanticSelected:semanticSelected.map(row=>row.candidate),
    continuitySelected:continuitySelected.map(row=>row.candidate),
    deterministicFill:deterministicFill.map(row=>row.candidate),
    rows,
    warmBudget:target,
    requestedWarmBudget:warmBudgetFromChoice(clean(result.answers?.warm_budget?.value),floor),
    warmBudgetFloor:floor,
    averageConfidence,
    ambiguousRatio:ambiguous,
    currentSceneSeed:currentSeed?.candidate||null,
    nextBeatSeed:nextSeed?.candidate||null,
    result,
  };
}

export function evaluateSmartContextWarmReviewShadow(context,options={}){return evaluateDecisionSite(SMART_CONTEXT_WARM_REVIEW_SITE_ID,context,{mode:DECISION_MODE.SHADOW,...options});}
