import { getContext } from '../../../../st-context.js';
import { getSettings } from '../core/settings.js';
import { captureLoreCorpus } from '../lore/corpus-authority.js';
import { loadBook } from '../lore/store.js';
import { getTree } from '../tree/store.js';
import { getPinnedRefs, getWarmCandidates } from '../smart-context/warmer.js';
import { getNexusMutationLockSnapshot } from '../nexus/mutation-lock.js';
import { currentNexusChatEpoch, currentNexusForegroundGenerationId } from '../nexus/work-scope.js';
import { pagingConfig } from './policy.js';
import { embedWithSession } from './embeddings.js';
import { readVectorCache } from './cache.js';
import { readLoreVectorCache, writeLoreVectorCache } from './lore-cache.js';
import { embeddingProfile } from './embeddings.js';
import { LorePaging, loreEntryId } from './lore-paging.js';
import { unresolvedLoreProposalProtections } from './lore-protections.js';
import { nextLorePagingDelay } from './retry-policy.js';
import { logEvent } from '../observability/telemetry.js';
import { isNarrativeSceneMessage } from '../retrieval/handoff-policy.js';

let timer=null,loreSourceRevision=1,retryStreak=0,nextRetryAt=0,providerBlocked=null;
const config=()=>pagingConfig(getSettings().vectorPaging);
function notify(){globalThis.window?.dispatchEvent(new CustomEvent('nexus-vector-paging-updated'));}
const corpus=()=>captureLoreCorpus({purpose:getContext()?.chatId!=null||getContext()?.chat_id!=null?'story':'maintenance',requireTree:false,access:'read',injection:'tv2'});
const books=()=>[...corpus().books];
const service=new LorePaging({
    config,books,loadBook,tree:getTree,embed:embedWithSession,notify,sourceRevision:()=>loreSourceRevision,
    log:(name,data,level='debug')=>logEvent('vector-paging',name,data,level),
    traceContext:()=>({chatId:getContext()?.chatId??null,epoch:currentNexusChatEpoch(),generationId:currentNexusForegroundGenerationId(),turn:getContext()?.chat?.length||0}),
    loadCache:async key=>{
        const cached=await readLoreVectorCache(key);if(cached)return cached;
        // Reuse compatible vectors from the previous package's current-scope
        // cache once, then save them in separate book/profile records.
        const legacyScope=JSON.stringify([getContext()?.chatId,getContext()?.groupId,getContext()?.characterId,books().slice().sort()]);
        return readVectorCache(JSON.stringify([legacyScope,embeddingProfile(config())]),'lore');
    },
    saveCache:(key,rows,options)=>writeLoreVectorCache(key,rows,{...options,budgetMiB:config().loreCacheMiB}),
    enabled:()=>getSettings().enabled&&books().length>0,
    scope:()=>getContext()?.chatId!=null?JSON.stringify(['chat',getContext()?.chatId,getContext()?.groupId,getContext()?.characterId,currentNexusChatEpoch()]):JSON.stringify(['lorebook-maintenance',books().slice().sort()]),
    query:()=>getContext()?.chatId!=null?String((getContext()?.chat||[]).findLast(isNarrativeSceneMessage)?.mes||''):'',
    foreground:()=>currentNexusForegroundGenerationId()!=null,
    protections:()=>{
        const refs=[...getPinnedRefs(),...getWarmCandidates()];
        const result=new Set(refs.map(r=>loreEntryId(r.book,r.uid)));
        const held=getNexusMutationLockSnapshot();
        for(const book of books())if(held.some(key=>['lorebook:','tree:','lore:'].some(prefix=>key===prefix+book)))result.add(book);
        // Unresolved proposals protect only their actual entry/subtree participants
        // when that scope is knowable. Full Tree replacement/deletion remains book-wide.
        for(const ref of unresolvedLoreProposalProtections(getContext()?.chatMetadata?.tv2_lore_proposals_v1||[],getTree))result.add(ref);
        return result;
    },
});
export const lorePagingStatus=()=>{const authority=corpus();return {...service.snapshot(),books:[...authority.books],bookCount:authority.books.length,corpusSource:authority.source,corpusFingerprint:authority.fingerprint,retrying:retryStreak>0,retryStreak,nextRetryAt:nextRetryAt||null,providerError:providerBlocked};};
export function loreEntryResidencyStatus(book,uid){const entry=service.entries.get(loreEntryId(book,uid));return entry?service.entryResidency(entry):'UNKNOWN';}
export const prepareLorePaging=options=>service.prepare(options);
export const markLorePagingUsed=(refs,options)=>service.used(refs,options);
export function coolLorePaging(){return service.cool();}
export function invalidateLorePaging(reason='source-changed',{resetProvider=false,schedule=true}={}){loreSourceRevision++;retryStreak=0;nextRetryAt=0;if(resetProvider)providerBlocked=null;service.reset();if(schedule)scheduleLorePaging(2000,{force:true});notify();}
export function retryLorePagingProvider(){providerBlocked=null;retryStreak=0;nextRetryAt=0;notify();}
export async function maintainLorePaging(){
    await service.maintain();
    const snap=service.snapshot(),pendingCount=service.index.pending(config()).length;
    const next=nextLorePagingDelay({pendingCount,reason:snap.reason,retryStreak});
    retryStreak=next.retryStreak;nextRetryAt=next.delayMs==null?0:Date.now()+next.delayMs;
    if(next.state==='provider-error'){
        providerBlocked=String(snap.reason||'Embedding provider unavailable.');
        if(timer)clearTimeout(timer);timer=null;
        logEvent('vector-paging','lore-index-provider-error',{reason:providerBlocked,pendingCount,automaticRetry:false},'warn');
    }else{
        if(next.state==='ready'||next.state==='indexing')providerBlocked=null;
        if(next.state==='retrying')logEvent('vector-paging','lore-index-retry-scheduled',{reason:snap.reason,pendingCount,retryStreak,delayMs:next.delayMs},'warn');
        else if(next.state==='paused'&&pendingCount)logEvent('vector-paging','lore-index-paused',{reason:snap.reason,pendingCount},'debug');
    }
    if(next.delayMs!=null)scheduleLorePaging(next.delayMs,{force:true});
    notify();
}
function scheduleLorePaging(delay=2000,{force=false}={}){
    clearTimeout(timer);timer=null;
    if(!service.enabled()||getSettings().scheduler?.enabled===false||providerBlocked)return;
    let wait=Math.max(1000,Number(delay)||2000);
    if(!force&&nextRetryAt>Date.now())wait=Math.max(wait,nextRetryAt-Date.now());
    timer=setTimeout(()=>{timer=null;if(providerBlocked)return;void maintainLorePaging();},wait);
}

