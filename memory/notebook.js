import { getContext } from '../../../../st-context.js';
import { getSettings } from '../core/settings.js';
import { BUS_STAGE, BUS_PRIORITY } from '../sidecar/bus.js';
import { NEXUS_BATCH_DOMAIN, structuredSidecarOptions } from '../nexus/batch-layer.js';
import { enqueueLaneAModelWorkerJob, runLaneAModelWorkerBatch } from './model-worker.js';
import { parseStructuredJsonCandidate } from '../sidecar/normalize-response.js';
import { composeNotebookSplitPayload, validateNotebookDeltaPayload, validateNotebookPayload } from '../sidecar/semantic-validation.js';
import { evaluateNotebookMaterialChangeAssist, notebookMaterialChangeFingerprint } from './decision-sites.js';
import { estimateContentTokens } from '../observability/token-estimator.js';
import { logEvent } from '../observability/telemetry.js';
import { mutateChatMetadataDurably } from '../nexus/host-durability.js';
import { commitCanonicalNexusMutation } from '../nexus/mutation-coordinator.js';
import {
    abortNexusTransaction,
    beginNotebookRefreshTransaction,
    buildNotebookAssumptions,
    enforceNexusTransactionFreshBeforeStage,
    failNexusTransactionDurable as failNexusTransaction,
    initializeNexusTransactionExecution,
    markNexusTransactionAggregating,
    recordNexusTransactionSlice,
    recordNotebookRefreshParsed,
    stageNotebookRefreshTransaction,
    updateNexusTransactionExecution,
} from '../nexus/transaction-service.js';
import { publishNotebookOutlet, clearNotebookOutlet } from '../nexus/generation-frame-ports.js';
import { NEXUS_GENERATION_OUTLET_STATUS } from '../nexus/generation-frame-contract.js';
import { currentNexusHotSnapshot, renderCurrentNexusHotNotebook } from '../nexus/hot-cognition.js';
import {
    LOGICAL_SOFT_PACKING_TARGET,
    assertPhysicalPromptBounded,
    packValidatedItems,
    resolvePhysicalPackingBudget,
    sliceChronologicalRows,
} from '../nexus/large-input-reshape.js';

import { getMemoryRecord, markMemoryRouted } from './store.js';
import { getNexusWorldTreeOwner } from '../world-tree/index.js';
import { trackedCharacterLabels } from '../world-tree/tracking.js';
import { NOTEBOOK_KEY as KEY, NOTEBOOK_REFRESH_OUTCOME, NOTEBOOK_REFRESH_STATUS_KEY, NOTEBOOK_REVISION_LIMIT, describeRefreshResult, listNotebookRevisions, normalizeNotebook, normalizeRefreshStatus, rollbackNotebookDocument, saveIntoNotebook } from './notebook-document.js';
import { NOTEBOOK_RETIRED_KEYS, migrateNotebookMetadata } from './notebook-migration.js';
import { resolveNotebookBudget } from './notebook-budget.js';
import { NOTEBOOK_REJECTION, NOTEBOOK_REJECTION_TEXT, NotebookRejectedError, validateNotebookEvidence } from './notebook-evidence.js';
import { decideNotebookRefresh, describeGateReason, evidenceThrough } from './notebook-gate.js';
import { buildNotebookColdStartBrief, composeNotebookOutlet } from './notebook-outlet.js';
export { buildNotebookColdStartBrief };
export { describeRefreshResult, listNotebookRevisions };

