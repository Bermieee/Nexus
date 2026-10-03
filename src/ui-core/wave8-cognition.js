import { ProductDataMode, Wave6Health, clone, createProductSourceStatus, deepFreeze, normalizeWave6Health } from './wave6-contracts.js';

export const CognitionStageState=Object.freeze({
  ACTIVE:'ACTIVE',COMPLETE:'COMPLETE',SKIPPED:'SKIPPED',DEFERRED:'DEFERRED',UNAVAILABLE:'UNAVAILABLE',
  DEGRADED:'DEGRADED',STALE:'STALE',INVALID:'INVALID',FAILED:'FAILED',
});
export const CognitionStageId=Object.freeze({
  SCENE:'SCENE',CHOICE:'COGNITIVE_CHOICE',SCATTER:'SCATTER',SENSORY:'SENSORY',RETRIEVAL_QUALITY:'RETRIEVAL_QUALITY',
  TRUTH:'TRUTH',JEV:'JEV',PRECISION:'PRECISION',GATHER:'GATHER',CONTEXT_SEAL:'CONTEXT_SEAL',PROMPT_PLAN:'PROMPT_PLAN',
});
export const RetrievalQuality=Object.freeze({HIGH:'HIGH',MIXED:'MIXED',LOW:'LOW'});
export const JevOutcome=Object.freeze({
  DECIDED:'DECIDED',PARTIAL:'PARTIAL',UNRESOLVED:'UNRESOLVED',ABSTAINED:'ABSTAINED',ESCALATE_OWNER:'ESCALATE_OWNER',
  REQUEST_OPERATOR:'REQUEST_OPERATOR',STALE:'STALE',INVALID:'INVALID',
});
const STATES=new Set(Object.values(CognitionStageState));
const TRUTH=new Set(['CURRENT','HISTORICAL','SUPERSEDED','CONTRADICTED','UNCERTAIN','UNRESOLVED','UNKNOWN']);
const JEV=new Set(Object.values(JevOutcome));
const QUALITY=new Set(Object.values(RetrievalQuality));
const safeArray=(v)=>Array.isArray(v)?clone(v):[];
const stringOrNull=(v)=>v==null?null:String(v);
const reasonOf=(x)=>x?.reason??x?.reasonCode??x?.explanation??x?.diagnostics?.reason??x?.metadata?.reason??null;

export function createStage({id,label,state=CognitionStageState.UNAVAILABLE,summary='',reason=null,health=null,receiptRef=null,details=null}={}){
  if(!Object.values(CognitionStageId).includes(id))throw new TypeError(`Unsupported cognition stage: ${id}`);
  if(!STATES.has(state))throw new TypeError(`Unsupported cognition stage state: ${state}`);
  return deepFreeze({kind:'CognitionStage',id,label:label??human(id),state,summary:String(summary??''),reason:reason==null?null:String(reason),health:health??stateHealth(state),receiptRef:receiptRef??null,details:clone(details??null)});
}

export function normalizeCognitiveChoiceReceipt(receipt){
  if(!receipt)return null;
  const canonical=receipt.kind==='CognitiveChoiceReceipt'&&receipt.contractVersion==='1.0.0';
  const functionDecisions=safeArray(receipt.functionDecisions??receipt.cognitiveFunctionDecisions);
  const candidateJobs=(functionDecisions.length?functionDecisions:safeArray(receipt.consideredCognitionOptions??receipt.candidateJobs??receipt.candidateCognitionOptions??receipt.options??receipt.candidates)).map(normalizeJobCandidate);
  const admitted=(functionDecisions.length?functionDecisions.filter(x=>String(x.disposition??'').toUpperCase()==='ADMITTED'):safeArray(receipt.admittedJobs??receipt.admitted??receipt.selectedJobs)).map(x=>normalizeJobDecision(x,'ADMITTED'));
  const skipped=(functionDecisions.length?functionDecisions.filter(x=>String(x.disposition??'').toUpperCase()==='SKIPPED'):safeArray(receipt.skippedJobs??receipt.skipped??receipt.rejectedJobs)).map(x=>normalizeJobDecision(x,'SKIPPED'));
  const deferred=(functionDecisions.length?functionDecisions.filter(x=>String(x.disposition??'').toUpperCase()==='DEFERRED'):safeArray(receipt.deferredJobs??receipt.deferred??receipt.backgroundJobs)).map(x=>normalizeJobDecision(x,'DEFERRED'));
  const status=receipt.status??receipt.state??'COMPLETE';
  const executionResources=safeArray(receipt.executionResources??receipt.executionPlan?.resources??receipt.executionPlan?.assignments??receipt.resources??receipt.assignments).map(normalizeResource);
  const reasonCodes=safeArray(receipt.reasonCodes);
  const admittedNames=new Set(admitted.map(x=>machineJob(x.capability))),skippedNames=new Set(skipped.map(x=>machineJob(x.capability)));
  const retrievalDecision=canonical?decisionFromJob('RETRIEVAL',admittedNames,skippedNames,reasonCodes):normalizeOptionalDecision(receipt.retrieval??receipt.retrievalDecision??receipt.retrievalStatus);
  const sensoryDecision=canonical?retrievalDecision:normalizeOptionalDecision(receipt.sensory??receipt.sensoryDecision??receipt.sensoryStatus);
  const truthDecision=canonical?normalizeTruthChoice(receipt.truthGate,reasonCodes):normalizeOptionalDecision(receipt.truth??receipt.truthDecision??receipt.truthStatus);
  const jevDecision=canonical?normalizeJevChoice(receipt.jev,reasonCodes):normalizeOptionalDecision(receipt.jev??receipt.jevDecision??receipt.jevStatus);
  const precisionDecision=canonical?normalizePrecisionChoice(receipt.precision,reasonCodes,receipt.candidateCounts):normalizeOptionalDecision(receipt.precision??receipt.precisionDecision??receipt.precisionStatus);
  const scatterDecision=canonical?null:normalizeOptionalDecision(receipt.scatter??receipt.scatterDecision??receipt.scatterStatus);
  const gatherDecision=canonical?decisionFromJob('GATHER',admittedNames,skippedNames,reasonCodes):normalizeOptionalDecision(receipt.gather??receipt.gatherDecision??receipt.gatherStatus);
  const revisionIdentity=clone(receipt.revisions??receipt.revisionIdentity??{
    worldRevision:receipt.worldRevision??null,sceneRevision:receipt.sceneRevision??null,sourceRevisionRefs:safeArray(receipt.sourceRevisionRefs??receipt.sourceRevisionIds),
  });
  return deepFreeze({
    kind:'NormalizedCognitiveChoiceReceipt',sourceKind:receipt.kind??'CognitiveChoiceReceipt',contractVersion:receipt.contractVersion??null,
    receiptId:stringOrNull(receipt.receiptId??receipt.id),receiptRevision:receipt.receiptRevision??null,
    turnId:stringOrNull(receipt.turnId),turnRevision:receipt.turnRevision??revisionIdentity?.turnRevision??null,generationId:stringOrNull(receipt.generationId),
    correlationId:stringOrNull(receipt.correlationId),causationId:stringOrNull(receipt.causationId),
    status,paths:safeArray(receipt.paths),brainChoice:humanChoice(receipt.brainChoice??receipt.chosenPath??receipt.choice??(receipt.paths?.length?receipt.paths:admitted.map(x=>x.capability))),
    candidateJobs,admitted,skipped,deferred,executionResources,reasonCodes,
    retrievalIntents:safeArray(receipt.retrievalIntents),sensoryChannelsRequested:safeArray(receipt.sensoryChannelsRequested??receipt.sensoryChannels),
    sensoryChannelsUsed:safeArray(receipt.sensoryChannelsUsed),candidateCounts:clone(receipt.candidateCounts??null),retrievalQuality:receipt.retrievalQuality??null,
    correctiveRetrieval:clone(receipt.correctiveRetrieval??null),truthGate:clone(receipt.truthGate??null),
    jevDecision,precisionDecision,retrievalDecision,sensoryDecision,truthDecision,scatterDecision,gatherDecision,
    abstained:Boolean(receipt.abstained),unresolved:Boolean(receipt.unresolved),abstentions:safeArray(receipt.abstentions),
    generationEvidenceRefs:safeArray(receipt.finalEvidenceRefs??receipt.generationEvidenceRefs),
    resourceBudget:clone(receipt.latencyResourceBudget??receipt.resourceBudget??receipt.latencyBudget??receipt.budget??null),
    measurements:clone(receipt.measurements??receipt.optimizationMeasurements??null),executionPlan:clone(receipt.executionPlan??null),
    revisionIdentity,freshness:clone(receipt.freshness??null),seal:clone(receipt.seal??null),
    lateResultIds:safeArray(receipt.lateResultIds),staleResultIds:safeArray(receipt.staleResultIds),invalidResultIds:safeArray(receipt.invalidResultIds),
    metadata:clone(receipt.metadata??null),reason:reasonOf(receipt),authority:'READ_ONLY',truthAuthority:false,settlementAuthority:false,mutationAuthority:false,
  });
}

