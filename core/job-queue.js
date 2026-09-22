import { logEvent, recordJobLifecycle } from '../observability/telemetry.js';
import { isIntentionalCancellation } from './cancellation.js';

/**
 * Nexus single background scheduler.
 * Jobs have explicit lifecycle state and optional resource locks. There are no
 * subsystem-owned retry timers. The queue may run jobs concurrently only when
 * their resource keys do not conflict.
 */

export const JOB_STATE = Object.freeze({
    QUEUED: 'queued',
    RUNNING: 'running',
    SUCCEEDED: 'succeeded',
    FAILED: 'failed',
    CANCELLED: 'cancelled',
    BLOCKED: 'blocked',
});

let _seq = 0;
let _generationSeq = 0;
function nextId() { return `tv2_job_${Date.now()}_${++_seq}`; }
function normalizeMaxConcurrent(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : Number.POSITIVE_INFINITY;
}

export class JobQueue {
    constructor({ maxConcurrent = null, terminalHistoryLimit = 250 } = {}) {
        this.maxConcurrent = normalizeMaxConcurrent(maxConcurrent);
        this.terminalHistoryLimit = Math.max(0, Math.floor(Number(terminalHistoryLimit) || 0));
        this.jobs = [];
        this.running = new Map();
        this.resourceLocks = new Map();
        // Priority reservations are admission floors, not locks. A batch parent can
        // reserve A/B for priority-100 work while still allowing equal/higher-priority
        // children to run. Lower-priority foreground work remains queued until the
        // parent releases the reservation.
        this.resourcePriorityReservations = new Map();
        this.pausedForForeground = false;
        this.listeners = new Set();
        this.signalListeners = new Set();
        // Completion, retry, enqueue, and foreground changes all ask for the same
        // coalesced dispatcher wake. This prevents nested drain loops from racing
        // each other while still guaranteeing that a released Sidecar immediately
        // considers its next eligible lane job.
        this.drainPending = false;
        this.draining = false;
        this.drainReasons = new Set();
        this.lastDrainAt = 0;
        this.activeGenerationId = null;
        this.activeForegroundGenerations = new Set();
    }

    onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
    // Presentation/status consumers that only need invalidation must not force a
    // full queue snapshot allocation on every lifecycle event.
    onSignal(fn) { this.signalListeners.add(fn); return () => this.signalListeners.delete(fn); }

    configure(settings = {}) {
        if (!Object.prototype.hasOwnProperty.call(settings || {}, 'maxConcurrent')) return false;
        const next = normalizeMaxConcurrent(settings.maxConcurrent);
        if (Object.is(next, this.maxConcurrent)) return false;
        this.maxConcurrent = next;
        logEvent('queue-dispatcher', 'runtime-reconfigured', { maxConcurrent: Number.isFinite(next) ? next : null }, 'info');
        this.requestDrain('runtime-reconfigured');
        return true;
    }

    reserveResourcePriority(resourceKey, priority, ownerId = 'anonymous') {
        const key = String(resourceKey || '');
        const owner = String(ownerId || 'anonymous');
        const floor = Number(priority);
        if (!key || !Number.isFinite(floor)) return false;
        if (!this.resourcePriorityReservations.has(key)) this.resourcePriorityReservations.set(key, new Map());
        this.resourcePriorityReservations.get(key).set(owner, floor);
        this.requestDrain('priority-reserved');
        return true;
    }

    releaseResourcePriority(resourceKey, ownerId = 'anonymous') {
        const key = String(resourceKey || '');
        const owner = String(ownerId || 'anonymous');
        const reservations = this.resourcePriorityReservations.get(key);
        if (!reservations) return false;
        const removed = reservations.delete(owner);
        if (!reservations.size) this.resourcePriorityReservations.delete(key);
        if (removed) this.requestDrain('priority-released');
        return removed;
    }

    resourcePriorityFloor(resourceKey) {
        const reservations = this.resourcePriorityReservations.get(String(resourceKey || ''));
        if (!reservations?.size) return null;
        return Math.max(...reservations.values());
    }
    _emit(job) {
        try { recordJobLifecycle(job); } catch {}
        for (const fn of this.signalListeners) { try { fn(job); } catch {} }
        for (const fn of this.listeners) { try { fn(job, this.snapshot()); } catch {} }
    }

