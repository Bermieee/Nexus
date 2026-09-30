import { authorityDescriptor, deepFreeze, clone } from './wave6-contracts.js';

export const ForensicStage=Object.freeze({
  SOURCE:'SOURCE',OBSERVATION:'OBSERVATION',COGNITION:'COGNITION',TRUTH:'TRUTH',PROPOSAL:'PROPOSAL',
  SETTLEMENT:'SETTLEMENT',GATHER:'GATHER',CONTEXT:'CONTEXT',GENERATION:'GENERATION',REFERENCE:'REFERENCE',UNKNOWN:'UNKNOWN',
});
const TYPE_STAGE=Object.freeze({
  SOURCE_REVISION_ADMITTED:ForensicStage.SOURCE,
  PROPOSAL_CREATED:ForensicStage.PROPOSAL,PROPOSAL_VALIDATED:ForensicStage.PROPOSAL,PROPOSAL_REJECTED:ForensicStage.PROPOSAL,
  SETTLEMENT_ACCEPTED:ForensicStage.SETTLEMENT,SETTLEMENT_REJECTED:ForensicStage.SETTLEMENT,SETTLEMENT_UNRESOLVED:ForensicStage.SETTLEMENT,STATE_SUPERSEDED:ForensicStage.SETTLEMENT,STATE_CONTRADICTED:ForensicStage.SETTLEMENT,
  HYPOTHESIS_OPENED:ForensicStage.COGNITION,HYPOTHESIS_RESOLVED:ForensicStage.COGNITION,REFLECTION_CREATED:ForensicStage.COGNITION,REFLECTION_REVISED:ForensicStage.COGNITION,RETRIEVAL_COMPLETED:ForensicStage.COGNITION,RETRIEVAL_SKIPPED:ForensicStage.COGNITION,
  OPERATOR_OVERRIDE:ForensicStage.SETTLEMENT,CONTEXT_SECTION_COMPILED:ForensicStage.CONTEXT,CONTEXT_SEALED:ForensicStage.CONTEXT,CONTEXT_DELIVERY_PLANNED:ForensicStage.CONTEXT,
  ARTIFACT_INVALIDATED:ForensicStage.COGNITION,RECONSOLIDATION_APPLIED:ForensicStage.COGNITION,RESULT_ROUTED:ForensicStage.GATHER,
  RESULT_STALE:ForensicStage.COGNITION,RESULT_LATE:ForensicStage.COGNITION,
});
const STALE=new Set(['RESULT_STALE','STALE']),LATE=new Set(['RESULT_LATE','LATE']),REJECTED=new Set(['PROPOSAL_REJECTED','SETTLEMENT_REJECTED','GATHER_REJECTED']);
const text=(v)=>String(v??'').trim();

export function normalizeForensicReadModel(model){
  if(!model?.bundleId)return null;
  return deepFreeze({
    kind:'NormalizedForensicReadModel',sourceKind:model.kind??'ForensicReadModel',bundleId:model.bundleId,turnId:model.turnId??null,generationId:model.generationId??null,
    worldRevision:model.worldRevision??null,sceneRevision:model.sceneRevision??null,sourceRevisionRefs:[...(model.sourceRevisionRefs??[])],turnEventRef:model.turnEventRef??null,
    runtimeWorkRefs:[...(model.runtimeWorkRefs??[])],workerResultRefs:[...(model.workerResultRefs??[])],truthDecisionRefs:[...(model.truthDecisionRefs??[])],
    precisionRefs:[...(model.precisionRefs??[])],gatherRef:model.gatherRef??null,transactionRefs:[...(model.transactionRefs??[])],settlementRefs:[...(model.settlementRefs??[])],
    contextSealRef:model.contextSealRef??null,promptPlanRef:model.promptPlanRef??null,lateResultRefs:[...(model.lateResultRefs??[])],staleResultRefs:[...(model.staleResultRefs??[])],
    diagnosticRefs:[...(model.diagnosticRefs??[])],diagnosticReasons:clone(model.diagnosticReasons??[]),assemblyProvenanceRefs:[...(model.assemblyProvenanceRefs??[])],
    complete:Boolean(model.complete),health:clone(model.health??null),authority:model.authority??'READ_ONLY',mutationAuthority:false,
  });
}

