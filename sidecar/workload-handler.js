/**
 * Nexus Sidecar Workload Handler
 *
 * Sidecar A and B are full-capability workers. Routing preferences are hints,
 * not hard capability walls. Assignment is admission-aware: queue load,
 * priority reservations and transient worker health are considered before a
 * slot is selected. Retry/fallback classification is failure-domain aware so
 * request/backend-bound failures are not replayed unchanged merely because a
 * second credential exists.
 */

export function normalizeWorkerLock(value) {
    const slot = String(value || '').trim().toUpperCase();
    return slot === 'A' || slot === 'B' ? slot : null;
}

function slotFromResourceKey(resourceKey) {
    const match = /^sidecar:([AB])$/i.exec(String(resourceKey || ''));
    return match ? match[1].toUpperCase() : null;
}

export function summarizeSidecarLoad(queueSnapshot = [], slot) {
    const normalized = String(slot || '').toUpperCase();
    let running = 0;
    let queued = 0;
    for (const job of Array.isArray(queueSnapshot) ? queueSnapshot : []) {
        const assigned = String(job?.meta?.assignedSlot || '').toUpperCase() || slotFromResourceKey(job?.resourceKey);
        if (assigned !== normalized) continue;
        if (job?.state === 'running') running += 1;
        else if (job?.state === 'queued') queued += 1;
    }
    return {
        slot: normalized,
        running,
        queued,
        total: running + queued,
        idle: running === 0 && queued === 0,
    };
}

function floorAllows(priority, floor) {
    return !Number.isFinite(Number(floor)) || Number(priority) >= Number(floor);
}

export function chooseWorkloadSlot({
    preferredSlot = 'A',
    enabledSlots = ['A', 'B'],
    queueSnapshot = [],
    loadBalance = true,
    priority = 50,
    priorityFloors = {},
    health = {},
} = {}) {
    const enabled = [...new Set((enabledSlots || []).map(s => String(s).toUpperCase()).filter(s => s === 'A' || s === 'B'))];
    const preferred = ['A', 'B'].includes(String(preferredSlot).toUpperCase()) ? String(preferredSlot).toUpperCase() : 'A';
    const alternate = preferred === 'A' ? 'B' : 'A';
    const loads = {
        A: summarizeSidecarLoad(queueSnapshot, 'A'),
        B: summarizeSidecarLoad(queueSnapshot, 'B'),
    };
    const healthyEnabled = enabled.filter(slot => health?.[slot]?.eligible !== false);
    const admissible = healthyEnabled.filter(slot => floorAllows(priority, priorityFloors?.[slot]));

    if (!admissible.length) {
        const queueSlot = healthyEnabled.includes(preferred) ? preferred : (healthyEnabled[0] || null);
        return {
            assignedSlot: null,
            queueSlot,
            preferredSlot: preferred,
            reason: enabled.length ? 'no-admissible-worker' : 'no-enabled-worker',
            offloaded: false,
            loads,
            priorityFloors: { ...priorityFloors },
            health,
        };
    }
    if (!admissible.includes(preferred)) {
        const assignedSlot = admissible[0];
        return {
            assignedSlot,
            preferredSlot: preferred,
            reason: enabled.includes(preferred) ? 'preferred-admission-blocked' : 'preferred-disabled',
            offloaded: assignedSlot !== preferred,
            loads,
            priorityFloors: { ...priorityFloors },
            health,
        };
    }
    if (!loadBalance || !admissible.includes(alternate)) {
        return { assignedSlot: preferred, preferredSlot: preferred, reason: loadBalance ? 'only-admissible-worker' : 'load-balancing-disabled', offloaded: false, loads, priorityFloors: { ...priorityFloors }, health };
    }

    const preferredFailures = Math.max(0, Number(health?.[preferred]?.failures) || 0);
    const alternateFailures = Math.max(0, Number(health?.[alternate]?.failures) || 0);
    if (preferredFailures > alternateFailures) {
        return { assignedSlot: alternate, preferredSlot: preferred, reason: 'health-offload', offloaded: true, loads, priorityFloors: { ...priorityFloors }, health };
    }

    const preferredLoad = loads[preferred];
    const alternateLoad = loads[alternate];
    if (alternateLoad.total < preferredLoad.total) {
        return {
            assignedSlot: alternate,
            preferredSlot: preferred,
            reason: alternateLoad.idle ? 'idle-offload' : 'least-loaded-offload',
            offloaded: true,
            loads,
            priorityFloors: { ...priorityFloors },
            health,
        };
    }

    return {
        assignedSlot: preferred,
        preferredSlot: preferred,
        reason: preferredLoad.idle ? 'preferred-idle' : 'preferred-tie-or-lighter',
        offloaded: false,
        loads,
        priorityFloors: { ...priorityFloors },
        health,
    };
}

