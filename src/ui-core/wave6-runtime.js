import { SignalHub } from './signals.js';
import { RenderScheduler } from './render-scheduler.js';
import { WidgetRegistry, WorkspaceRegistry, InspectorRegistry } from './registry.js';
import { WidgetRuntime, ResourceScope } from './lifecycle.js';
import { ActionRouter } from './action-router.js';
import { UIStateStore } from './persistence.js';
import { OverlayManager } from './overlay.js';
import { NotificationCenter, ToastViewport } from './notifications.js';
import { registerPrimitiveWidgets, createKeyValue, element, makeCard } from './primitives.js';
import { registerCognitiveWidgets } from './cognitive-widgets.js';
import { InspectorController } from './inspector.js';
import { ApplicationShell } from './shell.js';
import { UIExtensionRegistry } from './wave4-extension-registry.js';
import { renderGenericArtifactInspector } from './wave4-generic-inspection.js';
import { ProductPresentationState } from './wave5-product-model.js';
import { registerKnowledgeInspectionActions } from './provenance-ui.js';
import { BrainPulseModel } from './wave6-brain-pulse.js';
import { CoprocessorProductionUIAdapter, ForensicsProductionUIAdapter, PromptPlanProductionUIAdapter, RuntimeProductionUIAdapter, SceneProductionUIAdapter, Wave6ProductAdapter } from './wave6-production-adapters.js';
import { FrontFaceMode, FrontFacePresentationState, HostAdjacentMountAdapter } from './wave6-presentation.js';
import { HostAdjacentFrontFaceController, registerWave6FrontFaceWorkspaces } from './wave6-front-face.js';
import { ExplainabilityPresentationState } from './wave7-explainability.js';
import { registerWave7Actions, registerWave7Inspectors, registerWave7Workspaces } from './wave7-workspaces.js';
import { Wave8CognitionProductionAdapter } from './wave8-production-adapters.js';
import { registerWave8Actions, registerWave8Inspectors } from './wave8-workspace.js';
import { createWave11LiveReceiptBinding, mergeWave11Bridges } from './wave11-live-bindings.js';
import { Wave13CoprocessorStateUIAdapter, Wave13DiagnosticsCenterAdapter, Wave13LoreAuthoringUIAdapter, Wave13LoreStudyUIAdapter, Wave13MemoryUIAdapter, Wave13OperationalStatusAdapter, Wave13ResourceControlAdapter, Wave13RuntimeReceiptUIAdapter } from './wave13-operator-adapters.js';
import { installWave13OperatorSurfaces, registerWave13OperatorActions } from './wave13-operator-surfaces.js';
import { VerticalRailPopoutController } from './wave13-floating-navigation.js';
import { DemoActivityFeedController, DemoEvidenceJournal } from './demo-visibility.js';
import { OperatorLoadTrace } from './operator-load-trace.js';
import { installTurnLogDiagnosticsWorkspace } from './turn-log-diagnostics.js';
import { BrainDecisionVisibilityAdapter } from './brain-decision-visibility.js';
import { SelectedTurnGraphVisibilityAdapter } from './selected-turn-graph-visibility.js';

