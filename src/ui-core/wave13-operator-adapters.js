import {
  ProductDataMode, Wave6Health, clone, createProductSourceStatus, deepFreeze, normalizeWave6Health,
} from './wave6-contracts.js';
import {projectVectoringCausalTrace,safeVectoringExecution} from './vectoring-causal-trace.js';

export const OperatorProducerState=Object.freeze({
  LIVE:'LIVE',
  WORKING:'WORKING',
  IDLE:'IDLE',
  WAITING_FOR_TURN:'WAITING_FOR_TURN',
  DISCONNECTED:'DISCONNECTED',
  UNAVAILABLE:'UNAVAILABLE',
  DEGRADED:'DEGRADED',
});

const text=v=>v==null||v===''?null:String(v);
const fn=(x,names)=>{for(const name of names)if(typeof x?.[name]==='function')return x[name].bind(x);return null;};
const cloneSafe=v=>v==null?v:clone(v);

export class Wave13OwnerReadModelAdapter{
  constructor({label,producer,read,selectionProvider=()=>({}),turnBound=false,unavailableReason=null}={}){
    this.label=String(label||'Owner state');this.producer=producer??this.label;this.readFn=typeof read==='function'?read:null;
    this.selectionProvider=selectionProvider;this.turnBound=Boolean(turnBound);this.unavailableReason=unavailableReason;
  }
  read(){
    const selection=this.selectionProvider?.()??{};
    if(!this.readFn)return unavailable(this.label,this.unavailableReason??(this.label+' read contract is not exported by the host assembly.'),this.producer);
    if(this.turnBound&&selection.chatId&&!selection.turnId)return waiting(this.label,'Waiting for the selected chat to publish an active turn.',this.producer,selection);
    try{
      const raw=this.readFn(selection);
      if(raw==null)return idle(this.label,this.turnBound?'No owner receipt has been published for the selected turn.':'The producer is connected but has no current record.',this.producer,selection);
      assertSelection(raw,selection,this.label);
      const health=normalizeWave6Health(raw.health?.state??raw.health??raw.status??Wave6Health.READY,{fallback:Wave6Health.READY});
      const degraded=[Wave6Health.DEGRADED,Wave6Health.STALE,Wave6Health.BLOCKED].includes(health);
      return deepFreeze({
        source:createProductSourceStatus({
          mode:degraded?ProductDataMode.DEGRADED:ProductDataMode.LIVE,health,label:this.label,
          operationalState:degraded?OperatorProducerState.DEGRADED:health===Wave6Health.WORKING?OperatorProducerState.WORKING:OperatorProducerState.LIVE,
          impact:degraded?this.label+' owner state is degraded.':this.label+' owner state is current for the selected context.',
          reason:reasonOf(raw),producer:this.producer,revision:revisionOf(raw),connected:true,selection,freshness:freshnessOf(raw),
        }),
        data:cloneSafe(raw),
      });
    }catch(error){
      return degraded(this.label,this.label+' owner read failed for the selected context.',this.producer,selection,error);
    }
  }
}

export class Wave13CoprocessorStateUIAdapter{
  constructor({readState=null,selectionProvider=()=>({})}={}){this.readState=typeof readState==='function'?readState:null;this.selectionProvider=selectionProvider;}
  read(){
    const selection=this.selectionProvider?.()??{};
    if(!this.readState)return unavailable('Coprocessor','Worker 2 CognitionUiState is not exported by the host assembly.','CognitionUiState');
    if(selection.chatId&&!selection.turnId)return waiting('Coprocessor','Worker 2 telemetry is connected; waiting for an active turn.','CognitionUiState',selection);
    try{
      const raw=this.readState(selection);
      if(raw==null)return idle('Coprocessor','No Worker 2 cognition telemetry exists for the selected turn.','CognitionUiState',selection);
      assertSelection(raw,selection,'Coprocessor',{allowMissingIdentity:true});
      const state=String(raw.health?.state??raw.health??'READY').toUpperCase(),degraded=['DEGRADED','STALE','BLOCKED','ERROR','UNAVAILABLE'].includes(state);
      const activeRows=Array.isArray(raw.activeTasks)?raw.activeTasks:[];
      const hot=Number(raw.hotTasks??raw.hotTaskCount??raw.hotActivity??activeRows.filter(x=>String(x.placement??x.layer??x.lane??'').toUpperCase()==='HOT'||['L0','L1'].includes(x.layer)).length);
      const deep=Number(raw.deepTasks??raw.deepTaskCount??raw.deepActivity??activeRows.filter(x=>String(x.placement??x.layer??x.lane??'').toUpperCase()==='DEEP'||['L2','L3','L4'].includes(x.layer)).length);
      const active=Number(typeof raw.activeTasks==='number'?raw.activeTasks:activeRows.length);
      const queue=raw.queue&&typeof raw.queue==='object'?cloneSafe(raw.queue):{
        queued:Number(raw.queueEvents??raw.queuedTasks??0),yields:Number(raw.yieldCount??raw.yields??0),parks:Number(raw.parkCount??raw.parks??0),resumes:Number(raw.resumeCount??raw.resumes??0),pressure:cloneSafe(raw.queuePressure??null),
      };
      const physical=raw.physicalExecution&&typeof raw.physicalExecution==='object'?cloneSafe(raw.physicalExecution):{
        attempts:Number(raw.physicalExecutionAttempts??0),succeeded:Number(raw.physicalExecutionSucceeded??0),failed:Number(raw.physicalExecutionFailed??0),
      };
      const lifecycle=raw.lifecycle&&typeof raw.lifecycle==='object'?cloneSafe(raw.lifecycle):{
        configured:Number(raw.configuredResources??0),connected:Number(raw.connectedResources??0),physicallyExecuted:Number(raw.physicallyExecutedResources??0),ownerAccepted:Number(raw.ownerAcceptedResources??0),
      };
      return deepFreeze({
        source:createProductSourceStatus({mode:degraded?ProductDataMode.DEGRADED:ProductDataMode.LIVE,health:degraded?Wave6Health.DEGRADED:hot+deep?Wave6Health.WORKING:Wave6Health.READY,label:'Coprocessor',operationalState:degraded?OperatorProducerState.DEGRADED:hot+deep?OperatorProducerState.WORKING:OperatorProducerState.LIVE,impact:degraded?'Worker 2 reports degraded cognitive execution telemetry.':hot+deep?'Worker 2 cognitive work is active.':'Worker 2 cognition telemetry is current.',reason:reasonOf(raw),producer:raw.kind??'CognitionUiState',revision:raw.receiptRevision??raw.revision??null,connected:true,selection,freshness:raw.freshness??'TURN_CURRENT'}),
        data:{...cloneSafe(raw),activeTaskCount:active,hotActivity:hot,deepActivity:deep,
          fallback:Number(raw.fallbackCount??raw.fallback??0),retry:Number(raw.retryCount??raw.retry??0),validationFailures:Number(raw.validationFailures??0),
          staleDrop:Number(raw.staleDrops??raw.staleDrop??0),lateResults:Number(raw.lateResults??0),
          warm:cloneSafe(raw.warm??{hit:Number(raw.warmHits??0),miss:Number(raw.warmMisses??0)}),
          queue,physicalExecution:physical,lifecycle,
          ownerAcceptance:cloneSafe(raw.ownerAcceptance??[]),resultDestinations:cloneSafe(raw.resultDestinations??{}),
          providerHealth:cloneSafe(raw.providerHealth??[]),resources:cloneSafe(raw.resources??[]),
          rawPromptIncluded:false,rawPayloadIncluded:false,
        },
      });
    }catch(error){return degraded('Coprocessor','Worker 2 cognition telemetry failed coherence or read.','CognitionUiState',selection,error);}
  }
  subscribe(){return()=>{};}
}

export class Wave13RuntimeReceiptUIAdapter{
  constructor({readScatter=null,readStatus=null,selectionProvider=()=>({})}={}){
    this.readScatter=typeof readScatter==='function'?readScatter:null;
    this.readStatus=typeof readStatus==='function'?readStatus:null;
    this.selectionProvider=selectionProvider;
  }
  read(){
    const selection=this.selectionProvider?.()??{};
    if(!this.readScatter&&!this.readStatus)return unavailable('Runtime','Runtime scheduler telemetry and selected-turn scatter readers are not exported by the host assembly.','Runtime');
    try{
      const scheduler=runtimeLifecycleSnapshot(safeRead(this.readStatus,null));
      if(selection.chatId&&!selection.turnId){
        if(scheduler)return deepFreeze({
          source:createProductSourceStatus({mode:ProductDataMode.LIVE,health:scheduler.activeBatches||scheduler.queuedObligations?Wave6Health.WORKING:Wave6Health.READY,label:'Runtime',operationalState:scheduler.activeBatches||scheduler.queuedObligations?OperatorProducerState.WORKING:OperatorProducerState.LIVE,impact:'Runtime lifecycle telemetry is available; waiting for the selected chat to publish a turn-scoped execution receipt.',producer:'WorkerDirectorSnapshot',connected:true,selection}),
          data:{...scheduler,mode:'SCHEDULER_ONLY',resourceCount:0,admittedJobCount:0,resourceIds:[],jobs:[],receipt:null},
        });
        return waiting('Runtime','Runtime is connected; waiting for an active turn.','RuntimeTurnReceipt',selection);
      }
      const raw=this.readScatter?safeRead(()=>this.readScatter(selection),null):null;
      if(raw)assertSelection(raw,selection,'Runtime',{allowMissingIdentity:true});
      const jobs=raw?.jobs??raw?.admittedJobs??[],resourceCount=Number(raw?.resourceCount??raw?.executionResourceCount??(raw?.resourceIds??[]).length??0);
      const fallback=Number(raw?.requiredFallback??raw?.fallbackCount??0),pending=Number(raw?.opportunisticPending??raw?.pending??0);
      if(!raw&&!scheduler)return idle('Runtime','No Runtime execution receipt or scheduler lifecycle state exists for the selected turn.','Runtime',selection);
      const recovering=Number(scheduler?.blockedRecoveringWork??0),queued=Number(scheduler?.queuedObligations??0),active=Number(scheduler?.activeBatches??0);
      const degradedState=fallback+recovering>0,working=pending+queued+active>0;
      return deepFreeze({
        source:createProductSourceStatus({
          mode:degradedState?ProductDataMode.DEGRADED:ProductDataMode.LIVE,
          health:degradedState?Wave6Health.DEGRADED:working?Wave6Health.WORKING:Wave6Health.READY,
          label:'Runtime',operationalState:degradedState?OperatorProducerState.DEGRADED:working?OperatorProducerState.WORKING:OperatorProducerState.LIVE,
          impact:raw?(Array.isArray(jobs)?jobs.length:Number(raw?.admittedJobCount??0))+' logical jobs · '+resourceCount+' mapped resource identit'+(resourceCount===1?'y':'ies')+' for the selected turn. Scatter mapping alone does not prove physical execution.':'Runtime lifecycle telemetry is current; no turn-scoped scatter receipt is published.',
          reason:degradedState?'Runtime reports fallback, blocked, or recovering work.':'',producer:raw?.kind??'WorkerDirectorSnapshot',revision:raw?.receiptRevision??scheduler?.telemetry?.latestSequence??null,connected:true,selection,freshness:raw?.freshness??'CURRENT',
        }),
        data:{
          ...(scheduler??{}),mode:raw?'TURN_RECEIPT_AND_SCHEDULER':'SCHEDULER_ONLY',
          hotActivity:Number(scheduler?.hotActivity??(pending?1:0)),deepActivity:Number(scheduler?.deepActivity??0),
          queuedObligations:Number(scheduler?.queuedObligations??pending),blockedRecoveringWork:Number(scheduler?.blockedRecoveringWork??fallback),
          activeBatches:Number(scheduler?.activeBatches??(pending?1:0)),resourceCount,
          admittedJobCount:Number(raw?.admittedJobCount??(Array.isArray(jobs)?jobs.length:0)),resourceIds:[...(raw?.resourceIds??[])],jobs:cloneSafe(jobs),receipt:cloneSafe(raw),
        },
      });
    }catch(error){return degraded('Runtime','Runtime selected-turn receipt or scheduler lifecycle read failed.','Runtime',selection,error);}
  }
  subscribe(){return()=>{};}
}

function runtimeLifecycleSnapshot(raw){
  if(!raw||typeof raw!=='object')return null;
  const lifecycle=Array.isArray(raw.lifecycle)?raw.lifecycle:[];
  const counts={};
  for(const row of lifecycle){
    const state=String(row.executionStatus??'UNKNOWN').toUpperCase();counts[state]=(counts[state]??0)+1;
  }
  const queueDepth=raw.queueDepth&&typeof raw.queueDepth==='object'?cloneSafe(raw.queueDepth):{};
  const queuedObligations=Object.values(queueDepth).reduce((sum,value)=>sum+(Number(value)||0),0);
  const hotLayers=new Set(['HOT','L0','L1']),deepLayers=new Set(['DEEP','L2','L3','L4']);
  const activeRows=lifecycle.filter(row=>['ACTIVE','YIELDING'].includes(String(row.executionStatus??'').toUpperCase()));
  return deepFreeze({
    lifecycle:cloneSafe(lifecycle),lifecycleCounts:counts,queueDepth,
    queuedObligations,
    blockedRecoveringWork:lifecycle.filter(row=>['BLOCKED','RECOVERING'].includes(String(row.executionStatus??'').toUpperCase())).length,
    activeBatches:activeRows.length,
    hotActivity:activeRows.filter(row=>hotLayers.has(String(row.layer??'').toUpperCase())).length,
    deepActivity:activeRows.filter(row=>deepLayers.has(String(row.layer??'').toUpperCase())).length,
    resources:cloneSafe(raw.resources??null),workers:cloneSafe(raw.workers??null),dependencies:cloneSafe(raw.dependencies??null),
    telemetry:cloneSafe(raw.telemetry??null),eventTypes:Array.isArray(raw.eventTypes)?[...raw.eventTypes]:[],
    batchProgressAvailable:false,lateResultHistoryAvailable:false,
  });
}

export class Wave13MemoryUIAdapter{
  constructor({bindings={},selectionProvider=()=>({})}={}){
    this.bindings=bindings;this.selectionProvider=selectionProvider;
    this.surface=bindings.memoryIntegrationSurface??bindings.memoryInterface??bindings.memoryOwner??null;
    this.readFn=fn(this.surface,['readMemory'])??fn(this.surface?.adapters,['readMemory'])??fn(bindings,['readMemory','readMemoryReadModel','readMemoryStatus']);
    this.summaryStatusFn=fn(this.surface,['summaryStatus'])??fn(this.surface?.adapters,['summaryStatus'])??fn(bindings,['readMemorySummaryStatus']);
    this.readRetrievalFn=fn(this.surface,['readRetrieval'])??fn(this.surface?.adapters,['readRetrieval'])??fn(bindings,['readMemoryRetrieval']);
    this.subscribeFn=fn(this.surface,['subscribe'])??fn(this.surface?.adapters,['subscribe'])??fn(bindings,['subscribeMemory','subscribeMemoryStatus']);
  }
  capabilities(){return deepFreeze({read:Boolean(this.readFn),summaryStatus:Boolean(this.summaryStatusFn),retrieval:Boolean(this.readRetrievalFn),subscribe:Boolean(this.subscribeFn),mutation:false});}
  read(){
    const selection=this.selectionProvider?.()??{};
    if(!this.readFn)return unavailable('Memory','Memory owner read model is not exported by the host assembly.','MemoryUiReadModel');
    if(!selection.chatId)return waiting('Memory','Select a SillyTavern chat to inspect its owner-backed Memory state.','MemoryUiReadModel',selection);
    try{
      const raw=this.readFn(selection);
      if(raw==null)return idle('Memory','No memories recorded for this chat yet.','MemoryUiReadModel',selection);
      if(raw.kind==='NativeBrainMemoryStatus'&&raw.sync==null&&raw.fallbackStore==null)return idle('Memory','No memories recorded for this chat yet.','MemoryUiReadModel',selection);
      assertSelection(raw,selection,'Memory',{allowMissingIdentity:true});
      const data=normalizeMemorySurface(raw);
      const health=String(raw.health?.state??raw.health??(data.freshness.staleEvidence+data.freshness.staleSummaries>0?'DEGRADED':'READY')).toUpperCase();
      const degradedState=['DEGRADED','STALE','BLOCKED','ERROR','UNAVAILABLE'].includes(health);
      return deepFreeze({
        source:createProductSourceStatus({
          mode:degradedState?ProductDataMode.DEGRADED:ProductDataMode.LIVE,
          health:degradedState?Wave6Health.DEGRADED:data.counts.total?Wave6Health.READY:Wave6Health.IDLE,
          label:'Memory',operationalState:degradedState?OperatorProducerState.DEGRADED:data.counts.total?OperatorProducerState.LIVE:OperatorProducerState.IDLE,
          impact:data.counts.total?data.counts.total+' owner-backed Memory record'+(data.counts.total===1?' is':'s are')+' visible for the selected chat.':'No memories recorded for this chat yet.',
          reason:(raw.health?.reasons??[]).join(', '),producer:raw.kind??'MemoryUiReadModel',revision:raw.revision??null,connected:true,selection,freshness:degradedState?'STALE_OR_DEGRADED':'CURRENT',
        }),
        data,
      });
    }catch(error){return degraded('Memory','Memory owner read failed for the selected chat.','MemoryUiReadModel',selection,error);}
  }
  summaryStatus(){
    if(!this.summaryStatusFn)return null;
    try{return cloneSafe(this.summaryStatusFn());}catch{return null;}
  }
  subscribe(listener){
    if(typeof listener!=='function'||!this.subscribeFn)return()=>{};
    const release=this.subscribeFn(listener);return typeof release==='function'?release:()=>{};
  }
}

