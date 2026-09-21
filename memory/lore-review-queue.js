import { getContext } from '../../../../st-context.js';
import { getMemoryRecord, memoryRecordVersion } from './store.js';
import { routeMemoryToLore } from './lore-router.js';
import { getNexusRuntime } from '../nexus/runtime.js';
import { NEXUS_JOB_KIND } from '../nexus/contracts.js';
import { markModelWorkerExecutor } from '../nexus/sidecar-job-adapter.js';
import { captureNexusWorkScope, isNexusWorkScopeFresh } from '../nexus/work-scope.js';
import { enqueueNexusModelWorkerJob } from '../nexus/model-worker-bus.js';
import { NEXUS_BATCH_DOMAIN } from '../nexus/batch-layer.js';
import { logEvent } from '../observability/telemetry.js';

const CHANGE_EVENT='tv2:lore-review-queue-changed';
const activeByKey=new Map();
const latestByMemory=new Map();
let queueSeq=0;

function emit(){try{globalThis.window?.dispatchEvent?.(new CustomEvent(CHANGE_EVENT));}catch{}}
function clone(value){return value==null?value:JSON.parse(JSON.stringify(value));}
function chatIdOf(ctx=getContext()){return String(ctx?.chatId??'').trim();}
function rowKey(chatId,memoryId,version){return `${chatId}|${memoryId}|${version}`;}
function latestKey(chatId,memoryId){return `${chatId}|${memoryId}`;}
function terminal(state){return ['complete','failed','stale','skipped','cancelled'].includes(String(state||''));}

export function getLoreReviewQueueChangeEventName(){return CHANGE_EVENT;}
export function isLoreReviewableMemory(record){return !!record&&!record.promotedTo&&['unrouted','failed','partial'].includes(String(record.routeState||'unrouted'));}
export function getLoreReviewQueueEntry(memoryId,{chatId=chatIdOf()}={}){return clone(latestByMemory.get(latestKey(String(chatId||''),String(memoryId||'')))||null);}
export function getLoreReviewQueueSnapshot({chatId=chatIdOf()}={}){
    const id=String(chatId||'');return [...latestByMemory.values()].filter(row=>row.chatId===id).map(clone).sort((a,b)=>a.queuedAt-b.queuedAt);
}

function updateRow(row,patch={}){
    Object.assign(row,patch,{updatedAt:Date.now()});latestByMemory.set(latestKey(row.chatId,row.memoryId),row);emit();return row;
}
function queueError(message,name='TV2LoreReviewQueueRejected'){const error=new Error(message);error.name=name;return error;}

