import { DECISION_ERROR, DECISION_MODE } from './constants.js';
import { getDecisionContract, registerDecisionContract } from './contracts.js';
import { DecisionProviderError } from './errors.js';

const decisionSites = new Map();

function clean(value) { return String(value ?? '').trim(); }
function asPriority(value) { return Math.max(0, Math.min(100, Number.isFinite(Number(value)) ? Number(value) : 50)); }
function requiredFunction(site, name) {
    if (typeof site?.[name] !== 'function') throw new Error(`Decision Site ${clean(site?.id) || '(unnamed)'} requires ${name}().`);
    return site[name];
}
function resolveContract(spec = {}) {
    if (spec.contract && typeof spec.contract === 'object') return registerDecisionContract(spec.contract);
    const id = clean(spec.contractId || spec.id);
    const version = spec.contractVersion == null ? null : Number(spec.contractVersion);
    const contract = getDecisionContract(id, version);
    if (!contract) throw new Error(`Decision Site ${clean(spec.id) || id || '(unnamed)'} references an unknown Decision contract: ${id || '(missing)'}@${version ?? 'latest'}`);
    return contract;
}

/**
 * Register one subsystem-owned Decision Site adapter.
 *
 * A site owns semantic state/question construction and destination freshness.
 * It MUST NOT own provider transport, credentials, fallback, provider health,
 * or canonical mutation. Those stay in Decision Core / the destination system.
 */
export function registerDecisionSite(spec = {}) {
    const contract = resolveContract(spec);
    const id = clean(spec.id || contract.id);
    const subsystem = clean(spec.subsystem || contract.subsystem);
    if (!id) throw new Error('Decision Site requires a stable id.');
    if (!subsystem) throw new Error(`Decision Site ${id} requires a subsystem owner.`);
    const buildState = requiredFunction(spec, 'buildState');
    const buildQuestions = requiredFunction(spec, 'buildQuestions');
    const freshness = spec.freshness && typeof spec.freshness === 'object' ? spec.freshness : null;
    const getSourceFingerprint = freshness ? (typeof spec.getSourceFingerprint === 'function' ? spec.getSourceFingerprint : null) : requiredFunction(spec, 'getSourceFingerprint');
    const freshnessRequired = spec.freshnessRequired !== false;
    const getCurrentSourceFingerprint = freshness ? (typeof spec.getCurrentSourceFingerprint === 'function' ? spec.getCurrentSourceFingerprint : null) : (freshnessRequired ? requiredFunction(spec, 'getCurrentSourceFingerprint') : (typeof spec.getCurrentSourceFingerprint === 'function' ? spec.getCurrentSourceFingerprint : null));
    if (freshness && (typeof freshness.getInitial !== 'function' || typeof freshness.getCurrent !== 'function')) throw new Error(`Decision Site ${id} freshness contract requires getInitial() and getCurrent().`);
    const mode = clean(spec.mode || DECISION_MODE.SHADOW).toLowerCase();
    if (![DECISION_MODE.OFF, DECISION_MODE.SHADOW, DECISION_MODE.ASSIST].includes(mode)) throw new Error(`Decision Site ${id} uses unsupported checkpoint mode: ${mode}`);
    if (decisionSites.has(id)) throw new Error(`Decision Site already registered: ${id}`);
    const site = Object.freeze({
        id,
        subsystem,
        contractId: contract.id,
        contractVersion: contract.version,
        mode,
        priority: asPriority(spec.priority),
        freshnessRequired,
        freshness,
        buildState,
        buildQuestions,
        getSourceFingerprint,
        getCurrentSourceFingerprint,
        providerPolicy: spec.providerPolicy || null,
        interpret: typeof spec.interpret === 'function' ? spec.interpret : null,
        metadata: Object.freeze({ ...(spec.metadata || {}) }),
    });
    decisionSites.set(id, site);
    return site;
}