export function normalizeSensoryFromChoiceReceipt(choice){
  if(!choice?.candidateCounts)return null;
  const nominated=Number(choice.candidateCounts.nominated??0),unique=Number(choice.candidateCounts.deduplicated??0);
  if(!nominated&&!unique&&!choice.sensoryChannelsUsed?.length&&!choice.sensoryChannelsRequested?.length)return null;
  const skipped=isExplicitSkip(choice.retrievalDecision);
  return deepFreeze({
    kind:'NormalizedSensoryReceipt',receiptId:choice.receiptId,state:skipped?CognitionStageState.SKIPPED:CognitionStageState.COMPLETE,
    inputNominationCount:nominated,uniqueCandidateCount:unique,duplicateNominationCount:Math.max(0,nominated-unique),perChannelCounts:{},
    inputChannelCount:choice.sensoryChannelsUsed?.length??0,boundedOutCount:0,staleNominationCount:Number(choice.freshness?.staleNominationCount??0),
    invalidNominationCount:Number(choice.freshness?.invalidNominationCount??0),unavailableChannels:[],degradedChannels:[],
    retrievalIntentIds:safeArray(choice.retrievalIntents),sourceRevisionRefs:safeArray(choice.revisionIdentity?.sourceRevisionRefs),
    worldRevision:choice.revisionIdentity?.worldRevision??null,sceneRevision:choice.revisionIdentity?.sceneRevision??null,candidates:[],
    channelsUsed:safeArray(choice.sensoryChannelsUsed),channelsRequested:safeArray(choice.sensoryChannelsRequested),fusionPolicyVersion:null,
    summaryOnly:true,sourceReceipt:'CognitiveChoiceReceipt',authority:'READ_ONLY',mutationAuthority:false,
  });
}

export function normalizeTruthFromChoiceReceipt(choice){
  const gate=choice?.truthGate;if(!gate||gate.considered===false)return null;
  const counts=Object.fromEntries([...TRUTH].map(x=>[x,Number(gate.outcomeCounts?.[x]??0)]));
  return deepFreeze({
    kind:'NormalizedTruthAssessment',receiptId:choice.receiptId,query:null,intent:null,retrievalQuality:choice.retrievalQuality??null,
    reason:null,truthRows:[],counts,corrective:null,admittedCandidateIds:safeArray(gate.admittedCandidateIds),supportCandidateIds:safeArray(gate.supportCandidateIds),
    summaryOnly:true,sourceReceipt:'CognitiveChoiceReceipt',authority:'READ_ONLY',mutationAuthority:false,
  });
}

export function normalizeGatherFromChoiceReceipt(choice){
  if(!choice)return null;
  const decision=choice.gatherDecision;if(!decision||isExplicitSkip(decision))return null;
  const admitted=choice.generationEvidenceRefs?.length??0,stale=choice.staleResultIds?.length??0,late=choice.lateResultIds?.length??0,invalid=choice.invalidResultIds?.length??0;
  if(!admitted&&!stale&&!late&&!invalid&&!decision.invoked)return null;
  return deepFreeze({
    kind:'NormalizedGatherReceipt',receiptId:choice.receiptId,turnId:choice.turnId,generationId:choice.generationId,correlationId:choice.correlationId,
    state:CognitionStageState.COMPLETE,counts:{ADMITTED:admitted,STALE:stale,LATE:late,REJECTED:0,INVALID:invalid},results:[],
    admittedEvidenceRefs:safeArray(choice.generationEvidenceRefs),rejectedResultIds:[...safeArray(choice.staleResultIds),...safeArray(choice.lateResultIds),...safeArray(choice.invalidResultIds)],
    reason:null,summaryOnly:true,sourceReceipt:'CognitiveChoiceReceipt',authority:'READ_ONLY',mutationAuthority:false,
  });
}

export function normalizeSealFromChoiceReceipt(choice){
  const seal=choice?.seal;if(!seal?.sealed&&!seal?.sealReceiptId)return null;
  return deepFreeze({
    kind:'NormalizedContextSeal',sealId:stringOrNull(seal.sealReceiptId),turnId:choice.turnId,correlationId:choice.correlationId,
    packetId:stringOrNull(seal.packetId),packetHash:stringOrNull(seal.packetHash),sourceRevisionRefs:safeArray(choice.revisionIdentity?.sourceRevisionRefs),
    worldRevision:choice.revisionIdentity?.worldRevision??null,sceneRevision:choice.revisionIdentity?.sceneRevision??null,
    admittedResultIds:[],rejectedResultIds:safeArray(choice.invalidResultIds),staleResultIds:safeArray(choice.staleResultIds),lateResultIds:safeArray(choice.lateResultIds),
    admittedEvidenceCount:choice.generationEvidenceRefs?.length??0,fallbackState:'NONE',deadline:null,sequence:seal.sequence??null,sealedAt:null,
    dependencies:[],sealedState:Boolean(seal.sealed),integrityState:seal.sealed?'SEALED':'UNSEALED',summaryOnly:true,sourceReceipt:'CognitiveChoiceReceipt',
  });
}

export function normalizeScatterReceipt(receipt,choice=null){
  if(!receipt)return null;
  const jobs=safeArray(receipt.jobs??receipt.executions??receipt.assignments).map(row=>({
    jobId:stringOrNull(row.jobId??row.taskId??row.id),capability:human(row.capability??row.jobType??row.taskType??row.kind??'Cognitive job'),
    state:String(row.state??row.status??'UNKNOWN'),resourceId:stringOrNull(row.resourceId??row.workerId??row.executionResourceId),provider:stringOrNull(row.provider??row.providerId),
    model:stringOrNull(row.model??row.modelId),reason:reasonOf(row),correlationId:stringOrNull(row.correlationId),causationId:stringOrNull(row.causationId),
  }));
  const layeredTelemetry=normalizeLayeredScatterTelemetry(receipt.layeredTelemetry??receipt.waveTelemetry??receipt.waves??null);
  return deepFreeze({kind:'NormalizedScatterReceipt',receiptId:stringOrNull(receipt.receiptId??receipt.id),turnId:stringOrNull(receipt.turnId??choice?.turnId),correlationId:stringOrNull(receipt.correlationId??choice?.correlationId),jobs,resourceCount:new Set(jobs.map(x=>x.resourceId).filter(Boolean)).size,layeredTelemetry,authority:'READ_ONLY',mutationAuthority:false});
}

