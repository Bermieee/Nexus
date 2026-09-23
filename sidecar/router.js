import { getSettings, getSidecarProfile } from '../core/settings.js';
import { getJobQueue } from '../core/job-queue.js';
import { isIntentionalCancellation } from '../core/cancellation.js';
import { callSidecar } from './client.js';
import { logEvent, recordWorkloadDecision, recordWorkloadFallback, recordMultiWorkloadAssignment } from '../observability/telemetry.js';
import { chooseWorkloadSlot, normalizeWorkerLock, summarizeSidecarLoad, shouldRetrySidecarFailure, sameSidecarCapacity, sameSidecarProviderModel } from './workload-handler.js';
import { runBatchPool, describeInitialScatter } from './batch-pool.js';
import { evaluateTreeBuildWorkerQuality, evaluateTreeBuildWorkerProbe, shouldProbeTreeBuildWorker, treeBuildScatterLead, treeBuildWorkerProbePolicy } from './worker-quality.js';
import {
    SIDECAR_EXECUTION_MODE,
    normalizeExecutionMode,
    isMultiExecutionMode,
    buildCascadePrompt,
    buildParallelSynthesisPrompt,
    buildSynthesisCandidate,
    modeLabel,
} from './multi-bus.js';
import { resolveNexusSidecarResourcePolicy, getNexusSynthesisResourcePolicy } from '../nexus/resource-policy.js';
import { estimateContentTokens } from '../observability/token-estimator.js';

const ROLE_KEYS = Object.freeze({
    retrieval: 'retrieval',
    loreInjection: 'loreInjection',
    postTurn: 'postTurn',
    summaries: 'summaries',
    maintenance: 'maintenance',
    treeBuild: 'treeBuild',
});

let multiSeq = 0;
let batchSeq = 0;
let adaptiveSeq = 0;
let treeBuildScatterSeq = 0;
const multiInFlight = new Map();
const batchInFlight = new Map();
const adaptiveInFlight = new Map();

function liveInFlight(map, key) {
    if (!key) return null;
    const handle = map.get(key);
    if (!handle) return null;
    if (handle.cancelled || ['succeeded','degraded','failed','cancelled'].includes(handle.state)) {
        if (map.get(key) === handle) map.delete(key);
        return null;
    }
    return handle;
}
function releaseInFlight(map,key,handle){ if(key && map.get(key)===handle) map.delete(key); }

let sidecarAuthorityNotifier = null;
export function setSidecarAuthorityNotifier(fn) { sidecarAuthorityNotifier = typeof fn === 'function' ? fn : null; }
function smallProfileHash(value = '') {
    let hash = 2166136261;
    for (const ch of String(value || '')) { hash ^= ch.charCodeAt(0); hash = Math.imul(hash, 16777619); }
    return (hash >>> 0).toString(36);
}

function endpointIdentity(endpoint = '') {
    const raw = String(endpoint || '').trim();
    try {
        const url = new URL(raw);
        return `${url.protocol.toLowerCase()}//${url.host.toLowerCase()}${url.pathname.replace(/\/+$/, '') || '/'}${url.search}`;
    } catch { return raw.replace(/\/+$/, ''); }
}

function profileHealthKey(profile = {}) {
    return smallProfileHash(JSON.stringify({
        format: String(profile?.format || 'openai').toLowerCase(),
        endpoint: endpointIdentity(profile?.endpoint),
        model: String(profile?.model || '').trim().toLowerCase(),
        credential: smallProfileHash(profile?.credentialId || profile?.accountId || profile?.apiKey || ''),
        timeoutMs: Number(profile?.timeoutMs) || null,
        reasoningEffort: String(profile?.reasoningEffort || ''),
        providerMaxTokens: Number(profile?.providerMaxTokens ?? profile?.maxOutputTokens) || null,
        providerContextTokens: Number(profile?.providerContextTokens ?? profile?.contextWindowTokens) || null,
    }));
}

function blankHealth(profile = {}) {
    return { profileKey: profileHealthKey(profile), failures: 0, cooldownUntil: 0, lastFailure: null, lastRecoveryAt: Date.now() };
}
const runtimeHealth = { A: blankHealth(getSidecarProfile('A')), B: blankHealth(getSidecarProfile('B')) };
function healthRow(slot, profile = getSidecarProfile(slot)) {
    const key = String(slot || '').toUpperCase();
    if (!['A','B'].includes(key)) return null;
    const fingerprint = profileHealthKey(profile);
    if (!runtimeHealth[key] || runtimeHealth[key].profileKey !== fingerprint) runtimeHealth[key] = blankHealth(profile);
    const row = runtimeHealth[key];
    const now = Date.now();
    // Half-open/passive recovery: once cooldown elapsed, gradually forgive old
    // failures so a preferred lane cannot be starved forever without a probe.
    if (row.cooldownUntil <= now && row.failures > 0 && now - Number(row.lastRecoveryAt || 0) >= 60000) {
        row.failures = Math.max(0, row.failures - 1);
        row.lastRecoveryAt = now;
        if (!row.failures) row.lastFailure = null;
    }
    return row;
}
function healthEligible(slot, profile = getSidecarProfile(slot)) { return Date.now() >= Number(healthRow(slot, profile)?.cooldownUntil || 0); }
function healthSnapshot() {
    const now = Date.now();
    return Object.fromEntries(['A','B'].map(slot => {
        const row = healthRow(slot);
        return [slot, {
            eligible: healthEligible(slot), failures: row.failures,
            cooldownUntil: row.cooldownUntil,
            cooldownMs: Math.max(0, row.cooldownUntil - now),
            lastFailure: row.lastFailure,
            profileKey: row.profileKey,
        }];
    }));
}
export function getSidecarRuntimeHealth() { return healthSnapshot(); }
function statusOf(error) { const n=Number(error?.status ?? error?.statusCode ?? error?.httpStatus ?? error?.response?.status); return Number.isFinite(n)?n:null; }
function healthRelevantFailure(error) {
    const name=String(error?.name||''); const status=statusOf(error);
    return name==='TV2SidecarTimeout' || status===429 || (status!=null && status>=500) || (name==='TypeError' && /fetch|network|socket|connection/i.test(String(error?.message||'')));
}
function markWorkerFailure(slot,error,{strong=false,profile=null}={}) {
    const key=String(slot||'').toUpperCase(); if(!['A','B'].includes(key) || !healthRelevantFailure(error)) return;
    const row=healthRow(key, profile || getSidecarProfile(key));
    row.failures=Math.min(8,row.failures+1); row.lastFailure=String(error?.name||error?.message||'failure'); row.lastRecoveryAt=Date.now();
    const shouldQuarantine = strong || row.failures >= 2 || statusOf(error) === 429;
    const retryAfter = Number(error?.http?.headers?.['retry-after']);
    const hintedMs = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(300000, retryAfter * 1000) : 0;
    const base = shouldQuarantine ? Math.max(hintedMs, strong ? 60000 : Math.min(30000,1500*(2**Math.max(0,row.failures-2)))) : 0;
    if (base > 0) row.cooldownUntil=Math.max(row.cooldownUntil,Date.now()+base);
    logEvent('sidecar', shouldQuarantine ? 'runtime-health-quarantine' : 'runtime-health-degraded', {slot:key,profileKey:row.profileKey,failures:row.failures,cooldownMs:base,lastFailure:row.lastFailure},'warn');
}
function markWorkerSuccess(slot,{profile=null}={}) {
    const key=String(slot||'').toUpperCase(); if(!['A','B'].includes(key)) return;
    const row=healthRow(key, profile || getSidecarProfile(key));
    if(row.failures||row.cooldownUntil) logEvent('sidecar','runtime-health-recovered',{slot:key,profileKey:row.profileKey},'info');
    runtimeHealth[key]=blankHealth(profile || getSidecarProfile(key));
}

function other(slot) { return slot === 'A' ? 'B' : 'A'; }
function routeId(role) { return `tv2_route_${role}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`; }
function boundedCandidateEvidence(result,maxChars=1200){const text=String(result?.text||'');let structured='';try{structured=JSON.stringify(result?.structuredPayload??null);}catch{structured='[unserializable]';}const clip=value=>value.length<=maxChars?value:`${value.slice(0,maxChars)}… [${value.length-maxChars} chars omitted]`;const boundedText=clip(text),boundedStructured=clip(structured);return{text:boundedText,structuredPayload:boundedStructured,textChars:text.length,structuredPayloadChars:structured.length,textSample:boundedText,structuredPayloadSample:boundedStructured};}
function multiJobId(role) { return `tv2_multi_${role}_${Date.now()}_${++multiSeq}`; }
function batchJobId(role) { return `tv2_batch_${role}_${Date.now()}_${++batchSeq}`; }

function applySidecarResourcePolicy(role, opts = {}, phase = null) {
    const telemetry = opts.telemetry || {};
    const resolved = resolveNexusSidecarResourcePolicy({
        role,
        stage: opts.bus || role,
        domain: telemetry.nexusBatchDomain || '',
        phase: phase || telemetry.phase || '',
        requestedMaxTokens: opts.maxTokens,
        settings: getSettings(),
    });
    return {
        ...opts,
        // These remain planning hints; callSidecar never treats them as hard
        // transport limits.
        maxTokens: resolved.softOutputTargetTokens || opts.maxTokens,
        inputBudgetTokens: resolved.softInputTargetTokens || opts.inputBudgetTokens,
        totalBudgetTokens: resolved.softTotalTargetTokens || opts.totalBudgetTokens,
        telemetry: {
            ...telemetry,
            resourcePolicy: {
                enabled: resolved.enabled,
                softInputTargetTokens: resolved.softInputTargetTokens,
                softOutputTargetTokens: resolved.softOutputTargetTokens,
                softTotalTargetTokens: resolved.softTotalTargetTokens,
                hardStopAuthority: false,
                requestedMaxTokens: resolved.requestedMaxTokens,
                role: resolved.role,
                stage: resolved.stage,
                domain: resolved.domain,
                phase: resolved.phase,
                inputSources: resolved.inputSources || [],
                sources: resolved.sources,
            },
        },
    };
}

function capabilityKey(role, bus) {
    const stage = String(bus || '');
    if (stage === 'tree-region-scan' || stage === 'tree-region-condense') return 'regionScan';
    if (stage === 'tree-node-scan' || stage === 'tree-node-condense') return 'nodeScan';
    if (stage === 'search-reasoning') return 'search';
    if (stage === 'smart-context-warm') return 'smartContext';
    if (stage === 'lore-injection') return 'loreInjection';
    if (stage === 'postturn-memory') return 'postTurn';
    if (stage === 'summary' || stage === 'summary-promotion' || stage === 'memory-recall' || stage === 'summary-lore-route') return 'summaries';
    if (stage === 'maintenance') return 'maintenance';
    if (stage === 'tree-build') return 'treeBuild';
    if (role === 'loreInjection') return 'loreInjection';
    if (role === 'postTurn') return 'postTurn';
    if (role === 'summaries') return 'summaries';
    if (role === 'maintenance') return 'maintenance';
    if (role === 'treeBuild') return 'treeBuild';
    if (role === 'retrieval') return 'nodeScan';
    return null;
}
function slotEligible(slot, role, bus) {
    const profile = getSidecarProfile(slot);
    if (!profile?.enabled || !healthEligible(slot)) return false;
    const key = capabilityKey(role, bus);
    if (!key) return false;
    return profile.capabilities?.[key] !== false;
}
function enabledSlots(role = null, bus = null) { return ['A', 'B'].filter(slot => slotEligible(slot, role, bus)); }

function normalizedBackend(profile = {}) {
    return {
        format: String(profile?.format || 'openai').toLowerCase(),
        endpoint: endpointIdentity(profile?.endpoint),
        model: String(profile?.model || '').trim().toLowerCase(),
        timeoutMs: Number(profile?.timeoutMs) || null,
        reasoningEffort: String(profile?.reasoningEffort || '').toLowerCase(),
        providerMaxTokens: Number(profile?.providerMaxTokens ?? profile?.maxOutputTokens) || null,
        providerContextTokens: Number(profile?.providerContextTokens ?? profile?.contextWindowTokens) || null,
    };
}

function sameBackend(left, right) { return sameSidecarCapacity(left, right); }

function backendKey(profile = {}) {
    const value = normalizedBackend(profile);
    return value.endpoint && value.model ? JSON.stringify(value) : '';
}

function workerUnavailableError(message, slot = null) {
    const error = new Error(message);
    error.name = 'TV2SidecarWorkerUnavailable';
    error.workerLocal = true;
    error.slot = slot ? String(slot).toUpperCase() : null;
    return error;
}

