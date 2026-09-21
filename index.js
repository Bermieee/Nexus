/** Nexus framework orchestrator. Keep this file boring. */
import { eventSource, event_types, generateRaw } from '../../../../script.js';
import { getContext } from '../../../st-context.js';
import { renderExtensionTemplateAsync } from '../../../extensions.js';
import { initRuntime, teardownRuntime } from './core/runtime.js';
import { getSettings } from './core/settings.js';
import { getJobQueue } from './core/job-queue.js';
import { isIntentionalCancellation } from './core/cancellation.js';
import { bindUI } from './ui.js';
import { initLorePaging } from './paging/lore-runtime.js';
import { initVectorPaging, invalidateVectorPaging } from './paging/runtime.js';
import { registerTools, unregisterTools } from './tools/registry.js';
import { runRetrieval, clearRetrieval } from './retrieval/retriever.js';
import { hasReusableInjection } from './retrieval/state.js';
import { prepareBootstrapAdmission, hasBootstrapAdmissionForBook, hasBootstrapAdmissionForEntry, clearBootstrapAdmission, getBootstrapAdmissionState } from './retrieval/bootstrap-admission.js';
import { beginNativeWorldInfoSuppression, rollbackNativeWorldInfoSuppression, narrowNativeWorldInfoSuppression, commitNativeWorldInfoSuppression, removeNativeWorldInfoEntries } from './retrieval/native-worldinfo-transaction.js';
import { markPostTurnPending, reconcilePostTurnBacklogAuthority } from './postturn/pipeline.js';
import { reconcilePostTurnParentSagas } from './postturn/parent-recovery.js';
import { invalidateSmartContext } from './smart-context/warmer.js';
import { prepareMemoryRecall, clearMemoryRecall } from './memory/recall.js';
import { prepareNotebookPrompt, clearNotebookPrompt, refreshNotebookFromScene } from './memory/notebook.js';
import { resetCharacterBankReconciliation } from './memory/character-banks.js';
import { resetMemoryBankUiState } from './memory/ui.js';
import { reconcileLoreRoutingSagasOnStartup } from './memory/lore-router.js';
import { reconcileProposalAuditFromCommitJournal } from './proposals/store.js';
import { reconcileDirectWriteLedgerOnStartup } from './lore/write-valve.js';
import { runLifecycleCycle, invalidateLifecycleScheduler, clearLifecycleSchedulerDiagnostics } from './lifecycle/scheduler.js';
import { hydrateConnectedChatContext, clearChatContextHydration } from './lifecycle/scene-hydrator.js';
import { clearSceneScannerState } from './scene/scanner.js';
import { ensureSceneAuthority } from './scene/runtime.js';
import { clearSceneChangeGate } from './retrieval/change-gate.js';
import { logEvent, clearTelemetry } from './observability/telemetry.js';
import { analyzeChatCompletionPromptReady, analyzeTextCompletionPromptReady, resetPromptLoaderTelemetryState } from './observability/prompt-loader-telemetry.js';
import { initActivityFeed } from './activity-feed.js';
import { mountNexusSettingsRoot, openNexusControlPanel, destroyNexusStandaloneShell } from './standalone-ui.js';
import { isBookEnabled, isTv2InjectionBook, canReadBook } from './lore/policy.js';
import { getStoryScopeStatus, isBookInCurrentStory } from './lore/active-books.js';
import { getTree } from './tree/store.js';
import { onStoryScopeChange } from './lore/story-scope.js';
import { markMainBridgeConnected, markMainLifecycleActive, markMainGatewayActive } from './nexus/main-bridge-status.js';
import { createSillyTavernGenerationAdapter } from './nexus/st-generation-adapter.js';
import { planSettledNexusLifecycle, resetNexusLifecycleBridge, finalizeNexusLifecycleAttempt, primeNexusLifecycleBridgeBaseline } from './nexus/lifecycle-bridge.js';
import { NEXUS_MIGRATED_WORKLOAD, shouldRunLegacyWorkload } from './nexus/director-migration.js';
import { invalidateNexusChatScope, beginNexusForegroundGeneration, endNexusForegroundGeneration, currentNexusChatEpoch, captureNexusWorkScope, isNexusWorkScopeFresh } from './nexus/work-scope.js';
import { markMessageRevisionDirty } from './nexus/message-settle-barrier.js';
import { invalidateNexusTransactionsForChat, invalidateNexusTransactionsForReviewScope, inspectNexusCommitRecovery, partitionNexusCommitRecoveryForChat, reconcileKnownAppliedNexusCommitRecoveryDurable as reconcileKnownAppliedNexusCommitRecovery, reconcileProvableNexusCommitRecovery, reconcilePendingNexusRecoveryProjections } from './nexus/transaction-service.js';
import { initializeNexusCommitJournalDurability, getNexusCommitJournalStatus } from './nexus/commit-journal.js';
import { restoreOperatorReviewTransactionsForStartup, clearActiveNexusToolGateway } from './nexus/tool-gateway.js';
import { configureOperatorReviewScopeProvider, currentOperatorReviewScope } from './nexus/review-scope.js';
import { invalidateOperatorReviewScope, compactAllOperatorReviewStoragePressure } from './nexus/operator-review-store.js';
import { cancelPendingNexusBatchWork, clearNexusBatchDiagnostics } from './nexus/batch-layer.js';
import { cancelNexusSidecarBusWork } from './sidecar/bus.js';
import { reconcileImportRecoveryOnStartup } from './migration.js';
import { bumpNexusLoreSourceRevision } from './nexus/lore-source-revision.js';
import { invalidateSearchIndex } from './retrieval/search-index-cache.js';
import { beginGenerationFrame, sealAndApplyGenerationFrame, retireGenerationFrame, resetGenerationFrameAuthority, getGenerationFrameSnapshot, getGenerationFrameDiagnostics } from './nexus/generation-frame.js';
import { settleGenerationFrameSubsystemOutlets } from './nexus/generation-frame-outlets.js';
import { awaitForegroundProgress } from './nexus/foreground-progress-watchdog.js';
import { installMainContextGovernor, resetMainContextGovernor } from './nexus/main-context-governor.js';


installMainContextGovernor();

let pendingNativeWorldInfoSuppression=null;
let activeChatId=null;
let activeForegroundGenerationId=null;
let activeOperatorReviewScope=null;
let runtimeRef=null;
let foregroundInvocationSeq=0;
const foregroundRecords=[];
const hostGenerationObjectIds=new WeakMap();
const pendingTerminalGenerationIds=[];
let foregroundFinalizeTimer=null;
let automaticLifecycleScope=null;
let initialized=false;

function invalidateRevisionBoundNexusWork(reason='message-revision-invalidated',eventName='MESSAGE_REVISION',argsCount=0){
    cancelScheduledAutomaticLifecycle();
    runtimeRef?.generationGateway?.abortActive?.(reason,{cancelPhysical:true});
    markMessageRevisionDirty(reason);
    const chatId=getContext()?.chatId??activeChatId??null;
    const priorEpoch=currentNexusChatEpoch();
    invalidateNexusChatScope(reason);
    resetMainContextGovernor(reason);
    invalidateLifecycleScheduler(reason);
    resetNexusLifecycleBridge(reason);
    cancelPendingNexusBatchWork({chatId,epoch:priorEpoch,reason:`${reason}: stale revision-bound Nexus batch work cancelled.`});
    cancelNexusSidecarBusWork({chatId,epoch:priorEpoch,reason:`${reason}: stale revision-bound Sidecar work cancelled.`});
    if(chatId!=null)invalidateNexusTransactionsForChat(chatId,`${reason}: source revision changed.`);
    // Message revisions revoke prompt-suppression authority as well as semantic
    // retrieval reuse. A pending native-WI transaction must never survive an
    // edit/swipe/delete and later commit against a different scene revision.
    rollbackPendingNativeWorldInfo(reason);
    clearBootstrapAdmission({force:true});
    clearRetrieval();
    clearChatContextHydration(reason);
    clearSceneScannerState(reason);
    clearSceneChangeGate(reason);
    clearMemoryRecall();
    clearNotebookPrompt();
    resetGenerationFrameAuthority(reason,{clearComparison:false});
    invalidateSmartContext(reason);
    resetCharacterBankReconciliation();
    logEvent('lifecycle','message-revision-invalidated',{eventName,reason,argsCount,chatId,priorEpoch,nextEpoch:currentNexusChatEpoch(),physicalCancellation:true},'info');
}

function validLoadedSourceMessages(){
    return (getContext()?.chat||[]).filter(message=>!message?.is_system&&String(message?.mes||'').trim());
}

function pendingSuppressionForGeneration(generationId=null){
    const transaction=pendingNativeWorldInfoSuppression;
    if(!transaction)return null;
    // Generation-keyed settlement never adopts an ownerless transaction. A
    // pre-generation transaction is stamped explicitly at GENERATION_STARTED;
    // a late WORLDINFO event is stamped immediately by its creation path.
    if(generationId!=null&&(transaction.nexusGenerationId==null||String(transaction.nexusGenerationId)!==String(generationId)))return null;
    return transaction;
}

