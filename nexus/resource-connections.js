import { getSettings, updateSettings } from '../core/settings.js';
import { inferDecisionProviderFromEndpoint, resolveDecisionConnection, testDecisionConnection } from '../decision/index.js';
import { checkSidecarProvider } from '../sidecar/provider-check.js';
import { listSidecarModels } from '../sidecar/client.js';
import { embedWithSession } from '../paging/embeddings.js';
import { pagingConfig } from '../paging/policy.js';
import { embeddingSessionKeyLoaded, invalidateVectorPaging, setEmbeddingSessionKey, vectorPagingStatus } from '../paging/runtime.js';

const clean=value=>String(value??'').trim();

function roleOf(input={}){
    if(typeof input==='string')input={resourceId:input};
    const explicit=clean(input?.role??input?.resourceRole??input?.kind).toUpperCase();
    if(['JEV','VECTORING','SIDECAR_A','SIDECAR_B'].includes(explicit))return explicit;
    const hint=[input?.id,input?.resourceId,input?.profileId,input?.providerProfileId,input?.workerId,input?.displayName,input?.connectionName]
        .filter(Boolean).map(String).join(' ');
    if(/\bjev\b/i.test(hint))return'JEV';
    if(/vector|embed/i.test(hint))return'VECTORING';
    if(/sidecar(?:[-_: ]+)b(?:\b|$)/i.test(hint))return'SIDECAR_B';
    if(/sidecar/i.test(hint))return'SIDECAR_A';
    if(explicit==='SIDECAR')return'SIDECAR_A';
    const caps=[...(input?.capabilities??input?.declaredCapabilities??input?.activeCapabilities??[])].map(x=>String(x).toUpperCase());
    if(caps.includes('SEMANTIC_JUDGMENT'))return'JEV';
    if(caps.some(x=>['EMBED','RETRIEVAL','RETRIEVAL_QUALITY','RERANK','LATE_INTERACTION','CROSS_ENCODER_RERANK'].includes(x)))return'VECTORING';
    return null;
}

function sidecarSlot(role){return role==='SIDECAR_B'?'B':'A';}
function sidecarResourceId(slot){return'nexus-sidecar-'+String(slot).toLowerCase();}
function configuredSidecar(profile={}){return profile?.enabled===true||Boolean(clean(profile?.endpoint)||clean(profile?.model)||clean(profile?.apiKey));}
function decisionRaw(settings){return settings?.decisionCore?.connection??{};}

function jevRow(settings){
    const raw=decisionRaw(settings),connection=resolveDecisionConnection(settings),enabled=settings?.decisionCore?.enabled===true;
    const present=enabled||Boolean(clean(raw.endpoint)||clean(raw.apiKey));
    if(!present)return null;
    const configured=Boolean(connection.endpoint&&connection.apiKey&&connection.model);
    const callable=enabled&&configured;
    return Object.freeze({
        resourceId:'nexus-jev',displayName:'Jev',kind:'OPENAI_COMPATIBLE',
        providerId:connection.provider,providerProfileId:'nexus-jev-profile',workerId:'nexus-jev-worker',
        modelId:connection.model||null,endpoint:connection.endpoint||null,
        state:callable?'READY':configured?'DISCONNECTED':'DEGRADED',health:callable?'HEALTHY':configured?'READY':'DEGRADED',
        availability:callable?'AVAILABLE':'UNAVAILABLE',connected:callable,callable,
        capabilities:Object.freeze(['SEMANTIC_JUDGMENT']),declaredCapabilities:Object.freeze(['SEMANTIC_JUDGMENT']),
        activeCapabilities:Object.freeze(callable?['SEMANTIC_JUDGMENT']:[]),qualifiedCapabilities:Object.freeze(callable?['SEMANTIC_JUDGMENT']:[]),
        routableCapabilities:Object.freeze(callable?['SEMANTIC_JUDGMENT']:[]),placements:Object.freeze(['decision-sites']),
        currentLoad:0,concurrencyCapacity:1,credentialConfigured:Boolean(connection.apiKey),credentialRequired:true,
        reasonCode:callable?'JEV_CONNECTED':configured?'JEV_DISCONNECTED':'JEV_CONFIGURATION_INCOMPLETE',
        reason:callable?'Jev connector is available to registered Nexus decision sites.':configured?'Jev is configured but disconnected.':'Jev endpoint, API key, or model is incomplete.',
        lastHealthResult:connection.lastTest??null,lastHealthLatencyMs:Number(connection.lastTest?.latencyMs)||null,lastTest:connection.lastTest??null,local:false,
    });
}

