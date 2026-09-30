import { createButton, createKeyValue, element, makeBadge } from './primitives.js';
import { renderBrainDecisionExplanation } from './brain-decision-visibility.js';
import { renderSelectedTurnGraphVisibility } from './selected-turn-graph-visibility.js';

export const TURN_LOG_DIAGNOSTICS_VERSION='1.3.0';
const DEFAULT_MAX_VISIBLE=96;
const DEFAULT_MAX_DETAIL_BYTES=12288;
const CATEGORY_ORDER=['HOST','EDGE','COGNITION','RUNTIME','RESOURCE','RESULT','GATHER','CONTEXT','DELIVERY','LEARNING','ERROR'];
const SEVERITY_ORDER=['ERROR','WARN','OK','INFO'];
const BLOCKED_KEYS=new Set(['rawprompt','prompt','prompttext','story','storytext','lorebody','contentbody','responsebody','reasoning','hiddenreasoning','apikey','api_key','authorization','credential','credentials','password','secret','access_token','refresh_token']);

export class SelectedTurnLogModel{
  constructor({journal,selectionProvider=()=>({}),decisionVisibility=null,graphVisibility=null,diagnostics=null,now=()=>Date.now(),maxVisibleRows=DEFAULT_MAX_VISIBLE,maxDetailBytes=DEFAULT_MAX_DETAIL_BYTES}={}){
    this.journal=journal??null;this.decisionVisibility=decisionVisibility??null;this.graphVisibility=graphVisibility??null;this.diagnostics=diagnostics??null;
    this.selectionProvider=typeof selectionProvider==='function'?selectionProvider:()=>({});
    this.now=typeof now==='function'?now:()=>Date.now();
    this.maxVisibleRows=Math.max(16,Math.min(256,Number(maxVisibleRows)||DEFAULT_MAX_VISIBLE));
    this.maxDetailBytes=Math.max(2048,Math.min(65536,Number(maxDetailBytes)||DEFAULT_MAX_DETAIL_BYTES));
  }

  read({selection=null,filters={}}={}){
    const selected=normalizeSelection(selection??this.selectionProvider?.()??{});
    const turn=this.journal?.readTurn?.(selected)??null;
    const allRows=buildTurnRows(turn,selected);
    const normalizedFilters=normalizeFilters(filters,this.now());
    const filtered=allRows.filter(row=>matchesFilters(row,normalizedFilters));
    const truncated=filtered.length>this.maxVisibleRows;
    const rows=boundedVisibleRows(filtered,this.maxVisibleRows).map(stripPrivate);
    const status=this.journal?.status?.()??null;
    return safeClone({
      kind:'Area52SelectedTurnLog',contractVersion:TURN_LOG_DIAGNOSTICS_VERSION,selection:selected,
      current:Boolean(selected.chatId&&selected.turnId&&selected.generationId),firstSeenAt:turn?.firstSeenAt??null,lastUpdatedAt:turn?.lastUpdatedAt??null,
      filters:normalizedFilters,rows,totalRows:allRows.length,matchingRows:filtered.length,visibleRows:rows.length,truncated,
      availableCategories:CATEGORY_ORDER.filter(category=>allRows.some(row=>row.category===category)),
      availableSeverities:SEVERITY_ORDER.filter(severity=>allRows.some(row=>row.severity===severity)),
      summary:summarize(turn,allRows),brainDecision:safeDecisionRead(this.decisionVisibility,selected),graphTrace:safeGraphRead(this.graphVisibility,selected),retention:status,
      chronology:'OWNER_STAGE_ORDER_WITH_EXACT_TIMESTAMPS_WHEN_PUBLISHED',
      safety:{metadataOnly:true,rawPrompts:false,storyLoreBodies:false,credentials:false,hiddenReasoning:false,mutationAuthority:false},
    });
  }

  detail(rowId,{selection=null}={}){
    const selected=normalizeSelection(selection??this.selectionProvider?.()??{});
    const turn=this.journal?.readTurn?.(selected)??null;
    const row=buildTurnRows(turn,selected).map(stripPrivate).find(item=>item.id===rowId)??null;
    return row?detailPayload(this.journal,selected,row,this.maxDetailBytes):null;
  }

  readOperational(){
    return safeDiagnosticsRead(this.diagnostics);
  }

  setGenerationProfiling(enabled=false){
    try{
      if(typeof this.diagnostics?.setGenerationProfiling!=='function')return{ok:false,enabled:null,reason:'PROFILING_CONTROL_UNAVAILABLE',sessionScoped:true,persisted:false};
      return this.diagnostics.setGenerationProfiling(Boolean(enabled));
    }catch(error){
      return{ok:false,enabled:null,reason:error?.code??String(error?.message??error),sessionScoped:true,persisted:false};
    }
  }

  readTimeline({filters={}}={}){
    const evidence=this.journal?.exportEvidence?.({selection:null})??{turns:[]};
    const normalizedFilters=normalizeFilters(filters,this.now());
    const allRows=[];
    for(const turn of evidence.turns??[]){
      const turnSelection=normalizeSelection(turn.selection??{});
      for(const row of buildTurnRows(turn,turnSelection)){
        const publicRow=stripPrivate(row);
        allRows.push({...publicRow,selection:turnSelection,turnKey:turn.key??selectionKey(turnSelection)});
      }
    }
    allRows.sort((a,b)=>numericTime(a.time??a.observedAt)-numericTime(b.time??b.observedAt)||String(a.id).localeCompare(String(b.id)));
    const filtered=allRows.filter(row=>matchesFilters(row,normalizedFilters));
    const truncated=filtered.length>this.maxVisibleRows;
    const rows=boundedVisibleRows(filtered,this.maxVisibleRows);
    return safeClone({
      filters:normalizedFilters,rows,totalRows:allRows.length,matchingRows:filtered.length,visibleRows:rows.length,truncated,
      availableCategories:CATEGORY_ORDER.filter(category=>allRows.some(row=>row.category===category)),
      availableSeverities:SEVERITY_ORDER.filter(severity=>allRows.some(row=>row.severity===severity)),
    });
  }

  exportDiagnostics({selection=null}={}){
    const selected=normalizeSelection(selection??this.selectionProvider?.()??{});
    const retainedEvidence=this.journal?.exportEvidence?.({selection:null})??null;
    const operational=operationalForSelection(safeDiagnosticsRead(this.diagnostics),selected);
    const selectedTurn=this.exportMetadata({selection:selected});
    const timeline=buildMasterTimeline(retainedEvidence);
    const errors=collectDiagnosticErrors(operational,timeline);
    return sanitize({
      kind:'Area52DiagnosticsExport',contractVersion:TURN_LOG_DIAGNOSTICS_VERSION,exportedAt:this.now(),
      manifest:{
        product:'Nexus',surface:'Diagnostics',selection:selected,
        retainedTurns:retainedEvidence?.turns?.length??0,retainedTimelineEvents:timeline.length,
        selectedTurnRows:selectedTurn?.rows?.length??0,errorCount:errors.length,
      },
      operationalSnapshot:operational,selectedTurn,retainedEvidence,timeline,errors,
      safety:{metadataOnly:true,rawPrompts:false,storyLoreBodies:false,credentials:false,hiddenReasoning:false,mutationAuthority:false},
    });
  }

  exportUnifiedDiagnostics({selection=null}={}){
    const legacy=this.exportDiagnostics({selection}),op=legacy.operationalSnapshot??{},selectedTurn=legacy.selectedTurn??{},manifest=legacy.manifest??{};
    const ownerTurn=op?.nativeBrainIntegration?.selectedTurnReceipt??op?.generationInspection?.selectedTurnReceipt??op?.selectedTurnReceipt??null;
    return sanitize({
      kind:'Area52UnifiedDiagnosticsExport',
      contractVersion:TURN_LOG_DIAGNOSTICS_VERSION,
      exportedAt:legacy.exportedAt,
      manifest:{
        ...manifest,
        format:'single-json',
        bounded:true,
        source:'Nexus Diagnostics retained metadata',
      },
      selection:manifest.selection??selectedTurn.selection??normalizeSelection(selection??this.selectionProvider?.()??{}),
      summary:{
        selectedTurn:selectedTurn.summary??null,
        retainedTurns:manifest.retainedTurns??0,
        retainedTimelineEvents:manifest.retainedTimelineEvents??0,
        selectedTurnRows:manifest.selectedTurnRows??0,
        errorCount:manifest.errorCount??0,
        chronology:selectedTurn.chronology??null,
      },
      generationPerformance:op.generationPerformance??null,
      brain:{
        producers:op.producers??null,
        pipeline:op.pipeline??null,
        generationInspection:op.generationInspection??null,
        denseRetrieval:ownerTurn?.denseRetrieval??op.generationInspection?.denseRetrieval??op.generationInspection?.memoryDensePrime??null,
        completionLifecycle:ownerTurn?.completionLifecycle??op.generationInspection?.completionLifecycle??null,
        memoryRetrievalFeedback:ownerTurn?.memoryRetrievalFeedback??op.generationInspection?.memoryRetrievalFeedback??op.memory?.retrievalFeedback?.last??null,
        decision:selectedTurn.brainDecision??null,
        graph:selectedTurn.graphTrace??op.graph??null,
      },
      runtime:op.runtime??null,
      resources:{
        resources:op.resources??null,
        vectoringTrace:op.vectoringTrace??null,
        wiring:op.wiring??null,
        coprocessor:op.coprocessor??null,
      },
      knowledge:{
        lore:op.lore??null,
        memory:op.memory??null,
        cognition:op.cognition??null,
      },
      diagnosticsUi:op.telemetry?.uiLoad??null,
      errors:legacy.errors??[],
      eventTimeline:legacy.timeline??[],
      selectedTurn,
      retainedEvidence:legacy.retainedEvidence??null,
      retention:selectedTurn.retention??null,
      rawOperationalSnapshot:op,
      bounds:{
        retainedTurns:manifest.retainedTurns??0,
        retainedTimelineEvents:manifest.retainedTimelineEvents??0,
        selectedTurnRows:manifest.selectedTurnRows??0,
        retentionBounded:true,
      },
      safety:{
        ...(legacy.safety??{}),
        metadataOnly:true,
        rawPrompts:false,
        storyLoreBodies:false,
        providerBodies:false,
        credentials:false,
        hiddenReasoning:false,
        mutationAuthority:false,
      },
    });
  }

  downloadDiagnosticsJson({selection=null,document=globalThis.document??null,filename=null}={}){
    const payload=this.exportUnifiedDiagnostics({selection}),json=JSON.stringify(payload,null,2),BlobCtor=globalThis.Blob,URLApi=globalThis.URL;
    const downloadName=filename??'Area52-Diagnostics-'+fileTimestamp(payload.exportedAt)+'.json';
    if(!document?.createElement||typeof BlobCtor!=='function'||typeof URLApi?.createObjectURL!=='function')return{ok:false,reason:'DOWNLOAD_API_UNAVAILABLE',filename:downloadName,bundleFormat:'json',payload,json};
    const blob=new BlobCtor([json],{type:'application/json'}),url=URLApi.createObjectURL(blob),a=document.createElement('a');
    a.href=url;a.download=downloadName;a.style.display='none';document.body?.append?.(a);
    try{a.click?.();}finally{a.remove?.();URLApi.revokeObjectURL?.(url);}
    return{ok:true,filename:a.download,bundleFormat:'json',payload,json};
  }

  downloadFullDiagnostics({selection=null,document=globalThis.document??null,filename=null}={}){
    const payload=this.exportDiagnostics({selection}),files=diagnosticsBundleFiles(payload),BlobCtor=globalThis.Blob,URLApi=globalThis.URL;
    if(!document?.createElement||typeof BlobCtor!=='function'||typeof URLApi?.createObjectURL!=='function')return{ok:false,reason:'DOWNLOAD_API_UNAVAILABLE',payload,files};
    const stamp=fileTimestamp(payload.exportedAt),base='Area52-Diagnostics-'+stamp;
    let blob=createStoredZipBlob(files,{BlobCtor,TextEncoderCtor:globalThis.TextEncoder,exportedAt:payload.exportedAt}),bundleFormat='zip',downloadName=filename??base+'.zip';
    if(!blob){bundleFormat='json';downloadName=filename??base+'.json';blob=new BlobCtor([JSON.stringify(payload,null,2)],{type:'application/json'});}
    const url=URLApi.createObjectURL(blob),a=document.createElement('a');
    a.href=url;a.download=downloadName;a.style.display='none';document.body?.append?.(a);
    try{a.click?.();}finally{a.remove?.();URLApi.revokeObjectURL?.(url);}
    return{ok:true,filename:a.download,bundleFormat,payload,files};
  }

  exportMetadata({selection=null}={}){
    const selected=normalizeSelection(selection??this.selectionProvider?.()??{}),turn=this.journal?.readTurn?.(selected)??null;
    const rows=buildTurnRows(turn,selected).map(stripPrivate),details={};
    for(const row of rows){
      if(!row.sourceEntryIds?.length)continue;
      const detail=detailPayload(this.journal,selected,row,this.maxDetailBytes);
      if(detail)details[row.id]=detail;
    }
    return sanitize({
      kind:'Area52SelectedTurnLogExport',contractVersion:TURN_LOG_DIAGNOSTICS_VERSION,exportedAt:this.now(),
      selection:selected,summary:summarize(turn,rows),brainDecision:safeDecisionRead(this.decisionVisibility,selected),graphTrace:safeGraphRead(this.graphVisibility,selected),rows,details,retention:this.journal?.status?.()??null,
      chronology:'OWNER_STAGE_ORDER_WITH_EXACT_TIMESTAMPS_WHEN_PUBLISHED',
      safety:{metadataOnly:true,rawPrompts:false,storyLoreBodies:false,credentials:false,hiddenReasoning:false,mutationAuthority:false},
    });
  }


