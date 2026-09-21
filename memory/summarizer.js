import { getContext } from '../../../../st-context.js';
import { getSettings } from '../core/settings.js';
import { BUS_STAGE, BUS_PRIORITY } from '../sidecar/bus.js';
import { NEXUS_BATCH_DOMAIN, structuredSidecarOptions } from '../nexus/batch-layer.js';
import { enqueueLaneAModelWorkerJob, runLaneAModelWorkerBatch } from './model-worker.js';
import { summaryDurableRoutingFingerprint } from './decision-sites.js';
import { logEvent } from '../observability/telemetry.js';
import { previewMemoryRecordCreate, previewMemoryPromotion, getActiveMemories, getActiveLayerRecords, getMemoryStore, getMemoryRecord, reviseMemoryRecord, memoryRecordVersion, getEffectiveSummarizedUpTo, hasActiveMemoryStory } from './store.js';
import { buildCharacterSummaryDirective } from './character-banks.js';
import {
    buildMemorySummaryAssumptions,
    buildMemoryPromotionAssumptions,
    abortNexusTransaction,
    beginMemorySummaryTransaction,
    beginMemoryPromotionTransaction,
    enforceNexusTransactionFreshBeforeStage,
    failNexusTransactionDurable as failNexusTransaction,
    finalizeMemorySummaryTransaction,
    finalizeMemoryPromotionTransaction,
    markNexusTransactionAggregating,
    recordNexusTransactionSlice,
    updateNexusTransactionExecution,
} from '../nexus/transaction-service.js';
import { listAssistantTurns, planAutomaticSummaryWindow, planManualNextSummaryWindow, planManualAssistantRange, planManualMessageRange } from './range-planner.js';
import { parseStructuredJsonCandidate } from '../sidecar/normalize-response.js';
import { validateSummaryEvidencePayload, validateSummaryFinalPayload } from '../sidecar/semantic-validation.js';
import {
    LOGICAL_SOFT_PACKING_TARGET,
    assertPhysicalPromptBounded,
    packValidatedItems,
    resolvePhysicalPackingBudget,
    sliceChronologicalRows,
    sliceSemanticText,
} from '../nexus/large-input-reshape.js';
import { captureNexusWorkScope, isNexusWorkScopeFresh } from '../nexus/work-scope.js';
import { commitCanonicalNexusMutation } from '../nexus/mutation-coordinator.js';


import { estimateContentTokens } from '../observability/token-estimator.js';

// Direct narrative synthesis remains deliberately conservative: live HF27 evidence
// showed medium direct prose requests could monopolize both Sidecars. Once a
// Summary crosses this boundary Nexus switches to structured evidence extraction.
const SUMMARY_DIRECT_INPUT_TARGET = 3000;
const DEFAULT_SUMMARY_EVIDENCE_INPUT_TARGET = 7000;

export function resolveSummaryEvidenceSliceTargetTokens({settings=getSettings(),physicalPromptTargetTokens=LOGICAL_SOFT_PACKING_TARGET}={}){
    const configured=Number(settings?.nexus?.batchLayer?.summaryInputTokens);
    const semanticTarget=Number.isFinite(configured)&&configured>0?Math.floor(configured):DEFAULT_SUMMARY_EVIDENCE_INPUT_TARGET;
    return Math.max(1200,Math.min(Math.floor(Number(physicalPromptTargetTokens)||LOGICAL_SOFT_PACKING_TARGET),Math.max(1200,semanticTarget)));
}

function cleanJsonText(text=''){
    let s=String(text||'').trim();
    const fenced=s.match(/```(?:json)?\s*([\s\S]*?)```/i);if(fenced)s=fenced[1].trim();
    const a=s.indexOf('{'),b=s.lastIndexOf('}');if(a>=0&&b>a)s=s.slice(a,b+1);
    return s;
}
function parseJson(text,label='Summary Sidecar'){
    try{return JSON.parse(cleanJsonText(text));}catch(err){throw new Error(`${label} returned invalid JSON: ${err.message}`);}
}
function uniqStrings(v){return [...new Set((Array.isArray(v)?v:[]).map(x=>String(x||'').trim()).filter(Boolean))];}
function hashText(text=''){
    let h=2166136261>>>0;for(let i=0;i<text.length;i++){h^=text.charCodeAt(i);h=Math.imul(h,16777619);}return (h>>>0).toString(16).padStart(8,'0');
}
function speakerLabel(m){return m?.is_user?'User':String(m?.name||'Assistant');}
function isNarrativeMessage(m){return !!m&&!m.is_system&&String(m.mes||'').trim().length>0;}
const assistantTurns=listAssistantTurns;
function buildPassage(chat,start,end){
    const rows=[];for(let i=Math.max(0,start);i<=Math.min(chat.length-1,end);i++){const m=chat[i];if(!isNarrativeMessage(m))continue;rows.push(`[${speakerLabel(m)} | message ${i}]\n${String(m.mes||'').trim()}`);}return rows.join('\n\n');
}
function messageIds(chat,start,end){const ids=[];for(let i=start;i<=end;i++){const m=chat[i];if(!isNarrativeMessage(m))continue;ids.push(String(m?.extra?.tv2_message_id||i));}return ids;}

function sourceMessagesForSummary(chat,start,end){
    const rows=[];
    for(let i=Math.max(0,start);i<=Math.min(chat.length-1,end);i++){
        const m=chat[i];if(!isNarrativeMessage(m))continue;
        rows.push({index:i,isUser:m?.is_user===true,messageId:String(m?.extra?.tv2_message_id||i),text:String(m?.mes||'')});
    }
    return rows;
}
function summaryAssumptions(plan,chat,passage,prior){
    return buildMemorySummaryAssumptions({
        chatId:getContext()?.chatId||null,
        sourceRange:[plan.start,plan.end],
        sourceMessages:sourceMessagesForSummary(chat,plan.start,plan.end),
        summarizedUpTo:getEffectiveSummarizedUpTo(),
        priorMemoryFingerprint:hashText(prior||''),
        passageFingerprint:hashText(passage||''),
        relevantState:{memorySchema:'summary-bank/v3'},
    });
}
function enqueueSummarySidecar(enqueueSidecar,stage,options){
    const handle=typeof enqueueSidecar==='function'?enqueueSidecar(stage,options):enqueueLaneAModelWorkerJob(NEXUS_BATCH_DOMAIN.MEMORY_BANK,stage,options);
    if(!handle||!handle.promise||typeof handle.promise.then!=='function')throw new Error('Summary Sidecar dispatcher did not return a valid job handle.');
    return handle;
}
function priorContextForLayer(targetLayer=0,beforeMessageIndex=Infinity){
    const active=getActiveMemories();
    const selected=active.filter(r=>r.layer>=targetLayer&&(!r.turnRange||r.turnRange[1]<beforeMessageIndex)).sort((a,b)=>b.layer-a.layer||a.createdAt-b.createdAt);
    if(!selected.length)return '(none yet)';
    return selected.map(r=>`[L${r.layer} ${r.turnRange?`turns ${r.turnRange[0]}-${r.turnRange[1]}`:''}] ${r.text}`).join('\n');
}

