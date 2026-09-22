import { getContext } from '../../../../st-context.js';
import { getSettings } from '../core/settings.js';
import { estimateContentTokens } from '../observability/token-estimator.js';
import { logEvent } from '../observability/telemetry.js';
import { enqueueBusBatch, enqueueBusJob } from '../sidecar/bus.js';
import { parseStructuredJsonCandidate } from '../sidecar/normalize-response.js';
import { BatchAdmissionGate } from './batch-gate.js';
import { packNexusBatchItems, packNexusRollingDispatchGroups, groupNexusDispatchUnits } from './batch-planner.js';
import { captureNexusWorkScope, isNexusWorkScopeFresh, currentNexusChatEpoch } from './work-scope.js';
import { isIntentionalCancellation } from '../core/cancellation.js';
import { createAdaptiveProfileKey, recommendAdaptiveBatchSize, recordThroughputSample } from './adaptive-throughput.js';

/**
 * Nexus Sidecar Batch Layer
 * -------------------------
 *
 * This is intentionally *not* part of the Call Center or Main boundary.
 * Its default physical dispatcher is the A/B Sidecar Bus. The same logical
 * slicing/recovery engine may also be reused by an abstract MODEL_WORKER caller
 * that supplies its own physical dispatchUnits adapter; Batch Layer still does
 * not choose Main/SC-A/SC-B itself.
 *
 * It has two entry points:
 * - enqueueNexusSidecarJob: a small coalescer for independent worker jobs that
 *   arrive together (Notebook, Memory Bank, Lorebook, and Reasoning helpers).
 * - runNexusSidecarBatch: an immediate scatter/gather operation with parsing
 *   and a bounded per-slice recovery pass (UID Summarizer, Merge, etc.).
 */

export const NEXUS_BATCH_DOMAIN = Object.freeze({
    UID_SUMMARIZER: 'uid-summarizer',
    MERGE: 'merge',
    TREE: 'tree',
    NOTEBOOK: 'notebook',
    MEMORY_BANK: 'memory-bank',
    LOREBOOK: 'lorebook',
    REASONING: 'reasoning',
});

const DOMAIN_LABEL = Object.freeze({
    [NEXUS_BATCH_DOMAIN.UID_SUMMARIZER]: 'UID Summarizer',
    [NEXUS_BATCH_DOMAIN.MERGE]: 'Merge',
    [NEXUS_BATCH_DOMAIN.TREE]: 'Tree',
    [NEXUS_BATCH_DOMAIN.NOTEBOOK]: 'Notebook',
    [NEXUS_BATCH_DOMAIN.MEMORY_BANK]: 'Memory Bank',
    [NEXUS_BATCH_DOMAIN.LOREBOOK]: 'Lorebook',
    [NEXUS_BATCH_DOMAIN.REASONING]: 'Reasoning',
});

let handleSequence = 0;
const pendingQueues = new Map();
// Entries remain registered here from queue drain until every planned wave has
// either settled or been cancelled. CHAT_CHANGED therefore has authority over
// coalesced work even after it has left pendingQueues and entered dispatchWave.
const activeCoalescedEntries = new Set();
const activeImmediateOperations = new Map();
const coalescedDedupOwners = new Map();
let lastBatchOutcome = null;

const ADAPTIVE_BATCH_WAVE_CONTRACT = 'hf46.7-wave-v1';

function adaptiveBatchWorkloadType(domain, stage) {
    return `batch-layer:${normalizeDomain(domain)}:${String(stage || 'unknown').trim().toLowerCase() || 'unknown'}`;
}

function adaptiveBatchWavePolicy({ domain, stage, currentSize = 1, maxSize = 1, remainingItems = 1, enabled = true } = {}) {
    const workloadType = adaptiveBatchWorkloadType(domain, stage);
    const boundedMax = Math.max(1, Math.min(50, Math.floor(Number(maxSize) || 1)));
    const boundedCurrent = Math.max(1, Math.min(boundedMax, Math.floor(Number(currentSize) || boundedMax)));
    const profileKey = createAdaptiveProfileKey({
        workloadType,
        provider: 'AUTO',
        profile: 'batch-layer',
        model: 'AUTO',
        worker: 'POOL',
        contractVersion: ADAPTIVE_BATCH_WAVE_CONTRACT,
    });
    const recommendedSize = enabled === true && Number(remainingItems) > 1
        ? recommendAdaptiveBatchSize({
            profileKey,
            currentSize: boundedCurrent,
            minSize: 1,
            maxSize: boundedMax,
            remainingItems,
        })
        : boundedCurrent;
    return {
        enabled: enabled === true,
        workloadType,
        profileKey,
        contractVersion: ADAPTIVE_BATCH_WAVE_CONTRACT,
        configuredSize: boundedCurrent,
        recommendedSize,
        effectiveSize: Math.max(1, Math.min(recommendedSize, Math.max(1, Math.floor(Number(remainingItems) || 1)))),
    };
}

function adaptiveWaveFailureKind(error) {
    const name = String(error?.name || '');
    const message = String(error?.message || '');
    if (name === 'TV2SidecarTimeout' || /timeout|timed out/i.test(message)) return 'timeout';
    if (name === 'TV2SidecarTruncated' || /truncated|output boundary/i.test(message)) return 'truncated';
    return 'failure';
}

function responseOutputTokens(response) {
    return Math.max(0, Number(response?.usageNormalized?.outputTokens ?? response?.usage?.outputTokens ?? response?.usageEstimated?.outputTokens) || 0);
}

function recordAdaptiveBatchWave({ policy, units = [], rows = [], latencyMs = 0, error = null } = {}) {
    if (!policy?.enabled || !policy?.profileKey || !units.length) return null;
    if (error && isIntentionalCancellation(error)) return null;
    const failures = Array.isArray(rows) ? rows.filter(row => row?.error) : [];
    const successes = Array.isArray(rows) ? rows.filter(row => !row?.error) : [];
    const failure = error || failures[0]?.error || null;
    const outcome = failure ? adaptiveWaveFailureKind(failure) : (successes.length === units.length ? 'success' : 'failure');
    const sample = recordThroughputSample({
        profileKey: policy.profileKey,
        batchSize: units.length,
        successfulItems: successes.length,
        latencyMs,
        outcome,
        inputTokens: units.reduce((sum, unit) => sum + requestInputTokens(unit?.request || unit?.options || {}), 0),
        outputTokens: successes.reduce((sum, row) => sum + responseOutputTokens(row?.response), 0),
    });
    logEvent('nexus-batch', 'adaptive-wave-observed', {
        adaptiveWorkloadType: policy.workloadType,
        adaptiveContractVersion: policy.contractVersion,
        adaptiveBatchItems: units.length,
        configuredBatchItems: policy.configuredSize,
        recommendedBatchItems: policy.recommendedSize,
        successfulItems: successes.length,
        latencyMs: Math.max(0, Number(latencyMs) || 0),
        outcome,
    }, outcome === 'success' ? 'debug' : 'warn');
    return sample;
}

function queuedUnitCount() {
    let total = 0;
    for (const queue of pendingQueues.values()) total += (queue.entries || []).filter(entry => !entry?.cancelled && !entry?.settled).length;
    return total;
}

function activeCoalescedUnitCount() {
    let total = 0;
    for (const entry of activeCoalescedEntries) {
        if (!entry?.settled && !entry?.cancelled) total += 1;
    }
    return total;
}