  exportDiagnosticsBundle({selection=null,operationalSnapshot=null}={}){
    const selectedTurn=this.exportMetadata({selection}),exportedAt=this.now();
    const cleanOperational=sanitize(operationalSnapshot??null);
    const manifest=sanitize({
      kind:'Area52DiagnosticsBundleManifest',contractVersion:TURN_LOG_DIAGNOSTICS_VERSION,exportedAt,
      selection:selectedTurn.selection,
      sources:{
        selectedTurn:true,
        operationalSnapshot:Boolean(cleanOperational),
        brainDecision:Boolean(selectedTurn.brainDecision),
        eventTimeline:true,
        retention:Boolean(selectedTurn.retention),
      },
      chronology:selectedTurn.chronology,
      safety:selectedTurn.safety,
      note:'This bundle contains every bounded diagnostic surface currently retained by the Nexus Diagnostics UI. Missing owner evidence remains explicitly missing and is never reconstructed.',
    });
    const files=[
      {path:'manifest.json',content:JSON.stringify(manifest,null,2)},
      {path:'selected-turn/diagnostics.json',content:JSON.stringify(selectedTurn,null,2)},
      {path:'selected-turn/timeline.json',content:JSON.stringify(selectedTurn.rows??[],null,2)},
      {path:'selected-turn/timeline.jsonl',content:(selectedTurn.rows??[]).map(row=>JSON.stringify(row)).join('\n')},
      {path:'selected-turn/brain-decision.json',content:JSON.stringify(selectedTurn.brainDecision??null,null,2)},
      {path:'session/operational-snapshot.json',content:JSON.stringify(cleanOperational??null,null,2)},
      {path:'session/generation-performance.json',content:JSON.stringify(cleanOperational?.generationPerformance??null,null,2)},
      {path:'session/retention.json',content:JSON.stringify(selectedTurn.retention??null,null,2)},
      {path:'README.txt',content:'Nexus Diagnostics export\n\nThis archive is metadata-only. Raw prompts, story/Lore bodies, credentials, keys, and hidden reasoning are excluded. Missing evidence is reported as missing rather than inferred.\n'},
    ];
    return{kind:'Area52DiagnosticsBundle',contractVersion:TURN_LOG_DIAGNOSTICS_VERSION,exportedAt,selection:selectedTurn.selection,manifest,files};
  }

  downloadDiagnosticsBundle({selection=null,operationalSnapshot=null,document=globalThis.document??null,filename=null}={}){
    const bundle=this.exportDiagnosticsBundle({selection,operationalSnapshot});
    const BlobCtor=globalThis.Blob,URLApi=globalThis.URL;
    if(!document?.createElement||typeof BlobCtor!=='function'||typeof URLApi?.createObjectURL!=='function'||typeof globalThis.TextEncoder!=='function')return{ok:false,reason:'DOWNLOAD_API_UNAVAILABLE',bundle};
    const blob=createStoredZipBlob(bundle.files,{BlobCtor,TextEncoderCtor:globalThis.TextEncoder,exportedAt:bundle.exportedAt});
    if(!blob)return{ok:false,reason:'ZIP_BUILD_FAILED',bundle};
    const url=URLApi.createObjectURL(blob),a=document.createElement('a'),id=bundle.selection;
    a.href=url;a.download=filename??['area52-diagnostics',id?.chatId,id?.turnId,id?.generationId].filter(Boolean).map(filePart).join('-')+'.zip';a.style.display='none';document.body?.append?.(a);
    try{a.click?.();}finally{a.remove?.();URLApi.revokeObjectURL?.(url);}
    return{ok:true,filename:a.download,bundle};
  }

  download({selection=null,document=globalThis.document??null,filename=null}={}){
    const payload=this.exportMetadata({selection}),json=JSON.stringify(payload,null,2);
    const BlobCtor=globalThis.Blob,URLApi=globalThis.URL;
    if(!document?.createElement||typeof BlobCtor!=='function'||typeof URLApi?.createObjectURL!=='function')return{ok:false,reason:'DOWNLOAD_API_UNAVAILABLE',payload,json};
    const blob=new BlobCtor([json],{type:'application/json'}),url=URLApi.createObjectURL(blob),a=document.createElement('a'),id=payload.selection;
    a.href=url;a.download=filename??['area52-turn-log',id?.chatId,id?.turnId,id?.generationId].filter(Boolean).map(filePart).join('-')+'.json';a.style.display='none';document.body?.append?.(a);
    try{a.click?.();}finally{a.remove?.();URLApi.revokeObjectURL?.(url);}
    return{ok:true,filename:a.download,payload,json};
  }
}

export function installTurnLogDiagnosticsWorkspace(registry,{journal,selectionProvider=()=>({}),decisionVisibility=null,graphVisibility=null,diagnostics=null,maxVisibleRows=DEFAULT_MAX_VISIBLE}={}){
  if(!registry||!journal)return null;
  const model=new SelectedTurnLogModel({journal,selectionProvider,decisionVisibility,graphVisibility,diagnostics,maxVisibleRows});
  const filters={time:'ALL',category:'ALL',severity:'ALL',search:''};
  const id='turn-log';
  if(!registry.has(id))registry.register({
    id,title:'Diagnostics',icon:'⌁',category:'Product',navigation:{level:'product',order:85},preferredWidth:1180,views:['normal','detail','advanced'],supportedActions:['export-diagnostics','export-metadata','filter','drilldown'],
    render(host,ctx){renderTurnLogWorkspace(host,{...ctx,model,filters});},
  });
  return{model,release(){try{registry.unregister(id);}catch{}},filters};
}

export function buildSelectedTurnLog(turn,selection={}){
  return buildTurnRows(turn,normalizeSelection(selection)).map(stripPrivate);
}

