import { registerDecisionSite } from '../decision/site-registry.js';
import { startDecisionSiteThroughDirector } from '../decision/work-director-bridge.js';
import { DECISION_MODE } from '../decision/constants.js';
import { builder2Fingerprint, clean } from './contracts.js';
import { recordBuilder2DecisionShadow } from './decision-benchmark.js';

export const BUILDER_PARENT_PLACEMENT_SITE_ID='builder.parent-placement.v1';
export const BUILDER_HIERARCHICAL_CLASSIFICATION_SITE_ID='builder.hierarchical-classification.v1';
export const BUILDER_TAXONOMY_STRUCTURE_SITE_ID='builder.taxonomy-structure.v1';
const MAX_SOURCE_CHARS=10000,MAX_TOTAL_EVIDENCE_CHARS=16000,MAX_CANDIDATES=16;
function sourcePacket(source={}){return{sourceKey:clean(source.sourceKey),uid:Number(source.uid),title:clean(source.title),keys:[...(source.keys||[])].map(clean).filter(Boolean),content:String(source.content||''),fingerprint:clean(source.fingerprint),currentPlacement:source.currentPlacement||null};}
function taxonPacket(t={}){return{taxonId:clean(t.taxonId),label:clean(t.label),purpose:clean(t.purpose),aliases:[...(t.aliases||[])].map(clean).filter(Boolean),parentTaxonId:clean(t.parentTaxonId)||null,path:[...(t.path||[])].map(clean).filter(Boolean),entryPolicy:clean(t.entryPolicy||'allow')};}
function evidenceComplete(ctx={}){const sourceChars=String(ctx.source?.content||'').length;const evidenceChars=(ctx.evidenceSources||[]).reduce((n,row)=>n+String(row?.content||'').length,0);const candidates=ctx.candidates||[];return sourceChars<=MAX_SOURCE_CHARS&&evidenceChars<=MAX_TOTAL_EVIDENCE_CHARS&&Array.isArray(candidates)&&candidates.length<=MAX_CANDIDATES;}
function assertBounded(ctx={}){if(!evidenceComplete(ctx)){const error=new Error('Builder Decision Site evidence exceeds its bounded contract.');error.name='TV2BuilderDecisionEvidenceUnbounded';throw error;}}
export function builderDecisionFingerprint(ctx,kind){return builder2Fingerprint({kind,source:sourcePacket(ctx.source),evidenceSources:(ctx.evidenceSources||[]).map(sourcePacket).sort((a,b)=>a.sourceKey.localeCompare(b.sourceKey)),taxonomyRevision:ctx.taxonomy?.revisionId||ctx.taxonomyFingerprint||null,candidates:(ctx.candidates||[]).map(taxonPacket),proposed:ctx.proposed?{...taxonPacket(ctx.proposed),evidenceSourceKeys:[...(ctx.proposed.evidenceSourceKeys||[])].sort()}:null,currentPath:ctx.currentPath||[],authoritativeChoice:ctx.authoritativeChoice||null});}
async function currentFingerprint(ctx,kind){if(typeof ctx.getCurrentFingerprint==='function')return ctx.getCurrentFingerprint(kind);return builderDecisionFingerprint(ctx,kind);}
function choiceCriteria(candidates,extra=[]){return Object.fromEntries([...candidates.map(t=>[clean(t.taxonId),`${clean(t.label)||t.taxonId}${clean(t.purpose)?` — ${clean(t.purpose)}`:''}`]),...extra.map(([id,label])=>[id,label])]);}
function sourceState(ctx){const source=sourcePacket(ctx.source);return{...source,content:source.content};}

export const BUILDER_PARENT_PLACEMENT_SITE=registerDecisionSite({
  id:BUILDER_PARENT_PLACEMENT_SITE_ID,subsystem:'builder2',mode:DECISION_MODE.ASSIST,priority:42,
  contract:{id:BUILDER_PARENT_PLACEMENT_SITE_ID,version:1,subsystem:'builder2',questions:{parent:{type:'choice'},evidence_sufficient:{type:'noul'}}},
  buildState(ctx){assertBounded(ctx);return{runId:ctx.runId||null,source:sourceState(ctx),existingPlacement:ctx.currentPlacement||ctx.source?.currentPlacement||null,candidateParents:(ctx.candidates||[]).map(taxonPacket),taxonomyFingerprint:ctx.taxonomy?.revisionId||ctx.taxonomyFingerprint||null};},
  buildQuestions(ctx){return{parent:{type:'choice',instructions:'Which exact currently legal parent best fits this source concept? Select OTHER if none fit, or REVIEW if evidence/placement is genuinely ambiguous.',criteria:choiceCriteria(ctx.candidates||[],[['OTHER','No listed parent is semantically appropriate'],['REVIEW','Human review is warranted']])},evidence_sufficient:{type:'noul',instructions:'Is the supplied source evidence and candidate-parent context sufficient for a reliable placement judgment?'}};},
  getSourceFingerprint(ctx){return builderDecisionFingerprint(ctx,'parent-placement');},getCurrentSourceFingerprint(ctx){return currentFingerprint(ctx,'parent-placement');},metadata:{shadowOnly:false,assist:true,direct:false,execution:'director-managed',boundary:'before-builder-classification-worker'},
});

