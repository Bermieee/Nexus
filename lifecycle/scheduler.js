import { getContext } from '../../../../st-context.js';
import { getSettings } from '../core/settings.js';
import { drainPostTurn } from '../postturn/pipeline.js';
import { runAutomaticPostTurnLifecycle, runAutomaticLoreRoutingLifecycle } from './intelligence.js';
import { preWarmSmartContext } from '../smart-context/warmer.js';
import { createNextSummary, inspectSummaryEligibility, promoteDueSummaries } from '../memory/summarizer.js';
import { routeUnroutedMemories, routeMemoryToLore } from '../memory/lore-router.js';
import { getMemoryRecord, memoryStats, setLastCycleId } from '../memory/store.js';
import { logEvent } from '../observability/telemetry.js';
import { runHousekeeper, isHousekeeperSuccessfulRun } from '../maintenance/housekeeper.js';
import { captureNexusWorkScope, isNexusWorkScopeFresh, currentNexusChatEpoch } from '../nexus/work-scope.js';
import { updateAssistantTurnCounter, countAssistantTurnsForCadence } from './cadence-counter.js';
import { refreshNotebookFromScene } from '../memory/notebook.js';
import { isIntentionalCancellation } from '../core/cancellation.js';

let seq=0;
let activeCycle=null;
let lastCycle=null;
let pendingAutomaticCycle=null;
let diagnosticEpoch=0;

const CADENCE_META_KEY='tv2_lifecycle_cadence';
const CADENCE_TASKS=['postTurn','notebook','summary','promotion','loreRouting','smartWarm','housekeeper'];

function cycleId(){seq+=1;return `tv2_cycle_${Date.now()}_${seq}`;}
function enabledTask(name){const s=getSettings().scheduler||{};return s.tasks?.[name]!==false;}
function notify(){try{globalThis.window?.dispatchEvent?.(new CustomEvent('tv2-scheduler-updated'));}catch{}}
function cadenceInterval(name){const n=Number(getSettings().scheduler?.intervals?.[name]);return Number.isFinite(n)&&n>0?Math.floor(n):0;}
function persistCadenceStore(ctx,store){if(!ctx?.chatMetadata||!store)return;store.updatedAt=Date.now();ctx.chatMetadata[CADENCE_META_KEY]=store;try{ctx.saveMetadataDebounced?.();}catch{}}
function cadenceStore(ctx=getContext()){
    const chat=ctx?.chat||[];
    const epoch=currentNexusChatEpoch();
    if(!ctx?.chatMetadata){
        const result=updateAssistantTurnCounter(null,chat,{epoch,reason:'no-chat-metadata'});
        return {version:2,lastRunCounts:Object.fromEntries(CADENCE_TASKS.map(name=>[name,Math.max(0,result.counter.assistantTurns-1)])),...result.counter,updatedAt:0,counterDirty:false};
    }
    let store=ctx.chatMetadata[CADENCE_META_KEY];
    const hadStore=!!store&&typeof store==='object'&&!Array.isArray(store);
    if(!hadStore)store={version:2,lastRunCounts:{},assistantTurns:null,messageCount:null,structureEpoch:null,counterRevision:0,counterDirty:false,updatedAt:0};
    if(!store.lastRunCounts||typeof store.lastRunCounts!=='object')store.lastRunCounts={};
    const priorCounter=Number(store.version)>=2?{
        assistantTurns:store.assistantTurns,
        messageCount:store.messageCount,
        structureEpoch:store.structureEpoch,
        counterRevision:store.counterRevision,
    }:null;
    const forceRebase=store.counterDirty===true||Number(store.version)<2;
    const reason=store.counterDirty?String(store.dirtyReason||'structural-change'):Number(store.version)<2?'cadence-v2-migration':null;
    const started=typeof performance!=='undefined'&&performance?.now?performance.now():Date.now();
    const result=updateAssistantTurnCounter(priorCounter,chat,{epoch,forceRebase,reason});
    Object.assign(store,result.counter,{version:2,counterDirty:false,dirtyReason:null});
    for(const name of CADENCE_TASKS){
        const raw=Number(store.lastRunCounts[name]);
        if(!Number.isFinite(raw))store.lastRunCounts[name]=hadStore?store.assistantTurns:Math.max(0,store.assistantTurns-1);
        else if(raw>store.assistantTurns)store.lastRunCounts[name]=store.assistantTurns;
    }
    if(!hadStore||result.rebased||result.inspectedMessages>0)persistCadenceStore(ctx,store);
    if(result.rebased){
        const ended=typeof performance!=='undefined'&&performance?.now?performance.now():Date.now();
        logEvent('scheduler','cadence-counter-rebased',{reason:result.reason,chatMessages:chat.length,assistantTurns:store.assistantTurns,inspectedMessages:result.inspectedMessages,counterRevision:store.counterRevision,durationMs:Math.max(0,Math.round(ended-started))},'debug');
    }else if(result.inspectedMessages>0){
        logEvent('scheduler','cadence-counter-advanced',{assistantTurns:store.assistantTurns,messageCount:store.messageCount,inspectedMessages:result.inspectedMessages,counterRevision:store.counterRevision},'debug');
    }
    return store;
}
function currentAssistantTurns(ctx=getContext()){return Math.max(0,Number(cadenceStore(ctx).assistantTurns)||0);}
function peekAssistantTurns(ctx=getContext()){
    const chat=ctx?.chat||[];
    const raw=ctx?.chatMetadata?.[CADENCE_META_KEY];
    const prior=raw&&typeof raw==='object'&&!Array.isArray(raw)&&Number(raw.version)>=2&&raw.counterDirty!==true?{
        assistantTurns:raw.assistantTurns,
        messageCount:raw.messageCount,
        structureEpoch:raw.structureEpoch,
        counterRevision:raw.counterRevision,
    }:null;
    if(!prior)return countAssistantTurnsForCadence(chat);
    return updateAssistantTurnCounter(prior,chat,{epoch:currentNexusChatEpoch()}).counter.assistantTurns;
}
function saveCadence(ctx=getContext(),store=null){const target=store||cadenceStore(ctx);persistCadenceStore(ctx,target);}
function cadenceDecision(name,{manual=false}={}){
    const interval=cadenceInterval(name);
    const store=cadenceStore(),current=Math.max(0,Number(store.assistantTurns)||0);
    if(manual)return {due:true,manual:true,interval,current,elapsed:0,remaining:0};
    if(interval===0)return {due:true,manual:false,interval:0,current,elapsed:0,remaining:0};
    const stored=Math.max(0,Number(store.lastRunCounts?.[name])||0),last=Math.min(current,stored),elapsed=Math.max(0,current-last);
    return {due:elapsed>=interval,manual:false,interval,current,last,elapsed,remaining:Math.max(0,interval-elapsed)};
}
function markCadenceRun(name,{manual=false,cycle=null,context=null}={}){
    if(manual)return false;
    const ctx=context||cycle?.context||getContext();
    if(cycle?.invalidated)return false;
    if(cycle?.scope&&!isNexusWorkScopeFresh(cycle.scope,getContext(),{checkRevision:true}))return false;
    const store=cadenceStore(ctx);store.lastRunCounts[name]=Math.max(0,Number(store.assistantTurns)||0);saveCadence(ctx,store);return true;
}
export function noteLifecycleCadenceAppend({context=null}={}){
    const ctx=context||getContext();
    const before=ctx?.chatMetadata?.[CADENCE_META_KEY]?.messageCount;
    const store=cadenceStore(ctx);
    return {assistantTurns:store.assistantTurns,messageCount:store.messageCount,appended:Math.max(0,Number(store.messageCount||0)-Math.max(0,Number(before)||0)),counterRevision:store.counterRevision};
}
export function markLifecycleCadenceStructureDirty(reason='structural-change',{context=null}={}){
    const ctx=context||getContext();
    if(!ctx?.chatMetadata)return false;
    const store=ctx.chatMetadata[CADENCE_META_KEY];
    if(!store||typeof store!=='object'||Array.isArray(store))return false;
    store.counterDirty=true;store.dirtyReason=String(reason||'structural-change');store.updatedAt=Date.now();
    try{ctx.saveMetadataDebounced?.();}catch{}
    logEvent('scheduler','cadence-counter-invalidated',{reason:store.dirtyReason,messageCount:Number(store.messageCount)||0,assistantTurns:Number(store.assistantTurns)||0},'debug');
    return true;
}

