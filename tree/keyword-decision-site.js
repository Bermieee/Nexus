import { DECISION_MODE } from '../decision/constants.js';
import { registerDecisionSite, evaluateDecisionSite } from '../decision/site-registry.js';
import { clipDecisionText, stableDecisionFingerprint, resolveDecisionFingerprint } from '../decision/site-utils.js';

export const TREE_KEYWORD_SAFETY_SITE_ID='tree.keyword-safety.v1';
export const TREE_KEYWORD_DECISION_MAX=8;
function state(context={}){return{entry:{book:String(context.book||''),uid:Number(context.uid),title:String(context.title||''),content:clipDecisionText(context.content||'',8000),existingKeywords:Array.isArray(context.existingKeywords)?context.existingKeywords.map(String).slice(0,20):[]},candidates:(context.candidates||[]).slice(0,TREE_KEYWORD_DECISION_MAX).map((row,i)=>({id:String(row.id||`K${i+1}`),keyword:String(row.keyword??row),collisionCount:Number(row.collisionCount)||0,collisionExamples:Array.isArray(row.collisionExamples)?row.collisionExamples.map(String).slice(0,6):[]}))};}
function contractQuestions(){const out={};for(let i=1;i<=TREE_KEYWORD_DECISION_MAX;i+=1){out[`candidate_${i}_safe`]={type:'noul',required:false};out[`candidate_${i}_specificity`]={type:'score',required:false};out[`candidate_${i}_collision_risk`]={type:'score',required:false};}return out;}
function questions(context={}){const out={};(context.candidates||[]).slice(0,TREE_KEYWORD_DECISION_MAX).forEach((_,i)=>{const n=i+1;out[`candidate_${n}_safe`]={type:'noul',instructions:`Evaluate only state.candidates[${i}]. Is this keyword semantically grounded in the entry and safe enough to consider as a retrieval trigger rather than a vague/common activation term?`};out[`candidate_${n}_specificity`]={type:'score',instructions:`Evaluate only state.candidates[${i}]. How specifically does this keyword identify the entry's durable concept?`,criteria:['Generic/noisy','Broad','Moderately specific','Highly specific','Near-unique concept trigger']};out[`candidate_${n}_collision_risk`]={type:'score',instructions:`Evaluate only state.candidates[${i}] with its supplied collision evidence. How likely is this keyword to activate unrelated lore?`,criteria:['Very low collision risk','Low','Moderate','High','Very high collision risk']};});return out;}
export function treeKeywordSafetyFingerprint(context={}){return String(context.sourceFingerprint||stableDecisionFingerprint('tree-keyword-safety',state(context)));}

export const TREE_KEYWORD_SAFETY_SITE=registerDecisionSite({
  id:TREE_KEYWORD_SAFETY_SITE_ID,subsystem:'tree',mode:DECISION_MODE.SHADOW,priority:28,
  contract:{id:TREE_KEYWORD_SAFETY_SITE_ID,version:1,subsystem:'tree',questions:contractQuestions()},
  buildState:state,buildQuestions:questions,
  getSourceFingerprint:treeKeywordSafetyFingerprint,
  getCurrentSourceFingerprint(context){return resolveDecisionFingerprint(context,'tree-keyword-safety',state(context));},
  metadata:{shadowOnly:true,boundary:'after-keyword-nomination-before-operator-review',authority:'none',candidateLimit:TREE_KEYWORD_DECISION_MAX},
});
export function evaluateTreeKeywordSafetyShadow(context,options={}){return evaluateDecisionSite(TREE_KEYWORD_SAFETY_SITE_ID,context,{mode:DECISION_MODE.SHADOW,...options});}
