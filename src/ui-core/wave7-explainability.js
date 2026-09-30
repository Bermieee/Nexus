import { ProductDataMode, Wave6Health, createProductSourceStatus, deepFreeze, clone, normalizeWave6Health } from './wave6-contracts.js';

export const ContextSectionState=Object.freeze({
  REUSED:'REUSED',UPDATED:'UPDATED',REBUILT:'REBUILT',NEW:'NEW',DROPPED:'DROPPED',DEFERRED:'DEFERRED',INVALIDATED:'INVALIDATED',INCLUDED:'INCLUDED',UNAVAILABLE:'UNAVAILABLE',NO_EVIDENCE:'NO_EVIDENCE',
});
export const ExplainabilityView=Object.freeze({WHY:'WHY',CONTEXT:'CONTEXT',DIFF:'DIFF',SEAL:'SEAL',FORENSICS:'FORENSICS',ADVANCED:'ADVANCED'});
const STATES=new Set(Object.values(ContextSectionState));
const cloneSafe=(v)=>v==null?v:clone(v);

export function normalizePromptPlanReadModel(model){
  if(!model?.promptPlanId)return null;
  if(model.kind==='PromptPlanReadModel'){
    const slots=new Map();
    for(const row of model.slotAllocation??[])slots.set(row.slot,{slot:row.slot,representation:row.representation??null,estimatedTokens:row.estimatedTokens??null,required:Boolean(row.required),protected:Boolean(row.protected)});
    const reuseBySlot=new Map();
    for(const row of model.reuseDecisions??[])if(row?.slot)reuseBySlot.set(row.slot,row);
    for(const row of model.reusedSegments??[])if(row?.slot&&!reuseBySlot.has(row.slot))reuseBySlot.set(row.slot,{slot:row.slot,state:row.reuseState,segmentId:row.segmentId,cacheEligible:row.cacheEligible});
    for(const row of model.rebuiltSegments??[])if(row?.slot&&!reuseBySlot.has(row.slot))reuseBySlot.set(row.slot,{slot:row.slot,state:row.reuseState??'REBUILD',segmentId:row.segmentId,cacheEligible:row.cacheEligible});
    const dropped=new Map((model.dropped??[]).map(x=>[x.slot??x.segmentKey??x.id,{...x}]));
    const deferred=new Map((model.deferred??[]).map(x=>[x.slot??x.segmentKey??x.id,{...x}]));
    const sectionOrder=model.sectionOrder?.length?[...model.sectionOrder]:[...slots.keys()];
    const sections=[];
    for(const slot of new Set([...sectionOrder,...slots.keys(),...reuseBySlot.keys(),...dropped.keys(),...deferred.keys()])){
      const alloc=slots.get(slot)??{},reuse=reuseBySlot.get(slot)??null,drop=dropped.get(slot)??null,defer=deferred.get(slot)??null;
      const state=drop?ContextSectionState.DROPPED:defer?ContextSectionState.DEFERRED:mapReuseState(reuse?.state??reuse?.reuseState,Boolean(alloc.slot));
      sections.push(deepFreeze({
        kind:'GenerationContextSection',slot,state,priority:reuse?.priority??drop?.priority??defer?.priority??null,
        estimatedTokens:alloc.estimatedTokens??null,actualTokens:null,sourceSubsystem:reuse?.sourceSubsystem??null,
        authority:reuse?.authorityClass??null,revisionIdentity:cloneSafe(reuse?.revisionIdentity??reuse?.sourceRevisionIds??null),
        reuseState:reuse?.state??reuse?.reuseState??null,cacheEligible:reuse?.cacheEligible??null,representation:alloc.representation??null,
        required:Boolean(alloc.required),protected:Boolean(alloc.protected),reason:ownerReason(drop??defer??reuse),
        included:!drop&&!defer,rawRef:cloneSafe({allocation:alloc,reuse,drop,defer}),
      }));
    }
    return deepFreeze({
      kind:'NormalizedPromptPlan',sourceKind:model.kind,promptPlanId:model.promptPlanId,generationId:model.generationId??null,turnId:model.turnId??null,
      contextSealId:model.contextSealId??null,sealedPacketHash:model.sealedPacketHash??null,modelProfileId:model.modelProfileId??null,
      modelProfileRevision:model.modelProfileRevision??null,deliveryPolicyRevision:model.deliveryPolicyRevision??null,
      worldRevision:model.worldRevision??null,sceneRevision:model.sceneRevision??null,sourceRevisionRefs:[...(model.sourceRevisionRefs??[])],
      sections,sectionOrder,budget:cloneSafe(model.budget??{}),estimatedTokens:model.estimatedTokens??null,
      integrityStatus:model.integrityStatus??null,fallbackDecisions:cloneSafe(model.fallbackDecisions??[]),
      dropped:cloneSafe(model.dropped??[]),deferred:cloneSafe(model.deferred??[]),health:cloneSafe(model.health??null),
      previousPromptPlanId:model.previousPromptPlanId??null,authority:model.authority??'READ_ONLY',mutationAuthority:false,
    });
  }
  // Wave 6 compatibility for raw PromptPlan; kept only so accepted callers do not break.
  const sections=(model.sections??[]).map(section=>{
    const reuse=(model.reuseDecisions??[]).find(x=>x.slot===section.slot)||(model.segments??[]).find(x=>(x.slot??x.segmentKey)===section.slot)||null;
    return deepFreeze({kind:'GenerationContextSection',slot:section.slot??section.segmentKey??'UNKNOWN',state:mapReuseState(reuse?.state??reuse?.reuseState??section.reuseState,true),
      priority:section.priority??reuse?.priority??null,estimatedTokens:section.estimatedTokens??section.tokenEstimate??section.allocatedTokens??null,actualTokens:section.actualTokens??null,
      sourceSubsystem:section.sourceSubsystem??null,authority:section.authorityClass??null,revisionIdentity:cloneSafe(section.sourceRevisionIds??null),
      reuseState:reuse?.state??reuse?.reuseState??section.reuseState??null,cacheEligible:reuse?.cacheEligible??section.cacheEligible??null,representation:section.representation??null,
      required:Boolean(section.required),protected:Boolean(section.protected),reason:ownerReason(section)??ownerReason(reuse),included:true,rawRef:null});
  });
  for(const row of model.dropped??[])sections.push(sectionFromDisposition(row,ContextSectionState.DROPPED));
  for(const row of model.deferred??[])sections.push(sectionFromDisposition(row,ContextSectionState.DEFERRED));
  return deepFreeze({kind:'NormalizedPromptPlan',sourceKind:model.kind??'PromptPlan',promptPlanId:model.promptPlanId,generationId:model.generationId??null,turnId:model.turnId??null,contextSealId:model.contextSealId??null,sealedPacketHash:model.sealedPacketHash??null,modelProfileId:model.modelProfileId??null,modelProfileRevision:model.modelProfileRevision??null,deliveryPolicyRevision:model.deliveryPolicyRevision??null,worldRevision:model.worldRevision??null,sceneRevision:model.sceneRevision??null,sourceRevisionRefs:[...(model.sourceRevisionDependencies??[])],sections,sectionOrder:[...(model.ordering??[])],budget:cloneSafe(model.budget??{}),estimatedTokens:model.budget?.estimatedTokens??model.budget?.usedTokens??model.budget?.allocated??null,integrityStatus:model.status??null,fallbackDecisions:cloneSafe(model.fallbackDecisions??[]),dropped:cloneSafe(model.dropped??[]),deferred:cloneSafe(model.deferred??[]),health:null,previousPromptPlanId:model.previousPromptPlanId??null,authority:'READ_ONLY',mutationAuthority:false});
}

