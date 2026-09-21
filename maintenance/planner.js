
export const MAINTENANCE_PRESSURE = Object.freeze({
    NORMAL: 'normal',
    ELEVATED: 'elevated',
    CONGESTED: 'congested',
});

function median(values = []) {
    const rows = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
    if (!rows.length) return 0;
    const middle = Math.floor(rows.length / 2);
    return rows.length % 2 ? rows[middle] : (rows[middle - 1] + rows[middle]) / 2;
}

function recentSidecarEvents(events = [], limit = 16, activeModels = []) {
    const models = new Set((Array.isArray(activeModels) ? activeModels : []).map(value => String(value || '').trim()).filter(Boolean));
    return (Array.isArray(events) ? events : [])
        .filter(event => /^sidecar-[ab]$/.test(String(event?.category || '')) && ['request-success', 'request-failure'].includes(String(event?.name || '')))
        .filter(event => String(event?.data?.role || '') !== 'connectivity-test')
        .filter(event => !models.size || !event?.data?.model || models.has(String(event.data.model)))
        .slice(-Math.max(1, limit));
}

/**
 * Runtime pressure is advisory scheduling input, never a hard stop.  It uses
 * queue occupancy plus recent Sidecar latency relative to the configured
 * Notebook timeout so the same policy scales from very fast Qwen workers to
 * slower reasoning models without baking a model name into Nexus.
 */
export function classifyMaintenancePressure({ queue = {}, events = [], timeoutMs = 120000, activeModels = [] } = {}) {
    const recent = recentSidecarEvents(events, 16, activeModels);
    const latencies = recent.map(event => Number(event?.data?.latencyMs)).filter(Number.isFinite);
    const recentTimeouts = recent.filter(event => /timeout/i.test(String(event?.data?.error?.name || event?.data?.error?.message || ''))).length;
    const p50LatencyMs = Math.round(median(latencies));
    const configuredTimeoutMs = Math.max(1000, Number(timeoutMs) || 120000);
    const latencyRatio = p50LatencyMs > 0 ? p50LatencyMs / configuredTimeoutMs : 0;
    const queued = Number(queue?.queued?.length || 0);
    const running = Number(queue?.running?.length || 0);
    const bothLanesBusy = ['A', 'B'].every(slot => Number(queue?.lanes?.[slot]?.running?.length || 0) > 0);

    let level = MAINTENANCE_PRESSURE.NORMAL;
    const reasons = [];
    if (recentTimeouts > 0) reasons.push('recent-sidecar-timeout');
    if (bothLanesBusy && queued > 0) reasons.push('both-sidecars-busy-with-backlog');
    if (queued >= 3) reasons.push('queue-backlog');
    if (latencyRatio >= 0.45) reasons.push('recent-latency-near-timeout');
    if (reasons.length) level = MAINTENANCE_PRESSURE.CONGESTED;
    else {
        if (queued > 0) reasons.push('queued-work');
        if (running >= 2) reasons.push('both-sidecars-busy');
        if (latencyRatio >= 0.20) reasons.push('elevated-sidecar-latency');
        if (reasons.length) level = MAINTENANCE_PRESSURE.ELEVATED;
    }
    return {
        level,
        queued,
        running,
        bothLanesBusy,
        recentSamples: recent.length,
        recentTimeouts,
        p50LatencyMs,
        timeoutMs: configuredTimeoutMs,
        latencyRatio,
        reasons,
    };
}

export function inspectMaintenancePressure({ queue = {}, events = [], timeoutMs = 120000, activeModels = [] } = {}) {
    return classifyMaintenancePressure({ queue, events, timeoutMs, activeModels });
}


/**
 * Cheap deterministic preflight.  Major/cold-start Notebook work is never
 * suppressed by pressure.  Routine Notebook refreshes use cadence and may wait
 * while the worker pool is congested; because cadence is not marked until a run
 * succeeds, deferred work remains due and naturally catches up later.
 */
export function planAutomaticMaintenance({
    source = 'lifecycle',
    assistantTurnAdvanced = false,
    changeClass = 'none',
    coldStart = false,
    notebookAutomatic = true,
    notebookCadenceDue = false,
    schedulerAutomatic = true,
    housekeeperEnabled = true,
    maintenanceCadenceDue = false,
    pressure = { level: MAINTENANCE_PRESSURE.NORMAL },
} = {}) {
    const change = String(changeClass || 'none').toLowerCase();
    const major = change === 'major';
    const congested = pressure?.level === MAINTENANCE_PRESSURE.CONGESTED;
    const generationEnd = source === 'generation-end';
    const notebookConfigured = generationEnd && notebookAutomatic === true;
    const notebookDue = notebookConfigured && assistantTurnAdvanced === true && (
        major || coldStart === true || (notebookCadenceDue === true && !congested)
    );
    const maintenanceDue = schedulerAutomatic === true
        && housekeeperEnabled === true
        && maintenanceCadenceDue === true
        && !congested;
    return {
        notebookDue,
        maintenanceDue,
        notebookReason: !notebookConfigured ? 'notebook-not-configured-for-source'
            : !assistantTurnAdvanced ? 'assistant-turn-not-advanced'
                : major ? 'major-scene-change'
                    : coldStart ? 'cold-start'
                        : !notebookCadenceDue ? 'notebook-cadence-not-due'
                            : congested ? 'deferred-worker-pressure'
                                : 'notebook-cadence-due',
        maintenanceReason: !schedulerAutomatic ? 'scheduler-not-automatic'
            : !housekeeperEnabled ? 'housekeeper-disabled'
                : !maintenanceCadenceDue ? 'maintenance-cadence-not-due'
                    : congested ? 'deferred-worker-pressure'
                        : 'maintenance-cadence-due',
        pressure,
    };
}
