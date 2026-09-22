import {
  BUILDER2_PHASE, BUILDER2_CLASSIFICATION_DECISION,
  createBuilder2Plan, createBuilder2SourceRevision, createBuilder2TreeRevision, createBuilder2Classification, clean
} from './contracts.js';
import { createBuilder2ReviewToken, assertBuilder2ReviewToken } from './review-token.js';
import { fenceBuilder2Continuation } from './freshness-gate.js';
import { surveyBuilder2Corpus } from './survey.js';
import { planBuilder2Taxonomy, applyBuilder2TaxonomyReview, createBuilder2ExistingTaxonomy } from './taxonomy-engine.js';
import { classifyBuilder2Sources, applyBuilder2ClassificationReview, rebaseBuilder2ClassificationsForTaxonomy } from './classification-engine.js';
import { collectBuilder2Gaps, consolidateBuilder2Gaps, createBuilder2FallbackGapProposals, applyBuilder2GapReview } from './gap-engine.js';
import { proposeBuilder2Reconciliation, applyBuilder2Reconciliation } from './reconciliation-engine.js';
import { evaluateBuilder2Quality } from './quality-gate.js';
import { createBuilder2StructuralHandoff, buildBuilder2ProspectivePopulation } from './structural-handoff.js';
import { createBuilder2Preview } from './preview.js';
import { validateBuilder2Materialization } from './validation.js';
import { createBuilder2CommitEnvelope } from './commit-envelope.js';
import { createBuilder2LedgerArtifact } from './ledger-bridge.js';
import { builderDecisionFingerprint, evaluateBuilderParentPlacementAssist, evaluateBuilderHierarchicalClassificationAssist } from './decision-sites.js';
import { beginBuilder2DecisionBenchmark, finishBuilder2DecisionBenchmark, recordBuilder2Cycle } from './decision-benchmark.js';
import { builder2SemanticRoundFingerprint, inspectBuilder2SemanticNonProgress, builder2SemanticProgressMetadata } from './non-progress-guard.js';