export function queueLoreReviewMemories(memoryIds=[],{source='memory-bank'}={}){
    const context=getContext(),chatId=chatIdOf(context);
    if(!chatId)throw queueError('Select a chat before queueing Summary-to-Lore review.','TV2LoreReviewScopeUnavailable');
    const ids=[...new Set((Array.isArray(memoryIds)?memoryIds:[memoryIds]).map(String).filter(Boolean))];
    const scope=captureNexusWorkScope(context,{includeRevision:false});
    const accepted=[],duplicates=[],rejected=[];
    for(const memoryId of ids){
        const record=getMemoryRecord(memoryId);
        if(!record){rejected.push({memoryId,reason:'missing-memory'});continue;}
        if(!isLoreReviewableMemory(record)){rejected.push({memoryId,reason:`not-reviewable:${record.routeState||'unknown'}`});continue;}
        const sourceRevision=memoryRecordVersion(record),key=rowKey(chatId,memoryId,sourceRevision),prior=activeByKey.get(key);
        if(prior&&!terminal(prior.state)){duplicates.push(clone(prior));continue;}
        const row={queueId:`lore_review_${Date.now()}_${++queueSeq}`,key,chatId,memoryId,sourceRevision,state:'queued',source:String(source||'memory-bank'),queuedAt:Date.now(),updatedAt:Date.now(),planId:null,jobId:null,error:'',result:null};
        activeByKey.set(key,row);latestByMemory.set(latestKey(chatId,memoryId),row);accepted.push(row);emit();
    }
    if(!accepted.length)return {queued:0,accepted:[],duplicates,rejected};

    const runtime=getNexusRuntime();
    const plan=runtime.director.buildRequestedPlan({
        source:'memory-bank-lore-review-queue',
        classification:{manual:true,storyScoped:true},
        decisions:accepted.map(row=>({action:'run',job:'lore-routing',reason:`operator queued memory ${row.memoryId}`})),
        jobs:accepted.map(row=>({
            type:'lore-routing',name:`Lore review · ${row.memoryId}`,kind:NEXUS_JOB_KIND.ROUTE,priority:65,transactionRequired:true,
            metadata:{queueId:row.queueId,memoryId:row.memoryId,chatId:row.chatId,expectedMemoryVersion:row.sourceRevision,source:'memory-bank-lore-review-queue'},
        })),
        metadata:{chatId,queuedCount:accepted.length,source:String(source||'memory-bank')},
    });
    const byMemory=new Map(accepted.map(row=>[row.memoryId,row]));
    for(const job of plan.jobs){const row=byMemory.get(String(job.metadata?.memoryId||''));if(row){row.planId=plan.id;row.jobId=job.id;}}
    emit();

    const executor=markModelWorkerExecutor(async(job,activePlan)=>{
        const row=byMemory.get(String(job.metadata?.memoryId||''));
        if(!row)throw queueError('Queued lore-review job lost its memory identity.');
        if(!isNexusWorkScopeFresh(scope,getContext(),{checkRevision:false}))throw queueError('Queued lore review belongs to a different active story.','TV2ScopeInvalidated');
        updateRow(row,{state:'reviewing'});
        const result=await routeMemoryToLore(row.memoryId,{
            cycleId:`queue:${activePlan?.id||plan.id}`,
            manual:true,
            expectedChatId:row.chatId,
            expectedMemoryVersion:row.sourceRevision,
            directorMeta:{nexusPlanId:activePlan?.id||plan.id,nexusDirectorJobId:job.id,nexusMigration:'manual-lore-review-queue',nexusInternalWorker:true,loreReviewQueueId:row.queueId},
            enqueueSidecar:(stage,options)=>enqueueNexusModelWorkerJob(NEXUS_BATCH_DOMAIN.LOREBOOK,stage,{...(options||{}),telemetry:{...(options?.telemetry||{}),nexusPlanId:activePlan?.id||plan.id,nexusDirectorJobId:job.id,loreReviewQueueId:row.queueId,nexusInternalWorker:true}}),
        });
        if(result?.deferred||result?.stale){const error=queueError(result.reason||'Queued lore review became stale.','TV2ScopeInvalidated');error.result=result;throw error;}
        if(result?.failed){const error=queueError(result.error||'Queued lore review failed.','TV2LoreReviewFailed');error.result=result;throw error;}
        return result;
    });

    queueMicrotask(()=>{
        void runtime.coordinator.run(plan,{
            executors:{'lore-routing':executor},
            isFresh:()=>isNexusWorkScopeFresh(scope,getContext(),{checkRevision:false}),
            onChange:job=>{
                const row=byMemory.get(String(job.metadata?.memoryId||''));if(!row)return;
                if(job.state==='running')updateRow(row,{state:'reviewing'});
                else if(job.state==='succeeded')updateRow(row,{state:'complete',result:clone(job.result?.value||null),error:''});
                else if(job.state==='failed')updateRow(row,{state:'failed',error:String(job.error||'Lore review failed.')});
                else if(job.state==='cancelled')updateRow(row,{state:'stale',error:String(job.error||'Lore review became stale.')});
                else if(job.state==='skipped')updateRow(row,{state:'skipped',result:clone(job.result?.value||null)});
                if(terminal(row.state))activeByKey.delete(row.key);
            },
        }).then(snapshot=>{logEvent('memory','lore-review-queue-complete',{planId:plan.id,chatId,queued:accepted.length,succeeded:snapshot?.succeeded||0,failed:snapshot?.failed||0,cancelled:snapshot?.cancelled||0},snapshot?.failed?'warn':'info');},error=>{
            for(const row of accepted){if(!terminal(row.state)){updateRow(row,{state:'failed',error:error?.message||String(error)});activeByKey.delete(row.key);}}
            logEvent('memory','lore-review-queue-failed',{planId:plan.id,chatId,error},'error');
        });
    });
    logEvent('memory','lore-review-queued',{planId:plan.id,chatId,count:accepted.length,memoryIds:accepted.map(row=>row.memoryId)},'info');
    return {queued:accepted.length,planId:plan.id,accepted:accepted.map(clone),duplicates,rejected};
}
