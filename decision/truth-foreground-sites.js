import { DECISION_MODE } from './constants.js';
import { evaluateDecisionSite, registerDecisionSite } from './site-registry.js';
import { createDecisionFreshnessContract } from './freshness.js';
import { logEvent } from '../observability/telemetry.js';

export const TRUTH_FOREGROUND_SITE_IDS=Object.freeze({
  INTENT:'truth.intent',
  CORRECTIVE:'truth.corrective',
});

const INTENT_CHOICES=Object.freeze(['CURRENT','HISTORICAL','TEMPORAL','CONTRADICTION']);
const CORRECTIVE_CHOICES=Object.freeze(['NONE','GRAPH_EXPANSION','TEMPORAL_NARROWING','ENTITY_CONSTRAINED_SEARCH','REFORMULATE']);
const MAX_ARRAY=12;
const MAX_KEYS=28;
const MAX_TEXT=480;

function bounded(value,depth=0){
  if(value==null||typeof value==='boolean'||typeof value==='number')return value;
  if(typeof value==='string')return value.length<=MAX_TEXT?value:value.slice(0,MAX_TEXT)+' [bounded]';
  if(depth>=4)return String(value).slice(0,MAX_TEXT);
  if(Array.isArray(value))return value.slice(0,MAX_ARRAY).map(row=>bounded(row,depth+1));
  if(typeof value==='object')return Object.fromEntries(Object.entries(value).slice(0,MAX_KEYS).map(([key,row])=>[key,bounded(row,depth+1)]));
  return String(value).slice(0,MAX_TEXT);
}
function stateOf(context={}){return bounded(context.state??context);}
function freshness(siteId){
  return createDecisionFreshnessContract({
    siteId,
    buildCanonicalInput(context={}){
      return{revisions:bounded(context.revisions??{}),material:stateOf(context)};
    },
  });
}
function choiceQuestion(instructions,criteria){return{type:'choice',instructions,criteria};}
function registerForegroundChoice({id,priority,instructions,criteria}){
  return registerDecisionSite({
    id,
    subsystem:'truth',
    mode:DECISION_MODE.ASSIST,
    priority,
    contract:{id,version:1,subsystem:'truth',questions:{choice:{type:'choice'}}},
    buildState(context){return stateOf(context);},
    buildQuestions(){return{choice:choiceQuestion(instructions,criteria)};},
    freshness:freshness(id),
    providerPolicy:{fallbackEnabled:true,allowProviderFallback:true},
    metadata:{shadowOnly:false,assist:true,authority:'advisory-only',canonicalMutation:false,phase:'foreground',sharesTurnDeadline:true},
  });
}

registerForegroundChoice({
  id:TRUTH_FOREGROUND_SITE_IDS.INTENT,
  priority:99,
  instructions:'Classify the truth need of this turn using only the supplied short question summary and bounded scene labels. Choose the single retrieval intent that best matches what must be established. Do not answer the question and do not infer canon.',
  criteria:{
    CURRENT:'The turn asks what is true now or has no meaningful time comparison.',
    HISTORICAL:'The turn asks about a former, previous, old, or past state.',
    TEMPORAL:'The turn asks when something happened, how it changed over time, or compares before/after/during states.',
    CONTRADICTION:'The turn asks to reconcile conflicting, disputed, incompatible, or competing accounts.',
  },
});

registerForegroundChoice({
  id:TRUTH_FOREGROUND_SITE_IDS.CORRECTIVE,
  priority:98,
  instructions:'Choose at most one bounded retrieval correction after the first Truth assessment. Choose NONE when the current evidence is already usable or when no listed correction is clearly justified. The choice is advisory; code decides whether any corrected pass improves the evidence.',
  criteria:{
    NONE:'Do not spend more foreground work on a corrective pass.',
    GRAPH_EXPANSION:'Expand graph traversal from the existing resolved entity anchors within the remaining dynamic budget.',
    TEMPORAL_NARROWING:'Retry with time-aware retrieval focused on the turn question rather than broader scene context.',
    ENTITY_CONSTRAINED_SEARCH:'Retry using only entity-aware continuity and graph channels around the resolved anchors.',
    REFORMULATE:'Retry the existing retrieval channels with a concise question-centered query.',
  },
});

async function runtimeDecisionMode(){
  try{
    const mod=await import('./mode.js');
    return mod.getDecisionCoreRuntimeMode();
  }catch{
    return DECISION_MODE.OFF;
  }
}
function normalizeChoice(answer){return String(answer?.choice??answer?.value??'').trim().toUpperCase();}
function normalizeDeadline(value){
  const n=Number(value);
  return Number.isFinite(n)&&n>0?n:null;
}
function emit(siteId,{choice,providerChoice=null,source='fallback',mode=DECISION_MODE.OFF,provider=null,latencyMs=0,reasonCode='RULE_FALLBACK'}={}){
  logEvent('decision-core','decision.site',{
    siteId,
    choice,
    providerChoice,
    source,
    mode,
    provider,
    latencyMs:Math.max(0,Number(latencyMs)||0),
    reasonCode:String(reasonCode||'RULE_FALLBACK').slice(0,96),
    phase:'foreground',
  },source==='provider'?'info':'debug');
}
function fallbackResult(choice,mode,reasonCode,result=null,providerChoice=null){
  return{choice:String(choice??''),providerChoice,source:'fallback',mode,result,reasonCode};
}

