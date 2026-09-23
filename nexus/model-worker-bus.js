import { logEvent } from '../observability/telemetry.js';
import { captureNexusWorkScope, isNexusWorkScopeFresh, currentNexusChatEpoch } from './work-scope.js';
import { estimateSidecarCall } from '../observability/token-estimator.js';
import { resolveAutoReasoningEffort } from '../sidecar/reasoning-auto.js';
import { resolveSidecarTransportTimeout } from '../sidecar/timeout-policy.js';
import { recordAdaptivePhysicalWorkerSample, recommendAdaptivePhysicalWorkerPlan } from './adaptive-throughput.js';

import { chooseNexusModelWorkerResource, isNexusMainPreferredWorker, resolveNexusModelWorkerPoolPlan, resolveNexusModelWorkerLanePreference } from './model-worker-policy.js';
export { chooseNexusModelWorkerResource, isNexusMainPreferredWorker, resolveNexusModelWorkerPoolPlan, resolveNexusModelWorkerLanePreference } from './model-worker-policy.js';

let hostContextModulePromise = null;
async function getModelWorkerHostContext(){
    if(typeof globalThis.__NEXUS_TEST_CONTEXT_PROVIDER__==='function')return globalThis.__NEXUS_TEST_CONTEXT_PROVIDER__();
    hostContextModulePromise ||= import('../../../../st-context.js');
    const mod=await hostContextModulePromise;
    return mod?.getContext?.() ?? null;
}

let settingsModulePromise = null;
let sidecarBusModulePromise = null;
let batchLayerModulePromise = null;
async function currentModelWorkerSettings(){
    settingsModulePromise ||= import('../core/settings.js');
    const mod=await settingsModulePromise;
    return mod?.getSettings?.() || {};
}
async function canDispatchModelWorkerSidecar(stage, options={}){
    sidecarBusModulePromise ||= import('../sidecar/bus.js');
    const mod=await sidecarBusModulePromise;
    return mod?.canDispatchSidecarWork?.(stage,options)===true;
}
async function enqueueModelWorkerSidecar(domain, stage, options={}){
    batchLayerModulePromise ||= import('./batch-layer.js');
    const mod=await batchLayerModulePromise;
    if(typeof mod?.enqueueNexusSidecarJob!=='function')throw new Error('Nexus Sidecar batch dispatcher is unavailable.');
    return mod.enqueueNexusSidecarJob(domain,stage,options);
}

let seq = 0;
let mainReservationHandleId = null;

function claimMainReservation(handleId){
    const id=String(handleId||'');
    if(!id)return false;
    if(mainReservationHandleId&&mainReservationHandleId!==id)return false;
    mainReservationHandleId=id;
    return true;
}
function releaseMainReservation(handleId){
    if(mainReservationHandleId===String(handleId||''))mainReservationHandleId=null;
}

function nextId(){ seq += 1; return `nexus_model_worker_${Date.now()}_${seq}`; }
function clean(v){ return String(v ?? '').trim(); }
function modelWorkerPhysicalWorkloadType(domain,stage,role){
    return `model-worker:${clean(domain)||'unknown'}:${clean(stage)||'unknown'}:${clean(role)||'unknown'}`;
}
function modelWorkerFailureOutcome(error){
    const name=String(error?.name||''),message=String(error?.message||'');
    if(/timeout/i.test(name)||/timeout|timed out/i.test(message))return 'timeout';
    if(/truncated/i.test(name)||/truncated|output boundary/i.test(message))return 'truncated';
    return 'failure';
}
function modelWorkerResponseOutputTokens(response,text=''){
    const n=Number(response?.usageNormalized?.outputTokens??response?.usage?.outputTokens??response?.usageEstimated?.outputTokens);
    if(Number.isFinite(n)&&n>0)return n;
    return Math.max(0,Math.ceil(String(text||response?.text||'').length/4));
}
function modelWorkerResponseInputTokens(response,request){
    const n=Number(response?.usageNormalized?.inputTokens??response?.usage?.inputTokens??response?.usageEstimated?.inputTokens);
    if(Number.isFinite(n)&&n>0)return n;
    try{return estimateSidecarCall({systemPrompt:clean(request?.systemPrompt),prompt:clean(request?.prompt),maxTokens:Number(request?.responseLength||request?.maxTokens||request?.requestedMaxTokens)||0}).inputTokens||0;}catch{return 0;}
}
export function isNexusMainWorkerEnabled(settings={}){
    const s=settings||{};
    return s.enabled===true
        && s.nexus?.callCenter?.mainModelAccess===true;
}
async function mainPolicyEnabled(){ return isNexusMainWorkerEnabled(await currentModelWorkerSettings()); }
function textOf(value){
    if(typeof value==='string') return value;
    if(typeof value?.text==='string') return value.text;
    if(typeof value?.content==='string') return value.content;
    if(typeof value?.response==='string') return value.response;
    return JSON.stringify(value ?? '');
}
function staleError(scope){ const e=new Error('Nexus model-worker result arrived after its chat/revision scope became stale.'); e.name='TV2ScopeInvalidated'; e.nexusScope=scope?{...scope}:null; return e; }
function cancellationError(reason){ const e=reason instanceof Error?reason:new Error(String(reason||'Nexus model-worker work cancelled.')); if(!e.name||e.name==='Error')e.name='TV2BatchCancelled'; return e; }