function renderTurnLogWorkspace(host,{model,filters,scope,refresh,inspect}={}){
  const d=host.ownerDocument,snapshot=model.read({filters}),timeline=model.readTimeline({filters}),operational=model.readOperational(),s=snapshot.selection??{};
  const generationPerf=operational?.generationPerformance??null,profileControl=generationPerf?.control??{},profileEnabled=profileControl.enabled===true;
  const stages=generationPerf?.brainStages??[],stageMs=(name)=>stages.find(row=>row.stage===name)?.wallMs??null,detailed=generationPerf?.detailed??null;
  const errorRows=timeline.rows.filter(row=>row.severity==='ERROR'||row.severity==='WARN'),cognitionErrors=Object.entries(operational?.cognition?.errors??{});
  const errorCount=collectDiagnosticErrors(operational,[]).length+errorRows.length,status=diagnosticsStatus(snapshot,operational);
  const root=element(d,'section',{className:'a52-turn-log a52-diagnostics-console a52-diagnostics-command-center',attrs:{'aria-label':'Nexus diagnostics console'}});

  const command=element(d,'header',{className:'a52-diagnostics-command'});
  const commandTitle=element(d,'div',{className:'a52-diagnostics-command__title'});
  commandTitle.append(
    element(d,'span',{className:'a52-diagnostics-command__eyebrow',text:'COGNITIVE OPERATIONS / LIVE FORENSICS'}),
    element(d,'h1',{text:'Nexus Diagnostics Command Center'}),
    element(d,'p',{className:'a52-muted',text:'Trace one Nexus generation from Brain preparation through host insertion, provider wait, learning, and browser-side load — without exposing story content.'}),
  );
  const commandIdentity=element(d,'div',{className:'a52-diagnostics-command__identity'});
  commandIdentity.append(
    diagnosticIdentityChip(d,'CHAT',shortDiagnosticId(s.chatId),'historical'),
    diagnosticIdentityChip(d,'TURN',shortDiagnosticId(s.turnId),'observed'),
    diagnosticIdentityChip(d,'GEN',shortDiagnosticId(s.generationId),'ready'),
    diagnosticIdentityChip(d,'PROFILE',profileControl.enabled==null?'NO EVIDENCE':profileEnabled?'ARMED':'OFF',profileEnabled?'ready':profileControl.enabled==null?'historical':'warning'),
  );
  const commandActions=element(d,'div',{className:'a52-diagnostics-command__actions'});
  commandActions.append(
    makeBadge(d,status.label,status.token),
    createButton(d,{label:'Export Diagnostics JSON',scope,size:'sm',variant:'primary',onPress:()=>model.downloadDiagnosticsJson({selection:s,document:d})}),
    createButton(d,{label:'Export Full Diagnostics ZIP',scope,size:'sm',variant:'secondary',onPress:()=>model.downloadFullDiagnostics({selection:s,document:d})}),
    createButton(d,{label:'Refresh',scope,size:'sm',variant:'quiet',onPress:()=>refresh?.()}),
  );
  command.append(commandTitle,commandIdentity,commandActions);root.append(command);

  const pipeline=operational?.pipeline??{},resourceRows=operational?.resources?.rows??[],retained=snapshot.retention??{};
  const kpis=element(d,'section',{className:'a52-diagnostics-kpi-strip',attrs:{'aria-label':'Diagnostics status summary'}});
  kpis.append(
    diagnosticKpi(d,{icon:'●',label:'SYSTEM STATE',value:status.label,detail:(operational?.producers?.active??0)+' active producers · '+(operational?.producers?.failures??0)+' failures',tone:status.token}),
    diagnosticKpi(d,{icon:'⌁',label:'SELECTED GENERATION',value:s.generationId?shortDiagnosticId(s.generationId,20):'WAITING',detail:(snapshot.summary?.logicalJobs??0)+' logical jobs · '+(pipeline.returnedResults??0)+' results',tone:s.generationId?'observed':'historical'}),
    diagnosticKpi(d,{icon:'◉',label:'FLIGHT RECORDER',value:profileControl.enabled==null?'NO EVIDENCE':profileEnabled?'ARMED':'STANDBY',detail:(generationPerf?.retention?.retainedProfiles??0)+' / '+(generationPerf?.retention?.maxProfiles??'—')+' detailed profiles',tone:profileEnabled?'ready':'historical'}),
    diagnosticKpi(d,{icon:errorCount?'!':'✓',label:'NEEDS ATTENTION',value:String(errorCount),detail:errorCount?'Warnings or errors retained for review':'No retained warning/error evidence',tone:errorCount?'warning':'ready'}),
  );
  root.append(kpis);

  const primary=element(d,'section',{className:'a52-diagnostics-primary-grid'});
  const flight=diagnosticPanel(d,{icon:'◉',title:'Generation Flight Recorder',subtitle:'Exact selected-generation latency map',badge:detailed?'DETAILED':stages.length?'BRAIN TIMINGS':'NO EVIDENCE',tone:detailed?'ready':stages.length?'observed':'historical',className:'a52-diagnostics-flight'});
  flight.body.append(element(d,'span',{className:'a52-eyebrow',text:'Performance / generation profiling'}));
  const profilerControl=element(d,'div',{className:'a52-generation-profiler-control a52-generation-profiler-control--hero'});
  const profilerStatus=element(d,'div',{className:'a52-inline-status'});
  profilerStatus.append(element(d,'strong',{text:'Detailed generation profiling'}),makeBadge(d,profileControl.enabled==null?'NO_EVIDENCE':profileEnabled?'ON':'OFF',profileEnabled?'ready':profileControl.enabled==null?'historical':'warning'));
  const toggle=createButton(d,{label:profileEnabled?'Turn profiling OFF':'Turn profiling ON',scope,size:'sm',variant:profileEnabled?'primary':'secondary',onPress:()=>{model.setGenerationProfiling(!profileEnabled);refresh?.();}});
  toggle.setAttribute('role','switch');toggle.setAttribute('aria-checked',String(profileEnabled));
  if(!profileControl.available){toggle.disabled=true;toggle.setAttribute('disabled','');}
  profilerControl.append(profilerStatus,toggle,element(d,'p',{className:'a52-muted',text:profileControl.available?'Session only. Arm before the generation you want to measure; a new live session starts OFF.':'This installed session does not expose detailed browser profiling.'}));
  flight.body.append(profilerControl);

  const phases=[
    {id:'brain',label:'Brain pre-generation',ms:stageMs('BRAIN_PREPARATION_TOTAL'),tone:'cyan'},
    {id:'host-prep',label:'Host preparation',ms:stageMs('HOST_PREPARATION'),tone:'blue'},
    {id:'host-insert',label:'Host insertion',ms:stageMs('HOST_INSERTION'),tone:'violet'},
    {id:'provider',label:'Provider wait',ms:detailed?.providerLatencyMs??stageMs('PROVIDER_RESPONSE'),tone:'amber'},
    {id:'learning',label:'Response / learning',ms:stageMs('LEARNING'),tone:'green'},
  ];
  const finitePhases=phases.map(row=>Number(row.ms)).filter(Number.isFinite),phaseMax=Math.max(1,...finitePhases);
  const flightRows=element(d,'div',{className:'a52-diagnostics-flight__rows'});
  for(const phase of phases)flightRows.append(diagnosticPhaseBar(d,phase,phaseMax));
  flight.body.append(flightRows);

  const retrievalTotal=stageMs('RETRIEVAL_CHANNELS'),allRetrievalChannels=generationPerf?.retrievalChannels??[];
  const slowest=allRetrievalChannels.slice().sort((a,b)=>(b.elapsedMs??0)-(a.elapsedMs??0)).slice(0,3);
  const flightFoot=element(d,'div',{className:'a52-diagnostics-flight__footer'});
  flightFoot.append(
    diagnosticMiniStat(d,'Retrieval',diagnosticMs(retrievalTotal),allRetrievalChannels.length+' measured channels'),
    diagnosticMiniStat(d,'Context admitted',String(pipeline.contextAdmitted??'NO_EVIDENCE'),String(pipeline.returnedResults??0)+' returned'),
    diagnosticMiniStat(d,'Host delivery',pipeline.deliveryReceipt?'OBSERVED':'NO_EVIDENCE',pipeline.deliveryReceipt?'Request edge retained':'No retained host receipt'),
  );
  if(slowest.length){
    const slow=element(d,'div',{className:'a52-diagnostics-slowest'});
    slow.append(element(d,'span',{className:'a52-eyebrow',text:'SLOWEST RETRIEVAL CHANNELS'}));
    for(const row of slowest){const slowRow=element(d,'div',{className:'a52-diagnostics-slowest__row'});slowRow.append(element(d,'strong',{text:String(row.channelId??'channel')}),element(d,'span',{text:diagnosticMs(row.elapsedMs)}),makeBadge(d,String(row.status??'UNKNOWN'),stageDiagnosticToken(row.status)));slow.append(slowRow);}
    flight.body.append(slow);
  }
  flight.body.append(flightFoot);
  if(generationPerf?.selectionError)flight.body.append(emptyDiagnosticRow(d,'Identity fence rejected this performance record: '+String(generationPerf.selectionError)));
  else if(!generationPerf?.exactSelection)flight.body.append(emptyDiagnosticRow(d,'NO_EVIDENCE — select an exact chat / turn / generation to bind the flight recorder.'));
  else if(!detailed){
    const captureMessages={
      PROFILE_CHECKPOINT_PENDING:'The response is complete; its detailed profile is waiting for checkpoint persistence.',
      PROFILE_CAPTURE_PENDING:'This generation is armed; its detailed profile is still being captured.',
      PROFILE_NOT_ARMED_AT_GENERATION:'This generation started without detailed profiling armed.',
      PROFILE_READER_SELECTION_MISMATCH:'A profile was recorded for this generation, but its selected-turn reader did not return it.',
      PROFILE_READER_MISSING:'This installed session does not expose the detailed-profile reader.',
      PROFILE_NOT_RETAINED_FOR_SELECTED_GENERATION:'No detailed profile is retained for this selected generation.',
    };
    flight.body.append(emptyDiagnosticRow(d,captureMessages[generationPerf?.capture?.reasonCode]??(profileEnabled?'Profiler is armed; this selected generation has not published a detailed browser profile yet.':'Cheap Brain stage timings remain visible. Arm detailed profiling before the next generation for browser attribution.')));
  }
  primary.append(flight.root);

  const sideStack=element(d,'div',{className:'a52-diagnostics-side-stack'});
  const overall=detailed?.deltas??{},preInsertion=detailed?.phases?.preGenerationToHostInsertion??{},afterInsertion=detailed?.phases?.hostInsertionToLearningComplete??{};
  const browser=diagnosticPanel(d,{icon:'⌁',title:'Browser Load Attribution',subtitle:'Measurements captured around the selected generation',badge:detailed?'MEASURED':'NO EVIDENCE',tone:detailed?'observed':'historical',className:'a52-diagnostics-browser'});
  const measurementGrid=element(d,'div',{className:'a52-diagnostics-measurement-grid'});
  measurementGrid.append(
    diagnosticMeasurement(d,{label:'Heap Δ',value:diagnosticBytes(overall.heapBytes),detail:generationPerf?.support?.heap??'NO_EVIDENCE',tone:overall.heapBytes>0?'warning':'observed'}),
    diagnosticMeasurement(d,{label:'Long Tasks',value:diagnosticLongTasks(overall.longTaskCount,overall.longTaskTotalMs),detail:generationPerf?.support?.longTasks??'NO_EVIDENCE',tone:Number(overall.longTaskCount)>0?'warning':'observed'}),
    diagnosticMeasurement(d,{label:'Diagnostics/UI refresh',value:diagnosticRefresh(overall.diagnosticsUiRefreshCount,overall.diagnosticsUiRefreshTotalMs),detail:generationPerf?.support?.diagnosticsUiRefresh??'NO_EVIDENCE',tone:'cyan'}),
    diagnosticMeasurement(d,{label:'Provider Wait',value:diagnosticMs(detailed?.providerLatencyMs??stageMs('PROVIDER_RESPONSE')),detail:'generation transport edge',tone:'amber'}),
  );
  browser.body.append(measurementGrid);
  const split=element(d,'div',{className:'a52-diagnostics-browser__split'});
  split.append(diagnosticDeltaBand(d,'PRE → INSERT',preInsertion),diagnosticDeltaBand(d,'INSERT → LEARNED',afterInsertion));
  browser.body.append(split);sideStack.append(browser.root);

  const selected=diagnosticPanel(d,{icon:'◎',title:'Selection Fence',subtitle:'Current evidence identity',badge:snapshot.current?'CURRENT':'WAITING',tone:snapshot.current?'ready':'historical',className:'a52-diagnostics-selection'});
  selected.body.append(createKeyValue(d,[
    {key:'Chat',value:s.chatId??'NO_EVIDENCE'},{key:'Turn',value:s.turnId??'NO_EVIDENCE'},{key:'Generation',value:s.generationId??'NO_EVIDENCE'},
    {key:'Correlation',value:s.correlationId??'NO_EVIDENCE'},{key:'World / Scene',value:(s.worldRevision??'—')+' / '+(s.sceneRevision??'—')},
    {key:'Source fence',value:(s.sourceRevisionRefs?.length??0)+' revision refs'},
  ]));sideStack.append(selected.root);

  const lanesPanel=diagnosticPanel(d,{icon:'⇄',title:'Resource Lanes',subtitle:'Configured execution paths',badge:String(resourceRows.length)+' RESOURCES',tone:resourceRows.length?'observed':'historical',className:'a52-diagnostics-resource-mini'});
  const laneGrid=element(d,'div',{className:'a52-diagnostics-lane-grid'});
  for(const spec of [['JEV',operational?.wiring?.jev],['SIDECAR',operational?.wiring?.sidecar],['VECTOR',operational?.wiring?.vectoring]]){
    const lane=spec[1]?.lane??{},connected=Number(lane.connected??0),configured=Number(lane.configured??0),callable=Number(lane.callable??0);
    laneGrid.append(diagnosticLanePill(d,spec[0],connected?'CONNECTED':configured?'CONFIGURED':'IDLE',connected?'ready':configured?'warning':'historical',callable+' callable'));
  }
  lanesPanel.body.append(laneGrid);sideStack.append(lanesPanel.root);
  primary.append(sideStack);root.append(primary);

  const middle=element(d,'section',{className:'a52-diagnostics-middle-grid'});
  const brain=diagnosticPanel(d,{icon:'◈',title:'Brain / Producer Activity',subtitle:'What actually executed for this selected turn',badge:String(operational?.producers?.stages?.length??0)+' STAGES',tone:'observed',className:'a52-diagnostics-brain'});
  const pipelineRibbon=element(d,'div',{className:'a52-diagnostics-pipeline-ribbon'});
  pipelineRibbon.append(
    diagnosticPipelineNode(d,'MAPPED',pipeline.logicalJobsMapped??snapshot.summary?.logicalJobs??0,'blue'),
    diagnosticPipelineArrow(d),
    diagnosticPipelineNode(d,'ATTEMPTED',pipeline.physicalExecutionAttempts??0,'violet'),
    diagnosticPipelineArrow(d),
    diagnosticPipelineNode(d,'RETURNED',pipeline.returnedResults??0,'cyan'),
    diagnosticPipelineArrow(d),
    diagnosticPipelineNode(d,'ADMITTED',pipeline.contextAdmitted??0,'green'),
  );
  brain.body.append(pipelineRibbon);
  const brainStages=element(d,'div',{className:'a52-diagnostics-producer-grid'});
  for(const row of (operational?.producers?.stages??[]).slice(0,12))brainStages.append(diagnosticProducerTile(d,row,inspect?()=>inspect({kind:'area52-diagnostic-stage',id:row.id,title:row.label??label(row.id),payload:operational?.producers?.inspections?.[row.id]??row}):null,scope));
  if(!brainStages.children?.length)brainStages.append(emptyDiagnosticRow(d,'No producer telemetry is currently published.'));
  brain.body.append(brainStages);
  if(snapshot.brainDecision)brain.body.append(renderBrainDecisionExplanation(d,snapshot.brainDecision,{compact:true,title:'Brain decision evidence'}));
  middle.append(brain.root);

  const attention=diagnosticPanel(d,{icon:errorCount?'!':'✓',title:'Needs Attention',subtitle:'Warnings, errors, and coherence issues',badge:errorCount?String(errorCount):'CLEAR',tone:errorCount?'warning':'ready',className:'a52-diagnostics-attention'});
  const attentionList=element(d,'div',{className:'a52-diagnostics-attention-list'});
  for(const [name,error] of cognitionErrors.slice(0,4))attentionList.append(diagnosticAttentionItem(d,label(name)+' read issue',error?.message??error?.code??'Unknown owner read issue.','warning',inspect?()=>inspect({kind:'area52-diagnostic-error',id:name,title:label(name)+' read issue',payload:error}):null,scope));
  for(const row of errorRows.slice(-6).reverse())attentionList.append(diagnosticAttentionItem(d,row.stage,row.summary??row.reasonCode??'Retained warning/error evidence.',row.severity==='ERROR'?'warning':'historical',inspect?()=>inspect({kind:'area52-diagnostic-event',id:row.id,title:row.stage,payload:model.detail(row.id,{selection:row.selection??s})}):null,scope));
  if(!attentionList.children?.length){const clear=element(d,'div',{className:'a52-diagnostics-clear-state'});clear.append(element(d,'span',{text:'✓'}),element(d,'strong',{text:'No retained issues'}),element(d,'p',{className:'a52-muted',text:'Selected-turn diagnostics contain no warning/error evidence under the current filters.'}));attentionList.append(clear);}
  attention.body.append(attentionList);middle.append(attention.root);root.append(middle);

  const pulseGrid=element(d,'section',{className:'a52-diagnostics-pulse-grid'});
  const runtimeSummary=operational?.runtime?.summary??{},life=runtimeSummary.lifecycleCounts??{};
  const runtimePulse=diagnosticPanel(d,{icon:'▥',title:'Runtime Pulse',subtitle:'Lifecycle and queue pressure',badge:String(snapshot.summary?.logicalJobs??0)+' JOBS',tone:'observed'});
  runtimePulse.body.append(createKeyValue(d,[
    {key:'Active / yielding',value:(life.ACTIVE??0)+' / '+(life.YIELDING??0)},{key:'Parked / recovering',value:(life.PARKED??0)+' / '+(life.RECOVERING??0)},
    {key:'Complete / failed',value:(life.COMPLETE??0)+' / '+(life.FAILED??0)},{key:'Queue',value:Object.entries(runtimeSummary.queueDepth??{}).map(([key,value])=>key+' '+value).join(' · ')||'NO_EVIDENCE'},
  ]));pulseGrid.append(runtimePulse.root);

  const contextPulse=diagnosticPanel(d,{icon:'◇',title:'Context Delivery',subtitle:'Evidence flow into the sealed generation',badge:pipeline.admissionReceipt?'SEALED':'NO EVIDENCE',tone:pipeline.admissionReceipt?'ready':'historical'});
  const admitted=Number(pipeline.contextAdmitted??0),returned=Number(pipeline.returnedResults??0),ratio=returned>0?Math.min(100,Math.round((admitted/returned)*100)):0;
  const contextMeter=element(d,'div',{className:'a52-diagnostics-context-meter'});
  const contextTrack=element(d,'div',{className:'a52-diagnostics-context-meter__track'}),contextFill=element(d,'span',{className:'a52-diagnostics-context-meter__fill',attrs:{style:'width:'+ratio+'%'}}),contextStatus=element(d,'div',{className:'a52-inline-status'});contextTrack.append(contextFill);contextStatus.append(element(d,'strong',{text:admitted+' admitted'}),element(d,'span',{className:'a52-muted',text:returned+' returned · '+ratio+'%'}));contextMeter.append(contextTrack,contextStatus);
  contextPulse.body.append(contextMeter,createKeyValue(d,[{key:'Logical jobs',value:pipeline.logicalJobsMapped??snapshot.summary?.logicalJobs??0},{key:'Mapped resources',value:pipeline.mappedResourceCount??0},{key:'Physical attempts',value:pipeline.physicalExecutionAttempts??0},{key:'Delivery receipt',value:pipeline.deliveryReceipt?'OBSERVED':'NO_EVIDENCE'}]));pulseGrid.append(contextPulse.root);

  const knowledge=diagnosticPanel(d,{icon:'◫',title:'Knowledge Pulse',subtitle:'Lore and Memory readiness',badge:'OWNER DATA',tone:'observed'});
  const lore=operational?.lore??{},memory=operational?.memory??{},memoryCounts=memory.counts??{},fresh=memory.freshness??{};
  const knowledgeSplit=element(d,'div',{className:'a52-diagnostics-knowledge-split'});knowledgeSplit.append(
    diagnosticMiniStat(d,'Lore ready',String(lore.retrievalReady??0),(lore.learned??0)+' learned / '+(lore.accepted??0)+' accepted'),
    diagnosticMiniStat(d,'Memory current',String(memoryCounts.current??0),(memoryCounts.historical??0)+' historical · '+(memoryCounts.unresolved??0)+' unresolved'),
    diagnosticMiniStat(d,'Summaries',String(memoryCounts.summaries??0),(fresh.freshSummaries??0)+' fresh · '+(fresh.staleSummaries??0)+' stale'),
  );knowledge.body.append(knowledgeSplit);pulseGrid.append(knowledge.root);root.append(pulseGrid);

  const recent=diagnosticPanel(d,{icon:'≋',title:'Recent Diagnostic Events',subtitle:'Newest retained metadata for the current evidence set',badge:String(Math.min(10,timeline.rows.length))+' SHOWN',tone:'historical',className:'a52-diagnostics-recent'});
  const recentList=element(d,'div',{className:'a52-diagnostics-event-stream'});
  const newest=timeline.rows.slice(-10).reverse();
  if(!newest.length)recentList.append(emptyDiagnosticRow(d,snapshot.current?'No retained evidence matches these filters.':'Select a chat turn and generation to populate diagnostics.'));
  for(const row of newest)recentList.append(diagnosticEventStreamItem(d,row,{model,selection:row.selection??s,scope,inspect}));
  recent.body.append(recentList);root.append(recent.root);

  const advancedHead=element(d,'div',{className:'a52-diagnostics-advanced-head'}),advancedTitle=element(d,'div');advancedTitle.append(element(d,'span',{className:'a52-eyebrow',text:'FORENSICS / ADVANCED EVIDENCE'}),element(d,'h2',{text:'Deep inspection'}));
  advancedHead.append(advancedTitle,element(d,'p',{className:'a52-muted',text:'Detailed owner receipts, retained event filters, raw sanitized state, and storage safety stay available without dominating the live console.'}));
  root.append(advancedHead);
  const advanced=element(d,'section',{className:'a52-diagnostics-advanced-grid'});

  const coordination=diagnosticSection(d,'Coordination / selected turn',{count:snapshot.current?'CURRENT':'WAITING'});
  coordination.body.append(createKeyValue(d,[
    {key:'Chat',value:s.chatId??'unknown'},{key:'Turn',value:s.turnId??'unknown'},{key:'Generation',value:s.generationId??'unknown'},{key:'Correlation',value:s.correlationId??'unknown'},
    {key:'World / Scene revision',value:(s.worldRevision??'unknown')+' / '+(s.sceneRevision??'unknown')},{key:'Source revision fence',value:s.sourceRevisionRefs?.length?s.sourceRevisionRefs.join(', '):'unknown'},
    {key:'Retained turns / entries',value:String(retained.turnCount??0)+' / '+String(retained.entryCount??0)},
  ]),element(d,'p',{className:'a52-muted',text:snapshot.summary?.explanation??'No selected-turn evidence is retained yet.'}));
  advanced.append(coordination.root);

  const brainDeep=diagnosticSection(d,'Brain / owner generation inspection',{count:String(operational?.producers?.stages?.length??0)+' stages'});
  const deepStages=element(d,'div',{className:'a52-diagnostics-status-list'});
  for(const row of operational?.producers?.stages??[])deepStages.append(compactStatusRow(d,row.label??label(row.id),row.state??'UNKNOWN',row.reason??row.errorCode??'Owner status published.',stageDiagnosticToken(row.state),inspect?()=>inspect({kind:'area52-diagnostic-stage',id:row.id,title:row.label??label(row.id),payload:operational?.producers?.inspections?.[row.id]??row}):null,scope));
  if(!deepStages.children?.length)deepStages.append(emptyDiagnosticRow(d,'No producer telemetry is currently published.'));
  brainDeep.body.append(deepStages);
  brainDeep.body.append(renderSelectedTurnGraphVisibility(d,snapshot.graphTrace??operational?.graph,{compact:false,title:'Selected-turn world graph'}));
  const generationInspection=operational?.generationInspection??null;
  const ownerTurn=operational?.nativeBrainIntegration?.selectedTurnReceipt??generationInspection?.selectedTurnReceipt??operational?.selectedTurnReceipt??null;
  const memoryFeedback=ownerTurn?.memoryRetrievalFeedback??generationInspection?.memoryRetrievalFeedback??memory?.retrievalFeedback?.last??null;
  if(generationInspection||ownerTurn){
    const dense=ownerTurn?.denseRetrieval??generationInspection?.denseRetrieval??generationInspection?.memoryDensePrime??null;
    const completion=ownerTurn?.completionLifecycle??generationInspection?.completionLifecycle??null,background=completion?.background??null,responseCompletion=completion?.responseCompletion??null;
    brainDeep.body.append(element(d,'strong',{text:'Owner generation inspection'}),createKeyValue(d,[
      {key:'Source revision fence',value:String(generationInspection?.sourceRevisionFenceCount??ownerTurn?.sourceRevisions?.selectedCount??0)+' revisions'},
      {key:'Identity resolution',value:diagnosticReceiptSummary(generationInspection?.identityResolution)},
      {key:'Graph traversal',value:diagnosticReceiptSummary(generationInspection?.graphTraversal)},
      {key:'Retrieval budget',value:diagnosticReceiptSummary(generationInspection?.retrievalBudget)},
      {key:'Rejected evidence',value:generationInspection?.rejectedEvidence?String(generationInspection.rejectedEvidence.count??0)+' rejected'+(generationInspection.rejectedEvidence.reasonCode?' · '+generationInspection.rejectedEvidence.reasonCode:''):'No owner rejection receipt'},
      {key:'Lore / Memory sync',value:[generationInspection?.loreSync?.status??generationInspection?.loreSync?.kind??'Lore not published',generationInspection?.memorySync?.status??generationInspection?.memorySync?.kind??'Memory not published'].join(' · ')},
      {key:'Dense Memory eligibility',value:dense?(String(dense.status??'UNKNOWN')+' · '+String(dense.resultClass??'OPPORTUNISTIC')+(dense.reasonCode?' · '+dense.reasonCode:'')):'No dense retrieval receipt'},
      {key:'Dense request / attempt / return / admit',value:dense?[dense.requested,dense.providerAttempted,dense.providerReturned,dense.ownerAdmitted].map(value=>value?'YES':'NO').join(' / '):'No evidence'},
      {key:'Dense foreground / provider',value:dense?diagnosticMs(dense.foregroundWaitMs)+' / '+diagnosticMs(dense.providerExecutionMs):'No evidence'},
      {key:'Response completion',value:responseCompletion?(String(responseCompletion.status??'UNKNOWN')+' · foreground '+diagnosticMs(responseCompletion.foregroundWaitMs)):'No completion receipt'},
      {key:'Background learning',value:background?(String(background.status??'UNKNOWN')+' · '+String(background.tasks?.length??0)+' task(s) · execution '+diagnosticMs(background.backgroundExecutionMs)+(background.reasonCode?' · '+background.reasonCode:'')):'No background lifecycle receipt'},
      {key:'Memory retrieval feedback',value:memoryFeedback?(String(memoryFeedback.status??'UNKNOWN')+' · applied '+String(memoryFeedback.counts?.applied??0)+' · rejected '+String(memoryFeedback.counts?.rejected??0)+' · deferred '+String(memoryFeedback.counts?.deferred??0)+' · replayed '+String(memoryFeedback.counts?.replayed??0)):(ownerTurn?.memoryRetrievalFeedbackBatch?'SCHEDULED · awaiting Memory owner':'No owner-backed feedback receipt')},
    ]));
  }
  advanced.append(brainDeep.root);

  const runtime=diagnosticSection(d,'Runtime / lifecycle / jobs',{count:String(snapshot.summary?.logicalJobs??0)+' jobs'});
  runtime.body.append(createKeyValue(d,[{key:'Queued by layer',value:Object.entries(runtimeSummary.queueDepth??{}).map(([key,value])=>key+': '+value).join(' · ')||'Not published'},{key:'Borrowed background leases',value:runtimeSummary.borrowedBackgroundLeases??'Not published'}]));
  const jobRows=snapshot.rows.filter(row=>row.stage==='Fan-out job'),jobList=element(d,'div',{className:'a52-diagnostics-timeline'});
  for(const row of jobRows)jobList.append(renderRow(d,row,{model,selection:s,scope,inspect}));
  if(!jobRows.length)jobList.append(emptyDiagnosticRow(d,'No owner-backed job audit is retained for this selected turn.'));
  runtime.body.append(jobList);advanced.append(runtime.root);

  const resources=diagnosticSection(d,'Resources / connections / provider calls',{count:String(resourceRows.length)+' configured'});
  const lanes=element(d,'div',{className:'a52-diagnostics-lanes'});
  for(const spec of [['Jev',operational?.wiring?.jev],['Sidecar',operational?.wiring?.sidecar],['Vectoring',operational?.wiring?.vectoring]]){
    const lane=spec[1]?.lane??{},card=element(d,'article',{className:'a52-diagnostics-lane'}),laneStatus=lane.connected>0?'CONNECTED':lane.configured>0?'CONFIGURED':'NOT CONNECTED';
    const laneHead=element(d,'div',{className:'a52-inline-status'});laneHead.append(element(d,'strong',{text:spec[0]}),makeBadge(d,laneStatus,lane.connected>0?'ready':lane.configured>0?'warning':'historical'));card.append(laneHead,createKeyValue(d,[{key:'Callable',value:lane.callable??0},{key:'Attempted / succeeded',value:(lane.attempted??0)+' / '+(lane.succeeded??0)},{key:'Owner accepted',value:lane.ownerAccepted??0},{key:'Active',value:lane.activeExecutions??0}]));
    lanes.append(card);
  }
  resources.body.append(lanes);
  const provider=operational?.coprocessor?.summary?.providerCalls??{},resourceTelemetry=operational?.coprocessor?.summary?.resourceTelemetry??{};
  resources.body.append(createKeyValue(d,[{key:'Provider calls invoked / failed',value:(provider.invoked??0)+' / '+(provider.failed??0)},{key:'Resource tests pass / fail',value:(resourceTelemetry.testsPassed??0)+' / '+(resourceTelemetry.testsFailed??0)},{key:'Executions success / fail',value:(resourceTelemetry.executionsSucceeded??0)+' / '+(resourceTelemetry.executionsFailed??0)}]));
  if(resourceRows.length){
    const currentResources=element(d,'div',{className:'a52-diagnostics-status-list'});
    for(const row of resourceRows.slice(0,40)){
      const resourceState=row.state??row.health??'UNKNOWN',detail=[row.displayName&&row.displayName!==row.id?row.displayName:null,row.health?'health '+row.health:null,row.availability?'availability '+row.availability:null,row.lastExecution?.status?'last execution '+row.lastExecution.status:null].filter(Boolean).join(' · ')||'Owner resource state published.';
      currentResources.append(compactStatusRow(d,row.displayName??row.id??row.resourceId??row.kind??'Resource',resourceState,detail,stageDiagnosticToken(resourceState),inspect?()=>inspect({kind:'area52-diagnostic-resource',id:row.id??row.resourceId??row.displayName??'resource',title:(row.displayName??row.id??row.resourceId??'Resource')+' detail',payload:sanitize(row)}):null,scope));
    }
    resources.body.append(element(d,'strong',{text:'Current resources'}),currentResources);
  }
  const vectorTrace=operational?.vectoringTrace??null;
  resources.body.append(element(d,'strong',{text:'Vectoring causal trace'}));
  for(const [title,records] of [['Selected-turn Memory queries',vectorTrace?.selectedTurn??[]],['Background Memory indexing',vectorTrace?.background??[]]]){
    resources.body.append(element(d,'span',{className:'a52-eyebrow',text:title}));
    if(!records.length){resources.body.append(emptyDiagnosticRow(d,'NO_EVIDENCE — no matching execution receipt.'));continue;}
    const list=element(d,'div',{className:'a52-diagnostics-status-list'});
    for(const row of records.slice(-12)){
      const detail=[row.latencyMs==null?null:diagnosticMs(row.latencyMs),
        'Memory '+row.memoryDecision,row.candidateCount==null?null:row.candidateCount+' candidate(s)',
        row.operation==='EMBED_QUERY'?'Gather '+row.gather:'Indexed work '+(row.workId??'unknown')].filter(Boolean).join(' · ');
      list.append(compactStatusRow(d,row.operation==='EMBED_QUERY'?'Memory query':'Memory artifact index',row.status,detail,stageDiagnosticToken(row.status),
        inspect?()=>inspect({kind:'area52-vectoring-trace',id:row.executionId??'vectoring',title:'Vectoring · '+row.operation,payload:row}):null,scope));
    }
    resources.body.append(list);
  }
  const resourceEvents=operational?.telemetry?.resourceEvents??[];
  if(resourceEvents.length){
    const eventList=element(d,'div',{className:'a52-diagnostics-status-list'});
    for(const event of resourceEvents.slice(0,40)){
      const eventName=event.displayName??event.resourceId??'Resource';
      eventList.append(compactStatusRow(d,eventName,event.code??'EVENT',event.message??'Owner resource event published.',stageDiagnosticToken(event.code),inspect?()=>inspect({kind:'area52-diagnostic-resource-event',id:String(event.sequence??event.code??eventName),title:eventName+' · '+String(event.code??'event'),payload:sanitize(event)}):null,scope));
    }
    resources.body.append(element(d,'strong',{text:'Recent owner resource telemetry'}),eventList);
  }
  advanced.append(resources.root);

  const knowledgeDeep=diagnosticSection(d,'Lore / retrieval / Memory',{count:'knowledge'}),knowledgeColumns=element(d,'div',{className:'a52-diagnostics-two-column'}),loreColumn=element(d,'div'),memoryColumn=element(d,'div');
  loreColumn.append(element(d,'strong',{text:'Lore / retrieval'}),createKeyValue(d,[{key:'Accepted',value:lore.accepted??0},{key:'Learned/current',value:lore.learned??0},{key:'Retrieval-ready',value:lore.retrievalReady??0},{key:'Due / active',value:(lore.lifecycle?.due??0)+' / '+(lore.lifecycle?.active??lore.lifecycle?.counts?.ACTIVE??0)},{key:'Invalid',value:lore.lifecycle?.counts?.INVALID??0}]));
  memoryColumn.append(element(d,'strong',{text:'Memory'}),createKeyValue(d,[{key:'Exact evidence',value:memoryCounts.exactEvidence??0},{key:'Current / historical / unresolved',value:[memoryCounts.current??0,memoryCounts.historical??0,memoryCounts.unresolved??0].join(' / ')},{key:'Episodes / reflections / summaries',value:[memoryCounts.episodes??0,memoryCounts.reflections??0,memoryCounts.summaries??0].join(' / ')},{key:'Fresh / stale summaries',value:[fresh.freshSummaries??0,fresh.staleSummaries??0].join(' / ')},{key:'Retrieval',value:memory.retrievalStatus??'No selected-turn receipt'},{key:'Retrieval feedback',value:memoryFeedback?(String(memoryFeedback.status??'UNKNOWN')+' · applied '+String(memoryFeedback.counts?.applied??0)+' · rejected '+String(memoryFeedback.counts?.rejected??0)+' · deferred '+String(memoryFeedback.counts?.deferred??0)):'No selected-turn feedback receipt'},{key:'Feedback authority',value:'supportAdded=false · canonical authority unchanged · delivery unknown'}]));
  knowledgeColumns.append(loreColumn,memoryColumn);knowledgeDeep.body.append(knowledgeColumns);advanced.append(knowledgeDeep.root);

  const errorsDeep=diagnosticSection(d,'Errors / recovery / coherence',{count:String(errorCount)});
  if(cognitionErrors.length){
    const list=element(d,'div',{className:'a52-diagnostics-status-list'});
    for(const [name,error] of cognitionErrors)list.append(compactStatusRow(d,label(name),'READ ISSUE',error?.message??error?.code??'Unknown owner read issue.','warning',inspect?()=>inspect({kind:'area52-diagnostic-error',id:name,title:label(name)+' read issue',payload:error}):null,scope));
    errorsDeep.body.append(list);
  }
  if(errorRows.length){const list=element(d,'div',{className:'a52-diagnostics-timeline'});for(const row of errorRows.slice(-24))list.append(renderRow(d,row,{model,selection:row.selection??s,scope,inspect}));errorsDeep.body.append(list);}
  if(!cognitionErrors.length&&!errorRows.length)errorsDeep.body.append(emptyDiagnosticRow(d,'No retained warnings or errors match the current filters.'));
  advanced.append(errorsDeep.root);

  const performance=diagnosticSection(d,'Performance detail / retrieval / UI workload',{count:profileEnabled?'PROFILE ON':'PROFILE OFF'});
  performance.body.append(element(d,'strong',{text:'Retrieval channels · slowest first'}));
  if(allRetrievalChannels.length)performance.body.append(createKeyValue(d,allRetrievalChannels.slice().sort((a,b)=>(b.elapsedMs??0)-(a.elapsedMs??0)).slice(0,16).map(row=>({key:row.channelId,value:diagnosticMs(row.elapsedMs)+' · '+row.status+' · '+(row.nominationCount??'NO_EVIDENCE')+' nominations'}))));
  else performance.body.append(emptyDiagnosticRow(d,'NO_EVIDENCE — no per-channel retrieval timing was published for this generation.'));
  const uiLoad=operational?.telemetry?.uiLoad??null,categories=uiLoad?.categories??{};
  performance.body.append(element(d,'strong',{text:'Diagnostics UI workload'}),createKeyValue(d,[
    {key:'Host event invalidations',value:diagnosticLoadMetric(categories.HOST_EVENT_INVALIDATION)},{key:'Scatter / Gather owner read',value:diagnosticLoadMetric(categories.OWNER_SCATTER_GATHER_READ)},
    {key:'Journal diagnostics read',value:diagnosticLoadMetric(categories.UI_JOURNAL_DIAGNOSTICS_READ)},{key:'Journal processing',value:diagnosticLoadMetric(categories.UI_JOURNAL_PROCESS)},
    {key:'Activity feed render',value:diagnosticLoadMetric(categories.UI_ACTIVITY_FEED_RENDER)},{key:'Workspace refresh',value:diagnosticLoadMetric(categories.UI_WORKSPACE_REFRESH)},{key:'Capture total',value:diagnosticLoadMetric(categories.UI_CAPTURE_TOTAL)},
  ]));advanced.append(performance.root);

  const timelineSection=diagnosticSection(d,'Event timeline · all retained evidence',{count:String(timeline.matchingRows)+' matching'});
  const controls=element(d,'div',{className:'a52-diagnostics-toolbar'});
  const timeSelect=selectControl(d,'Time',filters.time,[['ALL','All retained'],['1M','Last 1 minute'],['5M','Last 5 minutes'],['15M','Last 15 minutes']]);
  const catSelect=selectControl(d,'Category',filters.category,[['ALL','All categories'],...timeline.availableCategories.map(x=>[x,x])]);
  const sevSelect=selectControl(d,'Severity',filters.severity,[['ALL','All severities'],...timeline.availableSeverities.map(x=>[x,x])]);
  const search=element(d,'input',{attrs:{type:'search',placeholder:'Search stages, reasons, receipts, jobs, resources…','aria-label':'Search diagnostics'}});search.value=filters.search??'';
  controls.append(timeSelect.wrap,catSelect.wrap,sevSelect.wrap,search);
  scope?.listen?.(timeSelect.input,'change',()=>{filters.time=timeSelect.input.value;refresh?.();});
  scope?.listen?.(catSelect.input,'change',()=>{filters.category=catSelect.input.value;refresh?.();});
  scope?.listen?.(sevSelect.input,'change',()=>{filters.severity=sevSelect.input.value;refresh?.();});
  scope?.listen?.(search,'change',()=>{filters.search=String(search.value??'').trim();refresh?.();});
  timelineSection.body.append(controls,element(d,'p',{className:'a52-muted',text:timeline.truncated?'Visible row cap reached. Narrow filters or use Export Full Diagnostics for the complete retained evidence set.':'Showing '+timeline.visibleRows+' of '+timeline.matchingRows+' matching rows across '+String(retained.turnCount??0)+' retained turn(s).'}));
  const timelineList=element(d,'div',{className:'a52-diagnostics-timeline'});
  for(const row of timeline.rows)timelineList.append(renderRow(d,row,{model,selection:row.selection??s,scope,inspect}));
  timelineSection.body.append(timelineList);advanced.append(timelineSection.root);

  const raw=diagnosticSection(d,'Raw operational snapshot',{count:operational?'SANITIZED':'NO EVIDENCE'});
  if(operational)raw.body.append(element(d,'pre',{className:'a52-context-packet',text:JSON.stringify(sanitize(operational),null,2),attrs:{'aria-label':'Sanitized raw operational diagnostics snapshot'}}));
  else raw.body.append(emptyDiagnosticRow(d,'No operational Diagnostics snapshot is currently published.'));
  advanced.append(raw.root);

  const retention=diagnosticSection(d,'Retention / safety',{count:String(retained.entryCount??0)+' entries'});
  retention.body.append(createKeyValue(d,[{key:'Storage',value:retained.available===false?'DEGRADED: '+String(retained.lastError??'local storage unavailable'):String(retained.storageKind??'unknown')},{key:'Retained turns / entries',value:String(retained.turnCount??0)+' / '+String(retained.entryCount??0)},{key:'Serialized bytes / ceiling',value:String(retained.serializedBytes??0)+' / '+String(retained.maxStoredBytes??'unknown')},{key:'Writes / skipped redundant writes',value:String(retained.writes??0)+' / '+String(retained.skippedRedundantWrites??0)},{key:'Payload policy',value:'metadata only; no raw prompts, story/Lore bodies, credentials, or hidden reasoning'}]));
  advanced.append(retention.root);
  root.append(advanced);
  host.append(root);
}

