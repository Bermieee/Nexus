import {
  BUILDER2_TAXON_ORIGIN,
  BUILDER2_TAXON_PROTECTION,
  BUILDER2_TAXON_ENTRY_POLICY,
  createBuilder2Taxon,
  createBuilder2TaxonomyRevision,
  clean,
} from './contracts.js';

export function createBuilder2ExistingTaxonomy(tree={}){
  const nodes=Array.isArray(tree?.nodes)?tree.nodes:[], byCanonical=new Map();
  for(const row of nodes)if(row?.id)byCanonical.set(String(row.id),`existing:${row.id}`);
  return nodes.map((row,i)=>createBuilder2Taxon({
    taxonId:`existing:${clean(row.id)||i}`,
    parentTaxonId:row.parentId&&byCanonical.get(String(row.parentId))||null,
    label:clean(row.label)||`Node ${i+1}`,
    purpose:clean(row.summary),aliases:row.aliases||[],evidenceSourceKeys:[],
    origin:BUILDER2_TAXON_ORIGIN.EXISTING_TREE,
    protection:row.locked?BUILDER2_TAXON_PROTECTION.LOCKED:row.protected?BUILDER2_TAXON_PROTECTION.PROTECTED:BUILDER2_TAXON_PROTECTION.NORMAL,
    entryPolicy:row.containerOnly?'container-only':'allow',canonicalNodeId:clean(row.id)||null,
    metadata:{path:row.path||[],canonicalDepth:Number(row.depth)||0},
  }));
}


function siblingKey(node){return `${clean(node?.parentTaxonId)||'__ROOT__'}|${clean(node?.label).toLocaleLowerCase()}`;}
function strongerPurpose(a,b){const aa=clean(a),bb=clean(b);return bb.length>aa.length?bb:aa;}
function preferredDuplicateTaxon(rows=[]){
  const ranked=[...rows].sort((a,b)=>{
    const ax=a?.canonicalNodeId?0:1,bx=b?.canonicalNodeId?0:1;if(ax!==bx)return ax-bx;
    const ap=(a?.protection==='locked'||a?.protection==='protected')?0:1,bp=(b?.protection==='locked'||b?.protection==='protected')?0:1;if(ap!==bp)return ap-bp;
    return clean(a?.taxonId).localeCompare(clean(b?.taxonId));
  });
  return ranked[0]||null;
}
/**
 * Provider taxonomy output may contain semantic duplicates with different builder IDs.
 * Coalesce only groups that include at least one Builder-owned taxon; two distinct
 * canonical existing-tree siblings remain an operator-visible structural conflict.
 * Child parent references are redirected so no evidence/branch is orphaned.
 */
export function coalesceBuilder2DuplicateSiblingTaxa(nodes=[]){
  let rows=(nodes||[]).map(row=>({...row,aliases:[...(row?.aliases||[])],evidenceSourceKeys:[...(row?.evidenceSourceKeys||[])]}));
  const merged=[];
  const maxRounds=Math.max(1,rows.length+1);
  for(let round=0;round<maxRounds;round++){
    const groups=new Map();for(const row of rows){const key=siblingKey(row);const list=groups.get(key)||[];list.push(row);groups.set(key,list);}
    const duplicate=[...groups.values()].find(group=>group.length>1&&group.some(row=>!clean(row?.canonicalNodeId)));
    if(!duplicate)break;
    const keep=preferredDuplicateTaxon(duplicate);if(!keep)break;
    const removed=duplicate.filter(row=>row!==keep);
    const removedIds=new Set(removed.map(row=>clean(row.taxonId)).filter(Boolean));
    const mergedAliases=[...new Set(duplicate.flatMap(row=>row.aliases||[]).map(clean).filter(Boolean))];
    const mergedEvidence=[...new Set(duplicate.flatMap(row=>row.evidenceSourceKeys||[]).map(clean).filter(Boolean))];
    const purpose=duplicate.reduce((value,row)=>strongerPurpose(value,row?.purpose),'');
    const entryPolicy=duplicate.some(row=>row?.entryPolicy===BUILDER2_TAXON_ENTRY_POLICY.ALLOW)?BUILDER2_TAXON_ENTRY_POLICY.ALLOW:BUILDER2_TAXON_ENTRY_POLICY.CONTAINER_ONLY;
    rows=rows.filter(row=>!removedIds.has(clean(row.taxonId))).map(row=>removedIds.has(clean(row.parentTaxonId))?{...row,parentTaxonId:keep.taxonId}:row);
    rows=rows.map(row=>clean(row.taxonId)===clean(keep.taxonId)?{...row,purpose:purpose||row.purpose,aliases:mergedAliases,evidenceSourceKeys:mergedEvidence,entryPolicy}:row);
    merged.push({keptTaxonId:clean(keep.taxonId),removedTaxonIds:[...removedIds],parentTaxonId:clean(keep.parentTaxonId)||null,label:clean(keep.label)});
  }
  return {nodes:rows,merged};
}

