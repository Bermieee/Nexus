import { ProductDetailLevel } from './wave5-product-model.js';
import { OperatorProducerState } from './wave13-operator-adapters.js';
import { createButton, createKeyValue, createProgressBar, element, makeBadge, makeHealthPill } from './primitives.js';
import { renderLoreReviewWorkspace } from './lore-authoring-review-ui.js';
import { createLoreNeuralRenderState, renderLoreNeuralWorkspace } from './lore-neural-graph.js';
import { renderSelectedTurnGraphVisibility } from './selected-turn-graph-visibility.js';

export function installWave13OperatorSurfaces(registry,{operations=null,resources=null,loreStudy=null,loreAuthoring=null,memory=null,diagnostics=null,actionRouter=null,cognition=null,coprocessor=null,frontFacePresentation=null,evidenceJournal=null,graphVisibility=null,worldTree=null}={}){
  const releases=[],connectionDrafts=createConnectionDraftStore(),loreAuthoringDraft=createLoreAuthoringDraftStore(),loreNeuralState=createLoreNeuralRenderState();
  if(registry.has('brain')){
    const current=registry.get('brain');
    registry.update('brain',{render(host,ctx){
      current.render?.(host,ctx);
      const detail=ctx.productAdapter.getDetailLevel();
      if(operations&&detail!==ProductDetailLevel.NORMAL)renderOperationalDetail(host,{...ctx,operations});
      if(graphVisibility&&detail!==ProductDetailLevel.NORMAL)host.append(renderSelectedTurnGraphVisibility(host.ownerDocument,graphVisibility.read?.(),{compact:detail!==ProductDetailLevel.ADVANCED,title:'Selected-turn world graph'}));
    }});
  }
  if(!registry.has('connections'))registry.register({
    id:'connections',title:'Connections',icon:'⇄',category:'Product',navigation:{level:'product',order:70},views:['normal','detail','advanced'],supportedActions:['inspect','discover-models','refresh-models','select-model','connect','disconnect','test','forget-saved'],
    render(host,ctx){
      host.append(header(host.ownerDocument,'Connections','Configure and test Jev, Sidecar A, Sidecar B, and Vectoring independently.'));
      if(resources)renderResourceSurface(host,{...ctx,resources,coprocessor,actionRouter,connectionDrafts});
      else host.append(message(host.ownerDocument,'Connections unavailable','The Nexus resource connection host is not available.','offline'));
    },
  });
  if(!registry.has('settings'))registry.register({
    id:'settings',title:'Settings',icon:'⚙',category:'Product',navigation:{level:'product',order:80},views:['normal','detail','advanced'],supportedActions:['display-preferences'],
    render(host,ctx){renderSettingsSurface(host,{...ctx,frontFacePresentation});},
  });
  if(registry.has('lore')){
    const current=registry.get('lore');
    registry.update('lore',{preferredWidth:1280,render(host,ctx){
      renderLoreStudySurface(host,{...ctx,loreStudy,actionRouter,fallbackRender:current.render,loreNeuralState,frontFacePresentation,worldTree});
    }});
  }
  // Lore entry states, derived representations and authoring review live in the Diagnostics workspace. The Diagnostics Center
  // registers as 'turn-log' (title 'Diagnostics'); no workspace is registered as 'diagnostics', so binding only that id left
  // these tools unreachable in the assembled UI.
  for(const diagnosticsWorkspaceId of ['diagnostics','turn-log']){
    if(!registry.has(diagnosticsWorkspaceId))continue;
    const current=registry.get(diagnosticsWorkspaceId);
    registry.update(diagnosticsWorkspaceId,{render(host,ctx){
      current.render?.(host,ctx);
      renderLoreDiagnosticsTools(host,{...ctx,loreStudy,loreAuthoring,actionRouter,draft:loreAuthoringDraft});
    }});
  }
  // The product Memory workspace is registered as 'memory-product' by the Front Face; the dashboard registers 'memory'.
  // Bind the owner-backed Memory surface to whichever exists (binding only 'memory' left the installed UI on a placeholder).
  if(memory){
    for(const memoryWorkspaceId of ['memory-product','memory'])if(registry.has(memoryWorkspaceId))registry.update(memoryWorkspaceId,{render(host,ctx){renderMemoryOwnerSurface(host,{...ctx,memory});}});
  }
  return()=>{for(const release of releases)try{release();}catch{}};
}

export function registerWave13OperatorActions(actionRouter,{resources=null,loreStudy=null,loreAuthoring=null}={}){
  const releases=[];
  if(resources){
    releases.push(actionRouter.registerSubsystem('wave13-resources',async(action)=>{
      if(action.type==='wave13.resource.discoverModels')return resources.discoverModels(action.payload??{});
      if(action.type==='wave13.resource.refreshModels')return resources.refreshModels(action.target??action.payload??{});
      if(action.type==='wave13.resource.selectModel')return resources.selectModel(action.target??{},action.payload?.modelId??'');
      if(action.type==='wave13.resource.connect')return resources.connect(action.payload??action.target??{});
      if(action.type==='wave13.resource.disconnect')return resources.disconnect(action.target??action.payload??{});
      if(action.type==='wave13.resource.test')return resources.test(action.target??action.payload??{});
      if(action.type==='wave13.resource.forgetSaved')return resources.forgetSavedProfile(action.target??action.payload??{});
      throw new Error('Unsupported Wave 13 resource action');
    }));
    releases.push(actionRouter.registerAction('wave13.resource.discoverModels',{subsystem:'wave13-resources'}));
    releases.push(actionRouter.registerAction('wave13.resource.refreshModels',{subsystem:'wave13-resources'}));
    releases.push(actionRouter.registerAction('wave13.resource.selectModel',{subsystem:'wave13-resources'}));
    releases.push(actionRouter.registerAction('wave13.resource.connect',{subsystem:'wave13-resources'}));
    releases.push(actionRouter.registerAction('wave13.resource.disconnect',{subsystem:'wave13-resources'}));
    releases.push(actionRouter.registerAction('wave13.resource.test',{subsystem:'wave13-resources'}));
    releases.push(actionRouter.registerAction('wave13.resource.forgetSaved',{subsystem:'wave13-resources'}));
  }
  if(loreStudy){
    releases.push(actionRouter.registerSubsystem('wave13-lore',async(action)=>{
      if(action.type==='wave13.lore.accept')return loreStudy.accept(action.payload??{});
      if(action.type==='wave13.lore.run')return loreStudy.run(action.payload??{});
      throw new Error('Unsupported Wave 13 Lore action');
    }));
    releases.push(actionRouter.registerAction('wave13.lore.accept',{subsystem:'wave13-lore'}));
    releases.push(actionRouter.registerAction('wave13.lore.run',{subsystem:'wave13-lore'}));
  }
  if(loreAuthoring){
    releases.push(actionRouter.registerSubsystem('wave13-lore-authoring',async(action)=>{
      if(action.type==='wave13.loreAuthoring.discover')return loreAuthoring.sourceDiscoveryIdentity(action.payload??{});
      if(action.type==='wave13.loreAuthoring.previewEdit')return loreAuthoring.previewEditImpact(action.payload??{});
      if(action.type==='wave13.loreAuthoring.proposeTree')return loreAuthoring.proposeTree(action.payload??{});
      if(action.type==='wave13.loreAuthoring.previewMerge')return loreAuthoring.previewMerge(action.payload??{});
      if(action.type==='wave13.loreAuthoring.createMutationProposal')return loreAuthoring.createMutationProposal(action.payload??{});
      if(action.type==='wave13.loreAuthoring.approveMutationProposal')return loreAuthoring.approveMutationProposal(action.payload??{});
      if(action.type==='wave13.loreAuthoring.rejectMutationProposal')return loreAuthoring.rejectMutationProposal(action.payload??{});
      if(action.type==='wave13.loreAuthoring.commitMutationProposal')return loreAuthoring.commitMutationProposal(action.payload??{});
      if(action.type==='wave13.loreAuthoring.restoreMutationProposal')return loreAuthoring.restoreMutationProposal(action.payload??{});
      if(action.type==='wave13.loreAuthoring.rebuildAffectedNavigation')return loreAuthoring.rebuildAffectedNavigation(action.payload??{});
      if(action.type==='wave13.loreAuthoring.startTreeBuild')return loreAuthoring.startTreeBuild(action.payload??{});
      if(action.type==='wave13.loreAuthoring.startMergeBuild')return loreAuthoring.startMergeBuild(action.payload??{});
      if(action.type==='wave13.loreAuthoring.resumeBuild')return loreAuthoring.resumeBuild(action.payload??{});
      if(action.type==='wave13.loreAuthoring.recordDecision')return loreAuthoring.recordDecision(action.payload??{});
      if(action.type==='wave13.loreAuthoring.reclassify')return loreAuthoring.reclassify(action.payload??{});
      if(action.type==='wave13.loreAuthoring.computeFinalPreview')return loreAuthoring.computeFinalPreview(action.payload??{});
      if(action.type==='wave13.loreAuthoring.approveFinalPreview')return loreAuthoring.approveFinalPreview(action.payload??{});
      if(action.type==='wave13.loreAuthoring.applySettlement')return loreAuthoring.applySettlement(action.payload??{});
      if(action.type==='wave13.loreAuthoring.restoreSettlement')return loreAuthoring.restoreSettlement(action.payload??{});
      throw new Error('Unsupported Wave 13 Lore authoring action');
    }));
    for(const type of ['wave13.loreAuthoring.discover','wave13.loreAuthoring.previewEdit','wave13.loreAuthoring.proposeTree','wave13.loreAuthoring.previewMerge','wave13.loreAuthoring.createMutationProposal','wave13.loreAuthoring.approveMutationProposal','wave13.loreAuthoring.rejectMutationProposal','wave13.loreAuthoring.commitMutationProposal','wave13.loreAuthoring.restoreMutationProposal','wave13.loreAuthoring.rebuildAffectedNavigation','wave13.loreAuthoring.startTreeBuild','wave13.loreAuthoring.startMergeBuild','wave13.loreAuthoring.resumeBuild','wave13.loreAuthoring.recordDecision','wave13.loreAuthoring.reclassify','wave13.loreAuthoring.computeFinalPreview','wave13.loreAuthoring.approveFinalPreview','wave13.loreAuthoring.applySettlement','wave13.loreAuthoring.restoreSettlement']){
      releases.push(actionRouter.registerAction(type,{subsystem:'wave13-lore-authoring'}));
    }
  }
  return()=>{for(const release of releases.reverse())try{release?.();}catch{}};
}

export function renderOperationalSummary(host,{operations,scope,inspect}={}){
  const d=host.ownerDocument,status=operations.read(),section=element(d,'section',{className:'nexus-wave13-operations',attrs:{'aria-label':'Live Brain bindings'}});
  const head=element(d,'div',{className:'nexus-wave13-section-head'});
  head.append(element(d,'h2',{text:'Live Brain bindings'}),makeBadge(d,status.waitingForTurn?'WAITING FOR TURN':status.hostConnected?'HOST SELECTED':'NO HOST CHAT',status.waitingForTurn?'historical':status.hostConnected?'ready':'offline'));
  section.append(head);
  if(status.waitingForTurn)section.append(message(d,'Waiting for a turn','The selected chat is current. Turn-scoped receipts will appear after the Brain receives a generation event.','historical'));
  else if(!status.hostConnected)section.append(message(d,'No selected chat','Nexus has no host chat identity to bind cognitive receipts to.','offline'));
  const pipeline=status.pipeline??{};
  if(pipeline.hostLifecycle?.ownerAvailable===false)section.append(message(d,'Native Brain owner not integrated',pipeline.hostLifecycle.reason??'Worker 1 native Brain owner is not attached to this main assembly. Visible legacy/demo receipts must not be treated as end-to-end native Brain execution.','warning'));
  else if(pipeline.hostLifecycle?.ownerAvailable===true)section.append(message(d,'Native Brain host loop attached','The host reports Worker 1’s owner interface is attached. Delivery and learning still require their own receipts below.','ready'));
  section.append(element(d,'h3',{text:'Brain activity'}),element(d,'div',{className:'nexus-wave13-diagnostics__activity'},
    flowStep(d,'Producers available',String(pipeline.registeredProducers??0)),
    flowStep(d,'Jobs mapped',pipeline.mappingReceipt?String(pipeline.logicalJobsMapped??0)+' logical → '+String(pipeline.mappedResourceCount??0)+' resource '+((pipeline.mappedResourceCount??0)===1?'identity':'identities'):'No Scatter receipt'),
    flowStep(d,'Physical execution',pipeline.executionReceipt?String(pipeline.physicalExecutionAttempts??0)+' attempts · '+String(pipeline.physicalExecutionSucceeded??0)+' succeeded':'No selected-turn execution receipt'),
    flowStep(d,'Results returned',pipeline.resultReceipt?String(pipeline.returnedResults??0):'No Gather receipt'),
    flowStep(d,'Context admitted',pipeline.admissionReceipt?String(pipeline.contextAdmitted??0):'No Context Seal receipt'),
    flowStep(d,'Generation delivery',pipeline.deliveryReceipt?(pipeline.generationState?humanLabel(pipeline.generationState):'Sealed context delivered'):pipeline.generationReader?'No delivery receipt':'Owner generation reader unavailable'),
    flowStep(d,'Learning write-back',pipeline.learningReceipt?'Learning receipt recorded':pipeline.generationReceipt?'No learning receipt yet':'No generation receipt')
  ));
  const grid=element(d,'div',{className:'nexus-wave13-status-grid'});
  for(const row of status.stages.slice(0,8))grid.append(stageCard(d,row,scope,inspect,{inspection:status.inspections?.[row.id]}));
  section.append(grid);host.append(section);
}

export function renderOperationalDetail(host,{operations,scope,inspect}={}){
  const d=host.ownerDocument,status=operations.read(),section=element(d,'section',{className:'nexus-wave13-operations nexus-wave13-operations--detail'});
  section.append(element(d,'h2',{text:'Producer / selection diagnostics'}));
  const selection=status.selection??{};
  section.append(createKeyValue(d,[
    {key:'Chat',value:selection.chatId??'none'},
    {key:'Turn',value:selection.turnId??'waiting'},
    {key:'Generation',value:selection.generationId??'waiting'},
    {key:'World revision',value:selection.worldRevision??'—'},
    {key:'Scene revision',value:selection.sceneRevision??'—'},
  ]));
  const pipeline=status.pipeline??{};
  section.append(element(d,'h3',{text:'Execution / admission'}),createKeyValue(d,[
    {key:'Registered producers',value:pipeline.registeredProducers??0},{key:'Scatter mapping receipt',value:pipeline.mappingReceipt?'Published':'None'},
    {key:'Logical jobs mapped',value:pipeline.logicalJobsMapped??0},{key:'Mapped resource identities',value:pipeline.mappedResourceCount??0},
    {key:'Physical execution receipt',value:pipeline.executionReceipt?'Published':'None'},{key:'Physical attempts / success / fail',value:[pipeline.physicalExecutionAttempts??0,pipeline.physicalExecutionSucceeded??0,pipeline.physicalExecutionFailed??0].join(' / ')},
    {key:'Gather receipt',value:pipeline.resultReceipt?'Published':'None'},
    {key:'Returned results',value:pipeline.returnedResults??0},{key:'Context Seal receipt',value:pipeline.admissionReceipt?'Published':'None'},
    {key:'Context-admitted results',value:pipeline.contextAdmitted??0},
    {key:'Generation receipt',value:pipeline.generationReceipt?'Published':'None'},{key:'Generation state',value:pipeline.generationState??'—'},
    {key:'Post-response learning',value:pipeline.learningReceipt?(pipeline.learningKind??'Published'):'None'},
    {key:'Host lifecycle',value:pipeline.hostLifecycle?String(pipeline.hostLifecycle.learned??0)+' learned · '+String(pipeline.hostLifecycle.pending??0)+' pending':'Not exported'},
  ]));
  const grid=element(d,'div',{className:'nexus-wave13-status-grid'});
  for(const row of status.stages)grid.append(stageCard(d,row,scope,inspect,{showIds:true,inspection:status.inspections?.[row.id]}));
  section.append(grid);host.append(section);
}

export function renderResourceSurface(host,{resources,coprocessor=null,actionRouter,scope,refresh,notifications,connectionDrafts=null}={}){
  const d=host.ownerDocument,read=resources.read(),source=read.source,data=read.data??{resources:[],configurations:[],nativePathAvailable:true};
  const turnResources=safeCoprocessorResourceRows(coprocessor);
  const section=element(d,'section',{className:'nexus-wave13-resources',attrs:{'aria-label':'Optional execution resource connections'}});
  const head=element(d,'div',{className:'nexus-wave13-section-head'});
  head.append(element(d,'h2',{text:'Connections'}),makeHealthPill(d,{label:source.operationalState??source.health,status:source.statusToken,detail:source.impact}));
  section.append(head,element(d,'p',{className:'nexus-muted',text:'Jev, Sidecar A, Sidecar B, and Vectoring are independent connections. A locked connection keeps its own profile and credential and rehydrates automatically until you release the lock.'}));
  if(source.reason)section.append(message(d,source.operationalState==='UNAVAILABLE'?'Assembly action seam not connected':'Resource status',source.reason,source.statusToken));

  const caps=resources.capabilities();
  if(caps.read&&(!caps.connect||!caps.test||!caps.disconnect))section.append(message(d,'Resource controls incomplete','Resource status is readable, but connect/test/disconnect are not all exported by the assembly. Worker 2 remains the routing/execution owner.','warning'));

  const slots=element(d,'div',{className:'nexus-wave13-connection-slots'});
  const drafts=connectionDrafts??createConnectionDraftStore(),savedProfiles=resources.savedProfiles?.()??[];
  if(savedProfiles.length)section.append(message(d,'Saved connection locks',savedProfiles.length+' optional connection lock'+(savedProfiles.length===1?' is':'s are')+' stored persistently for automatic reload recovery.','ready'));
  for(const spec of connectionSlotSpecs()){
    const savedProfile=savedProfiles.find(row=>row.role===spec.id)??null;
    slots.append(renderConnectionSlot(d,{spec,savedProfile,rows:data.resources.filter(row=>connectionSlotFor(row)===spec.id).map(row=>overlayTurnResourceEvidence(row,turnResources)),resources,actionRouter,scope,refresh,notifications,caps,connectionDrafts:drafts}));
  }
  section.append(slots);

  if(!data.resources.length)section.append(message(d,'No optional resource connected',caps.read?'Worker 2 reports no configured optional resources. Native cognition remains available.':'The host assembly has not exported Worker 2 resource status/actions yet.','historical'));
  host.append(section);
}

