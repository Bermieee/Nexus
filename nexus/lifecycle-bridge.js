import { sidecarRouter } from '../sidecar/router.js';
import { getContext } from '../../../../st-context.js';
import { getSettings } from '../core/settings.js';
import { getJobQueue } from '../core/job-queue.js';
import { getPostTurnBacklogState } from '../postturn/pipeline.js';
import { runAutomaticPostTurnLifecycle, runAutomaticLoreRoutingLifecycle } from '../lifecycle/intelligence.js';
import { inspectLifecycleTaskCadence, markLifecycleTaskCadenceRun } from '../lifecycle/scheduler.js';
import { runHousekeeper, isHousekeeperSuccessfulRun } from '../maintenance/housekeeper.js';
import { createNextSummary, inspectSummaryEligibility, inspectPromotionEligibility, promoteDueSummaries } from '../memory/summarizer.js';
import { inspectLoreRoutingEligibility } from '../memory/lore-router.js';
import { refreshNotebookFromScene } from '../memory/notebook.js';
import { getCharacterBankSceneSnapshot, reconcileCharacterBankRuntime } from '../memory/character-banks.js';
import { isSmartContextStale, preWarmSmartContext } from '../smart-context/warmer.js';
import { logEvent, getTelemetrySnapshot } from '../observability/telemetry.js';
import { NEXUS_EVENT_TYPE, NEXUS_JOB_ROUTE, createNexusEvent, deepCopy } from './contracts.js';
import { getNexusRuntime } from './runtime.js';
import { NEXUS_BATCH_DOMAIN } from './batch-layer.js';
import { enqueueNexusModelWorkerJob } from './model-worker-bus.js';
import { markModelWorkerExecutor } from './sidecar-job-adapter.js';
import { NEXUS_MIGRATED_WORKLOAD, runMigratedDirectorPlan } from './director-migration.js';
import { NEXUS_COORDINATION_MODE, inferNexusCoordinationMode, inspectDirectorMigrationCoverage } from './coordination-profile.js';
import { awaitMessageSettle, revisionFromMessages, currentMessageRevisionGeneration, stableRevisionHash } from './message-settle-barrier.js';
import { captureNexusWorkScope, isNexusWorkScopeFresh } from './work-scope.js';
import { getCurrentSceneChangeGate, RETRIEVAL_CHANGE } from '../retrieval/change-gate.js';
import { getSceneScannerSnapshot } from '../scene/scanner.js';
import { inspectMaintenancePressure, planAutomaticMaintenance } from '../maintenance/planner.js';

let previousState = {};
let lastPlannedRevision = null;
let lastPlan = null;
let shadowPreviousState = {};
let shadowLastPlannedRevision = null;
let shadowLastPlan = null;
let bridgeEpoch = 0;
let bridgeAbortController = new AbortController();
const completedWorkMemo = new Map();
const pendingLifecycleAttempts = new Map();

function assistantTurnCount(chat = []) {
    return chat.filter(message => message?.is_user === false && message?.is_system !== true).length;
}

