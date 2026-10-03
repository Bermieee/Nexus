import {acquireNexusMutationResources,loreMutationResource,treeMutationResource,metadataMutationResource} from '../nexus/mutation-lock.js';
import {inspectNexusCommitResourceConflicts,reconcileNexusCommitRecovery} from '../nexus/transaction-service.js';

function ownsIntent(plan,row){
  const mutation=row.canonicalMutation,binding=plan.binding,fingerprint=plan.review?.approvedFingerprint;
  if(binding?.kind==='lorebook'){
    const receipt=mutation?.tree?.nexusWorldTreeBuild;
    return mutation?.type==='tree.replace'&&mutation.book===binding.book&&receipt?.book===binding.book&&receipt.runId===plan.runId&&receipt.fingerprint===fingerprint;
  }
  const receipt=mutation?.value;
  return mutation?.type==='metadata.set'&&mutation.chatId===binding?.chatId&&mutation.key==='nexusWorldTreeOrganizationV1'
    &&receipt?.book===binding.book&&receipt.lastRunId===plan.runId&&receipt.lastFingerprint===fingerprint&&JSON.stringify(receipt.binding)===JSON.stringify(binding);
}

// COMMITTING in PlanStore precedes the physical owner's durable intent. An
// interrupted run may therefore have nothing to reconcile, or an intent whose
// canonical PRE footprint proves it never applied. Neither case is unknown.
// Claim the exact resources while proving PRE; actual retry still goes through
// the normal coordinator and repeats its freshness checks under write authority.
export async function recoverUnappliedWorldBuild({plan,assertFresh,context=null,
  inspectConflicts=inspectNexusCommitResourceConflicts,reconcile=reconcileNexusCommitRecovery}={}){
  const binding=plan?.binding;
  if(!binding?.book||!(binding.kind==='lorebook'||binding.chatId)||typeof assertFresh!=='function')throw Error('Builder recovery requires exact owner authority');
  const resources=binding.kind==='lorebook'?[loreMutationResource(binding.book),treeMutationResource(binding.book)]:[metadataMutationResource(binding.chatId)];
  const authority=await acquireNexusMutationResources(resources,{ownerId:plan.runId+':recovery',operation:'world-build-recovery',waitTimeoutMs:10000});
  try{
    await assertFresh();
    const rows=inspectConflicts(resources);
    // Never settle unrelated work merely because it touches the same book.
    for(const row of rows)if(!ownsIntent(plan,row))throw Error('Builder recovery is blocked by another unresolved transaction: '+row.id);
    const reconciled=[];
    for(const row of rows){
      await reconcile(row.id,{disposition:'confirmed-not-applied',context,projectDependents:false,
        note:'Builder recovery: unchanged reviewed authority and canonical PRE proof permit resuming this approved run.'});
      reconciled.push(row.id);
    }
    await assertFresh();
    if(inspectConflicts(resources).length)throw Error('Builder recovery still has unresolved physical ownership');
    return {state:'not-applied',reconciled};
  }finally{authority.release();}
}
