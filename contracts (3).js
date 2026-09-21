const CONTRACT = 'nexus-lorebook-builder/v2-plan';
export const BUILDER2_CONTRACT = CONTRACT;
export const BUILDER2_PHASE = Object.freeze({
  INVENTORY:'inventory', SURVEY:'survey', TAXONOMY_DRAFT:'taxonomy-draft', TAXONOMY_REVIEW:'taxonomy-review',
  CLASSIFICATION:'classification', CLASSIFICATION_REVIEW:'classification-review', GAP_REVIEW:'gap-review',
  RECLASSIFICATION:'reclassification', RECONCILIATION:'reconciliation', QUALITY_REVIEW:'quality-review',
  MATERIALIZATION:'materialization', VALIDATION:'validation', STAGED:'staged', COMMITTED:'committed',
  CANCELLED:'cancelled', STALE:'stale'
});
export const BUILDER2_CLASSIFICATION_DECISION = Object.freeze({CLASSIFIED:'classified', TAXONOMY_GAP:'taxonomy_gap', AMBIGUOUS:'ambiguous'});
export const BUILDER2_TAXON_ORIGIN = Object.freeze({EXISTING_TREE:'existing-tree', USER:'user', BUILDER:'builder'});
export const BUILDER2_TAXON_PROTECTION = Object.freeze({NORMAL:'normal', LOCKED:'locked', PROTECTED:'protected'});
export const BUILDER2_TAXON_ENTRY_POLICY = Object.freeze({ALLOW:'allow', CONTAINER_ONLY:'container-only'});
const PHASES = new Set(Object.values(BUILDER2_PHASE));
const DECISIONS = new Set(Object.values(BUILDER2_CLASSIFICATION_DECISION));
const ORIGINS = new Set(Object.values(BUILDER2_TAXON_ORIGIN));
const PROTECTIONS = new Set(Object.values(BUILDER2_TAXON_PROTECTION));
const ENTRY_POLICIES = new Set(Object.values(BUILDER2_TAXON_ENTRY_POLICY));
export function clean(value){ return String(value ?? '').trim(); }
function cleanStrings(values=[]){ return [...new Set((values||[]).map(clean).filter(Boolean))]; }
function finiteUid(value){ const uid=Number(value); if(!Number.isFinite(uid)) throw new Error(`Builder 2 source UID must be numeric: ${String(value)}`); return uid; }
function clampConfidence(value){ if(value==null||value==='') return null; const n=Number(value); if(!Number.isFinite(n)) throw new Error(`Builder 2 confidence must be numeric: ${String(value)}`); return Math.max(0,Math.min(1,n)); }
function stable(value){ if(Array.isArray(value)) return value.map(stable); if(value&&typeof value==='object') return Object.keys(value).sort().reduce((o,k)=>(o[k]=stable(value[k]),o),{}); return value; }
export function builder2Fingerprint(value){ const text=typeof value==='string'?value:JSON.stringify(stable(value)); let h=0x811c9dc5; for(let i=0;i<text.length;i++){h^=text.charCodeAt(i);h=Math.imul(h,0x01000193)>>>0;} return `fnv1a32:${h.toString(16).padStart(8,'0')}:${text.length}`; }
export function createBuilder2Source(spec={}){
  const book=clean(spec.book); if(!book) throw new Error('Builder 2 source requires book.');
  const uid=finiteUid(spec.uid), fingerprint=clean(spec.fingerprint); if(!fingerprint) throw new Error(`Builder 2 source ${uid} requires fingerprint.`);
  const removed=spec.removed===true;
  return {contract:CONTRACT,sourceKey:clean(spec.sourceKey)||`${book}#${uid}`,book,uid,fingerprint,title:clean(spec.title)||`UID ${uid}`,keys:cleanStrings(spec.keys),content:String(spec.content??''),removed,disabled:spec.disabled===true||removed,removalReason:removed?clean(spec.removalReason||'removed-from-corpus'):''};
}
export function createBuilder2SourceRevision(sources=[]){
  const normalized=(sources||[]).map(createBuilder2Source).sort((a,b)=>a.book.localeCompare(b.book)||a.uid-b.uid||a.sourceKey.localeCompare(b.sourceKey));
  const keys=new Set(), bus=new Set();
  for(const row of normalized){ if(keys.has(row.sourceKey)) throw new Error(`Builder 2 source revision has duplicate source authority for ${row.sourceKey}.`); keys.add(row.sourceKey); const bu=`${row.book}#${row.uid}`; if(bus.has(bu)) throw new Error(`Builder 2 source revision has multiple authorities for ${bu}.`); bus.add(bu); }
  const projection=normalized.map(r=>({sourceKey:r.sourceKey,book:r.book,uid:r.uid,fingerprint:r.fingerprint,disabled:r.disabled,removed:r.removed===true}));
  return {contract:CONTRACT,revisionId:`corpus:${builder2Fingerprint(projection)}`,sourceCount:normalized.length,activeCount:normalized.filter(r=>!r.disabled&&!r.removed).length,removedCount:normalized.filter(r=>r.removed).length,sources:normalized};
}
export function createBuilder2TreeRevision(treeInventory=null){
  const nodes=Array.isArray(treeInventory?.nodes)?treeInventory.nodes:[]; if(!nodes.length) return null;
  const projection=nodes.map((r,i)=>({id:clean(r?.id)||`__missing_${i}`,label:clean(r?.label),path:Array.isArray(r?.path)?r.path.map(clean).filter(Boolean):[],summary:clean(r?.summary),uids:[...new Set([...(r?.uids||[]),...(r?.loreUids||[]),...(r?.entryUids||[])].map(Number).filter(Number.isFinite))].sort((a,b)=>a-b)})).sort((a,b)=>a.id.localeCompare(b.id)||JSON.stringify(a.path).localeCompare(JSON.stringify(b.path)));
  return {contract:CONTRACT,revisionId:`tree:${builder2Fingerprint(projection)}`,nodeCount:projection.length,projection};
}
export function createBuilder2Taxon(spec={}){
  const taxonId=clean(spec.taxonId); if(!taxonId) throw new Error('Builder 2 taxon requires taxonId.'); const label=clean(spec.label); if(!label) throw new Error(`Builder 2 taxon ${taxonId} requires label.`);
  const origin=clean(spec.origin||BUILDER2_TAXON_ORIGIN.BUILDER); if(!ORIGINS.has(origin)) throw new Error(`Builder 2 taxon ${taxonId} has invalid origin ${origin}.`);
  const protection=clean(spec.protection||BUILDER2_TAXON_PROTECTION.NORMAL); if(!PROTECTIONS.has(protection)) throw new Error(`Builder 2 taxon ${taxonId} has invalid protection ${protection}.`);
  const entryPolicy=clean(spec.entryPolicy||BUILDER2_TAXON_ENTRY_POLICY.ALLOW); if(!ENTRY_POLICIES.has(entryPolicy)) throw new Error(`Builder 2 taxon ${taxonId} has invalid entryPolicy ${entryPolicy}.`);
  return {contract:CONTRACT,taxonId,parentTaxonId:clean(spec.parentTaxonId)||null,label,purpose:clean(spec.purpose),aliases:cleanStrings(spec.aliases),evidenceSourceKeys:cleanStrings(spec.evidenceSourceKeys),origin,protection,entryPolicy,canonicalNodeId:clean(spec.canonicalNodeId)||null,metadata:structuredClone(spec.metadata||{})};
}
export function validateBuilder2Taxonomy(nodes=[]){
  const normalized=(nodes||[]).map(createBuilder2Taxon), errors=[],warnings=[],byId=new Map();
  for(const n of normalized){if(byId.has(n.taxonId)) errors.push(`Duplicate taxonId ${n.taxonId}.`);byId.set(n.taxonId,n);} for(const n of normalized){if(n.parentTaxonId&&!byId.has(n.parentTaxonId)) errors.push(`Taxon ${n.taxonId} references missing parent ${n.parentTaxonId}.`);}
  const sib=new Map(); for(const n of normalized){const k=`${n.parentTaxonId||'__ROOT__'}|${n.label.toLocaleLowerCase()}`; const a=sib.get(k)||[];a.push(n.taxonId);sib.set(k,a);} for(const [k,a] of sib){if(a.length>1) errors.push(`Duplicate sibling label ${k.split('|').slice(1).join('|')} for ${a.join(', ')}.`);}
  const state=new Map(); const visit=id=>{const s=state.get(id)||0;if(s===1){errors.push(`Taxonomy cycle detected at ${id}.`);return;}if(s===2)return;state.set(id,1);const p=byId.get(id)?.parentTaxonId;if(p&&byId.has(p))visit(p);state.set(id,2);}; for(const id of byId.keys())visit(id);
  const roots=normalized.filter(n=>!n.parentTaxonId).length;if(!roots&&normalized.length)errors.push('Builder 2 taxonomy has no root-level taxa.');if(roots>24)warnings.push(`Builder 2 taxonomy has ${roots} root-level taxa; review for over-fragmentation.`);
  return {contract:CONTRACT,passed:errors.length===0,errors:[...new Set(errors)],warnings,nodes:normalized};
}
export function createBuilder2TaxonomyRevision(spec={}){
  const sourceRevision=clean(spec.sourceRevision); if(!sourceRevision) throw new Error('Builder 2 taxonomy revision requires sourceRevision.');
  const corpusRevision=clean(spec.corpusRevision)||sourceRevision;
  const treeRevision=clean(spec.treeRevision)||null;
  const validation=validateBuilder2Taxonomy(spec.nodes||[]); if(!validation.passed) throw new Error(`Invalid Builder 2 taxonomy: ${validation.errors.join(' ')}`);
  const cp=validation.nodes.map(n=>({taxonId:n.taxonId,label:n.label,purpose:n.purpose,aliases:n.aliases,entryPolicy:n.entryPolicy}));
  const mp=validation.nodes.map(n=>({taxonId:n.taxonId,parentTaxonId:n.parentTaxonId,label:n.label,canonicalNodeId:n.canonicalNodeId}));
  const fp=validation.nodes.map(n=>({taxonId:n.taxonId,parentTaxonId:n.parentTaxonId,label:n.label,purpose:n.purpose,aliases:n.aliases,evidenceSourceKeys:n.evidenceSourceKeys,origin:n.origin,protection:n.protection,entryPolicy:n.entryPolicy,canonicalNodeId:n.canonicalNodeId}));
  const fence={sourceRevision,corpusRevision,treeRevision};
  return {contract:CONTRACT,revisionId:clean(spec.revisionId)||`taxonomy:${builder2Fingerprint({fence,nodes:fp})}`,classificationRevisionId:`taxonomy-classification:${builder2Fingerprint({fence,nodes:cp})}`,materializationRevisionId:`taxonomy-materialization:${builder2Fingerprint({fence,nodes:mp})}`,sourceRevision,corpusRevision,treeRevision,createdAt:Number.isFinite(Number(spec.createdAt))?Number(spec.createdAt):Date.now(),nodes:validation.nodes,warnings:validation.warnings,metadata:structuredClone(spec.metadata||{})};
}
export function createBuilder2Classification(spec={}){
  const sourceKey=clean(spec.sourceKey);if(!sourceKey)throw new Error('Builder 2 classification requires sourceKey.'); const taxonomyRevision=clean(spec.taxonomyRevision);if(!taxonomyRevision)throw new Error(`Builder 2 classification ${sourceKey} requires taxonomyRevision.`);
  const classificationRevision=clean(spec.classificationRevision)||taxonomyRevision, decision=clean(spec.decision); if(!DECISIONS.has(decision))throw new Error(`Builder 2 classification ${sourceKey} has invalid decision ${decision}.`);
  const candidates=(spec.candidates||[]).map(r=>({taxonId:clean(r?.taxonId),confidence:clampConfidence(r?.confidence)})).filter(r=>r.taxonId), taxonId=clean(spec.taxonId)||null;
  if(decision===BUILDER2_CLASSIFICATION_DECISION.CLASSIFIED&&!taxonId)throw new Error(`Builder 2 classified result ${sourceKey} requires taxonId.`); if(decision!==BUILDER2_CLASSIFICATION_DECISION.CLASSIFIED&&taxonId)throw new Error(`Builder 2 ${decision} result ${sourceKey} cannot claim authoritative taxonId.`); if(decision===BUILDER2_CLASSIFICATION_DECISION.AMBIGUOUS&&candidates.length<2)throw new Error(`Builder 2 ambiguous result ${sourceKey} requires at least two candidates.`);
  return {contract:CONTRACT,sourceKey,sourceFingerprint:clean(spec.sourceFingerprint),taxonomyRevision,classificationRevision,decision,taxonId,candidates,reason:clean(spec.reason),confidence:clampConfidence(spec.confidence),metadata:structuredClone(spec.metadata||{})};
}
export function createBuilder2Plan(spec={}){
  const phase=clean(spec.phase||BUILDER2_PHASE.INVENTORY);if(!PHASES.has(phase))throw new Error(`Invalid Builder 2 phase ${phase}.`);const book=clean(spec.book);if(!book)throw new Error('Builder 2 plan requires book.');
  return {contract:CONTRACT,runId:clean(spec.runId)||`builder2_${Date.now().toString(36)}`,planRevision:Number.isInteger(Number(spec.planRevision))&&Number(spec.planRevision)>=0?Number(spec.planRevision):0,book,mode:clean(spec.mode||'full'),phase,sourceRevision:clean(spec.sourceRevision),corpusRevision:clean(spec.corpusRevision)||clean(spec.sourceRevision),treeRevision:clean(spec.treeRevision)||null,taxonomyRevision:clean(spec.taxonomyRevision)||null,survey:structuredClone(spec.survey||{contributions:[],semanticMap:null}),taxonomy:structuredClone(spec.taxonomy||null),structuralBaselineTaxonomy:structuredClone(spec.structuralBaselineTaxonomy||null),structuralPlan:structuredClone(spec.structuralPlan||null),previewModel:structuredClone(spec.previewModel||null),taxonomyReview:structuredClone(spec.taxonomyReview||null),taxonomyPlanning:structuredClone(spec.taxonomyPlanning||null),classifications:(spec.classifications||[]).map(createBuilder2Classification),classificationReview:structuredClone(spec.classificationReview||null),classificationPlanning:structuredClone(spec.classificationPlanning||null),taxonomyGaps:structuredClone(spec.taxonomyGaps||[]),gapPlanning:structuredClone(spec.gapPlanning||null),proposedExpansions:structuredClone(spec.proposedExpansions||[]),reconciliation:structuredClone(spec.reconciliation||null),reconciliationPlanning:structuredClone(spec.reconciliationPlanning||null),qualityReview:structuredClone(spec.qualityReview||null),candidateTree:structuredClone(spec.candidateTree||null),validation:structuredClone(spec.validation||null),createdAt:Number.isFinite(Number(spec.createdAt))?Number(spec.createdAt):Date.now(),updatedAt:Number.isFinite(Number(spec.updatedAt))?Number(spec.updatedAt):Date.now(),metadata:structuredClone(spec.metadata||{})};
}
