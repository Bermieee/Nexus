import { NEXUS_EXECUTION_PROFILE } from '../nexus/execution-profile.js';
import { markBatchLayerSidecarExecutor } from '../nexus/sidecar-job-adapter.js';

/**
 * Chooses an available semantic resource without merging Main into Sidecar
 * scheduling. Sidecar execution and Main boundary execution remain distinct.
 */
export class LorebookBuilderSemanticRouter {
    constructor({ runtimeProvider, sidecarExecutor, mainExecutor } = {}) {
        if (typeof runtimeProvider !== 'function') throw new Error('Lorebook Builder semantic router requires runtimeProvider().');
        if (!sidecarExecutor?.execute) throw new Error('Lorebook Builder semantic router requires Sidecar executor.');
        if (!mainExecutor?.execute) throw new Error('Lorebook Builder semantic router requires Main executor.');
        this.runtimeProvider = runtimeProvider;
        this.sidecarExecutor = sidecarExecutor;
        this.mainExecutor = mainExecutor;
    }

    resolveResource(request = {}) {
        const runtime = this.runtimeProvider();
        const profile = runtime?.executionProfile || {};
        const preference = String(request?.metadata?.semanticResource || 'auto').trim().toLowerCase();
        const sidecarAvailable = profile.internalSidecarWorkAvailable === true;
        const mainAvailable = profile.mainBoundaryAvailable === true;
        const foregroundDependency = request?.metadata?.foregroundDependency === true;
        if (foregroundDependency) {
            if (sidecarAvailable) return 'sidecar';
            const error = new Error('Lorebook Builder is executing inside an active Main Function Gateway call; recursive Main semantic execution is forbidden and no Sidecar is available.');
            error.name = 'TV2BuilderForegroundDependencyUnavailable';
            error.nexusLegacyFallback = false;
            throw error;
        }
        if (preference === 'main') {
            if (!mainAvailable) throw new Error('Lorebook Builder requested Main semantic analysis, but Main/ST is disconnected.');
            return 'main';
        }
        if (preference === 'sidecar') {
            if (!sidecarAvailable) throw new Error('Lorebook Builder requested Sidecar semantic analysis, but no Sidecar is enabled.');
            return 'sidecar';
        }
        if (sidecarAvailable) return 'sidecar';
        if (mainAvailable) return 'main';
        if (profile.kind === NEXUS_EXECUTION_PROFILE.LOCAL_ONLY || (!sidecarAvailable && !mainAvailable)) {
            throw new Error('Lorebook Builder has no available LLM resource in the Model Worker pool. Enable Main worker participation or connect an operator-approved Sidecar worker.');
        }
        throw new Error(`Lorebook Builder cannot resolve semantic execution for profile ${profile.kind || 'unknown'}.`);
    }

    async execute(context = {}) {
        const resource = context?.buildPlan?.metadata?.semanticResource || this.resolveResource(context?.request || {});
        const runtime = this.runtimeProvider();
        const coordinator = runtime?.coordinator;
        const directorPlan = context?.buildPlan?.directorPlan;
        if (!coordinator?.run || !directorPlan?.jobs) {
            const error = new Error('Lorebook Builder requires the Work Coordinator to execute its Director plan; direct semantic execution is forbidden.');
            error.name = 'TV2BuilderCoordinatorUnavailable';
            error.nexusLegacyFallback = false;
            throw error;
        }

        const sourceJobs = Array.isArray(context?.buildPlan?.jobs) ? context.buildPlan.jobs : [];
        const sourceByType = new Map(sourceJobs.map(job => [String(job?.type || ''), job]));
        const executeOne = async job => {
            const sourceJob = sourceByType.get(String(job?.type || ''));
            if (!sourceJob || !Array.isArray(sourceJob?.metadata?.refs)) {
                return { validated: true, builderJobType: job?.type || null };
            }
            const scopedPlan = { ...context.buildPlan, jobs: [sourceJob] };
            const scopedContext = { ...context, buildPlan: scopedPlan };
            return resource === 'main'
                ? this.mainExecutor.execute(scopedContext)
                : this.sidecarExecutor.execute(scopedContext);
        };
        const sidecarOne = markBatchLayerSidecarExecutor(executeOne);
        const executors = {};
        for (const job of directorPlan.jobs) {
            const isSemantic = Array.isArray(job?.metadata?.refs);
            executors[job.type] = resource === 'sidecar' && isSemantic ? sidecarOne : executeOne;
        }

        const execution = await coordinator.run(directorPlan, {
            executors,
            signal: context?.signal || null,
        });
        if (execution.failed || execution.blocked || execution.cancelled) {
            const failed = execution.jobs.find(row => ['failed','blocked','cancelled'].includes(String(row?.state || '')));
            const error = new Error(`Lorebook Builder Director execution did not complete: ${failed?.error || 'one or more jobs failed, blocked, or cancelled'}`);
            error.name = execution.cancelled ? 'TV2ScopeInvalidated' : 'TV2BuilderDirectorExecutionFailed';
            if (execution.cancelled) error.nexusLegacyFallback = false;
            throw error;
        }
        const placements = execution.jobs
            .filter(row => Array.isArray(row?.metadata?.refs) && row?.state === 'succeeded')
            .flatMap(row => Array.isArray(row?.result?.value?.placements) ? row.result.value.placements : []);
        return { placements };
    }
}
