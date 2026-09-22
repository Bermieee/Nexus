import { DECISION_MODE } from '../decision/constants.js';
import { registerDecisionSite, evaluateDecisionSite } from '../decision/site-registry.js';
import { clipDecisionText, stableDecisionFingerprint, resolveDecisionFingerprint } from '../decision/site-utils.js';

export const CHARACTER_STATE_REVIEW_PREFLIGHT_SITE_ID='character-state.review-preflight.v1';
export const CHARACTER_STATE_PROPOSAL_AGREEMENT_SITE_ID='character-state.proposal-agreement.v1';
export const CHARACTER_STATE_PROPOSAL_AGREEMENT_MAX=8;

// Initial routing thresholds are intentionally conservative and remain Nexus
// policy, not model-owned behavior. The middle band stays human-reviewable.
export const CHARACTER_STATE_JEV_REVIEW_THRESHOLD=0.35;
export const CHARACTER_STATE_JEV_AGREE_THRESHOLD=0.70;

function preflightPacket(context={}){
  return {
    character:String(context.character||context.bank?.character||'').trim(),
    tracking:context.tracking||context.bank?.tracking||{},
    allowedFields:[...(context.allowedFields||[])].map(String),
    source:{type:String(context.source?.type||''),id:String(context.source?.id||''),label:String(context.source?.label||''),fingerprint:String(context.source?.fingerprint||''),text:clipDecisionText(context.sourceText??context.text??'',16000)},
    currentState:context.currentStateSnapshot||context.currentState||{},
    pendingFields:[...(context.pendingFields||context.bank?.stateProposals||[]).map(row=>String(row?.field||row)).filter(Boolean)],
    configuredOwner:context.configuredOwner!==false,
  };
}
export function characterStateReviewPreflightFingerprint(context={}){return String(context.sourceFingerprint||stableDecisionFingerprint('charstate-preflight',preflightPacket(context)));}

export const CHARACTER_STATE_REVIEW_PREFLIGHT_SITE=registerDecisionSite({
  id:CHARACTER_STATE_REVIEW_PREFLIGHT_SITE_ID,subsystem:'character-state',mode:DECISION_MODE.SHADOW,priority:54,
  contract:{id:CHARACTER_STATE_REVIEW_PREFLIGHT_SITE_ID,version:1,subsystem:'character-state',questions:{
    review_warranted:{type:'noul'},durability_degree:{type:'score'},conflict_risk:{type:'noul'},best_layer:{type:'choice'}
  }},
  buildState(context){return preflightPacket(context);},
  buildQuestions(){return{
    review_warranted:{type:'noul',instructions:'Within tracking and allowedFields only, does the bounded source contain a materially new character-specific state change for the tracked character that is not already represented by currentState or pendingFields and is worth a full Character State review? Ignore facts outside the enabled Tracking Policy.'},
    durability_degree:{type:'score',instructions:'Within allowedFields only, how durable is the strongest supported character-state change in the source?',criteria:['No supported tracked change','Momentary scene-only tracked state','Temporary tracked state worth reviewing now','Persistent tracked continuity change','Baseline-defining tracked change']},
    conflict_risk:{type:'noul',instructions:'Within allowedFields only, does the source materially conflict with an already-canonical Character State value rather than merely adding detail or updating a changed condition?'},
    best_layer:{type:'choice',instructions:'Within allowedFields only, which coarse Character State layer best owns the strongest supported tracked change? This is routing only; do not choose a specific field or write state.',criteria:{NONE:'No tracked Character State change is warranted.',TEMPORARY:'Scene/current-condition tracked state.',PERSISTENT:'Durable tracked continuity state.',BASELINE:'Identity/baseline-defining tracked state.',REVIEW:'Evidence is genuinely ambiguous.'}},
  };},
  getSourceFingerprint(context){return characterStateReviewPreflightFingerprint(context);},
  getCurrentSourceFingerprint(context){return resolveDecisionFingerprint(context,'charstate-preflight',preflightPacket(context));},
  metadata:{shadowOnly:true,boundary:'before-full-character-state-review',authority:'none',purpose:'measure whether enabled Tracking Policy domains warrant full semantic review'},
});
export function evaluateCharacterStateReviewPreflightShadow(context,options={}){return evaluateDecisionSite(CHARACTER_STATE_REVIEW_PREFLIGHT_SITE_ID,context,{mode:DECISION_MODE.SHADOW,...options});}

