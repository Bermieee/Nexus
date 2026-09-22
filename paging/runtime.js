import { getContext } from '../../../../st-context.js';
import { getSettings } from '../core/settings.js';
import { memoryEmbeddingVersion, memoryPagingFreshnessStamp, memoryRecordValidity } from '../memory/store.js';
import { currentNexusChatEpoch, currentNexusForegroundGenerationId } from '../nexus/work-scope.js';
import { logEvent } from '../observability/telemetry.js';
import { getCurrentSceneChangeGate } from '../retrieval/change-gate.js';
import { isNarrativeSceneMessage, tailNarrativeSceneMessages } from '../retrieval/handoff-policy.js';
import { activationDecision, pagingConfig } from './policy.js';
import { ResidencyIndex } from './engine.js';
import { embedWithSession, embeddingProfile, setPagingSessionKey, hasPagingSessionKey } from './embeddings.js';
import { readVectorCache, writeVectorCache } from './cache.js';
import { clearLoreVectorCache } from './lore-cache.js';
import { selectContinuableUnits } from '../nexus/continuable-work.js';
import { createAdaptiveProfileKey, recommendAdaptiveBatchSize, recordThroughputSample } from '../nexus/adaptive-throughput.js';

const index=new ResidencyIndex();
let timer=null, running=null, backgroundAbort=null, revision=0, hydratedKey='', lastQuery='', lastProbedQuery='', lastVector=null, lastWake=[], lastError='',status={},indexedEpoch=null, indexedIds=[],probeSeq=0,lastRecall={state:'not-run',reason:null};
const yieldTask=()=>new Promise(resolve=>setTimeout(resolve,0));
function embeddingEndpointHost(config={}){try{return new URL(config.endpoint).host||'embedding';}catch{return 'embedding';}}
function memoryEmbeddingAdaptiveKey(config={}){return createAdaptiveProfileKey({workloadType:'vector:memory-index',provider:'embedding',profile:`${embeddingEndpointHost(config)}|maxChars:${Math.max(0,Number(config.maxTextChars)||0)}`,model:config.model||'unknown',worker:'EMBEDDING',contractVersion:'hf46-v1'});}
const cfg=()=>pagingConfig(getSettings().vectorPaging);
function identity(ctx=getContext()){return ctx?.chatId==null?'':JSON.stringify([String(ctx.chatId),ctx.groupId??null,ctx.characterId??null]);}
function usable(c=cfg()){return getSettings().enabled&&getSettings().memoryBank?.enabled!==false&&c.mode!=='off'&&!!identity();}
function rawStore(){return getContext()?.chatMetadata?.tv2_memory_bank||{records:{},activeLayers:[],permanentIds:[]};}
function memoryIndexReady(c=cfg()){return index.active&&index.rows.size>0&&index.pending(c).length===0;}
function notify(){const snap=index.snapshot();status={...snap,mode:cfg().mode,error:lastError,nominated:lastWake.length,busy:!!running,indexReady:memoryIndexReady(cfg()),reason:snap.total===0?'no-eligible-indexed-memory-records':(lastError||snap.reason||null),physicalStorageState:'canonical-memory-resident',physicalUnloadedRecords:0,liveRecall:{...lastRecall}};try{window.dispatchEvent(new CustomEvent('nexus-vector-paging-updated'));}catch{}}
async function digest(text){const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text));return [...new Uint8Array(bytes)].map(x=>x.toString(16).padStart(2,'0')).join('');}
function recordCurrent(row,store=rawStore()){const live=store.records?.[row.canonicalId];return !!live&&memoryPagingFreshnessStamp(live)===row.sourceStamp;}
function currentQuery(){const n=getSettings().memoryBank?.recall?.contextMessages||8;return tailNarrativeSceneMessages(getContext()?.chat||[],n).map(m=>`[${m.is_user?'User':'Assistant'}] ${String(m.mes||'')}`).join('\n\n');}
function wakeAllowed(query,weakCoverage=false){
    if(!lastProbedQuery||weakCoverage||/\b(remember|back then|years? ago|promis\w*|earlier|used to)\b/i.test(query))return true;
    // Paging is a consumer of Change Gate authority, never a second scene
    // classifier. If the current revision has not yet been classified, fail
    // open to an ordinary vector wake probe; wake nominations do not mutate
    // scene topology or prompt authority.
    const gate=getCurrentSceneChangeGate({chatId:getContext()?.chatId??null});
    return gate?.mode ? gate.mode!=='NO_CHANGE' : true;
}

