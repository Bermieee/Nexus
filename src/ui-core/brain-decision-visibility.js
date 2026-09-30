import { createButton, createKeyValue, element, makeBadge } from './primitives.js';

const MAX_CANDIDATES=32;
const MAX_DECISIONS=32;
const MAX_OBLIGATIONS=32;
const MAX_STAGES=24;
const MAX_REFS=24;
const REQUIRED_STAGES=['cognitiveChoice','sensory','truth','gather','contextSeal','promptPlan','contextReceipt','compiledDelivery','delivery'];
const BLOCKED_KEYS=/^(?:rawprompt|prompt|prompttext|messages|story|storytext|lore|lorebody|content|body|response|responsebody|reasoning|hiddenreasoning|chainofthought|apikey|api_key|authorization|credential|credentials|password|secret|access_token|refresh_token)$/i;

const arr=(value)=>Array.isArray(value)?value:[];
const uniq=(value,max=MAX_REFS)=>[...new Set(arr(value).filter(v=>v!=null).map(String))].slice(0,max);
const text=(value,max=240)=>value==null?null:String(value).slice(0,max);
const boolOrNull=(value)=>value==null?null:Boolean(value);
const clone=(value)=>value==null?value:structuredClone(value);

export class BrainDecisionVisibilityAdapter{
  constructor({bindings={},selectionProvider=()=>({})}={}){
    this.bindings=bindings??{};
    this.selectionProvider=typeof selectionProvider==='function'?selectionProvider:()=>({});
    this.readSelected=reader(bindings,['readSelectedTurnReceipt']);
    this.readSensory=reader(bindings,['readSensoryTrace','readCandidateBusEnvelope']);
    this.readChoice=reader(bindings,['readCognitiveChoice','readCognitiveChoiceReceipt']);
    this.readTruth=reader(bindings,['readTruth','readTruthAssessment']);
    this.readGather=reader(bindings,['readGather','readGatherReceipt']);
    this.readSeal=reader(bindings,['readContextSeal','readContextSealReceipt','readSealReceipt']);
    this.readPlan=reader(bindings,['readPromptPlan']);
    this.readContext=reader(bindings,['readContextReceipt']);
    this.readDelivery=reader(bindings,['readPromptDeliveryReceipt']);
  }

  capabilities(){
    return Object.freeze({
      selectedTurn:Boolean(this.readSelected),sensory:Boolean(this.readSensory),choice:Boolean(this.readChoice),truth:Boolean(this.readTruth),
      gather:Boolean(this.readGather),seal:Boolean(this.readSeal),promptPlan:Boolean(this.readPlan),contextReceipt:Boolean(this.readContext),delivery:Boolean(this.readDelivery),
      mutation:false,
    });
  }