export function normalizeContextReceiptReadModel(model){
  if(!model)return null;
  if(model.kind==='ContextReceiptReadModel')return deepFreeze({
    kind:'NormalizedContextReceipt',sourceKind:model.kind,turnId:model.turnId,generationId:model.generationId,contextSealId:model.contextSealId,promptPlanId:model.promptPlanId,
    packetId:model.packetId,packetHash:model.packetHash,modelProfileId:model.modelProfileId,worldRevision:model.worldRevision,sceneRevision:model.sceneRevision,
    sourceRevisionRefs:[...(model.sourceRevisionRefs??[])],includedSections:[...(model.includedSections??[])],omittedSections:cloneSafe(model.omittedSections??[]),
    deferredSections:cloneSafe(model.deferredSections??[]),unresolvedEvidence:cloneSafe(model.unresolvedEvidence??[]),reusedSegments:cloneSafe(model.reusedSegments??[]),
    rebuiltSegments:cloneSafe(model.rebuiltSegments??[]),budget:cloneSafe(model.budget??{}),estimatedTokens:model.estimatedTokens??null,fallbackState:model.fallbackState??null,
    provenanceRefs:[...(model.provenanceRefs??[])],health:cloneSafe(model.health??null),contextSealValid:model.contextSealValid??null,authority:model.authority??'READ_ONLY',mutationAuthority:false,
  });
  return deepFreeze({kind:'NormalizedContextReceipt',sourceKind:model.kind??'ContextReceipt',turnId:model.turnId??null,generationId:model.generationId??null,contextSealId:model.contextSealId??model.sealId??null,promptPlanId:model.promptPlanId??null,packetId:model.packetId??null,packetHash:model.packetHash??null,modelProfileId:model.modelProfileId??null,worldRevision:model.worldRevision??null,sceneRevision:model.sceneRevision??null,sourceRevisionRefs:[...(model.sourceRevisionRefs??[])],includedSections:[...(model.includedSections??model.primarySections??[])],omittedSections:cloneSafe(model.omittedSections??model.requiredOmissions??[]),deferredSections:cloneSafe(model.deferredSections??[]),unresolvedEvidence:cloneSafe(model.unresolvedEvidence??[]),reusedSegments:cloneSafe(model.reusedSegments??[]),rebuiltSegments:cloneSafe(model.rebuiltSegments??[]),budget:cloneSafe(model.budget??{}),estimatedTokens:model.estimatedTokens??model.finalContextSize??null,fallbackState:model.fallbackState??null,provenanceRefs:[...(model.provenanceRefs??[])],health:cloneSafe(model.health??null),contextSealValid:model.contextSealValid??null,authority:'READ_ONLY',mutationAuthority:false});
}