function recordBatchOutcome(outcome = {}) {
    const scope=outcome?.scope||null;
    lastBatchOutcome = { at: Date.now(), ...outcome, scope: scope ? {...scope} : { epoch: currentNexusChatEpoch(), chatId: String(getContext()?.chatId ?? '') || null }, sidecarOnly: outcome.sidecarOnly !== false, mainEligible: outcome.mainEligible === true };
}

export function clearNexusBatchDiagnostics(){lastBatchOutcome=null;return true;}

function clampNumber(value, low, high, fallback) {
    if (value === null || value === undefined) return fallback;
    if (typeof value === 'string' && value.trim() === '') return fallback;
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.max(low, Math.min(high, Math.floor(number)));
}


function normalizeDomain(domain) {
    const value = String(domain || '').trim().toLowerCase();
    if (Object.values(NEXUS_BATCH_DOMAIN).includes(value)) return value;
    const error = new Error(`Unknown Nexus batch domain: ${String(domain || '<empty>')}`);
    error.name = 'TV2UnknownBatchDomain';
    error.code = 'TV2_UNKNOWN_BATCH_DOMAIN';
    throw error;
}

function batchSettings() {
    const configured = getSettings().nexus?.batchLayer || {};
    return {
        enabled: configured.enabled !== false,
        coalesceMs: clampNumber(configured.coalesceMs, 0, 500, 45),
        maxBatchItems: clampNumber(configured.maxBatchItems, 1, 50, 10),
        targetInputTokens: clampNumber(configured.targetInputTokens, 1000, 100000, 7000),
        summaryInputTokens: clampNumber(configured.summaryInputTokens, 1000, 100000, 7000),
        mergeInputTokens: clampNumber(configured.mergeInputTokens, 1000, 100000, 9000),
        recoveryAttempts: clampNumber(configured.recoveryAttempts, 0, 3, 1),
        domains: { ...(configured.domains || {}) },
    };
}

function domainEnabled(domain, settings = batchSettings()) {
    const configured = settings.domains?.[domain];
    return settings.enabled && configured !== false;
}

function tokenEstimate(value, model = '') {
    const number = Number(value);
    if (Number.isFinite(number) && number >= 0) return Math.floor(number);
    return estimateContentTokens(String(value || ''), model);
}

function requestInputTokens(request = {}) {
    if (Number.isFinite(Number(request.estimatedInputTokens))) return Math.max(0, Math.floor(Number(request.estimatedInputTokens)));
    return estimateContentTokens(`${request.systemPrompt || ''}\n${request.prompt || ''}`);
}

function nextHandleId(domain) {
    handleSequence += 1;
    return `nexus_batch_${normalizeDomain(domain).replace(/[^a-z0-9]+/g, '_')}_${Date.now()}_${handleSequence}`;
}

function childRequest(entry, parentId, index, count) {
    const options = entry.options || {};
    return {
        ...options,
        telemetry: {
            ...(options.telemetry || {}),
            nexusBatchDomain: entry.domain,
            nexusBatchParentId: parentId,
            nexusBatchIndex: index,
            nexusBatchCount: count,
        },
    };
}

/**
 * Builds deterministic waves without making a model call.  Individual work
 * units remain independent; each wave is later scattered through A/B by the
 * Sidecar Bus.  An oversized unit is never silently trimmed—it remains alone
 * and is marked oversized for a caller's own recovery strategy.
 */
export function createNexusBatchPlan({
    domain,
    items = [],
    estimateInputTokens = item => item?.estimatedInputTokens,
    maxBatchItems,
    targetInputTokens,
} = {}) {
    const settings = batchSettings();
    const normalizedDomain = normalizeDomain(domain);
    const packed = packNexusBatchItems({
        items,
        estimateInputTokens: item => tokenEstimate(estimateInputTokens(item)),
        maxBatchItems: maxBatchItems ?? settings.maxBatchItems,
        targetInputTokens: targetInputTokens ?? settings.targetInputTokens,
    });
    return {
        domain: normalizedDomain,
        label: DOMAIN_LABEL[normalizedDomain] || normalizedDomain,
        ...packed,
        totalEstimatedInputTokens: packed.batches.reduce((total, batch) => total + batch.estimatedInputTokens, 0),
    };
}

/** A deterministic record of what the batch layer may do, for diagnostics/UI. */
export function inspectNexusBatchWork({ domain, items = [], inputTokens = 0, requestedBatch = false } = {}) {
    const settings = batchSettings();
    const normalizedDomain = normalizeDomain(domain);
    const gate = new BatchAdmissionGate({
        enabled: domainEnabled(normalizedDomain, settings),
        summaryInputTokens: settings.summaryInputTokens,
        mergeInputTokens: settings.mergeInputTokens,
        maxBatchItems: settings.maxBatchItems,
    });
    const inspection = gate.inspect({
        operation: normalizedDomain === NEXUS_BATCH_DOMAIN.MERGE ? 'merge' : 'summary',
        inputTokens,
        itemCount: Array.isArray(items) ? items.length : 0,
        requestedBatch,
    });
    const configured=domainEnabled(normalizedDomain,settings);
    const truthful=(!configured&&inspection.mode==='blocked')
        ? {...inspection,mode:'bypass',allowed:true,reason:'batching is disabled for this domain; runtime executes legal work individually'}
        : inspection;
    return {
        ...truthful,
        domain: normalizedDomain,
        sidecarOnly: true,
        mainEligible: false,
        configured,
    };
}

/**
 * Sidecar transforms that must return machine-readable drafts use this option
 * bundle. Structured output is NOT authority to disable provider reasoning.
 * Preserve an explicit workload override when one exists; otherwise leave the
 * request on Auto Sense so the Sidecar client can choose an appropriate level
 * from workload shape, request size, retry phase, and learned provider
 * capabilities. `excludeReasoning` keeps hidden reasoning out of the returned
 * payload without manufacturing an unsupported `reasoning:none` control.
 */
export function structuredSidecarOptions(options = {}) {
    const { reasoningEffort, responseFormat, excludeReasoning, temperature, ...rest } = options || {};
    return {
        ...rest,
        temperature: temperature ?? 0.15,
        reasoningEffort: reasoningEffort ?? 'auto',
        excludeReasoning: excludeReasoning !== false,
        responseFormat: responseFormat ?? 'json_object',
        // Structured JSON workers still receive a soft output target through
        // `maxTokens`, but it must never become a transport hard stop. The
        // Sidecar client owns the real provider/context/user/emergency bound.
        enforceRequestedMaxTokens: false,
        synthesisCandidateParser: typeof options?.synthesisCandidateParser === 'function'
            ? options.synthesisCandidateParser
            : (text => parseStructuredJsonCandidate(text, { validator: options?.structuredValidator || null })),
    };
}

function fastMaterialSignature(value='') { let h=2166136261; const text=String(value); for(let i=0;i<text.length;i++){h^=text.charCodeAt(i);h=Math.imul(h,16777619);} return (h>>>0).toString(16).padStart(8,'0'); }
function dedupMaterialSignature(options={}) {
    return fastMaterialSignature(JSON.stringify({
        prompt:String(options.prompt||''),systemPrompt:String(options.systemPrompt||''),responseFormat:String(options.responseFormat||''),
        role:String(options.role||''),executionMode:String(options.executionMode||''),forceSlot:String(options.forceSlot||''),startSlot:String(options.startSlot||''),
        maxTokens:Number(options.maxTokens)||0,temperature:Number(options.temperature)||0,
    }));
}