export function createWave6ProductInterface({
  root,
  stateStore=new UIStateStore(),
  bridges={},
  productName='Nexus',
  productTagline='Cognitive Story System',
  hostMountAdapter=null,
  fixture=null,
  hostBindings=null,
  floatingNavigation=false,
  viewportProvider=null,
}={}){
  if(!root)throw new Error('Wave 6 product interface requires a host-adjacent root element');
  if(fixture&&hostBindings)throw new TypeError('Fixture review mode and Wave 11 live host bindings are mutually exclusive');
  const liveReceiptBinding=hostBindings?createWave11LiveReceiptBinding(hostBindings):null;
  const effectiveBridges=liveReceiptBinding?mergeWave11Bridges(bridges,liveReceiptBinding.bridges):bridges;
  const signals=new SignalHub(),scheduler=new RenderScheduler(),widgetRegistry=new WidgetRegistry(),workspaceRegistry=new WorkspaceRegistry(),inspectorRegistry=new InspectorRegistry(),actionRouter=new ActionRouter();
  const extensionRegistry=new UIExtensionRegistry({workspaceRegistry,inspectorRegistry,actionRouter,scheduler});
  const overlays=new OverlayManager({document:root.ownerDocument,root:root.ownerDocument.body});
  const notifications=new NotificationCenter({signals});
  const productPresentation=new ProductPresentationState({stateStore});
  const frontFacePresentation=new FrontFacePresentationState({stateStore});
  const explainabilityPresentation=new ExplainabilityPresentationState({stateStore});
  const selectionProvider=()=>liveReceiptBinding?.selection?.()??{};
  const brainDecisionVisibility=hostBindings?new BrainDecisionVisibilityAdapter({bindings:hostBindings,selectionProvider}):null;
  const graphVisibility=hostBindings?new SelectedTurnGraphVisibilityAdapter({bindings:hostBindings,selectionProvider,decisionVisibility:brainDecisionVisibility}):null;
  const uiLoadTrace=new OperatorLoadTrace({maxSamples:96});
  const hostDeliveryReader=typeof hostBindings?.readHostDeliveryReceipt==='function'?hostBindings.readHostDeliveryReceipt.bind(hostBindings):null;
  const hostDeliveryCache={key:null,value:null,valid:false};
  const readHostDeliveryReceipt=hostDeliveryReader?(selection={})=>{
    const key=JSON.stringify([selection?.chatId??null,selection?.turnId??null,selection?.generationId??null,selection?.correlationId??null,selection?.worldRevision??null,selection?.sceneRevision??null,selection?.sourceRevisionRefs??[]]);
    if(hostDeliveryCache.valid&&hostDeliveryCache.key===key)return hostDeliveryCache.value;
    const value=hostDeliveryReader(selection);hostDeliveryCache.key=key;hostDeliveryCache.value=value??null;hostDeliveryCache.valid=true;return hostDeliveryCache.value;
  }:null;
  const invalidateHostDeliveryCache=()=>{hostDeliveryCache.valid=false;hostDeliveryCache.key=null;hostDeliveryCache.value=null;};
  const scene=effectiveBridges.scene?.readModel?new SceneProductionUIAdapter({...effectiveBridges.scene,selectionProvider}):null;
  const runtime=effectiveBridges.runtimeAdapter?new RuntimeProductionUIAdapter(effectiveBridges.runtimeAdapter):
    (effectiveBridges.cognition?.readScatterReceipt||typeof hostBindings?.readRuntimeStatus==='function')?new Wave13RuntimeReceiptUIAdapter({
      readScatter:effectiveBridges.cognition?.readScatterReceipt??(typeof hostBindings?.readScatter==='function'?hostBindings.readScatter.bind(hostBindings):null),
      readStatus:typeof hostBindings?.readRuntimeStatus==='function'?hostBindings.readRuntimeStatus.bind(hostBindings):null,
      selectionProvider,
    }):new RuntimeProductionUIAdapter(null);
  const resourceCognitionReader=typeof hostBindings?.readCognitionUiState==='function'
    ?(selection)=>hostBindings.readCognitionUiState(selection)
    :typeof hostBindings?.resourceHost?.read?.cognition==='function'
      ?(selection)=>hostBindings.resourceHost.read.cognition(selection)
      :typeof hostBindings?.coprocessorResourceHost?.read?.cognition==='function'
        ?(selection)=>hostBindings.coprocessorResourceHost.read.cognition(selection)
        :typeof hostBindings?.resourceConnectionsHost?.read?.cognition==='function'
          ?(selection)=>hostBindings.resourceConnectionsHost.read.cognition(selection)
          :null;
  const coprocessor=(effectiveBridges.coprocessorTelemetry??effectiveBridges.coprocessorAdapter)?new CoprocessorProductionUIAdapter(effectiveBridges.coprocessorTelemetry??effectiveBridges.coprocessorAdapter):
    resourceCognitionReader?new Wave13CoprocessorStateUIAdapter({readState:resourceCognitionReader,selectionProvider}):new CoprocessorProductionUIAdapter(null);
  const promptPlan=new PromptPlanProductionUIAdapter({...effectiveBridges.promptPlan,readHostDeliveryReceipt,selectionProvider});
  const forensics=new ForensicsProductionUIAdapter(effectiveBridges.forensics??{});
  const cognition=new Wave8CognitionProductionAdapter({scene,promptPlan,...(effectiveBridges.cognition??{})});
  const loreStudy=hostBindings?new Wave13LoreStudyUIAdapter({bindings:hostBindings,selectionProvider}):null;
  const loreAuthoring=hostBindings?new Wave13LoreAuthoringUIAdapter({bindings:hostBindings}):null;
  const memoryOwner=hostBindings?new Wave13MemoryUIAdapter({bindings:hostBindings,selectionProvider}):null;
  const resources=hostBindings?new Wave13ResourceControlAdapter({bindings:hostBindings,stateStore}):null;
  const productAdapter=new Wave6ProductAdapter({
    scene,runtime,coprocessor,promptPlan,forensics,
    story:effectiveBridges.story??null,characters:effectiveBridges.characters??null,lore:loreStudy??effectiveBridges.lore??null,memory:memoryOwner??effectiveBridges.memory??null,world:effectiveBridges.world??null,
    presentationState:productPresentation,fixture,
  });
  let shell=null,controller=null,floatingController=null,workspaceScope=new ResourceScope();
  const brainPulse=new BrainPulseModel({runtime,coprocessor,scheduler,onUpdate(){if(shell&&['home','brain'].includes(shell.currentWorkspace))shell.refreshCurrentWorkspace();controller?.scheduleQuickDash();}});
  const mounted=new Set();

  registerPrimitiveWidgets(widgetRegistry);registerCognitiveWidgets(widgetRegistry);
  const widgetRuntime=new WidgetRuntime({registry:widgetRegistry,services:{signals,scheduler,actionRouter,overlays,notifications,productAdapter}});
  if(effectiveBridges.knowledgeAdapter)registerKnowledgeInspectionActions(actionRouter,{adapter:effectiveBridges.knowledgeAdapter,signals});
  const releaseWave7Actions=registerWave7Actions(actionRouter,{presentation:explainabilityPresentation});
  const releaseWave8Actions=registerWave8Actions(actionRouter);
  const releaseWave13Actions=registerWave13OperatorActions(actionRouter,{resources,loreStudy,loreAuthoring});

  inspectorRegistry.register('*',(object,{document:doc})=>renderReadOnlyInspector(doc,object));
  inspectorRegistry.register('framework-artifact',renderGenericArtifactInspector);
  const releaseWave7Inspectors=registerWave7Inspectors(inspectorRegistry,{forensics,promptPlan});
  const releaseWave8Inspectors=registerWave8Inspectors(inspectorRegistry,{cognition,forensics,decisionVisibility:brainDecisionVisibility});

  const inspector=new InspectorController({host:root,registry:inspectorRegistry,signals,scheduler,services:{signals,actionRouter,productAdapter,extensionRegistry}});
  const inspectionScope=new ResourceScope();
  inspectionScope.subscribe(signals,'UI_INSPECT_SELECTION_CHANGED',({payload})=>{
    if(!payload?.object)return;
    frontFacePresentation.patch({frontFaceMode:FrontFaceMode.EXPANDED});
    floatingController?.open?.();
    controller?.scheduleQuickDash?.();
  });
  const renderWorkspace=(entry,host)=>{
    for(const instance of mounted)widgetRuntime.destroy(instance);mounted.clear();workspaceScope.cleanup();workspaceScope=new ResourceScope();host.replaceChildren();
    entry.render?.(host,{
      scope:workspaceScope,signals,scheduler,actionRouter,notifications,productAdapter,brainPulse,workspaceRegistry,
      promptPlan,forensics,cognition,brainDecisionVisibility,presentation:explainabilityPresentation,frontFacePresentation,liveReceiptBinding,operations,resources,loreStudy,loreAuthoring,diagnostics,floatingController,
      mount(widgetId,node,props){const instance=widgetRuntime.mount(widgetId,node,props);mounted.add(instance);return instance;},
      inspect(object){signals.publish('UI_INSPECT_SELECTION_CHANGED',{object},{source:'wave6-product'});},
      navigate(id){shell?.selectWorkspace(id);},
      refresh(){shell?.refreshCurrentWorkspace();},
    });
  };

  registerWave6FrontFaceWorkspaces(workspaceRegistry,{adapter:productAdapter,brainPulse});
  const productionAdapters={scene,runtime,coprocessor,promptPlan,forensics,cognition};
  const operations=hostBindings?new Wave13OperationalStatusAdapter({hostBindings,liveReceiptBinding,productionAdapters,loreStudy,resources}):null;
  const diagnostics=hostBindings?new Wave13DiagnosticsCenterAdapter({operations,resources,loreStudy,memory:memoryOwner,cognition,liveReceiptBinding,productionAdapters,uiLoadTrace,graphVisibility,hostBindings}):null;
  const evidenceJournal=hostBindings?new DemoEvidenceJournal({storage:stateStore.storage,namespace:String(stateStore.namespace??'nexus.ui.v1')+'.demoEvidence.v1'}):null;
  const turnLogWorkspace=evidenceJournal?installTurnLogDiagnosticsWorkspace(workspaceRegistry,{journal:evidenceJournal,selectionProvider,decisionVisibility:brainDecisionVisibility,graphVisibility,diagnostics}):null;
  const releaseWave13Surfaces=installWave13OperatorSurfaces(workspaceRegistry,{operations,resources,loreStudy,loreAuthoring,memory:memoryOwner,diagnostics,actionRouter,cognition,coprocessor,frontFacePresentation,evidenceJournal,graphVisibility,worldTree:hostBindings?.world??null});
  registerProductionEngineeringWorkspaces(workspaceRegistry,{runtime,coprocessor,promptPlan,forensics});
  registerWave7Workspaces(workspaceRegistry,{promptPlan,forensics,presentation:explainabilityPresentation,scheduler});

  shell=new ApplicationShell({root,workspaceRegistry,inspector,signals,stateStore,renderWorkspace,productName,productTagline});
  const mountAdapter=hostMountAdapter instanceof HostAdjacentMountAdapter?hostMountAdapter:new HostAdjacentMountAdapter(hostMountAdapter??{});
  controller=new HostAdjacentFrontFaceController({host:root,shell,adapter:productAdapter,presentation:frontFacePresentation,scheduler,signals,brainPulse,hostMountAdapter:mountAdapter,productName,collapsedReservationWidth:floatingNavigation?0:76});
  controller.mount();
  floatingController=floatingNavigation?new VerticalRailPopoutController({frontFaceController:controller,shell,presentation:frontFacePresentation,signals,scheduler,stateStore,workspaceRegistry,productName,viewportProvider}).mount():null;
  const cognitionScope=new ResourceScope();
  const inspectEvidence=(object)=>signals.publish('UI_INSPECT_SELECTION_CHANGED',{object},{source:'demo-activity-feed'});
  let activityFeed=null,activityFeedHost=null;
  const captureEvidence=()=>{
    if(!evidenceJournal||!operations)return null;
    const outerStart=uiLoadTrace.now();
    const op=uiLoadTrace.measure('OWNER_OPERATIONS_READ',()=>operations.read(),{selection:selectionProvider()}),selection=op.selection??selectionProvider();
    let ownerReceipt=null;
    try{ownerReceipt=uiLoadTrace.measure('OWNER_SELECTED_TURN_READ',()=>effectiveBridges.selectedTurn?.readReceipt?.(selection)??null,{selection});}catch{/* LiveReceiptBinding records the safe rejection for Diagnostics. */}
    const cognitionRead=uiLoadTrace.measure('OWNER_SCATTER_GATHER_READ',()=>cognition.read?.(selection)??null,{selection});
    const diagnosticsRead=uiLoadTrace.measure('UI_JOURNAL_DIAGNOSTICS_READ',()=>diagnostics?.readJournalEvidence?.()??diagnostics?.read?.()??null,{selection});
    const promptPlanRead=uiLoadTrace.measure('OWNER_PROMPT_PLAN_READ',()=>promptPlan.read?.(selection)??null,{selection});
    const turn=uiLoadTrace.measure('UI_JOURNAL_PROCESS',()=>evidenceJournal.recordSnapshot({selection,operations:op,diagnostics:diagnosticsRead,cognition:cognitionRead,promptPlan:promptPlanRead,ownerReceipt}),{selection,details:{writes:evidenceJournal.writeCount}});
    if(evidenceJournal.lastRecordChanged&&activityFeed)uiLoadTrace.measure('UI_ACTIVITY_FEED_RENDER',()=>activityFeed.render(),{selection});
    uiLoadTrace.record('UI_CAPTURE_TOTAL',Math.max(0,uiLoadTrace.now()-outerStart),{selection,details:{coalesced:!evidenceJournal.lastRecordChanged}});
    return turn;
  };
  const scheduleEvidenceCapture=(source='HOST_EVENT')=>{
    if(!evidenceJournal||!operations)return false;
    const pendingBefore=scheduler.pendingCount,scheduled=scheduler.invalidate('demo:evidence-capture',captureEvidence,{cost:'CHEAP'});
    uiLoadTrace.record('HOST_EVENT_INVALIDATION',0,{selection:selectionProvider(),details:{pendingBefore,pendingAfter:scheduler.pendingCount,coalesced:pendingBefore===scheduler.pendingCount&&pendingBefore>0}});
    return scheduled;
  };
  let liveSelectionKey=null;
  const applyLiveSelection=(update=null,{initial=false}={})=>{
    invalidateHostDeliveryCache();
    const selection=liveReceiptBinding?.selection?.(update?.selection??{})??null;
    if(!selection)return;
    const key=JSON.stringify([selection.chatId,selection.turnId,selection.generationId,selection.correlationId,selection.worldRevision,selection.sceneRevision,selection.sourceRevisionRefs]);
    const switched=liveSelectionKey!==null&&key!==liveSelectionKey;liveSelectionKey=key;
    if(initial||switched){
      explainabilityPresentation.selectGeneration({generationId:selection.generationId??null,turnId:selection.turnId??null});
      inspector.clear();scheduler.cancelPrefix('inspector');
      signals.publish('UI_HOST_CONTEXT_CHANGED',{selection,switched},{source:'wave11-live-binding'});
    }else if(inspector.selection)scheduler.invalidate('wave11:inspector-refresh',()=>inspector.render(),{cost:'NORMAL'});
    scheduler.invalidate('wave11:host-refresh',()=>uiLoadTrace.measure('UI_WORKSPACE_REFRESH',()=>{if(shell?.currentWorkspace)shell.refreshCurrentWorkspace();controller?.scheduleQuickDash?.();},{selection}),{cost:'NORMAL'});
    scheduleEvidenceCapture('LIVE_SELECTION');
  };
  if(liveReceiptBinding)applyLiveSelection(null,{initial:true});
  const cognitionRelease=cognition.subscribe((update)=>{
    if(liveReceiptBinding)applyLiveSelection(update);
    else scheduler.invalidate('wave8:cognition-refresh',()=>{if(shell?.currentWorkspace==='brain')shell.refreshCurrentWorkspace();controller?.scheduleQuickDash?.();},{cost:'NORMAL'});
  });if(typeof cognitionRelease==='function')cognitionScope.add(cognitionRelease);
  const operatorRefresh=(scopeKey)=>scheduler.invalidate('wave13:'+scopeKey+'-refresh',()=>uiLoadTrace.measure('UI_WORKSPACE_REFRESH',()=>{
    if(shell?.currentWorkspace==='brain'||shell?.currentWorkspace==='connections'||shell?.currentWorkspace==='settings'||shell?.currentWorkspace==='turn-log'||(scopeKey==='lore'&&shell?.currentWorkspace==='lore')||(scopeKey==='memory'&&shell?.currentWorkspace==='memory')||shell?.currentWorkspace==='home')shell.refreshCurrentWorkspace();
    controller?.scheduleQuickDash?.();scheduleEvidenceCapture('OPERATOR_'+String(scopeKey).toUpperCase());
  },{selection:selectionProvider()}),{cost:'NORMAL'});
  const resourceRelease=resources?.subscribe?.(()=>operatorRefresh('resources'));if(typeof resourceRelease==='function')cognitionScope.add(resourceRelease);
  const resourceRestore=resources?.restoreSavedProfiles?.();
  if(resourceRestore&&typeof resourceRestore.then==='function')resourceRestore.then(()=>operatorRefresh('resources')).catch(()=>operatorRefresh('resources'));
  const loreRelease=loreStudy?.subscribe?.(()=>operatorRefresh('lore'));if(typeof loreRelease==='function')cognitionScope.add(loreRelease);
  const memoryRelease=memoryOwner?.subscribe?.(()=>operatorRefresh('memory'));if(typeof memoryRelease==='function')cognitionScope.add(memoryRelease);

  const toastScope=new ResourceScope(),toastViewport=new ToastViewport({host:shell.nodes.toastHost,signals,scope:toastScope});toastViewport.mount();
  if(evidenceJournal){
    activityFeedHost=element(root.ownerDocument,'div',{className:'nexus-floating-activity-feed-host',attrs:{'aria-label':'Selected-turn activity feed'}});
    shell.nodes.toastHost.append(activityFeedHost);
    activityFeed=new DemoActivityFeedController({host:activityFeedHost,journal:evidenceJournal,selectionProvider,inspect:inspectEvidence,maxVisible:5}).mount();
  }
  scheduleEvidenceCapture('INITIAL_MOUNT');

  return{
    controller,shell,signals,scheduler,widgetRegistry,workspaceRegistry,inspectorRegistry,actionRouter,extensionRegistry,overlays,notifications,
    productAdapter,brainPulse,presentation:frontFacePresentation,productPresentation,explainabilityPresentation,liveReceiptBinding,
    floatingController,operator:{operations,resources,loreStudy,loreAuthoring,memory:memoryOwner,diagnostics,evidenceJournal,activityFeed,captureEvidence,loadTrace:uiLoadTrace,turnLog:turnLogWorkspace?.model??null,brainDecisionVisibility,graphVisibility},
    productionAdapters:{scene,runtime,coprocessor,promptPlan,forensics,cognition},
    registerUIExtension(descriptor,binding){return extensionRegistry.register(descriptor,binding);},
    destroy(){for(const instance of mounted)widgetRuntime.destroy(instance);mounted.clear();workspaceScope.cleanup();toastScope.cleanup();cognitionScope.cleanup();inspectionScope.cleanup();activityFeed?.destroy?.();activityFeedHost?.remove?.();turnLogWorkspace?.release?.();floatingController?.destroy?.();liveReceiptBinding?.destroy?.();cognition.destroy?.();forensics.destroy?.();releaseWave13Surfaces?.();releaseWave13Actions?.();releaseWave8Inspectors?.();releaseWave8Actions?.();releaseWave7Inspectors?.();releaseWave7Actions?.();overlays.destroy();controller.destroy();extensionRegistry.destroy();scheduler.destroy();signals.clear();},
  };
}