  read(selection=null){
    const expected=normalizeSelection(selection??this.selectionProvider?.()??{});
    if(!expected.chatId||!expected.turnId||!expected.generationId){
      return freeze({
        kind:'BrainDecisionVisibilityReadModel',contractVersion:1,selection:expected,state:'WAITING_FOR_SELECTED_TURN',
        identityState:'INCOMPLETE_SELECTION',stages:[],sensoryNominations:[],choiceDecisions:[],lifecycleObligations:[],candidateFlow:[],
        delivery:emptyDelivery(),missingReceipts:['NativeBrainSelectedTurnReceipt'],errors:[],
        safety:safety(),
      });
    }

    const errors=[];
    const selectedResult=safeOwnerRead(this.readSelected,expected,'NativeBrainSelectedTurnReceipt',errors,{requireIdentity:true});
    const selected=selectedResult.value;
    if(!selected){
      return freeze({
        kind:'BrainDecisionVisibilityReadModel',contractVersion:1,selection:expected,state:'NO_EVIDENCE',
        identityState:selectedResult.identityState??'NO_SELECTED_TURN_RECEIPT',stages:[],sensoryNominations:[],choiceDecisions:[],lifecycleObligations:[],candidateFlow:[],
        delivery:emptyDelivery(),missingReceipts:['NativeBrainSelectedTurnReceipt'],errors,
        safety:safety(),
      });
    }

    const anchor=normalizeSelection(selected);
    const sensory=safeOwnerRead(this.readSensory,anchor,'Sensory',errors).value;
    const choice=safeOwnerRead(this.readChoice,anchor,'CognitiveChoice',errors).value;
    const truth=safeOwnerRead(this.readTruth,anchor,'Truth',errors).value;
    const gather=safeOwnerRead(this.readGather,anchor,'Gather',errors).value;
    const seal=safeOwnerRead(this.readSeal,anchor,'ContextSeal',errors).value;
    const plan=safeOwnerRead(this.readPlan,anchor,'PromptPlan',errors).value;
    const context=safeOwnerRead(this.readContext,anchor,'ContextReceipt',errors).value;
    const delivery=safeOwnerRead(this.readDelivery,anchor,'PromptDeliveryReceipt',errors).value;

    const choiceDecisions=normalizeChoice(choice).slice(0,MAX_DECISIONS);
    const sensoryNominations=normalizeSensory(sensory).slice(0,MAX_CANDIDATES);
    const stages=normalizeStages(selected,choiceDecisions).slice(0,MAX_STAGES);
    const lifecycleObligations=normalizeLifecycle(selected,choiceDecisions).slice(0,MAX_OBLIGATIONS);
    const deliveryModel=normalizeDelivery(selected,{plan,context,delivery});
    const candidateFlow=sensoryNominations.map(candidate=>candidateProgress(candidate,{truth,gather,seal,plan,delivery})).slice(0,MAX_CANDIDATES);
    const missingReceipts=stages.filter(row=>REQUIRED_STAGES.includes(row.stage)&&['NO_EVIDENCE','UNAVAILABLE'].includes(row.state)).map(row=>row.stage);

    return freeze({
      kind:'BrainDecisionVisibilityReadModel',contractVersion:1,selection:anchor,state:'READY',identityState:'EXACT_SELECTED_TURN',
      sourceRevisions:safeSourceRevisions(selected.sourceRevisions),stages,sensoryNominations,choiceDecisions,lifecycleObligations,candidateFlow,
      delivery:deliveryModel,missingReceipts:uniq(missingReceipts,MAX_STAGES),errors,
      optionalExecution:{
        jev:optionalExecution(selected?.producers?.jev),
        sidecar:optionalExecution(selected?.producers?.sidecar),
        vectoring:optionalExecution(selected?.producers?.vectoring),
        precision:optionalExecution(selected?.producers?.precision),
      },
      safety:safety(),
    });
  }
}