function queueKey(domain, stage, options = {}, scope = null) {
    return [
        normalizeDomain(domain),
        String(stage || ''),
        String(options.role || ''),
        Number(options.priority ?? 50),
        String(options.executionMode || 'adaptive'),
        `force:${String(options.forceSlot || 'none').toUpperCase()}`,
        `start:${String(options.startSlot || 'none').toUpperCase()}`,
        `dedup:${options.dedupKey || 'none'}`,
        `payload:${options.dedupKey ? dedupMaterialSignature(options) : 'none'}`,
        options.preemptible === false ? 'nonpreemptible' : 'preemptible',
        `chat:${scope?.chatId ?? 'none'}`,
        `epoch:${Number(scope?.epoch) || 0}`,
        `rev:${scope?.revision || 'none'}`,
    ].join('|');
}

function batchCancelError(reason = 'Nexus batch work cancelled.') {
    const error = reason instanceof Error ? reason : new Error(String(reason || 'Nexus batch work cancelled.'));
    if (!error.name || error.name === 'Error') error.name = 'TV2BatchCancelled';
    return error;
}

function cancelEntry(entry, reason = 'Nexus batch work cancelled.') {
    if (!entry || entry.settled || entry.cancelled) return false;
    entry.cancelled = true;
    const error = batchCancelError(reason);
    entry.handle.state = 'cancelled';
    entry.handle.error = error;
    try { entry.cancelPhysical?.(error); } catch {}
    entry.reject(error);
    entry.settled = true;
    if(entry.dedupOwnerKey && coalescedDedupOwners.get(entry.dedupOwnerKey)===entry.handle) coalescedDedupOwners.delete(entry.dedupOwnerKey);
    return true;
}

export function cancelPendingNexusBatchWork({ chatId = null, epoch = null, generationId = null, reason = 'Nexus batch scope invalidated.' } = {}) {
    let cancelled = 0;
    const matchesScope = entry => {
        const matchesChat = chatId == null || String(entry?.scope?.chatId ?? '') === String(chatId);
        const matchesEpoch = epoch == null || Number(entry?.scope?.epoch) === Number(epoch);
        const matchesGeneration = generationId == null || String(entry?.scope?.generationId ?? '') === String(generationId);
        return matchesChat && matchesEpoch && matchesGeneration;
    };
    for (const [key, queue] of [...pendingQueues.entries()]) {
        for (const entry of queue.entries || []) {
            if (matchesScope(entry) && cancelEntry(entry, reason)) cancelled += 1;
        }
        queue.entries = (queue.entries || []).filter(entry => !entry.cancelled && !entry.settled);
        if (!queue.entries.length) {
            if (queue.timer) clearTimeout(queue.timer);
            pendingQueues.delete(key);
        }
    }
    // drainQueue removes its queue before physical dispatch. Keep authority over
    // that gap and over active/future waves from the same drain. cancelEntry()
    // invokes the physical JobQueue handle when it already exists; if cancellation
    // wins just before enqueue, dispatchWave sees the cancelled flag and never
    // starts that child.
    for (const entry of [...activeCoalescedEntries]) {
        if (matchesScope(entry) && cancelEntry(entry, reason)) cancelled += 1;
    }
    for (const operation of activeImmediateOperations.values()) {
        if (chatId !== null && String(operation.scope.chatId) !== String(chatId)) continue;
        if (epoch !== null && Number(operation.scope.epoch) !== Number(epoch)) continue;
        if (generationId !== null && String(operation.scope.generationId ?? '') !== String(generationId)) continue;
        if (operation.cancel(reason)) cancelled++;
    }
    if (cancelled) logEvent('nexus-batch', 'coalesced-work-cancelled', { chatId, epoch, generationId, cancelled, reason: String(reason?.message || reason || ''), sidecarOnly: true }, 'warn');
    return cancelled;
}

async function dispatchWave(queue, entries) {
    const liveEntries = entries.filter(entry => !entry?.settled && !entry?.cancelled);
    if (!liveEntries.length) return;
    // Only the physical wave being admitted is executing. Later serial waves
    // remain queued until their own dispatchWave call.
    for (const entry of liveEntries) entry.handle.state = 'executing';
    const parentId = nextHandleId(queue.domain);
    const stage = queue.stage;
    const common = queue.common;
    const requests = liveEntries.map((entry, index) => childRequest(entry, parentId, index, liveEntries.length));

    const settle = (entry, state, value) => {
        if (entry.settled || entry.cancelled) return;
        entry.settled = true;
        entry.handle.state = state;
        entry.handle.error = state === 'completed' ? null : value;
        if (state === 'completed') entry.resolve(value);
        else entry.reject(value);
        if(entry.dedupOwnerKey && coalescedDedupOwners.get(entry.dedupOwnerKey)===entry.handle) coalescedDedupOwners.delete(entry.dedupOwnerKey);
    };

    try {
        if (liveEntries.length === 1) {
            const entry = liveEntries[0];
            const job = enqueueBusJob(stage, { ...requests[0], role: requests[0].role ?? common.role, executionMode: requests[0].executionMode ?? common.executionMode, forceSlot: requests[0].forceSlot ?? common.forceSlot, startSlot: requests[0].startSlot ?? common.startSlot, priority: requests[0].priority ?? common.priority });
            entry.handle.jobId = job.id;
            entry.cancelPhysical = reason => job.cancel?.(reason);
            if (entry.cancelled) job.cancel?.(entry.handle.error || 'Nexus batch work cancelled.');
            const response = await job.promise;
            settle(entry, 'completed', response);
            return;
        }

        const parent = enqueueBusBatch(stage, requests, {
            label: `Nexus ${DOMAIN_LABEL[queue.domain] || queue.domain} · ${liveEntries.length} sidecar jobs`,
            priority: common.priority,
            role: common.role,
            executionMode: common.executionMode,
            forceSlot: common.forceSlot,
            startSlot: common.startSlot,
            allowPartial: true,
            dedupKey: `${queue.domain}:${parentId}`,
            nexusScope: liveEntries[0].scope,
            telemetry: { nexusBatchDomain: queue.domain, nexusBatchParentId: parentId },
        });
        for (const [index,entry] of liveEntries.entries()) {
            entry.handle.jobId = parent.id;
            // One logical child does not own the shared physical parent. Only
            // cancel the parent when every sibling in this wave is already
            // cancelled/settled; otherwise healthy siblings keep running.
            entry.cancelPhysical = reason => {
                parent.cancelSlice?.(index,reason);
                const noHealthySibling = liveEntries.every(candidate => candidate === entry || candidate.cancelled || candidate.settled);
                if (noHealthySibling) parent.cancel?.(reason);
            };
        }
        if (liveEntries.every(entry => entry.cancelled || entry.settled)) parent.cancel?.('All coalesced Nexus batch children were cancelled.');
        const result = await parent.promise;
        const completed = new Map((result.batches || []).map(row => [Number(row.index), row.response]));
        const failures = new Map((result.failures || []).map(row => [Number(row.index), row.error || new Error('Sidecar batch slice failed.')]));
        liveEntries.forEach((entry, index) => {
            if (completed.has(index)) settle(entry, 'completed', completed.get(index));
            else settle(entry, 'failed', failures.get(index) || new Error('Sidecar batch did not return this job.'));
        });
    } catch (error) {
        for (const entry of liveEntries) settle(entry, 'failed', error);
    }
}

