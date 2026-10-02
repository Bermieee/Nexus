import { subscribeWorldTreeUi } from './core/world-tree-events.js';
import {createWorldTreeBuilderHostBindings} from './builder2/world-host.js';
import {createLorebookWorldTreeBuilderHost} from './builder2/book-world-host.js';
import {analyzeWorldTreeContext} from './builder2/world-analysis.js';
import {attachWorldTreeStoryBook} from './world-tree/story-attachment.js';
export {createWorldTreeBuilderHostBindings};
import { mountWave12SillyTavernInterface } from './src/ui-core/wave12-sillytavern-host.js';
import {
  createNexusUiHostBindings,
  projectNexusSensoryTrace,
  projectNexusTruthAssessment,
  projectNexusScatterReceipt,
  projectNexusGatherReceipt,
} from './nexus-ui-bindings.js';
import { getSettings,assertAuthoritySettingsReady } from './core/settings.js';
import {assertReadableBook,assertWritableBook,canReadBook,isBookEnabled,setBookEnabled} from './lore/policy.js';
import {getHostLorebookNames} from './lore/host-inventory.js';
import {createLorebookAuthoringSource} from './lore/authoring-source.js';
import { getJobQueue } from './core/job-queue.js';
import { snapshotMainBridgeStatus, getMainBridgeStatusEventName } from './nexus/main-bridge-status.js';
import { getTelemetrySnapshot, getTelemetryActivitySnapshot, onTelemetryChange } from './observability/telemetry.js';
import { getGenerationFrameIdentity } from './nexus/generation-frame-bus.js';
import { getMemoryReadSnapshot, getMemoryStore } from './memory/store.js';
import { getNexusLedger, stageUidSummarySelectionTransaction, persistNexusReviewTransaction, transitionNexusReviewTransactionDurably } from './nexus/transaction-service.js';
import { getHousekeeperRuntimeStatus } from './maintenance/housekeeper.js';
import { vectorPagingStatus } from './paging/runtime.js';
import { getLastWarmStats } from './smart-context/warmer.js';
import { getPostTurnBacklogState } from './postturn/pipeline.js';
import { projectNexusDiagnosticTelemetryFromObservability } from './nexus/diagnostics-source.js';
import { getDecisionTelemetrySnapshot } from './decision/telemetry.js';
import { readDecisionRecords } from './decision/records.js';
import { getRetrievalDiagnosticsSnapshot, readGraphTraversalDiagnostics } from './retrieval/diagnostics.js';
import { inspectSelectedWorldGraph } from './retrieval/graph-inspection.js';
import { getGenerationFrameDiagnostics } from './nexus/generation-frame.js';
import { currentNexusHotSnapshot } from './nexus/hot-cognition.js';
import { nexusForegroundScatterGatherDiagnostics } from './nexus/scatter-gather-runtime.js';
import {getNexusWorldTreeOwner,requireWorldTreeStoryBinding,readNexusWorldTreeUiModel,readNexusWorldTree,readNexusWorldTreeLoreMetadata} from './world-tree/index.js';
import { legacyWorldTreeMigrationRuntimeStatus } from './world-tree/legacy-migration.js';
import { setWorldTreeCharacterTracking, readWorldTreeTrackSuggestions } from './world-tree/tracking.js';
import { readWorldTreeWatchList } from './world-tree/watch-list.js';
import { listWorldTreeCandidates } from './world-tree/intake/candidates.js';
import { readableDecisionReasons } from './world-tree/decision-records.js';
import { WORLD_TREE_GROWTH_THRESHOLD } from './world-tree/growth.js';
import { legacyLoreWorldTreeBridgeStatus } from './world-tree/legacy-lore-bridge.js';
import { getSceneScannerSnapshot } from './scene/scanner.js';
import { getNexusSceneIntelligenceView } from './nexus/scene-intelligence.js';
import { listSillyTavernCharacters, getCurrentSillyTavernCharacter, inspectSillyTavernCharacter } from './character-cards/io.js';
import {
  readNexusConnectionResources,
  configureNexusConnectionResource,
  connectNexusConnectionResource,
  disconnectNexusConnectionResource,
  testNexusConnectionResource,
  discoverNexusConnectionModels,
  refreshNexusConnectionModels,
  selectNexusConnectionModel,
  setNexusConnectionCredential,
  clearNexusConnectionCredential,
  setNexusConnectionEndpoint,
} from './nexus/resource-connections.js';
import {
  setDetailedGenerationProfiling,
  loadGenerationProfilerDiagnostics,
  readNativeGenerationPerformance,
  readSelectedGenerationPerformanceReceipt,
} from './nexus/generation-profiler.js';
import {getTree} from './tree/store.js';
import { scanMergeCandidates } from './tools/merge.js';
import { syncLegacyLoreToWorldTree } from './world-tree/legacy-lore-bridge.js';
import { projectNexusActivityFeed } from './src/ui-core/activity-projection.js';
import { summarizeUid } from './lore/uid-summarizer.js';
import { estimateContentTokens } from './observability/token-estimator.js';
import { getCharacterBanks, getCharacterBankMemories, updateCharacterBank } from './memory/character-banks.js';
import {
  getCharacterStateReviewSnapshot,
  reviewRecentChatForCharacterState,
  reviewSummaryForCharacterState,
  approveCharacterStateProposal,
  rejectCharacterStateProposal,
} from './memory/character-state-review.js';
import { CHARACTER_TRACKING_POLICY } from './memory/character-state-contract.js';