function rollbackPendingNativeWorldInfo(reason='nexus-replacement-unavailable',generationId=null){
    const transaction=pendingSuppressionForGeneration(generationId);
    if(!transaction)return null;
    if(!transaction||transaction.state!=='pending'){pendingNativeWorldInfoSuppression=null;return transaction;}
    // Keep the authority handle until physical restoration completes. If an
    // exotic host array throws during rollback, a later retry still owns it.
    rollbackNativeWorldInfoSuppression(transaction,reason);
    pendingNativeWorldInfoSuppression=null;
    logEvent('retrieval','native-worldinfo-restored',{
        restored:transaction.removedCount||0,
        reason,
        policy:'transactional-nexus-replacement',
    },'warn');
    return transaction;
}

function commitPendingNativeWorldInfo(reason='validated-nexus-replacement',generationId=null){
    const transaction=pendingSuppressionForGeneration(generationId);
    if(!transaction)return null;
    if(!transaction||transaction.state!=='pending'){pendingNativeWorldInfoSuppression=null;return transaction;}
    const removed=transaction.removedCount||0;
    commitNativeWorldInfoSuppression(transaction,reason);
    pendingNativeWorldInfoSuppression=null;
    logEvent('retrieval','native-worldinfo-suppression-committed',{removed,reason,policy:'transactional-nexus-replacement'},'debug');
    return transaction;
}

function currentGenerationRetrievalReplacementReady(generationId=activeForegroundGenerationId){
    if(generationId==null)return true;
    const frame=getGenerationFrameSnapshot();
    if(String(frame?.generationId||'')!==String(generationId||''))return false;
    // Native World Info is loaded by SillyTavern late in prompt assembly. By
    // then Nexus may already have sealed/applied the Generation Frame. A READY
    // retrieval-lore outlet remains a valid exact replacement after sealing;
    // requiring the frame to still be OPEN causes the host to retain the full
    // native lorebook alongside Nexus selected lore.
    return ['open','sealed','applied'].includes(String(frame?.state||''))
        && String(frame?.outlets?.['retrieval-lore']?.status||'')==='ready';
}

function nativeWorldInfoRowCount(data){
    return ['globalLore','characterLore','chatLore','personaLore'].reduce((total,key)=>total+(Array.isArray(data?.[key])?data[key].length:0),0);
}

function suppressNativeWorldInfoForTv2(data){
    const settings=getSettings();
    const loadedRows=nativeWorldInfoRowCount(data);
    const previewLike=activeForegroundGenerationId==null;
    if(!data){
        logEvent('retrieval','native-worldinfo-suppression-skipped',{reason:'missing-worldinfo-payload',loadedRows,mode:previewLike?'preview-or-dry-run':'foreground',generationId:activeForegroundGenerationId},'debug');
        return;
    }
    if(!settings.enabled||settings.retrieval?.enabled!==true){
        logEvent('retrieval','native-worldinfo-suppression-skipped',{reason:settings.enabled!==true?'nexus-disabled':'retrieval-disabled',loadedRows,mode:previewLike?'preview-or-dry-run':'foreground',generationId:activeForegroundGenerationId},'debug');
        return;
    }
    const currentRecord=foregroundRecords.at(-1)||null;
    if(currentRecord?.nexusPrompt===false){
        logEvent('retrieval','native-worldinfo-suppression-skipped',{reason:'current-foreground-does-not-own-nexus-prompt',loadedRows,mode:previewLike?'preview-or-dry-run':'foreground',generationId:activeForegroundGenerationId,foregroundCount:foregroundRecords.length},'debug');
        return;
    }
    if(pendingNativeWorldInfoSuppression?.state==='pending'){
        if(String(pendingNativeWorldInfoSuppression.nexusGenerationId||'')===String(activeForegroundGenerationId||'')){
            logEvent('retrieval','native-worldinfo-reentrant-retained',{generationId:activeForegroundGenerationId,reason:'suppression-already-pending'},'debug');
            return;
        }
        logEvent('retrieval','native-worldinfo-overlap-retained',{generationId:activeForegroundGenerationId,pendingGenerationId:pendingNativeWorldInfoSuppression.nexusGenerationId||null},'warn');
        return;
    }
    const storyScope=getStoryScopeStatus();
    const ambiguous=storyScope.mode==='ambiguous-requires-scope';
    // Story isolation is a stronger boundary than replacement readiness. A
    // Nexus-managed lorebook outside the current story is forbidden context and
    // is removed from this prompt even on a cold start. It is never rolled back.
    const forbidden=removeNativeWorldInfoEntries(data,(entry)=>{
        const book=String(entry?.world||'').trim();
        if(!book||!isBookEnabled(book))return false;
        // C11-180: Story Scope membership does not itself grant current read
        // authority. Write-only/authority-not-ready books must not be read or
        // transactionally suppressed by Nexus.
        if(!canReadBook(book))return false;
        if(ambiguous)return true;
        return !isBookInCurrentStory(book,{access:'read'});
    });
    if(forbidden.removedCount)logEvent('story-scope','native-worldinfo-out-of-story-suppressed',{removed:forbidden.removedCount,groups:forbidden.groups,mode:storyScope.mode,readBooks:storyScope.readBooks},'info');

    // HOTFIX46.31: Nexus-owned Tree books are prompt-authority sources, not
    // native SillyTavern prompt contributors. Suppress them as soon as ST loads
    // World Info so they cannot be serialized into the host prompt and then
    // collide with the later Nexus Generation Frame. This changes prompt
    // ownership only: Scene Scanner / Change Gate / Retrieval semantics still
    // read chat + Nexus Tree authority and are deliberately untouched.
    //
    // Fail-safe behavior remains transactional. Retrieval failure, timeout,
    // stop, chat revision, or authority invalidation rolls these rows back via
    // the existing pending-suppression transaction before Main is released.
    // Pre-Tree books retain the stricter exact-entry bootstrap admission rule.
    const bootstrapState=getBootstrapAdmissionState();
    const generationId=activeForegroundGenerationId;
    const currentRetrievalReady=currentGenerationRetrievalReplacementReady(generationId);
    const reusableReplacementReady=hasReusableInjection()&&currentRetrievalReady;
    const currentBootstrapReady=bootstrapState.selectedCount>0&&(generationId==null||String(bootstrapState.generationId||'')===String(generationId));
    let treeOwnershipReady=false;
    for(const key of ['globalLore','characterLore','chatLore','personaLore']){
        const rows=Array.isArray(data?.[key])?data[key]:[];
        if(rows.some(entry=>{
            const book=String(entry?.world||'').trim();
            return !!book&&isBookEnabled(book)&&canReadBook(book)&&isBookInCurrentStory(book,{access:'read'})&&isTv2InjectionBook(book)&&!!getTree(book);
        })){treeOwnershipReady=true;break;}
    }
    const suppressionAuthorized=(treeOwnershipReady&&reusableReplacementReady)||currentBootstrapReady;
    logEvent('retrieval','native-worldinfo-suppression-evaluated',{
        loadedRows,
        mode:previewLike?'preview-or-dry-run':'foreground',
        generationId:activeForegroundGenerationId,
        foregroundCount:foregroundRecords.length,
        treeOwnershipReady,
        reusableInjectionReady:hasReusableInjection(),
        currentRetrievalReady,
        reusableReplacementReady,
        currentBootstrapReady,
        suppressionAuthorized,
        frameState:getGenerationFrameSnapshot()?.state||null,
        retrievalOutletStatus:getGenerationFrameSnapshot()?.outlets?.['retrieval-lore']?.status||null,
    },'debug');
    const transaction=beginNativeWorldInfoSuppression({
        data,
        replacementReady:suppressionAuthorized,
        generationId:activeForegroundGenerationId,
        chatEpoch:currentNexusChatEpoch(),
        invocationId:currentRecord?.hostKey||activeForegroundGenerationId,
        shouldSuppress:(entry)=>{
            const book=String(entry?.world||'').trim();
            if(!book||!isBookEnabled(book)||!canReadBook(book)||!isBookInCurrentStory(book,{access:'read'})||!isTv2InjectionBook(book))return false;
            const treeOwned=!!getTree(book)&&currentRetrievalReady;
            const hasBootstrapReplacement=!treeOwned&&hasBootstrapAdmissionForBook(book,{generationId})&&hasBootstrapAdmissionForEntry(book,entry?.uid,{generationId});
            return treeOwned||hasBootstrapReplacement;
        },
    });
    if(transaction.state==='pending'){
        transaction.nexusGenerationId=activeForegroundGenerationId==null?null:String(activeForegroundGenerationId);
        pendingNativeWorldInfoSuppression=transaction;
        logEvent('retrieval','native-worldinfo-suppressed',{removed:transaction.removedCount,policy:'transactional-nexus-ownership',suppressionBasis:treeOwnershipReady?'tree-ownership':'bootstrap-admission',replacementReady:reusableReplacementReady||currentBootstrapReady,storyScoped:true},'debug');
    }else{
        logEvent('retrieval','native-worldinfo-retained',{reason:suppressionAuthorized?'no-tv2-worldinfo-entries':'no-nexus-owned-worldinfo',policy:'transactional-nexus-ownership',suppressionAuthorized,replacementReady:reusableReplacementReady||currentBootstrapReady,storyScoped:true},'debug');
    }
}

function invalidatePendingWorldInfoAuthority(reason='worldinfo-authority-changed'){
    const tx=rollbackPendingNativeWorldInfo(reason);
    clearBootstrapAdmission({force:true});
    clearRetrieval();
    invalidateSmartContext(reason);
    return tx;
}

