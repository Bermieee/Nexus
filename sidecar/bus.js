import { sidecarRouter, setSidecarAuthorityNotifier } from './router.js';
import { logEvent } from '../observability/telemetry.js';
import { isIntentionalCancellation } from '../core/cancellation.js';
import { getContext } from '../../../../st-context.js';
import { captureNexusWorkScope, nexusScopeDedupKey, isNexusWorkScopeFresh } from '../nexus/work-scope.js';
import { getSettings } from '../core/settings.js';
import { getJobQueue } from '../core/job-queue.js';

/** Nexus public Sidecar dispatch spine. */
export const BUS_PRIORITY = Object.freeze({
    LORE_INJECTION: 110, SCENE_SCAN: 105, RETRIEVAL: 100, MEMORY_RECALL: 98,
    SMART_WARM: 80, POST_TURN: 70, NOTEBOOK: 65, SUMMARY: 55, SUMMARY_PROMOTION: 52, SUMMARY_LORE_ROUTE: 50,
    MAINTENANCE: 25,
});
export const BUS_STAGE = Object.freeze({
    SCENE_SCAN:'scene-scan', RETRIEVAL:'retrieval', REGION_SCAN:'tree-region-scan', REGION_CONDENSE:'tree-region-condense',
    NODE_SCAN:'tree-node-scan', NODE_CONDENSE:'tree-node-condense', LORE_INJECTION:'lore-injection',
    SMART_WARM:'smart-context-warm', POST_TURN:'postturn-memory', SUMMARY:'summary', MEMORY_RECALL:'memory-recall',
    SUMMARY_PROMOTION:'summary-promotion', SUMMARY_LORE_ROUTE:'summary-lore-route', MAINTENANCE:'maintenance',
    TREE_BUILD:'tree-build', SEARCH_REASONING:'search-reasoning', DIAGNOSTICS:'diagnostics',
});
const ROLE_BY_STAGE = Object.freeze({
    [BUS_STAGE.SCENE_SCAN]:'retrieval',[BUS_STAGE.RETRIEVAL]:'retrieval',[BUS_STAGE.REGION_SCAN]:'retrieval',[BUS_STAGE.REGION_CONDENSE]:'retrieval',
    [BUS_STAGE.NODE_SCAN]:'retrieval',[BUS_STAGE.NODE_CONDENSE]:'retrieval',[BUS_STAGE.LORE_INJECTION]:'loreInjection',
    [BUS_STAGE.SMART_WARM]:'retrieval',[BUS_STAGE.SEARCH_REASONING]:'retrieval',[BUS_STAGE.POST_TURN]:'postTurn',
    [BUS_STAGE.SUMMARY]:'summaries',[BUS_STAGE.MEMORY_RECALL]:'summaries',[BUS_STAGE.SUMMARY_PROMOTION]:'summaries',
    [BUS_STAGE.SUMMARY_LORE_ROUTE]:'summaries',[BUS_STAGE.MAINTENANCE]:'maintenance',[BUS_STAGE.TREE_BUILD]:'treeBuild',
});
const KNOWN_ROLES = ['retrieval','loreInjection','postTurn','summaries','maintenance','treeBuild'];
function roleFor(stage, explicitRole){const explicit=String(explicitRole||'').trim();if(explicit)return KNOWN_ROLES.includes(explicit)?explicit:null;return ROLE_BY_STAGE[stage]||null;}
function fastSignature(value=''){let h=2166136261;for(let i=0;i<value.length;i++){h^=value.charCodeAt(i);h=Math.imul(h,16777619);}return (h>>>0).toString(16).padStart(8,'0');}
function stableValue(value){if(Array.isArray(value))return value.map(stableValue);if(value&&typeof value==='object'){return Object.fromEntries(Object.keys(value).sort().map(key=>[key,stableValue(value[key])]));}return value;}
function stableSignature(value){return fastSignature(JSON.stringify(stableValue(value)));}

let activeBusSeq=0;
const activeBusWork = new Map();
let auditGeneration=1;
// Compatibility/audit counter only. Scoped slot/role generations own settlement authority.
let executionProfileGeneration = 1;
const slotGeneration={A:1,B:1};
const roleGeneration=new Map(KNOWN_ROLES.map(role=>[role,1]));
let slotSignatures={A:'',B:''};
let roleSignatures=Object.fromEntries(KNOWN_ROLES.map(role=>[role,'']));