function isBatchTimeoutFailure(error) {
    return String(error?.name || '') === 'TV2SidecarTimeout';
}

function shouldRetryBatchSlice({ slot, error, attemptedSlots = [], workers = [] } = {}) {
    if (isIntentionalCancellation(error)) return false;
    const failedProfile = getSidecarProfile(slot);
    const remaining = workers.filter(worker => !attemptedSlots.includes(worker));
    return remaining.some(worker => shouldRetrySidecarFailure({
        error,
        failedProfile,
        nextProfile: getSidecarProfile(worker),
    }));
}

// A timed-out slice gets one smaller-payload recovery attempt in the retrieval
// layer.  If that recovery also times out, take only that worker out of the
// pool instead of letting it repeatedly stall foreground-adjacent work.
export function disableSidecarAfterRepeatedTimeout(slot, details = {}) {
    const key = String(slot || '').toUpperCase();
    if (!['A', 'B'].includes(key)) return false;
    const profile = getSidecarProfile(key);
    if (!profile?.enabled) return false;
    const priorTimeoutCount = Math.max(0, Number(details?.priorTimeoutCount) || 0);
    if (priorTimeoutCount < 1) {
        logEvent('sidecar', 'timeout-circuit-held', { slot:key, action:'worker has not timed out twice in the same recovery lineage', ...details }, 'warn');
        return false;
    }
    // Runtime health is not user configuration. Quarantine the worker for a
    // bounded period and revoke only that lane's in-flight authority.
    const timeoutError=Object.assign(new Error('Sidecar timed out twice in one recovery lineage.'),{name:'TV2SidecarTimeout'});
    markWorkerFailure(key, timeoutError, { strong:true });
    try { sidecarAuthorityNotifier?.({ slot:key, reason:'Sidecar runtime timeout circuit opened.' }); } catch {}
    logEvent('sidecar','timeout-circuit-open',{slot:key,action:'runtime-quarantined after two timeout attempts',configuredEnabled:true,...details},'error');
    return true;
}

function settledValue(settled) {
    return settled?.status === 'fulfilled' ? settled.value : null;
}
function settledError(settled) {
    return settled?.status === 'rejected' ? settled.reason : null;
}

class SidecarRouter {
    refresh() { return getSettings().routing; }

    availableSlots(role, bus = null) {
        const locked = this.lockedSlot(role);
        return enabledSlots(role, bus).filter(slot => !locked || slot === locked);
    }

    canExecute(role, bus = null) {
        return this.availableSlots(role, bus).length > 0;
    }

    preferredSlot(role) {
        const settings = getSettings();
        const key = ROLE_KEYS[role] || role;
        const slot = String(settings.routing?.[key] || 'A').toUpperCase();
        return ['A', 'B'].includes(slot) ? slot : 'A';
    }


    lockedSlot(role) {
        const settings = getSettings();
        const key = ROLE_KEYS[role] || role;
        return normalizeWorkerLock(settings.routing?.locks?.[key]);
    }

    executionMode(role, override = null) {
        if (override) return normalizeExecutionMode(override);
        const settings = getSettings();
        const key = ROLE_KEYS[role] || role;
        return normalizeExecutionMode(settings.routing?.modes?.[key]);
    }

    resolveSlots(role, startSlot = null, bus = null) {
        const settings = getSettings();
        const requested = String(startSlot || '').toUpperCase();
        const first = ['A', 'B'].includes(requested) ? requested : this.preferredSlot(role);
        const slots = [first];
        if (settings.routing?.fallback !== false) slots.push(other(first));
        return slots.filter((slot, idx, arr) => arr.indexOf(slot) === idx && slotEligible(slot, role, bus));
    }

    /** Adaptive single-worker call with provider/transport failure fallback. */
    async generate(role, opts = {}) {
        const slots = this.resolveSlots(role, opts.startSlot, opts.bus);
        const rid = opts.routeId || routeId(role);
        if (!slots.length) {
            const err = new Error(`No enabled Nexus Sidecar is available for ${role}.`);
            logEvent('routing', 'no-sidecar-available', { role, routeId: rid }, 'error');
            throw err;
        }
        logEvent('routing', 'route-start', {
            role,
            routeId: rid,
            mode: 'adaptive',
            slots,
            preferredSlot: this.preferredSlot(role),
            assignedSlot: opts.startSlot || slots[0] || null,
            fallback: getSettings().routing?.fallback !== false,
            jobId: opts.jobId || null,
        }, 'info');
        let lastError = null;
        let failedProfile = null;
        let attempt = 0;
        for (const slot of slots) {
            attempt += 1;
            if (attempt > 1) {
                const fromSlot = slots[attempt - 2];
                if (isIntentionalCancellation(lastError, opts.signal)) throw opts.signal?.reason || lastError;
                const retryAllowed = shouldRetrySidecarFailure({
                    error: lastError,
                    failedProfile,
                    nextProfile: { ...getSidecarProfile(slot) },
                    allowSameProviderModelTimeoutRetry: opts.allowSameProviderModelTimeoutRetry === true,
                });
                if (!retryAllowed) {
                    logEvent('routing', 'fallback-skipped-identical-profile', {
                        role,
                        bus: opts.bus || role,
                        routeId: rid,
                        jobId: opts.jobId || null,
                        fromSlot,
                        toSlot: slot,
                        errorName: lastError?.name || null,
                        reason: 'identical-failed-request-identical-model-profile',
                    }, 'warn');
                    break;
                }
                const sameProfileTimeoutRestart = lastError?.name === 'TV2SidecarTimeout'
                    && opts.allowSameProviderModelTimeoutRetry === true
                    && sameSidecarProviderModel(failedProfile, { ...getSidecarProfile(slot) });
                if (sameProfileTimeoutRestart) {
                    logEvent('routing', 'adaptive-timeout-restart', {
                        role,
                        bus: opts.bus || role,
                        routeId: rid,
                        jobId: opts.jobId || null,
                        fromSlot,
                        toSlot: slot,
                        attempt,
                        policy: 'one-cross-slot-restart',
                    }, 'warn');
                }
                recordWorkloadFallback({
                    role,
                    bus: opts.bus || role,
                    routeId: rid,
                    jobId: opts.jobId || null,
                    fromSlot,
                    toSlot: slot,
                    reason: sameProfileTimeoutRestart
                        ? 'same-profile-timeout-cross-lane-restart'
                        : (lastError?.name === 'NexusSidecarReasoningExhausted'
                            ? 'reasoning-exhaustion-alternate-profile'
                            : 'provider-or-transport-failure'),
                });
            }
            let attemptProfile = null;
            try {
                if (attempt > 1 && typeof opts.fallbackDispatch === 'function') {
                    const result = await opts.fallbackDispatch(slot, { attempt, fromSlot: slots[attempt - 2], routeId: rid });
                    result.tv2 = { ...(result.tv2 || {}), slot, role, routeId: rid, attempt, executionMode: 'adaptive', fallbackQueued: true };
                    logEvent('routing', 'route-success', { role, routeId: rid, slot, attempt, jobId: opts.jobId || null, fallbackQueued: true }, 'info');
                    return result;
                }
                if (attempt > 1) {
                    const error = new Error(`Adaptive fallback to Sidecar ${slot} requires scheduler admission for sidecar:${slot}.`);
                    error.name = 'TV2FallbackAdmissionRequired';
                    throw error;
                }
                const governed = applySidecarResourcePolicy(role, opts, 'primary');
                attemptProfile = { ...getSidecarProfile(slot) };
                const requestModel=String(attemptProfile?.model||'');
                const requestFormat=String(attemptProfile?.format||'openai');
                const result = await callSidecar(attemptProfile, {
                    ...governed,
                    label: opts.label || `Nexus ${role} Sidecar ${executionSlot}`,
                    telemetry: {
                        ...(governed.telemetry || {}),
                        slot: executionSlot,
                        role,
                        bus: opts.bus || role,
                        routeId: rid,
                        jobId: opts.jobId || null,
                        attempt,
                        executionMode: 'adaptive',
                        phase: 'primary',
                    },
                });
                result.tv2 = {
                    ...(result.tv2 || {}),
                    slot,
                    role,
                    routeId: rid,
                    attempt,
                    model: requestModel,
                    format: requestFormat,
                    executionMode: 'adaptive',
                };
                markWorkerSuccess(slot, { profile: attemptProfile });
                logEvent('routing', 'route-success', { role, routeId: rid, slot, attempt, jobId: opts.jobId || null }, 'info');
                return result;
            } catch (err) {
                lastError = err;
                failedProfile = attemptProfile || failedProfile || { ...getSidecarProfile(slot) };
                if (isIntentionalCancellation(err, opts.signal)) {
                    logEvent('routing', 'route-preempted', { role, routeId: rid, slot, attempt, error: err, jobId: opts.jobId || null }, 'debug');
                    throw opts.signal?.reason || err;
                }
                markWorkerFailure(slot, err, { profile: failedProfile });
                logEvent('routing', 'route-attempt-failed', { role, routeId: rid, slot, attempt, error: err, jobId: opts.jobId || null }, 'warn');
                console.warn(`[Nexus] Sidecar ${slot} failed for ${role}:`, err?.message || err);
            }
        }
        logEvent('routing', 'route-failed', { role, routeId: rid, slots, error: lastError, jobId: opts.jobId || null }, 'error');
        throw lastError || new Error(`All Nexus Sidecars failed for ${role}.`);
    }

    _enqueuePinned(role, slot, opts, { routeId: rid, parentJobId = null, phase = 'multi-worker', preferredSlot = slot } = {}) {
        opts.assertExecutionFresh?.();
        const queue = getJobQueue(getSettings().jobs);
        if (opts.signal?.aborted) throw opts.signal.reason || Object.assign(new Error('Sidecar work cancelled before queue admission.'), { name: 'TV2BatchCancelled' });
        const job = queue.enqueue(async ({ signal, job }) => {
            opts.assertExecutionFresh?.();
            const executionSlot = opts.dynamicRehome === true ? (String(job.resourceKey||'').split(':')[1] || slot) : slot;
            if (job.meta && typeof job.meta === 'object') {
                job.meta.assignedSlot = executionSlot;
                job.meta.offloaded = executionSlot !== preferredSlot;
            }
            opts.onAttemptAuthority?.(executionSlot);
            if (!slotEligible(executionSlot, role, opts.bus)) throw workerUnavailableError(`Sidecar ${executionSlot} became unavailable before queued ${role} work started.`, executionSlot);
            const profile = { ...getSidecarProfile(executionSlot) };
            job._nexusAttemptProfile = profile;
            const requestModel=String(profile?.model||'');
            const requestFormat=String(profile?.format||'openai');
            const governed = applySidecarResourcePolicy(role, opts, phase);
            let result;
            try {
                result = await callSidecar(profile, {
                    ...governed,
                    signal,
                    label: opts.label || `Nexus ${role} Sidecar ${executionSlot}`,
                    telemetry: {
                        ...(governed.telemetry || {}),
                        slot: executionSlot,
                        role,
                        bus: opts.bus || role,
                        routeId: rid,
                        jobId: job.id,
                        parentJobId,
                        attempt: job.attempts,
                        executionMode: opts.executionMode || 'adaptive',
                        phase,
                        queuedAt: job.createdAt || null,
                        queueStartedAt: job.startedAt || null,
                        queueWaitMs: job.startedAt && job.createdAt ? Math.max(0, job.startedAt-job.createdAt) : null,
                    },
                });
                markWorkerSuccess(executionSlot, { profile });
            } catch (error) {
                if (!isIntentionalCancellation(error, signal)) markWorkerFailure(executionSlot, error, { profile });
                throw error;
            }
            result.tv2 = {
                ...(result.tv2 || {}),
                slot: executionSlot,
                role,
                routeId: rid,
                jobId: job.id,
                parentJobId,
                model: requestModel,
                format: requestFormat,
                executionMode: opts.executionMode || 'adaptive',
                phase,
                hardLocked: String(opts.executionMode || '').startsWith('hard-lock'),
            };
            return result;
        }, {
            label: opts.label || `${role} ${phase} on Sidecar ${slot}`,
            priority: opts.priority ?? 50,
            resourceKey: `sidecar:${slot}`,
            preemptible: opts.preemptible !== false,
            maxAttempts: opts.maxAttempts || 1,
            dedupKey: null,
            foregroundAdjacent: opts.foregroundAdjacent === true,
            meta: {
                kind: 'sidecar',
                role,
                preferredSlot,
                assignedSlot: slot,
                assignmentReason: phase,
                offloaded: slot !== preferredSlot,
                routeId: rid,
                parentJobId,
                executionMode: opts.executionMode || 'adaptive',
                phase,
                bus: opts.bus || role,
                nexusPlanId: opts.telemetry?.nexusPlanId || null,
                nexusDirectorJobId: opts.telemetry?.nexusDirectorJobId || null,
                nexusDirectorJobType: opts.telemetry?.nexusDirectorJobType || null,
                recoverableSemanticAttempt: opts.telemetry?.recoverableSemanticAttempt === true,
                dynamicResource: opts.dynamicRehome === true,
                resourceCandidates: opts.dynamicRehome === true
                    ? [...new Set((opts.dynamicCandidateSlots || [slot]).map(value=>String(value||'').toUpperCase()).filter(value=>value==='A'||value==='B'))].map(value=>`sidecar:${value}`)
                    : null,
            },
        });
        const callerAbort = () => { try { job.cancel?.(opts.signal?.reason || Object.assign(new Error('Sidecar work cancelled by caller.'), { name: 'TV2BatchCancelled' })); } catch {} };
        opts.signal?.addEventListener?.('abort', callerAbort, { once: true });
        job.promise.finally(() => opts.signal?.removeEventListener?.('abort', callerAbort)).catch(()=>{});
        if (opts.signal?.aborted) callerAbort();
        recordMultiWorkloadAssignment({
            assignedSlot: slot,
            preferredSlot,
            reason: phase,
            role,
            bus: opts.bus || role,
            routeId: rid,
            jobId: job.id,
            parentJobId,
            executionMode: opts.executionMode || 'adaptive',
            phase,
            label: job.label,
        });
        logEvent('multi-bus', 'phase-enqueued', {
            parentJobId,
            childJobId: job.id,
            routeId: rid,
            role,
            bus: opts.bus || role,
            mode: opts.executionMode || 'adaptive',
            phase,
            slot,
        }, 'debug');
        return job;
    }

