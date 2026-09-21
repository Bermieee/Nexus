import { ResidencyIndex } from './engine.js';
import { embeddingProfile } from './embeddings.js';
import { selectContinuableUnits } from '../nexus/continuable-work.js';
import { createAdaptiveProfileKey, recommendAdaptiveBatchSize, recordThroughputSample } from '../nexus/adaptive-throughput.js';

export const loreEntryId=(book,uid)=>JSON.stringify([String(book),Number(uid)]);
export const loreRegionId=(book,nodeId)=>JSON.stringify([String(book),String(nodeId)]);
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
function embeddingEndpointHost(config={}){try{return new URL(config.endpoint).host||'embedding';}catch{return 'embedding';}}
function loreEmbeddingAdaptiveKey(config={}){return createAdaptiveProfileKey({workloadType:'vector:lore-index',provider:'embedding',profile:`${embeddingEndpointHost(config)}|maxChars:${Math.max(0,Number(config.maxTextChars)||0)}`,model:config.model||'unknown',worker:'EMBEDDING',contractVersion:'hf46-v1'});}
async function hash(value){const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value));return Array.from(new Uint8Array(bytes),x=>x.toString(16).padStart(2,'0')).join('');}
function failureReason(error,deadlineExpired=false){
    if(deadlineExpired||error?.name==='AbortError')return 'timeout';
    const text=String(error?.message||error||'').toLowerCase();
    if(/\b(?:401|403|4\d\d|5\d\d)\b/.test(text)||text.includes('provider')||text.includes('embedding request failed'))return 'provider-failure';
    return 'provider-failure';
}