function profileProjection(slot){
    const p=getSettings().sidecars?.[slot]||{};
    return {
        enabled:p.enabled!==false,endpoint:String(p.endpoint||''),apiKey:String(p.apiKey||''),model:String(p.model||''),format:String(p.format||''),
        providerMaxTokens:p.providerMaxTokens??null,maxOutputTokens:p.maxOutputTokens??null,maxCompletionTokens:p.maxCompletionTokens??null,max_output_tokens:p.max_output_tokens??null,
        providerContextTokens:p.providerContextTokens??null,contextWindowTokens:p.contextWindowTokens??null,contextLengthTokens:p.contextLengthTokens??null,context_length:p.context_length??null,
        emergencyContextTokens:p.emergencyContextTokens??null,emergencyOutputTokens:p.emergencyOutputTokens??null,capabilities:p.capabilities||{},
        temperature:p.temperature??null,reasoningEffort:p.reasoningEffort??null,timeoutMs:p.timeoutMs??null,
        inputBudgetTokens:p.inputBudgetTokens??null,outputCeilingTokens:p.outputCeilingTokens??null,totalBudgetTokens:p.totalBudgetTokens??null,
    };
}
function routeProjection(role){
    const routing=getSettings().routing||{};
    return {preferred:routing?.[role]??null,mode:routing?.modes?.[role]??null,lock:routing?.locks?.[role]??null,fallback:routing.fallback!==false,loadBalance:routing.loadBalance!==false};
}
function signaturesNow(){
    return {
        slots:{A:stableSignature(profileProjection('A')),B:stableSignature(profileProjection('B'))},
        roles:Object.fromEntries(KNOWN_ROLES.map(role=>[role,stableSignature(routeProjection(role))])),
    };
}
export function currentSidecarExecutionProfileGeneration(){return executionProfileGeneration;}

function slotsForJob(job){
    const meta=job?.meta||{};
    const slots=[];
    if(Array.isArray(meta.authoritySlots)) slots.push(...meta.authoritySlots);
    if(meta.assignedSlot) slots.push(meta.assignedSlot);
    if(meta.lockedSlot) slots.push(meta.lockedSlot);
    if(meta.slot) slots.push(meta.slot);
    if(meta.kind==='multi-sidecar') slots.push('A','B');
    else if(Number(meta.batchCount||0)>1 && Array.isArray(meta.workers)) slots.push(...meta.workers);
    return [...new Set(slots.map(s=>String(s||'').toUpperCase()).filter(s=>s==='A'||s==='B'))];
}

function captureAuthority(job, role){
    const slots=slotsForJob(job);
    // Router handles normally expose assigned/worker slots. Preserve a safe
    // admission fallback for adapters/tests that omit those diagnostics: the
    // configured lock/preferred lane still owns the captured request profile.
    if (!slots.length) {
        const route = routeProjection(role);
        const fallbackSlot = String(route.lock || route.preferred || '').toUpperCase();
        if (fallbackSlot === 'A' || fallbackSlot === 'B') slots.push(fallbackSlot);
    }
    return {role,roleGeneration:roleGeneration.get(role)||1,slots:Object.fromEntries(slots.map(slot=>[slot,slotGeneration[slot]])),auditGeneration};
}
function authorityFresh(authority){
    if(!authority)return true;
    if((roleGeneration.get(authority.role)||1)!==authority.roleGeneration)return false;
    return Object.entries(authority.slots||{}).every(([slot,generation])=>slotGeneration[slot]===generation);
}
function authorityTouches(authority,{slots=[],roles=[]}={}){
    if(!authority)return false;
    if(roles.includes(authority.role))return true;
    return slots.some(slot=>Object.prototype.hasOwnProperty.call(authority.slots||{},slot));
}
function trackBusWork(job,scope,kind='job',authority=null){
    if(!job||typeof job!=='object')return null;
    const key=`${kind}:${job.id||`anonymous-${++activeBusSeq}`}`;
    activeBusWork.set(key,{job,scope:scope||null,kind,authority});
    Promise.resolve(job.promise).then(()=>{},()=>{}).finally(()=>activeBusWork.delete(key));
    return key;
}
function staleScopeError(scope){const error=new Error('Nexus Sidecar result arrived after its chat/revision scope became stale.');error.name='TV2ScopeInvalidated';error.nexusScope=scope?{...scope}:null;return error;}
function retiredError(authority){const error=new Error('Nexus Sidecar result arrived from a retired provider/routing profile.');error.name='TV2ExecutionProfileRetired';error.requestAuthority=authority;error.currentGeneration=auditGeneration;return error;}
function guardFreshSettlement(job,scope,authority,extraFresh=null){
    if(!job?.promise)return job;
    const original=job.promise;
    job.promise=Promise.resolve(original).then(result=>{
        if(!isNexusWorkScopeFresh(scope,getContext()))throw staleScopeError(scope);
        if(!authorityFresh(authority))throw retiredError(authority);
        extraFresh?.();
        return result;
    });
    return job;
}
function cancellationError(reason){const error=reason instanceof Error?reason:new Error(String(reason||'Nexus Sidecar Bus work cancelled.'));if(!error.name||error.name==='Error')error.name='TV2BatchCancelled';return error;}
function cancelMatchingAuthority({slots=[],roles=[],reason='Sidecar execution authority retired.',profileRetired=false}={}){
    let cancelled=0;
    for(const {job,authority} of activeBusWork.values()){
        if(!authorityTouches(authority,{slots,roles}))continue;
        const error=profileRetired ? retiredError(authority) : cancellationError(reason);
        if(profileRetired && reason) error.message=String(reason?.message||reason);
        try{if(job?.cancel?.(error)!==false)cancelled+=1;}catch{}
    }
    return cancelled;
}
export function revokeSidecarSlotAuthority(slot,reason='Sidecar runtime health authority changed.'){
    const key=String(slot||'').toUpperCase();if(!['A','B'].includes(key))return 0;
    slotGeneration[key]+=1;auditGeneration+=1;executionProfileGeneration += 1;
    const cancelled=cancelMatchingAuthority({slots:[key],reason});
    logEvent('bus','slot-authority-revoked',{slot:key,slotGeneration:slotGeneration[key],currentGeneration:auditGeneration,cancelled,reason:String(reason?.message||reason)},'warn');
    return cancelled;
}
if (typeof setSidecarAuthorityNotifier === 'function') setSidecarAuthorityNotifier(({slot,reason})=>revokeSidecarSlotAuthority(slot,reason));

