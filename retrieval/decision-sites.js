import { getSettings } from '../core/settings.js';
import { loadBook, findEntryByUid } from '../lore/store.js';
import { getTree } from '../tree/store.js';
import { currentNodeForUid } from '../tree/ops.js';
import { currentNexusLoreSourceRevision } from '../nexus/lore-source-revision.js';
import { getSceneScannerSnapshot } from '../scene/scanner.js';
import { DECISION_MODE } from '../decision/constants.js';
import { decisionAssistEnabled, decisionShadowEnabled } from '../decision/mode.js';
import { registerDecisionSite, evaluateDecisionSite } from '../decision/site-registry.js';
import { recordDecisionShadowComparison } from '../decision/telemetry.js';
import { logEvent } from '../observability/telemetry.js';
import { recordChangeGateShadowDiagnostics, recordRetrievalCandidateShadow } from './diagnostics.js';

export const RETRIEVAL_CANDIDATE_RERANK_SITE_ID = 'retrieval.candidate-rerank.v1';
export const CHANGE_GATE_SEMANTIC_CLASSIFICATION_SITE_ID = 'change-gate.semantic-classification.v1';
export const RETRIEVAL_REGION_ADMISSION_SITE_ID = 'retrieval.region-admission.v1';
export const RETRIEVAL_NODE_ADMISSION_SITE_ID = 'retrieval.node-admission.v1';
const MAX_TREE_DECISION_CANDIDATES = 48;
const MAX_ENTRY_DECISION_CANDIDATES = 48;

const rerankRuns = new Map();
const gateRuns = new Map();

function shadowEnabled() { return decisionShadowEnabled(); }

function clean(value) { return String(value ?? '').replace(/\s+/g, ' ').trim(); }
function stableObject(value) {
    if (Array.isArray(value)) return value.map(stableObject);
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableObject(value[key])]));
    return value;
}
function hashText(value = '') {
    const text = String(value || ''); let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i += 1) { hash ^= text.charCodeAt(i); hash = Math.imul(hash, 0x01000193) >>> 0; }
    return `${hash.toString(16).padStart(8, '0')}-${text.length}`;
}
function boundedText(value, maxChars = 12000) {
    const text = String(value || '');
    return text.length <= maxChars ? text : `${text.slice(0, maxChars)}\n[bounded evidence: ${text.length - maxChars} chars omitted]`;
}
function candidateMaterial(candidate = {}) {
    return {
        book: clean(candidate.book), uid: Number(candidate.uid), title: clean(candidate.title), content: String(candidate.content || ''),
        nodeId: candidate.nodeId == null ? null : String(candidate.nodeId), baselineRank: Number(candidate.baselineRank) || null,
        discoverySources: [...new Set((candidate.discoverySources || []).map(clean).filter(Boolean))].sort(),
    };
}

export function candidateRerankFingerprint({ chatId = null, sceneRevision = null, chatRevision = null, needText = '', sourceRevision = '', candidates = [] } = {}) {
    const payload = stableObject({ chatId, sceneRevision: clean(sceneRevision), chatRevision: clean(chatRevision), needText: String(needText || ''), sourceRevision: clean(sourceRevision), candidates: (candidates || []).map(candidateMaterial) });
    return `retrieval-rerank-${hashText(JSON.stringify(payload))}`;
}

export function changeGateShadowFingerprint({ chatId = null, scene = null } = {}) {
    const payload = stableObject({ chatId, sceneRevision: scene?.scanRevision || null, acceptedScene: scene?.acceptedScene || null, previousScene: scene?.previousScene || null, delta: scene?.delta || null, references: scene?.references || null, degraded: scene?.degraded === true });
    return `change-gate-shadow-${hashText(JSON.stringify(payload))}`;
}

