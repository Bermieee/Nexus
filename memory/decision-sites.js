import { DECISION_MODE, DECISION_PROVIDER_CLASS } from '../decision/constants.js';
import { registerDecisionSite, evaluateDecisionSite } from '../decision/site-registry.js';
import { recordDecisionShadowComparison } from '../decision/telemetry.js';
import { createDecisionFreshnessContract, decisionFreshnessSnapshot } from '../decision/freshness.js';

export const SUMMARY_HISTORICAL_RERANK_SITE_ID = 'summary.historical-candidate-rerank.v1';
export const NOTEBOOK_MATERIAL_CHANGE_SITE_ID = 'notebook.material-change.v1';
export const SUMMARY_DURABLE_ROUTING_SITE_ID = 'summary.durable-routing.v1';

const durableRoutingShadow = new Map();
const MAX_DURABLE_ROUTING_SHADOW_ROWS = 512;
const DURABLE_EVENT = 'nexus-summary-durable-routing-shadow';

function stable(value) {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
    return value;
}
function hash(value, prefix='lane-a') {
    const text=JSON.stringify(stable(value));let h=0x811c9dc5;
    for(let i=0;i<text.length;i+=1){h^=text.charCodeAt(i);h=Math.imul(h,0x01000193)>>>0;}
    return `${prefix}-${h.toString(16).padStart(8,'0')}-${text.length}`;
}
function bounded(text,max=7000){const value=String(text||'');return value.length<=max?value:`${value.slice(0,max)}\n[bounded: ${value.length-max} chars omitted]`;}
function answerValue(result,id){const raw=result?.answers?.[id];const value=Number(raw?.value ?? raw?.score);return Number.isFinite(value)?value:null;}
function emitDurable(){try{globalThis.window?.dispatchEvent?.(new CustomEvent(DURABLE_EVENT));}catch{}}
function summaryFingerprintRow(row={}){
    return {
        id:String(row?.id||''),
        sourceVersion:String(row?.decisionSourceVersion??row?.sourceVersion??row?.updatedAt??''),
        layer:Number(row?.layer)||0,
        turnRange:row?.turnRange||null,
        text:String(row?.text||''),
        topics:(row?.topics||[]).map(String),
        characters:(row?.characters||[]).map(String),
        locations:(row?.locations||[]).map(String),
        threads:(row?.threads||[]).map(String),
    };
}

function summaryHistoricalFreshnessInput({need='',candidates=[],chatRevision=null}={}){const rows=(candidates||[]).map(summaryFingerprintRow);return{revisions:{chat:String(chatRevision??''),memory:Object.fromEntries(rows.map(row=>[row.id,row.sourceVersion]))},material:{need:String(need||''),candidates:rows.map(({sourceVersion,...row})=>row)}};}
export function summaryHistoricalRerankFingerprint(context={}){return decisionFreshnessSnapshot(SUMMARY_HISTORICAL_RERANK_SITE_ID,summaryHistoricalFreshnessInput(context)).fingerprint;}
const SUMMARY_HISTORICAL_FRESHNESS=createDecisionFreshnessContract({siteId:SUMMARY_HISTORICAL_RERANK_SITE_ID,buildCanonicalInput:summaryHistoricalFreshnessInput});
export function notebookMaterialChangeFingerprint({ priorNotebook='', evidence=[], characterNames=[] }={}) {
    return hash({priorNotebook:String(priorNotebook||''),evidence:(evidence||[]).map(row=>({id:String(row?.evidenceId||row?.id||''),text:String(row?.text||'')})),characterNames:[...(characterNames||[])].map(String).sort()},'notebook-change');
}
export function summaryDurableRoutingFingerprint(record,{chatId='',sourceVersion=null,characterState='',characterStateOwners=null,canonicalHints=null}={}){
    return hash({
        chatId:String(chatId||''),
        summary:{...summaryFingerprintRow(record),sourceVersion:String(sourceVersion??record?.decisionSourceVersion??record?.sourceVersion??record?.updatedAt??'')},
        characterState:String(characterState||''),
        characterStateOwners:stable(characterStateOwners||{}),
        canonicalHints:stable(canonicalHints||{}),
    },'summary-route');
}

