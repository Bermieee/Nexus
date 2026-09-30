import { markNexusRenderingSurface } from '../../core/rendering-policy.js';
import { createWave6ProductInterface } from './wave6-runtime.js';
import { HostAdjacentMountAdapter } from './wave6-presentation.js';
import { normalizeLiveSelection } from './wave11-live-bindings.js';

export const WAVE12_SILLYTAVERN_HOST_VERSION='1.0.0';
export const WAVE12_SILLYTAVERN_CHAT_SELECTOR='#sheld';

const HOST_EVENT_KEYS=Object.freeze([
  'CHAT_CHANGED','CHAT_LOADED','CHAT_CREATED','CHAT_RENAMED',
  'MESSAGE_SENT','MESSAGE_RECEIVED','MESSAGE_EDITED','MESSAGE_DELETED','MESSAGE_UPDATED','MESSAGE_SWIPED','MESSAGE_SWIPE_DELETED',
  'GENERATION_STARTED','GENERATION_STOPPED','GENERATION_ENDED',
  'WORLDINFO_UPDATED','WORLDINFO_SETTINGS_UPDATED',
]);

const OWNER_BINDING_KEYS=Object.freeze([
  'readScene','readSceneModel','readSceneUiReadModel',
  'runtimeAdapter','coprocessorTelemetry','coprocessorAdapter',
  'readPromptPlan','readPromptPlanReadModel','readContextReceipt','readContextReceiptReadModel',
  'readContextSeal','readContextSealReceipt','readSealReceipt','readIntegrityReceipt','readGeneration','listGenerations','readSelectedTurnReceipt','readNativeBrainHostLifecycle','readHostDeliveryReceipt',
  'readNativeGenerationPerformance','setDetailedGenerationProfiling','loadDiagnostics','readSceneObservationReceipts','readSceneObservationRuntime',
  'readForensic','readForensicReadModel','listForensics','listForensicReadModels','listBundles',
  'listTransactions','listCognitiveTransactions','readTransaction','readCognitiveTransaction',
  'reconstructGeneration','reconstructTransaction','readRuntimeWork','readKnowledgeTrace',
  'readLazyForensicPayload','readLazyPayload','searchForensics','search',
  'readHotCognition','readHotCognitionReadModel','readCognitiveChoice','readCognitiveChoiceReceipt',
  'readScatter','readScatterReceipt','readRuntimeTurn','readSensoryTrace','readCandidateBusEnvelope','readCandidateFusionReceipt',
  'readIdentityResolution','readGraphTraversal','readRetrievalBudget','readRejectedEvidence',
  'readTruth','readTruthAssessment','readCorrectiveRetrieval','readCorrectiveRetrievalReceipt',
  'readJev','readJevDecisionReceipt','readPrecision','readPrecisionReceipt','readGather','readGatherReceipt','readLoreStatus','readLoreStudyStatus','readLoreStudySurface','readMemoryStatus',
  'readRuntimeStatus','readDiagnosticsTelemetry','readCognitionUiState','readCoprocessorChoiceContribution',
  'resourceHost','coprocessorResourceHost','resourceConnectionsHost',
  'listResources','listResourceProfiles','listCapabilityProfiles','readResourceStatus','listResourceConfigurations','listAvailableResources',
  'addResource','configureResource','discoverModels','loadModels','listProviderModels','refreshModels','refreshResourceModels','setCredential','setResourceCredential','clearCredential','clearResourceCredential','revokeCredential','revokeResourceCredential','selectModel','selectResourceModel','connectResource','mountResource','disconnectResource','unmountResource','testResource','probeResource','testConnection','subscribeResources','subscribeResourceStatus',
  'loreIntelligenceService','loreStudyService','loreOperatorHost','loreStudyHost','loreHost','loreStudyRuntime','loreRuntime',
  'loreAuthoringService','loreAuthoringHost','loreAuthoringOperator',
  'memoryIntegrationSurface','memoryInterface','memoryOwner','readMemory','readMemoryReadModel','readMemoryRetrieval','readMemorySummaryStatus','readMemoryVectorReceipts',
  'acceptLorebook','submitLorebook','enqueueLorebook','ingestLorebook','runLoreStudy','startLoreStudy','runDueLoreStudy','retryLoreStudy','subscribeLoreStudy','subscribeLoreStatus',
  'story','characters','lore','memory','world','knowledgeAdapter',
]);

