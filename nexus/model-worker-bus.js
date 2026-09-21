import { logEvent } from '../observability/telemetry.js';
import { captureNexusWorkScope, isNexusWorkScopeFresh, currentNexusChatEpoch } from './work-scope.js';

import { chooseNexusModelWorkerResource, isNexusMainPreferredWorker } from './model-worker-policy.js';
export { chooseNexusModelWorkerResource, isNexusMainPreferredWorker } from './model-worker-policy.js';

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

function nextId(){ seq += 1; return `nexus_model_worker_${Date.now()}_${seq}`; }
function clean(v){ return String(v ?? '').trim(); }
export function isNexusMainWorkerEnabled(settings={}){
    const s=settings||{};
    return s.enabled===true
        && s.nexus?.modelWorker?.useMain===true;
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
    // Main is one physical lease. When it is the only eligible worker, queued
    // Nexus work may wait behind the current Main lease/foreground generation,
    // but that wait is bounded. A stale lifecycle/gateway busy flag must never
    // turn into an infinite queue or 60ms Activity Feed spam.
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
            attempts+=1;
            lastBusySource=error?.busySource||null;
            const waitedMs=Date.now()-startedAt;
            if(waitedMs>=waitCapMs){
                const timeout=new Error(`Nexus Main worker lease remained busy for ${waitedMs}ms.`);
                timeout.name='TV2MainLeaseWaitTimeout';
                timeout.deferred=true;
                timeout.busySource=lastBusySource;
                timeout.waitedMs=waitedMs;
                timeout.waitCapMs=waitCapMs;
                logEvent('model-worker','main-lease-wait-timeout',{handleId:id,stage,role:options.role||null,busySource:lastBusySource,waitedMs,waitCapMs,attempts},'warn');
                throw timeout;
            }
            const now=Date.now();
            if(lastLogAt===0||now-lastLogAt>=5000){
                lastLogAt=now;
                logEvent('model-worker','main-waiting-for-lease',{handleId:id,stage,role:options.role||null,busySource:lastBusySource,waitedMs,waitCapMs,attempts},'debug');
            }
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
    const metadata={
        ...(options.telemetry||{}), internalModelWorker:true, modelWorkerStage:clean(stage), modelWorkerRole:clean(options.role),
        nexusChatEpoch:currentNexusChatEpoch(), chatBound:true, modelWorkerHandleId:id,
    };
    logEvent('model-worker','main-dispatch-start',{handleId:id,stage,role:options.role||null,responseLength},'info');
    if(!(await mainPolicyEnabled())){ const e=new Error('Nexus Main worker participation was revoked before dispatch.'); e.name='TV2BoundaryPolicyRevoked'; e.deferred=true; throw e; }
    const raw=await gateway.dispatchWorker({
        prompt:clean(options.prompt), systemPrompt:clean(options.systemPrompt), responseLength, metadata,
    },{signal:controller.signal,timeoutMs:Math.max(1000,Math.min(300000,Number(options.timeoutMs)||120000)),workerId:id});
    if(!(await mainPolicyEnabled())){ const e=new Error('Nexus Main worker participation was revoked before result acceptance.'); e.name='TV2BoundaryPolicyRevoked'; e.deferred=true; throw e; }
    if(!isNexusWorkScopeFresh(scope,await getModelWorkerHostContext())) throw staleError(scope);
    const text=textOf(raw);
    let structuredPayload=null;
    if(typeof options.synthesisCandidateParser==='function') structuredPayload=options.synthesisCandidateParser(text);
    const response={ text, structuredPayload, raw, tv2:{slot:'MAIN',worker:'main',resourceKey:'main',jobId:id,stage:clean(stage),role:clean(options.role)} };
    logEvent('model-worker','main-dispatch-complete',{handleId:id,stage,role:options.role||null,responseChars:text.length},'info');
    return response;
}

/**
 * Director-owned semantic work dispatcher. Main and Sidecars are execution
 * resources only; the owning subsystem still builds, validates and commits the
 * work. Foreground-adjacent requests prefer Sidecars so RP Main stays free.
 */