// The sidecar response and the durability error carry shared contract fields the Notebook reads but does not own.
const responseSlot=response=>response?.tv2?.slot||null;
const responseJobId=response=>response?.tv2?.jobId||null;
const rollbackWasRestored=error=>error?.tv2RollbackRestored===true;
const NOTEBOOK_EVENT='nexus-notebook-updated';
const DIGESTED_REASON='digested-to-notebook';
function notebookPolicy(){
    const cfg=getSettings()?.notebook||{};
    const budget=resolveNotebookBudget({configured:cfg,contextTokens:getContext()?.maxContext});
    const revisionLimit=Math.max(1,Math.min(12,Math.floor(Number(cfg.revisionLimit)||NOTEBOOK_REVISION_LIMIT)));
    return {targetTokens:budget.targetTokens,maxTokens:budget.maxTokens,revisionLimit,contextTokens:budget.contextTokens,budget};
}
function notebookSizeContract(){const policy=notebookPolicy();return `SIZE CONTRACT\n- Target the complete rolling Notebook at or below ${policy.targetTokens} estimated content tokens.\n- HARD persisted ceiling: ${policy.maxTokens} estimated content tokens.\n- When near/over target, compact resolved, historical, duplicated, or low-value working state before adding new material. Preserve explicit user direction, active constraints, unresolved commitments/questions, current scene state, and immediate hooks.\n- Never solve size pressure by inventing facts or deleting still-active obligations.`;}
function validateBoundedNotebookPayload(value,allowedEvidenceIds=[]){
    const verdict=validateNotebookPayload(value,allowedEvidenceIds);if(!verdict.valid)return verdict;
    if(value?.changed===true){const tokens=estimateContentTokens(String(value.notebook||'')),policy=notebookPolicy();if(tokens>policy.maxTokens)return {valid:false,reason:`Notebook exceeds hard persisted ceiling (${tokens} > ${policy.maxTokens} estimated tokens).`,notebookSizeExceeded:true,tokens,maxTokens:policy.maxTokens};}
    return verdict;
}
function assertNotebookWithinHardLimit(text,label='Notebook'){const tokens=estimateContentTokens(String(text||'')),policy=notebookPolicy();if(tokens>policy.maxTokens){const error=new Error(`${label} exceeds the configured hard persisted ceiling (${tokens} > ${policy.maxTokens} estimated tokens).`);error.name='NexusNotebookSizeExceeded';error.tokens=tokens;error.maxTokens=policy.maxTokens;throw error;}return {tokens,...policy};}
function clone(value){return value==null?value:JSON.parse(JSON.stringify(value));}
function clean(value){return String(value??'').trim();}
function notify(){try{window.dispatchEvent(new CustomEvent(NOTEBOOK_EVENT));}catch{}}
function persistOptimistic(ctx){ctx?.saveMetadataDebounced?.();}
function documentState(){
    const ctx=getContext();if(!ctx?.chatMetadata)throw new Error('No active chat metadata is available.');
    const migration=migrateNotebookMetadata(ctx.chatMetadata);
    const doc=normalizeNotebook(ctx.chatMetadata[KEY],{revisionLimit:notebookPolicy().revisionLimit});
    ctx.chatMetadata[KEY]=doc;
    if(migration.migrated||migration.dropped.length)persistOptimistic(ctx);
    return {ctx,doc};
}
export function getNotebook(){try{return clone(documentState().doc);}catch{return normalizeNotebook(null);}}
function saveNotebookLocal(text,{updatedBy='operator'}={}){
    const {ctx,doc}=documentState(),policy=notebookPolicy();
    const result=saveIntoNotebook(doc,text,{updatedBy,revisionLimit:policy.revisionLimit,assertFits:next=>assertNotebookWithinHardLimit(next,updatedBy==='operator'?'Notebook manual save':'Notebook save')});
    if(!result.changed)return clone(doc);
    ctx.chatMetadata[KEY]=result.doc;persistOptimistic(ctx);
    return clone(result.doc);
}
function previewNotebookSave(current,text,{updatedBy='operator'}={}){
    return saveIntoNotebook(current||normalizeNotebook(null),text,{updatedBy,revisionLimit:notebookPolicy().revisionLimit,assertFits:next=>assertNotebookWithinHardLimit(next,'Notebook staged save')}).doc;
}
function rollbackNotebookLocal(){
    const {ctx,doc}=documentState(),next=rollbackNotebookDocument(doc,{revisionLimit:notebookPolicy().revisionLimit});
    ctx.chatMetadata[KEY]=next;persistOptimistic(ctx);
    return clone(next);
}
const METADATA_KEYS=[KEY,...NOTEBOOK_RETIRED_KEYS];
export async function saveNotebook(text,{updatedBy='operator'}={}){
    const context=getContext();
    const saved=await mutateChatMetadataDurably(context,'Notebook manual save',{keys:METADATA_KEYS},()=>saveNotebookLocal(text,{updatedBy}));
    notify();logEvent('notebook','updated',{chatId:context?.chatId??null,characters:characterNames(),chars:saved.text.length,updatedBy:saved.updatedBy,revisions:saved.revisions.length,durable:true},'info');return saved;
}
// The Notebook is working state, not canon. The one thing a digest does to the World Tree is mark
// the Summary as digested; the Summary stays on record and is never deleted.
export async function digestMemoryToNotebook(memoryId,{enqueueSidecar=null}={}){
    const memory=getMemoryRecord(memoryId);if(!memory)throw new Error(`Memory ${memoryId} was not found.`);
    if(memory.permanent===true||memory.locked===true)throw new Error('Permanent memory must be made temporary before it can be digested.');
    const settings=getSettings(),cfg=settings.notebook||{},doc=getNotebook(),evidenceId='S1';
    const prompt=`Nexus SUMMARY → NOTEBOOK DIGEST

CURRENT NOTEBOOK
${doc.text||'(empty)'}

SOURCE SUMMARY [${evidenceId}]
${memory.text}

TASK
Decide whether this temporary narrative Summary contains active working-state that belongs in the rolling Notebook: current scene situation, explicit user direction, unresolved questions, commitments, goals/needs, or near-term hooks. Do not duplicate canonical lore or static character facts. If it adds nothing operationally useful, return changed=false and Nexus will keep the Summary. If it does, return the COMPLETE revised Notebook and cite ${evidenceId}.\n\n${notebookSizeContract()}

Return ONLY JSON:
{"changed":false,"reason":"short","evidence":[]}
OR
{"changed":true,"notebook":"complete revised Notebook","reason":"short","evidence":["${evidenceId}"]}`;
    const validator=value=>validateBoundedNotebookPayload(value,[evidenceId]);
    const options=structuredSidecarOptions({prompt,systemPrompt:'You are Nexus Notebook digestion. Move only active working-state from the supplied Summary into the rolling Notebook. Return exact JSON only.',reasoningEffort:cfg.reasoningEffort||'medium',timeoutMs:Number(cfg.timeoutMs)||120000,priority:BUS_PRIORITY.NOTEBOOK,dedupKey:`notebook-digest:${memory.id}:${memory.updatedAt||0}`,label:'Digest Summary to Notebook',structuredValidator:validator,structuredCandidateComposer:composeNotebookSplitPayload,synthesisCandidateParser:text=>parseStructuredJsonCandidate(String(text||''),{validator,candidateComposer:composeNotebookSplitPayload,label:'Notebook Summary digest'}),telemetry:{notebook:true,summaryDigest:true,memoryId:memory.id}});
    const handle=typeof enqueueSidecar==='function'?enqueueSidecar(BUS_STAGE.MAINTENANCE,options):enqueueLaneAModelWorkerJob(NEXUS_BATCH_DOMAIN.NOTEBOOK,BUS_STAGE.MAINTENANCE,options);
    if(!handle?.promise)throw new Error('Notebook digest dispatcher did not return a valid job handle.');
    const response=await handle.promise,payload=parseResponse(response.structuredPayload??response.text,[evidenceId]);
    if(!payload.changed){logEvent('notebook','summary-digest-noop',{memoryId:memory.id,reason:payload.reason},'info');return {digested:false,kept:true,reason:payload.reason};}
    const saved=await saveNotebook(payload.notebook,{updatedBy:'summary-digest'});
    markMemoryRouted(memory.id,{state:'superseded',reasoning:DIGESTED_REASON});
    logEvent('notebook','summary-digested',{chatId:getContext()?.chatId??null,memoryId:memory.id,chars:saved.text.length,reason:payload.reason,summaryDeleted:false,marked:true},'info');
    return {digested:true,deleted:false,kept:true,marked:true,memoryId:memory.id,notebook:saved,reason:payload.reason};
}