function sidecarRow(settings,queue,slot){
    const profile=settings?.sidecars?.[slot]??{};
    if(!configuredSidecar(profile))return null;
    const endpoint=clean(profile.endpoint)||null,modelId=clean(profile.model)||null;
    const callable=profile.enabled===true&&Boolean(endpoint&&modelId);
    const lane=queue?.lanes?.[slot]??{},running=Array.isArray(lane?.running)?lane.running.length:0;
    const lastHealth=profile.lastHealth??null,degraded=lastHealth?.ok===false;
    return Object.freeze({
        resourceId:sidecarResourceId(slot),displayName:'Sidecar '+slot,kind:'OPENAI_COMPATIBLE',
        providerId:clean(profile.format)||'openai',providerProfileId:'nexus-sidecar-profile-'+slot.toLowerCase(),workerId:'nexus-sidecar-worker-'+slot.toLowerCase(),
        modelId,endpoint,state:callable?(degraded?'DEGRADED':'READY'):(endpoint&&modelId?'DISCONNECTED':'DEGRADED'),
        health:callable?(degraded?'DEGRADED':'HEALTHY'):(endpoint&&modelId?'READY':'DEGRADED'),availability:callable?'AVAILABLE':'UNAVAILABLE',
        connected:callable,callable,capabilities:Object.freeze(['STRUCTURED_EXTRACTION']),declaredCapabilities:Object.freeze(['STRUCTURED_EXTRACTION']),
        activeCapabilities:Object.freeze(callable?['STRUCTURED_EXTRACTION']:[]),qualifiedCapabilities:Object.freeze(callable?['STRUCTURED_EXTRACTION']:[]),
        routableCapabilities:Object.freeze(callable?['STRUCTURED_EXTRACTION']:[]),placements:Object.freeze(Object.entries(profile.capabilities??{}).filter(([,v])=>v===true).map(([k])=>String(k))),
        currentLoad:running,concurrencyCapacity:1,credentialConfigured:Boolean(clean(profile.apiKey)),credentialRequired:false,
        reasonCode:callable?(degraded?'SIDECAR_LAST_HEALTH_FAILED':'SIDECAR_CONNECTED'):(endpoint&&modelId?'SIDECAR_DISCONNECTED':'SIDECAR_CONFIGURATION_INCOMPLETE'),
        reason:callable?(degraded?'The most recent Sidecar health check failed.':'Sidecar is available for Nexus routing.'):(endpoint&&modelId?'Sidecar is configured but disconnected.':'Sidecar endpoint or model is incomplete.'),
        lastHealthResult:lastHealth,lastHealthLatencyMs:Number(lastHealth?.latencyMs??lastHealth?.durationMs)||null,lastTest:lastHealth,local:false,
    });
}

function vectorRow(settings){
    const cfg=pagingConfig(settings?.vectorPaging??{}),meta=settings?.vectorPaging?.connection??{},credentialLoaded=embeddingSessionKeyLoaded();
    const present=Boolean(clean(cfg.endpoint)||clean(cfg.model)||credentialLoaded||meta.connected===true||meta.lastTest);
    if(!present)return null;
    const configured=Boolean(cfg.endpoint&&cfg.model),connected=configured&&meta.connected!==false;
    const status=vectorPagingStatus();
    return Object.freeze({
        resourceId:'nexus-vectoring',displayName:'Vectoring',kind:'OPENAI_COMPATIBLE',
        providerId:'embedding',providerProfileId:'nexus-vectoring-profile',workerId:'nexus-vectoring-worker',
        modelId:cfg.model||null,endpoint:cfg.endpoint||null,state:connected?'READY':configured?'DISCONNECTED':'DEGRADED',
        health:connected?'HEALTHY':configured?'READY':'DEGRADED',availability:connected?'AVAILABLE':'UNAVAILABLE',connected,callable:connected,
        capabilities:Object.freeze(['RETRIEVAL','EMBED']),declaredCapabilities:Object.freeze(['RETRIEVAL','EMBED']),
        activeCapabilities:Object.freeze(connected?['RETRIEVAL','EMBED']:[]),qualifiedCapabilities:Object.freeze(connected?['RETRIEVAL','EMBED']:[]),
        routableCapabilities:Object.freeze(connected?['RETRIEVAL','EMBED']:[]),placements:Object.freeze(['vector-paging','memory-retrieval']),
        currentLoad:status?.busy?1:0,concurrencyCapacity:1,credentialConfigured:credentialLoaded,credentialRequired:false,
        reasonCode:connected?'VECTORING_CONNECTED':configured?'VECTORING_DISCONNECTED':'VECTORING_CONFIGURATION_INCOMPLETE',
        reason:connected?'Embedding/vector connector is available to Nexus vector paging.':configured?'Vectoring is configured but disconnected.':'Vectoring endpoint or model is incomplete.',
        lastHealthResult:meta.lastTest??null,lastHealthLatencyMs:Number(meta.lastTest?.latencyMs)||null,lastTest:meta.lastTest??null,
        diagnostics:Object.freeze([{kind:'VectorPagingStatus',mode:status?.mode??cfg.mode,busy:Boolean(status?.busy),error:status?.error??null}]),local:false,
    });
}