    async _runSemanticRecovery(role, mode, opts, handle, rid, errors = {}) {
        const preferred = this.preferredSlot(role);
        const available = enabledSlots(role, opts.bus);
        const slot = available.includes(preferred) ? preferred : available[0];
        if (!slot) {
            const error = new Error(`${modeLabel(mode)} semantic recovery could not run because no Sidecar lane is available.`);
            error.name = 'NexusSemanticRecoveryFailed';
            error.degraded = true;
            throw error;
        }
        const recoveryPrompt = `${String(opts.prompt || '')}\n\nNEXUS SEMANTIC RECOVERY\nThe prior independent attempts failed the required output/domain contract. Re-run the ORIGINAL TASK from source. Do not quote, repair, summarize, or reuse either invalid response. Return only one fresh final payload that satisfies the exact requested schema and candidate constraints.`;
        logEvent('multi-bus', 'semantic-recovery-start', {
            parentJobId: handle.id, routeId: rid, role, mode, slot,
            errors: Object.fromEntries(Object.entries(errors).map(([key, value]) => [key, value?.message || String(value || '')])),
            attemptLimit: 1, rawInvalidCandidatesIncluded: false, reasoningIncluded: false,
        }, 'warn');
        const recoveryJob = this._enqueuePinned(role, slot, {
            ...opts,
            prompt: recoveryPrompt,
            label: `${opts.label || role} · semantic recovery`,
            dedupKey: null,
        }, { routeId: rid, parentJobId: handle.id, phase: 'semantic-recovery', preferredSlot: preferred });
        handle.children.push(recoveryJob.id);
        try {
            const result = await recoveryJob.promise;
            result.tv2 = {
                ...(result.tv2 || {}), role, routeId: rid, parentJobId: handle.id, executionMode: mode,
                multi: { mode, degraded: true, reason: 'semantic-recovery', recoveryAttempts: 1, finalSlot: slot, childJobs: [...handle.children] },
            };
            logEvent('multi-bus', 'semantic-recovery-complete', { parentJobId: handle.id, routeId: rid, role, mode, slot, recoveryJobId: recoveryJob.id }, 'warn');
            return result;
        } catch (cause) {
            if (isIntentionalCancellation(cause) || handle.cancelled) {
                logEvent('multi-bus', 'semantic-recovery-cancelled', { parentJobId: handle.id, routeId: rid, role, mode, slot, recoveryJobId: recoveryJob.id, error: cause }, 'debug');
                throw cause;
            }
            const error = new Error(`${modeLabel(mode)} failed semantic validation on both workers and its one bounded recovery also failed.`);
            error.name = 'NexusSemanticRecoveryFailed';
            error.degraded = true;
            error.cause = cause;
            error.causes = errors;
            logEvent('multi-bus', 'semantic-recovery-failed', { parentJobId: handle.id, routeId: rid, role, mode, slot, recoveryJobId: recoveryJob.id, error: cause }, 'error');
            throw error;
        }
    }

    async _runParallelLike(role, mode, opts, handle, rid) {
        const preferred = this.preferredSlot(role);
        const base = { ...opts, executionMode: mode, assertExecutionFresh: () => {
            if (handle.cancelled) throw handle.cancelReason;
            opts.assertExecutionFresh?.();
        }};
        logEvent('multi-bus', 'fanout-start', {
            parentJobId: handle.id,
            routeId: rid,
            role,
            bus: opts.bus || role,
            mode,
            workers: ['A', 'B'],
        }, 'info');

        const jobA = this._enqueuePinned(role, 'A', { ...base, label: `${opts.label || role} · ${modeLabel(mode)} worker A` }, {
            routeId: rid, parentJobId: handle.id, phase: 'independent-a', preferredSlot: preferred,
        });
        handle.children.push(jobA.id);
        let jobB = null;
        try {
            if (!slotEligible('B', role, opts.bus)) throw workerUnavailableError('B', role, opts.bus);
            jobB = this._enqueuePinned(role, 'B', { ...base, label: `${opts.label || role} · ${modeLabel(mode)} worker B` }, {
                routeId: rid, parentJobId: handle.id, phase: 'independent-b', preferredSlot: preferred,
            });
            handle.children.push(jobB.id);
        } catch (admissionError) {
            if (getSettings().routing?.fallback === false) { jobA.cancel?.(admissionError); throw admissionError; }
            const survivor = await jobA.promise;
            survivor.tv2 = { ...(survivor.tv2 || {}), role, routeId: rid, parentJobId: handle.id, executionMode: mode,
                multi: { mode, degraded: true, workers: ['A','B'], survivorSlot: 'A', admissionFailureSlot: 'B', childJobs: [...handle.children] } };
            logEvent('multi-bus','degraded-second-admission-failed',{parentJobId:handle.id,routeId:rid,role,mode,failedSlot:'B',error:admissionError},'warn');
            return survivor;
        }
        const [settledA, settledB] = await Promise.allSettled([jobA.promise, jobB.promise]);
        base.assertExecutionFresh();
        const resultA = settledValue(settledA);
        const resultB = settledValue(settledB);
        const errorA = settledError(settledA);
        const errorB = settledError(settledB);
        const intentional = [errorA, errorB].find(error => isIntentionalCancellation(error));

        logEvent('multi-bus', 'fanout-complete', {
            parentJobId: handle.id,
            routeId: rid,
            role,
            mode,
            a: resultA ? 'succeeded' : 'failed',
            b: resultB ? 'succeeded' : 'failed',
            errorA,
            errorB,
        }, (resultA && resultB) ? 'info' : 'warn');

        if (intentional) throw intentional;
        if (!resultA && !resultB) {
            const bothSemantic = [errorA, errorB].every(error => error?.name === 'NexusSemanticValidationError' || error?.semantic === true);
            if (bothSemantic && typeof opts.structuredValidator === 'function') {
                return this._runSemanticRecovery(role, mode, opts, handle, rid, { A: errorA, B: errorB });
            }
            const err = new Error(`${modeLabel(mode)} failed because both Sidecars failed.`);
            err.causes = { A: errorA, B: errorB };
            err.degraded = true;
            throw err;
        }
        if (!resultA || !resultB) {
            if (getSettings().routing?.fallback === false) {
                const err = new Error(`${modeLabel(mode)} requires both Sidecars, and degraded completion is disabled.`);
                err.causes = { A: errorA, B: errorB };
                throw err;
            }
            const survivor = resultA || resultB;
            const survivorSlot = resultA ? 'A' : 'B';
            logEvent('multi-bus', 'degraded-single-result', {
                parentJobId: handle.id,
                routeId: rid,
                role,
                mode,
                survivorSlot,
                failedSlot: resultA ? 'B' : 'A',
            }, 'warn');
            survivor.tv2 = {
                ...(survivor.tv2 || {}),
                role,
                routeId: rid,
                parentJobId: handle.id,
                executionMode: mode,
                multi: {
                    mode,
                    degraded: true,
                    workers: ['A', 'B'],
                    survivorSlot,
                    childJobs: [...handle.children],
                },
            };
            return survivor;
        }

        // Parallel and consensus both deliberately finish with one broker-controlled
        // final response so downstream JSON parsers receive exactly one answer.
        try {
        const queue = getJobQueue(getSettings().jobs);
        const decision = chooseWorkloadSlot({
            preferredSlot: preferred,
            enabledSlots: enabledSlots(role, opts.bus),
            queueSnapshot: queue.snapshot(),
            priority: opts.priority ?? 50,
            priorityFloors: {A:queue.resourcePriorityFloor?.('sidecar:A'),B:queue.resourcePriorityFloor?.('sidecar:B')},
            loadBalance: getSettings().routing?.loadBalance !== false,
            priority: opts.priority ?? 50,
            priorityFloors: { A: queue.resourcePriorityFloor?.('sidecar:A') ?? null, B: queue.resourcePriorityFloor?.('sidecar:B') ?? null },
            health: healthSnapshot(),
        });
        const reviewer = decision.assignedSlot || preferred;
        const reviewPhase = mode === SIDECAR_EXECUTION_MODE.CONSENSUS ? 'consensus-review' : 'parallel-synthesis';
        const synthesisPolicy = getNexusSynthesisResourcePolicy(getSettings());
        const candidateTarget = synthesisPolicy.candidateTargetTokens || synthesisPolicy.maxCandidateTokens;
        const promptTarget = synthesisPolicy.promptTargetTokens || synthesisPolicy.maxPromptTokens;
        const candidateA = buildSynthesisCandidate(resultA, {
            parseCandidate: opts.synthesisCandidateParser,
            structured: opts.responseFormat === 'json_object',
            maxTokens: candidateTarget,
            label: 'Sidecar A',
        });
        const candidateB = buildSynthesisCandidate(resultB, {
            parseCandidate: opts.synthesisCandidateParser,
            structured: opts.responseFormat === 'json_object',
            maxTokens: candidateTarget,
            label: 'Sidecar B',
        });
        const synthesisPrompt = buildParallelSynthesisPrompt({
            originalPrompt: opts.prompt,
            candidateA: candidateA.text,
            candidateB: candidateB.text,
            mode,
        });
        const synthesisPromptTokens = estimateContentTokens(synthesisPrompt);
        if (synthesisPolicy.enabled && synthesisPromptTokens > promptTarget) {
            logEvent('multi-bus', 'synthesis-soft-target-exceeded', {
                parentJobId: handle.id, routeId: rid, role, mode, reviewPhase,
                synthesisPromptTokens, promptTargetTokens: promptTarget,
                candidateATokens: candidateA.estimatedTokens,
                candidateBTokens: candidateB.estimatedTokens,
                reason: 'planning-target-exceeded-continue-to-physical-boundary',
            }, 'debug');
        }
        logEvent('multi-bus', 'review-input-prepared', {
            parentJobId: handle.id, routeId: rid, role, mode, reviewPhase,
            rawAChars: String(resultA?.text || '').length, rawBChars: String(resultB?.text || '').length,
            reasoningAChars: String(resultA?.reasoning || '').length, reasoningBChars: String(resultB?.reasoning || '').length,
            candidateAChars: candidateA.text.length, candidateBChars: candidateB.text.length,
            candidateAKind: candidateA.kind, candidateBKind: candidateB.kind,
            candidateATruncated: candidateA.truncated, candidateBTruncated: candidateB.truncated,
            synthesisPromptChars: synthesisPrompt.length, synthesisPromptTokens,
            promptTargetTokens: promptTarget, candidateTargetTokens: candidateTarget,
            reasoningIncluded: false, rawResponseIncluded: false,
        }, 'info');
        logEvent('multi-bus', 'review-assigned', {
            parentJobId: handle.id,
            routeId: rid,
            role,
            mode,
            phase: reviewPhase,
            assignedSlot: reviewer,
            workloadDecision: decision,
        }, 'info');
        const reviewJob = this._enqueuePinned(role, reviewer, {
            ...base,
            prompt: synthesisPrompt,
            systemPrompt: `${opts.systemPrompt || ''}\n\nYou are the Nexus broker-controlled ${reviewPhase}. Return only the final output required by the original task.`.trim(),
            label: `${opts.label || role} · ${modeLabel(mode)} ${reviewPhase}`,
        }, {
            routeId: rid,
            parentJobId: handle.id,
            phase: reviewPhase,
            preferredSlot: preferred,
        });
        handle.children.push(reviewJob.id);
        const final = await reviewJob.promise;
        final.tv2 = {
            ...(final.tv2 || {}),
            role,
            routeId: rid,
            parentJobId: handle.id,
            executionMode: mode,
            multi: {
                mode,
                degraded: false,
                workers: ['A', 'B'],
                reviewerSlot: reviewer,
                childJobs: [...handle.children],
                candidateSlots: ['A', 'B'],
            },
        };
        return final;
        } catch (error) {
            base.assertExecutionFresh();
            if (isIntentionalCancellation(error) || getSettings().routing?.fallback === false) {
                error.workerResults = {A:resultA,B:resultB};
                throw error;
            }
            const survivorSlot = preferred === 'B' ? 'B' : 'A';
            const survivor = survivorSlot === 'A' ? resultA : resultB;
            survivor.tv2 = {...(survivor.tv2||{}),role,routeId:rid,parentJobId:handle.id,executionMode:mode,
                multi:{mode,degraded:true,reason:'review-failed',survivorSlot,candidateSlots:['A','B'],
                    reviewError:String(error?.message||error),childJobs:[...handle.children],
                    candidates:{A:boundedCandidateEvidence(resultA),B:boundedCandidateEvidence(resultB)}}};
            logEvent('multi-bus','degraded-review-failed',{parentJobId:handle.id,role,mode,survivorSlot,error},'warn');
            return survivor;
        }
    }