export function normalizeContextSealReceipt(seal,forensic=null){
  if(!seal)return null;
  const late=[...(forensic?.lateResultRefs??seal.lateResultIds??[])];
  return deepFreeze({
    kind:'NormalizedContextSeal',sealId:seal.id??seal.contextSealId??null,turnId:seal.turnId??null,correlationId:seal.correlationId??null,packetId:seal.packetId??null,
    packetHash:seal.packetHash??null,sourceRevisionRefs:[...(seal.sourceRevisionIds??seal.sourceRevisionRefs??[])],worldRevision:seal.worldRevision??null,sceneRevision:seal.sceneRevision??null,
    admittedResultIds:[...(seal.admittedResultIds??[])],rejectedResultIds:[...(seal.rejectedResultIds??[])],staleResultIds:[...(seal.staleResultIds??[])],
    lateResultIds:late,fallbackState:seal.fallbackState??'NONE',deadline:cloneSafe(seal.deadline??null),sequence:seal.sequence??null,sealedAt:seal.sealedAt??null,
    dependencies:[...(seal.dependencies??[])],sealedState:seal.sealedState!==false,integrityState:seal.sealedState===false?'FAILED':'SEALED',
  });
}

export function buildGenerationExplainability({promptPlan,contextReceipt=null,sealReceipt=null,hostDeliveryReceipt=null,forensic=null}={}){
  const plan=normalizePromptPlanReadModel(promptPlan);if(!plan)return null;
  const receipt=normalizeContextReceiptReadModel(contextReceipt),seal=normalizeContextSealReceipt(sealReceipt,forensic);
  const host=normalizeHostDeliveryEvidence(hostDeliveryReceipt);
  const sections=mergeSectionEvidence(plan.sections,receipt,host);
  const counts=countSectionStates(sections);
  const reasons=sections.filter(x=>x.reason).map(x=>({slot:x.slot,state:x.state,plannedState:x.plannedState,compiledState:x.compiledState,observedState:x.observedState,reason:x.reason}));
  const unavailableReasonCount=sections.filter(x=>!x.reason).length;
  const health=normalizeWave6Health(plan.health?.state??plan.integrityStatus??'READY',{fallback:Wave6Health.READY});
  const degraded=[Wave6Health.DEGRADED,Wave6Health.STALE,Wave6Health.BLOCKED].includes(health)||Boolean(seal&&seal.fallbackState!=='NONE');
  const fixture=promptPlan?.fixture===true||promptPlan?.dataMode===ProductDataMode.FIXTURE||promptPlan?.dataMode==='FIXTURE';
  const displayHealth=degraded&&health===Wave6Health.READY?Wave6Health.DEGRADED:health;
  const mode=fixture?ProductDataMode.FIXTURE:degraded?ProductDataMode.DEGRADED:ProductDataMode.LIVE;
  const impact=degraded?'Context was delivered with omissions, deferrals, fallback, stale evidence, or degraded integrity.':health===Wave6Health.WORKING?'Context delivery is still being assembled.':'Context delivery is explainable and healthy.';
  const source=createProductSourceStatus({mode,health:displayHealth,label:'Generation Explainability',impact,producer:'PromptPlanReadModel/ContextReceiptReadModel',revision:plan.promptPlanId});
  const deliveryEvidence=deepFreeze({
    planned:{state:'PLANNED',receiptRef:plan.promptPlanId,reason:null},
    compiled:receipt?{state:(seal?.sealedState!==false&&(seal||receipt.contextSealId))?'COMPILED_AND_SEALED':'COMPILED',receiptRef:receipt.packetId??receipt.contextSealId??receipt.promptPlanId??null,reason:null}:{state:'NO_EVIDENCE',receiptRef:null,reason:'CONTEXT_RECEIPT_NOT_PUBLISHED'},
    observed:host,
  });
  const budgetEvidence=deepFreeze({planned:budgetRecord(plan.budget,plan.estimatedTokens),compiled:receipt?budgetRecord(receipt.budget,receipt.estimatedTokens):budgetRecord(null,null)});
  return deepFreeze({
    kind:'GenerationExplainability',generationId:plan.generationId,turnId:plan.turnId,contextSealId:plan.contextSealId??receipt?.contextSealId??seal?.sealId??null,promptPlanId:plan.promptPlanId,
    modelProfileId:plan.modelProfileId,budget:plan.budget,budgetEvidence,deliveryEvidence,plannedTokens:plan.estimatedTokens,usedOrEstimatedTokens:receipt?.estimatedTokens??plan.estimatedTokens,
    worldRevision:plan.worldRevision,sceneRevision:plan.sceneRevision,sourceRevisionRefs:plan.sourceRevisionRefs,sections,sectionCounts:counts,
    dropped:plan.dropped,deferred:plan.deferred,reasons,unavailableReasonCount,integrityState:plan.integrityStatus??receipt?.health?.state??'UNAVAILABLE',
    fallbackState:receipt?.fallbackState??seal?.fallbackState??(plan.fallbackDecisions?.length?'RECORDED':'NONE'),receipt,seal,forensic:cloneSafe(forensic),
    unresolvedEvidence:cloneSafe(receipt?.unresolvedEvidence??[]),source,authority:'READ_ONLY',mutationAuthority:false,
  });
}

