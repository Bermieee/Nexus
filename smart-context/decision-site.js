import { DECISION_MODE } from '../decision/constants.js';
import { registerDecisionSite, evaluateDecisionSite } from '../decision/site-registry.js';
import { clipDecisionText, stableDecisionFingerprint, resolveDecisionFingerprint } from '../decision/site-utils.js';

export const SMART_CONTEXT_WARM_REVIEW_SITE_ID='smart-context.warm-candidate-review.v1';
export const SMART_CONTEXT_DECISION_MAX_CANDIDATES=8;
function candidate(row={},index=0){return{id:String(row.id||row.refId||`C${index+1}`),book:String(row.book||''),uid:Number(row.uid),title:String(row.title||''),nodeLabel:String(row.nodeLabel||''),path:Array.isArray(row.path)?row.path.map(String):[],keywords:Array.isArray(row.keys||row.keywords)?(row.keys||row.keywords).map(String).slice(0,12):[],summary:clipDecisionText(row.summary||row.content||'',2500),deterministicScore:Number.isFinite(Number(row.score))?Number(row.score):null,protected:Boolean(row.pinned||row.characterWarm)};}
function state(context={}){return{sceneNeed:clipDecisionText(context.sceneNeed||context.sceneText||'',6000),changeGate:context.changeGate||null,warmBudget:Number(context.warmBudget)||0,candidates:(context.candidates||[]).slice(0,SMART_CONTEXT_DECISION_MAX_CANDIDATES).map(candidate)};}
function contractQuestions(){const out={};for(let i=1;i<=SMART_CONTEXT_DECISION_MAX_CANDIDATES;i+=1){out[`candidate_${i}_relevant`]={type:'noul',required:false};out[`candidate_${i}_predictive_value`]={type:'score',required:false};}return out;}
function questions(context={}){const out={};(context.candidates||[]).slice(0,SMART_CONTEXT_DECISION_MAX_CANDIDATES).forEach((_,i)=>{const n=i+1;out[`candidate_${n}_relevant`]={type:'noul',instructions:`Evaluate only state.candidates[${i}]. Is this exact already-nominated lore candidate materially relevant to the immediate scene need and appropriate to keep warm?`};out[`candidate_${n}_predictive_value`]={type:'score',instructions:`Evaluate only state.candidates[${i}]. How useful is keeping this exact candidate warm for the next one or two turns, without inventing future events?`,criteria:['No predictive value','Weak background value','Plausible near-term value','Strong likely near-term value','Critical continuity value']};});return out;}
export function smartContextWarmReviewFingerprint(context={}){return String(context.sourceFingerprint||stableDecisionFingerprint('smart-warm-review',state(context)));}

export const SMART_CONTEXT_WARM_REVIEW_SITE=registerDecisionSite({
  id:SMART_CONTEXT_WARM_REVIEW_SITE_ID,subsystem:'smart-context',mode:DECISION_MODE.SHADOW,priority:72,
  contract:{id:SMART_CONTEXT_WARM_REVIEW_SITE_ID,version:1,subsystem:'smart-context',questions:contractQuestions()},
  buildState:state,buildQuestions:questions,
  getSourceFingerprint:smartContextWarmReviewFingerprint,
  getCurrentSourceFingerprint(context){return resolveDecisionFingerprint(context,'smart-warm-review',state(context));},
  metadata:{shadowOnly:true,boundary:'after-deterministic-warm-nomination-before-sidecar-selection',authority:'none',candidateLimit:SMART_CONTEXT_DECISION_MAX_CANDIDATES},
});
export function evaluateSmartContextWarmReviewShadow(context,options={}){return evaluateDecisionSite(SMART_CONTEXT_WARM_REVIEW_SITE_ID,context,{mode:DECISION_MODE.SHADOW,...options});}
