import { BUILDER2_CLASSIFICATION_DECISION, createBuilder2Taxon, createBuilder2TaxonomyRevision, builder2Fingerprint, clean } from './contracts.js';

export function collectBuilder2Gaps(classifications=[]){
  return classifications
    .filter(r=>r.decision===BUILDER2_CLASSIFICATION_DECISION.TAXONOMY_GAP&&!['nonsemantic','deferred'].includes(r.metadata?.resolvedDisposition))
    .map(r=>({sourceKey:r.sourceKey,sourceFingerprint:r.sourceFingerprint,reason:r.reason||'',classificationRevision:r.classificationRevision}));
}

export function createBuilder2FallbackGapProposals({gaps=[],sources=[],taxonomy,reason='uncovered-by-gap-consolidator'}={}){
  const bySource=new Map((sources||[]).map(s=>[s.sourceKey,s]));
  return (gaps||[]).map((gap,index)=>{
    const source=bySource.get(gap.sourceKey);
    const title=clean(source?.title)||clean(gap.sourceKey)||`Gap ${index+1}`;
    return{
      proposalId:`gap-fallback:${builder2Fingerprint({sourceKey:gap.sourceKey,reason:gap.reason||'',classificationRevision:gap.classificationRevision||''})}`,
      status:'pending',
      parentTaxonId:null,
      label:`Resolve gap · ${title}`,
      purpose:clean(gap.reason)||'This taxonomy gap was not covered by a consolidated category proposal. Choose an existing category or mark it structural/non-semantic.',
      aliases:[],
      entryPolicy:'allow',
      evidenceSourceKeys:[gap.sourceKey],
      taxonomyRevision:taxonomy?.revisionId||null,
      classificationRevision:taxonomy?.classificationRevisionId||null,
      fallback:true,
      fallbackReason:reason,
    };
  });
}

export async function consolidateBuilder2Gaps({gaps=[],sources=[],taxonomy,consolidateGaps,signal=null}={}){
  if(!gaps.length)return[];
  if(typeof consolidateGaps!=='function')throw new Error('Builder 2 gap consolidation requires consolidateGaps().');
  const bySource=new Map(sources.map(s=>[s.sourceKey,s]));
  const raw=await consolidateGaps({
    gaps:gaps.map(g=>({...g,source:bySource.get(g.sourceKey)?{title:bySource.get(g.sourceKey).title,keys:bySource.get(g.sourceKey).keys,content:bySource.get(g.sourceKey).content}:null})),
    taxonomy:taxonomy.nodes,
    signal,
  });
  const legal=new Set(gaps.map(g=>g.sourceKey));
  const normalized=[];
  const evidenceCounts=new Map();
  for(const [i,p] of (raw?.proposals||[]).entries()){
    const evidence=[...new Set((p.evidenceSourceKeys||[]).map(clean).filter(k=>legal.has(k)))];
    if(!clean(p.label)||!evidence.length)continue;
    for(const key of evidence)evidenceCounts.set(key,(evidenceCounts.get(key)||0)+1);
    normalized.push({
      proposalId:clean(p.proposalId)||`gap:${builder2Fingerprint({i,label:p.label,evidence})}`,
      status:'pending',
      parentTaxonId:clean(p.parentTaxonId)||null,
      label:clean(p.label),purpose:clean(p.purpose),
      aliases:[...new Set((p.aliases||[]).map(clean).filter(Boolean))],
      entryPolicy:p.entryPolicy==='container-only'?'container-only':'allow',
      evidenceSourceKeys:evidence,
      taxonomyRevision:taxonomy.revisionId,
      classificationRevision:taxonomy.classificationRevisionId,
      fallback:false,
    });
  }

  // A model-produced gap proposal is advisory, not authority. Every unresolved
  // source must reach the operator exactly once. If the consolidator omitted a
  // source or mentioned it in multiple competing proposals, remove that source
  // from model-owned groups and surface one deterministic manual fallback row.
  const out=[];
  for(const proposal of normalized){
    const evidence=proposal.evidenceSourceKeys.filter(key=>evidenceCounts.get(key)===1);
    if(evidence.length)out.push({...proposal,evidenceSourceKeys:evidence});
  }
  const unresolved=gaps.filter(gap=>evidenceCounts.get(gap.sourceKey)!==1);
  if(unresolved.length){
    const duplicateKeys=new Set(unresolved.filter(g=>evidenceCounts.get(g.sourceKey)>1).map(g=>g.sourceKey));
    for(const proposal of createBuilder2FallbackGapProposals({gaps:unresolved,sources,taxonomy})){
      out.push({...proposal,fallbackReason:duplicateKeys.has(proposal.evidenceSourceKeys[0])?'overlapping-gap-consolidator-evidence':'uncovered-by-gap-consolidator'});
    }
  }
  return out;
}

