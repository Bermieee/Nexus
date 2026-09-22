import { DECISION_MODE } from '../decision/constants.js';
import { registerDecisionSite, evaluateDecisionSite } from '../decision/site-registry.js';
import { clipDecisionText, stableDecisionFingerprint, resolveDecisionFingerprint } from '../decision/site-utils.js';

export const PROPOSAL_REVIEW_TRIAGE_SITE_ID='proposals.review-triage.v1';
export const PROPOSAL_DECISION_MAX=8;
function proposal(row={},index=0){return{id:String(row.id||`P${index+1}`),status:String(row.status||''),source:String(row.source||''),opType:String(row.op?.type||row.type||''),operation:clipDecisionText(JSON.stringify(row.op||row.operation||{}),4500),reason:clipDecisionText(row.reason||row.result||'',1200),ageMs:Math.max(0,Number(row.ageMs)||0),canonicalHints:row.canonicalHints||null};}
function state(context={}){return{scope:context.scope||null,proposals:(context.proposals||[]).slice(0,PROPOSAL_DECISION_MAX).map(proposal)};}
function contractQuestions(){const out={};for(let i=1;i<=PROPOSAL_DECISION_MAX;i+=1){out[`proposal_${i}_priority`]={type:'score',required:false};out[`proposal_${i}_semantic_risk`]={type:'score',required:false};out[`proposal_${i}_evidence_sufficient`]={type:'noul',required:false};out[`proposal_${i}_likely_redundant`]={type:'noul',required:false};}return out;}
function questions(context={}){const out={};(context.proposals||[]).slice(0,PROPOSAL_DECISION_MAX).forEach((_,i)=>{const n=i+1;out[`proposal_${n}_priority`]={type:'score',instructions:`Evaluate only state.proposals[${i}]. How urgently should an operator inspect this proposal relative to ordinary pending review? This is attention triage only, never approval authority.`,criteria:['Can wait','Low','Normal','High','Urgent attention']};out[`proposal_${n}_semantic_risk`]={type:'score',instructions:`Evaluate only state.proposals[${i}]. How much semantic/canonical risk would a mistaken approval carry, ignoring mechanical transaction safety?`,criteria:['Minimal semantic risk','Low','Moderate','High','Very high canon risk']};out[`proposal_${n}_evidence_sufficient`]={type:'noul',instructions:`Evaluate only state.proposals[${i}]. Is the supplied proposal/evidence context sufficient for meaningful operator review, without assuming mutation freshness or commit safety?`};out[`proposal_${n}_likely_redundant`]={type:'noul',instructions:`Evaluate only state.proposals[${i}]. Does the proposed semantic change appear likely redundant with the supplied canonical hints rather than genuinely novel?`};});return out;}
export function proposalReviewTriageFingerprint(context={}){return String(context.sourceFingerprint||stableDecisionFingerprint('proposal-review-triage',state(context)));}

export const PROPOSAL_REVIEW_TRIAGE_SITE=registerDecisionSite({
  id:PROPOSAL_REVIEW_TRIAGE_SITE_ID,subsystem:'proposals',mode:DECISION_MODE.SHADOW,priority:22,
  contract:{id:PROPOSAL_REVIEW_TRIAGE_SITE_ID,version:1,subsystem:'proposals',questions:contractQuestions()},
  buildState:state,buildQuestions:questions,
  getSourceFingerprint:proposalReviewTriageFingerprint,
  getCurrentSourceFingerprint(context){return resolveDecisionFingerprint(context,'proposal-review-triage',state(context));},
  metadata:{shadowOnly:true,boundary:'pending-review-attention-layer',authority:'never-approve-never-mutate',candidateLimit:PROPOSAL_DECISION_MAX},
});
export function evaluateProposalReviewTriageShadow(context,options={}){return evaluateDecisionSite(PROPOSAL_REVIEW_TRIAGE_SITE_ID,context,{mode:DECISION_MODE.SHADOW,...options});}