const FAMILY_KEYS=Object.freeze({
  scene:['readScene','readSceneModel','readSceneUiReadModel'],
  hotCognition:['readHotCognition','readHotCognitionReadModel'],
  cognitiveChoice:['readCognitiveChoice','readCognitiveChoiceReceipt'],
  runtimeScatter:['readScatter','readScatterReceipt','readRuntimeTurn'],
  sensory:['readSensoryTrace','readCandidateBusEnvelope','readCandidateFusionReceipt'],
  identityResolution:['readIdentityResolution'],
  graphTraversal:['readGraphTraversal'],
  retrievalBudget:['readRetrievalBudget'],
  rejectedEvidence:['readRejectedEvidence'],
  truth:['readTruth','readTruthAssessment'],
  correctiveRetrieval:['readCorrectiveRetrieval','readCorrectiveRetrievalReceipt'],
  jev:['readJev','readJevDecisionReceipt'],
  precision:['readPrecision','readPrecisionReceipt'],
  gather:['readGather','readGatherReceipt'],
  contextSeal:['readContextSeal','readContextSealReceipt','readSealReceipt'],
  promptPlan:['readPromptPlan','readPromptPlanReadModel'],
  contextReceipt:['readContextReceipt','readContextReceiptReadModel'],
  forensics:['readForensic','readForensicReadModel','listForensics','listForensicReadModels','listBundles'],
  transactions:['listTransactions','listCognitiveTransactions','readTransaction','readCognitiveTransaction'],
  loreStatus:['readLoreStatus','readLoreStudyStatus','readLoreStudySurface','loreIntelligenceService','loreStudyService','loreOperatorHost','loreStudyHost','loreHost','loreStudyRuntime','loreRuntime'],
  loreActions:['acceptLorebook','submitLorebook','enqueueLorebook','ingestLorebook','runLoreStudy','startLoreStudy','loreIntelligenceService','loreStudyService','loreOperatorHost','loreStudyHost','loreHost','loreStudyRuntime','loreRuntime'],
  runtime:['runtimeAdapter','readRuntimeStatus','readScatter','readRuntimeTurn'],
  coprocessor:['coprocessorTelemetry','coprocessorAdapter','readCognitionUiState','readCoprocessorChoiceContribution'],
  resources:['resourceHost','coprocessorResourceHost','resourceConnectionsHost','listResources','listResourceProfiles','listCapabilityProfiles','readResourceStatus'],
  resourceActions:['resourceHost','coprocessorResourceHost','resourceConnectionsHost','addResource','configureResource','discoverModels','loadModels','listProviderModels','refreshModels','refreshResourceModels','setCredential','setResourceCredential','clearCredential','clearResourceCredential','revokeCredential','revokeResourceCredential','selectModel','selectResourceModel','connectResource','mountResource','disconnectResource','unmountResource','testResource','probeResource','testConnection'],
  memory:['memory','memoryIntegrationSurface','memoryInterface','memoryOwner','readMemoryStatus','readMemory','readMemoryReadModel','readMemoryRetrieval','readMemorySummaryStatus'],
});

export class SillyTavernHostUnavailableError extends Error{
  constructor(code,message){super(message);this.name='SillyTavernHostUnavailableError';this.code=code;}
}

export class SillyTavernSelectionBridge{
  constructor({getContext,ownerBindings={}}={}){
    if(typeof getContext!=='function')throw new TypeError('SillyTavern selection bridge requires getContext()');
    this.getContext=getContext;
    this.ownerBindings=ownerBindings&&typeof ownerBindings==='object'?ownerBindings:{};
    this.ownerReadSelection=firstFunction(this.ownerBindings,['readSelection','readCurrentSelection','readCurrentTurn']);
    this.ownerSubscribe=firstFunction(this.ownerBindings,['subscribe','subscribeReceipts','subscribeHost']);
    this.listeners=new Set();
    this.hostReleases=[];
    this.ownerRelease=null;
    this.wired=false;
    this.destroyed=false;
    this.eventCount=0;
    this.lastHostEvent=null;
    this.chatMismatchDrops=0;
  }