function renderConnectionSlot(d,{spec,savedProfile=null,rows,resources,actionRouter,scope,refresh,notifications,caps,connectionDrafts}){
  const connected=rows.some(row=>row.connected),configured=rows.length>0,saved=Boolean(savedProfile);
  const slot=element(d,'section',{className:'nexus-wave13-connection-slot',dataset:{slot:spec.id,connected:String(connected),locked:String(saved),saved:String(saved)}});
  const head=element(d,'div',{className:'nexus-wave13-connection-slot__head'});
  head.append(element(d,'h3',{text:spec.title}),makeBadge(d,connected?'READY':saved?'SAVED':configured?'CONFIGURED':'OPEN',connected?'ready':configured||saved?'observed':'historical'));
  slot.append(head,element(d,'p',{className:'nexus-wave13-connection-slot__hint',text:spec.description}));

  if(configured&&savedProfile){
    const locked=element(d,'div',{className:'nexus-wave13-connection-slot__locked'});
    for(const row of rows)locked.append(renderLockedResource(d,{row,spec,savedProfile,resources,actionRouter,scope,refresh,notifications,caps,connectionDrafts}));
    slot.append(locked);
    return slot;
  }

  if(!(caps.connect&&caps.configure)){
    slot.append(message(d,'Connection setup unavailable',caps.connect?'This assembly can reconnect owner-configured resources, but cannot add a new one.':'Worker 2 connection actions are not exported by this assembly.','warning'));
    return slot;
  }

  const editableSource=savedProfile??rows[0]??null;
  if(editableSource)connectionDrafts.patch(spec.id,{
    connectionName:editableSource.displayName??spec.defaultName,
    endpoint:editableSource.endpoint??'',
    capabilities:(editableSource.capabilities??editableSource.declaredCapabilities??spec.defaultCapabilities).join(', '),
    selectedModel:editableSource.modelId??'',
    manualModel:editableSource.modelId??'',
  });
  const draft=connectionDrafts.get(spec);
  const form=element(d,'div',{className:'nexus-wave13-connection-slot__form'});
  const connectionName=field(d,'input',spec.title+' connection name',{type:'text',placeholder:spec.defaultName,autocomplete:'off'});
  connectionName.value=draft.connectionName??spec.defaultName;
  const endpoint=field(d,'input',spec.title+' endpoint',{type:'url',placeholder:spec.remotePlaceholder??'https://provider.example/v1'});
  endpoint.value=draft.endpoint??'';
  const apiKey=field(d,'input',spec.title+' API key',{type:'password',placeholder:savedProfile?.credentialPersisted?'Stored credential will be reused; enter a new key only to replace it':'Required when the provider requires authentication',autocomplete:'off',spellcheck:'false'});
  const capabilities=field(d,'input',spec.title+' capabilities',{type:'text',placeholder:spec.defaultCapabilities.join(', ')});
  capabilities.value=draft.capabilities??spec.defaultCapabilities.join(', ');
  if(spec.fixedCapabilities){
    capabilities.disabled=true;capabilities.setAttribute('aria-disabled','true');capabilities.title='Jev capability is fixed by the owner contract.';
  }
  const draftModels=Array.isArray(draft.models)?draft.models:[];
  const modelListId='nexus-model-list-'+String(spec.id).replace(/[^a-z0-9_-]/gi,'-');
  const modelChoice=field(d,'input',spec.title+' model',{type:'text',placeholder:'Type or choose a model ID',autocomplete:'off',list:modelListId});
  const modelSuggestions=element(d,'datalist',{attrs:{id:modelListId}});
  for(const modelRow of draftModels)modelSuggestions.append(option(d,modelRow.id,modelRow.label));
  modelChoice.value=draft.manualModel??draft.selectedModel??'';
  const discoveryState=element(d,'p',{className:'nexus-wave13-connection-slot__hint',text:draft.discoveryMessage??(caps.discoverModels?'Load models from the provider before testing the connection. Choosing a model does not prove the connection works.':'Worker 2 model discovery is not exported here. Manual model entry is available only as a compatibility fallback.')});
  const updateDraft=()=>connectionDrafts.patch(spec.id,{
    connectionName:String(connectionName.value||spec.defaultName),endpoint:String(endpoint.value||''),capabilities:String(capabilities.value||''),
    selectedModel:String(modelChoice.value||''),manualModel:String(modelChoice.value||''),
  });
  listenField(scope,connectionName,'input',updateDraft);listenField(scope,endpoint,'input',updateDraft);listenField(scope,capabilities,'input',updateDraft);
  listenField(scope,modelChoice,'input',updateDraft);listenField(scope,modelChoice,'change',updateDraft);
  const loadModels=createButton(d,{label:'Load / Refresh Models',scope,size:'sm',variant:'quiet',disabled:!caps.discoverModels,onPress:async()=>{
    updateDraft();
    const parsedCaps=String(capabilities.value||'').split(',').map(x=>x.trim()).filter(Boolean);
    const result=await actionRouter.route({type:'wave13.resource.discoverModels',payload:{
      role:spec.role,transportKind:'OPENAI_COMPATIBLE',endpoint:endpoint.value||null,apiKey:apiKey.value||null,capabilities:parsedCaps,
    }});
    if(!result.ok){
      const text='Model discovery failed: '+connectionDisplayText(result.error??'unknown error')+'.';
      connectionDrafts.patch(spec.id,{models:[],manualAllowed:true,discoveryState:'FAILED',discoveryMessage:text});
      modelSuggestions.replaceChildren();discoveryState.textContent=text+' You can still enter the exact model ID manually; Test Connection will verify it.';
      reportAction(notifications,result,spec.title+' model discovery');return;
    }
    const discovery=result.result??{},models=discoveryModels(discovery),state=String(discovery.state??'FAILED').toUpperCase(),statusText=discoveryStatusText(state,discovery,models.length);
    connectionDrafts.patch(spec.id,{models,manualAllowed:true,discoveryState:state,discoveryMessage:statusText});
    modelSuggestions.replaceChildren();
    for(const modelRow of models)modelSuggestions.append(option(d,modelRow.id,modelRow.label));
    discoveryState.textContent=statusText;reportAction(notifications,result,spec.title+' model discovery');
  }});
  const testConnection=createButton(d,{label:'Save, Lock & Test Connection',scope,onPress:async()=>{
    updateDraft();
    const selectedModel=String(modelChoice.value||'').trim();
    if(!selectedModel){
      discoveryState.textContent='Enter a model ID. Load models to get suggestions; qualification will verify the exact ID you submit.';
      return;
    }
    const parsedCaps=String(capabilities.value||'').split(',').map(x=>x.trim()).filter(Boolean);
    const connectResult=await actionRouter.route({type:'wave13.resource.connect',payload:{
      role:spec.role,displayName:connectionName.value||spec.defaultName,transportKind:'OPENAI_COMPATIBLE',
      endpoint:endpoint.value||null,modelId:selectedModel,apiKey:apiKey.value||null,capabilities:parsedCaps,local:isLocalConnectionEndpoint(endpoint.value),
    }});
    apiKey.value='';
    if(!connectResult.ok){
      discoveryState.textContent='Connection failed: '+connectionDisplayText(connectResult.error??'unknown error')+'.';
      reportAction(notifications,connectResult,spec.title+' connection');refresh?.();return;
    }
    connectionDrafts.clear(spec.id);
    const connectedRow=resources.read().data.resources.find(row=>connectionSlotFor(row)===spec.id);
    const testResult=connectedRow?await actionRouter.route({type:'wave13.resource.test',target:connectedRow}):connectResult;
    const testFailure=resourceTestFailure(testResult);
    discoveryState.textContent=testFailure?'Connection test failed: '+testFailure:'Connection test passed. Owner-reported status is shown in the locked resource card.';
    reportResourceTest(notifications,testResult,spec.title+' connection test');refresh?.();
  }});
  form.append(
    labelWrap(d,'Connection name',connectionName),labelWrap(d,'Endpoint',endpoint),labelWrap(d,'API key',apiKey),labelWrap(d,'Capabilities',capabilities),
    loadModels,labelWrap(d,'Model',modelChoice),modelSuggestions,discoveryState,
    ...(savedProfile?[message(d,'Saved lock loaded','The saved '+spec.title+' endpoint, model, capabilities, identity'+(savedProfile.credentialPersisted?', and credential':'')+' are retained. Stored credentials are reused without being rendered back into this form.','ready')]:[]),
    element(d,'p',{className:'nexus-wave13-connection-slot__hint',text:'Save & Lock persists this connection in browser/extension storage. It stays available across reloads until Release saved lock is used.'}),
    testConnection,
    ...(savedProfile?[createButton(d,{label:'Release saved lock',scope,size:'sm',variant:'quiet',onPress:async()=>{
      const result=await actionRouter.route({type:'wave13.resource.forgetSaved',target:savedProfile});
      if(result.ok){connectionDrafts.clear(spec.id);notifications?.push?.({message:'Released saved '+spec.title+' lock. Stored profile and credential were removed.',status:'info'});}
      else reportAction(notifications,result,'Saved connection lock release');
      refresh?.();
    }})]:[])
  );
  slot.append(form);return slot;
}

function renderLockedResource(d,{row,spec,savedProfile=null,resources,actionRouter,scope,refresh,notifications,caps,connectionDrafts}){
  const card=element(d,'article',{className:'nexus-card nexus-wave13-resource nexus-wave13-resource--compact',dataset:{health:row.health,saved:String(Boolean(savedProfile))}});
  const top=element(d,'div',{className:'nexus-inline-status nexus-wave13-resource__top'});
  top.append(
    element(d,'strong',{text:row.displayName??'Connected resource'}),
    makeBadge(d,row.state??row.health,resourceStatus(row.health)),
    ...(savedProfile?[makeBadge(d,'SAVED','observed')]:[])
  );

  const latestTest=String(row.lastTest?.status??'').toUpperCase();
  const failedTest=['FAIL','FAILED','ERROR'].includes(latestTest);
  const summary=element(d,'div',{className:'nexus-wave13-resource-summary'});
  summary.append(
    compactFact(d,'Model',row.actualModelId??row.modelId??'—'),
    compactFact(d,'Provider',row.actualProvider??row.providerId??'—'),
    compactFact(d,'Health',row.health??'—'),
    compactFact(d,'Connection',row.callable?'Ready':humanLabel(row.state??'Configured'))
  );
  card.append(top,summary);

  if(latestTest){
    const status=element(d,'div',{className:'nexus-wave13-resource-test',dataset:{status:failedTest?'error':'ready'}});
    status.append(
      element(d,'strong',{text:'Test '+latestTest}),
      element(d,'span',{text:failedTest?String(row.lastFailure?.message??row.reason??row.lastTest?.failureCode??'Provider check failed.'):row.lastTest?.latencyMs!=null?String(row.lastTest.latencyMs)+' ms':'Passed'})
    );
    card.append(status);
  }

  if(!row.callable)card.append(message(d,'Not ready',row.reason??'This connection has not passed its provider test yet.','warning'));

  const actions=element(d,'div',{className:'nexus-wave13-resource-actions nexus-wave13-resource-actions--primary'});
  if(caps.connect&&!row.callable)actions.append(createButton(d,{label:row.connected?'Requalify':'Connect / qualify',scope,size:'sm',onPress:async()=>{const result=await actionRouter.route({type:'wave13.resource.connect',target:row});reportAction(notifications,result,'Resource qualification');refresh?.();}}));
  if(caps.test)actions.append(createButton(d,{label:'Test',scope,size:'sm',onPress:async()=>{const result=await actionRouter.route({type:'wave13.resource.test',target:row});reportResourceTest(notifications,result,'Resource test');refresh?.();}}));
  if(caps.disconnect&&row.connected)actions.append(createButton(d,{label:'Disconnect',scope,size:'sm',variant:'quiet',onPress:async()=>{const result=await actionRouter.route({type:'wave13.resource.disconnect',target:row});reportAction(notifications,result,'Resource disconnect');refresh?.();}}));
  if(savedProfile)actions.append(createButton(d,{label:'Release lock',scope,size:'sm',variant:'quiet',onPress:async()=>{
    const result=await actionRouter.route({type:'wave13.resource.forgetSaved',target:row});
    if(result.ok)notifications?.push?.({message:'Released saved '+(spec?.title??'resource')+' lock. Stored profile and credential were removed.',status:'info'});
    else reportAction(notifications,result,'Saved connection lock release');
    refresh?.();
  }}));
  if(actions.children?.length)card.append(actions);

  const details=element(d,'details',{className:'nexus-wave13-resource-details'});
  details.append(element(d,'summary',{text:'Details'}));
  const detailBody=element(d,'div',{className:'nexus-wave13-resource-details__body'});
  detailBody.append(createKeyValue(d,[
    {key:'Saved across reloads',value:savedProfile?'Yes':'No'},
    {key:'Credential saved',value:savedProfile?.credentialPersisted?'Yes':savedProfile?'No':'Not locked'},
    {key:'Connection',value:row.state??(row.connected?'CONNECTED':'DISCONNECTED')},
    {key:'Availability',value:row.availability??'Not reported'},
    {key:'Physical execution',value:row.physicalExecutionAttempted?(row.physicalExecutionSucceeded?'Succeeded':'Attempted / not successful'):'None observed'},
    {key:'Owner accepted',value:row.ownerAccepted===true?'Yes':row.ownerAccepted===false?'No':row.ownerAcceptanceSource==='OWNER_RECEIPT_REQUIRED'?'Requires owner receipt':'Not reported'},
    {key:'Transport',value:row.transportKind??'—'},
    {key:'Concurrency',value:String(row.currentLoad)+' / '+String(row.concurrencyCapacity)},
    {key:'Capabilities',value:(row.capabilities??row.declaredCapabilities??[]).join(', ')||'none published'},
  ]));

  const discovered=Array.isArray(row.modelDiscovery?.models)?row.modelDiscovery.models:[];
  const modelListId='nexus-model-list-locked-'+String(row.id??row.resourceId??'resource').replace(/[^a-z0-9_-]/gi,'-');
  const model=field(d,'input',(spec?.title??row.kind??'Resource')+' qualified model',{type:'text',placeholder:'Type or choose a model ID',autocomplete:'off',list:modelListId});
  const modelSuggestions=element(d,'datalist',{attrs:{id:modelListId}});
  for(const item of discovered)modelSuggestions.append(option(d,String(item.id??item.modelId??''),String(item.displayName??item.name??item.id??item.modelId??'model')));
  model.value=String(row.modelId??'');
  const managementStatus=element(d,'p',{className:'nexus-wave13-connection-slot__hint',attrs:{role:'status','aria-live':'polite'},text:'Model changes require another connection test.'});
  const manageActions=element(d,'div',{className:'nexus-wave13-resource-actions'});
  if(caps.refreshModels)manageActions.append(createButton(d,{label:'Refresh models',scope,size:'sm',variant:'quiet',onPress:async()=>{
    const result=await actionRouter.route({type:'wave13.resource.refreshModels',target:row});reportAction(notifications,result,'Configured resource model refresh');refresh?.();
  }}));
  if(caps.selectModel)manageActions.append(createButton(d,{label:'Select model',scope,size:'sm',variant:'quiet',onPress:async()=>{
    const modelId=String(model.value||'').trim();if(!modelId){managementStatus.textContent='Enter a model ID first.';return;}
    const result=await actionRouter.route({type:'wave13.resource.selectModel',target:row,payload:{modelId}});
    managementStatus.textContent=result.ok?'Model selected. Test the connection again before use.':'Model selection failed: '+connectionDisplayText(result.error??'unknown error');
    reportAction(notifications,result,'Configured resource model selection');refresh?.();
  }}));
  if(manageActions.children?.length)detailBody.append(labelWrap(d,'Model',model),modelSuggestions,manageActions,managementStatus);
  details.append(detailBody);card.append(details);
  return card;
}

function compactFact(d,label,value){
  const item=element(d,'div',{className:'nexus-wave13-resource-summary__item'});
  item.append(element(d,'span',{text:label}),element(d,'strong',{text:String(value??'—')}));
  return item;
}

