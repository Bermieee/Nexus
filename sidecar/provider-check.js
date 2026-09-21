import { callSidecar, listSidecarModels, providerCapabilityKey } from './client.js';

function errorStatus(error){const n=Number(error?.httpStatus??error?.status??error?.response?.status);return Number.isFinite(n)?n:null;}
function result(name,ok,detail='',extra={}){return{name,ok:ok===true,detail:String(detail||''),...extra};}
export function sameProviderCapacity(a,b){
    if(!a?.endpoint||!a?.model||!b?.endpoint||!b?.model)return false;
    return providerCapabilityKey(a,a.endpoint)===providerCapabilityKey(b,b.endpoint);
}
export async function checkSidecarProvider(profile,{signal=null,includeStructured=true}={}){
    const started=Date.now(),checks=[];let models=[];
    if(!profile?.endpoint){return{usable:false,checkedAt:Date.now(),durationMs:0,checks:[result('connection',false,'Endpoint is missing.')],capacityKey:''};}
    try{
        models=await listSidecarModels(profile,{signal,timeoutMs:15000});
        checks.push(result('connection',true,'Provider Models endpoint responded.'));
        checks.push(result('authentication',true,'Credentials accepted by model discovery.'));
        checks.push(result('model availability',!models.length||models.includes(String(profile.model||'')),models.length?(models.includes(String(profile.model||''))?'Configured model is listed.':'Configured model was not returned by model discovery.'):'Provider returned no model list; real request will decide usability.'));
    }catch(error){
        const status=errorStatus(error);checks.push(result('connection',status!=null,status?`Provider responded HTTP ${status}.`:(error?.message||error)));
        checks.push(result('authentication',![401,403,407].includes(status),[401,403,407].includes(status)?'Credentials were rejected.':'Model discovery unavailable; authentication will be tested by a real request.'));
        checks.push(result('model availability',false,'Model discovery did not verify the configured model.'));
    }
    let textResponse=null;
    try{
        const t=Date.now();textResponse=await callSidecar({...profile,enabled:true},{prompt:'Reply with exactly NEXUS_OK.',systemPrompt:'This is a Nexus provider compatibility check. Return only the requested text.',maxTokens:64,reasoningEffort:profile.reasoningEffort||'auto',timeoutMs:Math.min(30000,Number(profile.timeoutMs)||30000),signal,label:'Nexus provider check',telemetry:{role:'connectivity-test',bus:'provider-check',providerCheck:true}});
        checks.push(result('ordinary text',/NEXUS_OK/i.test(String(textResponse?.text||'')),`Real request completed in ${Date.now()-t} ms.`,{latencyMs:Date.now()-t,effectiveReasoning:textResponse?.tv2?.reasoningDecision?.effective||textResponse?.tv2?.effectiveReasoningEffort||null}));
        checks.push(result('request format',true,'Configured provider request shape completed successfully.'));
    }catch(error){checks.push(result('ordinary text',false,error?.message||error,{status:errorStatus(error)}));checks.push(result('request format',false,'Configured text request was not usable.'));}
    if(includeStructured&&checks.find(x=>x.name==='ordinary text')?.ok){
        try{
            const t=Date.now();const response=await callSidecar({...profile,enabled:true},{prompt:'Return exactly this JSON object: {"nexus_provider_check":true}',systemPrompt:'Return JSON only.',responseFormat:'json_object',structuredValidator:value=>value?.nexus_provider_check===true?true:'Expected nexus_provider_check=true.',maxTokens:96,reasoningEffort:profile.reasoningEffort||'auto',timeoutMs:Math.min(30000,Number(profile.timeoutMs)||30000),signal,label:'Nexus structured provider check',telemetry:{role:'connectivity-test',bus:'provider-check',providerCheck:true,structured:true}});
            checks.push(result('structured JSON',response?.structuredPayload?.nexus_provider_check===true,`Structured request completed in ${Date.now()-t} ms.`,{latencyMs:Date.now()-t}));
        }catch(error){checks.push(result('structured JSON',false,error?.message||error,{status:errorStatus(error)}));}
    }
    const textOk=checks.find(x=>x.name==='ordinary text')?.ok===true;
    const structuredOk=!includeStructured||checks.find(x=>x.name==='structured JSON')?.ok===true;
    const authBad=checks.some(x=>x.name==='authentication'&&x.ok===false&&/rejected/i.test(x.detail));
    const usable=textOk&&structuredOk&&!authBad;
    return{usable,checkedAt:Date.now(),durationMs:Date.now()-started,model:String(profile.model||''),format:String(profile.format||'openai'),capacityKey:providerCapabilityKey(profile,profile.endpoint),checks,usage:textResponse?.usageNormalized||null};
}
