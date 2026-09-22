const profiles = new Map();
const DEFAULT_WINDOW = 32;

function clampInt(value, min, max, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.floor(n))) : fallback;
}
function clean(value, fallback = 'unknown') {
    const text = String(value ?? '').trim();
    return text || fallback;
}
function positive(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Physical learning identity. Workload semantics and provider topology are
 * deliberately both present: the same model/lane can have very different
 * optimal request shapes for Builder, maintenance, UID summary, etc.
 */
export function createAdaptiveProfileKey({
    workloadType = 'unknown',
    provider = 'unknown',
    profile = 'unknown',
    model = 'unknown',
    worker = 'AUTO',
    contractVersion = 'v1',
} = {}) {
    return [
        clean(workloadType),
        clean(provider),
        clean(profile),
        clean(model),
        clean(worker, 'AUTO').toUpperCase(),
        clean(contractVersion, 'v1'),
    ].join('|');
}

function profileFor(key) {
    const id = clean(key);
    if (!profiles.has(id)) profiles.set(id, { profileKey: id, samples: [], updatedAt: 0, recommendedSize: null });
    return profiles.get(id);
}

export function recordThroughputSample({
    profileKey,
    batchSize = 1,
    successfulItems = 0,
    latencyMs = 0,
    outcome = 'success',
    inputTokens = 0,
    outputTokens = 0,
    providerContextTokens = 0,
    requestMaxTokens = 0,
    at = Date.now(),
} = {}) {
    const profile = profileFor(profileKey);
    const sample = {
        batchSize: clampInt(batchSize, 1, 1000, 1),
        successfulItems: Math.max(0, Number(successfulItems) || 0),
        latencyMs: Math.max(0, Number(latencyMs) || 0),
        outcome: clean(outcome, 'success').toLowerCase(),
        inputTokens: Math.max(0, Number(inputTokens) || 0),
        outputTokens: Math.max(0, Number(outputTokens) || 0),
        providerContextTokens: Math.max(0, Number(providerContextTokens) || 0),
        requestMaxTokens: Math.max(0, Number(requestMaxTokens) || 0),
        at: Number(at) || Date.now(),
    };
    sample.success = sample.outcome === 'success' && sample.successfulItems > 0;
    sample.throughput = sample.success && sample.latencyMs > 0
        ? sample.successfulItems / (sample.latencyMs / 1000)
        : 0;
    sample.tokenThroughput = sample.success && sample.latencyMs > 0
        ? (sample.inputTokens + sample.outputTokens) / (sample.latencyMs / 1000)
        : 0;
    sample.contextPressure = sample.providerContextTokens > 0
        ? Math.min(10, (sample.inputTokens + sample.outputTokens) / sample.providerContextTokens)
        : 0;
    sample.outputPressure = sample.requestMaxTokens > 0
        ? Math.min(10, sample.outputTokens / sample.requestMaxTokens)
        : 0;

    profile.samples.push(sample);
    if (profile.samples.length > DEFAULT_WINDOW) profile.samples.splice(0, profile.samples.length - DEFAULT_WINDOW);
    profile.updatedAt = sample.at;
    return { ...sample };
}

function percentile(sorted, p) {
    return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))] : 0;
}