export async function rollbackNotebook(){
    const context=getContext();
    const saved=await mutateChatMetadataDurably(context,'Notebook manual rollback',{keys:METADATA_KEYS},()=>rollbackNotebookLocal());
    notify();logEvent('notebook','rolled-back',{chatId:context?.chatId??null,chars:saved.text.length,revisions:saved.revisions.length,durable:true},'warn');return saved;
}

function characterNames(){
    try{const context=getContext();return trackedCharacterLabels({tree:getNexusWorldTreeOwner(),chatId:context?.chatId??null,limit:16});}catch{return [];}
}
function readRefreshStatus(){try{return normalizeRefreshStatus(getContext()?.chatMetadata?.[NOTEBOOK_REFRESH_STATUS_KEY]);}catch{return normalizeRefreshStatus(null);}}
export function getNotebookRefreshStatus(){return readRefreshStatus();}
// The last refresh result is working state: written optimistically, never through a canonical transaction.
function recordRefreshStatus({outcome,reason='',manual=false,evidenceThrough:through,fingerprint}={}){
    try{
        const ctx=getContext();if(!ctx?.chatMetadata)return null;
        const prior=readRefreshStatus();
        const next={outcome,reason:String(reason||''),manual:manual===true,at:Date.now(),evidenceThrough:through===undefined?prior.evidenceThrough:through,fingerprint:fingerprint===undefined?prior.fingerprint:String(fingerprint||'')};
        ctx.chatMetadata[NOTEBOOK_REFRESH_STATUS_KEY]=next;persistOptimistic(ctx);notify();
        return next;
    }catch{return null;}
}
function coldOpening(){return !(getContext()?.chat||[]).some(message=>!message?.is_system&&!message?.is_user&&String(message?.mes||'').trim());}
function recentSceneSnapshot(limit=8){
    const rows=(getContext()?.chat||[]).map((message,index)=>({message,index})).filter(({message})=>message&&!message.is_system&&clean(message.mes)).slice(-Math.max(1,Number(limit)||8));
    const messages=rows.map(({message,index})=>({index,role:message.is_user?'user':'assistant',text:clean(message.mes)}));
    const text=rows.map(({message,index})=>`[M${index} | ${message.is_user?'User':'Assistant'}]\n${clean(message.mes)}`).join('\n\n');
    return {text,messages};
}
function recentScene(limit=8){return recentSceneSnapshot(limit).text;}
function parseResponse(input,allowedEvidenceIds=[]){const validator=value=>validateBoundedNotebookPayload(value,allowedEvidenceIds);const data=(input&&typeof input==='object'&&!Array.isArray(input))?input:parseStructuredJsonCandidate(String(input||''),{validator,candidateComposer:composeNotebookSplitPayload,label:'Notebook Sidecar'});const verdict=validator(data);if(!verdict.valid)throw new Error(verdict.reason||'Notebook Sidecar failed semantic validation.');const changed=data.changed===true,evidence=[...new Set(data.evidence.map(clean).filter(Boolean))],reason=clean(data.reason);if(!changed)return {changed:false,reason,evidence};return {changed:true,notebook:String(data.notebook||'').trim(),reason,evidence};}
function isNotebookAmbiguousStructuredError(error){return error?.name==='NexusSemanticValidationError'&&error?.validation?.ambiguous===true;}
function notebookAmbiguityRepairSystemPrompt(){return 'Notebook JSON recovery: the previous response contained multiple independently valid top-level JSON answers. Re-evaluate the same supplied evidence and return exactly ONE complete Notebook JSON object. Do not return alternatives, commentary, fences, or a second JSON root.';}
function validateEvidence(payload,scene){const verdict=validateNotebookEvidence(payload,scene);if(!verdict.valid)throw new NotebookRejectedError(verdict.code,verdict.reason);}
function promptText(doc,scene,names=characterNames()){return `Nexus ROLLING WORLD-STATE NOTEBOOK\n\nCURRENT NOTEBOOK\n${doc.text||'(empty — establish only what is supported by the recent scene)'}\n\nTRACKED CHARACTERS\n${names.join(', ')||'(none)'}\n\nRECENT SCENE\n${scene||'(no recent scene)'}\n\n${notebookSizeContract()}\n\nTASK\nMaintain ONE compact rolling working-state document for the next turn. First decide whether the recent scene materially changes active scene situation, character goals/needs, explicit user direction, unresolved questions, commitments, or likely next hooks. If not, preserve the document exactly. If it does, revise only the supported state; remove resolved/stale items, and compact the complete revised Notebook toward the target size while preserving still-active state. Preserve deliberate user direction unless superseded. You may reference tracked characters by name, but do not duplicate their canonical facts. Do not invent canon, facts, motives, or outcomes. This is planning/state, not narrative prose, and it never replaces canonical lore. Every material revision must cite the [M#] message(s) that support it.\n\nReturn ONLY JSON:\n{"changed":false,"reason":"short","evidence":["M12"]}\nOR\n{"changed":true,"notebook":"complete revised single Notebook document","reason":"short","evidence":["M12","M13"]}`;}