function normalizeLayeredScatterTelemetry(value){
  if(value==null)return null;
  const rows=Array.isArray(value)?value:Array.isArray(value?.waves)?value.waves:Array.isArray(value?.layers)?value.layers:[];
  if(!rows.length)return null;
  return deepFreeze(rows.slice(0,16).map((row,index)=>({
    waveId:stringOrNull(row.waveId??row.layerId??row.id??String(index+1)),
    trigger:stringOrNull(row.trigger??row.triggerReason??row.reasonCode),
    startedAt:finiteOrNull(row.startedAt??row.startAt),
    completedAt:finiteOrNull(row.completedAt??row.endAt),
    durationMs:finiteOrNull(row.durationMs),
    concurrency:finiteOrNull(row.concurrency??row.maxConcurrency??row.activeWorkers),
    deferred:finiteOrNull(row.deferred??row.deferredCount??row.deferredWork),
    jobs:finiteOrNull(row.jobs??row.jobCount??row.workCount),
  })));
}
function finiteOrNull(value){if(value==null||value==='')return null;const n=Number(value);return Number.isFinite(n)?n:null;}

export function normalizeSensoryReceipt(input){
  if(!input)return null;
  const envelope=input.envelope??input.candidateBusEnvelope??(input.kind==='CandidateBusEnvelope'?input:null);
  const fusion=input.fusionReceipt??envelope?.fusionReceipt??(input.kind==='CandidateFusionReceipt'?input:null);
  const trace=input.trace??input.sensoryTrace??null;
  if(!envelope&&!fusion&&!trace)return null;
  const candidates=safeArray(envelope?.candidates??trace?.candidates);
  const perChannel=clone(fusion?.perChannelCounts??trace?.perChannelCounts??trace?.channels??{});
  const inputNominations=Number(fusion?.inputNominationCount??trace?.inputNominationCount??trace?.nominations??0);
  const unique=Number(fusion?.deduplicatedCandidateCount??envelope?.candidateCount??trace?.uniqueCandidates??trace?.uniqueCount??0);
  const duplicate=Number(fusion?.duplicateNominationCount??trace?.duplicateNominationCount??Math.max(0,inputNominations-unique));
  const freshness=envelope?.freshness??fusion?.freshness??trace?.freshness??'UNKNOWN';
  const unhealthy=[...(fusion?.unavailableChannels??envelope?.unavailableChannels??[]),...(fusion?.degradedChannels??envelope?.degradedChannels??[])];
  const state=freshness==='STALE'?CognitionStageState.STALE:freshness==='INVALID'?CognitionStageState.INVALID:unhealthy.length?CognitionStageState.DEGRADED:CognitionStageState.COMPLETE;
  return deepFreeze({
    kind:'NormalizedSensoryReceipt',receiptId:stringOrNull(fusion?.candidateSetId??envelope?.candidateSetId??trace?.receiptId??trace?.id),
    state,inputNominationCount:inputNominations,uniqueCandidateCount:unique,duplicateNominationCount:duplicate,perChannelCounts:perChannel,
    inputChannelCount:Number(fusion?.inputChannelCount??Object.keys(perChannel).length),boundedOutCount:Number(fusion?.boundedOutCount??0),
    staleNominationCount:Number(fusion?.staleNominationCount??0),invalidNominationCount:Number(fusion?.invalidNominationCount??0),
    unavailableChannels:safeArray(fusion?.unavailableChannels??envelope?.unavailableChannels),degradedChannels:safeArray(fusion?.degradedChannels??envelope?.degradedChannels),
    retrievalIntentIds:safeArray(envelope?.retrievalIntentIds??fusion?.retrievalIntentIds??trace?.retrievalIntentIds),
    sourceRevisionRefs:safeArray(envelope?.sourceRevisionSet??trace?.sourceRevisionRefs),worldRevision:envelope?.worldRevision??trace?.worldRevision??null,
    sceneRevision:envelope?.sceneRevision??trace?.sceneRevision??null,candidates:candidates.map(normalizeSensoryCandidate),fusionPolicyVersion:fusion?.fusionPolicyVersion??null,
    authority:'READ_ONLY',mutationAuthority:false,
  });
}

export function normalizeTruthAssessment(assessment){
  if(!assessment)return null;
  const quality=assessment.confidence??assessment.retrievalQuality??assessment.quality??null;
  const truthRows=safeArray(assessment.truthResults??assessment.results??assessment.classifications).map(row=>{
    const classification=String(row.classification??row.truthStatus??row.status??'UNKNOWN').toUpperCase();
    return deepFreeze({candidateId:stringOrNull(row.candidateId??row.id),classification:TRUTH.has(classification)?classification:'UNKNOWN',
      usableForIntent:row.usableForIntent==null?null:Boolean(row.usableForIntent),reasons:safeArray(row.reasons??(row.reason?[row.reason]:[])),claimIds:safeArray(row.claimIds),provenance:clone(row.provenance??null)});
  });
  const counts=Object.fromEntries([...TRUTH].map(x=>[x,0]));for(const row of truthRows)counts[row.classification]=(counts[row.classification]??0)+1;
  const corrective=assessment.correctiveRequest?deepFreeze({
    requestId:stringOrNull(assessment.correctiveRequest.id??assessment.correctiveRequest.requestId),reason:reasonOf(assessment.correctiveRequest),
    requestedAction:assessment.correctiveRequest.requestedAction??null,attempt:Number(assessment.correctiveRequest.attempt??1),
    maxAttempts:Number(assessment.correctiveRequest.maxAttempts??1),sourceRevisionRefs:safeArray(assessment.correctiveRequest.sourceRevisionIds),
    worldRevision:assessment.correctiveRequest.worldRevision??null,sceneRevision:assessment.correctiveRequest.sceneRevision??null,
  }):null;
  return deepFreeze({
    kind:'NormalizedTruthAssessment',receiptId:stringOrNull(assessment.id??assessment.receiptId),query:stringOrNull(assessment.query),intent:stringOrNull(assessment.intent),
    retrievalQuality:QUALITY.has(String(quality).toUpperCase())?String(quality).toUpperCase():null,reason:reasonOf(assessment),truthRows,counts,corrective,
    admittedCandidateIds:safeArray(assessment.admittedCandidateIds),supportCandidateIds:safeArray(assessment.supportCandidateIds),
    authority:'READ_ONLY',mutationAuthority:false,
  });
}

export function normalizeCorrectiveRetrievalReceipt(receipt,truth=null){
  if(!receipt&&!truth?.corrective)return null;
  const source=receipt??truth.corrective;
  const state=source.failed?CognitionStageState.DEGRADED:source.executed===false?CognitionStageState.SKIPPED:source.executed===true?CognitionStageState.COMPLETE:CognitionStageState.UNAVAILABLE;
  return deepFreeze({
    kind:'NormalizedCorrectiveRetrievalReceipt',receiptId:stringOrNull(source.receiptId??source.id??source.requestId),state,
    executed:source.executed==null?null:Boolean(source.executed),failed:Boolean(source.failed),terminated:source.terminated==null?null:Boolean(source.terminated),
    attempt:Number(source.attempt??source.correctionCount??source.request?.attempt??truth?.corrective?.attempt??0)||null,maxAttempts:Number(source.maxAttempts??source.maxCorrections??source.request?.maxAttempts??truth?.corrective?.maxAttempts??0)||null,
    reason:reasonOf(source)??truth?.corrective?.reason??null,initialQuality:source.initialQuality??truth?.retrievalQuality??null,finalQuality:source.finalQuality??source.retrievalQuality??(QUALITY.has(String(source.result??'').toUpperCase())?String(source.result).toUpperCase():null),
    candidateCount:Number(source.candidateCount??source.candidates?.length??0),authority:'READ_ONLY',mutationAuthority:false,
  });
}

