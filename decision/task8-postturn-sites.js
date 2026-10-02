import { DECISION_MODE } from './constants.js';
import { evaluateDecisionSite, registerDecisionSite } from './site-registry.js';
import { createDecisionFreshnessContract } from './freshness.js';
import { logEvent } from '../observability/telemetry.js';

export const TASK8_POSTTURN_SITE_IDS=Object.freeze({
  RUN_GREEN_ROOM:'scheduler.runGreenRoom',
  OBSERVE_ON_MINOR:'scheduler.observeOnMinor',
  BACKGROUND_ORDER:'scheduler.backgroundOrder',
  TRUTH_CONFLICT:'truth.conflict',
  WALKER_ANCHOR:'walker.anchor',
  SCENE_BOUNDARY:'scene.boundary',
  SCENE_PATH_CONFLICT:'scene.pathConflict',
  HOT_THREAD_STATE:'hot.threadState',
  GREENROOM_SURFACE:'greenroom.surface',
  GREENROOM_REFLECT:'greenroom.reflect',
  WORLDTREE_SUPERSEDE:'worldtree.supersede',
  WORLDTREE_IDENTITY:'worldtree.identity',
  WORLDTREE_SUGGEST_TRACK:'worldtree.suggestTrack',
  WORLDTREE_GROWTH:'worldtree.growth',
  RETRIEVAL_SOURCE_PLAN:'retrieval.sourcePlan',
});

const POST_TURN_TIMEOUT_MS=5000;
const MAX_ARRAY=12;
const MAX_KEYS=32;
const MAX_TEXT=2200;

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
function choiceSite({id,subsystem,priority=60,instructions,criteria,stateBuilder=stateOf,questionsBuilder=null}){
  const siteFreshness=freshness(id);
  return registerDecisionSite({
    id,subsystem,mode:DECISION_MODE.ASSIST,priority,
    contract:{id,version:1,subsystem,questions:{choice:{type:'choice'}}},
    buildState(context){return bounded(stateBuilder(context));},
    buildQuestions(context){return questionsBuilder?questionsBuilder(context):{choice:choiceQuestion(instructions,criteria)};},
    freshness:siteFreshness,
    providerPolicy:{timeoutMs:POST_TURN_TIMEOUT_MS,fallbackEnabled:true,allowProviderFallback:true},
    metadata:{shadowOnly:false,assist:true,authority:'advisory-only',canonicalMutation:false,phase:'post-turn'},
  });
}

