import { DECISION_ERROR } from './constants.js';
import { evaluateDecisionSite, getDecisionSite } from './site-registry.js';
import { NEXUS_JOB_KIND, NEXUS_JOB_ROUTE } from '../nexus/contracts.js';

export const DECISION_SITE_JOB_TYPE = 'semantic-decision';

function clean(value) { return String(value ?? '').trim(); }
let runtimeModulePromise = null;
async function resolveRuntime(explicit = null) {
    if (explicit) return explicit;
    runtimeModulePromise ||= import('../nexus/runtime.js');
    const mod = await runtimeModulePromise;
    return mod.getNexusRuntime();
}
function cancellationError(reason) {
    const error = reason instanceof Error ? reason : new Error(String(reason || 'Decision Site work cancelled.'));
    if (!error.name || error.name === 'Error') error.name = 'TV2DecisionSiteCancelled';
    return error;
}
function decisionFailure(result) {
    const error = new Error(result?.error?.message || `Decision Site failed: ${result?.error?.category || 'unknown'}`);
    error.name = 'TV2DecisionSiteFailed';
    error.category = result?.error?.category || null;
    error.decisionResult = result || null;
    return error;
}

/**
 * Ask the existing deterministic Work Director to normalize one Decision Site
 * execution opportunity. The plan contains no semantic state/questions and no
 * provider choice; Decision Core remains the sole provider-routing authority.
 */
export async function planDecisionSiteWork(siteId, {
    source = 'decision-site',
    priority = null,
    metadata = {},
    director = null,
    runtimeInstance = null,
} = {}) {
    const site = getDecisionSite(siteId);
    if (!site) throw new Error(`Unknown Decision Site: ${clean(siteId) || '(missing)'}`);
    const runtime = director ? null : await resolveRuntime(runtimeInstance);
    const planner = director || runtime?.director;
    if (!planner?.buildRequestedPlan) throw new Error('Nexus Work Director is unavailable for Decision Site planning.');
    const decisionMetadata = {
        ...metadata,
        decisionSiteId: site.id,
        decisionContractId: site.contractId,
        decisionContractVersion: site.contractVersion,
        subsystem: site.subsystem,
        executionOwner: 'decision-core',
        providerNeutral: true,
    };
    return planner.buildRequestedPlan({
        source: `${source}:${site.subsystem}`,
        decisions: [{ action: 'run', job: DECISION_SITE_JOB_TYPE, route: NEXUS_JOB_ROUTE.LOCAL, reason: 'registered Decision Site requested a bounded semantic judgment', decisionSiteId: site.id }],
        jobs: [{
            type: DECISION_SITE_JOB_TYPE,
            name: `Decision · ${site.id}`,
            kind: NEXUS_JOB_KIND.INSPECT,
            route: NEXUS_JOB_ROUTE.LOCAL,
            priority: priority == null ? site.priority : Math.max(0, Math.min(100, Number(priority) || 0)),
            transactionRequired: false,
            metadata: decisionMetadata,
        }],
        metadata: { decisionSite: decisionMetadata },
    });
}

function executorFor(siteId, context, options) {
    return async () => {
        const result = await evaluateDecisionSite(siteId, context, options);
        if (result.ok === true) return { decision: result };
        if (result.stale === true || result.error?.category === DECISION_ERROR.STALE_RESULT) return { skipped: true, reason: 'stale-result', decision: result };
        if ([DECISION_ERROR.PROVIDER_DISABLED, DECISION_ERROR.NOT_CONFIGURED].includes(result.error?.category)) return { skipped: true, reason: result.error.category, decision: result };
        throw decisionFailure(result);
    };
}

/**
 * Plan through Work Director, execute through Work Coordinator, and delegate
 * the actual semantic judgment to Decision Core. Work Director/Coordinator do
 * not know which Decision provider is used.
 */
export async function runDecisionSiteThroughDirector(siteId, context, options = {}) {
    const runtime = await resolveRuntime(options.runtimeInstance || null);
    const plan = options.plan || await planDecisionSiteWork(siteId, { ...options, runtimeInstance: runtime, director: options.director || runtime.director });
    const snapshot = await runtime.coordinator.run(plan, {
        executors: { [DECISION_SITE_JOB_TYPE]: executorFor(siteId, context, { ...options, signal: options.signal || null }) },
        signal: options.signal || null,
        isFresh: options.isFresh || null,
        onChange: options.onChange || null,
    });
    const job = snapshot.jobs?.find(row => row.type === DECISION_SITE_JOB_TYPE) || snapshot.jobs?.[0] || null;
    return { plan, snapshot, job, decision: job?.result?.value?.decision || job?.result?.value?.decisionResult || job?.result?.value?.decision || null };
}

/** Fire-and-observe helper for shadow consumers such as Housekeeper. */
export function startDecisionSiteThroughDirector(siteId, context, options = {}) {
    const controller = new AbortController();
    const externalSignal = options.signal || null;
    if (externalSignal?.aborted) controller.abort(externalSignal.reason);
    const abort = () => { try { controller.abort(externalSignal.reason || cancellationError()); } catch {} };
    externalSignal?.addEventListener?.('abort', abort, { once: true });
    const handle = {
        id: null,
        plan: null,
        state: 'queued',
        error: null,
        promise: null,
        cancel(reason = 'Decision Site work cancelled.') {
            if (['completed', 'failed', 'cancelled'].includes(handle.state)) return false;
            const error = cancellationError(reason);
            handle.state = 'cancelled';
            handle.error = error;
            try { controller.abort(error); } catch {}
            return true;
        },
    };
    handle.promise = (async () => {
        handle.state = 'executing';
        const runtime = await resolveRuntime(options.runtimeInstance || null);
        const plan = await planDecisionSiteWork(siteId, { ...options, runtimeInstance: runtime, director: options.director || runtime.director });
        handle.plan = plan;
        handle.id = plan.id;
        return runDecisionSiteThroughDirector(siteId, context, { ...options, runtimeInstance: runtime, plan, signal: controller.signal });
    })().then(value => {
        if (handle.state !== 'cancelled') {
            if (Number(value?.snapshot?.cancelled) > 0) handle.state = 'cancelled';
            else if (Number(value?.snapshot?.failed) > 0) {
                handle.state = 'failed';
                handle.error = new Error(value?.job?.error || 'Decision Site execution failed.');
            } else handle.state = 'completed';
        }
        return value;
    }, error => {
        if (handle.state !== 'cancelled') handle.state = 'failed';
        handle.error = error;
        throw error;
    }).finally(() => externalSignal?.removeEventListener?.('abort', abort));
    return handle;
}

export const DecisionWorkDirector = Object.freeze({
    plan: planDecisionSiteWork,
    run: runDecisionSiteThroughDirector,
    start: startDecisionSiteThroughDirector,
});