export function normalizeJevDecisionReceipt(receipt,choice=null){
  const looksLikeChoiceSummary=Boolean(receipt&&(!receipt.kind||receipt.kind==='JevChoiceSummary')&&
    ['considered','invoked','skipped','unavailable','advised','action','abstained'].some(key=>Object.prototype.hasOwnProperty.call(receipt,key)));
  if(looksLikeChoiceSummary)return normalizeJevDecisionReceipt(null,{jevDecision:normalizeJevChoice(receipt,safeArray(receipt.reasonCodes??choice?.reasonCodes))});
  if(!receipt){
    const decision=choice?.jevDecision;if(!decision)return null;
    const action=String(decision.action??decision.state??decision.status??'').toUpperCase();
    if(action==='JEV_UNAVAILABLE'||decision.unavailable===true)return deepFreeze({
      kind:'NormalizedJevDecisionReceipt',receiptId:stringOrNull(decision.resultRef),state:CognitionStageState.UNAVAILABLE,outcome:'UNAVAILABLE',invoked:Boolean(decision.invoked),physicalAttempt:Boolean(decision.invoked),
      reason:decision.reasonDetail??decision.reason??null,reasonCodes:safeArray(decision.reasonCodes),decisionType:null,decisionShape:null,decisionCode:null,classification:null,
      serviceStatus:'JEV_UNAVAILABLE',options:[],selectedOptionIds:[],rejectedOptionIds:[],evidenceRefs:[],unresolvedFactors:[],revisionFence:null,confidence:null,
      requiresOwnerSettlement:null,requiresOperatorReview:null,ownerSettlement:null,settlementPerformed:false,provider:null,model:null,resourceId:null,
      admission:null,explanation:null,authority:'READ_ONLY',mutationAuthority:false,
    });
    if(action==='SKIP_JEV'||decision.invoked===false||decision.skipped===true||action==='SKIPPED')return deepFreeze({
      kind:'NormalizedJevDecisionReceipt',receiptId:stringOrNull(decision.resultRef),state:CognitionStageState.SKIPPED,outcome:'SKIPPED',invoked:false,physicalAttempt:false,
      reason:decision.reasonDetail??decision.reason??null,reasonCodes:safeArray(decision.reasonCodes),decisionType:null,decisionShape:null,decisionCode:null,classification:null,
      serviceStatus:'JEV_SKIPPED',options:[],selectedOptionIds:[],rejectedOptionIds:[],evidenceRefs:[],unresolvedFactors:[],revisionFence:null,confidence:null,
      requiresOwnerSettlement:null,requiresOperatorReview:null,ownerSettlement:null,settlementPerformed:false,provider:null,model:null,resourceId:null,
      admission:null,explanation:null,authority:'READ_ONLY',mutationAuthority:false,
    });
    if(action==='JEV_ABSTAINED'||decision.abstained===true)return deepFreeze({
      kind:'NormalizedJevDecisionReceipt',receiptId:stringOrNull(decision.resultRef),state:CognitionStageState.COMPLETE,outcome:JevOutcome.ABSTAINED,invoked:true,
      reason:decision.reasonDetail??decision.reason??null,reasonCodes:safeArray(decision.reasonCodes),decisionType:null,decisionShape:null,decisionCode:'ABSTAIN',classification:null,
      serviceStatus:'JEV_ABSTAINED',options:[],selectedOptionIds:[],rejectedOptionIds:[],evidenceRefs:[],unresolvedFactors:[],revisionFence:null,confidence:null,
      requiresOwnerSettlement:null,requiresOperatorReview:null,ownerSettlement:null,settlementPerformed:false,provider:null,model:null,resourceId:null,
      admission:null,explanation:null,authority:'READ_ONLY',mutationAuthority:false,
    });
    if(action==='REQUEST_OPERATOR')return choiceJevSummary(decision,JevOutcome.REQUEST_OPERATOR,'JEV_OPERATOR');
    if(action==='PRESERVE_UNRESOLVED')return choiceJevSummary(decision,JevOutcome.UNRESOLVED,'JEV_UNRESOLVED');
    // An invocation request is not a completed Jev decision. Without a Jev receipt or an accepted
    // Core summary carrying a terminal outcome, keep the decision stage unavailable rather than
    // fabricating completion from intent alone.
    if(action==='INVOKE_JEV'||action==='INVOKED'||decision.invoked===true)return null;
    return null;
  }
  const reasonCodes=safeArray(receipt.reasonCodes);
  const serviceStatus=String(receipt.serviceStatus??'').toUpperCase();
  const recordedReason=String(receipt.reasonCode??receipt.reason??receipt.decisionCode??'').toUpperCase();
  const intentionalSkip=serviceStatus==='JEV_SKIPPED'||recordedReason==='JEV_NOT_REQUIRED'||reasonCodes.some(code=>String(code).toUpperCase()==='JEV_NOT_REQUIRED');
  const rawOutcome=String(receipt.outcome??receipt.status??receipt.decisionStatus??'INVALID').toUpperCase();
  const outcome=intentionalSkip?'SKIPPED':JEV.has(rawOutcome)?rawOutcome:JevOutcome.INVALID;
  const admission=clone(receipt.admission??null);
  const state=intentionalSkip?CognitionStageState.SKIPPED:
    serviceStatus==='JEV_UNAVAILABLE'?CognitionStageState.UNAVAILABLE:
    outcome==='STALE'||serviceStatus==='JEV_STALE'?CognitionStageState.STALE:
    outcome==='INVALID'||serviceStatus==='JEV_INVALID'?CognitionStageState.INVALID:
    admission?.late===true?CognitionStageState.DEFERRED:CognitionStageState.COMPLETE;
  const selected=safeArray(receipt.selectedOptionIds??receipt.selectedOptions??(receipt.selectedOptionId?[receipt.selectedOptionId]:[])).map(x=>typeof x==='string'?x:x.optionId??x.id).filter(Boolean);
  const rejected=safeArray(receipt.rejectedOptionIds??receipt.rejectedOptions).map(x=>typeof x==='string'?x:x.optionId??x.id).filter(Boolean);
  const provenance=receipt.providerProvenance??{};
  return deepFreeze({
    kind:'NormalizedJevDecisionReceipt',receiptId:stringOrNull(receipt.receiptId??receipt.id??receipt.decisionId),state,outcome,
    chatId:stringOrNull(receipt.chatId),turnId:stringOrNull(receipt.turnId),generationId:stringOrNull(receipt.generationId),correlationId:stringOrNull(receipt.correlationId),
    physicalAttempt:typeof receipt.physicalAttempt==='boolean'?receipt.physicalAttempt:null,returned:typeof receipt.returned==='boolean'?receipt.returned:null,
    invoked:!intentionalSkip,reason:receipt.explanation||reasonCodes.join(', ')||reasonOf(receipt),reasonCodes,
    decisionType:stringOrNull(receipt.decisionType??receipt.requestType),decisionShape:stringOrNull(receipt.decisionShape),decisionCode:stringOrNull(receipt.decisionCode),
    classification:stringOrNull(receipt.classification),serviceStatus:receipt.serviceStatus??null,options:safeArray(receipt.options??receipt.optionsConsidered),
    selectedOptionIds:selected,rejectedOptionIds:rejected,evidenceRefs:safeArray(receipt.evidenceUsed??receipt.evidenceRefs??receipt.evidenceIds),
    unresolvedFactors:safeArray(receipt.unresolvedFactors),revisionFence:clone(receipt.revisionFence??{
      worldRevision:receipt.worldRevision??null,sceneRevision:receipt.sceneRevision??null,sourceRevisionSet:safeArray(receipt.sourceRevisionRefs??receipt.sourceRevisionIds),
    }),freshnessToken:stringOrNull(receipt.freshnessToken),confidence:receipt.confidence==null?null:Number(receipt.confidence),
    requiresOwnerSettlement:receipt.requiresOwnerSettlement==null?null:Boolean(receipt.requiresOwnerSettlement),
    requiresOperatorReview:receipt.requiresOperator==null?(receipt.requiresOperatorReview==null?null:Boolean(receipt.requiresOperatorReview)):Boolean(receipt.requiresOperator),
    ownerSettlement:clone(receipt.ownerSettlement??receipt.settlement??null),settlementPerformed:Boolean(receipt.settlementPerformed),
    provider:stringOrNull(receipt.provider??receipt.providerId??provenance.providerId),providerProfileId:stringOrNull(provenance.providerProfileId),
    model:stringOrNull(receipt.model??receipt.modelId??provenance.modelId),resourceId:stringOrNull(receipt.resourceId??receipt.workerId??receipt.executionResourceId??provenance.workerId),
    escalationTarget:stringOrNull(receipt.escalationTarget),admission,validationStatus:clone(receipt.validationStatus??null),latencyMetadata:clone(receipt.latencyMetadata??null),
    explanation:receipt.explanation??null,authority:'READ_ONLY',authorityGranted:false,mutationAuthority:false,
  });
}

