import { getContext } from '../../../../st-context.js';
import { mutateChatMetadataDurably } from '../nexus/host-durability.js';
import { ContinuableWorkStore } from '../nexus/continuable-work.js';
import { LifecycleExecutionLeaseRegistry } from './execution-leases.js';
import { logEvent } from '../observability/telemetry.js';
import { getSettings } from '../core/settings.js';
import { getActiveBooks } from '../lore/active-books.js';
import { currentNexusLoreSourceRevision } from '../nexus/lore-source-revision.js';
import { currentMemoryBankRevision } from '../memory/store.js';

const META_KEY='tv2_lifecycle_execution_checkpoints';
const CHECKPOINT_VERSION=1;
const MAX_TERMINAL_RECORDS=80;
const EXECUTION_SESSION_ID=`lc-session-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;

/**
 * Execution checkpoints are deliberately restricted to non-canonical,
 * preemptible lifecycle work. Summary/Digest coverage, Memory Bank pointers,
 * proposals, and canonical mutations have their own durability authorities and
 * must never be inferred from a generic "completed" execution checkpoint.
 */
export const CHECKPOINTABLE_LIFECYCLE_TASKS=Object.freeze(new Set(['smart-warm','maintenance','housekeeper']));

let cachedMetadata=null;
let cachedChatId=null;
let cachedStore=null;

function clone(value){try{return structuredClone(value);}catch{return JSON.parse(JSON.stringify(value));}}
function clean(value){return String(value??'').trim();}
function stableObject(value){
    if(Array.isArray(value))return value.map(stableObject);
    if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(key=>[key,stableObject(value[key])]));
    return value;
}
function hashValue(prefix,value){
    const text=JSON.stringify(stableObject(value??null));let hash=0x811c9dc5;
    for(let i=0;i<text.length;i+=1){hash^=text.charCodeAt(i);hash=Math.imul(hash,0x01000193)>>>0;}
    return `${prefix}-${hash.toString(16).padStart(8,'0')}-${text.length}`;
}
function stableScope(scope={}){
    if(scope?.kind==='independent')return 'independent';
    return [
        `chat:${String(scope?.chatId??'none')}`,
        `epoch:${Number(scope?.epoch)||0}`,
        `rev:${String(scope?.revision||'none')}`,
        `source:${String(scope?.sourceRevision||'none')}`,
        `generation:${String(scope?.generationId??'none')}`,
    ].join('|');
}
function normalizedTask(task=''){
    const name=clean(task);
    if(['summary','summary-create','summary-backlog','summary-promote','summary-promotion','lore-route','lore-routing'].includes(name))return 'memory-bank';
    if(['maintenance','housekeeper'].includes(name))return 'housekeeper';
    if(['post-turn','post-turn-extract','post-turn-flush'].includes(name))return 'post-turn';
    if(['notebook','notebook-refresh'].includes(name))return 'notebook';
    if(['character-bank','character-bank-refresh'].includes(name))return 'character-bank';
    if(['smart-warm'].includes(name))return 'smart-warm';
    return name||'lifecycle-task';
}
function checkpointSourceAuthority(task,scope={}){
    const normalized=normalizedTask(task),settings=getSettings();
    if(normalized==='smart-warm'){
        const books=getActiveBooks({requireTree:true,access:'read',injection:'tv2'});
        const meta=getContext()?.chatMetadata?.tv2_smart_context||{};
        return hashValue('lc-smart-warm',{scope:stableScope(scope),books,loreRevision:currentNexusLoreSourceRevision(books),policy:settings?.smartContext||{},manualPins:meta?.manualPins||[],activePins:meta?.activePins||[]});
    }
    if(normalized==='housekeeper'){
        const books=getActiveBooks({requireTree:true,access:'read',injection:'any'});
        return hashValue('lc-housekeeper',{scope:stableScope(scope),books,loreRevision:currentNexusLoreSourceRevision(books),memoryRevision:currentMemoryBankRevision(),policy:settings?.housekeeper||{}});
    }
    return hashValue('lc-scope',{scope:stableScope(scope)});
}
function checkpointEnvelope(context){
    const raw=context?.chatMetadata?.[META_KEY];
    if(!raw||typeof raw!=='object'||Array.isArray(raw))return {version:CHECKPOINT_VERSION,records:[],updatedAt:0};
    return {version:CHECKPOINT_VERSION,records:Array.isArray(raw.records)?raw.records:[],updatedAt:Number(raw.updatedAt)||0};
}
function retainedSnapshot(snapshot=[]){
    const nonterminal=[];const terminal=[];
    for(const row of Array.isArray(snapshot)?snapshot:[]){
        if(['complete','stale','cancelled','superseded'].includes(String(row?.state||'')))terminal.push(row);else nonterminal.push(row);
    }
    terminal.sort((a,b)=>(Number(b?.updatedAt)||0)-(Number(a?.updatedAt)||0));
    return [...nonterminal,...terminal.slice(0,MAX_TERMINAL_RECORDS)].map(clone);
}
function currentStore(context=getContext()){
    const metadata=context?.chatMetadata||null;
    const chatId=String(context?.chatId||'');
    if(cachedStore&&cachedMetadata===metadata&&cachedChatId===chatId)return cachedStore;
    const initial=checkpointEnvelope(context).records;
    cachedMetadata=metadata;cachedChatId=chatId;
    cachedStore=new ContinuableWorkStore({
        initialRecords:initial,
        onCheckpoint:async(_record,snapshot,meta)=>{
            const live=getContext();
            if(!live?.chatMetadata||live.chatMetadata!==metadata||String(live.chatId||'')!==chatId){
                const error=new Error('Lifecycle execution checkpoint target changed before persistence.');
                error.name='TV2ScopeInvalidated';
                throw error;
            }
            const records=retainedSnapshot(snapshot);
            await mutateChatMetadataDurably(live,'Lifecycle execution checkpoint',{keys:[META_KEY]},()=>{
                live.chatMetadata[META_KEY]={version:CHECKPOINT_VERSION,records,updatedAt:Date.now()};
                return true;
            });
            logEvent('lifecycle-checkpoint','checkpoint-persisted',{phase:meta?.phase||null,unitId:meta?.unitId||null,effectMayHaveCommitted:meta?.effectMayHaveCommitted===true,recordCount:records.length},'debug');
        },
    });
    return cachedStore;
}

const leases=new LifecycleExecutionLeaseRegistry({
    onChange:(type,lease,extra)=>logEvent('lifecycle-physical',`lease-${type}`,{
        leaseId:lease?.leaseId||null,workUnitId:lease?.workUnitId||null,conflictKey:lease?.conflictKey||null,
        cycleId:lease?.cycleId||null,task:lease?.task||null,logicalInvalidated:lease?.logicalInvalidated===true,...(extra||{}),
    },type==='logical-invalidated'?'warn':'debug'),
});

export function lifecycleConflictKey(task,scope={}){
    const owner=normalizedTask(task);
    const target=scope?.kind==='independent'?'independent':`chat:${String(scope?.chatId??'none')}`;
    return `${owner}|${target}`;
}

export function lifecycleWorkUnitId(task,scope={},authorityKey=null){
    const authority=clean(authorityKey)||stableScope(scope);
    return `${normalizedTask(task)}|${authority}`;
}

export function getLifecyclePhysicalLeaseSnapshot(){return leases.snapshot();}
export function invalidateLifecyclePhysicalLeasesForCycle(cycleId,reason='logical-cycle-invalidated'){
    return leases.invalidateCycle(cycleId,reason);
}

/**
 * One physical owner for an exact work unit and one owner for a conflicting
 * target. A newer logical cycle may wait for the stale physical owner to drain,
 * but invalidating the old cycle never releases the physical lease early.
 */
export async function runLifecyclePhysicalLease({task,scope={},authorityKey=null,workUnitId=null,conflictKey=null,cycleId=null,waitForConflict=true,isFresh=null,execute}={}){
    const unit=clean(workUnitId)||lifecycleWorkUnitId(task,scope,authorityKey);
    const conflict=clean(conflictKey)||lifecycleConflictKey(task,scope);
    const result=await leases.run({
        workUnitId:unit,conflictKey:conflict,cycleId,task:normalizedTask(task),waitForConflict,
        execute:async info=>{
            if(typeof isFresh==='function'&&isFresh()===false){
                const error=new Error('Lifecycle physical lease became stale before execution.');error.name='TV2ScopeInvalidated';throw error;
            }
            const value=await execute(info);
            if(typeof isFresh==='function'&&isFresh()===false){
                const error=new Error('Lifecycle physical lease became stale after execution.');error.name='TV2ScopeInvalidated';throw error;
            }
            return value;
        },
    });
    // Joined callers have their own logical authority. The physical owner may
    // finish successfully after this caller was invalidated, so recheck here too.
    if(typeof isFresh==='function'&&isFresh()===false){
        const error=new Error('Lifecycle physical lease result is stale for this caller.');error.name='TV2ScopeInvalidated';throw error;
    }
    return result;
}

function compactReceipt(value){
    if(value==null)return {completed:true};
    return {
        completed:true,
        skipped:value?.skipped===true,
        count:Number(value?.count??value?.findingCount??value?.finalWarmCount??0)||0,
        sourceSignature:value?.sourceSignature||null,
        status:value?.status||null,
        at:Date.now(),
    };
}

/**
 * Run an allow-listed non-canonical lifecycle unit behind both a physical lease
 * and a durable execution-intent checkpoint. This is execution durability only;
 * callers may not use it as Memory/Summary coverage authority.
 */
export async function runCheckpointedLifecycleTask({task,scope={},authorityKey=null,cycleId=null,isFresh=()=>true,execute,receipt=compactReceipt}={}){
    const normalized=normalizedTask(task);
    if(!CHECKPOINTABLE_LIFECYCLE_TASKS.has(clean(task))&&!CHECKPOINTABLE_LIFECYCLE_TASKS.has(normalized)){
        throw new Error(`Lifecycle execution checkpoints are not authorized for ${clean(task)||'(missing task)'}.`);
    }
    if(typeof execute!=='function')throw new Error('Checkpointed lifecycle task requires execute().');
    const ownerSourceAuthority=checkpointSourceAuthority(normalized,scope);
    // Completion identity must survive extension/browser reload. The session ID is
    // diagnostic metadata only; putting it in the authority key would make a
    // durable COMPLETE checkpoint invisible to the next runtime and replay the
    // same physical effect.
    const combinedAuthority=hashValue('lc-authority',{caller:clean(authorityKey)||null,owner:ownerSourceAuthority});
    const workId=lifecycleWorkUnitId(normalized,scope,combinedAuthority);
    const conflictKey=lifecycleConflictKey(normalized,scope);
    const checkpointFresh=()=>isFresh()!==false&&checkpointSourceAuthority(normalized,scope)===ownerSourceAuthority;
    const lease=await runLifecyclePhysicalLease({task:normalized,scope,authorityKey:combinedAuthority,workUnitId:workId,conflictKey,cycleId,waitForConflict:true,isFresh:checkpointFresh,execute:async()=>{
        const store=currentStore(getContext());
        let row=store.get(workId);
        if(!row){
            // A prior process may have died after persisting execution intent but
            // before proving completion. That indeterminate same-source unit owns
            // replay authority even though the new runtime has a new session ID.
            const unresolved=store.list().find(record=>record?.ownerSubsystem===normalized&&record?.metadata?.ownerSourceAuthority===ownerSourceAuthority&&(record?.state==='recovery-required'||Number(record?.recoveryRequiredUnits)>0));
            if(unresolved){
                logEvent('lifecycle-checkpoint','reload-recovery-required',{workId:unresolved.workId,requestedWorkId:workId,task:normalized,recoveryRequiredUnits:unresolved.recoveryRequiredUnits||0,coverageAuthority:false},'warn');
                return {skipped:true,deferred:true,recoveryRequired:true,reason:'checkpoint-recovery-required',workId:unresolved.workId};
            }
            row=store.create({workId,ownerSubsystem:normalized,sourceProof:{scope:clone(scope),ownerSourceAuthority},units:['execute'],metadata:{authorityKey:clean(authorityKey)||null,ownerSourceAuthority,executionSessionId:EXECUTION_SESSION_ID,executionOnly:true,coverageAuthority:false}});
        }
        if(row.state==='complete'){
            logEvent('lifecycle-checkpoint','checkpoint-reused',{workId,task:normalized,completedUnits:row.completedUnits||0,coverageAuthority:false},'info');
            return {skipped:true,reason:'execution-checkpoint-complete',checkpointReused:true,workId};
        }
        if(row.state==='recovery-required'||row.recoveryRequiredUnits>0){
            logEvent('lifecycle-checkpoint','recovery-required',{workId,task:normalized,recoveryRequiredUnits:row.recoveryRequiredUnits||0,coverageAuthority:false},'warn');
            return {skipped:true,deferred:true,recoveryRequired:true,reason:'checkpoint-recovery-required',workId};
        }
        let actual;
        const completed=await store.advance(workId,{
            maxUnits:1,
            isFresh:()=>checkpointFresh(),
            executeUnit:async()=>{actual=await execute();return typeof receipt==='function'?receipt(actual):compactReceipt(actual);},
            validateUnit:()=>checkpointFresh(),
            validateComplete:()=>checkpointFresh(),
            // Foreground/scope cancellation is fenced by Smart Warm/Housekeeper
            // before publication, so it is safe to resume later. Unknown errors
            // remain indeterminate rather than risking duplicate effects.
            isRetrySafeError:error=>['TV2ForegroundAbort','TV2GenerationStopped','TV2BatchCancelled','TV2ScopeInvalidated','AbortError'].includes(String(error?.name||'')),
        });
        if(completed?.recoveryRequiredUnits>0||completed?.state==='recovery-required')return {skipped:true,deferred:true,recoveryRequired:true,reason:'checkpoint-recovery-required',workId};
        if(completed?.state==='stale')return {skipped:true,deferred:true,stale:true,reason:'checkpoint-source-stale',workId};
        return actual===undefined?{skipped:true,reason:'execution-checkpoint-complete',checkpointReused:true,workId}:actual;
    }});
    return lease.value;
}

export function getLifecycleExecutionCheckpointSnapshot(){
    const context=getContext();
    const store=currentStore(context);
    return {version:CHECKPOINT_VERSION,records:store.list(),physicalLeases:getLifecyclePhysicalLeaseSnapshot(),coverageAuthority:false};
}

export async function resolveLifecycleExecutionRecovery(workId,unitId='execute',resolution={}){
    const store=currentStore(getContext());
    const result=await store.resolveRecovery(workId,unitId,resolution);
    logEvent('lifecycle-checkpoint','recovery-resolved',{workId,unitId,outcome:resolution?.outcome||null,state:result?.state||null,coverageAuthority:false},'warn');
    return result;
}