function sleepWithSignal(ms, signal){
    return new Promise((resolve,reject)=>{
        if(signal?.aborted)return reject(signal.reason||cancellationError('Nexus model-worker wait cancelled.'));
        const timer=setTimeout(done,Math.max(10,Math.floor(Number(ms)||50)));
        function done(){signal?.removeEventListener?.('abort',onAbort);resolve();}
        function onAbort(){clearTimeout(timer);signal?.removeEventListener?.('abort',onAbort);reject(signal.reason||cancellationError('Nexus model-worker wait cancelled.'));}
        signal?.addEventListener?.('abort',onAbort,{once:true});
    });
}

async function dispatchMainWhenAvailable(stage, options, scope, controller, id){
    // Main is one physical lease. Waiting is bounded and telemetry is throttled
    // so a stale/busy lease cannot become an infinite Activity Feed loop.
    const startedAt=Date.now();
    const waitCapMs=Math.max(1000,Math.min(300000,Number(options.leaseWaitTimeoutMs??options.timeoutMs)||120000));
    let attempts=0,lastLogAt=0,lastBusySource=null;
    while(true){
        if(controller.signal.aborted)throw controller.signal.reason||cancellationError('Nexus Main worker wait cancelled.');
        if(!(await mainPolicyEnabled())){const e=new Error('Nexus Main worker participation was revoked while queued.');e.name='TV2BoundaryPolicyRevoked';e.deferred=true;throw e;}
        try{return await dispatchMain(stage,options,scope,controller,id);}
        catch(error){
            if(controller.signal.aborted)throw controller.signal.reason||error;
            if(String(error?.name||'')!=='TV2MainExecutionBusy')throw error;
            attempts+=1;lastBusySource=error?.busySource||null;
            const waitedMs=Date.now()-startedAt;
            if(waitedMs>=waitCapMs){
                const timeout=new Error(`Nexus Main worker lease remained busy for ${waitedMs}ms.`);
                timeout.name='TV2MainLeaseWaitTimeout';timeout.deferred=true;timeout.busySource=lastBusySource;timeout.waitedMs=waitedMs;timeout.waitCapMs=waitCapMs;
                logEvent('model-worker','main-lease-wait-timeout',{handleId:id,stage,role:options.role||null,busySource:lastBusySource,waitedMs,waitCapMs,attempts},'warn');
                throw timeout;
            }
            const now=Date.now();
            if(lastLogAt===0||now-lastLogAt>=5000){lastLogAt=now;logEvent('model-worker','main-waiting-for-lease',{handleId:id,stage,role:options.role||null,busySource:lastBusySource,waitedMs,waitCapMs,attempts},'debug');}
            await sleepWithSignal(125,controller.signal);
        }
    }
}

async function runtimeSnapshot(){
    const mod=await import('./runtime.js');
    const runtime=mod.getNexusRuntime?.();
    const gateway=runtime?.generationGateway;
    const snap=gateway?.snapshot?.()||{};
    return {runtime,gateway,snap};
}

