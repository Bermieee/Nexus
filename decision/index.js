import { DecisionSites } from './site-registry.js';
import { getSettings, updateSettings } from '../core/settings.js';
import { createDecisionCoreEngine } from './engine.js';
import { CONNECTIVITY_CONTRACT } from './contracts.js';
import { DECISION_MODE, DECISION_PROVIDER, DEFAULT_OPENROUTER_JEV_MODEL, DEFAULT_TYPESAFE_MODEL, OPENROUTER_DECISIONS_ENDPOINT, TYPESAFE_SYSTEMONE_ENDPOINT } from './constants.js';
import { createLlmFallbackAdapter } from './providers/llm-fallback.js';
import { getDecisionTelemetrySnapshot } from './telemetry.js';

function decisionSettings(settings = getSettings()) { return settings.decisionCore || {}; }
function clean(value){ return String(value || '').trim(); }
export function inferDecisionProviderFromEndpoint(endpoint='') {
    return /openrouter\.ai/i.test(clean(endpoint)) ? DECISION_PROVIDER.OPENROUTER_JEV : DECISION_PROVIDER.TYPESAFE_DIRECT;
}
function normalizeDecisionEndpoint(endpoint='') {
    const raw=clean(endpoint);if(!raw)return '';
    if(/openrouter\.ai/i.test(raw)&&/\/api\/v1\/?$/i.test(raw))return OPENROUTER_DECISIONS_ENDPOINT;
    return raw;
}
export function resolveDecisionConnection(settings = getSettings()) {
    const config = decisionSettings(settings), connection = config.connection || {};
    let endpoint = normalizeDecisionEndpoint(connection.endpoint || '');
    let provider = endpoint ? inferDecisionProviderFromEndpoint(endpoint) : null;
    let apiKey = clean(connection.apiKey || '');
    let model = clean(connection.model || '');
    let source = 'connection';

    // Legacy TypeSafe-direct settings are accepted only as a one-way compatibility
    // bridge. Decision Core must never borrow Sidecar A/B credentials: Sidecars and
    // Decision Core are independent provider/accounting authorities.
    if (endpoint && provider === DECISION_PROVIDER.TYPESAFE_DIRECT && !apiKey && clean(config.typeSafe?.apiKey)) {
        apiKey = clean(config.typeSafe.apiKey);
        source = 'legacy-typesafe-credential';
    }
    if (!endpoint && clean(config.typeSafe?.apiKey)) {
        endpoint = TYPESAFE_SYSTEMONE_ENDPOINT;
        provider = DECISION_PROVIDER.TYPESAFE_DIRECT;
        apiKey = clean(config.typeSafe.apiKey);
        model = model || clean(config.typeSafe?.model) || DEFAULT_TYPESAFE_MODEL;
        source = 'legacy-typesafe';
    }
    if (endpoint && !provider) provider = inferDecisionProviderFromEndpoint(endpoint);
    if (!model) model = provider === DECISION_PROVIDER.OPENROUTER_JEV ? DEFAULT_OPENROUTER_JEV_MODEL : DEFAULT_TYPESAFE_MODEL;
    return {
        endpoint,
        apiKey,
        model,
        provider: provider || DECISION_PROVIDER.AUTO,
        configured: Boolean(endpoint && apiKey),
        lastTest: connection.lastTest || null,
        source,
    };
}
export function getDecisionProviderStatus(settings = getSettings()) {
    const config = decisionSettings(settings);
    const connection = resolveDecisionConnection(settings);
    const openRouterConfigured = connection.configured && connection.provider === DECISION_PROVIDER.OPENROUTER_JEV;
    const typeSafeConfigured = connection.configured && connection.provider === DECISION_PROVIDER.TYPESAFE_DIRECT;
    return {
        enabled: config.enabled === true,
        mode: config.mode || DECISION_MODE.OFF,
        provider: connection.endpoint ? connection.provider : (config.provider || DECISION_PROVIDER.AUTO),
        connection: { configured: connection.configured, endpoint: connection.endpoint, model: connection.model, provider: connection.provider, lastTest: connection.lastTest, credentialSource: connection.source },
        openRouter: { configured: openRouterConfigured, profile: null, model: openRouterConfigured ? connection.model : (config.openRouter?.model || DEFAULT_OPENROUTER_JEV_MODEL), lastTest: config.openRouter?.lastTest || null },
        typeSafe: { configured: typeSafeConfigured, model: typeSafeConfigured ? connection.model : (config.typeSafe?.model || DEFAULT_TYPESAFE_MODEL), lastTest: config.typeSafe?.lastTest || null },
        fallback: { enabled: config.fallbackEnabled !== false, route: settings.routing?.maintenance || 'adaptive' },
    };
}
async function loadOptionalJevAdapter(kind, options) {
    try {
        if (kind === DECISION_PROVIDER.OPENROUTER_JEV) {
            const module = await import('./providers/openrouter-jev.js');
            return module.createOpenRouterJevAdapter(options);
        }
        if (kind === DECISION_PROVIDER.TYPESAFE_DIRECT) {
            const module = await import('./providers/typesafe-direct.js');
            return module.createTypeSafeDirectAdapter(options);
        }
    } catch {
        // Jev is Early Access and optional. Missing/drifted adapter modules must
        // never stop Nexus startup; the engine simply sees no Jev provider.
        return null;
    }
    return null;
}
async function buildRuntimeProviders(settings = getSettings(), overrides = {}) {
    const connection = resolveDecisionConnection(settings);
    const providers = {
        [DECISION_PROVIDER.LLM_FALLBACK]: overrides[DECISION_PROVIDER.LLM_FALLBACK] || createLlmFallbackAdapter(),
        ...overrides,
    };
    if (connection.endpoint && !providers[connection.provider]) {
        providers[connection.provider] = await loadOptionalJevAdapter(connection.provider, {
            apiKey: connection.apiKey,
            model: connection.model,
            endpoint: connection.endpoint,
        });
    }
    return providers;
}
export async function createRuntimeDecisionCore({ providerOverrides = {}, settingsProvider = getSettings } = {}) {
    const providers = await buildRuntimeProviders(settingsProvider(), providerOverrides);
    return createDecisionCoreEngine({
        getConfig: () => {
            const s = settingsProvider();
            const c = decisionSettings(s);
            const connection=resolveDecisionConnection(s); return { enabled: c.enabled === true, mode: c.mode || DECISION_MODE.OFF, provider: connection.endpoint ? connection.provider : (c.provider || DECISION_PROVIDER.AUTO), fallbackEnabled: c.fallbackEnabled !== false, timeoutMs: Number(c.timeoutMs) || 10000 };
        },
        providers,
    });
}
export async function evaluateDecision(request, runtime = {}) {
    // Rebuild lightweight adapters at call time so Decision Core connection changes are
    // effective immediately and no credential is retained in Decision Core state.
    const core = await createRuntimeDecisionCore();
    return core.evaluate(request, runtime);
}