function loadMetric(value){if(!value)return'NO_EVIDENCE';return String(value.count??0)+' samples · '+String(value.avgMs??0)+' ms avg · '+String(value.maxMs??0)+' ms max';}
function resourceStatus(v){if(v==='HEALTHY')return'ready';if(v==='UNVERIFIED')return'warning';if(v==='DEGRADED'||v==='SATURATED'||v==='COOLDOWN'||v==='PROBE')return'warning';return'offline';}
function testSummary(x){
  if(x?.failure||String(x?.resource?.lastTest?.status??'').toUpperCase()==='FAIL')return'FAIL';
  if(String(x?.resource?.lastTest?.status??'').toUpperCase()==='PASS')return'PASS';
  return String(x?.status??x?.health??x?.result?.status??(x?.ok===true?'PASS':x?.ok===false?'FAIL':'completed'));
}
function resourceTestFailure(actionResult){
  if(!actionResult?.ok)return connectionDisplayText(actionResult?.error??'Owner test action failed.');
  const owner=actionResult.result??{};
  if(owner.failure)return String(owner.failure.message??owner.failure.code??'Provider check failed.');
  const resource=owner.resource??owner;
  if(String(resource?.lastTest?.status??'').toUpperCase()==='FAIL')return String(resource?.lastFailure?.message??resource?.reason??resource?.lastTest?.failureCode??'Provider check failed.');
  if(['UNAVAILABLE'].includes(String(resource?.state??'').toUpperCase())&&resource?.lastFailure)return String(resource.lastFailure.message??resource.reason??'Provider is unavailable.');
  return null;
}
function reportResourceTest(notifications,result,label){
  if(!notifications?.push)return;
  const failure=resourceTestFailure(result);notifications.push({status:failure?'error':'success',message:label+': '+(failure??'passed')});
}
function reportAction(notifications,result,label){if(!notifications?.push)return;notifications.push({status:result?.ok?'success':'error',message:label+': '+(result?.ok?'completed':connectionDisplayText(result?.error??'failed'))});}


function createConnectionDraftStore(){
  const drafts=new Map();
  const initial=(spec)=>({connectionName:spec.defaultName,endpoint:'',capabilities:spec.defaultCapabilities.join(', '),models:[],selectedModel:'',manualModel:'',manualAllowed:false,discoveryState:null,discoveryMessage:null});
  return{
    get(spec){if(!drafts.has(spec.id))drafts.set(spec.id,initial(spec));return drafts.get(spec.id);},
    patch(id,patch){const current=drafts.get(id)??{};drafts.set(id,{...current,...patch});return drafts.get(id);},
    clear(id){drafts.delete(id);},
  };
}

function listenField(scope,node,type,handler){if(scope?.listen)scope.listen(node,type,handler);else node.addEventListener(type,handler);}

function discoveryModels(result){
  const raw=Array.isArray(result?.models)?result.models:[];
  return raw.map((row,index)=>{
    if(typeof row==='string')return{id:row,label:row};
    const id=String(row?.id??row?.modelId??row?.name??'').trim();
    if(!id)return null;
    const label=String(row?.displayName??row?.label??row?.name??id);
    return{id,label};
  }).filter(Boolean);
}

function discoveryStatusText(state,result,count){
  const reason=connectionDisplayText(result?.reason??'').trim();
  if(state==='READY')return count+' model'+(count===1?'':'s')+' loaded. Type to filter suggestions, or enter an exact model ID manually. Test Connection performs qualification.';
  if(state==='UNAUTHORIZED')return (reason||'Provider authorization was rejected before model discovery.')+' You can still enter a model ID manually; qualification still requires provider access.';
  if(state==='UNSUPPORTED')return (reason||'This provider does not support model discovery.')+' Enter the exact model ID manually.';
  if(state==='EMPTY')return (reason||'The provider returned no selectable models.')+' Enter the exact model ID manually.';
  if(state==='UNREACHABLE')return reason||'The provider endpoint could not be reached.';
  if(state==='LOADING')return'Loading models from the provider…';
  return reason||'Model discovery failed.';
}

function connectionDisplayText(value){return String(value??'').replace(/\bsession credentials?\b/gi,'credential');}

function safeCoprocessorResourceRows(coprocessor){
  try{
    const read=coprocessor?.read?.(),rows=read?.data?.resources;
    return Array.isArray(rows)?rows:[];
  }catch{return[];}
}

function overlayTurnResourceEvidence(row,turnRows=[]){
  const turn=turnRows.find(item=>String(item?.resourceId??item?.id??'')===String(row?.id??''));
  if(!turn)return row;
  return{
    ...row,
    physicalExecutionAttempted:Boolean(turn.physicalExecutionAttempted??row.physicalExecutionAttempted),
    physicalExecutionSucceeded:Boolean(turn.physicalExecutionSucceeded??row.physicalExecutionSucceeded),
    ownerAccepted:typeof turn.ownerAccepted==='boolean'?turn.ownerAccepted:row.ownerAccepted,
    ownerAcceptanceSource:typeof turn.ownerAccepted==='boolean'?'SELECTED_TURN_OWNER_RECEIPT':row.ownerAcceptanceSource,
  };
}

function connectionSlotSpecs(){return[
  {id:'SIDECAR_A',title:'Sidecar A',role:'SIDECAR_A',defaultName:'Sidecar A',description:'First optional execution sidecar. Nexus routing decides which admitted work reaches this lane.',defaultCapabilities:['STRUCTURED_EXTRACTION'],fixedCapabilities:false},
  {id:'SIDECAR_B',title:'Sidecar B',role:'SIDECAR_B',defaultName:'Sidecar B',description:'Second optional execution sidecar with its own profile, credential, health, and connection lifecycle.',defaultCapabilities:['STRUCTURED_EXTRACTION'],fixedCapabilities:false},
  {id:'JEV',title:'Jev',role:'JEV',defaultName:'Jev',description:'Semantic judgment connector used by Nexus decision sites. The UI configures the connection; runtime owners decide when Jev runs.',defaultCapabilities:['SEMANTIC_JUDGMENT'],fixedCapabilities:true},
  {id:'VECTORING',title:'Vectoring',role:'VECTORING',defaultName:'Vectoring',description:'Embedding/vector connector used by Nexus vector paging and retrieval support.',defaultCapabilities:['RETRIEVAL','EMBED'],fixedCapabilities:false},
];}

function isLocalConnectionEndpoint(value){try{const host=new URL(String(value??'')).hostname.toLowerCase();return host==='127.0.0.1'||host==='localhost'||host==='::1'||host.endsWith('.local');}catch{return false;}}

function connectionSlotFor(row){
  const capabilities=new Set([...(row.capabilities??[]),...(row.declaredCapabilities??[]),...(row.activeCapabilities??[])].map(String));
  if(capabilities.has('SEMANTIC_JUDGMENT'))return'JEV';
  if(['EMBED','RETRIEVAL','RETRIEVAL_QUALITY','RERANK','LATE_INTERACTION','CROSS_ENCODER_RERANK'].some(capability=>capabilities.has(capability)))return'VECTORING';
  const hint=[row?.id,row?.resourceId,row?.providerProfileId,row?.workerId,row?.displayName].filter(Boolean).map(String).join(' ');
  if(/sidecar(?:[-_: ]+)b(?:\b|$)/i.test(hint))return'SIDECAR_B';
  return'SIDECAR_A';
}

export function renderFanoutGatherSurface(host,{cognition,scope,inspect}={}){
  const d=host.ownerDocument,section=element(d,'section',{className:'nexus-wave13-swarm',attrs:{'aria-label':'Sidecar fan-out and Gather'}});
  section.append(element(d,'h2',{text:'Fan-out → Gather'}));
  if(!cognition?.read){section.append(message(d,'Brain trace unavailable','The assembly does not expose the selected-turn cognition read model.','offline'));host.append(section);return;}
  const read=cognition.read(),data=read?.data,selection=data?.bindingSelection??{};
  if(!selection.turnId){
    section.append(message(d,'Waiting for an active turn','Connection health remains available above. Fan-out and Gather appear only when the selected chat publishes a turn.','historical'));host.append(section);return;
  }
  const choice=data?.choice??null,scatter=data?.scatter??null,gather=data?.gather??null,seal=data?.seal??null,jev=data?.jev??null;
  const jobs=scatter?.jobs??[],resourceIds=[...new Set(jobs.map(row=>row.resourceId).filter(Boolean))],gatherRows=gather?.results??[];
  const summary=element(d,'div',{className:'nexus-wave13-flow-summary'});
  summary.append(flowStep(d,'Choice',choice?String(choice.admitted?.length??0)+' admitted · '+String(choice.skipped?.length??0)+' skipped':'No Choice receipt'),
    flowStep(d,'Fan-out',scatter?jobs.length+' logical jobs → '+resourceIds.length+' mapped resource identit'+(resourceIds.length===1?'y':'ies'):'No Scatter receipt'),
    flowStep(d,'Gather',gather?String(gather.counts?.ADMITTED??0)+' admitted · '+String((gather.counts?.LATE??0)+(gather.counts?.STALE??0)+(gather.counts?.REJECTED??0)+(gather.counts?.INVALID??0))+' contained':'No Gather receipt'));
  section.append(summary);

  if(jev){
    const jevCard=element(d,'section',{className:'nexus-card'});
    jevCard.append(element(d,'div',{className:'nexus-inline-status'},element(d,'strong',{text:'Jev decision'}),makeBadge(d,jev.outcome??jev.state??'AVAILABLE',jev.state==='DEGRADED'||jev.state==='UNAVAILABLE'?'warning':'observed')));
    jevCard.append(createKeyValue(d,[{key:'Resource',value:jev.resourceId??'owner did not publish resource id'},{key:'Provider',value:jev.provider??'—'},{key:'Model',value:jev.model??'—'},{key:'Outcome',value:jev.outcome??jev.state??'—'}]));
    section.append(jevCard);
  }

  if(jobs.length){
    section.append(element(d,'h3',{text:'Logical jobs / published resource mapping'}));
    const list=element(d,'div',{className:'nexus-wave13-flow-list'});
    for(const job of jobs){
      const row=element(d,'div',{className:'nexus-wave13-flow-row'});
      row.append(element(d,'strong',{text:job.capability??job.jobId??'Cognitive job'}),element(d,'code',{text:job.resourceId??'native / unreported'}),makeBadge(d,String(job.state??'UNKNOWN'),flowStatus(job.state)));
      list.append(row);
    }
    section.append(list);
  }else section.append(message(d,'No fan-out receipt','The selected turn did not publish Scatter jobs. The UI will not infer sidecar use from registered resources.','historical'));

  if(gatherRows.length){
    section.append(element(d,'h3',{text:'Gather results'}));
    const sealIds=new Set(seal?.effectiveAdmittedResultIds??seal?.admittedResultIds??[]),list=element(d,'div',{className:'nexus-wave13-flow-list'});
    for(const result of gatherRows){
      const sealed=result.resultId&&sealIds.has(result.resultId),contained=['LATE','STALE','INVALID','REJECTED'].includes(String(result.status).toUpperCase());
      const row=element(d,'div',{className:'nexus-wave13-flow-row'});
      row.append(element(d,'strong',{text:result.capability??result.resultId??'Result'}),element(d,'code',{text:(result.resourceId??result.sourceSubsystem??'owner')+(result.destination?' → '+result.destination:'')}),makeBadge(d,sealed?'SEALED':contained?String(result.status):String(result.status??'RETURNED'),sealed?'canonical':contained?'warning':'observed'));
      list.append(row);
    }
    section.append(list);
  }else if(gather)section.append(message(d,'Gather summary only','Gather published counts/evidence but no per-result rows. No result-level Seal admission is inferred.','historical'));
  else section.append(message(d,'Gather unavailable','No Gather receipt is published for the selected turn.','offline'));

  if(seal){
    const safe=seal.effectiveAdmittedResultIds??seal.admittedResultIds??[];
    section.append(element(d,'p',{className:'nexus-muted',text:'Context Seal owner reports '+safe.length+' result id'+(safe.length===1?'':'s')+' safely admitted. Late/stale/invalid/rejected Gather results remain visible but are not relabeled as prompt contributions.'}));
  }
  if(inspect&&scatter)section.append(createButton(d,{label:'Inspect Scatter receipt',scope,size:'sm',variant:'inspect',onPress:()=>inspect({kind:'wave13-scatter-trace',id:scatter.receiptId??selection.turnId,title:'Scatter / fan-out',available:true,receiptRef:scatter.receiptId??null,selection:{...selection},payload:scatter})}));
  if(inspect&&gather)section.append(createButton(d,{label:'Inspect Gather receipt',scope,size:'sm',variant:'inspect',onPress:()=>inspect({kind:'wave13-gather-trace',id:gather.receiptId??selection.turnId,title:'Gather',available:true,receiptRef:gather.receiptId??null,selection:{...selection},payload:gather})}));
  host.append(section);
}

