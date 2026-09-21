import {
    NEXUS_JOB_ROUTE,
    NEXUS_JOB_STATE,
    NEXUS_RESULT_STATE,
    createNexusResult,
    deepCopy,
} from './contracts.js';
import { isBatchLayerSidecarExecutor, isModelWorkerExecutor } from './sidecar-job-adapter.js';
import { isIntentionalCancellation } from '../core/cancellation.js';

/**
 * Executes an already-approved Job Plan without owning physical worker lanes.
 * Physical worker selection stays outside this coordinator. MODEL_WORKER jobs
 * require a marked model-worker adapter; that adapter may lease Main or dispatch
 * through the Sidecar Batch Layer without changing subsystem ownership.
 */
export class NexusWorkCoordinator {
    constructor(){this.activeRuns=new Map();this.lastRun=null;}
    diagnosticSnapshot(){return {active:[...this.activeRuns.values()].map(deepCopy),last:this.lastRun?deepCopy(this.lastRun):null};}
    async run(plan, { executors = {}, onChange = null, signal = null, isFresh = null } = {}) {
        const sourceJobs = Array.isArray(plan?.jobs) ? plan.jobs : [];
        const seenIds = new Set();
        for (const job of sourceJobs) {
            const id = String(job?.id || '');
            if (!id) throw new Error('Nexus Work Coordinator received a job without an ID.');
            if (seenIds.has(id)) throw new Error(`Nexus Work Coordinator received duplicate job ID ${id}.`);
            seenIds.add(id);
        }
        const jobs = new Map(sourceJobs.map(job => [job.id, {
            ...deepCopy(job),
            state: NEXUS_JOB_STATE.QUEUED,
            result: null,
            error: null,
            startedAt: null,
            completedAt: null,
        }]));
        const active = new Set();
        const runKey=String(plan?.id||`work-${Date.now()}-${Math.random().toString(36).slice(2,7)}`);
        this.activeRuns.set(runKey,{planId:plan?.id||null,source:plan?.source||null,startedAt:Date.now(),...this.snapshot(jobs,plan)});
        const emit = job => { const snap=this.snapshot(jobs,plan);this.activeRuns.set(runKey,{...(this.activeRuns.get(runKey)||{}),...snap,updatedAt:Date.now()});try { onChange?.(deepCopy(job), snap); } catch {} };
        const cancellationReason = () => {
            if (signal?.aborted) {
                const reason = signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason || 'Nexus work plan cancelled.'));
                if (!reason.name || reason.name === 'Error') reason.name = 'TV2ScopeInvalidated';
                return reason;
            }
            if (typeof isFresh === 'function') {
                let fresh = false;
                try { fresh = isFresh() !== false; } catch {}
                if (!fresh) {
                    const error = new Error('Nexus work plan scope became stale before further execution.');
                    error.name = 'TV2ScopeInvalidated';
                    return error;
                }
            }
            return null;
        };
        const cancelQueued = reason => {
            for (const job of jobs.values()) {
                if (job.state !== NEXUS_JOB_STATE.QUEUED) continue;
                job.state = NEXUS_JOB_STATE.CANCELLED;
                job.completedAt = Date.now();
                job.error = String(reason?.message || reason || 'Nexus work plan cancelled.');
                job.result = createNexusResult({ jobId: job.id, planId: plan?.id, state: NEXUS_RESULT_STATE.CANCELLED, error: reason, completedAt: job.completedAt });
                emit(job);
            }
        };
        const terminalFailure = new Set([NEXUS_JOB_STATE.FAILED, NEXUS_JOB_STATE.BLOCKED, NEXUS_JOB_STATE.CANCELLED, NEXUS_JOB_STATE.SKIPPED]);
        const missingDependencies = job => (job.dependencies || []).filter(id => !jobs.has(id));
        const runnable = job => job.state === NEXUS_JOB_STATE.QUEUED
            && missingDependencies(job).length === 0
            && job.dependencies.every(id => jobs.get(id)?.state === NEXUS_JOB_STATE.SUCCEEDED);
        const blocked = job => job.state === NEXUS_JOB_STATE.QUEUED
            && (missingDependencies(job).length > 0 || job.dependencies.some(id => terminalFailure.has(jobs.get(id)?.state)));

        const start = job => {
            const execute = executors[job.type] || executors[job.kind] || null;
            job.state = NEXUS_JOB_STATE.RUNNING;
            job.startedAt = Date.now();
            emit(job);
            const promise = Promise.resolve().then(async () => {
                if (job.route === NEXUS_JOB_ROUTE.TREE_BATCH_FIRE && typeof execute !== 'function') {
                    throw new Error(`Tree Batch Fire job ${job.type} requires its specialized executor.`);
                }
                if (job.route === NEXUS_JOB_ROUTE.SIDECAR && typeof execute === 'function' && !isBatchLayerSidecarExecutor(execute)) {
                    throw new Error(`Sidecar job ${job.type} must execute through a Nexus Batch Layer adapter.`);
                }
                if (job.route === NEXUS_JOB_ROUTE.MODEL_WORKER && typeof execute === 'function' && !isModelWorkerExecutor(execute)) {
                    throw new Error(`Model-worker job ${job.type} must execute through a Nexus model-worker adapter.`);
                }
                if (typeof execute !== 'function') return { skipped: true, reason: `No executor registered for ${job.type}.` };
                const beforeExecute = cancellationReason();
                if (beforeExecute) throw beforeExecute;
                return execute(deepCopy(job), deepCopy(plan), { signal, isFresh });
            }).then(value => {
                job.completedAt = Date.now();
                const staleAfterExecute = cancellationReason();
                if (staleAfterExecute) {
                    job.state = NEXUS_JOB_STATE.CANCELLED;
                    job.error = String(staleAfterExecute.message || staleAfterExecute);
                    job.result = createNexusResult({ jobId: job.id, planId: plan?.id, state: NEXUS_RESULT_STATE.CANCELLED, error: staleAfterExecute, startedAt: job.startedAt, completedAt: job.completedAt });
                } else if (value?.skipped) {
                    job.state = NEXUS_JOB_STATE.SKIPPED;
                    job.result = createNexusResult({ jobId: job.id, planId: plan?.id, state: NEXUS_RESULT_STATE.SKIPPED, value, startedAt: job.startedAt, completedAt: job.completedAt });
                } else {
                    job.state = NEXUS_JOB_STATE.SUCCEEDED;
                    job.result = createNexusResult({ jobId: job.id, planId: plan?.id, state: NEXUS_RESULT_STATE.SUCCEEDED, value, startedAt: job.startedAt, completedAt: job.completedAt });
                }
            }).catch(error => {
                job.completedAt = Date.now();
                const cancelled = isIntentionalCancellation(error, signal) || Boolean(cancellationReason());
                job.state = cancelled ? NEXUS_JOB_STATE.CANCELLED : NEXUS_JOB_STATE.FAILED;
                job.error = String(error?.message || error);
                job.result = createNexusResult({ jobId: job.id, planId: plan?.id, state: cancelled ? NEXUS_RESULT_STATE.CANCELLED : NEXUS_RESULT_STATE.FAILED, error, startedAt: job.startedAt, completedAt: job.completedAt, metadata: { legacyFallbackAllowed: error?.nexusLegacyFallback !== false } });
            }).finally(() => { active.delete(promise); emit(job); });
            active.add(promise);
        };

        while ([...jobs.values()].some(job => [NEXUS_JOB_STATE.QUEUED, NEXUS_JOB_STATE.RUNNING].includes(job.state))) {
            const cancelled = cancellationReason();
            if (cancelled) {
                cancelQueued(cancelled);
                if (active.size) await Promise.allSettled([...active]);
                break;
            }
            let progressed = false;
            for (const job of jobs.values()) {
                if (!blocked(job)) continue;
                const missing = missingDependencies(job);
                job.state = NEXUS_JOB_STATE.BLOCKED;
                job.completedAt = Date.now();
                job.error = missing.length
                    ? `Dependency is missing from this plan: ${missing.join(', ')}.`
                    : 'Dependency did not complete successfully.';
                job.result = createNexusResult({ jobId: job.id, planId: plan?.id, state: NEXUS_RESULT_STATE.BLOCKED, error: job.error, completedAt: job.completedAt });
                emit(job);
                progressed = true;
            }
            const ready = [...jobs.values()].filter(runnable).sort((a, b) => b.priority - a.priority || String(a.id).localeCompare(String(b.id)));
            for (const job of ready) { start(job); progressed = true; }
            if (active.size) await Promise.race(active);
            else if (!progressed) {
                // No work is executing and no queued job can become runnable.
                // Terminate the unresolved component explicitly instead of
                // returning a plan that still claims work is queued forever.
                for (const job of jobs.values()) {
                    if (job.state !== NEXUS_JOB_STATE.QUEUED) continue;
                    const unresolved = (job.dependencies || []).filter(id => jobs.get(id)?.state !== NEXUS_JOB_STATE.SUCCEEDED);
                    job.state = NEXUS_JOB_STATE.BLOCKED;
                    job.completedAt = Date.now();
                    job.error = `Dependency deadlock or cycle; unresolved dependencies: ${unresolved.join(', ') || 'unknown'}.`;
                    job.result = createNexusResult({ jobId: job.id, planId: plan?.id, state: NEXUS_RESULT_STATE.BLOCKED, error: job.error, completedAt: job.completedAt });
                    emit(job);
                }
                break;
            }
        }
        if (active.size) await Promise.allSettled([...active]);
        const finalSnapshot=this.snapshot(jobs, plan);
        this.lastRun={...(this.activeRuns.get(runKey)||{}),...finalSnapshot,endedAt:Date.now()};
        this.activeRuns.delete(runKey);
        return finalSnapshot;
    }

    snapshot(jobs, plan = null) {
        const rows = [...jobs.values()].map(deepCopy);
        return {
            planId: plan?.id || null,
            jobs: rows,
            succeeded: rows.filter(row => row.state === NEXUS_JOB_STATE.SUCCEEDED).length,
            failed: rows.filter(row => row.state === NEXUS_JOB_STATE.FAILED).length,
            blocked: rows.filter(row => row.state === NEXUS_JOB_STATE.BLOCKED).length,
            skipped: rows.filter(row => row.state === NEXUS_JOB_STATE.SKIPPED).length,
            cancelled: rows.filter(row => row.state === NEXUS_JOB_STATE.CANCELLED).length,
        };
    }
}
