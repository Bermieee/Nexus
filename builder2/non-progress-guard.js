import { builder2Fingerprint } from './contracts.js';

const MAX_HISTORY=16;
function stableRows(rows=[]){return [...(rows||[])].map(row=>structuredClone(row)).sort((a,b)=>String(a?.sourceKey||a?.proposalId||a?.taxonId||'').localeCompare(String(b?.sourceKey||b?.proposalId||b?.taxonId||'')));}
export function builder2SemanticRoundFingerprint({stage,taxonomy,evidence=[],classifications=[],gaps=[],requestedSourceKeys=[]}={}){
  return builder2Fingerprint({
    stage:String(stage||''),taxonomyRevision:taxonomy?.revisionId||null,
    taxonomy:(taxonomy?.nodes||[]).map(n=>({taxonId:n.taxonId,parentTaxonId:n.parentTaxonId,label:n.label,purpose:n.purpose,aliases:n.aliases,entryPolicy:n.entryPolicy})),
    evidence:stableRows(evidence).map(s=>({sourceKey:s.sourceKey,fingerprint:s.fingerprint,title:s.title,keys:s.keys,content:s.content,removed:s.removed===true,disabled:s.disabled===true})),
    classifications:stableRows(classifications).map(r=>({sourceKey:r.sourceKey,sourceFingerprint:r.sourceFingerprint,decision:r.decision,taxonId:r.taxonId,candidates:r.candidates,reason:r.reason,metadata:r.metadata?.resolvedDisposition||null})),
    gaps:stableRows(gaps),requestedSourceKeys:[...new Set((requestedSourceKeys||[]).map(String))].sort(),
  });
}
export function inspectBuilder2SemanticNonProgress(plan,{stage,fingerprint}={}){
  const history=Array.isArray(plan?.metadata?.semanticProgressGuard?.history)?plan.metadata.semanticProgressGuard.history:[];
  const match=history.find(row=>row.stage===String(stage||'')&&row.fingerprint===String(fingerprint||''));
  return {stalled:!!match,match:match||null,history};
}
export function builder2SemanticProgressMetadata(plan,{stage,fingerprint,stalled=false,reason=''}={}){
  const prior=Array.isArray(plan?.metadata?.semanticProgressGuard?.history)?plan.metadata.semanticProgressGuard.history:[];
  const row={stage:String(stage||''),fingerprint:String(fingerprint||''),at:Date.now(),stalled:stalled===true,reason:String(reason||'')};
  const history=[...prior,row].slice(-MAX_HISTORY);
  return {...(plan?.metadata||{}),semanticProgressGuard:{history,last:row,stalled:stalled===true}};
}