export function renderSettingsSurface(host,{productAdapter,frontFacePresentation,scope,refresh}={}){
  const d=host.ownerDocument,root=element(d,'section',{className:'nexus-wave13-settings'});
  root.append(header(d,'Settings','Nexus display, motion, and density preferences. Runtime telemetry, evidence, errors, resources, Lore/Memory status, and performance live in Diagnostics.'));
  const detail=element(d,'section',{className:'nexus-wave13-settings__group'});
  detail.append(element(d,'strong',{text:'Detail level'}),element(d,'p',{className:'nexus-muted',text:'Normal keeps product pages concise; Detail and Advanced progressively expose more owner-backed evidence on the pages where it belongs.'}));
  const detailActions=element(d,'div',{className:'nexus-wave13-resource-actions'});
  for(const level of Object.values(ProductDetailLevel)){
    const button=createButton(d,{label:humanLabel(level),scope,size:'sm',onPress:()=>{productAdapter?.setDetailLevel?.(level);refresh?.();}});
    button.setAttribute('aria-pressed',String(productAdapter?.getDetailLevel?.()===level));detailActions.append(button);
  }
  detail.append(detailActions);root.append(detail);
  const display=element(d,'section',{className:'nexus-wave13-settings__group'}),state=frontFacePresentation?.get?.()??{};
  display.append(element(d,'strong',{text:'Panel display'}),element(d,'p',{className:'nexus-muted',text:'Use the rail or panel drag handle to move Nexus. Use the ↔ Resize handle on the panel edge to change width. Inspect actions now open a temporary drawer instead of reserving permanent screen space.'}));
  const displayActions=element(d,'div',{className:'nexus-wave13-resource-actions'});
  for(const density of ['COMPACT','COMFORTABLE']){
    const button=createButton(d,{label:humanLabel(density),scope,size:'sm',onPress:()=>{frontFacePresentation?.setDensity?.(density);refresh?.();}});
    button.setAttribute('aria-pressed',String(state.frontFaceDensity===density));displayActions.append(button);
  }
  display.append(displayActions);root.append(display);
  const motion=element(d,'section',{className:'nexus-wave13-settings__group'});
  motion.append(
    element(d,'strong',{text:'Motion & animation'}),
    element(d,'p',{className:'nexus-muted',text:'Full is the Nexus default and ignores the operating system reduced-motion preference. Switch to System or Reduced if animation causes accessibility or performance issues.'})
  );
  const motionActions=element(d,'div',{className:'nexus-wave13-resource-actions'});
  const motionMode=state.motionMode??'FULL';
  for(const [mode,labelText] of [['FULL','Full (recommended)'],['SYSTEM','System'],['REDUCED','Reduced']]){
    const button=createButton(d,{label:labelText,scope,size:'sm',onPress:()=>{frontFacePresentation?.setMotionMode?.(mode);refresh?.();}});
    button.setAttribute('aria-pressed',String(motionMode===mode));
    button.dataset.motionMode=mode;
    motionActions.append(button);
  }
  motion.append(motionActions,element(d,'p',{className:'nexus-muted',text:motionMode==='FULL'?'Nexus animations run even when Windows/browser reduced-motion is enabled.':motionMode==='SYSTEM'?'Nexus follows the operating system/browser motion preference.':'Nonessential Nexus animations are suppressed.'}));
  root.append(motion);
  host.append(root);
}
export function renderDiagnosticsCenter(d,{diagnostics,evidenceJournal,scope,inspect,navigate,detailLevel=ProductDetailLevel.NORMAL}={}){
  const snapshot=diagnostics.read(),center=element(d,'section',{className:'nexus-wave13-settings__group nexus-wave13-diagnostics',attrs:{'aria-label':'Diagnostics Center'}});
  const head=element(d,'div',{className:'nexus-wave13-section-head'});
  const unhealthy=(snapshot.producers?.failures??0)>0||snapshot.resources?.rows?.some(row=>['DEGRADED','UNAVAILABLE'].includes(String(row.state))||['DEGRADED','UNAVAILABLE','COOLDOWN'].includes(String(row.health)));
  head.append(element(d,'strong',{text:'Diagnostics Center'}),makeBadge(d,unhealthy?'ATTENTION':snapshot.host?.waitingForTurn?'WAITING':'LIVE',unhealthy?'warning':snapshot.host?.waitingForTurn?'historical':'ready'));
  const advanced=detailLevel===ProductDetailLevel.ADVANCED;
  center.append(head,element(d,'p',{className:'nexus-muted',text:'Operational read-only summary for the selected chat/turn. This is not a complete forensic transaction timeline. Owner receipts, resource health, routing evidence, and failures appear here. Raw prompts, story/lore bodies, credentials, keys, and hidden reasoning are excluded from retained/exported UI evidence.'}));
  const selection=snapshot.selection??{};
  center.append(createKeyValue(d,advanced?[
    {key:'Chat ID',value:selection.chatId??'none'},{key:'Turn ID',value:selection.turnId??'waiting'},{key:'Generation ID',value:selection.generationId??'waiting'},
    {key:'World / Scene revision',value:(selection.worldRevision??'—')+' / '+(selection.sceneRevision??'—')},
    {key:'Live-binding reads',value:snapshot.host?.liveBinding?.reads??'—'},{key:'Rejected stale/foreign reads',value:snapshot.host?.liveBinding?.rejected??0},
  ]:[
    {key:'Selected chat',value:selection.chatId?'Current chat selected':'No chat selected'},{key:'Turn',value:selection.turnId?'Active turn':'Waiting for turn'},{key:'Generation',value:selection.generationId?'Active generation':'Waiting for generation'},
    {key:'Owner read coherence',value:(snapshot.host?.liveBinding?.rejected??0)>0?'Stale/foreign reads contained':'Current selection coherent'},
  ]));
  const copro=snapshot.coprocessor?.summary??{},resourceTelemetry=copro.resourceTelemetry??{},providerCalls=copro.providerCalls??{};
  center.append(element(d,'h3',{text:'Coprocessor telemetry'}),createKeyValue(d,[
    {key:'Events',value:copro.totalEvents??0},{key:'Warm hit / miss',value:(copro.warm?.hit??0)+' / '+(copro.warm?.miss??0)},
    {key:'Fallback / stale drop',value:(copro.fallback??0)+' / '+(copro.staleDrop??0)},{key:'Retries',value:copro.retry??0},
    {key:'Resource tests pass / fail',value:(resourceTelemetry.testsPassed??0)+' / '+(resourceTelemetry.testsFailed??0)},
    {key:'Resource executions success / fail',value:(resourceTelemetry.executionsSucceeded??0)+' / '+(resourceTelemetry.executionsFailed??0)},
    {key:'Provider calls invoked / failed',value:(providerCalls.invoked??0)+' / '+(providerCalls.failed??0)},
  ]));
  const runtime=snapshot.runtime?.summary??{},runtimeCounts=runtime.lifecycleCounts??{};
  center.append(element(d,'h3',{text:'Runtime lifecycle telemetry'}),createKeyValue(d,[
    {key:'Queued by layer',value:Object.entries(runtime.queueDepth??{}).map(([key,value])=>key+': '+value).join(' · ')||'Not published'},
    {key:'Active / yielding',value:(runtimeCounts.ACTIVE??0)+' / '+(runtimeCounts.YIELDING??0)},{key:'Parked / recovering',value:(runtimeCounts.PARKED??0)+' / '+(runtimeCounts.RECOVERING??0)},
    {key:'Complete / failed',value:(runtimeCounts.COMPLETE??0)+' / '+(runtimeCounts.FAILED??0)},{key:'Borrowed background leases',value:runtime.borrowedBackgroundLeases??'Not published'},
    {key:'Retained signals / sink failures',value:(runtime.retainedSignals??'—')+' / '+(runtime.telemetrySinkFailures??'—')},
    {key:'Batch history',value:runtime.batchProgressAvailable===false?'Not published by owner snapshot':runtime.batchProgressAvailable?'Published':'Not available'},
    {key:'Late-result history',value:runtime.lateResultHistoryAvailable===false?'Not published by owner snapshot':runtime.lateResultHistoryAvailable?'Published':'Not available'},
  ]));
  const nexusTelemetry=snapshot.telemetry?.nexus??{};
  const observability=nexusTelemetry.observability??{},decisionTelemetry=nexusTelemetry.decision??{},retrievalTelemetry=nexusTelemetry.retrieval??{};
  const runtimeTelemetry=nexusTelemetry.runtime??{},queueTelemetry=nexusTelemetry.queue??{},generationFrameTelemetry=nexusTelemetry.generationFrame??{};
  const sceneTelemetry=nexusTelemetry.scene??{},mainBridgeTelemetry=nexusTelemetry.mainBridge??{},worldTreeTelemetry=nexusTelemetry.worldTree??{};
  const subsystemStatus=nexusTelemetry.subsystems??{};
  const nexusEvents=Array.isArray(observability.events)?observability.events:[],promptEvents=nexusEvents.filter(row=>['prompt-loader','main-request'].includes(String(row?.category??'')));
  const probeRows=Array.isArray(snapshot.probes?.resources)?snapshot.probes.resources:[];
  center.append(element(d,'h3',{text:'Central Nexus telemetry'}),createKeyValue(d,[
    {key:'Observability events',value:nexusEvents.length},
    ...Object.entries(nexusTelemetry.systems?.channels??{}).map(([channel,event])=>({key:channel,value:event?(event.data?.status??event.name??'Observed'):'No events yet'})),
    {key:'Prompt Loader / Main request',value:promptEvents.length},
    {key:'Decision total / provider failures',value:(decisionTelemetry.totalDecisions??0)+' / '+(decisionTelemetry.providerFailures??0)},
    {key:'Decision stale results',value:decisionTelemetry.staleResults??0},
    {key:'Retrieval candidates / history',value:(retrievalTelemetry.candidates?.length??0)+' / '+(retrievalTelemetry.history?.length??0)},
    {key:'Runtime coordinator active',value:runtimeTelemetry.coordinator?.active?.length??0},
    {key:'Queue queued / running',value:(queueTelemetry.queued?.length??0)+' / '+(queueTelemetry.running?.length??0)},
    {key:'Generation Frame',value:generationFrameTelemetry.state??generationFrameTelemetry.status??'Not published'},
    {key:'Scene Scanner',value:sceneTelemetry?.degraded?'DEGRADED':sceneTelemetry?.acceptedScene?'READY':sceneTelemetry?'OBSERVING':'Not published'},
    {key:'Main bridge',value:mainBridgeTelemetry?.fullyConnected?'Fully connected':mainBridgeTelemetry?.connected?'Connected':'Disconnected'},
    {key:'World Tree revision / nodes',value:(worldTreeTelemetry.worldRevision??'—')+' / '+(worldTreeTelemetry.counts?.nodes??'—')},
    {key:'World Tree Memory/Character sync',value:worldTreeTelemetry.legacyWorldBridge?.lastSync?.reason??(worldTreeTelemetry.legacyWorldBridge?.installed?'Installed':'Not installed')},
    {key:'World Tree Lore sync',value:worldTreeTelemetry.legacyLoreBridge?.lastSync?.reason??(worldTreeTelemetry.legacyLoreBridge?.installed?'Installed':'Not installed')},
  ]));
  center.append(element(d,'p',{className:'nexus-muted',text:'Diagnostics is the sole UI destination for Nexus telemetry and probe evidence. The feed is metadata-only and redacts raw prompts, provider bodies, credentials, hidden reasoning, and story/lore bodies before presentation.'}));
  center.append(element(d,'h3',{text:'Nexus subsystem status'}),createKeyValue(d,[
    {key:'Maintenance',value:subsystemStatus.maintenance?.lastStatus??'No run recorded'},
    {key:'Paging',value:subsystemStatus.paging?.mode??'No status recorded'},
    {key:'Paging index',value:subsystemStatus.paging?.indexReady==null?'No status recorded':subsystemStatus.paging.indexReady?'Ready':'Building or empty'},
    {key:'Postturn pending',value:subsystemStatus.postturn?.pendingCount??'No status recorded'},
    {key:'Smart Context',value:subsystemStatus.smartContext?subsystemStatus.smartContext.status??'Owner statistics available':'No warm run recorded'},
  ]));

  if(nexusEvents.length){
    const list=element(d,'div',{className:'nexus-wave13-diagnostic-events'});
    for(const event of nexusEvents.slice(-60).reverse()){
      const line=element(d,'div',{className:'nexus-wave13-diagnostic-event'});
      line.append(
        element(d,'span',{text:String(event.data?.channelId??event.category??'telemetry')}),
        element(d,'strong',{text:String(event.name??'event')}),
        makeBadge(d,String(event.level??'info').toUpperCase(),['error','warn'].includes(String(event.level??'').toLowerCase())?'warning':'observed')
      );
      if(advanced&&event.ts!=null)line.append(element(d,'code',{text:String(event.ts)}));
      if(inspect)line.append(createButton(d,{label:'Inspect',scope,size:'sm',variant:'quiet',onPress:()=>inspect({kind:'nexus-telemetry-event',id:String(event.id??event.ts??event.name??'event'),title:(event.category??'Telemetry')+' · '+(event.name??'event'),payload:event})}));
      list.append(line);
    }
    center.append(element(d,'h4',{text:'Recent telemetry events'}),list);
  }else center.append(message(d,'No Nexus telemetry events yet','Runtime telemetry and Prompt Loader/Main request events will appear here when their owners publish them.','historical'));

  const probeList=element(d,'div',{className:'nexus-wave13-diagnostic-events'});
  const mainProbe=snapshot.probes?.mainBridge??{};
  const mainProbeLine=element(d,'div',{className:'nexus-wave13-diagnostic-event'});
  mainProbeLine.append(element(d,'strong',{text:'Main bridge'}),makeBadge(d,mainProbe.fullyConnected?'READY':mainProbe.connected?'CONNECTED':'DISCONNECTED',mainProbe.fullyConnected?'ready':mainProbe.connected?'observed':'warning'),element(d,'span',{className:'nexus-muted',text:[
    mainProbe.generationGatewayConnected?'generation gateway':null,
    mainProbe.lifecycleBridgeConnected?'lifecycle bridge':null,
    mainProbe.active?'active':null,
  ].filter(Boolean).join(' · ')||'No active bridge path'}));
  probeList.append(mainProbeLine);
  for(const probe of probeRows){
    const line=element(d,'div',{className:'nexus-wave13-diagnostic-event'});
    line.append(
      element(d,'strong',{text:probe.displayName??probe.resourceId??'Resource'}),
      makeBadge(d,probe.health??probe.state??'UNKNOWN',['DEGRADED','UNAVAILABLE','FAILED'].includes(String(probe.health??probe.state??'').toUpperCase())?'warning':'ready'),
      element(d,'span',{className:'nexus-muted',text:[
        probe.reasonCode??null,
        probe.lastHealthLatencyMs!=null?String(probe.lastHealthLatencyMs)+' ms':null,
        probe.callable?'callable':'not callable',
      ].filter(Boolean).join(' · ')})
    );
    if(inspect)line.append(createButton(d,{label:'Inspect probe',scope,size:'sm',variant:'quiet',onPress:()=>inspect({kind:'nexus-resource-probe',id:String(probe.resourceId??'resource'),title:(probe.displayName??probe.resourceId??'Resource')+' probe',payload:probe})}));
    probeList.append(line);
  }
  center.append(element(d,'h4',{text:'Probe / health evidence'}),probeList);
  if(advanced){
    const ownerPayloads=[
      ['Decision telemetry',decisionTelemetry],
      ['Retrieval diagnostics',retrievalTelemetry],
      ['Runtime diagnostic snapshot',runtimeTelemetry],
      ['Queue health snapshot',queueTelemetry],
      ['Generation Frame diagnostics',generationFrameTelemetry],
      ['Scene Scanner diagnostics',sceneTelemetry],
      ['Main bridge diagnostics',mainBridgeTelemetry],
      ['World Tree diagnostics',worldTreeTelemetry],
    ];
    const owners=element(d,'div',{className:'nexus-wave13-diagnostic-events'});
    for(const [label,payload] of ownerPayloads){
      const line=element(d,'div',{className:'nexus-wave13-diagnostic-event'});
      line.append(element(d,'strong',{text:label}),element(d,'span',{className:'nexus-muted',text:payload&&Object.keys(payload).length?'Published':'No owner snapshot'}));
      if(inspect&&payload&&Object.keys(payload).length)line.append(createButton(d,{label:'Inspect',scope,size:'sm',variant:'quiet',onPress:()=>inspect({kind:'nexus-diagnostic-owner-snapshot',id:label.toLowerCase().replace(/\s+/g,'-'),title:label,payload})}));
      owners.append(line);
    }
    center.append(element(d,'h4',{text:'Owner diagnostic snapshots'}),owners);
  }

  const uiLoad=snapshot.telemetry?.uiLoad??null,loadCategories=uiLoad?.categories??{};
  center.append(element(d,'h3',{text:'Browser-side UI load attribution'}),createKeyValue(d,[
    {key:'Host event invalidations',value:loadMetric(loadCategories.HOST_EVENT_INVALIDATION)},
    {key:'Scatter / Gather owner read',value:loadMetric(loadCategories.OWNER_SCATTER_GATHER_READ)},
    {key:'Journal diagnostics read',value:loadMetric(loadCategories.UI_JOURNAL_DIAGNOSTICS_READ)},
    {key:'Journal processing',value:loadMetric(loadCategories.UI_JOURNAL_PROCESS)},
    {key:'Activity feed render',value:loadMetric(loadCategories.UI_ACTIVITY_FEED_RENDER)},
    {key:'Workspace refresh',value:loadMetric(loadCategories.UI_WORKSPACE_REFRESH)},
    {key:'Capture total',value:loadMetric(loadCategories.UI_CAPTURE_TOTAL)},
  ]));
  center.append(element(d,'p',{className:'nexus-muted',text:uiLoad?'Bounded in-browser timing samples from this UI instance. These are attribution signals, not a substitute for installed-browser Long Task and heap measurements.':'NO_EVIDENCE — this UI instance has not published bounded load samples.'}));
  const scatterWaves=snapshot.cognition?.scatterTelemetry??null;
  center.append(element(d,'h3',{text:'Layered Scatter owner telemetry'}));
  if(Array.isArray(scatterWaves)&&scatterWaves.length){
    const waveBox=element(d,'div',{className:'nexus-wave13-diagnostic-events'});
    for(const wave of scatterWaves.slice(0,16)){
      const line=element(d,'div',{className:'nexus-wave13-diagnostic-event'});
      line.append(element(d,'strong',{text:wave.waveId??'Wave'}),element(d,'span',{className:'nexus-muted',text:[
        wave.trigger?'trigger '+wave.trigger:null,wave.durationMs!=null?wave.durationMs+' ms':null,wave.concurrency!=null?'concurrency '+wave.concurrency:null,
        wave.jobs!=null?'jobs '+wave.jobs:null,wave.deferred!=null?'deferred '+wave.deferred:null,
      ].filter(Boolean).join(' · ')||'Owner published a wave without timing/concurrency fields.'}));
      waveBox.append(line);
    }
    center.append(waveBox);
  }else center.append(element(d,'p',{className:'nexus-muted',text:'NO_EVIDENCE — the Scatter owner did not publish layered wave triggers, timings, concurrency, or deferred-work telemetry for this selected turn.'}));

  const wiring=element(d,'div',{className:'nexus-wave13-diagnostic-lanes'});
  for(const spec of [
    ['Jev',snapshot.wiring?.jev],['Sidecar',snapshot.wiring?.sidecar],['Vectoring',snapshot.wiring?.vectoring],
  ]){
    const lane=spec[1]?.lane??{},card=element(d,'article',{className:'nexus-card nexus-wave13-diagnostic-lane'});
    const status=lane.connected>0?'CONNECTED':lane.configured>0?'CONFIGURED':'NOT CONNECTED';
    card.append(element(d,'div',{className:'nexus-inline-status'},element(d,'strong',{text:spec[0]}),makeBadge(d,status,lane.connected>0?'ready':lane.configured>0?'warning':'historical')));
    card.append(createKeyValue(d,[
      {key:'Configured',value:lane.configured??0},{key:'Connected',value:lane.connected??0},{key:'Callable',value:lane.callable??0},
      {key:'Attempted',value:lane.attempted??0},{key:'Succeeded',value:lane.succeeded??0},{key:'Owner-accepted',value:lane.ownerAccepted??0},
      {key:'Active executions',value:lane.activeExecutions??0},{key:'Expected capabilities',value:(spec[1]?.expectedCapabilities??[]).join(', ')},
    ]));
    if((lane.states??[]).length){
      const states=element(d,'div',{className:'nexus-wave13-diagnostic-events'});
      for(const row of lane.states.slice(0,8)){
        const line=element(d,'div',{className:'nexus-wave13-diagnostic-event'});
        line.append(advanced?element(d,'code',{text:row.id}):element(d,'span',{text:row.displayName??'Configured resource'}),makeBadge(d,row.state??row.health??'UNKNOWN',resourceStatus(row.health)));
        if(row.lastExecution?.status)line.append(element(d,'span',{className:'nexus-muted',text:'last execution '+row.lastExecution.status+(row.lastExecution.taskType?' · '+row.lastExecution.taskType:'')}));
        states.append(line);
      }
      card.append(states);
    }
    wiring.append(card);
  }
  center.append(element(d,'h3',{text:'Jev / Sidecar / Vectoring wiring'}),wiring);

  const stages=element(d,'div',{className:'nexus-wave13-status-grid'});
  for(const row of snapshot.producers?.stages??[])stages.append(stageCard(d,row,scope,inspect,{showIds:advanced,inspection:snapshot.producers?.inspections?.[row.id]}));
  center.append(element(d,'h3',{text:'Producer telemetry'}),stages);

  const activity=element(d,'div',{className:'nexus-wave13-diagnostics__activity'});
  const jobs=snapshot.cognition?.jobs??[],results=snapshot.cognition?.gather??[],pipeline=snapshot.pipeline??{};
  activity.append(
    flowStep(d,'Producers available',String(pipeline.registeredProducers??0)),
    flowStep(d,'Work executed',pipeline.executionReceipt?jobs.length+' jobs':'No execution receipt'),
    flowStep(d,'Results returned',pipeline.resultReceipt?results.length+' returned':'No Gather receipt'),
    flowStep(d,'Context admitted',pipeline.admissionReceipt?String(snapshot.cognition?.seal?.admittedResultIds?.length??0):'No Context Seal receipt'),
    flowStep(d,'Generation delivered',pipeline.deliveryReceipt?(pipeline.generationState?humanLabel(pipeline.generationState):'Owner delivery recorded'):pipeline.generationReader?'No delivery receipt':'Owner generation reader unavailable'),
    flowStep(d,'Learning recorded',pipeline.learningReceipt?'Owner learning receipt recorded':pipeline.generationReceipt?'Not yet':'No generation receipt')
  );
  center.append(element(d,'h3',{text:'Current turn activity'}),activity);
  center.append(renderSelectedTurnGraphVisibility(d,snapshot.graph,{compact:!advanced,title:'Selected-turn world graph'}));
  center.append(renderSelectedTurnEvidence(d,{snapshot,evidenceJournal,scope,inspect,advanced}));
  const path=element(d,'section',{className:'nexus-card nexus-wave13-turn-path',attrs:{'aria-label':'Selected turn owner receipt path'}});
  path.append(element(d,'h3',{text:'Selected-turn receipt path'}),element(d,'p',{className:'nexus-muted',text:'A read-only owner-receipt path for this selected turn. This is an operational trace, not a complete cognitive transaction ledger.'}));
  const stageMap=new Map((snapshot.producers?.stages??[]).map(row=>[row.id,row]));
  for(const [id,label] of [['choice','Choice'],['runtime','Execution'],['truth','Truth'],['gather','Returned evidence'],['seal','Context Seal'],['generation','Generation delivery'],['learning','Learning write-back']]){
    const row=stageMap.get(id),line=element(d,'div',{className:'nexus-wave13-flow-row'});
    line.append(element(d,'strong',{text:label}),makeBadge(d,row?.state??'UNAVAILABLE',stageStatus(row?.state)));
    line.append(element(d,'span',{className:'nexus-muted',text:row?.reason??'Owner receipt not exported.'}));
    if(advanced&&row?.errorCode)line.append(element(d,'code',{text:row.errorCode}));
    path.append(line);
  }
  const forensicStage=stageMap.get('forensics');
  if(navigate&&forensicStage&&forensicStage.state!==OperatorProducerState.UNAVAILABLE)path.append(createButton(d,{label:'Open Forensics',scope,size:'sm',variant:'quiet',onPress:()=>navigate('forensics')}));
  else path.append(element(d,'p',{className:'nexus-muted',text:'A full forensic timeline requires the owner transaction/forensics readers; missing owner data is not reconstructed by the UI.'}));
  center.append(path);
  if(advanced&&snapshot.generationInspection){
    const inspection=snapshot.generationInspection,identity=inspection.identityResolution,graph=inspection.graphTraversal,budget=inspection.retrievalBudget,rejected=inspection.rejectedEvidence;
    center.append(element(d,'h3',{text:'Owner generation inspection'}),createKeyValue(d,[
      {key:'Source revision fence',value:String(inspection.sourceRevisionFenceCount??0)+' revisions'},
      {key:'Identity resolution',value:identity?[(identity.kind??'receipt'),identity.status??identity.reasonCode??'published',formatReceiptCounts(identity.counts)].filter(Boolean).join(' · '):'Not published'},
      {key:'Graph traversal',value:graph?[(graph.kind??'receipt'),graph.status??graph.reasonCode??'published',formatReceiptCounts(graph.counts)].filter(Boolean).join(' · '):'Not published'},
      {key:'Retrieval budget',value:budget?[(budget.kind??'receipt'),budget.status??budget.reasonCode??'published',formatReceiptCounts(budget.counts)].filter(Boolean).join(' · '):'Not published'},
      {key:'Rejected evidence',value:rejected?String(rejected.count??0)+' rejected'+(rejected.reasonCode?' · '+rejected.reasonCode:''):'No owner rejection receipt'},
      {key:'Lore / Memory sync',value:[inspection.loreSync?.status??inspection.loreSync?.kind??'Lore not published',inspection.memorySync?.status??inspection.memorySync?.kind??'Memory not published'].join(' · ')},
    ]),element(d,'p',{className:'nexus-muted',text:'Metadata-only inspection. Raw prompts and evidence payloads are intentionally excluded; use owner forensic tooling for a full transaction reconstruction.'}));
  }
  if(jobs.length){
    const list=element(d,'div',{className:'nexus-wave13-flow-list'});
    for(const job of jobs.slice(0,40)){
      const row=element(d,'div',{className:'nexus-wave13-flow-row'});
      row.append(element(d,'strong',{text:job.taskType??job.jobId??job.taskId??job.capability??'Cognitive job'}),advanced?element(d,'code',{text:job.resourceId??job.taskId??'native / unreported'}):element(d,'span',{className:'nexus-muted',text:job.resourceId?'Optional resource':'Native / owner resource'}),makeBadge(d,job.state??'PUBLISHED',flowStatus(job.state)));
      list.append(row);
    }
    center.append(list);
  }
  if(results.length){
    const list=element(d,'div',{className:'nexus-wave13-flow-list'});
    for(const result of results.slice(0,40)){
      const row=element(d,'div',{className:'nexus-wave13-flow-row'});
      row.append(element(d,'strong',{text:result.capability??'Returned result'}),advanced?element(d,'code',{text:result.resourceId??result.resultId??'owner'}):element(d,'span',{className:'nexus-muted',text:result.resourceId?'Optional resource result':'Owner result'}),makeBadge(d,result.contextAdmitted?'CONTEXT ADMITTED':result.status??'RETURNED',result.contextAdmitted?'ready':flowStatus(result.status)));
      list.append(row);
    }
    center.append(list);
  }

  const lore=snapshot.lore??{};
  center.append(element(d,'h3',{text:'Lore / retrieval telemetry'}),createKeyValue(d,[
    {key:'Accepted',value:lore.accepted??0},{key:'Learned/current',value:lore.learned??0},{key:'Retrieval-ready',value:lore.retrievalReady??0},
    {key:'Due',value:lore.lifecycle?.due??0},{key:'Active',value:lore.lifecycle?.active??lore.lifecycle?.counts?.ACTIVE??0},{key:'Invalid',value:lore.lifecycle?.counts?.INVALID??0},
  ]));
  const memory=snapshot.memory??{},memoryCounts=memory.counts??{},memoryFresh=memory.freshness??{};
  center.append(element(d,'h3',{text:'Memory telemetry'}),createKeyValue(d,[
    {key:'Exact evidence',value:memoryCounts.exactEvidence??0},{key:'Current / historical / unresolved',value:[memoryCounts.current??0,memoryCounts.historical??0,memoryCounts.unresolved??0].join(' / ')},
    {key:'Episodes / reflections / summaries',value:[memoryCounts.episodes??0,memoryCounts.reflections??0,memoryCounts.summaries??0].join(' / ')},
    {key:'Fresh / stale summaries',value:[memoryFresh.freshSummaries??0,memoryFresh.staleSummaries??0].join(' / ')},{key:'Retrieval status',value:memory.retrievalStatus??'No selected-turn retrieval receipt'},
  ]));

  const errors=Object.entries(snapshot.cognition?.errors??{});
  if(errors.length){
    const list=element(d,'div',{className:'nexus-wave13-diagnostic-events'});
    for(const [name,error] of errors){
      const issue=message(d,name+' read issue',error?.message??error?.code??'Unknown cognition read failure','warning');
      if(error?.code)issue.append(element(d,'code',{text:String(error.code)}));
      if(error?.foreignSourceRevisionRefs?.length)issue.append(element(d,'code',{className:'nexus-wave13-fence-ref',text:'Outside selected source fence: '+error.foreignSourceRevisionRefs.slice(0,8).join(' · ')}));
      if(advanced&&error?.actual)issue.append(element(d,'span',{className:'nexus-muted',text:'Observed identity: '+[error.actual.chatId,error.actual.turnId,error.actual.generationId].filter(Boolean).join(' · ')}));
      list.append(issue);
    }
    center.append(element(d,'h3',{text:'Read / coherence issues'}),list);
  }
  const events=snapshot.telemetry?.resourceEvents??[];
  center.append(element(d,'h3',{text:'Recent owner resource telemetry'}));
  if(events.length){
    const list=element(d,'div',{className:'nexus-wave13-diagnostic-events'});
    for(const event of events.slice(0,40)){
      const line=element(d,'div',{className:'nexus-wave13-diagnostic-event'});
      line.append(advanced?element(d,'code',{text:event.resourceId??'resource'}):element(d,'span',{text:event.displayName??'Configured resource'}),element(d,'strong',{text:humanLabel(event.code??'EVENT')}),element(d,'span',{text:event.message??''}));
      if(inspect)line.append(createButton(d,{label:'Inspect',scope,size:'sm',variant:'quiet',onPress:()=>inspect({kind:'wave13-diagnostic-event',id:String(event.sequence??event.code??'event'),title:(event.resourceId??'Resource')+' · '+(event.code??'event'),payload:event})}));
      list.append(line);
    }
    center.append(list);
  }else center.append(message(d,'No resource events yet','Connect, test, disconnect, reconnect, or execute an optional resource and owner telemetry will appear here.','historical'));
  return center;
}