function aggregateBySize(samples = []) {
    const by = new Map();
    for (const sample of samples) {
        const row = by.get(sample.batchSize) || {
            batchSize: sample.batchSize,
            calls: 0,
            successes: 0,
            failures: 0,
            timeouts: 0,
            throughputTotal: 0,
            tokenThroughputTotal: 0,
            latencies: [],
            contextPressureMax: 0,
            outputPressureMax: 0,
            inputTokensTotal: 0,
            outputTokensTotal: 0,
        };
        row.calls += 1;
        if (sample.success) {
            row.successes += 1;
            row.throughputTotal += sample.throughput;
            row.tokenThroughputTotal += positive(sample.tokenThroughput);
        } else row.failures += 1;
        if (sample.outcome === 'timeout' || sample.outcome === 'truncated') row.timeouts += 1;
        if (sample.latencyMs > 0) row.latencies.push(sample.latencyMs);
        row.contextPressureMax = Math.max(row.contextPressureMax, positive(sample.contextPressure));
        row.outputPressureMax = Math.max(row.outputPressureMax, positive(sample.outputPressure));
        row.inputTokensTotal += positive(sample.inputTokens);
        row.outputTokensTotal += positive(sample.outputTokens);
        by.set(sample.batchSize, row);
    }

    return [...by.values()].map(row => {
        const sorted = [...row.latencies].sort((a, b) => a - b);
        const reliability = row.calls ? row.successes / row.calls : 0;
        const avgThroughput = row.successes ? row.throughputTotal / row.successes : 0;
        const avgTokenThroughput = row.successes ? row.tokenThroughputTotal / row.successes : 0;
        const p50LatencyMs = percentile(sorted, 0.5);
        const p90LatencyMs = percentile(sorted, 0.9);
        const capacityPressure = Math.max(row.contextPressureMax, row.outputPressureMax);
        // Throughput is useful for diagnostics, but completion-time estimates
        // below are the actual selection objective. Reliability/capacity are
        // penalties rather than alternate semantic criteria.
        const score = avgThroughput * reliability * Math.max(0.1, 1 - Math.max(0, capacityPressure - 0.70));
        return {
            ...row,
            reliability,
            avgThroughput,
            avgTokenThroughput,
            p50LatencyMs,
            p90LatencyMs,
            avgInputTokens: row.calls ? row.inputTokensTotal / row.calls : 0,
            avgOutputTokens: row.calls ? row.outputTokensTotal / row.calls : 0,
            capacityPressure,
            score,
        };
    }).sort((a, b) => a.batchSize - b.batchSize);
}

function estimatedCompletionMs(row, remainingItems) {
    const remaining = Math.max(1, Math.floor(Number(remainingItems) || row.batchSize));
    const calls = Math.max(1, Math.ceil(remaining / Math.max(1, row.batchSize)));
    const latency = positive(row.p90LatencyMs) || positive(row.p50LatencyMs) || 1;
    // Expected retries are represented as a reliability penalty. This keeps a
    // superficially fast but flaky shape from winning the whole-job estimate.
    const reliability = Math.max(0.25, Math.min(1, Number(row.reliability) || 0.25));
    const capacityPenalty = 1 + Math.max(0, (Number(row.capacityPressure) || 0) - 0.75) * 3;
    return (calls * latency * capacityPenalty) / reliability;
}

function pressuredCurrent(recent, current) {
    const rows = recent.filter(row => row.batchSize === current).slice(-4);
    if (!rows.length) return false;
    return rows.some(row => Math.max(Number(row.contextPressure) || 0, Number(row.outputPressure) || 0) >= 0.82);
}

/**
 * Choose the physical shape predicted to finish the remaining workload fastest
 * while staying inside reliability/capacity/deadline evidence. This changes
 * request geometry only; semantic item coverage is untouched.
 */
