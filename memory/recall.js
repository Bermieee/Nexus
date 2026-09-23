import { getContext } from '../../../../st-context.js';
import { getSettings } from '../core/settings.js';
import { BUS_STAGE, BUS_PRIORITY } from '../sidecar/bus.js';
import { enqueueNexusModelWorkerJob } from '../nexus/model-worker-bus.js';
import { estimateContentTokens } from '../observability/token-estimator.js';
import { getActiveMemories, getPermanentMemoryRecords, getMemoryStore, memoryRecordVersion } from './store.js';
import { evaluateSummaryHistoricalRerankAssist, summaryHistoricalRerankFingerprint } from './decision-sites.js';
import { logEvent } from '../observability/telemetry.js';
import { captureNexusWorkScope, isNexusWorkScopeFresh } from '../nexus/work-scope.js';
import { isIntentionalCancellation } from '../core/cancellation.js';

import { prepareMemoryPaging, markMemoryPagingUsed } from '../paging/runtime.js';
import { composeMemoryRecallCandidates } from '../paging/recall-candidates.js';
import { isNarrativeSceneMessage, tailNarrativeSceneMessages } from '../retrieval/handoff-policy.js';
import { publishMemoryRecallOutlet, clearMemoryRecallOutlet } from '../nexus/generation-frame-ports.js';
import { NEXUS_GENERATION_OUTLET_STATUS } from '../nexus/generation-frame-contract.js';