  readSelection(){
    const context=this.#context();
    const hostChatId=cleanText(context?.chatId??safeCall(context?.getCurrentChatId));
    const ownerRaw=this.ownerReadSelection?.({chatId:hostChatId})??{};
    const owner=normalizeLiveSelection(ownerRaw);
    if(hostChatId&&owner.chatId&&hostChatId!==owner.chatId){
      this.chatMismatchDrops+=1;
      return normalizeLiveSelection({chatId:hostChatId});
    }
    return normalizeLiveSelection({...owner,chatId:hostChatId??owner.chatId});
  }

  subscribe(listener){
    if(typeof listener!=='function')throw new TypeError('SillyTavern selection subscriber must be a function');
    if(this.destroyed)return()=>{};
    this.listeners.add(listener);
    if(!this.wired)this.#wire();
    let active=true;
    return()=>{
      if(!active)return;active=false;this.listeners.delete(listener);
      if(!this.listeners.size)this.#unwire();
    };
  }

  diagnostics(){
    let selection=null;
    try{selection=this.readSelection();}catch{}
    return Object.freeze({
      kind:'Wave12SillyTavernSelectionDiagnostics',
      contractVersion:WAVE12_SILLYTAVERN_HOST_VERSION,
      selection,
      compositeSubscribers:this.listeners.size,
      hostEventListeners:this.hostReleases.length,
      ownerSubscription:Boolean(this.ownerRelease),
      eventCount:this.eventCount,
      lastHostEvent:this.lastHostEvent,
      chatMismatchDrops:this.chatMismatchDrops,
      polling:false,
      rawPromptTelemetry:false,
    });
  }

  destroy(){
    if(this.destroyed)return;
    this.destroyed=true;
    this.listeners.clear();
    this.#unwire();
  }

  #context(){
    const context=this.getContext();
    if(!context||typeof context!=='object')throw new SillyTavernHostUnavailableError('SILLYTAVERN_CONTEXT_UNAVAILABLE','SillyTavern getContext() did not return a host context');
    return context;
  }

  #wire(){
    if(this.wired||this.destroyed)return;
    this.wired=true;
    const context=this.#context();
    const eventSource=context.eventSource;
    const eventTypes=context.eventTypes??context.event_types??{};
    if(eventSource&&typeof eventSource.on==='function'&&typeof eventSource.removeListener==='function'){
      for(const key of HOST_EVENT_KEYS){
        const eventName=eventTypes?.[key];
        if(!eventName)continue;
        const handler=()=>{
          this.eventCount+=1;this.lastHostEvent=key;
          this.#emit({kind:'SILLYTAVERN_CONTEXT_CHANGED',hostEvent:key});
        };
        eventSource.on(eventName,handler);
        this.hostReleases.push(()=>eventSource.removeListener(eventName,handler));
      }
    }
    if(this.ownerSubscribe){
      const release=this.ownerSubscribe((event)=>{
        this.eventCount+=1;this.lastHostEvent='NEXUS_RECEIPT_UPDATED';
        this.#emit({kind:'NEXUS_RECEIPT_UPDATED',stage:cleanText(event?.stage??event?.kind)});
      });
      this.ownerRelease=typeof release==='function'?release:()=>{};
    }
  }

  #unwire(){
    for(const release of this.hostReleases.splice(0))try{release();}catch{}
    if(this.ownerRelease){try{this.ownerRelease();}catch{}this.ownerRelease=null;}
    this.wired=false;
  }

  #emit(meta){
    let selection;
    try{selection=this.readSelection();}
    catch(error){
      selection=normalizeLiveSelection({});
      meta={...meta,errorCode:error?.code??'HOST_SELECTION_READ_FAILED'};
    }
    const event=Object.freeze({...meta,selection});
    for(const listener of [...this.listeners])try{listener(event);}catch{}
  }
}

export class SillyTavernAdjacentLayoutReservation{
  constructor({chatRoot,mountRoot,manageMountPosition=true,reserveWidth=null,releaseWidth=null,onModeChange=null,allowOverflow=false}={}){
    if(!chatRoot||!mountRoot)throw new TypeError('SillyTavern adjacent layout requires chatRoot and mountRoot');
    this.chatRoot=chatRoot;this.mountRoot=mountRoot;this.manageMountPosition=Boolean(manageMountPosition);
    this.reserveWidthCallback=typeof reserveWidth==='function'?reserveWidth:null;
    this.releaseWidthCallback=typeof releaseWidth==='function'?releaseWidth:null;
    this.onModeChange=typeof onModeChange==='function'?onModeChange:null;this.allowOverflow=Boolean(allowOverflow);
    this.width=0;this.released=false;
    this.chatStyle=snapshotStyle(chatRoot,['right']);
    this.mountStyle=snapshotStyle(mountRoot,['position','top','height','maxHeight','left','right','width','maxWidth','zIndex','overflow']);
  }