export function inspectSummaryEligibility(){
    if(!hasActiveMemoryStory())return {due:false,reason:'no-active-story',assistantTurns:0};
    const settings=getSettings().memoryBank||{};const chat=getContext()?.chat||[];const effectiveSummarizedUpTo=getEffectiveSummarizedUpTo();
    return planAutomaticSummaryWindow({turns:assistantTurns(chat),summarizedUpTo:effectiveSummarizedUpTo,verbatimTurns:settings.verbatimTurns??10,turnsPerSummary:settings.turnsPerSummary??3,catchUpAssistantTurns:settings.catchUpAssistantTurns??24,catchUpThresholdAssistantTurns:settings.catchUpThresholdAssistantTurns??12});
}


function inspectForcedEligibility(){
    if(!hasActiveMemoryStory())return {due:false,reason:'no-active-story',assistantTurns:0,summarizedUpTo:-1};
    const settings=getSettings().memoryBank||{};const chat=getContext()?.chat||[];const effectiveSummarizedUpTo=getEffectiveSummarizedUpTo();
    return planManualNextSummaryWindow({turns:assistantTurns(chat),summarizedUpTo:effectiveSummarizedUpTo,turnsPerSummary:settings.turnsPerSummary??3,catchUpAssistantTurns:settings.catchUpAssistantTurns??24,catchUpThresholdAssistantTurns:settings.catchUpThresholdAssistantTurns??12});
}

export function inspectManualNextSummary(){ return inspectForcedEligibility(); }

export function inspectManualSummaryRange({fromTurn=null,toTurn=null,turnCount=null}={}){
    if(!hasActiveMemoryStory()){
        const error=new Error('Select a chat before creating a Summary.');
        error.name='TV2MemoryStoryScopeUnavailable';
        throw error;
    }
    return planManualAssistantRange({chat:getContext()?.chat||[],summarizedUpTo:getEffectiveSummarizedUpTo(),fromTurn,toTurn,turnCount});
}

function normalizeSummaryPayload(parsed){
    const text=String(parsed.summary||parsed.text||'').trim();
    if(!text)throw new Error('Summary Sidecar returned an empty summary.');
    return {text,evidence:uniqStrings(parsed.evidence),characters:uniqStrings(parsed.characters),locations:uniqStrings(parsed.locations),dates:uniqStrings(parsed.dates),topics:uniqStrings(parsed.topics),threads:uniqStrings(parsed.threads)};
}


function summaryEvidenceRows(chat,start,end){
    return sourceMessagesForSummary(chat,start,end).map(row=>({
        ...row,
        evidenceId:`M${row.index}`,
    }));
}
function renderSummaryEvidenceRow(row){
    return `[${row.evidenceId} | ${row.isUser?'User':'Assistant'} | message ${row.index}]\n${String(row.text||'').trim()}`;
}
function summarySlicePrompt(passage, ids, characterFocus=''){
    return `Nexus SUMMARY EVIDENCE EXTRACTION\n\nSOURCE SLICE\n${passage}\n\nTASK\nExtract only durable events/facts from this chronological slice. Preserve chronology, decisions, promises, relationship shifts, motives, functional emotional/behavioral texture, locations, dates, and unresolved threads. Do not write a prose summary and do not infer beyond the supplied slice. Every event must cite one or more exact evidence IDs from this slice: ${ids.join(', ')}.${characterFocus}\nReturn ONLY JSON:\n{"events":[{"text":"durable event/fact","evidence":["M12"],"order":0}],"characters":[],"locations":[],"dates":[],"topics":[],"threads":[]}`;
}
function summaryAggregationPrompt(prior, evidencePayloads, characterFocus=''){
    const allowed=[...new Set((evidencePayloads||[]).flatMap(item=>(item.events||[]).flatMap(event=>event.evidence||[])))];
    return `Nexus RECURSIVE MEMORY — FINAL LAYER 0 DELTA\n\nPRIOR MEMORY\n${prior}\n\nVALIDATED CHRONOLOGICAL EVIDENCE\n${JSON.stringify(evidencePayloads)}\n\nTASK\nWrite only the durable narrative delta needed to continue this roleplay later. The evidence objects are validated source-derived events; preserve their chronology and functional emotional texture. Do not repeat facts already established in PRIOR MEMORY. Do not invent canon. This is the only prose-synthesis phase; do not expose analysis.${characterFocus}\nAllowed evidence IDs: ${allowed.join(', ')}. Cite at least one exact validated evidence ID used by the final summary.\nReturn ONLY JSON:\n{"summary":"compact narrative memory","evidence":["M12"],"characters":[],"locations":[],"dates":[],"topics":[],"threads":[]}`;
}
function summaryEvidenceReductionPrompt(items){
    const allowed=[...new Set(items.flatMap(item=>(item.events||[]).flatMap(event=>event.evidence||[])))];
    return `Nexus SUMMARY EVIDENCE CONSOLIDATION\n\nVALIDATED EVIDENCE OBJECTS\n${JSON.stringify(items)}\n\nTASK\nConsolidate these structured events into fewer chronological durable event clusters. This is not prose summarization. Preserve every distinct load-bearing event, relationship/decision change, unresolved thread, and all supporting evidence IDs. Merge only redundant/closely coupled events. Keep evidence IDs exact and ordered. Allowed IDs: ${allowed.join(', ')}.\nReturn ONLY JSON:\n{"events":[{"text":"durable event cluster","evidence":["M12"],"order":0}],"characters":[],"locations":[],"dates":[],"topics":[],"threads":[]}`;
}
function mergeEvidenceMetadata(payloads){
    const out={events:[],characters:[],locations:[],dates:[],topics:[],threads:[]};
    for(const payload of payloads){
        out.events.push(...(payload.events||[]));
        for(const field of ['characters','locations','dates','topics','threads'])out[field].push(...(payload[field]||[]));
    }
    out.events.sort((a,b)=>Number(a.order||0)-Number(b.order||0));
    for(const field of ['characters','locations','dates','topics','threads'])out[field]=uniqStrings(out[field]);
    return out;
}
async function reduceSummaryEvidenceToFit({payloads,prior,characterFocus,packing,transactionId,enqueueSidecar=null}){
    let current=payloads.map((payload,index)=>({...payload,__sliceOrder:index}));
    for(let round=0;round<12;round++){
        const finalPrompt=summaryAggregationPrompt(prior,current,characterFocus),beforeTokens=estimateContentTokens(finalPrompt);
        if(beforeTokens<=packing.promptTargetTokens)return current;
        const groups=packValidatedItems({items:current,buildPrompt:items=>summaryEvidenceReductionPrompt(items),targetTokens:packing.promptTargetTokens,label:'Summary validated evidence'});
        if(!groups.length)return current;
        const reduced=[];
        for(const group of groups){
            const allowed=[...new Set(group.items.flatMap(item=>(item.events||[]).flatMap(event=>event.evidence||[])))];
            const prompt=summaryEvidenceReductionPrompt(group.items);
            assertPhysicalPromptBounded(prompt,packing.promptTargetTokens,'Summary evidence consolidation');
            const result=await runLaneAModelWorkerBatch({
                laneAEnqueue:enqueueSidecar,
                domain:NEXUS_BATCH_DOMAIN.MEMORY_BANK,stage:BUS_STAGE.SUMMARY,items:[{group,allowed}],requestedBatch:false,
                buildRequest:item=>structuredSidecarOptions({prompt,systemPrompt:'You consolidate validated Nexus summary evidence. Return exact JSON only.',maxTokens:Math.min(2048,packing.resourcePolicy.outputCeilingTokens||2048),priority:BUS_PRIORITY.SUMMARY,structuredValidator:value=>validateSummaryEvidencePayload(value,item.allowed),telemetry:{summaryReshape:true,phase:'evidence-consolidation',round,group:group.index}}),
                parse:(text,item)=>parseStructuredJsonCandidate(text,{validator:value=>validateSummaryEvidencePayload(value,item.allowed),label:'Summary evidence consolidation'}),
                validate:(value,item)=>validateSummaryEvidencePayload(value,item.allowed),
                buildRecovery:(item)=>structuredSidecarOptions({prompt:`${prompt}\n\nRECOVERY: The prior response violated the structured evidence contract. Return one corrected JSON object only; preserve all allowed evidence IDs that support retained events.`,systemPrompt:'Return corrected structured evidence JSON only.',maxTokens:Math.min(2048,packing.resourcePolicy.outputCeilingTokens||2048),priority:BUS_PRIORITY.SUMMARY,structuredValidator:value=>validateSummaryEvidencePayload(value,item.allowed),telemetry:{summaryReshape:true,phase:'evidence-consolidation-recovery',round,group:group.index}}),
            });
            const outcome=result.completed[0];
            if(!outcome)throw new Error(result.failed[0]?.error?.message||'Summary evidence consolidation failed after bounded recovery.');
            reduced.push({...outcome.value,__sliceOrder:group.index});
        }
        current=reduced;
        const afterTokens=estimateContentTokens(summaryAggregationPrompt(prior,current,characterFocus)),noProgress=afterTokens>=beforeTokens;
        updateNexusTransactionExecution(transactionId,{aggregation:{phase:'evidence-consolidation',round:round+1,groupCount:groups.length,remainingPayloads:current.length,beforeTokens,afterTokens,noProgress,softTargetUnresolved:afterTokens>packing.promptTargetTokens}},'aggregation-consolidated');
        if(noProgress)return current;
    }
    updateNexusTransactionExecution(transactionId,{aggregation:{phase:'evidence-consolidation',softTargetUnresolved:true,reason:'soft-compaction-round-limit'}},'aggregation-soft-target-unresolved');
    return current;
}