async function drainQueue(key) {
    const queue = pendingQueues.get(key);
    if (!queue) return;
    pendingQueues.delete(key);
    const entries = queue.entries.splice(0).filter(entry => {
        if (entry.cancelled || entry.settled) return false;
        if (!isNexusWorkScopeFresh(entry.scope, getContext())) {
            cancelEntry(entry, 'Nexus batch work became stale before physical dispatch.');
            return false;
        }
        return true;
    });
    if (!entries.length) return;
    for (const entry of entries) activeCoalescedEntries.add(entry);
    const plan = createNexusBatchPlan({
        domain: queue.domain,
        items: entries,
        estimateInputTokens: entry => requestInputTokens(entry.options),
    });
    const batchingStillAllowed = domainEnabled(queue.domain, batchSettings());
    const adaptivePolicy = adaptiveBatchWavePolicy({
        domain: queue.domain, stage: queue.stage, currentSize: plan.maxBatchItems, maxSize: plan.maxBatchItems,
        remainingItems: entries.length, enabled: batchingStillAllowed && queue.domain !== NEXUS_BATCH_DOMAIN.TREE && entries.length > 1,
    });
    recordBatchOutcome({ mode: 'coalesced', domain: queue.domain, stage: queue.stage, itemCount: plan.itemCount, waveCount: plan.batchCount, state: 'dispatching', scope: entries[0]?.scope || null });
    logEvent('nexus-batch', 'coalesced-work-dispatch', {
        domain: queue.domain,
        stage: queue.stage,
        itemCount: plan.itemCount,
        waveCount: plan.batchCount,
        targetInputTokens: plan.targetInputTokens,
        adaptiveWorkloadType: adaptivePolicy.enabled ? adaptivePolicy.workloadType : null,
        adaptiveContractVersion: adaptivePolicy.enabled ? adaptivePolicy.contractVersion : null,
        adaptiveConfiguredBatchItems: adaptivePolicy.enabled ? adaptivePolicy.configuredSize : null,
        adaptiveBatchItems: adaptivePolicy.enabled ? adaptivePolicy.effectiveSize : 0,
        sidecarOnly: true,
    }, 'info');
    try {
        if (!batchingStillAllowed) {
            // Revoking a domain while entries sit in the coalescing window revokes
            // batch-parent formation, but it does not erase otherwise legal work.
            await Promise.all(entries.map(entry => dispatchWave({ ...queue, common:{...queue.common} }, [entry])));
        } else {
            const rolling = packNexusRollingDispatchGroups({ items: entries, maxBatchItems: adaptivePolicy.enabled ? adaptivePolicy.effectiveSize : plan.maxBatchItems }).groups;
            for (const waveEntries of rolling) {
                for (const entry of waveEntries) if (!isNexusWorkScopeFresh(entry.scope, getContext())) cancelEntry(entry, 'Nexus batch work became stale before physical wave dispatch.');
                const startedAt = globalThis.performance?.now?.() ?? Date.now();
                await dispatchWave(queue, waveEntries);
                const latencyMs = (globalThis.performance?.now?.() ?? Date.now()) - startedAt;
                recordAdaptiveBatchWave({
                    policy: adaptivePolicy,
                    units: waveEntries,
                    rows: waveEntries.map(entry => entry.handle?.state === 'completed' ? { response:null } : { error:entry.handle?.error || new Error('Coalesced batch wave failed.') }),
                    latencyMs,
                });
            }
        }
    } finally {
        for (const entry of entries) activeCoalescedEntries.delete(entry);
    }
    const cancelledCount = entries.filter(entry => entry.cancelled).length;
    const failedCount = entries.filter(entry => entry.handle?.state === 'failed').length;
    const completedCount = entries.filter(entry => entry.handle?.state === 'completed').length;
    recordBatchOutcome({
        mode: 'coalesced',
        domain: queue.domain,
        stage: queue.stage,
        itemCount: plan.itemCount,
        waveCount: plan.batchCount,
        cancelledCount,
        failedCount,
        completedCount,
        state: cancelledCount === entries.length
            ? 'cancelled'
            : ((cancelledCount || failedCount) ? 'partial' : 'completed'),
        scope: entries[0]?.scope || null,
    });
}

/**
 * Queue one independent Nexus worker job. Near-simultaneous compatible jobs
 * are coalesced into real `enqueueBusBatch` scatter/gather waves. Foreground
 * work deliberately bypasses the hold so recall can never wait behind a batch.
 */
export function enqueueNexusSidecarJob(domain, stage, options = {}) {
    const normalizedDomain = normalizeDomain(domain);
    const settings = batchSettings();
    const bypass = !domainEnabled(normalizedDomain, settings)
        || options.batchable === false
        || options.foregroundAdjacent === true
        || options.preemptible === false
        || (options.executionMode && String(options.executionMode) !== 'adaptive');
    if (bypass) {
        logEvent('nexus-batch', 'sidecar-work-bypassed', {
            domain: normalizedDomain,
            stage,
            reason: !domainEnabled(normalizedDomain, settings) ? 'domain-disabled' : (options.foregroundAdjacent ? 'foreground' : 'caller-single'),
            sidecarOnly: true,
        }, 'debug');
        return enqueueBusJob(stage, {
            ...options,
            telemetry: { ...(options.telemetry || {}), nexusBatchDomain: normalizedDomain, nexusBatchMode: 'single' },
        });
    }

    const id = nextHandleId(normalizedDomain);
    const scope = options.nexusScope || captureNexusWorkScope(getContext(), { kind: options.scopeKind === 'independent' ? 'independent' : 'chat' });
    const dedupOwnerKey = options.dedupKey ? `${queueKey(normalizedDomain,stage,options,scope)}|owner` : null;
    if (dedupOwnerKey) {
        const owner = coalescedDedupOwners.get(dedupOwnerKey);
        if (owner && !['completed','failed','cancelled'].includes(owner.state)) return owner;
        if (owner) coalescedDedupOwners.delete(dedupOwnerKey);
    }
    let resolve;
    let reject;
    let entry = null;
    const handle = {
        id,
        jobId: null,
        state: 'queued',
        label: options.label || `${DOMAIN_LABEL[normalizedDomain] || normalizedDomain} sidecar work`,
        promise: new Promise((done, fail) => { resolve = done; reject = fail; }),
        meta: { kind: 'nexus-sidecar-batchable', domain: normalizedDomain, stage, sidecarOnly: true, nexusScope: scope },
        cancel: (reason = 'Nexus batch work cancelled before dispatch.') => cancelEntry(entry, reason),
    };
    const key = queueKey(normalizedDomain, stage, options, scope);
    let queue = pendingQueues.get(key);
    if (!queue) {
        queue = {
            domain: normalizedDomain,
            stage,
            entries: [],
            common: {
                priority: options.priority,
                role: options.role,
                executionMode: options.executionMode,
                forceSlot: options.forceSlot,
                startSlot: options.startSlot,
            },
            timer: null,
        };
        pendingQueues.set(key, queue);
    }
    entry = { domain: normalizedDomain, options, handle, resolve, reject, scope, cancelled: false, settled: false, cancelPhysical: null, dedupOwnerKey };
    if(dedupOwnerKey)coalescedDedupOwners.set(dedupOwnerKey,handle);
    queue.entries.push(entry);
    // Coalescing is a quiet-period debounce: each compatible arrival restarts
    // the bounded window instead of fragmenting one burst at the first timer.
    if (queue.timer) clearTimeout(queue.timer);
    queue.timer = setTimeout(() => { void drainQueue(key); }, settings.coalesceMs);
    logEvent('nexus-batch', 'sidecar-work-queued', {
        domain: normalizedDomain,
        stage,
        handleId: id,
        queuedCount: queue.entries.length,
        coalesceMs: settings.coalesceMs,
        sidecarOnly: true,
    }, 'debug');
    return handle;
}

