import { ResourceScope } from './lifecycle.js';
import { element } from './primitives.js';
function safeCompletionResponseMetadata(value){
  if(!value||typeof value!=='object')return null;
  const count=x=>Number.isSafeInteger(x)&&x>=0?x:null;
  return Object.freeze({choiceCount:count(value.choiceCount),finishReason:['stop','length','tool_calls','function_call','content_filter','error'].includes(value.finishReason)?value.finishReason:null,contentType:['null','undefined','string','array','object','number','boolean'].includes(value.contentType)?value.contentType:null,reasoningPresent:value.reasoningPresent===true,toolCallCount:count(value.toolCallCount),promptTokens:count(value.promptTokens),completionTokens:count(value.completionTokens),totalTokens:count(value.totalTokens),reasoningTokens:count(value.reasoningTokens)});
}
function safeSceneGenerationBudget(value){
  if(value?.policy!=='ADAPTIVE_SCENE')return null;
  const out={policy:'ADAPTIVE_SCENE',providerLimited:value.providerLimited===true};
  for(const key of ['estimatedFinalTokens','reasoningAllowanceTokens','reasoningCapTokens','requestedGenerationTokens','effectiveGenerationTokens'])out[key]=Number.isSafeInteger(value[key])&&value[key]>=0?value[key]:null;
  return Object.freeze(out);
}

export const DEMO_EVIDENCE_JOURNAL_VERSION='1.5.0';
const DEFAULT_NAMESPACE='nexus.demo.evidence.v1';
const STAGES=['scene','runtime','coprocessor','choice','truth','jev','gather','seal','promptPlan','generation','learning'];