choiceSite({
  id:TASK8_POSTTURN_SITE_IDS.RUN_GREEN_ROOM,subsystem:'scheduler',priority:96,
  instructions:'Choose whether Green Room inference should run for this completed turn. Use the change gate, expiry state, and active cast only. This choice is advisory scheduling; it never changes canon.',
  criteria:{RUN:'Run Green Room this turn.',SKIP:'Do not run Green Room this turn.'},
});
choiceSite({
  id:TASK8_POSTTURN_SITE_IDS.OBSERVE_ON_MINOR,subsystem:'scheduler',priority:95,
  instructions:'The deterministic change gate says MINOR. Choose whether the post-reply Scene observation should run. Prefer RUN when the reply could materially change scene details. This is advisory scheduling only.',
  criteria:{RUN:'Run Scene observation.',SKIP:'Reuse current Scene observation.'},
});
choiceSite({
  id:TASK8_POSTTURN_SITE_IDS.BACKGROUND_ORDER,subsystem:'scheduler',priority:75,
  instructions:'Choose which tied background job should run first. Only choose one supplied candidate id; do not create work or change priority classes.',
  criteria:null,
  questionsBuilder(context){
    const ids=(context?.state?.candidates??[]).slice(0,MAX_ARRAY).map(row=>String(row?.id??row)).filter(Boolean);
    return{choice:choiceQuestion('Choose the highest-value next background job among the supplied equal-priority candidates. The scheduler remains authoritative.',Object.fromEntries(ids.map(id=>[id,'Run '+id+' before the other tied candidates.'])))};
  },
});
choiceSite({
  id:TASK8_POSTTURN_SITE_IDS.TRUTH_CONFLICT,subsystem:'truth',priority:82,
  instructions:'Classify the relationship between two current claims about the same subject. Do not rewrite either claim or infer canon beyond the supplied summaries.',
  criteria:{REAL_CONFLICT:'The claims cannot both be current as stated.',COMPATIBLE:'The claims can both be true.',CHANGE_OVER_TIME:'They describe different times or a transition.',UNRESOLVED:'The supplied evidence is insufficient.'},
});
choiceSite({
  id:TASK8_POSTTURN_SITE_IDS.WALKER_ANCHOR,subsystem:'walker',priority:80,
  instructions:'Resolve an ambiguous scene name to one supplied World Tree node id. Choose SKIP when the state does not justify a unique match.',
  criteria:null,
  questionsBuilder(context){
    const ids=(context?.state?.candidates??[]).slice(0,MAX_ARRAY).map(row=>String(row?.id??'')).filter(Boolean);
    return{choice:choiceQuestion('Choose the intended World Tree node for state.name. Use only supplied candidates. Choose SKIP if still ambiguous.',{...Object.fromEntries(ids.map(id=>[id,'Resolve the ambiguous reference to '+id+'.'])),SKIP:'Do not resolve this ambiguous reference.'})};
  },
});
choiceSite({
  id:TASK8_POSTTURN_SITE_IDS.SCENE_BOUNDARY,subsystem:'scene',priority:90,
  instructions:'When the deterministic change gate and post-reply scene observation disagree, decide whether this is a real scene cut or a minor shift. Do not invent scene facts.',
  criteria:{SCENE_CUT:'Open a new scene boundary.',MINOR_SHIFT:'Remain in the current scene.'},
});
choiceSite({
  id:TASK8_POSTTURN_SITE_IDS.SCENE_PATH_CONFLICT,subsystem:'scene',priority:89,
  instructions:'The sidecar scene observation and deterministic extractor disagree. Choose which supplied observation path should be trusted for this post-turn update.',
  criteria:{SIDECAR:'Use the validated sidecar observation.',EXTRACTOR:'Use the deterministic extractor observation.'},
});
choiceSite({
  id:TASK8_POSTTURN_SITE_IDS.HOT_THREAD_STATE,subsystem:'hot-cognition',priority:72,
  instructions:'Decide whether the supplied active story thread remains active after the latest completed turn or is resolved. This is working-state advice, not canon.',
  criteria:{ACTIVE:'Keep the thread active.',RESOLVED:'Mark the thread resolved in short-lived working state.'},
});
choiceSite({
  id:TASK8_POSTTURN_SITE_IDS.GREENROOM_SURFACE,subsystem:'green-room',priority:71,
  instructions:'Decide whether this low-confidence inferred Green Room reading is useful enough to surface next turn. It remains explicitly inferred and non-canonical.',
  criteria:{INCLUDE:'Surface the reading as tentative subtext.',SKIP:'Keep the reading out of the next prompt.'},
});
choiceSite({
  id:TASK8_POSTTURN_SITE_IDS.GREENROOM_REFLECT,subsystem:'green-room',priority:70,
  instructions:'Decide whether three or more compatible inferred readings justify creating a reflection proposal for normal owner review. Never write memory or World Tree state directly.',
  criteria:{PROPOSE:'Create a reviewable reflection proposal.',SKIP:'Do not create a reflection proposal.'},
});
choiceSite({
  id:TASK8_POSTTURN_SITE_IDS.WORLDTREE_SUPERSEDE,subsystem:'world-tree',priority:74,
  instructions:'Decide whether the new fact supersedes the older fact. This is review advice only; it must not mutate canonical World Tree state.',
  criteria:{SUPERSEDES:'The new fact clearly replaces the older current fact.',NO_SUPERSESSION:'Both may remain current or are unrelated.',REVIEW:'Evidence is insufficient; flag for owner review.'},
});
choiceSite({
  id:TASK8_POSTTURN_SITE_IDS.WORLDTREE_IDENTITY,subsystem:'world-tree',priority:73,
  instructions:'Decide whether two supplied World Tree nodes refer to the same entity. This is review advice only; never merge nodes directly.',
  criteria:{SAME_ENTITY:'The supplied evidence supports one identity.',SEPARATE:'They are distinct entities.',REVIEW:'Identity is still ambiguous; keep separate and flag for review.'},
});
choiceSite({
  id:TASK8_POSTTURN_SITE_IDS.WORLDTREE_SUGGEST_TRACK,subsystem:'world-tree',priority:72,
  instructions:'Decide whether an existing untracked global World Tree UID should be suggested to the owner as a tracked character because it repeatedly appears as a speaking or acting scene participant. This is advisory only. Never enable tracking.',
  criteria:{SUGGEST:'Show an owner-facing tracking suggestion.',SKIP:'Do not show a tracking suggestion yet.'},
});
choiceSite({
  id:TASK8_POSTTURN_SITE_IDS.WORLDTREE_GROWTH,subsystem:'world-tree',priority:73,
  instructions:'A chat-scoped World Tree candidate is near the evidence threshold. Choose whether it should grow now, wait for more evidence, or be sent to owner review. Never approve global growth.',
  criteria:{GROW:'Apply the justified chat-scoped candidate.',WAIT:'Keep the candidate unresolved for more evidence.',REVIEW:'Keep it unresolved and add it to owner review.'},
});