export function explainContextSection(section){
  if(!section)return null;
  return deepFreeze({
    kind:'ContextSectionExplanation',slot:section.slot,state:STATES.has(section.state)?section.state:ContextSectionState.UNAVAILABLE,
    plannedState:STATES.has(section.plannedState)?section.plannedState:ContextSectionState.NO_EVIDENCE,
    compiledState:STATES.has(section.compiledState)?section.compiledState:ContextSectionState.NO_EVIDENCE,
    observedState:STATES.has(section.observedState)?section.observedState:ContextSectionState.NO_EVIDENCE,
    evidence:cloneSafe(section.evidence??null),
    reason:section.reason??null,reasonAvailable:Boolean(section.reason),priority:section.priority??null,estimatedTokens:section.estimatedTokens??null,actualTokens:section.actualTokens??null,
    sourceSubsystem:section.sourceSubsystem??null,authority:section.authority??null,revisionIdentity:cloneSafe(section.revisionIdentity),reuseState:section.reuseState??null,
    cacheEligible:section.cacheEligible??null,representation:section.representation??null,required:Boolean(section.required),protected:Boolean(section.protected),
    impact:sectionImpact(section),
  });
}

export function diffGenerationContext(previous,current){
  if(!previous||!current)return deepFreeze({kind:'GenerationContextDiff',available:false,reason:'Both adjacent generation read models are required.',fromGenerationId:previous?.generationId??null,toGenerationId:current?.generationId??null,groups:{}});
  const a=new Map(previous.sections.map(x=>[x.slot,x])),b=new Map(current.sections.map(x=>[x.slot,x]));const groups={UNCHANGED:[],UPDATED:[],REBUILT:[],ADDED:[],REMOVED:[],DROPPED:[],DEFERRED:[],UNKNOWN:[]};
  for(const slot of new Set([...a.keys(),...b.keys()])){
    const before=a.get(slot),after=b.get(slot),beforePlanned=before?.plannedState??before?.state??null,afterPlanned=after?.plannedState??after?.state??null;
    if((!before||beforePlanned===ContextSectionState.NO_EVIDENCE)&&after&&afterPlanned!==ContextSectionState.NO_EVIDENCE){pushDiff(groups,after.state===ContextSectionState.DEFERRED?'DEFERRED':after.state===ContextSectionState.DROPPED?'DROPPED':'ADDED',slot,before,after);continue;}
    if(before&&(!after||afterPlanned===ContextSectionState.NO_EVIDENCE)&&beforePlanned!==ContextSectionState.NO_EVIDENCE){pushDiff(groups,'REMOVED',slot,before,after);continue;}
    if(after.state===ContextSectionState.REUSED){pushDiff(groups,'UNCHANGED',slot,before,after);continue;}
    if(after.state===ContextSectionState.UPDATED){pushDiff(groups,'UPDATED',slot,before,after);continue;}
    if(after.state===ContextSectionState.REBUILT){pushDiff(groups,'REBUILT',slot,before,after);continue;}
    if(after.state===ContextSectionState.DEFERRED){pushDiff(groups,'DEFERRED',slot,before,after);continue;}
    if(after.state===ContextSectionState.DROPPED){pushDiff(groups,'DROPPED',slot,before,after);continue;}
    pushDiff(groups,'UNKNOWN',slot,before,after);
  }
  return deepFreeze({kind:'GenerationContextDiff',available:true,fromGenerationId:previous.generationId,toGenerationId:current.generationId,groups,insufficient:groups.UNKNOWN.length>0});
}