export const BUILDER_HIERARCHICAL_CLASSIFICATION_SITE=registerDecisionSite({
  id:BUILDER_HIERARCHICAL_CLASSIFICATION_SITE_ID,subsystem:'builder2',mode:DECISION_MODE.ASSIST,priority:43,
  contract:{id:BUILDER_HIERARCHICAL_CLASSIFICATION_SITE_ID,version:1,subsystem:'builder2',questions:{child:{type:'choice'},evidence_sufficient:{type:'noul'}}},
  buildState(ctx){assertBounded(ctx);return{runId:ctx.runId||null,source:sourceState(ctx),currentTaxonomyPath:ctx.currentPath||[],legalChildren:(ctx.candidates||[]).map(taxonPacket),existingClassification:ctx.existingClassification||null,taxonomyFingerprint:ctx.taxonomy?.revisionId||ctx.taxonomyFingerprint||null};},
  buildQuestions(ctx){return{child:{type:'choice',instructions:'At this one taxonomy level only, which exact existing legal child best fits the source concept? Select STAY to remain at the current level, OTHER if no child fits, or REVIEW if ambiguous.',criteria:choiceCriteria(ctx.candidates||[],[['STAY','Remain at the current taxonomy level'],['OTHER','No listed child fits'],['REVIEW','Human review is warranted']])},evidence_sufficient:{type:'noul',instructions:'Is the supplied evidence sufficient to classify this source reliably at this taxonomy level?'}};},
  getSourceFingerprint(ctx){return builderDecisionFingerprint(ctx,'hierarchical-classification');},getCurrentSourceFingerprint(ctx){return currentFingerprint(ctx,'hierarchical-classification');},metadata:{shadowOnly:false,assist:true,direct:false,execution:'director-managed'},
});

export const BUILDER_TAXONOMY_STRUCTURE_SITE=registerDecisionSite({
  id:BUILDER_TAXONOMY_STRUCTURE_SITE_ID,subsystem:'builder2',mode:DECISION_MODE.ASSIST,priority:41,
  contract:{id:BUILDER_TAXONOMY_STRUCTURE_SITE_ID,version:1,subsystem:'builder2',questions:{warrants_distinct_category:{type:'noul'},semantically_coherent:{type:'noul'},too_broad:{type:'noul'},duplicates_existing_category:{type:'noul'},evidence_sufficient:{type:'noul'},parent:{type:'choice',required:false}}},
  buildState(ctx){assertBounded(ctx);return{runId:ctx.runId||null,proposedCategory:{...taxonPacket(ctx.proposed),evidenceSourceKeys:[...(ctx.proposed?.evidenceSourceKeys||[])]},evidenceSources:(ctx.evidenceSources||[]).map(sourceState),existingLegalParents:(ctx.candidates||[]).map(taxonPacket),taxonomyFingerprint:ctx.taxonomy?.revisionId||ctx.taxonomyFingerprint||null};},
  buildQuestions(ctx){const questions={warrants_distinct_category:{type:'noul',instructions:'Does this proposed concept/group deserve its own distinct taxonomy category rather than being folded into existing structure?'},semantically_coherent:{type:'noul',instructions:'Do the evidence sources form one semantically coherent category concept?'},too_broad:{type:'noul',instructions:'Is the proposed category too broad to be a useful retrieval/classification unit?'},duplicates_existing_category:{type:'noul',instructions:'Does the proposed category substantially duplicate an existing category represented in the supplied candidate context?'},evidence_sufficient:{type:'noul',instructions:'Is the supplied evidence sufficient to judge the proposed category structure reliably?'}};if((ctx.candidates||[]).length)questions.parent={type:'choice',instructions:'Which exact existing legal parent best contains this proposed category? Select ROOT for a root category or REVIEW if uncertain.',criteria:choiceCriteria(ctx.candidates||[],[['ROOT','Place at taxonomy root'],['REVIEW','Human review is warranted']])};return questions;},
  getSourceFingerprint(ctx){return builderDecisionFingerprint(ctx,'taxonomy-structure');},getCurrentSourceFingerprint(ctx){return currentFingerprint(ctx,'taxonomy-structure');},metadata:{shadowOnly:false,assist:true,direct:false,execution:'director-managed'},
});