function cadenceSkip(decision){return {reason:'cadence-not-due',interval:decision.interval,elapsed:decision.elapsed,remaining:decision.remaining};}

/** Read scheduler cadence without initializing or persisting chat metadata. */
export function inspectLifecycleTaskCadence(name,{manual=false}={}){
    const task=String(name||'');
    if(!CADENCE_TASKS.includes(task))return {due:false,reason:'unknown-task',interval:0,current:peekAssistantTurns(),elapsed:0,remaining:0};
    const interval=cadenceInterval(task),current=peekAssistantTurns();
    if(manual)return {due:true,manual:true,interval,current,elapsed:0,remaining:0};
    if(interval===0)return {due:true,manual:false,interval:0,current,elapsed:0,remaining:0};
    const raw=getContext()?.chatMetadata?.[CADENCE_META_KEY];
    const hasStore=!!raw&&typeof raw==='object'&&!Array.isArray(raw);
    const stored=hasStore?Number(raw?.lastRunCounts?.[task]):NaN;
    const last=Number.isFinite(stored)?Math.min(current,Math.max(0,stored)):(hasStore?current:Math.max(0,current-1));
    const elapsed=Math.max(0,current-last);
    return {due:elapsed>=interval,manual:false,interval,current,last,elapsed,remaining:Math.max(0,interval-elapsed)};
}

/** Executor-side cadence mutation. The Work Director never calls this. */
export function markLifecycleTaskCadenceRun(name,{manual=false,scope=null,context=null}={}){
    const task=String(name||'');
    if(!CADENCE_TASKS.includes(task))return false;
    return markCadenceRun(task,{manual,context,cycle:scope?{scope,context,invalidated:false}:null});
}

