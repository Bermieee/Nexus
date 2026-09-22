/** Pure policy for deciding when a Summary may be removed after Lore digestion. */
export function evaluateLoreDigestCleanup({saga=null,proposals=[]}={}){
    if(!saga)return {allowed:false,reason:'missing-parent-saga'};
    if(String(saga.state||'')!=='committed')return {allowed:false,reason:'parent-not-committed',state:saga.state||null};
    if(saga.deleteAfterDigest!==true)return {allowed:false,reason:'delete-after-digest-disabled'};
    const proposalIds=[...new Set((saga.proposalIds||[]).map(String).filter(Boolean))];
    if(!proposalIds.length)return {allowed:false,reason:'no-lore-children',proposalIds};
    const byId=new Map((Array.isArray(proposals)?proposals:[]).filter(Boolean).map(row=>[String(row.id),row]));
    const children=proposalIds.map(id=>byId.get(id)).filter(Boolean);
    if(children.length!==proposalIds.length)return {allowed:false,reason:'child-audit-missing',proposalIds,foundIds:children.map(row=>String(row.id))};
    const unsettled=children.filter(row=>String(row.status||'')!=='approved');
    if(unsettled.length)return {allowed:false,reason:'lore-children-unsettled',proposalIds,unsettled:unsettled.map(row=>({id:String(row.id),status:String(row.status||'unknown')}))};
    return {allowed:true,reason:'all-lore-children-approved',proposalIds};
}