function normalizeMemorySurface(raw){
  const state=raw.state??{},evidence=Array.isArray(raw.evidence)?raw.evidence:[],episodes=Array.isArray(raw.episodes)?raw.episodes:[],reflections=Array.isArray(raw.reflections)?raw.reflections:[],summaries=Array.isArray(raw.summaries)?raw.summaries:[];
  const current=Array.isArray(state.current)?state.current:[],historical=Array.isArray(state.historical)?state.historical:[],unresolved=Array.isArray(state.unresolved)?state.unresolved:[];
  const freshness=raw.freshness??{};
  return{
    kind:'Wave13MemorySurface',chatId:raw.chatId??null,turnId:raw.turnId??null,generationId:raw.generationId??null,
    worldRevision:raw.worldRevision??null,sceneRevision:raw.sceneRevision??null,revision:raw.revision??null,
    sourceRevisionRefs:[...(raw.sourceRevisionRefs??[])],revisionRefs:cloneSafe(raw.revisionRefs??null),
    evidence:cloneSafe(evidence),state:{current:cloneSafe(current),historical:cloneSafe(historical),unresolved:cloneSafe(unresolved)},
    episodes:cloneSafe(episodes),reflections:cloneSafe(reflections),summaries:cloneSafe(summaries),retrieval:cloneSafe(raw.retrieval??null),provenance:cloneSafe(raw.provenance??null),
    freshness:{
      freshEvidence:Number(freshness.freshEvidence??evidence.filter(x=>x.freshness==='FRESH').length),staleEvidence:Number(freshness.staleEvidence??evidence.filter(x=>x.freshness&&x.freshness!=='FRESH').length),
      freshEpisodes:Number(freshness.freshEpisodes??episodes.filter(x=>x.freshness==='FRESH').length),staleEpisodes:Number(freshness.staleEpisodes??episodes.filter(x=>x.freshness&&x.freshness!=='FRESH').length),
      freshReflections:Number(freshness.freshReflections??reflections.filter(x=>x.freshness==='FRESH').length),staleReflections:Number(freshness.staleReflections??reflections.filter(x=>x.freshness&&x.freshness!=='FRESH').length),
      freshSummaries:Number(freshness.freshSummaries??summaries.filter(x=>x.freshness==='FRESH').length),staleSummaries:Number(freshness.staleSummaries??summaries.filter(x=>x.freshness&&x.freshness!=='FRESH').length),
    },
    counts:{exactEvidence:evidence.length,current:current.length,historical:historical.length,unresolved:unresolved.length,episodes:episodes.length,reflections:reflections.length,summaries:summaries.length,total:evidence.length+current.length+historical.length+unresolved.length+episodes.length+reflections.length+summaries.length},
    readOnly:raw.readOnly!==false,mutationAuthority:Boolean(raw.mutationAuthority),settlementAuthority:Boolean(raw.settlementAuthority),contextSealAuthority:Boolean(raw.contextSealAuthority),
  };
}

export class Wave13LoreStudyUIAdapter{
  constructor({bindings={},selectionProvider}={}){
    // hostSelection: the host told us which chat is open. Without one (a bare service binding) accept keeps the payload's
    // own chat, as before; with one, accept binds to the open chat.
    this.hostSelection=typeof selectionProvider==='function';
    this.bindings=bindings;this.selectionProvider=this.hostSelection?selectionProvider:()=>({});
    this.service=bindings.loreIntelligenceService??bindings.loreStudyService??null;
    this.host=bindings.loreOperatorHost??bindings.loreStudyHost??bindings.loreHost??operatorHostFromService(this.service);
    this.runtime=bindings.loreStudyRuntime??bindings.loreRuntime??null;
    this.readFn=fn(this.host?.read,['surface','status','loreStudy'])??fn(bindings,['readLoreStudySurface','readLoreStatus','readLoreStudyStatus']);
    this.metadataReadFn=fn(this.host?.read,['metadataSurface']);
    this.selectionFn=fn(bindings,['readSelectedLorebookSelection']);
    this.discoverFn=fn(bindings,['discoverSelectedLorebook']);
    this.loadWorldTreeSourceFn=fn(bindings,['loadWorldTreeSource']);
    this.worldBuilderBindings=bindings;
    this.worldBuilderState={open:false,busy:false,result:null,error:null,mode:'EXTEND',book:null};
    for(const method of ['startWorldTreeBuild','readWorldTreeBuild','reviseWorldTreeBuild','approveWorldTreeBuild','applyWorldTreeBuild','cancelWorldTreeBuild','resumeWorldTreeBuild','retryWorldTreeBuildLayout','readWorldTreeLayout','saveWorldTreeLayoutPins','readWorldTreeBuildSourceIds','listWorldTreeBuilds','reviewWorldTreeBuildLayout']){
      this[method]=(...args)=>{
        const action=fn(bindings,[method]);if(!action)throw new Error('World Tree Builder owner unavailable');
        return action(...args);
      };
    }
    this.summarizeWorldTreeSourceFn=fn(bindings,['summarizeWorldTreeSource']);
    this.scanWorldTreeMergeFn=fn(bindings,['scanWorldTreeMerge']);
    this.summarizeLoreUidFn=fn(bindings,['summarizeLoreUid']);
    this.stageLoreUidSummaryFn=fn(bindings,['stageLoreUidSummary']);
    this.rejectLoreUidSummaryFn=fn(bindings,['rejectLoreUidSummary']);
    this.runtimeStripFn=fn(bindings,['readActivityFeed']);
    this.acceptFn=fn(this.host?.actions,['acceptLorebook','submitLorebook','ingestLorebook'])??fn(bindings,['acceptLorebook','submitLorebook','enqueueLorebook','ingestLorebook']);
    this.runFn=fn(this.host?.actions,['runLoreStudy','startLoreStudy','runDueLoreStudy'])??fn(bindings,['runLoreStudy','startLoreStudy','runDueLoreStudy']);
    this.retryFn=fn(this.host?.actions,['retryLoreStudy'])??fn(bindings,['retryLoreStudy']);
    this.summaryFn=fn(bindings,['readLoreSummaries','readLoreSummarySurface'])??(typeof this.service?.summarySurface==='function'?this.service.summarySurface.bind(this.service):null);
    if(!this.summaryFn&&typeof this.service?.brainInterface==='function'){try{this.summaryFn=fn(this.service.brainInterface()?.read,['summaries']);}catch{}}
    this.subscribeFn=fn(bindings,['subscribeLoreStudy','subscribeLoreStatus'])??(typeof this.host?.subscribe==='function'?this.host.subscribe.bind(this.host):null);
    if(this.runtime){
      this.readFn??=()=>buildLoreSurfaceFromRuntime(this.runtime);
      this.acceptFn??=(input)=>this.runtime.ingestLorebook(input);
      this.runFn??=(input)=>runLoreRuntime(this.runtime,input);
    }
    this.lastAction=null;this.lastError=null;this.discoveredLorebook=null;
  }
  capabilities(){return deepFreeze({worldTreeBuilder:Boolean(this.worldBuilderBindings?.startWorldTreeBuild),read:Boolean(this.readFn),discover:Boolean(this.discoverFn),loadWorldTreeSource:Boolean(this.loadWorldTreeSourceFn),summarizeWorldTreeSource:Boolean(this.summarizeWorldTreeSourceFn),scanWorldTreeMerge:Boolean(this.scanWorldTreeMergeFn),summarizeLoreUid:Boolean(this.summarizeLoreUidFn),stageLoreUidSummary:Boolean(this.stageLoreUidSummaryFn),rejectLoreUidSummary:Boolean(this.rejectLoreUidSummaryFn),accept:Boolean(this.acceptFn),run:Boolean(this.runFn),retry:Boolean(this.retryFn),summaries:Boolean(this.summaryFn),subscribe:Boolean(this.subscribeFn)});}
  selectedLorebook(){
    const selected=safeRead(this.selectionFn,null);
    return deepFreeze({selection:cloneSafe(selected),snapshot:cloneSafe(this.discoveredLorebook)});
  }
  async discoverSelectedLorebook(){
    this.lastError=null;
    if(!this.discoverFn){const e=new Error('SillyTavern selected-Lorebook discovery is not exported by the host.');e.code='LORE_DISCOVERY_UNAVAILABLE';this.lastError=e;throw e;}
    try{
      const result=await this.discoverFn();
      this.discoveredLorebook=cloneSafe(result);this.lastAction={type:'DISCOVER',result:cloneSafe(result?.discovery??null)};
      return cloneSafe(result);
    }catch(error){this.lastError=error;throw error;}
  }
  async loadWorldTreeSource(input=null){
    this.lastError=null;
    if(!this.loadWorldTreeSourceFn){const e=new Error('World Tree source loader is not exported by the host.');e.code='WORLD_TREE_SOURCE_LOAD_UNAVAILABLE';this.lastError=e;throw e;}
    const payload=cloneSafe(input??this.discoveredLorebook);
    if(!payload){const e=new Error('Load the selected Lorebook before publishing it to the World Tree.');e.code='WORLD_TREE_SOURCE_REQUIRED';this.lastError=e;throw e;}
    try{const result=await this.loadWorldTreeSourceFn(payload);this.lastAction={type:'LOAD_WORLD_TREE_SOURCE',result:cloneSafe(result)};return cloneSafe(result);}
    catch(error){this.lastError=error;throw error;}
  }
  async summarizeWorldTreeSource(book=null){
    this.lastError=null;
    if(!this.summarizeWorldTreeSourceFn){const e=new Error('World Tree summarizer is not exported by the host.');e.code='WORLD_TREE_SUMMARIZER_UNAVAILABLE';this.lastError=e;throw e;}
    const id=text(book??this.discoveredLorebook?.id??this.selectedLorebook()?.selection?.lorebookId);
    if(!id){const e=new Error('Select and load a Lorebook before running the Summarizer.');e.code='WORLD_TREE_SOURCE_REQUIRED';this.lastError=e;throw e;}
    try{const result=await this.summarizeWorldTreeSourceFn({book:id});this.lastAction={type:'SUMMARIZE_WORLD_TREE_SOURCE',result:cloneSafe(result)};return cloneSafe(result);}
    catch(error){this.lastError=error;throw error;}
  }
  async scanWorldTreeMerge(book=null){
    this.lastError=null;
    if(!this.scanWorldTreeMergeFn){const e=new Error('World Tree Merge scan is not exported by the host.');e.code='WORLD_TREE_MERGE_UNAVAILABLE';this.lastError=e;throw e;}
    const id=text(book??this.discoveredLorebook?.id??this.selectedLorebook()?.selection?.lorebookId);
    if(!id){const e=new Error('Select and load a Lorebook before running Merge.');e.code='WORLD_TREE_SOURCE_REQUIRED';this.lastError=e;throw e;}
    try{const result=await this.scanWorldTreeMergeFn({book:id});this.lastAction={type:'SCAN_WORLD_TREE_MERGE',result:cloneSafe(result)};return cloneSafe(result);}
    catch(error){this.lastError=error;throw error;}
  }
  async summarizeLoreUid(input={}){
    this.lastError=null;
    if(!this.summarizeLoreUidFn){const e=new Error('UID Summarizer is not exported by the host.');e.code='UID_SUMMARIZER_UNAVAILABLE';this.lastError=e;throw e;}
    try{const result=await this.summarizeLoreUidFn(cloneSafe(input));this.lastAction={type:'SUMMARIZE_UID',result:cloneSafe(result)};return cloneSafe(result);}
    catch(error){this.lastError=error;throw error;}
  }
  async stageLoreUidSummary(input={}){
    this.lastError=null;
    if(!this.stageLoreUidSummaryFn){const e=new Error('UID summary review staging is not exported by the host.');e.code='UID_SUMMARY_REVIEW_UNAVAILABLE';this.lastError=e;throw e;}
    try{const result=await this.stageLoreUidSummaryFn(cloneSafe(input));this.lastAction={type:'STAGE_UID_SUMMARY',result:cloneSafe(result)};return cloneSafe(result);}
    catch(error){this.lastError=error;throw error;}
  }
  async rejectLoreUidSummary(input={}){
    this.lastError=null;
    if(!this.rejectLoreUidSummaryFn){const e=new Error('UID summary rejection is not exported by the host.');e.code='UID_SUMMARY_REJECT_UNAVAILABLE';this.lastError=e;throw e;}
    try{const result=await this.rejectLoreUidSummaryFn(cloneSafe(input));this.lastAction={type:'REJECT_UID_SUMMARY',result:cloneSafe(result)};return cloneSafe(result);}
    catch(error){this.lastError=error;throw error;}
  }
  runtimeStrip(){
    if(!this.runtimeStripFn)return null;
    try{return cloneSafe(this.runtimeStripFn()?.status??null);}catch{return null;}
  }
  readStatus(){return this.read({metadataOnly:true});}
  read({metadataOnly=false}={}){
    const selection=this.selectionProvider?.()??{};
    if(!this.readFn)return unavailable('Lore Study','Lore Study read contract is not exported by the host assembly.','LoreStudyRuntime');
    try{
      const raw=(metadataOnly&&this.metadataReadFn?this.metadataReadFn:this.readFn)(selection);
      if(raw==null)return idle('Lore Study','Lore Study is connected; no Lore has been accepted yet.','LoreStudyRuntime',selection);
      if(selection.turnId)assertSelection(raw,selection,'Lore Study',{allowMissingIdentity:true});
      const data=normalizeLoreSurface(raw);
      const failed=Number(data.operatorCounts?.FAILED??data.lifecycle?.counts?.INVALID??0),studying=Number(data.operatorCounts?.STUDYING??0),accepted=Number(data.operatorCounts?.ACCEPTED??0);
      const active=Number(data.lifecycle?.active??data.lifecycle?.counts?.ACTIVE??0),due=Number(data.lifecycle?.due??0),canonicalOnly=raw.capabilities?.canonicalLoreRead===true&&raw.capabilities?.studyEngine===false,working=studying+(canonicalOnly?0:accepted)+active+due>0;
      const stale=data.entries.some(x=>x.freshness==='STALE_OR_UNLEARNED');
      const health=failed?Wave6Health.DEGRADED:working?Wave6Health.WORKING:Wave6Health.READY;
      const op=failed?OperatorProducerState.DEGRADED:working?OperatorProducerState.WORKING:data.entries.length?OperatorProducerState.LIVE:OperatorProducerState.IDLE;
      const ready=Number(data.operatorCounts?.READY??0);
      // Lore is read per chat: accepted Lore the selected chat is not authorized to read is reported, never as "ready".
      const access=data.storyAccess;
      const unauthorizedHere=Boolean(selection.chatId&&access&&access.chatId===String(selection.chatId)&&data.entries.length&&!(access.authorized??[]).length);
      if(unauthorizedHere){
        return deepFreeze({
          source:createProductSourceStatus({
            mode:ProductDataMode.DEGRADED,health:Wave6Health.DEGRADED,label:'Lore Study',operationalState:OperatorProducerState.DEGRADED,
            impact:'Accepted Lore is not authorized for this chat, so none of it reaches this chat\'s prompts. Use "Use for this chat" to authorize it.',
            reason:access.explanation??'LORE_NOT_AUTHORIZED_FOR_CHAT',producer:raw.kind??'LoreStudyRuntime',revision:data.revision,connected:true,selection,freshness:stale?'STALE_OR_UNLEARNED':'CURRENT',errorCode:'LORE_NOT_AUTHORIZED_FOR_CHAT',
          }),
          data,
        });
      }
      return deepFreeze({
        source:createProductSourceStatus({
          mode:failed?ProductDataMode.DEGRADED:ProductDataMode.LIVE,health,label:'Lore Study',operationalState:op,
          impact:failed?'Lore owner reports one or more failed study entries.':working?'Lore is accepted; study or readiness work is still in progress.':canonicalOnly?'Canonical Lore is available. This owner read does not report a study job or retrieval readiness.':data.entries.length?ready===data.entries.length?'Accepted Lore is ready for retrieval.':'Accepted Lore is not fully retrieval-ready yet.':'No Lore has been accepted.',
          reason:stale?'One or more accepted source revisions are stale or not learned.':'',producer:raw.kind??'LoreStudyRuntime',revision:data.revision,connected:true,selection,freshness:stale?'STALE_OR_UNLEARNED':'CURRENT',
        }),
        data,
      });
    }catch(error){return degraded('Lore Study','Lore Study read failed.','LoreStudyRuntime',selection,error);}
  }
  summaries(){
    if(!this.summaryFn)return null;
    try{return cloneSafe(this.summaryFn());}catch{return null;}
  }
  async accept(input){
    this.lastError=null;
    if(!this.acceptFn){const e=new Error('Lore acceptance action is not exported by the host assembly.');e.code='LORE_ACCEPT_ACTION_UNAVAILABLE';this.lastError=e;throw e;}
    // Accept authorizes the chat that is open when the operator clicks it (Lore is read per chat), not whichever chat was
    // open when the Lorebook was loaded. With a host selection but no chat open it refuses: Lore accepted for no chat would
    // be readable by none.
    const payload=cloneSafe(input)??{};
    const hasSelection=this.hostSelection;
    const chatId=hasSelection?text(this.selectionProvider()?.chatId):null;
    if(hasSelection&&!chatId){const e=new Error('Open the chat this Lore is for, then accept it: Lore is authorized per chat.');e.code='LORE_CHAT_REQUIRED';this.lastError=e;throw e;}
    if(chatId){payload.chatId=chatId;payload.discovery={...(payload.discovery??{}),chatId};}
    try{const result=await this.acceptFn(payload);this.lastAction={type:'ACCEPT',result:cloneSafe(result)};return cloneSafe(result);}
    catch(error){this.lastError=error;throw error;}
  }
  canAuthorizeForChat(){return Boolean(fn(this.host?.actions,['authorizeLorebookForChat']));}
  async authorizeForChat(lorebookId){
    this.lastError=null;
    const action=fn(this.host?.actions,['authorizeLorebookForChat']);
    if(!action){const e=new Error('Per-chat Lore authorization is not exported by the host assembly.');e.code='LORE_AUTHORIZE_UNAVAILABLE';this.lastError=e;throw e;}
    const chatId=text(this.selectionProvider?.()?.chatId);
    if(!chatId){const e=new Error('Select the chat to authorize Lore for.');e.code='LORE_CHAT_REQUIRED';this.lastError=e;throw e;}
    try{const result=await action({chatId,lorebookId:String(lorebookId)});this.lastAction={type:'AUTHORIZE_FOR_CHAT',result:cloneSafe(result)};return cloneSafe(result);}
    catch(error){this.lastError=error;throw error;}
  }
  async run(input={}){
    this.lastError=null;
    if(!this.runFn){const e=new Error('Lore study execution action is not exported by the host assembly.');e.code='LORE_RUN_ACTION_UNAVAILABLE';this.lastError=e;throw e;}
    try{const result=await this.runFn(cloneSafe(input));this.lastAction={type:'RUN',result:cloneSafe(result)};return cloneSafe(result);}
    catch(error){this.lastError=error;throw error;}
  }
  subscribe(listener){
    if(typeof listener!=='function'||!this.subscribeFn)return()=>{};
    const release=this.subscribeFn(listener);return typeof release==='function'?release:()=>{};
  }
}