let activeNexusUi=null;

function readCharacterCardMetadata(){
  const rows=listSillyTavernCharacters().map(row=>{
    let card=null;
    try{card=inspectSillyTavernCharacter(row.character);}catch{}
    return{
      index:row.index,
      avatar:row.avatar??card?.avatar??null,
      name:row.name??card?.name??null,
      tags:Array.isArray(card?.tags)?card.tags:[],
      characterVersion:card?.characterVersion??null,
      fingerprint:card?.fingerprint??null,
    };
  });
  let currentIndex=null;
  try{currentIndex=getCurrentSillyTavernCharacter().index;}catch{}
  return{rows,currentIndex};
}

/**
 * Nexus owns the product name and host lifecycle. Nexus UI.Core owns presentation.
 * Only clean read-only seams are exposed here. Ported cognition systems are
 * projected into the finished UI through bounded read models; telemetry and
 * probes remain centralized in Diagnostics.
 */
export function mountNexusUi({getContext,runtime=null}={}){
  if(activeNexusUi)return activeNexusUi;
  const storyBuilderBindings=createWorldTreeBuilderHostBindings({getContext,runtime});
  const authoringSource=createLorebookAuthoringSource({listNames:getHostLorebookNames,canRead:canReadBook,
    assertReady:()=>assertAuthoritySettingsReady('Lorebook authoring'),
    loadBook:async book=>(await import('./lore/store.js')).loadBook(book),
    enableBook:async book=>{if(!isBookEnabled(book))await setBookEnabled(book,true);},
    createBook:async book=>(await import('./lore/store.js')).createEmptyBook(book)});
  const bookDependencies={loadBook:async book=>(await import('./lore/store.js')).loadBook(book),readTree:getTree,
    assertReadableBook,assertWritableBook,
    ledger:getNexusLedger(),commitMutation:async(...args)=>(await import('./nexus/mutation-coordinator.js')).commitCanonicalNexusMutation(...args)};
  let bookBuilderBindings;
  try{bookBuilderBindings=createLorebookWorldTreeBuilderHost({...bookDependencies,analysis:runtime?.director&&runtime?.coordinator?(context,options,adapters)=>analyzeWorldTreeContext(context,options,{runtime,...adapters}):null});}
  catch(error){bookBuilderBindings=createLorebookWorldTreeBuilderHost(bookDependencies);bookBuilderBindings.worldTreeBuilderUnavailableReason=error.message;}
  const worldBuilderBindings={...storyBuilderBindings,
    readWorldTreeAuthoringBinding:bookBuilderBindings.readWorldTreeAuthoringBinding,
    readWorldTreeAuthoringModel:bookBuilderBindings.readWorldTreeAuthoringModel,
    listWorldTreeAuthoringBooks:()=>authoringSource.list(),
  };
  for(const name of ['startWorldTreeBuild','readWorldTreeBuild','reviseWorldTreeBuild','approveWorldTreeBuild','applyWorldTreeBuild','cancelWorldTreeBuild','resumeWorldTreeBuild','retryWorldTreeBuildLayout','reviewWorldTreeBuildLayout','readWorldTreeLayout','saveWorldTreeLayoutPins','readWorldTreeBuildSourceIds','listWorldTreeBuilds','readWorldTreeBuilderChatId','trashWorldTree']){
    if(bookBuilderBindings[name]||storyBuilderBindings[name])worldBuilderBindings[name]=(...args)=>{
      const selected=bookBuilderBindings.readWorldTreeAuthoringBinding();
      const handler=selected?bookBuilderBindings[name]:storyBuilderBindings[name];
      if(!handler)throw Error(bookBuilderBindings.worldTreeBuilderUnavailableReason??'Builder owner unavailable');return handler(...args);
    };
  }
  const baseHostBindings=createNexusUiHostBindings({
    readCurrentChatId:()=>getContext?.()?.chatId??null,
    readGenerationFrameIdentity:()=>getGenerationFrameIdentity(),
    readMemorySnapshot:()=>typeof getMemoryReadSnapshot==='function'?getMemoryReadSnapshot():getMemoryStore(),
    readLoreSnapshot:()=>readNexusWorldTreeLoreMetadata({chatId:getContext?.()?.chatId??null}),
    readTransactions:()=>getNexusLedger().list(),
    readSubsystemStatus:()=>({
      maintenance:getHousekeeperRuntimeStatus(),
      paging:vectorPagingStatus(),
      smartContext:getLastWarmStats(),
      postturn:getPostTurnBacklogState(getContext?.()),
    }),
    subscribeOwner:listener=>onTelemetryChange(()=>listener({kind:'NexusOwnerTelemetryChanged'})),
    readSettings:()=>getSettings(),
    readQueueHealth:()=>getJobQueue(getSettings().jobs).healthSnapshot(),
    readResources:()=>readNexusConnectionResources({queue:getJobQueue(getSettings().jobs).healthSnapshot()}),
    readRuntimeDiagnostic:()=>runtime?.diagnosticSnapshot?.()??{},
    readMainBridge:()=>snapshotMainBridgeStatus(),
    readSceneSnapshot:(selection={})=>{
      const chatId=selection?.chatId??getContext?.()?.chatId??null;
      return getNexusSceneIntelligenceView({chatId})??getSceneScannerSnapshot({chatId});
    },
    readCharacterCards:()=>readCharacterCardMetadata(),
    readTelemetry:()=>getTelemetrySnapshot(),
    readSystemDiagnostics:()=>projectNexusDiagnosticTelemetryFromObservability(getTelemetrySnapshot()),
    readHotCognition:(selection={})=>{
      const snapshot=currentNexusHotSnapshot({context:getContext?.()});
      if(!snapshot)return null;
      if(selection?.chatId!=null&&snapshot?.chatNamespace!=null&&String(selection.chatId)!==String(snapshot.chatNamespace))return null;
      return snapshot;
    },
    readScatter:(selection={})=>{
      const diagnostics=nexusForegroundScatterGatherDiagnostics();
      if(!diagnostics)return null;
      if(selection?.chatId!=null&&diagnostics.chatId!=null&&String(selection.chatId)!==String(diagnostics.chatId))return null;
      if(selection?.generationId!=null&&diagnostics.generationId!=null&&String(selection.generationId)!==String(diagnostics.generationId))return null;
      return projectNexusScatterReceipt(diagnostics);
    },
    readGather:(selection={})=>{
      const diagnostics=nexusForegroundScatterGatherDiagnostics();
      if(!diagnostics)return null;
      if(selection?.chatId!=null&&diagnostics.chatId!=null&&String(selection.chatId)!==String(diagnostics.chatId))return null;
      if(selection?.generationId!=null&&diagnostics.generationId!=null&&String(selection.generationId)!==String(diagnostics.generationId))return null;
      return projectNexusGatherReceipt(diagnostics);
    },
    readSensoryTrace:(selection={})=>projectNexusSensoryTrace(getTelemetrySnapshot(),selection),
    readTruthAssessment:(selection={})=>projectNexusTruthAssessment(getTelemetrySnapshot(),selection),
    readDecisionTelemetry:()=>getDecisionTelemetrySnapshot(),
    readRetrievalDiagnostics:(selection={})=>getRetrievalDiagnosticsSnapshot({chatId:selection?.chatId??null}),
    readGraphTraversal:selection=>readGraphTraversalDiagnostics(selection),
    readWorldGraphReferences:selection=>inspectSelectedWorldGraph(selection,getContext?.()?.chatId??null),
    readGenerationFrameDiagnostics:()=>getGenerationFrameDiagnostics(),
    subscribeWorldTree:listener=>subscribeWorldTreeUi(listener,{getChatId:()=>getContext?.()?.chatId??null}),
    readWorldTree:()=>readNexusWorldTreeUiModel({chatId:getContext?.()?.chatId??null}),
    setWorldTreeCharacterTracking:({nodeId,tracked}={})=>setWorldTreeCharacterTracking({nodeId,tracked,context:getContext?.()}),
    readWorldTreeTrackSuggestions:()=>readWorldTreeTrackSuggestions({context:getContext?.()}),
    readWorldTreeDiagnostics:()=>{
      const context=getContext?.()??{},chatId=context?.chatId??null,tree=getNexusWorldTreeOwner();
      const snapshot=readNexusWorldTree({chatId,includeOverlays:true,limit:5000}),frame=getGenerationFrameIdentity();
      const generationId=frame?.generationId??null;
      const treeDecisionRows=tree.listDecisionRecords({chatId,generationId,limit:128}).map(row=>Object.freeze({...row,subsystem:row.site?.split('.')?.[0]??'world-tree',why:Object.freeze(readableDecisionReasons(row))}));
      const coreDecisionRows=readDecisionRecords({chatId,generationId,limit:128});
      const decisionRows=[...treeDecisionRows,...coreDecisionRows].sort((a,b)=>Number(a.ts)-Number(b.ts)).slice(-128);
      const watch=readWorldTreeWatchList({tree,chatId}).map(row=>Object.freeze({...row,sourceRefs:Object.freeze([...(row.sourceRefs??[])])}));
      const watchHistory=tree.listDecisionRecords({chatId,site:'worldtree.watch',limit:64})
        .filter(row=>(row.reasonCodes??[]).some(code=>code==='ENTERED_FROM_WATCHLIST'||code==='WATCH_EXPIRED'))
        .map(row=>Object.freeze({...row,why:Object.freeze(readableDecisionReasons(row))}));
      const growth=listWorldTreeCandidates({context,chatId}).map(row=>Object.freeze({
        candidateId:String(row.candidateId),label:String(row.label??''),kindHint:row.kindHint??null,
        mentionCount:Number(row.mentionCount)||0,firstTurn:row.firstTurn??null,lastTurn:row.lastTurn??null,
        evidenceScore:Number.isFinite(Number(row.evidenceScore))?Number(row.evidenceScore):null,
        threshold:WORLD_TREE_GROWTH_THRESHOLD,growthChoice:row.growthChoice??null,
        growthDecisionRecordId:row.growthDecisionRecordId??null,sourceRefCount:(row.sourceRefs??[]).length,
      }));
      return{
        kind:'NexusWorldTreeDiagnostics',chatId:chatId==null?null:String(chatId),generationId,
        worldRevision:snapshot.worldRevision,overlayRevision:snapshot.overlayRevision,counts:snapshot.counts,
        views:Object.freeze({
          thisTurn:Object.freeze({generationId,records:Object.freeze(decisionRows)}),
          watchList:Object.freeze({entries:Object.freeze(watch),recent:Object.freeze(watchHistory)}),
          growth:Object.freeze({threshold:WORLD_TREE_GROWTH_THRESHOLD,candidates:Object.freeze(growth)}),
        }),
        legacyWorldBridge:legacyWorldTreeMigrationRuntimeStatus(),legacyLoreBridge:legacyLoreWorldTreeBridgeStatus(),
        metadataOnly:true,rawStoryTextIncluded:false,
      };
    },
  });
  let authoringRequest=0;
  const selectAuthoringSource=async(input,create=false)=>{
    const request=++authoringRequest;
    const prepared=await authoringSource[create?'create':'load'](create?input?.name:input?.id??input?.book);
    if(request!==authoringRequest)throw Error('Lorebook selection changed while loading.');
    return bookBuilderBindings.loadWorldTreeSource({id:prepared.book,title:prepared.book});
  };
  const loadWorldTreeSource=snapshot=>selectAuthoringSource(snapshot);
  worldBuilderBindings.createWorldTreeBook=input=>selectAuthoringSource(input,true);
  const attachWorldTreeStoryBookAction=async({book}={})=>{
    const origin=getContext();
    const originChatId=String(origin?.chatId??''),originScope=JSON.stringify(origin?.chatMetadata?.tv2_story_scope_v1??null);
    const [{getManagedBooks},{configureCurrentStoryScope}]=await Promise.all([import('./lore/active-books.js'),import('./lore/story-scope.js')]);
    const live=getContext();if(String(live?.chatId??'')!==originChatId||live?.chatMetadata!==origin?.chatMetadata||JSON.stringify(live?.chatMetadata?.tv2_story_scope_v1??null)!==originScope)throw Error('Story changed before attaching Lorebook');
    return attachWorldTreeStoryBook({book,getContext,getManagedBooks,configureCurrentStoryScope});
  };
  const scanWorldTreeMerge=async({book,thresholdPercent=35,limit=25}={})=>{
    const id=requireWorldTreeStoryBinding({book}).book;
    return scanMergeCandidates(id,{thresholdPercent,limit});
  };
  const summarizeLoreUid=async({book,uid,includeKeywords=true}={})=>{
    const id=requireWorldTreeStoryBinding({book}).book;const numericUid=Number(uid);
    if(!id||!Number.isFinite(numericUid))throw new Error('UID Summarizer requires a Lorebook and numeric UID.');
    return summarizeUid({book:id,uid:numericUid,profiles:['lean','balanced','heavy'],includeKeywords:includeKeywords!==false});
  };
  const stageLoreUidSummary=async({transactionId,option,summary=null,keywords=null}={})=>{
    const txId=String(transactionId??'').trim();if(!txId)throw new Error('UID summary review requires a transaction.');
    const chosen=option&&typeof option==='object'?option:{};
    const content=String(summary??chosen.summary??'').trim();if(!content)throw new Error('Selected UID summary draft is empty.');
    const estimatedTokens=estimateContentTokens(content);
    const cap=Number(chosen.safetyCapTokens??chosen.targetTokens??0);
    const staged=stageUidSummarySelectionTransaction(txId,{
      draft:{content,keywords:Array.isArray(keywords)?keywords:[...(chosen.keywords??[])],notes:String(chosen.notes??'')},
      cap:Number.isFinite(cap)&&cap>0?cap:Math.max(48,estimatedTokens),
      estimatedTokens,optionId:chosen.id??chosen.profileId??null,
      metadata:{profileId:chosen.profileId??null,label:chosen.label??null,operatorSelected:true},
    });
    if(staged?.state==='failed')return staged;
    await persistNexusReviewTransaction(txId);
    return getNexusLedger().read(txId);
  };
  const rejectLoreUidSummary=async({transactionId,reason='Rejected from UID Summarizer'}={})=>{
    const txId=String(transactionId??'').trim();if(!txId)throw new Error('UID summary review requires a transaction.');
    return transitionNexusReviewTransactionDurably(txId,(shadow)=>shadow.reject(txId,String(reason||'Rejected from UID Summarizer')));
  };
  const hostBindings=Object.freeze({
    ...baseHostBindings,
    listResources:()=>readNexusConnectionResources({queue:getJobQueue(getSettings().jobs).healthSnapshot()}),
    readResourceStatus:()=>readNexusConnectionResources({queue:getJobQueue(getSettings().jobs).healthSnapshot()}),
    addResource:config=>configureNexusConnectionResource(config),
    configureResource:config=>configureNexusConnectionResource(config),
    discoverModels:config=>discoverNexusConnectionModels(config),
    refreshModels:resource=>refreshNexusConnectionModels(resource),
    selectModel:(resourceId,modelId)=>selectNexusConnectionModel(resourceId,modelId),
    selectResourceModel:(resourceId,modelId)=>selectNexusConnectionModel(resourceId,modelId),
    connectResource:config=>connectNexusConnectionResource(config),
    disconnectResource:resource=>disconnectNexusConnectionResource(resource),
    testResource:resource=>testNexusConnectionResource(resource),
    testConnection:resource=>testNexusConnectionResource(resource),
    setCredential:(resourceId,apiKey)=>setNexusConnectionCredential(resourceId,apiKey),
    setResourceCredential:(resourceId,apiKey)=>setNexusConnectionCredential(resourceId,apiKey),
    clearCredential:resourceId=>clearNexusConnectionCredential(resourceId),
    clearResourceCredential:resourceId=>clearNexusConnectionCredential(resourceId),
    setEndpoint:(resourceId,endpoint)=>setNexusConnectionEndpoint(resourceId,endpoint),
    setResourceEndpoint:(resourceId,endpoint)=>setNexusConnectionEndpoint(resourceId,endpoint),
    setDetailedGenerationProfiling:enabled=>setDetailedGenerationProfiling(enabled),
    loadDiagnostics:()=>loadGenerationProfilerDiagnostics(),
    readNativeGenerationPerformance:selection=>readNativeGenerationPerformance(selection),
    readSelectedTurnReceipt:selection=>{
      const receipt=baseHostBindings.readSelectedTurnReceipt(selection);
      const performance=readSelectedGenerationPerformanceReceipt(selection);
      return receipt?{...receipt,performance:performance?.performance??null}:performance;
    },
    readActivityFeed:()=>projectNexusActivityFeed({
      telemetry:getTelemetryActivitySnapshot(),
      queue:getJobQueue(getSettings().jobs).healthSnapshot(),
      mainBridge:snapshotMainBridgeStatus(),
      settings:getSettings(),
    }),
    subscribeActivityFeed:listener=>{
      if(typeof listener!=='function')return()=>{};
      const releases=[];
      releases.push(onTelemetryChange(()=>listener({kind:'NexusActivityFeedChanged',source:'telemetry'})));
      try{
        const queue=getJobQueue(getSettings().jobs);
        const releaseQueue=queue?.onSignal?.(()=>listener({kind:'NexusActivityFeedChanged',source:'queue'}));
        if(typeof releaseQueue==='function')releases.push(releaseQueue);
      }catch{}
      try{
        const win=globalThis.window,eventName=getMainBridgeStatusEventName();
        if(win?.addEventListener&&eventName){
          const handler=()=>listener({kind:'NexusActivityFeedChanged',source:'main'});
          win.addEventListener(eventName,handler);releases.push(()=>win.removeEventListener(eventName,handler));
        }
      }catch{}
      return()=>{for(const release of releases.splice(0))try{release();}catch{}};
    },
    characterReview:Object.freeze({
      read(){
        const banks=getCharacterBanks().map(bank=>({
          ...bank,
          linkedSummaries:getCharacterBankMemories(bank).slice(0,40).map(memory=>({
            id:memory.id,
            layer:memory.layer,
            text:String(memory.text??'').slice(0,640),
            topics:[...(memory.topics??[])].slice(0,4),
            characters:[...(memory.characters??[])].slice(0,12),
            updatedAt:memory.updatedAt??memory.createdAt??null,
          })),
        }));
        return Object.freeze({
          banks,
          review:getCharacterStateReviewSnapshot(),
          trackingPolicy:CHARACTER_TRACKING_POLICY,
          manualOnly:true,
          humanApprovalFinal:true,
        });
      },
      updateTracking(bankId,tracking){
        const bank=getCharacterBanks().find(row=>String(row.id)===String(bankId));
        if(!bank)throw new Error('Character Bank not found.');
        return updateCharacterBank(bank.id,{tracking:{...(bank.tracking??{}),...(tracking??{})}});
      },
      reviewRecentChat(bankId,{messageCount=25}={}){
        return reviewRecentChatForCharacterState(bankId,{messageCount});
      },
      reviewSummary(memoryId,{bankId}={}){
        return reviewSummaryForCharacterState(memoryId,{bankIds:bankId?[bankId]:null});
      },
      approveProposal(proposalId){return approveCharacterStateProposal(proposalId);},
      rejectProposal(proposalId,reason='Rejected by operator.'){return rejectCharacterStateProposal(proposalId,reason);},
    }),
    loadWorldTreeSource,
    attachWorldTreeStoryBook:attachWorldTreeStoryBookAction,
    ...worldBuilderBindings,
    scanWorldTreeMerge,
    summarizeLoreUid,
    stageLoreUidSummary,
    rejectLoreUidSummary,
  });
  activeNexusUi=mountWave12SillyTavernInterface({
    getContext,
    hostBindings,
    productName:'Nexus',
    productTagline:'Cognitive Story System',
    rootId:'nexus-ui-core-host',
    floatingNavigation:true,
  });
  return activeNexusUi;
}

export function destroyNexusUi(){
  if(!activeNexusUi)return;
  try{activeNexusUi.destroy?.();}finally{activeNexusUi=null;}
}

export function nexusUiDiagnostics(){return activeNexusUi?.diagnostics?.()??null;}