export async function createNextSummary({cycleId=null,manual=false,range=null,assistantRange=null,turnCount=null,enqueueSidecar=null,directorMeta=null}={}){
    const settings=getSettings();if(!settings.enabled||settings.memoryBank?.enabled===false)return {skipped:true,reason:'disabled'};
    if(!hasActiveMemoryStory())return {skipped:true,reason:'no-active-story'};
    const chat=getContext()?.chat||[];
    let plan;
    if(assistantRange||turnCount!=null)plan=inspectManualSummaryRange({fromTurn:assistantRange?.fromTurn??assistantRange?.start??null,toTurn:assistantRange?.toTurn??assistantRange?.end??null,turnCount});
    else if(range&&(range?.fromMessage!=null||range?.toMessage!=null))plan=planManualMessageRange({chat,summarizedUpTo:getEffectiveSummarizedUpTo(),fromMessage:range?.fromMessage,toMessage:range?.toMessage});
    else if(range&&Number.isFinite(Number(range.start))&&Number.isFinite(Number(range.end))){
        plan=planManualMessageRange({chat,summarizedUpTo:getEffectiveSummarizedUpTo(),fromMessage:Number(range.start)+1,toMessage:Number(range.end)+1});
    } else plan=manual?inspectForcedEligibility():inspectSummaryEligibility();
    logEvent('summary','eligibility',{...plan,cycleId,manual},plan.due?'info':'debug');
    if(!plan.due)return {skipped:true,...plan};
    const passage=buildPassage(chat,plan.start,plan.end);if(!passage.trim())return {skipped:true,reason:'empty-passage'};
    const prior=priorContextForLayer(0,plan.start),assumptions=summaryAssumptions(plan,chat,passage,prior),characterFocus=buildCharacterSummaryDirective();
    const rows=summaryEvidenceRows(chat,plan.start,plan.end);
    const systemPrompt='You are Nexus recursive narrative memory. Structured extraction must preserve source evidence; final synthesis returns exact JSON only.';
    const packing=resolvePhysicalPackingBudget({role:'summaries',stage:BUS_STAGE.SUMMARY,domain:NEXUS_BATCH_DOMAIN.MEMORY_BANK,phase:'summary-reshape',requestedMaxTokens:2048,systemPrompt,settings:getSettings(),sliceInstructions:'structured chronological evidence extraction and final synthesis'});
    const summaryEvidenceTargetTokens=resolveSummaryEvidenceSliceTargetTokens({settings,physicalPromptTargetTokens:packing.promptTargetTokens});
    let transaction=beginMemorySummaryTransaction({assumptions,metadata:{cycleId,manual,director:directorMeta||null},execution:{logicalJobId:`summary:${getContext()?.chatId||''}:${plan.start}:${plan.end}`,settings:{context:'memoryBank',softPackingTarget:LOGICAL_SOFT_PACKING_TARGET,physicalPromptTarget:packing.promptTargetTokens,directInputTarget:SUMMARY_DIRECT_INPUT_TARGET,evidenceSliceTarget:summaryEvidenceTargetTokens},sliceManifest:[]}}),transactionId=transaction.id;
    try{
        const directEvidenceIds=rows.map(row=>row.evidenceId),directEvidencePassage=rows.map(renderSummaryEvidenceRow).join('\n\n');
        const fullPrompt=`Nexus RECURSIVE MEMORY — LAYER 0 DELTA SUMMARY\n\nPRIOR MEMORY\n${prior}\n\nNEW PASSAGE WITH EVIDENCE IDS\n${directEvidencePassage}\n\nTASK\nWrite only the durable narrative delta needed to continue this roleplay later. Do not repeat facts already established in PRIOR MEMORY. Preserve emotional texture when it is functional: relationship-specific behavior, meaningful physicality, motives, promises, decisions, shifts in trust, distinctive sensory/behavioral tells, chronology, location, and unresolved threads. Compress ordinary prose and repeated atmosphere. Do not invent canon.${characterFocus} Cite at least one exact evidence ID from: ${directEvidenceIds.join(', ')}.\nReturn ONLY JSON:\n{"summary":"compact narrative memory","evidence":["M12"],"characters":[],"locations":[],"dates":[],"topics":[],"threads":[]}`;
        let payload,responseSlot=null,resolvedJobId=null,reshapeUsed=false;
        const directPromptTokens=estimateContentTokens(fullPrompt);
        if(directPromptTokens<=SUMMARY_DIRECT_INPUT_TARGET){
            assertPhysicalPromptBounded(fullPrompt,packing.promptTargetTokens,'Summary direct request');
            updateNexusTransactionExecution(transactionId,{sliceManifest:[{id:'summary-direct',order:0,kind:'final-direct'}]},'slice-manifest-planned');
            const batch=await runLaneAModelWorkerBatch({laneAEnqueue:enqueueSidecar,domain:NEXUS_BATCH_DOMAIN.MEMORY_BANK,stage:BUS_STAGE.SUMMARY,items:[{id:'summary-direct'}],requestedBatch:false,
                buildRequest:item=>structuredSidecarOptions({prompt:fullPrompt,systemPrompt,maxTokens:Math.min(2048,packing.resourcePolicy.outputCeilingTokens||2048),priority:BUS_PRIORITY.SUMMARY,structuredValidator:value=>validateSummaryFinalPayload(value,directEvidenceIds),telemetry:{memoryLayer:0,cycleId,manual,summaryReshape:false,...(directorMeta||{})}}),
                parse:text=>parseStructuredJsonCandidate(text,{validator:value=>validateSummaryFinalPayload(value,directEvidenceIds),label:'Summary Sidecar'}),validate:value=>validateSummaryFinalPayload(value,directEvidenceIds),
                buildRecovery:()=>structuredSidecarOptions({prompt:`${fullPrompt}\n\nRECOVERY: Return one corrected final JSON object only.`,systemPrompt,maxTokens:Math.min(2048,packing.resourcePolicy.outputCeilingTokens||2048),priority:BUS_PRIORITY.SUMMARY,structuredValidator:value=>validateSummaryFinalPayload(value,directEvidenceIds),telemetry:{memoryLayer:0,cycleId,manual,summaryRecovery:true}})});
            const outcome=batch.completed[0];if(!outcome){recordNexusTransactionSlice(transactionId,{sliceId:'summary-direct',failed:true});throw new Error(batch.failed[0]?.error?.message||'Summary Sidecar failed after bounded recovery.');}
            recordNexusTransactionSlice(transactionId,{sliceId:'summary-direct',recovered:outcome.recovered===true});payload=normalizeSummaryPayload(outcome.value);responseSlot=outcome.response?.tv2?.slot||null;resolvedJobId=outcome.jobId||outcome.response?.tv2?.jobId||null;
        } else {
            reshapeUsed=true;
            const slices=sliceChronologicalRows({rows,renderRow:renderSummaryEvidenceRow,buildPrompt:(slicePassage,sliceRows)=>summarySlicePrompt(slicePassage,sliceRows.map(row=>row.evidenceId),characterFocus),targetTokens:summaryEvidenceTargetTokens,label:'Summary chronological passage'});
            logEvent('summary','reshape-plan',{cycleId,manual,start:plan.start,end:plan.end,directPromptTokens,directInputTarget:SUMMARY_DIRECT_INPUT_TARGET,evidenceSliceTargetTokens:summaryEvidenceTargetTokens,physicalPromptTargetTokens:packing.promptTargetTokens,sliceCount:slices.length,sliceEstimatedInputTokens:slices.map(slice=>slice.estimatedInputTokens)},'debug');
            const manifest=slices.map(slice=>({id:`summary-slice-${slice.index}`,order:slice.index,kind:'chronological-evidence',sourceMessageIds:slice.rows.map(row=>row.messageId),evidenceIds:slice.rows.map(row=>row.evidenceId),estimatedInputTokens:slice.estimatedInputTokens}));
            updateNexusTransactionExecution(transactionId,{sliceManifest:manifest,status:'executing'},'slice-manifest-planned');
            const batch=await runLaneAModelWorkerBatch({laneAEnqueue:enqueueSidecar,domain:NEXUS_BATCH_DOMAIN.MEMORY_BANK,stage:BUS_STAGE.SUMMARY,items:slices,requestedBatch:slices.length>1,label:`Summary evidence · messages ${plan.start}-${plan.end}`,priority:BUS_PRIORITY.SUMMARY,dedupKey:`summary-evidence:${getContext()?.chatId||''}:${plan.start}:${plan.end}`,telemetry:{memoryLayer:0,cycleId,manual,summaryReshape:true,...(directorMeta||{})},
                buildRequest:slice=>{const ids=slice.rows.map(row=>row.evidenceId),prompt=summarySlicePrompt(slice.passage,ids,characterFocus);assertPhysicalPromptBounded(prompt,packing.promptTargetTokens,'Summary evidence slice');return structuredSidecarOptions({prompt,systemPrompt:'Extract validated chronological summary evidence only. Return exact JSON.',maxTokens:Math.min(2048,packing.resourcePolicy.outputCeilingTokens||2048),priority:BUS_PRIORITY.SUMMARY,structuredValidator:value=>validateSummaryEvidencePayload(value,ids),telemetry:{summaryReshape:true,phase:'slice',sliceId:`summary-slice-${slice.index}`}});},
                parse:(text,slice)=>parseStructuredJsonCandidate(text,{validator:value=>validateSummaryEvidencePayload(value,slice.rows.map(row=>row.evidenceId)),label:`Summary slice ${slice.index}`}),
                validate:(value,slice)=>validateSummaryEvidencePayload(value,slice.rows.map(row=>row.evidenceId)),
                buildRecovery:slice=>{const ids=slice.rows.map(row=>row.evidenceId),prompt=`${summarySlicePrompt(slice.passage,ids,characterFocus)}\n\nRECOVERY: Correct the structured evidence contract only; do not broaden beyond this exact slice.`;return structuredSidecarOptions({prompt,systemPrompt:'Return corrected summary evidence JSON only.',maxTokens:Math.min(2048,packing.resourcePolicy.outputCeilingTokens||2048),priority:BUS_PRIORITY.SUMMARY,structuredValidator:value=>validateSummaryEvidencePayload(value,ids),telemetry:{summaryReshape:true,phase:'slice-recovery',sliceId:`summary-slice-${slice.index}`}});}});
            for(const outcome of batch.completed)recordNexusTransactionSlice(transactionId,{sliceId:`summary-slice-${outcome.unit.item.index}`,recovered:outcome.recovered===true,details:{jobId:outcome.jobId||null}});
            if(batch.failed.length){for(const outcome of batch.failed)recordNexusTransactionSlice(transactionId,{sliceId:`summary-slice-${outcome.unit.item.index}`,failed:true,details:{error:outcome.error?.message||String(outcome.error)}});abortNexusTransaction(transactionId,'Summary slice failed after its bounded recovery; completed slices were retained only as execution evidence and nothing was staged.');return {failed:true,error:batch.failed[0]?.error?.message||'Summary slice failed after bounded recovery.',transactionId,plan};}
            let evidence=batch.completed.map(outcome=>({...outcome.value,__sliceOrder:outcome.unit.item.index})).sort((a,b)=>a.__sliceOrder-b.__sliceOrder);
            markNexusTransactionAggregating(transactionId,{phase:'final-summary',inputSliceCount:evidence.length});
            evidence=await reduceSummaryEvidenceToFit({payloads:evidence,prior,characterFocus,packing,transactionId,enqueueSidecar});
            const finalEvidenceIds=[...new Set(evidence.flatMap(item=>(item.events||[]).flatMap(event=>event.evidence||[])))];const aggregatePrompt=summaryAggregationPrompt(prior,evidence,characterFocus);assertPhysicalPromptBounded(aggregatePrompt,packing.promptTargetTokens,'Summary final aggregation');
            const finalBatch=await runLaneAModelWorkerBatch({laneAEnqueue:enqueueSidecar,domain:NEXUS_BATCH_DOMAIN.MEMORY_BANK,stage:BUS_STAGE.SUMMARY,items:[{evidence}],requestedBatch:false,
                buildRequest:()=>structuredSidecarOptions({prompt:aggregatePrompt,systemPrompt,maxTokens:Math.min(2048,packing.resourcePolicy.outputCeilingTokens||2048),priority:BUS_PRIORITY.SUMMARY,structuredValidator:value=>validateSummaryFinalPayload(value,finalEvidenceIds),telemetry:{summaryReshape:true,phase:'final-aggregation',sliceCount:slices.length}}),
                parse:text=>parseStructuredJsonCandidate(text,{validator:value=>validateSummaryFinalPayload(value,finalEvidenceIds),label:'Summary final aggregation'}),validate:value=>validateSummaryFinalPayload(value,finalEvidenceIds),
                buildRecovery:()=>structuredSidecarOptions({prompt:`${aggregatePrompt}\n\nRECOVERY: Return the corrected final summary JSON only.`,systemPrompt,maxTokens:Math.min(2048,packing.resourcePolicy.outputCeilingTokens||2048),priority:BUS_PRIORITY.SUMMARY,structuredValidator:value=>validateSummaryFinalPayload(value,finalEvidenceIds),telemetry:{summaryReshape:true,phase:'final-aggregation-recovery'}})});
            const finalOutcome=finalBatch.completed[0];if(!finalOutcome){abortNexusTransaction(transactionId,'Summary aggregation failed after bounded recovery; no mutation was staged.');return {failed:true,error:finalBatch.failed[0]?.error?.message||'Summary aggregation failed.',transactionId,plan};}
            payload=normalizeSummaryPayload(finalOutcome.value);responseSlot=finalOutcome.response?.tv2?.slot||null;resolvedJobId=finalOutcome.jobId||finalOutcome.response?.tv2?.jobId||null;
        }
        const currentChat=getContext()?.chat||[],currentPassage=buildPassage(currentChat,plan.start,plan.end),currentPrior=priorContextForLayer(0,plan.start),currentAssumptions=summaryAssumptions(plan,currentChat,currentPassage,currentPrior);
        const fresh=enforceNexusTransactionFreshBeforeStage(transactionId,currentAssumptions);if(fresh.state==='stale'){logEvent('summary','transaction-stale',{cycleId,manual,transactionId,plan,freshness:fresh.freshness,pointerPreserved:true},'warn');return {deferred:true,reason:'transaction-stale',plan,transactionId,freshness:fresh.freshness};}
        transaction=finalizeMemorySummaryTransaction(transactionId,{draft:payload,metadata:{cycleId,manual,director:directorMeta||null,workerJobId:resolvedJobId,reshapeUsed}});if(transaction.state!=='staged')return {failed:true,error:transaction.error||'Summary transaction validation failed.',plan,transactionId};
        const rawForFingerprint=chat.slice(plan.start,plan.end+1).map(m=>`${m?.is_user?'u':'a'}:${m?.mes||''}`).join('\n');
        const durabilityContext=getContext(),beforeStore=JSON.parse(JSON.stringify(getMemoryStore()));
        const preview=previewMemoryRecordCreate({...payload,layer:0,turnRange:[plan.start,plan.end],assistantTurnRange:plan.assistantTurnRange||null,sourceMessageIds:messageIds(chat,plan.start,plan.end),sourceFingerprint:hashText(rawForFingerprint),sidecarSlot:responseSlot,cycleId,source:plan.reason==='manual-message-range'?'manual-range-summary':manual?'manual-summary':'summary'},beforeStore);
        const commit=await commitCanonicalNexusMutation(transactionId,{type:'metadata.set',chatId:String(durabilityContext?.chatId||''),key:'tv2_memory_bank',value:preview.store,expected:beforeStore},{context:durabilityContext,currentAssumptions:()=>summaryAssumptions(plan,getContext()?.chat||[],buildPassage(getContext()?.chat||[],plan.start,plan.end),priorContextForLayer(0,plan.start)),committed:()=>({memoryId:preview.record.id,turnRange:preview.record.turnRange,layer:0,reshapeUsed})});
        if(commit.state==='stale')return {deferred:true,reason:'transaction-stale',plan,transactionId,freshness:commit.freshness};
        const record=getMemoryRecord(preview.record.id);
        logEvent('summary','created',{cycleId,manual,jobId:resolvedJobId,transactionId,slot:responseSlot,memoryId:record.id,layer:0,turnRange:record.turnRange,reshapeUsed},'info');
        return {created:true,record,jobId:resolvedJobId,transactionId,slot:responseSlot,plan,reshapeUsed};
    }catch(error){const state=transactionId?undefined:null;if(transactionId){try{const current=/* read avoided to keep facade small */null;await failNexusTransaction(transactionId,error,{stage:'summary-create',recoveryRequired:error?.tv2RollbackRestored!==true});}catch{}}logEvent('summary','create-failed',{cycleId,manual,transactionId,plan,error,pointerPreserved:true},'error');return {failed:true,error:error?.message||String(error),transactionId,plan};}
}