function mergePlannerNodes(existing,proposed){
  const byId=new Map(existing.map(n=>[n.taxonId,n]));
  for(const raw of proposed||[]){
    const node=createBuilder2Taxon(raw),prior=byId.get(node.taxonId);
    if(prior?.origin===BUILDER2_TAXON_ORIGIN.EXISTING_TREE&&(prior.protection==='locked'||prior.protection==='protected')){
      byId.set(node.taxonId,{...prior,purpose:node.purpose||prior.purpose,aliases:[...new Set([...(prior.aliases||[]),...(node.aliases||[])])],evidenceSourceKeys:[...new Set([...(prior.evidenceSourceKeys||[]),...(node.evidenceSourceKeys||[])])]});
    }else byId.set(node.taxonId,node);
  }
  return [...byId.values()];
}

function looksLikeSyntheticRoot(node,proposed=[]){
  if(clean(node?.parentTaxonId)||clean(node?.canonicalNodeId))return false;
  const id=clean(node?.taxonId).toLowerCase(),label=clean(node?.label).toLowerCase(),purpose=clean(node?.purpose).toLowerCase();
  const hasChildren=proposed.some(child=>clean(child?.parentTaxonId)===clean(node?.taxonId));
  if(!hasChildren)return false;
  if(id==='builder:root'||id.startsWith('builder:root-')||id.startsWith('builder:root_'))return true;
  return id.startsWith('builder:') && node?.entryPolicy===BUILDER2_TAXON_ENTRY_POLICY.CONTAINER_ONLY && (/(^|\b)root(\b|$)/.test(label)||/container[- ]only root|root taxon|organizing all lorebook|top[- ]level index/.test(purpose));
}

/**
 * The Builder taxonomy has a semantic root concept, while the canonical Nexus
 * Tree already has a physical root. A model-produced synthetic root is therefore
 * routing context, not another visible Tree category. Absorb it locally and
 * attach its children to the canonical root (existing Tree) or make them
 * top-level categories (fresh Tree).
 */
export function normalizeBuilder2PlannerRoots(existing=[],proposed=[]){
  const existingRoot=[...(existing||[]),...(proposed||[])].find(node=>!node.parentTaxonId&&node.canonicalNodeId&&node.entryPolicy===BUILDER2_TAXON_ENTRY_POLICY.CONTAINER_ONLY)||null;
  let rows=(proposed||[]).map(row=>({...row}));
  const roots=rows.filter(row=>looksLikeSyntheticRoot(row,rows));
  const absorbed=[];
  for(const root of roots){
    const rootId=clean(root.taxonId);if(!rootId)continue;
    rows=rows.filter(row=>clean(row.taxonId)!==rootId).map(row=>clean(row.parentTaxonId)===rootId?{...row,parentTaxonId:existingRoot?.taxonId||null}:row);
    absorbed.push(rootId);
  }
  // Incremental/repair plans share the canonical Tree root. Any new top-level
  // Builder category belongs beneath that existing root, never beside it.
  if(existingRoot){
    rows=rows.map(row=>!clean(row.parentTaxonId)&&!clean(row.canonicalNodeId)?{...row,parentTaxonId:existingRoot.taxonId}:row);
  }
  // If a provider returned a root-like node that could not be absorbed (for
  // example a degenerate root-only proposal), it must still remain container-only.
  rows=rows.map(row=>{
    const id=clean(row.taxonId).toLowerCase();
    if(id==='builder:root'&&!clean(row.canonicalNodeId))return{...row,entryPolicy:BUILDER2_TAXON_ENTRY_POLICY.CONTAINER_ONLY};
    return row;
  });
  return{nodes:rows,absorbedRootTaxonIds:absorbed,canonicalRootTaxonId:existingRoot?.taxonId||null};
}