function diagnosticPanel(d,{icon='◇',title,subtitle='',badge=null,tone='historical',className=''}={}){
  const root=element(d,'article',{className:'a52-diagnostics-panel '+className});
  const head=element(d,'header',{className:'a52-diagnostics-panel__head'});
  const mark=element(d,'span',{className:'a52-diagnostics-panel__icon',text:icon,attrs:{'aria-hidden':'true'}});
  const copy=element(d,'div',{className:'a52-diagnostics-panel__copy'});
  copy.append(element(d,'h2',{text:title}),element(d,'p',{className:'a52-muted',text:subtitle}));
  head.append(mark,copy);if(badge!=null)head.append(makeBadge(d,String(badge),tone));
  const body=element(d,'div',{className:'a52-diagnostics-panel__body'});root.append(head,body);return{root,head,body};
}
function diagnosticKpi(d,{icon='•',label:labelText,value,detail,tone='historical'}={}){
  const root=element(d,'article',{className:'a52-diagnostics-kpi',dataset:{tone}});
  const copy=element(d,'div',{className:'a52-diagnostics-kpi__copy'});copy.append(element(d,'span',{text:labelText}),element(d,'strong',{text:String(value??'NO_EVIDENCE')}),element(d,'small',{text:String(detail??'')}));root.append(element(d,'span',{className:'a52-diagnostics-kpi__icon',text:icon}),copy);
  return root;
}
function diagnosticIdentityChip(d,labelText,value,tone='historical'){
  const chip=element(d,'div',{className:'a52-diagnostics-identity-chip'});
  chip.append(element(d,'span',{text:labelText}),makeBadge(d,String(value??'—'),tone));return chip;
}
function shortDiagnosticId(value,max=15){const s=String(value??'');if(!s)return'—';return s.length>max?s.slice(0,Math.max(4,max-5))+'…'+s.slice(-4):s;}
function diagnosticPhaseBar(d,phase,max){
  const n=Number(phase.ms),measured=Number.isFinite(n),pct=measured?Math.max(2,Math.min(100,(n/max)*100)):0;
  const row=element(d,'div',{className:'a52-diagnostics-phase',dataset:{phase:phase.id,tone:phase.tone}});
  const labelNode=element(d,'strong',{text:phase.label}),track=element(d,'div',{className:'a52-diagnostics-phase__track'}),fill=element(d,'span',{className:'a52-diagnostics-phase__fill',attrs:{style:'width:'+pct+'%'}}),value=element(d,'span',{className:'a52-diagnostics-phase__value',text:diagnosticMs(phase.ms)});
  track.append(fill);row.append(labelNode,track,value);return row;
}
function diagnosticMiniStat(d,labelText,value,detail){
  const root=element(d,'div',{className:'a52-diagnostics-mini-stat'});
  root.append(element(d,'span',{text:labelText}),element(d,'strong',{text:String(value??'NO_EVIDENCE')}),element(d,'small',{text:String(detail??'')}));return root;
}
function diagnosticMeasurement(d,{label:labelText,value,detail,tone='historical'}={}){
  const root=element(d,'div',{className:'a52-diagnostics-measurement',dataset:{tone}});
  root.append(element(d,'span',{text:labelText}),element(d,'strong',{text:String(value??'NO_EVIDENCE')}),element(d,'small',{text:String(detail??'NO_EVIDENCE')}));return root;
}
function diagnosticDeltaBand(d,labelText,phase){
  const root=element(d,'div',{className:'a52-diagnostics-delta-band'});
  root.append(element(d,'span',{text:labelText}),element(d,'strong',{text:diagnosticPhaseDelta(phase)}));return root;
}
function diagnosticLanePill(d,name,state,tone,detail){
  const root=element(d,'div',{className:'a52-diagnostics-lane-pill'});
  const head=element(d,'div',{className:'a52-inline-status'});head.append(element(d,'strong',{text:name}),makeBadge(d,state,tone));root.append(head,element(d,'small',{className:'a52-muted',text:detail}));return root;
}
function diagnosticPipelineNode(d,labelText,value,tone){
  const root=element(d,'div',{className:'a52-diagnostics-pipeline-node',dataset:{tone}});
  root.append(element(d,'span',{text:labelText}),element(d,'strong',{text:String(value??0)}));return root;
}
function diagnosticPipelineArrow(d){return element(d,'span',{className:'a52-diagnostics-pipeline-arrow',text:'→',attrs:{'aria-hidden':'true'}});}
function diagnosticProducerTile(d,row,onInspect,scope){
  const state=row.state??'UNKNOWN',root=element(d,'button',{className:'a52-diagnostics-producer-tile',attrs:{type:'button'},dataset:{state:String(state)}});
  const copy=element(d,'div');copy.append(element(d,'strong',{text:row.label??label(row.id)}),element(d,'small',{className:'a52-muted',text:row.reason??row.errorCode??'Owner status published.'}));root.append(element(d,'span',{className:'a52-diagnostics-producer-tile__dot'}),copy,makeBadge(d,String(state),stageDiagnosticToken(state)));
  if(onInspect)scope?.listen?.(root,'click',onInspect);else root.disabled=true;return root;
}
function diagnosticAttentionItem(d,title,detail,tone='warning',onInspect=null,scope=null){
  const root=element(d,onInspect?'button':'div',{className:'a52-diagnostics-attention-item',attrs:onInspect?{type:'button'}:{},dataset:{tone}});
  const copy=element(d,'div');copy.append(element(d,'strong',{text:title}),element(d,'small',{className:'a52-muted',text:String(detail??'')}));root.append(element(d,'span',{className:'a52-diagnostics-attention-item__mark',text:tone==='warning'?'!':'•'}),copy);
  if(onInspect)scope?.listen?.(root,'click',onInspect);return root;
}
function diagnosticEventStreamItem(d,row,{model,selection,scope,inspect}={}){
  const root=element(d,'button',{className:'a52-diagnostics-event-stream__item',attrs:{type:'button'},dataset:{severity:String(row.severity??'INFO')}});
  const copy=element(d,'div');copy.append(element(d,'strong',{text:row.stage}),element(d,'small',{className:'a52-muted',text:row.summary??row.reasonCode??'Retained diagnostic evidence'}));root.append(element(d,'span',{className:'a52-diagnostics-event-stream__time',text:displayTime(row)}),element(d,'span',{className:'a52-diagnostics-event-stream__mark'}),copy,makeBadge(d,String(row.status??'UNKNOWN'),statusToken(row.status)));
  scope?.listen?.(root,'click',()=>inspect?.({kind:'area52-diagnostic-event',id:row.id,title:row.stage,category:row.category,severity:row.severity,status:row.status,selection:{...selection},payload:model.detail(row.id,{selection})}));return root;
}