function batchValidationVerdict(check) {
    if (check === true) return { valid: true, reason: null };
    if (typeof check === 'string') return { valid: false, reason: check };
    if (check && typeof check === 'object') {
        const explicit = check.valid !== undefined || check.passed !== undefined;
        const valid = explicit && check.valid !== false && check.passed !== false && (check.valid === true || check.passed === true);
        return { valid, reason: check.reason ? String(check.reason) : (valid ? null : 'The Sidecar result did not pass Nexus batch validation.') };
    }
    return { valid: false, reason: 'The Sidecar validator did not explicitly accept the result.' };
}

function parseOutcome(unit, response, parse, validate) {
    try {
        const source = response?.structuredPayload ?? response?.text;
        const value = parse ? parse(typeof source === 'string' ? source : JSON.stringify(source), unit.item, response) : (response?.structuredPayload ?? response);
        const verdict = validate ? validate(value, unit.item, response) : true;
        const validation = batchValidationVerdict(verdict);
        if (!validation.valid) throw new Error(validation.reason || 'The Sidecar result did not pass Nexus batch validation.');
        return { unit, state: 'completed', value, response, recovered: unit.recovered === true };
    } catch (error) {
        return { unit, state: 'invalid', error, response, recovered: unit.recovered === true };
    }
}

async function dispatchImmediateUnits({ domain, stage, units, label, priority, role, executionMode, forceSlot, startSlot, allowPartial, dedupKey, telemetry, nexusScope, operation, foregroundAdjacent = false, generationId = null }) {
    if (!units.length) return [];
    const requests = units.map((unit, index) => ({
        ...(unit.request || {}),
        telemetry: {
            ...(telemetry || {}),
            ...(unit.request?.telemetry || {}),
            nexusBatchDomain: domain,
            nexusBatchSlice: unit.id,
            nexusBatchIndex: index,
            nexusBatchCount: units.length,
        },
    }));
    if (units.length === 1) {
        const job = enqueueBusJob(stage, { ...requests[0], priority: requests[0].priority ?? priority, role: requests[0].role ?? role, executionMode: requests[0].executionMode ?? executionMode, forceSlot: requests[0].forceSlot ?? forceSlot, startSlot: requests[0].startSlot ?? startSlot, nexusScope: requests[0].nexusScope ?? nexusScope, assertExecutionFresh: requests[0].assertExecutionFresh ?? operation?.assertFresh, foregroundAdjacent: foregroundAdjacent === true, generationId });
        operation?.handles.add(job);
        try {
            const response = await job.promise;
            return [{ unit: units[0], response, jobId: job.id }];
        } catch (error) {
            if (isIntentionalCancellation(error)) throw error;
            // A one-unit physical tail is still one logical slice. Return its
            // failure as a row so runNexusSidecarBatch can preserve completed
            // siblings and apply the normal bounded semantic recovery pass.
            return [{ unit: units[0], error, jobId: job.id }];
        } finally { operation?.handles.delete(job); }
    }
    const parent = enqueueBusBatch(stage, requests, {
        label: `${label || DOMAIN_LABEL[domain] || domain} · ${units.length} batch scatter`,
        priority,
        role,
        executionMode,
        forceSlot,
        startSlot,
        allowPartial: allowPartial !== false,
        dedupKey,
        nexusScope,
        foregroundAdjacent: foregroundAdjacent === true,
        generationId,
        assertExecutionFresh: operation?.assertFresh,
        telemetry: { ...(telemetry || {}), nexusBatchDomain: domain },
    });
    operation?.handles.add(parent);
    let result;
    try {
        result = await parent.promise;
    } catch (error) {
        if (isIntentionalCancellation(error)) throw error;
        // Strict Sidecar parents may reject with retained successful/failed slice
        // evidence. Reconstruct that evidence so only failed slices enter semantic
        // recovery and already-successful siblings are never replayed.
        if (Array.isArray(error?.batchResults) || Array.isArray(error?.batchFailures)) {
            result = {
                batches: (error.batchResults || []).map(row => ({
                    index: row.index,
                    response: row.response ?? row.value ?? row.result ?? row,
                })),
                failures: error.batchFailures || [],
            };
        } else throw error;
    } finally {
        operation?.handles.delete(parent);
    }
    const rows = [];
    for (const row of result.batches || []) rows.push({ unit: units[Number(row.index)], response: row.response, jobId: row.response?.tv2?.jobId || parent.id });
    for (const row of result.failures || []) rows.push({ unit: units[Number(row.index)], error: row.error || new Error('Sidecar batch slice failed.'), jobId: parent.id });
    const returned=new Set(rows.map(row=>row.unit?.id).filter(Boolean));
    for(const unit of units){if(!returned.has(unit.id)){const error=new Error(`Sidecar batch parent omitted logical slice ${unit.id}.`);error.name='TV2BatchSliceMissing';rows.push({unit,error,jobId:parent.id});}}
    return rows;
}

async function dispatchWithRetainedEvidence(dispatchFn, args = {}) {
    try {
        return await dispatchFn(args);
    } catch (error) {
        if (isIntentionalCancellation(error)) throw error;
        if (!Array.isArray(error?.batchResults) && !Array.isArray(error?.batchFailures)) throw error;
        const rows = [];
        for (const result of error.batchResults || []) {
            const unit = args.units?.[Number(result.index)];
            if (!unit) continue;
            rows.push({ unit, response: result.response ?? result.value ?? result.result ?? result, jobId: result.jobId || null });
        }
        for (const failure of error.batchFailures || []) {
            const unit = args.units?.[Number(failure.index)];
            if (!unit) continue;
            rows.push({ unit, error: failure.error || failure.reason || new Error('Sidecar batch slice failed.'), jobId: failure.jobId || null });
        }
        return rows;
    }
}

function reconcileDispatchRows(units = [], rows = []) {
    const expected = new Map((units || []).map(unit => [String(unit?.id || ''), unit]).filter(([id]) => id));
    const reconciled = [];
    const seen = new Set();
    for (const row of Array.isArray(rows) ? rows : []) {
        const id = String(row?.unit?.id || '');
        if (!id || !expected.has(id) || seen.has(id)) continue;
        seen.add(id);
        reconciled.push({ ...row, unit: expected.get(id) });
    }
    for (const [id, unit] of expected) {
        if (seen.has(id)) continue;
        const error = new Error(`Sidecar dispatch omitted logical slice ${id}.`);
        error.name = 'TV2BatchSliceMissing';
        error.code = 'TV2_BATCH_SLICE_MISSING';
        reconciled.push({ unit, error, jobId: null });
    }
    return reconciled;
}

function structuredDomainValidator(parse, validate, item) {
    if (typeof parse !== 'function' && typeof validate !== 'function') return null;
    return value => {
        try {
            const parsed = typeof parse === 'function'
                ? parse(typeof value === 'string' ? value : JSON.stringify(value), item, { structuredPayload: value })
                : value;
            const check = typeof validate === 'function' ? validate(parsed, item, { structuredPayload: value }) : true;
            const verdict = batchValidationVerdict(check);
            return { valid: verdict.valid, score: verdict.valid ? 50 : 0, reason: verdict.reason || (verdict.valid ? null : 'The Sidecar result did not pass the Nexus domain contract.'), value: parsed };
        } catch (error) {
            return { valid: false, score: 0, reason: error?.message || String(error) };
        }
    };
}