function notebookSceneRows(snapshot){return (snapshot.messages||[]).map(row=>({...row,evidenceId:`M${row.index}`}));}
function renderNotebookSceneRow(row){return `[${row.evidenceId} | ${row.role==='user'?'User':'Assistant'}]\n${clean(row.text)}`;}
function notebookDeltaPrompt(doc,sceneSlice,ids,names){return `Nexus NOTEBOOK SCENE-DELTA EXTRACTION\n\nUNCHANGED NOTEBOOK BASELINE\n${doc.text||'(empty)'}\n\nTRACKED CHARACTERS\n${names.join(', ')||'(none)'}\n\nNEW SCENE SLICE\n${sceneSlice}\n\nTASK\nDo not rewrite or save the Notebook. Extract only proposed working-state deltas supported by this slice: current scene situation, goals/needs, explicit user direction, unresolved questions, commitments, likely next hooks, and resolved/stale items that should be removed. Cite only exact evidence IDs from this slice: ${ids.join(', ')}. Do not invent canon or duplicate tracked-character facts.\nReturn ONLY JSON:\n{"changed":true,"reason":"short","evidence":["M12"],"deltas":["supported state delta"]}\nOR\n{"changed":false,"reason":"short","evidence":[],"deltas":[]}`;}
function notebookReconcilePrompt(doc,deltas,names){return `Nexus NOTEBOOK FINAL RECONCILIATION\n\nUNCHANGED NOTEBOOK BASELINE\n${doc.text||'(empty — establish only supported state)'}\n\nTRACKED CHARACTERS\n${names.join(', ')||'(none)'}\n\nVALIDATED SCENE DELTAS\n${JSON.stringify(deltas)}\n\n${notebookSizeContract()}\n\nTASK\nReconcile the validated deltas into ONE complete rolling Notebook. The baseline is authoritative until a delta explicitly changes or resolves it. Preserve deliberate user direction unless superseded. Remove only items supported as resolved/stale. Do not invent canon, facts, motives, or outcomes. Return the entire Notebook, not a patch.\nReturn ONLY JSON:\n{"changed":false,"reason":"short","evidence":[]}\nOR\n{"changed":true,"notebook":"complete revised single Notebook document","reason":"short","evidence":["M12","M13"]}`;}
function notebookDeltaReductionPrompt(items,allowed){return `Nexus NOTEBOOK DELTA CONSOLIDATION\n\nVALIDATED DELTA OBJECTS\n${JSON.stringify(items)}\n\nTASK\nConsolidate only redundant/overlapping working-state deltas. Preserve every distinct supported state change and all exact evidence IDs. This remains a read-only intermediate representation; do not write a complete Notebook. Allowed evidence IDs: ${allowed.join(', ')}.\nReturn ONLY JSON:\n{"changed":true,"reason":"short","evidence":["M12"],"deltas":["supported consolidated delta"]}`;}
async function reduceNotebookDeltasToFit({deltas,doc,names,packing,transactionId,enqueueSidecar=null}){
    let current=deltas;
    for(let round=0;round<12;round++){
        const finalPrompt=notebookReconcilePrompt(doc,current,names),beforeTokens=estimateContentTokens(finalPrompt);if(beforeTokens<=packing.promptTargetTokens)return current;
        const groups=packValidatedItems({items:current,buildPrompt:items=>{const allowed=[...new Set(items.flatMap(item=>item.evidence||[]))];return notebookDeltaReductionPrompt(items,allowed);},targetTokens:packing.promptTargetTokens,label:'Notebook validated deltas'});
        const reduced=[];
        for(const group of groups){const allowed=[...new Set(group.items.flatMap(item=>item.evidence||[]))],prompt=notebookDeltaReductionPrompt(group.items,allowed);assertPhysicalPromptBounded(prompt,packing.promptTargetTokens,'Notebook delta consolidation');const batch=await runLaneAModelWorkerBatch({laneAEnqueue:enqueueSidecar,domain:NEXUS_BATCH_DOMAIN.NOTEBOOK,stage:BUS_STAGE.MAINTENANCE,items:[{allowed}],requestedBatch:false,buildRequest:item=>structuredSidecarOptions({prompt,systemPrompt:'Consolidate validated Nexus Notebook deltas. Return exact JSON only.',maxTokens:Math.min(1536,packing.resourcePolicy.outputCeilingTokens||1536),priority:BUS_PRIORITY.NOTEBOOK,structuredValidator:value=>validateNotebookDeltaPayload(value,item.allowed),telemetry:{notebookReshape:true,phase:'delta-consolidation',round,group:group.index}}),parse:(text,item)=>parseStructuredJsonCandidate(text,{validator:value=>validateNotebookDeltaPayload(value,item.allowed),label:'Notebook delta consolidation'}),validate:(value,item)=>validateNotebookDeltaPayload(value,item.allowed),buildRecovery:item=>structuredSidecarOptions({prompt:`${prompt}\n\nRECOVERY: Return one corrected delta JSON object only.`,systemPrompt:'Return corrected Notebook delta JSON only.',maxTokens:Math.min(1536,packing.resourcePolicy.outputCeilingTokens||1536),priority:BUS_PRIORITY.NOTEBOOK,structuredValidator:value=>validateNotebookDeltaPayload(value,item.allowed),telemetry:{notebookReshape:true,phase:'delta-consolidation-recovery',round,group:group.index}})});const outcome=batch.completed[0];if(!outcome)throw new Error(batch.failed[0]?.error?.message||'Notebook delta consolidation failed after bounded recovery.');reduced.push(outcome.value);}
        current=reduced;const afterTokens=estimateContentTokens(notebookReconcilePrompt(doc,current,names)),noProgress=afterTokens>=beforeTokens;updateNexusTransactionExecution(transactionId,{aggregation:{phase:'delta-consolidation',round:round+1,groupCount:groups.length,remainingPayloads:current.length,beforeTokens,afterTokens,noProgress,softTargetUnresolved:afterTokens>packing.promptTargetTokens}},'aggregation-consolidated');
        if(noProgress)return current;
    }
    updateNexusTransactionExecution(transactionId,{aggregation:{phase:'delta-consolidation',softTargetUnresolved:true,reason:'soft-compaction-round-limit'}},'aggregation-soft-target-unresolved');
    return current;
}