function normalizedFailureProfile(profile = {}) {
    const numeric = value => {
        const number = Number(value);
        return Number.isFinite(number) ? number : null;
    };
    const endpointIdentity = value => {
        const raw = String(value || '').trim();
        try {
            const url = new URL(raw);
            return `${url.protocol.toLowerCase()}//${url.host.toLowerCase()}${url.pathname.replace(/\/+$/, '') || '/'}${url.search}`;
        } catch { return raw.replace(/\/+$/, ''); }
    };
    const credentialRaw = String(profile?.credentialId || profile?.accountId || profile?.apiKey || profile?.headers?.Authorization || '');
    let credentialHash = 2166136261;
    for (const ch of credentialRaw) { credentialHash ^= ch.charCodeAt(0); credentialHash = Math.imul(credentialHash, 16777619); }
    return {
        format: String(profile?.format || 'openai').toLowerCase(),
        endpoint: endpointIdentity(profile?.endpoint),
        model: String(profile?.model || '').trim().toLowerCase(),
        credentialIdentity: credentialRaw ? (credentialHash >>> 0).toString(36) : '',
        temperature: numeric(profile?.temperature),
        reasoningEffort: String(profile?.reasoningEffort || '').toLowerCase(),
        providerMaxTokens: numeric(profile?.providerMaxTokens ?? profile?.maxOutputTokens ?? profile?.maxCompletionTokens ?? profile?.max_output_tokens),
        providerContextTokens: numeric(profile?.providerContextTokens ?? profile?.contextWindowTokens ?? profile?.contextLengthTokens ?? profile?.context_length),
        inputBudgetTokens: numeric(profile?.inputBudgetTokens),
        outputCeilingTokens: numeric(profile?.outputCeilingTokens),
        totalBudgetTokens: numeric(profile?.totalBudgetTokens),
        emergencyContextTokens: numeric(profile?.emergencyContextTokens),
        emergencyOutputTokens: numeric(profile?.emergencyOutputTokens),
        timeoutMs: numeric(profile?.timeoutMs),
    };
}

function sameMaterialRequestProfile(a, b) {
    return a.format === b.format
        && a.endpoint === b.endpoint
        && a.model === b.model
        && a.temperature === b.temperature
        && a.reasoningEffort === b.reasoningEffort
        && a.providerMaxTokens === b.providerMaxTokens
        && a.providerContextTokens === b.providerContextTokens
        && a.inputBudgetTokens === b.inputBudgetTokens
        && a.outputCeilingTokens === b.outputCeilingTokens
        && a.totalBudgetTokens === b.totalBudgetTokens
        && a.emergencyContextTokens === b.emergencyContextTokens
        && a.emergencyOutputTokens === b.emergencyOutputTokens
        && a.timeoutMs === b.timeoutMs;
}


export function sameSidecarProviderModel(left, right) {
    const a = normalizedFailureProfile(left);
    const b = normalizedFailureProfile(right);
    return !!a.endpoint && !!a.model && a.format===b.format && a.endpoint===b.endpoint && a.model===b.model;
}

