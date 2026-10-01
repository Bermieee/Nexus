import {Builder2Pipeline} from './pipeline.js';
import {NexusBuilder2SemanticAdapter} from './nexus-semantic.js';
import {createNexusBuilder2PlanStore} from './nexus-plan-store.js';
import {adaptWorldContextForBuilder2} from './world-context.js';
import {createBuilder2SourceRevision,createBuilder2TreeRevision,builder2Fingerprint,builder2DraftReviewIdentity} from './contracts.js';
import {loreGroupWorldNodeId} from '../world-tree/import-lore.js';

export async function analyzeWorldTreeContext(context,{runId,analysisRevision=1,mode,signal,review=null}={},
  {runtime=null,contextReader=null,semanticStore=null,pipelineFactory=null}={}){
  const store=semanticStore??createNexusBuilder2PlanStore(),semanticRun=`${runId}:analysis:${analysisRevision}`,adapted=adaptWorldContextForBuilder2(context);
  const options={store,semantic:new NexusBuilder2SemanticAdapter({runtime,store,runId:semanticRun}),signal,contextLoader:async()=>adapted,
    readCurrentAuthority:async()=>{
      const current=contextReader?adaptWorldContextForBuilder2(await contextReader({sourceIds:context.sources.map(s=>s.sourceId),chatId:context.scope.chatId})):adapted;
      return {sourceRevision:createBuilder2SourceRevision(current.worksetSources).revisionId,corpusRevision:createBuilder2SourceRevision(current.corpusSources).revisionId,treeRevision:createBuilder2TreeRevision(current.treeInventory)?.revisionId};
    }};
  const pipeline=pipelineFactory?pipelineFactory(options):new Builder2Pipeline(options);
  const existing=await store.read(semanticRun);
  let step=existing?await pipeline.resume(semanticRun):await pipeline.startWorldContext(context,{runId:semanticRun,validateOnly:true,metadata:{reviewFlow:'consolidated',semanticResource:'model-worker',authoringBook:context.binding?.kind==='lorebook'?context.binding.book:null}});
  if(review&&step.reviewKind!=='draft-review'&&step.plan.metadata?.acceptedDraftReview!==builder2DraftReviewIdentity(review))throw Error('These placement choices differ from the saved accepted review; rerun analysis to change them.');
  if(step.reviewKind==='draft-review'){
    const pending=step.plan.classificationReview?.pending??[],gaps=step.plan.proposedExpansions??[];
    if((pending.length||gaps.length)&&!review)return {semanticReview:{
      token:step.reviewToken,semanticRunId:semanticRun,
      taxonomy:step.plan.taxonomy.nodes.map(({taxonId,label,parentTaxonId,entryPolicy})=>({taxonId,label,parentTaxonId,entryPolicy})),
      classifications:step.plan.classifications.filter(row=>pending.includes(row.sourceKey)).map(row=>({...row,title:context.sources.find(s=>s.sourceId===row.sourceKey)?.title??row.sourceKey})),
      proposals:structuredClone(gaps),
    }};
    if(review){
      for(const id of pending)if(!review.classificationDecisions?.[id])throw Error('Choose a placement or explicit deferral for '+id);
      for(const gap of gaps)if(!review.gapDecisions?.[gap.proposalId])throw Error('Review the proposed category '+gap.label);
    }
    step=await pipeline.reviewDraft(semanticRun,review??{token:step.reviewToken});
  }
  const plan=step.plan;
  if(!plan.validation?.passed||!plan.qualityReview?.report?.passed)throw Error('Builder analysis did not pass validation: '+(plan.qualityReview?.report?.blockers??[]).map(b=>b.blockerId).join(', ')+' ('+plan.phase+')');
  const byTaxon=new Map(),book=context.binding?.kind==='lorebook'?context.binding.book:null;
  for(const taxon of plan.taxonomy?.nodes??[])byTaxon.set(taxon.taxonId,taxon.canonicalNodeId??(book?loreGroupWorldNodeId(book,'builder-'+builder2Fingerprint(taxon.taxonId)):`world-build-group:${encodeURIComponent(context.scope.chatId)}:${builder2Fingerprint(taxon.taxonId)}`));
  // WORLD is a structural anchor, not a category. Giving it the fallback
  // parent 'world:nexus' creates a self-cycle before materialization.
  const groups=(plan.taxonomy?.nodes??[]).filter(t=>byTaxon.get(t.taxonId)!=='world:nexus').map(t=>({id:byTaxon.get(t.taxonId),label:t.label,parentId:byTaxon.get(t.parentTaxonId)??'world:nexus'}));
  const placements=[],coverage=[];
  for(const source of context.sources){const decision=(plan.classifications??[]).find(c=>c.sourceKey===source.sourceId),parentId=byTaxon.get(decision?.taxonId);
    if(parentId&&decision.decision==='classified'){placements.push({sourceId:source.sourceId,parentId});coverage.push({sourceId:source.sourceId,disposition:'PLACED'});}
    else coverage.push({sourceId:source.sourceId,disposition:decision?.metadata?.resolvedDisposition==='nonsemantic'?'EXCLUDED':'UNRESOLVED',reason:decision?.reason??'Builder analysis requires placement review'});
  }
  return {organization:{groups,placements},coverage,layout:{mode,seed:context.binding?.book??context.scope.chatId}};
}