function settleNativeWorldInfoForRetrieval(result,error=null,generationId=null){
    const transaction=pendingSuppressionForGeneration(generationId);
    if(!transaction)return;
    const live=getSettings();
    // C11-179: generation-end settlement must honor live global/retrieval
    // authority. A pending suppression created before disable can never commit.
    if(live?.enabled!==true||live?.retrieval?.enabled!==true){
        rollbackPendingNativeWorldInfo('retrieval-disabled-before-native-worldinfo-commit',generationId);
        return;
    }
    const refs=Array.isArray(result?.refs)?result.refs:[];
    const validReplacement=!error
        && result?.reason!=='no-chat-context'
        && result?.noInjection!==true
        && refs.length>0;
    if(!validReplacement){
        rollbackPendingNativeWorldInfo(error?'retrieval-failed':(result?.reason||'no-valid-nexus-replacement'),generationId);
        return;
    }

    // C11-170: successful Retrieval only authorizes suppression for lorebooks it
    // actually replaced. Pre-Tree rows may also remain suppressed when the exact
    // bootstrap entry is still admitted for this generation. Restore every other
    // pending row before committing the covered remainder.
    const coveredBooks=new Set(refs.map(ref=>String(ref?.book||'')).filter(Boolean));
    narrowNativeWorldInfoSuppression(transaction,(entry)=>{
        const book=String(entry?.world||'').trim();
        if(!book||!isBookEnabled(book)||!canReadBook(book)||!isBookInCurrentStory(book,{access:'read'})||!isTv2InjectionBook(book))return false;
        if(coveredBooks.has(book))return true;
        return hasBootstrapAdmissionForEntry(book,entry?.uid,{generationId});
    },'partial-retrieval-coverage');
    if(transaction.state!=='pending'){
        pendingNativeWorldInfoSuppression=null;
        logEvent('retrieval','native-worldinfo-restored',{restored:'all-uncovered',reason:'partial-retrieval-coverage',policy:'transactional-nexus-replacement'},'warn');
        return;
    }
    commitPendingNativeWorldInfo(result?.degraded===true?'validated-degraded-survivor':'validated-nexus-replacement',generationId);
}

function detectFolder(){try{const u=new URL(import.meta.url);const marker='/scripts/extensions/';const i=u.pathname.indexOf(marker);if(i>=0){const rel=decodeURIComponent(u.pathname.slice(i+marker.length));return rel.slice(0,rel.lastIndexOf('/'));}}catch{}return'third-party/Nexus';}
const EXTENSION_FOLDER=detectFolder();
let initializationState='idle';
let initializationPromise=null;
const initializationDisposers=[];
let foregroundActive=false;
let automaticLifecycleTimer=null;
const pendingAutomaticLifecycleSources=new Set();
let lastObservedMainRequestModel=null;
let lastObservedMainRequestProvider=null;
let pendingChatPromptTelemetry=null;
let pendingChatPromptTelemetryTimer=null;

function registerInitializationDisposer(disposer){
    if(typeof disposer==='function')initializationDisposers.push(disposer);
    return disposer;
}

function promptLoaderTelemetryMeta(){
    const context=getContext();
    return {
        generationId:activeForegroundGenerationId,
        chatId:context?.chatId??activeChatId??null,
        chatEpoch:currentNexusChatEpoch(),
        nexusFrame:getGenerationFrameDiagnostics(),
        model:lastObservedMainRequestModel,
        provider:lastObservedMainRequestProvider,
    };
}

function recordPromptLoaderTelemetry(surface,eventData,metaOverride=null){
    try{
        const meta=metaOverride&&typeof metaOverride==='object'?metaOverride:promptLoaderTelemetryMeta();
        const payload=surface==='chat-completion'
            ?analyzeChatCompletionPromptReady(eventData,meta)
            :analyzeTextCompletionPromptReady(eventData,meta);
        logEvent('prompt-loader',`${surface}-ready`,payload,'info');
    }catch(error){
        logEvent('prompt-loader','telemetry-failed',{surface,generationId:activeForegroundGenerationId,error:error?.message||String(error)},'warn');
    }
}

function clonePromptTelemetryEvent(eventData={}){
    try{return typeof structuredClone==='function'?structuredClone(eventData):JSON.parse(JSON.stringify(eventData));}
    catch{return eventData;}
}

function clearPendingChatPromptTelemetry(){
    if(pendingChatPromptTelemetryTimer!==null){clearTimeout(pendingChatPromptTelemetryTimer);pendingChatPromptTelemetryTimer=null;}
    pendingChatPromptTelemetry=null;
}

function flushPendingChatPromptTelemetry(reason='settings-ready'){
    const pending=pendingChatPromptTelemetry;
    if(!pending)return false;
    clearPendingChatPromptTelemetry();
    const meta={...pending.meta,model:lastObservedMainRequestModel||pending.meta?.model||null,provider:lastObservedMainRequestProvider||pending.meta?.provider||null};
    recordPromptLoaderTelemetry('chat-completion',pending.eventData,meta);
    logEvent('prompt-loader','chat-completion-telemetry-flushed',{generationId:meta.generationId,model:meta.model||null,provider:meta.provider||null,reason},'debug');
    return true;
}

function queueChatPromptLoaderTelemetry(eventData={}){
    if(eventData?.dryRun===true){recordPromptLoaderTelemetry('chat-completion',eventData);return;}
    clearPendingChatPromptTelemetry();
    pendingChatPromptTelemetry={eventData:clonePromptTelemetryEvent(eventData),meta:promptLoaderTelemetryMeta(),queuedAt:Date.now()};
    // SillyTavern currently emits CHAT_COMPLETION_SETTINGS_READY shortly after
    // PROMPT_READY.  Wait for that exact-generation model/provider metadata so
    // Main token accounting does not fall back to a generic tokenizer hint.
    pendingChatPromptTelemetryTimer=setTimeout(()=>flushPendingChatPromptTelemetry('settings-timeout-fallback'),1000);
}

function recordMainRequestSettingsTelemetry(eventData={}){
    try{
        if(typeof eventData?.model==='string'&&eventData.model.trim())lastObservedMainRequestModel=eventData.model.trim();
        const observedProvider=eventData?.chat_completion_source??eventData?.chatCompletionSource??null;
        if(observedProvider!=null&&String(observedProvider).trim())lastObservedMainRequestProvider=String(observedProvider).trim();
        const reasoning=eventData?.reasoning&&typeof eventData.reasoning==='object'?eventData.reasoning:{};
        const thinking=eventData?.thinking&&typeof eventData.thinking==='object'?eventData.thinking:{};
        const outputCeiling=eventData?.max_output_tokens??eventData?.max_completion_tokens??eventData?.max_tokens??null;
        logEvent('main-request','settings-ready',{
            generationId:activeForegroundGenerationId,
            model:eventData?.model??null,
            provider:eventData?.chat_completion_source??eventData?.chatCompletionSource??null,
            messageCount:Array.isArray(eventData?.messages)?eventData.messages.length:null,
            outputCeiling:Number.isFinite(Number(outputCeiling))?Number(outputCeiling):null,
            includeReasoning:eventData?.include_reasoning??eventData?.includeReasoning??null,
            reasoningEffort:eventData?.reasoning_effort??reasoning?.effort??null,
            thinkingType:thinking?.type??null,
            stream:eventData?.stream===true,
        },'info');
        flushPendingChatPromptTelemetry('settings-ready');
    }catch(error){logEvent('main-request','settings-telemetry-failed',{error:error?.message||String(error)},'warn');}
}

function subscribeLifecycleEvent(eventType,handler){
    if(!eventType||typeof handler!=='function')return null;
    const remove = typeof eventSource?.off === 'function'
        ? () => eventSource.off(eventType,handler)
        : (typeof eventSource?.removeListener === 'function'
            ? () => eventSource.removeListener(eventType,handler)
            : (typeof eventSource?.removeEventListener === 'function' ? () => eventSource.removeEventListener(eventType,handler) : null));
    if(!remove){const error=new Error('SillyTavern event source does not expose a removable lifecycle-listener contract.');error.name='TV2LifecycleTeardownUnavailable';throw error;}
    eventSource.on(eventType,handler);
    return registerInitializationDisposer(()=>{try{remove();}catch(error){logEvent('runtime','lifecycle-listener-remove-failed',{eventType,error},'error');}});
}

async function reconcileHydratedChatAuthority(expectedChatId,source='chat-change'){
    const live=()=>getContext();
    if(String(live()?.chatId??'')!==String(expectedChatId??''))return {skipped:true,reason:'chat-changed-again'};
    const results={source,chatId:expectedChatId};
    try{results.importRecovery=await reconcileImportRecoveryOnStartup();}catch(error){results.importRecovery={failed:true,error:error?.message||String(error)};logEvent('migration','chat-recovery-import-failed',{source,chatId:expectedChatId,error},'error');}
    if(String(live()?.chatId??'')!==String(expectedChatId??''))return {...results,skipped:true,reason:'chat-changed-again'};
    try{await reconcileDurableCommitRecoveryOnStartup();results.durableRecovery=true;}catch(error){results.durableRecovery=false;results.durableRecoveryError=error?.message||String(error);logEvent('transaction','chat-recovery-durable-failed',{source,chatId:expectedChatId,error},'error');}
    if(String(live()?.chatId??'')!==String(expectedChatId??''))return {...results,skipped:true,reason:'chat-changed-again'};
    try{results.postTurnParents=await reconcilePostTurnParentSagas(live());}catch(error){results.postTurnParents=[{state:'recovery-required',error:error?.message||String(error)}];logEvent('postturn','chat-recovery-parent-saga-failed',{source,chatId:expectedChatId,error},'error');}
    logEvent('runtime','chat-durable-reconciliation-complete',{source,chatId:expectedChatId,importRecoveryStatus:results.importRecovery?.status||null,postTurnParentCount:results.postTurnParents?.length||0},'info');
    return results;
}