export function normalizeCognitiveTransaction(row){
  if(!row)return null;const type=row.transactionType??row.type??'UNKNOWN',authority=authorityFrom(row.authorityContext);
  return deepFreeze({
    kind:'ForensicTimelineItem',id:row.transactionId??row.id??`tx:${row.sequence??'unknown'}`,sequence:Number(row.sequence??0),timestamp:row.timestamp??null,
    eventType:type,stage:TYPE_STAGE[type]??ForensicStage.UNKNOWN,subsystem:row.subsystem??null,owner:row.owner??null,turnId:row.turnId??null,generationId:row.generationId??null,
    taskId:row.taskId??null,correlationId:row.correlationId??null,causationId:row.causationId??null,beforeRevision:row.beforeRevision??null,afterRevision:row.afterRevision??null,
    sourceRevisionRefs:[...(row.sourceRevisionIds??[])],affectedArtifactIds:[...(row.affectedArtifactIds??[])],authority,decision:clone(row.decision??null),outcome:clone(row.outcome??null),
    receiptRefs:[...(row.receiptRefs??[])],reasonCode:row.reasonCode??null,provenance:clone(row.provenance??{}),retentionClass:row.retentionClass??null,
    status:statusFor(type,row),impact:impactFor(type,row),referenceOnly:false,rawPayloadAvailable:row.retentionClass==='LARGE_DEBUG_PAYLOAD'||row.retentionClass==='SENSITIVE_PAYLOAD'||Boolean(row.metadata?.payloadRef),
  });
}

export function buildForensicTimeline({forensic,transactions=[]}={}){
  const f=normalizeForensicReadModel(forensic);if(!f)return deepFreeze({kind:'ForensicTimeline',available:false,rows:[],runtimeWorkRefs:[],missingStages:[],health:'UNAVAILABLE'});
  const tx=transactions.map(normalizeCognitiveTransaction).filter(Boolean).sort((a,b)=>a.sequence-b.sequence||Number(a.timestamp??0)-Number(b.timestamp??0));
  const rows=[...tx],knownReceipts=new Set(tx.flatMap(x=>x.receiptRefs));
  addReference(rows,f.turnEventRef,ForensicStage.SOURCE,'TURN_EVENT','Recorded turn event reference.',knownReceipts);
  for(const ref of f.workerResultRefs)addReference(rows,ref,ForensicStage.COGNITION,'WORKER_RESULT','Worker result reference.',knownReceipts);
  for(const ref of f.truthDecisionRefs)addReference(rows,ref,ForensicStage.TRUTH,'TRUTH_DECISION','Truth decision reference.',knownReceipts);
  for(const ref of f.precisionRefs)addReference(rows,ref,ForensicStage.TRUTH,'PRECISION_RESULT','Precision result reference.',knownReceipts);
  addReference(rows,f.gatherRef,ForensicStage.GATHER,'GATHER','Gather decision reference.',knownReceipts);
  for(const ref of f.settlementRefs)addReference(rows,ref,ForensicStage.SETTLEMENT,'SETTLEMENT','Settlement reference.',knownReceipts);
  addReference(rows,f.contextSealRef,ForensicStage.CONTEXT,'CONTEXT_SEAL','Context Seal reference.',knownReceipts);
  addReference(rows,f.promptPlanRef,ForensicStage.CONTEXT,'PROMPT_PLAN','PromptPlan reference.',knownReceipts);
  for(const ref of f.staleResultRefs)addReference(rows,ref,ForensicStage.COGNITION,'RESULT_STALE','Stale result was contained.',knownReceipts,'STALE');
  for(const ref of f.lateResultRefs)addReference(rows,ref,ForensicStage.COGNITION,'RESULT_LATE','Late result completed after the relevant publication boundary.',knownReceipts,'LATE');
  rows.sort((a,b)=>Number(a.sequence??Number.MAX_SAFE_INTEGER)-Number(b.sequence??Number.MAX_SAFE_INTEGER)||String(a.id).localeCompare(String(b.id)));
  return deepFreeze({
    kind:'ForensicTimeline',available:true,bundleId:f.bundleId,turnId:f.turnId,generationId:f.generationId,worldRevision:f.worldRevision,sceneRevision:f.sceneRevision,
    rows,runtimeWorkRefs:[...f.runtimeWorkRefs],sourceRevisionRefs:[...f.sourceRevisionRefs],complete:f.complete,health:f.health?.state??(f.complete?'READY':'DEGRADED'),
    diagnosticReasons:clone(f.diagnosticReasons),missingStages:missingStageNames(rows),authority:'READ_ONLY',mutationAuthority:false,
  });
}