export async function regenerateMemoryRecord(memoryId,{detail='balanced'}={}){
    const settings=getSettings(),context=getContext();const record=getMemoryRecord(memoryId);if(!record)throw new Error(`Memory ${memoryId} was not found.`);if(record.locked)throw new Error('Unlock this memory before regenerating it.');if(!record.turnRange)throw new Error('Only message-range memories can be regenerated.');
    const expectedVersion=memoryRecordVersion(record),scope=captureNexusWorkScope(context);const chat=context?.chat||[],[start,end]=record.turnRange,passage=buildPassage(chat,start,end);if(!passage.trim())throw new Error('The original message range is no longer available.');const sourceVersion=hashText(passage);
    const prompt=`Nexus MEMORY REGENERATION

Rewrite this existing ${detail} memory from the original passage. Preserve chronology, character texture, decisions, promises, and unresolved threads; do not invent canon.

CURRENT MEMORY
${record.text}

ORIGINAL PASSAGE
${passage}

Return ONLY JSON: {"summary":"replacement memory","characters":["..."],"locations":["..."],"dates":["..."],"topics":["..."],"threads":["..."]}`;
    const job=enqueueLaneAModelWorkerJob(NEXUS_BATCH_DOMAIN.MEMORY_BANK, BUS_STAGE.SUMMARY,structuredSidecarOptions({prompt,systemPrompt:'You are Nexus memory regeneration. Return exact JSON only.',reasoningEffort:settings.memoryBank?.reasoningEffort||'high',timeoutMs:Number(settings.memoryBank?.timeoutMs)||240000,priority:BUS_PRIORITY.SUMMARY,label:`Regenerate memory ${record.id.slice(-8)}`,telemetry:{memoryId:record.id,regeneration:true,detail}}));
    const response=await job.promise;if(!isNexusWorkScopeFresh(scope,getContext(),{checkRevision:true})){const error=new Error('Memory regeneration scope changed before commit.');error.name='TV2ScopeInvalidated';throw error;}
    const currentPassage=buildPassage(getContext()?.chat||[],start,end);if(hashText(currentPassage)!==sourceVersion){const error=new Error('The source passage changed while memory regeneration was in flight.');error.name='TV2MemoryRegenerationStale';throw error;}
    const payload=normalizeSummaryPayload(parseJson(response.text,'Memory regeneration Sidecar'));const revised=await reviseMemoryRecord(record.id,{...payload,sidecarSlot:response?.tv2?.slot||null},`regenerated:${detail}`,{expectedVersion});return revised;
}