function renderSelectedTurnEvidence(d,{snapshot,evidenceJournal,scope,inspect,advanced=false}={}){
  const selection=snapshot.selection??{},pipeline=snapshot.pipeline??{},runtimeTurn=snapshot.runtime?.turn??{};
  const section=element(d,'section',{className:'nexus-card nexus-wave13-evidence-drilldown',attrs:{'aria-label':'Selected-turn evidence drilldown'}});
  section.append(element(d,'h3',{text:'Selected-turn evidence drilldown'}),element(d,'p',{className:'nexus-muted',text:'Evidence is shown only when an owner receipt or bounded local journal entry exists. Missing per-job resource identity, Context Seal, PromptPlan, or host observation remains explicitly unproven.'}));

  const jobRows=(snapshot.cognition?.jobs?.length?snapshot.cognition.jobs:runtimeTurn.jobs??[]).slice(0,12);
  section.append(element(d,'h4',{text:'Job → resource / attempt'}));
  if(jobRows.length){
    const list=element(d,'div',{className:'nexus-wave13-flow-list'});
    for(const job of jobRows){
      const resource=job.resourceId??job.workerId??null;
      const resourceText=resource?String(resource):(runtimeTurn.resourceIds?.length?'Per-job resource not published · turn resource set: '+runtimeTurn.resourceIds.slice(0,4).join(', '):'Resource identity not published');
      const row=element(d,'div',{className:'nexus-wave13-flow-row'});
      row.append(element(d,'strong',{text:job.taskType??job.jobId??job.taskId??job.capability??'Cognitive job'}),element(d,advanced?'code':'span',{className:advanced?'':'nexus-muted',text:resourceText}),makeBadge(d,job.state??'PUBLISHED',flowStatus(job.state)));
      list.append(row);
    }
    section.append(list);
  }else section.append(message(d,'No selected-turn job receipt','No Scatter or Runtime job rows are available for this exact turn.','historical'));

  const attempts=(snapshot.resources?.rows??[]).filter(row=>row.physicalExecutionAttempted||row.lastExecution).slice(0,12);
  if(attempts.length){
    section.append(element(d,'h4',{text:'Optional-resource physical attempts'}));
    const list=element(d,'div',{className:'nexus-wave13-flow-list'});
    for(const attempt of attempts){
      const state=attempt.physicalExecutionSucceeded?'SUCCEEDED':attempt.lastExecution?.status??'ATTEMPTED';
      const row=element(d,'div',{className:'nexus-wave13-flow-row'});
      row.append(element(d,'strong',{text:attempt.displayName??attempt.id??'Optional resource'}),element(d,advanced?'code':'span',{className:advanced?'':'nexus-muted',text:attempt.id??'resource id unavailable'}),makeBadge(d,state,flowStatus(state)));
      list.append(row);
    }
    section.append(list);
  }

  const results=(snapshot.cognition?.gather??[]).slice(0,16);
  section.append(element(d,'h4',{text:'Result → Gather → Context Seal'}));
  if(results.length){
    const list=element(d,'div',{className:'nexus-wave13-flow-list'});
    for(const result of results){
      const row=element(d,'div',{className:'nexus-wave13-flow-row'});
      const origin=result.resourceId??(result.taskId?'task '+result.taskId:'owner result; resource not published');
      row.append(element(d,'strong',{text:result.capability??'Result'}),element(d,advanced?'code':'span',{className:advanced?'':'nexus-muted',text:String(origin)}),makeBadge(d,result.contextAdmitted?'SEAL ADMITTED':result.status??'RETURNED',result.contextAdmitted?'ready':flowStatus(result.status)));
      list.append(row);
    }
    section.append(list);
  }else section.append(message(d,'No Gather result rows','No selected-turn Gather result rows are available.','historical'));

  const planPublished=Boolean(snapshot.promptPlan?.summary?.promptPlanId||pipeline.promptPlanReceipt);
  const prepared=Boolean(pipeline.hostPrepared),observed=Boolean(pipeline.hostInjected||pipeline.deliveryReceipt);
  const deliveryProof=element(d,'div',{className:'nexus-wave13-delivery-proof'});
  deliveryProof.append(
    flowStep(d,'Planned',planPublished?'PromptPlan receipt published':'No PromptPlan receipt'),
    flowStep(d,'Compiled / injected',pipeline.hostDeliveryReceipt?(observed?'Host receipt reports request injection':prepared?'Host receipt reports prepared payload only':'Host receipt exists; compilation/injection state not published'):'No exact host-delivery receipt'),
    flowStep(d,'Host-observed',observed?'Observed at SillyTavern model-request hook':'No host-observed injection evidence')
  );
  section.append(element(d,'h4',{text:'Prompt delivery proof levels'}),deliveryProof);

  const journalStatus=evidenceJournal?.status?.()??null,journalEntries=evidenceJournal?.listEntries?.(selection,{limit:12})??[];
  section.append(element(d,'h4',{text:'Local evidence journal'}),createKeyValue(d,[
    {key:'Selected-turn entries',value:journalEntries.length},{key:'Storage',value:journalStatus?.storageKind??'Not connected'},
    {key:'Retention bound',value:journalStatus?String(journalStatus.maxTurns)+' turns · '+String(journalStatus.maxEntriesPerTurn)+' entries/turn':'Not connected'},
  ]));
  if(evidenceJournal?.download&&selection.chatId&&selection.turnId&&selection.generationId)section.append(createButton(d,{label:'Export selected turn evidence',scope,size:'sm',variant:'quiet',onPress:()=>evidenceJournal.download({selection,document:d})}));
  if(journalEntries.length){
    const list=element(d,'div',{className:'nexus-wave13-evidence-journal'});
    for(const item of journalEntries.slice(-12).reverse()){
      const row=element(d,'button',{className:'nexus-wave13-evidence-row',attrs:{type:'button','aria-label':'Inspect '+item.title},dataset:{status:item.status}});
      row.append(element(d,'strong',{text:item.title}),element(d,'span',{className:'nexus-muted',text:item.summary}),makeBadge(d,item.status,flowStatus(item.status)));
      if(inspect)scope?.listen?.(row,'click',()=>inspect({kind:'wave14-activity-evidence',id:item.id,title:item.title,available:true,selection:item.selection,receiptRef:item.receiptRef??null,payload:item}));
      else row.disabled=true;
      list.append(row);
    }
    section.append(list);
  }else section.append(element(d,'p',{className:'nexus-muted',text:'No retained selected-turn journal entries are currently available. This does not imply that backend work did or did not occur.'}));
  return section;
}

function formatReceiptCounts(counts){
  const rows=Object.entries(counts??{}).filter(([,value])=>Number(value)>0);
  return rows.length?rows.map(([key,value])=>humanLabel(key)+' '+String(value)).join(', '):'';
}

function flowStep(d,label,value){const node=element(d,'div',{className:'nexus-wave13-flow-step'});node.append(element(d,'strong',{text:label}),element(d,'span',{text:value}));return node;}

function flowStatus(value){const v=String(value??'').toUpperCase();if(['COMPLETE','COMPLETED','READY','SUCCEEDED','ADMITTED'].includes(v))return'ready';if(['ACTIVE','RUNNING','QUEUED','WORKING'].includes(v))return'loading';if(['FAILED','ERROR','INVALID','LATE','STALE','REJECTED'].includes(v))return'warning';return'historical';}

function humanLabel(value){return String(value??'').toLowerCase().replace(/(^|_)([a-z])/g,(_,space,letter)=>(space?' ':'')+letter.toUpperCase());}