export function clearNotebookPrompt({generationId=null}={}){if(generationId!=null)clearNotebookOutlet({generationId,status:NEXUS_GENERATION_OUTLET_STATUS.EMPTY,reason:'notebook-cleared'});return true;}
// What the NOTEBOOK outlet carries for the next turn. The Notebook tab reads this same function.
function buildNotebookOutlet(){
    const cfg=getSettings().notebook||{};
    const doc=getNotebook(),hotSnapshot=currentNexusHotSnapshot(),hotText=renderCurrentNexusHotNotebook({maxChars:5000});
    const policy=notebookPolicy();
    const outlet=composeNotebookOutlet({doc,hotText,coldOpening:doc.text?coldOpening():false,coldStart:cfg.coldStart,budget:policy.budget});
    return {doc,hotSnapshot,hotText,policy,outlet,hotRevision:Number(hotSnapshot?.hotRevision??0)||0};
}
export function readNotebookProjection(){
    const settings=getSettings(),cfg=settings.notebook||{};
    if(!settings.enabled||cfg.enabled===false)return {enabled:false,content:'',notebookText:'',hotText:'',coldStart:false,compaction:null,budget:null};
    const view=buildNotebookOutlet();
    return {enabled:true,empty:view.outlet.empty,content:view.outlet.content,notebookText:view.outlet.notebookText,hotText:view.outlet.hotText,coldStart:view.outlet.coldStart,compaction:view.outlet.compaction,tokens:view.outlet.tokens,hotRevision:view.hotRevision,budget:{targetTokens:view.policy.targetTokens,maxTokens:view.policy.maxTokens,contextTokens:view.policy.contextTokens}};
}
export function prepareNotebookPrompt({generationId=null}={}){
    const settings=getSettings(),cfg=settings.notebook||{};if(!settings.enabled||cfg.enabled===false){clearNotebookPrompt({generationId});return {skipped:true,reason:'disabled'};}
    const {doc,hotSnapshot,hotText,outlet,hotRevision}=buildNotebookOutlet();
    if(outlet.empty){clearNotebookPrompt({generationId});return {skipped:true,reason:'empty'};}
    const text=outlet.content,useColdBrief=outlet.coldStart;
    if(generationId!=null){
        const published=publishNotebookOutlet({
            generationId,status:NEXUS_GENERATION_OUTLET_STATUS.READY,content:text,
            sourceRevision:`${doc.updatedAt}:${doc.revisions?.length||0}:${doc.text.length}:hot-${hotRevision}`,
            data:{coldStart:useColdBrief,updatedAt:doc.updatedAt,hotRevision,hotSnapshot,compaction:outlet.compaction},
        });
        if(published?.accepted===false)return {skipped:true,deferred:true,reason:`generation-frame-${published.reason}`};
    }
    logEvent('notebook',useColdBrief?'cold-start-brief-prepared':'prompt-prepared',{chars:text.length,notebookChars:outlet.notebookText.length,coldStart:useColdBrief,updatedAt:doc.updatedAt,generationId,hotRevision,hotChars:hotText.length,compacted:outlet.compaction?.compacted===true,heldBackBlocks:outlet.compaction?.heldBackBlocks??0},'info');
    if(outlet.compaction?.compacted)logEvent('notebook','prompt-compacted',{generationId,...outlet.compaction},'info');
    if(generationId!=null&&outlet.hotText)logEvent('nexus.hot','notebook-projection',{chatId:getContext()?.chatId??null,generationId,hotRevision,chars:outlet.hotText.length,outlet:'NOTEBOOK'},'debug');
    return {ready:true,chars:text.length,coldStart:useColdBrief,updatedAt:doc.updatedAt,hotRevision,hotChars:hotText.length,compaction:outlet.compaction};
}