function recordStep(cycle,name,status,data={}){
    const at=Date.now();
    // cycle.steps is the CURRENT lifecycle state ledger, not the event history.
    // Telemetry already preserves every transition separately. Reconcile a
    // terminal result into the task's running row so a completed cycle can
    // never report the same task as both `running` and `complete/skipped`.
    let row=null;
    if(status!=='running'){
        for(let i=cycle.steps.length-1;i>=0;i-=1){
            const candidate=cycle.steps[i];
            if(candidate?.name===name&&candidate?.status==='running'){row=candidate;break;}
        }
    }
    if(row){
        const startedAt=Number(row.startedAt||row.at)||at;
        Object.assign(row,{...data,name,status,at,startedAt,endedAt:at,durationMs:Math.max(0,at-startedAt)});
    }else{
        row={name,status,at,...data};
        if(status==='running')row.startedAt=at;
        cycle.steps.push(row);
    }
    notify();
    const level=status==='failed'?'error':status==='skipped'?'debug':status==='deferred'?'info':'info';
    logEvent('scheduler-cycle',`step-${status}`,{cycleId:cycle.id,source:cycle.source,task:name,...data},level);
}
function beginCycle({source,manual=false}={}){
    if(activeCycle)return null;
    const context=getContext();
    const cycle={id:cycleId(),source:String(source||'manual'),manual:manual===true,startedAt:Date.now(),endedAt:0,status:'running',steps:[],context,scope:captureNexusWorkScope(context),invalidated:false,diagnosticEpoch};
    activeCycle=cycle;setLastCycleId(cycle.id);notify();
    logEvent('scheduler-cycle','cycle-start',{cycleId:cycle.id,source:cycle.source,manual:cycle.manual,memory:memoryStats()},'info');
    return cycle;
}
function queueAutomaticCatchup(options){
    const scope=captureNexusWorkScope(getContext());
    return new Promise(resolve=>{
        if(!pendingAutomaticCycle)pendingAutomaticCycle={options:{...options},scope,waiters:[resolve]};
        else{
            // Newest trigger owns source/scope; inclusion flags are unioned so
            // coalescing cannot silently drop an un-migrated workload.
            const prior=pendingAutomaticCycle.options||{};
            pendingAutomaticCycle.options={...prior,...options,
                includeSmartWarm:prior.includeSmartWarm!==false||options.includeSmartWarm!==false,
                includePostTurn:prior.includePostTurn!==false||options.includePostTurn!==false,
                includeNotebook:prior.includeNotebook!==false||options.includeNotebook!==false,
                includeSummary:prior.includeSummary!==false||options.includeSummary!==false,
                includePromotion:prior.includePromotion!==false||options.includePromotion!==false,
                includeLoreRouting:prior.includeLoreRouting!==false||options.includeLoreRouting!==false,
                includeHousekeeper:prior.includeHousekeeper!==false||options.includeHousekeeper!==false};
            pendingAutomaticCycle.scope=scope;pendingAutomaticCycle.waiters.push(resolve);
        }
        logEvent('scheduler-cycle','automatic-catchup-queued',{source:options.source||'automatic',activeCycleId:activeCycle?.id||null},'info');
    });
}
function dispatchAutomaticCatchup(){
    if(activeCycle||!pendingAutomaticCycle)return;
    const pending=pendingAutomaticCycle;pendingAutomaticCycle=null;
    if(!isNexusWorkScopeFresh(pending.scope,getContext(),{checkRevision:true})){
        const stale={deferred:true,stale:true,reason:'scope-invalidated'};for(const resolve of pending.waiters)resolve(stale);return;
    }
    queueMicrotask(()=>{void runLifecycleCycle({...pending.options,manual:false}).then(result=>{for(const resolve of pending.waiters)resolve(result);},error=>{for(const resolve of pending.waiters)resolve({failed:true,error});});});
}

function finishCycle(cycle,status=null,error=null){
    cycle.endedAt=Date.now();cycle.durationMs=cycle.endedAt-cycle.startedAt;
    if(cycle.invalidated)status='stale';
    // Closing with a `running` task is a lifecycle invariant violation. This can
    // happen when an executor rejects before its normal terminal bookkeeping and
    // Promise.allSettled absorbs the rejection. Never publish a false complete
    // cycle: terminalize the orphan and surface the cycle as partial/failed.
    if(!cycle.invalidated){
        for(const step of cycle.steps){
            if(step.status!=='running')continue;
            step.status='failed';
            step.reason='missing-terminal-state';
            step.error='Lifecycle task ended without a terminal state.';
            step.endedAt=cycle.endedAt;
            step.durationMs=Math.max(0,cycle.endedAt-Number(step.startedAt||step.at||cycle.startedAt));
            logEvent('scheduler-cycle','step-terminal-invariant-repair',{cycleId:cycle.id,source:cycle.source,task:step.name,reason:step.reason},'error');
        }
    }
    cycle.status=status||((cycle.steps.some(s=>s.status==='failed'))?'partial':'complete');
    if(status==='complete'&&cycle.steps.some(s=>s.status==='failed'))cycle.status='partial';
    if(error)cycle.error=error?.message||String(error);
    if(cycle.diagnosticEpoch===diagnosticEpoch&&(!cycle.invalidated||!lastCycle||Number(cycle.startedAt)>=Number(lastCycle.startedAt||0)))lastCycle=JSON.parse(JSON.stringify({...cycle,context:undefined}));
    if(activeCycle?.id===cycle.id)activeCycle=null;
    notify();
    dispatchAutomaticCatchup();
    logEvent('scheduler-cycle','cycle-complete',{cycleId:cycle.id,source:cycle.source,status:cycle.status,durationMs:cycle.durationMs,steps:cycle.steps.map(s=>({name:s.name,status:s.status,slot:s.slot||null,reason:s.reason||null}))},cycle.status==='failed'?'error':cycle.status==='partial'?'warn':'info');
    return cycleView(cycle);
}