export function inspectPromotionEligibility() {
    const settings = getSettings();
    if (!settings.enabled || settings.memoryBank?.enabled === false) return { due: false, reason: 'disabled' };
    if (!hasActiveMemoryStory()) return { due: false, reason: 'no-active-story' };
    const memory = settings.memoryBank || {};
    const maxLayers = Math.max(1, Number(memory.maxLayers) || 5);
    const threshold = Math.max(2, Number(memory.snippetsPerLayer) || 20);
    const take = Math.max(2, Number(memory.snippetsPerPromotion) || 3);
    for (let layer = 0; layer < maxLayers - 1; layer++) {
        const active = getActiveLayerRecords(layer).filter(record => record.locked !== true);
        if (active.length > threshold && Math.min(active.length, take) >= 2) {
            return { due: true, reason: 'promotion-due', layer, count: active.length, threshold, take, maxLayers };
        }
    }
    return { due: false, reason: 'no-promotion-due', threshold, take, maxLayers };
}

function promotionValidator(value, allowedEvidenceIds = [], requireAll = true) {
    const verdict=validateSummaryFinalPayload(value,allowedEvidenceIds);
    if(verdict?.valid===false||!requireAll)return verdict;
    const seen=new Set((verdict?.value?.evidence||[]).map(String));
    const missing=(allowedEvidenceIds||[]).map(String).filter(id=>!seen.has(id));
    if(!missing.length)return verdict;
    return {...verdict,valid:false,reason:`Promotion payload omitted required source evidence: ${missing.join(', ')}`};
}
function promotionSourcePrompt(content,evidenceId,layer,characterFocus=''){
    return `Nexus RECURSIVE MEMORY PROMOTION — SOURCE SLICE\n\nSOURCE EVIDENCE ${evidenceId}\n${content}\n\nTASK\nCompress only this source slice into a durable higher-level contribution for Layer ${layer+1}. Preserve chronology, relationship changes, decisions, unresolved threads, and distinctive character texture. Do not invent canon.${characterFocus}\nCite the exact evidence ID ${evidenceId}.\nReturn ONLY JSON:\n{"summary":"grounded promotion contribution","evidence":["${evidenceId}"],"characters":[],"locations":[],"dates":[],"topics":[],"threads":[]}`;
}
function promotionPriorPrompt(content,evidenceId,layer){
    return `Nexus RECURSIVE MEMORY PROMOTION — PRIOR CONTEXT DIGEST\n\nPRIOR CONTEXT EVIDENCE ${evidenceId}\n${content}\n\nTASK\nCompress this already-established destination-layer context only so a later promotion can avoid redundant facts. Do not add new canon. Cite ${evidenceId}.\nReturn ONLY JSON:\n{"summary":"prior context digest","evidence":["${evidenceId}"],"characters":[],"locations":[],"dates":[],"topics":[],"threads":[]}`;
}
function promotionReductionPrompt(items,layer,phase='source'){
    const allowed=[...new Set((items||[]).flatMap(item=>item.evidence||[]).map(String))];
    return `Nexus RECURSIVE MEMORY PROMOTION — ${phase.toUpperCase()} CONSOLIDATION\n\nVALIDATED CONTRIBUTIONS\n${JSON.stringify(items)}\n\nTASK\nConsolidate these validated contributions into one shorter grounded representation for Layer ${layer+1}. Preserve every distinct durable event/fact and every evidence ID. Do not invent canon. Required evidence IDs: ${allowed.join(', ')}.\nReturn ONLY JSON:\n{"summary":"consolidated grounded contribution","evidence":${JSON.stringify(allowed)},"characters":[],"locations":[],"dates":[],"topics":[],"threads":[]}`;
}
function promotionFinalPrompt(prior,items,layer,characterFocus=''){
    const allowed=[...new Set((items||[]).flatMap(item=>item.evidence||[]).map(String))];
    return `Nexus RECURSIVE MEMORY PROMOTION\n\nDESTINATION-LAYER PRIOR MEMORY\n${prior||'(none yet)'}\n\nVALIDATED SOURCE CONTRIBUTIONS\n${JSON.stringify(items)}\n\nTASK\nRewrite the validated source contributions as one higher-level narrative memory for Layer ${layer+1}. This is a true abstraction step, not concatenation. Preserve durable chronology, relationship changes, decisions, unresolved threads, and distinctive character texture that would matter later. Remove redundancy already present in DESTINATION-LAYER PRIOR MEMORY. Do not invent events.${characterFocus}\nEvery validated source slice must remain represented. Required evidence IDs: ${allowed.join(', ')}.\nReturn ONLY JSON:\n{"summary":"higher-level narrative memory","evidence":${JSON.stringify(allowed)},"characters":[],"locations":[],"dates":[],"topics":[],"threads":[]}`;
}
async function requestPromotionPayload({prompt,allowedEvidenceIds,layer,enqueueSidecar,label,settings,priority=BUS_PRIORITY.SUMMARY_PROMOTION,telemetry={}}){
    const validator=value=>promotionValidator(value,allowedEvidenceIds,true);
    const options=structuredSidecarOptions({prompt,systemPrompt:`You are Nexus recursive memory promotion for Layer ${layer+1}. Return exact grounded JSON only.`,reasoningEffort:settings.reasoningEffort||'high',timeoutMs:Number(settings.timeoutMs)||240000,priority,maxAttempts:1,label,structuredValidator:validator,synthesisCandidateParser:text=>parseStructuredJsonCandidate(text,{validator,label}),telemetry});
    const job=enqueueSummarySidecar(enqueueSidecar,BUS_STAGE.SUMMARY_PROMOTION,options),response=await job.promise;
    const source=response?.structuredPayload??response?.text;
    let value;
    if(source&&typeof source==='object'&&!Array.isArray(source)){
        const verdict=validator(source);if(verdict?.valid===false)throw new Error(verdict.reason||`${label} failed semantic validation.`);value=verdict?.value??source;
    }else value=parseStructuredJsonCandidate(String(source||''),{validator,label});
    return {value,response,job};
}
async function collapsePromotionPayloads({payloads,layer,enqueueSidecar,settings,packing,phase,transactionId}){
    let current=(payloads||[]).map(item=>({...item}));
    for(let round=0;current.length>1&&round<12;round++){
        const beforeTokens=estimateContentTokens(JSON.stringify(current));
        const groups=packValidatedItems({items:current,buildPrompt:items=>promotionReductionPrompt(items,layer,phase),targetTokens:packing.promptTargetTokens,label:`Promotion ${phase} contributions`});
        if(!groups.length)break;
        const next=[];
        for(const group of groups){
            const allowed=[...new Set(group.items.flatMap(item=>item.evidence||[]).map(String))],prompt=promotionReductionPrompt(group.items,layer,phase);
            assertPhysicalPromptBounded(prompt,packing.promptTargetTokens,`Promotion ${phase} consolidation`);
            const outcome=await requestPromotionPayload({prompt,allowedEvidenceIds:allowed,layer,enqueueSidecar,label:`Promotion ${phase} consolidation ${round+1}.${group.index+1}`,settings,telemetry:{promotionReshape:true,phase:`${phase}-consolidation`,round,group:group.index}});
            next.push(outcome.value);
        }
        const afterTokens=estimateContentTokens(JSON.stringify(next));
        updateNexusTransactionExecution(transactionId,{aggregation:{phase:`promotion-${phase}`,round:round+1,groupCount:groups.length,beforeTokens,afterTokens}},'promotion-aggregation');
        if(next.length>=current.length&&afterTokens>=beforeTokens){const error=new Error(`Promotion ${phase} consolidation made no packing progress.`);error.name='NexusPhysicalPackingError';throw error;}
        current=next;
    }
    if(current.length>1){const error=new Error(`Promotion ${phase} consolidation could not reach one bounded contribution.`);error.name='NexusPhysicalPackingError';throw error;}
    return current;
}