    async _runCascade(role, mode, opts, handle, rid) {
        const [firstSlot, secondSlot] = mode === SIDECAR_EXECUTION_MODE.CASCADE_BA ? ['B', 'A'] : ['A', 'B'];
        const preferred = this.preferredSlot(role);
        const base = { ...opts, executionMode: mode, assertExecutionFresh: () => {
            if (handle.cancelled) throw handle.cancelReason;
            opts.assertExecutionFresh?.();
        }};
        logEvent('multi-bus', 'cascade-start', {
            parentJobId: handle.id,
            routeId: rid,
            role,
            bus: opts.bus || role,
            mode,
            firstSlot,
            secondSlot,
        }, 'info');

        const firstJob = this._enqueuePinned(role, firstSlot, {
            ...base,
            label: `${opts.label || role} · ${modeLabel(mode)} first pass`,
        }, { routeId: rid, parentJobId: handle.id, phase: 'cascade-first', preferredSlot: preferred });
        handle.children.push(firstJob.id);
        let firstResult;
        try {
            firstResult = await firstJob.promise;
        } catch (firstError) {
            if (isIntentionalCancellation(firstError)) throw firstError;
            if (getSettings().routing?.fallback === false || !slotEligible(secondSlot, role, opts.bus)) throw firstError;
            if (!shouldRetrySidecarFailure({
                error: firstError,
                failedProfile: firstJob._nexusAttemptProfile || { ...getSidecarProfile(firstSlot) },
                nextProfile: { ...getSidecarProfile(secondSlot) },
            })) {
                logEvent('multi-bus', 'cascade-fallback-skipped-identical-profile', {
                    parentJobId: handle.id, routeId: rid, role, mode, firstSlot, secondSlot, error: firstError,
                }, 'warn');
                throw firstError;
            }
            recordWorkloadFallback({
                role,
                bus: opts.bus || role,
                routeId: rid,
                jobId: handle.id,
                fromSlot: firstSlot,
                toSlot: secondSlot,
                reason: 'cascade-first-worker-failed',
            });
            logEvent('multi-bus', 'cascade-degraded-first-failed', {
                parentJobId: handle.id,
                routeId: rid,
                role,
                mode,
                failedSlot: firstSlot,
                fallbackSlot: secondSlot,
                error: firstError,
            }, 'warn');
            const fallbackJob = this._enqueuePinned(role, secondSlot, {
                ...base,
                label: `${opts.label || role} · cascade degraded fallback`,
            }, { routeId: rid, parentJobId: handle.id, phase: 'cascade-first-failure-fallback', preferredSlot: preferred });
            handle.children.push(fallbackJob.id);
            const fallback = await fallbackJob.promise;
            fallback.tv2 = {
                ...(fallback.tv2 || {}),
                role,
                routeId: rid,
                parentJobId: handle.id,
                executionMode: mode,
                multi: { mode, degraded: true, failedSlot: firstSlot, finalSlot: secondSlot, childJobs: [...handle.children] },
            };
            return fallback;
        }

        const synthesisPolicy = getNexusSynthesisResourcePolicy(getSettings());
        const candidateTarget = synthesisPolicy.candidateTargetTokens || synthesisPolicy.maxCandidateTokens;
        const promptTarget = synthesisPolicy.promptTargetTokens || synthesisPolicy.maxPromptTokens;
        const firstCandidate = buildSynthesisCandidate(firstResult, {
            parseCandidate: opts.synthesisCandidateParser,
            structured: opts.responseFormat === 'json_object',
            maxTokens: candidateTarget,
            label: `Sidecar ${firstSlot}`,
        });
        const handoffPrompt = buildCascadePrompt({
            originalPrompt: opts.prompt,
            firstSlot,
            secondSlot,
            firstCandidate: firstCandidate.text,
        });
        const handoffPromptTokens = estimateContentTokens(handoffPrompt);
        if (synthesisPolicy.enabled && handoffPromptTokens > promptTarget) {
            logEvent('multi-bus', 'cascade-soft-target-exceeded', {
                parentJobId: handle.id, routeId: rid, role, mode, firstSlot, secondSlot,
                handoffPromptTokens, promptTargetTokens: promptTarget,
                candidateTokens: firstCandidate.estimatedTokens,
                reason: 'planning-target-exceeded-continue-to-physical-boundary',
            }, 'debug');
        }
        logEvent('multi-bus', 'handoff-created', {
            parentJobId: handle.id,
            routeId: rid,
            role,
            mode,
            fromSlot: firstSlot,
            toSlot: secondSlot,
            firstResponseChars: String(firstResult?.text || '').length,
            firstReasoningChars: String(firstResult?.reasoning || '').length,
            handoffCandidateChars: firstCandidate.text.length,
            handoffCandidateKind: firstCandidate.kind,
            handoffCandidateTruncated: firstCandidate.truncated,
            handoffCandidateTargetTokens: candidateTarget,
            handoffPromptTokens, promptTargetTokens: promptTarget,
            reasoningIncluded: false,
        }, 'info');
        let secondJob;
        try {
            base.assertExecutionFresh();
            if (!slotEligible(secondSlot, role, opts.bus)) throw workerUnavailableError(secondSlot, role, opts.bus);
            secondJob = this._enqueuePinned(role, secondSlot, {
            ...base,
            prompt: handoffPrompt,
            systemPrompt: `${opts.systemPrompt || ''}\n\nYou are the second worker in a Nexus broker-controlled cascade. Verify the first worker and return only the final format requested by the original task.`.trim(),
            label: `${opts.label || role} · ${modeLabel(mode)} second pass`,
        }, { routeId: rid, parentJobId: handle.id, phase: 'cascade-second', preferredSlot: preferred });
            handle.children.push(secondJob.id);
        } catch (admissionError) {
            if (isIntentionalCancellation(admissionError) || getSettings().routing?.fallback === false) throw admissionError;
            base.assertExecutionFresh();
            firstResult.tv2 = { ...(firstResult.tv2 || {}), role, routeId: rid, parentJobId: handle.id, executionMode: mode,
                multi: { mode, degraded: true, reason: 'cascade-second-admission-failed', failedSlot: secondSlot, finalSlot: firstSlot, childJobs: [...handle.children] } };
            logEvent('multi-bus','cascade-degraded-second-admission-failed',{parentJobId:handle.id,routeId:rid,role,mode,failedSlot:secondSlot,survivingSlot:firstSlot,error:admissionError},'warn');
            return firstResult;
        }
        try {
            const final = await secondJob.promise;
            final.tv2 = {
                ...(final.tv2 || {}),
                role,
                routeId: rid,
                parentJobId: handle.id,
                executionMode: mode,
                multi: {
                    mode,
                    degraded: false,
                    firstSlot,
                    finalSlot: secondSlot,
                    childJobs: [...handle.children],
                },
            };
            return final;
        } catch (secondError) {
            base.assertExecutionFresh();
            if (isIntentionalCancellation(secondError)) throw secondError;
            if (getSettings().routing?.fallback === false) throw secondError;
            // The first pass is already a valid response to the original task; preserve
            // it rather than rerunning recursively through the failed second worker.
            recordWorkloadFallback({
                role,
                bus: opts.bus || role,
                routeId: rid,
                jobId: handle.id,
                fromSlot: secondSlot,
                toSlot: firstSlot,
                reason: 'cascade-second-worker-failed-return-first-pass',
            });
            logEvent('multi-bus', 'cascade-degraded-second-failed', {
                parentJobId: handle.id,
                routeId: rid,
                role,
                mode,
                failedSlot: secondSlot,
                survivingSlot: firstSlot,
                error: secondError,
            }, 'warn');
            firstResult.tv2 = {
                ...(firstResult.tv2 || {}),
                role,
                routeId: rid,
                parentJobId: handle.id,
                executionMode: mode,
                multi: { mode, degraded: true, failedSlot: secondSlot, finalSlot: firstSlot, childJobs: [...handle.children] },
            };
            return firstResult;
        }
    }

    _enqueueMulti(role, mode, opts = {}) {
        const rid = opts.routeId || routeId(role);
        const dedupKey = opts.dedupKey ? `multi:${role}:${mode}:${opts.dedupKey}` : null;
        { const existing = liveInFlight(multiInFlight, dedupKey); if (existing) return existing; }

        const available = enabledSlots(role, opts.bus);
        if (available.length < 2) {
            if (getSettings().routing?.fallback === false) {
                const error = new Error(`Nexus ${modeLabel(mode)} requires both Sidecars; only ${available.join(', ') || 'none'} is available and fallback/degradation is disabled.`);
                error.name = 'TV2MultiWorkerUnavailable';
                throw error;
            }
            logEvent('multi-bus', 'mode-degraded-missing-worker', {
                role,
                routeId: rid,
                requestedMode: mode,
                enabledSlots: available,
                action: 'adaptive-single-worker',
            }, 'warn');
            return this._enqueueAdaptive(role, { ...opts, routeId: rid });
        }

        const handle = {
            id: multiJobId(role),
            label: opts.label || `${role} · ${modeLabel(mode)}`,
            state: 'queued',
            mode,
            routeId: rid,
            children: [],
            meta: { kind: 'multi-sidecar', role, mode, routeId: rid, bus: opts.bus || role },
            promise: null,
            cancelled: false,
            cancelReason: null,
            cancel: null,
        };
        handle.cancel = (reason = 'Nexus multi-Sidecar work cancelled.') => {
            if (handle.cancelled || ['succeeded', 'failed', 'cancelled'].includes(handle.state)) return false;
            const error = reason instanceof Error ? reason : Object.assign(new Error(String(reason || 'Nexus multi-Sidecar work cancelled.')), { name: 'TV2BatchCancelled' });
            if (!error.name || error.name === 'Error') error.name = 'TV2BatchCancelled';
            handle.cancelled = true;
            handle.cancelReason = error;
            handle.state = 'cancelled';
            releaseInFlight(multiInFlight,dedupKey,handle);
            const queue = getJobQueue(getSettings().jobs);
            queue.cancelWhere(job => job?.meta?.parentJobId === handle.id || handle.children.includes(job.id), error);
            return true;
        };
        const abortMultiFromCaller=()=>handle.cancel(opts.signal?.reason||Object.assign(new Error('Multi-Sidecar work cancelled by caller.'),{name:'TV2BatchCancelled'}));
        opts.signal?.addEventListener?.('abort',abortMultiFromCaller,{once:true});
        logEvent('multi-bus', 'multi-job-created', {
            parentJobId: handle.id,
            routeId: rid,
            role,
            bus: opts.bus || role,
            mode,
            modeLabel: modeLabel(mode),
            preferredSlot: this.preferredSlot(role),
        }, 'info');
        handle.state = 'running';
        const runner = mode === SIDECAR_EXECUTION_MODE.CASCADE_AB || mode === SIDECAR_EXECUTION_MODE.CASCADE_BA
            ? this._runCascade(role, mode, opts, handle, rid)
            : this._runParallelLike(role, mode, opts, handle, rid);
        handle.promise = Promise.resolve(runner)
            .then(result => {
                if (handle.cancelled) throw handle.cancelReason || Object.assign(new Error('Nexus multi-Sidecar work cancelled.'), { name: 'TV2BatchCancelled' });
                handle.state = 'succeeded';
                logEvent('multi-bus', 'multi-job-succeeded', {
                    parentJobId: handle.id,
                    routeId: rid,
                    role,
                    mode,
                    finalSlot: result?.tv2?.slot || null,
                    childJobs: [...handle.children],
                    degraded: result?.tv2?.multi?.degraded === true,
                }, 'info');
                return result;
            })
            .catch(error => {
                const intentional = isIntentionalCancellation(error) || handle.cancelled;
                handle.state = intentional ? 'cancelled' : 'failed';
                logEvent('multi-bus', intentional ? 'multi-job-cancelled' : 'multi-job-failed', {
                    parentJobId: handle.id,
                    routeId: rid,
                    role,
                    mode,
                    childJobs: [...handle.children],
                    error,
                }, intentional ? 'debug' : 'error');
                throw error;
            })
            .finally(() => {
                opts.signal?.removeEventListener?.('abort',abortMultiFromCaller);
                releaseInFlight(multiInFlight,dedupKey,handle);
            });
        if (dedupKey) multiInFlight.set(dedupKey, handle);
        return handle;
    }