export function renderBrainDecisionExplanation(doc,model,{title='Brain decision evidence',compact=false,onInspect=null}={}){
  const root=element(doc,'section',{className:'a52-card a52-brain-decision-visibility',attrs:{'aria-label':title}});
  const head=element(doc,'div',{className:'a52-wave13-section-head'});
  head.append(element(doc,compact?'h3':'h2',{text:title}),makeBadge(doc,model?.state==='READY'?'SELECTED TURN':'NO EVIDENCE',model?.state==='READY'?'ready':'warning'));
  if(onInspect)head.append(createButton(doc,{label:'Inspect Brain decisions',size:'sm',variant:'inspect',onPress:onInspect}));
  root.append(head);
  if(!model||model.state!=='READY'){
    root.append(stateMessage(doc,'Selected-turn Brain evidence unavailable',model?.identityState==='IDENTITY_MISMATCH'?'A receipt belonged to a different chat / turn / generation and was fenced out.':'No exact selected-turn owner receipt is available. The UI will not reconstruct Brain decisions from nearby activity.','warning'));
    return root;
  }
  const s=model.selection??{};
  root.append(createKeyValue(doc,[
    {key:'Chat / turn / generation',value:[s.chatId,s.turnId,s.generationId].map(x=>x??'—').join(' / ')},
    {key:'Correlation',value:s.correlationId??'not published'},
    {key:'Missing expected receipts',value:model.missingReceipts?.length?model.missingReceipts.join(', '):'None'},
  ]));

  root.append(deliveryView(doc,model.delivery));

  const choice=element(doc,'section',{className:'a52-brain-decision-block'});
  choice.append(element(doc,'h3',{text:'Cognitive Choice'}));
  if(model.choiceDecisions?.length){
    const list=element(doc,'div',{className:'a52-brain-decision-list'});
    for(const row of model.choiceDecisions.slice(0,compact?12:MAX_DECISIONS)){
      const item=element(doc,'div',{className:'a52-brain-decision-row'});
      item.append(makeBadge(doc,row.disposition,statusFor(row.disposition)),element(doc,'strong',{text:row.capability}),element(doc,'span',{className:'a52-muted',text:row.reason??'Reason not published'}));list.append(item);
    }
    choice.append(list);
  }else choice.append(stateMessage(doc,'Choice receipt missing','No exact CognitiveChoiceReceipt appeared for this selected turn.','warning'));
  root.append(choice);

  const sensory=element(doc,'section',{className:'a52-brain-decision-block'});
  sensory.append(element(doc,'h3',{text:'Sensory nominations'}));
  if(model.sensoryNominations?.length){
    const list=element(doc,'div',{className:'a52-brain-decision-list'});
    for(const row of model.sensoryNominations.slice(0,compact?10:MAX_CANDIDATES)){
      const item=element(doc,'div',{className:'a52-brain-candidate-row'});
      item.append(element(doc,'strong',{text:row.candidateId??'candidate'}),element(doc,'span',{text:row.channels.length?row.channels.join(', '):'channel not published'}),element(doc,'code',{text:row.sourceRevisionRefs.length?row.sourceRevisionRefs.join(', '):'source revision not published'}));
      list.append(item);
    }
    sensory.append(list);
  }else sensory.append(stateMessage(doc,'No Sensory nominations','No exact Candidate Bus / Sensory nominations are available for this selected turn.','historical'));
  root.append(sensory);

  const flow=element(doc,'section',{className:'a52-brain-decision-block'});
  flow.append(element(doc,'h3',{text:'Candidate path'}));
  if(model.candidateFlow?.length){
    const list=element(doc,'div',{className:'a52-brain-candidate-flow'});
    for(const row of model.candidateFlow.slice(0,compact?10:MAX_CANDIDATES)){
      const item=element(doc,'div',{className:'a52-brain-candidate-flow__row'});
      item.append(element(doc,'strong',{text:row.candidateId??'candidate'}));
      for(const stage of ['sensory','truth','gather','seal','plannedPrompt','observedHost'])item.append(makeBadge(doc,human(stage)+': '+row[stage],statusFor(row[stage])));
      list.append(item);
    }
    flow.append(list);
  }else flow.append(stateMessage(doc,'Candidate path unavailable','Candidate-level progression cannot be shown without Sensory candidate identities.','historical'));
  root.append(flow);

  const lifecycle=element(doc,'section',{className:'a52-brain-decision-block'});
  lifecycle.append(element(doc,'h3',{text:'Lifecycle obligations'}));
  if(model.lifecycleObligations?.length){
    const list=element(doc,'div',{className:'a52-brain-decision-list'});
    for(const row of model.lifecycleObligations.slice(0,compact?10:MAX_OBLIGATIONS)){
      const item=element(doc,'div',{className:'a52-brain-decision-row'});
      item.append(makeBadge(doc,row.state,statusFor(row.state)),element(doc,'strong',{text:row.taskType??row.taskId??'obligation'}),element(doc,'span',{className:'a52-muted',text:row.reasonCode??'Reason not published'}));list.append(item);
    }
    lifecycle.append(list);
  }else lifecycle.append(stateMessage(doc,'Lifecycle evidence missing','No selected-turn runtime causal receipt was published. Logical Choice admission is not shown as execution.','warning'));
  root.append(lifecycle);

  const optional=element(doc,'section',{className:'a52-brain-decision-block'});
  optional.append(element(doc,'h3',{text:'Optional execution proof'}));
  for(const key of ['jev','sidecar','vectoring','precision']){
    const row=model.optionalExecution?.[key]??{};
    optional.append(createKeyValue(doc,[
      {key:human(key),value:[row.state??'NO_EVIDENCE',row.physicalAttempt===true?'physical attempt proven':row.physicalAttempt===false?'no physical attempt':'physical attempt not proven',row.ownerAccepted===true?'owner accepted':row.ownerAccepted===false?'owner rejected':'owner acceptance not published'].join(' · ')},
    ]));
  }
  root.append(optional);
  if(model.errors?.length)root.append(stateMessage(doc,'Fenced producer reads',model.errors.map(x=>x.stage+': '+x.code).join(' · '),'warning'));
  root.append(element(doc,'p',{className:'a52-muted',text:'Metadata-only view. Raw prompts, story/Lore bodies, credentials, provider bodies, and hidden reasoning are never rendered here.'}));
  return root;
}