registerDecisionSite({
  id:TASK8_POSTTURN_SITE_IDS.RETRIEVAL_SOURCE_PLAN,subsystem:'retrieval-sensory',mode:DECISION_MODE.ASSIST,priority:85,
  contract:{id:TASK8_POSTTURN_SITE_IDS.RETRIEVAL_SOURCE_PLAN,version:1,subsystem:'retrieval-sensory',questions:{
    hot:{type:'choice'},walker:{type:'choice'},vector:{type:'choice'},reason:{type:'choice'},
  }},
  buildState(context){return bounded(context.state??context);},
  buildQuestions(){return{
    hot:choiceQuestion('Choose next-turn Hot Cognition emphasis. This only scales its existing dynamic budget and fusion weight.',{lead:'Lead continuity-sensitive retrieval.',normal:'Use normal emphasis.',light:'Use light emphasis.'}),
    walker:choiceQuestion('Choose next-turn Graph Walker breadth. This only scales the dynamic budget; skip is allowed.',{deep:'Walk more deeply within budget.',normal:'Use normal graph work.',shallow:'Use shallow graph work.',skip:'Skip Walker this turn.'}),
    vector:choiceQuestion('Choose next-turn vector paging breadth. This only scales the dynamic budget; skip is allowed.',{wide:'Wake a wider vector set within budget.',normal:'Use normal vector breadth.',narrow:'Use narrow vector breadth.',skip:'Skip vector paging this turn.'}),
    reason:choiceQuestion('Choose the best bounded reason for the retrieval source plan.',{CONTINUITY:'Stable continuity dominates.',BALANCED:'No source should dominate.',NEW_ANCHORS:'New scene, cast, or location needs expansion.',HISTORICAL:'Older facts or memories matter.',TEMPORAL:'Time-sensitive comparison matters.',CONTRADICTION:'Related conflicting claims need graph context.',OTHER:'None of the listed reasons clearly dominates.'}),
  };},
  freshness:freshness(TASK8_POSTTURN_SITE_IDS.RETRIEVAL_SOURCE_PLAN),
  providerPolicy:{timeoutMs:POST_TURN_TIMEOUT_MS,fallbackEnabled:true,allowProviderFallback:true},
  metadata:{shadowOnly:false,assist:true,authority:'advisory-only',canonicalMutation:false,phase:'post-turn-predictive'},
});

async function runtimeDecisionMode(){
  try{
    const mod=await import('./mode.js');
    return mod.getDecisionCoreRuntimeMode();
  }catch{
    return DECISION_MODE.OFF;
  }
}
function normalizedChoice(answer){return String(answer?.choice??answer?.value??'').trim();}

