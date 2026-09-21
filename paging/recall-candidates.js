// Vector paging may nominate or rank ordinary Nexus relevance candidates, but
// it is never an eligibility authority. A wrong-but-nonempty resident set must
// not hide otherwise valid historical memory from the deterministic recall path.
export function composeMemoryRecallCandidates(ordinary,paging,limit,semanticEnabled=true){
    const cap=Math.max(1,Number(limit)||1);
    const preferredIds=paging?.eligibleIds instanceof Set ? paging.eligibleIds : null;
    const preferred=preferredIds?ordinary.filter(r=>preferredIds.has(String(r.id))):[];
    const preferredSet=new Set(preferred.map(r=>String(r.id)));
    const ordered=[...preferred,...ordinary.filter(r=>!preferredSet.has(String(r.id)))];
    const vectorIds=new Set((paging?.nominationDetails||[]).map(row=>String(row.sourceId)));
    const provenance={};
    for(const row of ordered)provenance[String(row.id)]=vectorIds.has(String(row.id))?'lexical+vector':'lexical';
    const fallback=ordered.slice(0,cap);
    if(!semanticEnabled||!['enabled','memory-pilot'].includes(paging?.mode))return {fallback,candidates:fallback,provenance};
    const existing=new Set(ordinary.map(r=>String(r.id)));
    const seen=new Set();
    const nominated=(paging?.nominated||[]).filter(r=>!existing.has(String(r.id))&&!seen.has(String(r.id))&&seen.add(String(r.id)));
    const quota=Math.min(nominated.length,Math.max(1,Math.floor(cap/2)));
    const ordinaryQuota=Math.max(0,cap-quota);
    for(const row of nominated.slice(0,quota))provenance[String(row.id)]='vector';
    const candidates=[...ordered.slice(0,ordinaryQuota),...nominated.slice(0,quota).map(r=>({...r,score:0}))];
    return {fallback,candidates,provenance};
}