    _enqueueBatch(role, batches = [], opts = {}) {
        const list = Array.isArray(batches) ? batches.filter(Boolean) : [];
        if (!list.length) throw new Error(`Nexus ${role} batch dispatch requires at least one batch.`);

        const settings = getSettings();
        const rid = opts.routeId || routeId(role);
        const configuredPreferred = this.preferredSlot(role);
        const requestedStart = String(opts.startSlot || '').toUpperCase();
        const preferred = ['A','B'].includes(requestedStart) ? requestedStart : configuredPreferred;
        const forced = String(opts.forceSlot || '').toUpperCase();
        const locked = ['A','B'].includes(forced) ? forced : this.lockedSlot(role);
        const mode = this.executionMode(role, opts.executionMode);
        if (!locked && isMultiExecutionMode(mode)) {
            const err = new Error(`Nexus batch scatter is only available in Adaptive retrieval mode. Current ${role} mode is ${mode}.`);
            err.code = 'TV2_BATCH_MULTI_MODE_CONFLICT';
            logEvent('batch-bus', 'batch-mode-conflict', { role, bus: opts.bus || role, routeId: rid, mode }, 'warn');
            throw err;
        }

        const dedupKey = opts.dedupKey ? `batch:${role}:${opts.bus || role}:${locked || 'adaptive'}:${mode}:${opts.dedupKey}` : null;
        { const existing = liveInFlight(batchInFlight, dedupKey); if (existing) return existing; }
        if (opts.signal?.aborted) throw opts.signal.reason || Object.assign(new Error('Nexus Sidecar batch cancelled before admission.'), { name: 'TV2BatchCancelled' });
        const available = enabledSlots(role, opts.bus);
        let workers;
        if (locked) workers = available.includes(locked) ? [locked] : [];
        else if (settings.routing?.loadBalance === false) workers = available.includes(preferred) ? [preferred] : available.slice(0, 1);
        else workers = [preferred, other(preferred)].filter((slot, index, arr) => available.includes(slot) && arr.indexOf(slot) === index);
        if (!workers.length) throw new Error(`No enabled Nexus Sidecar is available for ${role} batch dispatch.`);

        // Automatic Builder scatter must not make a configured preference into
        // permanent first-slice ownership. Alternate the lead lane across
        // parent treeBuild batches while preserving explicit startSlot, hard
        // locks, single-worker operation, and all non-Builder routing.
        let scatterLeadSlot = workers[0] || null;
        const fairTreeScatter = role === 'treeBuild'
            && !locked
            && settings.routing?.loadBalance !== false
            && !['A','B'].includes(requestedStart)
            && workers.length > 1
            && list.length > 1;
        if (fairTreeScatter) {
            treeBuildScatterSeq += 1;
            const rotatedLead = treeBuildScatterLead(preferred, treeBuildScatterSeq);
            workers = [rotatedLead, ...workers.filter(slot => slot !== rotatedLead)];
            scatterLeadSlot = workers[0];
            logEvent('batch-bus', 'batch-scatter-lead-rotated', {
                role, bus: opts.bus || role, routeId: rid,
                configuredPreferred, scatterLeadSlot, scatterSequence: treeBuildScatterSeq,
                reason: 'automatic treeBuild scatter alternates first-slice ownership',
            }, 'debug');
        }

        const queue = getJobQueue(settings.jobs);
        const snapshot = queue.snapshot();
        if (!locked && settings.routing?.loadBalance !== false) {
            const runnable = workers.filter(slot=>{
                const floor=queue.resourcePriorityFloor?.(`sidecar:${slot}`);
                return !Number.isFinite(floor) || (opts.priority??50)>=floor;
            });
            if (runnable.length) workers=runnable;
        }
        scatterLeadSlot = workers[0] || null;
        const queueLoads = {
            A: summarizeSidecarLoad(snapshot, 'A'),
            B: summarizeSidecarLoad(snapshot, 'B'),
        };
        if (!locked && settings.routing?.loadBalance !== false && list.length === 1 && workers.length > 1) {
            const singleDecision = chooseWorkloadSlot({
                preferredSlot: preferred,
                enabledSlots: workers,
                queueSnapshot: snapshot,
                priority: opts.priority ?? 50,
                priorityFloors: { A: queue.resourcePriorityFloor?.('sidecar:A') ?? null, B: queue.resourcePriorityFloor?.('sidecar:B') ?? null },
                loadBalance: true,
                health: healthSnapshot(),
            });
            if (singleDecision.assignedSlot) workers = [singleDecision.assignedSlot, ...workers.filter(slot => slot !== singleDecision.assignedSlot)];
        }
        const scatter = describeInitialScatter({ slots: workers, batchCount: list.length, queueLoads });
        const handle = {
            id: batchJobId(role),
            label: opts.label || `${role} batch scatter`,
            state: 'queued',
            routeId: rid,
            mode: locked ? 'hard-lock-batch' : 'batch-scatter',
            children: [],
            cancelled: false,
            cancelReason: null,
            meta: {
                kind: 'batch-sidecar', role, routeId: rid, bus: opts.bus || role,
                batchCount: list.length, workers: [...workers], authoritySlots: list.length === 1 ? [workers[0]] : [...workers], assignedSlot: list.length === 1 ? workers[0] : null, dualIdle: scatter.dualIdle, scatterLeadSlot,
            },
            promise: null,
            cancel: null,
        };
        handle.cancel = (reason = 'Nexus Sidecar batch cancelled.') => {
            if (handle.cancelled || ['succeeded','degraded','failed','cancelled'].includes(handle.state)) return false;
            const error = reason instanceof Error ? reason : Object.assign(new Error(String(reason || 'Nexus Sidecar batch cancelled.')), { name: 'TV2BatchCancelled' });
            if (!error.name || error.name === 'Error') error.name = 'TV2BatchCancelled';
            handle.cancelled = true;
            handle.cancelReason = error;
            handle.state = 'cancelled';
            releaseInFlight(batchInFlight,dedupKey,handle);
            for (const childId of [...handle.children]) queue.cancel(childId, error);
            logEvent('batch-bus', 'batch-job-cancelled', { parentJobId: handle.id, routeId: rid, role, childJobs: [...handle.children], error }, 'warn');
            return true;
        };

        const abortBatchFromCaller = () => handle.cancel(opts.signal?.reason || Object.assign(new Error('Nexus Sidecar batch cancelled by caller.'), { name: 'TV2BatchCancelled' }));
        opts.signal?.addEventListener?.('abort', abortBatchFromCaller, { once: true });

        const cancelledSlices = new Map();
        const settledSlices = new Set();
        const sliceChildren = new Map();
        handle.cancelSlice = (index, reason = 'Nexus batch slice cancelled.') => {
            if (!Number.isInteger(index) || index < 0 || index >= list.length || cancelledSlices.has(index) || settledSlices.has(index) || ['succeeded','degraded','failed','cancelled'].includes(handle.state)) return false;
            const error = reason instanceof Error ? reason : Object.assign(new Error(String(reason)), {name:'TV2BatchCancelled'});
            cancelledSlices.set(index,error);
            for (const id of sliceChildren.get(index)||[]) queue.cancel(id,error);
            return true;
        };
        handle.cancelIndex = handle.cancelSlice;

        logEvent('batch-bus', 'batch-job-created', {
            parentJobId: handle.id,
            routeId: rid,
            role,
            bus: opts.bus || role,
            batchCount: list.length,
            workers,
            preferredSlot: preferred,
            scatterLeadSlot,
            hardLocked: !!locked,
            dualIdleScatter: scatter.dualIdle,
            queueLoads,
            allowPartial: opts.allowPartial === true,
        }, 'info');

        // Reserve the batch workers at the parent's priority before any child is
        // dispatched. This closes the admission race where a lower-priority
        // foreground recall could claim B between batch slices merely because the
        // next child had not reached the JobQueue yet. Reservations are priority
        // floors, not resource locks: equal/higher-priority jobs remain eligible.
        const batchPriority = Number.isFinite(opts.priority) ? opts.priority : 50;
        // Reserve only when a physical slice is assigned to a worker; release
        // when the pool has no more eligible work for that worker.
        logEvent('batch-bus', 'worker-priority-reserved', {
            parentJobId: handle.id, routeId: rid, role, bus: opts.bus || role,
            workers, priority: batchPriority,
        }, 'debug');

        // Parent-batch backend circuit: a single timeout may be transient, so
        // normal cross-slot fallback remains legal. If two distinct workers on
        // the same endpoint/model both time out in this parent batch, Nexus has
        // enough evidence to stop sibling slices from rediscovering the same
        // 75s failure. The circuit is local to this parent and never disables a
        // Sidecar globally or blocks materially different backends.
        const attemptProfiles = new Map();
        const attemptKey = (index, attempt, slot) => `${index}:${attempt}:${String(slot || '').toUpperCase()}`;
        const backendTimeoutEvidence = new Map();
        const openBatchBackends = new Set();
        const evidenceFor = key => {
            if (!backendTimeoutEvidence.has(key)) backendTimeoutEvidence.set(key, { consecutiveTimeouts: 0, slots: new Set() });
            return backendTimeoutEvidence.get(key);
        };
        const noteParentBatchSuccess = ({ slot, index = null, attempt = null } = {}) => {
            const profile = attemptProfiles.get(attemptKey(index, attempt, slot)) || { ...getSidecarProfile(slot) };
            const key = backendKey(profile);
            if (!key) return;
            const evidence = evidenceFor(key);
            evidence.consecutiveTimeouts = 0;
            evidence.slots.clear();
            openBatchBackends.delete(key);
        };
        const noteParentBatchFailure = ({ slot, error, index = null, attempt = null } = {}) => {
            if (!isBatchTimeoutFailure(error)) return;
            const profile = attemptProfiles.get(attemptKey(index, attempt, slot)) || { ...getSidecarProfile(slot) };
            const key = backendKey(profile);
            if (!key) return;
            const evidence = evidenceFor(key);
            evidence.consecutiveTimeouts += 1;
            evidence.slots.add(String(slot || '').toUpperCase());
            // Two consecutive timeouts are sufficient even in a one-worker
            // deployment. Intervening successes reset this evidence.
            if (evidence.consecutiveTimeouts < 2 || openBatchBackends.has(key)) return;
            openBatchBackends.add(key);
            const backend = normalizedBackend(profile);
            logEvent('batch-bus', 'parent-backend-circuit-open', {
                parentJobId: handle.id, routeId: rid, role, bus: opts.bus || role,
                batchIndex: index, workers: [...evidence.slots], backend,
                consecutiveTimeouts: evidence.consecutiveTimeouts,
                reason: 'same backend produced two consecutive parent-batch timeouts',
            }, 'error');
        };
        const parentBatchRetryPolicy = ({ slot, error, attemptedSlots = [], workers: retryWorkers = [], index = null, attempt = null } = {}) => {
            if (isIntentionalCancellation(error)) return false;
            noteParentBatchFailure({ slot, error, index, attempt });
            const failedProfile = attemptProfiles.get(attemptKey(index, attempt, slot)) || { ...getSidecarProfile(slot) };
            const remaining = retryWorkers.filter(worker => !attemptedSlots.includes(worker));
            return remaining.some(worker => {
                const nextProfile = getSidecarProfile(worker);
                const key = backendKey(nextProfile);
                if (key && openBatchBackends.has(key)) {
                    logEvent('batch-bus', 'parent-backend-circuit-skip', {
                        parentJobId: handle.id, routeId: rid, role, bus: opts.bus || role,
                        batchIndex: index, failedSlot: slot, skippedSlot: worker,
                        backend: normalizedBackend(nextProfile),
                    }, 'warn');
                    return false;
                }
                return shouldRetrySidecarFailure({ error, failedProfile, nextProfile });
            });
        };

        // Builder scatter evaluates workers by live task quality, not just HTTP
        // health. Transport health remains global; these statistics and the
        // rehabilitation state are scoped to this parent batch/profile so a
        // model that is poor at Builder JSON does not get globally quarantined
        // from unrelated Nexus workloads. A deprioritized worker may still
        // rescue an already-attempted slice. Fresh work re-enters through a
        // bounded probe instead of remaining excluded for the whole batch.
        const workerQuality = new Map(workers.map(slot => [slot, {
            profileKey: profileHealthKey(getSidecarProfile(slot)),
            durations: [], successes: 0, failures: 0, semanticFailures: 0,
        }]));
        const workerAdmission = new Map(workers.map(slot => [slot, {
            status: 'active', reason: null, deprioritizedAt: 0,
            peerSuccessesSinceDemotion: 0, backoffLevel: 0,
            probeStartedAt: 0, lastProbeReason: null,
        }]));
        const median = values => {
            const rows = [...values].filter(Number.isFinite).sort((a,b)=>a-b);
            if (!rows.length) return null;
            const mid = Math.floor(rows.length / 2);
            return rows.length % 2 ? rows[mid] : (rows[mid-1] + rows[mid]) / 2;
        };
        const semanticFailure = error => error?.name === 'NexusSemanticValidationError' || error?.semantic === true;
        const builderTransportFailure = error => !semanticFailure(error) && healthRelevantFailure(error);
        const qualitySnapshotFor = slot => {
            const row = workerQuality.get(slot) || { durations: [], successes: 0, failures: 0, semanticFailures: 0, profileKey: null };
            const attempts = row.successes + row.failures;
            return {
                profileKey: row.profileKey, attempts, successes: row.successes, failures: row.failures, semanticFailures: row.semanticFailures,
                semanticFailureRate: attempts ? row.semanticFailures / attempts : 0,
                latencySamples: row.durations.length,
                medianLatencyMs: median(row.durations),
            };
        };
        const admissionSnapshotFor = slot => {
            const state = workerAdmission.get(slot) || {};
            const policy = treeBuildWorkerProbePolicy(state.backoffLevel || 0);
            return {
                status: state.status || 'active',
                reason: state.reason || null,
                deprioritizedAt: Number(state.deprioritizedAt || 0),
                peerSuccessesSinceDemotion: Number(state.peerSuccessesSinceDemotion || 0),
                backoffLevel: Number(state.backoffLevel || 0),
                requiredPeerSuccesses: policy.requiredPeerSuccesses,
                cooldownMs: policy.cooldownMs,
                probeStartedAt: Number(state.probeStartedAt || 0),
                lastProbeReason: state.lastProbeReason || null,
            };
        };
        const bestPeerSnapshotFor = slot => {
            const peers = workers.filter(other => other !== slot).map(qualitySnapshotFor);
            return peers.reduce((best, row) => {
                if (!best) return row;
                if (row.semanticFailureRate !== best.semanticFailureRate) return row.semanticFailureRate < best.semanticFailureRate ? row : best;
                const rowLatency = Number.isFinite(row.medianLatencyMs) ? row.medianLatencyMs : Infinity;
                const bestLatency = Number.isFinite(best.medianLatencyMs) ? best.medianLatencyMs : Infinity;
                return rowLatency < bestLatency ? row : best;
            }, null);
        };
        const resetQualityAfterRecovery = (slot, durationMs = null) => {
            const row = workerQuality.get(slot);
            if (!row) return;
            row.durations = Number.isFinite(durationMs) ? [durationMs] : [];
            row.successes = 1;
            row.failures = 0;
            row.semanticFailures = 0;
        };
        const deprioritizeWorker = (slot, reason, own, peer, { increaseBackoff = false, probeReason = null } = {}) => {
            const state = workerAdmission.get(slot);
            if (!state) return;
            if (increaseBackoff) state.backoffLevel = Math.min(2, Number(state.backoffLevel || 0) + 1);
            const policy = treeBuildWorkerProbePolicy(state.backoffLevel || 0);
            state.status = 'deprioritized';
            state.reason = reason || 'quality';
            state.deprioritizedAt = Date.now();
            state.peerSuccessesSinceDemotion = 0;
            state.probeStartedAt = 0;
            state.lastProbeReason = probeReason || state.lastProbeReason || null;
            logEvent('batch-bus', probeReason ? 'batch-worker-probe-failed' : 'batch-worker-deprioritized', {
                parentJobId: handle.id, routeId: rid, role, bus: opts.bus || role, slot,
                profileKey: own?.profileKey || qualitySnapshotFor(slot).profileKey,
                peerProfileKey: peer?.profileKey || null,
                attempts: own?.attempts ?? qualitySnapshotFor(slot).attempts,
                semanticFailures: own?.semanticFailures ?? qualitySnapshotFor(slot).semanticFailures,
                semanticFailureRate: Number((own?.semanticFailureRate ?? qualitySnapshotFor(slot).semanticFailureRate).toFixed(3)),
                medianLatencyMs: Number.isFinite(own?.medianLatencyMs) ? Math.round(own.medianLatencyMs) : null,
                peerSemanticFailureRate: Number((peer?.semanticFailureRate || 0).toFixed(3)),
                peerMedianLatencyMs: Number.isFinite(peer?.medianLatencyMs) ? Math.round(peer.medianLatencyMs) : null,
                reason: reason || 'quality',
                probeReason,
                backoffLevel: state.backoffLevel,
                requiredPeerSuccesses: policy.requiredPeerSuccesses,
                cooldownMs: policy.cooldownMs,
            }, 'warn');
        };
        const reconsiderWorkerQuality = () => {
            if (role !== 'treeBuild' || workers.length < 2) return;
            for (const candidate of workers) {
                const admission = workerAdmission.get(candidate);
                if (!admission || admission.status !== 'active') continue;
                const own = qualitySnapshotFor(candidate);
                const peer = bestPeerSnapshotFor(candidate);
                if (!peer) continue;
                const qualityDecision = evaluateTreeBuildWorkerQuality(own, peer);
                if (!qualityDecision.deprioritize) continue;
                deprioritizeWorker(candidate, qualityDecision.reason, own, peer);
            }
        };
        const notePeerProgress = (completedSlot, attempt, success) => {
            if (role !== 'treeBuild' || !success || Number(attempt) !== 1) return;
            for (const slot of workers) {
                if (slot === completedSlot) continue;
                const state = workerAdmission.get(slot);
                if (state?.status === 'deprioritized') state.peerSuccessesSinceDemotion += 1;
            }
        };
        const noteWorkerOutcome = (slot, { durationMs = null, error = null, success = false, attempt = 1 } = {}) => {
            if (role !== 'treeBuild') return;
            const row = workerQuality.get(slot);
            const admission = workerAdmission.get(slot);
            if (!row || !admission) return;
            if (Number.isFinite(durationMs)) { row.durations.push(durationMs); if (row.durations.length > 8) row.durations.shift(); }
            if (success) row.successes += 1;
            else { row.failures += 1; if (semanticFailure(error)) row.semanticFailures += 1; }
            notePeerProgress(slot, attempt, success);

            // HOTFIX15: Builder's parent batch must not hand a fresh slice back
            // to a lane that just consumed a full timeout/network failure. This
            // is deliberately local to treeBuild admission; global Sidecar health
            // keeps its established two-timeout circuit contract. The lane can
            // re-enter through the existing bounded probe lifecycle after peer
            // progress or cooldown.
            if (!success && Number(attempt) === 1 && admission.status === 'active' && builderTransportFailure(error)) {
                const peer = bestPeerSnapshotFor(slot) || {};
                deprioritizeWorker(slot, 'transport-failure', qualitySnapshotFor(slot), peer);
                return;
            }

            if (admission.status === 'probing' && Number(attempt) === 1) {
                const peer = bestPeerSnapshotFor(slot) || {};
                const probeDecision = evaluateTreeBuildWorkerProbe({
                    success,
                    durationMs,
                    semanticFailure: semanticFailure(error),
                }, peer);
                if (probeDecision.recover) {
                    admission.status = 'active';
                    admission.reason = null;
                    admission.deprioritizedAt = 0;
                    admission.peerSuccessesSinceDemotion = 0;
                    admission.backoffLevel = 0;
                    admission.probeStartedAt = 0;
                    admission.lastProbeReason = probeDecision.reason;
                    resetQualityAfterRecovery(slot, durationMs);
                    logEvent('batch-bus', 'batch-worker-recovered', {
                        parentJobId: handle.id, routeId: rid, role, bus: opts.bus || role, slot,
                        durationMs, peerMedianLatencyMs: probeDecision.peerMedianLatencyMs,
                        latencyThresholdMs: probeDecision.latencyThresholdMs,
                        reason: probeDecision.reason,
                    }, 'info');
                } else {
                    deprioritizeWorker(slot, admission.reason || 'quality', qualitySnapshotFor(slot), peer, {
                        increaseBackoff: true,
                        probeReason: probeDecision.reason,
                    });
                }
                return;
            }
            reconsiderWorkerQuality();
        };
        const probeEligibilityFor = slot => {
            const state = workerAdmission.get(slot);
            if (!state || state.status !== 'deprioritized') return { eligible: false };
            return shouldProbeTreeBuildWorker({
                peerSuccessesSinceDemotion: state.peerSuccessesSinceDemotion,
                deprioritizedAt: state.deprioritizedAt,
                backoffLevel: state.backoffLevel,
                now: Date.now(),
            });
        };
        const isWorkerEligible = ({ slot, item }) => {
            const state = workerAdmission.get(slot);
            if (!state || state.status === 'active') return true;
            // Failed-slice rescue remains legal even while fresh work is gated.
            if (item?.attempts?.length) return true;
            if (state.status === 'probing') return false;
            const probe = probeEligibilityFor(slot);
            if (probe.eligible) return true;
            // Never deadlock a parent if every worker is quality-deprioritized.
            // Prefer the lane that has waited longest instead of blindly forcing
            // the scatter lead; otherwise a just-timed-out lead could be probed
            // again immediately while an older demoted peer is ready to re-enter.
            const noActiveWorkers = workers.every(worker => workerAdmission.get(worker)?.status !== 'active');
            if (!noActiveWorkers) return false;
            const forcedProbeSlot = [...workers].sort((a,b) =>
                Number(workerAdmission.get(a)?.deprioritizedAt || 0) - Number(workerAdmission.get(b)?.deprioritizedAt || 0))[0];
            return slot === forcedProbeSlot;
        };

        handle.state = 'running';
        const poolPromise = runBatchPool({
            batches: list,
            slots: workers,
            fallback: !locked && settings.routing?.fallback !== false,
            allowPartial: opts.allowPartial === true,
            shouldRetry: parentBatchRetryPolicy,
            isWorkerEligible,
            onWorkerIdle: slot => queue.releaseResourcePriority(`sidecar:${slot}`,handle.id),
            dispatch: ({ slot, index, batch, attempt }) => {
                opts.assertExecutionFresh?.();
                if (cancelledSlices.has(index)) throw cancelledSlices.get(index);
                if (handle.cancelled) throw handle.cancelReason || Object.assign(new Error('Nexus Sidecar batch cancelled.'), { name: 'TV2BatchCancelled' });
                const attemptProfile = { ...getSidecarProfile(slot) };
                attemptProfiles.set(attemptKey(index, attempt, slot), attemptProfile);
                const slotBackendKey = backendKey(attemptProfile);
                if (slotBackendKey && openBatchBackends.has(slotBackendKey)) {
                    const error = Object.assign(new Error(`Nexus parent batch backend circuit is open for Sidecar ${slot}.`), {
                        name: 'NexusParentBatchBackendCircuitOpen',
                        backendBound: true,
                    });
                    logEvent('batch-bus', 'parent-backend-circuit-fast-fail', {
                        parentJobId: handle.id, routeId: rid, role, bus: opts.bus || role,
                        batchIndex: index, slot, backend: normalizedBackend(attemptProfile),
                    }, 'warn');
                    throw error;
                }
                queue.reserveResourcePriority(`sidecar:${slot}`,batchPriority,handle.id);
                const child = this._enqueuePinned(role, slot, {
                    ...opts,
                    ...batch,
                    assertExecutionFresh: () => {
                        opts.assertExecutionFresh?.();
                        if (handle.cancelled) throw handle.cancelReason;
                        if (cancelledSlices.has(index)) throw cancelledSlices.get(index);
                        batch.assertExecutionFresh?.();
                    },
                    executionMode: locked ? 'hard-lock-batch' : 'batch-scatter',
                    dedupKey: null,
                    label: batch.label || `${opts.label || role} · batch ${index + 1}/${list.length}`,
                    telemetry: {
                        ...(opts.telemetry || {}),
                        ...(batch.telemetry || {}),
                        batchParentJobId: handle.id,
                        batchIndex: index,
                        batchNumber: index + 1,
                        batchCount: list.length,
                        batchAttempt: attempt,
                    },
                }, {
                    routeId: rid,
                    parentJobId: handle.id,
                    phase: `batch-${index + 1}-attempt-${attempt}`,
                    preferredSlot: preferred,
                });
                handle.children.push(child.id);
                if (!sliceChildren.has(index)) sliceChildren.set(index,[]);
                sliceChildren.get(index).push(child.id);
                if (handle.cancelled) child.cancel?.(handle.cancelReason || 'Nexus Sidecar batch cancelled.');
                logEvent('batch-bus', 'batch-child-enqueued', {
                    parentJobId: handle.id, childJobId: child.id, routeId: rid, role,
                    bus: opts.bus || role, batchIndex: index, batchNumber: index + 1,
                    batchCount: list.length, slot, attempt,
                }, 'debug');
                return Promise.resolve(child.promise).then(
                    value => {
                        if (child._nexusAttemptProfile) attemptProfiles.set(attemptKey(index, attempt, slot), child._nexusAttemptProfile);
                        return value;
                    },
                    error => {
                        if (child._nexusAttemptProfile) attemptProfiles.set(attemptKey(index, attempt, slot), child._nexusAttemptProfile);
                        throw error;
                    },
                );
            },
            onAttemptStart: ({ slot, index, attempt, attemptedSlots }) => {
                const admission = workerAdmission.get(slot);
                if (role === 'treeBuild' && Number(attempt) === 1 && admission?.status === 'deprioritized') {
                    const probe = probeEligibilityFor(slot);
                    admission.status = 'probing';
                    admission.probeStartedAt = Date.now();
                    logEvent('batch-bus', 'batch-worker-probe-start', {
                        parentJobId: handle.id, routeId: rid, role, bus: opts.bus || role, slot,
                        batchIndex: index, batchNumber: index + 1, backoffLevel: admission.backoffLevel,
                        peerSuccessesSinceDemotion: admission.peerSuccessesSinceDemotion,
                        requiredPeerSuccesses: probe.requiredPeerSuccesses ?? null,
                        elapsedMs: probe.elapsedMs ?? Math.max(0, Date.now() - Number(admission.deprioritizedAt || 0)),
                        cooldownMs: probe.cooldownMs ?? null,
                        forcedBecauseNoActiveWorker: probe.eligible !== true,
                    }, 'info');
                }
                logEvent('batch-bus', 'batch-attempt-start', {
                    parentJobId: handle.id, routeId: rid, role, bus: opts.bus || role,
                    batchIndex: index, batchNumber: index + 1, batchCount: list.length,
                    slot, attempt, attemptedSlots,
                }, 'info');
            },
            onAttemptSuccess: ({ slot, index, attempt, durationMs }) => {
                settledSlices.add(index);
                noteParentBatchSuccess({ slot, index, attempt });
                noteWorkerOutcome(slot, { durationMs, success: true, attempt });
                logEvent('batch-bus', 'batch-attempt-success', {
                    parentJobId: handle.id, routeId: rid, role, bus: opts.bus || role,
                    batchIndex: index, batchNumber: index + 1, batchCount: list.length,
                    slot, attempt, durationMs,
                }, 'info');
            },
            onAttemptFailure: ({ slot, index, attempt, error, willRetry, attemptedSlots, durationMs }) => {
                noteWorkerOutcome(slot, { durationMs, error, success: false, attempt });
                if (!willRetry) settledSlices.add(index);
                const nextSlot = willRetry ? workers.find(worker => !attemptedSlots.includes(worker)) || null : null;
                if (willRetry && nextSlot) {
                    recordWorkloadFallback({
                        role,
                        bus: opts.bus || role,
                        routeId: rid,
                        jobId: handle.id,
                        fromSlot: slot,
                        toSlot: nextSlot,
                        reason: 'batch-slice-failure',
                    });
                }
                logEvent('batch-bus', 'batch-attempt-failed', {
                    parentJobId: handle.id, routeId: rid, role, bus: opts.bus || role,
                    batchIndex: index, batchNumber: index + 1, batchCount: list.length,
                    slot, attempt, attemptedSlots, willRetry, nextSlot, durationMs, error,
                }, willRetry ? 'warn' : 'error');
            },
        });

        handle.promise = Promise.resolve(poolPromise)
            .then(pool => {
                if (handle.cancelled) throw handle.cancelReason || Object.assign(new Error('Nexus Sidecar batch cancelled.'), { name: 'TV2BatchCancelled' });
                handle.state = pool.failures.length ? 'degraded' : 'succeeded';
                const completed = pool.results.map(row => ({
                    index: row.index,
                    batchNumber: row.index + 1,
                    slot: row.slot,
                    attempts: row.attempts,
                    response: row.value,
                }));
                const failures = pool.failures.map(row => ({
                    index: row.index,
                    batchNumber: row.index + 1,
                    slot: row.slot,
                    attempts: row.attempts,
                    batch: list[row.index],
                    error: row.error,
                }));
                const slotsUsed = [...new Set([...completed,...failures].flatMap(row=>Array.isArray(row.attempts)?row.attempts:[row.slot]).filter(Boolean))];
                logEvent('batch-bus', 'batch-job-complete', {
                    parentJobId: handle.id,
                    routeId: rid,
                    role,
                    bus: opts.bus || role,
                    status: handle.state,
                    batchCount: list.length,
                    completedCount: completed.length,
                    failedCount: failures.length,
                    slotsUsed,
                    childJobs: [...handle.children],
                    dualIdleScatter: scatter.dualIdle,
                    scatterLeadSlot,
                    workerQuality: Object.fromEntries(workers.map(slot => [slot, qualitySnapshotFor(slot)])),
                    workerAdmission: Object.fromEntries(workers.map(slot => [slot, admissionSnapshotFor(slot)])),
                }, failures.length ? 'warn' : 'info');
                return {
                    batches: completed,
                    failures,
                    tv2: {
                        role,
                        routeId: rid,
                        parentJobId: handle.id,
                        executionMode: locked ? 'hard-lock-batch' : 'batch-scatter',
                        batch: true,
                        degraded: failures.length > 0,
                        batchCount: list.length,
                        completedCount: completed.length,
                        failedCount: failures.length,
                        slotsUsed,
                        workers: [...workers],
                        childJobs: [...handle.children],
                        dualIdleScatter: scatter.dualIdle,
                        scatterLeadSlot,
                        workerQuality: Object.fromEntries(workers.map(slot => [slot, qualitySnapshotFor(slot)])),
                    workerAdmission: Object.fromEntries(workers.map(slot => [slot, admissionSnapshotFor(slot)])),
                    },
                };
            })
            .catch(error => {
                const cancelled = handle.cancelled || isIntentionalCancellation(error);
                handle.state = cancelled ? 'cancelled' : 'failed';
                logEvent('batch-bus', cancelled ? 'batch-job-cancelled-complete' : 'batch-job-failed', {
                    parentJobId: handle.id, routeId: rid, role, bus: opts.bus || role,
                    batchCount: list.length, childJobs: [...handle.children], error,
                }, cancelled ? 'warn' : 'error');
                throw error;
            })
            .finally(() => {
                for (const slot of workers) queue.releaseResourcePriority(`sidecar:${slot}`, handle.id);
                logEvent('batch-bus', 'worker-priority-released', {
                    parentJobId: handle.id, routeId: rid, role, bus: opts.bus || role,
                    workers, priority: batchPriority,
                }, 'debug');
                opts.signal?.removeEventListener?.('abort', abortBatchFromCaller);
                releaseInFlight(batchInFlight,dedupKey,handle);
            });
        if (dedupKey) batchInFlight.set(dedupKey, handle);
        return handle;
    }