function captureSnapshot(source = 'lifecycle', baselineState = previousState) {
    const context = getContext();
    const chat = Array.isArray(context?.chat) ? context.chat : [];
    const settings = getSettings();
    const backlog = getPostTurnBacklogState();
    const authorityErrors = [];
    let summary = { due: false, reason: 'unavailable' };
    try { summary = inspectSummaryEligibility(); } catch (error) { const message=`summary-check-failed:${error?.message || error}`; summary = { due: false, reason: message }; authorityErrors.push({workload:NEXUS_MIGRATED_WORKLOAD.SUMMARY,error:message}); }
    const chatText = chat.slice(-8).map(message => String(message?.mes || '')).join('\n');
    // The Work Director is a consumer of accepted scene semantics. It does not
    // re-scan prose or own Change Gate classification. The message-settle
    // boundary below advances Scene Scanner first; this snapshot is read-only.
    const sceneSnapshot = getSceneScannerSnapshot({ chatId: context?.chatId ?? null });
    const sceneGate = getCurrentSceneChangeGate({ chatId: context?.chatId ?? null });
    const detectedLocation = String(sceneSnapshot?.acceptedScene?.location || baselineState?.location || '').trim();
    const acceptedSceneActors = Array.isArray(sceneSnapshot?.acceptedScene?.participants)
        ? sceneSnapshot.acceptedScene.participants.map(value=>String(value||'').trim()).filter(Boolean)
        : (Array.isArray(baselineState?.activeActors) ? [...baselineState.activeActors] : []);
    const characterScene = getCharacterBankSceneSnapshot({ chatText, sceneSnapshot });
    const postTurnCadence = inspectLifecycleTaskCadence('postTurn');
    const notebookCadence = inspectLifecycleTaskCadence('notebook');
    const summaryCadence = inspectLifecycleTaskCadence('summary');
    const smartWarmCadence = inspectLifecycleTaskCadence('smartWarm');
    const maintenanceCadence = inspectLifecycleTaskCadence('housekeeper');
    const promotionCadence = inspectLifecycleTaskCadence('promotion');
    const loreRoutingCadence = inspectLifecycleTaskCadence('loreRouting');
    let promotion = { due: false, reason: 'unavailable' };
    let loreRouting = { due: false, reason: 'unavailable' };
    try { promotion = inspectPromotionEligibility(); } catch (error) { const message=`promotion-check-failed:${error?.message || error}`; promotion = { due: false, reason: message }; authorityErrors.push({workload:NEXUS_MIGRATED_WORKLOAD.SUMMARY_PROMOTION,error:message}); }
    try { loreRouting = inspectLoreRoutingEligibility(); } catch (error) { const message=`lore-routing-check-failed:${error?.message || error}`; loreRouting = { due: false, reason: message }; authorityErrors.push({workload:NEXUS_MIGRATED_WORKLOAD.LORE_ROUTING,error:message}); }
    const schedulerAutomatic = settings.scheduler?.enabled !== false && settings.scheduler?.automatic !== false;
    const assistantTurns = assistantTurnCount(chat);
    const changeClass = sceneGate?.mode === RETRIEVAL_CHANGE.MAJOR_CHANGE ? 'major' : sceneGate?.mode === RETRIEVAL_CHANGE.MINOR_CHANGE ? 'minor' : 'none';
    const assistantTurnAdvanced = assistantTurns > Math.max(0, Number(baselineState?.assistantTurns) || 0);
    const maintenancePressure = inspectMaintenancePressure({
        queue: getJobQueue(settings.jobs).healthSnapshot(),
        events: getTelemetrySnapshot().events,
        timeoutMs: Number(settings.notebook?.timeoutMs) || 120000,
        activeModels: ['A', 'B'].map(slot => settings.sidecars?.[slot]?.model).filter(Boolean),
    });
    const maintenancePlan = planAutomaticMaintenance({
        source,
        assistantTurnAdvanced,
        changeClass: changeClass,
        coldStart: assistantTurns <= 1 || !Number(baselineState?.assistantTurns),
        notebookAutomatic: settings.notebook?.enabled !== false && settings.notebook?.automatic !== false,
        notebookCadenceDue: notebookCadence.due === true,
        schedulerAutomatic,
        housekeeperEnabled: settings.scheduler?.tasks?.housekeeper !== false && settings.housekeeper?.enabled !== false,
        maintenanceCadenceDue: maintenanceCadence.due === true,
        pressure: maintenancePressure,
    });
    const current = {
        postTurnDue: schedulerAutomatic && settings.scheduler?.tasks?.postTurn !== false && postTurnCadence.due === true && backlog.pendingStart !== null && backlog.pendingEnd !== null,
        notebookDue: source === 'generation-end' && maintenancePlan.notebookDue,
        notebookDueReason: maintenancePlan.notebookReason,
        summaryDue: schedulerAutomatic && settings.scheduler?.tasks?.summary !== false && summaryCadence.due === true && summary?.due === true,
        promotionDue: schedulerAutomatic && settings.scheduler?.tasks?.promotion !== false && promotionCadence.due === true && promotion?.due === true,
        loreRoutingDue: schedulerAutomatic && settings.scheduler?.tasks?.loreRouting !== false && loreRoutingCadence.due === true && loreRouting?.due === true,
        maintenanceDue: maintenancePlan.maintenanceDue,
        maintenanceDueReason: maintenancePlan.maintenanceReason,
        maintenancePressure,
        smartWarmStale: isSmartContextStale(),
        smartWarmDue: schedulerAutomatic && settings.scheduler?.tasks?.smartWarm !== false && smartWarmCadence.due === true,
        coldStart: assistantTurns <= 1,
        messageCount: chat.length,
        assistantTurns,
        // Accepted Scanner participants/location are the scene observation fed to
        // Change Gate/Director. Character Bank presence remains a separate local
        // runtime concern and cannot become a second topology classifier.
        activeActors: acceptedSceneActors,
        sceneActorsChanged: sceneGate?.sceneDelta?.participants?.changed === true,
        sceneLocationChanged: sceneGate?.sceneDelta?.location?.changed === true,
        characterBankActiveActors: characterScene.activeActors,
        characterBankFingerprint: characterScene.fingerprint,
        location: detectedLocation,
        changeClass: changeClass,
        majorBeat: sceneGate?.mode === RETRIEVAL_CHANGE.MAJOR_CHANGE,
        minorBeat: sceneGate?.mode === RETRIEVAL_CHANGE.MINOR_CHANGE,
    };
    const planningAuthority = {
        source,
        messageRevisionGeneration: currentMessageRevisionGeneration(),
        pendingStart: backlog.pendingStart, pendingEnd: backlog.pendingEnd,
        due: { postTurn:current.postTurnDue, notebook:current.notebookDue, summary:current.summaryDue, promotion:current.promotionDue, loreRouting:current.loreRoutingDue, maintenance:current.maintenanceDue, smartWarm:current.smartWarmDue, smartWarmStale:current.smartWarmStale },
        scene: { assistantTurns:current.assistantTurns, activeActors:current.activeActors, sceneActorsChanged:current.sceneActorsChanged, sceneLocationChanged:current.sceneLocationChanged, characterBankActiveActors:current.characterBankActiveActors, characterBankFingerprint:current.characterBankFingerprint, location:current.location, changeClass:current.changeClass },
        cadence: { postTurn:postTurnCadence, notebook:notebookCadence, summary:summaryCadence, smartWarm:smartWarmCadence, maintenance:maintenanceCadence, promotion:promotionCadence, loreRouting:loreRoutingCadence },
        maintenancePlan,
        authorityErrors,
        policy: {
            schedulerAutomatic, schedulerTasks:deepCopy(settings.scheduler?.tasks||{}), schedulerIntervals:deepCopy(settings.scheduler?.intervals||{}),
            notebook:{enabled:settings.notebook?.enabled!==false,automatic:settings.notebook?.automatic!==false},
            workDirector:deepCopy(settings.nexus?.workDirector||{}), migration:deepCopy(settings.nexus?.migration||{}),
            sidecars:{A:settings.sidecars?.A?.enabled===true,B:settings.sidecars?.B?.enabled===true},
        },
    };
    const revision = revisionFromMessages(chat, planningAuthority, { includeAll:true });
    return { revision, source, current, authorityErrors:deepCopy(authorityErrors), planningAuthority:deepCopy(planningAuthority), backlog: deepCopy(backlog), summary: deepCopy(summary), promotion: deepCopy(promotion), loreRouting: deepCopy(loreRouting), characterScene: deepCopy(characterScene), postTurnCadence: deepCopy(postTurnCadence), notebookCadence: deepCopy(notebookCadence), summaryCadence: deepCopy(summaryCadence), smartWarmCadence: deepCopy(smartWarmCadence), maintenanceCadence: deepCopy(maintenanceCadence), maintenancePlan: deepCopy(maintenancePlan), promotionCadence: deepCopy(promotionCadence), loreRoutingCadence: deepCopy(loreRoutingCadence) };
}