async function rollbackInitialization(reason='initialization-failed'){
    clearPendingChatPromptTelemetry();
    cancelScheduledAutomaticLifecycle();
    rollbackPendingNativeWorldInfo(reason);
    const priorGenerationId=activeForegroundGenerationId;activeForegroundGenerationId=null;
    try{endNexusForegroundGeneration(priorGenerationId);}catch{}
    foregroundActive=false;
    resetPromptLoaderTelemetryState();
    resetMainContextGovernor(reason);
    try{markMainLifecycleActive(false,reason,'foreground-main');}catch{}
    for(const dispose of initializationDisposers.splice(0).reverse()){try{await dispose();}catch(error){logEvent('runtime','initialization-disposer-failed',{reason,error},'error');}}
    try{resetGenerationFrameAuthority(reason,{clearComparison:true});}catch{}
    try{clearActiveNexusToolGateway();}catch{}
    try{unregisterTools({throwOnFailure:false});}catch{}
    try{teardownRuntime(reason);}catch(error){logEvent('runtime','runtime-teardown-failed',{reason,error},'error');}
    try{markMainBridgeConnected(false,reason);}catch{}
    activeOperatorReviewScope=null;
    activeChatId=null;
    initialized=false;
}

function scheduleAutomaticLifecycle(source){
    pendingAutomaticLifecycleSources.add(String(source||'lifecycle'));
    if(automaticLifecycleTimer!==null)return false;
    automaticLifecycleScope=captureNexusWorkScope(getContext());
    // Release the SillyTavern terminal handler and allow render/save work to
    // settle before background planning. The immutable scope prevents this
    // zero-delay trigger from rebinding after chat/edit/swipe invalidation.
    automaticLifecycleTimer=setTimeout(()=>{
        automaticLifecycleTimer=null;
        const scope=automaticLifecycleScope;automaticLifecycleScope=null;
        const sources=[...pendingAutomaticLifecycleSources];pendingAutomaticLifecycleSources.clear();
        if(!scope||!isNexusWorkScopeFresh(scope,getContext(),{checkRevision:true})){
            logEvent('scheduler-cycle','automatic-trigger-stale',{sources,scope},'debug');
            return;
        }
        const selected=sources.includes('generation-end')?'generation-end':(sources.at(-1)||'lifecycle');
        if(foregroundActive){
            logEvent('scheduler-cycle','automatic-deferred-foreground-active',{source:selected,sources,reason:'foreground-active'},'debug');
            return;
        }
        runAutomaticLifecycle(selected).catch(error=>logEvent('scheduler-cycle','automatic-dispatch-failed',{source:selected,sources,error},'error'));
    },0);
    return true;
}

function cancelScheduledAutomaticLifecycle(){
    if(automaticLifecycleTimer!==null)clearTimeout(automaticLifecycleTimer);
    automaticLifecycleTimer=null;automaticLifecycleScope=null;pendingAutomaticLifecycleSources.clear();
}

async function runAutomaticLifecycle(source){
    const loadedMessages=validLoadedSourceMessages();
    if(!loadedMessages.length){
        logEvent('scheduler-cycle','automatic-deferred-no-chat-context',{source,degraded:true,reason:'no-chat-context',deferredWorkloads:['notebook','summary','post-turn','lore-mutations']},'warn');
        return {skipped:true,deferred:true,degraded:true,reason:'no-chat-context'};
    }
    // Advance scene observation/classification at the runtime boundary before
    // Work Director reads the scene. This keeps Director a consumer and gives
    // Smart Context/Character Banks the same accepted snapshot for this turn.
    try {
        await ensureSceneAuthority({ context:getContext(), source:`lifecycle:${source}` });
    } catch (error) {
        logEvent('scene-scanner','lifecycle-authority-refresh-failed',{source,error:error?.message||String(error)},'warn');
    }
    const admissionSettings=getSettings();
    if(admissionSettings.scheduler?.enabled===false||admissionSettings.scheduler?.automatic===false){
        // Automatic-disabled is an execution authority boundary: do not even
        // start Director/migrated work after the user disables automatic work.
        logEvent('scheduler-cycle','automatic-skipped',{source,reason:'automatic-disabled'},'debug');
        return {skipped:true,reason:'automatic-disabled'};
    }
    const director=await (async()=>{try{return await planSettledNexusLifecycle({source});}catch(error){logEvent('nexus-director','shadow-plan-failed',{source,error},'error');return {failed:true,error};}})();
    // Configuration is authority. Re-read it after settlement/Director work so a
    // mode/task toggle made while planning cannot be overwritten by an old snapshot.
    const s=getSettings();
    if(s.scheduler?.enabled===false||s.scheduler?.automatic===false){
        logEvent('scheduler-cycle','automatic-skipped',{source,reason:'automatic-disabled-after-plan'},'debug');
        finalizeNexusLifecycleAttempt(director,{legacyTypes:[],legacySucceeded:true});
        return {skipped:true,reason:'automatic-disabled',director};
    }
    const includeSmartWarm=shouldRunLegacyWorkload(director,NEXUS_MIGRATED_WORKLOAD.SMART_WARM);
    const includePostTurn=shouldRunLegacyWorkload(director,NEXUS_MIGRATED_WORKLOAD.POST_TURN_EXTRACT);
    const includeSummary=shouldRunLegacyWorkload(director,NEXUS_MIGRATED_WORKLOAD.SUMMARY);
    const includePromotion=shouldRunLegacyWorkload(director,NEXUS_MIGRATED_WORKLOAD.SUMMARY_PROMOTION);
    const includeLoreRouting=shouldRunLegacyWorkload(director,NEXUS_MIGRATED_WORKLOAD.LORE_ROUTING);
    const includeHousekeeper=shouldRunLegacyWorkload(director,NEXUS_MIGRATED_WORKLOAD.MAINTENANCE);
    const currentNotebook=getSettings();
    const includeNotebook=source==='generation-end'&&currentNotebook.notebook?.enabled!==false&&currentNotebook.notebook?.automatic!==false&&shouldRunLegacyWorkload(director,NEXUS_MIGRATED_WORKLOAD.NOTEBOOK_REFRESH);
    const cycleRequested=includeSmartWarm||includePostTurn||includeNotebook||includeSummary||includePromotion||includeLoreRouting||includeHousekeeper;
    const legacyCycleTypes=[
        includeSmartWarm&&NEXUS_MIGRATED_WORKLOAD.SMART_WARM,
        includePostTurn&&NEXUS_MIGRATED_WORKLOAD.POST_TURN_EXTRACT,
        includeSummary&&NEXUS_MIGRATED_WORKLOAD.SUMMARY,
        includePromotion&&NEXUS_MIGRATED_WORKLOAD.SUMMARY_PROMOTION,
        includeLoreRouting&&NEXUS_MIGRATED_WORKLOAD.LORE_ROUTING,
        includeHousekeeper&&NEXUS_MIGRATED_WORKLOAD.MAINTENANCE,
        includeNotebook&&NEXUS_MIGRATED_WORKLOAD.NOTEBOOK_REFRESH,
    ].filter(Boolean);
    if(!cycleRequested){
        logEvent('scheduler-cycle','automatic-skipped',{source,reason:'director-authoritative-no-legacy-work'},'debug');
        finalizeNexusLifecycleAttempt(director,{legacyTypes:[],legacySucceeded:true});
        return {skipped:true,reason:'director-authoritative-no-legacy-work',director};
    }
    try{
        const result=cycleRequested?await runLifecycleCycle({source,manual:false,includeSmartWarm,includePostTurn,includeNotebook,includeSummary,includePromotion,includeLoreRouting,includeHousekeeper}):{skipped:true,reason:'no-legacy-cycle-work'};
        const cycleSucceeded=!cycleRequested||result?.status==='complete';
        finalizeNexusLifecycleAttempt(director,{legacyTypes:legacyCycleTypes,legacySucceeded:cycleSucceeded});
        return result;
    }catch(err){
        finalizeNexusLifecycleAttempt(director,{legacyTypes:legacyCycleTypes,legacySucceeded:false});
        logEvent('scheduler-cycle','automatic-cycle-error',{source,error:err},'error');
        return {failed:true,error:err};
    }
}



function foregroundGenerationAuthorityOpen(generationId){
    const frame=getGenerationFrameSnapshot();
    return String(activeForegroundGenerationId||'')===String(generationId||'')
        && String(frame?.generationId||'')===String(generationId||'')
        && String(frame?.state||'')==='open';
}

function settleRetrievalNativeWorldInfoIfOpen(result,error,generationId){
    if(!foregroundGenerationAuthorityOpen(generationId))return false;
    settleNativeWorldInfoForRetrieval(result,error,generationId);
    return true;
}

