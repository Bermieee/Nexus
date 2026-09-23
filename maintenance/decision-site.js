import { DECISION_MODE, DECISION_PROVIDER_CLASS } from '../decision/constants.js';
import { registerDecisionSite, evaluateDecisionSite } from '../decision/site-registry.js';
import { clipDecisionText } from '../decision/site-utils.js';
import { createDecisionFreshnessContract, decisionFreshnessSnapshot } from '../decision/freshness.js';

export const MAINTENANCE_FINDING_TRIAGE_SITE_ID='maintenance.finding-triage.v1';
export const MAINTENANCE_DECISION_MAX=8;
export const MAINTENANCE_TRIAGE_LOW_CONFIDENCE=0.45;
const ROUTES=new Set(['DETERMINISTIC','OPERATOR','SIDECAR','DEFER']);

function serializableText(value,max=9000){
  let text='';
  try{text=typeof value==='string'?value:JSON.stringify(value??null);}catch{text=String(value??'');}
  return clipDecisionText(text,max);
}
function finding(row={},index=0){
  return{
    id:String(row.id||`F${index+1}`),
    category:String(row.category||row.kind||row.type||'REVIEW'),
    title:String(row.title||''),
    book:row.book==null?null:String(row.book),
    provenance:row.provenance||null,
    deterministicEvidence:serializableText(row.deterministicEvidence??row.evidence??row.reason??row.summary??'',5000),
    semanticEvidence:serializableText(row.decisionEvidence??'',9000),
    deterministicSeverity:String(row.severity||''),
    refs:Array.isArray(row.refs)?row.refs.slice(0,12):[],
  };
}
function state(context={}){
  return{maintenanceScope:context.maintenanceScope||null,pressure:context.pressure||null,findings:(context.findings||[]).slice(0,MAINTENANCE_DECISION_MAX).map(finding)};
}
function contractQuestions(){
  const out={};
  for(let i=1;i<=MAINTENANCE_DECISION_MAX;i+=1){out[`finding_${i}_priority`]={type:'score',required:false};out[`finding_${i}_semantic_review`]={type:'noul',required:false};out[`finding_${i}_route`]={type:'choice',required:false};}
  return out;
}
function questions(context={}){
  const out={};
  (context.findings||[]).slice(0,MAINTENANCE_DECISION_MAX).forEach((_,i)=>{
    const n=i+1;
    out[`finding_${n}_priority`]={type:'score',instructions:`Evaluate only state.findings[${i}]. How important is this deterministic finding for maintenance attention? Do not decide or apply a mutation.`,criteria:['No meaningful attention','Low','Routine','High','Critical review attention']};
    out[`finding_${n}_semantic_review`]={type:'noul',instructions:`Evaluate only state.findings[${i}]. Does resolving or explaining this finding require semantic judgment beyond its deterministic evidence? This is admission/triage only; never approve or apply a change.`};
    out[`finding_${n}_route`]={type:'choice',instructions:`Evaluate only state.findings[${i}]. Choose the next review route. This choice is advisory triage only and cannot mutate lore, approve a proposal, or replace operator authority.`,criteria:{DETERMINISTIC:'The deterministic evidence is sufficient; no generative review is needed.',OPERATOR:'A human can review the finding directly without generative synthesis.',SIDECAR:'Generative explanation/synthesis is useful before operator review.',DEFER:'Evidence is incomplete or uncertain; preserve the finding and fail open to the existing safe review path.'}};
  });
  return out;
}
function freshnessInput(context={}){return{revisions:{housekeeperSource:String(context.sourceSignature||'')},material:state(context)};}
export function maintenanceFindingTriageFingerprint(context={}){return decisionFreshnessSnapshot(MAINTENANCE_FINDING_TRIAGE_SITE_ID,freshnessInput(context)).fingerprint;}
const MAINTENANCE_FRESHNESS=createDecisionFreshnessContract({siteId:MAINTENANCE_FINDING_TRIAGE_SITE_ID,buildCanonicalInput:freshnessInput});