function bridgeSettings() {
    const settings = getSettings();
    const workDirector = settings.nexus?.workDirector || {};
    return {
        extensionEnabled: settings.enabled === true,
        nexusEnabled: settings.nexus?.enabled === true,
        directorEnabled: workDirector.enabled === true,
        shadowOnly: workDirector.shadowOnly !== false,
        settleMs: Math.max(0, Math.min(2000, Number(workDirector.settleMs) || 60)),
        settleAttempts: Math.max(1, Math.min(10, Math.floor(Number(workDirector.settleAttempts) || 2))),
        migratedWorkloads: Array.isArray(settings.nexus?.migration?.migratedWorkloads) ? [...settings.nexus.migration.migratedWorkloads] : [],
        useLegacyFallback: settings.nexus?.useLegacyFallback !== false,
        coordinationMode: inferNexusCoordinationMode(settings.nexus || {}),
        sidecarAvailable: settings.sidecars?.A?.enabled === true || settings.sidecars?.B?.enabled === true,
        sidecarSlots: ['A','B'].filter(slot => settings.sidecars?.[slot]?.enabled === true),
        mainWorkerConfigured: settings.enabled === true
            && settings.nexus?.modelWorker?.useMain === true,
    };
}

export function resetNexusLifecycleBridge(reason = 'reset') {
    bridgeEpoch++;
    try { bridgeAbortController.abort(Object.assign(new Error(String(reason||'Nexus lifecycle bridge reset.')), {name:'TV2ScopeInvalidated'})); } catch {}
    bridgeAbortController = new AbortController();
    completedWorkMemo.clear();
    pendingLifecycleAttempts.clear();
    previousState = {};
    lastPlannedRevision = null;
    lastPlan = null;
    shadowPreviousState = {};
    shadowLastPlannedRevision = null;
    shadowLastPlan = null;
    logEvent('nexus-director', 'bridge-reset', { reason }, 'debug');
}

export function getNexusLifecycleBridgeState() {
    return {
        lastPlannedRevision,
        lastPlan: lastPlan ? deepCopy(lastPlan) : null,
        previousState: deepCopy(previousState),
        shadowLastPlannedRevision,
        shadowLastPlan: shadowLastPlan ? deepCopy(shadowLastPlan) : null,
        shadowPreviousState: deepCopy(shadowPreviousState),
        pendingRevisions: [...pendingLifecycleAttempts.keys()],
    };
}

/**
 * Close the composite lifecycle attempt only after both Director-owned work and
 * any required legacy compatibility work have reached a safe terminal result.
 * This repair strengthens the HOTFIX hydration boundary: priming establishes a
 * baseline, while finalization is the only path that memoizes a serviced live
 * revision after Director + legacy compatibility work settles.
 */
export function finalizeNexusLifecycleAttempt(directorResult, { legacyTypes = [], legacySucceeded = true } = {}) {
    const attemptId = String(directorResult?.attemptId || '');
    if (!attemptId) return { finalized:false, reason:'no-pending-attempt' };
    const pending = pendingLifecycleAttempts.get(attemptId);
    if (!pending) return { finalized:false, reason:'attempt-not-current' };
    pendingLifecycleAttempts.delete(attemptId);
    const fresh = pending.epoch === bridgeEpoch && isNexusWorkScopeFresh(pending.scope, getContext());
    if (!fresh) return { finalized:false, reason:'scope-invalidated' };

    const legacy = new Set((legacyTypes || []).map(String));
    const handled = new Set((directorResult?.handledTypes || []).map(String));
    const planned = new Set((directorResult?.plan?.jobs || []).map(job => String(job?.type || '')).filter(Boolean));
    const unresolved = [...planned].filter(type => !handled.has(type) && !(legacySucceeded && legacy.has(type)));
    if (!legacySucceeded || unresolved.length) {
        logEvent('nexus-director','composite-attempt-open',{attemptId,revision:pending.revision,legacySucceeded,legacyTypes:[...legacy],unresolved},'warn');
        return { finalized:false, reason:!legacySucceeded?'legacy-incomplete':'workload-unresolved', unresolved };
    }
    previousState = deepCopy(pending.current);
    lastPlannedRevision = pending.revision;
    logEvent('nexus-director','composite-attempt-complete',{attemptId,revision:pending.revision,legacyTypes:[...legacy],handledTypes:[...handled]},'info');
    return { finalized:true, revision:pending.revision };
}