function resultSlot(result){return result?.slot||result?.sidecarSlot||result?.tv2?.slot||result?.results?.find?.(r=>r?.slot)?.slot||null;}
function cycleFresh(cycle){return !!cycle&&!cycle.invalidated&&isNexusWorkScopeFresh(cycle.scope,getContext(),{checkRevision:true});}
function staleCycleResult(cycle){
    if(cycle){cycle.invalidated=true;cycle.invalidatedAt=Date.now();cycle.invalidatedReason='scope-invalidated';for(const step of cycle.steps){if(step.status==='running'){step.status='deferred';step.reason='scope-invalidated';}}if(activeCycle?.id===cycle.id)activeCycle=null;}
    notify();
    return {deferred:true,stale:true,reason:'scope-invalidated',cycleId:cycle?.id||null};
}

function cycleView(cycle){if(!cycle)return null;const {context,...rest}=cycle;return JSON.parse(JSON.stringify(rest));}
export function getSchedulerState(){return {active:cycleView(activeCycle),last:cycleView(lastCycle)};}
export function getSchedulerStatusSummary(){return {active:activeCycle!=null,lastStatus:String(lastCycle?.status||'')};}
export function clearLifecycleSchedulerDiagnostics(){lastCycle=null;diagnosticEpoch+=1;notify();return true;}
export function invalidateLifecycleScheduler(reason='Lifecycle scope invalidated.'){
    if(!activeCycle)return false;
    const cycle=activeCycle;
    cycle.invalidated=true;
    cycle.invalidatedAt=Date.now();
    cycle.invalidatedReason=String(reason||'Lifecycle scope invalidated.');
    // Invalidation revokes admission authority immediately. Old async work may
    // drain physically, but its captured scope fences every settlement and it
    // cannot block a new-chat/new-revision cycle from becoming the owner.
    if(activeCycle?.id===cycle.id)activeCycle=null;
    if(pendingAutomaticCycle){const stale={deferred:true,stale:true,reason:'scope-invalidated'};for(const resolve of pendingAutomaticCycle.waiters||[])resolve(stale);pendingAutomaticCycle=null;}
    notify();
    logEvent('scheduler-cycle','cycle-invalidated',{cycleId:cycle.id,source:cycle.source,reason:cycle.invalidatedReason},'warn');
    return true;
}