async function refresh(c,token){
    const ctx=getContext(),scope=identity(ctx),epoch=currentNexusChatEpoch(),store=rawStore();
    const records=Object.values(store.records||{}),chat=ctx?.chat||[];
    const assistantAfter=new Array(chat.length+1).fill(0);
    for(let i=chat.length-1;i>=0;i--)assistantAfter[i]=assistantAfter[i+1]+Number(chat[i]?.is_user===false&&!chat[i]?.is_system);
    const active=new Set((store.activeLayers||[]).flat().map(String));
    const permanent=new Set((store.permanentIds||[]).map(String));
    const rows=[];
    let validRecordCount=0;
    for(const r of records)if(r?.id&&memoryRecordValidity(r,{store,chat}).valid)validRecordCount++;
    // Overflow remains outside paging authority: incomplete indexes never hide it.
    for(const r of records.slice(0,c.indexLimit)){
        if(token!==revision||scope!==identity()||epoch!==currentNexusChatEpoch()||currentNexusForegroundGenerationId()!=null)return false;
        if(!r?.id||!memoryRecordValidity(r,{store,chat}).valid)continue;
        const sourceStamp=memoryPagingFreshnessStamp(r),semanticVersion=memoryEmbeddingVersion(r),prior=index.rows.get(String(r.id));
        const version=prior?.semanticVersion===semanticVersion?prior.version:await digest(semanticVersion);
        const end=r.turnRange?.[1],recent=!Number.isInteger(end)||end<0||end>=chat.length||assistantAfter[end+1]<c.minAgeTurns;
        // Unresolved threads/proposals are conservative protections; never infer
        // resolution from vectors, record age, or summary promotion alone.
        rows.push({id:String(r.id),canonicalId:String(r.id),kind:'memory',version,sourceStamp,semanticVersion,
            text:[r.text,...(r.characters||[]),...(r.locations||[]),...(r.topics||[])].join('\n'),
            aliases:[...(r.characters||[]),...(r.locations||[]),...(r.dates||[])].filter(x=>typeof x==='string'),
            protected:r.permanent===true||permanent.has(String(r.id))||r.locked===true||recent||(r.threads||[]).length>0||(r.routeProposalIds||[]).length>0,
            recency:Number(r.updatedAt||r.createdAt)||0,baselineActive:active.has(String(r.id))||permanent.has(String(r.id)),record:r});
        if(rows.length%24===0)await yieldTask();
    }
    if(token!==revision||scope!==identity()||epoch!==currentNexusChatEpoch())return false;
    const turns=chat.filter(m=>m?.is_user===false&&!m.is_system).length;
    const activation=activationDecision({turns,records:validRecordCount,wasActive:index.active,activatedAt:index.activatedAt,now:Date.now()},c);
    index.reconcile(rows,{scope,profile:embeddingProfile(c),turns,config:c,activation});
    indexedEpoch=epoch;indexedIds=Object.keys(store.records||{}).sort();
    const key=JSON.stringify([scope,index.profile]);
    if(hydratedKey!==key){
        hydratedKey=key;
        try{const saved=await readVectorCache(key);if(token===revision&&scope===identity()&&index.profile===embeddingProfile(cfg()))index.restoreVectors(saved);}catch{lastError='Vector cache unavailable; rebuilding in memory.';}
    }
    return true;
}

