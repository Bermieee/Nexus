// Truth's foreground time: bounded by core/budget.js, never silent, never throws into generation.
// Pure helpers; the retriever owns the clock and the events.
import { CAMPAIGN_APPLICABILITY, TRUTH_OUTCOME } from './truth-classification.js';

export const TRUTH_BUDGET_IDS=Object.freeze({CLASSIFY:'truth.classify',CORRECTIVE:'truth.corrective'});

// Initial per-unit estimates, replaced by the budget manager's observed averages after a turn.
const CLASSIFY_MS_PER_CANDIDATE=0.1;
const CORRECTIVE_MS_ESTIMATE=250;
const VERDICT_ROWS_IN_EVENT=96;

const number=(value,fallback=0)=>Number.isFinite(Number(value))?Number(value):fallback;

// One frame per Truth turn, sharing the turn deadline. No deadline means there is no foreground
// budget to enforce, so Truth is unbounded (it is rule-based and cheap) and says so.
export function beginTruthBudget({budgetManager,foregroundDeadlineMs=null,now=()=>Date.now(),worldSize=200,promptTokens=4096}={}){
  const deadline=Number(foregroundDeadlineMs);
  const started=now();
  if(!budgetManager||!Number.isFinite(deadline)||deadline<=0){
    return Object.freeze({bounded:false,source:'UNBOUNDED',budgetMs:null,startedAt:started,frame:null});
  }
  const frame=budgetManager.beginTurn({deadline,now:started,worldSize,promptTokens});
  return Object.freeze({bounded:true,source:'FOREGROUND_DEADLINE',budgetMs:Math.max(0,deadline-started),startedAt:started,frame});
}

// How many candidates Truth may classify now. The rest are deferred, not dropped.
export function planTruthClassification(budget,total){
  const count=Math.max(0,Math.floor(number(total)));
  if(!budget?.bounded||!budget.frame){
    return Object.freeze({id:TRUTH_BUDGET_IDS.CLASSIFY,allowed:count,examined:count,total:count,deferred:0,complete:true,continuation:null,bounded:false});
  }
  const receipt=budget.frame.compute(TRUTH_BUDGET_IDS.CLASSIFY,{total:count,defaultUnits:Math.max(1,count),msPerUnit:CLASSIFY_MS_PER_CANDIDATE});
  return Object.freeze({...receipt,bounded:true});
}

// Whether the corrective pass (a Decision call plus a second retrieval) fits what is left.
export function planTruthCorrective(budget){
  if(!budget?.bounded||!budget.frame)return Object.freeze({allowed:0,deferred:1,complete:false,bounded:false,reason:'NO_FOREGROUND_DEADLINE'});
  const receipt=budget.frame.compute(TRUTH_BUDGET_IDS.CORRECTIVE,{total:1,defaultUnits:1,msPerUnit:CORRECTIVE_MS_ESTIMATE});
  return Object.freeze({...receipt,bounded:true,reason:receipt.allowed>=1?null:'OVER_BUDGET'});
}

export function observeTruthWork(budgetManager,id,{units=1,durationMs=0}={}){
  try{budgetManager?.observe?.(id,{units,durationMs});}catch{/* telemetry must never fail the turn */}
}

// Per-turn Diagnostics payload. Every count is taken over ALL rows, not a clipped sample.
export function buildTruthTurnSummary({assessment,kind='lore',timeUsedMs=0,budget=null,corrective=null}={}){
  const rows=assessment?.rows??[];
  const count=predicate=>rows.filter(predicate).length;
  const tally=(pick)=>{
    const out={};
    for(const row of rows){const key=pick(row);if(key!=null&&key!=='')out[key]=(out[key]??0)+1;}
    return out;
  };
  const coverage=assessment?.coverage??{total:rows.length,assessed:rows.length,deferred:0};
  const deferred=count(row=>row?.deferred===true);
  return {
    kind,
    intent:assessment?.intent??null,
    candidateCount:rows.length,
    keptCount:assessment?.candidates?.length??count(row=>row?.keep===true),
    droppedCount:assessment?.dropped?.length??count(row=>row?.keep===false),
    supportOnlyCount:count(row=>row?.outcome===TRUTH_OUTCOME.SUPPORT_ONLY),
    fullWeightCount:count(row=>row?.outcome===TRUTH_OUTCOME.FULL),
    deferredCount:deferred,
    unresolvedCount:count(row=>row?.unresolved===true&&row?.timingUnspecified!==true&&row?.deferred!==true),
    unspecifiedTimingCount:count(row=>row?.timingUnspecified===true),
    disputedCount:count(row=>row?.disputed===true),
    canonReferenceCount:count(row=>row?.campaignApplicability===CAMPAIGN_APPLICABILITY.DIFFERENT_TIME),
    classifications:tally(row=>row?.verdict?.classification),
    outcomeCounts:Object.fromEntries(Object.values(TRUTH_OUTCOME).map(outcome=>[outcome,count(row=>row?.outcome===outcome)])),
    reasonCodeCounts:tally(row=>row?.reasonCode),
    coverageTotal:number(coverage.total,rows.length),
    coverageAssessed:number(coverage.assessed,rows.length-deferred),
    coverageDeferred:number(coverage.deferred,deferred),
    coverageComplete:number(coverage.deferred,deferred)===0&&!assessment?.error,
    verdictsOmitted:Math.max(0,rows.length-VERDICT_ROWS_IN_EVENT),
    timeUsedMs:Math.max(0,Math.round(number(timeUsedMs)*100)/100),
    budgetMs:budget?.budgetMs==null?null:Math.max(0,Math.round(number(budget.budgetMs)*100)/100),
    budgetSource:budget?.source??'UNBOUNDED',
    correctiveState:corrective?.state??'NOT_NEEDED',
    correctiveChoice:corrective?.choice??null,
    degraded:assessment?.error!=null,
  };
}