// One adapter for every permitted lorebook. Content stays in its original store.
// Chunks are index inputs only; retrieval always resolves complete live entries.
export class LorePaging {
    constructor(host){this.host=host;this.index=new ResidencyIndex();this.sources=new Map();this.entries=new Map();this.bookFailures=new Map();this.revision=0;this.running=null;this.controller=null;this.query='';this.vector=null;this.lastProbe='';this.hydratedBooks=new Set();this.probeSeq=0;this.probeTraces=new Map();this.last={reason:'not-indexed',nominated:0,liveRecallState:'not-run',liveRecallReason:null};}
    reset(){this.revision++;this.controller?.abort();this.index.reset('','');this.sources.clear();this.entries.clear();this.bookFailures.clear();this.query='';this.vector=null;this.lastProbe='';this.hydratedBooks.clear();this.probeTraces.clear();this.last={reason:'not-indexed',nominated:0,liveRecallState:'not-run',liveRecallReason:null};}
    enabled(c=this.host.config()){return this.host.enabled()&&['enabled','shadow'].includes(c.mode);}
    scope(){return JSON.stringify([this.host.scope(),this.host.books().slice().sort()]);}
    valid(token,scope,profile,mode=null){const live=this.host.config();return token===this.revision&&scope===this.scope()&&profile===embeddingProfile(live)&&this.enabled(live)&&(mode==null||String(live.mode)===String(mode));}
    indexReady(c=this.host.config()){return this.index.active&&this.index.rows.size>0&&this.index.pending(c).length===0&&this.bookFailures.size===0;}
    snapshot(){let sleeping=0,indexed=0,protectedEntries=0,protectedChunks=0;for(const e of this.entries.values()){if(e.chunks.length===e.chunkCount&&e.chunks.every(id=>this.index.vectors.has(id)))indexed++;if(this.asleep(e))sleeping++;if(e.chunks.some(id=>this.index.rows.get(id)?.protected))protectedEntries++;}for(const r of this.index.rows.values())if(r.protected)protectedChunks++;return {...this.index.snapshot(),total:this.entries.size,indexed,chunks:this.index.rows.size,indexedChunks:this.index.vectors.size,SLEEPING:sleeping,protectedEntries,protectedChunks,failedBooks:this.bookFailures.size,indexReady:this.indexReady(),physicalStorageState:'canonical-content-resident',physicalUnloadedEntries:0,...this.last,busy:!!this.running};}
    asleep(e){return e.chunkCount>0&&e.chunks.length===e.chunkCount&&e.chunks.every(id=>this.index.vectors.has(id)&&this.index.residency.get(id)?.state==='SLEEPING');}
    entryResidency(e){
        if(!e?.chunks?.length||e.chunks.length!==e.chunkCount||!e.chunks.every(id=>this.index.vectors.has(id)))return 'UNINDEXED_RESIDENT';
        const states=e.chunks.map(id=>this.index.residency.get(id)?.state||'WARM');
        if(states.every(x=>x==='SLEEPING'))return 'SLEEPING';
        if(states.some(x=>x==='ACTIVE'))return 'ACTIVE';
        return 'WARM';
    }
    protections(){return this.host.protections?.()||new Set();}
    applyProtections(){const p=this.protections();for(const r of this.index.rows.values()){r.protected=r.constant||p.has(r.canonicalId)||p.has(r.book);if(r.protected)this.index.residency.get(r.id).state='ACTIVE';}}
    cool(){
        const before=new Map([...this.entries].map(([id,e])=>[id,this.entryResidency(e)]));
        this.applyProtections();
        for(const [id,s] of this.index.residency)if(!this.index.rows.get(id).protected)s.until=0;
        this.index.rebalance(this.host.config());
        let slept=0,alreadySleeping=0,protectedEntries=0,budgetResident=0,unindexedResident=0;
        for(const [id,e] of this.entries){
            const after=this.entryResidency(e),was=before.get(id);
            const protectedEntry=e.chunks.some(chunk=>this.index.rows.get(chunk)?.protected);
            if(after==='SLEEPING'){if(was==='SLEEPING')alreadySleeping++;else slept++;continue;}
            if(protectedEntry){protectedEntries++;continue;}
            if(after==='UNINDEXED_RESIDENT')unindexedResident++;else budgetResident++;
        }
        const result={
            logical:true,physicalStorageState:'canonical-content-resident',physicalUnloadedEntries:0,
            entriesSlept:slept,entriesAlreadySleeping:alreadySleeping,protectedEntries,budgetResidentEntries:budgetResident,unindexedResidentEntries:unindexedResident,
            before:Object.fromEntries([...before.values()].reduce((m,state)=>m.set(state,(m.get(state)||0)+1),new Map())),
            after:Object.fromEntries([...this.entries.values()].map(e=>this.entryResidency(e)).reduce((m,state)=>m.set(state,(m.get(state)||0)+1),new Map())),
        };
        const reason=slept>0?'cooled':protectedEntries>0&&budgetResident===0&&unindexedResident===0?'cooling-blocked-protected':'cooled-no-transition';
        this.last={...this.last,reason,cooledAt:Date.now(),cooling:result};
        this.host.log?.('lore-cooling-result',result,'info');this.host.notify?.();return result;
    }
    rememberTrace(trace){this.probeTraces.set(trace.probeId,trace);while(this.probeTraces.size>24)this.probeTraces.delete(this.probeTraces.keys().next().value);}
    used(refs,{probeId=null,stage='retrieval',selectedRefs=null}={}){
        const ids=new Set((refs||[]).map(r=>loreEntryId(r.book,r.uid)));this.index.used([...this.index.rows.values()].filter(r=>ids.has(r.canonicalId)).map(r=>r.id),this.host.config());this.last.injected=refs.length;
        const trace=probeId?this.probeTraces.get(probeId):null;
        if(trace){
            const entered=[...trace.nominations].filter(id=>ids.has(id));
            const selectedIds=new Set((selectedRefs||[]).map(r=>loreEntryId(r.book,r.uid)));
            const passed=selectedRefs?[...trace.nominations].filter(id=>selectedIds.has(id)):(Array.isArray(trace.passedRetrieval)?trace.passedRetrieval:entered);
            this.host.log?.('lore-wake-outcome',{probeId,requestId:trace.requestId,turn:trace.turn,sourceVersions:trace.sourceVersions,stage,nominatedCount:trace.nominations.size,passedRetrievalCount:passed.length,passedRetrievalSourceIds:passed,enteredInjectionCount:entered.length,enteredInjectionSourceIds:entered},'info');
        }
        this.host.notify?.();
    }
    sourceToken(book){return String(this.host.sourceRevision?.(book)??this.revision);}
    async load(books){
        const result=new Map();this.bookFailures.clear();
        for(const book of books){try{result.set(book,await this.host.loadBook(book));}catch(error){this.bookFailures.set(book,error);}}
        return result;
    }
    async sourceMatches(books,data=null){
        // Foreground validation is a cheap revision fence. WORLDINFO and semantic
        // Tree-routing events invalidate/revision the service; no full book reload
        // or corpus JSON serialization occurs on the generation path.
        for(const book of books)if(this.sources.has(book)&&this.sources.get(book)!==this.sourceToken(book))return false;
        return true;
    }
    async maintain(){
        if(this.running)return this.running;
        const c=this.host.config();if(!this.enabled(c)||this.host.foreground())return;
        const token=this.revision,scope=this.scope(),profile=embeddingProfile(c),books=this.host.books();
        this.running=(async()=>{
            const data=await this.load(books);if(!this.valid(token,scope,profile)||this.host.foreground())return;
            const rows=[],entries=new Map(),sources=new Map(),protect=this.protections(),candidatesByBook=new Map();
            for(const book of books){
                if(!data.has(book))continue; // failed book remains ordinary/fail-open
                sources.set(book,this.sourceToken(book));
                const seen=new Set(),candidates=[];
                for(const entry of Object.values(data.get(book)?.entries||{})){
                    if(entry?.disable===true||!String(entry?.content||'').trim()||entry.uid==null||!Number.isFinite(Number(entry.uid)))continue;
                    const id=loreEntryId(book,entry.uid);
                    if(seen.has(id)){this.bookFailures.set(book,new Error(`Duplicate lore UID ${entry.uid}; this book remains ordinary.`));candidates.length=0;break;}
                    seen.add(id);
                    const text=[entry.comment||entry.title||'',...(Array.isArray(entry.key)?entry.key:[]),...(Array.isArray(entry.keysecondary)?entry.keysecondary:[]),entry.content].join('\n');
                    const textCodepoints=Array.from(text);const count=Math.ceil(textCodepoints.length/c.maxTextChars);
                    const prior=this.entries.get(id),priorRow=prior&&this.index.rows.get(prior.chunks[0]);
                    const unchanged=this.index.profile===profile&&this.sources.get(book)===sources.get(book);
                    const version=unchanged&&priorRow?priorRow.version:await hash(JSON.stringify({uid:Number(entry.uid),comment:entry.comment||entry.title||'',key:entry.key||[],keysecondary:entry.keysecondary||[],content:entry.content||''}));
                    candidates.push({book,entry,id,text,textCodepoints,count,version});
                }
                if(!this.bookFailures.has(book))candidatesByBook.set(book,candidates);
            }
            // Fair deterministic allocation. First give every healthy book an
            // equal floor, then share unused capacity round-robin. An entry is
            // either fully represented or consumes zero chunk slots.
            const healthyBooks=books.filter(book=>candidatesByBook.has(book));
            const limit=Math.max(0,Number(c.indexLimit)||0),floor=healthyBooks.length?Math.floor(limit/healthyBooks.length):0;
            const allocated=new Set();
            const appendCandidate=candidate=>{
                const {book,entry,id,textCodepoints,count,version}=candidate,chunks=[];
                for(let n=0;n<count;n++){
                    const chunkId=JSON.stringify([book,Number(entry.uid),n]);chunks.push(chunkId);
                    rows.push({id:chunkId,canonicalId:id,book,uid:Number(entry.uid),kind:'lore',version,text:textCodepoints.slice(n*c.maxTextChars,(n+1)*c.maxTextChars).join(''),aliases:[entry.comment||entry.title,...(Array.isArray(entry.key)?entry.key:[])].filter(x=>typeof x==='string'),constant:entry.constant===true,protected:entry.constant===true||protect.has(id)||protect.has(book),recency:0});
                }
                entries.set(id,{book,uid:Number(entry.uid),chunks,chunkCount:count});allocated.add(id);return count;
            };
            let remaining=limit;
            for(const book of healthyBooks){
                let used=0;
                for(const candidate of candidatesByBook.get(book)||[]){
                    if(candidate.count<=Math.max(0,floor-used)&&candidate.count<=remaining){used+=appendCandidate(candidate);remaining-=candidate.count;}
                }
            }
            // Unused floor capacity is shared without input-order monopoly.
            let progress=true;
            while(remaining>0&&progress){
                progress=false;
                for(const book of healthyBooks){
                    const candidate=(candidatesByBook.get(book)||[]).find(row=>!allocated.has(row.id)&&row.count<=remaining);
                    if(!candidate)continue;
                    remaining-=appendCandidate(candidate);progress=true;
                    if(remaining<=0)break;
                }
            }
            // Preserve ordinary eligibility metadata for unallocated candidates;
            // they have no paging authority and therefore can never sleep.
            for(const [book,candidates] of candidatesByBook){
                for(const candidate of candidates){if(!entries.has(candidate.id))entries.set(candidate.id,{book,uid:Number(candidate.entry.uid),chunks:[],chunkCount:candidate.count});}
            }
            if(!this.valid(token,scope,profile)||this.host.foreground())return;
            if(scope!==this.index.scope||profile!==this.index.profile){this.hydratedBooks.clear();this.query='';this.vector=null;this.lastProbe='';}
            this.index.reconcile(rows,{scope,profile,turns:0,config:c,activation:{active:rows.length>0,reason:rows.length?'lore-available':'empty-lore'}});
            this.sources=sources;this.entries=entries;
            const cacheKeys=new Map(books.map(book=>[book,JSON.stringify(['lore-book-v1',String(book),profile])]));
            for(const [book,key] of cacheKeys){
                if(!this.host.loadCache||this.hydratedBooks.has(key))continue;
                try{
                    const saved=await this.host.loadCache(key);
                    if(!this.valid(token,scope,profile)||this.host.foreground())return;
                    this.index.restoreVectors(Array.isArray(saved)?saved.filter(row=>this.index.rows.get(row?.id)?.book===book):[]);
                    this.hydratedBooks.add(key);
                }catch{/* Derived cache failure never removes ordinary lore. */}
            }
            if(!c.endpoint||!c.model){this.last.reason='configure-embedding-service';return;}
            const controller=new AbortController();this.controller=controller;
            const timeout=setTimeout(()=>controller.abort(),10000);
            try{
                const pendingAll=this.index.pending({...c,batchSize:32});
                const adaptiveProfileKey=loreEmbeddingAdaptiveKey(c);
                const adaptiveBatchSize=recommendAdaptiveBatchSize({profileKey:adaptiveProfileKey,currentSize:c.batchSize,minSize:1,maxSize:32,remainingItems:pendingAll.length,availableWindowMs:8000});
                const pending=selectContinuableUnits(pendingAll,adaptiveBatchSize);
                if(pending.length){
                    this.host.log?.('lore-index-slice-start',{pendingTotal:pendingAll.length,sliceSize:pending.length,configuredBatchSize:c.batchSize,adaptiveBatchSize,sourceRevision:token},'debug');
                    const started=globalThis.performance?.now?.()??Date.now();
                    let vectors;
                    try{
                        vectors=await this.host.embed(pending.map(r=>r.text),c,{signal:controller.signal});
                        const elapsed=(globalThis.performance?.now?.()??Date.now())-started;
                        recordThroughputSample({profileKey:adaptiveProfileKey,batchSize:pending.length,successfulItems:pending.length,latencyMs:elapsed,outcome:'success',inputTokens:pending.reduce((sum,row)=>sum+Math.max(1,Math.ceil(String(row.text||'').length/4)),0)});
                    }catch(error){
                        const elapsed=(globalThis.performance?.now?.()??Date.now())-started;
                        if(!this.host.foreground()&&elapsed>=9500)recordThroughputSample({profileKey:adaptiveProfileKey,batchSize:pending.length,successfulItems:0,latencyMs:elapsed,outcome:'timeout'});
                        else if(!controller.signal.aborted)recordThroughputSample({profileKey:adaptiveProfileKey,batchSize:pending.length,successfulItems:0,latencyMs:elapsed,outcome:'failure'});
                        throw error;
                    }
                    if(controller.signal.aborted||!this.valid(token,scope,profile)||this.host.foreground())return;
                    if(!await this.sourceMatches(books)){this.last.reason='source-changed';return;}
                    if(!this.valid(token,scope,profile)||this.host.foreground())return;
                    pending.forEach((r,i)=>this.index.put(r.id,r.version,vectors[i]));
                    this.host.log?.('lore-index-slice-complete',{completedUnits:pending.length,remainingUnits:this.index.pending({...c,batchSize:32}).length,adaptiveBatchSize,sourceRevision:token},'debug');
                }
                // Background query-vector caching is opportunistic only. It is exact-text
                // keyed and never implies that a future user query is already vector-ready.
                const query=this.host.query();
                if(query&&query.length<=c.maxTextChars&&(query!==this.query||!this.vector)){
                    const [vector]=await this.host.embed([query],c,{signal:controller.signal});
                    if(!controller.signal.aborted&&this.valid(token,scope,profile)&&!this.host.foreground()&&query===this.host.query()){this.query=query;this.vector=vector;}
                }
                this.applyProtections();this.index.rebalance(c);this.last.reason=this.index.pending(c).length?'indexing':'ready';
                if(this.host.saveCache){
                    const groups=new Map(books.map(book=>[book,[]]));
                    for(const row of this.index.exportVectors())groups.get(this.index.rows.get(row.id)?.book)?.push(row);
                    for(const [book,vectors] of groups){
                        if(!this.valid(token,scope,profile)||this.host.foreground())return;
                        const liveEntryIds=[...this.entries].filter(([,entry])=>entry.book===book).map(([id])=>id);
                        try{await this.host.saveCache(cacheKeys.get(book),vectors,{liveEntryIds});}catch{this.last.reason='ready-cache-unavailable';}
                    }
                }
            }finally{clearTimeout(timeout);if(this.controller===controller)this.controller=null;}
        })().catch(error=>{this.last.reason=error?.name==='AbortError'?'indexing-paused':String(error?.message||'index-unavailable');})
          .finally(()=>{this.running=null;this.host.notify?.();});
        return this.running;
    }
    async prepare({books=this.host.books(),bookData=null,gate=null,weakCoverage=false,requestId=null}={}){
        const c=this.host.config(),context=this.host.traceContext?.()||{},token=this.revision,scope=this.scope(),profile=embeddingProfile(c),mode=c.mode,query=this.host.query();
        const probeId=`lore-wake-${context.epoch??'na'}-${context.generationId??requestId??'none'}-${++this.probeSeq}`;
        const sourceVersions=Object.fromEntries(books.map(book=>[String(book),this.sourceToken(book)]));
        const queryFingerprint=query?`${(await hash(query)).slice(0,16)}:${Array.from(query).length}`:null;
        const traceBase={probeId,requestId:requestId??context.generationId??null,turn:context.turn??null,chatEpoch:context.epoch??null,sourceVersions,mode:c.mode,queryFingerprint};
        const ordinaryBase={eligibleIds:null,eligibleRegions:null,warmedRegions:[],nominated:[],nominationDetails:[],mode:c.mode,requiresRefresh:false,degraded:false,probeId,turn:traceBase.turn,sourceVersions,validate:async()=>true};
        const hadPriorProbe=!!this.lastProbe;
        const startedAt=performance.now();
        const cachedVector=this.query===query?this.vector:null;
        // A cached query vector means the provider is already out of the path.
        // Give the bounded local residency scan enough wall-clock headroom to
        // survive browser/UI contention without turning an otherwise healthy
        // cache hit into a false vector timeout. Foreground embedding misses keep
        // the operator-configured deadline unchanged.
        const configuredBudgetMs=Math.max(1,Number(c.foregroundBudgetMs)||1);
        const activeBudgetMs=cachedVector
            ? Math.min(1000,Math.max(configuredBudgetMs,250,configuredBudgetMs*2))
            : configuredBudgetMs;
        const deadline=startedAt+activeBudgetMs;
        let stage='admission';
        const wakeDiagnostics={rowsTotal:this.index.rows.size,rowsScanned:0,vectorDimensions:cachedVector?.length||0,deadlineExceeded:false};
        const timing=()=>({
            stage,
            elapsedMs:Math.round((performance.now()-startedAt)*10)/10,
            configuredBudgetMs,
            activeBudgetMs,
            cachedVectorBudgetExtended:!!cachedVector&&activeBudgetMs>configuredBudgetMs,
            rowsTotal:Number(wakeDiagnostics.rowsTotal)||0,
            rowsScanned:Number(wakeDiagnostics.rowsScanned)||0,
            vectorDimensions:Number(wakeDiagnostics.vectorDimensions)||0,
            deadlineExceeded:wakeDiagnostics.deadlineExceeded===true||performance.now()>deadline,
        });
        let fallbackResult=null;
        const recordFallback=(reason,{probe='skipped',vectorAvailability='unavailable',vectorCache='miss',level='debug',indexReady=this.indexReady(c),requiresRefresh=false,extra={}}={})=>{
            if(fallbackResult)return fallbackResult;
            const lastReason=reason==='observation-mode'?'observe-only':reason==='disabled'?'disabled':reason;
            const probeTiming=timing();
            this.last={...this.last,reason:lastReason,liveRecallState:'ordinary',liveRecallReason:reason,lastProbeId:probeId,queryVectorAvailable:vectorAvailability==='available',queryVectorCache:vectorCache,indexReady,probeTiming};
            this.host.log?.('lore-wake-probe',{...traceBase,indexReady,probe,probeReason:reason,queryVector:{availability:vectorAvailability,cache:vectorCache,foregroundAllowed:c.allowForegroundEmbedding===true},exclusionEnforced:false,ordinaryRetrieval:true,fallbackReason:reason,timing:probeTiming,...extra},level);
            fallbackResult={...ordinaryBase,fallbackReason:reason,indexReady,requiresRefresh:requiresRefresh===true,degraded:requiresRefresh===true,probeTiming};
            this.host.notify?.();return fallbackResult;
        };
        if(!this.enabled(c))return recordFallback('disabled',{probe:'skipped'});
        if(scope!==this.index.scope||profile!==this.index.profile||!this.index.active)return recordFallback('index-not-ready',{probe:'skipped',indexReady:false});
        const callback=/\b(remember|back then|earlier|used to|return|revisit|recuerda|recordar|antes|volver|regresar)\b/i.test(query)||/[思想]い出|思い出|以前|戻|记得|記得|回想|以前/u.test(query);
        const shouldWake=!this.lastProbe||query!==this.lastProbe||weakCoverage||callback||gate?.mode!=='NO_CHANGE';
        const controller=new AbortController();let timeout;
        if(!shouldWake){
            const vector=this.query===query?this.vector:null;
            const covered=!!vector&&this.index.vectors.size>0;
            if(c.mode==='enabled'&&covered){
                this.applyProtections();this.index.rebalance(c);
                const eligible=new Set([...this.entries].filter(([,e])=>!this.asleep(e)).map(([id])=>id));
                this.last={...this.last,reason:'probe-skipped-no-change',liveRecallState:'vector-residency',liveRecallReason:null,lastProbeId:probeId,queryVectorAvailable:true,queryVectorCache:'hit',enforced:true,eligible:eligible.size};
                this.host.log?.('lore-wake-probe',{...traceBase,indexReady:this.indexReady(c),probe:'skipped',probeReason:'no-change-exact-query-cache',queryVector:{availability:'available',cache:'hit',foregroundAllowed:c.allowForegroundEmbedding===true},exclusionEnforced:true,ordinaryRetrieval:false,nominations:[],newlyAwakenedCount:0},'debug');
                this.host.notify?.();return {...ordinaryBase,eligibleIds:eligible,mode:c.mode,indexReady:this.indexReady(c)};
            }
            return recordFallback(c.mode==='shadow'?'observation-mode':'missing-query-vector',{probe:'skipped',vectorAvailability:vector?'available':'unavailable',vectorCache:vector?'hit':'miss'});
        }
        try{
            return await Promise.race([(async()=>{
                stage='source-validation';
                if(!await this.sourceMatches(books,bookData))return recordFallback('stale-source',{probe:'executed',level:'warn',requiresRefresh:c.mode==='enabled'});
                stage='query-vector';
                let vector=cachedVector,vectorCache=vector?'hit':'miss',vectorOrigin=vector?'exact-query-cache':'none';
                if(!vector&&c.allowForegroundEmbedding&&query&&query.length<=c.maxTextChars){
                    vectorOrigin='foreground';
                    try{
                        stage='foreground-embedding';
                        [vector]=await this.host.embed([query],c,{signal:controller.signal});
                        vectorCache='miss';
                        wakeDiagnostics.vectorDimensions=vector?.length||0;
                    }catch(error){
                        const reason=failureReason(error,controller.signal.aborted||performance.now()>deadline);
                        return recordFallback(reason,{probe:'executed',vectorAvailability:'unavailable',vectorCache:'miss',level:reason==='timeout'?'warn':'warn',requiresRefresh:c.mode==='enabled',extra:{queryVector:{availability:'unavailable',cache:'miss',foregroundAllowed:true,attempted:true,reason}}});
                    }
                }
                if(controller.signal.aborted||performance.now()>deadline)return recordFallback('timeout',{probe:'executed',vectorAvailability:vector?'available':'unavailable',vectorCache,level:'warn',requiresRefresh:c.mode==='enabled'});
                if(!this.valid(token,scope,profile,mode)||query!==this.host.query())return recordFallback('stale-source',{probe:'executed',vectorAvailability:vector?'available':'unavailable',vectorCache,level:'warn',requiresRefresh:c.mode==='enabled'});
                // Embedding can await a provider; re-read exact source before exclusion.
                stage='post-vector-source-validation';
                if(!await this.sourceMatches(books)||!this.valid(token,scope,profile,mode)||query!==this.host.query()||controller.signal.aborted)return recordFallback('stale-source',{probe:'executed',vectorAvailability:vector?'available':'unavailable',vectorCache,level:'warn',requiresRefresh:c.mode==='enabled'});
                if(performance.now()>deadline)return recordFallback('timeout',{probe:'executed',vectorAvailability:vector?'available':'unavailable',vectorCache,level:'warn',requiresRefresh:c.mode==='enabled'});
                stage='residency-rebalance';
                this.applyProtections();this.index.rebalance(c);
                const previousResidency=new Map([...this.entries].map(([id,e])=>[id,this.entryResidency(e)]));
                const beforeSleeping=new Set([...previousResidency].filter(([,state])=>state==='SLEEPING').map(([id])=>id));
                // ResidencyIndex has a hardened exact/canonical alias path that does
                // not require semantic-vector similarity. Keep that path reachable.
                const explicitOnly=!vector;
                stage='vector-scan';
                const wake=this.index.wake(query,vector,c,Date.now(),deadline,wakeDiagnostics);
                if(explicitOnly&&!wake.length)return recordFallback('missing-query-vector',{probe:'executed',vectorAvailability:'unavailable',vectorCache:'miss',requiresRefresh:c.mode==='enabled'});
                if(performance.now()>deadline)return recordFallback('timeout',{probe:'executed',vectorAvailability:vector?'available':'unavailable',vectorCache,level:'warn',requiresRefresh:c.mode==='enabled'});
                this.lastProbe=query;this.query=query;if(vector)this.vector=vector;
                const nominations=[...new Set(wake.map(n=>this.index.rows.get(n.id)?.canonicalId).filter(Boolean))];
                // One matching chunk wakes the whole entry. Unknown/overflow chunks
                // keep the entry eligible rather than hiding unindexed content.
                for(const id of nominations){const e=this.entries.get(id);if(!e)continue;this.index.used(e.chunks,c);for(const chunk of e.chunks){const state=this.index.residency.get(chunk);if(state)state.state='WARM';}}
                const details=[];
                for(const id of nominations){
                    const e=this.entries.get(id),matching=wake.filter(n=>this.index.rows.get(n.id)?.canonicalId===id).sort((a,b)=>b.score-a.score)[0];
                    if(!e||!matching)continue;
                    const previous=previousResidency.get(id)||null,newState=this.entryResidency(e),row=this.index.rows.get(matching.id);
                    details.push({sourceId:id,book:e.book,uid:e.uid,sourceVersion:row?.version||null,score:matching.score,reason:matching.reason,previousResidency:previous,newResidency:newState,newlyAwakened:previous==='SLEEPING'&&newState!=='SLEEPING'});
                }
                const eligible=new Set([...this.entries].filter(([,e])=>!this.asleep(e)).map(([id])=>id));
                stage='region-routing';
                const regions=new Set(),warmedRegions=[];const warmedRegionKeys=new Set();const nominatedSet=new Set(nominations);
                for(const book of books){
                    const visit=node=>[...(node?.entryUids||[]),...(node?.children||[]).flatMap(visit)];
                    const tree=this.host.tree(book);const root=tree?.root;
                    for(const region of root?.children||[]){
                        const ids=visit(region).map(uid=>loreEntryId(book,uid));
                        if(!ids.length||ids.some(id=>!this.entries.has(id)||eligible.has(id)))regions.add(loreRegionId(book,region.id));
                        if(ids.some(id=>nominatedSet.has(id))){
                            const key=loreRegionId(book,region.id);
                            if(!warmedRegionKeys.has(key)){warmedRegionKeys.add(key);warmedRegions.push({book,nodeId:region.id});}
                        }
                    }
                    // Root-direct and Tree-unlinked lore has no top-level child region.
                    // Surface the Tree root as an operational refresh hint when such an
                    // entry is nominated; Change Gate semantics remain untouched.
                    if(root){
                        const childIds=new Set((root.children||[]).flatMap(visit).map(uid=>loreEntryId(book,uid)));
                        const rootNominated=nominations.some(id=>this.entries.get(id)?.book===book&&!childIds.has(id));
                        if(rootNominated){
                            const key=loreRegionId(book,root.id);
                            if(!warmedRegionKeys.has(key)){warmedRegionKeys.add(key);warmedRegions.push({book,nodeId:root.id});}
                        }
                    }
                }
                if(performance.now()>deadline)return recordFallback('timeout',{probe:'executed',vectorAvailability:vector?'available':'unavailable',vectorCache,level:'warn',requiresRefresh:c.mode==='enabled'});
                const enforced=c.mode==='enabled';
                const reason=c.mode==='shadow'?'observation-mode':'paging-ready';
                const newlyAwakenedCount=details.filter(d=>d.newlyAwakened).length;
                const trace={...traceBase,nominations:new Set(nominations),details,requestId:traceBase.requestId};this.rememberTrace(trace);
                stage='complete';
                const probeTiming=timing();
                this.last={...this.last,reason:c.mode==='shadow'?'observe-only':'paging-ready',nominated:nominations.length,enforced,eligible:eligible.size,liveRecallState:c.mode==='shadow'?'ordinary':'vector-residency',liveRecallReason:c.mode==='shadow'?'observation-mode':null,lastProbeId:probeId,queryVectorAvailable:!!vector,queryVectorCache:vectorCache,indexReady:this.indexReady(c),probeTiming};
                this.host.log?.('lore-wake-probe',{...traceBase,indexReady:this.indexReady(c),probe:'executed',probeReason:weakCoverage?'weak-coverage':callback?'callback-language':gate?.mode!=='NO_CHANGE'?'change-gate':hadPriorProbe?'query-changed':'first-probe',queryVector:{availability:vector?'available':'unavailable',cache:vectorCache,origin:explicitOnly?'explicit-alias':vectorOrigin,foregroundAllowed:c.allowForegroundEmbedding===true,attempted:vectorOrigin==='foreground'},exclusionEnforced:enforced,ordinaryRetrieval:!enforced,fallbackReason:enforced?null:'observation-mode',nominations:details,newlyAwakenedCount,timing:probeTiming},'info');
                this.host.notify?.();
                if(c.mode!=='enabled')return {...ordinaryBase,probeId,nominationDetails:details,fallbackReason:'observation-mode',indexReady:this.indexReady(c),probeTiming};
                return {eligibleIds:eligible,eligibleRegions:regions,warmedRegions,nominated:nominations,nominationDetails:details,probeId,turn:traceBase.turn,sourceVersions,mode:c.mode,indexReady:this.indexReady(c),probeTiming,validate:async()=>{
                    let timer;
                    try{return await Promise.race([(async()=>this.valid(token,scope,profile,mode)&&query===this.host.query()&&await this.sourceMatches(books)&&this.valid(token,scope,profile,mode)&&query===this.host.query())(),new Promise(resolve=>{timer=setTimeout(()=>resolve(false),c.foregroundBudgetMs);})]);}catch{return false;}finally{clearTimeout(timer);}
                }};
            })(),new Promise(resolve=>{timeout=setTimeout(()=>{controller.abort();resolve(recordFallback('timeout',{probe:'executed',vectorAvailability:cachedVector?'available':'unavailable',vectorCache:cachedVector?'hit':'miss',level:'warn',requiresRefresh:c.mode==='enabled'}));},activeBudgetMs);})]);
        }catch(error){return recordFallback(failureReason(error,performance.now()>deadline),{probe:'executed',level:'warn'});}
        finally{clearTimeout(timeout);controller.abort();}
    }
}