    snapshot() {
        return this.jobs.map(j => ({
            id: j.id, label: j.label, state: j.state, priority: j.priority,
            resourceKey:j.resourceKey,attempts:j.attempts,lifetimeAttempts:j.lifetimeAttempts||j.attempts||0,maxAttempts:j.maxAttempts,
            attemptsRemaining:Math.max(0,Number(j.maxAttempts||0)-Number(j.attempts||0)),manualRetryCount:j.manualRetryCount||0,
            preemptible:j.preemptible!==false,foregroundAdjacent:j.foregroundAdjacent===true,generationId:j.generationId??null,dedupKey:j.dedupKey??null,controllerAborted:j.controller?.signal?.aborted===true,
            createdAt: j.createdAt, startedAt: j.startedAt, endedAt: j.endedAt,
            error: j.error ? String(j.error?.message || j.error) : '', meta: j.meta || null,
        }));
    }

    healthSnapshot() {
        const jobs = this.snapshot();
        const lanes = {};
        for (const slot of ['A', 'B']) {
            const resourceKey = `sidecar:${slot}`;
            lanes[slot] = {
                activeJobId: this.resourceLocks.get(resourceKey) || null,
                queued: jobs.filter(job => job.resourceKey === resourceKey && job.state === JOB_STATE.QUEUED).map(job => job.id),
                running: jobs.filter(job => job.resourceKey === resourceKey && job.state === JOB_STATE.RUNNING).map(job => job.id),
                priorityFloor: this.resourcePriorityFloor(resourceKey),
            };
        }
        return {
            pausedForForeground: this.pausedForForeground,
            activeGenerationId: this.activeGenerationId,
            activeForegroundGenerationIds: [...this.activeForegroundGenerations],
            draining: this.draining,
            drainPending: this.drainPending,
            lastDrainAt: this.lastDrainAt,
            locks: Object.fromEntries(this.resourceLocks),
            lanes,
            queued: jobs.filter(job => job.state === JOB_STATE.QUEUED),
            running: jobs.filter(job => job.state === JOB_STATE.RUNNING),
        };
    }

    reconcile(reason = 'manual-reconcile') {
        const staleLocks = [];
        for (const [resourceKey, jobId] of this.resourceLocks) {
            const running = this.running.get(jobId);
            if (running?.state === JOB_STATE.RUNNING && running.resourceKey === resourceKey) continue;
            this.resourceLocks.delete(resourceKey);
            staleLocks.push({ resourceKey, jobId });
        }
        if (staleLocks.length) {
            logEvent('queue-guardian', 'stale-lock-released', { reason, staleLocks }, 'warn');
        }
        const eligible = this.jobs.filter(job => job.state === JOB_STATE.QUEUED && this._canRun(job));
        const health = this.healthSnapshot();
        if (eligible.length && !this.draining && !this.drainPending) {
            logEvent('queue-guardian', 'eligible-work-wake', {
                reason,
                eligibleJobIds: eligible.map(job => job.id),
                lanes: health.lanes,
                locks: health.locks,
            }, 'warn');
            this.requestDrain(`guardian:${reason}`);
            return { woke: true, eligible: eligible.length, staleLocks, health };
        }
        return { woke: false, eligible: eligible.length, staleLocks, health };
    }


    _pruneTerminalHistory() {
        const terminal = new Set([JOB_STATE.SUCCEEDED, JOB_STATE.FAILED, JOB_STATE.CANCELLED, JOB_STATE.BLOCKED]);
        const completed = this.jobs.filter(job => terminal.has(job.state)).sort((a,b)=>(a.endedAt||0)-(b.endedAt||0));
        const excess = Math.max(0, completed.length - this.terminalHistoryLimit);
        if (!excess) return 0;
        const remove = new Set(completed.slice(0, excess).map(job => job.id));
        this.jobs = this.jobs.filter(job => !remove.has(job.id));
        return remove.size;
    }

    requestDrain(reason = 'unspecified') {
        this.drainReasons.add(String(reason || 'unspecified'));
        if (this.drainPending) return false;
        this.drainPending = true;
        queueMicrotask(() => this._drainNow());
        return true;
    }

    _activeDedupOwner(dedupKey) {
        if (!dedupKey) return null;
        return this.jobs.find(job => job.dedupKey === dedupKey
            && [JOB_STATE.QUEUED, JOB_STATE.RUNNING].includes(job.state)
            && job.cancelRequested !== true
            && !job.controller?.signal?.aborted) || null;
    }