export function setEmbeddingSessionKey(value){const loaded=setPagingSessionKey(value);if(!loaded)backgroundAbort?.abort();lastError='';notify();scheduleVectorMaintenance(1000);return loaded;}
export function embeddingSessionKeyLoaded(){return hasPagingSessionKey();}
export function vectorPagingStatus(){return {...status};}
export function invalidateVectorPaging(reason='changed',{broadcast=true,schedule=true}={}){
    revision++;backgroundAbort?.abort();lastQuery='';lastProbedQuery='';lastVector=null;lastWake=[];hydratedKey='';index.reset('', '');
    lastError='';lastRecall={state:'not-run',reason:null};notify();if(broadcast){try{window.dispatchEvent(new CustomEvent('nexus-paging-invalidated'));}catch{}}if(schedule)scheduleVectorMaintenance();
}
export async function clearVectorPagingCache({broadcast=true,schedule=true}={}){invalidateVectorPaging('manual-rebuild',{broadcast,schedule});try{await writeVectorCache('',[]);await writeVectorCache('',[],'lore');await clearLoreVectorCache();}catch{}notify();}
export function scheduleVectorMaintenance(delay=2000){
    if(timer)clearTimeout(timer);
    if(!usable()||getSettings().scheduler?.enabled===false)return;
    timer=setTimeout(()=>{timer=null;void maintainVectorIndex();},typeof delay==='number'?Math.max(1000,delay):2000);
}
export async function maintainVectorIndex(){
    if(running)return running;
    const c=cfg();if(!usable(c)||currentNexusForegroundGenerationId()!=null)return;
    const token=revision;
    running=(async()=>{
        if(!await refresh(c,token)||!index.active||!c.endpoint||!c.model||currentNexusForegroundGenerationId()!=null)return;
        const profile=embeddingProfile(c),scope=identity();
        backgroundAbort=new AbortController();
        const timeout=setTimeout(()=>backgroundAbort?.abort(),10000);
        try{
            const pendingAll=index.pending({...c,batchSize:32});
            const adaptiveProfileKey=memoryEmbeddingAdaptiveKey(c);
            const adaptiveBatchSize=recommendAdaptiveBatchSize({profileKey:adaptiveProfileKey,currentSize:c.batchSize,minSize:1,maxSize:32,remainingItems:pendingAll.length,availableWindowMs:8000});
            const pending=selectContinuableUnits(pendingAll,adaptiveBatchSize);
            if(pending.length){
                logEvent('vector-paging','memory-index-slice-start',{pendingTotal:pendingAll.length,sliceSize:pending.length,configuredBatchSize:c.batchSize,adaptiveBatchSize,sourceRevision:token},'debug');
                const started=globalThis.performance?.now?.()??Date.now();
                let vectors;
                try{
                    vectors=await embedWithSession(pending.map(r=>r.text),c,{signal:backgroundAbort.signal});
                    const elapsed=(globalThis.performance?.now?.()??Date.now())-started;
                    recordThroughputSample({profileKey:adaptiveProfileKey,batchSize:pending.length,successfulItems:pending.length,latencyMs:elapsed,outcome:'success',inputTokens:pending.reduce((sum,row)=>sum+Math.max(1,Math.ceil(String(row.text||'').length/4)),0)});
                }catch(error){
                    const elapsed=(globalThis.performance?.now?.()??Date.now())-started;
                    const foreground=currentNexusForegroundGenerationId()!=null;
                    if(!foreground&&elapsed>=9500)recordThroughputSample({profileKey:adaptiveProfileKey,batchSize:pending.length,successfulItems:0,latencyMs:elapsed,outcome:'timeout'});
                    else if(!backgroundAbort.signal.aborted)recordThroughputSample({profileKey:adaptiveProfileKey,batchSize:pending.length,successfulItems:0,latencyMs:elapsed,outcome:'failure'});
                    throw error;
                }
                if(backgroundAbort.signal.aborted||currentNexusForegroundGenerationId()!=null||token!==revision||scope!==identity()||profile!==embeddingProfile(cfg())||!usable())return;
                for(let i=0;i<pending.length;i++)if(recordCurrent(pending[i]))index.put(pending[i].id,pending[i].version,vectors[i]);
                logEvent('vector-paging','memory-index-slice-complete',{completedUnits:pending.length,remainingUnits:index.pending({...c,batchSize:32}).length,adaptiveBatchSize,sourceRevision:token},'debug');
            }
            // Cache the current scene vector in idle time, never reuse it for a
            // different query. A foreground miss falls back unless opted in.
            const query=currentQuery();
            if(query&&query.length<=c.maxTextChars&&(lastQuery!==query||!lastVector)&&wakeAllowed(query)){
                const [vector]=await embedWithSession([query],c,{signal:backgroundAbort.signal});
                if(backgroundAbort.signal.aborted||currentNexusForegroundGenerationId()!=null||token!==revision||scope!==identity()||profile!==embeddingProfile(cfg())||query!==currentQuery()||!usable())return;
                lastQuery=query;lastVector=vector;
            }
            if(token!==revision||scope!==identity()||!usable())return;
            index.rebalance(c);lastError='';
            await writeVectorCache(JSON.stringify([scope,profile]),index.exportVectors());
        }finally{clearTimeout(timeout);backgroundAbort=null;}
    })().catch(error=>{if(error?.name!=='AbortError')lastError=error?.message||'Index unavailable';})
      .finally(()=>{running=null;notify();if(usable()&&cfg().endpoint&&cfg().model&&index.active&&!lastError)scheduleVectorMaintenance(index.pending(cfg()).length?2000:30000);});
    return running;
}