function renderRow(d,row,{model,selection,scope,inspect}={}){
  const details=element(d,'details',{className:'a52-wave13-flow-row a52-turn-log__row',dataset:{turnLogRow:row.id}}),summary=element(d,'summary',{className:'a52-inline-status'});
  summary.append(element(d,'span',{className:'a52-muted',text:displayTime(row)}),makeBadge(d,row.severity,severityStatus(row.severity)),element(d,'strong',{text:row.stage}),makeBadge(d,row.status,statusToken(row.status)));
  if(row.receiptId)summary.append(element(d,'code',{text:row.receiptId}));
  details.append(summary,element(d,'p',{text:row.summary}),element(d,'p',{className:'a52-muted',text:[row.reasonCode?'Reason '+row.reasonCode:null,row.jobId?'Job '+row.jobId:null,row.resourceId?'Resource '+row.resourceId:null,row.resultId?'Result '+row.resultId:null].filter(Boolean).join(' · ')||'No additional correlation identity published.'}));
  let loaded=false;
  scope?.listen?.(details,'toggle',()=>{
    if(!details.open||loaded)return;loaded=true;const payload=model.detail(row.id,{selection});details.append(renderDetail(d,row,payload));
    if(inspect)inspect({kind:'area52-diagnostic-event',id:row.id,title:row.stage,category:row.category,severity:row.severity,status:row.status,selection:{...selection},payload});
  });
  return details;
}