export function normalizePrecisionReceipt(receipt,choice=null){
  if(!receipt){
    const decision=choice?.precisionDecision;if(!decision)return null;
    if(decision.available===false||decision.failed===true||decision.fallback===true)return deepFreeze({
      kind:'NormalizedPrecisionReceipt',receiptId:null,state:CognitionStageState.DEGRADED,invoked:Boolean(decision.invoked),reason:decision.reason??decision.reasonCode??null,inputCount:decision.inputCount??null,outputCount:decision.resultCount??null,results:[],summaryOnly:true,sourceReceipt:'CognitiveChoiceReceipt',authority:'READ_ONLY',mutationAuthority:false,
    });
    if(decision.invoked===false||decision.state==='SKIPPED'||decision.status==='SKIPPED'||decision.skipped===true)return deepFreeze({
      kind:'NormalizedPrecisionReceipt',receiptId:null,state:CognitionStageState.SKIPPED,invoked:false,reason:decision.reason??decision.reasonCode??null,inputCount:decision.inputCount??null,outputCount:decision.resultCount??null,results:[],summaryOnly:true,sourceReceipt:'CognitiveChoiceReceipt',authority:'READ_ONLY',mutationAuthority:false,
    });
    if(decision.invoked===true)return deepFreeze({kind:'NormalizedPrecisionReceipt',receiptId:null,state:CognitionStageState.COMPLETE,invoked:true,reason:decision.reason??null,inputCount:decision.inputCount??null,outputCount:decision.resultCount??null,results:[],summaryOnly:true,sourceReceipt:'CognitiveChoiceReceipt',authority:'READ_ONLY',mutationAuthority:false});
    return null;
  }
  const rows=Array.isArray(receipt)?receipt:safeArray(receipt.results??receipt.rankings??receipt.precisionResults);
  const freshness=receipt.freshness??(rows.some(x=>x.freshness==='STALE')?'STALE':'FRESH');
  const state=freshness==='STALE'?CognitionStageState.STALE:receipt.invalid?CognitionStageState.INVALID:receipt.failed?CognitionStageState.DEGRADED:CognitionStageState.COMPLETE;
  return deepFreeze({
    kind:'NormalizedPrecisionReceipt',receiptId:stringOrNull(receipt.receiptId??receipt.id),state,invoked:true,reason:reasonOf(receipt),
    inputCount:Number(receipt.inputCount??receipt.candidateCount??rows.length),outputCount:Number(receipt.outputCount??receipt.admittedCount??rows.length),
    results:rows.map(row=>({candidateId:stringOrNull(row.candidateId),finalRank:row.finalRank??null,rawScore:row.rawScore??null,normalizedScore:row.normalizedScore??null,
      freshness:row.freshness??null,sourceRevisionRefs:safeArray(row.sourceRevisionIds),worldRevision:row.worldRevision??null,sceneRevision:row.sceneRevision??null,
      modelProfileId:stringOrNull(row.modelProfileId),modelProfileRevision:stringOrNull(row.modelProfileRevision),runtimeProfile:stringOrNull(row.runtimeProfile),latencyMs:row.latencyMs??null})),
    authority:'READ_ONLY',mutationAuthority:false,
  });
}

export function normalizeGatherReceipt(receipt){
  if(!receipt)return null;
  const rows=safeArray(receipt.results??receipt.items??receipt.entries).map(row=>{
    const freshness=String(row.freshness??row.route?.freshness??'FRESH').toUpperCase(),late=Boolean(row.late??row.route?.late);
    const accepted=row.accepted??row.route?.accepted??row.admitted??false;
    const rawStatus=String(row.status??row.disposition??(late?'LATE':freshness==='STALE'?'STALE':freshness==='INVALID'?'INVALID':accepted?'ADMITTED':'REJECTED')).toUpperCase();
    const status=['ADMITTED','STALE','LATE','REJECTED','INVALID'].includes(rawStatus)?rawStatus:(accepted?'ADMITTED':'REJECTED');
    return deepFreeze({resultId:stringOrNull(row.resultId??row.id??row.result?.id),capability:human(row.capability??row.resultType??row.result?.resultType??row.sourceSubsystem??row.result?.sourceSubsystem??'Result'),
      status,accepted:Boolean(accepted)&&!['STALE','LATE','INVALID','REJECTED'].includes(status),reason:reasonOf(row)??row.route?.reason??row.rejectionReason??row.result?.rejectionReason??row.result?.staleReason??null,
      evidenceRefs:safeArray(row.evidenceRefs??row.evidenceIds??row.result?.evidenceIds),freshness,late,sourceSubsystem:stringOrNull(row.sourceSubsystem??row.result?.sourceSubsystem),
      taskId:stringOrNull(row.taskId??row.result?.taskId),resourceId:stringOrNull(row.resourceId??row.workerId??row.result?.workerId),correlationId:stringOrNull(row.correlationId??row.result?.correlationId),
      sourceRevisionRefs:safeArray(row.sourceRevisionRefs??row.sourceRevisionIds??row.result?.sourceRevisionIds),worldRevision:row.worldRevision??row.result?.worldRevision??null,
      sceneRevision:row.sceneRevision??row.result?.sceneRevision??null,destination:stringOrNull(row.destination??row.route?.effectiveDestination??row.result?.destination)});
  });
  const counts={ADMITTED:0,STALE:0,LATE:0,REJECTED:0,INVALID:0};for(const row of rows)counts[row.status]=(counts[row.status]??0)+1;
  return deepFreeze({
    kind:'NormalizedGatherReceipt',receiptId:stringOrNull(receipt.receiptId??receipt.id??receipt.gatherId),turnId:stringOrNull(receipt.turnId),generationId:stringOrNull(receipt.generationId),
    correlationId:stringOrNull(receipt.correlationId),state:receipt.failed?CognitionStageState.DEGRADED:CognitionStageState.COMPLETE,counts,results:rows,
    admittedEvidenceRefs:safeArray(receipt.admittedEvidenceRefs??receipt.generationEvidenceRefs??rows.filter(x=>x.accepted).flatMap(x=>x.evidenceRefs)),
    rejectedResultIds:safeArray(receipt.rejectedResultIds??rows.filter(x=>!x.accepted).map(x=>x.resultId).filter(Boolean)),
    reason:reasonOf(receipt),authority:'READ_ONLY',mutationAuthority:false,
  });
}

export function normalizeLoreStatus(model){
  if(!model)return null;
  return deepFreeze({
    kind:'NormalizedLoreStatus',sourceKind:model.kind??'LoreStatusReadModel',sourceEntryCount:numberOrNull(model.sourceEntryCount??model.sourceEntries??model.entryCount),
    learnedRepresentationCount:numberOrNull(model.learnedRepresentationCount??model.representationCount),learnedState:model.learnedState??model.representationsState??model.studyState??null,
    indexState:model.indexState??model.indexHealth??null,lastRevision:stringOrNull(model.lastRevision??model.revision??model.sourceRevision),
    sourceRevisionRefs:safeArray(model.sourceRevisionRefs),provenanceRefs:safeArray(model.provenanceRefs),health:clone(model.health??null),authority:'READ_ONLY',mutationAuthority:false,
  });
}