async function runSummaryBranch(cycle,{manual=false,summaryRange=null,backlog=false,includeSummary=true,includePromotion=true,includeLoreRouting=true}={}){
    const out={summary:null,promotion:null,routing:null};
    const settings=getSettings();
    const summaryCadence=cadenceDecision('summary',{manual});
    const promotionCadence=cadenceDecision('promotion',{manual});
    const routingCadence=cadenceDecision('loreRouting',{manual});
    if(settings.memoryBank?.enabled===false){
        recordStep(cycle,'summary-check','skipped',{reason:'memory-bank-disabled'});
        recordStep(cycle,'summary','skipped',{reason:'memory-bank-disabled'});
        recordStep(cycle,'promotion','skipped',{reason:'memory-bank-disabled'});
        recordStep(cycle,'lore-routing','skipped',{reason:'memory-bank-disabled'});
        // Disabled work did not execute, so its due state must remain due for
        // re-enable rather than being consumed as a successful cadence.
        return out;
    }

    let eligibility={due:false,reason:'summary-task-disabled'};
    if(!includeSummary){
        eligibility={due:false,reason:'not-requested'};
        recordStep(cycle,'summary-check','skipped',{reason:'not-requested'});
        recordStep(cycle,'summary','skipped',{reason:'not-requested'});
    }else if(enabledTask('summary')&&summaryCadence.due){
        eligibility=inspectSummaryEligibility();
        recordStep(cycle,'summary-check',eligibility.due?'complete':'skipped',{...eligibility,manualForceAvailable:manual===true,cadence:summaryCadence});
    }else if(!enabledTask('summary')){
        recordStep(cycle,'summary-check','skipped',{reason:'disabled-task'});
        recordStep(cycle,'summary','skipped',{reason:'disabled-task'});
    }else{
        recordStep(cycle,'summary-check','skipped',cadenceSkip(summaryCadence));
        recordStep(cycle,'summary','skipped',cadenceSkip(summaryCadence));
    }

    const shouldAttemptSummary=includeSummary&&enabledTask('summary')&&summaryCadence.due&&(manual||eligibility.due||summaryRange);
    let summaryFailed=false;
    let summaryCompleted=false;
    if(shouldAttemptSummary){
        if(backlog&&manual){
            const created=[];let guard=0;let last=null;
            while(guard++<200){if(!cycleFresh(cycle))break;const r=await createNextSummary({cycleId:cycle.id,manual:true});if(!cycleFresh(cycle))break;last=r;if(r.created)created.push(r.record);else break;}
            out.summary={createdRecords:created,backlog:true,last};
            if(created.length){summaryCompleted=true;recordStep(cycle,'summary','complete',{createdCount:created.length,backlog:true,slot:last?.slot||null});}
            else recordStep(cycle,'summary','skipped',{reason:last?.reason||'nothing-unsummarized',backlog:true});
        }else{
            const r=await createNextSummary({cycleId:cycle.id,manual,range:summaryRange});if(!cycleFresh(cycle))return out;out.summary=r;
            if(r.failed){summaryFailed=true;recordStep(cycle,'summary','failed',{error:r.error,slot:r.slot||null});}
            else if(r.created){summaryCompleted=true;recordStep(cycle,'summary','complete',{memoryId:r.record.id,layer:0,turnRange:r.record.turnRange,slot:r.slot||null});}
            else recordStep(cycle,'summary','skipped',{reason:r.reason||'not-due'});
        }
    }else if(includeSummary&&enabledTask('summary')&&summaryCadence.due)recordStep(cycle,'summary','skipped',{reason:eligibility.reason||'not-due'});
    if(includeSummary&&enabledTask('summary')&&summaryCadence.due&&!summaryFailed&&summaryCompleted)markCadenceRun('summary',{manual,cycle});

    if(!includePromotion)recordStep(cycle,'promotion','skipped',{reason:'handled-by-director'});
    else if(enabledTask('promotion')&&promotionCadence.due){
        if(!cycleFresh(cycle))return out;const p=await promoteDueSummaries({cycleId:cycle.id,manual});if(!cycleFresh(cycle))return out;out.promotion=p;
        if(p.failed)recordStep(cycle,'promotion','failed',{promotions:p.promotions||0});
        else if(p.promotions)recordStep(cycle,'promotion','complete',{promotions:p.promotions||0,slot:resultSlot(p)});
        else recordStep(cycle,'promotion','skipped',{promotions:0,reason:'no-promotion-due'});
        if(!p.failed&&p.promotions)markCadenceRun('promotion',{manual,cycle});
    }else if(!enabledTask('promotion'))recordStep(cycle,'promotion','skipped',{reason:'disabled-task'});
    else recordStep(cycle,'promotion','skipped',cadenceSkip(promotionCadence));

    if(!includeLoreRouting)recordStep(cycle,'lore-routing','skipped',{reason:'handled-by-director'});
    else if(enabledTask('loreRouting')&&routingCadence.due&&getSettings().memoryBank?.loreRouting?.enabled!==false){
        const ids=[];
        if(out.summary?.record?.id){const latest=getMemoryRecord(out.summary.record.id);if(latest&&!latest.promotedTo)ids.push(latest.id);}
        for(const r of out.summary?.createdRecords||[]){const latest=getMemoryRecord(r?.id);if(latest&&!latest.promotedTo)ids.push(latest.id);}
        for(const r of out.promotion?.results||[])if(r?.parent?.id)ids.push(r.parent.id);
        const unique=[...new Set(ids)];
        if(!cycleFresh(cycle))return out;
        const route=manual
            ? (unique.length
                ? await routeUnroutedMemories({cycleId:cycle.id,manual:true,ids:unique})
                : await routeUnroutedMemories({cycleId:cycle.id,manual:true,maxPerCycle:getSettings().memoryBank?.loreRouting?.maxPerCycle||1}))
            : await runAutomaticLoreRoutingLifecycle({
                cycleId:cycle.id,
                ids:unique.length?unique:null,
                maxPerCycle:unique.length?null:(getSettings().memoryBank?.loreRouting?.maxPerCycle||1),
                context:cycle.context,
            });
        if(!cycleFresh(cycle))return out;
        out.routing=route;
        const failed=route.results?.some(r=>r.failed);
        const slot=route.results?.find(r=>r?.slot)?.slot||null;
        const intelligenceRow=(route.results||[]).findLast?.(r=>r?.classification||r?.reason)||[...(route.results||[])].reverse().find(r=>r?.classification||r?.reason)||null;
        const intelligenceMeta=intelligenceRow?{classification:intelligenceRow.classification||null,reason:intelligenceRow.reason||null,uncertain:intelligenceRow.uncertain===true,serialized:intelligenceRow.serialized===true}:{};
        if(failed)recordStep(cycle,'lore-routing','failed',{memoryCount:route.count||0,proposalCount:(route.results||[]).reduce((n,r)=>n+(r.proposalIds?.length||0),0),slot,...intelligenceMeta});
        else if(route.count)recordStep(cycle,'lore-routing','complete',{memoryCount:route.count||0,proposalCount:(route.results||[]).reduce((n,r)=>n+(r.proposalIds?.length||0),0),slot,...intelligenceMeta});
        else recordStep(cycle,'lore-routing','skipped',{reason:'no-unrouted-memories',memoryCount:0});
        if(!failed&&route.count)markCadenceRun('loreRouting',{manual,cycle});
    }else if(!enabledTask('loreRouting')||getSettings().memoryBank?.loreRouting?.enabled===false)recordStep(cycle,'lore-routing','skipped',{reason:'disabled-task'});
    else recordStep(cycle,'lore-routing','skipped',cadenceSkip(routingCadence));
    return out;
}