class MemoryStorage{
  #data=new Map();
  getItem(key){return this.#data.has(key)?this.#data.get(key):null;}
  setItem(key,value){this.#data.set(key,String(value));}
  removeItem(key){this.#data.delete(key);}
}

export class DemoEvidenceJournal{
  constructor({storage=null,namespace=DEFAULT_NAMESPACE,maxTurns=48,maxEntriesPerTurn=64,maxStoredBytes=262144,now=()=>Date.now()}={}){
    const local=globalThis.localStorage??null;
    this.storage=storage??local??new MemoryStorage();
    this.storageKind=storage?'PROVIDED':local?'LOCAL_STORAGE':'MEMORY_FALLBACK';
    this.namespace=String(namespace||DEFAULT_NAMESPACE);
    this.maxTurns=Math.max(1,Number(maxTurns)||48);
    this.maxEntriesPerTurn=Math.max(4,Number(maxEntriesPerTurn)||64);
    this.maxStoredBytes=Math.max(16384,Number(maxStoredBytes)||262144);
    this.now=typeof now==='function'?now:()=>Date.now();
    this.lastError=null;this.cachedState=null;this.lastSerializedBytes=0;this.writeCount=0;this.skippedWriteCount=0;this.storageLoadCount=0;this.revision=0;this.lastRecordChanged=false;
  }

  recordSnapshot({selection={},operations=null,diagnostics=null,cognition=null,promptPlan=null,ownerReceipt=null}={}){
    this.lastRecordChanged=false;
    const identity=normalizeSelection(selection);
    if(!identity.chatId||!identity.turnId||!identity.generationId)return null;
    const state=this.#load(),key=selectionKey(identity),at=this.now();
    let turn=state.turns.find(row=>row.key===key),changed=false;
    if(turn&&selectionFenceConflict(turn.selection,identity)){
      const index=state.turns.indexOf(turn);
      turn={key,selection:identity,firstSeenAt:at,lastUpdatedAt:at,entries:[],replacedRevisionFence:true};
      state.turns[index]=turn;changed=true;
    }else if(!turn){
      turn={key,selection:identity,firstSeenAt:at,lastUpdatedAt:at,entries:[]};
      state.turns.push(turn);changed=true;
    }else{
      const merged=mergeSelectionFence(turn.selection,identity);
      if(JSON.stringify(merged)!==JSON.stringify(turn.selection)){turn.selection=merged;changed=true;}
    }
    const entries=deriveEntries({selection:identity,operations,diagnostics,cognition,promptPlan,ownerReceipt,at});
    const entryIndex=new Map(turn.entries.map((row,index)=>[row.identityKey,index]));
    for(const entry of entries){
      const index=entryIndex.get(entry.identityKey);
      if(index!=null){
        const prior=turn.entries[index];
        if(!sameEvidence(prior,entry)){turn.entries[index]=entry;changed=true;}
      }else{entryIndex.set(entry.identityKey,turn.entries.length);turn.entries.push(entry);changed=true;}
    }
    turn.entries.sort((a,b)=>Number(a.at??0)-Number(b.at??0));
    if(turn.entries.length>this.maxEntriesPerTurn){
      turn.entries=pruneEntriesPreservingDelivery(turn.entries,this.maxEntriesPerTurn);changed=true;
    }
    if(!changed){this.skippedWriteCount+=1;this.lastRecordChanged=false;return clone(turn);}
    turn.lastUpdatedAt=at;
    state.turns.sort((a,b)=>Number(a.lastUpdatedAt??0)-Number(b.lastUpdatedAt??0));
    if(state.turns.length>this.maxTurns)state.turns=pruneTurnsPreservingDelivery(state.turns,this.maxTurns);
    state.updatedAt=at;
    this.#save(state);this.revision+=1;this.lastRecordChanged=true;
    return clone(turn);
  }

  readTurn(selection={}){
    const identity=normalizeSelection(selection);
    if(!identity.chatId||!identity.turnId||!identity.generationId)return null;
    const turn=this.#load().turns.find(row=>row.key===selectionKey(identity));
    return turn&&selectionFenceCompatible(turn.selection,identity)?clone(turn):null;
  }

  listEntries(selection={}, {limit=64}={}){
    const identity=normalizeSelection(selection);
    if(!identity.chatId||!identity.turnId||!identity.generationId)return[];
    const turn=this.#load().turns.find(row=>row.key===selectionKey(identity));
    if(!turn||!selectionFenceCompatible(turn.selection,identity))return[];
    return clone(turn.entries.slice(-Math.max(1,Number(limit)||64)));
  }

  readEntry(selection={},entryId=null){
    const identity=normalizeSelection(selection);
    if(!identity.chatId||!identity.turnId||!identity.generationId||entryId==null)return null;
    const turn=this.#load().turns.find(row=>row.key===selectionKey(identity));
    if(!turn||!selectionFenceCompatible(turn.selection,identity))return null;
    const row=turn?.entries?.find(item=>item.id===String(entryId));
    return row?clone(row):null;
  }

  status(){
    const state=this.#load(),turnCount=state.turns.length,entryCount=state.turns.reduce((sum,row)=>sum+(row.entries?.length??0),0);
    return {
      kind:'NexusDemoEvidenceJournalStatus',contractVersion:DEMO_EVIDENCE_JOURNAL_VERSION,
      available:this.lastError==null,persistent:this.storageKind!=='MEMORY_FALLBACK',storageKind:this.storageKind,
      turnCount,entryCount,maxTurns:this.maxTurns,maxEntriesPerTurn:this.maxEntriesPerTurn,maxStoredBytes:this.maxStoredBytes,
      serializedBytes:this.lastSerializedBytes,storageLoads:this.storageLoadCount,writes:this.writeCount,skippedRedundantWrites:this.skippedWriteCount,revision:this.revision,lastRecordChanged:this.lastRecordChanged,
      metadataOnly:true,criticalDeliveryProtected:true,revisionFenceAware:true,updatedAt:state.updatedAt??null,
      lastError:this.lastError?String(this.lastError?.message??this.lastError):null,
    };
  }

  exportEvidence({selection=null}={}){
    const state=this.#load();
    const identity=selection?normalizeSelection(selection):null;
    const turns=identity?.chatId&&identity?.turnId&&identity?.generationId
      ? state.turns.filter(row=>row.key===selectionKey(identity)&&selectionFenceCompatible(row.selection,identity))
      : state.turns;
    return {
      kind:'NexusDemoEvidenceExport',contractVersion:DEMO_EVIDENCE_JOURNAL_VERSION,exportedAt:this.now(),
      selection:identity,turns:clone(turns),
      safety:{rawPromptsPersisted:false,storyTextPersisted:false,credentialsPersisted:false,hiddenReasoningPersisted:false,externalDatabaseUsed:false},
    };
  }

  download({selection=null,document=globalThis.document??null,filename=null}={}){
    const payload=this.exportEvidence({selection}),json=JSON.stringify(payload,null,2);
    const BlobCtor=globalThis.Blob,URLApi=globalThis.URL;
    if(!document?.createElement||typeof BlobCtor!=='function'||typeof URLApi?.createObjectURL!=='function')return{ok:false,reason:'DOWNLOAD_API_UNAVAILABLE',payload,json};
    const blob=new BlobCtor([json],{type:'application/json'}),url=URLApi.createObjectURL(blob),a=document.createElement('a');
    const id=payload.selection;
    a.href=url;a.download=filename??['nexus-evidence',id?.chatId,id?.turnId,id?.generationId].filter(Boolean).map(filePart).join('-')+'.json';
    a.style.display='none';document.body?.append?.(a);
    try{a.click?.();}finally{a.remove?.();URLApi.revokeObjectURL?.(url);}
    return{ok:true,filename:a.download,payload,json};
  }

  clear(){try{this.storage.removeItem(this.namespace);this.cachedState=emptyState();this.lastSerializedBytes=0;this.lastError=null;return true;}catch(error){this.lastError=error;return false;}}

  #load(){
    if(this.cachedState)return this.cachedState;
    this.storageLoadCount+=1;
    try{
      const raw=this.storage.getItem(this.namespace);
      if(!raw){this.cachedState=emptyState();return this.cachedState;}
      this.lastSerializedBytes=raw.length;
      const parsed=JSON.parse(raw);
      this.cachedState=parsed?.kind==='NexusDemoEvidenceJournal'&&Array.isArray(parsed.turns)?parsed:emptyState();
      return this.cachedState;
    }catch(error){this.lastError=error;this.cachedState=emptyState();return this.cachedState;}
  }
  #save(state){
    try{
      const json=boundedJournalJson(state,this.maxStoredBytes);
      this.cachedState=state;this.lastSerializedBytes=json.length;this.storage.setItem(this.namespace,json);this.writeCount+=1;this.lastError=null;
    }catch(error){this.lastError=error;this.cachedState=state;}
  }
}

export class DemoActivityFeedController{
  constructor({
    host,journal,selectionProvider=()=>({}),inspect=null,maxVisible=5,
    now=()=>Date.now(),fadeAfterMs=6500,visibleForMs=12000,
    setTimer=globalThis.setTimeout?.bind(globalThis)??null,clearTimer=globalThis.clearTimeout?.bind(globalThis)??null,scheduleEnabled=null,
  }={}){
    this.host=host;this.journal=journal;this.selectionProvider=selectionProvider;this.inspect=typeof inspect==='function'?inspect:null;
    this.maxVisible=Math.max(2,Number(maxVisible)||5);this.now=typeof now==='function'?now:()=>Date.now();
    this.fadeAfterMs=Math.max(250,Number(fadeAfterMs)||6500);this.visibleForMs=Math.max(this.fadeAfterMs+250,Number(visibleForMs)||12000);
    this.setTimer=typeof setTimer==='function'?setTimer:null;this.clearTimer=typeof clearTimer==='function'?clearTimer:null;
    this.scheduleEnabled=scheduleEnabled==null?typeof host?.isConnected==='boolean':Boolean(scheduleEnabled);
    this.scope=new ResourceScope();this.renderScope=new ResourceScope();this.held=new Set();this.timer=null;this.lastSignature=null;
  }
  mount(){this.host?.classList?.add?.('nexus-activity-feed-host');this.render();return this;}
  render(){
    if(!this.host||!this.journal)return;
    this.#cancelTimer();
    const selection=normalizeSelection(this.selectionProvider?.()??{}),now=Number(this.now()),all=this.journal.listEntries(selection,{limit:Math.max(this.maxVisible*4,32)});
    const active=all.filter(entry=>this.held.has(entry.id)||Math.max(0,now-Number(entry.at??now))<this.visibleForMs).slice(-this.maxVisible);
    let nextBoundary=Infinity;
    const rows=active.map((entry,index)=>{
      const elapsed=Math.max(0,now-Number(entry.at??now)),held=this.held.has(entry.id),phase=elapsed>=this.fadeAfterMs?'fading':'fresh';
      if(!held){const boundary=elapsed<this.fadeAfterMs?this.fadeAfterMs-elapsed:this.visibleForMs-elapsed;if(boundary>0)nextBoundary=Math.min(nextBoundary,boundary);}
      return{entry,held,phase,age:active.length-1-index};
    });
    const signature=selectionKey(selection)+'|'+JSON.stringify(rows.map(row=>[row.entry.id,row.entry.status,row.entry.summary,row.entry.detail,row.phase,row.held]));
    if(!rows.length){
      if(this.lastSignature!==signature){this.renderScope.cleanup();this.renderScope=new ResourceScope();this.host.replaceChildren();this.lastSignature=signature;}
      return;
    }
    if(this.lastSignature!==signature){
      this.renderScope.cleanup();this.renderScope=new ResourceScope();
      const d=this.host.ownerDocument,root=element(d,'div',{className:'nexus-activity-feed',attrs:{'aria-label':'Current turn activity',role:'log','aria-live':'polite','aria-relevant':'additions text'}});
      for(const {entry,held,phase,age} of rows){
        const button=element(d,'button',{className:'nexus-activity-feed__item',attrs:{type:'button','aria-label':entry.title+': '+entry.summary,title:entry.detail??entry.summary},dataset:{status:entry.status,age:String(age),phase,paused:String(held),entryId:entry.id}});
        button.append(element(d,'strong',{text:entry.title}),element(d,'span',{className:'nexus-activity-feed__summary',text:entry.summary}),element(d,'span',{className:'nexus-activity-feed__detail',text:entry.detail??entry.summary}));
        this.renderScope.listen(button,'click',()=>this.#activate(entry));
        this.renderScope.listen(button,'keydown',(event)=>{if(event.key==='Enter'||event.key===' '){event.preventDefault?.();this.#activate(entry);}});
        this.renderScope.listen(button,'mouseenter',()=>this.#hold(entry.id));
        this.renderScope.listen(button,'mouseleave',()=>this.#release(entry.id));
        this.renderScope.listen(button,'focusin',()=>this.#hold(entry.id));
        this.renderScope.listen(button,'focusout',()=>this.#release(entry.id));
        root.append(button);
      }
      this.host.replaceChildren(root);this.lastSignature=signature;
    }
    if(this.scheduleEnabled&&Number.isFinite(nextBoundary)&&this.held.size===0)this.#schedule(Math.max(20,nextBoundary+5));
  }
  destroy(){this.#cancelTimer();this.renderScope.cleanup();this.scope.cleanup();this.held.clear();this.lastSignature=null;this.host?.replaceChildren?.();}
  #activate(entry){
    const current=normalizeSelection(this.selectionProvider?.()??{});
    if(selectionKey(current)!==selectionKey(entry.selection)){this.render();return false;}
    const receiptRef=entry.receiptRef??null,evidenceState=receiptRef?'RECEIPT_AVAILABLE':'NO_EVIDENCE';
    this.inspect?.({kind:'wave14-activity-evidence',id:entry.id,title:entry.title,available:Boolean(receiptRef),evidenceState,selection:clone(entry.selection),receiptRef,payload:clone(entry),reason:receiptRef?null:'No owner receipt reference was retained for this selected-turn notice.'});
    return true;
  }
  #hold(id){this.held.add(id);this.#cancelTimer();const node=this.#entryNode(id);if(node)node.dataset.paused='true';}
  #release(id){this.held.delete(id);this.render();}
  #entryNode(id){return [...(this.host?.querySelectorAll?.('.nexus-activity-feed__item')??[])].find(node=>node.dataset?.entryId===id)??null;}
  #schedule(ms){if(!this.setTimer)return;this.timer=this.setTimer(()=>{this.timer=null;this.render();},ms);this.timer?.unref?.();}
  #cancelTimer(){if(this.timer!=null&&this.clearTimer)this.clearTimer(this.timer);this.timer=null;}
}

function deriveEntries({selection,operations,diagnostics,cognition,promptPlan,ownerReceipt,at}){
  const out=[],op=operations??{},diag=diagnostics??{},path=cognition?.data??cognition??{},pipeline=op.pipeline??{};
  const stages=new Map((op.stages??[]).map(row=>[row.id,row]));
  const inspections=op.inspections??{},scatter=path.scatter??null,gather=path.gather??null,seal=path.seal??null;
  const pp=promptPlan?.data??promptPlan??path.promptPlan??null,hostDelivery=inspections.generation?.payload??null;
  const dedicated=new Set();
  if(scatter)dedicated.add('runtime');if(gather)dedicated.add('gather');if(seal)dedicated.add('seal');if(pp)dedicated.add('promptPlan');
  if(hostDelivery?.kind==='SillyTavernHostDeliveryReceipt')dedicated.add('generation');if(pipeline.learningReceipt)dedicated.add('learning');
  for(const id of STAGES){
    const row=stages.get(id);if(!row||dedicated.has(id))continue;
    const inspection=inspections[id]??null;
    const ref=inspection?.receiptRef??null;
    if(!inspection?.available&&['runtime','coprocessor','choice','truth','jev','gather','seal','promptPlan','generation','learning'].includes(id)&&['UNAVAILABLE','DISCONNECTED','WAITING_FOR_TURN'].includes(String(row.state)))continue;
    const detail=producerDetail(id,path,pipeline,row);
    out.push(entry({
      type:'PRODUCER',subtype:id,status:row.state??'UNKNOWN',title:row.label??label(id),summary:detail.summary,
      detail:detail.detail,receiptRef:ref,selection,at,identitySuffix:ref??'selected-turn-status',
      metadata:{producerId:id,errorCode:row.errorCode??null,freshness:row.freshness??null},
    }));
  }

  const liveReadError=diag.host?.liveBinding?.lastError??null;
  if(liveReadError){
    const stage=String(liveReadError.stage??'owner-read'),code=technicalReason(liveReadError.code)??'LIVE_RECEIPT_READ_FAILED';
    out.push(entry({
      type:'READ_ERROR',subtype:stage,status:'READ_FAILED',title:label(stage)+' selected-turn read blocked',
      summary:'Selected-turn '+label(stage)+' read was blocked: '+code+'.',
      detail:'The owner reader rejected the selected-turn receipt. Raw error payload omitted [REDACTED] by metadata-only telemetry policy.',
      selection,at,identitySuffix:[stage,code,selection.worldRevision??'',selection.sceneRevision??'',selection.sourceRevisionRefs.join(',')].join(':'),
      metadata:{stage,code,worldRevision:selection.worldRevision,sceneRevision:selection.sceneRevision,sourceRevisionRefs:[...selection.sourceRevisionRefs]},
    }));
  }

  if(ownerReceipt){
    out.push(...deriveCausalOwnerEdges({selection,ownerReceipt,path,pipeline,operations:op,diagnostics:diag,promptPlan:pp,at}));
    const expected=expectedWorkJournalEntry(ownerReceipt?.expectedWork,selection,at);
    if(expected)out.push(expected);
  }

  if(scatter){
    const jobs=scatter.jobs??[],ids=[...new Set(jobs.map(row=>row.resourceId).filter(Boolean))];
    out.push(entry({
      type:'SCATTER',status:'MAPPED',title:'Runtime fan-out',
      summary:jobs.length+' logical job'+(jobs.length===1?'':'s')+' mapped to '+ids.length+' resource identit'+(ids.length===1?'y':'ies')+'.',
      detail:'Scatter proves logical mapping only. It is not evidence that any mapped resource physically executed.',
      receiptRef:scatter.receiptId??null,selection,at,identitySuffix:scatter.receiptId??String(jobs.length)+':'+ids.join(','),
      metadata:{logicalJobCount:jobs.length,mappedResourceCount:ids.length,mappedResourceIds:ids,jobs:jobs.map(row=>({jobId:row.jobId??row.taskId??null,capability:row.capability??null,resourceId:row.resourceId??null,state:row.state??null}))},
    }));
  }

  const runtimeOwner=inspections.runtime?.payload?.receipt??inspections.runtime?.payload??null;
  const ownerJobs=Array.isArray(runtimeOwner?.jobs)?runtimeOwner.jobs:Array.isArray(scatter?.jobs)?scatter.jobs:[];
  if(ownerJobs.length){
    const nativeIds=[...new Set(((runtimeOwner?.resourceIds??scatter?.resourceIds)??[]).filter(Boolean).map(String))];
    const optionalByJob=new Map((scatter?.jobs??[]).map(row=>[String(row.jobId??row.taskId??''),row]));
    const gatherRows=Array.isArray(path.gather?.results)?path.gather.results:[],sealedIds=new Set(path.seal?.effectiveAdmittedResultIds??path.seal?.admittedResultIds??[]);
    const auditJobs=ownerJobs.slice(0,32).map(job=>{
      const jobId=String(job.jobId??job.taskId??''),optional=optionalByJob.get(jobId)??null;
      const results=gatherRows.filter(row=>String(row.taskId??row.jobId??'')===jobId).slice(0,16);
      return{
        jobId:jobId||null,sequence:finite(job.sequence),owner:job.owner??null,reasonCode:technicalReason(job.reasonCode??job.reason??(job.owner?'OWNER_'+String(job.owner):null)),
        assignedNativeResourceId:job.resourceId??(nativeIds.length===1?nativeIds[0]:null),assignedOptionalResourceId:optional?.resourceId??null,
        startAt:finite(job.startedAt??job.startAt),endAt:finite(job.completedAt??job.endAt),outcome:job.status??job.state??null,
        physicalExecutionEvidence:job.physicalExecutionEvidence??null,resultReturned:typeof job.resultReturned==='boolean'?job.resultReturned:results.length>0,
        ownerAccepted:typeof job.ownerAccepted==='boolean'?job.ownerAccepted:null,taskIds:[...(job.taskIds??[])].slice(0,16),
        providerAttempted:results.some(row=>Boolean(row.providerAttempted)),resultIds:results.map(row=>row.resultId).filter(Boolean),
        gatherAdmissions:results.map(row=>({resultId:row.resultId??null,status:row.status??null,accepted:Boolean(row.accepted),resourceId:row.resourceId??null})),
        contextSealResultIds:results.map(row=>row.resultId).filter(id=>id&&sealedIds.has(id)),
      };
    });
    const optionalIds=[...new Set((scatter?.jobs??[]).map(row=>row.resourceId).filter(Boolean).map(String))];
    out.push(entry({
      type:'JOB_AUDIT',status:'RECORDED',title:'Selected-turn job execution audit',
      summary:auditJobs.length+' logical jobs · '+nativeIds.length+' native resource'+(nativeIds.length===1?'':'s')+' · '+optionalIds.length+' optional execution resource'+(optionalIds.length===1?'':'s')+'.',
      detail:'Native scheduler execution, optional provider execution, Gather admission, and Context Seal admission are separate evidence states. Zero optional execution resources does not imply a provider call.',
      receiptRef:runtimeOwner?.receiptId??runtimeOwner?.turnId??null,selection,at,identitySuffix:String(runtimeOwner?.receiptId??runtimeOwner?.turnId??auditJobs.length),
      metadata:{logicalJobCount:auditJobs.length,nativeResourceIds:nativeIds,optionalExecutionResourceIds:optionalIds,jobs:auditJobs},
    }));
  }

  for(const row of diag.resources?.rows??[]){
    if(!exactResourceExecution(row.lastExecution,selection))continue;
    const executionPurpose=technicalReason(row.lastExecution?.purpose??row.lastExecution?.executionPurpose??row.lastProbe?.purpose??row.lastQualification?.purpose);
    const qualificationProbe=executionPurpose==='QUALIFICATION_PROBE';
    if(qualificationProbe||(!row.physicalExecutionAttempted&&!row.lastExecution))continue;
    const succeeded=Boolean(row.physicalExecutionSucceeded??row.lastExecution?.status==='SUCCESS');
    const responseMetadata=safeCompletionResponseMetadata(row.lastExecution?.responseMetadata);
    const generationBudget=safeSceneGenerationBudget(row.lastExecution?.generationBudget);
    out.push(entry({
      type:'RESOURCE_ATTEMPT',status:succeeded?'SUCCEEDED':'FAILED',title:'Physical resource attempt',
      summary:String(row.displayName??row.id??'Resource')+' '+(succeeded?'completed a physical execution attempt.':'reported a physical execution failure.'),
      detail:'This evidence comes from the resource execution read model, not connection or configuration state. QUALIFICATION_PROBE traffic is excluded from cognitive execution.'+(responseMetadata?' Completion: '+String(responseMetadata.finishReason??'unknown finish reason')+'; content '+String(responseMetadata.contentType)+'; reasoning present '+responseMetadata.reasoningPresent+'; output tokens '+String(responseMetadata.completionTokens??'unknown')+'.':''),
      receiptRef:row.lastExecution?.receiptId??row.lastExecution?.executionId??null,selection,at,
      identitySuffix:String(row.id??'resource')+':'+String(row.lastExecution?.at??row.lastExecution?.completedAt??row.lastExecution?.status??succeeded),
      metadata:{resourceId:row.id??null,providerId:row.providerId??null,modelId:row.modelId??null,workerId:row.workerId??null,measurementClass:row.measurementClass??null,executionPurpose,succeeded,latencyMs:finite(row.lastExecution?.latencyMs),responseMetadata,generationBudget},
    }));
  }


  const optionalRows=(diag.resources?.rows??[]).filter(row=>['JEV','SIDECAR','VECTORING'].includes(String(row.kind??'').toUpperCase())).slice(0,24);
  const nativeJev=path.jev??ownerReceipt?.producers?.jev??null;
  const jevIdentity=nativeJev?.selection??nativeJev;
  const nativeJevAttempt=nativeJev?.physicalAttempt===true&&Boolean(nativeJev.receiptId)&&
    ['chatId','turnId','generationId'].every(key=>jevIdentity?.[key]===selection[key])&&
    !selectionFenceConflict(jevIdentity,selection);
  if(optionalRows.length||nativeJevAttempt){
    const jevReason=technicalReason(path.jev?.reasonCode??path.jev?.reason??path.jev?.outcome??path.jev?.state);
    const lifecycleRows=optionalRows.map(row=>{
      const kind=String(row.kind??'').toUpperCase();
      const executionPurpose=technicalReason(row.lastExecution?.purpose??row.lastExecution?.executionPurpose??row.lastProbe?.purpose??row.lastQualification?.purpose);
      const qualificationProbe=executionPurpose==='QUALIFICATION_PROBE';
      const attempted=!qualificationProbe&&exactResourceExecution(row.lastExecution,selection)&&Boolean(row.physicalExecutionAttempted||row.lastExecution),succeeded=attempted&&Boolean(row.physicalExecutionSucceeded??row.lastExecution?.status==='SUCCESS');
      const returned=attempted?(typeof row.physicalExecutionReturned==='boolean'?row.physicalExecutionReturned:typeof row.lastExecution?.returned==='boolean'?row.lastExecution.returned:null):null;
      const failed=attempted&&!succeeded&&Boolean(row.lastFailure||row.lastExecution?.status==='FAIL');
      const skipReason=qualificationProbe?'QUALIFICATION_PROBE':kind==='JEV'&&jevReason==='JEV_NOT_REQUIRED'?'JEV_NOT_REQUIRED':null;
      const ownerAcceptanceState=attempted&&typeof row.ownerAccepted==='boolean'?(row.ownerAccepted?'ACCEPTED':'REJECTED'):'NO_EVIDENCE';
      return{id:row.id??null,kind,state:row.state??null,configured:true,qualifiedCallable:Boolean(row.callable),attempted,returned,succeeded,failed,ownerAccepted:attempted&&row.ownerAccepted===true,ownerAcceptanceState,ownerAcceptanceSource:attempted?row.ownerAcceptanceSource??null:null,skipReason,executionPurpose,qualificationProbe,measurementClass:row.measurementClass??null,receiptId:row.lastExecution?.receiptId??null};
    });
    // Native Decision Core publishes Jev attempts separately from the optional
    // resource registry. Retain its exact receipt without claiming that a
    // configured connection executed it, or that an advisory settled canon.
    if(nativeJevAttempt&&!lifecycleRows.some(row=>row.attempted&&row.receiptId===nativeJev.receiptId)){
      const succeeded=nativeJev.returned===true;
      lifecycleRows.push({id:'native-jev:'+nativeJev.receiptId,kind:'JEV',state:nativeJev.outcome??nativeJev.status??null,
        configured:false,qualifiedCallable:false,attempted:true,returned:succeeded,succeeded,failed:!succeeded,
        ownerAccepted:false,ownerAcceptanceState:'NO_EVIDENCE',ownerAcceptanceSource:null,skipReason:null,
        executionPurpose:'TYPED_ADVISORY',qualificationProbe:false,measurementClass:'NEXUS_DECISION_CORE',receiptId:nativeJev.receiptId});
    }
    out.push(entry({
      type:'OPTIONAL_RESOURCE_LIFECYCLE',status:'RECORDED',title:'Optional resource lifecycle',
      summary:lifecycleRows.filter(row=>row.configured).length+' configured · '+lifecycleRows.filter(row=>row.qualifiedCallable).length+' callable · '+lifecycleRows.filter(row=>row.attempted).length+' attempted.',
      detail:'Configured, callable, attempted, succeeded or failed, and owner-accepted are independent states. JEV_NOT_REQUIRED is an intentional skip when no provider attempt occurred.',
      selection,at,identitySuffix:lifecycleRows.map(row=>[row.id,row.state,row.attempted,row.succeeded,row.failed,row.ownerAccepted,row.skipReason].join(':')).join('|'),
      metadata:{resources:lifecycleRows},
    }));
  }

  if(gather){
    const counts=gather.counts??{},returned=Object.values(counts).reduce((sum,value)=>sum+(Number(value)||0),0);
    out.push(entry({
      type:'GATHER',status:gather.state??'COMPLETE',title:'Gather returned',
      summary:returned+' result'+(returned===1?'':'s')+' recorded; '+Number(counts.ADMITTED??0)+' admitted by Gather.',
      detail:'Gather disposition is recorded independently from Context Seal admission.',
      receiptRef:gather.receiptId??null,selection,at,identitySuffix:gather.receiptId??JSON.stringify(counts),
      metadata:{counts:{ADMITTED:Number(counts.ADMITTED??0),LATE:Number(counts.LATE??0),STALE:Number(counts.STALE??0),REJECTED:Number(counts.REJECTED??0),INVALID:Number(counts.INVALID??0)},results:(gather.results??[]).slice(0,64).map(row=>({resultId:row.resultId??null,taskId:row.taskId??null,jobId:row.jobId??null,status:row.status??null,accepted:row.accepted===true,resourceId:row.resourceId??null,destination:row.destination??null,capability:row.capability??null,providerAttempted:row.providerAttempted===true,at:finite(row.at??row.completedAt),reasonCode:technicalReason(row.reasonCode??row.reason)}))},
    }));
  }

  if(seal){
    const admitted=[...(seal.effectiveAdmittedResultIds??seal.admittedResultIds??[])];
    out.push(entry({
      type:'CONTEXT_SEAL',status:seal.sealedState===false?'UNSEALED':'SEALED',title:'Context Seal',
      summary:admitted.length+' result id'+(admitted.length===1?'':'s')+' admitted by the Context Seal owner.',
      detail:'Only owner-published admitted result IDs are counted as sealed context contributions.',
      receiptRef:seal.sealId??seal.receiptId??null,selection,at,identitySuffix:seal.sealId??seal.receiptId??admitted.join(','),
      metadata:{admittedResultCount:admitted.length,admittedResultIds:admitted,rejectedResultIds:[...(seal.rejectedResultIds??[])],lateResultIds:[...(seal.lateResultIds??[])],staleResultIds:[...(seal.staleResultIds??[])]},
    }));
  }

  if(pp){
    out.push(entry({
      type:'PROMPT_PLAN',status:pp.status??'PUBLISHED',title:'Prompt delivery plan',
      summary:'PromptPlan '+String(pp.promptPlanId??'receipt')+' was published for this generation.',
      detail:'A PromptPlan proves owner context preparation; it does not prove SillyTavern received or used the prompt.',
      receiptRef:pp.promptPlanId??null,selection,at,identitySuffix:pp.promptPlanId??String(pp.generationId??selection.generationId),
      metadata:{promptPlanId:pp.promptPlanId??null,totalTokens:finite(pp.totalTokens),budgetTotal:finite(pp.budgetTotal),sealState:pp.seal?.sealedState??null},
    }));
  }

  if(hostDelivery?.kind==='SillyTavernHostDeliveryReceipt'){
    const injected=Boolean(hostDelivery.promptInjected??hostDelivery.requestInjectedAt),completed=Boolean(hostDelivery.responseCompleted??hostDelivery.completedAt),aborted=String(hostDelivery.state??'').toUpperCase()==='ABORTED';
    out.push(entry({
      type:'HOST_DELIVERY',status:aborted?'ABORTED':completed?'COMPLETED':injected?'INJECTED':'PREPARED',title:'SillyTavern prompt delivery',
      summary:aborted?'The exact generation was aborted before completion.':completed?'SillyTavern observed the request payload and the generation completed.':injected?'SillyTavern observed the prepared payload at the model-request hook.':'A PromptPlan was prepared; host injection has not been observed.',
      detail:'Host delivery is separate from PromptPlan and Context Seal. Only the host receipt can prove request-payload injection.',
      receiptRef:hostDelivery.receiptId??hostDelivery.generationId??null,selection,at,identitySuffix:hostDelivery.receiptId??String(hostDelivery.state??'host'),
      metadata:{state:hostDelivery.state??null,promptPlanId:hostDelivery.promptPlanId??null,contextSealId:hostDelivery.contextSealId??null,preparedAt:finite(hostDelivery.preparedAt),requestInjectedAt:finite(hostDelivery.requestInjectedAt),completedAt:finite(hostDelivery.completedAt),requestHook:hostDelivery.requestHook??null,renderedPayloadDigest:hostDelivery.renderedPayloadDigest??null,requestPayloadDigest:hostDelivery.requestPayloadDigest??null,renderedMessageCount:finite(hostDelivery.renderedMessageCount),promptInjected:Boolean(hostDelivery.promptInjected??hostDelivery.requestInjectedAt),hostObserved:Boolean(hostDelivery.hostObserved??hostDelivery.requestInjectedAt),responseCompleted:Boolean(hostDelivery.responseCompleted??hostDelivery.completedAt),abortCode:hostDelivery.abortCode??null},
    }));
  }else if(String(ownerReceipt?.delivery?.hostObserved?.state??'').toUpperCase()==='OBSERVED'){
    const observed=ownerReceipt.delivery.hostObserved;
    out.push(entry({
      type:'HOST_DELIVERY',status:'OBSERVED',title:'Observed host delivery',
      summary:'The Brain owner receipt records matching host-boundary delivery evidence for this generation.',
      detail:'Observed delivery is retained exactly as owner evidence. Response completion is not inferred without a richer SillyTavern host receipt.',
      receiptRef:observed.requestId??ownerReceipt?.producers?.delivery?.id??null,selection,at,identitySuffix:observed.requestId??'owner-observed',
      metadata:{state:'OBSERVED',requestId:observed.requestId??null,matching:observed.matching??null,live:observed.live??null,observedRoles:[...(observed.observedRoles??[])].slice(0,16),responseCompleted:null},
    }));
  }

  if(pipeline.learningReceipt){
    const learning=inspections.learning?.payload??null;
    out.push(entry({
      type:'LEARNING',status:'RECORDED',title:'Post-response learning',
      summary:'The owner published a learning receipt for this completed generation.',
      detail:'Only receipt identity and status are persisted; no response text or hidden reasoning is stored.',
      receiptRef:inspections.learning?.receiptRef??learning?.id??learning?.kind??null,selection,at,identitySuffix:inspections.learning?.receiptRef??learning?.id??learning?.kind??'learning',
      metadata:{kind:learning?.kind??pipeline.learningKind??null,status:learning?.status??'RECORDED'},
    }));
  }
  return out;
}


const CAUSAL_OWNER_STAGES=Object.freeze([
  {id:'hostObservation',label:'Host observation',producer:'SILLYTAVERN_HOST',consumer:'SCENE',phase:12},
  {id:'scene',label:'Scene',producer:'SCENE',consumer:'HOT_COGNITION',phase:14},
  {id:'hotCognition',label:'Hot Cognition',producer:'HOT_COGNITION',consumer:'COGNITIVE_CHOICE',phase:16},
  {id:'cognitiveChoice',label:'Cognitive Choice',producer:'COGNITIVE_CHOICE',consumer:'RUNTIME',phase:18},
  {id:'sensory',label:'Sensory / Retrieval',producer:'SENSORY_RETRIEVAL',consumer:'TRUTH',phase:22},
  {id:'truth',label:'Truth',producer:'TRUTH',consumer:'GATHER',phase:24},
  {id:'runtime',label:'Runtime jobs',producer:'RUNTIME',consumer:'WORKERS',phase:30},
  {id:'jev',label:'Jev',producer:'JEV',consumer:'GATHER',phase:42},
  {id:'sidecar',label:'Sidecar',producer:'SIDECAR',consumer:'GATHER',phase:44},
  {id:'vectoring',label:'Vectoring',producer:'VECTORING',consumer:'GATHER',phase:46},
  {id:'gather',label:'Gather',producer:'GATHER',consumer:'CONTEXT_SEAL',phase:70},
  {id:'contextSeal',label:'Context Seal',producer:'CONTEXT_SEAL',consumer:'PROMPT_PLAN',phase:80},
  {id:'promptPlan',label:'PromptPlan',producer:'PROMPT_PLAN',consumer:'CORE_RENDER',phase:90},
  {id:'compiledDelivery',label:'Compiled / sealed delivery',producer:'CORE_RENDER',consumer:'SILLYTAVERN_HOST',phase:95},
  {id:'delivery',label:'Observed host delivery',producer:'SILLYTAVERN_HOST',consumer:'MODEL_PROVIDER',phase:100},
  {id:'learning',label:'Post-response learning',producer:'LEARNING',consumer:'MEMORY_LORE',phase:110},
  {id:'memory',label:'Memory owner',producer:'MEMORY',consumer:'COGNITIVE_STATE',phase:112},
  {id:'lore',label:'Lore owner',producer:'LORE',consumer:'COGNITIVE_STATE',phase:114},
]);

function deriveCausalOwnerEdges({selection,ownerReceipt,path,pipeline,operations,diagnostics,promptPlan,at}={}){
  const producers=ownerReceipt?.producers??{},inspections=operations?.inspections??{},resources=diagnostics?.resources?.rows??[];
  const resource=(kind)=>resources.find(row=>String(row?.kind??'').toUpperCase()===kind)??null;
  const selectedRefs=ownerReceipt?.sourceRevisions?.selectedRefs??selection?.sourceRevisionRefs??[];
  const evidenceFor=(stage)=>{
    const owner=producers?.[stage]??null;
    if(owner&&String(owner.status??'').toUpperCase()!=='UNAVAILABLE')return ownerEvidence(owner,stage,selectedRefs,selection);
    if(stage==='hostObservation'){
      const host=producers?.hostObservation??producers?.host??null;
      return host&&String(host.status??'').toUpperCase()!=='UNAVAILABLE'?ownerEvidence(host,stage,selectedRefs,selection):null;
    }
    if(stage==='scene'&&path?.scene)return readModelEvidence(path.scene,inspections.scene,stage,selectedRefs,selection);
    if(stage==='hotCognition'&&path?.hotCognition)return readModelEvidence(path.hotCognition,inspections.hotCognition,stage,selectedRefs,selection);
    if(stage==='cognitiveChoice'&&path?.choice)return readModelEvidence(path.choice,inspections.choice,stage,selectedRefs,selection);
    if(stage==='sensory'&&path?.sensory)return readModelEvidence(path.sensory,inspections.sensory,stage,selectedRefs,selection);
    if(stage==='truth'&&path?.truth)return readModelEvidence(path.truth,inspections.truth,stage,selectedRefs,selection);
    if(stage==='runtime'){
      const receipt=inspections.runtime?.payload?.receipt??inspections.runtime?.payload??path?.scatter??null;
      return receipt?readModelEvidence(receipt,inspections.runtime,stage,selectedRefs,selection):null;
    }
    if(stage==='jev'){
      if(path?.jev)return readModelEvidence(path.jev,inspections.jev,stage,selectedRefs,selection,{reasonCode:technicalReason(path.jev?.reasonCode??path.jev?.reason??path.jev?.outcome)});
      return optionalResourceEvidence(resource('JEV'),stage,selectedRefs,selection);
    }
    if(stage==='sidecar')return optionalResourceEvidence(resource('SIDECAR'),stage,selectedRefs,selection);
    if(stage==='vectoring')return optionalResourceEvidence(resource('VECTORING'),stage,selectedRefs,selection);
    if(stage==='gather'&&path?.gather)return readModelEvidence(path.gather,inspections.gather,stage,selectedRefs,selection);
    if(stage==='contextSeal'&&path?.seal)return readModelEvidence(path.seal,inspections.seal,stage,selectedRefs,selection);
    if(stage==='promptPlan'&&(promptPlan||path?.promptPlan))return readModelEvidence(promptPlan??path.promptPlan,inspections.promptPlan,stage,selectedRefs,selection);
    if(stage==='compiledDelivery'){
      const compiled=ownerReceipt?.delivery?.compiled;
      return compiled&&String(compiled.state??'').toUpperCase()!=='UNAVAILABLE'?readModelEvidence(compiled,null,stage,selectedRefs,selection):null;
    }
    if(stage==='delivery'){
      const observed=ownerReceipt?.delivery?.hostObserved??null;
      if(observed&&String(observed.state??'').toUpperCase()==='OBSERVED')return readModelEvidence(observed,inspections.generation,stage,selectedRefs,selection);
      const host=inspections.generation?.payload??null;
      return host?.kind==='SillyTavernHostDeliveryReceipt'&&Boolean(host.hostObserved??host.requestInjectedAt)?readModelEvidence(host,inspections.generation,stage,selectedRefs,selection):null;
    }
    if(stage==='learning'&&pipeline?.learningReceipt)return readModelEvidence(inspections.learning?.payload??{kind:pipeline.learningKind??'LearningReceipt',status:'RECORDED'},inspections.learning,stage,selectedRefs,selection);
    if(stage==='memory'&&inspections.memory?.available)return readModelEvidence(inspections.memory.payload??{},inspections.memory,stage,selectedRefs,selection);
    if(stage==='lore'){
      if(inspections.lore?.available)return readModelEvidence(inspections.lore.payload??{},inspections.lore,stage,selectedRefs,selection);
      if(path?.lore)return readModelEvidence(path.lore,inspections.lore,stage,selectedRefs,selection);
    }
    return null;
  };
  return CAUSAL_OWNER_STAGES.map(def=>{
    const evidence=evidenceFor(def.id),explicitUnavailable=producers?.[def.id]&&String(producers[def.id].status??'').toUpperCase()==='UNAVAILABLE'?producers[def.id]:null;
    const deliveryUnavailable=def.id==='delivery'&&ownerReceipt?.delivery?.hostObserved&&String(ownerReceipt.delivery.hostObserved.state??'').toUpperCase()!=='OBSERVED'?ownerReceipt.delivery.hostObserved:null;
    const compiledUnavailable=def.id==='compiledDelivery'&&ownerReceipt?.delivery?.compiled&&String(ownerReceipt.delivery.compiled.state??'').toUpperCase()==='UNAVAILABLE'?ownerReceipt.delivery.compiled:null;
    const unavailable=explicitUnavailable??deliveryUnavailable??compiledUnavailable;
    const status=evidence?.status??'NO_EVIDENCE',reasonCode=evidence?.reasonCode??technicalReason(unavailable?.reason)??'OWNER_STAGE_RECEIPT_NOT_PUBLISHED';
    const receiptRef=evidence?.receiptId??null,parentReceiptId=evidence?.parentReceiptId??null;
    const summary=evidence
      ? def.producer+' → '+def.consumer+' published '+status+(receiptRef?' ('+receiptRef+')':'')+'.'
      : 'Expected '+def.producer+' → '+def.consumer+': no owner evidence for this selected turn.';
    return entry({
      type:'OWNER_EDGE',subtype:def.id,status,title:'Causal edge · '+def.label,summary,
      detail:evidence?'Backed by selected-turn owner evidence. Parent linkage stays unknown unless the owner publishes parentReceiptId.':'No execution or acceptance is inferred from configuration, connection, a plan, or another stage.',
      receiptRef,selection,at,identitySuffix:[def.id,receiptRef??'none',status,reasonCode].join(':'),
      metadata:{stage:def.id,producer:def.producer,consumer:def.consumer,edgeClass:'EXPECTED_OWNER_BOUNDARY',reasonCode,parentReceiptId,
        durationMs:evidence?.durationMs??null,ownerAccepted:evidence?.ownerAccepted??null,lifecycleState:evidence?.lifecycleState??status,
        configured:evidence?.configured??null,qualified:evidence?.qualified??null,physicalAttempt:evidence?.physicalAttempt??null,returned:evidence?.returned??null,
        worldRevision:evidence?.worldRevision??selection.worldRevision??null,sceneRevision:evidence?.sceneRevision??selection.sceneRevision??null,
        sourceRevisionRefs:[...(evidence?.sourceRevisionRefs??selectedRefs??[])].slice(0,32),correlationId:selection.correlationId??null,evidenceKind:evidence?.evidenceKind??null,phase:def.phase},
    });
  });
}
function ownerEvidence(value,stage,selectedRefs,selection){
  const meta=value?.metadata??{};
  return{status:String(value?.lifecycleState??value?.state??value?.status??'PUBLISHED').toUpperCase(),receiptId:value?.id??value?.receiptId??value?.promptPlanId??null,
    parentReceiptId:value?.parentReceiptId??value?.parentId??null,durationMs:finite(value?.durationMs),ownerAccepted:typeof value?.ownerAccepted==='boolean'?value.ownerAccepted:null,
    lifecycleState:value?.lifecycleState??value?.state??value?.status??'PUBLISHED',sourceRevisionRefs:[...(value?.sourceRevisionRefs??selectedRefs??[])].slice(0,32),
    worldRevision:numberOrNull(value?.worldRevision??selection?.worldRevision),sceneRevision:numberOrNull(value?.sceneRevision??value?.revision??selection?.sceneRevision),
    configured:booleanOrNull(meta.configured),qualified:booleanOrNull(meta.qualified),physicalAttempt:booleanOrNull(meta.physicalAttempt),returned:booleanOrNull(meta.returned),
    evidenceKind:value?.kind??('owner:'+stage),reasonCode:technicalReason(value?.reasonCode??value?.reason)};
}
function readModelEvidence(value,inspection,stage,selectedRefs,selection,overrides={}){
  return{status:String(overrides.status??value?.lifecycleState??value?.state??value?.status??(stage==='compiledDelivery'?'COMPILED_AND_SEALED':'PUBLISHED')).toUpperCase(),
    receiptId:inspection?.receiptRef??value?.receiptId??value?.id??value?.promptPlanId??value?.sealId??value?.snapshotId??value?.envelopeId??null,
    parentReceiptId:value?.parentReceiptId??value?.parentId??null,durationMs:finite(value?.durationMs),ownerAccepted:typeof value?.ownerAccepted==='boolean'?value.ownerAccepted:null,
    lifecycleState:value?.lifecycleState??value?.state??value?.status??null,sourceRevisionRefs:[...(value?.sourceRevisionRefs??value?.sourceRevisionIds??selectedRefs??[])].slice(0,32),
    worldRevision:numberOrNull(value?.worldRevision??selection?.worldRevision),sceneRevision:numberOrNull(value?.sceneRevision??value?.revision??selection?.sceneRevision),
    evidenceKind:value?.kind??('read-model:'+stage),reasonCode:overrides.reasonCode??technicalReason(value?.reasonCode??value?.reason)};
}
function optionalResourceEvidence(row,stage,selectedRefs,selection){
  if(!row)return null;
  if(!exactResourceExecution(row.lastExecution,selection))return null;
  const executionPurpose=technicalReason(row.lastExecution?.purpose??row.lastExecution?.executionPurpose??row.lastProbe?.purpose??row.lastQualification?.purpose);
  const qualificationProbe=executionPurpose==='QUALIFICATION_PROBE';
  const attempted=!qualificationProbe&&Boolean(row.physicalExecutionAttempted||row.lastExecution);
  const returned=attempted?(typeof row.physicalExecutionReturned==='boolean'?row.physicalExecutionReturned:typeof row.lastExecution?.returned==='boolean'?row.lastExecution.returned:null):null;
  const accepted=attempted&&typeof row.ownerAccepted==='boolean'?row.ownerAccepted:null;
  const status=qualificationProbe?'QUALIFIED_PROBE':accepted===true?'OWNER_ACCEPTED':returned===true?'RETURNED':attempted?'ATTEMPTED':row.callable?'QUALIFIED':'CONFIGURED';
  return{status,receiptId:qualificationProbe?null:row.lastExecution?.receiptId??row.lastExecution?.executionId??null,parentReceiptId:qualificationProbe?null:row.lastExecution?.parentReceiptId??null,
    durationMs:qualificationProbe?null:finite(row.lastExecution?.latencyMs),ownerAccepted:accepted,lifecycleState:status,configured:true,qualified:Boolean(row.callable),physicalAttempt:attempted,returned,
    executionPurpose,qualificationProbe,
    sourceRevisionRefs:[...(selectedRefs??[])].slice(0,32),worldRevision:numberOrNull(selection?.worldRevision),sceneRevision:numberOrNull(selection?.sceneRevision),
    evidenceKind:'optional-resource:'+stage,reasonCode:qualificationProbe?'QUALIFICATION_PROBE':technicalReason(row.skipReason??row.lastFailure?.code??row.lastExecution?.reasonCode)};
}
function exactResourceExecution(execution,selection){
  return Boolean(selection?.chatId&&selection?.turnId&&selection?.generationId&&
    execution?.selection?.chatId===selection.chatId&&execution?.selection?.turnId===selection.turnId&&execution?.selection?.generationId===selection.generationId&&
    (!selection.correlationId||execution.selection.correlationId===selection.correlationId));
}

function expectedWorkJournalEntry(expectedWork,selection,at){
  const items=Array.isArray(expectedWork?.items)?expectedWork.items.slice(0,64).map(projectExpectedWork):[];
  if(!items.length)return null;
  const counts={DONE:0,DUE:0,BLOCKED:0,FAILED:0,SKIPPED_WITH_REASON:0,DEFERRED:0,STALE:0,LATE:0};
  for(const row of items)counts[row.status]=(counts[row.status]??0)+1;
  const unresolved=items.filter(row=>row.status!=='DONE'&&row.status!=='SKIPPED_WITH_REASON').length;
  return entry({type:'OBLIGATION_RECONCILIATION',status:unresolved?'OPEN':'RECONCILED',title:'Expected cognitive work',
    summary:items.length+' expected owner step'+(items.length===1?'':'s')+' · '+counts.DONE+' done · '+counts.BLOCKED+' blocked · '+counts.FAILED+' failed · '+counts.SKIPPED_WITH_REASON+' skipped.',
    detail:'Owner-declared expected work is reconciled only against explicit causal evidence. Missing execution, result, owner admission, or Settlement stays visible.',
    selection,at,identitySuffix:'selected-turn-expected-work',metadata:{counts,items}});
}
function projectExpectedWork(row={}){
  const cause=row.cause??{};
  return{expectedId:safeDiagnosticText(row.expectedId??'',256),owner:safeDiagnosticText(row.owner??'',128),ownerSignalId:safeDiagnosticText(row.ownerSignalId??'',256),
    status:technicalReason(row.status)??'UNKNOWN',reasonCode:technicalReason(row.reasonCode)??'NO_EVIDENCE',taskId:row.taskId==null?null:safeDiagnosticText(row.taskId,256),
    lifecycleStatus:technicalReason(row.lifecycleStatus),executionStatus:technicalReason(row.executionStatus),missingEvidence:(row.missingEvidence??[]).map(technicalReason).filter(Boolean).slice(0,16),
    blockedBy:(row.blockedBy??[]).map(value=>safeDiagnosticText(value,256)).slice(0,16),eventType:technicalReason(cause.eventType),producer:safeDiagnosticText(cause.producerId??'',128)||null,
    consumer:safeDiagnosticText(cause.consumerId??'',128)||null,correlationId:safeDiagnosticText(cause.correlationId??'',256)||null,worldRevision:numberOrNull(cause.worldRevision),
    sceneRevision:numberOrNull(cause.sceneRevision),sourceRevisionRefs:[...(cause.sourceRevisionRefs??[])].map(value=>safeDiagnosticText(value,256)).slice(0,32),
    evidenceStages:(row.evidenceStages??[]).slice(-32).map(evidence=>({id:safeDiagnosticText(evidence.id??'',256),eventKind:technicalReason(evidence.eventKind),
      lifecycleState:technicalReason(evidence.lifecycleState),reasonCode:technicalReason(evidence.reasonCode),producerId:safeDiagnosticText(evidence.producerId??'',128)||null,
      consumerId:safeDiagnosticText(evidence.consumerId??'',128)||null,parentReceiptId:safeDiagnosticText(evidence.parentReceiptId??'',256)||null,
      ownerAccepted:typeof evidence.ownerAccepted==='boolean'?evidence.ownerAccepted:null,durationMs:finite(evidence.durationMs)}))};
}

function producerDetail(id,path,pipeline,row){
  if(id==='runtime')return{summary:pipeline.mappingReceipt?String(pipeline.logicalJobsMapped??0)+' logical jobs mapped.':'Runtime owner status updated.',detail:pipeline.mappingReceipt?'Mapping is visible; physical execution requires separate execution telemetry.':row.reason};
  if(id==='coprocessor')return{summary:pipeline.executionReceipt?String(pipeline.physicalExecutionAttempts??0)+' physical attempts · '+String(pipeline.physicalExecutionSucceeded??0)+' succeeded.':'No selected-turn physical execution receipt.',detail:'Configured or connected resources are not counted as executed.'};
  if(id==='choice')return{summary:path.choice?String(path.choice.admitted?.length??0)+' admitted · '+String(path.choice.skipped?.length??0)+' skipped.':row.reason,detail:'Cognitive Choice is shown from the selected-turn owner receipt.'};
  if(id==='truth')return{summary:path.truth?'Truth owner published '+sumCounts(path.truth.counts)+' classified result(s).':row.reason,detail:'Truth status comes from the selected-turn Truth assessment.'};
  if(id==='jev')return{summary:path.jev?'Jev '+String(path.jev.outcome??path.jev.state??'receipt')+'.':row.reason,detail:'Jev connection state is not execution evidence; this notice exists only when the selected-turn cognition path publishes Jev state.'};
  if(id==='gather')return{summary:path.gather?'Gather owner receipt published.':row.reason,detail:'Returned and contained results remain distinct from Context Seal admission.'};
  if(id==='seal')return{summary:path.seal?'Context Seal owner receipt published.':row.reason,detail:'Only explicit admitted result IDs count as sealed contributions.'};
  if(id==='promptPlan')return{summary:path.promptPlan?'PromptPlan prepared for generation.':row.reason,detail:'PromptPlan is not proof of SillyTavern prompt receipt.'};
  if(id==='learning')return{summary:pipeline.learningReceipt?'Post-response learning receipt recorded.':row.reason,detail:'Learning is recorded after response completion.'};
  return{summary:row.reason||label(id)+' owner status updated.',detail:'Selected-turn owner status; no raw narrative content is retained.'};
}

function sameEvidence(a,b){
  if(!a||!b)return false;
  return a.status===b.status&&a.summary===b.summary&&a.detail===b.detail&&a.receiptRef===b.receiptRef&&JSON.stringify(a.metadata??{})===JSON.stringify(b.metadata??{});
}
function entry({type,subtype=null,status,title,summary,detail,receiptRef=null,selection,at,identitySuffix='',metadata={}}){
  const id=[type,subtype??'',selection.chatId,selection.turnId,selection.generationId,String(identitySuffix)].join(':');
  return{
    kind:'NexusDemoEvidenceEntry',contractVersion:DEMO_EVIDENCE_JOURNAL_VERSION,id,identityKey:id,type,subtype,status:String(status??'UNKNOWN'),title:String(title??type),
    summary:safeDiagnosticText(summary??''),detail:safeDiagnosticText(detail??summary??''),receiptRef:receiptRef==null?null:safeDiagnosticText(receiptRef,512),selection:clone(selection),at:Number(at??0),metadata:sanitizeMetadata(metadata),
    rawPromptIncluded:false,storyTextIncluded:false,credentialsIncluded:false,hiddenReasoningIncluded:false,
  };
}
function normalizeSelection(value={}){return{chatId:text(value.chatId),turnId:text(value.turnId),generationId:text(value.generationId),correlationId:text(value.correlationId),worldRevision:numberOrNull(value.worldRevision),sceneRevision:numberOrNull(value.sceneRevision),sourceRevisionRefs:[...new Set((value.sourceRevisionRefs??[]).map(text).filter(Boolean))].slice(0,32)};}
function selectionKey(value={}){const x=normalizeSelection(value);return[x.chatId??'',x.turnId??'',x.generationId??''].join('|');}
function emptyState(){return{kind:'NexusDemoEvidenceJournal',contractVersion:DEMO_EVIDENCE_JOURNAL_VERSION,updatedAt:null,turns:[]};}
function sumCounts(value={}){return Object.values(value??{}).reduce((sum,row)=>sum+(Number(row)||0),0);}
function finite(value){const n=Number(value);return Number.isFinite(n)?n:null;}
function numberOrNull(value){const n=Number(value);return value==null||!Number.isFinite(n)?null:n;}
function booleanOrNull(value){return typeof value==='boolean'?value:null;}
function text(value){const x=value==null?'':String(value).trim();return x||null;}
function label(value){return String(value??'producer').replace(/([a-z])([A-Z])/g,'$1 $2').replace(/[_-]+/g,' ').replace(/\b\w/g,m=>m.toUpperCase());}
function filePart(value){return String(value??'').replace(/[^a-z0-9._-]+/gi,'-').replace(/^-+|-+$/g,'').slice(0,80)||'unknown';}
function technicalReason(value){const x=value==null?'':String(value).trim().toUpperCase();return /^[A-Z0-9_:-]{1,128}$/.test(x)?x:null;}
const BLOCKED_METADATA_KEYS=new Set(['rawprompt','prompt','prompttext','story','storytext','lorebody','loretext','content','contentbody','response','rawresponse','providerresponse','responsebody','messages','reasoning','hiddenreasoning','chainofthought','apikey','authorization','credential','credentials','password','secret','accesstoken','refreshtoken']);
function safeDiagnosticText(value,limit=2048){
  let out=String(value??'');
  out=out.replace(/(\bBearer\s+)[A-Za-z0-9._~+/=-]+/gi,'$1[REDACTED]');
  out=out.replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g,'[REDACTED]');
  out=out.replace(/(\b(?:api[_-]?key|authorization|credential|secret|password|access[_-]?token|refresh[_-]?token)\b\s*[:=]\s*)([^\s,;&]+)/gi,'$1[REDACTED]');
  return out.length>limit?out.slice(0,limit)+'…[clipped]':out;
}
function sanitizeMetadata(value,depth=0,key=''){
  if(depth>7)return'[depth-clipped]';
  const normalized=String(key??'').toLowerCase().replace(/[^a-z0-9]/g,'');
  if(BLOCKED_METADATA_KEYS.has(normalized))return'[REDACTED]';
  if(value==null||typeof value==='number'||typeof value==='boolean')return value;
  if(typeof value==='string')return safeDiagnosticText(value);
  if(Array.isArray(value))return value.slice(0,64).map(row=>sanitizeMetadata(row,depth+1,key));
  if(typeof value==='object'){const out={};for(const [name,row] of Object.entries(value))out[name]=sanitizeMetadata(row,depth+1,name);return out;}
  return safeDiagnosticText(value);
}
function boundedJournalJson(state,maxBytes){
  let json=JSON.stringify(state);
  while(json.length>maxBytes&&state.turns.length>1){
    const protectedIndex=latestDeliveryTurnIndex(state.turns),dropIndex=state.turns.findIndex((_,index)=>index!==protectedIndex);
    state.turns.splice(dropIndex<0?0:dropIndex,1);json=JSON.stringify(state);
  }
  while(json.length>maxBytes&&state.turns.length===1&&(state.turns[0].entries?.length??0)>1){
    const entries=state.turns[0].entries,protectedIndex=latestDeliveryEntryIndex(entries),dropIndex=entries.findIndex((_,index)=>index!==protectedIndex);
    entries.splice(dropIndex<0?0:dropIndex,1);json=JSON.stringify(state);
  }
  if(json.length>maxBytes&&state.turns.length===1&&(state.turns[0].entries?.length??0)===1){
    state.turns[0].entries[0]=compactCriticalEntry(state.turns[0].entries[0]);json=JSON.stringify(state);
  }
  if(json.length>maxBytes){state.turns=[];state.updatedAt=state.updatedAt??null;json=JSON.stringify(state);}
  return json;
}
function isDeliveryEntry(row){return row?.type==='HOST_DELIVERY'||(row?.type==='OWNER_EDGE'&&row?.subtype==='delivery');}
function latestDeliveryEntryIndex(entries=[]){for(let i=entries.length-1;i>=0;i--)if(isDeliveryEntry(entries[i]))return i;return-1;}
function latestDeliveryTurnIndex(turns=[]){let chosen=-1,best=-Infinity;for(let i=0;i<turns.length;i++){for(const row of turns[i]?.entries??[]){if(isDeliveryEntry(row)&&Number(row.at??0)>=best){best=Number(row.at??0);chosen=i;}}}return chosen;}
function pruneEntriesPreservingDelivery(entries=[],limit=64){
  if(entries.length<=limit)return entries;
  const start=Math.max(0,entries.length-limit),keep=new Set(entries.slice(start).map(row=>row.identityKey));
  const protectedIndex=latestDeliveryEntryIndex(entries),protectedRow=protectedIndex>=0?entries[protectedIndex]:null;
  if(protectedRow&&!keep.has(protectedRow.identityKey)){
    const removable=entries.slice(start).find(row=>!isDeliveryEntry(row))??entries[start];
    keep.delete(removable.identityKey);keep.add(protectedRow.identityKey);
  }
  return entries.filter(row=>keep.has(row.identityKey));
}
function pruneTurnsPreservingDelivery(turns=[],limit=48){
  if(turns.length<=limit)return turns;
  const start=Math.max(0,turns.length-limit),keep=new Set(turns.slice(start).map(row=>row.key)),protectedIndex=latestDeliveryTurnIndex(turns),protectedTurn=protectedIndex>=0?turns[protectedIndex]:null;
  if(protectedTurn&&!keep.has(protectedTurn.key)){
    const removable=turns.slice(start).find(row=>latestDeliveryEntryIndex(row.entries??[])<0)??turns[start];
    keep.delete(removable.key);keep.add(protectedTurn.key);
  }
  return turns.filter(row=>keep.has(row.key));
}
function compactCriticalEntry(row){
  return{kind:row?.kind??'NexusDemoEvidenceEntry',contractVersion:DEMO_EVIDENCE_JOURNAL_VERSION,id:row?.id??'delivery',identityKey:row?.identityKey??row?.id??'delivery',type:row?.type??'HOST_DELIVERY',subtype:row?.subtype??null,status:row?.status??'UNKNOWN',title:safeDiagnosticText(row?.title??'Delivery',128),summary:safeDiagnosticText(row?.summary??'Latest delivery evidence retained.',256),detail:'Detail compacted by byte retention policy.',receiptRef:row?.receiptRef??null,selection:normalizeSelection(row?.selection??{}),at:Number(row?.at??0),metadata:{reasonCode:technicalReason(row?.metadata?.reasonCode),state:safeDiagnosticText(row?.metadata?.state??'',64)},rawPromptIncluded:false,storyTextIncluded:false,credentialsIncluded:false,hiddenReasoningIncluded:false};
}
function selectionFenceConflict(a={},b={}){
  for(const key of ['correlationId','worldRevision','sceneRevision'])if(a?.[key]!=null&&b?.[key]!=null&&String(a[key])!==String(b[key]))return true;
  const ar=[...(a?.sourceRevisionRefs??[])].map(String).sort(),br=[...(b?.sourceRevisionRefs??[])].map(String).sort();
  return ar.length&&br.length&&JSON.stringify(ar)!==JSON.stringify(br);
}
function selectionFenceCompatible(stored={},requested={}){return !selectionFenceConflict(stored,requested);}
function mergeSelectionFence(a={},b={}){
  return{...normalizeSelection(a),...Object.fromEntries(Object.entries(normalizeSelection(b)).filter(([,value])=>value!=null&&(!Array.isArray(value)||value.length))),sourceRevisionRefs:[...new Set([...(a?.sourceRevisionRefs??[]),...(b?.sourceRevisionRefs??[])].map(String))].sort()};
}
function clone(value){if(value==null)return value;if(typeof structuredClone==='function')return structuredClone(value);return JSON.parse(JSON.stringify(value));}