/**
 * Run a known set of independent Sidecar transforms immediately. Every slice
 * gets transport fallback from the Sidecar Bus; only failed/invalid slices get
 * one semantic recovery request. No Main call is possible from this function.
 */
// One captured operation scope owns every initial wave and recovery wave.
export async function runNexusSidecarBatch(options = {}) {
    const executionClass = options.executionClass === 'model-worker' ? 'model-worker' : 'sidecar';
    const sidecarOnly = executionClass === 'sidecar';
    const mainEligible = !sidecarOnly;
    const scope = options.nexusScope || captureNexusWorkScope(getContext(), { kind: options.scopeKind === 'independent' ? 'independent' : 'chat' });
    const id = nextHandleId(options.domain);
    const operation = {id,scope,domain:normalizeDomain(options.domain),stage:options.stage,executionClass,
        itemCount:(options.items||[]).filter(item=>item!=null).length,inFlightUnits:0,settledUnits:0,startedAt:Date.now(),handles:new Set(),cancelled:false};
    operation.cancel = reason => {
        if (operation.cancelled) return false;
        operation.cancelled = true; operation.error = batchCancelError(reason);
        for (const handle of operation.handles) handle.cancel?.(operation.error);
        return true;
    };
    operation.assertFresh = () => {
        if (options.signal?.aborted) operation.cancel(options.signal.reason);
        if (!isNexusWorkScopeFresh(scope,getContext())) operation.cancel(Object.assign(new Error('Batch operation scope changed.'),{name:'TV2ScopeInvalidated'}));
        if (operation.cancelled) throw operation.error;
    };
    const abort = () => operation.cancel(options.signal.reason);
    options.signal?.addEventListener('abort',abort,{once:true});
    activeImmediateOperations.set(id,operation);
    const physicalDispatch = options.dispatchUnits || dispatchImmediateUnits;
    try {
        operation.assertFresh();
        const result = await runScopedNexusSidecarBatch({...options,nexusScope:scope,executionClass,dispatchUnits:async input => {
            operation.assertFresh();
            const units = input.units.map(unit=>({...unit,request:{...unit.request,nexusScope:scope,
                assertExecutionFresh:()=>{operation.assertFresh();unit.request?.assertExecutionFresh?.();}}}));
            operation.inFlightUnits += units.length;
            try {
                const physicalRows = await dispatchWithRetainedEvidence(physicalDispatch,{...input,units,nexusScope:scope,operation});
                const rows = reconcileDispatchRows(units, physicalRows);
                operation.settledUnits += new Set(rows.map(row=>row.unit?.id).filter(Boolean)).size;
                operation.assertFresh();
                // Preserve the original logical-unit identity used by recovery replacement.
                return rows.map(row=>({...row,unit:input.units.find(unit=>unit.id===row.unit?.id)||row.unit}));
            } finally { operation.inFlightUnits=Math.max(0,operation.inFlightUnits-units.length); }
        }});
        operation.assertFresh();
        return result;
    } catch (error) {
        recordBatchOutcome({mode:'immediate',domain:operation.domain,stage:operation.stage,itemCount:operation.itemCount,
            state:operation.cancelled||isIntentionalCancellation(error)?'cancelled':'failed',error:String(error?.message||error),scope,sidecarOnly,mainEligible,executionClass});
        throw error;
    } finally {
        options.signal?.removeEventListener('abort',abort);
        activeImmediateOperations.delete(id);
    }
}


/**
 * Same logical Batch Layer contract, but physical units are supplied by the
 * abstract Model Worker pool. The caller provides dispatchUnits so Batch Layer
 * does not import Model Worker Bus (which would create a circular dependency).
 */
export async function runNexusModelWorkerBatch(options = {}) {
    if (typeof options.dispatchUnits !== 'function') throw new Error('Nexus model-worker batch requires a physical dispatchUnits adapter.');
    return runNexusSidecarBatch({ ...options, executionClass: 'model-worker' });
}