async function currentCandidateRerankFingerprint(context = {}) {
    const books = [...new Set((context.books || []).map(clean).filter(Boolean))].sort();
    const byBook = new Map();
    for (const book of books) {
        try { byBook.set(book, await loadBook(book)); }
        catch { return `missing-book:${book}`; }
    }
    const candidates = [];
    for (const original of context.candidates || []) {
        const data = byBook.get(clean(original.book));
        const entry = data ? findEntryByUid(data.entries, original.uid) : null;
        if (!entry) return `missing-candidate:${clean(original.book)}:${Number(original.uid)}`;
        const tree = getTree(original.book);
        const nodeId = currentNodeForUid(tree, Number(entry.uid))?.id || null;
        candidates.push({ ...original, title: entry.comment || '', content: entry.content || '', nodeId });
    }
    const liveScene = getSceneScannerSnapshot({ chatId: context.chatId });
    const chatRevision = typeof context.readCurrentChatRevision === 'function'
        ? context.readCurrentChatRevision()
        : context.chatRevision;
    return candidateRerankFingerprint({
        chatId: context.chatId,
        sceneRevision: liveScene?.scanRevision || null,
        chatRevision,
        // The source need text is intentionally reused verbatim. Freshness of
        // the underlying chat is fenced by chatRevision; recomputing the text
        // through a different formatter caused false stale results.
        needText: context.needText,
        sourceRevision: currentNexusLoreSourceRevision(books),
        candidates,
    });
}

function currentChangeGateFingerprint(context = {}) {
    const live = getSceneScannerSnapshot({ chatId: context.chatId });
    return changeGateShadowFingerprint({ chatId: context.chatId, scene: live });
}

function entryAdmissionContractQuestions(){
    return Object.fromEntries(Array.from({length:MAX_ENTRY_DECISION_CANDIDATES},(_,i)=>[`candidate_${i+1}_relevant`,{type:'noul',required:false}]));
}
function entryAdmissionQuestions(context={}){
    const out={};
    (context.candidates||[]).slice(0,MAX_ENTRY_DECISION_CANDIDATES).forEach((candidate,index)=>{
        const statePath=`candidates[${index}]`;
        out[`candidate_${index+1}_relevant`]={type:'noul',instructions:`Evaluate only \`${statePath}\`. Should this exact lore entry be admitted to the final retrieval set for the immediate scene need? Judge only \`${statePath}\`; do not invent, nominate, or compare a different lore entry.`};
    });
    return out;
}

export const RETRIEVAL_CANDIDATE_RERANK_SITE = registerDecisionSite({
    id: RETRIEVAL_CANDIDATE_RERANK_SITE_ID,
    subsystem: 'retrieval',
    contract: {
        id: RETRIEVAL_CANDIDATE_RERANK_SITE_ID, version: 2, subsystem: 'retrieval',
        questions: entryAdmissionContractQuestions(),
    },
    mode: DECISION_MODE.ASSIST,
    priority: 90,
    buildState(context) {
        return {
            informationNeed: boundedText(context.needText, 8000),
            scene: context.scene ? { acceptedScene: context.scene.acceptedScene || null, references: context.scene.references || null, delta: context.scene.delta || null } : null,
            candidates: (context.candidates || []).slice(0,MAX_ENTRY_DECISION_CANDIDATES).map((candidate,index)=>({
                slot:index+1,book:clean(candidate.book),uid:Number(candidate.uid),title:clean(candidate.title),nodeId:candidate.nodeId==null?null:String(candidate.nodeId),
                baselineRank:Number(candidate.baselineRank)||index+1,discoverySources:[...new Set((candidate.discoverySources||[]).map(clean).filter(Boolean))].sort(),
                content:boundedText(candidate.content,1800),
            })),
        };
    },
    buildQuestions(context) { return entryAdmissionQuestions(context); },
    getSourceFingerprint(context) { return context.sourceFingerprint; },
    getCurrentSourceFingerprint(context) { return currentCandidateRerankFingerprint(context); },
    metadata: { decisionClass: 'candidate-admission-set', shadowOnly: false, assist: true, discoveryAuthority: false, route: 'direct', boundary: 'before-injection-worker', maxCandidates:MAX_ENTRY_DECISION_CANDIDATES },
});