export function readNexusConnectionResources({queue={}}={}){
    const settings=getSettings();
    const resources=[jevRow(settings),sidecarRow(settings,queue,'A'),sidecarRow(settings,queue,'B'),vectorRow(settings)].filter(Boolean);
    return Object.freeze({kind:'NexusResourceStatus',nativePathRequired:false,resources:Object.freeze(resources)});
}

function requireRole(input){const role=roleOf(input);if(!role)throw new Error('Unknown Nexus connection resource.');return role;}
function modelOf(input){return clean(input?.modelId??input?.model);}
function endpointOf(input){return clean(input?.endpoint);}
function keyOf(input){return typeof input?.apiKey==='string'?input.apiKey.trim():'';}

function writeConfig(input,{connect=false}={}){
    const role=requireRole(input),endpoint=endpointOf(input),model=modelOf(input),apiKey=keyOf(input);
    if(role==='JEV'){
        updateSettings(settings=>{
            settings.decisionCore||={};settings.decisionCore.connection||={};
            if(endpoint)settings.decisionCore.connection.endpoint=endpoint;
            if(model)settings.decisionCore.connection.model=model;
            if(apiKey)settings.decisionCore.connection.apiKey=apiKey;
            if(endpoint)settings.decisionCore.provider=inferDecisionProviderFromEndpoint(endpoint);
            if(connect){settings.decisionCore.enabled=true;settings.decisionCore.mode='assist';settings.decisionCore.connection.connected=true;}
        });
    }else if(role==='VECTORING'){
        updateSettings(settings=>{
            settings.vectorPaging||={};settings.vectorPaging.connection||={};
            if(endpoint)settings.vectorPaging.endpoint=endpoint;
            if(model)settings.vectorPaging.model=model;
            if(connect)settings.vectorPaging.connection.connected=true;
        });
        if(apiKey)setEmbeddingSessionKey(apiKey);
        invalidateVectorPaging('vectoring-connection-configured');
    }else{
        const slot=sidecarSlot(role);
        updateSettings(settings=>{
            settings.sidecars||={};settings.sidecars[slot]||={};
            const profile=settings.sidecars[slot];
            if(endpoint)profile.endpoint=endpoint;
            if(model)profile.model=model;
            if(apiKey)profile.apiKey=apiKey;
            profile.format=clean(input?.format??profile.format)||'openai';
            if(connect)profile.enabled=true;
        });
    }
    return readNexusConnectionResources().resources.find(row=>roleOf(row)===role)??null;
}

export function configureNexusConnectionResource(config={}){return writeConfig(config,{connect:false});}

export function connectNexusConnectionResource(config={}){
    const role=requireRole(config),settings=getSettings();
    let hydrated=typeof config==='string'?{resourceId:config}:({...config});
    if(role==='JEV'){
        const stored=resolveDecisionConnection(settings);
        hydrated={...hydrated,role,endpoint:endpointOf(hydrated)||stored.endpoint,model:modelOf(hydrated)||stored.model,apiKey:keyOf(hydrated)||stored.apiKey};
    }else if(role==='VECTORING'){
        const stored=pagingConfig(settings.vectorPaging??{});
        hydrated={...hydrated,role,endpoint:endpointOf(hydrated)||stored.endpoint,model:modelOf(hydrated)||stored.model};
    }else{
        const stored=settings.sidecars?.[sidecarSlot(role)]??{};
        hydrated={...hydrated,role,endpoint:endpointOf(hydrated)||stored.endpoint,model:modelOf(hydrated)||stored.model,apiKey:keyOf(hydrated)||stored.apiKey,format:hydrated.format??stored.format};
    }
    const endpoint=endpointOf(hydrated),model=modelOf(hydrated);
    if(!endpoint)throw new Error(role+' connection requires an endpoint.');
    if(!model)throw new Error(role+' connection requires a model.');
    if(role==='JEV'&&!keyOf(hydrated))throw new Error('Jev connection requires an API key.');
    return writeConfig(hydrated,{connect:true});
}

export function disconnectNexusConnectionResource(resource={}){
    const role=requireRole(resource);
    if(role==='JEV')updateSettings(settings=>{settings.decisionCore||={};settings.decisionCore.enabled=false;settings.decisionCore.mode='off';settings.decisionCore.connection||={};settings.decisionCore.connection.connected=false;});
    else if(role==='VECTORING'){updateSettings(settings=>{settings.vectorPaging||={};settings.vectorPaging.connection||={};settings.vectorPaging.connection.connected=false;});invalidateVectorPaging('vectoring-disconnected');}
    else{const slot=sidecarSlot(role);updateSettings(settings=>{settings.sidecars||={};settings.sidecars[slot]||={};settings.sidecars[slot].enabled=false;});}
    return readNexusConnectionResources().resources.find(row=>roleOf(row)===role)??null;
}