async function dispatchMain(stage, options, scope, controller, id){
    const {runtime,gateway,snap}=await runtimeSnapshot();
    if(!runtime||!gateway||!gateway.isConnected?.()) { const e=new Error('Nexus Main worker is not connected.'); e.name='TV2MainWorkerUnavailable'; e.deferred=true; throw e; }
    if(snap.busy===true){ const e=new Error('Nexus Main worker is currently busy.'); e.name='TV2MainExecutionBusy'; e.deferred=true; e.busySource=snap.foregroundMainActive?'foreground-main':'generation-gateway'; throw e; }
    const responseLength=Math.max(64,Math.min(131072,Math.floor(Number(options.responseLength||options.maxTokens||options.requestedMaxTokens||options.softOutputTargetTokens)||3072)));
    const prompt=clean(options.prompt),systemPrompt=clean(options.systemPrompt);
    const estimate=estimateSidecarCall({systemPrompt,prompt,maxTokens:responseLength});
    const reasoningDecision=resolveAutoReasoningEffort({
        requested:options.reasoningEffort??'auto',role:options.role||'',bus:options.telemetry?.bus||'',domain:options.telemetry?.nexusBatchDomain||'',phase:options.telemetry?.phase||'',attempt:options.telemetry?.attempt||1,
        inputTokens:estimate.inputTokens,plannedOutputTokens:responseLength,responseFormat:options.responseFormat||null,structuredValidator:options.structuredValidator||null,prompt,systemPrompt,
    });
    const genericJsonSchema=options.responseFormat==='json_object'?{$schema:'http://json-schema.org/draft-04/schema#',type:'object',additionalProperties:true}:null;
    const jsonSchema=options.jsonSchema&&typeof options.jsonSchema==='object'&&!Array.isArray(options.jsonSchema)?options.jsonSchema:genericJsonSchema;
    const workerControls={
        requestedReasoningEffort:reasoningDecision.requested,
        reasoningEffort:reasoningDecision.effective,
        reasoningReason:reasoningDecision.reason,
        temperature:Number.isFinite(Number(options.temperature))?Number(options.temperature):null,
        excludeReasoning:options.excludeReasoning===true,
        responseFormat:options.responseFormat||null,
        stream:false,
    };
    const metadata={
        ...(options.telemetry||{}), internalModelWorker:true, modelWorkerStage:clean(stage), modelWorkerRole:clean(options.role),
        nexusChatEpoch:currentNexusChatEpoch(), chatBound:true, modelWorkerHandleId:id,
        mainWorkerEstimate:estimate,mainWorkerControls:workerControls,
    };
    const timeoutMs=resolveSidecarTransportTimeout({
        profileTimeoutMs:120000,
        requestedTimeoutMs:options.timeoutMs,
        estimatedInputTokens:estimate.inputTokens,
        plannedInputTokens:options.resourcePolicy?.softInputTargetTokens||options.softInputTargetTokens||0,
        plannedOutputTokens:responseLength,
        requestMaxTokens:responseLength,
        reasoningEffort:reasoningDecision.effective,
    });
    const startedAt=Date.now();
    const physicalWorkloadType=modelWorkerPhysicalWorkloadType(options.telemetry?.modelWorkerDomain||options.telemetry?.nexusBatchDomain,stage,options.role);
    logEvent('model-worker','main-dispatch-start',{handleId:id,stage,role:options.role||null,responseLength,timeoutMs,estimatedInputTokens:estimate.inputTokens,requestedReasoningEffort:reasoningDecision.requested,reasoningEffort:reasoningDecision.effective,reasoningReason:reasoningDecision.reason,responseFormat:options.responseFormat||null,jsonSchema:!!jsonSchema,temperature:workerControls.temperature,adaptivePhysicalWorkloadType:physicalWorkloadType},'info');
    if(!(await mainPolicyEnabled())){ const e=new Error('Nexus Main worker participation was revoked before dispatch.'); e.name='TV2BoundaryPolicyRevoked'; e.deferred=true; throw e; }
    let raw;
    try{
        raw=await gateway.dispatchWorker({prompt,systemPrompt,responseLength,jsonSchema,prefill:clean(options.prefill),workerControls,metadata},{signal:controller.signal,timeoutMs,workerId:id});
    }catch(error){
        const latencyMs=Date.now()-startedAt,adapterMeta=error?.tv2MainWorker||null;
        if(!controller.signal.aborted)recordAdaptivePhysicalWorkerSample({workloadType:physicalWorkloadType,worker:'MAIN',provider:adapterMeta?.controls?.source||'st-main',profile:'st-main',model:adapterMeta?.controls?.model||'unknown',successfulItems:0,latencyMs,outcome:modelWorkerFailureOutcome(error),inputTokens:estimate.inputTokens,outputTokens:0,requestMaxTokens:responseLength});
        logEvent('model-worker','main-dispatch-failed',{handleId:id,stage,role:options.role||null,latencyMs,errorName:error?.name||null,error:error?.message||String(error),requestedReasoningEffort:reasoningDecision.requested,reasoningEffort:reasoningDecision.effective,responseFormat:options.responseFormat||null,jsonSchemaRequested:!!jsonSchema,jsonSchemaPassedToST:error?.tv2MainWorker?.jsonSchemaPassedToST??null,settingsReadyObserved:error?.tv2MainWorker?.settingsReadyObserved??null,controlAdaptation:error?.tv2MainWorker?.adaptation||null,appliedControls:error?.tv2MainWorker?.controls?.applied||[],skippedControls:error?.tv2MainWorker?.controls?.skipped||[],adaptivePhysicalWorkloadType:physicalWorkloadType},'warn');
        throw error;
    }
    const text=textOf(raw),adapterMeta=raw?.tv2MainWorker||null,latencyMs=Date.now()-startedAt;
    const estimatedOutputTokens=Math.max(0,Math.ceil(text.length/4));
    recordAdaptivePhysicalWorkerSample({workloadType:physicalWorkloadType,worker:'MAIN',provider:adapterMeta?.controls?.source||'st-main',profile:'st-main',model:adapterMeta?.controls?.model||'unknown',successfulItems:1,latencyMs,outcome:'success',inputTokens:estimate.inputTokens,outputTokens:estimatedOutputTokens,requestMaxTokens:responseLength});
    if(!(await mainPolicyEnabled())){ const e=new Error('Nexus Main worker participation was revoked before result acceptance.'); e.name='TV2BoundaryPolicyRevoked'; e.deferred=true; throw e; }
    if(!isNexusWorkScopeFresh(scope,await getModelWorkerHostContext())) throw staleError(scope);
    let structuredPayload=null;
    if(typeof options.synthesisCandidateParser==='function') structuredPayload=options.synthesisCandidateParser(text);
    const response={ text, structuredPayload, raw, usageEstimated:{inputTokens:estimate.inputTokens,outputTokens:estimatedOutputTokens,totalTokens:estimate.inputTokens+estimatedOutputTokens}, tv2:{slot:'MAIN',worker:'main',resourceKey:'main',jobId:id,stage:clean(stage),role:clean(options.role),model:adapterMeta?.controls?.model||null,format:adapterMeta?.controls?.source||null,mainWorker:adapterMeta} };
    logEvent('model-worker','main-dispatch-complete',{handleId:id,stage,role:options.role||null,latencyMs,responseChars:text.length,estimatedInputTokens:estimate.inputTokens,estimatedOutputTokens,requestedReasoningEffort:reasoningDecision.requested,reasoningEffort:reasoningDecision.effective,responseFormat:options.responseFormat||null,jsonSchemaRequested:!!jsonSchema,jsonSchemaPassedToST:adapterMeta?.jsonSchemaPassedToST??null,settingsReadyObserved:adapterMeta?.settingsReadyObserved??null,controlAdaptation:adapterMeta?.adaptation||null,appliedControls:adapterMeta?.controls?.applied||[],adaptivePhysicalWorkloadType:physicalWorkloadType},'info');
    return response;
}