export const CHANGE_GATE_SEMANTIC_CLASSIFICATION_SITE = registerDecisionSite({
    id: CHANGE_GATE_SEMANTIC_CLASSIFICATION_SITE_ID,
    subsystem: 'change-gate',
    contract: { id: CHANGE_GATE_SEMANTIC_CLASSIFICATION_SITE_ID, version: 1, subsystem: 'change-gate', questions: { classification: { type: 'choice' } } },
    mode: DECISION_MODE.ASSIST,
    priority: 90,
    buildState(context) {
        const scene = context.scene || {};
        return { previousScene: scene.previousScene || null, currentScene: scene.acceptedScene || null, delta: scene.delta || null, references: scene.references || null, degraded: scene.degraded === true };
    },
    buildQuestions() {
        return { classification: { type: 'choice', instructions: 'Classify only the semantic scene change represented by the supplied previous/current structured scene states and delta. Do not decide Retrieval execution, reroute scope, warming, residency, or prompt publication.', criteria: { NO_CHANGE: 'No material semantic scene change.', MINOR_CHANGE: 'Material focus/state change within substantially the same scene topology.', MAJOR_CHANGE: 'Scene topology changed materially, such as participant arrival/departure, location movement, time jump, or objective/activity transition.' } } };
    },
    getSourceFingerprint(context) { return context.sourceFingerprint; },
    getCurrentSourceFingerprint(context) { return currentChangeGateFingerprint(context); },
    metadata: { decisionClass: 'semantic-change-classification', shadowOnly: false, assist: true, rerouteAuthority: 'change-gate-owned', route: 'direct' },
});


function treeAdmissionContractQuestions(){
    return Object.fromEntries(Array.from({length:MAX_TREE_DECISION_CANDIDATES},(_,i)=>[`candidate_${i+1}_relevant`,{type:'noul',required:false}]));
}
function treeAdmissionQuestions(context={},kind='region'){
    const noun=kind==='region'?'region':'node';
    const out={};
    (context.candidates||[]).slice(0,MAX_TREE_DECISION_CANDIDATES).forEach((candidate,index)=>{
        const statePath=`candidates[${index}]`;
        out[`candidate_${index+1}_relevant`]={type:'noul',instructions:`Evaluate only \`${statePath}\`. Should this exact ${noun} be admitted to the next retrieval stage for the immediate scene need? Consider the label, summary, keywords, current warm/pin evidence, and bounded scene need of \`${statePath}\`. Do not invent, nominate, or evaluate any other ${noun}.`};
    });
    return out;
}
function treeAdmissionState(context={},kind='region'){
    return {
        informationNeed: boundedText(context.needText,8000),
        scene: context.scene ? {acceptedScene:context.scene.acceptedScene||null,references:context.scene.references||null,delta:context.scene.delta||null}:null,
        candidateType:kind,
        candidates:(context.candidates||[]).slice(0,MAX_TREE_DECISION_CANDIDATES).map((row,index)=>({slot:index+1,book:clean(row.book),nodeId:String(row.nodeId||''),label:clean(row.label),summary:boundedText(row.summary,2500),keywords:[...(row.keywords||[])].map(clean).filter(Boolean).slice(0,24),entryCount:Number(row.entryCount)||0,warm:row.warm===true,pinned:row.pinned===true,leaf:row.leaf===true,path:[...(row.path||[])].map(clean).filter(Boolean).slice(0,16)})),
    };
}
function treeAdmissionFingerprint(context={},kind='region'){
    return `retrieval-${kind}-admission-${hashText(JSON.stringify(stableObject({needText:String(context.needText||''),sceneRevision:context.scene?.scanRevision||null,sourceRevision:clean(context.sourceRevision||''),candidates:(context.candidates||[]).map(row=>({book:clean(row.book),nodeId:String(row.nodeId||''),label:clean(row.label),summary:String(row.summary||''),keywords:[...(row.keywords||[])].map(clean).filter(Boolean),entryCount:Number(row.entryCount)||0,warm:row.warm===true,pinned:row.pinned===true}))})))}`;
}
function currentTreeAdmissionFingerprint(context={},kind='region'){
    if(typeof context.readCurrentSourceFingerprint==='function') return context.readCurrentSourceFingerprint();
    return context.sourceFingerprint||treeAdmissionFingerprint(context,kind);
}