function generationFrameOutletReady(generationId,name){
    const frame=getGenerationFrameSnapshot();
    return String(frame?.generationId||'')===String(generationId||'')
        && String(frame?.state||'')==='open'
        && String(frame?.outlets?.[name]?.status||'')==='ready';
}

function foregroundGenerationWorkState(generationId){
    const queue=getJobQueue(getSettings().jobs);
    const rows=queue.snapshot().filter(job=>String(job?.generationId||'')===String(generationId||''));
    const running=rows.filter(job=>String(job?.state||'')==='running');
    const queued=rows.filter(job=>String(job?.state||'')==='queued');
    return {
        runningCount:running.length,
        queuedCount:queued.length,
        runningJobIds:running.map(job=>job.id),
        queuedJobIds:queued.map(job=>job.id),
    };
}

function foregroundProgressSnapshot(generationId,progressState=null){
    const frame=getGenerationFrameSnapshot();
    if(String(frame?.generationId||'')!==String(generationId||''))return {generationId:String(generationId||''),state:'retired',outlets:{}};
    const names=['scene','change-gate','memory-recall','bootstrap-lore','retrieval-lore'];
    const outlets={};
    for(const name of names)outlets[name]=String(frame?.outlets?.[name]?.status||'pending');
    const settledCount=Object.values(outlets).filter(status=>status==='ready'||status==='empty'||status==='failed').length;
    return {generationId:String(generationId||''),state:String(frame?.state||''),settledCount,totalCount:names.length,outlets,retrievalProgress:progressState?.retrieval||null,activeGenerationWork:foregroundGenerationWorkState(generationId)};
}

async function runForegroundMemoryUnsafe(generationId,progressState=null){
    const loadedMessages=validLoadedSourceMessages();
    logEvent('lifecycle','foreground-memory-start',{retrieval:true,memoryRecall:true,loadedMessages:loadedMessages.length},'debug');
    try{prepareNotebookPrompt({generationId});}catch(error){logEvent('notebook','foreground-prompt-failed',{error},'error');clearNotebookPrompt({generationId});}
    // C11-184: bootstrap lore I/O is independent foreground preparation. Start
    // Retrieval and Memory Recall immediately instead of serially awaiting it.
    const bootstrapWork=prepareBootstrapAdmission({generationId});
    let retrievalAuthoritySettledEarly=false;
    // Retrieval owns native-WI replacement authority.  Settle that authority
    // the moment retrieval itself finishes instead of waiting for unrelated
    // bootstrap/memory work in Promise.allSettled; otherwise a later deadline
    // can roll back a replacement that had already completed successfully.
    const retrievalWork=runRetrieval({generationId,onProgress:progress=>{ if(progressState)progressState.retrieval=progress; }}).then(value=>{
        if(settleRetrievalNativeWorldInfoIfOpen(value,null,generationId))retrievalAuthoritySettledEarly=true;
        return value;
    },error=>{
        if(settleRetrievalNativeWorldInfoIfOpen(null,error,generationId))retrievalAuthoritySettledEarly=true;
        throw error;
    });
    const memoryWork=prepareMemoryRecall({generationId});
    const work=[bootstrapWork,retrievalWork,memoryWork];
    const settled=await Promise.allSettled(work);
    if(!foregroundGenerationAuthorityOpen(generationId)){
        logEvent('lifecycle','foreground-memory-retired',{generationId,reason:'generation-authority-no-longer-open'},'debug');
        return {retired:true,reason:'generation-authority-no-longer-open'};
    }
    let bootstrapResult={skipped:true,reason:'not-run',refs:[]};
    if(settled[0].status==='fulfilled')bootstrapResult=settled[0].value;
    else{logEvent('retrieval','bootstrap-admission-failed',{error:settled[0].reason},'error');clearBootstrapAdmission({generationId,force:false});}
    if(settled[1].status==='rejected'){
        if(!retrievalAuthoritySettledEarly)settleNativeWorldInfoForRetrieval(null,settled[1].reason,generationId);
        logEvent('retrieval','foreground-retrieval-failed',{error:settled[1].reason},'error');
        console.warn('[Nexus] Retrieval failed; main generation continues without Nexus lore injection:',settled[1].reason?.message||settled[1].reason);clearRetrieval({clearState:false,generationId});
    }else{
        if(!retrievalAuthoritySettledEarly)settleNativeWorldInfoForRetrieval(settled[1].value,null,generationId);
        if(settled[1].value?.reason==='no-chat-context'){
            logEvent('retrieval','foreground-retrieval-degraded',{reason:'no-chat-context',mainContinues:true},'warn');
        }
    }
    if(settled[2].status==='rejected'){
        logEvent('memory-recall','foreground-recall-failed',{error:settled[2].reason},'error');
        console.warn('[Nexus] Summary Bank recall failed; main generation continues without historical-memory injection:',settled[2].reason?.message||settled[2].reason);clearMemoryRecall({generationId});
    }
    let frame=null;
    try{
        settleGenerationFrameSubsystemOutlets({generationId});
        frame=sealAndApplyGenerationFrame({generationId});
    }catch(error){
        logEvent('generation-frame','foreground-seal-failed',{generationId,error:error?.message||String(error),failClosed:true},'error');
        retireGenerationFrame({generationId,reason:'seal-failed',clearPrompt:true});
        frame={failed:true,error:error?.message||String(error)};
    }
    logEvent('lifecycle','foreground-memory-complete',{retrieval:settled[1].status,memoryRecall:settled[2].status,bootstrapAdmission:bootstrapResult?.reason||'none',bootstrapRefs:Array.isArray(bootstrapResult?.refs)?bootstrapResult.refs.length:0,generationFrameHash:frame?.promptHash||null,generationFrameFailed:frame?.failed===true},settled.some(row=>row.status==='rejected')||frame?.failed===true?'warn':'debug');
}

async function runForegroundMemory(generationId){
    const settings=getSettings();
    // HOTFIX46.3: foregroundPreflightTimeoutMs is a no-progress watchdog, not
    // a universal lifecycle completion deadline. Required current-prompt work
    // may continue while it is demonstrably making authority progress, bounded
    // by a separate absolute hard cap so a dead provider can never hang ST.
    const timeoutMs=Math.max(1000,Math.min(60000,Number(settings.nexus?.foregroundPreflightTimeoutMs)||15000));
    const hardCapMs=Math.max(timeoutMs,Math.min(300000,Number(settings.nexus?.foregroundPreflightHardCapMs)||60000));
    let timedOut=false;
    const progressState={retrieval:{ownerSubsystem:'retrieval',milestone:'PENDING',completedUnits:0,totalUnits:3,progressPct:0}};
    const work=runForegroundMemoryUnsafe(generationId,progressState);
    const outcome=await awaitForegroundProgress(work,{
        stallTimeoutMs:timeoutMs,
        hardTimeoutMs:hardCapMs,
        pollMs:100,
        getProgress:()=>foregroundProgressSnapshot(generationId,progressState),
        isActiveWork:()=>foregroundGenerationWorkState(generationId).runningCount>0,
        onProgress:({progressChanges,elapsedMs,progress})=>logEvent('lifecycle','foreground-preflight-progress',{generationId,progressChanges,elapsedMs,stallTimeoutMs:timeoutMs,hardCapMs,progress},'debug'),
    });
    timedOut=outcome?.timeout===true;
    if(outcome?.timeout){
        logEvent('lifecycle','foreground-memory-timeout',{generationId,timeoutMs,hardCapMs,timeoutKind:outcome.timeoutKind||'stall',elapsedMs:outcome.elapsedMs||null,progressChanges:outcome.progressChanges||0,activeDeferrals:outcome.activeDeferrals||0,degraded:true},'warn');
        const queue=getJobQueue(getSettings().jobs);
        const cancellationReason=Object.assign(new Error('Foreground preflight timed out; generation-scoped Nexus work cancelled.'),{name:'TV2ForegroundPreflightTimeout'});
        const queueCancelled=queue.cancelGenerationWork(cancellationReason,generationId);
        const batchCancelled=cancelPendingNexusBatchWork({generationId,reason:cancellationReason});
        const busCancelled=cancelNexusSidecarBusWork({generationId,reason:cancellationReason});
        logEvent('lifecycle','foreground-preflight-work-cancelled',{generationId,queueCancelled,batchCancelled,busCancelled},(queueCancelled||batchCancelled||busCancelled)?'warn':'debug');

        // HOTFIX44: the foreground deadline is a degradation boundary, not a
        // reason to throw away every already-settled Nexus outlet. Cancel only
        // unfinished semantic work, explicitly settle its generation outlets
        // EMPTY, retain native World Info, then seal the guarded Frame with the
        // context that is already authoritative (Notebook/Scene/etc.).
        const retrievalReady=generationFrameOutletReady(generationId,'retrieval-lore');
        const memoryReady=generationFrameOutletReady(generationId,'memory-recall');
        clearBootstrapAdmission({generationId,force:false});
        if(!retrievalReady){
            clearRetrieval({clearState:false,generationId});
        }
        if(!memoryReady)clearMemoryRecall({generationId});
        if(!retrievalReady)rollbackPendingNativeWorldInfo('foreground-preflight-timeout',generationId);
        let frame=null;
        if(foregroundGenerationAuthorityOpen(generationId)){
            try{
                settleGenerationFrameSubsystemOutlets({generationId});
                frame=sealAndApplyGenerationFrame({generationId});
                logEvent('lifecycle','foreground-preflight-degraded-applied',{generationId,timeoutMs,hardCapMs,timeoutKind:outcome.timeoutKind||'stall',queueCancelled,batchCancelled,busCancelled,preservedRetrievalReady:retrievalReady,preservedMemoryReady:memoryReady,generationFrameHash:frame?.promptHash||null,promptTokens:frame?.promptTokens||0,failedOutlets:frame?.failedOutlets||[]},'warn');
            }catch(error){
                logEvent('generation-frame','foreground-degraded-seal-failed',{generationId,error:error?.message||String(error),failClosed:true},'error');
                retireGenerationFrame({generationId,reason:'foreground-preflight-timeout-seal-failed',clearPrompt:true});
                frame={failed:true,error:error?.message||String(error)};
            }
        }else{
            retireGenerationFrame({generationId,reason:'foreground-preflight-timeout-authority-retired',clearPrompt:true});
        }
        void work.finally(()=>{
            // Once the deadline Frame is SEALED/APPLIED, late workers have no
            // publication authority. Only clear if this same Frame somehow
            // remains OPEN, which protects against an incomplete cancellation.
            if(timedOut&&foregroundGenerationAuthorityOpen(generationId)){clearBootstrapAdmission({generationId,force:false});clearRetrieval({clearState:false,generationId});clearMemoryRecall({generationId});}
        }).catch(()=>{});
        return {deferred:true,degraded:true,reason:'foreground-preflight-timeout',timeoutMs,hardCapMs,timeoutKind:outcome.timeoutKind||'stall',generationFrameHash:frame?.promptHash||null,generationFrameFailed:frame?.failed===true};
    }
    return {completed:true};
}