function connectivityQuestions() {
    return { reachable: { type: 'noul', instructions: 'Does the state explicitly identify this as a Nexus Decision Core connectivity test?' } };
}
export async function testDecisionProvider(provider, { fetchImpl = null } = {}) {
    const id = String(provider || '');
    if (![DECISION_PROVIDER.OPENROUTER_JEV, DECISION_PROVIDER.TYPESAFE_DIRECT].includes(id)) throw new Error(`Unsupported Decision provider test: ${id}`);
    const settings = getSettings(),config=decisionSettings(settings),connection=resolveDecisionConnection(settings);
    if (!connection.endpoint || connection.provider !== id) throw new Error(`Configure the Decision Core ${id} connection first.`);
    if (!connection.apiKey) throw new Error('Enter a Decision Core API key first.');
    const options={apiKey:connection.apiKey,model:connection.model,endpoint:connection.endpoint,fetchImpl:fetchImpl||globalThis.fetch};
    if (id === DECISION_PROVIDER.OPENROUTER_JEV) {
        const module = await import('./providers/openrouter-jev.js');
        await module.probeOpenRouterCredential({ apiKey: options.apiKey, fetchImpl: options.fetchImpl, timeoutMs: Number(config.timeoutMs) || 10000 });
    }
    const override=await loadOptionalJevAdapter(id,options);
    const engine=createDecisionCoreEngine({getConfig:()=>({enabled:true,mode:DECISION_MODE.SHADOW,provider:id,fallbackEnabled:false,timeoutMs:Number(config.timeoutMs)||10000}),providers:{[id]:override}});
    const result=await engine.evaluate({contractId:CONNECTIVITY_CONTRACT.id,contractVersion:CONNECTIVITY_CONTRACT.version,mode:DECISION_MODE.SHADOW,state:{purpose:'Nexus Decision Core connectivity test',expected:'connectivity test'},questions:connectivityQuestions(),sourceFingerprint:'decision-core-connectivity-v1',providerPolicy:{provider:id,fallbackEnabled:false,allowProviderFallback:false}});
    const now=Date.now();
    updateSettings(s=>{
        s.decisionCore ||= {};s.decisionCore.connection ||= {};
        const checked={checkedAt:now,ok:result.ok===true,successAt:result.ok?now:(s.decisionCore.connection.lastTest?.successAt||null),errorCategory:result.error?.category||null,errorMessage:result.error?.message||null,latencyMs:Number(result.latencyMs)||0,model:result.providerModel||options.model||null,provider:id};
        s.decisionCore.connection.lastTest=checked;
        const branch=id===DECISION_PROVIDER.OPENROUTER_JEV?s.decisionCore.openRouter:s.decisionCore.typeSafe;if(branch)branch.lastTest=checked;
    });
    return result;
}
export async function testDecisionConnection({fetchImpl=null}={}){
    const connection=resolveDecisionConnection(getSettings());
    if(!connection.endpoint)throw new Error('Enter a Decision Core endpoint first.');
    if(!connection.apiKey)throw new Error('Enter a Decision Core API key first.');
    return await testDecisionProvider(connection.provider,{fetchImpl});
}

export const DecisionCore = Object.freeze({
    evaluate: evaluateDecision,
    testProvider: testDecisionProvider,
    testConnection: testDecisionConnection,
    getProviderStatus: getDecisionProviderStatus,
    getTelemetry: getDecisionTelemetrySnapshot,
    sites: DecisionSites,
});

export { DecisionSites };
