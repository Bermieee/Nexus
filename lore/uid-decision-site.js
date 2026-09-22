import { DECISION_MODE } from '../decision/constants.js';
import { registerDecisionSite, evaluateDecisionSite } from '../decision/site-registry.js';
import { clipDecisionText, stableDecisionFingerprint, resolveDecisionFingerprint } from '../decision/site-utils.js';

export const UID_SUMMARY_DRAFT_REVIEW_SITE_ID='uid-summary.draft-review.v1';
export const UID_SUMMARY_DECISION_MAX_DRAFTS=3;
function draft(row={},index=0){return{id:String(row.id||row.profile||`DRAFT_${index+1}`),profile:String(row.profile||row.label||''),summary:clipDecisionText(row.summary||'',12000),keywords:Array.isArray(row.keywords)?row.keywords.map(String).slice(0,12):[],notes:clipDecisionText(row.notes||'',1200)};}
function state(context={}){return{sourceIdentity:context.sourceIdentity||{},sourceDigest:clipDecisionText(context.sourceDigest||context.sourceExcerpt||'',12000),drafts:(context.drafts||context.options||[]).slice(0,UID_SUMMARY_DECISION_MAX_DRAFTS).map(draft)};}
function contractQuestions(){const out={preferred_draft:{type:'choice'}};for(let i=1;i<=UID_SUMMARY_DECISION_MAX_DRAFTS;i+=1){out[`draft_${i}_faithful`]={type:'noul',required:false};out[`draft_${i}_coverage`]={type:'score',required:false};out[`draft_${i}_retrieval_utility`]={type:'score',required:false};}return out;}
function questions(context={}){const rows=(context.drafts||context.options||[]).slice(0,UID_SUMMARY_DECISION_MAX_DRAFTS);const out={preferred_draft:{type:'choice',instructions:'Which supplied draft is the strongest review recommendation when balancing source faithfulness, durable canon coverage, useful compression, and future retrieval utility? This recommendation must never stage or approve a draft automatically.',criteria:{...Object.fromEntries(rows.map((row,i)=>[`DRAFT_${i+1}`,String(row.profile||row.label||`Draft ${i+1}`)])),REVIEW:'No draft is clearly preferable; operator review should decide.'}}};rows.forEach((_,i)=>{const n=i+1;out[`draft_${n}_faithful`]={type:'noul',instructions:`Evaluate only state.drafts[${i}]. Is the draft faithful to the supplied source identity/digest without inventing or materially distorting canon?`};out[`draft_${n}_coverage`]={type:'score',instructions:`Evaluate only state.drafts[${i}]. How well does it preserve load-bearing durable canon and continuity from the supplied source digest?`,criteria:['Misses major canon','Substantial omissions','Adequate core coverage','Strong coverage','Excellent complete coverage']};out[`draft_${n}_retrieval_utility`]={type:'score',instructions:`Evaluate only state.drafts[${i}]. How useful and specific is this draft as a future lore retrieval unit rather than generic prose?`,criteria:['Poor retrieval unit','Weakly targeted','Usable','Strongly targeted','Excellent retrieval utility']};});return out;}
export function uidSummaryDraftReviewFingerprint(context={}){return String(context.sourceFingerprint||stableDecisionFingerprint('uid-draft-review',state(context)));}

export const UID_SUMMARY_DRAFT_REVIEW_SITE=registerDecisionSite({
  id:UID_SUMMARY_DRAFT_REVIEW_SITE_ID,subsystem:'uid-summarizer',mode:DECISION_MODE.SHADOW,priority:38,
  contract:{id:UID_SUMMARY_DRAFT_REVIEW_SITE_ID,version:1,subsystem:'uid-summarizer',questions:contractQuestions()},
  buildState:state,buildQuestions:questions,
  getSourceFingerprint:uidSummaryDraftReviewFingerprint,
  getCurrentSourceFingerprint(context){return resolveDecisionFingerprint(context,'uid-draft-review',state(context));},
  metadata:{shadowOnly:true,boundary:'after-validated-draft-generation-before-operator-selection',authority:'recommendation-only',draftLimit:UID_SUMMARY_DECISION_MAX_DRAFTS},
});
export function evaluateUidSummaryDraftReviewShadow(context,options={}){return evaluateDecisionSite(UID_SUMMARY_DRAFT_REVIEW_SITE_ID,context,{mode:DECISION_MODE.SHADOW,...options});}