async function reconcileDurableCommitRecoveryOnStartup() {
    // HOTFIX46.20: free safely compactable review/audit bulk before commit
    // recovery needs to write settlement checkpoints. This scans every scoped
    // v3 Operator Review store, not only the currently active chat/books.
    try {
        const compacted = await compactAllOperatorReviewStoragePressure({ force: true });
        if (compacted.changed || compacted.failures?.length) logEvent('transaction','startup-storage-pressure-compacted',compacted,compacted.failures?.length?'warn':'info');
    } catch (error) { logEvent('transaction','startup-storage-pressure-compaction-failed',{error},'warn'); }
    let auto = [];
    try { auto = await reconcileKnownAppliedNexusCommitRecovery(); }
    catch (error) { logEvent('transaction', 'commit-recovery-auto-failed', { error }, 'error'); }
    if (auto.length) logEvent('transaction', 'commit-recovery-auto-reconciled', { count: auto.length, ids: auto.map(row => row.id) }, 'warn');
    try {
        const provable = await reconcileProvableNexusCommitRecovery({ context: getContext() });
        if (provable.reconciled.length) logEvent('transaction','commit-recovery-provable-auto-reconciled',{count:provable.reconciled.length,ids:provable.reconciled.map(row=>row.id),states:provable.reconciled.map(row=>row.state)},'warn');
        if (provable.skipped.length) logEvent('transaction','commit-recovery-provable-auto-skipped',{rows:provable.skipped},'warn');
    } catch (error) { logEvent('transaction','commit-recovery-provable-auto-failed',{error},'error'); }
    try { await reconcileProposalAuditFromCommitJournal(); } catch (error) { logEvent('proposals','startup-audit-reconcile-failed',{error},'error'); }
    try { const direct=await reconcileDirectWriteLedgerOnStartup(getContext()); if(direct?.changed)logEvent('lore','startup-direct-write-reconciled',direct,'warn'); } catch (error) { logEvent('lore','startup-direct-write-reconcile-failed',{error},'error'); }
    try { const projected=await reconcilePendingNexusRecoveryProjections(); if(projected.some(row=>!row.ok))logEvent('transaction','commit-recovery-dependent-projection-pending',{rows:projected.filter(row=>!row.ok)},'warn'); } catch(error){ logEvent('transaction','commit-recovery-dependent-projection-failed',{error},'error'); }
    try { await reconcileLoreRoutingSagasOnStartup(getContext()); } catch (error) { logEvent('memory','startup-lore-route-saga-reconcile-failed',{error},'error'); }
    let unresolved = [];
    try { unresolved = inspectNexusCommitRecovery(); }
    catch (error) { logEvent('transaction', 'commit-recovery-inspection-failed', { error }, 'error'); return; }
    const context = getContext();
    const scoped = partitionNexusCommitRecoveryForChat(unresolved, { chatId: context?.chatId ?? context?.chat_id ?? null });
    const current = scoped.current;
    if (scoped.deferred.length) {
        logEvent('transaction', 'commit-recovery-deferred-other-chat', {
            activeChatId: scoped.chatId,
            count: scoped.deferred.length,
            rows: scoped.deferred.map(row => ({ id: row.id, type: row.type, chatId: row.chatId, state: row.state, createdAt: row.createdAt })),
        }, 'info');
    }
    if (!current.length) return;
    logEvent('transaction', 'commit-recovery-pending', {
        count: current.length,
        rows: current.map(row => ({ id: row.id, type: row.type, chatId: row.chatId, state: row.state, createdAt: row.createdAt, error: row.error || '' })),
    }, 'warn');
    globalThis.toastr?.warning(
        `Nexus found ${current.length} interrupted durable commit${current.length === 1 ? '' : 's'} for the active recovery scope. Open Diagnostics → Commit recovery before retrying the affected mutation.`,
        'Nexus commit recovery',
        { timeOut: 0, extendedTimeOut: 0, closeButton: true },
    );
}