export function explainContextSeal(seal){
  if(!seal)return deepFreeze({kind:'ContextSealExplanation',available:false,summary:'Context Seal data is unavailable.',impact:'Generation explainability is partial; the generation itself is not necessarily affected.'});
  const notes=[];
  if(seal.staleResultIds.length)notes.push(`${seal.staleResultIds.length} stale result${seal.staleResultIds.length===1?' was':'s were'} excluded before publication.`);
  if(seal.rejectedResultIds.length)notes.push(`${seal.rejectedResultIds.length} rejected result${seal.rejectedResultIds.length===1?' was':'s were'} not admitted.`);
  if(seal.lateResultIds.length)notes.push(`${seal.lateResultIds.length} result${seal.lateResultIds.length===1?' completed':'s completed'} after this generation's publication boundary and did not alter the sealed packet.`);
  if(seal.fallbackState&&seal.fallbackState!=='NONE')notes.push(`Fallback state: ${seal.fallbackState}.`);
  if(!notes.length)notes.push('All recorded publication inputs were contained by the normal Context Seal boundary.');
  return deepFreeze({kind:'ContextSealExplanation',available:true,sealId:seal.sealId,turnId:seal.turnId,accepted:seal.admittedResultIds.length,rejected:seal.rejectedResultIds.length,stale:seal.staleResultIds.length,late:seal.lateResultIds.length,fallbackState:seal.fallbackState,revisionFences:{worldRevision:seal.worldRevision,sceneRevision:seal.sceneRevision,sourceRevisionRefs:seal.sourceRevisionRefs},integrityState:seal.integrityState,summary:notes.join(' '),notes});
}