export function cancelNexusSidecarBusWork({chatId=null,epoch=null,generationId=null,reason='Nexus Sidecar Bus scope invalidated.'}={}){
    const error=cancellationError(reason);let cancelled=0;const queue=getJobQueue(getSettings().jobs);
    for(const {job,scope} of activeBusWork.values()){
        if(chatId!=null&&String(scope?.chatId??'')!==String(chatId))continue;
        if(epoch!=null&&Number(scope?.epoch)!==Number(epoch))continue;
        if(generationId!=null&&String(scope?.generationId??'')!==String(generationId))continue;
        let didCancel=false;if(typeof job?.cancel === 'function')didCancel=job.cancel(error)!==false;else if(job?.id)didCancel=queue.cancel(job.id, error)!==false;if(didCancel)cancelled+=1;
    }
    if(cancelled)logEvent('bus','scope-cancelled',{chatId,epoch,generationId,cancelled,reason:error.message},'warn');return cancelled;
}
export function getActiveSidecarBusWork(){return [...activeBusWork.values()].map(({job,scope,kind,authority})=>({id:job?.id||null,state:job?.state||null,scope:scope||null,kind,authority}));}
export function canDispatchSidecarWork(stage,{role=null}={}){const resolved=roleFor(stage,role);if(!resolved)return false;return sidecarRouter.canExecute?.(resolved,String(stage||resolved))!==false;}