function registerProductionEngineeringWorkspaces(registry,{runtime,coprocessor,promptPlan,forensics}){
  if(!registry.has('runtime-live'))registry.register({id:'runtime-live',title:'Runtime',icon:'≋',category:'Engineering',navigation:{level:'advanced',order:130},views:['advanced'],supportedActions:['inspect'],render(host){const d=host.ownerDocument,r=runtime.read();host.append(element(d,'h1',{text:'Runtime Detail'}));if(!r.data){host.append(state(d,'Runtime unavailable',r.source.reason||r.source.impact));return;}const x=r.data,counts=x.lifecycleCounts??{};host.append(makeCard(d,{title:'Runtime summary',body:createKeyValue(d,[{key:'Mode',value:x.mode},{key:'HOT active',value:x.hotActivity},{key:'DEEP active',value:x.deepActivity},{key:'Queued obligations',value:x.queuedObligations},{key:'Blocked / recovering',value:x.blockedRecoveringWork},{key:'Active / yielding',value:x.activeBatches}])}));host.append(makeCard(d,{title:'Lifecycle signals',body:createKeyValue(d,[{key:'Queued',value:counts.QUEUED??0},{key:'Active',value:counts.ACTIVE??0},{key:'Yielding',value:counts.YIELDING??0},{key:'Parked',value:counts.PARKED??0},{key:'Recovering',value:counts.RECOVERING??0},{key:'Complete',value:counts.COMPLETE??0},{key:'Failed',value:counts.FAILED??0}])}));host.append(makeCard(d,{title:'Scheduler / capacity',body:createKeyValue(d,[{key:'Queue by layer',value:Object.entries(x.queueDepth??{}).map(([k,v])=>k+': '+v).join(' · ')||'none'},{key:'Borrowed background leases',value:x.resources?.borrowedBackgroundLeases??'not published'},{key:'Retained telemetry signals',value:x.telemetry?.retainedSignals??'not published'},{key:'Telemetry sink failures',value:x.telemetry?.sinkFailures??'not published'},{key:'Batch progress history',value:x.batchProgressAvailable?'Published':'Owner snapshot does not publish batch history'},{key:'Late-result history',value:x.lateResultHistoryAvailable?'Published':'Owner snapshot does not publish late-result history'}])}));}});
  if(!registry.has('coprocessor-live'))registry.register({id:'coprocessor-live',title:'Coprocessor',icon:'✣',category:'Engineering',navigation:{level:'advanced',order:140},views:['advanced'],supportedActions:['inspect'],render(host){const d=host.ownerDocument,r=coprocessor.read();host.append(element(d,'h1',{text:'Coprocessor Detail'}));if(!r.data){host.append(state(d,'Coprocessor unavailable',r.source.reason||r.source.impact));return;}const q=r.data.queue??{},physical=r.data.physicalExecution??{},life=r.data.lifecycle??{};host.append(makeCard(d,{title:'Telemetry summary',body:createKeyValue(d,[{key:'Events',value:r.data.totalEvents??'—'},{key:'Warm hit / miss',value:`${r.data.warm?.hit??0} / ${r.data.warm?.miss??0}`},{key:'Fallback / retry',value:`${r.data.fallback??0} / ${r.data.retry??0}`},{key:'Validation failures',value:r.data.validationFailures??0},{key:'Stale / late',value:`${r.data.staleDrop??0} / ${r.data.lateResults??0}`}])}));host.append(makeCard(d,{title:'Worker lifecycle signals',body:createKeyValue(d,[{key:'Queued',value:q.queued??0},{key:'Yielding',value:q.yields??0},{key:'Parked',value:q.parks??0},{key:'Resumed',value:q.resumes??0},{key:'HOT / DEEP active',value:`${r.data.hotActivity??0} / ${r.data.deepActivity??0}`},{key:'Queue pressure',value:q.pressure?JSON.stringify(q.pressure):'not published'}])}));host.append(makeCard(d,{title:'Execution / owner admission',body:createKeyValue(d,[{key:'Configured resources',value:life.configured??0},{key:'Connected resources',value:life.connected??0},{key:'Physically executed resources',value:life.physicallyExecuted??0},{key:'Owner-accepted resources',value:life.ownerAccepted??0},{key:'Physical attempts',value:physical.attempts??0},{key:'Physical success / fail',value:`${physical.succeeded??0} / ${physical.failed??0}`},{key:'Result destinations',value:Object.entries(r.data.resultDestinations??{}).map(([k,v])=>k+': '+v).join(' · ')||'none published'}])}));}});
  if(!registry.has('context-delivery'))registry.register({id:'context-delivery',title:'Context Delivery',icon:'▥',category:'Engineering',navigation:{level:'advanced',order:150},views:['advanced'],supportedActions:['inspect'],render(host){const d=host.ownerDocument,r=promptPlan.read();host.append(element(d,'h1',{text:'PromptPlan / Context Delivery'}));if(!r.data){host.append(state(d,'Context delivery unavailable',r.source.reason||r.source.impact));return;}host.append(makeCard(d,{title:r.data.promptPlanId,body:createKeyValue(d,[{key:'Tokens',value:`${r.data.totalTokens} / ${r.data.budgetTotal}`},{key:'Segments',value:r.data.segments.length},{key:'Reused',value:r.data.reusedSegments},{key:'Updated',value:r.data.updatedSegments},{key:'Dropped / deferred',value:`${r.data.dropped.length} / ${r.data.deferred.length}`},{key:'Seal',value:r.data.seal?.sealedState===true?'SEALED':'UNAVAILABLE'}])}));}});
}