export function createForensicBookmark({turnId=null,generationId=null,transactionId=null,objectId=null,view=ExplainabilityView.WHY}={}){
  return deepFreeze({kind:'ForensicBookmark',turnId:stringOrNull(turnId),generationId:stringOrNull(generationId),transactionId:stringOrNull(transactionId),objectId:stringOrNull(objectId),view:Object.values(ExplainabilityView).includes(view)?view:ExplainabilityView.WHY});
}

export class ExplainabilityPresentationState{
  #listeners=new Set();
  constructor({stateStore=null,defaults={}}={}){
    this.stateStore=stateStore;const saved=stateStore?.load?.()??{};const raw={view:ExplainabilityView.WHY,bookmark:createForensicBookmark(),filters:{},sortDirection:'ASC',expandedSections:[],...defaults,...(saved.wave7Explainability??{})};
    this.state=this.#normalize(raw);
  }
  get(){return clone(this.state);}
  patch(patch){this.state=this.#normalize({...this.state,...patch});this.stateStore?.save?.({wave7Explainability:this.state});for(const fn of this.#listeners)try{fn(this.get());}catch{}return this.get();}
  selectGeneration({generationId=null,turnId=null}={}){return this.patch({bookmark:createForensicBookmark({...this.state.bookmark,generationId,turnId})});}
  setView(view){return this.patch({view});}
  setFilters(filters){return this.patch({filters:cloneSafe(filters??{})});}
  subscribe(fn){if(typeof fn!=='function')throw new TypeError('listener required');this.#listeners.add(fn);return()=>this.#listeners.delete(fn);}
  #normalize(v){
    const view=Object.values(ExplainabilityView).includes(v.view)?v.view:ExplainabilityView.WHY;
    const filters=sanitizePresentationMap(v.filters);const expandedSections=[...new Set((v.expandedSections??[]).map(String))].slice(0,100);
    const bookmark=createForensicBookmark({...v.bookmark,view});return deepFreeze({view,bookmark,filters,sortDirection:v.sortDirection==='DESC'?'DESC':'ASC',expandedSections});
  }
}

function mergeSectionEvidence(plannedSections,receipt,host){
  const planned=new Map((plannedSections??[]).map(row=>[row.slot,row]));
  const slots=new Set(planned.keys());
  for(const row of receipt?.includedSections??[])slots.add(sectionSlot(row));
  for(const row of receipt?.omittedSections??[])slots.add(sectionSlot(row));
  for(const row of receipt?.deferredSections??[])slots.add(sectionSlot(row));
  slots.delete(null);slots.delete(undefined);slots.delete('');
  const out=[];
  for(const slot of slots){
    const base=planned.get(slot)??emptySection(slot),compiled=contextDisposition(receipt,slot),observed=hostSectionDisposition(host,slot);
    const plannedState=STATES.has(base.state)?base.state:ContextSectionState.NO_EVIDENCE;
    const state=effectiveSectionState(plannedState,compiled.state);
    const reason=(compiled.state===ContextSectionState.DEFERRED||compiled.state===ContextSectionState.DROPPED?compiled.reason:null)??base.reason??compiled.reason??null;
    out.push(deepFreeze({
      ...base,slot,state,plannedState,compiledState:compiled.state,observedState:observed.state,
      reason,included:isIncludedState(state),
      evidence:deepFreeze({
        planned:{state:plannedState,receiptRef:base.receiptRef??null,reason:base.reason??null},
        compiled:{state:compiled.state,receiptRef:receipt?.packetId??receipt?.contextSealId??receipt?.promptPlanId??null,reason:compiled.reason??null},
        observed:{state:observed.state,receiptRef:host?.receiptRef??null,reason:observed.reason??null},
      }),
    }));
  }
  return out;
}
function emptySection(slot){return{kind:'GenerationContextSection',slot,state:ContextSectionState.NO_EVIDENCE,priority:null,estimatedTokens:null,actualTokens:null,sourceSubsystem:null,authority:null,revisionIdentity:null,reuseState:null,cacheEligible:null,representation:null,required:false,protected:false,reason:null,included:false,rawRef:null};}
function sectionSlot(row){if(typeof row==='string')return row;return row?.slot??row?.segmentKey??row?.section??row?.id??null;}
function dispositionRow(rows,slot){return (rows??[]).find(row=>sectionSlot(row)===slot)??null;}
function contextDisposition(receipt,slot){
  if(!receipt)return{state:ContextSectionState.NO_EVIDENCE,reason:'CONTEXT_RECEIPT_NOT_PUBLISHED'};
  const deferred=dispositionRow(receipt.deferredSections,slot);if(deferred)return{state:ContextSectionState.DEFERRED,reason:ownerReason(deferred)??'CONTEXT_SECTION_DEFERRED'};
  const omitted=dispositionRow(receipt.omittedSections,slot);if(omitted)return{state:ContextSectionState.DROPPED,reason:ownerReason(omitted)??'CONTEXT_SECTION_OMITTED'};
  if((receipt.includedSections??[]).some(row=>sectionSlot(row)===slot))return{state:ContextSectionState.INCLUDED,reason:null};
  return{state:ContextSectionState.NO_EVIDENCE,reason:'CONTEXT_SECTION_DISPOSITION_NOT_PUBLISHED'};
}
function normalizeHostDeliveryEvidence(host){
  if(!host)return deepFreeze({state:'NO_EVIDENCE',receiptRef:null,reason:'HOST_DELIVERY_RECEIPT_NOT_PUBLISHED',observedAt:null,sectionEvidence:null});
  const injected=Boolean(host.promptInjected||host.requestInjectedAt!=null);
  const sectionEvidence={
    includedSections:cloneSafe(host.includedSections??host.observedIncludedSections??[]),
    omittedSections:cloneSafe(host.omittedSections??host.observedOmittedSections??[]),
    deferredSections:cloneSafe(host.deferredSections??host.observedDeferredSections??[]),
  };
  const hasSections=Object.values(sectionEvidence).some(rows=>Array.isArray(rows)&&rows.length);
  return deepFreeze({
    state:injected?'OBSERVED':'NOT_OBSERVED',receiptRef:host.receiptId??host.id??host.generationId??null,
    reason:injected?null:(host.abortCode??host.reasonCode??'HOST_REQUEST_NOT_OBSERVED'),observedAt:host.requestInjectedAt??host.observedAt??null,
    sectionEvidence:hasSections?sectionEvidence:null,
  });
}
function hostSectionDisposition(host,slot){
  if(!host||host.state==='NO_EVIDENCE')return{state:ContextSectionState.NO_EVIDENCE,reason:host?.reason??'HOST_DELIVERY_RECEIPT_NOT_PUBLISHED'};
  const rows=host.sectionEvidence;if(!rows)return{state:ContextSectionState.NO_EVIDENCE,reason:'HOST_SECTION_DISPOSITION_NOT_PUBLISHED'};
  const deferred=dispositionRow(rows.deferredSections,slot);if(deferred)return{state:ContextSectionState.DEFERRED,reason:ownerReason(deferred)??'HOST_SECTION_DEFERRED'};
  const omitted=dispositionRow(rows.omittedSections,slot);if(omitted)return{state:ContextSectionState.DROPPED,reason:ownerReason(omitted)??'HOST_SECTION_OMITTED'};
  if((rows.includedSections??[]).some(row=>sectionSlot(row)===slot))return{state:ContextSectionState.INCLUDED,reason:null};
  return{state:ContextSectionState.NO_EVIDENCE,reason:'HOST_SECTION_DISPOSITION_NOT_PUBLISHED'};
}
function effectiveSectionState(planned,compiled){
  if(compiled===ContextSectionState.DEFERRED||compiled===ContextSectionState.DROPPED||compiled===ContextSectionState.INVALIDATED)return compiled;
  if(compiled===ContextSectionState.INCLUDED){
    if([ContextSectionState.REUSED,ContextSectionState.UPDATED,ContextSectionState.REBUILT,ContextSectionState.NEW].includes(planned))return planned;
    return ContextSectionState.INCLUDED;
  }
  return planned;
}
function isIncludedState(state){return[ContextSectionState.REUSED,ContextSectionState.UPDATED,ContextSectionState.REBUILT,ContextSectionState.NEW,ContextSectionState.INCLUDED].includes(state);}
function budgetRecord(budget,estimated){
  const b=budget&&typeof budget==='object'?budget:{};
  const total=finiteOrNull(b.total??b.available??b.contextWindow),allocated=finiteOrNull(b.allocated??b.usedTokens??estimated);
  const explicitRemaining=finiteOrNull(b.remaining),remaining=explicitRemaining??(total!=null&&allocated!=null?Math.max(0,total-allocated):null);
  return deepFreeze({total,allocated,remaining});
}
function finiteOrNull(value){if(value==null||value==='')return null;const n=Number(value);return Number.isFinite(n)?n:null;}

function mapReuseState(value,included){
  if(value==='NO_CHANGE')return ContextSectionState.REUSED;
  if(value==='PATCH')return ContextSectionState.UPDATED;
  if(value==='REBUILD')return ContextSectionState.REBUILT;
  if(value==='OMIT')return ContextSectionState.DROPPED;
  return included?ContextSectionState.INCLUDED:ContextSectionState.UNAVAILABLE;
}
function ownerReason(row){if(!row)return null;return row.reason??row.reasonCode??row.explanation??row.metadata?.reason??null;}
function sectionFromDisposition(row,state){return deepFreeze({kind:'GenerationContextSection',slot:row.slot??row.segmentKey??row.id??'UNKNOWN',state,priority:row.priority??null,estimatedTokens:row.estimatedTokens??row.tokenEstimate??null,actualTokens:null,sourceSubsystem:row.sourceSubsystem??null,authority:row.authorityClass??null,revisionIdentity:cloneSafe(row.sourceRevisionIds??null),reuseState:row.reuseState??null,cacheEligible:row.cacheEligible??null,representation:row.representation??null,required:Boolean(row.required),protected:Boolean(row.protected),reason:ownerReason(row),included:false,rawRef:null});}
function countSectionStates(sections){const out=Object.fromEntries(Object.values(ContextSectionState).map(x=>[x,0]));for(const x of sections)out[x.state]=(out[x.state]??0)+1;return out;}
function sectionImpact(section){if(section.state===ContextSectionState.DROPPED)return'This section did not reach the generation.';if(section.state===ContextSectionState.DEFERRED)return'This section was deferred and did not reach this generation.';if(section.state===ContextSectionState.REUSED)return'Previously valid context was reused.';if(section.state===ContextSectionState.UPDATED)return'Only the affected context segment was updated.';if(section.state===ContextSectionState.REBUILT)return'The owning context logic rebuilt this section.';if(section.state===ContextSectionState.INVALIDATED)return'This section was invalidated before generation.';return section.included?'This section was included in generation context.':'Section impact is unavailable.';}
function pushDiff(groups,key,slot,before,after){groups[key].push({slot,beforeState:before?.state??null,afterState:after?.state??null,reason:after?.reason??null});}
function sanitizePresentationMap(v){const out={};for(const [k,x] of Object.entries(v??{}).slice(0,32)){if(['string','number','boolean'].includes(typeof x)||x==null)out[String(k)]=x;else if(Array.isArray(x))out[String(k)]=x.slice(0,64).map(y=>String(y));}return out;}
function stringOrNull(v){return v==null?null:String(v);}