function enqueue(kind,stage,batches,opts={}){
    const role=roleFor(stage,opts.role);const bus=String(stage||role||(kind==='batch'?'sidecar-batch':'sidecar'));
    if(!role)throw new Error(`Unknown Nexus Sidecar Bus stage/capability: ${String(stage||'')}`);
    const scope=opts.nexusScope||captureNexusWorkScope(getContext(),{kind:opts.scopeKind==='independent'?'independent':'chat'});
    const authorityRef={current:null};
    const assertExecutionFresh=()=>{
        refreshSidecarBus();
        if(!isNexusWorkScopeFresh(scope,getContext()))throw staleScopeError(scope);
        if(authorityRef.current&&!authorityFresh(authorityRef.current))throw retiredError(authorityRef.current);
        opts.assertExecutionFresh?.();
    };
    assertExecutionFresh();
    const allowGlobalDedup=opts.dedupScope==='global'&&opts.scopeIndependent===true;
    const scopedDedupKey=allowGlobalDedup?(opts.dedupKey||null):(opts.dedupKey?nexusScopeDedupKey(opts.dedupKey, scope):null);
    const meta={stage:bus,role,label:opts.label||null,priority:opts.priority??null,dedupKey:scopedDedupKey,requestedMode:opts.executionMode||null,...(kind==='batch'?{batchCount:Array.isArray(batches)?batches.length:0}:{})};
    logEvent('bus',kind==='batch'?'batch-dispatch-requested':'dispatch-requested',meta,'debug');
    try{
        const onAttemptAuthority=slot=>{
            const key=String(slot||'').toUpperCase();if(!['A','B'].includes(key))return;
            refreshSidecarBus();
            if(authorityRef.current)authorityRef.current.slots[key]=slotGeneration[key];
            opts.onAttemptAuthority?.(key);
        };
        const routedOpts={...opts,bus,dedupKey:scopedDedupKey,nexusScope:scope,assertExecutionFresh,onAttemptAuthority};
        const raw=kind==='batch'?sidecarRouter.enqueueBatch(role,batches,routedOpts):sidecarRouter.enqueue(role,routedOpts);
        const authority=captureAuthority(raw,role);authorityRef.current=authority;
        const job=guardFreshSettlement(raw,scope,authority,assertExecutionFresh);trackBusWork(job,scope,kind,authority);
        logEvent('bus',kind==='batch'?'batch-dispatch-enqueued':'dispatch-enqueued',{...meta,jobId:job?.id||null,state:job?.state||null,mode:job?.mode||null,routeId:job?.routeId||null,authority},'info');
        Promise.resolve(job?.promise).then(result=>logEvent('bus',kind==='batch'?'batch-dispatch-complete':'dispatch-complete',{stage:bus,role,jobId:job?.id||null,slot:result?.tv2?.slot||null,completedCount:result?.tv2?.completedCount??null,failedCount:result?.tv2?.failedCount??null},result?.tv2?.degraded?'warn':'info'),error=>{const preempted=isIntentionalCancellation(error);const semanticRepair=job?.meta?.recoverableSemanticAttempt===true&&error?.semantic===true;const name=kind==='batch'?(preempted?'batch-dispatch-preempted':semanticRepair?'batch-dispatch-semantic-repair-needed':'batch-dispatch-failed'):(preempted?'dispatch-preempted':semanticRepair?'dispatch-semantic-repair-needed':'dispatch-failed');logEvent('bus',name,{stage:bus,role,jobId:job?.id||null,error},preempted?'debug':semanticRepair?'warn':'error');});
        return job;
    }catch(error){logEvent('bus',kind==='batch'?'batch-dispatch-rejected':'dispatch-rejected',{...meta,error},'error');throw error;}
}

export function enqueueBusJob(stage,opts={}){return enqueue('job',stage,null,opts);}
export function enqueueBusBatch(stage,batches=[],opts={}){return enqueue('batch',stage,batches,opts);}

export function refreshSidecarBus(){
    const next=signaturesNow();
    if(!slotSignatures.A&&!slotSignatures.B){slotSignatures=next.slots;roleSignatures=next.roles;return sidecarRouter.refresh();}
    const changedSlots=['A','B'].filter(slot=>next.slots[slot]!==slotSignatures[slot]);
    const changedRoles=KNOWN_ROLES.filter(role=>next.roles[role]!==roleSignatures[role]);
    if(changedSlots.length||changedRoles.length){
        for(const slot of changedSlots)slotGeneration[slot]+=1;
        for(const role of changedRoles)roleGeneration.set(role,(roleGeneration.get(role)||1)+1);
        auditGeneration+=1;executionProfileGeneration += 1;slotSignatures=next.slots;roleSignatures=next.roles;
        const cancelled=cancelMatchingAuthority({slots:changedSlots,roles:changedRoles,reason:'Sidecar provider/request/routing profile changed; affected in-flight work was revoked.',profileRetired:true});
        logEvent('bus','execution-profile-revoked',{changedSlots,changedRoles,currentGeneration:auditGeneration,slotGeneration:{...slotGeneration},cancelled},'warn');
    }
    return sidecarRouter.refresh();
}
export function preferredBusSlot(stage){const role=roleFor(stage);return role?sidecarRouter.preferredSlot(role):null;}
export function testSidecar(slot){
    const normalized=String(slot||'').toUpperCase();
    if(!['A','B'].includes(normalized))throw new Error(`Unknown Sidecar slot: ${slot}`);
    refreshSidecarBus();
    const scope=captureNexusWorkScope(getContext());
    const authority={role:'connectivity-test',roleGeneration:1,slots:{[normalized]:slotGeneration[normalized]},auditGeneration};
    const authorityRef=authority;
    const assertExecutionFresh=()=>{refreshSidecarBus();if(!isNexusWorkScopeFresh(scope,getContext()))throw staleScopeError(scope);if(!authorityFresh(authorityRef))throw retiredError(authorityRef);};
    const raw=sidecarRouter.test(normalized,{assertExecutionFresh,onAttemptAuthority:key=>{refreshSidecarBus();authorityRef.slots[key]=slotGeneration[key];}});
    const job=guardFreshSettlement(raw,scope,authorityRef,assertExecutionFresh);trackBusWork(job,scope,'test',authorityRef);
    return job;
}