export function recommendAdaptiveBatchSize({
    profileKey,
    currentSize = 1,
    minSize = 1,
    maxSize = 50,
    remainingItems = null,
    availableWindowMs = null,
} = {}) {
    const min = clampInt(minSize, 1, 1000, 1);
    const max = Math.max(min, clampInt(maxSize, min, 1000, 50));
    const fallbackCurrent = clampInt(currentSize, min, max, min);
    const profile = profileFor(profileKey);
    const current = Number.isFinite(Number(profile.recommendedSize)) && Number(profile.recommendedSize) > 0
        ? clampInt(profile.recommendedSize, min, max, fallbackCurrent)
        : fallbackCurrent;
    const commit = value => {
        const next = clampInt(value, min, max, current);
        profile.recommendedSize = next;
        return next;
    };
    if (!profile.samples.length) return commit(current);

    const recent = profile.samples.slice(-DEFAULT_WINDOW);
    const latest = recent[recent.length - 1];
    if (latest && ['timeout', 'truncated'].includes(latest.outcome) && latest.batchSize === current) {
        return commit(Math.max(min, Math.min(max, Math.floor(current * 0.6))));
    }
    if (pressuredCurrent(recent, current)) {
        return commit(Math.max(min, Math.min(max, current - Math.max(1, Math.ceil(current * 0.25)))));
    }

    const aggregates = aggregateBySize(recent).filter(row => row.successes >= 2);
    if (!aggregates.length) return commit(current);
    const healthy = aggregates.filter(row => row.reliability >= 0.8 && row.timeouts === 0 && row.capacityPressure < 0.92);
    let candidates = healthy.length ? healthy : aggregates.filter(row => row.timeouts === 0);
    if (!candidates.length) candidates = aggregates;

    const windowMs = positive(availableWindowMs);
    if (windowMs > 0) {
        const fitting = candidates.filter(row => positive(row.p90LatencyMs) > 0 && row.p90LatencyMs <= windowMs);
        if (fitting.length) candidates = fitting;
    }

    const remaining = remainingItems == null ? Math.max(current, ...candidates.map(row => row.batchSize)) : Math.max(1, Math.floor(Number(remainingItems) || 1));
    candidates = [...candidates].sort((a, b) => {
        const time = estimatedCompletionMs(a, remaining) - estimatedCompletionMs(b, remaining);
        if (Math.abs(time) > 0.001) return time;
        return b.reliability - a.reliability || b.score - a.score || a.batchSize - b.batchSize;
    });
    const best = candidates[0];
    if (best && best.batchSize !== current) return commit(Math.max(min, Math.min(max, best.batchSize)));

    const tail = recent.slice(-5);
    const healthyStreak = tail.length >= 4 && tail.every(row => row.success && row.batchSize === current
        && Math.max(Number(row.contextPressure) || 0, Number(row.outputPressure) || 0) < 0.75);
    // Exploration is intentionally one step at a time. A larger request must
    // earn its own measurements before it can become the new physical shape.
    if (healthyStreak && current < max && (!windowMs || (best?.p90LatencyMs || 0) < windowMs * 0.75)) return commit(current + 1);
    return commit(current);
}

/**
 * Return independent physical recommendations for currently eligible lanes.
 * Callers that cannot choose a lane before composing a physical envelope may
 * use sharedSafeSize; lane-aware dispatchers can consume byWorker directly.
 */
export function recommendAdaptiveBatchPlan({
    workloadType = 'unknown',
    profiles: physicalProfiles = [],
    currentSize = 1,
    minSize = 1,
    maxSize = 50,
    contractVersion = 'v1',
    remainingItems = null,
    availableWindowMs = null,
} = {}) {
    const byWorker = {};
    for (const row of Array.isArray(physicalProfiles) ? physicalProfiles : []) {
        const worker = clean(row?.worker, 'AUTO').toUpperCase();
        const profileKey = createAdaptiveProfileKey({
            workloadType,
            provider: row?.provider,
            profile: row?.profile,
            model: row?.model,
            worker,
            contractVersion,
        });
        const recommendedSize = recommendAdaptiveBatchSize({
            profileKey,
            currentSize,
            minSize,
            maxSize,
            remainingItems,
            availableWindowMs,
        });
        byWorker[worker] = { profileKey, recommendedSize };
    }
    const recommendations = Object.values(byWorker).map(row => row.recommendedSize);
    return {
        workloadType: clean(workloadType),
        byWorker,
        sharedSafeSize: recommendations.length ? Math.max(minSize, Math.min(...recommendations)) : clampInt(currentSize, minSize, maxSize, minSize),
    };
}


const MODEL_WORKER_PHYSICAL_CONTRACT = 'model-worker-physical-v1';

function physicalWorkerProfileKey(workloadType, worker, contractVersion = MODEL_WORKER_PHYSICAL_CONTRACT) {
    return createAdaptiveProfileKey({
        workloadType,
        provider: 'AUTO',
        profile: 'physical-worker',
        model: 'AUTO',
        worker,
        contractVersion,
    });
}