const REVIEW_KIND={
  [BUILDER2_PHASE.TAXONOMY_REVIEW]:'taxonomy-review',
  [BUILDER2_PHASE.CLASSIFICATION_REVIEW]:'classification-review',
  [BUILDER2_PHASE.GAP_REVIEW]:'gap-review',
  [BUILDER2_PHASE.DRAFT_REVIEW]:'draft-review',
  [BUILDER2_PHASE.RECONCILIATION]:'reconciliation-review',
  [BUILDER2_PHASE.QUALITY_REVIEW]:'quality-review',
  [BUILDER2_PHASE.VALIDATION]:'preview',
};
function sourceKey(s){return `${s.book}#${s.uid}`;}
function assertRemovalAuthority(workset,corpus){const active=new Map(corpus.filter(s=>!s.removed).map(s=>[sourceKey(s),s]));for(const s of workset)if(s.removed&&active.has(sourceKey(s)))throw new Error(`Builder 2 removal tombstone for ${sourceKey(s)} is stale because the UID exists in the authoritative corpus.`);}
function replaceByKey(all,replacements){const map=new Map(all.map(x=>[x.sourceKey,x]));for(const r of replacements)map.set(r.sourceKey,r);return [...map.values()].sort((a,b)=>a.sourceKey.localeCompare(b.sourceKey));}
function activeSourceKeys(sources=[]){return (sources||[]).filter(s=>!s.disabled&&!s.removed).map(s=>s.sourceKey);}
function unique(values=[]){return [...new Set((values||[]).filter(Boolean))];}
function consolidatedReview(plan){return clean(plan?.metadata?.reviewFlow).toLowerCase()==='consolidated';}
const REUSE_PHASE_ORDER=[BUILDER2_PHASE.INVENTORY,BUILDER2_PHASE.SURVEY,BUILDER2_PHASE.TAXONOMY_DRAFT,BUILDER2_PHASE.TAXONOMY_REVIEW,BUILDER2_PHASE.CLASSIFICATION,BUILDER2_PHASE.CLASSIFICATION_REVIEW,BUILDER2_PHASE.GAP_REVIEW,BUILDER2_PHASE.DRAFT_REVIEW,BUILDER2_PHASE.RECLASSIFICATION,BUILDER2_PHASE.RECONCILIATION,BUILDER2_PHASE.QUALITY_REVIEW,BUILDER2_PHASE.MATERIALIZATION,BUILDER2_PHASE.VALIDATION,BUILDER2_PHASE.STAGED,BUILDER2_PHASE.COMMITTED];
const REUSE_PHASE_RANK=new Map(REUSE_PHASE_ORDER.map((phase,index)=>[phase,index]));
function phaseAtLeast(phase,target){return (REUSE_PHASE_RANK.get(phase)??-1)>=(REUSE_PHASE_RANK.get(target)??Number.MAX_SAFE_INTEGER);}
export class Builder2Pipeline {
  constructor({store,semantic,readCurrentAuthority=null,contextLoader=null,signal=null,config={}}={}){
    if(!store)throw new Error('Builder 2 pipeline requires PlanStore.');this.store=store;this.semantic=semantic||{};this.readCurrentAuthority=readCurrentAuthority;this.contextLoader=contextLoader;this.signal=signal||null;this.config={surveyMaxEntries:24,surveyMaxChars:24000,classifyMaxEntries:24,semanticInputTargetTokens:null,classifyMaxTaxa:96,routeCandidateLimit:48,reconciliationMaxComponent:12,semanticReconciliation:false,...config};this.contexts=new Map();
  }
  #ensureLive(){if(this.signal?.aborted)throw this.signal.reason||new DOMException('Builder 2 cancelled.','AbortError');}
  async #context(plan){if(this.contexts.has(plan.runId))return this.contexts.get(plan.runId);if(typeof this.contextLoader==='function'){const c=await this.contextLoader(plan);if(c){this.contexts.set(plan.runId,c);return c;}}throw new Error(`Builder 2 context unavailable for ${plan.runId}; recovery requires contextLoader.`);}
  async #current(plan){if(typeof this.readCurrentAuthority==='function')return this.readCurrentAuthority(plan);const c=await this.#context(plan);return{sourceRevision:createBuilder2SourceRevision(c.worksetSources).revisionId,corpusRevision:createBuilder2SourceRevision(c.corpusSources).revisionId,treeRevision:createBuilder2TreeRevision(c.treeInventory)?.revisionId||null};}
  async #fence(plan,stage){const current=await this.#current(plan);return fenceBuilder2Continuation({store:this.store,runId:plan.runId,current,stage});}
  async #readFresh(runId,stage){this.#ensureLive();const p=await this.store.read(runId);if(!p)throw new Error(`Builder 2 missing run ${runId}.`);const f=await this.#fence(p,stage);if(!f.allowed){const e=new Error(`Builder 2 run ${runId} is stale: ${(f.verdict.reasons||[]).join(', ')}`);e.name='Builder2StaleError';e.reasons=f.verdict.reasons;throw e;}return f.plan;}
  #decisionContext(runId,ctx){
    const base={...ctx,runId};
    base.getCurrentFingerprint=async kind=>{
      const latest=await this.store.read(runId);if(!latest)return `missing-run:${runId}`;
      const authority=await this.#current(latest);
      if(clean(authority.sourceRevision)!==clean(latest.sourceRevision)||clean(authority.corpusRevision)!==clean(latest.corpusRevision)||clean(authority.treeRevision)!==clean(latest.treeRevision))return `stale-authority:${authority.sourceRevision}:${authority.corpusRevision}:${authority.treeRevision}`;
      const taxonomy=latest.taxonomy||ctx.taxonomy;const ids=new Set((ctx.candidates||[]).map(row=>row.taxonId));const candidates=(taxonomy?.nodes||[]).filter(row=>ids.has(row.taxonId));
      return builderDecisionFingerprint({...base,taxonomy,candidates},kind);
    };
    return base;
  }
  async #findReusablePlan({runId,book,sourceRevision,corpusRevision,treeRevision}={}){
    if(typeof this.store?.listRunIds!=='function')return null;
    let best=null,bestScore=-1;
    for(const id of await this.store.listRunIds()){
      if(clean(id)===clean(runId))continue;
      let candidate=null;try{candidate=await this.store.read(id);}catch{continue;}
      if(!candidate||clean(candidate.book)!==clean(book)||[BUILDER2_PHASE.CANCELLED,BUILDER2_PHASE.STALE].includes(candidate.phase))continue;
      if(clean(candidate.sourceRevision)!==clean(sourceRevision)||clean(candidate.corpusRevision||candidate.sourceRevision)!==clean(corpusRevision)||clean(candidate.treeRevision)!==clean(treeRevision))continue;
      let score=0;
      if(candidate.survey?.semanticMap?.length||candidate.survey?.surveyFingerprint)score+=10;
      if(candidate.taxonomy?.nodes?.length)score+=20;
      if(candidate.taxonomyReview?.approved===true||phaseAtLeast(candidate.phase,BUILDER2_PHASE.CLASSIFICATION))score+=10;
      score+=Math.min(30,(candidate.classifications||[]).length?30:0);
      if((candidate.proposedExpansions||[]).length)score+=4;
      if(candidate.reconciliation)score+=5;
      if(phaseAtLeast(candidate.phase,BUILDER2_PHASE.QUALITY_REVIEW))score+=15;
      score+=Math.min(9,Math.max(0,Number(candidate.updatedAt||0)/1e15));
      if(score>bestScore||(score===bestScore&&Number(candidate.updatedAt||0)>Number(best?.updatedAt||0))){best=candidate;bestScore=score;}
    }
    return best;
  }
  #reuseClassifications(candidate,taxonomy,worksetSources=[]){
    const active=new Map((worksetSources||[]).filter(s=>!s.disabled&&!s.removed).map(s=>[s.sourceKey,s]));
    const compatible=(candidate?.classifications||[]).filter(row=>active.get(row.sourceKey)?.fingerprint===row.sourceFingerprint);
    const rebased=rebaseBuilder2ClassificationsForTaxonomy(compatible,taxonomy);
    const present=new Set(rebased.classifications.map(row=>row.sourceKey));
    return{classifications:rebased.classifications,missingSourceKeys:[...active.keys()].filter(key=>!present.has(key)),invalidatedSourceKeys:rebased.invalidatedSourceKeys};
  }
  async #continueReusableStart(runId,candidate){
    let plan=await this.#readFresh(runId,'reuse-start');const ctx=await this.#context(plan);
    const survey=candidate?.survey?.semanticMap?.length||candidate?.survey?.surveyFingerprint?structuredClone(candidate.survey):null;
    const taxonomy=candidate?.taxonomy?.nodes?.length?structuredClone(candidate.taxonomy):null;
    const taxonomyApproved=!!taxonomy&&(candidate.taxonomyReview?.approved===true||phaseAtLeast(candidate.phase,BUILDER2_PHASE.CLASSIFICATION));
    if(!survey)return this.#runSurveyTaxonomy(runId);
    if(!taxonomy){
      plan=await this.store.transition(runId,BUILDER2_PHASE.TAXONOMY_DRAFT,{survey,metadata:{...(plan.metadata||{}),artifactReuse:{fromRunId:candidate.runId,survey:true}}});
      const nextTaxonomy=await planBuilder2Taxonomy({sourceRevision:plan.sourceRevision,corpusRevision:plan.corpusRevision,treeRevision:plan.treeRevision,survey,treeInventory:ctx.treeInventory,planTaxonomy:this.semantic.planTaxonomy,signal:this.signal});
      plan=await this.#readFresh(runId,'reuse-post-taxonomy-plan');
      if(consolidatedReview(plan)){const accepted=applyBuilder2TaxonomyReview(nextTaxonomy,{approved:true});plan=await this.store.transition(runId,BUILDER2_PHASE.CLASSIFICATION,{survey,taxonomy:accepted,taxonomyRevision:accepted.revisionId,taxonomyReview:{approved:true,automatic:true,reusedFromRunId:candidate.runId},metadata:{...(plan.metadata||{}),artifactReuse:{fromRunId:candidate.runId,survey:true},consolidatedProgress:{taxonomyDrafted:true,taxonomyAutoAccepted:true}}});return this.#runClassification(runId);}plan=await this.store.transition(runId,BUILDER2_PHASE.TAXONOMY_REVIEW,{taxonomy:nextTaxonomy,taxonomyRevision:nextTaxonomy.revisionId});return this.reviewRequest(plan);
    }
    if(!taxonomyApproved){
      if(consolidatedReview(plan)){const accepted=applyBuilder2TaxonomyReview(taxonomy,{approved:true});plan=await this.store.transition(runId,BUILDER2_PHASE.CLASSIFICATION,{survey,taxonomy:accepted,taxonomyRevision:accepted.revisionId,taxonomyReview:{approved:true,automatic:true,reusedFromRunId:candidate.runId},metadata:{...(plan.metadata||{}),artifactReuse:{fromRunId:candidate.runId,survey:true,taxonomyDraft:true},consolidatedProgress:{taxonomyAutoAccepted:true}}});return this.#runClassification(runId);}
      plan=await this.store.transition(runId,BUILDER2_PHASE.TAXONOMY_REVIEW,{survey,taxonomy,taxonomyRevision:taxonomy.revisionId,metadata:{...(plan.metadata||{}),artifactReuse:{fromRunId:candidate.runId,survey:true,taxonomyDraft:true}}});return this.reviewRequest(plan);
    }
    const reused=this.#reuseClassifications(candidate,taxonomy,ctx.worksetSources);
    let reusedClassifications=reused.classifications;
    const missing=unique([...reused.missingSourceKeys,...reused.invalidatedSourceKeys]);
    const metadata={...(plan.metadata||{}),artifactReuse:{fromRunId:candidate.runId,survey:true,taxonomy:true,classificationCount:reusedClassifications.length,missingClassificationCount:missing.length}};
    if(missing.length){
      plan=await this.store.transition(runId,BUILDER2_PHASE.CLASSIFICATION,{survey,taxonomy,taxonomyRevision:taxonomy.revisionId,taxonomyReview:{approved:true,reusedFromRunId:candidate.runId},classifications:reusedClassifications,classificationPlanning:{pendingSourceKeys:missing,status:'pending',reason:'artifact-reuse-miss'},metadata});
      return this.#runClassification(runId,{onlySourceKeys:missing,merge:true});
    }
    const ambiguous=reusedClassifications.filter(row=>row.decision===BUILDER2_CLASSIFICATION_DECISION.AMBIGUOUS);
    if(ambiguous.length&&consolidatedReview(plan)){
      reusedClassifications=await this.#resolveAmbiguousWithDecisionCore(runId,{taxonomy,classifications:reusedClassifications,evidenceSources:ctx.worksetSources});
    }
    const remainingAmbiguous=reusedClassifications.filter(row=>row.decision===BUILDER2_CLASSIFICATION_DECISION.AMBIGUOUS);
    if(remainingAmbiguous.length&&!consolidatedReview(plan)){
      plan=await this.store.transition(runId,BUILDER2_PHASE.CLASSIFICATION_REVIEW,{survey,taxonomy,taxonomyRevision:taxonomy.revisionId,taxonomyReview:{approved:true,reusedFromRunId:candidate.runId},classifications:reusedClassifications,classificationReview:{pending:remainingAmbiguous.map(row=>row.sourceKey),reusedFromRunId:candidate.runId},metadata});return this.reviewRequest(plan);
    }
    const gaps=collectBuilder2Gaps(reusedClassifications);
    const reusableGapReview=phaseAtLeast(candidate.phase,BUILDER2_PHASE.GAP_REVIEW)&&(candidate.proposedExpansions||[]).length&&gaps.length;
    if(reusableGapReview){
      const proposals=structuredClone(candidate.proposedExpansions),gapPlanning={...(candidate.gapPlanning||{}),reusedFromRunId:candidate.runId};
      if(consolidatedReview(plan))return this.#prepareDraftReview(runId,{classifications:reusedClassifications,taxonomy,gaps,proposals,gapPlanning,metadataPatch:metadata});
      plan=await this.store.transition(runId,BUILDER2_PHASE.GAP_REVIEW,{survey,taxonomy,taxonomyRevision:taxonomy.revisionId,taxonomyReview:{approved:true,reusedFromRunId:candidate.runId},classifications:reusedClassifications,taxonomyGaps:gaps,proposedExpansions:proposals,gapPlanning,metadata});return this.reviewRequest(plan);
    }
    if(gaps.length){
      plan=await this.store.transition(runId,BUILDER2_PHASE.CLASSIFICATION,{survey,taxonomy,taxonomyRevision:taxonomy.revisionId,taxonomyReview:{approved:true,reusedFromRunId:candidate.runId},classifications:reusedClassifications,metadata});return this.#prepareGaps(runId,reusedClassifications);
    }
    if(candidate.phase===BUILDER2_PHASE.RECONCILIATION&&candidate.reconciliation?.proposals?.length){
      plan=await this.store.transition(runId,BUILDER2_PHASE.RECONCILIATION,{survey,taxonomy,taxonomyRevision:taxonomy.revisionId,taxonomyReview:{approved:true,reusedFromRunId:candidate.runId},classifications:reusedClassifications,reconciliation:structuredClone(candidate.reconciliation),metadata});return this.reviewRequest(plan);
    }
    plan=await this.store.transition(runId,BUILDER2_PHASE.RECLASSIFICATION,{survey,taxonomy,taxonomyRevision:taxonomy.revisionId,taxonomyReview:{approved:true,reusedFromRunId:candidate.runId},classifications:reusedClassifications,reconciliation:phaseAtLeast(candidate.phase,BUILDER2_PHASE.QUALITY_REVIEW)?structuredClone(candidate.reconciliation):null,metadata});
    if(phaseAtLeast(candidate.phase,BUILDER2_PHASE.QUALITY_REVIEW))return this.#runQuality(runId,{taxonomy,classifications:reusedClassifications,reconciliation:structuredClone(candidate.reconciliation)});
    return this.#prepareReconciliation(runId,reusedClassifications,{taxonomy});
  }
  async start({runId,book,mode='full',worksetSources=null,corpusSources=[],treeInventory=null,validateOnly=false,metadata={}}={}){
    const corpus=createBuilder2SourceRevision(corpusSources);const workset=createBuilder2SourceRevision(mode==='full'?(worksetSources||corpus.sources):(worksetSources||[]));assertRemovalAuthority(workset.sources,corpus.sources);
    const treeRevision=createBuilder2TreeRevision(treeInventory);const reusable=await this.#findReusablePlan({runId,book,sourceRevision:workset.revisionId,corpusRevision:corpus.revisionId,treeRevision:treeRevision?.revisionId||null});
    const plan=createBuilder2Plan({runId,book,mode,phase:BUILDER2_PHASE.INVENTORY,sourceRevision:workset.revisionId,corpusRevision:corpus.revisionId,treeRevision:treeRevision?.revisionId||null,structuralBaselineTaxonomy:{nodes:createBuilder2ExistingTaxonomy(treeInventory||{})},metadata:{...structuredClone(metadata||{}),worksetSourceKeys:workset.sources.map(s=>s.sourceKey),worksetCount:workset.sourceCount,corpusCount:corpus.sourceCount,validateOnly:validateOnly===true,artifactReuseCandidate:reusable?.runId||null}});
    this.contexts.set(plan.runId,{worksetSources:workset.sources,corpusSources:corpus.sources,treeInventory:structuredClone(treeInventory||{nodes:[],membershipComplete:true})});beginBuilder2DecisionBenchmark(plan.runId,{book:plan.book,mode:plan.mode,sourceCount:workset.sourceCount});await this.store.write(plan);
    if(reusable)return this.#continueReusableStart(plan.runId,reusable);
    return this.#runSurveyTaxonomy(plan.runId);
  }
  async resume(runId){
    let plan=await this.store.read(runId);if(!plan)throw new Error(`Builder 2 missing run ${runId}.`);beginBuilder2DecisionBenchmark(runId,{book:plan.book,mode:plan.mode,resumed:true});
    plan=await this.#readFresh(runId,'resume');
    switch(plan.phase){
      case BUILDER2_PHASE.INVENTORY:
      case BUILDER2_PHASE.SURVEY:
        return this.#runSurveyTaxonomy(runId);
      case BUILDER2_PHASE.TAXONOMY_DRAFT:{
        const ctx=await this.#context(plan);
        const taxonomy=await planBuilder2Taxonomy({sourceRevision:plan.sourceRevision,corpusRevision:plan.corpusRevision,treeRevision:plan.treeRevision,survey:plan.survey,treeInventory:ctx.treeInventory,planTaxonomy:this.semantic.planTaxonomy,signal:this.signal});
        plan=await this.#readFresh(runId,'resume-post-taxonomy-plan');
        if(consolidatedReview(plan)){
          const accepted=applyBuilder2TaxonomyReview(taxonomy,{approved:true});
          plan=await this.store.transition(runId,BUILDER2_PHASE.CLASSIFICATION,{taxonomy:accepted,taxonomyRevision:accepted.revisionId,taxonomyReview:{approved:true,automatic:true,recovered:true,reviewFlow:'consolidated'}});
          return this.#runClassification(runId);
        }
        plan=await this.store.transition(runId,BUILDER2_PHASE.TAXONOMY_REVIEW,{taxonomy,taxonomyRevision:taxonomy.revisionId});return this.reviewRequest(plan);
      }
      case BUILDER2_PHASE.TAXONOMY_REVIEW:
      case BUILDER2_PHASE.CLASSIFICATION_REVIEW:
      case BUILDER2_PHASE.GAP_REVIEW:
      case BUILDER2_PHASE.DRAFT_REVIEW:
      case BUILDER2_PHASE.RECONCILIATION:
      case BUILDER2_PHASE.VALIDATION:
        return this.reviewRequest(plan);
      case BUILDER2_PHASE.QUALITY_REVIEW:
        // A blocked Quality Review from an older build may contain semantic
        // work that should never have escaped Ambiguity/Gap Review. Re-run the
        // local routing boundary so the owning review stage gets it back.
        if(plan.qualityReview?.report?.passed!==true)return this.#runQuality(runId,{taxonomy:plan.taxonomy,classifications:plan.classifications,reconciliation:plan.reconciliation});
        if(consolidatedReview(plan))return this.#materialize(runId,'consolidated-quality-resume');
        return this.reviewRequest(plan);
      case BUILDER2_PHASE.CLASSIFICATION:{
        const pending=plan.classificationPlanning?.pendingSourceKeys||null;
        return this.#runClassification(runId,{onlySourceKeys:pending,merge:(plan.classifications||[]).length>0});
      }
      case BUILDER2_PHASE.RECLASSIFICATION:{
        const pending=plan.classificationPlanning?.pendingSourceKeys||[];
        if(!pending.length) return this.#prepareGaps(runId,plan.classifications);
        return this.#runClassification(runId,{onlySourceKeys:pending,merge:true});
      }
      case BUILDER2_PHASE.MATERIALIZATION:
        return this.#materialize(runId,plan.qualityReview?.reviewToken||'resume-quality-review');
      case BUILDER2_PHASE.STAGED:
        return {plan,reviewKind:null,reviewToken:null,staged:true,commitEnvelope:plan.metadata?.commitEnvelope||null,ledgerArtifact:plan.metadata?.ledgerArtifact||null};
      case BUILDER2_PHASE.COMMITTED:
      case BUILDER2_PHASE.CANCELLED:
      case BUILDER2_PHASE.STALE:
        return {plan,reviewKind:null,reviewToken:null,terminal:true};
      default:throw new Error(`Builder 2 cannot resume unknown phase ${String(plan.phase)}.`);
    }
  }
  async #runSurveyTaxonomy(runId){
    let plan=await this.#readFresh(runId,'pipeline-survey');const ctx=await this.#context(plan);
    plan=await this.store.transition(runId,BUILDER2_PHASE.SURVEY);
    const survey=await surveyBuilder2Corpus({sources:ctx.corpusSources,analyzeSlice:this.semantic.analyzeSurveySlice,analyzeSlices:this.semantic.analyzeSurveySlices,maxEntries:this.config.surveyMaxEntries,maxChars:this.config.surveyMaxChars,targetInputTokens:this.config.semanticInputTargetTokens,signal:this.signal});
    plan=await this.#readFresh(runId,'post-survey');plan=await this.store.transition(runId,BUILDER2_PHASE.TAXONOMY_DRAFT,{survey});
    const taxonomy=await planBuilder2Taxonomy({sourceRevision:plan.sourceRevision,corpusRevision:plan.corpusRevision,treeRevision:plan.treeRevision,survey,treeInventory:ctx.treeInventory,planTaxonomy:this.semantic.planTaxonomy,signal:this.signal});
    plan=await this.#readFresh(runId,'post-taxonomy-plan');
    if(consolidatedReview(plan)){
      const accepted=applyBuilder2TaxonomyReview(taxonomy,{approved:true});
      plan=await this.store.transition(runId,BUILDER2_PHASE.CLASSIFICATION,{taxonomy:accepted,taxonomyRevision:accepted.revisionId,taxonomyReview:{approved:true,automatic:true,reviewFlow:'consolidated'},metadata:{...(plan.metadata||{}),consolidatedProgress:{...(plan.metadata?.consolidatedProgress||{}),taxonomyDrafted:true,taxonomyAutoAccepted:true}}});
      return this.#runClassification(runId);
    }
    plan=await this.store.transition(runId,BUILDER2_PHASE.TAXONOMY_REVIEW,{taxonomy,taxonomyRevision:taxonomy.revisionId});recordBuilder2Cycle(runId,'review',1,{kind:'taxonomy-review'});return this.reviewRequest(plan);
  }
  reviewRequest(plan){const kind=REVIEW_KIND[plan.phase];return{plan,reviewKind:kind||null,reviewToken:kind?createBuilder2ReviewToken(plan,kind):null};}
  async reviewTaxonomy(runId,{token,approved=true,nodes=null}={}){let plan=await this.#readFresh(runId,'taxonomy-review');assertBuilder2ReviewToken(plan,'taxonomy-review',token);const before=plan.taxonomy?.revisionId;const taxonomy=applyBuilder2TaxonomyReview(plan.taxonomy,{approved,nodes});recordBuilder2Cycle(runId,'taxonomyApproval',1);if(before&&before!==taxonomy.revisionId)recordBuilder2Cycle(runId,'taxonomyRevision',1,{from:before,to:taxonomy.revisionId});plan=await this.store.transition(runId,BUILDER2_PHASE.CLASSIFICATION,{taxonomy,taxonomyRevision:taxonomy.revisionId,taxonomyReview:{approved:true,reviewToken:token}});return this.#runClassification(runId);}
  async #resolveAmbiguousWithDecisionCore(runId,{taxonomy,classifications,evidenceSources=[]}={}){
    const bySource=new Map((evidenceSources||[]).map(source=>[source.sourceKey,source]));
    const byTaxon=new Map((taxonomy?.nodes||[]).map(node=>[node.taxonId,node]));
    const replacements=[];
    for(const row of classifications||[]){
      if(row.decision!==BUILDER2_CLASSIFICATION_DECISION.AMBIGUOUS)continue;
      const source=bySource.get(row.sourceKey);if(!source)continue;
      const candidates=(row.candidates||[]).map(candidate=>byTaxon.get(candidate.taxonId)).filter(Boolean).filter(node=>node.entryPolicy!=='container-only').slice(0,16);
      if(!candidates.length)continue;
      const decisionCtx=this.#decisionContext(runId,{taxonomy,source,candidates,currentPath:[],existingClassification:row,authoritativeChoice:null});
      const assist=await evaluateBuilderHierarchicalClassificationAssist(decisionCtx,{signal:this.signal});
      if(!assist?.handled)continue;
      replacements.push(createBuilder2Classification({
        sourceKey:row.sourceKey,
        sourceFingerprint:row.sourceFingerprint||source.fingerprint,
        taxonomyRevision:taxonomy.revisionId,
        classificationRevision:taxonomy.classificationRevisionId,
        decision:BUILDER2_CLASSIFICATION_DECISION.CLASSIFIED,
        taxonId:assist.taxonId,
        candidates:row.candidates||[],
        reason:'decision-core-hierarchical-assist',
        confidence:1,
        metadata:{...(row.metadata||{}),semantic:true,decisionCoreAssist:true,decisionCoreAfterWorker:true,provider:assist.result?.provider||null},
      }));
    }
    return replacements.length?replaceByKey(classifications,replacements):classifications;
  }

  async #runClassification(runId,{onlySourceKeys=null,merge=false}={}){
    let plan=await this.#readFresh(runId,'classification');const ctx=await this.#context(plan);
    const requested=unique(onlySourceKeys||activeSourceKeys(ctx.worksetSources));
    if(!requested.length)return this.#prepareGaps(runId,plan.classifications);
    const evidence=ctx.worksetSources.filter(source=>requested.includes(source.sourceKey));
    const roundFingerprint=builder2SemanticRoundFingerprint({stage:'classification',taxonomy:plan.taxonomy,evidence,classifications:plan.classifications,requestedSourceKeys:requested});
    const progress=inspectBuilder2SemanticNonProgress(plan,{stage:'classification',fingerprint:roundFingerprint});
    const reusableRows=(plan.classifications||[]).filter(row=>requested.includes(row.sourceKey)&&evidence.some(source=>source.sourceKey===row.sourceKey&&source.fingerprint===row.sourceFingerprint));
    if(progress.stalled&&reusableRows.length===requested.length){
      recordBuilder2Cycle(runId,'nonProgress',1,{stage:'classification',requestedCount:requested.length});
      let classifications=merge?plan.classifications:reusableRows;
      if(consolidatedReview(plan))classifications=await this.#resolveAmbiguousWithDecisionCore(runId,{taxonomy:plan.taxonomy,classifications,evidenceSources:ctx.worksetSources});
      plan=await this.store.transition(runId,plan.phase,{classifications,metadata:builder2SemanticProgressMetadata(plan,{stage:'classification',fingerprint:roundFingerprint,stalled:true,reason:'identical-authoritative-classification-round-reused'}),classificationPlanning:{...(plan.classificationPlanning||{}),pendingSourceKeys:[],status:'stalled-reused',nonProgressStalled:true,reason:'identical semantic round; reused durable classification results'}});
      const ambiguous=classifications.filter(r=>r.decision===BUILDER2_CLASSIFICATION_DECISION.AMBIGUOUS&&!['deferred','nonsemantic'].includes(r.metadata?.resolvedDisposition));
      if(ambiguous.length&&!consolidatedReview(plan)){recordBuilder2Cycle(runId,'review',1,{kind:'classification-review',nonProgress:true});plan=await this.store.transition(runId,BUILDER2_PHASE.CLASSIFICATION_REVIEW,{classificationReview:{pending:ambiguous.map(r=>r.sourceKey),nonProgressStalled:true,reason:'identical semantic round was not re-dispatched'}});return this.reviewRequest(plan);}
      return this.#prepareGaps(runId,classifications);
    }
    plan=await this.store.transition(runId,plan.phase,{classificationPlanning:{...(plan.classificationPlanning||{}),pendingSourceKeys:requested,status:'running',taxonomyRevision:plan.taxonomy.revisionId,classificationRevision:plan.taxonomy.classificationRevisionId}});
    if(plan.phase===BUILDER2_PHASE.RECLASSIFICATION)recordBuilder2Cycle(runId,'reclassification',1,{requestedCount:requested.length});
    const assistRows=[];const assistHandled=new Set();
    const legalTaxa=(plan.taxonomy?.nodes||[]).filter(node=>node.entryPolicy!=='container-only').slice(0,16);
    // Legacy phased runs retain the historical Jev-first path. Consolidated
    // runs prioritize high-throughput adaptive worker slices, then ask Jev only
    // about the small ambiguous tail. This avoids one typed request per source.
    if(!consolidatedReview(plan)&&(plan.taxonomy?.nodes||[]).length<=16&&legalTaxa.length){
      for(const source of evidence){
        const decisionCtx=this.#decisionContext(runId,{taxonomy:plan.taxonomy,source,candidates:legalTaxa,currentPlacement:source.currentPlacement||null,authoritativeChoice:null});
        const assist=await evaluateBuilderParentPlacementAssist(decisionCtx,{signal:this.signal});
        if(assist?.handled){assistHandled.add(source.sourceKey);assistRows.push(createBuilder2Classification({sourceKey:source.sourceKey,sourceFingerprint:source.fingerprint,taxonomyRevision:plan.taxonomy.revisionId,classificationRevision:plan.taxonomy.classificationRevisionId,decision:BUILDER2_CLASSIFICATION_DECISION.CLASSIFIED,taxonId:assist.taxonId,candidates:[],reason:'decision-core-assist',confidence:1,metadata:{semantic:true,decisionCoreAssist:true,provider:assist.result?.provider||null}}));}
      }
    }
    const remainingKeys=requested.filter(key=>!assistHandled.has(key));
    const workerRows=remainingKeys.length?await classifyBuilder2Sources({sources:ctx.worksetSources,taxonomy:plan.taxonomy,classifySlice:this.semantic.classifySlice,classifySlices:this.semantic.classifySlices,maxEntries:this.config.classifyMaxEntries,semanticInputTargetTokens:this.config.semanticInputTargetTokens,maxTaxa:this.config.classifyMaxTaxa,routeCandidateLimit:this.config.routeCandidateLimit,routeTaxonomy:this.semantic.routeTaxonomy,onlySourceKeys:remainingKeys,signal:this.signal}):[];
    const rows=replaceByKey(workerRows,assistRows);
    plan=await this.#readFresh(runId,'post-classification');let classifications=merge?replaceByKey(plan.classifications,rows):rows;const classificationProgress=builder2SemanticProgressMetadata(plan,{stage:'classification',fingerprint:roundFingerprint,reason:'authoritative-classification-round-complete'});
    if(consolidatedReview(plan))classifications=await this.#resolveAmbiguousWithDecisionCore(runId,{taxonomy:plan.taxonomy,classifications,evidenceSources:ctx.worksetSources});
    const ambiguous=classifications.filter(r=>r.decision===BUILDER2_CLASSIFICATION_DECISION.AMBIGUOUS);
    if(ambiguous.length&&!consolidatedReview(plan)){recordBuilder2Cycle(runId,'unresolved',ambiguous.length);recordBuilder2Cycle(runId,'review',1,{kind:'classification-review'});plan=await this.store.transition(runId,BUILDER2_PHASE.CLASSIFICATION_REVIEW,{classifications,metadata:classificationProgress,classificationPlanning:{...(plan.classificationPlanning||{}),pendingSourceKeys:[],status:'complete'},classificationReview:{pending:ambiguous.map(r=>r.sourceKey)}});return this.reviewRequest(plan);}
    if(ambiguous.length)recordBuilder2Cycle(runId,'unresolved',ambiguous.length,{consolidated:true});
    plan=await this.store.transition(runId,plan.phase,{classifications,metadata:classificationProgress,classificationPlanning:{...(plan.classificationPlanning||{}),pendingSourceKeys:[],status:'complete'}});
    return this.#prepareGaps(runId,classifications);
  }
  async reviewClassifications(runId,{token,decisions={}}={}){let plan=await this.#readFresh(runId,'classification-review');assertBuilder2ReviewToken(plan,'classification-review',token);const mapped=Object.values(decisions||{}).filter(d=>d?.action==='map').length;if(mapped)recordBuilder2Cycle(runId,'operatorCategoryCorrection',mapped,{surface:'classification-review'});const classifications=applyBuilder2ClassificationReview(plan.classifications,decisions,plan.taxonomy);const still=classifications.filter(r=>r.decision===BUILDER2_CLASSIFICATION_DECISION.AMBIGUOUS&&r.metadata?.resolvedDisposition!=='deferred');if(still.length){recordBuilder2Cycle(runId,'review',1,{kind:'classification-review-repeat'});plan=await this.store.transition(runId,BUILDER2_PHASE.CLASSIFICATION_REVIEW,{classifications,classificationReview:{pending:still.map(r=>r.sourceKey),lastToken:token}});return this.reviewRequest(plan);}return this.#prepareGaps(runId,classifications);}
  async #prepareDraftReview(runId,{classifications,taxonomy=null,gaps=[],proposals=[],gapPlanning=null,metadataPatch=null}={}){
    let plan=await this.#readFresh(runId,'consolidated-draft-review');
    const activeTaxonomy=taxonomy||plan.taxonomy;
    const ambiguous=(classifications||[]).filter(row=>row.decision===BUILDER2_CLASSIFICATION_DECISION.AMBIGUOUS&&!['deferred','nonsemantic'].includes(row.metadata?.resolvedDisposition));
    const draftAlreadyReviewed=plan.metadata?.consolidatedProgress?.draftReviewed===true;
    if(!ambiguous.length&&!proposals.length&&draftAlreadyReviewed)return this.#prepareReconciliation(runId,classifications,{taxonomy:activeTaxonomy});
    recordBuilder2Cycle(runId,'review',1,{kind:'draft-review',ambiguousCount:ambiguous.length,gapProposalCount:proposals.length,categoryReview:draftAlreadyReviewed!==true});
    plan=await this.store.transition(runId,BUILDER2_PHASE.DRAFT_REVIEW,{
      taxonomy:activeTaxonomy,
      taxonomyRevision:activeTaxonomy.revisionId,
      classifications,
      classificationReview:{pending:ambiguous.map(row=>row.sourceKey),consolidated:true},
      taxonomyGaps:gaps,
      proposedExpansions:proposals,
      gapPlanning:gapPlanning||plan.gapPlanning,
      metadata:{...(plan.metadata||{}),...(metadataPatch||{}),consolidatedProgress:{...(plan.metadata?.consolidatedProgress||{}),draftReviewReady:true,ambiguousCount:ambiguous.length,gapProposalCount:proposals.length}},
    });
    return this.reviewRequest(plan);
  }

  async #prepareGaps(runId,classifications){
    let plan=await this.#readFresh(runId,'gap-detection');const ctx=await this.#context(plan);const gaps=collectBuilder2Gaps(classifications);
    const ambiguous=classifications.filter(row=>row.decision===BUILDER2_CLASSIFICATION_DECISION.AMBIGUOUS&&!['deferred','nonsemantic'].includes(row.metadata?.resolvedDisposition));
    if(!gaps.length){
      if(consolidatedReview(plan)){
        if(ambiguous.length||plan.metadata?.consolidatedProgress?.draftReviewed!==true)return this.#prepareDraftReview(runId,{classifications,taxonomy:plan.taxonomy,gaps:[],proposals:[]});
      }
      return this.#prepareReconciliation(runId,classifications);
    }
    recordBuilder2Cycle(runId,'gap',1,{gapCount:gaps.length});
    const evidence=ctx.worksetSources.filter(source=>gaps.some(gap=>gap.sourceKey===source.sourceKey));
    const roundFingerprint=builder2SemanticRoundFingerprint({stage:'gap-consolidation',taxonomy:plan.taxonomy,evidence,classifications,gaps,requestedSourceKeys:gaps.map(row=>row.sourceKey)}),progress=inspectBuilder2SemanticNonProgress(plan,{stage:'gap-consolidation',fingerprint:roundFingerprint});
    let proposals=[];let nonProgressStalled=false;
    if(progress.stalled){
      nonProgressStalled=true;recordBuilder2Cycle(runId,'nonProgress',1,{stage:'gap-consolidation',gapCount:gaps.length});
      proposals=createBuilder2FallbackGapProposals({gaps,sources:ctx.worksetSources,taxonomy:plan.taxonomy,reason:'semantic-non-progress'});
    }else{
      proposals=await consolidateBuilder2Gaps({gaps,sources:ctx.worksetSources,taxonomy:plan.taxonomy,consolidateGaps:this.semantic.consolidateGaps,signal:this.signal});
    }
    const fallbackProposalCount=proposals.filter(p=>p.fallback===true).length;plan=await this.#readFresh(runId,'post-gap-consolidation');
    const gapPlanning={proposalCount:proposals.length,fallbackProposalCount,coverageComplete:proposals.reduce((n,p)=>n+(p.evidenceSourceKeys||[]).length,0)===gaps.length,nonProgressStalled,reason:nonProgressStalled?'identical semantic round; model consolidation skipped and operator fallback surfaced':null};
    const progressMetadata=builder2SemanticProgressMetadata(plan,{stage:'gap-consolidation',fingerprint:roundFingerprint,stalled:nonProgressStalled,reason:nonProgressStalled?'identical gap round routed to deterministic operator fallback':'authoritative-gap-consolidation-complete'});
    if(consolidatedReview(plan))return this.#prepareDraftReview(runId,{classifications,taxonomy:plan.taxonomy,gaps,proposals,gapPlanning,metadataPatch:progressMetadata});
    recordBuilder2Cycle(runId,'review',1,{kind:'gap-review',nonProgressStalled});
    plan=await this.store.transition(runId,BUILDER2_PHASE.GAP_REVIEW,{classifications,taxonomyGaps:gaps,proposedExpansions:proposals,metadata:progressMetadata,gapPlanning});return this.reviewRequest(plan);
  }

  async reviewDraft(runId,{token,classificationDecisions={},gapDecisions={},nodes=null}={}){
    let plan=await this.#readFresh(runId,'draft-review');assertBuilder2ReviewToken(plan,'draft-review',token);
    const priorTaxonomy=plan.taxonomy;
    const reviewedTaxonomy=Array.isArray(nodes)?applyBuilder2TaxonomyReview(priorTaxonomy,{approved:true,nodes}):priorTaxonomy;
    let reviewed={
      taxonomy:reviewedTaxonomy,
      classificationAssignments:{},
      excludedSourceKeys:[],
      deferredSourceKeys:[],
      proposals:plan.proposedExpansions||[],
    };
    if((plan.proposedExpansions||[]).length){
      reviewed=applyBuilder2GapReview({taxonomy:reviewedTaxonomy,proposals:plan.proposedExpansions,decisions:gapDecisions});
    }
    if(priorTaxonomy?.revisionId&&priorTaxonomy.revisionId!==reviewed.taxonomy?.revisionId)recordBuilder2Cycle(runId,'taxonomyRevision',1,{from:priorTaxonomy.revisionId,to:reviewed.taxonomy?.revisionId,source:'draft-review'});
    const rebased=rebaseBuilder2ClassificationsForTaxonomy(plan.classifications,reviewed.taxonomy,{assignments:reviewed.classificationAssignments});
    let classifications=applyBuilder2ClassificationReview(rebased.classifications,classificationDecisions,reviewed.taxonomy);
    const dispositionDecisions={
      ...Object.fromEntries((reviewed.excludedSourceKeys||[]).map(sourceKey=>[sourceKey,{action:'exclude',reason:'operator-nonsemantic-draft'}])),
      ...Object.fromEntries((reviewed.deferredSourceKeys||[]).map(sourceKey=>[sourceKey,{action:'defer',reason:'operator-deferred-draft'}])),
    };
    if(Object.keys(dispositionDecisions).length)classifications=applyBuilder2ClassificationReview(classifications,dispositionDecisions,reviewed.taxonomy);
    const mapped=Object.values(classificationDecisions||{}).filter(d=>d?.action==='map').length;
    if(mapped)recordBuilder2Cycle(runId,'operatorCategoryCorrection',mapped,{surface:'draft-review'});
    const parentCorrections=Object.values(gapDecisions||{}).filter(d=>d?.action==='merge-into'||d?.action==='approve').length;
    if(parentCorrections)recordBuilder2Cycle(runId,'operatorParentCorrection',parentCorrections,{surface:'draft-review'});
    plan=await this.store.transition(runId,BUILDER2_PHASE.RECLASSIFICATION,{
      taxonomy:reviewed.taxonomy,
      taxonomyRevision:reviewed.taxonomy.revisionId,
      classifications,
      proposedExpansions:reviewed.proposals,
      classificationReview:{pending:[],consolidated:true,reviewToken:token},
      gapPlanning:{...(plan.gapPlanning||{}),consolidatedReviewed:true,localPromotionCount:Object.keys(reviewed.classificationAssignments||{}).length,localExclusionCount:(reviewed.excludedSourceKeys||[]).length,localDeferredCount:(reviewed.deferredSourceKeys||[]).length},
      metadata:{...(plan.metadata||{}),consolidatedProgress:{...(plan.metadata?.consolidatedProgress||{}),draftReviewed:true}},
    });
    const invalidated=unique(rebased.invalidatedSourceKeys);
    if(invalidated.length){
      plan=await this.store.transition(runId,BUILDER2_PHASE.RECLASSIFICATION,{classificationPlanning:{pendingSourceKeys:invalidated,status:'pending',reason:'draft-review-taxonomy-invalidated'}});
      return this.#runClassification(runId,{onlySourceKeys:invalidated,merge:true});
    }
    return this.#prepareGaps(runId,classifications);
  }

  async reviewGaps(runId,{token,decisions={}}={}){
    let plan=await this.#readFresh(runId,'gap-review');assertBuilder2ReviewToken(plan,'gap-review',token);
    const parentCorrections=Object.values(decisions||{}).filter(d=>d?.action==='merge-into'||d?.action==='approve').length;if(parentCorrections)recordBuilder2Cycle(runId,'operatorParentCorrection',parentCorrections,{surface:'gap-review'});const priorTaxonomyRevision=plan.taxonomy?.revisionId;
    const reviewed=applyBuilder2GapReview({taxonomy:plan.taxonomy,proposals:plan.proposedExpansions,decisions});
    if(priorTaxonomyRevision&&priorTaxonomyRevision!==reviewed.taxonomy?.revisionId)recordBuilder2Cycle(runId,'taxonomyRevision',1,{from:priorTaxonomyRevision,to:reviewed.taxonomy?.revisionId,source:'gap-review'});
    const rebased=rebaseBuilder2ClassificationsForTaxonomy(plan.classifications,reviewed.taxonomy,{assignments:reviewed.classificationAssignments});
    const dispositionDecisions={
      ...Object.fromEntries((reviewed.excludedSourceKeys||[]).map(sourceKey=>[sourceKey,{action:'exclude',reason:'operator-nonsemantic-gap'}])),
      ...Object.fromEntries((reviewed.deferredSourceKeys||[]).map(sourceKey=>[sourceKey,{action:'defer',reason:'operator-deferred-gap'}])),
    };
    const disposedClassifications=Object.keys(dispositionDecisions).length?applyBuilder2ClassificationReview(rebased.classifications,dispositionDecisions,reviewed.taxonomy):rebased.classifications;
    const gapReviewPatch={taxonomy:reviewed.taxonomy,taxonomyRevision:reviewed.taxonomy.revisionId,classifications:disposedClassifications,proposedExpansions:reviewed.proposals,gapPlanning:{...(plan.gapPlanning||{}),localPromotionCount:Object.keys(reviewed.classificationAssignments||{}).length,localExclusionCount:(reviewed.excludedSourceKeys||[]).length,localDeferredCount:(reviewed.deferredSourceKeys||[]).length}};
    const pending=reviewed.proposals.filter(p=>p.status==='pending'||p.status==='rejected');
    if(pending.length){plan=await this.store.transition(runId,BUILDER2_PHASE.GAP_REVIEW,gapReviewPatch);return this.reviewRequest(plan);}
    // Persist the operator's completed gap dispositions before advancing.  A
    // previous implementation only wrote reviewed proposal statuses while a
    // pending proposal remained, so an all-deferred review advanced correctly
    // but the durable plan still displayed the old proposals as "pending".
    plan=await this.store.transition(runId,BUILDER2_PHASE.RECLASSIFICATION,gapReviewPatch);
    const unresolved=unique(rebased.invalidatedSourceKeys);
    if(unresolved.length){plan=await this.store.transition(runId,BUILDER2_PHASE.RECLASSIFICATION,{classificationPlanning:{pendingSourceKeys:unresolved,status:'pending',reason:'gap-review-invalidated'}});return this.#runClassification(runId,{onlySourceKeys:unresolved,merge:true});}
    return this.#prepareReconciliation(runId,disposedClassifications,{taxonomy:reviewed.taxonomy});
  }
  async #prepareReconciliation(runId,classifications,patch={}){
    let plan=await this.#readFresh(runId,'reconciliation-plan');
    if(patch.taxonomy)plan=await this.store.transition(runId,BUILDER2_PHASE.RECLASSIFICATION,{taxonomy:patch.taxonomy,taxonomyRevision:patch.taxonomy.revisionId,classifications});
    const taxonomy=patch.taxonomy||plan.taxonomy;
    if(this.config.semanticReconciliation!==true){
      const rec={proposals:[],components:[],manualReviewRequired:false,skipped:true,reason:'resident-taxonomy-no-automatic-semantic-reconciliation'};
      return this.#runQuality(runId,{taxonomy,classifications,reconciliation:rec});
    }
    const rec=await proposeBuilder2Reconciliation({taxonomy,classifications,proposeReconciliation:this.semantic.proposeReconciliation,maxComponentSize:this.config.reconciliationMaxComponent,signal:this.signal});
    plan=await this.#readFresh(runId,'post-reconciliation-plan');
    if(rec.proposals.length){plan=await this.store.transition(runId,BUILDER2_PHASE.RECONCILIATION,{taxonomy,taxonomyRevision:taxonomy.revisionId,classifications,reconciliation:rec});return this.reviewRequest(plan);}
    return this.#runQuality(runId,{taxonomy,classifications,reconciliation:rec});
  }
  async reviewReconciliation(runId,{token,decisions={}}={}){
    let plan=await this.#readFresh(runId,'reconciliation-review');assertBuilder2ReviewToken(plan,'reconciliation-review',token);
    const applied=applyBuilder2Reconciliation({taxonomy:plan.taxonomy,reconciliation:plan.reconciliation,decisions});
    const splitIds=new Set(applied.splitTaxonIds||[]);
    const derivedSplitKeys=(plan.classifications||[]).filter(row=>row.taxonId&&splitIds.has(row.taxonId)).map(row=>row.sourceKey);
    const dirty=unique([...(applied.reclassifySourceKeys||[]),...derivedSplitKeys]);
    const rebased=rebaseBuilder2ClassificationsForTaxonomy(plan.classifications,applied.taxonomy,{remapTaxonIds:applied.classificationRemap,dirtySourceKeys:dirty});
    const unresolved=unique([...dirty,...rebased.invalidatedSourceKeys]);
    const reconciliation={...plan.reconciliation,appliedIssueIds:applied.appliedIssueIds,localRemapCount:Object.keys(applied.classificationRemap||{}).length};
    if(unresolved.length){plan=await this.store.transition(runId,BUILDER2_PHASE.RECLASSIFICATION,{taxonomy:applied.taxonomy,taxonomyRevision:applied.taxonomy.revisionId,classifications:rebased.classifications,reconciliation,classificationPlanning:{pendingSourceKeys:unresolved,status:'pending',reason:'reconciliation-split'}});return this.#runClassification(runId,{onlySourceKeys:unresolved,merge:true});}
    return this.#runQuality(runId,{taxonomy:applied.taxonomy,classifications:rebased.classifications,reconciliation});
  }
  async #runQuality(runId,patch={}){let plan=await this.#readFresh(runId,'quality');const ctx=await this.#context(plan);const taxonomy=patch.taxonomy||plan.taxonomy,classifications=patch.classifications||plan.classifications;
    const ambiguous=classifications.filter(row=>row.decision===BUILDER2_CLASSIFICATION_DECISION.AMBIGUOUS&&!['nonsemantic','deferred'].includes(row.metadata?.resolvedDisposition));
    const gaps=collectBuilder2Gaps(classifications);
    if((ambiguous.length||gaps.length)&&consolidatedReview(plan)){
      return this.#prepareGaps(runId,classifications);
    }
    // Semantic incompleteness belongs to the semantic review stages, not the
    // final Quality Gate. Legacy phased runs keep their historical surfaces.
    if(ambiguous.length){plan=await this.store.transition(runId,BUILDER2_PHASE.RECLASSIFICATION,{taxonomy,taxonomyRevision:taxonomy.revisionId,classifications,reconciliation:patch.reconciliation||plan.reconciliation,qualityReview:null,classificationPlanning:{pendingSourceKeys:[],status:'review-recovery',reason:'quality-unresolved-ambiguity'}});plan=await this.store.transition(runId,BUILDER2_PHASE.CLASSIFICATION_REVIEW,{classificationReview:{pending:ambiguous.map(row=>row.sourceKey),recoveredFromQuality:true}});return this.reviewRequest(plan);}
    if(gaps.length){const proposals=createBuilder2FallbackGapProposals({gaps,sources:ctx.worksetSources,taxonomy,reason:'recovered-from-quality-review'});plan=await this.store.transition(runId,BUILDER2_PHASE.RECLASSIFICATION,{taxonomy,taxonomyRevision:taxonomy.revisionId,classifications,reconciliation:patch.reconciliation||plan.reconciliation,qualityReview:null,classificationPlanning:{pendingSourceKeys:[],status:'review-recovery',reason:'quality-unresolved-gap'}});plan=await this.store.transition(runId,BUILDER2_PHASE.GAP_REVIEW,{taxonomyGaps:gaps,proposedExpansions:proposals,gapPlanning:{proposalCount:proposals.length,fallbackProposalCount:proposals.length,coverageComplete:true,recoveredFromQuality:true}});return this.reviewRequest(plan);}
    const prospective=buildBuilder2ProspectivePopulation({treeInventory:ctx.treeInventory,worksetSources:ctx.worksetSources,classifications,taxonomy});
    const report=evaluateBuilder2Quality({sources:ctx.worksetSources,taxonomy,classifications,prospectivePopulation:prospective});
    plan=await this.store.transition(runId,BUILDER2_PHASE.QUALITY_REVIEW,{taxonomy,taxonomyRevision:taxonomy.revisionId,classifications,reconciliation:patch.reconciliation||plan.reconciliation,qualityReview:{report,status:report.passed?(consolidatedReview(plan)?'automatic-pass':'review'):'blocked'}});
    if(report.passed&&consolidatedReview(plan)){
      recordBuilder2Cycle(runId,'qualityAutoPass',1,{reviewFlow:'consolidated'});
      return this.#materialize(runId,'consolidated-quality-pass');
    }
    return this.reviewRequest(plan);
  }
  async reviewQuality(runId,{token,approved=true,decisions={}}={}){
    let plan=await this.#readFresh(runId,'quality-review');assertBuilder2ReviewToken(plan,'quality-review',token);
    if(!plan.qualityReview?.report?.passed){
      const applicable=Object.fromEntries(Object.entries(decisions||{}).filter(([,d])=>d&&d.action));
      if(Object.keys(applicable).length){
        const classifications=applyBuilder2ClassificationReview(plan.classifications,applicable,plan.taxonomy);
        return this.#runQuality(runId,{taxonomy:plan.taxonomy,classifications,reconciliation:plan.reconciliation});
      }
      throw new Error(`Builder 2 quality blockers prevent materialization: ${(plan.qualityReview.report.blockers||[]).map(b=>b.blockerId).join(', ')}`);
    }
    if(!approved)throw new Error('Builder 2 quality review rejected.');return this.#materialize(runId,token);
  }
  async #materialize(runId,qualityToken){let plan=await this.#readFresh(runId,'materialization');const ctx=await this.#context(plan);plan=await this.store.transition(runId,BUILDER2_PHASE.MATERIALIZATION,{qualityReview:{...plan.qualityReview,status:'approved',reviewToken:qualityToken}});const handoff=createBuilder2StructuralHandoff({plan,taxonomy:plan.taxonomy,classifications:plan.classifications,worksetSources:ctx.worksetSources,treeInventory:ctx.treeInventory,baselineTaxonomy:plan.structuralBaselineTaxonomy});const preview=createBuilder2Preview({plan,taxonomy:plan.taxonomy,handoff,treeInventory:ctx.treeInventory,worksetSources:ctx.worksetSources});const validation=validateBuilder2Materialization({handoff,corpusSources:ctx.corpusSources});if(!validation.passed)throw new Error(`Builder 2 materialization invalid: ${validation.errors.join(' ')}`);plan=await this.#readFresh(runId,'post-materialization');plan=await this.store.transition(runId,BUILDER2_PHASE.VALIDATION,{structuralPlan:handoff,previewModel:preview,validation});return this.reviewRequest(plan);}
  async reviewPreview(runId,{token,approved=true}={}){let plan=await this.#readFresh(runId,'preview-review');assertBuilder2ReviewToken(plan,'preview',token);if(!approved)throw new Error('Builder 2 preview rejected.');if(plan.metadata?.validateOnly===true){const decisionBenchmark=finishBuilder2DecisionBenchmark(runId,{state:'validate-only-complete'});plan=await this.store.transition(runId,BUILDER2_PHASE.VALIDATION,{metadata:{...(plan.metadata||{}),validateOnlyComplete:true,previewApproved:true,decisionBenchmark}});return{plan,readOnly:true,preview:plan.previewModel,validation:plan.validation,staged:false,committed:false};}const envelope=createBuilder2CommitEnvelope({plan,handoff:plan.structuralPlan,preview:plan.previewModel,quality:plan.qualityReview.report,validation:plan.validation});const artifact=createBuilder2LedgerArtifact({plan,envelope,review:{previewToken:token,approved:true}});const decisionBenchmark=finishBuilder2DecisionBenchmark(runId,{state:'staged'});plan=await this.#readFresh(runId,'pre-stage');plan=await this.store.transition(runId,BUILDER2_PHASE.STAGED,{metadata:{...(plan.metadata||{}),commitEnvelope:envelope,ledgerArtifact:artifact,decisionBenchmark}});return{plan,commitEnvelope:envelope,ledgerArtifact:artifact};}
  async applyPreviewOverride(runId,{token,sourceKey:sk,taxonId}={}){let plan=await this.#readFresh(runId,'preview-manual-override');assertBuilder2ReviewToken(plan,'preview',token);const ctx=await this.#context(plan);const source=ctx.worksetSources.find(s=>s.sourceKey===sk);if(!source)throw new Error(`Unknown source ${sk}.`);recordBuilder2Cycle(runId,'wrongBranchCorrection',1,{sourceKey:sk,taxonId});recordBuilder2Cycle(runId,'operatorParentCorrection',1,{sourceKey:sk,taxonId,surface:'preview'});const classifications=applyBuilder2ClassificationReview(plan.classifications,{[sk]:{action:'map',taxonId}},plan.taxonomy);plan=await this.store.transition(runId,BUILDER2_PHASE.RECLASSIFICATION,{classifications,structuralPlan:null,previewModel:null,validation:null});return this.#runQuality(runId,{classifications,taxonomy:plan.taxonomy});}
  async resetPreviewOverride(runId,{token,sourceKey:sk}={}){let plan=await this.#readFresh(runId,'preview-reset-override');assertBuilder2ReviewToken(plan,'preview',token);const rows=plan.classifications.filter(r=>r.sourceKey!==sk);plan=await this.store.transition(runId,BUILDER2_PHASE.RECLASSIFICATION,{classifications:rows,structuralPlan:null,previewModel:null,validation:null,classificationPlanning:{pendingSourceKeys:[sk],status:'pending',reason:'preview-reset-override'}});return this.#runClassification(runId,{onlySourceKeys:[sk],merge:true});}
}

export async function runBuilder2AutoToStage({pipeline,input,reviewers={}}={}){
  let step=await pipeline.start(input);let guard=0;
  while(step?.reviewKind&&guard++<30){const p=step.plan,token=step.reviewToken;switch(step.reviewKind){case'taxonomy-review':step=await pipeline.reviewTaxonomy(p.runId,{token,...(await reviewers.taxonomy?.(p)||{})});break;case'classification-review':step=await pipeline.reviewClassifications(p.runId,{token,decisions:(await reviewers.classification?.(p))||{}});break;case'gap-review':step=await pipeline.reviewGaps(p.runId,{token,decisions:(await reviewers.gap?.(p))||{}});break;case'draft-review':{const draft=(await reviewers.draft?.(p))||{};step=await pipeline.reviewDraft(p.runId,{token,classificationDecisions:draft.classificationDecisions||{},gapDecisions:draft.gapDecisions||{}});break;}case'reconciliation-review':step=await pipeline.reviewReconciliation(p.runId,{token,decisions:(await reviewers.reconciliation?.(p))||{}});break;case'quality-review':step=await pipeline.reviewQuality(p.runId,{token,approved:(await reviewers.quality?.(p))?.approved!==false});break;case'preview':return pipeline.reviewPreview(p.runId,{token,approved:(await reviewers.preview?.(p))?.approved!==false});default:throw new Error(`Unknown review kind ${step.reviewKind}`);}}
  if(guard>=30)throw new Error('Builder 2 auto pipeline exceeded review guard.');return step;
}