export function enqueueNexusModelWorkerJob(domain, stage, options={}){
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
        let mainConfigured=mainEligible&&(await mainPolicyEnabled());let mainBusy=true;
        if(mainConfigured){try{const {gateway,snap}=await runtimeSnapshot();mainConfigured=!!gateway?.isConnected?.();mainBusy=snap?.busy===true;}catch{mainConfigured=false;mainBusy=true;}}
        const preferMain=isNexusMainPreferredWorker(stage,options);
        let resource=forceMain
            ? (mainConfigured?'main':'none')
            : chooseNexusModelWorkerResource({mainConfigured,mainBusy,sidecarAvailable,preferMain,forcedSidecar,foregroundAdjacent:options.foregroundAdjacent===true});
        // With no Sidecar, a busy Main is still a valid queued resource. Do not
        // fail Main-only topologies because a sibling Builder slice owns the one
        // physical lease for the moment.
        if(resource==='none'&&!forcedSidecar&&!sidecarAvailable&&mainConfigured)resource='main';
        logEvent('model-worker','resource-selected',{handleId:id,domain,stage,role:options.role||null,resource,preferMain,mainEligible,forceMain,mainConfigured,mainBusy,sidecarAvailable,foregroundAdjacent:options.foregroundAdjacent===true},'debug');
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
            }
        }
        if(resource==='sidecar'){
            physical=await enqueueModelWorkerSidecar(domain,stage,{...options,telemetry:{...(options.telemetry||{}),modelWorkerSelected:'sidecar',modelWorkerHandleId:id}});
            handle.jobId=physical.id||physical.jobId||null;
            const abort=()=>{try{physical?.cancel?.(controller.signal.reason);}catch{}};controller.signal.addEventListener('abort',abort,{once:true});
            try{
                const result=await physical.promise;
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
    let width=1;
    try{
        const {runtime}=await runtimeSnapshot();
        const profile=runtime?.executionProfile||{};
        const explicitMain=sample.forceMain===true;
        const explicitSidecar=sample.mainEligible===false||['A','B'].includes(String(sample.forceSlot||forceSlot||'').toUpperCase())||(sample.executionMode&&String(sample.executionMode)!=='adaptive');
        if(explicitMain)width=1;
        else if(explicitSidecar)width=Math.max(1,Math.min(2,Number(profile.sidecarCount)||1));
        else width=Math.max(1,Math.min(3,Number(profile.modelWorkerCount)||1));
    }catch{width=1;}
    width=Math.min(width,units.length);
    logEvent('model-worker','batch-pool-start',{domain,stage,unitCount:units.length,poolWidth:width,role:role||sample.role||null},'debug');
    const rows=new Array(units.length);
    let cursor=0;
    const runNext=async()=>{
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
                nexusScope:unit.request?.nexusScope??nexusScope,
                foregroundAdjacent:unit.request?.foregroundAdjacent??foregroundAdjacent,
                generationId:unit.request?.generationId??generationId,
                dedupKey:unit.request?.dedupKey??(dedupKey?`${dedupKey}:unit:${unit.id||index}`:null),
                telemetry:{
                    ...(telemetry||{}),...(unit.request?.telemetry||{}),
                    nexusBatchDomain:domain,nexusBatchSlice:unit.id,nexusBatchIndex:index,nexusBatchCount:units.length,
                    modelWorkerBatch:true,modelWorkerPoolWidth:width,
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
    await Promise.all(Array.from({length:width},()=>runNext()));
    logEvent('model-worker','batch-pool-complete',{domain,stage,unitCount:units.length,poolWidth:width,failedCount:rows.filter(row=>row?.error).length},'debug');
    return rows.filter(Boolean);
}

function controllerCancellationLike(error){
    const name=String(error?.name||'');
    return name==='AbortError'||name==='TV2BatchCancelled'||name==='TV2ScopeInvalidated'||name==='TV2GenerationGatewayAborted';
}