async function runScopedNexusSidecarBatch({
    domain,
    stage,
    items = [],
    buildRequest,
    parse,
    validate,
    buildRecovery,
    label,
    priority,
    role,
    executionMode,
    forceSlot,
    startSlot,
    dedupKey,
    telemetry,
    requestedBatch = true,
    allowPartial = true,
    maxBatchItems,
    targetInputTokens,
    recoveryAttempts = null,
    dispatchUnits = dispatchImmediateUnits,
    foregroundAdjacent = false,
    generationId = null,
    nexusScope = null,
    executionClass = 'sidecar',
} = {}) {
    const normalizedDomain = normalizeDomain(domain);
    const sidecarOnly = executionClass !== 'model-worker';
    const mainEligible = !sidecarOnly;
    if (!stage) throw new Error(`Nexus ${sidecarOnly ? 'Sidecar' : 'model-worker'} batch work requires an execution stage.`);
    if (typeof buildRequest !== 'function') throw new Error(`Nexus ${sidecarOnly ? 'Sidecar' : 'model-worker'} batch work requires a request builder.`);
    const settings = batchSettings();
    const maxRecoveryAttempts = recoveryAttempts == null ? settings.recoveryAttempts : clampNumber(recoveryAttempts, 0, 3, settings.recoveryAttempts);
    const source = Array.isArray(items) ? items.filter(item => item != null) : [];
    if (!source.length) return { domain: normalizedDomain, plan: createNexusBatchPlan({ domain: normalizedDomain, items: [] }), completed: [], failed: [], recoveredCount: 0, sidecarOnly, mainEligible, executionClass };

    const units = [];
    const initialBuildFailures = [];
    for (let index=0; index<source.length; index+=1) {
        const item=source[index];
        try {
            const request = buildRequest(item, { index, phase: 'initial' });
            if (!request || typeof request !== 'object') { const error=new Error(`Nexus batch request builder returned no request for slice ${index+1}.`); error.name='TV2BatchRequestBuildError'; throw error; }
            // If this batch owns a bounded semantic recovery builder, the first
            // domain-validation miss is not a terminal provider failure. Carry
            // that authority through Router -> JobQueue -> Sidecar telemetry so
            // diagnostics report "semantic repair needed" instead of poisoning
            // worker health/failure counts before the recovery attempt runs.
            if(typeof buildRecovery==='function')request.telemetry={...(request.telemetry||{}),recoverableSemanticAttempt:true};
            const domainValidator = structuredDomainValidator(parse, validate, item);
            if (domainValidator && typeof request.structuredValidator !== 'function') request.structuredValidator = domainValidator;
            if (typeof parse === 'function' && typeof request.synthesisCandidateParser !== 'function') request.synthesisCandidateParser = (text, response) => parse(text, item, response);
            units.push({ id:`${normalizedDomain}-${index+1}`, index, item, request, recovered:false });
        } catch(error) {
            const unit={id:`${normalizedDomain}-${index+1}`,index,item,request:null,recovered:false};
            initialBuildFailures.push({unit,state:'failed',error,recovered:false,requestBuildFailed:true});
        }
    }
    const plan = createNexusBatchPlan({
        domain: normalizedDomain,
        items: units,
        estimateInputTokens: unit => requestInputTokens(unit.request),
        maxBatchItems,
        targetInputTokens,
    });
    const rawInspection = inspectNexusBatchWork({
        domain: normalizedDomain,
        items: units,
        inputTokens: plan.totalEstimatedInputTokens,
        requestedBatch: requestedBatch && units.length > 1,
    });
    const inspection = sidecarOnly ? rawInspection : { ...rawInspection, sidecarOnly:false, mainEligible:true, executionClass };
    const canScatter = inspection.allowed && inspection.mode === 'batch' && domainEnabled(normalizedDomain, settings) && requestedBatch && units.length > 1;
    if (!inspection.allowed) { const error=new Error(inspection.reason || 'Nexus batch admission blocked this operation.'); error.name='TV2BatchAdmissionBlocked'; error.inspection=inspection; throw error; }
    const allOutcomes = [...initialBuildFailures];

    // Tree Builder already applies a per-request semantic token target before it
    // reaches the Batch Layer. Re-applying the generic aggregate wave-token
    // target here created tiny ~2-job parents (3500 + 3500 ~= 7000), forcing A/B
    // to synchronize at every pair. For Tree only, keep the planner waves for
    // diagnostics/admission truth but feed the physical Sidecar pool by the
    // operator's max-jobs-per-wave setting. runBatchPool keeps at most one job
    // active per Sidecar and hands the next queued slice to whichever slot frees
    // first, so this is bounded rolling execution rather than unbounded fanout.
    const rollingDispatch = canScatter;
    const treeRollingDispatch = normalizedDomain === NEXUS_BATCH_DOMAIN.TREE && rollingDispatch;
    // HOTFIX46.7 wires the HOTFIX46 learner into the generic physical wave
    // boundary. Tree remains exempt because its continuous pool is already the
    // anti-head-of-line execution shape; Builder multiplexing adapts upstream.
    const adaptivePolicy = adaptiveBatchWavePolicy({
        domain: normalizedDomain, stage, currentSize: plan.maxBatchItems, maxSize: plan.maxBatchItems,
        remainingItems: units.length, enabled: rollingDispatch && !treeRollingDispatch,
    });
    const plannedRollingGroups = rollingDispatch
        ? packNexusRollingDispatchGroups({ items: units, maxBatchItems: treeRollingDispatch ? plan.maxBatchItems : adaptivePolicy.effectiveSize }).groups
        : null;
    // Tree work must remain genuinely rolling across the whole semantic phase.
    // Splitting a 25-slice Builder survey into 10/10/5 parent pools created a
    // head-of-line barrier: the fast Sidecar could empty its part of a group and
    // then sit idle behind one slow sibling before the next group was admitted.
    // runBatchPool already enforces the real physical bound (one active request
    // per Sidecar), so a single parent pool is bounded without a wave barrier.
    const dispatchGroups = treeRollingDispatch
        ? [units]
        : rollingDispatch
            ? plannedRollingGroups
            : plan.batches.map(wave => wave.items.map(row => row.item));

    logEvent('nexus-batch', 'dispatch-shape', {
        domain: normalizedDomain,
        stage,
        semanticUnitCount: units.length,
        plannedWaveCount: plan.batchCount,
        plannedRollingGroupCount: plannedRollingGroups?.length ?? null,
        plannedRollingGroupSizes: plannedRollingGroups?.map(group => group.length) ?? null,
        physicalDispatchGroupCount: dispatchGroups.length,
        physicalGroupSizes: dispatchGroups.map(group => group.length),
        maxBatchItems: plan.maxBatchItems,
        targetInputTokens: plan.targetInputTokens,
        adaptiveWorkloadType: adaptivePolicy.enabled ? adaptivePolicy.workloadType : null,
        adaptiveContractVersion: adaptivePolicy.enabled ? adaptivePolicy.contractVersion : null,
        adaptiveConfiguredBatchItems: adaptivePolicy.enabled ? adaptivePolicy.configuredSize : null,
        adaptiveBatchItems: adaptivePolicy.enabled ? adaptivePolicy.effectiveSize : 0,
        treeRollingDispatch,
        continuousTreePool: treeRollingDispatch,
        sidecarOnly,
        mainEligible,
        executionClass,
    }, 'info');

    for (let dispatchIndex = 0; dispatchIndex < dispatchGroups.length; dispatchIndex += 1) {
        const work = dispatchGroups[dispatchIndex];
        const groups = groupNexusDispatchUnits(work, canScatter);
        const rows = [];
        for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
            const groupUnits = groups[groupIndex];
            const startedAt = globalThis.performance?.now?.() ?? Date.now();
            try {
                const groupRows = await dispatchUnits({
                    domain: normalizedDomain,
                    stage,
                    units: groupUnits,
                    label,
                    priority,
                    role,
                    executionMode,
                    forceSlot,
                    startSlot,
                    allowPartial: canScatter ? allowPartial : true,
                    dedupKey: dedupKey ? `${dedupKey}:dispatch:${dispatchIndex}:${groupIndex}` : null,
                    telemetry: {
                        ...(telemetry || {}),
                        nexusBatchPlannedWaveCount: plan.batchCount,
                        nexusBatchPhysicalDispatchGroupCount: dispatchGroups.length,
                        nexusBatchPhysicalDispatchIndex: dispatchIndex,
                        nexusBatchTreeRollingDispatch: treeRollingDispatch,
                    },
                    foregroundAdjacent,
                    generationId,
                });
                recordAdaptiveBatchWave({ policy:adaptivePolicy, units:groupUnits, rows:groupRows, latencyMs:(globalThis.performance?.now?.() ?? Date.now())-startedAt });
                rows.push(...groupRows);
            } catch (error) {
                recordAdaptiveBatchWave({ policy:adaptivePolicy, units:groupUnits, rows:[], latencyMs:(globalThis.performance?.now?.() ?? Date.now())-startedAt, error });
                throw error;
            }
        }
        for (const row of rows) {
            if (row.error) allOutcomes.push({ unit: row.unit, state: 'failed', error: row.error, jobId: row.jobId, recovered: false });
            else allOutcomes.push({ ...parseOutcome(row.unit, row.response, parse, validate), jobId: row.jobId });
        }
    }

    const recoveryCandidates = allOutcomes.filter(outcome => outcome.state !== 'completed' && !isIntentionalCancellation(outcome.error));
    for (let recoveryAttempt = 1; recoveryAttempt <= maxRecoveryAttempts; recoveryAttempt += 1) {
        const attemptRecoveryCandidates = recoveryCandidates
            .map(candidate => allOutcomes.find(outcome => outcome.unit?.index === candidate.unit?.index) || candidate)
            .filter(outcome => outcome.state !== 'completed' && !outcome.recoveryTerminal && !isIntentionalCancellation(outcome.error));
        if (!attemptRecoveryCandidates.length || typeof buildRecovery !== 'function') break;

        const recoveryUnits = [];
        for (const outcome of attemptRecoveryCandidates) {
            let request;
            try {
                request = buildRecovery(outcome.unit.item, outcome, {
                    phase: 'recovery', attempt: recoveryAttempt, maxAttempts: maxRecoveryAttempts,
                });
            } catch (error) {
                // Recovery construction is slice-local authority. One broken
                // builder must not discard already-valid sibling work.
                outcome.error = error;
                outcome.state = 'failed';
                outcome.recoveryTerminal = true;
                outcome.recoveryBuilderFailed = true;
                continue;
            }
            if (!request) { outcome.recoveryTerminal = true; continue; }
            const domainValidator = structuredDomainValidator(parse, validate, outcome.unit.item);
            if (domainValidator && typeof request.structuredValidator !== 'function') request.structuredValidator = domainValidator;
            if (typeof parse === 'function' && typeof request.synthesisCandidateParser !== 'function') {
                request.synthesisCandidateParser = (text, response) => parse(text, outcome.unit.item, response);
            }
            recoveryUnits.push({
                id: `${outcome.unit.id}-recovery-${recoveryAttempt}`,
                index: outcome.unit.index, item: outcome.unit.item, request, recovered: true,
                recoveryAttempt, replaces: outcome,
            });
        }

        if (!recoveryUnits.length) continue;
        logEvent('nexus-batch', 'slice-recovery-start', {
            domain: normalizedDomain, stage, recoveryCount: recoveryUnits.length,
            recoveryAttempt, maxRecoveryAttempts, sidecarOnly, mainEligible, executionClass,
        }, 'warn');
        const recoveryPlan = createNexusBatchPlan({
            domain: normalizedDomain, items: recoveryUnits,
            estimateInputTokens: unit => requestInputTokens(unit.request), maxBatchItems, targetInputTokens,
        });
        const recoveryAdaptivePolicy = adaptiveBatchWavePolicy({
            domain: normalizedDomain,
            stage: `${stage}:recovery`,
            currentSize: recoveryPlan.maxBatchItems,
            maxSize: recoveryPlan.maxBatchItems,
            remainingItems: recoveryUnits.length,
            enabled: canScatter && !treeRollingDispatch,
        });
        const plannedRecoveryRollingGroups = canScatter
            ? packNexusRollingDispatchGroups({ items: recoveryUnits, maxBatchItems: treeRollingDispatch ? recoveryPlan.maxBatchItems : recoveryAdaptivePolicy.effectiveSize }).groups
            : null;
        const recoveryDispatchGroups = treeRollingDispatch
            ? [recoveryUnits]
            : canScatter
                ? plannedRecoveryRollingGroups
                : recoveryPlan.batches.map(wave => wave.items.map(row => row.item));
        for (let dispatchIndex = 0; dispatchIndex < recoveryDispatchGroups.length; dispatchIndex += 1) {
            const work = recoveryDispatchGroups[dispatchIndex];
            const recoveryGroups = groupNexusDispatchUnits(work, canScatter);
            const rows = [];
            for (let groupIndex = 0; groupIndex < recoveryGroups.length; groupIndex += 1) {
                const groupUnits = recoveryGroups[groupIndex];
                const startedAt = globalThis.performance?.now?.() ?? Date.now();
                try {
                    const groupRows = await dispatchWithRetainedEvidence(dispatchUnits, {
                        domain: normalizedDomain, stage, units: groupUnits,
                        label: `${label || DOMAIN_LABEL[normalizedDomain]} recovery ${recoveryAttempt}/${maxRecoveryAttempts}`,
                        priority, role, executionMode, forceSlot, startSlot, allowPartial: true,
                        dedupKey: dedupKey ? `${dedupKey}:recovery-${recoveryAttempt}:${dispatchIndex}:${groupIndex}` : null,
                        telemetry: {
                            ...(telemetry || {}), nexusBatchRecovery: true, nexusBatchRecoveryAttempt: recoveryAttempt,
                            nexusBatchPlannedWaveCount: recoveryPlan.batchCount,
                            nexusBatchPhysicalDispatchGroupCount: recoveryDispatchGroups.length,
                            nexusBatchPhysicalDispatchIndex: dispatchIndex, nexusBatchTreeRollingDispatch: treeRollingDispatch,
                        },
                        foregroundAdjacent,
                        generationId,
                    });
                    recordAdaptiveBatchWave({ policy:recoveryAdaptivePolicy, units:groupUnits, rows:groupRows, latencyMs:(globalThis.performance?.now?.() ?? Date.now())-startedAt });
                    rows.push(...groupRows);
                } catch (error) {
                    recordAdaptiveBatchWave({ policy:recoveryAdaptivePolicy, units:groupUnits, rows:[], latencyMs:(globalThis.performance?.now?.() ?? Date.now())-startedAt, error });
                    throw error;
                }
            }
            for (const row of rows) {
                const replacementIndex = allOutcomes.indexOf(row.unit.replaces);
                const parsed = row.error
                    ? { unit: row.unit, state: 'failed', error: row.error, jobId: row.jobId, recovered: true, recoveryAttempt }
                    : { ...parseOutcome(row.unit, row.response, parse, validate), jobId: row.jobId, recoveryAttempt };
                if (replacementIndex >= 0) allOutcomes[replacementIndex] = parsed;
                else allOutcomes.push(parsed);
            }
        }
    }

    const completed = allOutcomes.filter(outcome => outcome.state === 'completed').sort((a, b) => a.unit.index - b.unit.index);
    const failed = allOutcomes.filter(outcome => outcome.state !== 'completed').sort((a, b) => a.unit.index - b.unit.index);
    const result = {
        domain: normalizedDomain,
        stage,
        sidecarOnly,
        mainEligible,
        executionClass,
        inspection,
        plan,
        completed,
        failed,
        recoveredCount: completed.filter(outcome => outcome.recovered).length,
    };
    recordBatchOutcome({ mode: 'immediate', domain: normalizedDomain, stage, itemCount: units.length, waveCount: plan.batchCount, completedCount: completed.length, failedCount: failed.length, recoveredCount: result.recoveredCount, state: failed.length ? 'partial' : 'completed', scope: nexusScope || units[0]?.request?.nexusScope || null, sidecarOnly, mainEligible, executionClass });
    logEvent('nexus-batch', 'scatter-gather-complete', {
        domain: normalizedDomain,
        stage,
        plannedBatches: plan.batchCount,
        completedCount: completed.length,
        failedCount: failed.length,
        recoveredCount: result.recoveredCount,
        plannedWaveCount: plan.batchCount,
        physicalDispatchGroupCount: dispatchGroups.length,
        treeRollingDispatch,
        sidecarOnly,
        mainEligible,
        executionClass,
    }, failed.length ? 'warn' : 'info');
    return result;
}