  reserve(width){
    if(this.released)return 0;
    const next=Math.max(0,Math.round(Number(width)||0));
    this.width=next;
    if(this.reserveWidthCallback)this.reserveWidthCallback(next);
    else setStyle(this.chatRoot,'right',next?next+'px':this.chatStyle.right);
    setStyle(this.mountRoot,'width',next+'px');
    setStyle(this.mountRoot,'maxWidth','calc(100dvw - 16px)');
    if(this.manageMountPosition){
      setStyle(this.mountRoot,'position','fixed');
      setStyle(this.mountRoot,'top','var(--topBarBlockSize, 0px)');
      setStyle(this.mountRoot,'height','calc(100dvh - var(--topBarBlockSize, 0px))');
      setStyle(this.mountRoot,'maxHeight','calc(100dvh - var(--topBarBlockSize, 0px))');
      setStyle(this.mountRoot,'left',`max(8px, calc(50dvw + (var(--sheldWidth) / 2) - ${next/2}px))`);
      setStyle(this.mountRoot,'right','auto');
      setStyle(this.mountRoot,'zIndex','31');
      setStyle(this.mountRoot,'overflow',this.allowOverflow?'visible':'hidden');
    }
    return next;
  }

  modeChanged(change){this.onModeChange?.(change);}

  release(){
    if(this.released)return;
    this.released=true;
    if(this.releaseWidthCallback)this.releaseWidthCallback(this.width);
    restoreStyle(this.chatRoot,this.chatStyle);
    restoreStyle(this.mountRoot,this.mountStyle);
    this.width=0;
  }

  destroy(){this.release();}
}

export class Wave12SillyTavernHostAdapter{
  constructor({
    getContext=null,
    sillyTavern=null,
    document=null,
    hostBindings={},
    mountRoot=null,
    mountRootSelector=null,
    chatRoot=null,
    stateStore=undefined,
    bridges={},
    productName='Nexus',
    productTagline='Cognitive Story System',
    rootId='nexus-ui-core-host',
    layout={},
    floatingNavigation=true,
    viewportProvider=null,
  }={}){
    this.document=document??globalThis.document??null;
    this.getContext=resolveGetContext(getContext,sillyTavern);
    this.ownerBindings=hostBindings&&typeof hostBindings==='object'?hostBindings:{};
    this.providedMountRoot=mountRoot;
    this.mountRootSelector=mountRootSelector;
    this.providedChatRoot=chatRoot;
    this.stateStore=stateStore;
    this.bridges=bridges??{};
    this.productName=productName;
    this.productTagline=productTagline;
    this.rootId=rootId;
    this.layoutOptions=layout??{};this.floatingNavigation=Boolean(floatingNavigation);this.viewportProvider=viewportProvider;
    this.ui=null;this.selectionBridge=null;this.layoutReservation=null;this.mountRoot=null;this.chatRoot=null;
    this.ownsMountRoot=false;this.usesBodyFallback=false;this.mountCount=0;this.destroyCount=0;this.lastError=null;
  }