export const RETRIEVAL_REGION_ADMISSION_SITE=registerDecisionSite({
    id:RETRIEVAL_REGION_ADMISSION_SITE_ID,subsystem:'retrieval',
    contract:{id:RETRIEVAL_REGION_ADMISSION_SITE_ID,version:1,subsystem:'retrieval',questions:treeAdmissionContractQuestions()},
    mode:DECISION_MODE.ASSIST,priority:94,
    buildState(context){return treeAdmissionState(context,'region');},
    buildQuestions(context){return treeAdmissionQuestions(context,'region');},
    getSourceFingerprint(context){return context.sourceFingerprint||treeAdmissionFingerprint(context,'region');},
    getCurrentSourceFingerprint(context){return currentTreeAdmissionFingerprint(context,'region');},
    metadata:{decisionClass:'tree-region-admission',shadowOnly:false,assist:true,boundary:'before-region-worker',maxCandidates:MAX_TREE_DECISION_CANDIDATES,route:'direct'},
});
export const RETRIEVAL_NODE_ADMISSION_SITE=registerDecisionSite({
    id:RETRIEVAL_NODE_ADMISSION_SITE_ID,subsystem:'retrieval',
    contract:{id:RETRIEVAL_NODE_ADMISSION_SITE_ID,version:1,subsystem:'retrieval',questions:treeAdmissionContractQuestions()},
    mode:DECISION_MODE.ASSIST,priority:93,
    buildState(context){return treeAdmissionState(context,'node');},
    buildQuestions(context){return treeAdmissionQuestions(context,'node');},
    getSourceFingerprint(context){return context.sourceFingerprint||treeAdmissionFingerprint(context,'node');},
    getCurrentSourceFingerprint(context){return currentTreeAdmissionFingerprint(context,'node');},
    metadata:{decisionClass:'tree-node-admission',shadowOnly:false,assist:true,boundary:'before-node-worker',maxCandidates:MAX_TREE_DECISION_CANDIDATES,route:'direct'},
});

export function buildTreeAdmissionFingerprint(context={},kind='region'){return treeAdmissionFingerprint(context,kind);}
export async function evaluateRetrievalTreeAdmissionAssist({kind='region',candidates=[],mandatoryRefs=[],sourceFingerprint=null,...context}={},options={}){
    if(!decisionAssistEnabled())return{handled:false,reason:'assist-off'};
    if(!Array.isArray(candidates))return{handled:false,reason:'invalid-candidates'};
    if(candidates.length===0)return{handled:true,refs:[],result:null,reason:'empty-candidate-set'};
    if(candidates.length>MAX_TREE_DECISION_CANDIDATES)return{handled:false,reason:'candidate-bound-exceeded',candidateCount:candidates.length,maxCandidates:MAX_TREE_DECISION_CANDIDATES};
    const siteId=kind==='node'?RETRIEVAL_NODE_ADMISSION_SITE_ID:RETRIEVAL_REGION_ADMISSION_SITE_ID;
    const fingerprint=sourceFingerprint||treeAdmissionFingerprint({...context,candidates},kind);
    const result=await evaluateDecisionSite(siteId,{...context,candidates,sourceFingerprint:fingerprint},{mode:DECISION_MODE.ASSIST,...options});
    if(!result?.ok||result?.stale)return{handled:false,reason:result?.stale?'stale':'decision-failed',result};
    const mandatory=new Set((mandatoryRefs||[]).map(ref=>JSON.stringify([String(ref?.book||''),String(ref?.nodeId||'')])));
    const refs=[];
    candidates.forEach((candidate,index)=>{
        const probability=Number(result.answers?.[`candidate_${index+1}_relevant`]?.value);
        const key=JSON.stringify([String(candidate.book||''),String(candidate.nodeId||'')]);
        if(mandatory.has(key)||(Number.isFinite(probability)&&probability>=0.5))refs.push({book:String(candidate.book),nodeId:String(candidate.nodeId)});
    });
    return{handled:true,refs,result,reason:'assist-success'};
}