/**
 * Director-owned semantic work dispatcher. Main and Sidecars are execution
 * resources only; the owning subsystem still builds, validates and commits the
 * work. Foreground-adjacent requests prefer Sidecars so RP Main stays free.
 */
export function enqueueNexusModelWorkerJob(domain, stage, options={}){
    options={...options,telemetry:{...(options.telemetry||{}),modelWorkerDomain:domain}};
    const id=nextId();
    let scope=options.nexusScope||null;
    const controller=new AbortController();
    let physical=null;
    const handle={id,jobId:null,state:'queued',label:options.label||`Nexus model worker · ${stage}`,meta:{kind:'nexus-model-worker',domain,stage,mainEligible:options.mainEligible!==false,forceMain:options.forceMain===true,nexusScope:scope},error:null,promise:null,cancel(reason='Nexus model-worker work cancelled.'){
        if(['completed','failed','cancelled'].includes(handle.state))return false;
        const error=cancellationError(reason);handle.state='cancelled';handle.error=error;
        try{controller.abort(error);}catch{}
        try{physical?.cancel?.(error);}catch{}
        return true;
    }};
    handle.promise=(async()=>{
        if(controller.signal.aborted)throw controller.signal.reason;
        if(!scope)scope=captureNexusWorkScope(await getModelWorkerHostContext(),{kind:options.scopeKind==='independent'?'independent':'chat'});
        handle.meta.nexusScope=scope;
        handle.state='executing';
        const forcedSidecar=['A','B'].includes(String(options.forceSlot||'').toUpperCase()) || (options.executionMode&&String(options.executionMode)!=='adaptive');
        const forceMain=options.forceMain===true;
        if(forceMain&&forcedSidecar){const e=new Error('Nexus model-worker request cannot force Main and a Sidecar lane simultaneously.');e.name='TV2ModelWorkerRouteConflict';throw e;}
        const sidecarAvailable=await canDispatchModelWorkerSidecar(stage,{role:options.role});
        const mainEligible=options.mainEligible!==false;
        let mainConfigured=mainEligible&&(await mainPolicyEnabled());let mainBusy=true,runtimeProfile=null;
        if(mainConfigured||sidecarAvailable){try{const {runtime,gateway,snap}=await runtimeSnapshot();runtimeProfile=runtime?.executionProfile||null;mainConfigured=mainConfigured&&!!gateway?.isConnected?.();mainBusy=!mainConfigured||snap?.busy===true||(mainReservationHandleId!==null&&mainReservationHandleId!==id);}catch{mainConfigured=false;mainBusy=true;runtimeProfile=null;}}
        let preferMain=isNexusMainPreferredWorker(stage,options),adaptiveSinglePlan=null;
        if(!forceMain&&!forcedSidecar&&options.foregroundAdjacent!==true&&mainConfigured&&!mainBusy&&sidecarAvailable){
            const legalWorkers=(runtimeProfile?.workerResources||[]).map(value=>String(value||'').toUpperCase()).filter(worker=>worker==='MAIN'||['A','B'].includes(worker));
            if(legalWorkers.includes('MAIN')&&legalWorkers.some(worker=>worker!=='MAIN')){
                const workloadType=modelWorkerPhysicalWorkloadType(domain,stage,options.role);
                adaptiveSinglePlan=recommendAdaptivePhysicalWorkerPlan({workloadType,workers:legalWorkers,unitCount:1});
                if(adaptiveSinglePlan.reason!=='cold-exploration'){
                    const predictedMain=Number(adaptiveSinglePlan.predictedAssignments?.MAIN)||0;
                    const predictedSidecar=Object.entries(adaptiveSinglePlan.predictedAssignments||{}).filter(([worker])=>worker!=='MAIN').reduce((sum,[,count])=>sum+(Number(count)||0),0);
                    if(predictedMain>0)preferMain=true;else if(predictedSidecar>0||adaptiveSinglePlan.mainParticipates===false)preferMain=false;
                }
            }
        }
        let resource=forceMain
            ? (mainConfigured?'main':'none')
            : chooseNexusModelWorkerResource({mainConfigured,mainBusy,sidecarAvailable,preferMain,forcedSidecar,foregroundAdjacent:options.foregroundAdjacent===true});
        // With no Sidecar, a busy Main is still a valid queued resource. Do not
        // fail Main-only topologies because a sibling Builder slice owns the one
        // physical lease for the moment.
        if(resource==='none'&&!forcedSidecar&&!sidecarAvailable&&mainConfigured)resource='main';
        let reservedMain=false;
        if(resource==='main'&&!forceMain&&!mainBusy){
            reservedMain=claimMainReservation(id);
            if(!reservedMain&&sidecarAvailable){resource='sidecar';mainBusy=true;}
        }
        logEvent('model-worker','resource-selected',{handleId:id,domain,stage,role:options.role||null,resource,preferMain,mainEligible,forceMain,mainConfigured,mainBusy,sidecarAvailable,mainReservationOwner:mainReservationHandleId,foregroundAdjacent:options.foregroundAdjacent===true,adaptivePhysicalWorkloadType:modelWorkerPhysicalWorkloadType(domain,stage,options.role),adaptivePhysicalReason:adaptiveSinglePlan?.reason||null,predictedAssignments:adaptiveSinglePlan?.predictedAssignments||null,predictedWithMainMs:adaptiveSinglePlan?.predictedWithMainMs??null,predictedSidecarOnlyMs:adaptiveSinglePlan?.predictedSidecarOnlyMs??null},'debug');
        if(resource==='main'){
            try{
                if(forceMain||!sidecarAvailable||mainBusy)return await dispatchMainWhenAvailable(stage,options,scope,controller,id);
                return await dispatchMain(stage,options,scope,controller,id);
            }
            catch(error){
                if(controller.signal.aborted)throw controller.signal.reason||error;
                if(forceMain)throw error;
                const transient=['TV2MainExecutionBusy','TV2MainWorkerUnavailable'].includes(String(error?.name||''))||error?.deferred===true;
                if(!transient||!(await canDispatchModelWorkerSidecar(stage,{role:options.role})))throw error;
                logEvent('model-worker','main-fallback-sidecar',{handleId:id,stage,reason:error?.name||error?.message||String(error)},'warn');
                resource='sidecar';
            } finally {
                if(reservedMain)releaseMainReservation(id);
            }
        }
        if(resource==='sidecar'){
            const sidecarStartedAt=globalThis.performance?.now?.()??Date.now();
            physical=await enqueueModelWorkerSidecar(domain,stage,{...options,telemetry:{...(options.telemetry||{}),modelWorkerSelected:'sidecar',modelWorkerHandleId:id}});
            handle.jobId=physical.id||physical.jobId||null;
            if(handle.meta){
                handle.meta.preferredSlot=physical?.meta?.preferredSlot||null;
                handle.meta.assignedSlot=physical?.meta?.assignedSlot||null;
            }
            const abort=()=>{try{physical?.cancel?.(controller.signal.reason);}catch{}};controller.signal.addEventListener('abort',abort,{once:true});
            try{
                const result=await physical.promise;
                const slot=String(result?.tv2?.slot||'').toUpperCase();
                if(handle.meta&&['A','B'].includes(slot))handle.meta.assignedSlot=slot;
                if(['A','B'].includes(slot)){
                    const latencyMs=(globalThis.performance?.now?.()??Date.now())-sidecarStartedAt;
                    const inputTokens=modelWorkerResponseInputTokens(result,options),outputTokens=modelWorkerResponseOutputTokens(result);
                    const workloadType=modelWorkerPhysicalWorkloadType(domain,stage,options.role);
                    recordAdaptivePhysicalWorkerSample({workloadType,worker:slot,provider:result?.tv2?.format||'sidecar',profile:'sidecar',model:result?.tv2?.model||'unknown',successfulItems:1,latencyMs,outcome:'success',inputTokens,outputTokens,requestMaxTokens:Number(options.responseLength||options.maxTokens||options.requestedMaxTokens)||0});
                    logEvent('model-worker','adaptive-physical-worker-observed',{domain,stage,role:options.role||null,worker:slot,latencyMs,inputTokens,outputTokens,workloadType},'debug');
                }
                if(!isNexusWorkScopeFresh(scope,await getModelWorkerHostContext()))throw staleError(scope);
                return result;
            }catch(error){
                if(controller.signal.aborted)throw controller.signal.reason||error;
                const workerUnavailable=['TV2SidecarWorkerUnavailable','TV2MultiWorkerUnavailable','TV2ExecutionProfileRetired'].includes(String(error?.name||''));
                if(!workerUnavailable||forcedSidecar||!mainEligible||!(await mainPolicyEnabled()))throw error;
                const {gateway}=await runtimeSnapshot();
                if(!gateway?.isConnected?.())throw error;
                logEvent('model-worker','sidecar-fallback-main',{handleId:id,stage,reason:error?.name||error?.message||String(error)},'warn');
                physical=null;handle.jobId=null;
                return await dispatchMainWhenAvailable(stage,options,scope,controller,id);
            }finally{controller.signal.removeEventListener('abort',abort);}
        }
        const e=new Error('No Nexus model-worker execution resource is currently available.');e.name='TV2ModelWorkerUnavailable';e.deferred=true;throw e;
    })().then(value=>{if(handle.state!=='cancelled')handle.state='completed';return value;},error=>{if(handle.state!=='cancelled')handle.state='failed';handle.error=error;throw error;});
    return handle;
}