export function getNexusBatchStatus() {
    const settings = batchSettings();
    return {
        sidecarOnly: true,
        mainEligible: false,
        enabled: settings.enabled,
        coalesceMs: settings.coalesceMs,
        maxBatchItems: settings.maxBatchItems,
        targetInputTokens: settings.targetInputTokens,
        queuedUnits: queuedUnitCount(),
        inFlightCoalescedUnits: activeCoalescedUnitCount(),
        inFlightImmediateUnits: [...activeImmediateOperations.values()].reduce((n,op)=>n+(op.inFlightUnits||0),0),
        activeUnits: activeCoalescedUnitCount()+[...activeImmediateOperations.values()].reduce((n,op)=>n+(op.inFlightUnits||0),0),
        totalOutstandingUnits: queuedUnitCount()+activeCoalescedUnitCount()+[...activeImmediateOperations.values()].reduce((n,op)=>n+(op.inFlightUnits||0),0),
        activeImmediateOperations: [...activeImmediateOperations.values()].map(({id,scope,domain,stage,itemCount,inFlightUnits,settledUnits,startedAt,cancelled})=>({id,scope,domain,stage,itemCount,inFlightUnits,settledUnits,startedAt,cancelled})),
        lastOutcome: lastBatchOutcome ? { ...lastBatchOutcome } : null,
        domains: Object.values(NEXUS_BATCH_DOMAIN).map(domain => ({
            domain,
            label: DOMAIN_LABEL[domain],
            enabled: domainEnabled(domain, settings),
            sidecarOnly: true,
            mainEligible: false,
        })),
    };
}

/** Lightweight runtime facade used by Nexus's composition root and tests. */
export class NexusBatchLayer {
    inspect(input) { return inspectNexusBatchWork(input); }
    plan(input) { return createNexusBatchPlan(input); }
    status() { return getNexusBatchStatus(); }
    run(input) { return runNexusSidecarBatch(input); }
}