export async function runLifecycleCycle({source='manual',manual=false,summaryRange=null,backlog=false,includeSmartWarm=true,includePostTurn=true,includeNotebook=false,includeSummary=true,includePromotion=true,includeLoreRouting=true,includeHousekeeper=true}={}){
    const settings=getSettings();
    if(!settings.enabled||settings.scheduler?.enabled===false){logEvent('scheduler-cycle','cycle-skipped',{source,reason:'disabled'},'debug');return {skipped:true,reason:'disabled'};}
    if(activeCycle){
        if(!manual)return queueAutomaticCatchup({source,manual:false,summaryRange,backlog,includeSmartWarm,includePostTurn,includeNotebook,includeSummary,includePromotion,includeLoreRouting,includeHousekeeper});
        logEvent('scheduler-cycle','cycle-skipped',{source,reason:'already-running',activeCycleId:activeCycle.id},'warn');return {skipped:true,reason:'already-running',activeCycleId:activeCycle.id};
    }
    const cycle=beginCycle({source,manual});
    try{
        if(!cycleFresh(cycle))return finishCycle(cycle,'stale');
        const parallel=[];
        const postTurnCadence=cadenceDecision('postTurn',{manual});
        if(includePostTurn&&enabledTask('postTurn')&&postTurnCadence.due)parallel.push((async()=>{
            recordStep(cycle,'post-turn','running',{manualForce:manual===true,cadence:postTurnCadence,authority:manual===true?'manual-direct':'lifecycle-intelligence'});
            const r=manual===true
                ? await drainPostTurn({force:true})
                : await runAutomaticPostTurnLifecycle({context:cycle.context,cycleId:cycle.id});
            if(!cycleFresh(cycle))return staleCycleResult(cycle);
            if(r?.deferred)recordStep(cycle,'post-turn','deferred',{reason:r.reason||'foreground-preempted',classification:r.classification||null,sourceRange:r.sourceRange||null,transactionId:r.transactionId||null});
            else if(r?.failed)recordStep(cycle,'post-turn','failed',{error:r.error||r.stage,classification:r.classification||null,slot:r.slot||null,transactionId:r.transactionId||null});
            else if(r?.skipped)recordStep(cycle,'post-turn','skipped',{reason:r.reason||'nothing-pending',classification:r.classification||null,sourceRange:r.sourceRange||null,consumed:r.consumed===true});
            else recordStep(cycle,'post-turn','complete',{classification:r.classification||null,stagedCount:r?.staged?.length||0,operationCount:r?.operations||0,slot:r?.slot||null,sourceRange:r?.sourceRange||null,transactionId:r?.transactionId||null});
            if(!r?.failed&&!r?.deferred&&!(Number(r?.remainingPendingCount)||0))markCadenceRun('postTurn',{manual,cycle});
            return r;
        })()); else if(!includePostTurn)recordStep(cycle,'post-turn','skipped',{reason:'not-requested'}); else if(!enabledTask('postTurn'))recordStep(cycle,'post-turn','skipped',{reason:'disabled-task'}); else recordStep(cycle,'post-turn','skipped',cadenceSkip(postTurnCadence));

        const notebookCadence=cadenceDecision('notebook',{manual});
        if(includeNotebook&&enabledTask('notebook')&&notebookCadence.due)parallel.push((async()=>{
            recordStep(cycle,'notebook','running',{manualForce:manual===true,cadence:notebookCadence});
            try{
                const r=await refreshNotebookFromScene({manual});
                if(!cycleFresh(cycle))return staleCycleResult(cycle);
                if(r?.deferred||r?.stale||r?.cancelled){
                    const reason=r?.reason||'scope-invalidated';
                    logEvent('notebook','automatic-refresh-stale',{source:cycle.source,cycleId:cycle.id,reason,stale:r?.stale===true,cancelled:r?.cancelled===true,slot:r?.slot||null},'debug');
                    recordStep(cycle,'notebook','deferred',{reason,slot:r?.slot||null});
                }
                else if(r?.failed)recordStep(cycle,'notebook','failed',{error:r?.error?.message||r?.error||'Notebook refresh failed',slot:r?.slot||null});
                else if(r?.skipped)recordStep(cycle,'notebook','skipped',{reason:r?.reason||'not-due'});
                else recordStep(cycle,'notebook','complete',{updated:r?.updated===true,slot:r?.slot||null,transactionId:r?.transactionId||null,reshapeUsed:r?.reshapeUsed===true});
                if(!r?.failed&&!r?.deferred&&!r?.stale&&!r?.cancelled&&!r?.skipped)markCadenceRun('notebook',{manual,cycle});
                return r;
            }catch(error){
                if(isIntentionalCancellation(error)){
                    const reason=error?.name||'foreground-preempted';
                    logEvent('notebook','automatic-refresh-stale',{source:cycle.source,cycleId:cycle.id,reason,errorName:error?.name||null,message:error?.message||String(error)},'debug');
                    recordStep(cycle,'notebook','deferred',{reason});
                    return {deferred:true,stale:error?.name==='TV2ScopeInvalidated',cancelled:true,reason};
                }
                recordStep(cycle,'notebook','failed',{error:error?.message||String(error)});return {failed:true,error};
            }
        })()); else if(!includeNotebook)recordStep(cycle,'notebook','skipped',{reason:'not-requested'}); else if(!enabledTask('notebook'))recordStep(cycle,'notebook','skipped',{reason:'disabled-task'}); else recordStep(cycle,'notebook','skipped',cadenceSkip(notebookCadence));

        const warmCadence=cadenceDecision('smartWarm',{manual});
        if(includeSmartWarm&&enabledTask('smartWarm')&&warmCadence.due)parallel.push((async()=>{
            recordStep(cycle,'smart-warm','running',{manualForce:manual===true,cadence:warmCadence});
            try{
                const r=await preWarmSmartContext({source:`lifecycle:${cycle.id}`,force:manual===true});
                if(!cycleFresh(cycle))return staleCycleResult(cycle);
                if(r?.deferred)recordStep(cycle,'smart-warm','deferred',{reason:r.reason||'foreground-preempted'});
                else if(r?.failed)recordStep(cycle,'smart-warm','failed',{error:r.error?.message||r.error||'Smart Warm failed'});
                else if(r?.skipped)recordStep(cycle,'smart-warm','skipped',{reason:r.reason||'not-run'});
                else recordStep(cycle,'smart-warm','complete',{count:r?.refs?.length||r?.count||0,slot:r?.slot||null,cached:r?.cached===true});
                if(!r?.skipped&&!r?.deferred&&!r?.failed)markCadenceRun('smartWarm',{manual,cycle});
                return r;
            }catch(error){if(['TV2ForegroundAbort','TV2GenerationStopped','TV2ScopeInvalidated','TV2BatchCancelled','AbortError'].includes(String(error?.name||''))){recordStep(cycle,'smart-warm','deferred',{reason:'foreground-preempted'});return {deferred:true,reason:'foreground-preempted'};}recordStep(cycle,'smart-warm','failed',{error:error?.message||String(error)});return {failed:true,error};}
        })()); else if(!includeSmartWarm)recordStep(cycle,'smart-warm','skipped',{reason:'not-requested'}); else if(!enabledTask('smartWarm'))recordStep(cycle,'smart-warm','skipped',{reason:'disabled-task'}); else recordStep(cycle,'smart-warm','skipped',cadenceSkip(warmCadence));

        const housekeeperCadence=cadenceDecision('housekeeper',{manual});
        if(includeHousekeeper&&enabledTask('housekeeper')&&housekeeperCadence.due)parallel.push((async()=>{
            recordStep(cycle,'housekeeper','running',{manualForce:manual===true,cadence:housekeeperCadence});
            const r=await runHousekeeper({force:manual===true,cadenceDue:manual!==true});
            if(!cycleFresh(cycle))return staleCycleResult(cycle);
            if(r?.deferred)recordStep(cycle,'housekeeper','deferred',{reason:r.reason||'foreground-preempted'});
            else if(r?.skipped)recordStep(cycle,'housekeeper','skipped',{reason:r.reason||'lifecycle-cadence-required'});
            else if(!isHousekeeperSuccessfulRun(r))recordStep(cycle,'housekeeper','failed',{error:r.adviceError||r.reason||r.status||'housekeeper-incomplete',findings:r.findingCount||0,status:r.status||null});
            else recordStep(cycle,'housekeeper','complete',{findings:r.findingCount||0,adviceCount:r.advice?.length||0,slot:r.sidecarSlot||null});
            if(isHousekeeperSuccessfulRun(r))markCadenceRun('housekeeper',{manual,cycle});
            return r;
        })()); else if(!includeHousekeeper)recordStep(cycle,'housekeeper','skipped',{reason:'not-requested'}); else if(!enabledTask('housekeeper'))recordStep(cycle,'housekeeper','skipped',{reason:'disabled-task'}); else recordStep(cycle,'housekeeper','skipped',cadenceSkip(housekeeperCadence));

        const summaryPromise=runSummaryBranch(cycle,{manual,summaryRange,backlog,includeSummary,includePromotion,includeLoreRouting});
        const [parallelResults,summaryResults]=await Promise.all([Promise.allSettled(parallel),summaryPromise]);
        cycle.result={parallelResults:parallelResults.map(r=>r.status==='fulfilled'?r.value:{failed:true,error:r.reason?.message||String(r.reason)}),summary:summaryResults};
        if(!cycleFresh(cycle))return finishCycle(cycle,'stale');
        const terminalStatus=cycle.steps.some(s=>s.status==='failed')?'partial':cycle.steps.some(s=>s.status==='deferred')?'deferred':'complete';
        return finishCycle(cycle,terminalStatus);
    }catch(error){
        logEvent('scheduler-cycle','cycle-failed',{cycleId:cycle.id,source:cycle.source,error},'error');
        return finishCycle(cycle,'failed',error);
    }
}