export async function planBuilder2Taxonomy({sourceRevision,corpusRevision,treeRevision=null,survey,treeInventory=null,planTaxonomy,signal=null}={}){
  if(typeof planTaxonomy!=='function')throw new Error('Builder 2 taxonomy requires centralized planTaxonomy().');
  const existing=createBuilder2ExistingTaxonomy(treeInventory||{});
  const raw=await planTaxonomy({semanticMap:survey?.semanticMap||[],existingTaxonomy:structuredClone(existing),sourceRevision,corpusRevision,treeRevision,signal});
  const normalized=normalizeBuilder2PlannerRoots(existing,raw?.nodes||[]);
  const coalesced=coalesceBuilder2DuplicateSiblingTaxa(mergePlannerNodes(existing,normalized.nodes));
  return createBuilder2TaxonomyRevision({sourceRevision,corpusRevision,treeRevision,nodes:coalesced.nodes,metadata:{plannerReason:clean(raw?.reason),surveyFingerprint:survey?.surveyFingerprint||null,absorbedSyntheticRootTaxonIds:normalized.absorbedRootTaxonIds,canonicalRootTaxonId:normalized.canonicalRootTaxonId,coalescedDuplicateSiblingTaxa:coalesced.merged}});
}

function assertProtectedTaxonomyAuthority(previousNodes=[],nextNodes=[]){
  const nextById=new Map((nextNodes||[]).map(n=>[clean(n?.taxonId),n]));
  for(const prior of previousNodes||[]){
    if(prior?.protection!==BUILDER2_TAXON_PROTECTION.LOCKED&&prior?.protection!==BUILDER2_TAXON_PROTECTION.PROTECTED)continue;
    const next=nextById.get(clean(prior.taxonId));
    if(!next)throw new Error(`Builder 2 operator review cannot delete protected taxon ${prior.taxonId}.`);
    const immutable=['parentTaxonId','label','origin','protection','entryPolicy','canonicalNodeId'];
    for(const key of immutable){const a=clean(prior?.[key]),b=clean(next?.[key]);if(a!==b)throw new Error(`Builder 2 operator review cannot change protected taxon ${prior.taxonId} field ${key}.`);}
  }
  for(const next of nextNodes||[]){
    const prior=(previousNodes||[]).find(n=>clean(n?.taxonId)===clean(next?.taxonId));
    if(!prior&&clean(next?.origin)===BUILDER2_TAXON_ORIGIN.EXISTING_TREE)throw new Error(`Builder 2 operator review cannot manufacture existing-tree authority for ${next.taxonId}.`);
    if(!prior&&clean(next?.canonicalNodeId))throw new Error(`Builder 2 operator-created taxon ${next.taxonId} cannot claim canonicalNodeId ${next.canonicalNodeId}.`);
  }
}
export function applyBuilder2TaxonomyReview(taxonomy,{approved=true,nodes=null}={}){
  if(!approved)throw new Error('Builder 2 taxonomy review rejected; run requires operator revision or cancellation.');
  if(!nodes)return{...taxonomy,metadata:{...(taxonomy.metadata||{}),reviewed:true}};
  assertProtectedTaxonomyAuthority(taxonomy?.nodes||[],nodes);
  // Root-like planner artifacts are never valid entry destinations even if an
  // operator edits the plan before approval.
  const normalized=normalizeBuilder2PlannerRoots([],nodes);
  return createBuilder2TaxonomyRevision({sourceRevision:taxonomy.sourceRevision,corpusRevision:taxonomy.corpusRevision,treeRevision:taxonomy.treeRevision,nodes:normalized.nodes,metadata:{...(taxonomy.metadata||{}),reviewed:true,operatorEdited:true,absorbedSyntheticRootTaxonIds:[...new Set([...(taxonomy.metadata?.absorbedSyntheticRootTaxonIds||[]),...normalized.absorbedRootTaxonIds])]}});
}