/**
 * Record one physical Model Worker unit against both the stable worker identity
 * (MAIN/A/B) and, when known, the concrete provider/model profile. Pool-level
 * wave learning remains separate; this evidence is for heterogeneous routing.
 */
export function recordAdaptivePhysicalWorkerSample({
    workloadType = 'unknown', worker = 'AUTO', provider = 'AUTO', profile = 'physical-worker', model = 'AUTO',
    contractVersion = MODEL_WORKER_PHYSICAL_CONTRACT, successfulItems = 1, latencyMs = 0, outcome = 'success',
    inputTokens = 0, outputTokens = 0, providerContextTokens = 0, requestMaxTokens = 0, at = Date.now(),
} = {}) {
    const normalizedWorker = clean(worker, 'AUTO').toUpperCase();
    const aggregateKey = physicalWorkerProfileKey(workloadType, normalizedWorker, contractVersion);
    const detailedKey = createAdaptiveProfileKey({ workloadType, provider, profile, model, worker:normalizedWorker, contractVersion });
    const sample = {
        batchSize:1, successfulItems, latencyMs, outcome, inputTokens, outputTokens,
        providerContextTokens, requestMaxTokens, at,
    };
    const aggregate = recordThroughputSample({ profileKey:aggregateKey, ...sample });
    if (detailedKey !== aggregateKey) recordThroughputSample({ profileKey:detailedKey, ...sample });
    return { worker:normalizedWorker, aggregateKey, detailedKey, sample:aggregate };
}

function physicalWorkerEvidence(workloadType, worker, contractVersion = MODEL_WORKER_PHYSICAL_CONTRACT) {
    const profileKey = physicalWorkerProfileKey(workloadType, worker, contractVersion);
    const profile = profileFor(profileKey);
    const recent = profile.samples.slice(-DEFAULT_WINDOW);
    const successes = recent.filter(row => row.success);
    const failures = recent.filter(row => !row.success);
    if (!recent.length) return { worker, profileKey, sampleCount:0, successCount:0, reliability:null, predictedUnitMs:null, avgTokenThroughput:0, cold:true };
    const latencies = successes.map(row => positive(row.latencyMs)).filter(Boolean).sort((a,b)=>a-b);
    const p50LatencyMs = percentile(latencies, 0.5);
    const p90LatencyMs = percentile(latencies, 0.9);
    const reliability = successes.length / recent.length;
    const avgTokenThroughput = successes.length ? successes.reduce((sum,row)=>sum+positive(row.tokenThroughput),0)/successes.length : 0;
    // Use a reliability-penalized tail estimate. This deliberately makes a
    // flaky but superficially fast worker less attractive for batch makespan.
    const base = p90LatencyMs || p50LatencyMs || 0;
    const predictedUnitMs = base > 0 ? base / Math.max(0.35, reliability) : null;
    return {
        worker, profileKey, sampleCount:recent.length, successCount:successes.length, failureCount:failures.length,
        reliability, p50LatencyMs, p90LatencyMs, predictedUnitMs, avgTokenThroughput,
        cold:successes.length < 2,
    };
}

function simulatePhysicalSchedule(unitCount, evidenceRows) {
    const total = Math.max(1, Math.floor(Number(unitCount)||1));
    const rows = evidenceRows.filter(row => Number(row?.predictedUnitMs) > 0);
    if (!rows.length) return null;
    const clocks = rows.map(row => ({ worker:row.worker, t:0, unitMs:row.predictedUnitMs, assigned:0 }));
    for (let i=0;i<total;i++) {
        clocks.sort((a,b)=>a.t-b.t || a.unitMs-b.unitMs || String(a.worker).localeCompare(String(b.worker)));
        clocks[0].t += clocks[0].unitMs;
        clocks[0].assigned += 1;
    }
    return {
        makespanMs:Math.max(...clocks.map(row=>row.t)),
        assignments:Object.fromEntries(clocks.map(row=>[row.worker,row.assigned])),
    };
}