export function renderMemoryOwnerSurface(host,{memory,productAdapter}={}){
  const d=host.ownerDocument,read=memory.read(),source=read.source,data=read.data,detail=productAdapter?.getDetailLevel?.()??ProductDetailLevel.NORMAL;
  host.append(header(d,'Memory','Owner-backed selected-chat experience, temporal state, reflections, retrieval and hierarchical compaction. Derived summaries remain navigation aids, not canon.'));
  host.append(makeHealthPill(d,{label:'Memory · '+(source.operationalState??source.health),status:source.statusToken,detail:source.impact}));
  if(source.reason)host.append(message(d,'Memory status',plainMemoryReason(source.reason),source.statusToken));
  if(!data){host.append(message(d,'No owner Memory state',source.impact??'No memories recorded for this chat yet.','historical'));return;}
  const counts=data.counts??{},fresh=data.freshness??{};
  host.append(createKeyValue(d,[
    {key:'Exact evidence',value:counts.exactEvidence??0},{key:'Current / historical / unresolved',value:[counts.current??0,counts.historical??0,counts.unresolved??0].join(' / ')},
    {key:'Episodes / reflections',value:[counts.episodes??0,counts.reflections??0].join(' / ')},{key:'Hierarchical summaries',value:counts.summaries??0},
    {key:'Fresh / stale summaries',value:[fresh.freshSummaries??0,fresh.staleSummaries??0].join(' / ')},{key:'Retrieval',value:data.retrieval?.status??(data.retrieval?'Published':'No selected-turn retrieval receipt')},
  ]));
  if(data.summaries?.length){
    const summaries=element(d,'section',{className:'nexus-wave13-memory-summaries'});
    summaries.append(element(d,'h2',{text:'Story / arc / scene compaction'}),element(d,'p',{className:'nexus-muted',text:'These are derived navigation representations. Exact evidence remains the authority and is recoverable through the owner provenance/source ranges.'}));
    for(const row of data.summaries.slice(0,40)){
      const card=element(d,'article',{className:'nexus-card'}),head=element(d,'div',{className:'nexus-inline-status'});
      head.append(element(d,'strong',{text:humanLabel(row.scopeLevel??'Summary')}),makeBadge(d,humanLabel(row.freshness??row.state??'UNKNOWN'),row.freshness==='FRESH'?'ready':'warning'),makeBadge(d,'DERIVED / NAVIGATION','historical'));
      card.append(head,createKeyValue(d,[
        {key:'Scope',value:row.scopeRef??'—'},{key:'Source range',value:memorySourceRange(row.sourceRange)},{key:'Exact source revisions',value:(row.exactSourceRevisionSet??[]).length},
        {key:'Unresolved sets preserved',value:(row.unresolvedSetRefs??[]).length},{key:'Authority',value:row.authorityClass??'DERIVED'},
      ]));
      if(detail!==ProductDetailLevel.NORMAL&&row.representationText)card.append(element(d,'p',{text:String(row.representationText).slice(0,1200)}));
      if(detail===ProductDetailLevel.ADVANCED)card.append(createKeyValue(d,[{key:'Summary revision',value:row.revision??'—'},{key:'Policy revision',value:row.summaryPolicyRevision??'—'},{key:'Compiler revision',value:row.compilerRevision??'—'},{key:'Evidence refs',value:(row.exactEvidenceRefs??[]).join(', ')||'none'}]));
      summaries.append(card);
    }
    host.append(summaries);
  }else host.append(message(d,'No hierarchical summaries yet','The Memory owner has not published story/arc/scene compaction artifacts for the selected chat. Nexus does not synthesize them in the UI.','historical'));
  if(data.state?.unresolved?.length)host.append(message(d,'Unresolved memory preserved',data.state.unresolved.length+' competing or unresolved state record'+(data.state.unresolved.length===1?' remains':'s remain')+' unresolved. The UI does not promote a winner.','warning'));
  if(data.mutationAuthority||data.settlementAuthority||data.contextSealAuthority)host.append(message(d,'Authority contract warning','Memory UI read state unexpectedly advertises mutation, Settlement, or Context Seal authority. No UI mutation action is exposed.','warning'));
}

function memorySourceRange(range){
  if(!range)return'Not published';
  if(Array.isArray(range))return range.join(' → ');
  if(typeof range==='object')return[String(range.start??'—'),String(range.end??'—')].join(' → ');
  return String(range);
}

function plainMemoryReason(reason){
  if(String(reason).includes('MEMORY_NO_EVIDENCE'))return'No memories recorded for this chat yet.';
  return String(reason);
}

export function renderLoreStudySurface(host,{loreStudy,actionRouter,scope,refresh,notifications,fallbackRender,productAdapter,inspect,loreNeuralState=null,frontFacePresentation=null,worldTree=null}={}){
  const d=host.ownerDocument;
  if(!loreStudy){fallbackRender?.(host,{scope,refresh,notifications,actionRouter});return;}

  const read=loreStudy.read?.()??{},legacyData=read.data??{},selected=loreStudy.selectedLorebook?.()??{};
  const selection=selected.selection??{},snapshot=selected.snapshot??null,caps=loreStudy.capabilities?.()??{};
  const worldSnapshot=worldTree?.read?.()??null;
  const data=projectWorldTreeLoreData(worldSnapshot,legacyData);
  const source=worldSnapshot?{
    ...(read.source??{}),
    operationalState:'LIVE',health:'READY',statusToken:'ready',
    producer:'NexusWorldTree',revision:worldSnapshot.worldRevision??worldSnapshot.revision??null,
  }:(read.source??{});

  if((caps.subscribe||worldTree?.subscribe)&&scope?.add){
    let queued=false;
    const queueRefresh=()=>{
      if(queued)return;queued=true;
      if(scope?.timeout)scope.timeout(()=>{queued=false;refresh?.();},90);
      else{queued=false;refresh?.();}
    };
    if(caps.subscribe)scope.add(loreStudy.subscribe(queueRefresh));
    if(typeof worldTree?.subscribe==='function')scope.add(worldTree.subscribe(queueRefresh));
  }

  const entries=Array.isArray(data?.entries)?data.entries:[];
  const counts=data?.operatorCounts??{},accepted=Number(counts.ACCEPTED??0),studying=Number(counts.STUDYING??0),ready=Number(counts.READY??0),failed=Number(counts.FAILED??0),removed=Number(counts.REMOVED??0);
  const total=accepted+studying+ready+failed+removed,denominator=Math.max(1,total-removed),progress=Math.round(ready/denominator*100);
  const sourceBook=String(snapshot?.id??selection.lorebookId??'').trim();
  const worldBookCount=sourceBook?entries.filter(row=>String(row.book??'')===sourceBook).length:0;
  const sourcePublished=Boolean(sourceBook&&worldBookCount>0);
  const sourceCurrent=Boolean(snapshot&&sourcePublished&&worldBookCount>=Number(snapshot.entries?.length??0));

  const form=element(d,'section',{className:'nexus-card nexus-wave13-lore-form nexus-wave13-lore-controls nexus-lore-command nexus-world-tree-source-panel',dataset:{sourceState:sourceCurrent?'current':sourcePublished?'published':snapshot?'loaded':'empty'}});
  const commandHead=element(d,'div',{className:'nexus-lore-command__head'});
  const commandCopy=element(d,'div',{className:'nexus-lore-command__copy'});
  commandCopy.append(
    element(d,'span',{className:'nexus-eyebrow',text:'WORLD TREE SOURCE'}),
    element(d,'h2',{text:snapshot?.title??selection.title??'Selected Lorebook'}),
    element(d,'p',{className:'nexus-muted',text:sourceCurrent?'This loaded SillyTavern snapshot matches the Lore nodes currently published in the canonical World Tree.':sourcePublished?'This Lorebook is already published in the World Tree; refresh it to verify the current SillyTavern snapshot.':'Select a SillyTavern Lorebook, then load it into the canonical Nexus World Tree.'})
  );
  commandHead.append(commandCopy,makeBadge(d,sourceCurrent?'SYNCED':sourcePublished?'PUBLISHED':snapshot?'LOADED':'SELECT SOURCE',sourceCurrent?'ready':sourcePublished?'observed':snapshot?'observed':'historical'));
  form.append(commandHead);

  const sourceFacts=element(d,'div',{className:'nexus-world-tree-source-facts'});
  sourceFacts.append(
    compactFact(d,'Lorebook',snapshot?.title??selection.title??'None selected'),
    compactFact(d,'Entries',snapshot?.entries?.length??worldBookCount??0),
    compactFact(d,'World nodes',entries.length),
    compactFact(d,'World revision',worldSnapshot?.worldRevision??worldSnapshot?.revision??'—')
  );
  form.append(sourceFacts);

  const status=element(d,'p',{className:'nexus-wave13-form-status',attrs:{role:'status','aria-live':'polite'}});
  const actions=element(d,'div',{className:'nexus-wave13-lore-actions nexus-lore-command__actions'});
  const loadSource=createButton(d,{
    label:sourcePublished?'Refresh World Tree source':'Load World Tree source',
    disabled:!(caps.discover&&caps.loadWorldTreeSource),scope,variant:'primary',
    onPress:async()=>{
      status.textContent='Reading the selected SillyTavern Lorebook and publishing it to the World Tree…';status.dataset.status='loading';
      try{
        const discovered=await loreStudy.discoverSelectedLorebook();
        const imported=await loreStudy.loadWorldTreeSource(discovered);
        status.textContent='Published '+String(imported.entryCount??discovered.entries?.length??0)+' Lore entries · World revision '+String(imported.worldRevision??'updated')+'.';
        status.dataset.status='ready';
        notifications?.push?.({message:'World Tree source refreshed from '+String(discovered.title??discovered.id??'selected Lorebook')+'.',status:'ready'});
        refresh?.();
      }catch(error){status.textContent=String(error?.message??error);status.dataset.status='error';}
    }
  });
  actions.append(loadSource);

  if(caps.accept&&snapshot){
    actions.append(createButton(d,{label:'Accept for legacy study',scope,variant:'quiet',onPress:async()=>{
      const result=await actionRouter.route({type:'wave13.lore.accept',payload:loreStudy.selectedLorebook?.().snapshot??snapshot});
      if(!result.ok){status.textContent=result.error||'Lore acceptance failed';status.dataset.status='error';return;}
      status.textContent='Accepted by the legacy Lore Study owner.';status.dataset.status='ready';refresh?.();
    }}));
  }
  if(caps.run&&accepted>0){
    actions.append(createButton(d,{label:'Run '+accepted+' due stud'+(accepted===1?'y':'ies'),scope,variant:'quiet',onPress:async()=>{
      const result=await actionRouter.route({type:'wave13.lore.run',payload:{scope:'DUE'}});
      status.textContent=result.ok?'Lore Study request completed.':result.error||'Lore Study failed';
      status.dataset.status=result.ok?'ready':'error';refresh?.();
    }}));
  }
  form.append(actions,status);
  if(!caps.discover||!caps.loadWorldTreeSource)form.append(message(d,'World Tree source loading unavailable','The current host does not expose the selected-Lorebook → World Tree source bridge.','offline'));

  const motionMode=frontFacePresentation?.get?.().motionMode??'FULL';
  const worldTreeShell=element(d,'section',{className:'nexus-world-tree-shell',attrs:{'aria-label':'World Tree visual shell'}});
  const worldTreeView=renderLoreNeuralWorkspace(d,{
    data,source,selected,progress,scope,inspect,renderState:loreNeuralState,refresh,motionMode,
    tools:{
      merge:caps.scanWorldTreeMerge&&sourceBook?async()=>{
        try{
          const result=await loreStudy.scanWorldTreeMerge(sourceBook);
          notifications?.push?.({message:'Merge scan found '+String(result?.length??0)+' candidate pair(s).',status:'info'});
          inspect?.({kind:'nexus-world-tree-merge-scan',id:sourceBook,title:'Merge candidates · '+sourceBook,available:true,payload:result});
          return result;
        }catch(error){
          notifications?.push?.({message:'Merge scan failed: '+String(error?.message??error),status:'error'});
          return null;
        }
      }:null,
      summarize:caps.summarizeWorldTreeSource&&sourceBook?async()=>{
        try{
          const result=await loreStudy.summarizeWorldTreeSource(sourceBook);
          notifications?.push?.({message:'World Tree Summarizer completed for '+sourceBook+'.',status:'ready'});
          refresh?.();return result;
        }catch(error){
          notifications?.push?.({message:'Summarizer failed: '+String(error?.message??error),status:'error'});
          return null;
        }
      }:null,
    }
  });
  worldTreeShell.append(form,worldTreeView);
  host.append(worldTreeShell);
}

function projectWorldTreeLoreData(worldSnapshot=null,legacyData={}){
  const nodes=Array.isArray(worldSnapshot?.nodes)?worldSnapshot.nodes:[];
  const loreNodes=nodes.filter(node=>String(node?.kind??'').toUpperCase()==='LORE_FACT');
  if(!loreNodes.length){
    const legacyEntries=Array.isArray(legacyData?.entries)?legacyData.entries:[];
    return{
      ...(legacyData??{}),
      entries:legacyEntries,
      operatorCounts:legacyData?.operatorCounts??{ACCEPTED:0,STUDYING:0,READY:0,FAILED:0,REMOVED:0},
      retrievalReady:Number(legacyData?.retrievalReady??0),
      conflicts:Array.isArray(legacyData?.conflicts)?legacyData.conflicts:[],
    };
  }
  const legacyEntries=Array.isArray(legacyData?.entries)?legacyData.entries:[];
  const legacyBySource=new Map(legacyEntries.map(row=>[String(row.sourceId??row.uid??''),row]));
  const worldNodeById=new Map(nodes.map(node=>[String(node?.id??''),node]));
  const entries=loreNodes.map((node,index)=>{
    const id=String(node?.id??'');
    const match=id.match(/^lore-fact:(.*):(\d+)$/i);
    const book=match?.[1]??'',uid=match?.[2]??id??String(index),legacy=legacyBySource.get(id)??legacyBySource.get(String(uid))??{};
    const parent=worldNodeById.get(String(node?.parentId??''))??null;
    return{
      ...legacy,
      sourceId:id,uid,book,title:node.label??String(uid),label:node.label??String(uid),
      worldParentId:node.parentId??null,worldParentLabel:parent?.label??null,worldParentKind:parent?.kind??null,
      operatorState:'READY',retrievalReady:true,freshness:'CURRENT',
      representations:Array.isArray(legacy.representations)?legacy.representations:[],
      artifactIds:Array.isArray(legacy.artifactIds)?legacy.artifactIds:[],
      worldTreeKind:node.kind,worldTreeRevision:node.revision??worldSnapshot?.worldRevision??null,
      createdRevision:Number(node.createdRevision)||null,updatedRevision:Number(node.updatedRevision)||null,
      temporalStatus:node.temporal?.status??null,
    };
  });
  return{
    ...(legacyData??{}),
    revision:worldSnapshot?.worldRevision??legacyData?.revision??0,
    entries,
    operatorCounts:{ACCEPTED:0,STUDYING:0,READY:entries.length,FAILED:0,REMOVED:0},
    retrievalReady:entries.length,
    conflicts:legacyData?.conflicts??[],
    worldEdges:Array.isArray(worldSnapshot?.edges)?worldSnapshot.edges:[],
  };
}

function renderLoreDiagnosticsTools(host,{loreStudy,loreAuthoring,actionRouter,scope,refresh,productAdapter,draft=null}={}){
  if(!loreStudy&&!loreAuthoring)return;
  const d=host.ownerDocument,section=element(d,'section',{className:'nexus-wave13-settings__group nexus-lore-diagnostics-tools',attrs:{'aria-label':'Lore and World Tree diagnostics'}});
  const read=loreStudy?.read?.()??{},data=read.data??{},entries=Array.isArray(data.entries)?data.entries:[],detail=productAdapter?.getDetailLevel?.()??ProductDetailLevel.NORMAL;
  const head=element(d,'div',{className:'nexus-wave13-section-head'});
  head.append(element(d,'strong',{text:'Lore / World Tree diagnostics'}),makeBadge(d,entries.length?'PUBLISHED':'IDLE',entries.length?'observed':'historical'));
  section.append(head,element(d,'p',{className:'nexus-muted',text:'Secondary Lore owner state, derived representations, and authoring review live here so the Lore workspace can remain focused on the World Tree.'}));

  const study=element(d,'details',{className:'nexus-wave13-lore-entry-details'});
  study.open=false;
  study.append(element(d,'summary',{className:'nexus-wave13-lore-detail-summary',text:'Entry-level study states · '+entries.length+' entries'}));
  if(entries.length)study.append(renderLoreEntries(d,entries,scope,{showIds:detail===ProductDetailLevel.ADVANCED}));
  else study.append(message(d,'No Lore accepted yet','No owner-backed Lore entries are currently published.','historical'));
  section.append(study);

  const conflicts=Array.isArray(data.conflicts)?data.conflicts:[];
  const conflictDetails=element(d,'details',{className:'nexus-wave13-lore-conflict-details'});
  conflictDetails.open=conflicts.some(row=>row?.certainty==='ESTABLISHED');
  conflictDetails.append(element(d,'summary',{className:'nexus-wave13-lore-detail-summary',text:'Conflicts · '+conflicts.length}));
  conflictDetails.append(renderLoreConflicts(d,conflicts));
  section.append(conflictDetails);

  const derived=element(d,'details',{className:'nexus-wave13-lore-derived-details'});
  derived.open=detail===ProductDetailLevel.ADVANCED;
  derived.append(element(d,'summary',{className:'nexus-wave13-lore-detail-summary',text:'Derived representations / navigation summaries'}),renderLoreDerivedRepresentations(d,{entries,summarySurface:loreStudy?.summaries?.(),detail}));
  section.append(derived);

  if(loreAuthoring){
    const review=element(d,'details',{className:'nexus-wave13-lore-review-details'});
    review.open=detail===ProductDetailLevel.ADVANCED;
    const summary=element(d,'summary',{className:'nexus-wave13-lore-review-summary'});
    summary.append(element(d,'strong',{text:'Authoring / review tools'}),element(d,'span',{className:'nexus-muted',text:'Edit-impact, Tree, merge, and mutation review'}));
    const reviewHost=element(d,'div',{className:'nexus-wave13-lore-review-host'});
    renderLoreReviewWorkspace(reviewHost,{scope,refresh,productAdapter,loreStudy,loreAuthoring,actionRouter,draft});
    review.append(summary,reviewHost);section.append(review);
  }
  host.append(section);
}