/**
 * Evaluate one foreground Decision Site inside the already-open Nexus foreground
 * deadline. No separate Decision deadline is invented. If the deadline is absent,
 * exhausted, aborted, stale, invalid, or the provider chain fails, code returns
 * the supplied deterministic fallback and never throws into generation.
 */
export async function runTruthForegroundChoice(siteId,context={},fallbackChoice,{
  allowedChoices=[],
  foregroundDeadlineMs=null,
  telemetrySelection=null,
  signal=null,
  evaluate=null,
  fallbackReason='RULE_FALLBACK',
}={}){
  const started=Date.now();
  const fallback=String(fallbackChoice??'').toUpperCase();
  const allowed=new Set((allowedChoices??[]).map(value=>String(value).toUpperCase()));
  const mode=await runtimeDecisionMode();
  if(mode===DECISION_MODE.OFF){
    emit(siteId,{choice:fallback,mode,latencyMs:Date.now()-started,reasonCode:'DECISION_OFF'});
    return fallbackResult(fallback,mode,'DECISION_OFF');
  }

  const deadline=normalizeDeadline(foregroundDeadlineMs);
  const remaining=deadline==null?0:Math.max(0,deadline-Date.now());
  if(!(remaining>0)){
    const reason=deadline==null?'NO_FOREGROUND_DEADLINE':'FOREGROUND_DEADLINE_EXHAUSTED';
    emit(siteId,{choice:fallback,mode,latencyMs:Date.now()-started,reasonCode:reason});
    return fallbackResult(fallback,mode,reason);
  }
  if(signal?.aborted){
    emit(siteId,{choice:fallback,mode,latencyMs:Date.now()-started,reasonCode:'FOREGROUND_ABORTED'});
    return fallbackResult(fallback,mode,'FOREGROUND_ABORTED');
  }

  const controller=new AbortController();
  const abortFromParent=()=>{try{controller.abort(signal?.reason??new Error('Foreground decision aborted.'));}catch{}};
  if(signal)signal.addEventListener('abort',abortFromParent,{once:true});
  let timer=null;
  const deadlineError=Object.assign(new Error('Foreground Decision Core deadline exhausted.'),{name:'NexusDecisionDeadline'});
  const timeout=new Promise(resolve=>{
    timer=setTimeout(()=>{
      try{controller.abort(deadlineError);}catch{}
      resolve({__deadline:true});
    },remaining);
  });

  const evaluation=Promise.resolve().then(()=>evaluateDecisionSite(siteId,context,{
    mode,
    providerPolicy:{timeoutMs:remaining,fallbackEnabled:true,allowProviderFallback:true},
    telemetrySelection,
    signal:controller.signal,
    ...(typeof evaluate==='function'?{evaluate}:{}),
  })).catch(error=>({__error:error}));

  let result;
  try{result=await Promise.race([evaluation,timeout]);}
  catch(error){result={__error:error};}
  finally{
    if(timer!=null)clearTimeout(timer);
    if(signal)signal.removeEventListener('abort',abortFromParent);
  }

  if(result?.__deadline){
    emit(siteId,{choice:fallback,mode,latencyMs:Date.now()-started,reasonCode:'FOREGROUND_DEADLINE_EXHAUSTED'});
    return fallbackResult(fallback,mode,'FOREGROUND_DEADLINE_EXHAUSTED');
  }
  if(result?.__error){
    emit(siteId,{choice:fallback,mode,latencyMs:Date.now()-started,reasonCode:'DECISION_ERROR'});
    return fallbackResult(fallback,mode,'DECISION_ERROR',{ok:false,error:{message:result.__error?.message||String(result.__error)}});
  }

  const providerChoice=result?.ok&&!result?.stale?normalizeChoice(result.answers?.choice):null;
  const validProviderChoice=providerChoice&&(!allowed.size||allowed.has(providerChoice))?providerChoice:null;
  const useProvider=mode===DECISION_MODE.ASSIST&&validProviderChoice!=null;
  const choice=useProvider?validProviderChoice:fallback;
  const source=useProvider?'provider':'fallback';
  const reasonCode=useProvider?'PROVIDER':
    result?.stale?'STALE':
    providerChoice&&!validProviderChoice?'INVALID_OUTPUT':
    result?.error?.category||fallbackReason;
  emit(siteId,{choice,providerChoice,source,mode,provider:result?.provider??null,latencyMs:result?.latencyMs??(Date.now()-started),reasonCode});
  return{choice,providerChoice,source,mode,result,reasonCode};
}

export function runTruthIntentDecision(context,fallbackChoice,options={}){
  return runTruthForegroundChoice(TRUTH_FOREGROUND_SITE_IDS.INTENT,context,fallbackChoice,{
    ...options,
    allowedChoices:INTENT_CHOICES,
    fallbackReason:'INFER_TRUTH_NEED',
  });
}

export function runTruthCorrectiveDecision(context,options={}){
  return runTruthForegroundChoice(TRUTH_FOREGROUND_SITE_IDS.CORRECTIVE,context,'NONE',{
    ...options,
    allowedChoices:CORRECTIVE_CHOICES,
    fallbackReason:'NO_CORRECTIVE',
  });
}