export function unregisterDecisionSite(id) { return decisionSites.delete(clean(id)); }
export function getDecisionSite(id) { return decisionSites.get(clean(id)) || null; }
export function listDecisionSites() {
    return [...decisionSites.values()].map(site => ({
        id: site.id,
        subsystem: site.subsystem,
        contractId: site.contractId,
        contractVersion: site.contractVersion,
        mode: site.mode,
        priority: site.priority,
        freshnessRequired: site.freshnessRequired,
        metadata: { ...site.metadata },
    }));
}

async function resolveProviderPolicy(site, context, options) {
    const base = typeof site.providerPolicy === 'function'
        ? await site.providerPolicy(context, options)
        : (site.providerPolicy || {});
    return { ...(base || {}), ...(options.providerPolicy || {}) };
}

export async function buildDecisionSiteRequest(id, context, options = {}) {
    const site = getDecisionSite(id);
    if (!site) throw new DecisionProviderError(DECISION_ERROR.UNKNOWN_CONTRACT, `Unknown Decision Site: ${clean(id) || '(missing)'}`);
    const [state, questions, sourceFreshness, sourceFingerprint, providerPolicy] = await Promise.all([
        site.buildState(context, options),
        site.buildQuestions(context, options),
        site.freshness ? site.freshness.getInitial(context, options) : null,
        site.getSourceFingerprint ? site.getSourceFingerprint(context, options) : null,
        resolveProviderPolicy(site, context, options),
    ]);
    const fingerprint = clean(sourceFreshness?.fingerprint || sourceFingerprint);
    if (!fingerprint) throw new DecisionProviderError(DECISION_ERROR.VALIDATION, `Decision Site ${site.id} returned an empty source fingerprint.`);
    const mode = clean(options.mode || site.mode || DECISION_MODE.SHADOW).toLowerCase();
    if (![DECISION_MODE.OFF, DECISION_MODE.SHADOW, DECISION_MODE.ASSIST].includes(mode)) throw new DecisionProviderError(DECISION_ERROR.VALIDATION, `Decision Site ${site.id} requested unsupported checkpoint mode: ${mode}`);
    return {
        site,
        request: {
            contractId: site.contractId,
            contractVersion: site.contractVersion,
            mode,
            state,
            questions,
            sourceFingerprint: fingerprint,
            sourceFreshness: sourceFreshness || null,
            providerPolicy,
        },
    };
}

async function defaultEvaluator(request, runtime) {
    // Dynamic import keeps the generic site registry independent from the
    // Decision Core composition root and avoids provider-specific coupling.
    const mod = await import('./index.js');
    return mod.evaluateDecision(request, runtime);
}

/** Evaluate a registered site through the provider-neutral Decision Core. */
export async function evaluateDecisionSite(id, context, options = {}) {
    const { site, request } = await buildDecisionSiteRequest(id, context, options);
    const evaluator = typeof options.evaluate === 'function' ? options.evaluate : defaultEvaluator;
    const runtime = {
        ...(options.runtime || {}),
        signal: options.signal || options.runtime?.signal || null,
    };
    if (site.freshness) runtime.getCurrentSourceFreshness = () => site.freshness.getCurrent(context, options);
    else if (site.getCurrentSourceFingerprint) runtime.getCurrentSourceFingerprint = () => site.getCurrentSourceFingerprint(context, options);
    const result = await evaluator(request, runtime);
    return { ...result, decisionSiteId: site.id, subsystem: site.subsystem };
}

/**
 * Explicit policy handoff. Decision Core never invokes this automatically;
 * destination code must opt in after it accepts the normalized result.
 */
export async function interpretDecisionSiteResult(id, result, context, options = {}) {
    const site = getDecisionSite(id);
    if (!site) throw new Error(`Unknown Decision Site: ${clean(id) || '(missing)'}`);
    if (!site.interpret) return null;
    return site.interpret(result, context, options);
}

export const DecisionSites = Object.freeze({
    register: registerDecisionSite,
    unregister: unregisterDecisionSite,
    get: getDecisionSite,
    list: listDecisionSites,
    buildRequest: buildDecisionSiteRequest,
    evaluate: evaluateDecisionSite,
    interpret: interpretDecisionSiteResult,
});