export function buildForensicPath(timeline){
  const rows=timeline?.rows??[];
  const specs=[
    ['source','Source',row=>row.eventType==='SOURCE_REVISION_ADMITTED'||row.stage===ForensicStage.SOURCE],
    ['proposal','Proposal',row=>row.eventType==='PROPOSAL_CREATED'],
    ['validation','Validation',row=>row.eventType==='PROPOSAL_VALIDATED'],
    ['settlement','Owner Settlement',row=>row.eventType==='SETTLEMENT_UNRESOLVED'||row.eventType==='SETTLEMENT_ACCEPTED'||row.eventType==='SETTLEMENT_REJECTED'||row.eventType==='STATE_CONTRADICTED'],
    ['change','State / Reflection',row=>['REFLECTION_CREATED','REFLECTION_REVISED','STATE_SUPERSEDED','STATE_CONTRADICTED'].includes(row.eventType)],
    ['retrieval','Retrieval',row=>row.eventType==='RETRIEVAL_COMPLETED'||row.eventType==='RETRIEVAL_SKIPPED'||row.eventType.includes('RETRIEVAL')],
    ['compiled','Compiled Context',row=>row.eventType==='CONTEXT_SECTION_COMPILED'],
    ['seal','Context Seal',row=>row.eventType==='CONTEXT_SEALED'],
  ];
  const steps=specs.map(([key,label,match])=>{
    const row=rows.find(match)??null;
    if(!row)return deepFreeze({kind:'ForensicPathStep',key,label,status:'MISSING',recorded:false,referenceOnly:false,id:null,sequence:null,authority:authorityDescriptor('UNRESOLVED'),impact:`No recorded ${label.toLowerCase()} step is available for this generation; the UI did not infer one.`});
    return deepFreeze({kind:'ForensicPathStep',key,label,status:row.status??'RECORDED',recorded:!row.referenceOnly,referenceOnly:Boolean(row.referenceOnly),id:row.id,sequence:row.sequence,authority:row.authority??authorityDescriptor('UNRESOLVED'),impact:row.impact,eventType:row.eventType});
  });
  const seal=rows.find(row=>row.eventType==='CONTEXT_SEALED')??null;
  const lateAfterSeal=rows.filter(row=>row.status==='LATE'&&(seal==null||Number(row.sequence??Number.MAX_SAFE_INTEGER)>Number(seal.sequence??-1))).map(row=>row.id);
  return deepFreeze({kind:'ForensicPath',available:Boolean(timeline?.available),steps,lateAfterSeal,complete:steps.every(x=>x.status!=='MISSING'),generationId:timeline?.generationId??null,turnId:timeline?.turnId??null});
}

export function unresolvedConflictModel(contextReceipt){
  const rows=contextReceipt?.unresolvedEvidence??[];
  return deepFreeze(rows.map((row,index)=>({
    kind:'UnresolvedConflict',id:row.artifactId??`unresolved:${index}`,subjectId:row.subjectId??null,predicate:row.predicate??null,
    currentValue:clone(row.value??null),authority:row.authority??'UNRESOLVED',status:row.status??'UNRESOLVED',provenanceRefs:[...(row.provenanceRefs??[])],
    alternatives:clone(row.alternatives??row.competingEvidence??[]),reason:row.reason??row.explanation??null,settlement:'UNRESOLVED',
  })));
}