export function buildLiveCognitionPath({
  scene=null,hotCognition=null,choice=null,scatter=null,sensory=null,truth=null,corrective=null,jev=null,precision=null,gather=null,seal=null,promptPlan=null,lore=null,
  modes={},
}={}){
  const stages=[];
  stages.push(stageScene(scene,modes.scene));
  stages.push(stageChoice(choice,modes.choice));
  stages.push(stageScatter(scatter,choice,modes.scatter));
  stages.push(stageSensory(sensory,choice,modes.sensory));
  stages.push(stageRetrieval(truth,corrective,choice,modes.truth));
  stages.push(stageTruth(truth,choice,modes.truth));
  stages.push(stageJev(jev,modes.jev));
  stages.push(stagePrecision(precision,modes.precision));
  stages.push(stageGather(gather,choice,modes.gather));
  stages.push(stageSeal(seal,modes.seal));
  stages.push(stagePromptPlan(promptPlan,modes.promptPlan));
  const available=stages.filter(x=>x.state!==CognitionStageState.UNAVAILABLE);
  const degraded=available.some(x=>[CognitionStageState.DEGRADED,CognitionStageState.STALE,CognitionStageState.INVALID,CognitionStageState.FAILED].includes(x.state))||stages.some(x=>x.state===CognitionStageState.UNAVAILABLE&&x.receiptRef);
  const working=available.some(x=>x.state===CognitionStageState.ACTIVE);
  const availableModes=Object.values(modes??{}).filter(x=>x&&x!==ProductDataMode.UNAVAILABLE);const fixtureOnly=availableModes.length>0&&availableModes.every(x=>x===ProductDataMode.FIXTURE);
  const source=createProductSourceStatus({
    mode:available.length?(fixtureOnly?ProductDataMode.FIXTURE:degraded?ProductDataMode.DEGRADED:ProductDataMode.LIVE):ProductDataMode.UNAVAILABLE,
    health:available.length?(degraded?Wave6Health.DEGRADED:working?Wave6Health.WORKING:Wave6Health.READY):Wave6Health.UNAVAILABLE,
    label:'Live Brain Cognition',impact:available.length?(degraded?'Brain cognition is visible with contained degraded/stale/invalid work.':'Recorded cognitive path is available for inspection.'):'No live cognitive-path producer is connected.',
    producer:'Wave8 cognitive receipt adapters',
  });
  return deepFreeze({
    kind:'LiveBrainCognitionPath',source,turnId:first(choice?.turnId,gather?.turnId,seal?.turnId),generationId:first(choice?.generationId,gather?.generationId,promptPlan?.generationId),
    correlationId:first(choice?.correlationId,gather?.correlationId,seal?.correlationId),scene:clone(scene),hotCognition:clone(hotCognition),choice:clone(choice),scatter:clone(scatter),
    sensory:clone(sensory),truth:clone(truth),corrective:clone(corrective),jev:clone(jev),precision:clone(precision),gather:clone(gather),seal:clone(seal),promptPlan:clone(promptPlan),lore:clone(lore),
    stages,summary:buildNormalSummary({choice,sensory,truth,jev,precision,gather,seal,promptPlan}),authority:'READ_ONLY',mutationAuthority:false,
  });
}

export function explainCognitionWhy(item){
  if(!item)return deepFreeze({kind:'CognitionWhy',available:false,summary:'No cognitive item selected.',facts:[]});
  const facts=[];
  const reason=item.reason??item.reasonCode??null;if(reason)facts.push(`Recorded reason: ${reason}.`);
  if(item.disposition)facts.push(`Disposition: ${item.disposition}.`);
  if(item.state)facts.push(`Recorded state: ${item.state}.`);
  if(item.status)facts.push(`Recorded status: ${item.status}.`);
  if(item.retrievalQuality)facts.push(`Retrieval quality: ${item.retrievalQuality}.`);
  if(item.classification)facts.push(`Truth classification: ${item.classification}.`);
  if(item.outcome)facts.push(`Jev outcome: ${item.outcome}.`);
  if(item.freshness)facts.push(`Freshness: ${item.freshness}.`);
  if(item.late===true)facts.push('Completed after the applicable publication boundary.');
  if(item.accepted===false)facts.push('Not admitted to this generation.');
  return deepFreeze({kind:'CognitionWhy',available:facts.length>0,summary:facts.join(' ')||'The owning producer did not publish a reason for this item.',facts,authority:'READ_ONLY'});
}

export function sourceModeForReceipt(value,explicitMode=null){
  if(explicitMode)return explicitMode;
  return value?ProductDataMode.LIVE:ProductDataMode.UNAVAILABLE;
}