/**
 * Seed Director continuity after a chat-connect local hydration scan without
 * pretending that an assistant turn just completed. This prevents the first
 * hydrated snapshot from being interpreted as post-turn work while preserving
 * the correct baseline for the next real message-settled boundary.
 */
export function primeNexusLifecycleBridgeBaseline({source='chat-context-ready'}={}) {
    const snapshot=captureSnapshot(source);
    previousState=deepCopy(snapshot.current);
    lastPlannedRevision=snapshot.revision;
    lastPlan=null;
    logEvent('nexus-director','bridge-baseline-primed',{source,revision:snapshot.revision,messageCount:snapshot.current.messageCount,assistantTurns:snapshot.current.assistantTurns},'debug');
    return {revision:snapshot.revision,current:deepCopy(snapshot.current)};
}

/**
 * Build the deterministic Director plan before legacy lifecycle execution.
 * Shadow mode emits plans only. When migration is enabled, explicitly selected
 * workloads execute through adapters that preserve the existing Batch Layer ->
 * Sidecar Bus -> A/B boundary. Unselected workloads remain on legacy lifecycle.
 */
// Planning attempts are independent across scopes. Revision ownership is fenced
// by the settled authority fingerprint; physical Director work is never chained
// behind an old chat's promise tail.
export function planSettledNexusLifecycle(options = {}) {
    const epoch = bridgeEpoch;
    const scope = captureNexusWorkScope(getContext(),{includeRevision:false});
    if (epoch !== bridgeEpoch || !isNexusWorkScopeFresh(scope,getContext())) return Promise.resolve({skipped:true,reason:'scope-invalidated'});
    return executeSettledLifecycle(options,epoch,scope);
}

function workloadAvailable(job) {
    const routes = {
        'smart-warm':['retrieval','smart-context-warm'],
        'post-turn-extract':['postTurn','postturn-memory'],
        'notebook-refresh':['maintenance','maintenance'],
        'summary':['summaries','summary'],
        'summary-promotion':['summaries','summary-promotion'],
        'lore-routing':['summaries','summary-lore-route'],
        'maintenance':['maintenance','maintenance'],
    };
    const route = routes[job.type];
    return !!route && sidecarRouter.availableSlots(...route).length > 0;
}

function modelWorkerAvailable(job) {
    if (workloadAvailable(job)) return true;
    try {
        const profile = getNexusRuntime()?.executionProfile || {};
        return profile.mainWorkerAvailable === true;
    } catch { return false; }
}