function promotionAssumptions(layer, childIds, prior) {
    const settings = getSettings().memoryBank || {};
    const sourceRecords = getActiveLayerRecords(layer);
    const targetRecords = getActiveLayerRecords(layer + 1);
    const byId = new Map(sourceRecords.map(record => [String(record.id), record]));
    return buildMemoryPromotionAssumptions({
        chatId: getContext()?.chatId || null,
        sourceLayer: layer,
        targetLayer: layer + 1,
        childRecords: childIds.map(id => byId.get(String(id)) || getMemoryRecord(id) || { id: String(id), missing: true }),
        activeSourceLayerIds: sourceRecords.map(record => String(record.id)),
        activeTargetLayerIds: targetRecords.map(record => String(record.id)),
        snippetsPerLayer: Math.max(2, Number(settings.snippetsPerLayer) || 20),
        snippetsPerPromotion: Math.max(2, Number(settings.snippetsPerPromotion) || 3),
        maxLayers: Math.max(1, Number(settings.maxLayers) || 5),
        priorDestinationFingerprint: hashText(priorContextForLayer(layer + 1)),
        relevantState: { memorySchema: 'summary-bank/v3', promotionPolicy: 'oldest-unlocked/v1' },
    });
}

async function promoteOneLayer(layer,{cycleId=null,manual=false,force=false,enqueueSidecar=null,directorMeta=null}={}){
    const settings=getSettings().memoryBank||{};const maxLayers=Math.max(1,Number(settings.maxLayers)||5);if(layer>=maxLayers-1)return {skipped:true,reason:'max-layer'};
    const active=getActiveLayerRecords(layer).filter(record=>record.locked!==true);const threshold=Math.max(2,Number(settings.snippetsPerLayer)||20);
    if(active.length<=threshold&&!force)return {skipped:true,reason:'not-due',layer,count:active.length,threshold};
    const take=Math.min(active.length,Math.max(2,Number(settings.snippetsPerPromotion)||3));if(take<2)return {skipped:true,reason:'not-enough-memories'};
    const children=active.slice(0,take);const childIds=children.map(r=>String(r.id));const prior=priorContextForLayer(layer+1);
    const assumptions=promotionAssumptions(layer,childIds,prior);
    const passage=children.map(r=>`[${r.id} | L${r.layer} | ${r.turnRange?`turns ${r.turnRange[0]}-${r.turnRange[1]}`:''}]\n${r.text}`).join('\n\n');
    const characterFocus=buildCharacterSummaryDirective();
    const systemPrompt=`You are Nexus recursive memory promotion for Layer ${layer+1}. Compress source memories into a coherent higher-level delta. Return exact JSON only.`;
    const directPrompt=`Nexus RECURSIVE MEMORY PROMOTION\n\nDESTINATION-LAYER PRIOR MEMORY\n${prior}\n\nSOURCE MEMORIES\n${passage}\n\nTASK\nRewrite the source memories as one higher-level narrative memory for Layer ${layer+1}. This is a true abstraction step, not concatenation. Preserve durable chronology, relationship changes, decisions, unresolved threads, and distinctive character texture that would matter later. Remove redundancy already present in DESTINATION-LAYER PRIOR MEMORY. Do not invent events.${characterFocus}\nReturn ONLY JSON:\n{"summary":"higher-level narrative memory","characters":[],"locations":[],"dates":[],"topics":[],"threads":[]}`;
    const packing=resolvePhysicalPackingBudget({role:'summaries',stage:BUS_STAGE.SUMMARY_PROMOTION,domain:NEXUS_BATCH_DOMAIN.MEMORY_BANK,phase:'promotion-reshape',requestedMaxTokens:2048,systemPrompt,settings:getSettings(),sliceInstructions:'grounded source promotion and final synthesis'});
    const tx=beginMemoryPromotionTransaction({assumptions,metadata:{cycleId,manual,...(directorMeta||{})},execution:{logicalJobId:`promotion:${getContext()?.chatId||''}:L${layer}:${childIds.join(',')}`,settings:{softPackingTarget:LOGICAL_SOFT_PACKING_TARGET,physicalPromptTarget:packing.promptTargetTokens},sliceManifest:[]}});
    let transactionId=tx.id,responseSlot=null,resolvedJobId=null,reshapeUsed=false;
    try{
        let payload;
        if(estimateContentTokens(directPrompt)<=packing.promptTargetTokens){
            assertPhysicalPromptBounded(directPrompt,packing.promptTargetTokens,'Memory promotion direct request');
            const options=structuredSidecarOptions({prompt:directPrompt,systemPrompt,reasoningEffort:settings.reasoningEffort||'high',timeoutMs:Number(settings.timeoutMs)||240000,priority:BUS_PRIORITY.SUMMARY_PROMOTION,maxAttempts:1,dedupKey:`summary-promote:${getContext()?.chatId||''}:L${layer}:${childIds.join(',')}`,label:`Promote L${layer} → L${layer+1}`,telemetry:{memoryLayer:layer+1,cycleId,manual,childIds,promotionReshape:false,...(directorMeta||{})}});
            const job=enqueueSummarySidecar(enqueueSidecar,BUS_STAGE.SUMMARY_PROMOTION,options),response=await job.promise;
            payload=normalizeSummaryPayload(parseJson(response.text));responseSlot=response?.tv2?.slot||null;resolvedJobId=job.id||job.jobId||null;
        }else{
            reshapeUsed=true;
            const sourceSlices=sliceSemanticText({text:passage,buildPrompt:fragment=>promotionSourcePrompt(fragment,'P9999',layer,characterFocus),targetTokens:packing.promptTargetTokens,label:'Memory promotion source'});
            if(!sourceSlices.length)throw new Error('Memory promotion produced no source slices.');
            updateNexusTransactionExecution(transactionId,{sliceManifest:sourceSlices.map(slice=>({id:`P${slice.index}`,order:slice.index,kind:'promotion-source',estimatedInputTokens:slice.estimatedInputTokens}))},'promotion-slice-manifest');
            const contributions=[];
            for(const slice of sourceSlices){
                const evidenceId=`P${slice.index}`,prompt=promotionSourcePrompt(slice.content,evidenceId,layer,characterFocus);
                assertPhysicalPromptBounded(prompt,packing.promptTargetTokens,'Memory promotion source slice');
                const outcome=await requestPromotionPayload({prompt,allowedEvidenceIds:[evidenceId],layer,enqueueSidecar,label:`Promotion source ${slice.index+1}/${sourceSlices.length}`,settings,telemetry:{memoryLayer:layer+1,cycleId,manual,childIds,promotionReshape:true,promotionSlice:slice.index,promotionSliceCount:sourceSlices.length,...(directorMeta||{})}});
                contributions.push(outcome.value);recordNexusTransactionSlice(transactionId,{sliceId:evidenceId,details:{jobId:outcome.job?.id||outcome.job?.jobId||null}});responseSlot=responseSlot||outcome.response?.tv2?.slot||null;resolvedJobId=resolvedJobId||outcome.job?.id||outcome.job?.jobId||null;
            }
            let sourcePayloads=await collapsePromotionPayloads({payloads:contributions,layer,enqueueSidecar,settings,packing,phase:'source',transactionId});
            let boundedPrior=prior;
            if(prior&&prior!=='(none yet)'&&estimateContentTokens(prior)>Math.floor(packing.promptTargetTokens*0.35)){
                const priorSlices=sliceSemanticText({text:prior,buildPrompt:fragment=>promotionPriorPrompt(fragment,'R9999',layer),targetTokens:packing.promptTargetTokens,label:'Memory promotion prior context'}),priorPayloads=[];
                for(const slice of priorSlices){const evidenceId=`R${slice.index}`,prompt=promotionPriorPrompt(slice.content,evidenceId,layer);assertPhysicalPromptBounded(prompt,packing.promptTargetTokens,'Memory promotion prior slice');const outcome=await requestPromotionPayload({prompt,allowedEvidenceIds:[evidenceId],layer,enqueueSidecar,label:`Promotion prior ${slice.index+1}/${priorSlices.length}`,settings,telemetry:{promotionReshape:true,phase:'prior-digest',slice:slice.index}});priorPayloads.push(outcome.value);}
                const collapsed=await collapsePromotionPayloads({payloads:priorPayloads,layer,enqueueSidecar,settings,packing,phase:'prior',transactionId});boundedPrior=collapsed.map(item=>item.summary).join('\n');
            }
            let finalPrompt=promotionFinalPrompt(boundedPrior,sourcePayloads,layer,characterFocus);
            if(estimateContentTokens(finalPrompt)>packing.promptTargetTokens&&boundedPrior===prior&&prior&&prior!=='(none yet)'){
                const priorSlices=sliceSemanticText({text:prior,buildPrompt:fragment=>promotionPriorPrompt(fragment,'R9999',layer),targetTokens:packing.promptTargetTokens,label:'Memory promotion prior context'}),priorPayloads=[];
                for(const slice of priorSlices){const evidenceId=`R${slice.index}`,prompt=promotionPriorPrompt(slice.content,evidenceId,layer);const outcome=await requestPromotionPayload({prompt,allowedEvidenceIds:[evidenceId],layer,enqueueSidecar,label:`Promotion prior ${slice.index+1}/${priorSlices.length}`,settings,telemetry:{promotionReshape:true,phase:'prior-digest',slice:slice.index}});priorPayloads.push(outcome.value);}
                const collapsed=await collapsePromotionPayloads({payloads:priorPayloads,layer,enqueueSidecar,settings,packing,phase:'prior',transactionId});boundedPrior=collapsed.map(item=>item.summary).join('\n');finalPrompt=promotionFinalPrompt(boundedPrior,sourcePayloads,layer,characterFocus);
            }
            if(estimateContentTokens(finalPrompt)>packing.promptTargetTokens){const error=new Error('Memory promotion final synthesis could not fit inside the resolved physical packing target.');error.name='NexusPhysicalPackingError';throw error;}
            const allowed=[...new Set(sourcePayloads.flatMap(item=>item.evidence||[]).map(String))];markNexusTransactionAggregating(transactionId,{phase:'promotion-final',sourceSliceCount:sourceSlices.length});
            const finalOutcome=await requestPromotionPayload({prompt:finalPrompt,allowedEvidenceIds:allowed,layer,enqueueSidecar,label:`Promote L${layer} → L${layer+1} final`,settings,telemetry:{memoryLayer:layer+1,cycleId,manual,childIds,promotionReshape:true,phase:'final',...directorMeta}});
            payload=normalizeSummaryPayload(finalOutcome.value);responseSlot=finalOutcome.response?.tv2?.slot||responseSlot;resolvedJobId=finalOutcome.job?.id||finalOutcome.job?.jobId||resolvedJobId;
        }
        const stagedTx=finalizeMemoryPromotionTransaction(transactionId,{draft:payload,metadata:{cycleId,manual,jobId:resolvedJobId,reshapeUsed,...(directorMeta||{})}});
        if(stagedTx.state!=='staged')throw new Error(stagedTx.error||stagedTx.validation?.reason||'Memory promotion transaction failed validation.');
        const currentAssumptions=promotionAssumptions(layer,childIds,priorContextForLayer(layer+1));
        const durabilityContext=getContext(),beforeStore=JSON.parse(JSON.stringify(getMemoryStore()));
        const preview=previewMemoryPromotion(childIds,{...payload,sidecarSlot:responseSlot,cycleId,source:manual?'manual-promotion':'promotion'},beforeStore);
        const commit=await commitCanonicalNexusMutation(transactionId,{type:'metadata.set',chatId:String(durabilityContext?.chatId||''),key:'tv2_memory_bank',value:preview.store,expected:beforeStore},{context:durabilityContext,currentAssumptions:()=>promotionAssumptions(layer,childIds,priorContextForLayer(layer+1)),committed:()=>({memoryId:preview.parent.id,childIds,sourceLayer:layer,targetLayer:layer+1,reshapeUsed})});
        if(commit.state!=='committed')return {failed:true,stale:commit.state==='stale',error:commit.error||commit.freshness?.reason||'Memory promotion assumptions changed before commit.',layer,transactionId,childrenPreserved:true};
        const parent=getMemoryRecord(preview.parent.id);
        logEvent('summary','promoted',{cycleId,manual,jobId:resolvedJobId,transactionId,slot:responseSlot,sourceLayer:layer,targetLayer:layer+1,childIds,memoryId:parent.id,reshapeUsed},'info');
        return {promoted:true,parent,children,jobId:resolvedJobId,transactionId,slot:responseSlot,reshapeUsed};
    }catch(error){if(transactionId){try{await failNexusTransaction(transactionId,error,{stage:'summary-promotion',recoveryRequired:error?.tv2RollbackRestored!==true});}catch{}}logEvent('summary','promotion-failed',{cycleId,manual,jobId:resolvedJobId,transactionId,layer,childIds,error,childrenPreserved:true,reshapeUsed},'error');return {failed:true,error:error?.message||String(error),layer,transactionId};}
}