export const MAINTENANCE_FINDING_TRIAGE_SITE=registerDecisionSite({
  id:MAINTENANCE_FINDING_TRIAGE_SITE_ID,subsystem:'maintenance',mode:DECISION_MODE.ASSIST,priority:70,
  contract:{id:MAINTENANCE_FINDING_TRIAGE_SITE_ID,version:1,subsystem:'maintenance',questions:contractQuestions()},
  buildState:state,buildQuestions:questions,freshness:MAINTENANCE_FRESHNESS,
  providerPolicy:{fallbackEnabled:false,allowProviderFallback:true},
  metadata:{shadowOnly:false,assist:true,boundary:'after-deterministic-maintenance-scan-before-optional-housekeeper-review',authority:'triage-only',canonicalMutation:false,humanReviewFinal:true,candidateLimit:MAINTENANCE_DECISION_MAX},
});

function answerValue(answer){const value=Number(answer?.value??answer?.probability??answer?.score??answer?.noul);return Number.isFinite(value)?value:null;}
function answerChoice(answer){return String(answer?.value??answer?.choice??'').trim().toUpperCase();}
function answerConfidence(answer){const value=Number(answer?.confidence);return Number.isFinite(value)?Math.max(0,Math.min(1,value)):null;}

export function interpretMaintenanceFindingTriage(result,findings=[]){
  const bounded=(Array.isArray(findings)?findings:[]).slice(0,MAINTENANCE_DECISION_MAX);
  if(!result?.ok||result?.stale)return{handled:false,reason:result?.stale?'stale':'decision-unavailable',result,rows:bounded.map(row=>({finding:row,sidecarRequired:true,uncertain:true}))};
  if(result.providerClass!==DECISION_PROVIDER_CLASS.TYPED_DECISION)return{handled:false,reason:'non-typed-provider',result,rows:bounded.map(row=>({finding:row,sidecarRequired:true,uncertain:true}))};
  const rows=bounded.map((row,index)=>{
    const n=index+1,priority=answerValue(result.answers?.[`finding_${n}_priority`]),semanticReview=answerValue(result.answers?.[`finding_${n}_semantic_review`]),route=answerChoice(result.answers?.[`finding_${n}_route`]);
    const confidenceValues=[answerConfidence(result.answers?.[`finding_${n}_priority`]),answerConfidence(result.answers?.[`finding_${n}_semantic_review`]),answerConfidence(result.answers?.[`finding_${n}_route`])].filter(Number.isFinite),confidence=confidenceValues.length?Math.min(...confidenceValues):null;
    const malformed=!ROUTES.has(route)||!Number.isFinite(semanticReview),uncertain=malformed||(confidence!=null&&confidence<MAINTENANCE_TRIAGE_LOW_CONFIDENCE),contradictoryDeterministic=route==='DETERMINISTIC'&&Number.isFinite(semanticReview)&&semanticReview>=0.5,sidecarRequired=uncertain||route==='SIDECAR'||route==='DEFER'||contradictoryDeterministic;
    return{finding:row,priority,semanticReview,route:ROUTES.has(route)?route:'DEFER',confidence,uncertain,sidecarRequired,reason:uncertain?'uncertain':contradictoryDeterministic?'conflicting-triage':route.toLowerCase()};
  });
  return{handled:true,reason:'assist-success',result,rows};
}
export async function evaluateMaintenanceFindingTriageAssist(context,options={}){const result=await evaluateDecisionSite(MAINTENANCE_FINDING_TRIAGE_SITE_ID,context,{mode:DECISION_MODE.ASSIST,...options});return interpretMaintenanceFindingTriage(result,context.findings||[]);}
export function evaluateMaintenanceFindingTriageShadow(context,options={}){return evaluateDecisionSite(MAINTENANCE_FINDING_TRIAGE_SITE_ID,context,{mode:DECISION_MODE.SHADOW,...options});}