function normalizeChoice(receipt){
  if(!receipt)return[];
  const rows=arr(receipt.functionDecisions??receipt.cognitiveFunctionDecisions);
  if(rows.length)return rows.map((row,index)=>({
    id:text(row?.id??row?.jobId??row?.taskId??'choice:'+index,160),
    capability:human(row?.capability??row?.jobType??row?.taskType??row?.name??'Cognitive job'),
    disposition:normalizeDisposition(row?.disposition??row?.state??row?.status),
    reason:text(row?.reason??row?.reasonCode??row?.metadata?.reason??arr(row?.reasonCodes)[0],300),
    reasonCodes:uniq(row?.reasonCodes??(row?.reasonCode?[row.reasonCode]:[]),12),
  }));
  const out=[];
  for(const [key,disposition] of [['admittedJobs','ADMITTED'],['skippedJobs','SKIPPED'],['deferredJobs','DEFERRED'],['rejectedJobs','REJECTED']]){
    for(const value of arr(receipt[key]))out.push({id:null,capability:human(typeof value==='string'?value:value?.capability??value?.jobType??'Cognitive job'),disposition,reason:text(value?.reason??value?.reasonCode??arr(receipt.reasonCodes)[0],300),reasonCodes:uniq(value?.reasonCodes??receipt.reasonCodes,12)});
  }
  return out;
}

function normalizeSensory(receipt){
  if(!receipt)return[];
  const candidates=arr(receipt.candidates??receipt.envelope?.candidates??receipt.candidateBusEnvelope?.candidates);
  return candidates.map((row,index)=>({
    candidateId:text(row?.candidateId??row?.id??'candidate:'+index,180),
    evidenceIdentity:text(row?.evidenceIdentity,220),
    channels:uniq(arr(row?.channelNominations??row?.nominatedBy).map(x=>typeof x==='string'?x:x?.channelId??x?.id).filter(Boolean),12),
    sourceRevisionRefs:uniq(row?.sourceRevisionRefs??row?.sourceRevisionIds??row?.dependencyRevisions,MAX_REFS),
    evidenceRefs:uniq(row?.evidenceRefs,MAX_REFS),
    claimRefs:uniq(row?.claimRefs??row?.claimIds,MAX_REFS),
    freshness:text(row?.freshness,60),truthStatusHint:text(row?.truthStatusHint??row?.truthStatus,60),
    authority:text(row?.authorityClass??row?.authority,80),
    artifactId:text(row?.artifactRef?.artifactId??row?.artifactRef?.id,180),
  }));
}

function normalizeStages(selected,choiceDecisions){
  const producers=selected?.producers??{};
  const explicitByStage=new Map();
  for(const row of choiceDecisions){
    const key=stageForCapability(row.capability);
    if(!key)continue;
    if(['SKIPPED','DEFERRED','REJECTED','BLOCKED','FAILED'].includes(row.disposition))explicitByStage.set(key,row);
  }
  const order=['scene','hotCognition','cognitiveChoice','sensory','retrieval','truth','runtime','jev','sidecar','vectoring','precision','gather','contextSeal','promptPlan','contextReceipt','compiledDelivery','delivery'];
  return order.map(stage=>{
    const p=producers[stage]??null,decision=explicitByStage.get(stage);
    let state=String(p?.status??p?.lifecycleState??'NO_EVIDENCE').toUpperCase();
    let reason=p?.reasonCode??arr(p?.reasonCodes)[0]??null;
    if((state==='NO_EVIDENCE'||state==='UNAVAILABLE')&&decision){state=decision.disposition;reason=decision.reason??decision.reasonCodes?.[0]??reason;}
    return{
      stage,state,reasonCode:text(reason,180),receiptId:text(p?.id,220),producerId:text(p?.producerId,120),consumerId:text(p?.consumerId,120),
      parentReceiptId:text(p?.parentReceiptId,220),durationMs:Number.isFinite(Number(p?.durationMs))?Number(p.durationMs):null,
      ownerAccepted:p?.ownerAccepted==null?null:Boolean(p.ownerAccepted),sourceRevisionRefs:uniq(p?.sourceRevisionRefs,MAX_REFS),
    };
  });
}