    enqueueBatch(role, batches = [], opts = {}) {
        return this._enqueueBatch(role, batches, opts);
    }

    _enqueueHardLocked(role, slot, opts = {}) {
        const settings = getSettings();
        const normalized = String(slot || '').toUpperCase();
        const queue = getJobQueue(settings.jobs);
        const rid = opts.routeId || routeId(role);
        const physicalDedupKey = opts.dedupKey ? `slot:${normalized}|${opts.dedupKey}` : null;
        const existing = queue.activeByDedupKey?.(physicalDedupKey);
        if (existing) return queue.enqueue(async()=>null,{...opts,dedupKey:physicalDedupKey,resourceKey:`sidecar:${normalized}`});
        if (opts.signal?.aborted) throw opts.signal.reason || Object.assign(new Error('Hard-locked Sidecar work cancelled before admission.'), { name:'TV2BatchCancelled' });
        if (!slotEligible(normalized, role, opts.bus)) {
            const err = new Error(`Nexus ${role} is hard-locked to Sidecar ${normalized}, but that Sidecar is disabled or not checked for ${opts.bus || role}.`);
            logEvent('workload', 'hard-lock-unavailable', { role, bus: opts.bus || role, routeId: rid, lockedSlot: normalized }, 'error');
            throw err;
        }
        const snapshot = queue.snapshot();
        const job = queue.enqueue(async ({ signal, job }) => {
            opts.assertExecutionFresh?.();
            if (!slotEligible(normalized, role, opts.bus)) throw workerUnavailableError(`Sidecar ${normalized} became unavailable before queued hard-locked ${role} work started.`, normalized);
            const profile = { ...getSidecarProfile(normalized) };
            job._nexusAttemptProfile = profile;
            const requestModel=String(profile?.model||'');
            const requestFormat=String(profile?.format||'openai');
            const governed = applySidecarResourcePolicy(role, opts, 'hard-lock');
            let result;
            try {
                result = await callSidecar(profile, {
                    ...governed,
                    signal,
                    label: opts.label || `Nexus ${role} hard-locked Sidecar ${normalized}`,
                    telemetry: {
                        ...(governed.telemetry || {}),
                        slot: normalized,
                        role,
                        bus: opts.bus || role,
                        routeId: rid,
                        jobId: job.id,
                        attempt: job.attempts,
                        executionMode: 'hard-lock',
                        phase: 'hard-lock',
                    },
                });
                markWorkerSuccess(normalized, { profile });
            } catch (error) {
                markWorkerFailure(normalized, error, { profile });
                throw error;
            }
            result.tv2 = {
                ...(result.tv2 || {}),
                slot: normalized,
                role,
                routeId: rid,
                jobId: job.id,
                model: requestModel,
                format: requestFormat,
                executionMode: 'hard-lock',
                hardLocked: true,
            };
            return result;
        }, {
            label: opts.label || `${role} hard-locked to Sidecar ${normalized}`,
            priority: opts.priority ?? 50,
            resourceKey: `sidecar:${normalized}`,
            preemptible: opts.preemptible !== false,
            maxAttempts: opts.maxAttempts || 1,
            dedupKey: physicalDedupKey,
            foregroundAdjacent: opts.foregroundAdjacent === true,
            meta: {
                kind: 'sidecar',
                role,
                preferredSlot: normalized,
                assignedSlot: normalized,
                assignmentReason: 'hard-lock',
                hardLocked: true,
                offloaded: false,
                routeId: rid,
                executionMode: 'hard-lock',
                bus: opts.bus || role,
                nexusPlanId: opts.telemetry?.nexusPlanId || null,
                nexusDirectorJobId: opts.telemetry?.nexusDirectorJobId || null,
                nexusDirectorJobType: opts.telemetry?.nexusDirectorJobType || null,
            },
        });
        const callerAbort = () => { try { job.cancel?.(opts.signal?.reason || Object.assign(new Error('Hard-locked Sidecar work cancelled by caller.'), { name:'TV2BatchCancelled' })); } catch {} };
        opts.signal?.addEventListener?.('abort',callerAbort,{once:true});
        job.promise.finally(()=>opts.signal?.removeEventListener?.('abort',callerAbort)).catch(()=>{});
        if(opts.signal?.aborted)callerAbort();
        recordWorkloadDecision({
            assignedSlot: normalized,
            preferredSlot: normalized,
            reason: 'hard-lock',
            hardLocked: true,
            offloaded: false,
            loads: { snapshotSize: snapshot.length },
            role,
            bus: opts.bus || role,
            routeId: rid,
            jobId: job.id,
            executionMode: 'hard-lock',
            label: job.label,
        });
        logEvent('routing', 'hard-lock-enqueued', {
            role,
            bus: opts.bus || role,
            routeId: rid,
            lockedSlot: normalized,
            jobId: job.id,
            label: job.label,
        }, 'info');
        return job;
    }