// This function only returns eligibility and nominations. It never writes a
// prompt, canonical memory, or mutation journal.
export async function prepareMemoryPaging(query,{weakCoverage=false,requestId=null}={}){
    const c=cfg(),ordinaryBase={eligibleIds:null,nominated:[],nominationDetails:[],mode:c.mode};
    const scope=identity(),profile=embeddingProfile(c),epoch=currentNexusChatEpoch(),token=revision;
    const probeId=`memory-wake-${epoch}-${currentNexusForegroundGenerationId()??requestId??'none'}-${++probeSeq}`;
    const queryFingerprint=query?`${(await digest(query)).slice(0,16)}:${Array.from(query).length}`:null;
    const traceBase={probeId,requestId:requestId??currentNexusForegroundGenerationId()??null,chatEpoch:epoch,turn:getContext()?.chat?.length||0,sourceVersion:indexedEpoch,mode:c.mode,queryFingerprint};
    const fallback=(reason,{probe='skipped',vectorAvailability='unavailable',vectorCache='miss',level='debug',extra={}}={})=>{
        lastRecall={state:'ordinary',reason,probeId,queryVectorAvailable:vectorAvailability==='available',queryVectorCache:vectorCache};
        logEvent('vector-paging','memory-wake-probe',{...traceBase,indexReady:memoryIndexReady(c),probe,probeReason:reason,queryVector:{availability:vectorAvailability,cache:vectorCache,foregroundAllowed:c.allowForegroundEmbedding===true},exclusionEnforced:false,ordinaryRetrieval:true,fallbackReason:reason,...extra},level);
        notify();return {...ordinaryBase,probeId,turn:traceBase.turn,sourceVersion:traceBase.sourceVersion,fallbackReason:reason,indexReady:memoryIndexReady(c)};
    };
    if(!usable(c))return fallback(c.mode==='off'?'disabled':'index-not-ready');
    const deadline=performance.now()+c.foregroundBudgetMs;
    if(index.scope!==scope||index.profile!==profile||indexedEpoch!==epoch||!index.active){scheduleVectorMaintenance();return fallback('index-not-ready',{probe:'skipped'});}
    const store=rawStore();
    const ids=Object.keys(store.records||{}).sort();
    if(JSON.stringify(ids)!==JSON.stringify(indexedIds)){scheduleVectorMaintenance();return fallback('stale-source',{probe:'skipped',level:'warn'});}
    let stale=false;
    for(const r of index.rows.values()){
        if(performance.now()>deadline)return fallback('timeout',{probe:'skipped',level:'warn'});
        if(!recordCurrent(r,store)){index.vectors.delete(r.id);stale=true;}
    }
    if(stale){scheduleVectorMaintenance();return fallback('stale-source',{probe:'skipped',level:'warn'});}
    // New records and unindexed records are always eligible for ordinary recall.
    let vector=lastQuery===query?lastVector:null,vectorCache=vector?'hit':'miss',vectorOrigin=vector?'exact-query-cache':'none';
    const shouldWake=wakeAllowed(query,weakCoverage);
    if(!shouldWake){
        const dimensions=index.vectors.values().next().value?.vector.length,coveredRows=[...index.rows.values()].filter(row=>index.vectors.get(row.id)?.version===row.version);
        const covered=coveredRows.length>0&&vector?.length===dimensions;
        const enforce=['enabled','memory-pilot'].includes(c.mode)&&covered&&!!vector;
        if(enforce){
            let eligibleIds=new Set(ids);for(const row of coveredRows)if(index.residency.get(row.id)?.state==='SLEEPING')eligibleIds.delete(String(row.canonicalId));
            lastRecall={state:'vector-residency',reason:'probe-skipped-no-change',probeId,queryVectorAvailable:true,queryVectorCache:'hit'};
            logEvent('vector-paging','memory-wake-probe',{...traceBase,indexReady:memoryIndexReady(c),probe:'skipped',probeReason:'no-change-exact-query-cache',queryVector:{availability:'available',cache:'hit',foregroundAllowed:c.allowForegroundEmbedding===true},exclusionEnforced:true,ordinaryRetrieval:false,nominations:[],newlyAwakenedCount:0},'debug');notify();
            return {...ordinaryBase,eligibleIds,probeId,turn:traceBase.turn,sourceVersion:traceBase.sourceVersion,indexReady:memoryIndexReady(c)};
        }
        return fallback(c.mode==='shadow'?'observation-mode':'missing-query-vector',{probe:'skipped',vectorAvailability:vector?'available':'unavailable',vectorCache});
    }
    if(!vector&&c.allowForegroundEmbedding&&query.length<=c.maxTextChars&&c.endpoint&&c.model){
        const controller=new AbortController();let timeout;vectorOrigin='foreground';
        try{
            vector=await Promise.race([
                embedWithSession([query],c,{signal:controller.signal}).then(v=>v[0]),
                new Promise((_,reject)=>{timeout=setTimeout(()=>{controller.abort();const e=new Error('Wake budget expired; ordinary recall retained.');e.name='AbortError';reject(e);},Math.max(1,deadline-performance.now()));}),
            ]);
            lastError='';
        }catch(error){
            const reason=error?.name==='AbortError'||performance.now()>deadline?'timeout':'provider-failure';
            return fallback(reason,{probe:'executed',vectorAvailability:'unavailable',vectorCache:'miss',level:'warn',extra:{queryVector:{availability:'unavailable',cache:'miss',foregroundAllowed:true,attempted:true,reason}}});
        }finally{clearTimeout(timeout);controller.abort();}
    }
    if(token!==revision||scope!==identity()||epoch!==currentNexusChatEpoch()||profile!==embeddingProfile(cfg())||!usable())return fallback('stale-source',{probe:'executed',vectorAvailability:vector?'available':'unavailable',vectorCache,level:'warn'});
    for(const r of index.rows.values())if(performance.now()>deadline||!recordCurrent(r))return fallback(performance.now()>deadline?'timeout':'stale-source',{probe:'executed',vectorAvailability:vector?'available':'unavailable',vectorCache,level:'warn'});
    if(!vector)return fallback('missing-query-vector',{probe:'executed',vectorAvailability:'unavailable',vectorCache:'miss'});
    const before=new Map([...index.residency].map(([id,state])=>[id,state?.state||null]));
    lastWake=index.wake(query,vector,c,Date.now(),deadline);
    if(shouldWake)lastProbedQuery=query;
    if(performance.now()>deadline)return fallback('timeout',{probe:'executed',vectorAvailability:'available',vectorCache,level:'warn'});
    lastQuery=query;lastVector=vector;
    const nominated=index.warmedIds(c).map(id=>index.rows.get(id)).filter(Boolean).filter(r=>memoryRecordValidity(r.record,{store:rawStore(),chat:getContext()?.chat||[]}).valid).map(r=>JSON.parse(JSON.stringify(r.record)));
    const nominationDetails=lastWake.map(n=>{const row=index.rows.get(n.id);return {sourceId:String(row?.canonicalId??n.id),sourceVersion:row?.sourceStamp??row?.version??null,score:n.score,reason:n.reason,previousResidency:n.previousResidency??before.get(n.id)??null,newResidency:n.newResidency??index.residency.get(n.id)?.state??null,newlyAwakened:n.newlyAwakened===true};});
    const dimensions=index.vectors.values().next().value?.vector.length;
    const coveredRows=[...index.rows.values()].filter(row=>index.vectors.get(row.id)?.version===row.version);
    const covered=coveredRows.length>0&&vector?.length===dimensions;
    // Paging authority is per covered row. Unindexed/oversized/overflow records
    // remain ordinary-eligible while covered historical rows may sleep safely.
    const enforce=['enabled','memory-pilot'].includes(c.mode)&&covered&&!!vector;
    let eligibleIds=null;
    if(enforce){
        eligibleIds=new Set(ids);
        for(const row of coveredRows){const residency=index.residency.get(row.id);if(residency?.state==='SLEEPING')eligibleIds.delete(String(row.canonicalId));}
    }
    const fallbackReason=c.mode==='shadow'?'observation-mode':enforce?null:'index-not-ready';
    lastRecall={state:enforce?'vector-residency':'ordinary',reason:fallbackReason,probeId,queryVectorAvailable:true,queryVectorCache:vectorCache};
    logEvent('vector-paging','memory-wake-probe',{...traceBase,indexReady:memoryIndexReady(c),probe:'executed',probeReason:weakCoverage?'weak-coverage':'query-or-gate-change',queryVector:{availability:'available',cache:vectorCache,origin:vectorOrigin,foregroundAllowed:c.allowForegroundEmbedding===true,attempted:vectorOrigin==='foreground'},exclusionEnforced:enforce,ordinaryRetrieval:!enforce,fallbackReason,nominations:nominationDetails,newlyAwakenedCount:nominationDetails.filter(n=>n.newlyAwakened).length},'info');
    notify();
    return {eligibleIds,nominated:['enabled','memory-pilot'].includes(c.mode)?nominated:[],nominationDetails,probeId,turn:traceBase.turn,sourceVersion:traceBase.sourceVersion,mode:c.mode,fallbackReason,indexReady:memoryIndexReady(c)};
}
export function markMemoryPagingUsed(records){if(usable())index.used(records.map(r=>String(r.id)),cfg());notify();}
export function initVectorPaging(eventSource,eventTypes){
    const subscriptions=[];
    const on=(type,handler)=>{eventSource.on(type,handler);subscriptions.push([type,handler]);};
    for(const name of ['GENERATION_ENDED','GENERATION_STOPPED','MESSAGE_RECEIVED'])if(eventTypes[name])on(eventTypes[name],scheduleVectorMaintenance);
    if(eventTypes.GENERATION_STARTED){const handler=()=>{backgroundAbort?.abort();};on(eventTypes.GENERATION_STARTED,handler);}
    for(const name of ['CHAT_CHANGED','MESSAGE_EDITED','MESSAGE_SWIPED','MESSAGE_DELETED'])if(eventTypes[name]){const handler=()=>invalidateVectorPaging(name);on(eventTypes[name],handler);}
    const windowHandler=scheduleVectorMaintenance;
    globalThis.window?.addEventListener('tv2-memory-bank-updated',windowHandler);
    scheduleVectorMaintenance();
    return ()=>{
        revision++;backgroundAbort?.abort();
        if(timer)clearTimeout(timer);timer=null;
        for(const [type,handler] of subscriptions){try{if(typeof eventSource.off==='function')eventSource.off(type,handler);else eventSource.removeListener?.(type,handler);}catch{}}
        try{globalThis.window?.removeEventListener('tv2-memory-bank-updated',windowHandler);}catch{}
    };
}