async function runPool(items, worker, concurrency = 2) {
    let cursor = 0;
    const runners = Array.from({ length: Math.max(1, Math.min(concurrency, items.length || 1)) }, async () => {
        while (cursor < items.length) { const index = cursor++; await worker(items[index], index); }
    });
    await Promise.all(runners);
}

export function queueRetrievalCandidateRerankShadow({ chatId = null, scene = null, chatRevision = null, needText = '', books = [], candidates = [], sourceFingerprint = null, readCurrentChatRevision = null } = {}) {
    const fingerprint = clean(sourceFingerprint);
    if (!fingerprint || !candidates.length) return null;
    if (!shadowEnabled()) {
        recordRetrievalCandidateShadow({ chatId, sourceFingerprint: fingerprint, rows: [], status: 'off' });
        return null;
    }
    if(candidates.length>MAX_ENTRY_DECISION_CANDIDATES){
        recordRetrievalCandidateShadow({ chatId, sourceFingerprint:fingerprint, rows:[], status:'bounded-out' });
        return null;
    }
    const existing = rerankRuns.get(String(chatId ?? 'none'));
    if (existing?.fingerprint === fingerprint) return existing.promise;
    const context = { chatId, scene, chatRevision, needText, books, candidates, sourceFingerprint: fingerprint, readCurrentChatRevision };
    const promise = evaluateDecisionSite(RETRIEVAL_CANDIDATE_RERANK_SITE_ID, context, { mode: DECISION_MODE.SHADOW }).then(result=>{
        const rows=candidates.map((candidate,index)=>({
            book:candidate.book,uid:Number(candidate.uid),baselineRank:candidate.baselineRank,
            score:result?.ok?Number(result.answers?.[`candidate_${index+1}_relevant`]?.value):null,
            provider:result?.provider||null,providerClass:result?.providerClass||null,latencyMs:result?.latencyMs||0,usage:result?.usage||null,fallback:result?.fallback||null,stale:result?.stale===true,error:result?.error||null,
        }));
        const ranked=rows.filter(row=>Number.isFinite(row.score)&&!row.stale).sort((a,b)=>b.score-a.score||a.baselineRank-b.baselineRank);
        ranked.forEach((row,index)=>{row.shadowRank=index+1;});
        const rankByKey=new Map(ranked.map(row=>[`${row.book}\u0000${row.uid}`,row.shadowRank]));
        for(const row of rows)row.shadowRank=rankByKey.get(`${row.book}\u0000${row.uid}`)||null;
        const successful=rows.filter(row=>Number.isFinite(row.score)&&!row.stale).length;
        recordRetrievalCandidateShadow({chatId,sourceFingerprint:fingerprint,rows,status:successful?'complete':(result?.stale?'stale':'unavailable')});
        logEvent('retrieval','candidate-rerank-shadow-complete',{candidateCount:candidates.length,decisionCalls:1,scoredCount:successful,sourceFingerprint:fingerprint,rows:rows.map(({book,uid,baselineRank,shadowRank,score,provider,stale,error})=>({book,uid,baselineRank,shadowRank,score,provider,stale,errorCategory:error?.category||null}))},'debug');
        return rows;
    }).catch(error=>{
        recordRetrievalCandidateShadow({chatId,sourceFingerprint:fingerprint,rows:[],status:'failed',error:error?.message||String(error)});
        logEvent('retrieval','candidate-rerank-shadow-failed',{sourceFingerprint:fingerprint,error:error?.message||String(error)},'debug');
        return [];
    });
    rerankRuns.set(String(chatId ?? 'none'), { fingerprint, promise });
    return promise;
}

export function partitionRetrievalDecisionCandidates(candidates=[],maxCandidates=MAX_ENTRY_DECISION_CANDIDATES){
    const source=Array.isArray(candidates)?candidates:[];
    const size=Math.max(1,Math.min(MAX_ENTRY_DECISION_CANDIDATES,Number(maxCandidates)||MAX_ENTRY_DECISION_CANDIDATES));
    const chunks=[];
    for(let offset=0;offset<source.length;offset+=size)chunks.push(source.slice(offset,offset+size));
    return chunks;
}