    _enqueueAdaptive(role, opts = {}) {
        const settings = getSettings();
        const configuredPreferred = this.preferredSlot(role);
        const requestedStart = String(opts.startSlot || '').toUpperCase();
        const preferred = ['A','B'].includes(requestedStart) ? requestedStart : configuredPreferred;
        const queue = getJobQueue(settings.jobs);
        const rid = opts.routeId || routeId(role);
        const dedupKey = opts.dedupKey ? `adaptive:${role}:${opts.bus || role}:${opts.dedupKey}` : null;
        { const existing = liveInFlight(adaptiveInFlight,dedupKey); if(existing) return existing; }
        if (opts.signal?.aborted) throw opts.signal.reason || Object.assign(new Error('Adaptive Sidecar work cancelled before admission.'), { name:'TV2BatchCancelled' });
        const available = enabledSlots(role, opts.bus);
        const decision = chooseWorkloadSlot({
            preferredSlot: preferred,
            enabledSlots: available,
            queueSnapshot: queue.snapshot(),
            priority: opts.priority ?? 50,
            priorityFloors: {A:queue.resourcePriorityFloor?.('sidecar:A'),B:queue.resourcePriorityFloor?.('sidecar:B')},
            loadBalance: settings.routing?.loadBalance !== false,
            priority: opts.priority ?? 50,
            priorityFloors: { A: queue.resourcePriorityFloor?.('sidecar:A') ?? null, B: queue.resourcePriorityFloor?.('sidecar:B') ?? null },
            health: healthSnapshot(),
        });
        let assigned = decision.assignedSlot;
        let assignmentDecision = decision;
        if (!assigned && decision.queueSlot) {
            assigned = decision.queueSlot;
            assignmentDecision = { ...decision, assignedSlot: assigned, reason: 'queued-capacity-wait', queuedForCapacity: true };
            logEvent('workload', 'assignment-waiting-capacity', {
                role, bus: opts.bus || role, routeId: rid, preferredSlot: preferred, assignedSlot: assigned, decision: assignmentDecision,
            }, 'info');
        }
        if (!assigned) {
            const err = new Error(`No enabled Nexus Sidecar is available for ${role}.`);
            logEvent('workload', 'assignment-failed', { role, bus: opts.bus || role, routeId: rid, preferredSlot: preferred, decision }, 'error');
            throw err;
        }
        const handle = {
            id: `tv2_adaptive_${role}_${Date.now()}_${++adaptiveSeq}`,
            label: opts.label || `${role} generation`,
            state: 'queued',
            routeId: rid,
            children: [],
            activeChild: null,
            error: null,
            promise: null,
            cancel: null,
            meta: {
                kind: 'sidecar-adaptive', role, preferredSlot: preferred, assignedSlot: assigned,
                assignmentReason: assignmentDecision.reason, offloaded: assignmentDecision.offloaded, routeId: rid,
                executionMode: 'adaptive', bus: opts.bus || role,
            },
        };
        let cancelled = false;
        let cancelReason = null;
        handle.cancel = (reason = 'Adaptive Sidecar work cancelled.') => {
            if (cancelled || ['succeeded', 'failed', 'cancelled'].includes(handle.state)) return false;
            cancelReason = reason instanceof Error ? reason : Object.assign(new Error(String(reason || 'Adaptive Sidecar work cancelled.')), { name: 'TV2BatchCancelled' });
            if (!cancelReason.name || cancelReason.name === 'Error') cancelReason.name = 'TV2BatchCancelled';
            cancelled = true;
            handle.state = 'cancelled';
            releaseInFlight(adaptiveInFlight,dedupKey,handle);
            if (handle.activeChild?.id) queue.cancel(handle.activeChild.id, cancelReason);
            queue.cancelWhere(job => job?.meta?.parentJobId === handle.id, cancelReason);
            return true;
        };
        const abortAdaptiveFromCaller=()=>handle.cancel(opts.signal?.reason||Object.assign(new Error('Adaptive Sidecar work cancelled by caller.'),{name:'TV2BatchCancelled'}));
        opts.signal?.addEventListener?.('abort',abortAdaptiveFromCaller,{once:true});
        const candidates = [assigned, other(assigned)].filter((slot, index, list) => available.includes(slot) && list.indexOf(slot) === index);
        handle.state = 'running';
        handle.promise = (async () => {
            let lastError = null;
            let failedSlot = null;
            let failedProfile = null;
            for (let index = 0; index < candidates.length; index += 1) {
                const slot = index === 0 ? assigned : other(failedSlot || assigned);
                if (cancelled) throw cancelReason;
                if (!slotEligible(slot, role, opts.bus)) {
                    lastError = workerUnavailableError(`Sidecar ${slot} became unavailable after adaptive admission.`, slot);
                    failedSlot = slot;
                    failedProfile = { ...getSidecarProfile(slot) };
                    continue;
                }
                if (index > 0) {
                    if (getSettings().routing?.fallback === false) break;
                    if (isIntentionalCancellation(lastError)) throw lastError;
                    if (!shouldRetrySidecarFailure({
                        error: lastError,
                        failedProfile,
                        nextProfile: { ...getSidecarProfile(slot) },
                        allowSameProviderModelTimeoutRetry: opts.allowSameProviderModelTimeoutRetry === true,
                    })) break;
                    const sameProfileTimeoutRestart = lastError?.name === 'TV2SidecarTimeout'
                        && opts.allowSameProviderModelTimeoutRetry === true
                        && sameSidecarProviderModel(failedProfile, { ...getSidecarProfile(slot) });
                    if (sameProfileTimeoutRestart) {
                        logEvent('routing', 'adaptive-timeout-restart', {
                            role,
                            bus: opts.bus || role,
                            routeId: rid,
                            jobId: handle.id,
                            fromSlot: failedSlot,
                            toSlot: slot,
                            attempt: index + 1,
                            policy: 'one-cross-slot-restart',
                        }, 'warn');
                    }
                    recordWorkloadFallback({
                        role,
                        bus: opts.bus || role,
                        routeId: rid,
                        jobId: handle.id,
                        fromSlot: failedSlot,
                        toSlot: slot,
                        reason: sameProfileTimeoutRestart ? 'same-profile-timeout-cross-lane-restart' : 'provider-or-transport-failure',
                    });
                }
                // A health-offload decision is already the Work Director choosing
                // the healthier primary lane. JobQueue may rebalance ordinary
                // idle-equivalent primaries, but must not undo that health decision
                // before the selected worker gets its first attempt. The existing
                // adaptive fallback loop still owns retrying the other lane after a
                // real primary failure.
                const allowPrimaryIdleRehome = index === 0
                    && candidates.length > 1
                    && assignmentDecision.reason !== 'health-offload';
                const child = this._enqueuePinned(role, slot, {
                    ...opts,
                    executionMode: 'adaptive',
                    dedupKey: null,
                    label: index === 0 ? (opts.label || `${role} generation`) : `${opts.label || role} · adaptive fallback ${slot}`,
                    dynamicRehome: allowPrimaryIdleRehome,
                    dynamicCandidateSlots: allowPrimaryIdleRehome ? candidates : [slot],
                }, {
                    routeId: rid,
                    parentJobId: handle.id,
                    phase: index === 0 ? 'adaptive-primary' : `adaptive-fallback-${slot.toLowerCase()}`,
                    preferredSlot: preferred,
                });
                handle.activeChild = child;
                handle.children.push(child.id);
                try {
                    const result = await child.promise;
                    if (cancelled) throw cancelReason;
                    const actualSlot=String(result?.tv2?.slot||child?.meta?.assignedSlot||slot).toUpperCase();
                    if(handle.meta){handle.meta.assignedSlot=actualSlot;handle.meta.offloaded=actualSlot!==preferred;handle.meta.assignmentReason=actualSlot!==assigned?'queued-idle-rehome':assignmentDecision.reason;}
                    result.tv2 = { ...(result.tv2 || {}), slot:actualSlot, role, routeId: rid, parentJobId: handle.id, attempt: index + 1, executionMode: 'adaptive', fallbackQueued: index > 0 };
                    return result;
                } catch (error) {
                    if (isIntentionalCancellation(error) || cancelled) throw cancelReason || error;
                    lastError = error;
                    failedSlot = String(child?.meta?.assignedSlot||error?.slot||slot).toUpperCase();
                    failedProfile = child._nexusAttemptProfile || { ...getSidecarProfile(failedSlot) };
                } finally {
                    if (handle.activeChild === child) handle.activeChild = null;
                }
            }
            throw lastError || new Error(`All Nexus Sidecars failed for ${role}.`);
        })().then(result => {
            handle.state = 'succeeded';
            return result;
        }).catch(error => {
            handle.error = error;
            handle.state = isIntentionalCancellation(error) || cancelled ? 'cancelled' : 'failed';
            throw error;
        }).finally(() => {
            opts.signal?.removeEventListener?.('abort',abortAdaptiveFromCaller);
            releaseInFlight(adaptiveInFlight,dedupKey,handle);
        });
        if (dedupKey) adaptiveInFlight.set(dedupKey, handle);
        recordWorkloadDecision({
            ...assignmentDecision,
            role,
            bus: opts.bus || role,
            routeId: rid,
            jobId: handle.id,
            executionMode: 'adaptive',
            label: handle.label,
        });
        logEvent('routing', 'route-enqueued', {
            role,
            routeId: rid,
            executionMode: 'adaptive',
            preferredSlot: preferred,
            assignedSlot: assigned,
            assignmentReason: assignmentDecision.reason,
            offloaded: assignmentDecision.offloaded,
            loads: assignmentDecision.loads,
            jobId: handle.id,
            label: handle.label,
        }, 'debug');
        return handle;
    }

