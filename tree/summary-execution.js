import { getNexusRuntime } from '../nexus/runtime.js';
import { NEXUS_JOB_KIND, NEXUS_JOB_ROUTE } from '../nexus/contracts.js';

export const TREE_SUMMARY_JOB_TYPE='tree-summary-model-work';

/**
 * Work Director owns orchestration only. The supplied executor remains Tree-owned
 * and continues to own prompts, validation, recovery, freshness and commit intent.
 */
export async function runTreeSummaryThroughDirector(execute,{label='Tree Summary',priority=25,signal=null,metadata={}}={}){
  if(typeof execute!=='function')throw new Error('Tree Summary Director bridge requires an executor.');
  const runtime=getNexusRuntime();
  if(!runtime?.director?.buildRequestedPlan||!runtime?.coordinator?.run)throw new Error('Nexus Work Director/Coordinator is unavailable for Tree Summary.');
  // The Tree executor may return Model Worker request/result objects containing
  // parser/validator functions. Work Coordinator snapshots are intentionally
  // structured-cloneable, so never put that raw Tree-owned payload into the
  // Coordinator result. Capture it out-of-band and return only a clone-safe
  // execution receipt through the orchestration layer.
  let rawOutput;
  const plan=runtime.director.buildRequestedPlan({
    source:'tree-summary',
    decisions:[{action:'run',job:TREE_SUMMARY_JOB_TYPE,route:NEXUS_JOB_ROUTE.LOCAL,reason:'Tree-owned summary generation requested Model Worker execution'}],
    jobs:[{type:TREE_SUMMARY_JOB_TYPE,name:label,kind:NEXUS_JOB_KIND.INSPECT,route:NEXUS_JOB_ROUTE.LOCAL,priority,transactionRequired:false,metadata:{subsystem:'tree-lore',executionOwner:'tree-lore',modelWorker:true,...metadata}}],
    metadata:{treeSummary:{label,...metadata}},
  });
  const snapshot=await runtime.coordinator.run(plan,{executors:{[TREE_SUMMARY_JOB_TYPE]:async()=>{
    rawOutput=await execute();
    return {completed:true,outputCapturedBy:'tree-summary'};
  }},signal});
  const job=snapshot.jobs?.find(row=>row.type===TREE_SUMMARY_JOB_TYPE)||snapshot.jobs?.[0]||null;
  if(!job)throw new Error('Tree Summary Work Coordinator returned no job.');
  if(job.state==='failed'||job.error)throw Object.assign(new Error(job.error||'Tree Summary Work Director job failed.'),{name:'TV2TreeSummaryDirectorFailure'});
  return{plan,snapshot,job,output:rawOutput};
}