function decisionFromRun(run){return run?.decision||run?.job?.result?.value?.decision||null;}
export async function evaluateBuilderParentPlacementAssist(ctx,{signal=null}={}){
  if(!evidenceComplete(ctx))return{handled:false,reason:'insufficient-evidence'};
  try{
    const handle=startDecisionSiteThroughDirector(BUILDER_PARENT_PLACEMENT_SITE_ID,ctx,{source:'builder2-parent-placement-assist',mode:DECISION_MODE.ASSIST,signal});
    const run=await handle.promise,result=decisionFromRun(run);if(!result?.ok||result?.stale)return{handled:false,reason:result?.stale?'stale':'decision-failed',result};
    const sufficient=Number(result.answers?.evidence_sufficient?.value),choice=clean(result.answers?.parent?.value);
    if(Number.isFinite(sufficient)&&sufficient<0.5)return{handled:false,reason:'insufficient-evidence',result};
    const legal=new Set((ctx.candidates||[]).map(row=>clean(row.taxonId)));
    if(!legal.has(choice))return{handled:false,reason:choice||'no-legal-choice',result};
    return{handled:true,taxonId:choice,result,reason:'assist-success'};
  }catch(error){return{handled:false,reason:'decision-error',error};}
}

export async function evaluateBuilderHierarchicalClassificationAssist(ctx,{signal=null}={}){
  if(!evidenceComplete(ctx))return{handled:false,reason:'insufficient-evidence'};
  try{
    const handle=startDecisionSiteThroughDirector(BUILDER_HIERARCHICAL_CLASSIFICATION_SITE_ID,ctx,{source:'builder2-hierarchical-classification-assist',mode:DECISION_MODE.ASSIST,signal});
    const run=await handle.promise,result=decisionFromRun(run);if(!result?.ok||result?.stale)return{handled:false,reason:result?.stale?'stale':'decision-failed',result};
    const sufficient=Number(result.answers?.evidence_sufficient?.value),choice=clean(result.answers?.child?.value);
    if(Number.isFinite(sufficient)&&sufficient<0.5)return{handled:false,reason:'insufficient-evidence',result};
    const confidence=Number(result.answers?.child?.confidence);
    if(Number.isFinite(confidence)&&confidence<0.55)return{handled:false,reason:'low-choice-confidence',result};
    const legal=new Set((ctx.candidates||[]).map(row=>clean(row.taxonId)));
    if(!legal.has(choice))return{handled:false,reason:choice||'no-legal-choice',result};
    return{handled:true,taxonId:choice,result,reason:'assist-success'};
  }catch(error){return{handled:false,reason:'decision-error',error};}
}
function start(siteId,ctx,{authoritativeChoice=null,signal=null,source='builder2-shadow'}={}){
  if(!evidenceComplete(ctx)){recordBuilder2DecisionShadow(ctx.runId,siteId,null,{authoritativeChoice,insufficientEvidence:true});return{skipped:true,reason:'insufficient-evidence',siteId};}
  const handle=startDecisionSiteThroughDirector(siteId,ctx,{source,mode:DECISION_MODE.SHADOW,signal});
  handle.promise.then(run=>{const result=run?.decision||run?.job?.result?.value?.decision||null;recordBuilder2DecisionShadow(ctx.runId,siteId,result,{authoritativeChoice});}).catch(error=>{recordBuilder2DecisionShadow(ctx.runId,siteId,{ok:false,error:{message:error?.message||String(error)}},{authoritativeChoice});});
  return handle;
}
export function queueBuilderParentPlacementShadow(ctx,options={}){return start(BUILDER_PARENT_PLACEMENT_SITE_ID,ctx,{...options,source:'builder2-parent-placement-shadow'});}
export function queueBuilderHierarchicalClassificationShadow(ctx,options={}){return start(BUILDER_HIERARCHICAL_CLASSIFICATION_SITE_ID,ctx,{...options,source:'builder2-hierarchical-shadow'});}
export function queueBuilderTaxonomyStructureShadow(ctx,options={}){return start(BUILDER_TAXONOMY_STRUCTURE_SITE_ID,ctx,{...options,source:'builder2-taxonomy-structure-shadow'});}