export async function runTask8ChoiceDecision(siteId,context={},fallbackChoice,{reasonCode='RULE_FALLBACK',telemetrySelection=null,signal=null}={}){
  const mode=await runtimeDecisionMode();
  const fallback=String(fallbackChoice??'');
  if(mode===DECISION_MODE.OFF){
    logEvent('decision-core','decision.site',{siteId,choice:fallback,providerChoice:null,source:'fallback',mode,provider:null,latencyMs:0,reasonCode:'DECISION_OFF'},'debug');
    return{choice:fallback,providerChoice:null,source:'fallback',mode,result:null,reasonCode:'DECISION_OFF'};
  }
  let result=null,providerChoice=null;
  try{
    result=await evaluateDecisionSite(siteId,context,{mode,providerPolicy:{timeoutMs:POST_TURN_TIMEOUT_MS},telemetrySelection,signal});
    if(result?.ok&&!result?.stale)providerChoice=normalizedChoice(result.answers?.choice)||null;
  }catch(error){
    result={ok:false,stale:false,latencyMs:0,provider:null,error:{message:error?.message||String(error)}};
  }
  const useProvider=mode===DECISION_MODE.ASSIST&&result?.ok&&!result?.stale&&providerChoice;
  const choice=useProvider?providerChoice:fallback;
  const source=useProvider?'provider':'fallback';
  const finalReason=useProvider?'PROVIDER':result?.stale?'STALE':result?.error?.category||reasonCode;
  logEvent('decision-core','decision.site',{siteId,choice,providerChoice,source,mode,provider:result?.provider??null,latencyMs:Number(result?.latencyMs)||0,reasonCode:finalReason},useProvider?'info':'debug');
  return{choice,providerChoice,source,mode,result,reasonCode:finalReason};
}

export async function runRetrievalSourcePlanDecision(context={},fallbackPlan,{telemetrySelection=null,signal=null}={}){
  const siteId=TASK8_POSTTURN_SITE_IDS.RETRIEVAL_SOURCE_PLAN;
  const mode=await runtimeDecisionMode();
  const fallback={...fallbackPlan};
  if(mode===DECISION_MODE.OFF){
    logEvent('decision-core','decision.site',{siteId,choice:fallback,providerChoice:null,source:'fallback',mode,provider:null,latencyMs:0,reasonCode:'DECISION_OFF'},'debug');
    return{plan:fallback,providerPlan:null,source:'fallback',mode,result:null,reasonCode:'DECISION_OFF'};
  }
  let result=null,providerPlan=null;
  try{
    result=await evaluateDecisionSite(siteId,context,{mode,providerPolicy:{timeoutMs:POST_TURN_TIMEOUT_MS},telemetrySelection,signal});
    if(result?.ok&&!result?.stale){
      const hot=normalizedChoice(result.answers?.hot),walker=normalizedChoice(result.answers?.walker),vector=normalizedChoice(result.answers?.vector),reasonCode=normalizedChoice(result.answers?.reason);
      if(['lead','normal','light'].includes(hot)&&['deep','normal','shallow','skip'].includes(walker)&&['wide','normal','narrow','skip'].includes(vector))providerPlan={hot,walker,vector,reasonCode:reasonCode||'OTHER',watchBoost:Math.max(1,Math.min(1.2,Number(fallback.watchBoost)||1))};
    }
  }catch(error){
    result={ok:false,stale:false,latencyMs:0,provider:null,error:{message:error?.message||String(error)}};
  }
  const useProvider=mode===DECISION_MODE.ASSIST&&providerPlan!=null;
  const plan=useProvider?providerPlan:fallback;
  const source=useProvider?'provider':'fallback';
  const finalReason=useProvider?'PROVIDER':result?.stale?'STALE':result?.error?.category||String(fallback.reasonCode||'RULE_FALLBACK');
  logEvent('decision-core','decision.site',{siteId,choice:plan,providerChoice:providerPlan,source,mode,provider:result?.provider??null,latencyMs:Number(result?.latencyMs)||0,reasonCode:finalReason},useProvider?'info':'debug');
  return{plan,providerPlan,source,mode,result,reasonCode:finalReason};
}