async function executeSettledLifecycle({ source = 'lifecycle' } = {}, epoch, entryScope) {
    const initialConfig = bridgeSettings();
    const executionSignal = bridgeAbortController.signal;
    const config = initialConfig;
    if (!config.extensionEnabled) return { skipped: true, reason: 'extension-disabled' };
    if (!config.nexusEnabled || !config.directorEnabled) return { skipped: true, reason: 'director-disabled' };

    const baselineState = config.shadowOnly ? shadowPreviousState : previousState;
    const priorRevision = config.shadowOnly ? shadowLastPlannedRevision : lastPlannedRevision;
    const settled = await awaitMessageSettle({
        snapshot: async () => {
            // Scene authority is advanced by the runtime boundary before
            // Director planning. Work Director is read-only with respect to
            // Scanner observation and Change Gate classification.
            return captureSnapshot(source, baselineState);
        },
        delayMs: config.settleMs,
        attempts: config.settleAttempts,
    });
    if (epoch !== bridgeEpoch || executionSignal.aborted || !isNexusWorkScopeFresh(entryScope,getContext())) return {skipped:true,reason:'scope-invalidated'};
    const settledConfig = bridgeSettings();
    if (!settledConfig.extensionEnabled) return {skipped:true,reason:'extension-disabled'};
    if (!settledConfig.nexusEnabled || !settledConfig.directorEnabled) return {skipped:true,reason:'director-disabled'};
    // From this point forward, only the post-settlement settings snapshot may
    // decide mode, migration coverage, or legacy fallback.
    Object.assign(config, settledConfig);
    if (!settled.settled) {
        logEvent('nexus-director', 'message-not-settled', {
            source,
            revision: settled.revision,
            attempts: settled.attempt,
        }, 'debug');
        return { skipped: true, reason: 'message-not-settled', revision: settled.revision };
    }
    if (settled.revision === priorRevision) {
        const priorPlan=config.shadowOnly?shadowLastPlan:lastPlan;
        return { skipped: true, reason: 'revision-already-planned', revision: settled.revision, plan: priorPlan ? deepCopy(priorPlan) : null, shadow:config.shadowOnly };
    }
    if (pendingLifecycleAttempts.has(settled.revision)) {
        return { skipped:true, reason:'revision-in-flight', revision:settled.revision, plan:lastPlan ? deepCopy(lastPlan) : null };
    }

    const snapshot = settled.snapshot;
    const directorContext = getContext();
    const directorScope = captureNexusWorkScope(directorContext);
    if (!isNexusWorkScopeFresh(directorScope, getContext())) return { skipped: true, reason: 'scope-invalidated', revision: settled.revision };
    const event = createNexusEvent({
        type: NEXUS_EVENT_TYPE.MESSAGE_SETTLED,
        source,
        revision: settled.revision,
        previous: baselineState,
        current: snapshot.current,
        payload: { backlog: snapshot.backlog, summary: snapshot.summary, promotion: snapshot.promotion, loreRouting: snapshot.loreRouting, characterScene: snapshot.characterScene, postTurnCadence: snapshot.postTurnCadence, notebookCadence: snapshot.notebookCadence, summaryCadence: snapshot.summaryCadence, smartWarmCadence: snapshot.smartWarmCadence, maintenanceCadence: snapshot.maintenanceCadence, maintenancePlan: snapshot.maintenancePlan, promotionCadence: snapshot.promotionCadence, loreRoutingCadence: snapshot.loreRoutingCadence },
        metadata: { settleAttempt: settled.attempt, shadowOnly: config.shadowOnly },
    });
    const runtime = getNexusRuntime();
    const plan = runtime.director.buildPlanFromEvent(event);
    if(config.shadowOnly)shadowLastPlan=deepCopy(plan);else lastPlan = deepCopy(plan);

    logEvent('nexus-director', 'plan-ready', {
        source,
        eventId: event.id,
        planId: plan.id,
        revision: settled.revision,
        shadowOnly: config.shadowOnly,
        classification: plan.classification,
        decisions: plan.decisions,
        jobs: plan.jobs.map(job => ({ id: job.id, type: job.type, kind: job.kind, route: job.route, priority: job.priority, transactionRequired: job.transactionRequired })),
    }, 'info');
    for (const decision of plan.decisions) {
        logEvent('nexus-director', `decision-${decision.action}`, {
            source,
            planId: plan.id,
            revision: settled.revision,
            ...decision,
        }, decision.action === 'run' ? 'info' : 'debug');
    }

    if (config.shadowOnly) {
        shadowPreviousState=deepCopy(snapshot.current);shadowLastPlannedRevision=settled.revision;
        return { shadow: true, revision: settled.revision, event, plan, handledTypes: [], authorityBlockedTypes:(snapshot.authorityErrors||[]).map(row=>row.workload) };
    }

    const attemptId = settled.revision;
    pendingLifecycleAttempts.set(attemptId, { attemptId, revision:settled.revision, epoch, scope:directorScope, current:deepCopy(snapshot.current), planId:plan.id, source });

    const smartWarmExecutor = markModelWorkerExecutor(async (job, activePlan) => {
        const result = await preWarmSmartContext({
            source: `director:${activePlan?.id || plan.id}`,
            force: false,
            // A completed assistant turn may change what is load-bearing even
            // when location/cast/topology stay stable. Run the small semantic
            // continuity check once at that boundary; only explicit continuity
            // drift can request a foreground MINOR refresh.
            semanticCheck: activePlan?.classification?.assistantTurnAdvanced === true,
            enqueueSidecar: (stage, options) => enqueueNexusModelWorkerJob(NEXUS_BATCH_DOMAIN.REASONING, stage, {
                ...(options || {}),
                nexusScope: directorScope,
                telemetry: {
                    ...(options?.telemetry || {}),
                    nexusPlanId: activePlan?.id || plan.id,
                    nexusDirectorJobId: job?.id || null,
                    nexusDirectorJobType: job?.type || NEXUS_MIGRATED_WORKLOAD.SMART_WARM,
                    nexusDirectorResourceIntent: deepCopy(job?.metadata?.resourceIntent || null),
                    nexusMigration: NEXUS_MIGRATED_WORKLOAD.SMART_WARM,
                    nexusInternalWorker: true,
                },
            }),
        });
        if (!result?.failed && !result?.deferred && !result?.skipped) markLifecycleTaskCadenceRun('smartWarm',{scope:directorScope,context:directorContext});
        return result;
    });
    const postTurnExecutor = markModelWorkerExecutor(async (job, activePlan) => {
        const activePlanId = activePlan?.id || plan.id;
        const result = await runAutomaticPostTurnLifecycle({
            context: directorContext,
            cycleId: `director:${activePlanId}`,
            directorMeta: {
                nexusPlanId: activePlanId,
                nexusDirectorJobId: job?.id || null,
                nexusMigration: NEXUS_MIGRATED_WORKLOAD.POST_TURN_EXTRACT,
            },
            enqueueSidecar: (stage, options) => enqueueNexusModelWorkerJob(NEXUS_BATCH_DOMAIN.LOREBOOK, stage, {
                ...(options || {}),
                nexusScope: directorScope,
                telemetry: {
                    ...(options?.telemetry || {}),
                    nexusPlanId: activePlanId,
                    nexusDirectorJobId: job?.id || null,
                    nexusDirectorJobType: job?.type || NEXUS_MIGRATED_WORKLOAD.POST_TURN_EXTRACT,
                    nexusDirectorResourceIntent: deepCopy(job?.metadata?.resourceIntent || null),
                    nexusMigration: NEXUS_MIGRATED_WORKLOAD.POST_TURN_EXTRACT,
                    nexusInternalWorker: true,
                },
            }),
        });
        if (result?.failed) {
            const error = new Error(result.error || result.stage || 'Director post-turn extraction failed.');
            error.nexusPostTurnResult = result;
            throw error;
        }
        if (result?.deferred) return { skipped: true, ...result };
        // A budget-limited catch-up pass is successful work, but it has not
        // drained the workload. Leave cadence due so the next lifecycle plan can
        // continue from the durable remainder instead of pretending Post-turn is
        // caught up for another interval.
        // Lifecycle Intelligence may intentionally settle an eligible window
        // without launching Post-turn (NONE / Narrative Memory / Character State).
        // That is successful lifecycle work and must consume cadence once the
        // exact Post-turn backlog prefix is settled. Only failure/defer or a
        // budget-limited remainder leaves cadence due.
        if (!result?.failed && !result?.deferred && !(Number(result?.remainingPendingCount)||0)) markLifecycleTaskCadenceRun('postTurn',{scope:directorScope,context:directorContext});
        return result;
    });
    const notebookExecutor = markModelWorkerExecutor(async (job, activePlan) => {
        const activePlanId = activePlan?.id || plan.id;
        let result;
        try { result = await refreshNotebookFromScene({
            manual: false,
            directorMeta: {
                nexusPlanId: activePlanId,
                nexusDirectorJobId: job?.id || null,
                nexusMigration: NEXUS_MIGRATED_WORKLOAD.NOTEBOOK_REFRESH,
                nexusInternalWorker: true,
            },
            enqueueSidecar: (stage, options) => enqueueNexusModelWorkerJob(NEXUS_BATCH_DOMAIN.NOTEBOOK, stage, {
                ...(options || {}),
                nexusScope: directorScope,
                telemetry: {
                    ...(options?.telemetry || {}),
                    nexusPlanId: activePlanId,
                    nexusDirectorJobId: job?.id || null,
                    nexusDirectorJobType: job?.type || NEXUS_MIGRATED_WORKLOAD.NOTEBOOK_REFRESH,
                    nexusDirectorResourceIntent: deepCopy(job?.metadata?.resourceIntent || null),
                    nexusMigration: NEXUS_MIGRATED_WORKLOAD.NOTEBOOK_REFRESH,
                    nexusInternalWorker: true,
                },
            }),
        }); }
        catch (error) {
            // Notebook already performs bounded slice/final semantic recovery.
            // Replaying the whole legacy refresh would duplicate every valid
            // extraction slice, so leave the cadence due for a later catch-up.
            error.nexusLegacyFallback = false;
            throw error;
        }
        if (!result?.failed && !result?.deferred && !result?.stale) markLifecycleTaskCadenceRun('notebook',{scope:directorScope,context:directorContext});
        return result;
    });
    const characterBankExecutor = async (job, activePlan) => {
        const activePlanId = activePlan?.id || plan.id;
        return reconcileCharacterBankRuntime({
            source: `director:${activePlanId}`,
            expectedActiveActors: job?.metadata?.activeActors || [],
            sceneSnapshot: getSceneScannerSnapshot({ chatId: getContext()?.chatId ?? null }),
        });
    };
    const maintenanceExecutor = markModelWorkerExecutor(async (job, activePlan) => {
        const activePlanId = activePlan?.id || plan.id;
        const result = await runHousekeeper({
            force: false,
            cadenceDue: true,
            directorMeta: {
                nexusPlanId: activePlanId,
                nexusDirectorJobId: job?.id || null,
                nexusMigration: NEXUS_MIGRATED_WORKLOAD.MAINTENANCE,
                nexusInternalWorker: true,
            },
            enqueueSidecar: (stage, options) => enqueueNexusModelWorkerJob(NEXUS_BATCH_DOMAIN.REASONING, stage, {
                ...(options || {}),
                nexusScope: directorScope,
                telemetry: {
                    ...(options?.telemetry || {}),
                    nexusPlanId: activePlanId,
                    nexusDirectorJobId: job?.id || null,
                    nexusDirectorJobType: job?.type || NEXUS_MIGRATED_WORKLOAD.MAINTENANCE,
                    nexusDirectorResourceIntent: deepCopy(job?.metadata?.resourceIntent || null),
                    nexusMigration: NEXUS_MIGRATED_WORKLOAD.MAINTENANCE,
                    nexusInternalWorker: true,
                },
            }),
        });
        if (!isHousekeeperSuccessfulRun(result) && !result?.deferred && !result?.skipped) {
            const error = new Error(result?.adviceError || result?.reason || 'Director maintenance pass did not complete successfully.');
            error.nexusMaintenanceResult = result;
            // Housekeeper is proposal-first and cadence-driven. Immediate legacy
            // replay after its own failure only duplicates the deterministic scan.
            error.nexusLegacyFallback = false;
            throw error;
        }
        if (isHousekeeperSuccessfulRun(result)) markLifecycleTaskCadenceRun('housekeeper',{scope:directorScope,context:directorContext});
        return result;
    });
    const summaryExecutor = markModelWorkerExecutor(async (job, activePlan) => {
        const activePlanId = activePlan?.id || plan.id;
        const result = await createNextSummary({
            cycleId: `director:${activePlanId}`,
            manual: false,
            directorMeta: {
                nexusPlanId: activePlanId,
                nexusDirectorJobId: job?.id || null,
                nexusMigration: NEXUS_MIGRATED_WORKLOAD.SUMMARY,
            },
            enqueueSidecar: (stage, options) => enqueueNexusModelWorkerJob(NEXUS_BATCH_DOMAIN.MEMORY_BANK, stage, {
                ...(options || {}),
                nexusScope: directorScope,
                telemetry: {
                    ...(options?.telemetry || {}),
                    nexusPlanId: activePlanId,
                    nexusDirectorJobId: job?.id || null,
                    nexusDirectorJobType: job?.type || NEXUS_MIGRATED_WORKLOAD.SUMMARY,
                    nexusDirectorResourceIntent: deepCopy(job?.metadata?.resourceIntent || null),
                    nexusMigration: NEXUS_MIGRATED_WORKLOAD.SUMMARY,
                    nexusInternalWorker: true,
                },
            }),
        });
        if (result?.failed) {
            const error = new Error(result.error || 'Director summary creation failed.');
            error.nexusSummaryResult = result;
            throw error;
        }
        if (result?.deferred) return { skipped: true, ...result };
        if (result?.created) markLifecycleTaskCadenceRun('summary',{scope:directorScope,context:directorContext});
        return result;
    });
    const promotionExecutor = markModelWorkerExecutor(async (job, activePlan) => {
        const activePlanId = activePlan?.id || plan.id;
        const result = await promoteDueSummaries({
            cycleId: `director:${activePlanId}`,
            manual: false,
            directorMeta: {
                nexusPlanId: activePlanId,
                nexusDirectorJobId: job?.id || null,
                nexusMigration: NEXUS_MIGRATED_WORKLOAD.SUMMARY_PROMOTION,
                nexusInternalWorker: true,
            },
            enqueueSidecar: (stage, options) => enqueueNexusModelWorkerJob(NEXUS_BATCH_DOMAIN.MEMORY_BANK, stage, {
                ...(options || {}),
                nexusScope: directorScope,
                telemetry: {
                    ...(options?.telemetry || {}),
                    nexusPlanId: activePlanId,
                    nexusDirectorJobId: job?.id || null,
                    nexusDirectorJobType: job?.type || NEXUS_MIGRATED_WORKLOAD.SUMMARY_PROMOTION,
                    nexusDirectorResourceIntent: deepCopy(job?.metadata?.resourceIntent || null),
                    nexusMigration: NEXUS_MIGRATED_WORKLOAD.SUMMARY_PROMOTION,
                    nexusInternalWorker: true,
                },
            }),
        });
        if (result?.failed) {
            const error = new Error(result.error || result.results?.find?.(row => row?.failed)?.error || 'Director summary promotion failed.');
            error.nexusPromotionResult = result;
            throw error;
        }
        if((result?.promotions||0)>0)markLifecycleTaskCadenceRun('promotion',{scope:directorScope,context:directorContext});
        return result;
    });
    const loreRoutingExecutor = markModelWorkerExecutor(async (job, activePlan) => {
        const activePlanId = activePlan?.id || plan.id;
        const result = await runAutomaticLoreRoutingLifecycle({
            cycleId: `director:${activePlanId}`,
            context: directorContext,
            maxPerCycle: getSettings().memoryBank?.loreRouting?.maxPerCycle || 1,
            directorMeta: {
                nexusPlanId: activePlanId,
                nexusDirectorJobId: job?.id || null,
                nexusMigration: NEXUS_MIGRATED_WORKLOAD.LORE_ROUTING,
                nexusInternalWorker: true,
            },
            enqueueSidecar: (stage, options) => enqueueNexusModelWorkerJob(NEXUS_BATCH_DOMAIN.LOREBOOK, stage, {
                ...(options || {}),
                nexusScope: directorScope,
                telemetry: {
                    ...(options?.telemetry || {}),
                    nexusPlanId: activePlanId,
                    nexusDirectorJobId: job?.id || null,
                    nexusDirectorJobType: job?.type || NEXUS_MIGRATED_WORKLOAD.LORE_ROUTING,
                    nexusDirectorResourceIntent: deepCopy(job?.metadata?.resourceIntent || null),
                    nexusMigration: NEXUS_MIGRATED_WORKLOAD.LORE_ROUTING,
                    nexusInternalWorker: true,
                },
            }),
        });
        if (result?.failed) {
            const error = new Error(result.results?.find?.(row => row?.failed)?.error || 'Director Summary-to-Lore routing failed.');
            error.nexusLoreRoutingResult = result;
            throw error;
        }
        if (result?.deferred) {
            const error = new Error(result.reason || 'Director Summary-to-Lore routing became stale before commit.');
            error.nexusLoreRoutingResult = result;
            throw error;
        }
        if((result?.count||0)>0)markLifecycleTaskCadenceRun('loreRouting',{scope:directorScope,context:directorContext});
        return result;
    });
    const executors = {
        [NEXUS_MIGRATED_WORKLOAD.SMART_WARM]: smartWarmExecutor,
        [NEXUS_MIGRATED_WORKLOAD.POST_TURN_EXTRACT]: postTurnExecutor,
        [NEXUS_MIGRATED_WORKLOAD.NOTEBOOK_REFRESH]: notebookExecutor,
        [NEXUS_MIGRATED_WORKLOAD.CHARACTER_BANK_REFRESH]: characterBankExecutor,
        [NEXUS_MIGRATED_WORKLOAD.SUMMARY]: summaryExecutor,
        [NEXUS_MIGRATED_WORKLOAD.SUMMARY_PROMOTION]: promotionExecutor,
        [NEXUS_MIGRATED_WORKLOAD.LORE_ROUTING]: loreRoutingExecutor,
        [NEXUS_MIGRATED_WORKLOAD.MAINTENANCE]: maintenanceExecutor,
    };
    const workloadAuthorityKey = (type, job) => {
        const authority = type === NEXUS_MIGRATED_WORKLOAD.CHARACTER_BANK_REFRESH
            ? {activeActors:snapshot.current.characterBankActiveActors,characterBankFingerprint:snapshot.current.characterBankFingerprint}
            : type === NEXUS_MIGRATED_WORKLOAD.POST_TURN_EXTRACT ? snapshot.backlog
            : type === NEXUS_MIGRATED_WORKLOAD.NOTEBOOK_REFRESH ? {source,assistantTurns:snapshot.current.assistantTurns,cadence:snapshot.notebookCadence}
            : type === NEXUS_MIGRATED_WORKLOAD.SUMMARY ? snapshot.summary
            : type === NEXUS_MIGRATED_WORKLOAD.SUMMARY_PROMOTION ? snapshot.promotion
            : type === NEXUS_MIGRATED_WORKLOAD.LORE_ROUTING ? snapshot.loreRouting
            : type === NEXUS_MIGRATED_WORKLOAD.MAINTENANCE ? {plan:snapshot.maintenancePlan,pressure:snapshot.current.maintenancePressure}
            : {assistantTurns:snapshot.current.assistantTurns,scene:snapshot.current.characterBankFingerprint,location:snapshot.current.location,changeClass:snapshot.current.changeClass,stale:snapshot.current.smartWarmStale};
        return `${type}|${stableRevisionHash({authority,jobMetadata:job?.metadata||null})}`;
    };
    for (const [type,execute] of Object.entries(executors)) {
        const wrapped = async (...args) => {
            const job=args[0]||null;
            const memoKey=workloadAuthorityKey(type,job);
            if (completedWorkMemo.has(memoKey)) return deepCopy(completedWorkMemo.get(memoKey));
            const value = await execute(...args);
            if (value?.failed) throw new Error(value.error || `Director ${type} failed.`);
            if (value?.deferred || value?.stale) return {...value,skipped:true};
            completedWorkMemo.set(memoKey,deepCopy(value));
            return value;
        };
        executors[type] = type === NEXUS_MIGRATED_WORKLOAD.CHARACTER_BANK_REFRESH ? wrapped : markModelWorkerExecutor(wrapped);
    }
    const coverage = inspectDirectorMigrationCoverage(executors);
    if (config.coordinationMode === NEXUS_COORDINATION_MODE.FULL && !coverage.complete) {
        logEvent('nexus-director', 'full-mode-coverage-incomplete', {
            planId: plan.id,
            revision: settled.revision,
            missing: coverage.missing,
            invalid: coverage.invalid,
        }, 'error');
        return {
            skipped: true,
            reason: 'director-executor-coverage-incomplete',
            revision: settled.revision,
            event,
            plan,
            coverage,
            useLegacyFallback: false,
            failed: true,
        };
    }
    let migration;
    try {
        migration = await runMigratedDirectorPlan(plan, {
            migratedWorkloads: config.migratedWorkloads,
            executors,
            coordinator: runtime.coordinator,
            routeAvailability: {
                [NEXUS_JOB_ROUTE.LOCAL]: true,
                [NEXUS_JOB_ROUTE.SIDECAR]: workloadAvailable,
                [NEXUS_JOB_ROUTE.MODEL_WORKER]: modelWorkerAvailable,
                [NEXUS_JOB_ROUTE.TREE_BATCH_FIRE]: true,
            },
            isFresh: () => epoch === bridgeEpoch && !executionSignal.aborted && isNexusWorkScopeFresh(directorScope, getContext()),
            signal: executionSignal,
        });
    } catch (error) {
        pendingLifecycleAttempts.delete(attemptId);
        throw error;
    }
    const handledTypes = migration.handledTypes || [];
    const migrationFresh = epoch === bridgeEpoch && !executionSignal.aborted && isNexusWorkScopeFresh(directorScope,getContext());
    if (!migrationFresh) {
        pendingLifecycleAttempts.delete(attemptId);
        logEvent('nexus-director','migrated-plan-stale',{planId:plan.id,revision:settled.revision,reason:'scope-invalidated'},'warn');
        return {shadow:false,stale:true,scopeInvalidated:true,reason:'scope-invalidated',revision:settled.revision,event,plan,migration,handledTypes,useLegacyFallback:false,coordinationMode:config.coordinationMode,coverage};
    }
    logEvent('nexus-director', 'migrated-plan-complete', {
        planId: plan.id,
        revision: settled.revision,
        migratedWorkloads: config.migratedWorkloads,
        handledTypes,
        deferred: migration.deferred || [],
        execution: migration.execution ? {
            succeeded: migration.execution.succeeded,
            failed: migration.execution.failed,
            skipped: migration.execution.skipped,
            blocked: migration.execution.blocked,
        } : null,
        useLegacyFallback: config.useLegacyFallback,
        coordinationMode: config.coordinationMode,
        sidecarAvailable: config.sidecarAvailable,
        sidecarSlots: config.sidecarSlots,
        mainWorkerConfigured: config.mainWorkerConfigured,
        resourceBlockedTypes: migration.resourceBlockedTypes || [],
        coverage,
    }, migration.execution?.failed ? 'warn' : 'info');
    return { shadow: false, attemptId, revision: settled.revision, event, plan, migration, handledTypes, useLegacyFallback: config.useLegacyFallback, coordinationMode: config.coordinationMode, coverage, authorityBlockedTypes:(snapshot.authorityErrors||[]).map(row=>row.workload) };
}