export async function testNexusConnectionResource(resource={}){
    const role=requireRole(resource),started=Date.now();
    if(role==='JEV')return await testDecisionConnection();
    if(role==='VECTORING'){
        const settings=getSettings(),cfg=pagingConfig(settings.vectorPaging);
        if(!cfg.endpoint||!cfg.model)throw new Error('Configure the Vectoring endpoint and model first.');
        const vectors=await embedWithSession(['Nexus vector connector test.'],cfg);
        const result={ok:true,checkedAt:Date.now(),latencyMs:Date.now()-started,dimensions:vectors?.[0]?.length??0,model:cfg.model};
        updateSettings(s=>{s.vectorPaging||={};s.vectorPaging.connection||={};s.vectorPaging.connection.lastTest=result;});
        return result;
    }
    const slot=sidecarSlot(role),profile={...getSettings().sidecars?.[slot],resourceId:sidecarResourceId(slot)};
    const result=await checkSidecarProvider(profile,{includeStructured:true});
    updateSettings(settings=>{settings.sidecars||={};settings.sidecars[slot]||={};settings.sidecars[slot].lastHealth={...result,ok:result.usable===true,latencyMs:result.durationMs};});
    return result;
}

export async function discoverNexusConnectionModels(config={}){
    const role=requireRole(config);
    if(role==='JEV'||role==='VECTORING')return{state:'UNSUPPORTED',models:[],reason:'This connector uses an explicit model ID. Enter the provider model ID manually, then use Test Connection.'};
    const slot=sidecarSlot(role),stored=getSettings().sidecars?.[slot]??{};
    const profile={...stored,endpoint:endpointOf(config)||stored.endpoint,apiKey:keyOf(config)||stored.apiKey,model:modelOf(config)||stored.model,format:clean(config?.format??stored.format)||'openai'};
    const models=await listSidecarModels(profile,{timeoutMs:30000});
    return{state:models.length?'READY':'EMPTY',models:models.map(id=>({id,label:id})),reason:models.length?'':'Provider returned no model list.'};
}

export async function refreshNexusConnectionModels(resource={}){return discoverNexusConnectionModels(resource);}

export function selectNexusConnectionModel(resourceId,modelId){
    const role=requireRole({resourceId}),model=clean(modelId);if(!model)throw new Error('Model ID is required.');
    if(role==='JEV')updateSettings(s=>{s.decisionCore||={};s.decisionCore.connection||={};s.decisionCore.connection.model=model;});
    else if(role==='VECTORING'){updateSettings(s=>{s.vectorPaging||={};s.vectorPaging.model=model;});invalidateVectorPaging('vectoring-model-changed');}
    else{const slot=sidecarSlot(role);updateSettings(s=>{s.sidecars||={};s.sidecars[slot]||={};s.sidecars[slot].model=model;});}
    return readNexusConnectionResources().resources.find(row=>roleOf(row)===role)??null;
}

export function setNexusConnectionCredential(resourceId,apiKey){
    const role=requireRole({resourceId}),key=clean(apiKey);
    if(role==='JEV')updateSettings(s=>{s.decisionCore||={};s.decisionCore.connection||={};s.decisionCore.connection.apiKey=key;});
    else if(role==='VECTORING')setEmbeddingSessionKey(key);
    else{const slot=sidecarSlot(role);updateSettings(s=>{s.sidecars||={};s.sidecars[slot]||={};s.sidecars[slot].apiKey=key;});}
    return true;
}

export function clearNexusConnectionCredential(resourceId){
    const role=requireRole({resourceId});return setNexusConnectionCredential(resourceId,'');
}

export function setNexusConnectionEndpoint(resourceId,endpoint){
    const role=requireRole({resourceId}),value=clean(endpoint);if(!value)throw new Error('Endpoint is required.');
    if(role==='JEV')updateSettings(s=>{s.decisionCore||={};s.decisionCore.connection||={};s.decisionCore.connection.endpoint=value;s.decisionCore.provider=inferDecisionProviderFromEndpoint(value);});
    else if(role==='VECTORING'){updateSettings(s=>{s.vectorPaging||={};s.vectorPaging.endpoint=value;});invalidateVectorPaging('vectoring-endpoint-changed');}
    else{const slot=sidecarSlot(role);updateSettings(s=>{s.sidecars||={};s.sidecars[slot]||={};s.sidecars[slot].endpoint=value;});}
    return readNexusConnectionResources().resources.find(row=>roleOf(row)===role)??null;
}