function safeDiagnosticsRead(provider){
  try{return provider?.read?.()??null;}catch(error){return{kind:'Area52DiagnosticsUnavailable',error:{code:error?.code??'DIAGNOSTICS_READ_FAILED',message:safeText(error?.message??error,512)}};}
}
function operationalForSelection(operational,selection){
  if(!operational?.vectoringTrace)return operational;
  const trace=operational.vectoringTrace;
  const exact=row=>row?.chatId===selection.chatId&&row?.turnId===selection.turnId&&row?.generationId===selection.generationId;
  return {...operational,vectoringTrace:{...trace,selectedTurn:(trace.selectedTurn??[]).filter(exact)}};
}
function safeGraphRead(provider,selection){
  try{return provider?.read?.(selection)??null;}catch(error){return{kind:'SelectedTurnGraphVisibilityReadModel',state:'UNAVAILABLE',selection:normalizeSelection(selection),reason:safeText(error?.message??error,512),errors:[{code:error?.code??'GRAPH_VISIBILITY_READ_FAILED'}],safety:{metadataOnly:true,rawPrompt:false,rawLoreBodies:false,rawMemoryBodies:false,hiddenReasoning:false,mutationAuthority:false}};}
}
function diagnosticsStatus(snapshot,operational){
  const cognitionErrors=Object.keys(operational?.cognition?.errors??{}).length;
  const failures=Number(operational?.producers?.failures??0);
  if(cognitionErrors||failures)return{label:'ATTENTION',token:'warning'};
  if(!snapshot.current||operational?.host?.waitingForTurn)return{label:'WAITING',token:'historical'};
  return{label:'LIVE',token:'ready'};
}
function diagnosticsMetrics(snapshot,timeline,operational){
  const lanes=operational?.resources?.rows??[],errors=timeline.rows.filter(row=>row.severity==='ERROR').length,warnings=timeline.rows.filter(row=>row.severity==='WARN').length;
  return[
    ['Retained events',timeline.totalRows],['Visible',timeline.visibleRows],['Jobs',snapshot.summary?.logicalJobs??0],
    ['Resources',lanes.length],['Errors / warnings',errors+' / '+warnings],['Lore / Memory',(operational?.lore?.accepted??0)+' / '+(operational?.memory?.counts?.exactEvidence??0)],
  ];
}
function diagnosticSection(d,title,{open=false,count=null}={}){
  const root=element(d,'details',{className:'a52-diagnostics-section'});root.open=Boolean(open);
  const summary=element(d,'summary',{className:'a52-diagnostics-section__summary'});
  summary.append(element(d,'strong',{text:title}));
  if(count!=null)summary.append(element(d,'span',{className:'a52-muted',text:String(count)}));
  const body=element(d,'div',{className:'a52-diagnostics-section__body'});root.append(summary,body);return{root,body};
}
function compactStatusRow(d,name,status,detail,token='historical',onInspect=null,scope=null){
  const row=element(d,'div',{className:'a52-diagnostics-status-row'});
  row.append(element(d,'strong',{text:name}),makeBadge(d,String(status??'UNKNOWN'),token),element(d,'span',{className:'a52-muted',text:String(detail??'No additional evidence published.')}));
  if(onInspect)row.append(createButton(d,{label:'Inspect',scope,size:'sm',variant:'quiet',onPress:onInspect}));
  return row;
}
function emptyDiagnosticRow(d,textValue){return element(d,'div',{className:'a52-diagnostics-empty',text:textValue});}
function stageDiagnosticToken(value){const x=String(value??'').toUpperCase();if(/FAIL|ERROR|DEGRADED|UNAVAILABLE|DISCONNECTED/.test(x))return'warning';if(/LIVE|READY|COMPLETE|CONNECTED|SEALED/.test(x))return'ready';return'historical';}
function diagnosticReceiptSummary(receipt){
  if(!receipt)return'Not published';
  const counts=receipt.counts&&typeof receipt.counts==='object'?Object.entries(receipt.counts).map(([key,value])=>label(key)+' '+value).join(' · '):'';
  return[receipt.kind??'receipt',receipt.status??receipt.reasonCode??'published',counts].filter(Boolean).join(' · ');
}
function diagnosticMs(value){const n=Number(value);return value!=null&&Number.isFinite(n)?roundDiagnostic(n)+' ms':'NO_EVIDENCE';}
function diagnosticBytes(value){const n=Number(value);if(value==null||!Number.isFinite(n))return'NO_EVIDENCE';const sign=n>0?'+':'';return sign+roundDiagnostic(n/1048576)+' MiB';}
function diagnosticLongTasks(count,totalMs){const c=Number(count),ms=Number(totalMs);if(count==null||totalMs==null||!Number.isFinite(c)||!Number.isFinite(ms))return'NO_EVIDENCE';return c+' tasks · '+roundDiagnostic(ms)+' ms';}
function diagnosticRefresh(count,totalMs){const c=Number(count),ms=Number(totalMs);if(count==null||totalMs==null||!Number.isFinite(c)||!Number.isFinite(ms))return'NO_EVIDENCE';return c+' refreshes · '+roundDiagnostic(ms)+' ms';}
function diagnosticPhaseDelta(phase){if(!phase||typeof phase!=='object')return'NO_EVIDENCE';const parts=[];if(phase.heapBytes!=null)parts.push('heap '+diagnosticBytes(phase.heapBytes));if(phase.longTaskCount!=null&&phase.longTaskTotalMs!=null)parts.push('long '+diagnosticLongTasks(phase.longTaskCount,phase.longTaskTotalMs));if(phase.diagnosticsUiRefreshCount!=null&&phase.diagnosticsUiRefreshTotalMs!=null)parts.push('UI '+diagnosticRefresh(phase.diagnosticsUiRefreshCount,phase.diagnosticsUiRefreshTotalMs));return parts.length?parts.join(' · '):'NO_EVIDENCE';}
function diagnosticLoadMetric(row){
  if(!row)return'NO_EVIDENCE';
  const count=Number(row.count??row.samples??0),avg=Number(row.averageMs??row.avgMs??0),max=Number(row.maxMs??0);
  return count+' samples · '+roundDiagnostic(avg)+' ms avg · '+roundDiagnostic(max)+' ms max';
}
function roundDiagnostic(value){const n=Number(value);return Number.isFinite(n)?Math.round(n*10)/10:0;}
function buildMasterTimeline(evidence){
  const out=[];
  for(const turn of evidence?.turns??[]){
    for(const entry of turn.entries??[])out.push({
      id:entry.id,type:entry.type,subtype:entry.subtype??null,status:entry.status??null,title:entry.title??null,summary:entry.summary??null,detail:entry.detail??null,
      at:entry.at??null,receiptRef:entry.receiptRef??null,selection:turn.selection??entry.selection??null,metadata:entry.metadata??null,
    });
  }
  return out.sort((a,b)=>numericTime(a.at)-numericTime(b.at)||String(a.id??'').localeCompare(String(b.id??'')));
}
function collectDiagnosticErrors(operational,timeline=[]){
  const out=[];
  for(const [name,error] of Object.entries(operational?.cognition?.errors??{}))out.push({source:'COGNITION',name,error});
  for(const row of timeline)if(/ERROR|FAIL|DEGRADED|ABORT|REJECT|INVALID/.test(String(row.status??'').toUpperCase())||String(row.type??'').toUpperCase()==='READ_ERROR')out.push({source:'TIMELINE',event:row});
  return out;
}
function diagnosticsBundleFiles(payload){
  const op=payload.operationalSnapshot??{},root='Area52-Diagnostics-'+fileTimestamp(payload.exportedAt)+'/';
  const j=(value)=>JSON.stringify(value??null,null,2);
  return[
    {path:root+'README.txt',content:'Nexus Diagnostics bundle\n\nThis archive contains bounded metadata-only diagnostics retained by the UI. Raw prompts, story/Lore bodies, credentials, keys, and hidden reasoning are intentionally excluded.\n'},
    {path:root+'manifest.json',content:j({...payload.manifest,safety:payload.safety})},
    {path:root+'timeline.json',content:j(payload.timeline)},
    {path:root+'selected-turn.json',content:j(payload.selectedTurn)},
    {path:root+'retained-evidence.json',content:j(payload.retainedEvidence)},
    {path:root+'brain/brain.json',content:j({producers:op.producers,pipeline:op.pipeline,generationInspection:op.generationInspection})},
    {path:root+'brain/graph.json',content:j(payload.selectedTurn?.graphTrace??op.graph??null)},
    {path:root+'runtime/runtime.json',content:j(op.runtime)},
    {path:root+'resources/resources.json',content:j({resources:op.resources,wiring:op.wiring,coprocessor:op.coprocessor})},
    {path:root+'knowledge/lore-memory.json',content:j({lore:op.lore,memory:op.memory,cognition:op.cognition})},
    {path:root+'performance/ui-load.json',content:j(op.telemetry?.uiLoad??null)},
    {path:root+'performance/generation-profile.json',content:j(op.generationPerformance??null)},
    {path:root+'errors/errors.json',content:j(payload.errors)},
    {path:root+'operational-snapshot.json',content:j(op)},
  ];
}
function fileTimestamp(value){
  const date=new Date(Number(value)||Date.now()),pad=(n)=>String(n).padStart(2,'0');
  return date.getFullYear()+pad(date.getMonth()+1)+pad(date.getDate())+'-'+pad(date.getHours())+pad(date.getMinutes())+pad(date.getSeconds());
}