  mount(){
    if(this.ui)return this;
    if(!this.document)throw new SillyTavernHostUnavailableError('SILLYTAVERN_DOCUMENT_UNAVAILABLE','SillyTavern document is unavailable');
    if(typeof this.getContext!=='function')throw new SillyTavernHostUnavailableError('SILLYTAVERN_API_UNAVAILABLE','SillyTavern.getContext() is unavailable');
    try{
      const context=this.getContext();
      if(!context||typeof context!=='object')throw new SillyTavernHostUnavailableError('SILLYTAVERN_CONTEXT_UNAVAILABLE','SillyTavern.getContext() did not return a host context');
      this.chatRoot=this.providedChatRoot??this.document.querySelector?.(WAVE12_SILLYTAVERN_CHAT_SELECTOR)??null;
      this.usesBodyFallback=false;
      if(!this.chatRoot&&this.floatingNavigation){
        this.chatRoot=this.document.body??this.document.documentElement??null;
        this.usesBodyFallback=Boolean(this.chatRoot);
      }
      if(!this.chatRoot)throw new SillyTavernHostUnavailableError('SILLYTAVERN_CHAT_ROOT_UNAVAILABLE','SillyTavern host surface is unavailable');
      const resolved=this.#resolveMountRoot();
      this.mountRoot=markNexusRenderingSurface(resolved.root);this.ownsMountRoot=resolved.owned;
      this.layoutReservation=new SillyTavernAdjacentLayoutReservation({
        chatRoot:this.chatRoot,
        mountRoot:this.mountRoot,
        manageMountPosition:this.ownsMountRoot,
        reserveWidth:this.layoutOptions.reserveWidth,
        releaseWidth:this.layoutOptions.releaseWidth,
        onModeChange:this.layoutOptions.onModeChange,
        allowOverflow:this.floatingNavigation,
      });
      const hostMountAdapter=new HostAdjacentMountAdapter({
        reserveWidth:(width)=>this.layoutReservation.reserve(width),
        releaseWidth:()=>this.layoutReservation.release(),
        onModeChange:(change)=>this.layoutReservation.modeChanged(change),
        fixedReservationWidth:this.floatingNavigation?0:null,
      });
      this.selectionBridge=new SillyTavernSelectionBridge({getContext:this.getContext,ownerBindings:this.ownerBindings});
      const liveBindings={
        ...pickOwnerBindings(this.ownerBindings),
        readSelection:()=>this.selectionBridge.readSelection(),
        readSelectedLorebookSelection:()=>readSelectedSillyTavernLorebookSelection(this.document),
        discoverSelectedLorebook:()=>discoverSelectedSillyTavernLorebook({document:this.document,getContext:this.getContext}),
        subscribe:(listener)=>this.selectionBridge.subscribe(listener),
      };
      this.ui=createWave6ProductInterface({
        root:this.mountRoot,
        stateStore:this.stateStore,
        bridges:this.bridges,
        productName:this.productName,
        productTagline:this.productTagline,
        hostMountAdapter,
        hostBindings:liveBindings,
        floatingNavigation:this.floatingNavigation,
        viewportProvider:this.viewportProvider,
      });
      if(this.floatingNavigation)this.mountRoot.classList?.add?.('nexus-wave13-host');
      this.mountCount+=1;this.lastError=null;
      return this;
    }catch(error){
      this.lastError={code:error?.code??'WAVE12_HOST_MOUNT_FAILED',message:String(error?.message??error)};
      this.#cleanupAfterFailure();
      throw error;
    }
  }

  remount(){
    this.destroy();
    return this.mount();
  }

  destroy(){
    if(!this.ui&&!this.selectionBridge&&!this.layoutReservation&&!this.mountRoot)return;
    try{this.ui?.destroy?.();}finally{
      this.ui=null;
      this.selectionBridge?.destroy?.();this.selectionBridge=null;
      this.layoutReservation?.destroy?.();this.layoutReservation=null;
      if(this.ownsMountRoot)removeNode(this.mountRoot);
      else this.mountRoot?.replaceChildren?.();
      this.mountRoot=null;this.chatRoot=null;this.ownsMountRoot=false;this.usesBodyFallback=false;this.destroyCount+=1;
    }
  }

  diagnostics(){
    return Object.freeze({
      kind:'Wave12SillyTavernHostDiagnostics',
      contractVersion:WAVE12_SILLYTAVERN_HOST_VERSION,
      mounted:Boolean(this.ui),
      mountCount:this.mountCount,
      destroyCount:this.destroyCount,
      ownsMountRoot:this.ownsMountRoot,
      chatSelector:WAVE12_SILLYTAVERN_CHAT_SELECTOR,
      selection:this.selectionBridge?.diagnostics?.()??null,
      producers:producerAvailability(this.ownerBindings),
      lastError:this.lastError,
      polling:false,
      duplicateChat:false,
      readOnlyOwnerReceipts:true,
      floatingNavigation:this.floatingNavigation,
      bodyFallback:this.usesBodyFallback,
      floating:this.ui?.floatingController?.diagnostics?.()??null,
    });
  }