export async function promoteDueSummaries({cycleId=null,manual=false,fromLayer=null,maxPromotions=20,enqueueSidecar=null,directorMeta=null}={}){
    const settings=getSettings();if(!settings.enabled||settings.memoryBank?.enabled===false)return {skipped:true,reason:'disabled'};
    if(!hasActiveMemoryStory())return {skipped:true,reason:'no-active-story'};
    const results=[];let promotions=0;
    const maxLayers=Math.max(1,Number(settings.memoryBank?.maxLayers)||5);
    if(fromLayer!==null&&fromLayer!==undefined){const r=await promoteOneLayer(Math.max(0,Number(fromLayer)||0),{cycleId,manual:true,force:true,enqueueSidecar,directorMeta});results.push(r);return {results,promotions:r.promoted?1:0,failed:r.failed===true};}
    let changed=true;
    while(changed&&promotions<maxPromotions){changed=false;for(let layer=0;layer<maxLayers-1&&promotions<maxPromotions;layer++){const r=await promoteOneLayer(layer,{cycleId,manual,force:false,enqueueSidecar,directorMeta});if(r.promoted){results.push(r);promotions++;changed=true;}else if(r.failed){results.push(r);return {results,promotions,failed:true};}}}
    logEvent('summary','promotion-check-complete',{cycleId,promotions,maxPromotions,directorMeta:directorMeta||null},'info');
    return {results,promotions};
}