function renderLoreDerivedRepresentations(d,{entries=[],summarySurface=null,detail=ProductDetailLevel.NORMAL}={}){
  const root=element(d,'section',{className:'nexus-wave13-lore-derived',attrs:{'aria-label':'Lore derived representations'}});
  root.append(element(d,'h2',{text:'Derived Lore representations'}),element(d,'p',{className:'nexus-muted',text:'Summaries and compressed representations are derived retrieval/navigation artifacts. Exact authored Lore remains the source; these views do not gain truth or Settlement authority.'}));
  const represented=entries.filter(row=>Array.isArray(row.representations)&&row.representations.length);
  if(represented.length){
    const list=element(d,'div',{className:'nexus-wave13-flow-list'});
    for(const entry of represented.slice(0,40)){
      for(const rep of entry.representations.slice(0,8)){
        const row=element(d,'article',{className:'nexus-wave13-flow-row'});
        row.append(element(d,'strong',{text:humanLabel(rep.profile??rep.representationProfile??'Representation')}),makeBadge(d,humanLabel(rep.qualityStatus??'UNKNOWN'),String(rep.qualityStatus??'').toUpperCase()==='PASS'?'ready':'warning'),element(d,'span',{text:'Source '+String(entry.uid??'entry')+' · '+(rep.representationRevision??'revision not published')}));
        if(detail===ProductDetailLevel.ADVANCED&&rep.representationRef)row.append(element(d,'code',{text:rep.representationRef}));
        list.append(row);
      }
    }
    root.append(element(d,'h3',{text:'Per-source resolutions'}),list);
  }else root.append(message(d,'No multi-resolution representations published','The Lore owner has not exposed Lean/Balanced/Heavy representation receipts for these entries yet. No preview is treated as canonical.','historical'));

  const summaries=summarySurface?.summaries??[];
  if(summaries.length){
    root.append(element(d,'h3',{text:'Hierarchical navigation summaries'}));
    for(const summary of summaries.slice(0,40)){
      const card=element(d,'article',{className:'nexus-card'}),quality=summary.qualityReceipt?.status??'UNKNOWN';
      card.append(element(d,'div',{className:'nexus-inline-status'},element(d,'strong',{text:summary.label??humanLabel(summary.level??'Summary')}),makeBadge(d,humanLabel(summary.level??'SUMMARY'),'observed'),makeBadge(d,humanLabel(quality),String(quality).toUpperCase()==='PASS'?'ready':'warning'),makeBadge(d,'DERIVED / NO SOURCE AUTHORITY','historical')),
        createKeyValue(d,[{key:'Source revisions',value:(summary.sourceRevisionRefs??[]).length},{key:'Child summaries',value:(summary.childSummaryRefs??[]).length},{key:'Authority',value:summary.authorityClass??'DERIVED'},{key:'Exact source drillback',value:summarySurface.exactSourceDrillbackAvailable?'Available':'Not published'}]));
      if(detail!==ProductDetailLevel.NORMAL&&summary.content)card.append(element(d,'p',{text:String(summary.content).slice(0,1600)}));
      if(detail===ProductDetailLevel.ADVANCED)card.append(createKeyValue(d,[{key:'Summary ref',value:summary.summaryRef??'—'},{key:'Scope',value:summary.scopeId??'—'},{key:'Source revision fence',value:(summary.sourceRevisionRefs??[]).join(', ')||'none'}]));
      root.append(card);
    }
  }else root.append(message(d,'No hierarchical Lore summaries published','Worker 4 has not exposed a current navigation-summary surface through this installed assembly.','historical'));
  return root;
}

export function renderLoreAuthoringSurface(host,{loreStudy,loreAuthoring,actionRouter,scope,refresh,productAdapter,draft=null}={}){
  const d=host.ownerDocument,section=element(d,'section',{className:'nexus-wave13-lore-authoring',attrs:{'aria-label':'Lore authoring review'}});
  section.append(element(d,'div',{className:'nexus-wave13-section-head'},element(d,'h2',{text:'Lore authoring review'}),makeBadge(d,'PREVIEW ONLY','historical')),
    element(d,'p',{className:'nexus-muted',text:'Review exact source identity, edit impact, Tree proposals, and merge reconciliation from the Lore owner. These controls do not mutate Lore or Tree state.'}));
  if(!loreAuthoring){
    section.append(message(d,'Authoring contract unavailable','Worker 4 Lore authoring is not exported by this assembly. Study and retrieval remain separate from authoring review.','offline'));host.append(section);return;
  }
  const caps=loreAuthoring.capabilities(),state=draft??createLoreAuthoringDraftStore(),snapshot=loreAuthoring.snapshot?.()??{last:{}};
  const discovery=operatorValue(snapshot.last?.discovery),books=discovery?.books??[];
  const actions=element(d,'div',{className:'nexus-inline-status'});
  actions.append(createButton(d,{label:books.length?'Refresh authoring sources':'Load authoring sources',scope,size:'sm',variant:'quiet',disabled:!caps.discovery,onPress:async()=>{
    const result=await actionRouter.route({type:'wave13.loreAuthoring.discover',payload:{}});
    state.status=operatorRouteMessage(result,'Source identity loaded.');refresh?.();
  }}));
  section.append(actions);
  if(!caps.discovery)section.append(message(d,'Source identity unavailable','Worker 4 sourceDiscoveryIdentity() is not exported. No authoring preview will invent source identity.','offline'));
  if(!books.length){
    section.append(message(d,'No authoring sources loaded',state.status||'Load Worker 4’s persisted source identities after the selected Lorebook has been accepted and studied.','historical'));host.append(section);return;
  }

  const currentBookId=state.bookId&&books.some(x=>x.lorebookId===state.bookId)?state.bookId:(loreStudy?.selectedLorebook?.().snapshot?.id&&books.some(x=>x.lorebookId===loreStudy.selectedLorebook().snapshot.id)?loreStudy.selectedLorebook().snapshot.id:books[0].lorebookId);
  state.bookId=currentBookId;
  const book=books.find(x=>x.lorebookId===currentBookId)??books[0],sources=book.sources??[];
  if(!state.sourceId||!sources.some(x=>x.sourceId===state.sourceId))state.sourceId=sources[0]?.sourceId??null;
  const source=sources.find(x=>x.sourceId===state.sourceId)??null;
  const selectedSnapshot=loreStudy?.selectedLorebook?.().snapshot??null;
  const exactEntry=selectedSnapshot?.id===book.lorebookId?selectedSnapshot.entries?.find(x=>String(x.uid)===String(source?.uid)):null;
  if(state.contentSourceId!==source?.sourceId){
    state.contentSourceId=source?.sourceId??null;state.editContent=exactEntry?.content??'';
  }

  const identity=element(d,'section',{className:'nexus-card'});
  identity.append(element(d,'h3',{text:'1. Source identity'}),createKeyValue(d,[
    {key:'Lorebook',value:book.title??book.lorebookId},{key:'Persisted discovery receipt',value:book.discoveryIdentityPersisted?'Yes':'No'},
    {key:'Sources',value:sources.length},{key:'Current source',value:source?.metadata?.title??source?.uid??'none'},
  ]));
  const bookSelect=field(d,'select','Authoring lorebook');for(const row of books)bookSelect.append(option(d,row.lorebookId,row.title??row.lorebookId));bookSelect.value=book.lorebookId;
  const sourceSelect=field(d,'select','Authoring source');for(const row of sources)sourceSelect.append(option(d,row.sourceId,row.metadata?.title??row.uid??row.sourceId));sourceSelect.value=source?.sourceId??'';
  listenField(scope,bookSelect,'change',()=>{state.bookId=bookSelect.value;state.sourceId=null;state.contentSourceId=null;refresh?.();});
  listenField(scope,sourceSelect,'change',()=>{state.sourceId=sourceSelect.value;state.contentSourceId=null;refresh?.();});
  identity.append(labelWrap(d,'Lorebook',bookSelect),labelWrap(d,'Source',sourceSelect));
  if(productAdapter?.getDetailLevel?.()===ProductDetailLevel.ADVANCED&&source)identity.append(createKeyValue(d,[
    {key:'Source ID',value:source.sourceId},{key:'Source revision',value:source.sourceRevisionId},{key:'Content hash',value:source.contentHash},{key:'UID',value:source.uid},
  ]));
  section.append(identity);

  const edit=element(d,'section',{className:'nexus-card'});
  edit.append(element(d,'h3',{text:'2. Edit-impact preview'}),element(d,'p',{className:'nexus-muted',text:'Edit a local copy of the exact selected SillyTavern entry, then ask Worker 4 what would change. No source revision is applied.'}));
  const textarea=field(d,'textarea','Proposed authored content',{rows:'7',placeholder:exactEntry?'Edit this exact authored text to preview impact.':'Select this Lorebook in SillyTavern and refresh it before previewing an edit.'});textarea.value=state.editContent??'';
  listenField(scope,textarea,'input',()=>{state.editContent=String(textarea.value??'');});
  const previewEdit=createButton(d,{label:'Preview edit impact',scope,disabled:!caps.previewEdit||!source||!String(state.editContent??'').trim(),onPress:async()=>{
    const result=await actionRouter.route({type:'wave13.loreAuthoring.previewEdit',payload:{sourceId:source.sourceId,content:String(state.editContent??'')}});
    state.status=operatorRouteMessage(result,'Edit impact preview ready.');refresh?.();
  }});
  edit.append(textarea,previewEdit);
  if(!exactEntry)edit.append(message(d,'Exact authored text not loaded','The authoring identity contract proves the source, but this UI only pre-fills editable text from the currently selected SillyTavern Lorebook. Select that book and reload it instead of editing guessed content.','warning'));
  const editPreview=operatorValue(loreAuthoring.snapshot?.().last?.edit);
  if(editPreview){
    const change=editPreview.semanticChange??{},claims=change.claims??{},rels=change.relationships??{},plan=change.invalidationPlan??{};
    edit.append(message(d,'Preview only','Worker 4 evaluated a proposed revision without mutating the original Lore service.','ready'),createKeyValue(d,[
      {key:'Claims added / altered / superseded',value:[claims.added?.length??0,claims.altered?.length??0,claims.superseded?.length??0].join(' / ')},
      {key:'Relationships added / removed',value:[rels.added?.length??0,rels.removed?.length??0].join(' / ')},
      {key:'Unrelated ready sources remain ready',value:editPreview.allPreviouslyReadyUnrelatedSourcesRemainReady?'Yes':'No'},
      {key:'Invalidation targets',value:(plan.targets??[]).map(x=>x.target??x).join(', ')||'None reported'},
    ]));
    if(productAdapter?.getDetailLevel?.()===ProductDetailLevel.ADVANCED)edit.append(createKeyValue(d,[{key:'Base revision',value:editPreview.baseSourceRevisionId},{key:'Proposed revision',value:editPreview.proposedSourceRevisionId}]));
  }
  section.append(edit);

  const tree=element(d,'section',{className:'nexus-card'});
  tree.append(element(d,'h3',{text:'3. Tree Builder proposal'}),element(d,'p',{className:'nexus-muted',text:'Tree placement is a navigation proposal, not semantic truth and not a mutation.'}));
  tree.append(createButton(d,{label:'Preview Tree proposal',scope,disabled:!caps.tree,onPress:async()=>{
    const result=await actionRouter.route({type:'wave13.loreAuthoring.proposeTree',payload:{lorebookIds:[book.lorebookId]}});
    state.status=operatorRouteMessage(result,'Tree proposal ready.');refresh?.();
  }}));
  const treePlan=operatorValue(loreAuthoring.snapshot?.().last?.tree);
  if(treePlan){
    tree.append(createKeyValue(d,[{key:'Proposals',value:treePlan.proposals?.length??0},{key:'Review items',value:treePlan.reviewItems?.length??0},{key:'Revision fence',value:(treePlan.sourceRevisionFence??[]).length+' source revisions'},{key:'Mutation authority',value:treePlan.mutationAuthority?'Granted':'Not granted'}]));
    const list=element(d,'div',{className:'nexus-wave13-flow-list'});
    for(const row of (treePlan.proposals??[]).slice(0,20)){
      const item=element(d,'article',{className:'nexus-wave13-flow-row'});item.append(makeBadge(d,humanLabel(row.state??'NEEDS_REVIEW'),flowStatus(row.state)),element(d,'strong',{text:humanLabel(row.action)}),element(d,'span',{text:row.rationale??'Review proposal'}));list.append(item);
    }
    if(treePlan.proposals?.length)tree.append(list);
    if(productAdapter?.getDetailLevel?.()===ProductDetailLevel.ADVANCED)tree.append(createKeyValue(d,[{key:'Plan ID',value:treePlan.planId},{key:'Source revision fence',value:(treePlan.sourceRevisionFence??[]).join(', ')||'none'}]));
  }
  section.append(tree);

  const merge=element(d,'section',{className:'nexus-card'});
  merge.append(element(d,'h3',{text:'4. Merge / reconciliation preview'}),element(d,'p',{className:'nexus-muted',text:'Compare two studied Lorebooks while preserving contradictions and unique facts. Similarity is advisory only.'}));
  const secondSelect=field(d,'select','Merge comparison lorebook');const otherBooks=books.filter(x=>x.lorebookId!==book.lorebookId);secondSelect.append(option(d,'','Choose second Lorebook'));for(const row of otherBooks)secondSelect.append(option(d,row.lorebookId,row.title??row.lorebookId));secondSelect.value=state.mergeBookId??'';
  const previewMerge=createButton(d,{label:'Preview merge reconciliation',scope,disabled:!caps.merge||!state.mergeBookId,onPress:async()=>{
    const result=await actionRouter.route({type:'wave13.loreAuthoring.previewMerge',payload:{lorebookIds:[book.lorebookId,state.mergeBookId]}});
    state.status=operatorRouteMessage(result,'Merge preview ready.');refresh?.();
  }});
  listenField(scope,secondSelect,'change',()=>{state.mergeBookId=secondSelect.value;previewMerge.disabled=!caps.merge||!state.mergeBookId;});
  merge.append(labelWrap(d,'Compare with',secondSelect),previewMerge);
  const mergePreview=operatorValue(loreAuthoring.snapshot?.().last?.merge);
  if(mergePreview){
    const cls=mergePreview.classifications??{},validation=mergePreview.validation??{};
    merge.append(createKeyValue(d,[
      {key:'Unique semantic facts retained',value:validation.retainedEverySemanticFact?'Yes':'No'},
      {key:'Every current source mapped',value:validation.mappedEveryCurrentSource?'Yes':'No'},
      {key:'Contradictions kept separate',value:validation.preservedContradictionsSeparately?'Yes':'No'},
      {key:'Exact duplicates',value:cls.exactDuplicates?.length??0},{key:'Likely overlap',value:cls.likelyOverlap?.length??0},
      {key:'Complementary',value:cls.complementary?.length??0},{key:'Title/key collisions',value:cls.titleKeyCollisions?.length??0},{key:'Unresolved contradictions',value:cls.unresolvedContradictions?.length??0},
    ]));
    if(productAdapter?.getDetailLevel?.()===ProductDetailLevel.ADVANCED)merge.append(createKeyValue(d,[{key:'Preview ID',value:mergePreview.previewId},{key:'Source revision fence',value:(mergePreview.sourceRevisionFence??[]).join(', ')||'none'}]));
  }
  if(!caps.lifecycle)merge.append(message(d,'No destructive Apply action','This installed assembly exposes Worker 4’s review-only preview subset. Settlement-backed authoring is not exported here, so Nexus intentionally offers no Apply button.','historical'));
  section.append(merge);
  if(caps.lifecycle)section.append(renderLoreSettlementLifecycle(d,{loreAuthoring,actionRouter,scope,refresh,state,caps,book,secondBookId:state.mergeBookId,productAdapter}));
  if(state.status)section.append(element(d,'p',{className:'nexus-wave13-form-status',text:state.status,attrs:{role:'status','aria-live':'polite'}}));
  host.append(section);
}