  #resolveMountRoot(){
    if(this.providedMountRoot)return{root:this.providedMountRoot,owned:false};
    if(this.mountRootSelector){
      const found=this.document.querySelector?.(this.mountRootSelector);
      if(found)return{root:found,owned:false};
    }
    const existing=this.document.getElementById?.(this.rootId);
    if(existing)return{root:existing,owned:false};
    const root=this.document.createElement?.('aside');
    if(!root)throw new SillyTavernHostUnavailableError('SILLYTAVERN_MOUNT_ROOT_UNAVAILABLE','Unable to create Nexus host root');
    root.id=this.rootId;root.className='nexus-wave12-host-root';
    root.setAttribute?.('aria-label',this.productName+' host-adjacent cognitive interface');
    root.setAttribute?.('data-nexus-host-adapter','wave12');
    if(this.usesBodyFallback){
      const body=this.document.body??this.document.documentElement;
      if(!body)throw new SillyTavernHostUnavailableError('SILLYTAVERN_MOUNT_PARENT_UNAVAILABLE','Unable to locate a document surface for Nexus floating navigation');
      body.append?.(root);
      return{root,owned:true};
    }
    const parent=this.chatRoot.parentNode??this.document.body;
    if(!parent)throw new SillyTavernHostUnavailableError('SILLYTAVERN_MOUNT_PARENT_UNAVAILABLE','Unable to locate a host parent beside #sheld');
    if(typeof parent.insertBefore==='function'&&this.chatRoot.nextSibling)parent.insertBefore(root,this.chatRoot.nextSibling);
    else parent.append?.(root);
    return{root,owned:true};
  }

  #cleanupAfterFailure(){
    try{this.ui?.destroy?.();}catch{}this.ui=null;
    try{this.selectionBridge?.destroy?.();}catch{}this.selectionBridge=null;
    try{this.layoutReservation?.destroy?.();}catch{}this.layoutReservation=null;
    if(this.ownsMountRoot)removeNode(this.mountRoot);
    this.mountRoot=null;this.chatRoot=null;this.ownsMountRoot=false;
  }
}

export function createWave12SillyTavernHostAdapter(options){return new Wave12SillyTavernHostAdapter(options);}
export function mountWave12SillyTavernInterface(options){return new Wave12SillyTavernHostAdapter(options).mount();}

export function createWave12SillyTavernHostBindings({getContext,hostBindings={}}={}){
  const bridge=new SillyTavernSelectionBridge({getContext,ownerBindings:hostBindings});
  return{
    bridge,
    hostBindings:{
      ...pickOwnerBindings(hostBindings),
      readSelection:()=>bridge.readSelection(),
      readSelectedLorebookSelection:()=>readSelectedSillyTavernLorebookSelection(globalThis.document??null),
      discoverSelectedLorebook:()=>discoverSelectedSillyTavernLorebook({document:globalThis.document??null,getContext}),
      subscribe:(listener)=>bridge.subscribe(listener),
    },
    destroy:()=>bridge.destroy(),
  };
}

export function readSelectedSillyTavernLorebookSelection(document=globalThis.document??null){
  const select=document?.querySelector?.('#world_editor_select')??document?.getElementById?.('world_editor_select')??null;
  if(!select)return Object.freeze({kind:'SillyTavernLorebookSelection',selected:false,lorebookId:null,title:null,reason:'SillyTavern World Info editor selection is unavailable.'});
  const options=Array.from(select.options??select.children??[]),selected=select.selectedOptions?.[0]??options.find(row=>row?.selected)??options[Number(select.value)]??null;
  const title=cleanText(selected?.textContent??selected?.text??selected?.label);
  if(!title||title==='--- None ---')return Object.freeze({kind:'SillyTavernLorebookSelection',selected:false,lorebookId:null,title:null,reason:'No Lorebook is selected in SillyTavern.'});
  return Object.freeze({kind:'SillyTavernLorebookSelection',selected:true,lorebookId:title,title,entryCount:null,source:'SILLYTAVERN_WORLD_INFO_EDITOR'});
}