export function sameSidecarCapacity(left, right) {
    const a = normalizedFailureProfile(left);
    const b = normalizedFailureProfile(right);
    return !!a.endpoint && !!a.model
        && a.format === b.format
        && a.endpoint === b.endpoint
        && a.model === b.model
        && a.credentialIdentity === b.credentialIdentity;
}

export function sameSidecarBackend(left, right) {
    const a = normalizedFailureProfile(left);
    const b = normalizedFailureProfile(right);
    return !!a.endpoint && !!a.model && sameMaterialRequestProfile(a, b);
}

export function sameSidecarFailureProfile(left, right) {
    const a = normalizedFailureProfile(left);
    const b = normalizedFailureProfile(right);
    return !!a.endpoint && !!a.model
        && sameMaterialRequestProfile(a, b)
        && a.credentialIdentity === b.credentialIdentity;
}

function statusOf(error) {
    const value = Number(error?.status ?? error?.statusCode ?? error?.httpStatus ?? error?.response?.status);
    return Number.isFinite(value) ? value : null;
}

export function sidecarFailureDomain(error) {
    if (error?.retryable === false) return 'terminal';
    const name = String(error?.name || '');
    const status = statusOf(error);
    if (error?.workerLocal === true || ['TV2SidecarWorkerUnavailable','TV2ExecutionProfileRetired'].includes(name)) return 'worker';
    if (error?.backendBound === true) return 'backend';
    if (error?.semantic === true) return 'backend';
    if ([
        'NexusSemanticValidationError',
        'NexusSemanticRecoveryFailed',
        'NexusStructuredResponseError',
        'NexusSidecarReasoningExhausted',
        'NexusSidecarRunawayDetected',
        'NexusParentBatchBackendCircuitOpen',
        'TV2SidecarTruncated',
        'TV2SidecarEmptyFinal',
        'TV2SidecarTimeout',
        'NexusSidecarProviderBoundaryError',
    ].includes(name)) return 'backend';
    // Generic 400-class request/schema failures are deterministic for an
    // unchanged endpoint/model. Authentication/account/rate-limit failures are
    // explicitly credential/account-bound and may use an independent key.
    if (status === 400 || status === 404 || status === 405 || status === 409 || status === 413 || status === 415 || status === 422) return 'backend';
    if (status === 401 || status === 403 || status === 407 || status === 429) return 'credential';
    if (status != null && status >= 500) return 'backend';
    if (name === 'TypeError' && /fetch|network|socket|connection/i.test(String(error?.message || ''))) return 'backend';
    return 'credential-or-transport';
}

export function isBackendBoundSidecarFailure(error) {
    return sidecarFailureDomain(error) === 'backend';
}

export function shouldRetrySidecarFailure({ error, failedProfile, nextProfile, allowSameProviderModelTimeoutRetry = false } = {}) {
    if (!error) return true;
    if (error?.retryable === false) return false;
    const domain = sidecarFailureDomain(error);
    if (domain === 'worker') return true;
    if (domain === 'backend') {
        // Transport deadlines are capacity failures: changing tuning knobs on the same
        // endpoint/account/model does not create an independent retry lane. Semantic
        // incompatibilities retain the older backend/model comparison, where a different
        // credential cannot make an incompatible request shape valid.
        if (String(error?.name||'') === 'TV2SidecarTimeout') {
            if (allowSameProviderModelTimeoutRetry === true) return true;
            return !sameSidecarProviderModel(failedProfile, nextProfile);
        }
        return !sameSidecarBackend(failedProfile, nextProfile);
    }
    if (domain === 'credential') return !sameSidecarCapacity(failedProfile, nextProfile);
    // Unknown transport/account failures may retry only when provider capacity
    // is materially independent. Tuning knobs do not turn the same endpoint/account/model
    // into redundant capacity.
    return !sameSidecarCapacity(failedProfile, nextProfile);
}