let promptGenerationId=null;
const STOP=new Set(`the a an and or but if then of to in on at by for from with into is are was were be been being do does did have has had can could would should will may might not no this that these those it its they them their he him his she her we us our you your i me my as about after before during when where why how what which who said says say looked look scene current recent turn turns user assistant`.split(/\s+/));
function representativeTrigrams(chars, limit=96){
    const maxStart=chars.length-3;if(maxStart<0)return chars.length?[chars.join('')]:[];
    const count=Math.min(Math.max(1,Number(limit)||96),maxStart+1),out=[];
    for(let n=0;n<count;n++){const i=count===1?0:Math.round((n*maxStart)/(count-1));out.push(chars.slice(i,i+3).join(''));}
    return out;
}
function terms(text){
    const value=String(text||'').toLowerCase();const raw=value.match(/[\p{L}\p{N}][\p{L}\p{N}'_-]*/gu)||[],out=[];
    for(const token of raw){
        if(/^[a-z0-9'_-]+$/.test(token)){if(token.length>2&&!STOP.has(token))out.push(token);continue;}
        const chars=[...token].filter(ch=>/[\p{L}\p{N}]/u.test(ch));
        if(chars.length<=4){if(chars.length)out.push(chars.join(''));continue;}
        out.push(...representativeTrigrams(chars));
    }
    return [...new Set(out)];
}
function recentChat(n,context=getContext()){return tailNarrativeSceneMessages(context?.chat||[],Math.max(1,Number(n)||8)).map(m=>`[${m.is_user?'User':'Assistant'}] ${String(m.mes||'')}`).join('\n\n');}
function score(record,qterms){const hay=[record.text,...record.characters,...record.locations,...record.dates,...record.topics,...record.threads].join(' ');const hayTerms=new Set(terms(hay));let hits=0;for(const t of qterms)if(hayTerms.has(t))hits++;if(hits===0)return 0;const recency=Math.max(0,1-Math.min(1,(Date.now()-record.createdAt)/(1000*60*60*24*30)));const depth=Math.min(4,record.layer)*0.15;const durable=record.permanent===true?0.75:0;return hits*4+recency+depth+durable;}
function candidatesFor(query){const qterms=terms(query);if(!qterms.length)return[];const merged=new Map();for(const r of [...getActiveMemories(),...getPermanentMemoryRecords()])merged.set(r.id,r);const rows=[...merged.values()].map(r=>({...r,score:score(r,qterms)})).filter(r=>r.score>0).sort((a,b)=>b.score-a.score||b.layer-a.layer||b.createdAt-a.createdAt);if(!rows.length)return[];const best=rows[0].score;const floor=Math.max(1,best*0.32);return rows.filter(r=>r.score>=floor);}
function candidateUniverseSignature(records=[]){
    const rows=(records||[]).map(r=>[String(r?.id||''),memoryRecordVersion(r)]).sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:0);
    let hash=2166136261;
    const value=JSON.stringify(rows);
    for(let i=0;i<value.length;i++){hash^=value.charCodeAt(i);hash=Math.imul(hash,16777619)>>>0;}
    return `${rows.length}:${hash.toString(36)}`;
}
function decisionFingerprintCandidates(records=[]){return (records||[]).map(row=>({...row,decisionSourceVersion:memoryRecordVersion(row)}));}
function currentSummaryCandidateContext(ids=[],need='',chatRevision=null){const store=getMemoryStore();const rows=(ids||[]).map(id=>store.records?.[String(id)]).filter(Boolean);return{need,candidates:decisionFingerprintCandidates(rows),chatRevision};}
function parse(text){let s=String(text||'').trim();const f=s.match(/```(?:json)?\s*([\s\S]*?)```/i);if(f)s=f[1].trim();const a=s.indexOf('{'),b=s.lastIndexOf('}');if(a>=0&&b>a)s=s.slice(a,b+1);return JSON.parse(s);}
function render(records,budgetTokens=null,model=''){
    const sorted=[...records].sort((a,b)=>b.layer-a.layer||(a.turnRange?.[0]??0)-(b.turnRange?.[0]??0));let text='<tv2_historical_memory>\n[Chronological memory selected from the Nexus recursive Summary Bank. Use as past context; current chat and canonical lore remain authoritative.]\n';let omitted=0;const includedIds=[];
    for(const r of sorted){const block=`\n[L${r.layer}${r.turnRange?` | messages ${r.turnRange[0]}-${r.turnRange[1]}`:''}]\n${r.text}\n`;if(Number(budgetTokens)>0&&estimateContentTokens(text+block,model)>Number(budgetTokens)){omitted++;continue;}text+=block;includedIds.push(String(r.id));}
    text+='</tv2_historical_memory>';
    return {text,omitted,includedIds};
}
export function clearMemoryRecall({generationId=null,force=false}={}){if(!force&&generationId!=null&&promptGenerationId!=null&&String(generationId)!==String(promptGenerationId))return false;const target=generationId??promptGenerationId;if(target!=null)clearMemoryRecallOutlet({generationId:target,status:NEXUS_GENERATION_OUTLET_STATUS.EMPTY,reason:'memory-recall-cleared'});promptGenerationId=null;logEvent('memory-recall','cleared',{generationId},'debug');return true;}
export async function prepareMemoryRecall({generationId=null}={}){
    const context=getContext();const scope=captureNexusWorkScope(context,{includeGeneration:generationId!=null,generationId});
    const settings=getSettings();const cfg=settings.memoryBank?.recall||{};if(!settings.enabled||settings.memoryBank?.enabled===false||cfg.enabled===false){clearMemoryRecall({generationId});return {skipped:true,reason:'disabled'};}
    const chat=recentChat(cfg.contextMessages||8,context);const ordinary=candidatesFor(chat);const ordinaryUniverse=candidateUniverseSignature(ordinary);
    let paging={eligibleIds:null,nominated:[],mode:'off'};
    try{paging=await prepareMemoryPaging(chat,{weakCoverage:ordinary.length===0,requestId:generationId});}catch{logEvent('vector-paging','ordinary-recall-fallback',{},'warn');}
    if(!isNexusWorkScopeFresh(scope,getContext()))return {deferred:true,stale:true,reason:'scope-invalidated'};
    const rerankLimit=Math.max(3,Number(cfg.rerankCandidateLimit)||8);
    const {fallback,candidates:rerankCandidates,provenance={}}=composeMemoryRecallCandidates(ordinary,paging,rerankLimit,cfg.sidecarRerank!==false);
    const candidates=rerankCandidates;
    if(!candidates.length){clearMemoryRecall({generationId});logEvent('memory-recall','skipped',{reason:'no-candidates'},'debug');return {skipped:true,reason:'no-candidates'};}
    let selected=fallback;let reasoning='deterministic relevance';let slot=null;let model='';
    const rerankDecisionCandidates=decisionFingerprintCandidates(rerankCandidates);const rerankDecisionContext={need:chat,candidates:rerankDecisionCandidates,chatRevision:scope?.revision||null};rerankDecisionContext.sourceFingerprint=summaryHistoricalRerankFingerprint(rerankDecisionContext);rerankDecisionContext.readCurrentFreshnessContext=()=>currentSummaryCandidateContext(rerankCandidates.map(row=>row.id),recentChat(cfg.contextMessages||8,getContext()),captureNexusWorkScope(getContext(),{includeRevision:true}).revision);
    let rerankAssist=null;
    if(cfg.sidecarRerank!==false&&rerankCandidates.length){
        try{rerankAssist=await evaluateSummaryHistoricalRerankAssist(rerankDecisionContext);}catch(error){logEvent('decision-core','summary-recall-assist-error',{error:error?.message||String(error)},'warn');}
        if(rerankAssist?.handled){const wanted=new Set(rerankAssist.selectedIds||[]);selected=rerankCandidates.filter(row=>wanted.has(String(row.id)));reasoning='Decision Core Assist selected bounded Summary candidates before recall worker';slot='decision-core';logEvent('decision-core','summary-recall-assist-complete',{candidateCount:rerankCandidates.length,selectedIds:selected.map(row=>String(row.id)),provider:rerankAssist.result?.provider||null,latencyMs:rerankAssist.result?.latencyMs||0},'info');}
    }
    logEvent('memory-recall','candidate-pool',{candidateCount:candidates.length,rerankCandidateCount:rerankCandidates.length,rerankLimit,bestScore:candidates[0]?.score||0,layers:[...new Set(candidates.map(r=>r.layer))],candidateSources:candidates.map(r=>({id:String(r.id),source:provenance[String(r.id)]||'lexical',score:Number(r.score)||0}))},'info');
    if(cfg.sidecarRerank!==false&&rerankCandidates.length>0&&!rerankAssist?.handled){
        const listing=rerankCandidates.map(r=>`[${r.id} | L${r.layer}${r.turnRange?` | messages ${r.turnRange[0]}-${r.turnRange[1]}`:''} | score ${r.score.toFixed(2)}]\n${r.text}`).join('\n\n---\n\n');
        const prompt=`Nexus SUMMARY BANK RECALL\n\nCURRENT CHAT\n${chat}\n\nONLY ALLOWED MEMORY CANDIDATES\n${listing}\n\nSelect the minimum historical memories needed to understand or continue the current scene. Prefer precise lower-layer memories for exact incidents and deeper memories for broad arc context. Do not select a memory merely because a name appears. Return ONLY JSON: {"memoryIds":["exact id"],"reasoning":"short reason"}`;
        const configuredTimeout=Number(cfg.timeoutMs)||120000,softFallbackTimeout=Math.max(1000,Math.min(configuredTimeout,Number(cfg.foregroundFallbackTimeoutMs)||60000));
        const job=enqueueNexusModelWorkerJob('memory-bank', BUS_STAGE.MEMORY_RECALL||BUS_STAGE.SUMMARY,{prompt,systemPrompt:'You are Nexus historical memory recall. Select only from supplied Summary Bank candidates. Return exact JSON only.',role:'retrieval',mainPreferred:false,mainEligible:true,reasoningEffort:cfg.reasoningEffort||'medium',timeoutMs:softFallbackTimeout,priority:BUS_PRIORITY.MEMORY_RECALL,maxAttempts:1,foregroundAdjacent:true,preemptible:false,dedupKey:`memory-recall:${context?.chat?.length||0}:${ordinaryUniverse}`,label:'Summary Bank recall',nexusScope:scope,executionMode:generationId!=null?'adaptive':undefined,telemetry:{foregroundCritical:true,foregroundDeadlineCritical:generationId!=null,retrievalPhase:'memory-recall',softFallbackTimeoutMs:softFallbackTimeout}});
        try{const response=await job.promise;const data=parse(response.text);const allowed=new Map(rerankCandidates.map(r=>[r.id,r]));if(Array.isArray(data.memoryIds)){const ids=[...new Set(data.memoryIds.map(String))];const legal=ids.map(id=>allowed.get(id)).filter(Boolean);if(ids.length===0)selected=[];else if(legal.length===ids.length)selected=legal;else{selected=fallback;reasoning='sidecar returned Memory IDs outside the exact candidate set; deterministic fallback retained';}}if(!reasoning||reasoning==='deterministic relevance')reasoning=String(data.reasoning||reasoning);slot=response?.tv2?.slot||null;model=response?.tv2?.model||'';logEvent('memory-recall','rerank-complete',{jobId:job.id,slot,candidateCount:candidates.length,rerankCandidateCount:rerankCandidates.length,selectedCount:selected.length,softFallbackTimeoutMs:softFallbackTimeout,reasoning},'info');}catch(error){if(isIntentionalCancellation(error))throw error;logEvent('memory-recall','rerank-failed',{error,candidateCount:candidates.length,rerankCandidateCount:rerankCandidates.length,deterministicFallback:true},'warn');}
    }
    if(!isNexusWorkScopeFresh(scope,getContext())){logEvent('memory-recall','stale-discard',{scope},'warn');return {deferred:true,stale:true,reason:'scope-invalidated'};}
    const liveUniverse=candidateUniverseSignature(candidatesFor(chat));
    if(liveUniverse!==ordinaryUniverse){logEvent('memory-recall','candidate-universe-stale',{before:ordinaryUniverse,after:liveUniverse},'warn');return {deferred:true,stale:true,reason:'memory-candidate-universe-revised'};}
    const refreshedSelected=[];
    const postSidecarStore=getMemoryStore();
    for(const captured of selected){
        const live=postSidecarStore.records?.[String(captured.id)]||null;
        if(!live||memoryRecordVersion(live)!==memoryRecordVersion(captured)){
            logEvent('memory-recall','memory-snapshot-stale',{memoryId:captured.id},'warn');
            return {deferred:true,stale:true,reason:'memory-store-revised',memoryId:captured.id};
        }
        refreshedSelected.push(JSON.parse(JSON.stringify(live)));
    }
    selected=refreshedSelected;
    if(!selected.length){clearMemoryRecall({generationId});logEvent('memory-recall','injection-empty',{candidateCount:candidates.length,slot,reasoning},'info');return {selected:[],reasoning,estimatedTokens:0,omitted:0};}
    const vectorNominated=new Set((paging.nominationDetails||[]).map(row=>String(row.sourceId)));
    logEvent('vector-paging','memory-wake-selection',{probeId:paging.probeId||null,requestId:generationId==null?null:String(generationId),turn:paging.turn??null,sourceVersion:paging.sourceVersion??null,nominatedSourceIds:[...vectorNominated],passedRetrievalSourceIds:selected.filter(r=>vectorNominated.has(String(r.id))).map(r=>String(r.id)),passedRetrievalCount:selected.filter(r=>vectorNominated.has(String(r.id))).length},'info');
    const rendered=render(selected,cfg.maxInjectionTokens,model);
    if(!isNexusWorkScopeFresh(scope,getContext()))return {deferred:true,stale:true,reason:'scope-invalidated'};
    const published=publishMemoryRecallOutlet({generationId,status:NEXUS_GENERATION_OUTLET_STATUS.READY,content:rendered.text,refs:selected.filter(r=>rendered.includedIds.includes(String(r.id))).map(r=>({id:String(r.id)})),sourceRevision:candidateUniverseSignature(selected),data:{reasoning,slot,omitted:rendered.omitted}});
    if(published?.accepted===false)return {deferred:true,stale:true,reason:`generation-frame-${published.reason}`};
    promptGenerationId=generationId==null?null:String(generationId);
    const injected=selected.filter(r=>rendered.includedIds.includes(String(r.id)));
    markMemoryPagingUsed(injected);
    logEvent('vector-paging','memory-wake-outcome',{probeId:paging.probeId||null,requestId:generationId==null?null:String(generationId),turn:paging.turn??null,sourceVersion:paging.sourceVersion??null,enteredInjectionSourceIds:injected.filter(r=>vectorNominated.has(String(r.id))).map(r=>String(r.id)),enteredInjectionCount:injected.filter(r=>vectorNominated.has(String(r.id))).length},'info');
    const estimatedTokens=estimateContentTokens(rendered.text,model);logEvent('memory-recall','injection-complete',{selectedCount:selected.length,selected:selected.map(r=>({id:r.id,layer:r.layer,turnRange:r.turnRange,textPreview:r.text.slice(0,180),candidateSource:provenance[String(r.id)]||'lexical'})),slot,reasoning,estimatedTokens,budgetTokens:Number(cfg.maxInjectionTokens)>0?Number(cfg.maxInjectionTokens):null,omitted:rendered.omitted},'info');
    return {selected,reasoning,estimatedTokens,omitted:rendered.omitted};
}