function rerankQuestions(context={}){
    const out={};
    (context.candidates||[]).slice(0,8).forEach((_,index)=>{
        const statePath=`candidates[${index}]`;
        out[`candidate_${index+1}_fit`]={type:'score',instructions:`Evaluate only \`${statePath}\`. How strongly does this already-nominated historical Summary satisfy \`informationNeed\`? Do not evaluate another candidate.`,criteria:['Not relevant','Weak background','Useful','Strong evidence','Essential evidence']};
        out[`candidate_${index+1}_necessary`]={type:'noul',instructions:`Evaluate only \`${statePath}\`. Is this candidate necessary evidence for understanding or continuing the current scene rather than merely related background? Do not evaluate another candidate.`};
    });
    return out;
}
export const SUMMARY_HISTORICAL_RERANK_SITE=registerDecisionSite({
    id:SUMMARY_HISTORICAL_RERANK_SITE_ID,subsystem:'summary',
    contract:{id:SUMMARY_HISTORICAL_RERANK_SITE_ID,version:1,subsystem:'summary',questions:Object.fromEntries(Array.from({length:8},(_,i)=>[[`candidate_${i+1}_fit`,{type:'score',required:false}],[`candidate_${i+1}_necessary`,{type:'noul',required:false}]]).flat())},
    mode:DECISION_MODE.ASSIST,priority:82,
    buildState(context={}){return {informationNeed:bounded(context.need,8000),candidates:(context.candidates||[]).slice(0,8).map((row,index)=>({slot:index+1,id:String(row.id),layer:Number(row.layer)||0,turnRange:row.turnRange||null,text:bounded(row.text,7000)}))};},
    buildQuestions:rerankQuestions,
    freshness:SUMMARY_HISTORICAL_FRESHNESS,
    interpret(result,context={}){return (context.candidates||[]).slice(0,8).map((row,index)=>({id:String(row.id),score:answerValue(result,`candidate_${index+1}_fit`),necessary:answerValue(result,`candidate_${index+1}_necessary`)}));},
    metadata:{decisionClass:'historical-rerank',shadowOnly:false,assist:true,candidateDiscovery:false,boundary:'after-local-candidates-before-recall-worker'},
});
export async function evaluateSummaryHistoricalRerankAssist(context,options={}){
    const result=await evaluateDecisionSite(SUMMARY_HISTORICAL_RERANK_SITE_ID,context,{mode:DECISION_MODE.ASSIST,...options});
    if(!result?.ok||result?.stale)return {handled:false,result,reason:result?.stale?'stale':'decision-failed'};
    const rows=(context.candidates||[]).slice(0,8).map((row,index)=>({id:String(row.id),row,fit:answerValue(result,`candidate_${index+1}_fit`),necessary:answerValue(result,`candidate_${index+1}_necessary`)}));
    let selected=rows.filter(item=>Number.isFinite(item.necessary)&&item.necessary>=0.5);
    if(!selected.length){
        const ranked=rows.filter(item=>Number.isFinite(item.fit)).sort((a,b)=>b.fit-a.fit);
        if(ranked[0])selected=[ranked[0]];
    }
    return {handled:true,result,rows,selectedIds:selected.map(item=>item.id),reason:'assist-success'};
}
export async function evaluateSummaryHistoricalRerankShadow(context,options={}){
    return evaluateDecisionSite(SUMMARY_HISTORICAL_RERANK_SITE_ID,context,{mode:DECISION_MODE.SHADOW,...options});
}
export async function recordSummaryHistoricalRerankOutcome(shadowPromise,{authoritativeIds=[],candidateIds=[]}={}){
    try{
        const result=await shadowPromise;if(!result?.ok||result?.stale)return result;
        const scores=[];for(let i=1;i<=8;i+=1){const score=answerValue(result,`candidate_${i}_fit`);if(Number.isFinite(score))scores.push({slot:i,score});}
        scores.sort((a,b)=>b.score-a.score||a.slot-b.slot);
        const stateIds=(candidateIds||[]).map(String);
        const topId=stateIds[scores[0]?.slot-1]||null;
        const selected=new Set((authoritativeIds||[]).map(String));
        recordDecisionShadowComparison({contractId:result.contractId,provider:result.provider,agreement:topId?selected.has(topId):null,potentialExpensiveLlmCallAvoided:result.providerClass===DECISION_PROVIDER_CLASS.TYPED_DECISION,details:{authoritativeIds:[...selected],shadowTopCandidateId:topId,comparisonBasis:'shadow top-candidate presence only; existing Summary recall selection remains authoritative',latencyMs:result.latencyMs,usage:result.usage}});
        return result;
    }catch{return null;}
}