function normalizeLifecycle(selected,choiceDecisions){
  const events=arr(selected?.producers?.runtime?.events??selected?.producers?.runtime?.metadata?.events);
  const expected=arr(selected?.expectedWork?.items);
  const byTask=new Map();
  for(const item of expected.slice(0,64)){
    const key=item?.taskId?String(item.taskId):'expected:'+String(item?.expectedId??byTask.size);
    byTask.set(key,{
      expectedId:text(item?.expectedId,180),owner:text(item?.owner,120),ownerSignalId:text(item?.ownerSignalId,180),
      taskId:text(item?.taskId,180),taskType:text(item?.taskType??item?.obligation?.taskType??item?.expectedId,160),
      state:expectedWorkState(item?.status),reasonCode:text(item?.reasonCode,160),eventCount:arr(item?.evidenceStages).length,
      physicalExecution:arr(item?.evidenceStages).some(x=>String(x?.eventKind)==='PHYSICAL_EXECUTION_STARTED'),
      resultReturned:arr(item?.evidenceStages).some(x=>String(x?.eventKind)==='RESULT_RETURNED'),
      ownerAccepted:arr(item?.evidenceStages).some(x=>x?.ownerAccepted===true)?true:arr(item?.evidenceStages).some(x=>x?.ownerAccepted===false)?false:null,
      durationMs:null,sourceRevisionRefs:[],blockedBy:text(item?.blockedBy,180),missingEvidence:uniq(item?.missingEvidence,12),
      declarationSource:'OWNER_EXPECTED_WORK',
    });
  }
  for(const event of events.slice(-64)){
    const taskId=text(event?.taskId??event?.id,180)??'event:'+byTask.size;
    let key=taskId;
    if(!byTask.has(key)){const expectedMatch=[...byTask.entries()].find(([,row])=>row.taskId&&row.taskId===taskId);if(expectedMatch)key=expectedMatch[0];}
    if(!byTask.has(key))byTask.set(key,{expectedId:null,owner:null,ownerSignalId:null,taskId,taskType:text(event?.taskType,120),state:'EXPECTED',reasonCode:'NO_EVIDENCE',eventCount:0,physicalExecution:false,resultReturned:false,ownerAccepted:null,durationMs:null,sourceRevisionRefs:[],blockedBy:null,missingEvidence:[],declarationSource:'RUNTIME_CAUSAL'});
    const row=byTask.get(key);row.eventCount+=1;row.taskType??=text(event?.taskType,120);row.state=lifecycleState(event);row.reasonCode=text(event?.reasonCode??event?.eventKind,160);row.physicalExecution ||= String(event?.eventKind)==='PHYSICAL_EXECUTION_STARTED';row.resultReturned ||= String(event?.eventKind)==='RESULT_RETURNED';
    if(event?.ownerAccepted!=null)row.ownerAccepted=Boolean(event.ownerAccepted);
    if(Number.isFinite(Number(event?.durationMs)))row.durationMs=Number(event.durationMs);
    row.sourceRevisionRefs=uniq([...row.sourceRevisionRefs,...arr(event?.sourceRevisionRefs)],MAX_REFS);
  }
  const existingTypes=new Set([...byTask.values()].map(row=>machine(row.taskType)));
  for(const decision of choiceDecisions.filter(row=>row.disposition==='ADMITTED')){
    const taskType=machine(decision.capability);
    if(!taskType||existingTypes.has(taskType))continue;
    byTask.set('expected:'+taskType,{taskId:null,taskType:decision.capability,state:'NO_EVIDENCE',reasonCode:'LOGICAL_ADMISSION_ONLY',eventCount:0,physicalExecution:false,resultReturned:false,ownerAccepted:null,durationMs:null,sourceRevisionRefs:[]});
  }
  return [...byTask.values()];
}