    activeByDedupKey(dedupKey) { return this._activeDedupOwner(dedupKey); }

    _mergeDedupContract(existing, opts = {}) {
        const requestedPriority = Number.isFinite(opts.priority) ? Number(opts.priority) : 50;
        const requestedMaxAttempts = Math.max(1, Number(opts.maxAttempts) || 1);
        let changed = false;
        if (requestedPriority > existing.priority) { existing.priority = requestedPriority; changed = true; }
        if (requestedMaxAttempts > existing.maxAttempts) { existing.maxAttempts = requestedMaxAttempts; changed = true; }
        if (opts.preemptible === false && existing.preemptible !== false) { existing.preemptible = false; changed = true; }
        if (opts.foregroundAdjacent === true && existing.foregroundAdjacent !== true) { existing.foregroundAdjacent = true; changed = true; }
        const requestedGeneration = opts.generationId ?? ((opts.foregroundAdjacent === true && this.pausedForForeground) ? this.activeGenerationId : null);
        if (requestedGeneration != null) {
            if (!(existing.generationIds instanceof Set)) existing.generationIds = new Set(existing.generationId == null ? [] : [existing.generationId]);
            existing.generationIds.add(String(requestedGeneration));
            existing.generationId = String(requestedGeneration);
            changed = true;
        }
        if (changed) {
            this.jobs.sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt);
            this._emit(existing);
            this.requestDrain('dedup-contract-promoted');
        }
        return existing;
    }

    enqueue(run, opts = {}) {
        if (typeof run !== 'function') throw new TypeError('Nexus job requires a run function.');
        const requestedId = opts.id == null ? null : String(opts.id).trim();
        if (opts.id != null && !requestedId) throw new Error('Nexus job ID cannot be empty.');
        const dedupKey = opts.dedupKey || null;
        if (dedupKey) {
            const existing = this._activeDedupOwner(dedupKey);
            if (existing) return this._mergeDedupContract(existing, opts);
        }
        const id = requestedId || nextId();
        if (this.jobs.some(existing => existing.id === id)) throw new Error(`Duplicate Nexus JobQueue ID: ${id}`);
        const generationId = opts.generationId ?? ((opts.foregroundAdjacent === true && this.pausedForForeground) ? this.activeGenerationId : null);
        const job = {
            id,
            label: opts.label || 'background job',
            run,
            state: JOB_STATE.QUEUED,
            priority: Number.isFinite(opts.priority) ? opts.priority : 50,
            resourceKey: opts.resourceKey || null,
            preemptible: opts.preemptible !== false,
            maxAttempts: Math.max(1, Number(opts.maxAttempts) || 1),
            attempts: 0,
            lifetimeAttempts: 0,
            manualRetryCount: 0,
            createdAt: Date.now(),
            startedAt: 0,
            endedAt: 0,
            result: undefined,
            error: null,
            cancelReason: null,
            cancelRequested: false,
            controller: null,
            dedupKey,
            foregroundAdjacent: opts.foregroundAdjacent === true,
            generationId,
            generationIds: new Set(generationId == null ? [] : [String(generationId)]),
            meta: opts.meta || null,
            _resolve: null,
            _reject: null,
            promise: null,
            cancel: null,
        };
        job.cancel = (reason = 'Cancelled') => this.cancel(job.id, reason);
        job.promise = new Promise((resolve, reject) => { job._resolve = resolve; job._reject = reject; });
        this.jobs.push(job);
        this.jobs.sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt);
        this._emit(job);
        this.requestDrain('job-enqueued');
        return job;
    }

    foregroundStarted(generationToken = null) {
        const generationId = String(generationToken || `tv2_generation_${Date.now()}_${++_generationSeq}`);
        // Exact duplicate admission is idempotent, but a distinct overlapping
        // host generation receives its own owner. Older owners remain only as
        // physical-pause records; authority never falls back to them.
        if (this.activeForegroundGenerations.has(generationId)) return generationId;
        const wasPaused = this.pausedForForeground;
        this.activeForegroundGenerations.add(generationId);
        this.pausedForForeground = true;
        this.activeGenerationId = generationId;
        if (!wasPaused) {
            for (const job of this.running.values()) {
                if (!job.foregroundAdjacent && job.preemptible && job.controller && !job.controller.signal.aborted) {
                    job.controller.abort(Object.assign(new Error('Foreground generation started.'), { name: 'TV2ForegroundAbort' }));
                }
            }
        }
        return generationId;
    }

    foregroundEnded(generationToken = null) {
        const generationId = generationToken == null ? this.activeGenerationId : String(generationToken);
        if (generationId != null) this.activeForegroundGenerations.delete(String(generationId));
        if (generationId != null && String(this.activeGenerationId || '') === String(generationId)) this.activeGenerationId = null;
        this.pausedForForeground = this.activeForegroundGenerations.size > 0;
        if (!this.pausedForForeground) this.requestDrain('foreground-ended');
        return !this.pausedForForeground;
    }

    cancel(id, reason = 'Cancelled') {
        const job = this.jobs.find(j => j.id === id);
        if (!job || ![JOB_STATE.QUEUED, JOB_STATE.RUNNING].includes(job.state)) return false;
        const error = reason instanceof Error ? reason : new Error(String(reason || 'Cancelled'));
        job.cancelRequested = true;
        job.cancelReason = error;
        if (job.state === JOB_STATE.RUNNING) job.controller?.abort(error);
        if (job.state === JOB_STATE.QUEUED) {
            job.state = JOB_STATE.CANCELLED;
            job.endedAt = Date.now();
            job.error = error;
            job._reject?.(job.error);
            this._emit(job);
            this._pruneTerminalHistory();
            this.requestDrain('queued-job-cancelled');
        }
        return true;
    }

    cancelWhere(predicate, reason = 'Cancelled') {
        if (typeof predicate !== 'function') return 0;
        const ids = this.jobs.filter(job => [JOB_STATE.QUEUED, JOB_STATE.RUNNING].includes(job.state) && predicate(job)).map(job => job.id);
        for (const id of ids) this.cancel(id, reason);
        return ids.length;
    }

    cancelGenerationWork(reason = 'Generation-scoped work cancelled.', generationToken = null) {
        const generationId = generationToken == null ? this.activeGenerationId : String(generationToken);
        const error = reason instanceof Error ? reason : new Error(String(reason || 'Generation-scoped work cancelled.'));
        if (!error.name || error.name === 'Error') error.name = 'TV2GenerationWorkCancelled';
        const cancelled = generationId ? this.cancelWhere(job => job.generationId === generationId || job.generationIds?.has?.(String(generationId)), error) : 0;
        logEvent('queue-dispatcher', 'generation-work-cancelled', { generationId, cancelled }, cancelled ? 'warn' : 'debug');
        return cancelled;
    }

    generationStopped(reason = 'Generation stopped.', generationToken = null) {
        const generationId = generationToken == null ? this.activeGenerationId : String(generationToken);
        const error = Object.assign(new Error(String(reason || 'Generation stopped.')), { name: 'TV2GenerationStopped' });
        const cancelled = this.cancelGenerationWork(error, generationId);
        if (generationId != null) this.foregroundEnded(generationId);
        logEvent('queue-dispatcher', 'generation-scope-cancelled', { generationId, cancelled }, cancelled ? 'warn' : 'debug');
        return cancelled;
    }

    clearForegroundGenerations(reason = 'Foreground generation scope cleared.') {
        const ids = [...this.activeForegroundGenerations];
        let cancelled = 0;
        for (const id of ids) cancelled += this.generationStopped(reason, id);
        this.activeForegroundGenerations.clear();
        this.activeGenerationId = null;
        this.pausedForForeground = false;
        this.requestDrain('foreground-generations-cleared');
        return cancelled;
    }

    retry(id) {
        const job = this.jobs.find(j => j.id === id);
        if (!job || this.running.has(id) || ![JOB_STATE.FAILED, JOB_STATE.CANCELLED, JOB_STATE.BLOCKED].includes(job.state)) return false;
        const newerOwner = job.dedupKey ? this._activeDedupOwner(job.dedupKey) : null;
        if (newerOwner && newerOwner.id !== job.id) return false;
        job.state = JOB_STATE.QUEUED;
        job.error = null;
        job.cancelReason = null;
        job.cancelRequested = false;
        // Manual retry begins a fresh bounded attempt window while preserving
        // the original job identity/lineage. Do not retain stale result state.
        job.attempts = 0;
        job.manualRetryCount = (job.manualRetryCount || 0) + 1;
        if (this.activeGenerationId && job.foregroundAdjacent) {
            job.generationId = this.activeGenerationId;
            job.generationIds = new Set([String(this.activeGenerationId)]);
        }
        job.result = null;
        job.promise = new Promise((resolve, reject) => { job._resolve = resolve; job._reject = reject; });
        job.startedAt = 0;
        job.endedAt = 0;
        this._emit(job);
        this.requestDrain('job-retried');
        return true;
    }

    _canRun(job) {
        if (this.pausedForForeground && !job.foregroundAdjacent) return false;
        if (Number.isFinite(this.maxConcurrent) && this.running.size >= this.maxConcurrent) return false;
        if (job.resourceKey && this.resourceLocks.has(job.resourceKey)) return false;
        const floor = job.resourceKey ? this.resourcePriorityFloor(job.resourceKey) : null;
        if (Number.isFinite(floor) && job.priority < floor) return false;
        return true;
    }

    _drainNow() {
        this.drainPending = false;
        if (this.draining) {
            // A completion landed while the selector was already running. Leave a
            // pending wake behind so the next microtask observes the released lane.
            this.requestDrain('drain-reentered');
            return;
        }
        this.draining = true;
        const reasons = [...this.drainReasons];
        this.drainReasons.clear();
        let started = 0;
        try {
        for (const job of this.jobs) {
            if (job.state !== JOB_STATE.QUEUED || !this._canRun(job)) continue;
            this._start(job);
            started += 1;
            if (Number.isFinite(this.maxConcurrent) && this.running.size >= this.maxConcurrent) break;
        }
        } finally {
            this.lastDrainAt = Date.now();
            this.draining = false;
            logEvent('queue-dispatcher', 'drain-complete', {
                reasons,
                started,
                running: this.running.size,
                queued: this.jobs.filter(job => job.state === JOB_STATE.QUEUED).length,
                lanes: this.healthSnapshot().lanes,
            }, 'debug');
            // Do not strand a wake requested by a job completion that arrived while
            // this pass was choosing work.
            if (this.drainReasons.size && !this.drainPending) this.requestDrain('post-drain-wake');
        }
    }

    async _start(job) {
        job.state = JOB_STATE.RUNNING;
        job.startedAt = Date.now();
        job.attempts += 1;
        job.lifetimeAttempts = (job.lifetimeAttempts || 0) + 1;
        job.cancelRequested = false;
        job.cancelReason = null;
        job.controller = new AbortController();
        this.running.set(job.id, job);
        if (job.resourceKey) this.resourceLocks.set(job.resourceKey, job.id);
        this._emit(job);
        try {
            job.result = await job.run({ signal: job.controller.signal, job });
            if (job.controller.signal.aborted) throw job.controller.signal.reason || new Error('Aborted');
            job.state = JOB_STATE.SUCCEEDED;
            job.error = null;
            job._resolve?.(job.result);
        } catch (err) {
            job.error = err;
            if (job.controller.signal.aborted || isIntentionalCancellation(err, job.controller.signal)) {
                const cancellation = job.controller.signal.reason || job.cancelReason || err || new Error('Cancelled');
                job.error = cancellation;
                job.cancelReason = cancellation;
                job.cancelRequested = true;
                job.state = JOB_STATE.CANCELLED;
                job._reject?.(cancellation);
            } else if (job.attempts < job.maxAttempts) {
                // Explicit bounded retry: same queue, no timers, no hidden resurrection.
                job.state = JOB_STATE.QUEUED;
            } else {
                job.state = JOB_STATE.FAILED;
                job._reject?.(err);
            }
        } finally {
            if (job.state !== JOB_STATE.QUEUED) job.endedAt = Date.now();
            this.running.delete(job.id);
            if (job.resourceKey && this.resourceLocks.get(job.resourceKey) === job.id) this.resourceLocks.delete(job.resourceKey);
            job.controller = null;
            this._emit(job);
            this._pruneTerminalHistory();
            // This is the A1/B1 complete-state handoff: terminal transition,
            // resource release, then one coalesced selector wake for the next
            // eligible A/B lane job.
            this.requestDrain(`job-terminal:${job.state}`);
        }
    }
}

let singleton = null;
export function getJobQueue(settings = {}) {
    if (!singleton) singleton = new JobQueue(settings);
    else singleton.configure(settings);
    return singleton;
}