function renderLoreSettlementLifecycle(d,{loreAuthoring,actionRouter,scope,refresh,state,caps,book,secondBookId,productAdapter}={}){
  const root=element(d,'section',{className:'nexus-card nexus-wave13-lore-settlement'});
  root.append(element(d,'h3',{text:'5. Reviewed authoring lifecycle'}),element(d,'p',{className:'nexus-muted',text:'This path is shown only because the installed Worker 4 contract exports checkpointed review, Final Preview, explicit approval, and Settlement. Preview or model suggestion alone cannot mutate Lore.'}));
  const outputId=field(d,'input','Merge output Lorebook ID',{type:'text',placeholder:'New Lorebook ID for approved merge',autocomplete:'off'});outputId.value=state.mergeOutputId??'';
  listenField(scope,outputId,'input',()=>{state.mergeOutputId=String(outputId.value??'').trim();refresh?.();});
  const start=element(d,'div',{className:'nexus-wave13-resource-actions'});
  start.append(createButton(d,{label:'Start reviewed Tree build',scope,size:'sm',disabled:Boolean(state.sessionId),onPress:async()=>{
    const route=await actionRouter.route({type:'wave13.loreAuthoring.startTreeBuild',payload:{lorebookIds:[book.lorebookId]}});
    const value=operatorRouteValue(route);if(value?.sessionId){state.sessionId=value.sessionId;state.status='Tree authoring session started. Review owner progress below.';}else state.status=operatorRouteMessage(route,'Tree authoring session started.');refresh?.();
  }}));
  const startMerge=createButton(d,{label:'Start reviewed Merge build',scope,size:'sm',disabled:Boolean(state.sessionId)||!secondBookId||!state.mergeOutputId,onPress:async()=>{
    const route=await actionRouter.route({type:'wave13.loreAuthoring.startMergeBuild',payload:{lorebookIds:[book.lorebookId,secondBookId],outputLorebookId:state.mergeOutputId}});
    const value=operatorRouteValue(route);if(value?.sessionId){state.sessionId=value.sessionId;state.status='Merge authoring session started. Review owner progress below.';}else state.status=operatorRouteMessage(route,'Merge authoring session started.');refresh?.();
  }});
  start.append(startMerge);root.append(start);
  if(caps.mergeLifecycle)root.append(labelWrap(d,'Merge output ID',outputId));

  if(!state.sessionId){root.append(message(d,'No active reviewed session','Start a Tree or Merge build to enter Worker 4’s checkpointed Draft Review flow. Nothing is applied during proposal/build stages.','historical'));return root;}
  const progress=operatorValue(loreAuthoring.authoringProgress({sessionId:state.sessionId}));
  if(!progress){root.append(message(d,'Authoring session unavailable','Worker 4 did not return progress for '+state.sessionId+'. No mutation control is enabled.','warning'));return root;}
  if(progress.settlement?.settlementId)state.settlementId=progress.settlement.settlementId;
  root.append(createKeyValue(d,[
    {key:'Type',value:progress.type??'—'},{key:'Stage',value:humanLabel(progress.stage??'UNKNOWN')},{key:'Build',value:String(progress.build?.cursor??0)+' / '+String(progress.build?.total??progress.totalActions??0)},
    {key:'Decisions',value:Object.entries(progress.decisions??{}).map(([key,value])=>humanLabel(key)+' '+value).join(' · ')||'None yet'},
    {key:'Draft revision',value:progress.draftRevision??'—'},{key:'Stale fence',value:progress.stale?.reason??'Current'},
  ]));
  if(progress.lastError)root.append(message(d,'Owner authoring failure',progress.lastError.message??progress.lastError.code??'Authoring failed.','warning'));

  if(['BUILDING','CHECKPOINTED'].includes(String(progress.stage))&&!progress.settlement){
    root.append(createButton(d,{label:'Resume build checkpoint',scope,size:'sm',onPress:async()=>{
      const route=await actionRouter.route({type:'wave13.loreAuthoring.resumeBuild',payload:{sessionId:state.sessionId,maxActions:32}});state.status=operatorRouteMessage(route,'Build checkpoint advanced.');refresh?.();
    }}));
  }

  const draft=operatorValue(loreAuthoring.draftReview({sessionId:state.sessionId}));
  if(draft?.actions?.length&&['DRAFT_REVIEW','FINAL_PREVIEW','READY_TO_SETTLE'].includes(String(progress.stage))){
    root.append(element(d,'h4',{text:'Draft Review'}));
    const list=element(d,'div',{className:'nexus-wave13-flow-list'});
    for(const action of draft.actions.slice(0,60)){
      const item=element(d,'article',{className:'nexus-card'}),decision=action.decision??null;
      item.append(element(d,'div',{className:'nexus-inline-status'},element(d,'strong',{text:humanLabel(action.action??action.type??action.proposedOutput?.action??'Authoring action')}),makeBadge(d,decision?humanLabel(decision):'Decision required',decision?'observed':'warning')),
        element(d,'p',{className:'nexus-muted',text:action.rationale??action.proposedOutput?.rationale??'Review the owner proposal against its exact source-revision fence.'}),
        createKeyValue(d,[{key:'Input source revisions',value:(action.inputSourceRevisions??[]).length},{key:'Affected Tree nodes',value:(action.affectedTreeNodes??[]).length},{key:'Materialized',value:action.materialized?'Yes':'No'}]));
      if(!decision){
        const decisions=element(d,'div',{className:'nexus-wave13-resource-actions'});
        for(const choice of ['ACCEPT','REJECT','DEFER'])decisions.append(createButton(d,{label:humanLabel(choice),scope,size:'sm',variant:choice==='ACCEPT'?'primary':'quiet',onPress:async()=>{
          const route=await actionRouter.route({type:'wave13.loreAuthoring.recordDecision',payload:{sessionId:state.sessionId,actionId:action.id,decision:choice,operatorDecisionId:'ui:'+state.sessionId+':'+action.id+':'+choice}});
          state.status=operatorRouteMessage(route,'Draft decision recorded.');refresh?.();
        }}));
        item.append(decisions);
      }
      if(productAdapter?.getDetailLevel?.()===ProductDetailLevel.ADVANCED&&action.id)item.append(element(d,'code',{text:action.id}));
      list.append(item);
    }
    root.append(list);
  }
  const allDecided=Boolean(draft?.actions?.length)&&draft.actions.every(action=>Boolean(action.decision));
  if(String(progress.stage)==='DRAFT_REVIEW'&&allDecided)root.append(createButton(d,{label:'Compute revision-fenced Final Preview',scope,onPress:async()=>{
    const route=await actionRouter.route({type:'wave13.loreAuthoring.computeFinalPreview',payload:{sessionId:state.sessionId}});state.status=operatorRouteMessage(route,'Final Preview computed from current source/dependency fences.');refresh?.();
  }}));

  const finalPreview=operatorValue(loreAuthoring.finalPreview({sessionId:state.sessionId}));
  if(finalPreview){
    root.append(element(d,'h4',{text:'Final Preview'}),createKeyValue(d,[
      {key:'Validation',value:finalPreview.validation?.ok?'PASS':'FAIL'},{key:'Operations',value:finalPreview.operations?.length??0},
      {key:'Authoritative semantic preflight',value:finalPreview.authoritativeSemanticPreflight?'Yes':'No'},{key:'Explicit approval required',value:finalPreview.explicitApprovalRequired?'Yes':'No'},
      {key:'Final Preview ID',value:finalPreview.finalPreviewId??'—'},
    ]));
    if(finalPreview.validation?.failures?.length)root.append(message(d,'Final Preview validation failed',finalPreview.validation.failures.join(', '),'warning'));
  }
  if(String(progress.stage)==='FINAL_PREVIEW'&&finalPreview?.validation?.ok)root.append(createButton(d,{label:'Approve current Final Preview',scope,onPress:async()=>{
    const route=await actionRouter.route({type:'wave13.loreAuthoring.approveFinalPreview',payload:{sessionId:state.sessionId,operatorApprovalId:'ui:final:'+state.sessionId+':'+String(progress.draftRevision??1)}});
    state.status=operatorRouteMessage(route,'Final Preview explicitly approved. Settlement is now owner-authorized against the current fences.');refresh?.();
  }}));

  if(caps.settlement&&(['READY_TO_SETTLE'].includes(String(progress.stage))||(progress.settlement&&String(progress.settlement.state)==='CHECKPOINTED'))){
    root.append(createButton(d,{label:progress.settlement?'Resume approved Settlement':'Apply approved Settlement',scope,onPress:async()=>{
      const route=await actionRouter.route({type:'wave13.loreAuthoring.applySettlement',payload:{sessionId:state.sessionId,maxOperations:32}});
      const value=operatorRouteValue(route);if(value?.settlementId)state.settlementId=value.settlementId;
      state.status=operatorRouteMessage(route,'Settlement owner processed the approved operations.');refresh?.();
    }}));
  }
  const settlementId=state.settlementId??progress.settlement?.settlementId??null;
  const settlement=settlementId?operatorValue(loreAuthoring.settlement({settlementId})):null;
  if(settlement){
    root.append(element(d,'h4',{text:'Settlement receipt'}),createKeyValue(d,[
      {key:'State',value:humanLabel(settlement.state??'UNKNOWN')},{key:'Applied',value:String(settlement.cursor??0)+' / '+String(settlement.operationCount??0)},
      {key:'Revision events',value:settlement.revisionEvents?.length??0},{key:'Invalidation receipts',value:settlement.invalidationReceipts?.length??0},
      {key:'Original sources deleted',value:settlement.originalSourcesDeleted?'Yes':'No'},{key:'Reconstructable',value:settlement.reconstructable?'Yes':'No'},
    ]));
    if(settlement.lastError)root.append(message(d,'Settlement failure',settlement.lastError.message??settlement.lastError.code??'Settlement failed.','warning'));
    if(caps.restoration&&String(settlement.state)==='SETTLED')root.append(createButton(d,{label:'Restore settled revisions',scope,variant:'quiet',onPress:async()=>{
      const route=await actionRouter.route({type:'wave13.loreAuthoring.restoreSettlement',payload:{settlementId,restorationId:'ui:restore:'+settlementId,maxOperations:32}});
      state.status=operatorRouteMessage(route,'Restoration owner processed the selected Settlement.');refresh?.();
    }}));
  }
  return root;
}

function createLoreAuthoringDraftStore(){return{bookId:null,sourceId:null,contentSourceId:null,editContent:'',mergeBookId:null,mergeOutputId:'',sessionId:null,settlementId:null,status:''};}

function operatorValue(result){return result?.ok===true?result.value??null:null;}

function operatorRouteValue(route){return route?.ok===true&&route.result?.ok===true?route.result.value??null:null;}

function operatorRouteMessage(route,success){
  if(!route?.ok)return'UI routing failed: '+String(route?.error??'unknown error');
  const owner=route.result;
  if(owner?.ok===false)return'Owner preview failed: '+String(owner.error?.message??owner.error?.code??'unknown error');
  return success;
}

// Conflict sets under the Lore owner's rule R4. ESTABLISHED = incompatible values with provably overlapping applicability;
// POSSIBLE = the overlap or event identity is not established (shown, never an adjudication). A Jev advisory, if the native
// path recorded one, is shown as advisory only: nothing here resolves, applies or edits anything.
function renderLoreConflicts(d,conflicts){
  const root=element(d,'div',{className:'nexus-wave13-lore-conflicts'});
  if(!conflicts.length){root.append(message(d,'No conflicts','The Lore owner reports no conflicting claims for the accepted sources.','historical'));return root;}
  for(const conflict of conflicts.slice(0,40)){
    const certainty=String(conflict.certainty??'ESTABLISHED').toUpperCase();
    const card=element(d,'article',{className:'nexus-card nexus-wave13-lore-conflict',dataset:{certainty}});
    card.append(element(d,'div',{className:'nexus-inline-status'},element(d,'strong',{text:'Conflict · '+humanLabel(conflict.property??'property')}),makeBadge(d,certainty,certainty==='ESTABLISHED'?'warning':'historical'),makeBadge(d,'UNRESOLVED','historical')));
    card.append(element(d,'p',{className:'nexus-muted',text:certainty==='ESTABLISHED'
      ?'The Lore owner found values that cannot both hold at the same time on the same continuity. Nothing is resolved by showing this.'
      :'The owner could not establish that these claims apply to the same event or continuity ('+String(conflict.basis??'unestablished')+'). Shown for review, not adjudication.'}));
    const values=Array.isArray(conflict.values)?conflict.values:[];
    const alternatives=Array.isArray(conflict.alternatives)?conflict.alternatives:[values.map(v=>v.artifactId)];
    alternatives.slice(0,6).forEach((group,index)=>{
      const rows=values.filter(v=>group.includes(v.artifactId));
      card.append(createKeyValue(d,[{key:'Alternative '+(index+1),value:rows.map(v=>String(v.value)+' ('+String(v.attribution??'ASSERTED').toLowerCase()+(v.speaker?' by '+v.speaker:'')+')').join(' · ')||'—'}]));
    });
    const advisory=conflict.jevAdvisory;
    if(advisory){
      const status=String(advisory.status??'').toUpperCase();
      card.append(element(d,'div',{className:'nexus-inline-status'},element(d,'strong',{text:'Jev advisory'}),makeBadge(d,status==='ADVISED'?(advisory.current?'ADVISORY · CURRENT':'ADVISORY · STALE'):humanLabel(status||'UNKNOWN'),status==='ADVISED'&&advisory.current?'observed':'historical'),makeBadge(d,'NEXT TURN · ADVISORY ONLY','historical')));
      card.append(createKeyValue(d,[{key:'Classification',value:advisory.classification?humanLabel(advisory.classification):'—'},{key:'Lore owner review',value:advisory.ownerDecision?humanLabel(advisory.ownerDecision):'—'}]));
    }
    root.append(card);
  }
  return root;
}

function renderLoreEntries(d,entries,scope,{showIds=false}={}){
  const root=element(d,'div',{className:'nexus-wave13-lore-entries'});
  for(const row of entries.slice(0,80)){
    const state=String(row.operatorState??'ACCEPTED').toUpperCase(),card=element(d,'article',{className:'nexus-card nexus-wave13-lore-entry',dataset:{state}});
    card.append(element(d,'div',{className:'nexus-inline-status'},element(d,'strong',{text:'Lore entry'}),makeBadge(d,humanLabel(state),loreStateStatus(state))));
    const explanation=state==='READY'?'Learned representations are current and the Lore owner reports this entry retrieval-ready.'
      :state==='STUDYING'?'Study is in progress; this entry is not retrieval-ready yet.'
      :state==='FAILED'?'The Lore owner reports study failure; this entry must not be presented as ready.'
      :state==='REMOVED'?'The source entry has been removed and is not retrieval-ready.'
      :'The authored source has been accepted, but acceptance alone is not learning or readiness.';
    const details=[{key:'Study state',value:row.studyState??humanLabel(state)},{key:'Representations',value:row.retrievalRepresentations?.length??0}];
    if(showIds)details.push({key:'Entry UID',value:row.uid??'—'},{key:'Source revision',value:row.sourceRevisionId??'—'},{key:'Learned revision',value:row.learnedRevisionId??'—'});
    card.append(element(d,'p',{text:explanation}),createKeyValue(d,details));
    const revisionChanged=Boolean(row.sourceRevisionId&&row.learnedRevisionId&&row.freshness!=='CURRENT');
    if(revisionChanged)card.append(message(d,'Source revision changed','The authored source revision differs from the learned/current representation. Existing derived Lore is not treated as current until the Lore owner re-studies and publishes readiness.','warning'));
    if(row.studyError)card.append(message(d,'Study error',row.studyError.message??row.studyError.code??'Owner reported a study failure.','warning'));
    if(row.retrievalRepresentations?.some(x=>x.unresolved))card.append(makeBadge(d,'UNRESOLVED','warning'));root.append(card);
  }
  return root;
}

function loreStateStatus(state){if(state==='READY')return'ready';if(state==='STUDYING')return'loading';if(state==='FAILED')return'warning';if(state==='REMOVED')return'offline';return'historical';}

function stageCard(d,row,scope,inspect,{showIds=false,inspection=null}={}){
  const card=element(d,'article',{className:'nexus-wave13-stage',dataset:{state:row.state,producerId:row.id}});
  card.append(element(d,'div',{className:'nexus-inline-status'},element(d,'strong',{text:row.label}),makeBadge(d,row.state,stageStatus(row.state))));
  card.append(element(d,'p',{text:row.reason||'No additional detail.'}));
  if(showIds&&row.turnId)card.append(element(d,'span',{className:'nexus-muted',text:'turn '+row.turnId+(row.freshness?' · '+row.freshness:'')+(row.errorCode?' · '+row.errorCode:'')}));
  if(inspect){
    const target=inspection??{kind:'wave13-producer-inspection',id:'producer:'+row.id+':'+String(row.turnId??'no-turn'),producerId:row.id,title:row.label+' detail',available:false,availabilityState:row.state===OperatorProducerState.WORKING?'PENDING':'NO_SELECTED_TURN_EVIDENCE',selection:{chatId:row.chatId??null,turnId:row.turnId??null,generationId:row.generationId??null},reason:row.reason||'No selected-turn owner receipt is available.',payload:{kind:'ProducerInspectionState',status:'UNAVAILABLE',reason:row.reason||'No selected-turn owner receipt is available.'}};
    card.append(createButton(d,{label:'Inspect details',ariaLabel:'Inspect '+row.label+' for the selected turn',scope,size:'sm',variant:'inspect',onPress:()=>inspect(target)}));
  }
  return card;
}

function header(d,title,subtitle){const h=element(d,'div',{className:'nexus-workspace-header'});h.append(element(d,'h1',{text:title}),element(d,'p',{className:'nexus-muted',text:subtitle}));return h;}

function message(d,title,text,status='ready'){const r=element(d,'section',{className:'nexus-state-message',attrs:{role:status==='error'?'alert':'status'},dataset:{status}});r.append(element(d,'strong',{text:title}),element(d,'span',{text:String(text??'')}));return r;}

function labelWrap(d,label,node){const root=element(d,'label',{className:'nexus-wave13-field'});root.append(element(d,'span',{text:label}),node);return root;}

function field(d,tag,label,attrs={}){return element(d,tag,{className:'nexus-input',attrs:{'aria-label':label,...attrs}});}

function option(d,value,label){return element(d,'option',{text:label,attrs:{value}});}

function stageStatus(v){if(v===OperatorProducerState.LIVE)return'ready';if(v===OperatorProducerState.WORKING)return'loading';if(v===OperatorProducerState.DEGRADED)return'warning';if(v===OperatorProducerState.IDLE||v===OperatorProducerState.WAITING_FOR_TURN)return'historical';return'offline';}