function candidateProgress(candidate,{truth,gather,seal,plan,delivery}={}){
  const truthRows=arr(truth?.truthResults??truth?.results??truth?.classifications);
  const truthIds=new Set([
    ...truthRows.filter(row=>String(row?.candidateId??row?.id)===candidate.candidateId).map(()=>candidate.candidateId),
    ...arr(truth?.admittedCandidateIds).map(String),...arr(truth?.supportCandidateIds).map(String),
  ]);
  const truthState=truthIds.has(String(candidate.candidateId))?'PROVEN':truth?'NO_EVIDENCE':'UNAVAILABLE';

  const gathers=arr(gather?.results??gather?.items??gather?.entries);
  const candidateRefs=new Set([...candidate.evidenceRefs,...candidate.sourceRevisionRefs,candidate.candidateId].filter(Boolean).map(String));
  const matchedGather=gathers.filter(row=>{
    const refs=[row?.candidateId,row?.result?.candidateId,...arr(row?.evidenceRefs??row?.evidenceIds??row?.result?.evidenceIds),...arr(row?.sourceRevisionRefs??row?.sourceRevisionIds??row?.result?.sourceRevisionIds)].filter(Boolean).map(String);
    return refs.some(ref=>candidateRefs.has(ref));
  });
  const admittedGather=matchedGather.filter(row=>Boolean(row?.accepted??row?.route?.accepted??row?.admitted)||String(row?.status??row?.disposition).toUpperCase()==='ADMITTED');
  const gatherState=admittedGather.length?'PROVEN':gather?'NO_EVIDENCE':'UNAVAILABLE';

  const gatherIds=new Set(admittedGather.map(row=>String(row?.resultId??row?.id??row?.result?.id??'')).filter(Boolean));
  const sealIds=new Set(arr(seal?.admittedResultIds??seal?.effectiveAdmittedResultIds).map(String));
  const sealed=[...gatherIds].some(id=>sealIds.has(id));
  const sealState=sealed?'PROVEN':seal?'NO_EVIDENCE':'UNAVAILABLE';

  const plannedSections=arr(plan?.sections);
  const planned=plannedSections.some(section=>arr(section?.sourceRevisionIds??section?.sourceRevisionRefs).map(String).some(ref=>candidateRefs.has(ref)));
  const plannedState=planned?'PROVEN':plan?'NO_EVIDENCE':'UNAVAILABLE';

  const observed=delivery?.observedHostDelivery??null;
  const observedRefs=uniq(observed?.observedSourceRevisionRefs??observed?.sourceRevisionRefs??observed?.evidenceRefs??observed?.candidateIds,64);
  const observedState=observedRefs.some(ref=>candidateRefs.has(ref))?'PROVEN':observed?'NO_EVIDENCE':'UNAVAILABLE';
  return{candidateId:candidate.candidateId,sensory:'PROVEN',truth:truthState,gather:gatherState,seal:sealState,plannedPrompt:plannedState,observedHost:observedState};
}

function normalizeDelivery(selected,{plan,context,delivery}={}){
  const fromSelected=selected?.delivery??{};
  const planned=fromSelected.planned??(plan?{state:'PLANNED',promptPlanId:plan.promptPlanId??null,includedSlots:arr(plan.sections).map(x=>x.slot).filter(Boolean),deferred:arr(plan.deferred)}:{state:'UNAVAILABLE',reason:'PROMPT_PLAN_UNAVAILABLE'});
  const sealed=fromSelected.compiled??(context?{state:'COMPILED_AND_SEALED',contextSealId:context.contextSealId??null,includedSlots:arr(context.includedSections),deferred:arr(context.deferredSections)}:{state:'UNAVAILABLE',reason:'CONTEXT_RECEIPT_UNAVAILABLE'});
  const observed=fromSelected.hostObserved??(delivery?.observedHostDelivery?{state:'OBSERVED',requestId:delivery.observedHostDelivery.requestId??null,matching:Boolean(delivery.observedHostDelivery.matching),live:Boolean(delivery.observedHostDelivery.live),observedRoles:uniq(delivery.observedHostDelivery.observedRoles,12)}:{state:'UNAVAILABLE',reason:'HOST_OBSERVATION_OWNED_BY_SILLYTAVERN_BOUNDARY'});
  return{
    planned:sanitizeDelivery(planned),
    sealed:sanitizeDelivery(sealed),
    observed:sanitizeDelivery(observed),
  };
}

function optionalExecution(producer){
  if(!producer)return{state:'NO_EVIDENCE',physicalAttempt:null,returned:null,ownerAccepted:null,reasonCode:'NO_EVIDENCE'};
  return{
    state:String(producer.status??producer.lifecycleState??'NO_EVIDENCE').toUpperCase(),
    physicalAttempt:producer.physicalAttempt==null?null:Boolean(producer.physicalAttempt),
    returned:producer.returned==null?null:Boolean(producer.returned),
    ownerAccepted:producer.ownerAccepted==null?null:Boolean(producer.ownerAccepted),
    reasonCode:text(producer.reasonCode??arr(producer.reasonCodes)[0],180),
    resultRef:text(producer.resultRef,220),
  };
}