export async function evaluateRetrievalCandidateAdmissionAssist({ chatId=null,scene=null,chatRevision=null,needText='',books=[],candidates=[],sourceFingerprint=null,readCurrentChatRevision=null }={},options={}){
    if(!decisionAssistEnabled())return{handled:false,reason:'assist-off'};
    if(!Array.isArray(candidates)||!candidates.length)return{handled:true,selected:[],jevSelected:[],unresolved:[],rows:[],reason:'empty-candidate-set',decisionCalls:0,chunkCount:0};
    const chunks=partitionRetrievalDecisionCandidates(candidates);
    const sourceRevision=currentNexusLoreSourceRevision(books);
    const outcomes=await Promise.all(chunks.map(async(chunk,chunkIndex)=>{
        const fingerprint=chunks.length===1&&clean(sourceFingerprint)
            ? clean(sourceFingerprint)
            : candidateRerankFingerprint({
                chatId,
                sceneRevision:scene?.scanRevision||null,
                chatRevision,
                needText,
                sourceRevision,
                candidates:chunk,
            });
        const context={chatId,scene,chatRevision,needText,books,candidates:chunk,sourceFingerprint:fingerprint,readCurrentChatRevision};
        try{
            const result=await evaluateDecisionSite(RETRIEVAL_CANDIDATE_RERANK_SITE_ID,context,{mode:DECISION_MODE.ASSIST,...options});
            if(!result?.ok||result?.stale)return{chunkIndex,candidates:chunk,handled:false,result,reason:result?.stale?'stale':'decision-failed',fingerprint};
            const rows=chunk.map((candidate,index)=>({candidate,score:Number(result.answers?.[`candidate_${index+1}_relevant`]?.value),chunkIndex}));
            const selectedKeys=new Set(rows.filter(row=>Number.isFinite(row.score)&&row.score>=0.5).map(row=>JSON.stringify([String(row.candidate.book),Number(row.candidate.uid)])));
            if(!selectedKeys.size){
                const best=rows.filter(row=>Number.isFinite(row.score)).sort((a,b)=>b.score-a.score||Number(a.candidate.baselineRank||0)-Number(b.candidate.baselineRank||0))[0];
                if(best)selectedKeys.add(JSON.stringify([String(best.candidate.book),Number(best.candidate.uid)]));
            }
            return{chunkIndex,candidates:chunk,handled:true,result,reason:'assist-success',fingerprint,rows,selected:chunk.filter(candidate=>selectedKeys.has(JSON.stringify([String(candidate.book),Number(candidate.uid)])))};
        }catch(error){
            return{chunkIndex,candidates:chunk,handled:false,result:null,reason:'decision-error',fingerprint,error};
        }
    }));
    const valid=outcomes.filter(row=>row.handled);
    const unresolved=outcomes.filter(row=>!row.handled).flatMap(row=>row.candidates);
    const jevSelected=valid.flatMap(row=>row.selected||[]);
    const selectedKeys=new Set([...jevSelected,...unresolved].map(candidate=>JSON.stringify([String(candidate.book),Number(candidate.uid)])));
    const selected=candidates.filter(candidate=>selectedKeys.has(JSON.stringify([String(candidate.book),Number(candidate.uid)])));
    const rows=valid.flatMap(row=>row.rows||[]);
    const prunedCount=Math.max(0,candidates.length-selected.length);
    const reason=valid.length===chunks.length?'assist-success':valid.length?'assist-partial':'assist-unavailable';
    logEvent('decision-core','retrieval-candidate-admission-batched',{
        candidateCount:candidates.length,chunkCount:chunks.length,validChunkCount:valid.length,unresolvedChunkCount:chunks.length-valid.length,
        jevSelectedCount:jevSelected.length,unresolvedCount:unresolved.length,sidecarReviewCount:selected.length,prunedCount,
        chunks:outcomes.map(row=>({chunkIndex:row.chunkIndex,candidateCount:row.candidates.length,handled:row.handled,reason:row.reason,stale:row.result?.stale===true,latencyMs:row.result?.latencyMs||0,provider:row.result?.provider||null})),
    },unresolved.length?'warn':'info');
    return{handled:true,selected,jevSelected,unresolved,rows,results:outcomes.map(row=>row.result).filter(Boolean),reason,decisionCalls:chunks.length,chunkCount:chunks.length,validChunkCount:valid.length,unresolvedChunkCount:chunks.length-valid.length,prunedCount};
}
}

