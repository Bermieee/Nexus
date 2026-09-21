import { builder2Fingerprint } from './contracts.js';
function paths(taxonomy){
  const byId=new Map(taxonomy.nodes.map(t=>[t.taxonId,t])),memo=new Map();
  const one=id=>{
    if(memo.has(id))return memo.get(id);
    const n=byId.get(id);if(!n)return[];
    const virtualCanonicalRoot=!n.parentTaxonId&&!!n.canonicalNodeId&&n.entryPolicy==='container-only';
    const p=virtualCanonicalRoot?[]:(n.parentTaxonId?[...one(n.parentTaxonId),n.label]:[n.label]);memo.set(id,p);return p;
  };
  return new Map(taxonomy.nodes.map(t=>[t.taxonId,one(t.taxonId)]));
}
export function createBuilder2Preview({plan,taxonomy,handoff,treeInventory=null,worksetSources=[]}={}){const p=paths(taxonomy),oldHomes=new Map();for(const n of treeInventory?.nodes||[])for(const uid of [...(n.uids||[]),...(n.loreUids||[]),...(n.entryUids||[])]){const arr=oldHomes.get(Number(uid))||[];arr.push(Array.isArray(n.path)&&n.path.length?n.path:[n.label].filter(Boolean));oldHomes.set(Number(uid),arr);}const byKey=new Map(worksetSources.map(s=>[s.sourceKey,s]));const changes=[];for(const x of handoff.uidPlacements||[]){changes.push({sourceKey:x.sourceKey,uid:x.uid,title:byKey.get(x.sourceKey)?.title||null,beforePaths:oldHomes.get(Number(x.uid))||[],afterPath:p.get(x.taxonId)||[],removed:false});}for(const r of handoff.sourceRemovals||[])changes.push({sourceKey:r.sourceKey,uid:r.uid,title:byKey.get(r.sourceKey)?.title||null,beforePaths:oldHomes.get(Number(r.uid))||[],afterPath:null,removed:true});for(const r of handoff.sourceExclusions||[])changes.push({sourceKey:r.sourceKey,uid:r.uid,title:byKey.get(r.sourceKey)?.title||null,beforePaths:oldHomes.get(Number(r.uid))||[],afterPath:null,removed:false,excluded:true});changes.sort((a,b)=>a.uid-b.uid);const exact=handoff.prospectivePopulation?.complete===true;const model={contract:'nexus-lorebook-builder/v2-preview',runId:plan.runId,planRevision:plan.planRevision,sourceRevision:plan.sourceRevision,corpusRevision:plan.corpusRevision||plan.sourceRevision,treeRevision:plan.treeRevision||null,taxonomyRevision:taxonomy.revisionId,handoffFingerprint:handoff.handoffFingerprint,exact,partial:!exact,changes,prospectivePopulation:exact?handoff.prospectivePopulation:null,unknownUnchangedPopulation:!exact};return{...model,previewFingerprint:`preview:${builder2Fingerprint(model)}`};}