function safeOwnerRead(fn,selection,stage,errors,{requireIdentity=false}={}){
  if(!fn)return{value:null,identityState:'READER_UNAVAILABLE'};
  try{
    const raw=fn(clone(selection));
    if(raw==null)return{value:null,identityState:'NO_EVIDENCE'};
    const identity=normalizeSelection(raw);
    const compared=[];
    for(const key of ['chatId','turnId','generationId','correlationId']){
      const expected=selection?.[key],actual=identity?.[key];
      if(expected==null)continue;
      if(actual==null){if(requireIdentity){errors.push({stage,code:'IDENTITY_MISSING',field:key});return{value:null,identityState:'IDENTITY_MISSING'};}continue;}
      compared.push(key);
      if(String(expected)!==String(actual)){errors.push({stage,code:'IDENTITY_MISMATCH',field:key,expected:text(expected,100),actual:text(actual,100)});return{value:null,identityState:'IDENTITY_MISMATCH'};}
    }
    return{value:raw,identityState:compared.length?'EXACT':'OWNER_SELECTION_FENCED'};
  }catch(error){
    errors.push({stage,code:text(error?.code??'OWNER_READ_FAILED',120),message:text(error?.message??error,280)});
    return{value:null,identityState:'READ_FAILED'};
  }
}