export async function discoverSelectedSillyTavernLorebook({document=globalThis.document??null,getContext}={}){
  const selection=readSelectedSillyTavernLorebookSelection(document);
  if(!selection.selected){const error=new SillyTavernHostUnavailableError('SILLYTAVERN_LOREBOOK_NOT_SELECTED',selection.reason);throw error;}
  const context=typeof getContext==='function'?getContext():null;
  if(!context||typeof context.loadWorldInfo!=='function')throw new SillyTavernHostUnavailableError('SILLYTAVERN_LOREBOOK_API_UNAVAILABLE','SillyTavern loadWorldInfo() is unavailable to the extension host.');
  const raw=await context.loadWorldInfo(selection.lorebookId);
  if(!raw||typeof raw!=='object')throw new SillyTavernHostUnavailableError('SILLYTAVERN_LOREBOOK_LOAD_FAILED','SillyTavern did not return the selected Lorebook.');
  const rows=Array.isArray(raw.entries)?raw.entries:Object.entries(raw.entries??{}).map(([key,value])=>({...(value??{}),uid:value?.uid??key}));
  const entries=rows.map((entry,index)=>{
    const uid=cleanText(entry?.uid??entry?.id);if(!uid)throw new SillyTavernHostUnavailableError('SILLYTAVERN_LOREBOOK_UID_MISSING','Selected Lorebook entry '+String(index+1)+' has no SillyTavern UID.');
    if(typeof entry?.content!=='string')throw new SillyTavernHostUnavailableError('SILLYTAVERN_LOREBOOK_CONTENT_INVALID','Selected Lorebook entry '+uid+' has no authored text content.');
    return{
      uid,content:entry.content,
      metadata:{
        title:cleanText(entry.comment??entry.name??entry.title),
        keys:Array.isArray(entry.key)?[...entry.key]:[],
        secondaryKeys:Array.isArray(entry.keysecondary)?[...entry.keysecondary]:[],
        constant:Boolean(entry.constant),selective:Boolean(entry.selective),disabled:Boolean(entry.disable),
        order:Number.isFinite(Number(entry.order))?Number(entry.order):null,
        position:entry.position??null,depth:Number.isFinite(Number(entry.depth))?Number(entry.depth):null,
      },
    };
  });
  const receipt=Object.freeze({
    kind:'SillyTavernLorebookDiscoveryReceipt',contractVersion:1,source:'SILLYTAVERN_WORLD_INFO_EDITOR',
    lorebookId:selection.lorebookId,title:selection.title,entryCount:entries.length,
    chatId:cleanText(context.chatId??safeCall(context.getCurrentChatId)),exactAuthoredSource:true,
  });
  return Object.freeze({id:selection.lorebookId,title:selection.title,entries,fullSnapshot:true,discovery:receipt});
}

function resolveGetContext(getContext,sillyTavern){
  if(typeof getContext==='function')return getContext;
  if(sillyTavern&&typeof sillyTavern.getContext==='function')return()=>sillyTavern.getContext();
  if(globalThis.SillyTavern&&typeof globalThis.SillyTavern.getContext==='function')return()=>globalThis.SillyTavern.getContext();
  return null;
}

function pickOwnerBindings(input){
  const out={};
  for(const key of OWNER_BINDING_KEYS)if(input?.[key]!=null)out[key]=input[key];
  return out;
}

function producerAvailability(input={}){
  const connected={};
  for(const [family,keys] of Object.entries(FAMILY_KEYS))connected[family]=keys.some(key=>input?.[key]!=null);
  return Object.freeze(connected);
}

function firstFunction(input,keys){for(const key of keys){if(typeof input?.[key]==='function')return input[key];}return null;}
function safeCall(fn){try{return typeof fn==='function'?fn():null;}catch{return null;}}
function cleanText(value){return value==null||value===''?null:String(value);}
function snapshotStyle(node,keys){const out={};for(const key of keys)out[key]=readStyle(node,key);return out;}
function readStyle(node,key){const style=node?.style;if(!style)return'';return typeof style.getPropertyValue==='function'?style.getPropertyValue(toCssName(key)):(style[key]??'');}
function setStyle(node,key,value){const style=node?.style;if(!style)return;if(typeof style.setProperty==='function')style.setProperty(toCssName(key),String(value??''));else style[key]=String(value??'');}
function restoreStyle(node,snapshot){for(const [key,value] of Object.entries(snapshot??{}))setStyle(node,key,value);}
function toCssName(key){return String(key).replace(/[A-Z]/g,m=>'-'+m.toLowerCase());}
function removeNode(node){if(!node)return;if(typeof node.remove==='function'){node.remove();return;}const parent=node.parentNode;if(parent?.children){const index=parent.children.indexOf?.(node);if(index>=0)parent.children.splice(index,1);}if(node.parentNode)node.parentNode=null;}