async function runSingleManualTask(cycle,name,options={}){
    recordStep(cycle,name,'running',{manualForce:true});
    let result;
    switch(name){
        case'post-turn':result=await drainPostTurn({force:true});break;
        case'post-turn-flush':result=await discardPostTurnBacklog({context:cycle.context,reason:'operator-flush',rejectPending:true});break;
        case'summary-check':result=inspectSummaryEligibility();break;
        case'summary-create':result=await createNextSummary({cycleId:cycle.id,manual:true,range:options.range||null,assistantRange:options.assistantRange||null,turnCount:options.turnCount??null});break;
        case'summary-backlog':{
            const records=[];let guard=0,last=null;
            while(guard++<200){if(!cycleFresh(cycle))break;const r=await createNextSummary({cycleId:cycle.id,manual:true});if(!cycleFresh(cycle))break;last=r;if(r.created)records.push(r.record);else break;}
            result={records,last,createdCount:records.length};break;
        }
        case'summary-promote':result=await promoteDueSummaries({cycleId:cycle.id,manual:true,fromLayer:options.fromLayer??null});break;
        case'lore-route':result=options.memoryId?await routeMemoryToLore(options.memoryId,{cycleId:cycle.id,manual:true,deleteAfterDigest:options.deleteAfterDigest!==false}):await routeUnroutedMemories({cycleId:cycle.id,manual:true,ids:options.ids||null});break;
        case'smart-warm':result=await preWarmSmartContext({source:`manual:${cycle.id}`,force:true});break;
        case'housekeeper':result=await runHousekeeper({force:true});break;
        default:throw new Error(`Unknown lifecycle task: ${name}`);
    }
    if(result?.deferred){recordStep(cycle,name,'deferred',{reason:result.reason||'foreground-preempted'});return result;}
    if(result?.failed){recordStep(cycle,name,'failed',{error:result.error||'task failed',slot:resultSlot(result)});return result;}
    if(name==='summary-check'){
        recordStep(cycle,name,result?.due?'complete':'skipped',{...result});return result;
    }
    const noWork=(result?.skipped===true)||(name==='summary-backlog'&&!(result?.createdCount>0))||(name==='summary-promote'&&!(result?.promotions>0))||(name==='lore-route'&&!(result?.count>0));
    if(noWork)recordStep(cycle,name,'skipped',{reason:result?.reason||result?.last?.reason||(name==='lore-route'?'no-unrouted-memories':'nothing-to-process')});
    else recordStep(cycle,name,'complete',{slot:resultSlot(result),count:result?.count??result?.createdCount??null,jobId:result?.jobId||null});
    return result;
}