/**
 * Batch-layer physical dispatcher for the abstract Model Worker pool. Logical
 * slicing/recovery remains owned by the caller/Batch Layer; this function only
 * assigns each physical unit to Main or the Sidecar pool through the canonical
 * Model Worker contract.
 */
export async function dispatchNexusModelWorkerUnits({
    domain, stage, units = [], label, priority, role, executionMode, forceSlot,
    allowPartial, dedupKey, telemetry, nexusScope, operation,
    foregroundAdjacent = false, generationId = null, enqueue = null,
} = {}){
    if(!Array.isArray(units)||!units.length)return [];
    const enqueueWorker=typeof enqueue==='function'?enqueue:enqueueNexusModelWorkerJob;
    const sample=units.find(unit=>unit?.request)?.request||{};
    const physicalWorkloadType=modelWorkerPhysicalWorkloadType(domain,stage,role||sample.role);
    // Tree's outer Batch Layer has already packed semantic slices and owns the
    // continuous physical pool. Re-entering enqueueNexusSidecarJob's generic
    // debounce/coalescer adds a second scheduling barrier without combining
    // any work. Bypass only that nested queue for explicitly-marked Tree
    // rolling-pool units; all routing, health, retries and validation remain
    // owned by the existing Model Worker / Sidecar stack.
    const directTreePhysicalDispatch=String(domain||'').trim().toLowerCase()==='tree'
        && telemetry?.nexusBatchTreeRollingDispatch===true;
    let width=1,hybridMainLane=false,activeWorkers=[],adaptivePhysicalPlan=null;
    try{
        const {runtime,snap}=await runtimeSnapshot();
        const profile=runtime?.executionProfile||{};
        const explicitMain=sample.forceMain===true;
        const explicitSidecar=sample.mainEligible===false||['A','B'].includes(String(sample.forceSlot||forceSlot||'').toUpperCase())||(sample.executionMode&&String(sample.executionMode)!=='adaptive');
        const sidecarAvailableForRole=await canDispatchModelWorkerSidecar(stage,{role:role||sample.role});
        const advertisedWorkers=Array.isArray(profile.workerResources)?profile.workerResources.map(value=>String(value||'').toUpperCase()).filter(Boolean):[];
        const mainEligible=sample.mainEligible!==false;
        const sidecarWorkers=advertisedWorkers.filter(worker=>['A','B'].includes(worker));
        let legalWorkers=advertisedWorkers.filter(worker=>(worker!=='MAIN'||mainEligible)&&(worker==='MAIN'||sidecarAvailableForRole));
        if(explicitMain)legalWorkers=legalWorkers.includes('MAIN')?['MAIN']:[];
        else if(explicitSidecar)legalWorkers=sidecarWorkers.filter(worker=>legalWorkers.includes(worker));
        if(!legalWorkers.length){
            const pool=resolveNexusModelWorkerPoolPlan({unitCount:units.length,modelWorkerCount:profile.modelWorkerCount,sidecarCount:profile.sidecarCount,explicitMain,explicitSidecar,mainEligible});
            width=pool.width;hybridMainLane=pool.hybridMainLane;
        }else{
            const legalSidecars=legalWorkers.filter(worker=>worker!=='MAIN');
            if(explicitMain){activeWorkers=['MAIN'];adaptivePhysicalPlan={workloadType:physicalWorkloadType,activeWorkers,mainParticipates:true,reason:'explicit-main'};}
            else if(explicitSidecar){activeWorkers=legalSidecars;adaptivePhysicalPlan={workloadType:physicalWorkloadType,activeWorkers,mainParticipates:false,reason:'explicit-sidecar'};}
            else if(foregroundAdjacent&&legalSidecars.length){activeWorkers=legalSidecars;adaptivePhysicalPlan={workloadType:physicalWorkloadType,activeWorkers,mainParticipates:false,reason:'foreground-adjacent'};}
            else if(snap?.busy===true&&legalSidecars.length&&legalWorkers.includes('MAIN')){activeWorkers=legalWorkers;adaptivePhysicalPlan={workloadType:physicalWorkloadType,activeWorkers,mainParticipates:true,reason:'main-busy-elastic-pool'};}
            else{
                adaptivePhysicalPlan=recommendAdaptivePhysicalWorkerPlan({workloadType:physicalWorkloadType,workers:legalWorkers,unitCount:units.length});
                activeWorkers=adaptivePhysicalPlan.activeWorkers||legalWorkers;
            }
            width=Math.max(1,Math.min(units.length,activeWorkers.length||1));
            hybridMainLane=activeWorkers.includes('MAIN')&&activeWorkers.some(worker=>worker!=='MAIN');
        }
    }catch(error){
        width=1;hybridMainLane=false;activeWorkers=[];
        logEvent('model-worker','adaptive-physical-plan-fallback',{domain,stage,role:role||sample.role||null,error:error?.message||String(error)},'warn');
    }
    logEvent('model-worker','batch-pool-start',{
        domain,stage,unitCount:units.length,poolWidth:width,role:role||sample.role||null,hybridMainLane,
        adaptivePhysicalWorkloadType:physicalWorkloadType,activeWorkers,
        adaptivePhysicalReason:adaptivePhysicalPlan?.reason||null,
        predictedAssignments:adaptivePhysicalPlan?.predictedAssignments||null,
        predictedWithMainMs:adaptivePhysicalPlan?.predictedWithMainMs??null,
        predictedSidecarOnlyMs:adaptivePhysicalPlan?.predictedSidecarOnlyMs??null,
        predictedMainImprovement:adaptivePhysicalPlan?.improvement??null,
    },'debug');
    const rows=new Array(units.length);
    let cursor=0;
    const laneMainPreference=(workerIndex,request)=>{
        if(request?.mainPreferred===true||request?.mainPreferred===false)return request.mainPreferred;
        if(activeWorkers.length&&!activeWorkers.includes('MAIN'))return false;
        if(activeWorkers.length===1&&activeWorkers[0]==='MAIN')return true;
        return resolveNexusModelWorkerLanePreference(workerIndex,{hybridMainLane,explicitMainPreferred:request?.mainPreferred});
    };
    const runNext=async(workerIndex)=>{
        while(true){
            const index=cursor++;
            if(index>=units.length)return;
            const unit=units[index];
            const request={
                ...(unit.request||{}),
                priority:unit.request?.priority??priority,
                role:unit.request?.role??role,
                executionMode:unit.request?.executionMode??executionMode,
                forceSlot:unit.request?.forceSlot??forceSlot,
                mainPreferred:laneMainPreference(workerIndex,unit.request||{}),
                nexusScope:unit.request?.nexusScope??nexusScope,
                foregroundAdjacent:unit.request?.foregroundAdjacent??foregroundAdjacent,
                generationId:unit.request?.generationId??generationId,
                dedupKey:unit.request?.dedupKey??(dedupKey?`${dedupKey}:unit:${unit.id||index}`:null),
                batchable:directTreePhysicalDispatch?false:unit.request?.batchable,
                telemetry:{
                    ...(telemetry||{}),...(unit.request?.telemetry||{}),
                    modelWorkerDomain:domain,nexusBatchDomain:domain,nexusBatchSlice:unit.id,nexusBatchIndex:index,nexusBatchCount:units.length,
                    modelWorkerBatch:true,modelWorkerPoolWidth:width,modelWorkerPoolLane:workerIndex,hybridMainLane,
                    modelWorkerDirectTreePhysicalDispatch:directTreePhysicalDispatch,
                    adaptivePhysicalWorkloadType:physicalWorkloadType,adaptivePhysicalPlanReason:adaptivePhysicalPlan?.reason||null,
                },
            };
            let handle=null;
            try{
                operation?.assertFresh?.();
                handle=enqueueWorker(domain,stage,request);
                operation?.handles?.add?.(handle);
                const response=await handle.promise;
                operation?.assertFresh?.();
                rows[index]={unit,response,jobId:handle.id||handle.jobId||null};
            }catch(error){
                if(operation?.cancelled||controllerCancellationLike(error))throw error;
                rows[index]={unit,error,jobId:handle?.id||handle?.jobId||null};
            }finally{
                if(handle)operation?.handles?.delete?.(handle);
            }
        }
    };
    await Promise.all(Array.from({length:width},(_,workerIndex)=>runNext(workerIndex)));
    logEvent('model-worker','batch-pool-complete',{
        domain,stage,unitCount:units.length,poolWidth:width,failedCount:rows.filter(row=>row?.error).length,
        adaptivePhysicalWorkloadType:physicalWorkloadType,activeWorkers,adaptivePhysicalReason:adaptivePhysicalPlan?.reason||null,
    },'debug');
    return rows.filter(Boolean);
}

function controllerCancellationLike(error){
    const name=String(error?.name||'');
    return name==='AbortError'||name==='TV2BatchCancelled'||name==='TV2ScopeInvalidated'||name==='TV2GenerationGatewayAborted';
}