/**
 * Decide whether the single Main lane should join a dynamic heterogeneous pool.
 * Sidecar A/B eligibility is still owned by the Sidecar Bus. Cold profiles
 * explore all legal resources; once every compared worker has evidence, Main is
 * included only when it improves predicted whole-workload completion or is the
 * only legal worker. Semantic units are never dropped or rewritten.
 */
export function recommendAdaptivePhysicalWorkerPlan({
    workloadType = 'unknown', workers = [], unitCount = 1, contractVersion = MODEL_WORKER_PHYSICAL_CONTRACT,
    improvementThreshold = 0.03,
} = {}) {
    const normalized = [...new Set((workers||[]).map(row=>clean(row,'').toUpperCase()).filter(Boolean))];
    const evidence = Object.fromEntries(normalized.map(worker=>[worker, physicalWorkerEvidence(workloadType,worker,contractVersion)]));
    const hasMain = normalized.includes('MAIN');
    const sidecars = normalized.filter(worker=>worker!=='MAIN');
    if (!hasMain) return { workloadType:clean(workloadType), workers:normalized, activeWorkers:normalized, mainParticipates:false, reason:'main-unavailable', evidence };
    if (!sidecars.length) return { workloadType:clean(workloadType), workers:normalized, activeWorkers:['MAIN'], mainParticipates:true, reason:'main-only', evidence };
    const compared = ['MAIN',...sidecars].map(worker=>evidence[worker]);
    if (compared.some(row=>row.cold || !(Number(row.predictedUnitMs)>0))) {
        return { workloadType:clean(workloadType), workers:normalized, activeWorkers:normalized, mainParticipates:true, reason:'cold-exploration', evidence };
    }
    const sidecarRows = sidecars.map(worker=>evidence[worker]);
    const withMain = simulatePhysicalSchedule(unitCount, compared);
    const sidecarOnly = simulatePhysicalSchedule(unitCount, sidecarRows);
    const withMainMs = withMain?.makespanMs ?? null;
    const sidecarOnlyMs = sidecarOnly?.makespanMs ?? null;
    if (!(Number(sidecarOnlyMs)>0) || !(Number(withMainMs)>0)) {
        return { workloadType:clean(workloadType), workers:normalized, activeWorkers:normalized, mainParticipates:true, reason:'insufficient-estimate', evidence, predictedWithMainMs:withMainMs, predictedSidecarOnlyMs:sidecarOnlyMs, predictedAssignments:withMain?.assignments||null };
    }
    const improvement = (sidecarOnlyMs-withMainMs)/sidecarOnlyMs;
    const mainParticipates = improvement >= Math.max(0,Number(improvementThreshold)||0);
    return {
        workloadType:clean(workloadType), workers:normalized,
        activeWorkers:mainParticipates?normalized:sidecars, mainParticipates,
        reason:mainParticipates?'predicted-makespan-improvement':'predicted-main-straggler',
        predictedWithMainMs:withMainMs, predictedSidecarOnlyMs:sidecarOnlyMs, improvement, evidence,
        predictedAssignments:mainParticipates?withMain?.assignments||null:sidecarOnly?.assignments||null,
    };
}

export function getAdaptivePhysicalWorkerEvidence(workloadType = 'unknown', workers = ['MAIN','A','B'], contractVersion = MODEL_WORKER_PHYSICAL_CONTRACT) {
    return Object.fromEntries((workers||[]).map(worker=>{const key=clean(worker,'AUTO').toUpperCase();return [key,physicalWorkerEvidence(workloadType,key,contractVersion)];}));
}

export function getThroughputProfileSnapshot() {
    return [...profiles.values()].map(profile => ({
        profileKey: profile.profileKey,
        updatedAt: profile.updatedAt,
        sampleCount: profile.samples.length,
        recommendedSize: profile.recommendedSize,
        byBatchSize: aggregateBySize(profile.samples),
    }));
}

export function resetAdaptiveThroughputProfiles() { profiles.clear(); }