    enqueue(role, opts = {}) {
        const forcedSlot = String(opts.forceSlot || '').toUpperCase();
        if (['A', 'B'].includes(forcedSlot)) return this._enqueueHardLocked(role, forcedSlot, { ...opts, executionMode: 'call-center-route' });
        const locked = this.lockedSlot(role);
        if (locked) return this._enqueueHardLocked(role, locked, { ...opts, executionMode: 'hard-lock' });
        const mode = this.executionMode(role, opts.executionMode);
        if (isMultiExecutionMode(mode)) return this._enqueueMulti(role, mode, { ...opts, executionMode: mode });
        return this._enqueueAdaptive(role, { ...opts, executionMode: 'adaptive' });
    }

    test(slot, opts = {}) {
        const normalized = String(slot || '').toUpperCase();
        if (!['A', 'B'].includes(normalized)) throw new Error(`Unknown Sidecar slot: ${slot}`);
        const queue = getJobQueue(getSettings().jobs);
        const rid = routeId(`test-${normalized}`);
        const job = queue.enqueue(async ({ signal, job }) => {
            opts.assertExecutionFresh?.();
            opts.onAttemptAuthority?.(normalized);
            const profile = { ...getSidecarProfile(normalized) };
            job._nexusAttemptProfile = profile;
            try {
                const result = await callSidecar(profile, applySidecarResourcePolicy('connectivity-test', {
                    prompt: 'Return exactly this JSON and nothing else: {"ok":true,"component":"Nexus"}',
                    systemPrompt: 'You are a Nexus Sidecar connectivity and telemetry test. Follow the requested output exactly.',
                    reasoningEffort: profile.reasoningEffort || 'auto',
                    signal,
                    label: `Nexus Sidecar ${normalized} test`,
                    telemetry: { slot: normalized, role: 'connectivity-test', bus: 'diagnostics', routeId: rid, jobId: job.id, attempt: 1, phase: 'connectivity-test' },
                }, 'connectivity-test'));
                markWorkerSuccess(normalized, { profile });
                return result;
            } catch (error) {
                markWorkerFailure(normalized, error, { profile });
                throw error;
            }
        }, {
            label: `Sidecar ${normalized} connectivity test`,
            priority: 90,
            resourceKey: `sidecar:${normalized}`,
            preemptible: true,
            maxAttempts: 1,
            foregroundAdjacent: false,
            meta: { kind: 'sidecar-test', slot: normalized, assignedSlot: normalized, routeId: rid },
        });
        return job;
    }

}

export const sidecarRouter = new SidecarRouter();