function renderReadOnlyInspector(doc,object={}){
  const root=element(doc,'div',{className:'nexus-stack'});root.append(element(doc,'h2',{text:object.title??object.name??object.id??object.kind??'Inspector'}));
  const summary=[];for(const [key,value] of Object.entries(object).slice(0,20)){if(key==='payload'||key==='scene'||key==='source'||key==='diagnosticRefs'||key==='provenanceRefs'||key==='error')continue;if(value==null||typeof value==='function')continue;summary.push({key,value:typeof value==='object'?Array.isArray(value)?`${value.length} items`:value.status??value.state??value.kind??'available':String(value)});}
  if(summary.length)root.append(createKeyValue(doc,summary));
  const deep=object.payload??object.scene??object.source??object.diagnosticRefs??object.error??null;
  if(deep){const safe=safeInspectorPayload(deep),pre=element(doc,'pre',{className:'nexus-context-packet',text:JSON.stringify(safe,null,2)});pre.setAttribute('aria-label','Bounded metadata-only read-only payload');root.append(pre);}
  root.append(element(doc,'p',{className:'nexus-muted',text:'Inspector output is bounded metadata. Raw prompts, story/lore bodies, credentials, and hidden reasoning are omitted.'}));
  return root;
}
function safeInspectorPayload(value,depth=0){
  if(value==null||typeof value==='number'||typeof value==='boolean')return value;
  if(typeof value==='string')return value.length>600?value.slice(0,600)+'…':value;
  if(depth>=6)return'[nested metadata omitted]';
  if(Array.isArray(value))return value.slice(0,24).map(row=>safeInspectorPayload(row,depth+1));
  if(typeof value!=='object')return String(value);
  const out={},entries=Object.entries(value).slice(0,64);
  for(const [key,row] of entries){
    const normalized=String(key).toLowerCase().replace(/[^a-z0-9]/g,'');
    const sensitive=['text','content','body','prompt','rawprompt','rawpayload','messages','story','storytext','lorebody','hiddenreasoning','reasoning','chainofthought','contexttext'].includes(normalized)
      ||/apikey|credential|authorization|secret|bearertoken/.test(normalized);
    out[key]=sensitive?'[omitted from UI evidence]':safeInspectorPayload(row,depth+1);
  }
  if(Object.keys(value).length>entries.length)out.__truncated=Object.keys(value).length-entries.length;
  return out;
}
function state(d,title,message){const r=element(d,'section',{className:'nexus-state-message',attrs:{role:'status'}});r.append(element(d,'strong',{text:title}),element(d,'span',{text:message||'Not connected.'}));return r;}
