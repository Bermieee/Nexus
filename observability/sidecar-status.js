import { getSettings, getSidecarProfile } from '../core/settings.js';
import { getJobQueue } from '../core/job-queue.js';
import { getTelemetrySidecarSnapshot, onTelemetryChange } from './telemetry.js';
import { mainBridgeStatusHtml, getMainBridgeStatusEventName } from '../nexus/main-bridge-status.js';
import { getSidecarRuntimeHealth } from '../sidecar/router.js';
import { getNexusBatchStatus } from '../nexus/batch-layer.js';

function esc(value){return String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));}
const boundStatusTargets = new WeakMap();

export function sidecarStatusSnapshot(){
    const settings=getSettings(),telemetry=getTelemetrySidecarSnapshot(),queue=getJobQueue(settings.jobs).healthSnapshot(),runtimeHealth=getSidecarRuntimeHealth(),batch=getNexusBatchStatus();
    return { telemetry, queue, runtimeHealth, batch, queued:Number(queue?.queued?.length||0)+Number(batch?.queuedUnits||0), activeBatch:Number(batch?.activeUnits||0) };
}

export function sidecarStatusHtml({includeQueue=true,includeMain=true}={}){
    const snapshot=sidecarStatusSnapshot();
    const workers=['A','B'].map(slot=>{
        const worker=snapshot.telemetry.sidecars?.[slot]||{},lane=snapshot.queue?.lanes?.[slot]||{},profile=getSidecarProfile(slot)||{},health=snapshot.runtimeHealth?.[slot]||{};
        const active=worker.active||lane.running?.length;
        const enabled=profile.enabled===true;
        const quarantined=enabled&&health.eligible===false;
        const failed=enabled&&!active&&!quarantined&&worker.last?.ok===false;
        const state=!enabled?'disabled':quarantined?'quarantined':active?'running':failed?'failed':'ready';
        const label=!enabled?'disabled':quarantined?'quarantined':active?'working':failed?'failed':'ready';
        const title=!enabled?'Disabled by Sidecar configuration':quarantined?`Runtime health quarantine · ${Math.ceil(Number(health.cooldownMs||0)/1000)}s remaining · ${health.lastFailure||'provider failure'}`:active?String(worker.active?.label||'Sidecar work running'):failed?String(worker.last?.error?.message||worker.last?.label||'Last Sidecar job failed'):'Enabled and ready for Sidecar work';
        return `<span data-state="${state}" title="${esc(`SC-${slot}: ${title}`)}"><i></i> SC-${slot} ${label}</span>`;
    });
    const parts=[];
    if(includeMain)parts.push(mainBridgeStatusHtml());
    parts.push(...workers);
    const joined=parts.join('<span class="tv2-runtime-separator" aria-hidden="true">•</span>');
    if(!includeQueue)return joined;
    return `${joined}<span class="tv2-runtime-separator" aria-hidden="true">•</span><span class="tv2-shared-sidecar-queue" title="Physical dispatcher queue plus Nexus coalescer waiting units; ${snapshot.activeBatch} coalesced/immediate unit(s) active"><b>Queued</b> ${snapshot.queued}${snapshot.activeBatch?` · <b>Batch active</b> ${snapshot.activeBatch}`:''}</span>`;
}

export function bindSidecarStatus(target,{includeQueue=true,includeMain=true}={}){
    if(!target)return ()=>{};
    boundStatusTargets.get(target)?.();
    let renderHandle=null,renderKind='',cleaned=false;
    const render=()=>{if(!cleaned)target.innerHTML=sidecarStatusHtml({includeQueue,includeMain});};
    const scheduleRender=()=>{
        if(cleaned||renderHandle!=null)return;
        const run=()=>{renderHandle=null;renderKind='';render();};
        if(typeof requestAnimationFrame==='function'){renderKind='raf';renderHandle=requestAnimationFrame(run);}
        else{renderKind='timeout';renderHandle=setTimeout(run,16);}
    };
    const queue=getJobQueue(getSettings().jobs),unsubscribeTelemetry=onTelemetryChange(scheduleRender),unsubscribeQueue=queue.onSignal?.(scheduleRender)||queue.onChange(scheduleRender);
    const eventName=getMainBridgeStatusEventName();
    globalThis.window?.addEventListener?.(eventName,scheduleRender);
    let observer=null;
    const cleanup=()=>{
        if(cleaned)return;cleaned=true;
        unsubscribeTelemetry?.();unsubscribeQueue?.();globalThis.window?.removeEventListener?.(eventName,scheduleRender);observer?.disconnect?.();
        if(renderHandle!=null){if(renderKind==='raf'&&typeof cancelAnimationFrame==='function')cancelAnimationFrame(renderHandle);else clearTimeout(renderHandle);}
        renderHandle=null;renderKind='';boundStatusTargets.delete(target);
    };
    if(globalThis.MutationObserver&&globalThis.document?.documentElement){observer=new MutationObserver(()=>{if(!target.isConnected)cleanup();});observer.observe(globalThis.document.documentElement,{childList:true,subtree:true});}
    boundStatusTargets.set(target,cleanup);
    render();
    return cleanup;
}