export const NOTEBOOK_MATERIAL_CHANGE_SITE=registerDecisionSite({
    id:NOTEBOOK_MATERIAL_CHANGE_SITE_ID,subsystem:'notebook',
    contract:{id:NOTEBOOK_MATERIAL_CHANGE_SITE_ID,version:1,subsystem:'notebook',questions:{material_change:{type:'noul'},change_degree:{type:'score'}}},
    mode:DECISION_MODE.ASSIST,priority:65,
    buildState(context={}){return {priorNotebook:bounded(context.priorNotebook,12000),newEvidence:(context.evidence||[]).slice(-12).map(row=>({id:String(row.evidenceId||row.id||''),text:bounded(row.text,5000)})),characterNames:[...(context.characterNames||[])].slice(0,24)};},
    buildQuestions(){return {material_change:{type:'noul',instructions:'Does the new evidence materially change the bounded rolling Notebook current state, active direction, commitments, unresolved hooks, or user intent enough to justify rewriting it?'},change_degree:{type:'score',instructions:'How much would the rolling current-state Notebook need to change?',criteria:['No persistent change','Tiny wording-only change','Small useful update','Material state update','Major current-state rewrite']}};},
    getSourceFingerprint(context){return context.sourceFingerprint||notebookMaterialChangeFingerprint(context);},
    getCurrentSourceFingerprint(context){return typeof context.readCurrentSourceFingerprint==='function'?context.readCurrentSourceFingerprint():'missing-current-fingerprint';},
    interpret(result){return {materialChange:answerValue(result,'material_change'),changeDegree:answerValue(result,'change_degree')};},
    metadata:{decisionClass:'material-change',shadowOnly:false,assist:true,manualRefreshGate:false,boundary:'after-evidence-before-notebook-worker'},
});
export async function evaluateNotebookMaterialChangeAssist(context,options={}){
    const result=await evaluateDecisionSite(NOTEBOOK_MATERIAL_CHANGE_SITE_ID,context,{mode:DECISION_MODE.ASSIST,...options});
    if(!result?.ok||result?.stale)return {handled:false,result,reason:result?.stale?'stale':'decision-failed'};
    const probability=answerValue(result,'material_change');
    const degree=answerValue(result,'change_degree');
    const material=(Number.isFinite(probability)&&probability>=0.5)||(Number.isFinite(degree)&&degree>=0.5);
    return {handled:true,material,result,probability,degree,reason:'assist-success'};
}
export async function evaluateNotebookMaterialChangeShadow(context,options={}){
    return evaluateDecisionSite(NOTEBOOK_MATERIAL_CHANGE_SITE_ID,context,{mode:DECISION_MODE.SHADOW,...options});
}
export async function recordNotebookMaterialChangeOutcome(shadowPromise,{actualChanged,reason=''}={}){
    try{
        const result=await shadowPromise;if(!result?.ok||result?.stale)return result;
        const probability=answerValue(result,'material_change');
        recordDecisionShadowComparison({contractId:result.contractId,provider:result.provider,agreement:Number.isFinite(probability)?((probability>=0.5)===Boolean(actualChanged)):null,potentialExpensiveLlmCallAvoided:result.providerClass===DECISION_PROVIDER_CLASS.TYPED_DECISION&&actualChanged===false,details:{actualChanged:Boolean(actualChanged),materialChangeProbability:probability,comparisonBasis:'shadow telemetry only; 0.5 direction is not a production skip threshold',reason,latencyMs:result.latencyMs,usage:result.usage}});
        return result;
    }catch{return null;}
}

export const SUMMARY_DURABLE_ROUTING_SITE=registerDecisionSite({
    id:SUMMARY_DURABLE_ROUTING_SITE_ID,subsystem:'summary',
    contract:{id:SUMMARY_DURABLE_ROUTING_SITE_ID,version:1,subsystem:'summary',questions:{durable_world_lore:{type:'noul'},durable_character_state:{type:'noul'},primarily_temporary:{type:'noul'}}},
    mode:DECISION_MODE.ASSIST,priority:50,
    buildState(context={}){const r=context.record||{};return {
        summary:{id:String(r.id||''),layer:Number(r.layer)||0,turnRange:r.turnRange||null,topics:(r.topics||[]).slice(0,12),characters:(r.characters||[]).slice(0,16),locations:(r.locations||[]).slice(0,16),threads:(r.threads||[]).slice(0,16),text:bounded(r.text,12000)},
        characterState:bounded(context.characterState||'',3200),
        characterStateOwners:stable(context.characterStateOwners||{}),
        canonicalHints:stable(context.canonicalHints||{}),
    };},
    buildQuestions(){return {
        durable_world_lore:{type:'noul',instructions:'Evaluate `summary.text` together with `summary.topics`, `summary.characters`, `summary.locations`, `summary.threads`, `summary.turnRange`, `characterState`, `characterStateOwners`, and the read-only existing-canon comparison in `canonicalHints`. Does this Summary establish genuinely NEW persistent canon worth invoking the existing Lore Router worker for? Yes requires reusable future-scene canon such as a lasting world/event/location/organization/rule/item/ability/arc fact that is not already covered by the supplied canonical candidates and has no better configured Character State owner. A durable character-specific fact with no configured Character Bank owner may still belong in lore when it clearly needs persistent canonical storage. Ordinary conversation, emotional texture, routine scene progression, logistics, transient state, an already-covered fact, or character-specific state with an appropriate configured Character Bank owner is no.'},
        durable_character_state:{type:'noul',instructions:'Compare `summary.text` and `summary.characters` with the current tracked `characterState` and `characterStateOwners`. Does this Summary establish a materially NEW persistent/current tracked character-specific state worth invoking the existing Character State review worker for? Answer yes only when `characterStateOwners.relevant` identifies a configured Character Bank capable of owning the affected character. Examples include durable relationship/role/allegiance, condition, equipment/capability state, goal, title/status, or lasting physical change. Fleeting reactions, ordinary dialogue, state already present/pending in `characterState`, or character facts with no configured Character Bank owner are no.'},
        primarily_temporary:{type:'noul',instructions:'Evaluate `summary.text` and `summary.turnRange`. Is this Summary primarily narrative continuity or temporary/current-scene working information rather than persistent generic canon or persistent Character State? This may be yes even though the Summary remains valuable Narrative Memory.'}
    };},
    getSourceFingerprint(context){return context.sourceFingerprint||summaryDurableRoutingFingerprint(context.record,{chatId:context.chatId,sourceVersion:context.sourceVersion,characterState:context.characterState,characterStateOwners:context.characterStateOwners,canonicalHints:context.canonicalHints});},
    getCurrentSourceFingerprint(context){return typeof context.readCurrentSourceFingerprint==='function'?context.readCurrentSourceFingerprint():'missing-current-fingerprint';},
    interpret(result){return {lore:answerValue(result,'durable_world_lore'),character:answerValue(result,'durable_character_state'),temporary:answerValue(result,'primarily_temporary')};},
    metadata:{decisionClass:'durable-routing',shadowOnly:false,assist:true,canonicalMutation:false,boundary:'before-explicit-routing-job'},
});

