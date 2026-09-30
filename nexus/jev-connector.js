import {
    DECISION_PROVIDER,
    DEFAULT_OPENROUTER_JEV_MODEL,
    DEFAULT_TYPESAFE_MODEL,
    OPENROUTER_DECISIONS_ENDPOINT,
    TYPESAFE_SYSTEMONE_ENDPOINT,
} from '../decision/constants.js';

const clean=value=>String(value??'').trim();

/**
 * Jev is the external semantic-judgment connection boundary for Nexus.
 *
 * The legacy Decision engine still owns decision-site contracts, freshness,
 * fallback semantics, and result validation. It must obtain its physical Jev
 * connection through this boundary rather than owning a second connection.
 */
export function inferJevProviderFromEndpoint(endpoint=''){
    return /openrouter\.ai/i.test(clean(endpoint))?DECISION_PROVIDER.OPENROUTER_JEV:DECISION_PROVIDER.TYPESAFE_DIRECT;
}

export function normalizeJevEndpoint(endpoint=''){
    const raw=clean(endpoint);
    if(!raw)return'';
    if(/openrouter\.ai/i.test(raw)&&/\/api\/v1\/?$/i.test(raw))return OPENROUTER_DECISIONS_ENDPOINT;
    return raw;
}

export function resolveNexusJevConnection(settings={}){
    const config=settings?.decisionCore??{},connection=config.connection??{};
    let endpoint=normalizeJevEndpoint(connection.endpoint||'');
    let provider=endpoint?inferJevProviderFromEndpoint(endpoint):null;
    let apiKey=clean(connection.apiKey||'');
    let model=clean(connection.model||'');
    let source='jev-connector';

    // One-way compatibility for installations that still have the former
    // TypeSafe-direct fields. Sidecar credentials are deliberately never read.
    if(endpoint&&provider===DECISION_PROVIDER.TYPESAFE_DIRECT&&!apiKey&&clean(config.typeSafe?.apiKey)){
        apiKey=clean(config.typeSafe.apiKey);
        source='legacy-typesafe';
    }
    if(!endpoint&&clean(config.typeSafe?.apiKey)){
        endpoint=TYPESAFE_SYSTEMONE_ENDPOINT;
        provider=DECISION_PROVIDER.TYPESAFE_DIRECT;
        apiKey=clean(config.typeSafe.apiKey);
        model=model||clean(config.typeSafe?.model)||DEFAULT_TYPESAFE_MODEL;
        source='legacy-typesafe';
    }
    if(endpoint&&!provider)provider=inferJevProviderFromEndpoint(endpoint);
    if(!model)model=provider===DECISION_PROVIDER.OPENROUTER_JEV?DEFAULT_OPENROUTER_JEV_MODEL:DEFAULT_TYPESAFE_MODEL;

    return Object.freeze({
        kind:'NexusJevConnection',
        endpoint,
        apiKey,
        model,
        provider:provider||DECISION_PROVIDER.AUTO,
        configured:Boolean(endpoint&&apiKey),
        connected:connection.connected!==false&&Boolean(endpoint&&apiKey),
        lastTest:connection.lastTest||null,
        source,
    });
}
