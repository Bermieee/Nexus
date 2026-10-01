import {normalizeOperatorReviewScope,operatorReviewScopeProjection} from '../nexus/review-scope.js';
// All product writes retain the binding captured at admission through Nexus's
// final preflight. A picker value can never replace that authority.
export async function commitStoryWorldTreeMetadata({getContext,readBinding,ledger,commitMutation,key,value,expected,preflight=null,type='world-tree-operator',approvedBy='operator'}={}){
  const context=getContext(),binding=readBinding({write:true});
  const prior=structuredClone(expected??null);
  if(String(context?.chatId)!==binding.chatId||!context.chatMetadata)throw Error('World Tree story context unavailable');
  const scope=normalizeOperatorReviewScope({chatId:binding.chatId,storyId:context.storyId??context.story?.id??null});
  const assumptions={chatId:binding.chatId,operatorReviewScope:scope.identity,worldTreeBinding:binding};
  const mutation={type:'metadata.set',chatId:binding.chatId,key,value,expected:prior??undefined};
  const tx=ledger.begin({type,assumptions,input:{chatId:binding.chatId,book:binding.book},metadata:{source:'explicit-operator-command',reviewScope:operatorReviewScopeProjection(scope,0)}});
  ledger.executing(tx.id);ledger.parsed(tx.id,{operation:mutation.type});ledger.validated(tx.id,{passed:true});
  ledger.staged(tx.id,{operation:mutation.type},{mutationProposal:{type:mutation.type,draft:mutation,assumptions,approvalRequired:true}});
  ledger.approve(tx.id,{by:approvedBy});
  const assertCurrent=()=>{
    readBinding({write:true,expected:binding});
    const live=getContext();
    if(live?.chatId!==context.chatId||live.chatMetadata!==context.chatMetadata||JSON.stringify(live.chatMetadata[key]??null)!==JSON.stringify(prior))throw Error('World Tree story metadata changed');
  };
  return commitMutation(tx.id,mutation,{context,targetLedger:ledger,currentAssumptions:()=>{assertCurrent();return assumptions;},afterIntent:assertCurrent,preflight:async()=>{assertCurrent();await preflight?.();assertCurrent();}});
}
