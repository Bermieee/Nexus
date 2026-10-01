import {Builder2Pipeline} from './pipeline.js';
import {NexusBuilder2SemanticAdapter} from './nexus-semantic.js';
import {createNexusBuilder2PlanStore} from './nexus-plan-store.js';
import {adaptWorldContextForBuilder2} from './world-context.js';
import {createBuilder2SourceRevision,createBuilder2TreeRevision,builder2Fingerprint} from './contracts.js';
import {loreGroupWorldNodeId} from '../world-tree/import-lore.js';

export async function analyzeWorldTreeContext(context,{runId,analysisRevision=1,mode,signal}={},
  {runtime=null,contextReader=null,semanticStore=null,pipelineFactory=null}={}){
  const store=semanticStore??createNexusBuilder2PlanStore(),semanticRun=`${runId}:analysis:${analysisRevision}`,adapted=adaptWorldContextForBuilder2(context);
  const options={store,semantic:new NexusBuilder2SemanticAdapter({runtime,store,runId:semanticRun}),signal,contextLoader:async()=>adapted,
    readCurrentAuthority:async()=>{
      const current=contextReader?adaptWorldContextForBuilder2(await contextReader({sourceIds:context.sources.map(s=>s.sourceId),chatId:context.scope.chatId})):adapted;
      return {sourceRevision:createBuilder2SourceRevision(current.worksetSources).revisionId,corpusRevision:createBuilder2SourceRevision(current.corpusSources).revisionId,treeRevision:createBuilder2TreeRevision(current.treeInventory)?.revisionId};
    }};
  const pipeline=pipelineFactory?pipelineFactory(options):new Builder2Pipeline(options);
  const existing=await store.read(semanticRun);
  let step=existing?await pipeline.resume(semanticRun):await pipeline.startWorldContext(context,{runId:semanticRun,validateOnly:true,metadata:{reviewFlow:'consolidated',semanticResource:'model-worker'}});
  if(step.reviewKind==='draft-review'){
    const pending=step.plan.classificationReview?.pending??[],gaps=step.plan.proposedExpansions??[];
    if(pending.length||gaps.length)throw Error(`Builder needs placement review: ${pending.length} ambiguous source(s), ${gaps.length} proposed category expansion(s). No tree was changed.`);
    step=await pipeline.reviewDraft(semanticRun,{token:step.reviewToken});
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
    else coverage.push({sourceId:source.sourceId,disposition:'UNRESOLVED',reason:decision?.reason??'Builder analysis requires placement review'});
  }
  return {organization:{groups,placements},coverage,layout:{mode,seed:context.binding?.book??context.scope.chatId}};
}