function proposalPacket(context={}){
  return {
    character:String(context.character||context.bank?.character||'').trim(),
    tracking:context.tracking||context.bank?.tracking||{},
    allowedFields:[...(context.allowedFields||[])].map(String),
    source:{
      type:String(context.source?.type||''),
      id:String(context.source?.id||''),
      label:String(context.source?.label||''),
      fingerprint:String(context.source?.fingerprint||''),
      text:clipDecisionText(context.sourceText??context.text??'',14000),
    },
    currentState:context.currentStateSnapshot||context.currentState||{},
    proposals:(context.proposals||[]).slice(0,CHARACTER_STATE_PROPOSAL_AGREEMENT_MAX).map((row,index)=>({
      slot:index+1,
      field:String(row?.field||''),
      trackingDomain:String(row?.trackingDomain||''),
      classification:String(row?.classification||''),
      currentValue:clipDecisionText(row?.currentValue||'',3200),
      proposedValue:clipDecisionText(row?.proposedValue||'',4200),
      reason:clipDecisionText(row?.reason||'',1200),
      evidence:(row?.evidence||[]).slice(0,6).map(value=>clipDecisionText(value,1200)),
    })),
  };
}
function proposalContractQuestions(){
  const out={};
  for(let i=1;i<=CHARACTER_STATE_PROPOSAL_AGREEMENT_MAX;i+=1){
    out[`proposal_${i}_supported`]={type:'noul',required:false};
    out[`proposal_${i}_policy_fit`]={type:'noul',required:false};
    out[`proposal_${i}_state_change`]={type:'noul',required:false};
  }
  return out;
}
function proposalQuestions(context={}){
  const out={};
  (context.proposals||[]).slice(0,CHARACTER_STATE_PROPOSAL_AGREEMENT_MAX).forEach((_,index)=>{
    const n=index+1,path=`proposals[${index}]`;
    out[`proposal_${n}_supported`]={
      type:'noul',
      instructions:`Evaluate only \`${path}\`. Is its proposedValue directly supported by source.text/evidence for the tracked character, without inventing a trait, motive, condition, relationship, goal, or behavior pattern that the source does not establish?`,
    };
    out[`proposal_${n}_policy_fit`]={
      type:'noul',
      instructions:`Evaluate only \`${path}\` together with tracking and allowedFields. Does this proposal genuinely belong to its stated trackingDomain and an enabled Tracking Policy field, rather than merely being adjacent narrative information?`,
    };
    out[`proposal_${n}_state_change`]={
      type:'noul',
      instructions:`Evaluate only \`${path}\` against currentState. Is this a meaningful Character State delta worth showing to the operator, rather than a redundant restatement, one-off flavor with no tracked state value, or an overgeneralization from a single moment?`,
    };
  });
  return out;
}
export function characterStateProposalAgreementFingerprint(context={}){return String(context.sourceFingerprint||stableDecisionFingerprint('charstate-agreement',proposalPacket(context)));}
function answerValue(result,id){const raw=result?.answers?.[id];const value=Number(raw?.value??raw?.probability??raw?.noul);return Number.isFinite(value)?value:null;}

export const CHARACTER_STATE_PROPOSAL_AGREEMENT_SITE=registerDecisionSite({
  id:CHARACTER_STATE_PROPOSAL_AGREEMENT_SITE_ID,subsystem:'character-state',mode:DECISION_MODE.ASSIST,priority:56,
  contract:{id:CHARACTER_STATE_PROPOSAL_AGREEMENT_SITE_ID,version:1,subsystem:'character-state',questions:proposalContractQuestions()},
  buildState(context){return proposalPacket(context);},
  buildQuestions:proposalQuestions,
  getSourceFingerprint:characterStateProposalAgreementFingerprint,
  getCurrentSourceFingerprint(context){return resolveDecisionFingerprint(context,'charstate-agreement',proposalPacket(context));},
  providerPolicy:{fallbackEnabled:false},
  metadata:{shadowOnly:false,assist:true,boundary:'after-sidecar-draft-before-operator-review-publication',authority:'never-approve-never-mutate',humanReviewFinal:true,candidateLimit:CHARACTER_STATE_PROPOSAL_AGREEMENT_MAX},
});

export function interpretCharacterStateProposalAgreement(result,proposals=[]){
  const rows=(proposals||[]).slice(0,CHARACTER_STATE_PROPOSAL_AGREEMENT_MAX).map((proposal,index)=>{
    const n=index+1;
    const supported=answerValue(result,`proposal_${n}_supported`);
    const policyFit=answerValue(result,`proposal_${n}_policy_fit`);
    const stateChange=answerValue(result,`proposal_${n}_state_change`);
    const values=[supported,policyFit,stateChange];
    let status='unavailable';
    if(values.every(Number.isFinite)){
      const minimum=Math.min(...values);
      status=minimum<CHARACTER_STATE_JEV_REVIEW_THRESHOLD?'rejected':minimum>=CHARACTER_STATE_JEV_AGREE_THRESHOLD?'agreed':'uncertain';
    }
    return {proposal,status,supported,policyFit,stateChange};
  });
  return rows;
}

export function evaluateCharacterStateProposalAgreementAssist(context,options={}){
  return evaluateDecisionSite(CHARACTER_STATE_PROPOSAL_AGREEMENT_SITE_ID,context,{mode:DECISION_MODE.ASSIST,...options});
}