export async function refreshNotebookFromScene({manual=false,enqueueSidecar=null,directorMeta=null}={}){
    const settings=getSettings(),cfg=settings.notebook||{};
    if(!settings.enabled||cfg.enabled===false||(!manual&&cfg.automatic===false))return {skipped:true,reason:'disabled'};
    const sceneSnapshot=recentSceneSnapshot(cfg.contextMessages||8),scene=sceneSnapshot.text;if(!scene)return {skipped:true,reason:'no-scene'};
    const doc=getNotebook(),ctx=getContext(),chatId=ctx?.chatId||'',names=characterNames();
    const assumptions=buildNotebookAssumptions({chatId,sourceMessages:sceneSnapshot.messages,priorNotebook:doc,contextMessages:cfg.contextMessages||8,characterNames:names,relevantState:{schema:'rolling-notebook/v2',automatic:cfg.automatic!==false}});
    const materialDecisionContext={priorNotebook:doc.text,evidence:sceneSnapshot.messages.map(row=>({evidenceId:`M${row.index}`,text:row.text})),characterNames:names};
    materialDecisionContext.sourceFingerprint=notebookMaterialChangeFingerprint(materialDecisionContext);
    materialDecisionContext.readCurrentSourceFingerprint=()=>{const liveScene=recentSceneSnapshot(getSettings().notebook?.contextMessages||8),liveDoc=getNotebook(),liveNames=characterNames();return notebookMaterialChangeFingerprint({priorNotebook:liveDoc.text,evidence:liveScene.messages.map(row=>({evidenceId:`M${row.index}`,text:row.text})),characterNames:liveNames});};
    // Automatic refreshes pass the rule gate and then Decision Core (notebook.material-change.v1) before any
    // Notebook worker job. Manual Refresh deliberately bypasses the gate and always performs the requested work.
    const throughNow=evidenceThrough(materialDecisionContext.evidence);
    const gate=await decideNotebookRefresh({manual,evidence:materialDecisionContext.evidence,lastRefresh:readRefreshStatus(),fingerprint:materialDecisionContext.sourceFingerprint,assist:()=>evaluateNotebookMaterialChangeAssist(materialDecisionContext)});
    const assist=gate.verdict;
    if(assist?.handled)logEvent('decision-core',assist.material===false?'notebook-assist-no-change':'notebook-assist-refresh',{probability:assist.probability,degree:assist.degree,provider:assist.result?.provider||null,latencyMs:assist.result?.latencyMs||0},'info');
    if(gate.error)logEvent('decision-core','notebook-assist-error',{error:gate.error},'warn');
    if(!gate.run){
        const assessed=gate.source==='decision-core';
        recordRefreshStatus({outcome:NOTEBOOK_REFRESH_OUTCOME.NO_CHANGE,reason:describeGateReason(gate.reason),manual:false,...(assessed?{evidenceThrough:throughNow,fingerprint:materialDecisionContext.sourceFingerprint}:{})});
        prepareNotebookPrompt();
        return {skipped:true,reason:assessed?'decision-core-no-material-change':'no-material-change',gateReason:gate.reason,gateSource:gate.source,decisionCore:assessed};
    }
    const tx=beginNotebookRefreshTransaction({assumptions,metadata:{manual,...(directorMeta||{})}}),transactionId=tx.id;
    const systemPrompt='You maintain Nexus’s one rolling world-state Notebook. Structured intermediates are read-only; return exact JSON only.';
    const packing=resolvePhysicalPackingBudget({role:'maintenance',stage:BUS_STAGE.MAINTENANCE,domain:NEXUS_BATCH_DOMAIN.NOTEBOOK,phase:'notebook-reshape',requestedMaxTokens:2048,systemPrompt,settings:getSettings(),sliceInstructions:'Notebook delta extraction and final reconciliation'});
    initializeNexusTransactionExecution(transactionId,{logicalJobId:`notebook:${chatId}:${(ctx?.chat||[]).length}`,workload:'notebook',sourceFingerprints:{notebook:`${doc.updatedAt}:${doc.revisions?.length||0}:${doc.text.length}`},identity:{chatId},settings:{contextMessages:cfg.contextMessages||8,softPackingTarget:LOGICAL_SOFT_PACKING_TARGET,physicalPromptTarget:packing.promptTargetTokens},sliceManifest:[]});
    let response=null;
    try{
        const directEvidenceIds=sceneSnapshot.messages.map(row=>`M${row.index}`),directPrompt=promptText(doc,scene,names);let payload=null,jobId=null,reshapeUsed=false;
        if(estimateContentTokens(directPrompt)<=packing.promptTargetTokens){
            assertPhysicalPromptBounded(directPrompt,packing.promptTargetTokens,'Notebook direct request');
            updateNexusTransactionExecution(transactionId,{sliceManifest:[{id:'notebook-direct',order:0,kind:'final-direct'}]},'slice-manifest-planned');
            const enqueue=typeof enqueueSidecar==='function'?enqueueSidecar:(stage,options)=>enqueueLaneAModelWorkerJob(NEXUS_BATCH_DOMAIN.NOTEBOOK,stage,options);
            const directOptions=structuredSidecarOptions({prompt:directPrompt,systemPrompt,reasoningEffort:cfg.reasoningEffort||'medium',timeoutMs:Number(cfg.timeoutMs)||120000,priority:BUS_PRIORITY.NOTEBOOK,dedupKey:`notebook:${chatId}:${(ctx?.chat||[]).length}`,label:manual?'Refresh rolling Notebook':'Update rolling Notebook',telemetry:{notebook:true,manual,deltaMode:false,recoverableSemanticAttempt:true,...(directorMeta||{})},structuredValidator:value=>validateBoundedNotebookPayload(value,directEvidenceIds),structuredCandidateComposer:composeNotebookSplitPayload,synthesisCandidateParser:text=>parseResponse(text,directEvidenceIds)});
            let job=enqueue(BUS_STAGE.MAINTENANCE,directOptions),ambiguityRepaired=false;
            try{
                response=await job.promise;
            }catch(error){
                if(!isNotebookAmbiguousStructuredError(error))throw error;
                logEvent('notebook','ambiguity-repair-start',{transactionId,manual,ambiguityRepairAttempt:1,candidateCount:Number(error?.validation?.candidateCount)||null,validTopLevelCount:Number(error?.validation?.validTopLevelCount)||null},'warn');
                const repairPrompt=directPrompt;
                assertPhysicalPromptBounded(repairPrompt,packing.promptTargetTokens,'Notebook ambiguity repair request');
                job=enqueue(BUS_STAGE.MAINTENANCE,structuredSidecarOptions({prompt:repairPrompt,systemPrompt:notebookAmbiguityRepairSystemPrompt(),reasoningEffort:cfg.reasoningEffort||'medium',timeoutMs:Number(cfg.timeoutMs)||120000,priority:BUS_PRIORITY.NOTEBOOK,dedupKey:`notebook-ambiguity-repair:${chatId}:${(ctx?.chat||[]).length}`,label:'Repair rolling Notebook JSON',telemetry:{notebook:true,manual,deltaMode:false,ambiguityRepairAttempt:1,...(directorMeta||{})},structuredValidator:value=>validateNotebookPayload(value,directEvidenceIds),structuredCandidateComposer:composeNotebookSplitPayload,synthesisCandidateParser:text=>parseResponse(text,directEvidenceIds)}));
                response=await job.promise;
                ambiguityRepaired=true;
                logEvent('notebook','ambiguity-repair-complete',{transactionId,manual,ambiguityRepairAttempt:1,slot:responseSlot(response)},'info');
            }
            payload=parseResponse(response.structuredPayload??response.text,directEvidenceIds);
            jobId=job.id||job.jobId||responseJobId(response);
            recordNexusTransactionSlice(transactionId,{sliceId:'notebook-direct',recovered:ambiguityRepaired,details:{jobId,ambiguityRepairAttempt:ambiguityRepaired?1:0}});
        }
        else{reshapeUsed=true;const rows=notebookSceneRows(sceneSnapshot);const slices=sliceChronologicalRows({rows,renderRow:renderNotebookSceneRow,buildPrompt:(sliceText,sliceRows)=>notebookDeltaPrompt(doc,sliceText,sliceRows.map(row=>row.evidenceId),names),targetTokens:packing.promptTargetTokens,label:'Notebook scene messages'});updateNexusTransactionExecution(transactionId,{sliceManifest:slices.map(slice=>({id:`notebook-slice-${slice.index}`,order:slice.index,kind:'scene-delta',evidenceIds:slice.rows.map(row=>row.evidenceId),messageIndexes:slice.rows.map(row=>row.index),estimatedInputTokens:slice.estimatedInputTokens}))},'slice-manifest-planned');const batch=await runLaneAModelWorkerBatch({laneAEnqueue:enqueueSidecar,domain:NEXUS_BATCH_DOMAIN.NOTEBOOK,stage:BUS_STAGE.MAINTENANCE,items:slices,requestedBatch:slices.length>1,label:`Notebook scene deltas · ${chatId}`,priority:BUS_PRIORITY.NOTEBOOK,dedupKey:`notebook-deltas:${chatId}:${(ctx?.chat||[]).length}`,telemetry:{notebook:true,manual,notebookReshape:true,...(directorMeta||{})},buildRequest:slice=>{const ids=slice.rows.map(row=>row.evidenceId),prompt=notebookDeltaPrompt(doc,slice.passage,ids,names);assertPhysicalPromptBounded(prompt,packing.promptTargetTokens,'Notebook delta slice');return structuredSidecarOptions({prompt,systemPrompt:'Extract read-only Nexus Notebook state deltas. Return exact JSON only.',maxTokens:Math.min(1536,packing.resourcePolicy.outputCeilingTokens||1536),priority:BUS_PRIORITY.NOTEBOOK,structuredValidator:value=>validateNotebookDeltaPayload(value,ids),telemetry:{notebookReshape:true,phase:'slice',sliceId:`notebook-slice-${slice.index}`}});},parse:(text,slice)=>parseStructuredJsonCandidate(text,{validator:value=>validateNotebookDeltaPayload(value,slice.rows.map(row=>row.evidenceId)),label:`Notebook slice ${slice.index}`}),validate:(value,slice)=>validateNotebookDeltaPayload(value,slice.rows.map(row=>row.evidenceId)),buildRecovery:slice=>{const ids=slice.rows.map(row=>row.evidenceId),prompt=`${notebookDeltaPrompt(doc,slice.passage,ids,names)}\n\nRECOVERY: Correct only this slice's delta JSON. Do not rewrite the Notebook.`;return structuredSidecarOptions({prompt,systemPrompt:'Return corrected Notebook delta JSON only.',maxTokens:Math.min(1536,packing.resourcePolicy.outputCeilingTokens||1536),priority:BUS_PRIORITY.NOTEBOOK,structuredValidator:value=>validateNotebookDeltaPayload(value,ids),telemetry:{notebookReshape:true,phase:'slice-recovery',sliceId:`notebook-slice-${slice.index}`}});}});for(const outcome of batch.completed)recordNexusTransactionSlice(transactionId,{sliceId:`notebook-slice-${outcome.unit.item.index}`,recovered:outcome.recovered===true,details:{jobId:outcome.jobId||null}});if(batch.failed.length){for(const outcome of batch.failed)recordNexusTransactionSlice(transactionId,{sliceId:`notebook-slice-${outcome.unit.item.index}`,failed:true});abortNexusTransaction(transactionId,'Notebook slice failed after bounded recovery; no Notebook mutation was staged.');throw new Error(batch.failed[0]?.error?.message||'Notebook slice failed after bounded recovery.');}let deltas=batch.completed.map(outcome=>outcome.value).filter(value=>value.changed===true&&value.deltas?.length);if(!deltas.length){payload={changed:false,reason:'Validated scene slices contained no material Notebook state change.',evidence:[]};response={};jobId=batch.completed.map(outcome=>outcome.jobId).filter(Boolean).join(',')||null;}else{markNexusTransactionAggregating(transactionId,{phase:'notebook-reconcile',inputSliceCount:deltas.length});deltas=await reduceNotebookDeltasToFit({deltas,doc,names,packing,transactionId,enqueueSidecar});const finalEvidenceIds=[...new Set(deltas.flatMap(delta=>delta.evidence||[]))];const finalPrompt=notebookReconcilePrompt(doc,deltas,names);assertPhysicalPromptBounded(finalPrompt,packing.promptTargetTokens,'Notebook final reconciliation');const finalBatch=await runLaneAModelWorkerBatch({laneAEnqueue:enqueueSidecar,domain:NEXUS_BATCH_DOMAIN.NOTEBOOK,stage:BUS_STAGE.MAINTENANCE,items:[{deltas}],requestedBatch:false,buildRequest:()=>structuredSidecarOptions({prompt:finalPrompt,systemPrompt,maxTokens:Math.min(2048,packing.resourcePolicy.outputCeilingTokens||2048),priority:BUS_PRIORITY.NOTEBOOK,structuredValidator:value=>validateBoundedNotebookPayload(value,finalEvidenceIds),structuredCandidateComposer:composeNotebookSplitPayload,telemetry:{notebookReshape:true,phase:'final-reconciliation'}}),parse:text=>parseStructuredJsonCandidate(text,{validator:value=>validateBoundedNotebookPayload(value,finalEvidenceIds),label:'Notebook final reconciliation'}),validate:value=>validateBoundedNotebookPayload(value,finalEvidenceIds),buildRecovery:()=>structuredSidecarOptions({prompt:`${finalPrompt}\n\nRECOVERY: Return one corrected complete Notebook JSON object only.`,systemPrompt,maxTokens:Math.min(2048,packing.resourcePolicy.outputCeilingTokens||2048),priority:BUS_PRIORITY.NOTEBOOK,structuredValidator:value=>validateBoundedNotebookPayload(value,finalEvidenceIds),structuredCandidateComposer:composeNotebookSplitPayload,telemetry:{notebookReshape:true,phase:'final-reconciliation-recovery'}})});const outcome=finalBatch.completed[0];if(!outcome){abortNexusTransaction(transactionId,'Notebook aggregation failed after bounded recovery; no mutation was staged.');throw new Error(finalBatch.failed[0]?.error?.message||'Notebook final reconciliation failed.');}payload=parseResponse(outcome.value,finalEvidenceIds);response=outcome.response;jobId=outcome.jobId||outcome.responseJobId(response);}}
        recordNotebookRefreshParsed(transactionId,payload,response?.text);if(!payload.changed){abortNexusTransaction(transactionId,'Notebook worker reported no persistent change.');recordRefreshStatus({outcome:NOTEBOOK_REFRESH_OUTCOME.NO_CHANGE,reason:payload.reason||'The model found no change to the working state.',manual,evidenceThrough:throughNow,fingerprint:materialDecisionContext.sourceFingerprint});prepareNotebookPrompt();logEvent('notebook','sidecar-refresh-no-change',{jobId,transactionId,slot:responseSlot(response),reason:payload.reason,evidence:payload.evidence,chars:doc.text.length,manual,reshapeUsed},'info');return {updated:false,notebook:doc,reason:payload.reason,slot:responseSlot(response),transactionId,reshapeUsed};}validateEvidence(payload,scene);const currentScene=recentSceneSnapshot(cfg.contextMessages||8),currentDoc=getNotebook(),currentNames=characterNames(),currentAssumptions=buildNotebookAssumptions({chatId:getContext()?.chatId||'',sourceMessages:currentScene.messages,priorNotebook:currentDoc,contextMessages:getSettings().notebook?.contextMessages||8,characterNames:currentNames,relevantState:{schema:'rolling-notebook/v2',automatic:getSettings().notebook?.automatic!==false}});const fresh=enforceNexusTransactionFreshBeforeStage(transactionId,currentAssumptions);if(fresh.state==='stale'){prepareNotebookPrompt();return {skipped:true,stale:true,reason:'stale-before-stage',transactionId};}const staged=stageNotebookRefreshTransaction(transactionId,{payload,metadata:{manual,reshapeUsed,...(directorMeta||{})}});if(staged.state!=='staged')throw new Error(staged.error||'Notebook transaction failed validation.');const durabilityContext=getContext(),beforeNotebook=clone(currentDoc),nextNotebook=previewNotebookSave(beforeNotebook,payload.notebook,{updatedBy:`sidecar-${responseSlot(response)||'unknown'}`});const committedTx=await commitCanonicalNexusMutation(transactionId,{type:'metadata.set',chatId:String(durabilityContext?.chatId||''),key:KEY,value:nextNotebook,expected:beforeNotebook},{context:durabilityContext,currentAssumptions:()=>buildNotebookAssumptions({chatId:getContext()?.chatId||'',sourceMessages:recentSceneSnapshot(getSettings().notebook?.contextMessages||8).messages,priorNotebook:getNotebook(),contextMessages:getSettings().notebook?.contextMessages||8,characterNames:characterNames(),relevantState:{schema:'rolling-notebook/v2',automatic:getSettings().notebook?.automatic!==false}}),committed:()=>({updated:nextNotebook.text!==doc.text,updatedAt:nextNotebook.updatedAt,chars:nextNotebook.text.length,reshapeUsed}),schedulerPublish:enqueueSidecar?.publish});if(committedTx.state==='stale'){prepareNotebookPrompt();return {skipped:true,stale:true,reason:'stale-before-commit',transactionId};}const saved=getNotebook(),updated=saved.text!==doc.text;recordRefreshStatus({outcome:updated?NOTEBOOK_REFRESH_OUTCOME.UPDATED:NOTEBOOK_REFRESH_OUTCOME.NO_CHANGE,reason:payload.reason||'',manual,evidenceThrough:throughNow,fingerprint:materialDecisionContext.sourceFingerprint});notify();prepareNotebookPrompt();logEvent('notebook',updated?'sidecar-refresh-complete':'sidecar-refresh-no-change',{chatId:durabilityContext?.chatId??null,jobId,transactionId,slot:responseSlot(response),reason:payload.reason,evidence:payload.evidence,chars:saved.text.length,manual,reshapeUsed},'info');return {updated,notebook:saved,reason:payload.reason,slot:responseSlot(response),transactionId,reshapeUsed};
    }catch(error){
        if(error?.name==='NexusNotebookRejected'){
            try{abortNexusTransaction(transactionId,error.message);}catch{}
            recordRefreshStatus({outcome:NOTEBOOK_REFRESH_OUTCOME.REJECTED,reason:error.message,manual});
            prepareNotebookPrompt();
            logEvent('notebook','sidecar-refresh-rejected',{chatId,transactionId,code:error.code,reason:error.message,manual,chars:doc.text.length},'warn');
            return {updated:false,rejected:true,code:error.code,reason:error.message,notebook:getNotebook(),transactionId};
        }
        const overBudget=error?.validation?.notebookSizeExceeded===true||/hard persisted ceiling/.test(String(error?.message||''));
        recordRefreshStatus(overBudget?{outcome:NOTEBOOK_REFRESH_OUTCOME.REJECTED,reason:NOTEBOOK_REJECTION_TEXT[NOTEBOOK_REJECTION.OVER_BUDGET],manual}:{outcome:NOTEBOOK_REFRESH_OUTCOME.FAILED,reason:String(error?.message||error||'Notebook refresh failed'),manual});
        try{await failNexusTransaction(transactionId,error,{stage:'notebook-refresh',recoveryRequired:rollbackWasRestored(error)!==true});}catch{}throw error;}
}