async function performInitialization(){
    configureOperatorReviewScopeProvider(() => {
        const context=getContext();
        const story=getStoryScopeStatus();
        return { chatId: context?.chatId ?? context?.chat_id ?? null, story: { mode: story?.mode || 'unknown', readBooks: story?.readBooks || [], writeBooks: story?.writeBooks || [] } };
    });
    if(initialized)return;
    try {
        const durability = await initializeNexusCommitJournalDurability();
        logEvent('transaction','commit-journal-durability-ready',{...durability,status:getNexusCommitJournalStatus()},'info');
    } catch (error) {
        // Keep the UI/runtime available for diagnostics, but mutation authority
        // remains fail-closed until the durability backend can initialize.
        logEvent('transaction','commit-journal-durability-init-failed',{error},'error');
    }
    const nexusRuntime=initRuntime();runtimeRef=nexusRuntime;
    resetGenerationFrameAuthority('initialization',{clearComparison:true});
    try{
        const mainAdapter=createSillyTavernGenerationAdapter({
            generateRaw,
            readChat:()=>getContext()?.chat||[],
            cancelGeneration:()=>getContext()?.stopGeneration?.(),
            onActivity:(active,event,source)=>markMainGatewayActive(active,event,source),
        });
        nexusRuntime?.connectGenerationGateway?.(mainAdapter,'st-generateRaw-adapter');
        logEvent('call-center','generation-gateway-connected',{adapter:'SillyTavern generateRaw'},'info');
    }catch(error){
        nexusRuntime?.disconnectGenerationGateway?.('st-generation-adapter-failed');
        logEvent('call-center','generation-gateway-connect-failed',{error},'error');
    }
    try{initActivityFeed();}catch(err){logEvent('ui','activity-feed-init-failed',{error:err},'error');}
    try{
        const importRecovery=await reconcileImportRecoveryOnStartup();
        if(importRecovery?.status==='deferred')logEvent('migration','tv2-import-recovery-deferred',{reason:'exact-target-chat-unavailable'},'warn');
    }catch(error){
        logEvent('migration','tv2-import-recovery-required',{error},'error');
    }
    // Restore durable Main Function Gateway review rows before canonical
    // recovery settles APPLIED/RECOVERY_REQUIRED journal authority. Otherwise a
    // later lazy gateway restore can resurrect an older STAGED snapshot.
    activeOperatorReviewScope=currentOperatorReviewScope();
    try {
        const reviewRestore = restoreOperatorReviewTransactionsForStartup();
        if (reviewRestore?.ids?.length) logEvent('call-center','operator-review-startup-restored',{count:reviewRestore.ids.length,ids:reviewRestore.ids,reconciled:reviewRestore.reconciled?.length||0},'warn');
    } catch (error) {
        // The normal Tool Gateway will remain fail-closed on corrupt/unavailable
        // review authority. Recovery diagnostics may still initialize.
        logEvent('call-center','operator-review-startup-restore-failed',{error},'error');
    }
    // Canonical recovery/audit authority settles before Proposal UI/tools become
    // operator-writable. Unrelated Nexus runtime initialization remains free to
    // proceed; this is a scoped Proposal readiness boundary, not a global lock.
    await reconcileDurableCommitRecoveryOnStartup();
    try{
        const rendered=await renderExtensionTemplateAsync(EXTENSION_FOLDER,'settings');
        const html=$(rendered);
        const root=html?.[0];
        if(!root||String(root?.outerHTML||root?.textContent||'').trim()===''){const error=new Error('Nexus settings template rendered no mountable root.');error.name='TV2SettingsTemplateEmpty';throw error;}
        const standaloneHost=mountNexusSettingsRoot(root);
        registerInitializationDisposer(()=>{try{destroyNexusStandaloneShell();}catch{}});
        if(!standaloneHost||!document.getElementById('tv2_settings')){const error=new Error('Nexus standalone settings root #tv2_settings was not attached.');error.name='TV2SettingsMountFailed';throw error;}
        const extensionTarget=document.getElementById('extensions_settings2');
        if(extensionTarget){
            const launcher=document.createElement('div');
            launcher.id='tv2_extensions_launcher';
            launcher.className='extension_container tv2-extension-launcher';
            launcher.innerHTML='<div><b>Nexus</b><span>Runs independently of the Extensions drawer.</span></div><button type="button" class="menu_button"><i class="fa-solid fa-up-right-from-square"></i> Open Nexus</button>';
            launcher.querySelector('button')?.addEventListener('click',openNexusControlPanel);
            extensionTarget.appendChild(launcher);
            registerInitializationDisposer(()=>launcher.remove());
        }
        bindUI();
        logEvent('ui','settings-mounted',{folder:EXTENSION_FOLDER,surface:'standalone'},'info');
    }catch(err){
        logEvent('ui','settings-mount-failed',{folder:EXTENSION_FOLDER,error:err},'error');
        console.error('[Nexus] Settings UI failed to load:',err);
        throw err;
    }
    registerTools();
    if(event_types.CHAT_COMPLETION_PROMPT_READY)subscribeLifecycleEvent(event_types.CHAT_COMPLETION_PROMPT_READY,(eventData)=>queueChatPromptLoaderTelemetry(eventData));
    if(event_types.CHAT_COMPLETION_SETTINGS_READY)subscribeLifecycleEvent(event_types.CHAT_COMPLETION_SETTINGS_READY,(eventData)=>recordMainRequestSettingsTelemetry(eventData));
    if(event_types.CHAT_COMPLETION_MODEL_CHANGED)subscribeLifecycleEvent(event_types.CHAT_COMPLETION_MODEL_CHANGED,(value)=>{if(typeof value==='string'&&value.trim())lastObservedMainRequestModel=value.trim();});
    if(event_types.CHATCOMPLETION_SOURCE_CHANGED)subscribeLifecycleEvent(event_types.CHATCOMPLETION_SOURCE_CHANGED,(value)=>{if(value!=null&&String(value).trim())lastObservedMainRequestProvider=String(value).trim();});
    if(event_types.GENERATE_AFTER_COMBINE_PROMPTS)subscribeLifecycleEvent(event_types.GENERATE_AFTER_COMBINE_PROMPTS,(eventData)=>recordPromptLoaderTelemetry('text-completion',eventData));
    if(event_types.WORLDINFO_ENTRIES_LOADED)subscribeLifecycleEvent(event_types.WORLDINFO_ENTRIES_LOADED,suppressNativeWorldInfoForTv2);
    for(const name of ['WORLDINFO_UPDATED','WORLDINFO_SETTINGS_UPDATED']){
        const eventType=event_types?.[name];
        if(eventType)subscribeLifecycleEvent(eventType,()=>invalidatePendingWorldInfoAuthority(name.toLowerCase()));
    }
    const authorityStatusHandler=event=>{if(String(event?.detail?.status||'')==='pending')invalidatePendingWorldInfoAuthority('nexus-authority-settings-pending');};
    globalThis.window?.addEventListener?.('nexus-authority-settings-status',authorityStatusHandler);
    registerInitializationDisposer(()=>globalThis.window?.removeEventListener?.('nexus-authority-settings-status',authorityStatusHandler));
    activeChatId=getContext()?.chatId??null;
    const generationAdmissionEvent=event_types.GENERATION_AFTER_COMMANDS||event_types.GENERATION_STARTED;
    if(event_types.GENERATION_STARTED&&event_types.GENERATION_STARTED!==generationAdmissionEvent)subscribeLifecycleEvent(event_types.GENERATION_STARTED,()=>{
        if(getSettings().enabled!==true)return;
        cancelScheduledAutomaticLifecycle();
        runtimeRef?.generationGateway?.abortActive?.('host-foreground-started',{cancelPhysical:true});
    });
    if(generationAdmissionEvent)subscribeLifecycleEvent(generationAdmissionEvent,async(type,_opts,dryRun)=>{
        activeChatId=getContext()?.chatId??activeChatId;
        logEvent('lifecycle','generation-admission',{event:generationAdmissionEvent===event_types.GENERATION_AFTER_COMMANDS?'after-commands':'started-fallback',type,dryRun:!!dryRun},'debug');
        cancelScheduledAutomaticLifecycle();
        if(dryRun)return;
        const admissionSettings=getSettings();
        if(admissionSettings.enabled!==true){rollbackPendingNativeWorldInfo('nexus-disabled');resetGenerationFrameAuthority('nexus-disabled',{clearComparison:false});logEvent('lifecycle','generation-source-deferred',{type,reason:'nexus-disabled'},'debug');return;}
        let hostKey=null;
        if(_opts&&typeof _opts==='object'){
            const explicit=_opts.generationId??_opts.requestId??_opts.request_id??null;
            if(explicit!=null)hostKey=`host:${String(explicit)}`;
            else { hostKey=hostGenerationObjectIds.get(_opts)||null; if(!hostKey){hostKey=`host-object:${++foregroundInvocationSeq}`;hostGenerationObjectIds.set(_opts,hostKey);} }
        }
        if(hostKey&&foregroundRecords.some(row=>row.hostKey===hostKey)){
            logEvent('lifecycle','generation-admission-duplicate',{hostKey,type},'debug');
            return;
        }
        const quiet=type==='quiet';
        if(!quiet){
            const activeNormal=foregroundRecords.find(row=>row?.quiet!==true);
            if(activeNormal){
                logEvent('lifecycle','generation-admission-coalesced-active-normal',{existingGenerationId:activeNormal.id,existingHostKey:activeNormal.hostKey||null,incomingHostKey:hostKey||null,type,reason:'single-physical-main-foreground-authority'},'warn');
                return;
            }
        }
        const generationId=`tv2_generation_${Date.now()}_${++foregroundInvocationSeq}`;
        beginGenerationFrame({generationId,chatId:getContext()?.chatId??activeChatId,chatEpoch:currentNexusChatEpoch()});
        const record={id:generationId,hostKey:hostKey||generationId,quiet,nexusPrompt:!quiet,startedAt:Date.now()};
        foregroundRecords.push(record);
        markMainLifecycleActive(true,quiet?'quiet-generation-started':'generation-started','foreground-main');
        if(quiet)markMainLifecycleActive(true,'generation-started-quiet','quiet-main');
        foregroundActive=true;
        const q=getJobQueue(getSettings().jobs);q.foregroundStarted(generationId);
        activeForegroundGenerationId=generationId;beginNexusForegroundGeneration(generationId);
        if(pendingNativeWorldInfoSuppression&&pendingNativeWorldInfoSuppression.state==='pending'&&pendingNativeWorldInfoSuppression.nexusGenerationId==null)pendingNativeWorldInfoSuppression.nexusGenerationId=generationId;
        if(!quiet)await runForegroundMemory(generationId);
    });
    if(event_types.MESSAGE_RECEIVED)subscribeLifecycleEvent(event_types.MESSAGE_RECEIVED,(messageIndex,type)=>{
        if(getSettings().enabled!==true){logEvent('lifecycle','message-source-deferred',{messageIndex:Number(messageIndex),type,reason:'nexus-disabled'},'debug');return;}
        const index=Number(messageIndex);
        const message=getContext()?.chat?.[index];
        const validSource=!!message&&!message?.is_system&&!!String(message?.mes||'').trim();
        logEvent('lifecycle','message-received',{messageIndex:index,type,foregroundActive,validSource},'debug');
        if(!validSource){logEvent('lifecycle','message-source-deferred',{messageIndex:index,type,reason:'no-chat-context'},'warn');return;}
        markMessageRevisionDirty('message-received');
        void markPostTurnPending(index).then(()=>{if(!foregroundActive)scheduleAutomaticLifecycle('message-received-after-end');}).catch(error=>logEvent('postturn','pending-mark-durability-failed',{messageIndex:index,error},'error'));
    });
    if(event_types.GENERATION_ENDED)subscribeLifecycleEvent(event_types.GENERATION_ENDED,(...args)=>{
        logEvent('lifecycle','generation-ended',{argsCount:args.length,activeForegroundCount:foregroundRecords.length},'debug');
        if(!foregroundRecords.length){logEvent('lifecycle','generation-ended-unowned',{argsCount:args.length},'warn');return;}
        // ST does not provide a request id on GENERATION_ENDED. Retire the oldest
        // physical start only; never let an ambiguous old END finalize the newest
        // authority while another foreground invocation remains active.
        const retired=foregroundRecords.shift();
        getJobQueue(getSettings().jobs).foregroundEnded(retired.id);
        if(foregroundRecords.length){
            foregroundActive=true;
            logEvent('lifecycle','generation-end-deferred-overlap',{retiredGenerationId:retired.id,authoritativeGenerationId:activeForegroundGenerationId,remaining:foregroundRecords.length},'warn');
            return;
        }
        foregroundActive=false;
        const completedGenerationId=activeForegroundGenerationId;
        if(completedGenerationId)pendingTerminalGenerationIds.push(completedGenerationId);
        if(foregroundFinalizeTimer!==null)clearTimeout(foregroundFinalizeTimer);
        foregroundFinalizeTimer=setTimeout(()=>{
            foregroundFinalizeTimer=null;
            if(foregroundRecords.length||String(activeForegroundGenerationId||'')!==String(completedGenerationId||''))return;
            const i=pendingTerminalGenerationIds.indexOf(completedGenerationId);if(i>=0)pendingTerminalGenerationIds.splice(i,1);
            commitPendingNativeWorldInfo('generation-complete',completedGenerationId);
            clearBootstrapAdmission({generationId:completedGenerationId,force:false});
            retireGenerationFrame({generationId:completedGenerationId,reason:'generation-complete',clearPrompt:true});
            endNexusForegroundGeneration(completedGenerationId);activeForegroundGenerationId=null;
            markMainLifecycleActive(false,'generation-ended','foreground-main');
            markMainLifecycleActive(false,'generation-ended','quiet-main');
            scheduleAutomaticLifecycle('generation-end');
        },0);
    });
    if(event_types.GENERATION_STOPPED)subscribeLifecycleEvent(event_types.GENERATION_STOPPED,()=>{
        const stoppedGenerationId=pendingTerminalGenerationIds.shift()||activeForegroundGenerationId;
        logEvent('lifecycle','generation-stopped',{stoppedGenerationId,authoritativeGenerationId:activeForegroundGenerationId},'warn');
        cancelScheduledAutomaticLifecycle();
        if(foregroundFinalizeTimer!==null){clearTimeout(foregroundFinalizeTimer);foregroundFinalizeTimer=null;}
        rollbackPendingNativeWorldInfo('generation-stopped',stoppedGenerationId);
        clearBootstrapAdmission({generationId:stoppedGenerationId,force:false});
        retireGenerationFrame({generationId:stoppedGenerationId,reason:'generation-stopped',clearPrompt:true});
        getJobQueue(getSettings().jobs).generationStopped('SillyTavern generation stopped.',stoppedGenerationId);
        // A STOP emitted after an older END must not terminate a newer start.
        if(stoppedGenerationId&&String(stoppedGenerationId)!==String(activeForegroundGenerationId||''))return;
        foregroundRecords.length=0;
        const current=activeForegroundGenerationId;activeForegroundGenerationId=null;endNexusForegroundGeneration(current);
        foregroundActive=false;markMainLifecycleActive(false,'generation-stopped','foreground-main');
        getJobQueue(getSettings().jobs).clearForegroundGenerations('SillyTavern generation stopped.');
    });
    for(const [eventName,reason] of [['MESSAGE_EDITED','message-edited'],['MESSAGE_SWIPED','message-swiped'],['MESSAGE_DELETED','message-deleted']]){
        const eventType=event_types?.[eventName];if(!eventType)continue;
        subscribeLifecycleEvent(eventType,(...args)=>invalidateRevisionBoundNexusWork(reason,eventName,args.length));
    }
    markMainBridgeConnected(!!eventSource?.on,'st-lifecycle-hooks');
    if(event_types.CHAT_CHANGED)subscribeLifecycleEvent(event_types.CHAT_CHANGED,()=>{
        cancelScheduledAutomaticLifecycle();
        if(foregroundFinalizeTimer!==null){clearTimeout(foregroundFinalizeTimer);foregroundFinalizeTimer=null;}
        runtimeRef?.generationGateway?.abortActive?.('chat-changed',{cancelPhysical:true});
        const previousChatId=activeChatId;
        const previousReviewScope=activeOperatorReviewScope;
        const nextChatId=getContext()?.chatId??null;
        activeChatId=nextChatId;
        const priorGenerationId=activeForegroundGenerationId;activeForegroundGenerationId=null;endNexusForegroundGeneration(priorGenerationId);
        foregroundRecords.length=0;pendingTerminalGenerationIds.length=0;
        getJobQueue(getSettings().jobs).clearForegroundGenerations('Chat changed during foreground generation.');
        foregroundActive=false;markMainLifecycleActive(false,'chat-changed','foreground-main');markMainLifecycleActive(false,'chat-changed','quiet-main');
        markMessageRevisionDirty('chat-changed');
        // Advance chat authority before cancellation so any late Sidecar settlement
        // still stamped with the old epoch is rejected by telemetry.
        invalidateNexusChatScope('chat-changed');
        // Activity Feed + Diagnostics are active-chat surfaces. Reset their
        // session telemetry at the boundary so old-chat events, Sidecar totals,
        // and last-result state cannot bleed into the newly selected chat.
        clearTelemetry();
        resetPromptLoaderTelemetryState();
        resetMainContextGovernor('chat-changed');
        logEvent('lifecycle','chat-changed',{previousChatId,nextChatId,telemetryReset:true},'info');
        rollbackPendingNativeWorldInfo('chat-changed');
        invalidateLifecycleScheduler('chat-changed');
        clearLifecycleSchedulerDiagnostics();
        cancelPendingNexusBatchWork({chatId:previousChatId,reason:'Chat changed before Nexus batch dispatch.'});
        cancelNexusSidecarBusWork({chatId:previousChatId,reason:'Chat changed while Nexus Sidecar Bus work was active.'});
        clearNexusBatchDiagnostics();
        if(previousChatId!=null)invalidateNexusTransactionsForChat(previousChatId,'Chat changed.');
        // Durable review invalidation dominates any older STAGED/pending snapshot.
        // The old scoped gateway is closed immediately; a new chat receives a
        // separately keyed review store and cannot act on old-chat authority.
        clearActiveNexusToolGateway();
        if(previousReviewScope?.chatId){ void invalidateOperatorReviewScope(previousReviewScope,{reason:'Chat changed.',storage:globalThis.localStorage,lockManager:globalThis.navigator?.locks||null}).catch(error=>logEvent('call-center','operator-review-scope-invalidation-failed',{error,scope:previousReviewScope},'error')); }
        activeOperatorReviewScope=currentOperatorReviewScope();
        clearRetrieval();
        clearChatContextHydration('chat-changed');
        clearSceneScannerState('chat-changed');
        clearSceneChangeGate('chat-changed');
        clearBootstrapAdmission({force:true});
        clearMemoryRecall();
        clearNotebookPrompt();
        resetGenerationFrameAuthority('chat-changed',{clearComparison:true});
        invalidateSmartContext('chat-changed');
        resetCharacterBankReconciliation();
        resetMemoryBankUiState();
        resetNexusLifecycleBridge('chat-changed');
        // CHAT_CHANGED may fire before every chat-bound metadata consumer has
        // observed the newly hydrated object. Re-enter recovery on the next task
        // and fence it to the exact new chat identity.
        setTimeout(()=>{void (async()=>{
            await reconcileHydratedChatAuthority(nextChatId,'chat-changed');
            if(String(getContext()?.chatId??'')!==String(nextChatId??''))return;
            const hydration=await hydrateConnectedChatContext({source:'chat-changed'});
            // Hydration establishes a baseline; it is not a synthetic completed
            // assistant turn. Prime Director bookkeeping locally and let the
            // published chat-context-ready event wake only feature-specific
            // background work. Never dispatch the normal post-turn lifecycle here.
            if(hydration?.ready)primeNexusLifecycleBridgeBaseline({source:'chat-context-ready'});
        })();},0);
    });
    registerInitializationDisposer(initVectorPaging(eventSource,event_types));
    registerInitializationDisposer(initLorePaging(eventSource,event_types));
    registerInitializationDisposer(onStoryScopeChange(({reason})=>{
        const previousReviewScope=activeOperatorReviewScope;
        if(previousReviewScope?.identity)invalidateNexusTransactionsForReviewScope(previousReviewScope.identity,reason||'Story Scope changed.');
        clearActiveNexusToolGateway();
        if(previousReviewScope?.chatId){ void invalidateOperatorReviewScope(previousReviewScope,{reason:reason||'story-scope-changed',storage:globalThis.localStorage,lockManager:globalThis.navigator?.locks||null}).catch(error=>logEvent('call-center','operator-review-scope-invalidation-failed',{error,scope:previousReviewScope},'error')); }
        activeOperatorReviewScope=currentOperatorReviewScope();
        invalidateVectorPaging('story-scope-changed');
        rollbackPendingNativeWorldInfo('story-scope-changed');
        invalidateRevisionBoundNexusWork(reason||'story-scope-changed','STORY_SCOPE_CHANGED',0);
        logEvent('story-scope','runtime-boundary-invalidated',{reason:reason||'story-scope-changed',scope:getStoryScopeStatus()},'info');
    }));
    markMainBridgeConnected(!!eventSource?.on,'st-lifecycle-hooks');
    initialized=true;
    logEvent('runtime','extension-loaded',{version:'0.7.0',legacyFallback:true},'info');
    console.log('[Nexus] v0.7.0 loaded');
}

export async function init(){
    if(initializationState==='ready')return true;
    if(initializationState==='starting'&&initializationPromise)return initializationPromise;
    initializationState='starting';
    initializationPromise=(async()=>{
        try{await performInitialization();initializationState='ready';return true;}
        catch(error){await rollbackInitialization('initialization-failed');initializationState='failed';throw error;}
        finally{initializationPromise=null;}
    })();
    return initializationPromise;
}

export function nexusInitializationState(){return initializationState;}

jQuery(async()=>{try{await init();}catch(err){logEvent('runtime','initialization-failed',{error:err},'error');console.error('[Nexus] Initialization failed:',err);}});