function buildTurnRows(turn,selection){
  const entries=Array.isArray(turn?.entries)?turn.entries:[],rows=[];
  const add=(value)=>rows.push(normalizeRow(value,selection));
  add({id:'HOST_EVENT:'+selectionKey(selection),phase:10,stage:'Host event',category:'HOST',severity:'INFO',status:'UNKNOWN',reasonCode:'HOST_EVENT_TYPE_NOT_RETAINED',time:null,observedAt:turn?.firstSeenAt??null,summary:selection.generationId?'The selected generation is known, but this metadata journal does not retain the exact triggering SillyTavern event type.':'No selected generation host event is available.',sourceEntryIds:[]});

  const producers=entries.filter(e=>e.type==='PRODUCER');
  const choice=latest(producers.filter(e=>e.subtype==='choice'));
  if(choice)add(fromEntry(choice,{phase:20,stage:'Cognitive Choice',category:'COGNITION',severity:severityFromEntry(choice),status:choice.status,reasonCode:choice.metadata?.errorCode??null,summary:choice.summary}));

  const readErrors=entries.filter(e=>e.type==='READ_ERROR');
  for(const entry of readErrors)add(fromEntry(entry,{phase:phaseForStage(entry.subtype),stage:(entry.subtype?label(entry.subtype)+' inspection':'Owner read')+' error',category:'ERROR',severity:'ERROR',status:'BLOCKED',reasonCode:entry.metadata?.code??entry.status,summary:entry.summary}));

  for(const edge of entries.filter(e=>e.type==='OWNER_EDGE')){
    const missing=String(edge.status??'').toUpperCase()==='NO_EVIDENCE';
    add(fromEntry(edge,{phase:Number(edge.metadata?.phase??phaseForStage(edge.subtype)),stage:edge.title??('Causal edge · '+label(edge.subtype)),category:'EDGE',severity:missing?'WARN':severityFromEntry(edge),status:edge.status,reasonCode:edge.metadata?.reasonCode??null,summary:edge.summary}));
  }

  const scatter=latest(entries.filter(e=>e.type==='SCATTER'));
  if(scatter)add(fromEntry(scatter,{phase:30,stage:'Fan-out plan',category:'RUNTIME',severity:'OK',status:scatter.status,summary:scatter.summary}));

  const audit=latest(entries.filter(e=>e.type==='JOB_AUDIT'));
  const resultToJob=new Map();
  for(const job of audit?.metadata?.jobs??[])for(const adm of job.gatherAdmissions??[])if(adm?.resultId&&!resultToJob.has(String(adm.resultId)))resultToJob.set(String(adm.resultId),job.jobId??null);
  for(const job of audit?.metadata?.jobs??[]){
    const resourceId=job.assignedOptionalResourceId??job.assignedNativeResourceId??null;
    const resourceKind=job.assignedOptionalResourceId?'optional':job.assignedNativeResourceId?'native':'unknown';
    add({id:'JOB:'+selectionKey(selection)+':'+String(job.jobId??job.sequence??rows.length),phase:40,stage:'Fan-out job',category:'RUNTIME',severity:job.outcome&&/FAIL|ERROR/i.test(String(job.outcome))?'ERROR':'OK',status:job.outcome??'UNKNOWN',reasonCode:job.reasonCode??null,time:job.startAt??job.endAt??null,observedAt:audit?.at??null,receiptId:audit?.receiptRef??null,correlationId:selection.correlationId??null,jobId:job.jobId??null,resourceId,resultId:null,summary:(job.jobId??'Logical job')+' → '+(resourceId??'resource attribution unknown')+' ('+resourceKind+'). '+(job.resultIds?.length?job.resultIds.length+' attributable result(s).':'Result attribution unknown or not published.'),sourceEntryIds:[audit.id]});
  }

  const lifecycle=latest(entries.filter(e=>e.type==='OPTIONAL_RESOURCE_LIFECYCLE'));
  for(const resource of lifecycle?.metadata?.resources??[]){
    const status=resource.skipReason&&!resource.attempted?'SKIPPED':resource.failed?'FAILED':resource.succeeded?(resource.ownerAccepted?'SUCCEEDED_ACCEPTED':'SUCCEEDED_OWNER_NOT_ACCEPTED'):resource.attempted?'ATTEMPTED':resource.qualifiedCallable?'QUALIFIED':'CONFIGURED';
    const severity=resource.failed?'ERROR':resource.attempted&&!resource.succeeded?'WARN':resource.succeeded?'OK':'INFO';
    const summary=resource.skipReason&&!resource.attempted
      ? label(resource.kind)+' was intentionally skipped: '+resource.skipReason+'. No provider attempt occurred.'
      : resource.attempted
        ? label(resource.kind)+' provider execution '+(resource.succeeded?'succeeded':'did not succeed')+(resource.succeeded&&!resource.ownerAccepted?'; owner acceptance is not evidenced.':'.')
        : label(resource.kind)+' is '+(resource.qualifiedCallable?'qualified/callable':'configured')+' but was not executed for this turn.';
    add({id:'RESOURCE:'+selectionKey(selection)+':'+String(resource.id??resource.kind),phase:50,stage:'Optional resource',category:'RESOURCE',severity,status,reasonCode:resource.skipReason??null,time:null,observedAt:lifecycle?.at??null,receiptId:lifecycle?.receiptRef??null,correlationId:selection.correlationId??null,resourceId:resource.id??null,summary,sourceEntryIds:[lifecycle.id]});
  }
  for(const entry of entries.filter(e=>e.type==='RESOURCE_ATTEMPT'))add(fromEntry(entry,{phase:50,stage:'Provider attempt',category:'RESOURCE',severity:entry.status==='FAILED'?'ERROR':'OK',status:entry.status,resourceId:entry.metadata?.resourceId??null,summary:entry.summary}));

  const gather=latest(entries.filter(e=>e.type==='GATHER'));
  const seal=latest(entries.filter(e=>e.type==='CONTEXT_SEAL'));
  const sealed=new Set((seal?.metadata?.admittedResultIds??[]).map(String));
  if(gather){
    for(const result of gather.metadata?.results??[]){
      const resultId=result.resultId??null,jobId=result.taskId??result.jobId??(resultId?resultToJob.get(String(resultId))??null:null),state=String(result.status??(result.accepted?'ADMITTED':'RETURNED')).toUpperCase();
      const admitted=state==='ADMITTED'||result.accepted===true,late=state==='LATE',stale=state==='STALE',rejected=['REJECTED','INVALID'].includes(state),sealedResult=Boolean(resultId&&sealed.has(String(resultId)));
      add({id:'RESULT:'+selectionKey(selection)+':'+String(resultId??rows.length),phase:60,stage:'Result',category:'RESULT',severity:rejected?'ERROR':late||stale?'WARN':admitted?'OK':'INFO',status:state,reasonCode:result.reasonCode??null,time:result.at??result.completedAt??null,observedAt:gather.at??null,receiptId:gather.receiptRef??null,correlationId:selection.correlationId??null,jobId,resourceId:result.resourceId??null,resultId,summary:(resultId??'Returned result')+' · '+(jobId?'job '+jobId:'job attribution unknown')+(result.destination?' → '+result.destination:' → destination unknown')+' · Gather '+state+(sealedResult?' · admitted by Context Seal':' · not evidenced in Context Seal'),sourceEntryIds:[gather.id,...(seal?[seal.id]:[])]});
    }
    add(fromEntry(gather,{phase:70,stage:'Gather',category:'GATHER',severity:(gather.metadata?.counts?.REJECTED??0)||(gather.metadata?.counts?.INVALID??0)?'WARN':'OK',status:gather.status,summary:gather.summary}));
  }
  if(seal)add(fromEntry(seal,{phase:80,stage:'Context Seal',category:'CONTEXT',severity:seal.status==='SEALED'?'OK':'WARN',status:seal.status,summary:seal.summary}));

  const prompt=latest(entries.filter(e=>e.type==='PROMPT_PLAN'));
  if(prompt)add(fromEntry(prompt,{phase:90,stage:'PromptPlan',category:'DELIVERY',severity:'INFO',status:'PLANNED',summary:prompt.summary}));
  const delivery=latest(entries.filter(e=>e.type==='HOST_DELIVERY'));
  if(delivery)add(fromEntry(delivery,{phase:100,stage:'Observed host delivery',category:'DELIVERY',severity:delivery.status==='ABORTED'?'ERROR':delivery.status==='PREPARED'?'WARN':'OK',status:delivery.status,reasonCode:delivery.metadata?.abortCode??null,time:delivery.metadata?.requestInjectedAt??delivery.metadata?.completedAt??delivery.metadata?.preparedAt??null,summary:delivery.summary}));
  else if(prompt)add({id:'HOST_DELIVERY:'+selectionKey(selection)+':unknown',phase:100,stage:'Observed host delivery',category:'DELIVERY',severity:'WARN',status:'UNKNOWN',reasonCode:'HOST_DELIVERY_NOT_OBSERVED',time:null,observedAt:prompt.at??turn?.lastUpdatedAt??null,receiptId:null,correlationId:selection.correlationId??null,summary:'PromptPlan exists, but no exact SillyTavern host-boundary delivery receipt is retained for this generation.',sourceEntryIds:[prompt.id]});

  const learning=latest(entries.filter(e=>e.type==='LEARNING'));
  if(learning)add(fromEntry(learning,{phase:110,stage:'Post-response learning',category:'LEARNING',severity:'OK',status:learning.status,summary:learning.summary}));

  return rows.sort((a,b)=>a.phase-b.phase||numericTime(a.time)-numericTime(b.time)||numericTime(a.observedAt)-numericTime(b.observedAt)||a.id.localeCompare(b.id));
}

function summarize(turn,rows){
  const entries=Array.isArray(turn?.entries)?turn.entries:[],audit=latest(entries.filter(e=>e.type==='JOB_AUDIT')),gather=latest(entries.filter(e=>e.type==='GATHER')),lifecycle=latest(entries.filter(e=>e.type==='OPTIONAL_RESOURCE_LIFECYCLE')),prompt=latest(entries.filter(e=>e.type==='PROMPT_PLAN')),delivery=latest(entries.filter(e=>e.type==='HOST_DELIVERY'));
  const ownerEdges=entries.filter(e=>e.type==='OWNER_EDGE'),ownerEvidenceEdges=ownerEdges.filter(e=>String(e.status??'').toUpperCase()!=='NO_EVIDENCE').length,missingOwnerEdges=ownerEdges.length-ownerEvidenceEdges;
  const logicalJobs=Number(audit?.metadata?.logicalJobCount??0),nativeResources=(audit?.metadata?.nativeResourceIds??[]).length,resources=lifecycle?.metadata?.resources??[],optionalAttempts=resources.filter(r=>r.attempted).length,counts=gather?.metadata?.counts??{};
  const gatherAdmitted=Number(counts.ADMITTED??0),gatherRejected=Number(counts.REJECTED??0)+Number(counts.INVALID??0),gatherLate=Number(counts.LATE??0),gatherStale=Number(counts.STALE??0),readErrors=rows.filter(r=>r.category==='ERROR').length;
  const jobText=logicalJobs?logicalJobs+' logical job'+(logicalJobs===1?'':'s')+' recorded across '+nativeResources+' native resource'+(nativeResources===1?'':'s')+'; '+optionalAttempts+' optional provider attempt'+(optionalAttempts===1?'':'s')+'.':'No selected-turn job audit is retained.';
  const edgeText=ownerEdges.length?' '+ownerEvidenceEdges+' causal owner edge'+(ownerEvidenceEdges===1?'':'s')+' have evidence; '+missingOwnerEdges+' explicitly have no evidence.':' Causal owner receipts are not retained yet.';
  return{logicalJobs,nativeResources,optionalAttempts,gatherAdmitted,gatherRejected,gatherLate,gatherStale,promptPlanState:prompt?'PLANNED':'NOT OBSERVED',hostDeliveryState:delivery?.status??'NOT OBSERVED',readErrors,ownerEvidenceEdges,missingOwnerEdges,explanation:jobText+edgeText+' Connection/qualification alone is not execution evidence.'};
}

function renderDetail(d,row,payload){
  if(!payload)return element(d,'p',{className:'a52-muted',text:'No additional safe detail is retained for this row.'});
  const wrap=element(d,'div',{className:'a52-stack',attrs:{'aria-label':'Bounded metadata-only turn-log detail'}});
  wrap.append(createKeyValue(d,[
    {key:'Category',value:row.category},{key:'Status',value:row.status},{key:'Reason',value:row.reasonCode??'not published'},
    {key:'Correlation',value:row.correlationId??'unknown'},{key:'Receipt',value:row.receiptId??'unknown'},
    {key:'Job',value:row.jobId??'not attributed'},{key:'Resource',value:row.resourceId??'not attributed'},{key:'Result',value:row.resultId??'not attributed'},
  ]));
  for(const source of payload.sources??[]){
    const values=detailPairs(source,row);
    if(values.length)wrap.append(element(d,'strong',{text:label(source.type??'Evidence')}),createKeyValue(d,values));
  }
  if(payload.truncated)wrap.append(element(d,'p',{className:'a52-muted',text:'Additional metadata was clipped to the bounded detail limit.'}));
  return wrap;
}

function detailPairs(source,row){
  const value=source.job??source.result??source.resource??source.metadata??null,pairs=[];
  if(source.summary)pairs.push({key:'Summary',value:source.summary});
  if(source.detail)pairs.push({key:'Detail',value:source.detail});
  if(!value||typeof value!=='object')return pairs;
  const preferred=['producer','consumer','edgeClass','parentReceiptId','correlationId','durationMs','lifecycleState','worldRevision','sceneRevision','sourceRevisionRefs','owner','sequence','reasonCode','assignedNativeResourceId','assignedOptionalResourceId','startAt','endAt','outcome','providerAttempted','resultId','taskId','jobId','status','accepted','resourceId','destination','capability','at','configured','qualifiedCallable','attempted','succeeded','failed','ownerAccepted','ownerAcceptanceSource','skipReason','measurementClass'];
  for(const key of preferred){
    const v=value[key];if(v==null||v===''||(Array.isArray(v)&&!v.length))continue;
    pairs.push({key:label(key),value:Array.isArray(v)?v.join(', '):String(v)});
  }
  if(source.contextSeal)pairs.push({key:'Context Seal',value:Object.entries(source.contextSeal).filter(([,v])=>v).map(([k])=>label(k)).join(', ')||'not admitted'});
  if(value.resultIds?.length)pairs.push({key:'Attributable results',value:value.resultIds.join(', ')});
  if(value.gatherAdmissions?.length)pairs.push({key:'Gather admissions',value:value.gatherAdmissions.map(x=>x.resultId??x.status??'receipt').join(', ')});
  if(value.contextSealResultIds?.length)pairs.push({key:'Context Seal results',value:value.contextSealResultIds.join(', ')});
  return pairs.slice(0,24);
}

