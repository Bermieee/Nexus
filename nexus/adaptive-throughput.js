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