export async function evaluateSummaryDurableRoutingAssist(context,options={}){
    const result=await evaluateDecisionSite(SUMMARY_DURABLE_ROUTING_SITE_ID,context,{mode:DECISION_MODE.ASSIST,...options});
    if(!result?.ok||result?.stale)return {handled:false,result,reason:result?.stale?'stale':'decision-failed'};
    const lore=answerValue(result,'durable_world_lore');
    const character=answerValue(result,'durable_character_state');
    const temporary=answerValue(result,'primarily_temporary');
    if(!Number.isFinite(lore)||!Number.isFinite(character)||!Number.isFinite(temporary))return {handled:false,result,reason:'invalid-probabilities',lore,character,temporary};
    return {handled:true,result,reason:'assist-success',lore,character,temporary};
}

function durableKey(memoryId,chatId=''){return `${String(chatId||'')}|${String(memoryId||'')}`;}
export function getSummaryDurableRoutingShadowSnapshot(memoryId,{chatId='',sourceFingerprint=null}={}){const key=durableKey(memoryId,chatId),row=durableRoutingShadow.get(key);if(!row)return null;if(sourceFingerprint&&String(row.sourceFingerprint||'')!==String(sourceFingerprint)){durableRoutingShadow.delete(key);return null;}return JSON.parse(JSON.stringify(row));}
export function getSummaryDurableRoutingEventName(){return DURABLE_EVENT;}
export function queueSummaryDurableRoutingShadow({record,chatId='',sourceVersion=null,sourceFingerprint=null,readCurrentSourceFingerprint=null}={}){
    if(!record?.id)return null;
    const memoryId=String(record.id);const normalizedChatId=String(chatId||'');
    const context={record,chatId:normalizedChatId,sourceVersion,sourceFingerprint:sourceFingerprint||summaryDurableRoutingFingerprint(record,{chatId:normalizedChatId,sourceVersion}),readCurrentSourceFingerprint};
    import('../decision/work-director-bridge.js').then(({startDecisionSiteThroughDirector})=>{
        const handle=startDecisionSiteThroughDirector(SUMMARY_DURABLE_ROUTING_SITE_ID,context,{source:'summary-durable-routing-shadow',mode:DECISION_MODE.SHADOW});
        handle.promise.then(run=>{const result=run?.job?.result?.value?.decision||null;if(!result?.ok||result?.stale)return;const key=durableKey(memoryId,normalizedChatId);durableRoutingShadow.delete(key);durableRoutingShadow.set(key,{memoryId,chatId:normalizedChatId,sourceFingerprint:context.sourceFingerprint,at:Date.now(),provider:result.provider||null,lore:answerValue(result,'durable_world_lore'),character:answerValue(result,'durable_character_state'),temporary:answerValue(result,'primarily_temporary')});while(durableRoutingShadow.size>MAX_DURABLE_ROUTING_SHADOW_ROWS){const oldest=durableRoutingShadow.keys().next().value;if(oldest==null)break;durableRoutingShadow.delete(oldest);}emitDurable();}).catch(()=>{});
    }).catch(()=>{});
    return {queued:true,memoryId,chatId:normalizedChatId};
}