function detailPayload(journal,selection,row,maxDetailBytes){
  const sources=(row.sourceEntryIds??[]).map(id=>journal?.readEntry?.(selection,id)).filter(Boolean);
  const detail=sources.map(entry=>detailForRow(row,entry));
  return boundObject(sanitize({kind:'Area52TurnLogDetail',contractVersion:TURN_LOG_DIAGNOSTICS_VERSION,row,sources:detail,safety:{metadataOnly:true}}),maxDetailBytes);
}

function detailForRow(row,entry){
  const base={entryId:entry.id,type:entry.type,subtype:entry.subtype,status:entry.status,receiptRef:entry.receiptRef,observedAt:entry.at,selection:entry.selection};
  if(row.jobId&&entry.type==='JOB_AUDIT')return{...base,job:(entry.metadata?.jobs??[]).find(x=>String(x.jobId??'')===String(row.jobId))??null};
  if(row.resultId&&entry.type==='GATHER')return{...base,result:(entry.metadata?.results??[]).find(x=>String(x.resultId??'')===String(row.resultId))??null,counts:entry.metadata?.counts??null};
  if(row.resultId&&entry.type==='CONTEXT_SEAL')return{...base,contextSeal:{admitted:(entry.metadata?.admittedResultIds??[]).includes(row.resultId),rejected:(entry.metadata?.rejectedResultIds??[]).includes(row.resultId),late:(entry.metadata?.lateResultIds??[]).includes(row.resultId),stale:(entry.metadata?.staleResultIds??[]).includes(row.resultId)}};
  if(row.resourceId&&entry.type==='OPTIONAL_RESOURCE_LIFECYCLE')return{...base,resource:(entry.metadata?.resources??[]).find(x=>String(x.id??'')===String(row.resourceId))??null};
  return{...base,summary:entry.summary,detail:entry.detail,metadata:entry.metadata};
}

function fromEntry(entry,overrides={}){return{id:overrides.id??entry.id,phase:overrides.phase??50,stage:overrides.stage??entry.title,category:overrides.category??'COGNITION',severity:overrides.severity??severityFromEntry(entry),status:overrides.status??entry.status,reasonCode:overrides.reasonCode??entry.metadata?.errorCode??null,time:overrides.time??null,observedAt:entry.at??null,receiptId:overrides.receiptId??entry.receiptRef??null,correlationId:entry.selection?.correlationId??null,jobId:overrides.jobId??null,resourceId:overrides.resourceId??null,resultId:overrides.resultId??null,summary:overrides.summary??entry.summary,sourceEntryIds:[entry.id]};}
function normalizeRow(row,selection){return{...row,correlationId:row.correlationId??selection.correlationId??null,sourceEntryIds:[...(row.sourceEntryIds??[])].filter(Boolean),summary:safeText(row.summary,1024),reasonCode:row.reasonCode?String(row.reasonCode):null,status:String(row.status??'UNKNOWN'),severity:String(row.severity??'INFO'),category:String(row.category??'COGNITION'),stage:String(row.stage??'Stage'),time:finite(row.time),observedAt:finite(row.observedAt),phase:Number(row.phase??50)};}
function stripPrivate(row){const {phase,...out}=row;return safeClone(out);}
function boundedVisibleRows(rows,limit){
  if(rows.length<=limit)return rows;
  const head=Math.ceil(limit/2),tail=Math.floor(limit/2);
  return [...rows.slice(0,head),...rows.slice(-tail)];
}
function latest(rows){return rows.length?rows.reduce((a,b)=>Number(a?.at??0)>=Number(b?.at??0)?a:b):null;}
function severityFromEntry(entry){const status=String(entry?.status??'').toUpperCase(),code=String(entry?.metadata?.errorCode??'').toUpperCase();if(/FAIL|ERROR|DEGRADED|ABORT/.test(status)||/ERROR|STALE|FUTURE|MISMATCH/.test(code))return'ERROR';if(/WAIT|LATE|STALE|REJECT|INVALID|UNAVAILABLE/.test(status))return'WARN';if(/COMPLETE|LIVE|READY|SEALED|SUCCEEDED|RECORDED|MAPPED/.test(status))return'OK';return'INFO';}
function phaseForStage(stage){const x=String(stage??'').toLowerCase();if(x.includes('choice')||x.includes('hot'))return 20;if(x.includes('runtime')||x.includes('scatter'))return 30;if(x.includes('gather'))return 70;if(x.includes('seal'))return 80;if(x.includes('prompt'))return 90;if(x.includes('generation')||x.includes('delivery'))return 100;return 25;}
function normalizeFilters(filters,now){const time=String(filters?.time??'ALL').toUpperCase(),category=String(filters?.category??'ALL').toUpperCase(),severity=String(filters?.severity??'ALL').toUpperCase(),search=String(filters?.search??'').trim();const windowMs=time==='1M'?60000:time==='5M'?300000:time==='15M'?900000:null;return{time:['ALL','1M','5M','15M'].includes(time)?time:'ALL',category,severity,search,since:windowMs==null?null:Number(now)-windowMs};}
function matchesFilters(row,filters){if(filters.category!=='ALL'&&row.category!==filters.category)return false;if(filters.severity!=='ALL'&&row.severity!==filters.severity)return false;if(filters.since!=null){const t=row.time??row.observedAt;if(t==null||t<filters.since)return false;}if(filters.search){const hay=[row.stage,row.status,row.reasonCode,row.receiptId,row.correlationId,row.jobId,row.resourceId,row.resultId,row.summary].filter(Boolean).join(' ').toLowerCase();if(!hay.includes(filters.search.toLowerCase()))return false;}return true;}
function normalizeSelection(value={}){return{chatId:text(value.chatId),turnId:text(value.turnId),generationId:text(value.generationId),correlationId:text(value.correlationId),worldRevision:numberOrNull(value.worldRevision),sceneRevision:numberOrNull(value.sceneRevision),sourceRevisionRefs:[...new Set((value.sourceRevisionRefs??[]).map(text).filter(Boolean))].slice(0,32)};}
function selectionKey(value={}){return[value.chatId??'',value.turnId??'',value.generationId??''].join('|');}
function selectControl(d,labelText,value,options){const wrap=element(d,'label',{className:'a52-stack'}),labelNode=element(d,'span',{className:'a52-muted',text:labelText}),input=element(d,'select',{attrs:{'aria-label':labelText+' filter'}});for(const [id,label] of options){const opt=element(d,'option',{attrs:{value:id},text:label});if(id===value)opt.selected=true;input.append(opt);}wrap.append(labelNode,input);return{wrap,input};}
function displayTime(row){if(row.time!=null)return formatTime(row.time);if(row.observedAt!=null)return'Time unknown · observed '+formatTime(row.observedAt);return'Time unknown';}
function formatTime(value){try{return new Date(Number(value)).toLocaleTimeString();}catch{return'unknown';}}
function severityStatus(value){return value==='ERROR'?'warning':value==='WARN'?'warning':value==='OK'?'ready':'historical';}
function statusToken(value){const x=String(value??'').toUpperCase();if(/FAIL|ERROR|ABORT|REJECT|INVALID/.test(x))return'warning';if(/COMPLETE|LIVE|READY|SEALED|SUCCESS|ADMITTED|RECORDED|MAPPED|INJECTED/.test(x))return'ready';return'historical';}
function label(value){return String(value??'unknown').replace(/([a-z])([A-Z])/g,'$1 $2').replace(/[_-]+/g,' ').replace(/\b\w/g,m=>m.toUpperCase());}
function text(value){const x=value==null?'':String(value).trim();return x||null;}
function finite(value){const n=Number(value);return value==null||!Number.isFinite(n)?null:n;}
function numericTime(value){const n=Number(value);return Number.isFinite(n)?n:Number.MAX_SAFE_INTEGER;}
function numberOrNull(value){const n=Number(value);return value==null||!Number.isFinite(n)?null:n;}
function filePart(value){return String(value??'').replace(/[^a-z0-9._-]+/gi,'-').replace(/^-+|-+$/g,'').slice(0,80)||'unknown';}
function safeText(value,limit=2048){let out=String(value??'');out=out.replace(/(\bBearer\s+)[A-Za-z0-9._~+/=-]+/gi,'$1[REDACTED]');out=out.replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g,'[REDACTED]');out=out.replace(/(\b(?:api[_-]?key|authorization|credential|secret|password|access[_-]?token|refresh[_-]?token)\b\s*[:=]\s*)([^\s,;&]+)/gi,'$1[REDACTED]');return out.length>limit?out.slice(0,limit)+'…[clipped]':out;}
function sanitize(value,depth=0,key=''){if(depth>7)return'[depth-clipped]';const k=String(key??'').toLowerCase();if(BLOCKED_KEYS.has(k))return'[REDACTED]';if(value==null||typeof value==='number'||typeof value==='boolean')return value;if(typeof value==='string')return safeText(value);if(Array.isArray(value))return value.slice(0,64).map(v=>sanitize(v,depth+1,key));if(typeof value==='object'){const out={};for(const [name,v] of Object.entries(value)){const clean=sanitize(v,depth+1,name);if(clean!==undefined)out[name]=clean;}return out;}return safeText(value);}
function boundObject(value,maxBytes){let clean=sanitize(value),json=JSON.stringify(clean);if(json.length<=maxBytes)return clean;return{kind:clean?.kind??'Area52TurnLogDetail',contractVersion:TURN_LOG_DIAGNOSTICS_VERSION,row:clean?.row??null,sources:(clean?.sources??[]).slice(0,4).map(source=>({entryId:source.entryId,type:source.type,subtype:source.subtype,status:source.status,receiptRef:source.receiptRef,summary:safeText(source.summary??'Detail clipped to bounded export size.',512)})),truncated:true,maxBytes,safety:{metadataOnly:true}};}
function safeClone(value){if(value==null)return value;if(typeof structuredClone==='function')return structuredClone(value);return JSON.parse(JSON.stringify(value));}


function createStoredZipBlob(files,{BlobCtor=globalThis.Blob,TextEncoderCtor=globalThis.TextEncoder,exportedAt=Date.now()}={}){
  try{
    const encoder=new TextEncoderCtor(),locals=[],centrals=[];let offset=0,centralSize=0;
    const stamp=dosDateTime(exportedAt);
    for(const file of files??[]){
      const name=encoder.encode(String(file.path??'diagnostic.txt')),data=encoder.encode(String(file.content??'')),crc=crc32(data),size=data.byteLength;
      const local=new Uint8Array(30+name.byteLength),lv=new DataView(local.buffer);
      lv.setUint32(0,0x04034b50,true);lv.setUint16(4,20,true);lv.setUint16(6,0x0800,true);lv.setUint16(8,0,true);lv.setUint16(10,stamp.time,true);lv.setUint16(12,stamp.date,true);
      lv.setUint32(14,crc,true);lv.setUint32(18,size,true);lv.setUint32(22,size,true);lv.setUint16(26,name.byteLength,true);lv.setUint16(28,0,true);local.set(name,30);
      locals.push(local,data);
      const central=new Uint8Array(46+name.byteLength),cv=new DataView(central.buffer);
      cv.setUint32(0,0x02014b50,true);cv.setUint16(4,20,true);cv.setUint16(6,20,true);cv.setUint16(8,0x0800,true);cv.setUint16(10,0,true);cv.setUint16(12,stamp.time,true);cv.setUint16(14,stamp.date,true);
      cv.setUint32(16,crc,true);cv.setUint32(20,size,true);cv.setUint32(24,size,true);cv.setUint16(28,name.byteLength,true);cv.setUint16(30,0,true);cv.setUint16(32,0,true);cv.setUint16(34,0,true);cv.setUint16(36,0,true);cv.setUint32(38,0,true);cv.setUint32(42,offset,true);central.set(name,46);
      centrals.push(central);offset+=local.byteLength+size;centralSize+=central.byteLength;
    }
    const end=new Uint8Array(22),ev=new DataView(end.buffer),count=centrals.length;
    ev.setUint32(0,0x06054b50,true);ev.setUint16(4,0,true);ev.setUint16(6,0,true);ev.setUint16(8,count,true);ev.setUint16(10,count,true);ev.setUint32(12,centralSize,true);ev.setUint32(16,offset,true);ev.setUint16(20,0,true);
    return new BlobCtor([...locals,...centrals,end],{type:'application/zip'});
  }catch{return null;}
}
function crc32(bytes){let crc=0xffffffff;for(const byte of bytes){crc^=byte;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}return(crc^0xffffffff)>>>0;}
function dosDateTime(value){const d=new Date(Number(value)||Date.now()),year=Math.max(1980,d.getFullYear());return{time:(d.getHours()<<11)|(d.getMinutes()<<5)|Math.floor(d.getSeconds()/2),date:((year-1980)<<9)|((d.getMonth()+1)<<5)|d.getDate()};}

function safeDecisionRead(adapter,selection){try{return adapter?.read?.(selection)??null;}catch(error){return{kind:'BrainDecisionVisibilityReadModel',contractVersion:1,selection,state:'NO_EVIDENCE',identityState:'READ_FAILED',stages:[],sensoryNominations:[],choiceDecisions:[],lifecycleObligations:[],candidateFlow:[],delivery:{planned:{state:'UNAVAILABLE'},sealed:{state:'UNAVAILABLE'},observed:{state:'UNAVAILABLE'}},missingReceipts:['NativeBrainSelectedTurnReceipt'],errors:[{stage:'BrainDecisionVisibility',code:error?.code??'READ_FAILED'}],safety:{metadataOnly:true,rawPrompts:false,storyLoreBodies:false,credentials:false,hiddenReasoning:false,mutationAuthority:false}};}}