export async function runLifecycleTask(task,options={}){
    const name=String(task||'');
    if(name==='full-cycle'){
        logEvent('scheduler-cycle','manual-task-start',{task:name,options},'info');
        try{return await runLifecycleCycle({source:'manual-full-cycle',manual:true,backlog:options.backlog===true});}
        finally{logEvent('scheduler-cycle','manual-task-end',{task:name},'info');}
    }
    if(activeCycle)return {skipped:true,reason:'already-running',activeCycleId:activeCycle.id};
    const settings=getSettings();
    if(!settings.enabled||settings.scheduler?.enabled===false)return {skipped:true,reason:'scheduler-disabled'};
    const cycle=beginCycle({source:`manual-${name}`,manual:true});
    logEvent('scheduler-cycle','manual-task-start',{cycleId:cycle.id,task:name,options},'info');
    try{
        const result=await runSingleManualTask(cycle,name,options);
        cycle.result=result;
        if(!cycleFresh(cycle)){const done=finishCycle(cycle,'stale');return {...result,stale:true,cycleId:done.id,cycleStatus:done.status};}
        if(name==='housekeeper'&&isHousekeeperSuccessfulRun(result))markCadenceRun('housekeeper',{manual:true,cycle});
        const done=finishCycle(cycle,cycle.steps.some(s=>s.status==='failed')?'failed':cycle.steps.some(s=>s.status==='deferred')?'deferred':'complete');
        return {...result,cycleId:done.id,cycleStatus:done.status};
    }catch(error){
        if(!cycle.steps.some(s=>s.name===name&&s.status==='failed'))recordStep(cycle,name,'failed',{error:error?.message||String(error)});
        finishCycle(cycle,'failed',error);
        throw error;
    }finally{logEvent('scheduler-cycle','manual-task-end',{cycleId:cycle.id,task:name},'info');}
}