export class ForensicMetadataIndex{
  constructor(rows=[]){this.rows=[];this.setRows(rows);}
  setRows(rows=[]){
    this.rows=rows.map((row,index)=>({row,index,haystack:indexText(row),authority:row.authority?.authority??row.authority??null,eventType:row.eventType??null,stage:row.stage??null,subsystem:row.subsystem??null,status:row.status??null,generationId:row.generationId??null,turnId:row.turnId??null,sourceRefs:row.sourceRevisionRefs??[],claimRefs:row.affectedArtifactIds??[]}));
    return this;
  }
  query(filters={}){
    const q=text(filters.search).toLowerCase(),authority=setFilter(filters.authority),types=setFilter(filters.eventType),subsystems=setFilter(filters.subsystem),statuses=setFilter(filters.status),sources=setFilter(filters.source),claims=setFilter(filters.claim);
    return this.rows.filter(x=>{
      if(q&&!x.haystack.includes(q))return false;
      if(authority.size&&!authority.has(x.authority))return false;if(types.size&&!types.has(x.eventType))return false;if(subsystems.size&&!subsystems.has(x.subsystem))return false;if(statuses.size&&!statuses.has(x.status))return false;
      if(filters.generationId&&x.generationId!==filters.generationId)return false;if(filters.turnId&&x.turnId!==filters.turnId)return false;
      if(sources.size&&![...sources].some(v=>x.sourceRefs.includes(v)))return false;if(claims.size&&![...claims].some(v=>x.claimRefs.includes(v)))return false;
      return true;
    }).map(x=>x.row);
  }
}

export class LazyForensicDetailCache{
  constructor({loader=null,maxEntries=32}={}){this.loader=typeof loader==='function'?loader:null;this.maxEntries=Math.max(1,Number(maxEntries)||32);this.cache=new Map();this.pending=new Map();this.destroyed=false;}
  async load(ref){
    if(this.destroyed)throw new Error('LazyForensicDetailCache is destroyed');if(!ref)return null;
    const key=typeof ref==='string'?ref:ref.refId??ref.id??JSON.stringify(ref);if(this.cache.has(key)){const v=this.cache.get(key);this.cache.delete(key);this.cache.set(key,v);return clone(v);}
    if(this.pending.has(key))return clone(await this.pending.get(key));if(!this.loader)return null;
    const promise=Promise.resolve(this.loader(ref)).then(value=>{this.pending.delete(key);if(value!=null){this.cache.set(key,clone(value));while(this.cache.size>this.maxEntries)this.cache.delete(this.cache.keys().next().value);}return value;},error=>{this.pending.delete(key);throw error;});
    this.pending.set(key,promise);return clone(await promise);
  }
  clear(){this.cache.clear();this.pending.clear();}
  destroy(){this.destroyed=true;this.clear();}
  get size(){return this.cache.size;}
  get pendingCount(){return this.pending.size;}
}

export function forensicWhy(item){
  if(!item)return deepFreeze({kind:'ForensicWhy',available:false,summary:'No forensic item selected.'});
  const facts=[];
  if(item.reasonCode)facts.push(`Recorded reason: ${item.reasonCode}.`);
  if(item.sourceRevisionRefs?.length)facts.push(`Source revisions: ${item.sourceRevisionRefs.join(', ')}.`);
  if(item.beforeRevision!=null||item.afterRevision!=null)facts.push(`Revision: ${item.beforeRevision??'—'} → ${item.afterRevision??'—'}.`);
  if(item.status==='STALE')facts.push('The result was stale and excluded from current publication.');
  if(item.status==='LATE')facts.push('The result arrived after the applicable publication boundary and did not alter that sealed generation.');
  if(item.status==='REJECTED')facts.push('The owning subsystem recorded this item as rejected.');
  return deepFreeze({kind:'ForensicWhy',available:facts.length>0,summary:facts.join(' ')||'The backend did not publish a reason for this item.',facts,authority:item.authority??authorityDescriptor('UNRESOLVED')});
}