export function applyBuilder2GapReview({taxonomy,proposals=[],decisions={}}={}){
  const nodes=[...taxonomy.nodes],byId=new Map(nodes.map(n=>[n.taxonId,n])),affected=new Set(),assignments={},resolved=[],deferred=new Set();
  for(const p of proposals){
    const d=decisions[p.proposalId]||{action:'defer'};
    if(d.action==='approve'){
      if(p.fallback===true)throw new Error(`Builder 2 fallback gap ${p.proposalId} cannot create a new category; merge it into an existing category, mark it structural/non-semantic, or defer it.`);
      const id=clean(d.taxonId)||`builder:${builder2Fingerprint({parent:p.parentTaxonId,label:p.label,evidence:p.evidenceSourceKeys})}`;
      if(!byId.has(id)){
        const node=createBuilder2Taxon({taxonId:id,parentTaxonId:p.parentTaxonId,label:p.label,purpose:p.purpose,aliases:p.aliases,evidenceSourceKeys:p.evidenceSourceKeys,entryPolicy:p.entryPolicy,origin:'builder'});
        nodes.push(node);byId.set(id,node);
      }
      for(const k of p.evidenceSourceKeys){affected.add(k);assignments[k]=id;}
      resolved.push({...p,status:'approved',taxonId:id});
    }else if(d.action==='merge-into'){
      const id=clean(d.taxonId);if(!byId.has(id))throw new Error(`Builder 2 gap merge target ${id} does not exist.`);
      for(const k of p.evidenceSourceKeys){affected.add(k);assignments[k]=id;}
      resolved.push({...p,status:'merged',taxonId:id});
    }else if(d.action==='exclude'){
      for(const k of p.evidenceSourceKeys)affected.add(k);
      resolved.push({...p,status:'excluded',excludedSourceKeys:[...p.evidenceSourceKeys]});
    }else if(d.action==='reject'){
      // Preserved only for old persisted plans. The historical status remains
      // visible, but pipeline completion treats it as unresolved authority.
      resolved.push({...p,status:'rejected',legacyRejected:true});
    }else if(d.action==='defer'){for(const k of p.evidenceSourceKeys)deferred.add(k);resolved.push({...p,status:'deferred',deferredSourceKeys:[...p.evidenceSourceKeys]});}
    else throw new Error(`Unknown Builder 2 gap review action ${d.action}.`);
  }
  const next=createBuilder2TaxonomyRevision({sourceRevision:taxonomy.sourceRevision,corpusRevision:taxonomy.corpusRevision,treeRevision:taxonomy.treeRevision,nodes,metadata:{...(taxonomy.metadata||{}),gapReview:true}});
  return{taxonomy:next,affectedSourceKeys:[...affected],classificationAssignments:assignments,excludedSourceKeys:[...new Set(resolved.filter(p=>p.status==='excluded').flatMap(p=>p.excludedSourceKeys||[]))],deferredSourceKeys:[...deferred],proposals:resolved};
}