function decisionFromJob(job,admitted,skipped,reasonCodes){
  if(admitted.has(job))return deepFreeze({invoked:true,state:'ADMITTED',reason:null,reasonCodes:safeArray(reasonCodes)});
  if(skipped.has(job))return deepFreeze({invoked:false,state:'SKIPPED',reason:null,reasonCodes:safeArray(reasonCodes)});
  return null;
}
function normalizeTruthChoice(value,reasonCodes){
  if(!value)return null;
  return deepFreeze({invoked:value.invoked==null?null:Boolean(value.invoked),state:value.skipped?'SKIPPED':value.invoked?'COMPLETE':null,skipped:Boolean(value.skipped),
    considered:value.considered==null?null:Boolean(value.considered),reason:null,reasonCodes:safeArray(reasonCodes),outcomeCounts:clone(value.outcomeCounts??{}),
    admittedCandidateIds:safeArray(value.admittedCandidateIds),supportCandidateIds:safeArray(value.supportCandidateIds)});
}
function normalizeJevChoice(value,reasonCodes){
  if(!value)return null;
  return deepFreeze({invoked:value.invoked==null?null:Boolean(value.invoked),state:value.skipped?'SKIPPED':value.unavailable?'UNAVAILABLE':value.invoked?'INVOKED':null,
    skipped:Boolean(value.skipped),unavailable:Boolean(value.unavailable),abstained:Boolean(value.abstained),action:value.action??null,
    reason:value.reason??null,reasonDetail:value.reasonDetail??null,reasonCodes:safeArray(reasonCodes),alternativeCount:Number(value.alternativeCount??0),decisionRevision:value.decisionRevision??null,resultRef:value.resultRef??null});
}
function normalizePrecisionChoice(value,reasonCodes,candidateCounts){
  if(!value)return null;
  return deepFreeze({invoked:value.invoked==null?null:Boolean(value.invoked),state:value.skipped?'SKIPPED':value.failed||value.fallback?'DEGRADED':value.invoked?'COMPLETE':null,
    skipped:Boolean(value.skipped),required:value.required==null?null:Boolean(value.required),available:value.available==null?null:Boolean(value.available),
    fallback:Boolean(value.fallback),failed:Boolean(value.failed),reason:value.reason??null,reasonCodes:safeArray(reasonCodes),
    inputCount:Number(candidateCounts?.truthAdmitted??0),resultCount:Number(value.resultCount??candidateCounts?.precisionAdmitted??0)});
}
function choiceJevSummary(decision,outcome,serviceStatus){
  return deepFreeze({kind:'NormalizedJevDecisionReceipt',receiptId:stringOrNull(decision.resultRef),state:CognitionStageState.COMPLETE,outcome,invoked:true,
    reason:decision.reason??null,reasonCodes:safeArray(decision.reasonCodes),decisionType:null,decisionShape:null,decisionCode:null,classification:null,serviceStatus,
    options:[],selectedOptionIds:[],rejectedOptionIds:[],evidenceRefs:[],unresolvedFactors:[],revisionFence:null,confidence:null,
    requiresOwnerSettlement:null,requiresOperatorReview:outcome===JevOutcome.REQUEST_OPERATOR,ownerSettlement:null,settlementPerformed:false,
    provider:null,model:null,resourceId:null,admission:null,explanation:null,authority:'READ_ONLY',mutationAuthority:false});
}
function machineJob(label){return String(label??'').trim().toUpperCase().replace(/[\s-]+/g,'_');}
function normalizeJobCandidate(row,index){if(typeof row==='string')return deepFreeze({jobId:null,capability:human(row),reason:null,priority:null,expectedValue:null,resourceCost:null,freshnessRequirement:null,deadlineClass:null,index});return deepFreeze({jobId:stringOrNull(row.jobId??row.taskId??row.id),capability:human(row.capability??row.jobType??row.taskType??row.name??row.kind??('Candidate '+(index+1))),reason:reasonOf(row),priority:row.priority??null,expectedValue:row.expectedValue??null,resourceCost:clone(row.resourceCost??null),freshnessRequirement:row.freshnessRequirement??null,deadlineClass:row.deadlineClass??null,index});}
function normalizeJobDecision(row,disposition){if(typeof row==='string')return deepFreeze({jobId:null,capability:human(row),disposition,reason:null,resourceId:null,provider:null,model:null,state:null,expectedValue:null,resourceCost:null,freshnessRequirement:null,deadlineClass:null});return deepFreeze({jobId:stringOrNull(row.jobId??row.taskId??row.id),capability:human(row.capability??row.jobType??row.taskType??row.name??row.kind??'Cognitive job'),disposition,reason:reasonOf(row),resourceId:stringOrNull(row.resourceId??row.workerId??row.executionResourceId),provider:stringOrNull(row.provider??row.providerId),model:stringOrNull(row.model??row.modelId),state:row.state??row.status??null,expectedValue:row.expectedValue??null,resourceCost:clone(row.resourceCost??null),freshnessRequirement:row.freshnessRequirement??null,deadlineClass:row.deadlineClass??null});}
function normalizeResource(row){if(typeof row==='string')return deepFreeze({resourceId:row,jobs:[]});return deepFreeze({resourceId:stringOrNull(row.resourceId??row.workerId??row.id),provider:stringOrNull(row.provider??row.providerId),model:stringOrNull(row.model??row.modelId),jobs:safeArray(row.jobs??row.taskIds).map(String),state:row.state??row.status??null});}
function normalizeOptionalDecision(value){if(value==null)return null;if(typeof value==='boolean')return deepFreeze({invoked:value,state:value?'INVOKED':'SKIPPED',reason:null});if(typeof value==='string')return deepFreeze({invoked:value!=='SKIPPED',state:value,reason:null});return deepFreeze({invoked:value.invoked==null?null:Boolean(value.invoked),state:value.state??value.status??null,reason:reasonOf(value),reasonCode:value.reasonCode??null});}
function normalizeSensoryCandidate(row){return deepFreeze({candidateId:stringOrNull(row.candidateId??row.id),evidenceIdentity:stringOrNull(row.evidenceIdentity),channelCount:safeArray(row.channelNominations??row.nominatedBy).length,channels:safeArray(row.channelNominations??row.nominatedBy).map(x=>typeof x==='string'?x:x.channelId??x.id).filter(Boolean),authority:row.authorityClass??row.authority??'UNKNOWN',truthStatusHint:row.truthStatusHint??row.truthStatus??'UNKNOWN',freshness:row.freshness??'UNKNOWN',fusionScore:row.fusionScore??null,sourceRevisionRefs:safeArray(row.sourceRevisionRefs),evidenceRefs:safeArray(row.evidenceRefs),claimRefs:safeArray(row.claimRefs??row.claimIds),graphMetadata:clone(row.graphMetadata??null),rankSignals:clone(row.rankSignals??row.scoreSignals??{}),representationText:row.representationText==null?null:String(row.representationText).slice(0,1600),artifactRef:clone(row.artifactRef??null)});}
function stageScene(scene,mode){if(!scene)return createStage({id:CognitionStageId.SCENE,label:'Scene',state:CognitionStageState.UNAVAILABLE,summary:'Scene Intelligence unavailable.'});const health=normalizeWave6Health(scene.health?.state??scene.source?.health??'READY',{fallback:Wave6Health.READY});return createStage({id:CognitionStageId.SCENE,label:'Scene',state:health===Wave6Health.STALE?CognitionStageState.STALE:health===Wave6Health.DEGRADED?CognitionStageState.DEGRADED:health===Wave6Health.UNAVAILABLE?CognitionStageState.UNAVAILABLE:CognitionStageState.COMPLETE,summary:`${scene.title??scene.location??scene.sceneId??'Current Scene'}${scene.revision!=null?` · r${scene.revision}`:''}`,details:{mode}});}
function stageChoice(x,mode){if(!x)return createStage({id:CognitionStageId.CHOICE,label:'Choice',state:CognitionStageState.UNAVAILABLE,summary:'Cognitive Choice receipt unavailable.'});return createStage({id:CognitionStageId.CHOICE,label:'Choice',state:mapStageState(x.status),summary:x.brainChoice?`Brain chose: ${x.brainChoice}`:`${x.admitted.length} jobs admitted`,reason:x.reason,receiptRef:x.receiptId,details:{mode}});}
function stageScatter(x,choice,mode){if(!x){const d=choice?.scatterDecision;if(isExplicitSkip(d))return createStage({id:CognitionStageId.SCATTER,label:'Scatter',state:CognitionStageState.SKIPPED,summary:'Skipped',reason:d.reason??d.reasonCode??null});return createStage({id:CognitionStageId.SCATTER,label:'Scatter',state:CognitionStageState.UNAVAILABLE,summary:'Scatter execution receipt unavailable.'});}const failed=x.jobs.some(j=>['FAILED','ERROR','INVALID'].includes(String(j.state).toUpperCase()));const active=x.jobs.some(j=>['ACTIVE','RUNNING','QUEUED'].includes(String(j.state).toUpperCase()));return createStage({id:CognitionStageId.SCATTER,label:'Scatter',state:failed?CognitionStageState.DEGRADED:active?CognitionStageState.ACTIVE:CognitionStageState.COMPLETE,summary:`${x.jobs.length} logical jobs across ${x.resourceCount} execution resource${x.resourceCount===1?'':'s'}`,receiptRef:x.receiptId,details:{mode}});}
function stageSensory(x,choice,mode){if(!x){const d=choice?.sensoryDecision??choice?.retrievalDecision;if(isExplicitSkip(d))return createStage({id:CognitionStageId.SENSORY,label:'Sensory',state:CognitionStageState.SKIPPED,summary:'Skipped',reason:d.reason??d.reasonCode??null});return createStage({id:CognitionStageId.SENSORY,label:'Sensory',state:CognitionStageState.UNAVAILABLE,summary:'Sensory/Candidate Bus receipt unavailable.'});}return createStage({id:CognitionStageId.SENSORY,label:'Sensory',state:x.state,summary:`${x.inputNominationCount} nominations → ${x.uniqueCandidateCount} unique`,receiptRef:x.receiptId,details:{mode}});}
function stageRetrieval(truth,corrective,choice,mode){if(!truth){const d=choice?.retrievalDecision;if(isExplicitSkip(d))return createStage({id:CognitionStageId.RETRIEVAL_QUALITY,label:'Retrieval',state:CognitionStageState.SKIPPED,summary:'Skipped',reason:d.reason??d.reasonCode??null});return createStage({id:CognitionStageId.RETRIEVAL_QUALITY,label:'Retrieval',state:CognitionStageState.UNAVAILABLE,summary:'Retrieval-quality receipt unavailable.'});}let suffix='';if(truth.retrievalQuality==='MIXED'&&corrective){suffix=corrective.executed?' · corrected once':corrective.state===CognitionStageState.SKIPPED?' · correction skipped':'';}return createStage({id:CognitionStageId.RETRIEVAL_QUALITY,label:'Retrieval',state:truth.retrievalQuality?CognitionStageState.COMPLETE:CognitionStageState.UNAVAILABLE,summary:`${truth.retrievalQuality??'UNAVAILABLE'}${suffix}`,reason:truth.reason,receiptRef:truth.receiptId,details:{mode}});}
function stageTruth(x,choice,mode){if(!x){const d=choice?.truthDecision;if(isExplicitSkip(d))return createStage({id:CognitionStageId.TRUTH,label:'Truth',state:CognitionStageState.SKIPPED,summary:'Skipped',reason:d.reason??d.reasonCode??null});return createStage({id:CognitionStageId.TRUTH,label:'Truth',state:CognitionStageState.UNAVAILABLE,summary:'Truth assessment unavailable.'});}const rows=Object.entries(x.counts).filter(([,n])=>n>0).map(([k,n])=>`${n} ${k}`);return createStage({id:CognitionStageId.TRUTH,label:'Truth',state:CognitionStageState.COMPLETE,summary:rows.join(' · ')||'No classified candidates',receiptRef:x.receiptId,details:{mode}});}
function stageJev(x,mode){if(!x)return createStage({id:CognitionStageId.JEV,label:'Jev',state:CognitionStageState.UNAVAILABLE,summary:'Jev decision receipt unavailable.'});return createStage({id:CognitionStageId.JEV,label:'Jev',state:x.state,summary:x.state===CognitionStageState.UNAVAILABLE?'UNAVAILABLE · ambiguity preserved':x.outcome==='SKIPPED'?'Skipped':x.outcome,reason:x.reason,receiptRef:x.receiptId,details:{mode}});}
function stagePrecision(x,mode){if(!x)return createStage({id:CognitionStageId.PRECISION,label:'Precision',state:CognitionStageState.UNAVAILABLE,summary:'Precision receipt unavailable.'});return createStage({id:CognitionStageId.PRECISION,label:'Precision',state:x.state,summary:x.state===CognitionStageState.SKIPPED?'Skipped':`${x.inputCount??x.results.length} candidates → ${x.outputCount??x.results.length}`,reason:x.reason,receiptRef:x.receiptId,details:{mode}});}
function stageGather(x,choice,mode){if(!x){const d=choice?.gatherDecision;if(isExplicitSkip(d))return createStage({id:CognitionStageId.GATHER,label:'Gather',state:CognitionStageState.SKIPPED,summary:'Skipped',reason:d.reason??d.reasonCode??null});return createStage({id:CognitionStageId.GATHER,label:'Gather',state:CognitionStageState.UNAVAILABLE,summary:'Gather receipt unavailable.'});}return createStage({id:CognitionStageId.GATHER,label:'Gather',state:x.state,summary:`${x.counts.ADMITTED} admitted · ${x.counts.STALE} stale · ${x.counts.LATE} late · ${x.counts.REJECTED+x.counts.INVALID} rejected/invalid`,reason:x.reason,receiptRef:x.receiptId,details:{mode}});}
function stageSeal(x,mode){if(!x)return createStage({id:CognitionStageId.CONTEXT_SEAL,label:'Seal',state:CognitionStageState.UNAVAILABLE,summary:'Context Seal unavailable.'});const admitted=x.effectiveAdmittedResultIds??x.admittedResultIds??[];const conflict=x.coherenceConflictIds?.length>0;return createStage({id:CognitionStageId.CONTEXT_SEAL,label:'Seal',state:x.sealedState===false?CognitionStageState.FAILED:conflict?CognitionStageState.DEGRADED:CognitionStageState.COMPLETE,summary:x.sealedState===false?'UNSEALED':conflict?'SEALED receipt has admission conflict · '+admitted.length+' safely displayable':`SEALED · ${x.admittedEvidenceCount??admitted.length} admitted`,receiptRef:x.sealId,details:{mode}});}
function stagePromptPlan(x,mode){if(!x)return createStage({id:CognitionStageId.PROMPT_PLAN,label:'PromptPlan',state:CognitionStageState.UNAVAILABLE,summary:'PromptPlan unavailable.'});const source=x.source??null;return createStage({id:CognitionStageId.PROMPT_PLAN,label:'PromptPlan',state:source?.mode===ProductDataMode.DEGRADED?CognitionStageState.DEGRADED:CognitionStageState.COMPLETE,summary:`${x.totalTokens??x.usedOrEstimatedTokens??0} tokens · ${x.promptPlanId??'plan'}`,receiptRef:x.promptPlanId,details:{mode}});}
function buildNormalSummary({choice,sensory,truth,jev,precision,gather,seal,promptPlan}){return deepFreeze({brainChoice:choice?.brainChoice??null,jobs:choice?{candidate:choice.candidateJobs.length,admitted:choice.admitted.length,skipped:choice.skipped.length,deferred:choice.deferred.length}:null,sensory:sensory?{nominations:sensory.inputNominationCount,unique:sensory.uniqueCandidateCount}:null,retrievalQuality:truth?.retrievalQuality??null,truthCounts:truth?.counts??null,jev:jev?{state:jev.state,outcome:jev.outcome}:null,precision:precision?{state:precision.state,input:precision.inputCount,output:precision.outputCount}:null,gather:gather?.counts??null,seal:seal?{sealed:Boolean(seal.sealedState),admitted:seal.admittedEvidenceCount??(seal.effectiveAdmittedResultIds??seal.admittedResultIds).length,stale:seal.staleResultIds.length,late:seal.lateResultIds.length,rejected:seal.rejectedResultIds.length,coherenceConflicts:seal.coherenceConflictIds?.length??0}:null,promptPlan:promptPlan?{id:promptPlan.promptPlanId,tokens:promptPlan.totalTokens??promptPlan.usedOrEstimatedTokens??null}:null});}
function mapStageState(value){const x=String(value??'COMPLETE').toUpperCase();if(STATES.has(x))return x;if(['READY','DONE','SUCCESS','SUCCEEDED','DECIDED'].includes(x))return CognitionStageState.COMPLETE;if(['RUNNING','WORKING','QUEUED'].includes(x))return CognitionStageState.ACTIVE;if(['ERROR'].includes(x))return CognitionStageState.FAILED;return CognitionStageState.COMPLETE;}
function stateHealth(state){if(state===CognitionStageState.ACTIVE)return Wave6Health.WORKING;if([CognitionStageState.DEGRADED,CognitionStageState.STALE].includes(state))return Wave6Health.DEGRADED;if([CognitionStageState.INVALID,CognitionStageState.FAILED].includes(state))return Wave6Health.BLOCKED;if(state===CognitionStageState.UNAVAILABLE)return Wave6Health.UNAVAILABLE;return Wave6Health.READY;}
function humanChoice(v){if(Array.isArray(v))return v.map(human).join(' + ');return v==null?null:human(v);}
function human(v){const raw=String(v??'').trim();if(!raw)return '';const machine=/[_:-]/.test(raw)||raw===raw.toUpperCase();const spaced=raw.replace(/[_:-]+/g,' ');return machine?spaced.toLowerCase().replace(/\b\w/g,m=>m.toUpperCase()):spaced;}
function isExplicitSkip(v){return Boolean(v&&(v.invoked===false||String(v.state??v.status??'').toUpperCase()==='SKIPPED'));}
function numberOrNull(v){if(v==null)return null;const n=Number(v);return Number.isFinite(n)?n:null;}
function first(...v){return v.find(x=>x!=null)??null;}
