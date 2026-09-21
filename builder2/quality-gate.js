import { BUILDER2_CLASSIFICATION_DECISION, BUILDER2_TAXON_ENTRY_POLICY, builder2Fingerprint } from './contracts.js';

export function evaluateBuilder2Quality({sources=[],taxonomy,classifications=[],prospectivePopulation=null}={}){
  const blockers=[],signals=[],sourceMap=new Map(sources.map(s=>[s.sourceKey,s])),taxa=new Map(taxonomy.nodes.map(n=>[n.taxonId,n])),seen=new Set(),deferred=[];
  for(const c of classifications){
    if(seen.has(c.sourceKey))blockers.push({blockerId:`duplicate:${c.sourceKey}`,type:'duplicate-source-authority',sourceKey:c.sourceKey});
    seen.add(c.sourceKey);
    const src=sourceMap.get(c.sourceKey);
    if(!src)blockers.push({blockerId:`unknown-source:${c.sourceKey}`,type:'unknown-source'});
    else if(c.sourceFingerprint!==src?.fingerprint)blockers.push({blockerId:`stale:${c.sourceKey}`,type:'stale-classification'});

    const disposition=c.metadata?.resolvedDisposition||null;
    if(disposition==='deferred')deferred.push(c.sourceKey);
    if(c.decision!==BUILDER2_CLASSIFICATION_DECISION.CLASSIFIED&&!['nonsemantic','deferred'].includes(disposition)){
      blockers.push({blockerId:`unresolved:${c.sourceKey}`,type:'unresolved-classification',sourceKey:c.sourceKey,decision:c.decision});
    }
    if(c.decision===BUILDER2_CLASSIFICATION_DECISION.CLASSIFIED){
      const t=taxa.get(c.taxonId);
      if(!t)blockers.push({blockerId:`unknown-taxon:${c.sourceKey}`,type:'unknown-taxon'});
      else if(t.entryPolicy===BUILDER2_TAXON_ENTRY_POLICY.CONTAINER_ONLY)blockers.push({blockerId:`container:${c.sourceKey}`,type:'container-only-attachment'});
    }
  }
  if(deferred.length)signals.push({signalId:'operator-deferred-classifications',type:'operator-deferred-classifications',count:deferred.length,sourceKeys:[...deferred].sort()});
  const roots=taxonomy.nodes.filter(n=>!n.parentTaxonId);
  if(roots.length>16)signals.push({signalId:'root-fragmentation',type:'root-fragmentation',count:roots.length});
  const children=new Map();
  for(const n of taxonomy.nodes){const p=n.parentTaxonId||'ROOT';children.set(p,(children.get(p)||0)+1);}
  const leafIds=new Set(taxonomy.nodes.filter(n=>!children.has(n.taxonId)).map(n=>n.taxonId)),counts=new Map();
  for(const c of classifications)if(c.taxonId)counts.set(c.taxonId,(counts.get(c.taxonId)||0)+1);
  const singleton=[...leafIds].filter(id=>(counts.get(id)||0)===1).length;
  if(singleton>Math.max(8,Math.ceil(leafIds.size*.6)))signals.push({signalId:'singleton-heavy',type:'singleton-heavy',count:singleton});
  if(prospectivePopulation?.duplicateUidHomes?.length)for(const uid of prospectivePopulation.duplicateUidHomes)blockers.push({blockerId:`duplicate-uid-home:${uid}`,type:'duplicate-uid-home',uid});
  const reportFingerprint=`quality:${builder2Fingerprint({blockers,signals})}`;
  return{passed:blockers.length===0,blockers,signals,reportFingerprint};
}