function reader(bindings,names){
  const surfaces=[bindings,bindings?.read,bindings?.brain,bindings?.brain?.read,bindings?.nativeBrain,bindings?.nativeBrain?.read].filter(Boolean);
  for(const surface of surfaces)for(const name of names)if(typeof surface?.[name]==='function')return surface[name].bind(surface);
  return null;
}
function normalizeSelection(value={}){
  return{
    chatId:text(value?.chatId,180),turnId:text(value?.turnId,180),generationId:text(value?.generationId,180),correlationId:text(value?.correlationId,180),
    worldRevision:value?.worldRevision??null,sceneRevision:value?.sceneRevision??null,sourceRevisionRefs:uniq(value?.sourceRevisionRefs??value?.sourceRevisionIds??value?.sourceRevisionSet,64),
  };
}
function safeSourceRevisions(value={}){
  return{selectedRefs:uniq(value?.selectedRefs,64),sceneRefs:uniq(value?.sceneRefs,32),sealRefs:uniq(value?.sealRefs,64),ownerCount:Number(value?.ownerCount??0)||0};
}
function sanitizeDelivery(value={}){
  return{
    state:text(value?.state??'UNAVAILABLE',80),reason:text(value?.reason,180),promptPlanId:text(value?.promptPlanId,220),contextSealId:text(value?.contextSealId,220),
    packetId:text(value?.packetId,220),packetHash:text(value?.packetHash,220),requestId:text(value?.requestId,220),matching:value?.matching==null?null:Boolean(value.matching),live:value?.live==null?null:Boolean(value.live),
    includedSlots:uniq(value?.includedSlots,24),deferred:arr(value?.deferred).slice(0,16).map(row=>({slot:text(row?.slot,100),reason:text(row?.reason,180)})),observedRoles:uniq(value?.observedRoles,12),
  };
}
function emptyDelivery(){return{planned:{state:'UNAVAILABLE',reason:'NO_EVIDENCE'},sealed:{state:'UNAVAILABLE',reason:'NO_EVIDENCE'},observed:{state:'UNAVAILABLE',reason:'NO_EVIDENCE'}};}
function safety(){return{metadataOnly:true,rawPrompts:false,storyLoreBodies:false,credentials:false,providerBodies:false,hiddenReasoning:false,mutationAuthority:false};}
function normalizeDisposition(value){
  const x=String(value??'UNKNOWN').toUpperCase();
  if(['ADMITTED','CHOSEN','SELECTED','ACCEPTED'].includes(x))return'ADMITTED';
  if(['DEFERRED','BACKGROUND'].includes(x))return'DEFERRED';
  if(['REJECTED','DENIED'].includes(x))return'REJECTED';
  if(['SKIPPED','NOT_REQUIRED'].includes(x))return'SKIPPED';
  if(['BLOCKED'].includes(x))return'BLOCKED';
  if(['FAILED','ERROR','INVALID'].includes(x))return'FAILED';
  return x;
}
function stageForCapability(value){
  const x=machine(value);
  if(x.includes('TRUTH'))return'truth';if(x.includes('GATHER'))return'gather';if(x.includes('CONTEXT_SEAL'))return'contextSeal';if(x.includes('JEV'))return'jev';if(x.includes('PRECISION'))return'precision';if(x.includes('RETRIEVAL'))return'retrieval';if(x.includes('SENSORY'))return'sensory';return null;
}
function expectedWorkState(value){
  const x=String(value??'DUE').toUpperCase();
  if(x==='DONE')return'COMPLETED';
  if(x==='SKIPPED_WITH_REASON')return'SKIPPED';
  if(['DUE','BLOCKED','FAILED','DEFERRED','STALE','LATE'].includes(x))return x;
  return x||'NO_EVIDENCE';
}
function lifecycleState(event){
  const kind=String(event?.eventKind??'').toUpperCase(),state=String(event?.lifecycleState??'').toUpperCase();
  if(kind==='SETTLEMENT'||state==='SETTLED')return'SETTLED';
  if(kind==='OWNER_ADMISSION'||state==='ACCEPTED')return event?.ownerAccepted===false?'REJECTED':'COMPLETED';
  if(kind==='OWNER_REJECTED')return'REJECTED';
  if(kind==='RESULT_RETURNED'||state==='RETURNED')return'RETURNED';
  if(kind==='PHYSICAL_EXECUTION_STARTED'||state==='RUNNING')return'RUNNING';
  if(kind==='OBLIGATION_ADMITTED'||state==='ADMITTED')return'OPENED';
  if(kind==='WORK_SKIPPED'||state==='SKIPPED')return'SKIPPED';
  if(kind==='WORK_BLOCKED'||state==='BLOCKED')return'BLOCKED';
  if(kind==='WORK_DEFERRED'||state==='DEFERRED')return'DEFERRED';
  if(kind==='WORK_FAILED'||state==='FAILED')return'FAILED';
  if(kind==='RESULT_STALE'||state==='STALE')return'STALE';
  if(kind==='RESULT_LATE'||state==='LATE')return'LATE';
  return state||kind||'NO_EVIDENCE';
}
function deliveryView(doc,delivery){
  const root=element(doc,'section',{className:'a52-brain-decision-block'});root.append(element(doc,'h3',{text:'Prompt delivery evidence'}));
  const grid=element(doc,'div',{className:'a52-brain-delivery-grid'});
  for(const [label,key] of [['Planned','planned'],['Sealed / compiled','sealed'],['Observed at host','observed']]){
    const value=delivery?.[key]??{state:'UNAVAILABLE'},card=element(doc,'div',{className:'a52-wave13-stage'});
    card.append(element(doc,'strong',{text:label}),makeBadge(doc,value.state,statusFor(value.state)),element(doc,'span',{className:'a52-muted',text:value.reason??value.requestId??value.contextSealId??value.promptPlanId??'No additional receipt identity published'}));grid.append(card);
  }
  root.append(grid);return root;
}
function stateMessage(doc,title,message,status='historical'){const root=element(doc,'div',{className:'a52-state-message',attrs:{role:'status'},dataset:{status}});root.append(element(doc,'strong',{text:title}),element(doc,'span',{text:message}));return root;}
function machine(value){return String(value??'').trim().toUpperCase().replace(/[\s:/-]+/g,'_');}
function human(value){return String(value??'').replace(/([a-z])([A-Z])/g,'$1 $2').replace(/[_:-]+/g,' ').toLowerCase().replace(/\b\w/g,m=>m.toUpperCase());}
function statusFor(value){const x=String(value??'').toUpperCase();if(['PROVEN','PUBLISHED','COMPLETE','COMPLETED','SETTLED','OBSERVED','COMPILED_AND_SEALED','PLANNED','ADMITTED','OPENED','RETURNED','RUNNING'].includes(x))return'ready';if(['DEFERRED','SKIPPED','NO_EVIDENCE','UNAVAILABLE','BLOCKED','STALE','LATE'].includes(x))return'warning';if(['REJECTED','FAILED','INVALID','IDENTITY_MISMATCH'].includes(x))return'error';return'observed';}
function freeze(value){return deepFreeze(sanitize(value));}
function deepFreeze(value){if(value&&typeof value==='object'&&!Object.isFrozen(value)){for(const child of Object.values(value))deepFreeze(child);Object.freeze(value);}return value;}
function sanitize(value,depth=0){
  if(depth>7)return'[bounded]';
  if(value==null||typeof value==='number'||typeof value==='boolean')return value;
  if(typeof value==='string')return value.slice(0,2000);
  if(Array.isArray(value))return value.slice(0,64).map(x=>sanitize(x,depth+1));
  if(typeof value!=='object')return String(value);
  const out={};
  for(const [key,item] of Object.entries(value)){if(BLOCKED_KEYS.test(key))continue;out[key]=sanitize(item,depth+1);}
  return out;
}