function addReference(rows,ref,stage,eventType,impact,known,status='REFERENCE'){
  if(!ref||known.has(ref)||rows.some(x=>x.id===ref))return;
  rows.push(deepFreeze({kind:'ForensicTimelineItem',id:ref,sequence:Number.MAX_SAFE_INTEGER,timestamp:null,eventType,stage,subsystem:null,owner:null,turnId:null,generationId:null,taskId:null,correlationId:null,causationId:null,beforeRevision:null,afterRevision:null,sourceRevisionRefs:[],affectedArtifactIds:[],authority:authorityDescriptor('UNRESOLVED'),decision:null,outcome:null,receiptRefs:[ref],reasonCode:null,provenance:{},retentionClass:null,status,impact,referenceOnly:true,rawPayloadAvailable:false}));
}
function statusFor(type,row){if(STALE.has(type))return'STALE';if(LATE.has(type))return'LATE';if(REJECTED.has(type))return'REJECTED';if(type==='STATE_CONTRADICTED'||type==='SETTLEMENT_UNRESOLVED')return'UNRESOLVED';if(type==='RETRIEVAL_SKIPPED')return'SKIPPED';if(type==='CONTEXT_SEALED'||type==='CONTEXT_DELIVERY_PLANNED'||type==='SETTLEMENT_ACCEPTED')return'ACCEPTED';return row.outcome?.status??row.decision?.status??'RECORDED';}
function impactFor(type,row){
  if(type==='RESULT_STALE')return'Result was contained as stale and did not participate in current publication.';
  if(type==='RESULT_LATE')return'Result completed late; historical record is preserved without retroactively changing sealed context.';
  if(type==='PROPOSAL_REJECTED'||type==='SETTLEMENT_REJECTED')return'The proposal/settlement was rejected by the owning authority.';
  if(type==='STATE_CONTRADICTED'||type==='SETTLEMENT_UNRESOLVED')return'Owner Settlement preserved competing evidence as UNRESOLVED rather than choosing a claim.';
  if(type==='RETRIEVAL_COMPLETED')return'Retrieval supplied evidence to the generation context path.';
  if(type==='RETRIEVAL_SKIPPED')return'Retrieval was intentionally skipped; no retrieval result is implied.';
  if(type==='CONTEXT_SECTION_COMPILED')return'Recorded evidence was compiled into a context section without changing its authority.';
  if(type==='CONTEXT_SEALED')return'Generation context crossed the immutable publication boundary.';
  if(type==='CONTEXT_DELIVERY_PLANNED')return'Prompt delivery was planned for a specific generation.';
  return row.outcome?.summary??row.decision?.summary??row.reasonCode??'Recorded cognitive transaction.';
}
function authorityFrom(value){
  if(value==null)return authorityDescriptor('UNRESOLVED');if(typeof value==='string')return authorityDescriptor(value);
  return authorityDescriptor(value.authorityClass??value.authority??value.status??'UNRESOLVED');
}
function missingStageNames(rows){const have=new Set(rows.map(x=>x.stage)),order=[ForensicStage.SOURCE,ForensicStage.COGNITION,ForensicStage.TRUTH,ForensicStage.PROPOSAL,ForensicStage.SETTLEMENT,ForensicStage.GATHER,ForensicStage.CONTEXT];return order.filter(x=>!have.has(x));}
function indexText(row){return [row.id,row.eventType,row.stage,row.subsystem,row.status,row.reasonCode,row.turnId,row.generationId,row.taskId,row.correlationId,row.impact,row.outcome?.summary,row.decision?.summary,...(row.sourceRevisionRefs??[]),...(row.affectedArtifactIds??[])].filter(Boolean).join(' ').toLowerCase().replace(/[_:\-]+/g,' ');}
function setFilter(value){return new Set(value==null?[]:Array.isArray(value)?value:[value]);}