export class Wave13LoreAuthoringUIAdapter{
  constructor({bindings={}}={}){
    this.bindings=bindings;
    this.service=bindings.loreAuthoringService??null;
    this.host=bindings.loreAuthoringHost??bindings.loreAuthoringOperator??authoringHostFromService(this.service);
    this.discoveryFn=fn(this.host?.read,['sourceDiscoveryIdentity']);
    this.reviewStatesFn=fn(this.host?.read,['reviewStates']);
    this.invalidationFn=fn(this.host?.read,['worker1InvalidationContract']);
    this.previewEditFn=fn(this.host?.actions,['previewEditImpact']);
    this.treeFn=fn(this.host?.actions,['proposeTree']);
    this.mergeFn=fn(this.host?.actions,['previewMerge']);
    this.progressFn=fn(this.host?.read,['progress']);
    this.draftReviewFn=fn(this.host?.read,['draftReview']);
    this.finalPreviewFn=fn(this.host?.read,['finalPreview']);
    this.settlementFn=fn(this.host?.read,['settlement']);
    this.worker1ReceiptsFn=fn(this.host?.read,['worker1Receipts']);
    this.worker3ContractFn=fn(this.host?.read,['worker3AuthoringContract']);
    this.adaptiveNavigationFn=fn(this.host?.read,['adaptiveNavigation','readAdaptiveNavigation']);
    this.rebuildAffectedNavigationFn=fn(this.host?.actions,['rebuildAffectedNavigation']);

    // Worker 4 PR #261 / LoreAuthoringOperatorContract@2 mutationExtensionVersion:1.
    this.mutationProposalFn=fn(this.host?.read,['mutationProposal']);
    this.mutationQueueFn=fn(this.host?.read,['mutationQueue']);
    this.semanticImpactPreviewFn=fn(this.host?.read,['semanticImpactPreview']);
    this.mutationAuditFn=fn(this.host?.read,['mutationAudit']);
    this.createMutationProposalFn=fn(this.host?.actions,['createMutationProposal']);
    this.approveMutationProposalFn=fn(this.host?.actions,['approveMutationProposal']);
    this.rejectMutationProposalFn=fn(this.host?.actions,['rejectMutationProposal']);
    this.commitMutationProposalFn=fn(this.host?.actions,['commitMutationProposal']);
    this.restoreMutationProposalFn=fn(this.host?.actions,['restoreMutationProposal']);

    this.startTreeBuildFn=fn(this.host?.actions,['startTreeBuild']);
    this.startMergeBuildFn=fn(this.host?.actions,['startMergeBuild']);
    this.resumeBuildFn=fn(this.host?.actions,['resumeAuthoringBuild']);
    this.recordDecisionFn=fn(this.host?.actions,['recordDraftDecision']);
    this.reclassifyFn=fn(this.host?.actions,['reclassifyAfterTaxonomyEdit']);
    this.computeFinalPreviewFn=fn(this.host?.actions,['computeFinalPreview']);
    this.approveFinalPreviewFn=fn(this.host?.actions,['approveFinalPreview']);
    this.applySettlementFn=fn(this.host?.actions,['applySettlement']);
    this.restoreSettlementFn=fn(this.host?.actions,['restoreSettlement']);
    this.last={
      discovery:null,reviewStates:null,invalidation:null,edit:null,tree:null,merge:null,navigation:null,navigationRebuild:null,
      progress:null,draft:null,finalPreview:null,settlement:null,worker1Receipts:null,
      mutationProposal:null,mutationQueue:null,semanticImpact:null,mutationAudit:null,mutationAction:null,
    };
  }
  capabilities(){
    const v2=Number(this.host?.contractVersion??0)>=2;
    const mutationExtensionVersion=Number(this.host?.mutationExtensionVersion??0);
    const lifecycle=v2&&Boolean(this.progressFn&&this.draftReviewFn&&this.finalPreviewFn&&this.startTreeBuildFn&&this.resumeBuildFn&&this.recordDecisionFn&&this.computeFinalPreviewFn&&this.approveFinalPreviewFn);
    const mutationCreate=mutationExtensionVersion>=1&&Boolean(this.createMutationProposalFn);
    const mutationApprove=mutationExtensionVersion>=1&&Boolean(this.approveMutationProposalFn);
    const mutationReject=mutationExtensionVersion>=1&&Boolean(this.rejectMutationProposalFn);
    const mutationCommit=mutationExtensionVersion>=1&&Boolean(this.commitMutationProposalFn);
    const mutationRestore=mutationExtensionVersion>=1&&Boolean(this.restoreMutationProposalFn);
    const mutationProposal=mutationExtensionVersion>=1&&Boolean(this.mutationProposalFn);
    const mutationQueue=mutationExtensionVersion>=1&&Boolean(this.mutationQueueFn);
    const mutationAudit=mutationExtensionVersion>=1&&Boolean(this.mutationAuditFn);
    const semanticImpactPreview=mutationExtensionVersion>=1&&Boolean(this.semanticImpactPreviewFn);
    const reviewedMutation=mutationExtensionVersion>=1&&mutationCreate&&mutationApprove&&mutationReject&&mutationCommit&&mutationRestore&&mutationProposal&&mutationQueue&&mutationAudit;
    return deepFreeze({
      discovery:Boolean(this.discoveryFn),reviewStates:Boolean(this.reviewStatesFn),invalidation:Boolean(this.invalidationFn),
      previewEdit:Boolean(this.previewEditFn),tree:Boolean(this.treeFn),merge:Boolean(this.mergeFn),
      lifecycle,mergeLifecycle:lifecycle&&Boolean(this.startMergeBuildFn),reclassify:lifecycle&&Boolean(this.reclassifyFn),settlement:lifecycle&&Boolean(this.settlementFn&&this.applySettlementFn),
      restoration:lifecycle&&Boolean(this.restoreSettlementFn),worker1Receipts:Boolean(this.worker1ReceiptsFn),
      adaptiveNavigation:Boolean(this.adaptiveNavigationFn),incrementalNavigationRebuild:Boolean(this.rebuildAffectedNavigationFn),
      mutationExtensionVersion,reviewedMutation,mutationCreate,mutationApprove,mutationReject,mutationCommit,mutationRestore,mutationProposal,mutationQueue,mutationAudit,semanticImpactPreview,
      destructiveApply:lifecycle&&Boolean(this.settlementFn&&this.applySettlementFn),
    });
  }
  sourceDiscoveryIdentity(request={}){
    const result=this.#invoke(this.discoveryFn,request,'LORE_AUTHORING_DISCOVERY_UNAVAILABLE');
    this.last.discovery=cloneSafe(result);return cloneSafe(result);
  }
  reviewStates(){
    const result=this.#invoke(this.reviewStatesFn,{},'LORE_AUTHORING_REVIEW_STATES_UNAVAILABLE');
    this.last.reviewStates=cloneSafe(result);return cloneSafe(result);
  }
  worker1InvalidationContract(){
    const result=this.#invoke(this.invalidationFn,{},'LORE_AUTHORING_INVALIDATION_CONTRACT_UNAVAILABLE');
    this.last.invalidation=cloneSafe(result);return cloneSafe(result);
  }
  previewEditImpact(request){
    const result=this.#invoke(this.previewEditFn,request,'LORE_AUTHORING_EDIT_PREVIEW_UNAVAILABLE');
    this.last.edit=cloneSafe(result);return cloneSafe(result);
  }
  proposeTree(request={}){
    const result=this.#invoke(this.treeFn,request,'LORE_AUTHORING_TREE_PREVIEW_UNAVAILABLE');
    this.last.tree=cloneSafe(result);return cloneSafe(result);
  }
  previewMerge(request){
    const result=this.#invoke(this.mergeFn,request,'LORE_AUTHORING_MERGE_PREVIEW_UNAVAILABLE');
    this.last.merge=cloneSafe(result);return cloneSafe(result);
  }
  authoringProgress(request){const result=this.#invoke(this.progressFn,request,'LORE_AUTHORING_PROGRESS_UNAVAILABLE');this.last.progress=cloneSafe(result);return cloneSafe(result);}
  draftReview(request){const result=this.#invoke(this.draftReviewFn,request,'LORE_AUTHORING_DRAFT_REVIEW_UNAVAILABLE');this.last.draft=cloneSafe(result);return cloneSafe(result);}
  finalPreview(request){const result=this.#invoke(this.finalPreviewFn,request,'LORE_AUTHORING_FINAL_PREVIEW_UNAVAILABLE');this.last.finalPreview=cloneSafe(result);return cloneSafe(result);}
  settlement(request){const result=this.#invoke(this.settlementFn,request,'LORE_AUTHORING_SETTLEMENT_READ_UNAVAILABLE');this.last.settlement=cloneSafe(result);return cloneSafe(result);}
  worker1Receipts(request){const result=this.#invoke(this.worker1ReceiptsFn,request,'LORE_AUTHORING_WORKER1_RECEIPTS_UNAVAILABLE');this.last.worker1Receipts=cloneSafe(result);return cloneSafe(result);}
  worker3Contract(){return this.#invoke(this.worker3ContractFn,{},'LORE_AUTHORING_WORKER3_CONTRACT_UNAVAILABLE');}
  adaptiveNavigation(request={}){const result=this.#invoke(this.adaptiveNavigationFn,request,'LORE_AUTHORING_ADAPTIVE_NAVIGATION_UNAVAILABLE');this.last.navigation=cloneSafe(result);return cloneSafe(result);}
  rebuildAffectedNavigation(request){const result=this.#invoke(this.rebuildAffectedNavigationFn,request,'LORE_AUTHORING_NAVIGATION_REBUILD_UNAVAILABLE');this.last.navigationRebuild=cloneSafe(result);return cloneSafe(result);}

  mutationProposal(request){const result=this.#invoke(this.mutationProposalFn,request,'LORE_MUTATION_PROPOSAL_READ_UNAVAILABLE');this.last.mutationProposal=cloneSafe(result);return cloneSafe(result);}
  mutationQueue(request={}){const result=this.#invoke(this.mutationQueueFn,request,'LORE_MUTATION_QUEUE_READ_UNAVAILABLE');this.last.mutationQueue=cloneSafe(result);return cloneSafe(result);}
  semanticImpactPreview(request={}){const result=this.#invoke(this.semanticImpactPreviewFn,request,'LORE_MUTATION_SEMANTIC_IMPACT_UNAVAILABLE');this.last.semanticImpact=cloneSafe(result);return cloneSafe(result);}
  mutationAudit(request){const result=this.#invoke(this.mutationAuditFn,request,'LORE_MUTATION_AUDIT_READ_UNAVAILABLE');this.last.mutationAudit=cloneSafe(result);return cloneSafe(result);}
  createMutationProposal(request){return this.#mutationAction('CREATE_MUTATION_PROPOSAL',this.createMutationProposalFn,request,'LORE_MUTATION_CREATE_UNAVAILABLE');}
  approveMutationProposal(request){return this.#mutationAction('APPROVE_MUTATION_PROPOSAL',this.approveMutationProposalFn,request,'LORE_MUTATION_APPROVE_UNAVAILABLE');}
  rejectMutationProposal(request){return this.#mutationAction('REJECT_MUTATION_PROPOSAL',this.rejectMutationProposalFn,request,'LORE_MUTATION_REJECT_UNAVAILABLE');}
  commitMutationProposal(request){return this.#mutationAction('COMMIT_MUTATION_PROPOSAL',this.commitMutationProposalFn,request,'LORE_MUTATION_COMMIT_UNAVAILABLE');}
  restoreMutationProposal(request){return this.#mutationAction('RESTORE_MUTATION_PROPOSAL',this.restoreMutationProposalFn,request,'LORE_MUTATION_RESTORE_UNAVAILABLE');}

  startTreeBuild(request){return this.#lifecycleAction('START_TREE_BUILD',this.startTreeBuildFn,request,'LORE_AUTHORING_START_TREE_UNAVAILABLE');}
  startMergeBuild(request){return this.#lifecycleAction('START_MERGE_BUILD',this.startMergeBuildFn,request,'LORE_AUTHORING_START_MERGE_UNAVAILABLE');}
  resumeBuild(request){return this.#lifecycleAction('RESUME_BUILD',this.resumeBuildFn,request,'LORE_AUTHORING_RESUME_UNAVAILABLE');}
  recordDecision(request){return this.#lifecycleAction('RECORD_DECISION',this.recordDecisionFn,request,'LORE_AUTHORING_DECISION_UNAVAILABLE');}
  reclassify(request){return this.#lifecycleAction('RECLASSIFY',this.reclassifyFn,request,'LORE_AUTHORING_RECLASSIFY_UNAVAILABLE');}
  computeFinalPreview(request){return this.#lifecycleAction('COMPUTE_FINAL_PREVIEW',this.computeFinalPreviewFn,request,'LORE_AUTHORING_FINAL_PREVIEW_UNAVAILABLE');}
  approveFinalPreview(request){return this.#lifecycleAction('APPROVE_FINAL_PREVIEW',this.approveFinalPreviewFn,request,'LORE_AUTHORING_APPROVAL_UNAVAILABLE');}
  applySettlement(request){return this.#lifecycleAction('APPLY_SETTLEMENT',this.applySettlementFn,request,'LORE_AUTHORING_SETTLEMENT_UNAVAILABLE');}
  restoreSettlement(request){return this.#lifecycleAction('RESTORE_SETTLEMENT',this.restoreSettlementFn,request,'LORE_AUTHORING_RESTORE_UNAVAILABLE');}
  #mutationAction(type,action,payload,code){
    const result=this.#invoke(action,payload,code);
    const remember=(value)=>{this.last.mutationAction={type,result:cloneSafe(value)};if(value?.ok&&value?.value?.proposalId)this.last.mutationProposal=cloneSafe(value);this.last.mutationQueue=null;this.last.mutationAudit=null;return value;};
    return result&&typeof result.then==='function'?result.then(remember):remember(result);
  }
  #lifecycleAction(type,action,payload,code){const result=this.#invoke(action,payload,code);if(result&&typeof result.then==='function')return result.then(value=>{this.last.progress=null;this.last.draft=null;this.last.finalPreview=null;this.last.settlement=null;return value;});this.last.progress=null;this.last.draft=null;this.last.finalPreview=null;this.last.settlement=null;return result;}
  snapshot(){return deepFreeze({kind:'Wave13LoreAuthoringSnapshot',capabilities:this.capabilities(),last:cloneSafe(this.last)});}
  #invoke(action,payload,code){
    if(!action)return deepFreeze({ok:false,value:null,error:{kind:'LoreAuthoringError',code,message:'Worker 4 Lore authoring operator contract is not exported by this assembly.',safe:true,retryable:false}});
    try{
      const raw=action(cloneSafe(payload));
      if(raw&&typeof raw.then==='function')return raw.then(value=>normalizeLoreAuthoringResult(value)).catch(error=>normalizeLoreAuthoringFailure(error,code));
      return normalizeLoreAuthoringResult(raw);
    }catch(error){return normalizeLoreAuthoringFailure(error,code);}
  }
}

export class Wave13ResourceControlAdapter{
  constructor({bindings={},stateStore=null}={}){
    this.bindings=bindings;this.stateStore=stateStore;this.connectionProfileKey='wave13ConnectionProfiles';this.connectionCredentialKey='wave13ConnectionCredentials';this.persistenceSuppressed=new Set();this.restorePromise=null;
    this.host=bindings.resourceHost??bindings.coprocessorResourceHost??bindings.resourceConnectionsHost??null;
    this.publicHost=Boolean(this.host?.actions&&this.host?.read);
    this.listFn=fn(bindings,['listResources','listResourceProfiles','listCapabilityProfiles','readResourceStatus'])??fn(this.host?.read,['resources']);
    this.configFn=fn(bindings,['listResourceConfigurations','listAvailableResources']);
    this.addFn=fn(bindings,['addResource','configureResource'])??fn(this.host?.actions,['addResource']);
    this.discoverModelsFn=fn(bindings,['discoverModels','loadModels','listProviderModels'])??fn(this.host?.actions,['discoverModels']);
    this.refreshModelsFn=fn(bindings,['refreshModels','refreshResourceModels'])??fn(this.host?.actions,['refreshModels']);
    this.selectModelFn=fn(bindings,['selectModel','selectResourceModel'])??fn(this.host?.actions,['selectModel']);
    this.connectFn=fn(bindings,['connectResource','mountResource'])??fn(this.host?.actions,['connectResource']);
    this.disconnectFn=fn(bindings,['disconnectResource','unmountResource'])??fn(this.host?.actions,['disconnectResource']);
    this.testFn=fn(bindings,['testResource','probeResource','testConnection'])??fn(this.host?.actions,['testResource']);
    this.setCredentialFn=fn(bindings,['setCredential','setResourceCredential'])??fn(this.host?.actions,['setCredential']);
    this.setEndpointFn=fn(bindings,['setEndpoint','setResourceEndpoint'])??fn(this.host?.actions,['setEndpoint']);
    this.clearCredentialFn=fn(bindings,['clearCredential','clearResourceCredential','revokeCredential','revokeResourceCredential'])??fn(this.host?.actions,['clearCredential','revokeCredential']);
    this.subscribeFn=fn(bindings,['subscribeResources','subscribeResourceStatus'])??(typeof this.host?.subscribe==='function'?this.host.subscribe.bind(this.host):null);
    this.lastAction=null;this.lastError=null;this.tests=new Map();
  }
  capabilities(){return deepFreeze({read:Boolean(this.listFn),configurations:Boolean(this.configFn),configure:Boolean(this.addFn),discoverModels:Boolean(this.discoverModelsFn),refreshModels:Boolean(this.refreshModelsFn),selectModel:Boolean(this.selectModelFn),connect:Boolean(this.connectFn),disconnect:Boolean(this.disconnectFn),test:Boolean(this.testFn),subscribe:Boolean(this.subscribeFn),persistentProfiles:Boolean(this.stateStore?.load&&this.stateStore?.save),persistentCredentials:Boolean(this.stateStore?.load&&this.stateStore?.save)});}
  savedProfiles(){
    const map=this.#profileMap(),credentials=this.#credentialMap();
    return deepFreeze(Object.values(map).map(row=>({...cloneSafe(row),credentialPersisted:Boolean(credentials[row.role]?.apiKey)})).sort((a,b)=>String(a.role).localeCompare(String(b.role))));
  }
  async forgetSavedProfile(resource){
    const role=connectionProfileRole(resource);
    if(!role)return false;
    const map=this.#profileMap(),existing=map[role]??null;delete map[role];
    const credentials=this.#credentialMap();delete credentials[role];
    this.persistenceSuppressed.add(role);this.#writeProfileMap(map);this.#writeCredentialMap(credentials);
    const id=resourceId(resource)??existing?.resourceId??null;
    if(id&&this.clearCredentialFn){try{await this.clearCredentialFn(id,{reason:'Saved connection lock released by operator.'});}catch(error){this.lastError=error;}}
    return true;
  }
  async configure(config={}){
    this.lastError=null;
    if(!this.addFn){const e=new Error('Resource configure action is not exported by the host assembly.');e.code='RESOURCE_CONFIGURE_ACTION_UNAVAILABLE';this.lastError=e;throw e;}
    try{
      if(this.publicHost){
        const normalized=normalizeWorker2ResourceConfig(config),role=connectionProfileRole(config)??connectionProfileRole(normalized);
        const existing=this.read().data.resources.find(row=>row.id===normalized.resourceId||(role&&row.kind===role));
        if(existing){this.#saveProfile(config,existing,{force:true});return cloneSafe(existing);}
        const result=await this.addFn(normalized);this.#saveProfile(config,result,{force:true});this.lastAction={type:'CONFIGURE',result:cloneSafe(result)};return cloneSafe(result);
      }
      const result=await this.addFn(cloneSafe(config));this.#saveProfile(config,result,{force:true});this.lastAction={type:'CONFIGURE',result:cloneSafe(result)};return cloneSafe(result);
    }catch(error){this.lastError=error;throw error;}
  }
  async restoreSavedProfiles(){
    if(this.restorePromise)return this.restorePromise;
    const work=async()=>{
      const saved=this.savedProfiles();
      if(!saved.length)return deepFreeze({kind:'Wave13ConnectionProfileRestore',saved:0,restored:0,alreadyPresent:0,requalified:0,failed:[]});
      if(!this.addFn)return deepFreeze({kind:'Wave13ConnectionProfileRestore',saved:saved.length,restored:0,alreadyPresent:0,requalified:0,failed:saved.map(row=>({role:row.role,resourceId:row.resourceId,code:'RESOURCE_CONFIGURE_ACTION_UNAVAILABLE'}))});
      let restored=0,alreadyPresent=0,requalified=0;const failed=[];
      for(const profile of saved){
        try{
          const credential=this.#credentialFor(profile.role),hydrated=credential?{...profile,apiKey:credential}:profile;
          let current=this.read().data.resources,row=current.find(item=>item.id===profile.resourceId||item.kind===profile.role)??null;
          if(row){
            alreadyPresent+=1;
            if(credential&&this.setCredentialFn&&row.credentialConfigured!==true){
              await this.setCredentialFn(row.id,credential);current=this.read().data.resources;row=current.find(item=>item.id===profile.resourceId||item.kind===profile.role)??row;
            }
          }else{
            await this.configure(hydrated);restored+=1;current=this.read().data.resources;row=current.find(item=>item.id===profile.resourceId||item.kind===profile.role)??null;
          }
          if(profile.wasConnected&&row&&this.connectFn&&!row.callable){
            const result=await this.connectFn(row.id);requalified+=1;this.#saveProfile(hydrated,result??row,{force:true});
          }
        }catch(error){failed.push({role:profile.role,resourceId:profile.resourceId,stage:'RESTORE',code:error?.code??'RESOURCE_RESTORE_FAILED',message:String(error?.message??error)});}
      }
      return deepFreeze({kind:'Wave13ConnectionProfileRestore',saved:saved.length,restored,alreadyPresent,requalified,failed});
    };
    this.restorePromise=work().finally(()=>{this.restorePromise=null;});
    return this.restorePromise;
  }
  read(){
    if(!this.listFn)return deepFreeze({
      source:createProductSourceStatus({mode:ProductDataMode.UNAVAILABLE,health:Wave6Health.UNAVAILABLE,label:'Optional resources',operationalState:OperatorProducerState.UNAVAILABLE,impact:'Native Brain remains available. Optional resource control is not exported by this assembly.',reason:'Worker 2 resource host/read contract is not exported by this assembly.',producer:'OptionalResourceControl',connected:false}),
      data:{resources:[],configurations:this.configurations(),nativePathAvailable:true},
    });
    try{
      const raw=this.listFn();
      const resources=normalizeResources(raw);
      this.#captureProfiles(resources);
      const connected=resources.filter(x=>x.connected).length;
      const degradedRows=resources.filter(x=>['DEGRADED','SATURATED','COOLDOWN','UNAVAILABLE'].includes(x.health)||x.state==='UNAVAILABLE');
      const health=degradedRows.length?Wave6Health.DEGRADED:Wave6Health.READY;
      const op=connected?degradedRows.length?OperatorProducerState.DEGRADED:OperatorProducerState.LIVE:OperatorProducerState.DISCONNECTED;
      return deepFreeze({
        source:createProductSourceStatus({mode:degradedRows.length?ProductDataMode.DEGRADED:ProductDataMode.LIVE,health,label:'Optional resources',operationalState:op,impact:connected?connected+' optional execution resource'+(connected===1?' is':'s are')+' connected.':'No optional Jev or sidecar resource is connected; native Brain remains usable.',producer:raw?.kind??'Worker2ResourceStatus',revision:raw?.sequence??null,connected:true}),
        data:{resources,configurations:this.configurations(),nativePathAvailable:true,nativePathRequired:Boolean(raw?.nativePathRequired)},
      });
    }catch(error){return degraded('Optional resources','Resource status could not be read.','Worker2ResourceStatus',{},error,{resources:[],configurations:[],nativePathAvailable:true});}
  }
  configurations(){
    if(!this.configFn)return[];
    try{const rows=this.configFn()??[];return Array.isArray(rows)?rows.map(normalizeConfiguration):[];}catch{return[];}
  }
  async discoverModels(config={}){
    this.lastError=null;
    if(!this.discoverModelsFn){const e=new Error('Provider model discovery is not exported by the Worker 2 resource host.');e.code='RESOURCE_MODEL_DISCOVERY_UNAVAILABLE';this.lastError=e;throw e;}
    try{
      const role=connectionProfileRole(config),credential=(typeof config.apiKey==='string'&&config.apiKey.trim())?config.apiKey.trim():this.#credentialFor(role);
      const hydrated=credential?{...config,apiKey:credential}:config;
      const payload=this.publicHost?normalizeWorker2DiscoveryConfig(hydrated):cloneSafe(hydrated);
      const result=await this.discoverModelsFn(payload);
      this.lastAction={type:'DISCOVER_MODELS',result:cloneSafe(result)};
      return cloneSafe(result);
    }catch(error){this.lastError=error;throw error;}
  }
  async refreshModels(resource){
    return this.#resourceAction('REFRESH_MODELS',this.refreshModelsFn,resource,'Configured-resource model refresh is not exported by the Worker 2 resource host.');
  }
  async selectModel(resource,modelId){
    this.lastError=null;
    if(!this.selectModelFn){const e=new Error('Configured-resource model selection is not exported by the Worker 2 resource host.');e.code='RESOURCE_MODEL_SELECTION_UNAVAILABLE';this.lastError=e;throw e;}
    const id=resourceId(resource),model=text(modelId);
    if(!id){const e=new TypeError('Resource model selection requires resourceId.');e.code='RESOURCE_ID_REQUIRED';this.lastError=e;throw e;}
    if(!model){const e=new TypeError('A model ID must be entered. Discovered models are suggestions, not a whitelist.');e.code='RESOURCE_MODEL_REQUIRED';this.lastError=e;throw e;}
    try{const result=await this.selectModelFn(id,model);this.lastAction={type:'SELECT_MODEL',result:cloneSafe(result)};return cloneSafe(result);}
    catch(error){this.lastError=error;throw error;}
  }
  async connect(config){
    this.lastError=null;
    if(!this.connectFn){const e=new Error('Resource connect action is not exported by the host assembly.');e.code='RESOURCE_ACTION_UNAVAILABLE';this.lastError=e;throw e;}
    try{
      let result;const role=connectionProfileRole(config),explicitCredential=typeof config?.apiKey==='string'?config.apiKey.trim():'';
      const credential=explicitCredential||this.#credentialFor(role),hydrated=credential?{...config,apiKey:credential}:config;
      if(this.publicHost){
        const requestedId=resourceId(hydrated);
        const existing=this.read().data.resources.find(row=>(requestedId&&row.id===requestedId)||(role&&row.kind===role));
        if(existing){
          // A bare reconnect (an existing resource row, no endpoint or model fields) must not require a full configuration.
          const desired=text(hydrated?.endpoint)?normalizeWorker2ResourceConfig(hydrated):{endpoint:null,modelId:text(hydrated?.modelId)||null};
          if(desired.endpoint&&desired.endpoint!==existing.endpoint){
            if(!this.setEndpointFn){const e=new Error('Resource endpoint update action is not exported by the host assembly.');e.code='RESOURCE_ENDPOINT_UPDATE_UNAVAILABLE';throw e;}
            await this.setEndpointFn(existing.id,desired.endpoint);
          }
          if(desired.modelId&&desired.modelId!==existing.modelId){
            if(!this.selectModelFn){const e=new Error('Resource model update action is not exported by the host assembly.');e.code='RESOURCE_MODEL_UPDATE_UNAVAILABLE';throw e;}
            await this.selectModelFn(existing.id,desired.modelId);
          }
          if(credential&&this.setCredentialFn&&(Boolean(explicitCredential)||existing.credentialConfigured!==true))await this.setCredentialFn(existing.id,credential);
          result=await this.connectFn(existing.id);this.#saveProfile(hydrated,result??existing,{force:true});
        }else{
          const normalized=normalizeWorker2ResourceConfig(hydrated);
          if(!this.addFn){const e=new Error('Worker 2 resource host requires addResource() before connectResource().');e.code='RESOURCE_CONFIGURE_ACTION_UNAVAILABLE';throw e;}
          const configured=await this.addFn(normalized);this.#saveProfile(hydrated,configured??normalized,{force:true});
          result=await this.connectFn(normalized.resourceId);this.#saveProfile(hydrated,result??configured??normalized,{force:true});
        }
      }else{
        result=await this.connectFn(cloneSafe(hydrated));this.#saveProfile(hydrated,result,{force:true});
      }
      this.lastAction={type:'CONNECT',result:cloneSafe(result)};return cloneSafe(result);
    }catch(error){this.lastError=error;throw error;}
  }
  async disconnect(resource){
    return this.#resourceAction('DISCONNECT',this.disconnectFn,resource,'Resource disconnect action is not exported by the host assembly.');
  }
  async test(resource){
    const result=await this.#resourceAction('TEST',this.testFn,resource,'Resource connection-test action is not exported by the host assembly.');
    const id=resourceId(resource);if(id)this.tests.set(id,cloneSafe(result));return result;
  }
  testResult(id){return cloneSafe(this.tests.get(String(id))??null);}
  subscribe(listener){
    if(typeof listener!=='function'||!this.subscribeFn)return()=>{};
    const release=this.subscribeFn(listener);return typeof release==='function'?release:()=>{};
  }
  async #resourceAction(type,action,payload,message){
    this.lastError=null;
    if(!action){const e=new Error(message);e.code='RESOURCE_ACTION_UNAVAILABLE';this.lastError=e;throw e;}
    try{
      const arg=this.publicHost?resourceId(payload):cloneSafe(payload);
      if(this.publicHost&&!arg){const e=new TypeError('Resource action requires resourceId.');e.code='RESOURCE_ID_REQUIRED';throw e;}
      const result=await action(arg);this.lastAction={type,result:cloneSafe(result)};return cloneSafe(result);
    }catch(error){this.lastError=error;throw error;}
  }
  #profileMap(){
    if(!this.stateStore?.load)return{};
    const raw=this.stateStore.load()?.[this.connectionProfileKey];
    if(!raw||typeof raw!=='object'||Array.isArray(raw))return{};
    const out={};
    for(const row of Object.values(raw)){
      const normalized=normalizePersistedConnectionProfile(row);
      if(normalized)out[normalized.role]=normalized;
    }
    return out;
  }
  #credentialMap(){
    if(!this.stateStore?.load)return{};
    const raw=this.stateStore.load()?.[this.connectionCredentialKey];
    if(!raw||typeof raw!=='object'||Array.isArray(raw))return{};
    const out={};
    for(const [role,row] of Object.entries(raw)){
      const normalizedRole=connectionProfileRole({role});const apiKey=typeof row?.apiKey==='string'?row.apiKey.trim():'';
      if(normalizedRole&&apiKey)out[normalizedRole]={version:1,apiKey};
    }
    return out;
  }
  #credentialFor(role){const normalized=connectionProfileRole({role});return normalized?this.#credentialMap()[normalized]?.apiKey??null:null;}
  #writeProfileMap(map){if(this.stateStore?.save)this.stateStore.save({[this.connectionProfileKey]:map});}
  #writeCredentialMap(map){if(this.stateStore?.save)this.stateStore.save({[this.connectionCredentialKey]:map});}
  #saveCredential(input,role,{force=false}={}){
    const normalizedRole=connectionProfileRole({role})??connectionProfileRole(input),apiKey=typeof input?.apiKey==='string'?input.apiKey.trim():'';
    if(!normalizedRole||!apiKey||!this.stateStore?.save)return null;
    if(this.persistenceSuppressed.has(normalizedRole)&&!force)return null;
    const map=this.#credentialMap(),next={version:1,apiKey};
    if(map[normalizedRole]?.apiKey===apiKey)return true;
    map[normalizedRole]=next;this.#writeCredentialMap(map);return true;
  }
  #saveProfile(input,observed=null,{force=false}={}){
    const normalized=normalizePersistedConnectionProfile(input,observed);
    if(!normalized||!this.stateStore?.save)return null;
    if(this.persistenceSuppressed.has(normalized.role)&&!force)return null;
    if(force)this.persistenceSuppressed.delete(normalized.role);
    this.#saveCredential(input,normalized.role,{force});
    const map=this.#profileMap(),previous=map[normalized.role]??null;
    if(JSON.stringify(previous)===JSON.stringify(normalized))return cloneSafe(normalized);
    map[normalized.role]=normalized;this.#writeProfileMap(map);return cloneSafe(normalized);
  }
  #captureProfiles(resources=[]){for(const row of resources)this.#saveProfile(row,row);}
}

export class Wave13OperationalStatusAdapter{
  constructor({hostBindings={},liveReceiptBinding=null,productionAdapters={},loreStudy=null,resources=null}={}){
    this.hostBindings=hostBindings;this.live=liveReceiptBinding;this.adapters=productionAdapters;this.loreStudy=loreStudy;this.resources=resources;
  }
  read(){
    const selection=this.live?.selection?.()??{};
    const cognition=this.#cognition(selection),generation=this.#generation(selection),hostLifecycle=this.#hostLifecycle(),hostDelivery=this.#hostDelivery(selection);
    const sceneObservationReader=fn(this.hostBindings,['readSceneObservationReceipts']);
    const sceneObservations=sceneObservationReader?safeRead(()=>sceneObservationReader(),[])??[]:[];
    const sceneRuntimeReader=fn(this.hostBindings,['readSceneObservationRuntime']);
    const sceneRuntime=sceneRuntimeReader?safeRead(()=>sceneRuntimeReader(selection),null):null;
    const stages=[
      this.#adapterStage('scene','Scene',this.adapters.scene,selection,{turnBound:true,exported:Boolean(this.hostBindings.readScene||this.hostBindings.readSceneModel||this.hostBindings.readSceneUiReadModel)}),
      this.#runtimeStage(selection,cognition),
      this.#coprocessorStage(selection),
      this.#cognitionStage('choice','Cognitive Choice',cognition,selection),
      this.#cognitionStage('truth','Truth',cognition,selection),
      this.#cognitionStage('jev','Jev',cognition,selection,{optional:true}),
      this.#cognitionStage('gather','Gather',cognition,selection),
      this.#cognitionStage('seal','Context Seal',cognition,selection),
      this.#adapterStage('promptPlan','PromptPlan',this.adapters.promptPlan,selection,{turnBound:true,exported:Boolean(this.hostBindings.readPromptPlan||this.hostBindings.readPromptPlanReadModel||this.hostBindings.readGeneration)}),
      this.#generationStage(selection,generation,hostDelivery),
      this.#learningStage(selection,generation),
      this.#sourceStage('lore','Lore Study',this.loreStudy?.readStatus?.()??this.loreStudy?.read?.(),selection),
      this.#memoryStage(selection),
      this.#forensicsStage(selection),
    ];
    const active=stages.filter(x=>[OperatorProducerState.LIVE,OperatorProducerState.WORKING,OperatorProducerState.IDLE].includes(x.state)).length;
    const failures=stages.filter(x=>x.state===OperatorProducerState.DEGRADED).length;
    const scatter=cognition?.data?.scatter??null,gather=cognition?.data?.gather??null,seal=cognition?.data?.seal??null;
    const registeredIds=new Set(['scene','runtime','coprocessor','choice','truth','jev','gather','seal','promptPlan','generation','learning']);
    const registered=stages.filter(x=>registeredIds.has(x.id)&&![OperatorProducerState.UNAVAILABLE,OperatorProducerState.DISCONNECTED].includes(x.state)).length;
    const jobs=scatter?.jobs??[],results=gather?.results??[],admitted=seal?.effectiveAdmittedResultIds??seal?.admittedResultIds??[];
    const mappedResourceIds=[...new Set(jobs.map(row=>row.resourceId).filter(Boolean))];
    const coprocessorRead=safeRead(()=>this.adapters.coprocessor?.read?.(selection)??this.adapters.coprocessor?.read?.(),null);
    const physical=coprocessorRead?.data?.physicalExecution??{};
    const physicalAttempts=Math.max(0,Number(physical.attempts??0)),physicalSucceeded=Math.max(0,Number(physical.succeeded??0)),physicalFailed=Math.max(0,Number(physical.failed??0));
    const learning=generation?.learningReceipt??null;
    const hostPrepared=Boolean(hostDelivery&&(hostDelivery.preparedAt!=null||hostDelivery.renderedPayloadDigest||hostDelivery.renderedMessageCount!=null));
    const hostInjected=Boolean(hostDelivery?.promptInjected??hostDelivery?.requestInjectedAt);
    const pipeline=deepFreeze({
      registeredProducers:registered,mappingReceipt:Boolean(scatter),logicalJobsMapped:Array.isArray(jobs)?jobs.length:0,mappedResourceCount:mappedResourceIds.length,mappedResourceIds,
      executionReceipt:physicalAttempts>0,physicalExecutionAttempts:physicalAttempts,physicalExecutionSucceeded:physicalSucceeded,physicalExecutionFailed:physicalFailed,executedJobs:physicalSucceeded,
      resultReceipt:Boolean(gather),returnedResults:Array.isArray(results)?results.length:0,
      admissionReceipt:Boolean(seal),contextAdmitted:Array.isArray(admitted)?admitted.length:0,
      generationReader:Boolean(fn(this.hostBindings,['readGeneration'])),generationReceipt:Boolean(generation),generationState:generation?.state??null,
      promptPlanReceipt:Boolean(generation?.promptPlan),hostDeliveryReader:Boolean(fn(this.hostBindings,['readHostDeliveryReceipt'])),
      hostPrepared,hostInjected,deliveryReceipt:hostInjected,hostDeliveryReceipt:Boolean(hostDelivery),hostDeliveryState:hostDelivery?.state??null,completionReceipt:Boolean(hostDelivery?.responseCompleted??hostDelivery?.completedAt),
      learningReceipt:Boolean(learning),learningKind:learning?.kind??null,
      sceneObservation:{
        counts:Object.fromEntries(['QUEUED','DEDUPED','RETURNED','ROUTED','ADMITTED','REJECTED','FAILED','CANCELLED','INVALID','SKIPPED'].map(status=>[status,sceneObservations.filter(row=>row?.status===status).length])),
        recent:cloneSafe(sceneObservations.slice(-32)),
        runtime:cloneSafe(sceneRuntime),
        metadataOnly:true,
      },
      hostLifecycle:cloneSafe(hostLifecycle),
    });
    const inspections=this.#inspections({selection,cognition,generation,hostDelivery,stages,coprocessorRead,sceneObservations});
    return deepFreeze({kind:'Wave13OperationalStatus',selection:cloneSafe(selection),stages,active,failures,pipeline,sceneObservation:cloneSafe(pipeline.sceneObservation),inspections,inspection:generationInspectionSummary(generation,selection),waitingForTurn:Boolean(selection.chatId&&!selection.turnId),hostConnected:Boolean(selection.chatId),rawPromptTelemetry:false});
  }
  #inspections({selection,cognition,generation,hostDelivery,stages,coprocessorRead,sceneObservations=[]}={}){
    const stageById=new Map((stages??[]).map(row=>[row.id,row]));
    const adapterData=(adapter)=>safeRead(()=>adapter?.read?.(selection)??adapter?.read?.(),null)?.data??null;
    const data=cognition?.data??{},errors=cognition?.errors??{};
    const values={
      scene:adapterData(this.adapters.scene),runtime:adapterData(this.adapters.runtime),coprocessor:coprocessorRead?.data??null,
      choice:data.choice??null,truth:data.truth??null,jev:data.jev??null,gather:data.gather??null,seal:data.seal??null,
      promptPlan:adapterData(this.adapters.promptPlan),generation:hostDelivery??null,learning:generation?.learningReceipt??null,
      scatter:data.scatter??null,
    };
    const out={};
    for(const [id,payload] of Object.entries(values)){
      const row=stageById.get(id)??(id==='scatter'?stageById.get('runtime'):null);
      out[id]=producerInspection(id,row?.label??humanInspectionLabel(id),payload,selection,{stage:row,error:errors[id]??null,reason:row?.reason??'No owner receipt was published for the selected turn.'});
    }
    return deepFreeze(out);
  }
  #cognition(selection){try{return this.adapters.cognition?.read?.(selection)??null;}catch{return null;}}
  #generation(selection){
    const reader=fn(this.hostBindings,['readGeneration']);
    if(!reader||!selection?.generationId)return null;
    try{
      const value=reader({generationId:selection.generationId,...cloneSafe(selection)});
      if(value&&typeof value.then==='function')return null;
      if(value)assertSelection(value,selection,'Generation',{allowMissingIdentity:true});
      return value??null;
    }catch{return null;}
  }
  #hostLifecycle(){
    const reader=fn(this.hostBindings,['readNativeBrainHostLifecycle']);
    if(!reader)return null;
    try{const value=reader();return value&&typeof value.then!=='function'?cloneSafe(value):null;}catch{return null;}
  }
  #hostDelivery(selection){
    const reader=fn(this.hostBindings,['readHostDeliveryReceipt']);
    if(!reader||!selection?.generationId)return null;
    try{
      const value=reader(cloneSafe(selection));
      if(value&&typeof value.then==='function')return null;
      if(value)assertSelection(value,selection,'SillyTavern host delivery',{allowMissingIdentity:false});
      return value??null;
    }catch{return null;}
  }
  #generationStage(selection,generation,hostDelivery){
    const hostReader=Boolean(fn(this.hostBindings,['readHostDeliveryReceipt']));
    if(!hostReader)return stage('generation','SillyTavern prompt delivery',OperatorProducerState.UNAVAILABLE,'The installed assembly does not export an exact host-delivery receipt. PromptPlan and Context Seal do not prove SillyTavern received the prompt.',selection,null,'HOST_DELIVERY_READER_MISSING');
    if(selection.chatId&&!selection.generationId)return stage('generation','SillyTavern prompt delivery',OperatorProducerState.WAITING_FOR_TURN,'Waiting for a generation identity from the selected chat.',selection,null,'HOST_SELECTION');
    if(!hostDelivery){
      const reason=generation?.promptPlan?'PromptPlan exists, but no exact SillyTavern model-request injection receipt has been observed.':'No exact SillyTavern host-delivery receipt exists for the selected generation.';
      return stage('generation','SillyTavern prompt delivery',OperatorProducerState.IDLE,reason,selection,null,'NO_HOST_DELIVERY_RECEIPT');
    }
    const aborted=String(hostDelivery.state??'').toUpperCase()==='ABORTED',injected=Boolean(hostDelivery.promptInjected??hostDelivery.requestInjectedAt);
    if(aborted)return stage('generation','SillyTavern prompt delivery',OperatorProducerState.DEGRADED,'The host generation was aborted: '+String(hostDelivery.abortCode??'unknown reason')+'.',selection,null,'HOST_GENERATION_ABORTED');
    if(!injected)return stage('generation','SillyTavern prompt delivery',OperatorProducerState.WORKING,'Context is prepared, but SillyTavern has not yet observed the request payload at the model-request hook.',selection,null,'HOST_DELIVERY_PENDING');
    return stage('generation','SillyTavern prompt delivery',OperatorProducerState.LIVE,'SillyTavern observed the exact prepared request payload at the model-request hook.',selection,null,'HOST_DELIVERY_OBSERVED');
  }
  #learningStage(selection,generation){
    const exported=Boolean(fn(this.hostBindings,['readGeneration']));
    if(!exported)return stage('learning','Learning write-back',OperatorProducerState.UNAVAILABLE,'Assembly does not export the native Brain generation/learning read contract.',selection,null,'ASSEMBLY_CONTRACT_MISSING');
    if(selection.chatId&&!selection.generationId)return stage('learning','Learning write-back',OperatorProducerState.WAITING_FOR_TURN,'Learning is tied to a completed generation response.',selection,null,'HOST_SELECTION');
    if(!generation)return stage('learning','Learning write-back',OperatorProducerState.IDLE,'No owner generation receipt exists to inspect for learning.',selection,null,'NO_RECEIPT');
    if(!generation.learningReceipt)return stage('learning','Learning write-back',OperatorProducerState.IDLE,'Generation delivery may be complete, but no post-response learning receipt has been published yet.',selection,null,'NO_LEARNING_RECEIPT');
    return stage('learning','Learning write-back',OperatorProducerState.LIVE,'The native Brain recorded post-response learning for this generation.',selection,null,'OWNER_LEARNING_RECEIPT');
  }
  #adapterStage(id,label,adapter,selection,{turnBound=false,exported=true}={}){
    if(!exported)return stage(id,label,OperatorProducerState.UNAVAILABLE,'Assembly does not export the '+label+' owner reader.',selection,null,'ASSEMBLY_CONTRACT_MISSING');
    if(!adapter)return this.#missing(id,label,selection,turnBound);
    if(turnBound&&selection.chatId&&!selection.turnId)return stage(id,label,OperatorProducerState.WAITING_FOR_TURN,'Waiting for an active turn.',selection,null,'HOST_SELECTION');
    let read;try{read=adapter.read?.(selection)??adapter.read?.();}catch(error){return stage(id,label,OperatorProducerState.DEGRADED,String(error?.message??error),selection,null,'READ_ERROR');}
    return stageFromSource(id,label,read?.source,selection,{readerPresent:true});
  }
  #runtimeStage(selection,cognition){
    const hasRuntime=Boolean(this.hostBindings.runtimeAdapter||this.hostBindings.readRuntimeStatus||this.hostBindings.readScatter||this.hostBindings.readRuntimeTurn);
    if(selection.chatId&&!selection.turnId&&hasRuntime)return stage('runtime','Runtime',OperatorProducerState.WAITING_FOR_TURN,'Runtime is available; waiting for an active turn.',selection,null,'HOST_SELECTION');
    const normal=this.#adapterStage('runtime','Runtime',this.adapters.runtime,selection);
    if(normal.state!==OperatorProducerState.UNAVAILABLE)return normal;
    const scatter=cognition?.data?.scatter,source=cognition?.sources?.scatter;
    if(scatter)return stageFromSource('runtime','Runtime',source,selection,{readerPresent:true,reason:'Selected-turn Runtime scatter receipt is available; scheduler telemetry is not exported separately.'});
    if(hasRuntime)return stage('runtime','Runtime',OperatorProducerState.IDLE,'Runtime boundary is exported but no selected-turn execution receipt is available.',selection,null,'NO_TURN_RECEIPT');
    return normal;
  }
  #coprocessorStage(selection){
    const has=Boolean(this.hostBindings.coprocessorTelemetry||this.hostBindings.coprocessorAdapter||this.hostBindings.readCognitionUiState||this.hostBindings.readCoprocessorChoiceContribution);
    if(!has)return stage('coprocessor','Coprocessor',OperatorProducerState.UNAVAILABLE,'Assembly does not export Worker 2 CognitionUiState or Coprocessor choice contribution.',selection,null,'ASSEMBLY_CONTRACT_MISSING');
    if(selection.chatId&&!selection.turnId)return stage('coprocessor','Coprocessor',OperatorProducerState.WAITING_FOR_TURN,'Coprocessor is available; waiting for an active turn.',selection,null,'HOST_SELECTION');
    const normal=this.#adapterStage('coprocessor','Coprocessor',this.adapters.coprocessor,selection);
    if(normal.state!==OperatorProducerState.UNAVAILABLE)return normal;
    return stage('coprocessor','Coprocessor',OperatorProducerState.IDLE,'Coprocessor boundary is exported but has no selected-turn telemetry.',selection,null,'NO_TELEMETRY');
  }
  #cognitionStage(key,label,cognition,selection,{optional=false}={}){
    const source=cognition?.sources?.[key]??null,data=cognition?.data?.[key]??null,exported=readerExported(this.hostBindings,key);
    if(!exported)return stage(key,label,optional?OperatorProducerState.DISCONNECTED:OperatorProducerState.UNAVAILABLE,optional?'Optional '+label+' reader/resource is not connected.':'Assembly does not export the '+label+' owner reader.',selection,null,'ASSEMBLY_CONTRACT_MISSING');
    if(selection.chatId&&!selection.turnId)return stage(key,label,OperatorProducerState.WAITING_FOR_TURN,'Waiting for an active turn.',selection,null,'HOST_SELECTION');
    if(key==='jev'&&data&&isIntentionalJevSkip(data))return stage(key,label,OperatorProducerState.IDLE,'Jev was intentionally not required for this selected turn. No provider failure occurred.',selection,freshnessOf(data),'JEV_NOT_REQUIRED');
    if(data)return stageFromSource(key,label,source,selection,{readerPresent:true});
    if(source?.mode===ProductDataMode.DEGRADED)return stageFromSource(key,label,source,selection,{readerPresent:true});
    if(source?.mode===ProductDataMode.UNAVAILABLE)return stage(key,label,OperatorProducerState.IDLE,'No receipt was published for the selected turn.',selection,null,'NO_RECEIPT');
    return stageFromSource(key,label,source,selection,{readerPresent:true});
  }
  #sourceStage(id,label,read,selection){
    if(!read)return this.#missing(id,label,selection,false);
    return stageFromSource(id,label,read.source,selection,{readerPresent:true});
  }
  #memoryStage(selection){
    const reader=fn(this.hostBindings,['readMemoryStatus','readMemory','readMemoryReadModel']);
    if(!reader)return stage('memory','Memory',OperatorProducerState.UNAVAILABLE,'Assembly does not export a Memory status reader.',selection,null,'ASSEMBLY_CONTRACT_MISSING');
    if(selection.chatId&&!selection.turnId)return stage('memory','Memory',OperatorProducerState.IDLE,'Memory producer is available; no active turn is required to inspect retained state.',selection,null,'NO_ACTIVE_TURN');
    try{
      const raw=reader(selection);if(!raw)return stage('memory','Memory',OperatorProducerState.IDLE,'Memory producer has no current status record.',selection,null,'NO_STATUS');
      assertSelection(raw,selection,'Memory',{allowMissingIdentity:true});
      const reasonCode=String(raw.reasonCode??raw.code??raw.reason?.code??'').toUpperCase();
      if(reasonCode==='MEMORY_NO_EVIDENCE_FOR_SELECTED_CHAT')return stage('memory','Memory',OperatorProducerState.IDLE,'No memories recorded for this chat yet.',selection,freshnessOf(raw),reasonCode);
      return stage('memory','Memory',OperatorProducerState.LIVE,'Memory owner status is available for the selected chat.',selection,freshnessOf(raw),reasonCode||'OWNER_STATUS');
    }catch(error){return stage('memory','Memory',OperatorProducerState.DEGRADED,String(error?.message??error),selection,null,error?.code??'READ_ERROR');}
  }
  #forensicsStage(selection){
    const exported=Boolean(this.hostBindings.readForensic||this.hostBindings.readForensicReadModel||this.hostBindings.listForensics||this.hostBindings.listTransactions);
    if(!exported)return stage('forensics','Forensics',OperatorProducerState.UNAVAILABLE,'Assembly does not export Forensics/transaction readers.',selection,null,'ASSEMBLY_CONTRACT_MISSING');
    if(selection.chatId&&!selection.turnId)return stage('forensics','Forensics',OperatorProducerState.WAITING_FOR_TURN,'Waiting for an active turn.',selection,null,'HOST_SELECTION');
    try{const read=this.adapters.forensics?.readGeneration?.(selection.generationId)??null;return read?.data?stage('forensics','Forensics',OperatorProducerState.LIVE,'Forensic reconstruction is available for this generation.',selection,null,'OWNER_RECEIPT'):stage('forensics','Forensics',OperatorProducerState.IDLE,'No forensic bundle is available for the selected generation.',selection,null,'NO_RECEIPT');}
    catch(error){return stage('forensics','Forensics',OperatorProducerState.DEGRADED,String(error?.message??error),selection,null,error?.code??'READ_ERROR');}
  }
  #missing(id,label,selection,turnBound){if(turnBound&&selection.chatId&&!selection.turnId)return stage(id,label,OperatorProducerState.WAITING_FOR_TURN,'Waiting for an active turn.',selection,null,'HOST_SELECTION');return stage(id,label,OperatorProducerState.UNAVAILABLE,'Producer is not exported by the host assembly.',selection,null,'ASSEMBLY_CONTRACT_MISSING');}
}


export class Wave13DiagnosticsCenterAdapter{
  constructor({operations=null,resources=null,loreStudy=null,memory=null,cognition=null,liveReceiptBinding=null,productionAdapters={},uiLoadTrace=null,graphVisibility=null,hostBindings={}}={}){
    this.operations=operations;this.resources=resources;this.loreStudy=loreStudy;this.memory=memory;this.cognition=cognition;this.live=liveReceiptBinding;this.adapters=productionAdapters;this.uiLoadTrace=uiLoadTrace;this.graphVisibility=graphVisibility;this.hostBindings=hostBindings??{};
  }
  setGenerationProfiling(enabled=false){
    const setter=fn(this.hostBindings,['setDetailedGenerationProfiling']);
    if(!setter)return deepFreeze({ok:false,enabled:null,reason:'PROFILING_CONTROL_UNAVAILABLE',sessionScoped:true,persisted:false});
    try{
      const value=setter(Boolean(enabled));
      if(value&&typeof value.then==='function')return deepFreeze({ok:false,enabled:null,reason:'ASYNC_PROFILING_CONTROL_UNSUPPORTED',sessionScoped:true,persisted:false});
      return deepFreeze({ok:true,enabled:Boolean(value),reason:null,sessionScoped:true,persisted:false});
    }catch(error){
      return deepFreeze({ok:false,enabled:null,reason:String(error?.code??error?.message??'PROFILING_CONTROL_FAILED'),sessionScoped:true,persisted:false});
    }
  }
  readJournalEvidence(){
    const selection=cloneSafe(this.live?.selection?.()??{});
    const resourceRead=safeRead(()=>this.resources?.read?.(),null),rows=resourceRead?.data?.resources??[];
    const liveDiagnostics=safeRead(()=>this.live?.diagnostics?.(),null);
    return deepFreeze({
      kind:'Wave13JournalEvidence',selection,
      host:{liveBinding:cloneSafe(liveDiagnostics),rawPromptTelemetry:false},
      resources:{rows:rows.slice(0,32).map(row=>deepFreeze({
        id:row.id,displayName:row.displayName,kind:row.kind,physicalExecutionAttempted:Boolean(row.physicalExecutionAttempted),
        physicalExecutionSucceeded:Boolean(row.physicalExecutionSucceeded),ownerAccepted:row.ownerAccepted??null,ownerAcceptanceSource:row.ownerAcceptanceSource??null,
        reasonCode:row.reasonCode,reason:row.reason,lastExecution:row.kind==='VECTORING'?safeVectoringExecution(row.lastExecution):cloneSafe(row.lastExecution),lastFailure:cloneSafe(row.lastFailure),
      }))},
    });
  }
  read(){
    const operations=safeRead(()=>this.operations?.read?.(),null);
    const selection=cloneSafe(this.live?.selection?.()??operations?.selection??{});
    const resourceRead=safeRead(()=>this.resources?.read?.(),null);
    const loreRead=safeRead(()=>this.loreStudy?.readStatus?.()??this.loreStudy?.read?.(),null);
    const memoryRead=safeRead(()=>this.memory?.read?.(),null);
    const cognitionRead=safeRead(()=>this.cognition?.read?.(selection),null);
    const runtimeRead=safeRead(()=>this.adapters.runtime?.read?.(selection)??this.adapters.runtime?.read?.(),null);
    const coprocessorRead=safeRead(()=>this.adapters.coprocessor?.read?.(selection)??this.adapters.coprocessor?.read?.(),null);
    const promptPlanRead=safeRead(()=>this.adapters.promptPlan?.read?.(selection)??this.adapters.promptPlan?.read?.(),null);
    const generationPerformance=this.#generationPerformance(selection);
    const liveDiagnostics=safeRead(()=>this.live?.diagnostics?.(),null);
    const graphRead=safeRead(()=>this.graphVisibility?.read?.(selection),null);
    const nexusDiagnostics=safeRead(()=>this.hostBindings.readDiagnosticsTelemetry?.(selection),null);
    const resourceCaps=this.resources?.capabilities?.()??{};
    const rows=resourceRead?.data?.resources??[];
    const observabilityEvents=nexusDiagnostics?.telemetry?.observability?.events??[];
    const vectoringTrace=projectVectoringCausalTrace({resources:rows,telemetryEvents:observabilityEvents,selection});
    const lanes=['JEV','SIDECAR','VECTORING'].map(kind=>{
      const members=rows.filter(row=>String(row.kind??'SIDECAR').toUpperCase()===kind);
      return deepFreeze({
        kind,configured:members.length,connected:members.filter(row=>row.connected).length,callable:members.filter(row=>row.callable).length,
        attempted:members.filter(row=>row.physicalExecutionAttempted).length,succeeded:members.filter(row=>row.physicalExecutionSucceeded).length,
        ownerAccepted:members.filter(row=>row.ownerAccepted===true).length,
        activeExecutions:members.reduce((sum,row)=>sum+Number(row.currentLoad??0),0),
        resourceIds:members.map(row=>row.id),
        states:members.map(row=>({id:row.id,displayName:row.displayName,state:row.state,health:row.health,reasonCode:row.reasonCode,lastTest:cloneSafe(row.lastTest),lastExecution:cloneSafe(row.lastExecution)})),
      });
    });
    const cognitionData=cognitionRead?.data??{};
    const scatter=cognitionData.scatter??null,gather=cognitionData.gather??null,seal=cognitionData.seal??null,jev=cognitionData.jev??null;
    const sealedIds=new Set(seal?.effectiveAdmittedResultIds??seal?.admittedResultIds??[]);
    const jobs=(scatter?.jobs??[]).slice(0,40).map(job=>deepFreeze({
      jobId:job.jobId??job.taskId??null,taskId:job.taskId??job.jobId??null,taskType:job.taskType??null,capability:job.capability??job.requiredCapabilities?.[0]??null,
      state:job.state??job.status??null,resourceId:job.resourceId??null,providerId:job.providerId??job.provider??null,workerId:job.workerId??null,modelId:job.modelId??job.model??null,
    }));
    const results=(gather?.results??[]).slice(0,64).map(result=>deepFreeze({
      resultId:result.resultId??null,taskId:result.taskId??result.jobId??null,status:result.status??null,capability:result.capability??null,resourceId:result.resourceId??null,
      destination:result.destination??null,contextAdmitted:Boolean(result.resultId&&sealedIds.has(result.resultId)),
    }));
    const resourceEvents=rows.flatMap(row=>(row.diagnostics??[]).slice(-16).map(event=>deepFreeze({
      source:'RESOURCE',resourceId:row.id,displayName:row.displayName??null,sequence:event.sequence??null,at:event.at??null,code:event.code??null,message:event.message??'',details:cloneSafe(event.details??{}),
    }))).sort((a,b)=>Number(b.sequence??0)-Number(a.sequence??0)).slice(0,80);
    const loreData=loreRead?.data??null;
    const learned=(loreData?.entries??[]).filter(row=>row.learnedRevisionId&&row.freshness==='CURRENT').length;
    const runtimeData=runtimeRead?.data??{},runtimeReceipt=runtimeData.receipt??{};
    const runtimeTurn=deepFreeze({
      resourceCount:Number(runtimeData.resourceCount??runtimeReceipt.resourceCount??0),
      resourceIds:[...new Set((runtimeData.resourceIds??runtimeReceipt.resourceIds??[]).map(String))].slice(0,16),
      admittedJobCount:Number(runtimeData.admittedJobCount??runtimeReceipt.admittedJobCount??0),
      executionComplete:runtimeReceipt.executionComplete==null?null:Boolean(runtimeReceipt.executionComplete),
      jobs:(runtimeData.jobs??runtimeReceipt.jobs??[]).slice(0,24).map(row=>deepFreeze({
        jobId:row.jobId??row.taskId??null,capability:row.capability??row.taskType??null,state:row.state??row.status??null,
        owner:row.owner??null,resourceId:row.resourceId??row.workerId??null,providerId:row.providerId??row.provider??null,modelId:row.modelId??row.model??null,
      })),
    });
    return deepFreeze({
      kind:'Wave13DiagnosticsCenter',selection,vectoringTrace,
      host:{connected:Boolean(operations?.hostConnected),waitingForTurn:Boolean(operations?.waitingForTurn),liveBinding:cloneSafe(liveDiagnostics),rawPromptTelemetry:false},
      pipeline:cloneSafe(operations?.pipeline??{}),
      generationInspection:cloneSafe(operations?.inspection??null),
      graph:cloneSafe(graphRead),
      producers:{active:Number(operations?.active??0),failures:Number(operations?.failures??0),stages:cloneSafe(operations?.stages??[]),inspections:cloneSafe(operations?.inspections??{})},
      runtime:{...diagnosticSource(runtimeRead),turn:runtimeTurn},coprocessor:diagnosticSource(coprocessorRead),promptPlan:diagnosticSource(promptPlanRead),
      resources:{
        source:cloneSafe(resourceRead?.source??null),capabilities:cloneSafe(resourceCaps),nativePathAvailable:resourceRead?.data?.nativePathAvailable!==false,
        lanes,rows:rows.map(row=>deepFreeze({
          id:row.id,displayName:row.displayName,kind:row.kind,state:row.state,health:row.health,availability:row.availability,connected:row.connected,callable:row.callable,
          providerId:row.providerId,providerProfileId:row.providerProfileId,modelId:row.modelId,workerId:row.workerId,measurementClass:row.measurementClass,
          physicalExecutionAttempted:Boolean(row.physicalExecutionAttempted),physicalExecutionSucceeded:Boolean(row.physicalExecutionSucceeded),ownerAccepted:row.ownerAccepted??null,ownerAcceptanceSource:row.ownerAcceptanceSource??null,
          capabilities:[...(row.capabilities??[])],currentLoad:row.currentLoad,concurrencyCapacity:row.concurrencyCapacity,reasonCode:row.reasonCode,reason:row.reason,
          lastHealthResult:row.lastHealthResult,lastHealthLatencyMs:row.lastHealthLatencyMs,lastTest:cloneSafe(row.lastTest),lastExecution:row.kind==='VECTORING'?safeVectoringExecution(row.lastExecution):cloneSafe(row.lastExecution),executionHistory:row.kind==='VECTORING'?(row.executionHistory??[]).slice(-64).map(safeVectoringExecution):[],lastFailure:cloneSafe(row.lastFailure),
        })),
      },
      cognition:{
        source:cloneSafe(cognitionRead?.source??null),errors:cloneSafe(cognitionRead?.errors??{}),jobs,scatterTelemetry:cloneSafe(scatter?.layeredTelemetry??null),jev:jev?deepFreeze({
          state:jev.state??null,outcome:jev.outcome??null,invoked:jev.invoked??null,reason:jev.reason??null,reasonCodes:[...(jev.reasonCodes??[])].slice(0,12),
          resourceId:jev.resourceId??null,provider:jev.provider??jev.providerId??null,model:jev.model??jev.modelId??null,
          serviceStatus:jev.serviceStatus??null,admission:cloneSafe(jev.admission??null),
        }):null,gather:results,seal:{sealed:Boolean(seal),admittedResultIds:[...sealedIds]},
      },
      lore:{
        source:cloneSafe(loreRead?.source??null),accepted:loreData?.entries?.length??0,learned,retrievalReady:Number(loreData?.retrievalReady??0),
        lifecycle:cloneSafe(loreData?.lifecycle??null),
      },
      memory:{
        source:cloneSafe(memoryRead?.source??null),
        counts:cloneSafe(memoryRead?.data?.counts??null),freshness:cloneSafe(memoryRead?.data?.freshness??null),
        retrievalStatus:memoryRead?.data?.retrieval?.status??null,revision:memoryRead?.data?.revision??null,
      },
      telemetry:{
        resourceEvents,
        uiLoad:this.uiLoadTrace?.snapshot?.()??null,
        nexus:cloneSafe(nexusDiagnostics?.telemetry??null),
        rawPromptTelemetry:false,
      },
      probes:cloneSafe(nexusDiagnostics?.probes??{}),
      diagnosticsSafety:cloneSafe(nexusDiagnostics?.safety??null),
      generationPerformance,
      wiring:{
        controls:{read:Boolean(resourceCaps.read),configure:Boolean(resourceCaps.configure),discoverModels:Boolean(resourceCaps.discoverModels),refreshModels:Boolean(resourceCaps.refreshModels),selectModel:Boolean(resourceCaps.selectModel),connect:Boolean(resourceCaps.connect),disconnect:Boolean(resourceCaps.disconnect),test:Boolean(resourceCaps.test),subscribe:Boolean(resourceCaps.subscribe)},
        jev:{expectedCapabilities:['SEMANTIC_JUDGMENT'],lane:lanes.find(x=>x.kind==='JEV')},
        sidecar:{expectedCapabilities:['STRUCTURED_EXTRACTION'],lane:lanes.find(x=>x.kind==='SIDECAR')},
        vectoring:{expectedCapabilities:['RETRIEVAL','EMBED','RERANK'],lane:lanes.find(x=>x.kind==='VECTORING')},
      },
    });
  }

  #generationPerformance(selection={}){
    const setter=fn(this.hostBindings,['setDetailedGenerationProfiling']),loadReader=fn(this.hostBindings,['loadDiagnostics']),detailReader=fn(this.hostBindings,['readNativeGenerationPerformance']),selectedReader=fn(this.hostBindings,['readSelectedTurnReceipt']);
    let load=null,loadError=null;
    if(loadReader)try{const value=loadReader();if(value&&typeof value.then!=='function')load=value;}catch(error){loadError=String(error?.code??error?.message??'LOAD_DIAGNOSTICS_FAILED');}
    const profiling=load?.generationProfiling??{},heapSupported=load?.heap?.supported===true,longTaskSupported=load?.longTasks?.supported===true;
    const exactSelection=Boolean(selection?.chatId&&selection?.turnId&&selection?.generationId);
    let selected=null,detailed=null,selectionError=null;
    if(exactSelection&&selectedReader)try{
      const value=selectedReader(cloneSafe(selection));
      if(value&&typeof value.then!=='function'){assertSelection(value,selection,'Generation performance selected turn');selected=value;}
    }catch(error){selectionError=String(error?.code??error?.message??'SELECTED_TURN_PERFORMANCE_READ_FAILED');}
    if(exactSelection&&detailReader)try{
      const value=detailReader(cloneSafe(selection));
      if(value&&typeof value.then!=='function'&&value!=null){assertSelection(value,selection,'Detailed generation performance');detailed=value;}
    }catch(error){selectionError=selectionError??String(error?.code??error?.message??'DETAILED_PERFORMANCE_READ_FAILED');}
    const finiteOrNull=(value)=>Number.isFinite(Number(value))?Number(value):null;
    const brainStages=(selected?.performance?.stages??[]).slice(-24).map(row=>deepFreeze({
      stage:String(row?.stage??'UNKNOWN'),wallMs:finiteOrNull(row?.wallMs),queueWaitMs:finiteOrNull(row?.queueWaitMs),
      inputCount:finiteOrNull(row?.inputCount),outputCount:finiteOrNull(row?.outputCount),inputBytes:finiteOrNull(row?.inputBytes),outputBytes:finiteOrNull(row?.outputBytes),
      retainedObjectCount:finiteOrNull(row?.retainedObjectCount),retainedBytes:finiteOrNull(row?.retainedBytes),outcome:row?.outcome==null?null:String(row.outcome),
    }));
    const retrievalChannels=(selected?.performance?.retrievalChannels??[]).slice(0,32).map(row=>deepFreeze({
      channelId:String(row?.channelId??'UNKNOWN'),status:String(row?.status??'UNKNOWN'),
      nominationCount:finiteOrNull(row?.nominationCount),attemptedIntents:finiteOrNull(row?.attemptedIntents),
      failedIntents:finiteOrNull(row?.failedIntents),elapsedMs:finiteOrNull(row?.elapsedMs),
    }));
    const safeSample=(sample)=>sample?deepFreeze({
      at:finiteOrNull(sample.at),
      heapBytes:heapSupported?finiteOrNull(sample.heapBytes):null,
      longTaskCount:longTaskSupported?finiteOrNull(sample.longTaskCount):null,
      longTaskTotalMs:longTaskSupported?finiteOrNull(sample.longTaskTotalMs):null,
      longTaskMaxMs:longTaskSupported?finiteOrNull(sample.longTaskMaxMs):null,
      diagnosticsUiRefreshCount:finiteOrNull(sample.diagnosticsUiRefreshCount),
      diagnosticsUiRefreshTotalMs:finiteOrNull(sample.diagnosticsUiRefreshTotalMs),
      diagnosticsUiRefreshMaxMs:finiteOrNull(sample.diagnosticsUiRefreshMaxMs),
      diagnosticsUiRefreshLastMs:finiteOrNull(sample.diagnosticsUiRefreshLastMs),
    }):null;
    const delta=(before,after,key,supported=true)=>supported&&Number.isFinite(Number(before?.[key]))&&Number.isFinite(Number(after?.[key]))?Number(after[key])-Number(before[key]):null;
    const phaseDelta=(before,after)=>deepFreeze({
      heapBytes:delta(before,after,'heapBytes',heapSupported),
      longTaskCount:delta(before,after,'longTaskCount',longTaskSupported),
      longTaskTotalMs:delta(before,after,'longTaskTotalMs',longTaskSupported),
      diagnosticsUiRefreshCount:delta(before,after,'diagnosticsUiRefreshCount'),
      diagnosticsUiRefreshTotalMs:delta(before,after,'diagnosticsUiRefreshTotalMs'),
    });
    const start=safeSample(detailed?.start),afterInsertion=safeSample(detailed?.afterInsertion),end=safeSample(detailed?.end);
    const safeDetailed=detailed?deepFreeze({
      kind:'NativeGenerationDetailedPerformanceProfile',
      chatId:detailed.chatId??null,turnId:detailed.turnId??null,generationId:detailed.generationId??null,correlationId:detailed.correlationId??null,
      providerLatencyMs:finiteOrNull(detailed.providerLatencyMs),start,afterInsertion,end,
      checkpointPersistence:detailed.checkpointPersistence?{status:String(detailed.checkpointPersistence.status??'UNKNOWN').slice(0,32),wallMs:finiteOrNull(detailed.checkpointPersistence.wallMs),startAt:finiteOrNull(detailed.checkpointPersistence.startAt),endAt:finiteOrNull(detailed.checkpointPersistence.endAt),heapDeltaBytes:heapSupported?finiteOrNull(detailed.checkpointPersistence.heapDeltaBytes):null}:null,
      longTasks:(Array.isArray(detailed.longTasks)?detailed.longTasks:[]).slice(-64).map(row=>({startAt:finiteOrNull(row.startAt),durationMs:finiteOrNull(row.durationMs),phase:['PRE_INSERTION','PROVIDER_WAIT_OR_LEARNING','CHECKPOINT_PERSISTENCE'].includes(row.phase)?row.phase:'UNATTRIBUTED'})),
      phases:{preGenerationToHostInsertion:phaseDelta(start,afterInsertion),hostInsertionToLearningComplete:phaseDelta(afterInsertion,end),overall:phaseDelta(start,end)},
      deltas:{
        heapBytes:heapSupported?finiteOrNull(detailed.deltas?.heapBytes):null,
        longTaskCount:longTaskSupported?finiteOrNull(detailed.deltas?.longTaskCount):null,
        longTaskTotalMs:longTaskSupported?finiteOrNull(detailed.deltas?.longTaskTotalMs):null,
        diagnosticsUiRefreshCount:finiteOrNull(detailed.deltas?.diagnosticsUiRefreshCount),
        diagnosticsUiRefreshTotalMs:finiteOrNull(detailed.deltas?.diagnosticsUiRefreshTotalMs),
      },
    }):null;
    const captureState=(profiling.captureStates??[]).find(row=>row.chatId===selection.chatId&&row.turnId===selection.turnId&&row.generationId===selection.generationId&&(!selection.correlationId||row.correlationId===selection.correlationId))??null;
    const captureReason=safeDetailed?'PROFILE_PUBLISHED':selectionError?'PROFILE_SELECTION_REJECTED':!detailReader?'PROFILE_READER_MISSING':captureState?.status==='AVAILABLE'?'PROFILE_READER_SELECTION_MISMATCH':captureState?.status==='CHECKPOINT_PENDING'?'PROFILE_CHECKPOINT_PENDING':captureState?.status==='NOT_ARMED'?'PROFILE_NOT_ARMED_AT_GENERATION':captureState?.status==='ARMED'?'PROFILE_CAPTURE_PENDING':'PROFILE_NOT_RETAINED_FOR_SELECTED_GENERATION';
    return deepFreeze({
      kind:'Wave13GenerationPerformanceDiagnostics',selection:cloneSafe(selection),
      control:{available:Boolean(setter&&loadReader&&detailReader),enabled:load?Boolean(profiling.detailedEnabled):null,sessionScoped:true,defaultOff:true,persisted:false},
      retention:{retainedProfiles:Number(profiling.retainedProfiles??load?.retained?.nativePerformance??0)||0,maxProfiles:Number(load?.bounds?.nativePerformance??0)||null},
      support:{heap:heapSupported?'SUPPORTED':'NO_EVIDENCE',longTasks:longTaskSupported?'SUPPORTED':'NO_EVIDENCE',diagnosticsUiRefresh:loadReader?'SUPPORTED':'NO_EVIDENCE'},
      exactSelection,selectionError,loadError,brainStages,retrievalChannels,detailed:safeDetailed,
      capture:{status:safeDetailed?'AVAILABLE':captureState?.status??'NO_EVIDENCE',reasonCode:captureReason,updatedAt:finiteOrNull(captureState?.updatedAt)},
      status:selectionError?'NO_EVIDENCE':safeDetailed?'DETAILED_AVAILABLE':brainStages.length?'BRAIN_TIMINGS_ONLY':'NO_EVIDENCE',
      safety:{metadataOnly:true,rawPrompts:false,storyLoreBodies:false,providerBodies:false,credentials:false,hiddenReasoning:false},
    });
  }
}

export function parseLoreSubmission({id,title,text:inputText}={}){
  const body=String(inputText??'').trim();
  if(!body){const e=new TypeError('Lore content is required.');e.code='LORE_INPUT_EMPTY';throw e;}
  let parsed;
  if(body.startsWith('{')||body.startsWith('[')){
    try{parsed=JSON.parse(body);}catch(error){const e=new TypeError('Lore JSON is invalid: '+error.message);e.code='LORE_INPUT_INVALID_JSON';throw e;}
  }else parsed={entries:[{uid:'entry-1',content:body,metadata:{title:String(title||'Lore entry')}}]};
  const book=Array.isArray(parsed)?{entries:parsed}:parsed;
  const entries=book.entries;
  if(!Array.isArray(entries)||!entries.length){const e=new TypeError('Lore submission requires a non-empty entries array.');e.code='LORE_INPUT_NO_ENTRIES';throw e;}
  const normalized=entries.map((entry,index)=>{
    const uid=text(entry?.uid??entry?.id);const content=text(entry?.content);
    if(!uid||!content){const e=new TypeError('Lore entry '+(index+1)+' requires uid and content.');e.code='LORE_INPUT_INVALID_ENTRY';throw e;}
    return{uid,content,metadata:entry.metadata&&typeof entry.metadata==='object'?cloneSafe(entry.metadata):{}};
  });
  return deepFreeze({id:text(book.id??id)??'operator-lore',title:text(book.title??title)??text(book.id??id)??'Operator Lore',metadata:book.metadata&&typeof book.metadata==='object'?cloneSafe(book.metadata):{},entries:normalized,fullSnapshot:book.fullSnapshot!==false});
}

function authoringHostFromService(service){
  if(!service||typeof service.operatorContract!=='function')return null;
  try{
    const host=service.operatorContract();
    return host?.actions&&host?.read?host:null;
  }catch{return null;}
}
function normalizeLoreAuthoringResult(raw){
  if(raw&&typeof raw==='object'&&typeof raw.ok==='boolean')return deepFreeze({ok:Boolean(raw.ok),value:cloneSafe(raw.value??null),error:cloneSafe(raw.error??null)});
  return deepFreeze({ok:true,value:cloneSafe(raw??null),error:null});
}
function normalizeLoreAuthoringFailure(error,code){
  return deepFreeze({ok:false,value:null,error:{kind:'LoreAuthoringError',code:error?.code??code,message:String(error?.message??error),safe:true,retryable:false}});
}

function operatorHostFromService(service){
  if(!service||typeof service.operatorInterface!=='function')return null;
  try{
    const host=service.operatorInterface();
    return host?.actions&&host?.read?host:null;
  }catch{return null;}
}

function normalizeLoreSurface(raw){
  const x=raw.study?.kind==='LorePublicIntegrationSurface'?raw.study:raw.kind==='LorePublicIntegrationSurface'?raw:raw.publicSurface??raw.study??raw;
  const entries=(x.entries??[]).map(row=>({
    sourceId:row.sourceId??null,lorebookId:row.lorebookId??null,uid:row.uid??null,sourceRevisionId:row.sourceRevisionId??null,sourceState:row.sourceState??null,
    exactSourceHash:row.exactSourceHash??null,exactSourceRecoverable:Boolean(row.exactSourceRecoverable),learnedRevisionId:row.learnedRevisionId??null,freshness:row.freshness??'STALE_OR_UNLEARNED',operatorState:row.operatorState??null,
    studyState:row.studyState??null,studyObligationId:row.studyObligationId??null,studyAttempts:Number(row.studyAttempts??0),studyError:cloneSafe(row.studyError??null),semanticDiff:cloneSafe(row.semanticDiff??null),
    representations:cloneSafe(row.representations??[]),representationReady:Boolean(row.representationReady),retrievalReady:Boolean(row.retrievalReady),compileFailure:cloneSafe(row.compileFailure??null),
    artifactIds:[...(row.artifactIds??[])],
    retrievalRepresentations:(row.retrievalRepresentations??[]).map(rep=>({artifactId:rep.artifactId,sourceRevisionId:rep.sourceRevisionId,authorityClass:rep.authorityClass,temporalClass:rep.temporalClass,unresolved:Boolean(rep.unresolved),provenance:cloneSafe(rep.provenance)})),
  }));
  const operatorCounts={ACCEPTED:0,STUDYING:0,READY:0,FAILED:0,REMOVED:0};
  for(const row of entries){
    const state=row.operatorState??(row.sourceState==='REMOVED'?'REMOVED':row.learnedRevisionId&&row.freshness==='CURRENT'?'READY':row.studyState==='FAILED'||row.studyState==='INVALID'?'FAILED':row.studyState?'STUDYING':'ACCEPTED');
    row.operatorState=state;if(Object.hasOwn(operatorCounts,state))operatorCounts[state]+=1;
  }
  return{
    kind:'Wave13LoreStudySurface',entries,operatorCounts:{...operatorCounts,...cloneSafe(x.counts??{})},
    artifacts:(x.artifacts??[]).map(a=>({artifactId:a.artifactId,artifactType:a.artifactType,sourceId:a.sourceId,sourceRevisionId:a.sourceRevisionId,temporalClass:a.temporalClass,authorityClass:a.authorityClass,freshness:a.freshness,unresolved:Boolean(a.unresolved),provenance:cloneSafe(a.provenance)})),
    conflicts:cloneSafe(x.conflicts??[]),lifecycle:cloneSafe(x.lifecycle??raw.lifecycle??{}),revision:raw.hierarchyRevision??raw.revision??null,
    retrievalReady:entries.filter(e=>e.operatorState==='READY'&&(e.retrievalReady||e.retrievalRepresentations.length>0)).length,
    storyAccess:cloneSafe(raw.storyAccess??null),
  };
}

function buildLoreSurfaceFromRuntime(runtime){
  const registry=runtime?.registry,store=runtime?.store;
  if(!registry||!store||typeof registry.listEntries!=='function'||typeof registry.currentRevision!=='function'||typeof store.currentLearnedRevision!=='function')throw new TypeError('LoreStudyRuntime adapter requires registry/store public read methods');
  const entries=registry.listEntries({includeRemoved:true}).map(source=>{
    const revision=registry.currentRevision(source.sourceId,{allowMissing:true});
    const learned=store.currentLearnedRevision(source.sourceId);
    const artifacts=learned&&typeof store.artifactsForLearnedRevision==='function'?store.artifactsForLearnedRevision(learned.id):[];
    const current=Boolean(revision&&learned&&learned.sourceRevisionId===revision.id&&['CURRENT','REMOVED'].includes(learned.state));
    const retrieval=artifacts.filter(a=>a.artifactType==='RETRIEVAL').map(a=>({
      artifactId:a.id,sourceRevisionId:a.sourceRevisionId,authorityClass:a.authorityClass,temporalClass:a.temporalClass,
      unresolved:Boolean(a.unresolved),provenance:cloneSafe(a.provenance),
    }));
    return{
      sourceId:source.sourceId,lorebookId:source.lorebookId,uid:source.uid,sourceRevisionId:revision?.id??null,sourceState:revision?.state??null,
      learnedRevisionId:learned?.id??null,freshness:current?(revision?.state==='REMOVED'?'REMOVED':'CURRENT'):'STALE_OR_UNLEARNED',
      artifactIds:artifacts.map(a=>a.id),retrievalRepresentations:retrieval,
    };
  });
  const obligations=typeof runtime.listObligations==='function'?runtime.listObligations():[];
  const counts={DUE:0,PENDING:0,ACTIVE:0,CHECKPOINTED:0,COMPLETED:0,SUPERSEDED:0,STALE:0,INVALID:0};
  for(const row of obligations)if(Object.hasOwn(counts,row.state))counts[row.state]+=1;
  const currentArtifacts=typeof store.currentArtifacts==='function'?store.currentArtifacts(registry):[];
  const conflicts=typeof store.conflicts==='function'?store.conflicts(registry):[];
  return{
    kind:'LorePublicIntegrationSurface',entries,
    artifacts:currentArtifacts.map(a=>({artifactId:a.id,artifactType:a.artifactType,sourceId:a.sourceId,sourceRevisionId:a.sourceRevisionId,temporalClass:a.temporalClass,authorityClass:a.authorityClass,freshness:a.freshness,unresolved:Boolean(a.unresolved),provenance:cloneSafe(a.provenance)})),
    conflicts:cloneSafe(conflicts),lifecycle:{counts,due:counts.DUE+counts.PENDING+counts.CHECKPOINTED,active:counts.ACTIVE},
    revision:store.publicationSequence??registry.sequence??null,
  };
}

async function runLoreRuntime(runtime,input={}){
  if(typeof runtime?.run!=='function')throw new TypeError('LoreStudyRuntime.run() is unavailable');
  if(input?.obligationId)return runtime.run(input.obligationId,{maxUnits:input.maxUnits??Infinity});
  const due=typeof runtime.dueObligations==='function'?runtime.dueObligations():[];
  const results=[];
  for(const obligation of due)results.push(await runtime.run(obligation.id,{maxUnits:input.maxUnits??Infinity}));
  return{kind:'LoreStudyOperatorRun',requested:due.length,results};
}

const WAVE13_CONNECTION_PROFILE_VERSION=2;
function connectionProfileRole(input={}){
  const explicit=String(input?.role??input?.resourceRole??'').toUpperCase();
  const kind=String(input?.kind??'').toUpperCase();
  const hint=[input?.resourceId,input?.id,input?.profileId,input?.providerProfileId,input?.workerId,input?.displayName,input?.connectionName]
    .filter(Boolean).map(String).join(' ');
  const sidecarSlot=/sidecar(?:[-_: ]+)b(?:\b|$)/i.test(hint)?'SIDECAR_B':/sidecar(?:[-_: ]+)a(?:\b|$)/i.test(hint)?'SIDECAR_A':null;
  if(['JEV','VECTORING'].includes(explicit))return explicit;
  if(['SIDECAR_A','SIDECAR_B'].includes(explicit))return explicit;
  if(explicit==='SIDECAR')return sidecarSlot??'SIDECAR_A';
  if(['JEV','VECTORING'].includes(kind))return kind;
  if(['SIDECAR_A','SIDECAR_B'].includes(kind))return kind;
  if(kind==='SIDECAR')return sidecarSlot??'SIDECAR_A';
  const capabilities=[...(input?.capabilities??input?.declaredCapabilities??input?.activeCapabilities??[])].map(x=>String(x).toUpperCase());
  if(capabilities.includes('SEMANTIC_JUDGMENT'))return'JEV';
  if(capabilities.some(isVectorCapability))return'VECTORING';
  return sidecarSlot??(capabilities.length?'SIDECAR_A':null);
}
function normalizePersistedConnectionProfile(input={},observed=null){
  const source=observed&&typeof observed==='object'?observed:{},role=connectionProfileRole(input)??connectionProfileRole(source);
  if(!role)return null;
  const roleLabel=role==='JEV'?'Jev':role==='VECTORING'?'Vectoring':role==='SIDECAR_B'?'Sidecar B':'Sidecar A';
  const displayName=text(source.displayName??input.displayName??input.connectionName)??roleLabel;
  const resourceIdValue=resourceId(source)??resourceId(input)??generatedResourceId(role,displayName);
  const supplied=[...(source.declaredCapabilities??source.capabilities??input.capabilities??[])].map(String).filter(Boolean);
  const defaults=role==='JEV'?['SEMANTIC_JUDGMENT']:role==='VECTORING'?['RETRIEVAL','EMBED']:['STRUCTURED_EXTRACTION'];
  const capabilities=[...new Set(supplied.length?supplied:defaults)];
  const transportRaw=String(source.transportKind??input.transportKind??input.transport??(String(input.kind??'').toUpperCase()==='DETERMINISTIC_LOCAL'?'DETERMINISTIC_LOCAL':'OPENAI_COMPATIBLE')).toUpperCase();
  const transportKind=['OPENAI_COMPATIBLE','DETERMINISTIC_LOCAL'].includes(transportRaw)?transportRaw:'OPENAI_COMPATIBLE';
  const endpoint=text(source.endpoint??input.endpoint);
  if(transportKind==='OPENAI_COMPATIBLE'&&!endpoint)return null;
  return{
    version:WAVE13_CONNECTION_PROFILE_VERSION,locked:true,role,resourceId:resourceIdValue,displayName,transportKind,endpoint:transportKind==='OPENAI_COMPATIBLE'?endpoint:null,
    modelId:text(source.modelId??input.modelId)??(transportKind==='DETERMINISTIC_LOCAL'?'local-deterministic':'model'),
    capabilities,providerProfileId:text(source.providerProfileId??input.providerProfileId)??('profile:'+resourceIdValue),
    providerId:text(source.providerId??input.providerId)??('provider:'+resourceIdValue),workerId:text(source.workerId??input.workerId)??('resource:'+resourceIdValue),
    maxConcurrency:Math.max(1,Number(source.concurrencyCapacity??source.maxConcurrency??input.maxConcurrency??input.concurrencyCapacity??1)||1),
    local:Boolean(source.local??input.local??false),
    wasConnected:Boolean(source.connected??source.callable??input.wasConnected??false)
  };
}

function normalizeResources(raw){
  const rows=Array.isArray(raw)?raw:Array.isArray(raw?.resources)?raw.resources:Array.isArray(raw?.profiles)?raw.profiles:raw&&typeof raw==='object'&&raw.resourceId?[raw]:[];
  return rows.map((row,index)=>{
    const id=resourceId(row)??'resource:'+index;
    const state=String(row.state??'').toUpperCase();
    const health=String(row.providerHealth??row.health??(state==='READY'?'HEALTHY':state||'UNAVAILABLE')).toUpperCase();
    const availability=String(row.availability??(row.callable?'AVAILABLE':'UNAVAILABLE')).toUpperCase();
    const connected=row.connected??row.mounted??['READY','DEGRADED','CONNECTING'].includes(state);
    const declared=[...(row.declaredCapabilities??row.capabilities??[])],active=[...(row.activeCapabilities??[])];
    const capabilities=active.length?active:declared;
    const role=capabilities.includes('SEMANTIC_JUDGMENT')?'JEV':capabilities.some(isVectorCapability)?'VECTORING':'SIDECAR';
    return deepFreeze({
      id,displayName:text(row.displayName??row.name)??id,kind:role,transportKind:row.kind??row.resourceKind??null,providerId:row.providerId??null,providerProfileId:row.providerProfileId??row.profileId??null,
      modelId:row.modelId??null,actualModelId:row.actualModelId??null,actualProvider:row.actualProvider??null,modelSelectionMode:row.modelSelectionMode??null,
      selectedModelQualified:Boolean(row.selectedModelQualified??row.qualification?.qualified),qualifiedAt:row.qualifiedAt??row.qualification?.qualifiedAt??null,
      qualification:cloneSafe(row.qualification??null),modelDiscovery:cloneSafe(row.modelDiscovery??null),
      physicalExecutionAttempted:Boolean(row.physicalExecutionAttempted??row.lastExecution),
      physicalExecutionSucceeded:Boolean(row.physicalExecutionSucceeded??row.lastExecution?.status==='SUCCESS'),
      ownerAccepted:typeof row.ownerAccepted==='boolean'?row.ownerAccepted:null,
      ownerAcceptanceSource:row.ownerAcceptanceSource??null,
      workerId:row.workerId??null,endpoint:text(row.endpoint),connectionProfileName:text(row.connectionProfileName),
      local:Boolean(row.local),state:state||null,health,availability,connected:Boolean(connected),
      capabilities,declaredCapabilities:declared,activeCapabilities:active,qualifiedCapabilities:[...(row.qualifiedCapabilities??[])],routableCapabilities:[...(row.routableCapabilities??[])],placements:[...(row.placements??[])],currentLoad:Number(row.currentLoad??row.activeExecutions??0),
      concurrencyCapacity:Number(row.concurrencyCapacity??row.maxConcurrency??1),measurementClass:row.measurementClass??null,reasonCode:row.reasonCode??null,reason:row.reason??null,
      lastHealthResult:row.lastHealthResult??null,lastHealthLatencyMs:row.lastHealthLatencyMs??null,lastTest:cloneSafe(row.lastTest),lastExecution:role==='VECTORING'?safeVectoringExecution(row.lastExecution):cloneSafe(row.lastExecution),executionHistory:role==='VECTORING'?(row.executionHistory??[]).slice(-64).map(safeVectoringExecution):[],lastFailure:cloneSafe(row.lastFailure),
      diagnostics:cloneSafe(row.diagnostics??[]),callable:Boolean(row.callable),credentialConfigured:Boolean(row.credentialConfigured),credentialRequired:Boolean(row.credentialRequired),lastError:row.lastFailure?.message??((state==='UNAVAILABLE'||state==='DEGRADED')?row.reason:null),
    });
  });
}

function normalizeWorker2DiscoveryConfig(input={}){
  const role=String(input.role??input.resourceRole??'SIDECAR').toUpperCase();
  const supplied=Array.isArray(input.capabilities)?input.capabilities:String(input.capabilities??'').split(',').map(x=>x.trim()).filter(Boolean);
  const defaults=role==='JEV'?['SEMANTIC_JUDGMENT']:role==='VECTORING'?['RETRIEVAL','EMBED']:['STRUCTURED_EXTRACTION'];
  const capabilities=[...new Set((supplied.length?supplied:defaults).map(String))];
  const endpoint=text(input.endpoint);if(!endpoint){const e=new TypeError('OpenAI-compatible resource requires an endpoint before model discovery.');e.code='RESOURCE_ENDPOINT_REQUIRED';throw e;}
  const out={kind:'OPENAI_COMPATIBLE',endpoint,capabilities};
  if(input.transportMode)out.transportMode=String(input.transportMode);
  const apiKey=typeof input.apiKey==='string'?input.apiKey.trim():'';if(apiKey)out.apiKey=apiKey;
  return out;
}

function normalizeWorker2ResourceConfig(input={}){
  const role=String(input.role??input.resourceRole??input.kind??'SIDECAR_A').toUpperCase();
  const roleLabel=role==='JEV'?'Jev':role==='VECTORING'?'Vectoring':role==='SIDECAR_B'?'Sidecar B':'Sidecar A';
  const displayName=text(input.displayName??input.connectionName)??roleLabel;
  const resourceIdValue=resourceId(input)??generatedResourceId(role,displayName);
  const supplied=Array.isArray(input.capabilities)?input.capabilities:String(input.capabilities??'').split(',').map(x=>x.trim()).filter(Boolean);
  const defaults=role==='JEV'?['SEMANTIC_JUDGMENT']:role==='VECTORING'?['RETRIEVAL','EMBED']:['STRUCTURED_EXTRACTION'];
  const capabilities=[...new Set((supplied.length?supplied:defaults).map(String))];
  const transport=['OPENAI_COMPATIBLE','DETERMINISTIC_LOCAL'].includes(String(input.transportKind??input.kind??'').toUpperCase())?String(input.transportKind??input.kind).toUpperCase():'OPENAI_COMPATIBLE';
  const out={
    resourceId:resourceIdValue,displayName,kind:transport,capabilities,
    providerProfileId:text(input.providerProfileId)??('profile:'+resourceIdValue),providerId:text(input.providerId)??('provider:'+resourceIdValue),
    modelId:text(input.modelId)??(transport==='DETERMINISTIC_LOCAL'?'local-deterministic':'model'),workerId:text(input.workerId)??('resource:'+resourceIdValue),
    maxConcurrency:Math.max(1,Number(input.maxConcurrency??input.concurrencyCapacity??1)||1),local:input.local!==false,
  };
  if(transport==='OPENAI_COMPATIBLE'){
    const endpoint=text(input.endpoint);if(!endpoint){const e=new TypeError('OpenAI-compatible resource requires an endpoint.');e.code='RESOURCE_ENDPOINT_REQUIRED';throw e;}out.endpoint=endpoint;
    const apiKey=typeof input.apiKey==='string'?input.apiKey.trim():'';if(apiKey)out.apiKey=apiKey;
  }
  return out;
}

function generatedResourceId(role,name){
  const prefix=String(role??'SIDECAR').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'')||'resource';
  const slug=String(name??'primary').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,64)||'primary';
  return prefix+':'+slug;
}
function isVectorCapability(value){return ['RETRIEVAL','RETRIEVAL_QUALITY','RERANK','LATE_INTERACTION','CROSS_ENCODER_RERANK','EMBED'].includes(String(value??'').toUpperCase());}
function normalizeConfiguration(row,index=0){return deepFreeze({id:text(row?.id??row?.configurationId??row?.resourceId??row?.profileId)??'config:'+index,label:text(row?.label??row?.name??row?.displayName??row?.id)??'Resource configuration',kind:text(row?.kind??row?.resourceKind)??'SIDECAR',endpoint:text(row?.endpoint),modelId:text(row?.modelId),local:Boolean(row?.local),capabilities:[...(row?.capabilities??row?.declaredCapabilities??[])]});}
function resourceId(row){return text(row?.id??row?.resourceId??row?.profileId??row?.providerProfileId??row?.workerId);}
function readerExported(x,key){return({
  choice:['readCognitiveChoice','readCognitiveChoiceReceipt'],truth:['readTruth','readTruthAssessment'],jev:['readJev','readJevDecisionReceipt'],gather:['readGather','readGatherReceipt'],seal:['readContextSeal','readContextSealReceipt','readSealReceipt'],
}[key]??[]).some(name=>typeof x?.[name]==='function');}
function safeRead(read,fallback=null){try{const value=read?.();return value==null?fallback:value;}catch{return fallback;}}
function diagnosticSource(read){
  const data=read?.data??null;
  if(!data)return deepFreeze({source:cloneSafe(read?.source??null),summary:null});
  return deepFreeze({source:cloneSafe(read?.source??null),summary:{
    kind:data.kind??null,mode:data.mode??null,state:data.state??null,totalEvents:data.totalEvents??null,
    hotActivity:data.hotActivity??null,deepActivity:data.deepActivity??null,activeTaskCount:data.activeTaskCount??null,
    queuedObligations:data.queuedObligations??null,blockedRecoveringWork:data.blockedRecoveringWork??null,activeBatches:data.activeBatches??null,
    warm:data.warm?cloneSafe(data.warm):null,fallback:data.fallback??null,staleDrop:data.staleDrop??null,retry:data.retry??null,
    lifecycleCounts:data.lifecycleCounts?cloneSafe(data.lifecycleCounts):null,queueDepth:data.queueDepth?cloneSafe(data.queueDepth):null,
    borrowedBackgroundLeases:data.resources?.borrowedBackgroundLeases??null,retainedSignals:data.telemetry?.retainedSignals??null,telemetrySinkFailures:data.telemetry?.sinkFailures??null,
    batchProgressAvailable:data.batchProgressAvailable??null,lateResultHistoryAvailable:data.lateResultHistoryAvailable??null,
    resourceTelemetry:data.resources?cloneSafe(data.resources):null,providerCalls:data.providerCalls?cloneSafe(data.providerCalls):null,eventCounts:data.eventCounts?cloneSafe(data.eventCounts):null,
    queue:data.queue?cloneSafe(data.queue):null,physicalExecution:data.physicalExecution?cloneSafe(data.physicalExecution):null,lifecycle:data.lifecycle?cloneSafe(data.lifecycle):null,
    resultDestinations:data.resultDestinations?cloneSafe(data.resultDestinations):null,ownerAcceptanceCount:Array.isArray(data.ownerAcceptance)?data.ownerAcceptance.length:null,validationFailures:data.validationFailures??null,lateResults:data.lateResults??null,
    promptPlanId:data.promptPlanId??null,totalTokens:data.totalTokens??null,budgetTotal:data.budgetTotal??null,
    segmentCount:Array.isArray(data.segments)?data.segments.length:null,droppedCount:Array.isArray(data.dropped)?data.dropped.length:null,deferredCount:Array.isArray(data.deferred)?data.deferred.length:null,
    sealedState:data.seal?.sealedState??null,
  }});
}
function generationInspectionSummary(generation,selection={}){
  if(!generation)return null;
  const meta=(value,listKeys=[])=>{
    if(!value)return null;
    const counts={};
    for(const key of listKeys){
      const row=value?.[key];
      if(Array.isArray(row))counts[key]=row.length;
      else if(row&&typeof row==='object')counts[key]=Object.keys(row).length;
      else if(Number.isFinite(Number(row)))counts[key]=Number(row);
    }
    return deepFreeze({
      kind:text(value?.kind)??null,status:text(value?.status??value?.state)??null,reasonCode:text(value?.reasonCode??value?.code??value?.reason)??null,
      scopeState:text(value?.authorityScope?.state)??null,
      counts,
    });
  };
  const rejected=generation.rejectedEvidence;
  const rejectedCount=Array.isArray(rejected)?rejected.length:Array.isArray(rejected?.items)?rejected.items.length:Number(rejected?.count??rejected?.rejectedCount??0)||0;
  return deepFreeze({
    sourceRevisionFenceCount:Array.isArray(selection?.sourceRevisionRefs)?selection.sourceRevisionRefs.length:0,
    identityResolution:meta(generation.identityResolution,['entities','resolved','unresolved','aliases']),
    graphTraversal:meta(generation.graphTraversal,['visitedNodeIds','visitedEdgeIds','paths','nodes','edges']),
    retrievalBudget:meta(generation.retrievalBudget,['admitted','deferred','dropped','candidates']),
    rejectedEvidence:rejected?deepFreeze({kind:text(rejected?.kind)??'RejectedEvidence',count:rejectedCount,reasonCode:text(rejected?.reasonCode??rejected?.code)??null}):null,
    loreSync:meta(generation.loreSync,['sourceRevisionRefs','accepted','rejected','nominationCount','boundedOutCount','rejectedCount']),
    memorySync:meta(generation.memorySync,['sourceRevisionRefs','accepted','rejected']),
    rawPromptIncluded:false,
    rawEvidenceIncluded:false,
  });
}

function humanInspectionLabel(value){return String(value??'Producer').replace(/([a-z])([A-Z])/g,'$1 $2').replace(/[_-]+/g,' ').replace(/\b\w/g,m=>m.toUpperCase());}
function producerInspection(id,label,payload,selection,{stage=null,error=null,reason=null}={}){
  const available=payload!=null;
  const unavailableReason=String(reason??'No owner receipt was published for the selected turn.');
  const receiptRef=available?(payload.receiptId??payload.sealId??payload.promptPlanId??payload.id??payload.kind??null):null;
  const availabilityState=inspectionAvailability(stage,error,available);
  const safeError=error?safeInspectionPayload(error):null;
  return deepFreeze({
    kind:'wave13-producer-inspection',id:'producer:'+id+':'+String(selection?.turnId??'no-turn'),producerId:id,title:label+' detail',
    available,availabilityState,receiptRef,selection:cloneSafe(selection),error:safeError,
    reason:available?'Published owner read model / receipt for the selected turn.':unavailableReason,
    payload:available?safeInspectionPayload(payload):{
      kind:'ProducerInspectionState',status:availabilityState,reason:unavailableReason,code:error?.code??stage?.errorCode??null,
      chatId:selection?.chatId??null,turnId:selection?.turnId??null,generationId:selection?.generationId??null,
      error:safeError,
    },
  });
}
function inspectionAvailability(stage,error,available){
  if(available)return'RECEIPT_AVAILABLE';
  const code=String(error?.code??stage?.errorCode??'').toUpperCase();
  if(['LIVE_RECEIPT_STALE','LIVE_RECEIPT_FUTURE','LIVE_RECEIPT_IDENTITY_MISMATCH'].includes(code))return'STALE_OR_FOREIGN_RECEIPT';
  if([OperatorProducerState.WORKING,OperatorProducerState.WAITING_FOR_TURN].includes(stage?.state))return'PENDING';
  if(stage?.state===OperatorProducerState.DEGRADED)return'PRODUCER_ERROR';
  if(stage?.state===OperatorProducerState.IDLE)return'NO_SELECTED_TURN_EVIDENCE';
  if(stage?.state===OperatorProducerState.DISCONNECTED)return'NOT_CONFIGURED';
  return'UNAVAILABLE';
}
function safeInspectionPayload(value,depth=0){
  if(value==null||typeof value==='number'||typeof value==='boolean')return value;
  if(typeof value==='string')return value.length>600?value.slice(0,600)+'…':value;
  if(depth>=6)return'[nested metadata omitted]';
  if(Array.isArray(value))return value.slice(0,24).map(row=>safeInspectionPayload(row,depth+1));
  if(typeof value!=='object')return String(value);
  const out={},entries=Object.entries(value).slice(0,64);
  for(const [key,row] of entries){
    const normalized=String(key).toLowerCase().replace(/[^a-z0-9]/g,'');
    const sensitive=['text','content','body','prompt','rawprompt','rawpayload','messages','story','storytext','lorebody','hiddenreasoning','reasoning','chainofthought','contexttext'].includes(normalized)
      ||/apikey|credential|authorization|secret|bearertoken/.test(normalized);
    out[key]=sensitive?'[omitted from UI evidence]':safeInspectionPayload(row,depth+1);
  }
  if(Object.keys(value).length>entries.length)out.__truncated=Object.keys(value).length-entries.length;
  return out;
}
function stageFromSource(id,label,source,selection,{readerPresent=false,reason=null}={}){
  if(!source)return stage(id,label,readerPresent?OperatorProducerState.IDLE:OperatorProducerState.UNAVAILABLE,reason??(readerPresent?'No current owner data.':'Producer not connected.'),selection,null,readerPresent?'NO_DATA':'ASSEMBLY_CONTRACT_MISSING');
  const explicit=source.operationalState;if(explicit&&Object.values(OperatorProducerState).includes(explicit))return stage(id,label,explicit,reason??source.impact??source.reason,selection,source.freshness,source.errorCode??null,source);
  if(source.mode===ProductDataMode.DEGRADED||[Wave6Health.DEGRADED,Wave6Health.STALE,Wave6Health.BLOCKED].includes(source.health))return stage(id,label,OperatorProducerState.DEGRADED,reason??source.impact??source.reason,selection,source.freshness,source.errorCode??null,source);
  if(source.mode===ProductDataMode.UNAVAILABLE)return stage(id,label,readerPresent?OperatorProducerState.IDLE:OperatorProducerState.UNAVAILABLE,reason??source.reason??source.impact,selection,source.freshness,source.errorCode??null,source);
  if(source.health===Wave6Health.WORKING)return stage(id,label,OperatorProducerState.WORKING,reason??source.impact,selection,source.freshness,null,source);
  if(source.health===Wave6Health.IDLE)return stage(id,label,OperatorProducerState.IDLE,reason??source.impact,selection,source.freshness,null,source);
  return stage(id,label,OperatorProducerState.LIVE,reason??source.impact??'Current owner state available.',selection,source.freshness,null,source);
}
function stage(id,label,stateValue,reason,selection,freshness,errorCode,source=null){return deepFreeze({id,label,state:stateValue,reason:String(reason??''),chatId:selection?.chatId??null,turnId:selection?.turnId??null,generationId:selection?.generationId??null,freshness:freshness??null,errorCode:errorCode??null,producer:source?.producer??null});}
function unavailable(label,reason,producer){return deepFreeze({source:createProductSourceStatus({mode:ProductDataMode.UNAVAILABLE,health:Wave6Health.UNAVAILABLE,label,operationalState:OperatorProducerState.UNAVAILABLE,impact:label+' is unavailable.',reason,producer,connected:false}),data:null});}
function waiting(label,reason,producer,selection){return deepFreeze({source:createProductSourceStatus({mode:ProductDataMode.LIVE,health:Wave6Health.IDLE,label,operationalState:OperatorProducerState.WAITING_FOR_TURN,impact:reason,producer,connected:true,selection}),data:null});}
function idle(label,reason,producer,selection){return deepFreeze({source:createProductSourceStatus({mode:ProductDataMode.LIVE,health:Wave6Health.IDLE,label,operationalState:OperatorProducerState.IDLE,impact:reason,producer,connected:true,selection}),data:null});}
function degraded(label,impact,producer,selection,error,data=null){return deepFreeze({source:createProductSourceStatus({mode:ProductDataMode.DEGRADED,health:Wave6Health.DEGRADED,label,operationalState:OperatorProducerState.DEGRADED,impact,reason:String(error?.message??error??''),producer,connected:true,selection,errorCode:error?.code??'READ_ERROR'}),data:cloneSafe(data)});}
function isIntentionalJevSkip(raw){
  const values=[raw?.reasonCode,raw?.decisionCode,raw?.serviceStatus,raw?.state,raw?.outcome,...(Array.isArray(raw?.reasonCodes)?raw.reasonCodes:[])];
  const codes=values.filter(Boolean).map(value=>String(value).toUpperCase());
  return codes.includes('JEV_NOT_REQUIRED')||codes.includes('JEV_SKIPPED')||codes.includes('SKIPPED');
}
function reasonOf(raw){return Array.isArray(raw?.health?.reasons)?raw.health.reasons.join(', '):text(raw?.reason??raw?.error??'')??'';}
function revisionOf(raw){return raw?.revision??raw?.receiptRevision??raw?.sourceRevisionId??raw?.learnedRevisionId??null;}
function freshnessOf(raw){return raw?.freshness??raw?.revisionFence?.freshness??null;}
function assertSelection(raw,selection,label,{allowMissingIdentity=false}={}){
  const x=raw?.data??raw??{};
  for(const key of ['chatId','turnId','generationId','correlationId']){
    const expected=selection?.[key],actual=x?.[key]??x?.metadata?.[key];
    if(expected==null||actual==null){if(!allowMissingIdentity&&expected!=null&&actual==null)continue;else continue;}
    if(String(expected)!==String(actual)){const e=new Error(label+' belongs to '+key+' '+actual+', not selected '+expected);e.code='LIVE_RECEIPT_IDENTITY_MISMATCH';throw e;}
  }
}