export async function evaluateChangeGateSemanticAssist({ chatId = null, scene = null, sourceFingerprint = null } = {}, options = {}) {
    const fingerprint = clean(sourceFingerprint || changeGateShadowFingerprint({ chatId, scene }));
    if (!fingerprint || !scene) return null;
    return evaluateDecisionSite(CHANGE_GATE_SEMANTIC_CLASSIFICATION_SITE_ID, { chatId, scene, sourceFingerprint: fingerprint }, { mode: DECISION_MODE.ASSIST, ...options });
}

export function queueChangeGateSemanticShadow({ chatId = null, scene = null, authoritativeClassification = null, sourceFingerprint = null } = {}) {
    const fingerprint = clean(sourceFingerprint);
    if (!fingerprint || !scene) return null;
    if (!shadowEnabled()) {
        recordChangeGateShadowDiagnostics({ chatId, current: authoritativeClassification || null, shadow: null, agreement: null, sourceFingerprint: fingerprint, status: 'off' });
        return null;
    }
    const id = String(chatId ?? 'none');
    const existing = gateRuns.get(id);
    if (existing?.fingerprint === fingerprint) return existing.promise;
    const context = { chatId, scene, sourceFingerprint: fingerprint };
    recordChangeGateShadowDiagnostics({ chatId, current: authoritativeClassification || null, shadow: null, agreement: null, sourceFingerprint: fingerprint, status: 'pending' });
    const promise = evaluateDecisionSite(CHANGE_GATE_SEMANTIC_CLASSIFICATION_SITE_ID, context, { mode: DECISION_MODE.SHADOW }).then(result => {
        const classification = result?.ok ? String(result.answers?.classification?.value || '') : null;
        const agreement = classification ? classification === String(authoritativeClassification || '') : null;
        recordChangeGateShadowDiagnostics({ chatId, current: authoritativeClassification || null, shadow: { classification, probabilities: result?.answers?.classification?.probabilities || null, confidence: result?.answers?.classification?.confidence ?? null, provider: result?.provider || null, latencyMs: result?.latencyMs || 0, usage: result?.usage || null, stale: result?.stale === true, error: result?.error || null }, agreement, sourceFingerprint: fingerprint, status: result?.ok ? 'complete' : (result?.stale ? 'stale' : 'unavailable') });
        if (result?.ok) recordDecisionShadowComparison({ contractId: result.contractId, provider: result.provider, agreement, details: { authoritativeClassification, shadowClassification: classification, comparisonBasis: 'shadow semantic classification only; never operational reroute authority', latencyMs: result.latencyMs, usage: result.usage } });
        logEvent('change-gate', 'semantic-classification-shadow-complete', { authoritativeClassification, shadowClassification: classification, agreement, stale: result?.stale === true, provider: result?.provider || null, errorCategory: result?.error?.category || null, sourceFingerprint: fingerprint }, 'debug');
        return result;
    }).catch(error => {
        recordChangeGateShadowDiagnostics({ chatId, current: authoritativeClassification || null, shadow: null, agreement: null, sourceFingerprint: fingerprint, status: 'failed', error: error?.message || String(error) });
        logEvent('change-gate', 'semantic-classification-shadow-failed', { sourceFingerprint: fingerprint, error: error?.message || String(error) }, 'debug');
        return null;
    });
    gateRuns.set(id, { fingerprint, promise });
    return promise;
}

export function buildCandidateShadowFingerprint({ chatId = null, scene = null, chatRevision = null, needText = '', books = [], candidates = [] } = {}) {
    return candidateRerankFingerprint({ chatId, sceneRevision: scene?.scanRevision || null, chatRevision, needText, sourceRevision: currentNexusLoreSourceRevision(books), candidates });
}

export function buildChangeGateShadowFingerprint({ chatId = null, scene = null } = {}) {
    return changeGateShadowFingerprint({ chatId, scene });
}