export function initLorePaging(events,types){
    const subscriptions=[],windowSubscriptions=[];
    const on=(type,handler)=>{events.on(type,handler);subscriptions.push([type,handler]);};
    const onWindow=(type,handler)=>{globalThis.window?.addEventListener(type,handler);windowSubscriptions.push([type,handler]);};
    for(const name of ['GENERATION_ENDED','GENERATION_STOPPED','MESSAGE_RECEIVED'])if(types[name]){const handler=()=>scheduleLorePaging();on(types[name],handler);}
    if(types.GENERATION_STARTED){const handler=()=>service.controller?.abort();on(types.GENERATION_STARTED,handler);}
    for(const name of ['CHAT_CHANGED','MESSAGE_EDITED','MESSAGE_SWIPED','MESSAGE_DELETED','WORLDINFO_UPDATED','WORLDINFO_SETTINGS_UPDATED'])if(types[name]){const handler=()=>invalidateLorePaging(name);on(types[name],handler);}
    onWindow('nexus-tree-routing-updated',()=>invalidateLorePaging('tree-routing-updated'));
    onWindow('nexus-lore-source-updated',()=>invalidateLorePaging('lore-source-updated'));
    onWindow('nexus-paging-invalidated',()=>invalidateLorePaging('paging-invalidated'));
    scheduleLorePaging();
    return ()=>{
        if(timer)clearTimeout(timer);timer=null;service.controller?.abort();
        for(const [type,handler] of subscriptions){try{if(typeof events.off==='function')events.off(type,handler);else events.removeListener?.(type,handler);}catch{}}
        for(const [type,handler] of windowSubscriptions){try{globalThis.window?.removeEventListener(type,handler);}catch{}}
    };
}
