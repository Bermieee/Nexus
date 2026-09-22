import { getContext } from '../../../../st-context.js';
import { getSettings } from '../core/settings.js';
import { enqueueBusJob, enqueueBusBatch, preferredBusSlot, BUS_STAGE, BUS_PRIORITY } from '../sidecar/bus.js';
import { structuredSidecarOptions } from '../nexus/batch-layer.js';
import { parseStructuredJsonCandidate } from '../sidecar/normalize-response.js';
import { validateMutationEnvelope } from '../sidecar/semantic-validation.js';
import { packPostTurnCatalogSlices, nominatePostTurnRelationalPairs, renderPostTurnRelationalPair } from './reshape.js';
import { reconcilePostTurnOperations, reconcilePostTurnOperationLayers } from './reconcile.js';
import { getActiveBooks } from '../lore/active-books.js';
import { captureLoreCorpus } from '../lore/corpus-authority.js';
import { loadBook, findEntryByUid } from '../lore/store.js';
import { getTree } from '../tree/store.js';
import { findNode } from '../tree/model.js';
import { proposeCreate, proposeUpdate, proposeDelete, proposeMerge, proposeSplit, proposeMoveEntry, proposeCreateCategory, proposeRenameCategory, proposeMoveCategory, proposeDeleteCategory, entryBaselineFromEntry } from '../proposals/bus.js';
import { logEvent } from '../observability/telemetry.js';
import { estimateContentTokens } from '../observability/token-estimator.js';
import { routeOperation, rollbackDirectWrite, writeValveMode, assertDirectWritesActive } from '../lore/write-valve.js';
import { isIntentionalCancellation } from '../core/cancellation.js';
import { captureProposalStore, settleProposalForParentRollback, getProposals, rejectProposal } from '../proposals/store.js';
import { captureNexusWorkScope, isNexusWorkScopeFresh } from '../nexus/work-scope.js';
import {
    buildPostTurnProposalAssumptions,
    beginPostTurnProposalTransaction,
    finalizePostTurnProposalTransaction,
    failNexusTransactionDurable as failNexusTransaction,
    enforceNexusTransactionFreshBeforeStage,
} from '../nexus/transaction-service.js';
import { commitCanonicalNexusMutation } from '../nexus/mutation-coordinator.js';
import {
    consumePostTurnRange,
    markPostTurnPendingHint,
    materializeRecoveredPendingMessageIds,
    reconstructPostTurnPending,
    normalizePostTurnBacklog,
    isPostTurnEligibleMessage,
    postTurnMessageKey,
    planPostTurnCatchupWindow,
    POSTTURN_BACKLOG_VERSION,
} from './reconstructible-backlog.js';
import { acquirePostTurnDrainLease, renewPostTurnDrainLease, releasePostTurnDrainLease, beginPostTurnParentSaga, updatePostTurnParentSaga, resolvePostTurnParentSaga, getQuarantinedPostTurnMessageIds } from './parent-saga.js';
import { reconcilePostTurnParentSagas } from './parent-recovery.js';
import { mutateChatMetadataDurably } from '../nexus/host-durability.js';
import { evaluatePostTurnProposalWarrants, postTurnProposalWarrantFingerprint } from './decision-site.js';
import { resolveCanonicalHomePlan, verifyCanonicalHomeCandidateFresh } from '../lifecycle/canonical-home.js';

const POSTTURN_META_KEY = 'tv2_postturn_backlog';
const activeEvaluatedDrainByChat = new Map();
function ensureMessageId(message,index){
    if(!message)return null;
    if(!message.extra||typeof message.extra!=='object')message.extra={};
    if(message.extra.tv2_message_id==null||String(message.extra.tv2_message_id).trim()==='')message.extra.tv2_message_id=`tv2_msg_${Date.now()}_${Number(index)}_${Math.random().toString(36).slice(2,8)}`;
    return String(message.extra.tv2_message_id);
}
function backlogStore(ctx=getContext()){
    const chat=ctx?.chat||[];
    const fallback={version:POSTTURN_BACKLOG_VERSION,pendingMessageIds:[],pendingStart:null,pendingEnd:null,deferredCount:0,processedThrough:-1,recentProcessed:[],processedChunks:[]};
    if(!ctx?.chatMetadata)return normalizePostTurnBacklog(fallback,{chat,chatId:ctx?.chatId||''});
    return normalizePostTurnBacklog(ctx.chatMetadata[POSTTURN_META_KEY],{chat,chatId:ctx?.chatId||''});
}
function saveBacklog(ctx=getContext()){try{ctx?.saveMetadataDebounced?.();}catch{}}
function backlogSnapshot(ctx=getContext()){const s=backlogStore(ctx);return {version:POSTTURN_BACKLOG_VERSION,pendingMessageIds:[...(s.pendingMessageIds||[])],pendingStart:s.pendingStart,pendingEnd:s.pendingEnd,deferredCount:s.deferredCount,processedThrough:Number(s.processedThrough??-1),recentProcessed:JSON.parse(JSON.stringify(s.recentProcessed||[])),processedChunks:JSON.parse(JSON.stringify(s.processedChunks||[]))};}
function reconcilePendingMessageIds(snapshot,ctx=getContext()){
    const chat=ctx?.chat||[],indexById=new Map();
    chat.forEach((message,index)=>{const id=message?.extra?.tv2_message_id;if(id!=null)indexById.set(String(id),index);});
    const ids=[...new Set((snapshot?.pendingMessageIds||[]).map(String).filter(Boolean))],missing=[],ineligible=[],eligible=[];
    for(const id of ids){if(!indexById.has(id)){missing.push(id);continue;}const index=indexById.get(id);if(isPostTurnEligibleMessage(chat[index]))eligible.push({id,index});else ineligible.push({id,index});}
    const indices=eligible.map(row=>row.index).sort((a,b)=>a-b);
    return {ids,missing,ineligible,eligibleIds:eligible.map(row=>row.id),indices,start:indices.length?indices[0]:null,end:indices.length?indices[indices.length-1]:null};
}
function recentChatForRange(startIndex,endIndex,maxMessages,ctx=getContext()){
    const chat=ctx?.chat||[];
    if(!chat.length)return '';
    const start=Math.max(0,Math.min(Number(startIndex)||0,chat.length-1));
    const end=Math.max(start,Math.min(Number(endIndex)||0,chat.length-1));
    const contextStart=Math.max(0,start-Math.max(1,Number(maxMessages)||1)+1);
    return chat.slice(contextStart,end+1).map((m,offset)=>{
        const index=contextStart+offset;
        const role=m?.is_system?'System':m?.is_user?'User':'Assistant';
        const messageId=m?.extra?.tv2_message_id==null?'':String(m.extra.tv2_message_id).trim();
        return `[${role} @ ${index}${messageId?` | id=${messageId}`:''}]: ${m?.mes||''}`;
    }).join('\n\n');
}
function parse(input,validator=null){if(input&&typeof input==='object'&&!Array.isArray(input)){if(typeof validator==='function'){const verdict=validator(input);if(verdict?.valid===false)throw new Error(verdict.reason||'Post-turn Sidecar failed semantic validation.');return verdict?.value??input;}return input;}return parseStructuredJsonCandidate(String(input||''),{validator,label:'Post-turn Sidecar'});}
function cleanText(v){return String(v??'').replace(/\s+/g,' ').trim();}
function asUid(value){const n=Number(value);return Number.isInteger(n)&&n>=0?n:null;}

function sourceMessagesForRange(startIndex,endIndex,ctx=getContext()){
    const chat=ctx?.chat||[];
    const start=Math.max(0,Math.min(Number(startIndex)||0,Math.max(0,chat.length-1)));
    const end=Math.max(start,Math.min(Number(endIndex)||0,Math.max(0,chat.length-1)));
    return chat.slice(start,end+1).map((message,offset)=>({
        index:start+offset,
        isUser:message?.is_user===true,
        isSystem:message?.is_system===true,
        messageId:message?.extra?.tv2_message_id==null?null:String(message.extra.tv2_message_id),
        text:String(message?.mes||''),
        eligible:isPostTurnEligibleMessage(message),
        eligibilityFlags:{skip:message?.extra?.tv2_postturn_skip===true,incomplete:message?.extra?.tv2_generation_incomplete===true,failed:message?.extra?.tv2_generation_failed===true},
        authorityKey:postTurnMessageKey(ctx?.chatId||'',start+offset,message),
    }));
}
function fnv1a64(text=''){
    let hash=0xcbf29ce484222325n;
    for(const ch of String(text||'')){hash^=BigInt(ch.codePointAt(0));hash=BigInt.asUintN(64,hash*0x100000001b3n);}
    return hash.toString(16).padStart(16,'0');
}
function catalogAuthorityProjection(authority={}){
    const books=Object.entries(authority?.books||{}).sort(([a],[b])=>a.localeCompare(b)).map(([book,value])=>{
        const canonical=JSON.stringify(value||{});
        return {book,fingerprint:`ptcat:${fnv1a64(canonical)}:${canonical.length}`,entryCount:Array.isArray(value?.entries)?value.entries.length:0,nodeCount:Array.isArray(value?.nodes)?value.nodes.length:0};
    });
    const joined=JSON.stringify(books);
    return {version:1,fingerprint:`ptcatalog:${fnv1a64(joined)}:${joined.length}`,books};
}
function postTurnAssumptionsSnapshot(sourceRange,writableBooks,context=getContext(),catalogAuthority=null){
    const books=[...new Set((writableBooks||[]).map(String))];
    return buildPostTurnProposalAssumptions({
        chatId:context?.chatId||null,
        sourceRange,
        sourceMessages:sourceMessagesForRange(sourceRange?.[0],sourceRange?.[1],context),
        writableBooks:books,
        writeModes:Object.fromEntries(books.map(book=>[book,writeValveMode(book)])),
        relevantState:{proposalSchema:'post-turn/v2',catalog:catalogAuthorityProjection(catalogAuthority||{})},
    });
}
function normalizePostTurnHandle(handle){
    if(!handle||typeof handle!=='object'||!handle.promise||typeof handle.promise.then!=='function')throw new Error('Post-turn Sidecar dispatcher did not return a valid job handle.');
    return handle;
}

function evidenceContractForSlice(slice,sourceStart,targetIndex){
    const identities=Array.isArray(slice?.sourceIdentities)?slice.sourceIdentities:[];
    const sourceIndices=new Set(identities.map(row=>Number(row?.index)).filter(index=>Number.isInteger(index)&&index>=Number(sourceStart)&&index<=Number(targetIndex)));
    const sourceMessageIds=new Set(identities.map(row=>String(row?.messageId||'').trim()).filter(Boolean));
    return {sourceIndices,sourceMessageIds,sourceStart:Number(sourceStart),targetIndex:Number(targetIndex)};
}
function validatePostTurnEvidenceEnvelope(value,contract={}){
    const errors=[];const normalized=[];
    if(!value||typeof value!=='object'||Array.isArray(value))return {valid:false,score:0,reason:'Post-turn evidence payload must be a top-level object.'};
    if(!Array.isArray(value.evidence))return {valid:false,score:0,reason:'Post-turn evidence payload requires evidence array.'};
    const kinds=new Set(['fact','character','arc','world']);
    value.evidence.forEach((row,index)=>{
        if(!row||typeof row!=='object'||Array.isArray(row)){errors.push(`evidence ${index} is not an object`);return;}
        const kind=String(row.kind||'fact').trim().toLowerCase();
        const statement=cleanText(row.statement||row.fact||row.text||'');
        const sourceIndices=[...new Set((Array.isArray(row.source_indices)?row.source_indices:[]).map(Number).filter(Number.isInteger))];
        const sourceMessageIds=[...new Set((Array.isArray(row.source_message_ids)?row.source_message_ids:[]).map(v=>String(v||'').trim()).filter(Boolean))];
        if(!kinds.has(kind))errors.push(`evidence ${index} has invalid kind`);
        if(!statement)errors.push(`evidence ${index} has empty statement`);
        if(!sourceIndices.length)errors.push(`evidence ${index} requires source_indices`);
        for(const sourceIndex of sourceIndices)if(!contract.sourceIndices?.has(sourceIndex))errors.push(`evidence ${index} cites source index ${sourceIndex} outside this physical source authority`);
        for(const messageId of sourceMessageIds)if(contract.sourceMessageIds?.size&&!contract.sourceMessageIds.has(messageId))errors.push(`evidence ${index} cites unknown source message id ${messageId}`);
        normalized.push({kind,statement,source_indices:sourceIndices,source_message_ids:sourceMessageIds});
    });
    return {valid:errors.length===0,score:errors.length?0:20+normalized.length,value:{...value,evidence:normalized,reasoning:String(value.reasoning||'')},reason:errors.length?errors.join('; '):null,details:{errors}};
}
function mergePostTurnEvidence(payloads=[]){
    const rows=[];const byKey=new Map();
    for(const payload of payloads||[])for(const item of payload?.evidence||[]){
        const statement=cleanText(item?.statement||'');if(!statement)continue;
        const kind=String(item?.kind||'fact').toLowerCase();const key=`${kind}:${statement.toLowerCase()}`;
        const existing=byKey.get(key);
        if(existing){
            existing.source_indices=[...new Set([...existing.source_indices,...(item.source_indices||[]).map(Number).filter(Number.isInteger)])].sort((a,b)=>a-b);
            existing.source_message_ids=[...new Set([...existing.source_message_ids,...(item.source_message_ids||[]).map(String).filter(Boolean)])].sort();
        }else{
            const row={id:`E${rows.length+1}`,kind,statement,source_indices:[...new Set((item.source_indices||[]).map(Number).filter(Number.isInteger))].sort((a,b)=>a-b),source_message_ids:[...new Set((item.source_message_ids||[]).map(String).filter(Boolean))].sort()};
            rows.push(row);byKey.set(key,row);
        }
    }
    return rows;
}
function renderPostTurnEvidence(evidence=[]){return JSON.stringify({evidence:(evidence||[]).map(row=>({id:row.id,kind:row.kind,statement:row.statement,source_indices:row.source_indices,source_message_ids:row.source_message_ids}))});}
function buildEvidenceReductionPrompt(evidence=[]){
    return `Reduce this Post-turn evidence map without inventing or dropping distinct durable facts. Merge only semantic duplicates. Preserve the union of exact source_indices and source_message_ids for every retained statement.\n\nINPUT EVIDENCE\n${renderPostTurnEvidence(evidence)}\n\nReturn ONLY JSON using the same shape: {"evidence":[{"kind":"fact|character|arc|world","statement":"concise durable evidence","source_indices":[123],"source_message_ids":["id"]}],"reasoning":"short reduction note"}.`;
}
function reductionEvidenceContract(evidence=[]){
    return {sourceIndices:new Set((evidence||[]).flatMap(row=>row.source_indices||[]).map(Number).filter(Number.isInteger)),sourceMessageIds:new Set((evidence||[]).flatMap(row=>row.source_message_ids||[]).map(String).filter(Boolean))};
}
function packEvidenceGroups(evidence=[],promptTargetTokens=8000){
    const groups=[];let current=[];
    const flush=()=>{if(current.length){groups.push(current);current=[];}};
    for(const row of evidence||[]){
        const trial=[...current,row];
        if(current.length&&estimateContentTokens(buildEvidenceReductionPrompt(trial))>promptTargetTokens){flush();current=[row];}
        else current=trial;
    }
    flush();return groups;
}
async function executePostTurnRequests(requests,{enqueueSidecar=null,maxConcurrent=6,label='Post-turn batch',maxRecoveryAttempts=1}={}){
    const list=Array.isArray(requests)?requests:[];const responses=new Array(list.length);
    const width=Math.max(1,Math.min(8,Math.floor(Number(maxConcurrent)||6)));
    const recoveryCap=Math.max(0,Math.min(2,Math.floor(Number(maxRecoveryAttempts)||0)));
    for(let offset=0;offset<list.length;offset+=width){
        const wave=list.slice(offset,offset+width).map((request,localIndex)=>({request,globalIndex:offset+localIndex}));
        let pending=wave;let attempt=0;
        while(pending.length){
            const current=pending;pending=[];
            const retrying=attempt>0;
            const requestsForAttempt=current.map(({request})=>retrying&&request?.dedupKey?{...request,dedupKey:`${request.dedupKey}:slice-recovery-${attempt}`} : request);
            if(typeof enqueueSidecar==='function'){
                const handles=requestsForAttempt.map(request=>normalizePostTurnHandle(enqueueSidecar(BUS_STAGE.POST_TURN,request)));
                const settled=await Promise.allSettled(handles.map(handle=>handle.promise));
                settled.forEach((row,index)=>{
                    const unit=current[index];
                    if(row.status==='fulfilled')responses[unit.globalIndex]=row.value;
                    else pending.push({...unit,error:row.reason||new Error(`${label} slice failed.`)});
                });
            }else if(requestsForAttempt.length===1){
                // A one-slice Post-turn phase must not create a multi-worker batch:
                // the batch bus reserves both Sidecars even though only one child
                // can run. Dispatch the single physical request directly so the
                // other lane remains available for Summary/manual/background work.
                const unit=current[0];
                try{
                    const handle=normalizePostTurnHandle(enqueueBusJob(BUS_STAGE.POST_TURN,requestsForAttempt[0]));
                    responses[unit.globalIndex]=await handle.promise;
                }catch(error){pending.push({...unit,error:error||new Error(`${label} slice failed.`)});}
            }else{
                const handle=enqueueBusBatch(BUS_STAGE.POST_TURN,requestsForAttempt,{label:`${label}${retrying?` recovery ${attempt}`:''} · ${offset+1}-${offset+wave.length}/${list.length}`,priority:BUS_PRIORITY.POST_TURN,allowPartial:true,telemetry:{postTurnLogicalJob:true,postTurnWave:true,postTurnWaveOffset:offset,postTurnWaveSize:wave.length,postTurnSliceRecovery:retrying,postTurnSliceRecoveryAttempt:attempt}});
                const result=await handle.promise;
                const completed=new Map((result.batches||[]).map(row=>[Number(row.index),row.response]));
                const failures=new Map((result.failures||[]).map(row=>[Number(row.index),row.error||new Error(`${label} slice failed.`)]));
                current.forEach((unit,index)=>{
                    if(completed.has(index))responses[unit.globalIndex]=completed.get(index);
                    else pending.push({...unit,error:failures.get(index)||new Error(`${label} did not return slice ${unit.globalIndex+1}.`) });
                });
            }
            if(!pending.length)break;
            if(attempt>=recoveryCap){
                const first=pending[0]?.error||new Error(`${label} slice failed.`);
                first.postTurnFailedSlices=pending.map(unit=>unit.globalIndex);
                throw first;
            }
            logEvent('postturn','slice-recovery-start',{label,failedSlices:pending.map(unit=>unit.globalIndex),retainedSlices:wave.filter(unit=>responses[unit.globalIndex]!==undefined).map(unit=>unit.globalIndex),attempt:attempt+1,maxRecoveryAttempts:recoveryCap},'warn');
            attempt+=1;
        }
    }
    return responses;
}


export async function markPostTurnPending(messageIndex){
    const context=getContext(),chat=context?.chat||[];
    const index=Number.isInteger(messageIndex)?messageIndex:Math.max(0,chat.length-1);
    const message=chat[index],messageId=ensureMessageId(message,index);
    if(!messageId){logEvent('postturn','pending-mark-skipped',{messageIndex:index,reason:'message-unavailable'},'warn');return {recorded:false};}
    const activeEvaluated=activeEvaluatedDrainByChat.get(String(context?.chatId||''))||null;
    if(activeEvaluated&&index>Number(activeEvaluated.targetIndex)){
        // Automatic evaluated drains own an exact already-admitted prefix. Do
        // not mutate the same backlog metadata while that prefix is committing.
        // Post-turn backlog authority is reconstructible from canonical chat +
        // processedThrough, so this later suffix is recovered immediately after
        // the prefix settles (or after a failure) without widening worker input.
        const visible=getPostTurnBacklogState(context);
        const result={recorded:true,messageIndex:index,messageId,pendingStart:visible.pendingStart,pendingEnd:Math.max(Number(visible.pendingEnd??index),index),pendingMessageCount:Math.max(Number(visible.pendingMessageIds?.length||0),Number(visible.recoveredIndices?.length||0)),deferredCount:visible.deferredCount,deferredHint:true,reconstructible:true};
        logEvent('postturn','pending-hint-deferred',{...result,activeSourceRange:[activeEvaluated.sourceStart,activeEvaluated.targetIndex],durable:false,authority:'reconstructible-chat-plus-processed-fence'},'debug');
        return result;
    }
    const next=markPostTurnPendingHint(backlogStore(context),index,{chat,chatId:context?.chatId||'',messageId});
    if(context?.chatMetadata)context.chatMetadata[POSTTURN_META_KEY]=next;
    saveBacklog(context);
    const result={recorded:true,messageIndex:index,messageId,pendingStart:next.pendingStart,pendingEnd:next.pendingEnd,pendingMessageCount:next.pendingMessageIds.length,deferredCount:next.deferredCount,reconstructible:true};
    logEvent('postturn','marked-pending',{...result,durable:false,authority:'reconstructible-chat-plus-processed-fence'},'debug');
    return result;
}

export function getPostTurnBacklogState(context=getContext()){
    const chat=context?.chat||[];
    // Director planning must not depend on the best-effort MESSAGE_RECEIVED hint.
    // Reconstruct a derived view from canonical chat + durable processed fences
    // before deciding whether Post-turn is due. Recovery-quarantined source IDs
    // remain durably owned by their parent saga but are not allowed to keep the
    // entire Post-turn scheduler permanently due.
    const rebuilt=reconstructPostTurnPending(backlogStore(context),{chat,chatId:context?.chatId||''});
    const s=rebuilt.state,quarantined=new Set(getQuarantinedPostTurnMessageIds({context}));
    const visible={...s,pendingMessageIds:(s.pendingMessageIds||[]).filter(id=>!quarantined.has(String(id)))};
    // Planning is read-only, so reconstructed canonical work may not have durable
    // message IDs yet. Do not erase that work merely because the ID hint list is
    // empty. Combine exact visible IDs with recovered canonical chat indices and
    // exclude only messages whose already-existing stable ID is quarantined.
    const identity=reconcilePendingMessageIds(visible,context);
    const visibleRecovered=(rebuilt.recoveredIndices||[]).filter(index=>{
        const id=String(chat[index]?.extra?.tv2_message_id||'').trim();
        return !id||!quarantined.has(id);
    });
    const visibleIndices=[...(identity.indices||[]),...visibleRecovered].filter(Number.isInteger);
    if(visibleIndices.length){visible.pendingStart=Math.min(...visibleIndices);visible.pendingEnd=Math.max(...visibleIndices);}
    else if(quarantined.size){visible.pendingStart=null;visible.pendingEnd=null;}
    else {visible.pendingStart=s.pendingStart;visible.pendingEnd=s.pendingEnd;}
    return {version:POSTTURN_BACKLOG_VERSION,pendingMessageIds:[...(visible.pendingMessageIds||[])],pendingStart:visible.pendingStart,pendingEnd:visible.pendingEnd,deferredCount:visible.deferredCount,processedThrough:Number(visible.processedThrough??-1),recentProcessed:JSON.parse(JSON.stringify(visible.recentProcessed||[])),processedChunks:JSON.parse(JSON.stringify(visible.processedChunks||[])),reconstructed:rebuilt.reconstructed,recoveredIndices:[...visibleRecovered],quarantinedPendingCount:quarantined.size};
}


export function inspectPostTurnBacklogForAdmission({context=getContext()}={}){
    const state=getPostTurnBacklogState(context),chat=context?.chat||[];
    const recovered=[...(state.recoveredIndices||[])].filter(Number.isInteger);
    const identity=reconcilePendingMessageIds(state,context);
    const indices=[...new Set([...(identity.indices||[]),...recovered])].sort((a,b)=>a-b);
    const latestEligible=(()=>{for(let i=chat.length-1;i>=0;i-=1)if(isPostTurnEligibleMessage(chat[i]))return i;return -1;})();
    const oldest=indices.length?indices[0]:null,newest=indices.length?indices[indices.length-1]:null;
    const assistantIndices=[];for(let i=0;i<chat.length;i+=1)if(isPostTurnEligibleMessage(chat[i]))assistantIndices.push(i);
    const ordinal=index=>index==null?null:assistantIndices.filter(value=>value<=index).length;
    const latestOrdinal=ordinal(latestEligible)||0,oldestOrdinal=ordinal(oldest);
    return{pendingCount:indices.length,oldestIndex:oldest,newestIndex:newest,processedThrough:Number(state.processedThrough??-1),latestEligibleIndex:latestEligible,ageAssistantTurns:oldestOrdinal==null?0:Math.max(0,latestOrdinal-oldestOrdinal+1),deferredCount:Number(state.deferredCount)||0,reconstructed:state.reconstructed===true,quarantinedPendingCount:Number(state.quarantinedPendingCount)||0,indices};
}

/**
 * Exact read-only authority for destructive Automatic backlog disposition.
 * This captures both backlog topology and source-message fingerprints so a
 * Jev DROP_STALE decision cannot be applied after the same-chat source changed.
 */
export function postTurnBacklogAuthoritySnapshot({context=getContext()}={}){
    const metrics=inspectPostTurnBacklogForAdmission({context}),chat=context?.chat||[],chatId=context?.chatId||'';
    const sources=(metrics.indices||[]).map(index=>{
        const message=chat[index];
        return {index,messageId:String(message?.extra?.tv2_message_id||''),key:message?postTurnMessageKey(chatId,index,message):`missing:${index}`};
    });
    return {chatId:String(chatId),processedThrough:Number(metrics.processedThrough??-1),pendingCount:Number(metrics.pendingCount)||0,indices:[...(metrics.indices||[])],sources};
}

function postTurnBacklogAuthorityMatches(expected,current){
    if(!expected||!current)return false;
    return JSON.stringify(expected)===JSON.stringify(current);
}

/**
 * Exact source-only authority for one semantically evaluated Automatic
 * Post-turn prefix. Unlike the broader lifecycle/Jev fingerprint this excludes
 * derived Character State, Summary, Notebook, Retrieval, and lore comparison
 * state. Those may legitimately change after routing while the chat evidence
 * Jev evaluated remains identical.
 *
 * Later pending turns are intentionally excluded. A new generation may arrive
 * while Character Review is settling the admitted prefix; that newer suffix
 * must remain pending rather than invalidating or expanding the already
 * evaluated source window.
 */
export function postTurnEvaluationAuthoritySnapshot({context=getContext(),sourceStart=null,targetIndex=null}={}){
    const metrics=inspectPostTurnBacklogForAdmission({context}),chat=context?.chat||[],chatId=String(context?.chatId||'');
    const start=Number.isInteger(Number(sourceStart))?Number(sourceStart):Number(metrics.indices?.[0]);
    const fallbackEnd=Array.isArray(metrics.indices)&&metrics.indices.length?Number(metrics.indices[metrics.indices.length-1]):null;
    const end=Number.isInteger(Number(targetIndex))?Number(targetIndex):fallbackEnd;
    if(!Number.isInteger(start)||!Number.isInteger(end)||end<start)return null;
    const pendingIndices=(metrics.indices||[]).map(Number).filter(Number.isInteger).filter(index=>index>=start&&index<=end);
    const sources=[];
    for(let index=start;index<=end;index+=1){
        const message=chat[index];
        sources.push({
            index,
            messageId:String(message?.extra?.tv2_message_id||''),
            key:message?postTurnMessageKey(chatId,index,message):`missing:${index}`,
        });
    }
    return {
        version:1,
        chatId,
        processedThrough:Number(metrics.processedThrough??-1),
        sourceStart:start,
        targetIndex:end,
        oldestPendingIndex:Array.isArray(metrics.indices)&&metrics.indices.length?Number(metrics.indices[0]):null,
        pendingIndices,
        sources,
    };
}

function postTurnEvaluationAuthorityMatches(expected,current){
    if(!expected||!current)return false;
    return JSON.stringify(expected)===JSON.stringify(current);
}

export function inspectPostTurnEvaluationWindow({context=getContext()}={}){
    const settings=getSettings();
    const metrics=inspectPostTurnBacklogForAdmission({context});
    const chat=context?.chat||[];
    if(!(metrics.pendingCount>0))return {...metrics,sourceStart:null,targetIndex:null,consumedPendingIndices:[],remainingPendingIndices:[],budgetLimited:false};
    const softTargetTokens=Math.max(2000,Number(settings.postTurn?.softPackingTargetTokens)||16000);
    const plan=planPostTurnCatchupWindow({
        pendingIndices:metrics.indices||[],chat,softTargetTokens,
        contextMessages:settings.postTurn?.contextMessages||10,
        estimateTokens:text=>estimateContentTokens(text),
    });
    return {...metrics,...plan};
}

export function isPostTurnEvaluationAuthorityCurrent(expectedAuthority,{context=getContext()}={}){
    if(!expectedAuthority)return false;
    const start=Number(expectedAuthority.sourceStart),end=Number(expectedAuthority.targetIndex);
    if(!Number.isInteger(start)||!Number.isInteger(end)||end<start)return false;
    const current=postTurnEvaluationAuthoritySnapshot({context,sourceStart:start,targetIndex:end});
    return postTurnEvaluationAuthorityMatches(expectedAuthority,current);
}

/**
 * Consume an Automatic-mode evidence window that was semantically evaluated and
 * intentionally produced no generic lore work. This mutates Post-turn lifecycle
 * bookkeeping and may reject still-unresolved Post-turn proposals tied exactly
 * to the consumed source IDs. It never changes approved/applied canon, Summary,
 * Notebook, Character State, or another subsystem's mutation surface.
 */
export async function consumePostTurnEvaluatedWindow({context=getContext(),sourceStart=null,targetIndex=null,reason='lifecycle-evaluated-no-lore',classification='NONE',expectedAuthority=null}={}){
    const activeContext=getContext();
    if(String(activeContext?.chatId??'')!==String(context?.chatId??''))return {consumed:false,stale:true,reason:'chat-changed',pendingPreserved:true};
    if(!context?.chatMetadata)return {consumed:false,reason:'no-chat-metadata'};
    const initial=inspectPostTurnEvaluationWindow({context});
    if(!(initial.pendingCount>0))return {consumed:false,reason:'nothing-pending',pendingCount:0};
    const start=Number.isInteger(Number(sourceStart))?Number(sourceStart):Number(initial.sourceStart);
    const end=Number.isInteger(Number(targetIndex))?Number(targetIndex):Number(initial.targetIndex);
    if(!Number.isInteger(start)||!Number.isInteger(end)||end<start)return {consumed:false,reason:'invalid-range',pendingCount:initial.pendingCount};
    // Legacy callers retain the original exact-plan equality. Lifecycle
    // Intelligence supplies source-only authority instead: later pending suffix
    // work may appear, but the exact evaluated prefix itself must be byte-stable
    // and remain the oldest pending authority.
    if(expectedAuthority){
        if(Number(expectedAuthority.sourceStart)!==start||Number(expectedAuthority.targetIndex)!==end)return {consumed:false,stale:true,reason:'evaluation-authority-range-mismatch',expected:[start,end],authorityRange:[expectedAuthority.sourceStart,expectedAuthority.targetIndex],pendingPreserved:true};
        const authority=postTurnEvaluationAuthoritySnapshot({context,sourceStart:start,targetIndex:end});
        if(!postTurnEvaluationAuthorityMatches(expectedAuthority,authority))return {consumed:false,stale:true,reason:'evaluation-source-changed',expectedAuthority,currentAuthority:authority,pendingPreserved:true};
    }else if(Number(initial.sourceStart)!==start||Number(initial.targetIndex)!==end)return {consumed:false,stale:true,reason:'evaluation-window-changed',expected:[start,end],current:[initial.sourceStart,initial.targetIndex]};
    const chat=context?.chat||[];
    let committed=null;
    await mutateChatMetadataDurably(context,'Post-turn evaluated-window consume',{keys:[POSTTURN_META_KEY]},()=>{
        const live=inspectPostTurnEvaluationWindow({context});
        let sourceAuthority=null;
        if(expectedAuthority){
            sourceAuthority=postTurnEvaluationAuthoritySnapshot({context,sourceStart:start,targetIndex:end});
            if(!postTurnEvaluationAuthorityMatches(expectedAuthority,sourceAuthority)){committed={stale:true,live,sourceAuthority};return JSON.parse(JSON.stringify(backlogStore(context)));}
        }else if(!(live.pendingCount>0)||Number(live.sourceStart)!==start||Number(live.targetIndex)!==end){committed={stale:true,live};return JSON.parse(JSON.stringify(backlogStore(context)));}
        const current=JSON.parse(JSON.stringify(backlogStore(context))),next=JSON.parse(JSON.stringify(current));
        const consumedIndices=new Set((expectedAuthority?.pendingIndices||live.consumedPendingIndices||[]).map(Number).filter(index=>index>=start&&index<=end)),consumedIds=new Set();
        for(const index of consumedIndices){const id=String(chat[index]?.extra?.tv2_message_id||'').trim();if(id)consumedIds.add(id);}
        next.pendingMessageIds=(next.pendingMessageIds||[]).filter(id=>!consumedIds.has(String(id)));
        const shadowContext={...context,chatMetadata:{...(context?.chatMetadata||{}),[POSTTURN_META_KEY]:next}};
        const remaining=reconcilePendingMessageIds(next,shadowContext);
        next.pendingStart=remaining.start;next.pendingEnd=remaining.end;
        if(!next.pendingMessageIds.length)next.deferredCount=0;
        Object.assign(next,consumePostTurnRange(next,{chat,chatId:context?.chatId||'',sourceStart:start,targetIndex:end}));
        // consumePostTurnRange keeps a coarse pending start when later work remains;
        // restore exact reconstructed visible authority for that remainder.
        const after=reconstructPostTurnPending(next,{chat,chatId:context?.chatId||''}).state;
        next.pendingMessageIds=[...(after.pendingMessageIds||[])];next.pendingStart=after.pendingStart;next.pendingEnd=after.pendingEnd;
        context.chatMetadata[POSTTURN_META_KEY]=JSON.parse(JSON.stringify(next));
        committed={stale:false,current,next,live,sourceAuthority,consumedIds:[...consumedIds],consumedPendingCount:consumedIndices.size};
        return JSON.parse(JSON.stringify(next));
    });
    if(!committed||committed.stale===true){
        const live=committed?.live||inspectPostTurnEvaluationWindow({context});
        return {consumed:false,stale:true,reason:expectedAuthority?'evaluation-source-changed':'evaluation-window-changed',expected:[start,end],current:[live?.sourceStart,live?.targetIndex],expectedAuthority:expectedAuthority||null,currentAuthority:committed?.sourceAuthority||null,pendingPreserved:true};
    }
    const consumedIds=new Set(committed.consumedIds||[]),rejectedProposalIds=[];
    // A definitive Automatic NONE/SKIP disposition also settles stale review
    // noise from this exact source prefix. Only unresolved Post-turn proposals
    // whose origin message belongs to the consumed window are rejected; applied
    // or otherwise resolved canonical mutations are never rolled back here.
    const pendingProposals=getProposals('pending').filter(row=>String(row?.source||'')==='post-turn'&&String(row?.origin?.chatId??'')===String(context?.chatId??''));
    for(const proposal of pendingProposals){
        const originId=String(proposal?.origin?.messageId||'');
        if(!originId||!consumedIds.has(originId))continue;
        try{if(await rejectProposal(proposal.id,`Lifecycle Intelligence consumed source window ${start}-${end} as ${String(classification||'NONE')} (${String(reason||'no durable lore')}).`))rejectedProposalIds.push(proposal.id);}
        catch(error){logEvent('postturn','evaluated-window-proposal-reject-failed',{proposalId:proposal.id,sourceRange:[start,end],error},'warn');}
    }
    const afterMetrics=inspectPostTurnBacklogForAdmission({context});
    const result={consumed:true,reason:String(reason||''),classification:String(classification||'NONE'),sourceRange:[start,end],consumedPendingCount:committed.consumedPendingCount,remainingPendingCount:Math.max(0,Number(afterMetrics.pendingCount)||0),oldProcessedThrough:Number(committed.current?.processedThrough??-1),newProcessedThrough:Number(committed.next?.processedThrough??end),rejectedProposalCount:rejectedProposalIds.length,rejectedProposalIds};
    logEvent('postturn','evaluated-window-consumed',result,'info');
    return result;
}

export async function discardPostTurnBacklog({context=getContext(),reason='operator-flush',rejectPending=true,expectedAuthority=null}={}){
    if(!context?.chatMetadata)return{discarded:false,reason:'no-chat-metadata'};
    const activeContext=getContext();
    if(String(activeContext?.chatId??'')!==String(context?.chatId??''))return {discarded:false,stale:true,reason:'chat-changed',pendingPreserved:true};
    let committed=null;
    await mutateChatMetadataDurably(context,'Post-turn stale backlog flush',{keys:[POSTTURN_META_KEY]},()=>{
        const authority=postTurnBacklogAuthoritySnapshot({context});
        if(expectedAuthority&&!postTurnBacklogAuthorityMatches(expectedAuthority,authority)){
            committed={stale:true,authority};
            return JSON.parse(JSON.stringify(backlogStore(context)));
        }
        const before=inspectPostTurnBacklogForAdmission({context}),chat=context?.chat||[];
        const flushedIndices=[...(before.indices||[])];
        const flushedMessageIds=[...new Set(flushedIndices.map(index=>String(chat[index]?.extra?.tv2_message_id||'')).filter(Boolean))];
        const latest=before.latestEligibleIndex,current=JSON.parse(JSON.stringify(backlogStore(context)));
        const next=consumePostTurnRange({...current,pendingMessageIds:[],pendingStart:null,pendingEnd:null,deferredCount:0},{chat,chatId:context?.chatId||'',sourceStart:Math.max(0,Number(current.processedThrough||-1)+1),targetIndex:Math.max(Number(current.processedThrough||-1),latest)});
        next.pendingMessageIds=[];next.pendingStart=null;next.pendingEnd=null;next.deferredCount=0;
        context.chatMetadata[POSTTURN_META_KEY]=JSON.parse(JSON.stringify(next));
        committed={stale:false,before,current,next,latest,flushedMessageIds,authority};
        return JSON.parse(JSON.stringify(next));
    });
    if(!committed||committed.stale===true)return {discarded:false,stale:true,reason:'backlog-authority-changed',expectedAuthority:expectedAuthority||null,currentAuthority:committed?.authority||postTurnBacklogAuthoritySnapshot({context}),pendingPreserved:true};
    const flushedMessageIds=new Set(committed.flushedMessageIds||[]),rejected=[];
    if(rejectPending){
        const pendingProposals=getProposals('pending').filter(row=>String(row?.source||'')==='post-turn'&&String(row?.origin?.chatId??'')===String(context?.chatId??''));
        for(const proposal of pendingProposals){
            const originId=String(proposal?.origin?.messageId||'');
            if(flushedMessageIds.size&&originId&&!flushedMessageIds.has(originId))continue;
            try{if(await rejectProposal(proposal.id,`Discarded with stale Post-turn lifecycle backlog (${reason}).`))rejected.push(proposal.id);}catch(error){logEvent('postturn','backlog-flush-proposal-reject-failed',{proposalId:proposal.id,error},'warn');}
        }
    }
    const result={discarded:true,reason,discardedPending:committed.before.pendingCount,oldProcessedThrough:committed.before.processedThrough,newProcessedThrough:Number(committed.next.processedThrough??committed.latest),rejectedProposalCount:rejected.length,rejectedProposalIds:rejected};
    logEvent('postturn','backlog-flushed',result,'warn');
    return result;
}

function entryList(data){
    if(Array.isArray(data?.entries))return data.entries;
    if(data?.entries&&typeof data.entries==='object')return Object.values(data.entries);
    return [];
}

async function buildLoreCatalog(books){
    const blocks=[];
    const failures=[];
    const authority={version:1,books:{}};
    const loaded=await Promise.allSettled(books.map(book=>loadBook(book)));
    for(let bookIndex=0;bookIndex<books.length;bookIndex+=1){
        const book=books[bookIndex],settled=loaded[bookIndex];
        try{
            if(settled.status!=='fulfilled')throw settled.reason;
            const tree=getTree(book);
            const data=settled.value;
            const entries=entryList(data).slice().sort((a,b)=>Number(a?.uid)-Number(b?.uid));
            const nodes=[];
            const uidNodes=new Map();
            const walk=(node,parentId=null,depth=0)=>{
                if(!node)return;
                const id=String(node.id||'').trim();
                const uids=(node.entryUids||[]).map(Number).filter(Number.isFinite).sort((a,b)=>a-b);
                nodes.push({id,label:String(node.label||''),parentId:parentId==null?null:String(parentId),depth,uids});
                for(const uid of uids){const rows=uidNodes.get(uid)||[];rows.push(id);uidNodes.set(uid,rows);}
                for(const child of node.children||[])walk(child,id,depth+1);
            };
            if(tree?.root)walk(tree.root,null,0);
            const canonicalEntries=entries.map(entry=>({
                uid:Number(entry?.uid),
                title:String(entry?.comment||''),
                content:String(entry?.content||''),
                constant:entry?.constant===true,
                disable:entry?.disable===true,
                nodeIds:[...(uidNodes.get(Number(entry?.uid))||[])].sort(),
            }));
            authority.books[book]={nodes:nodes.slice().sort((a,b)=>a.id.localeCompare(b.id)),entries:canonicalEntries};
            blocks.push(`Lorebook: ${book}`);
            blocks.push('TREE NODES');
            if(nodes.length){
                for(const node of nodes)blocks.push(`[NODE ${node.id}] ${cleanText(node.label)||'Unnamed'}${node.parentId?` | parent=${node.parentId}`:''}`);
            }else blocks.push('[NO TREE NODES]');
            blocks.push('CANONICAL ENTRIES');
            for(const entry of canonicalEntries){
                const nodeText=entry.nodeIds.length?entry.nodeIds.join(','):'UNLINKED';
                blocks.push(`[ENTRY UID ${entry.uid} NODE ${nodeText}]`);
                blocks.push(`TITLE: ${entry.title}`);
                blocks.push(`CONSTANT: ${entry.constant?'true':'false'} | DISABLED: ${entry.disable?'true':'false'}`);
                blocks.push('CONTENT:');
                blocks.push(entry.content);
                blocks.push(`[END ENTRY UID ${entry.uid}]`);
            }
            blocks.push('');
        }catch(error){
            failures.push({book,message:error?.message||String(error)});
            blocks.push(`Lorebook: ${book}`);
            blocks.push('  [catalog unavailable for this pass — no operations may target this lorebook]');
            blocks.push('');
            logEvent('postturn','catalog-book-failed',{book,error},'warn');
        }
    }
    const catalog=blocks.join('\n').trim();
    if(!catalog||failures.length===books.length){
        const err=new Error('Post-turn could not build a usable lore catalog from any active lorebook.');
        err.failures=failures;
        throw err;
    }
    return {catalog,failures,authority};
}

function catalogSemanticContract(catalogText,writableBooks,catalogRefs=[],{allowedOperationTypes=null}={}){
    const uidsByBook={},nodeIdsByBook={},replaceableUidsByBook={},completeUidsByBook={};
    let currentBook='';
    const ensure=book=>{if(!writableBooks.includes(book))return;uidsByBook[book]??=new Set();nodeIdsByBook[book]??=new Set();replaceableUidsByBook[book]??=new Set();completeUidsByBook[book]??=new Set();};
    for(const rawLine of String(catalogText||'').split('\n')){
        const line=rawLine.trim();
        const bookMatch=line.match(/^Lorebook:\s*(.+)$/);
        if(bookMatch){currentBook=bookMatch[1].trim();ensure(currentBook);continue;}
        if(!currentBook||!writableBooks.includes(currentBook))continue;
        const nodeMatch=line.match(/^\[NODE\s+([^\]]+)\]/);if(nodeMatch)nodeIdsByBook[currentBook].add(String(nodeMatch[1]).trim());
        const uidMatch=line.match(/^(?:\[ENTRY\s+UID\s+|\[UID\s+|-?\s*UID\s+)(\d+)/i);if(uidMatch)uidsByBook[currentBook].add(Number(uidMatch[1]));
    }
    for(const ref of catalogRefs||[]){
        const book=String(ref?.book||'').trim();const uid=asUid(ref?.uid);if(!book||uid===null||!writableBooks.includes(book))continue;
        ensure(book);uidsByBook[book].add(uid);
        if(ref?.complete===true){replaceableUidsByBook[book].add(uid);completeUidsByBook[book].add(uid);}
        if(ref?.nodeId)for(const id of String(ref.nodeId).split(',').map(x=>x.trim()).filter(Boolean))if(id!=='UNLINKED')nodeIdsByBook[book].add(id);
    }
    const shownBooks=Object.keys({...uidsByBook,...nodeIdsByBook});
    for(const book of shownBooks)ensure(book);
    const contract={writableBooks:shownBooks,uidsByBook,nodeIdsByBook,replaceableUidsByBook,completeUidsByBook,requireCandidateIds:true};
    if(Array.isArray(allowedOperationTypes))contract.allowedOperationTypes=[...allowedOperationTypes];
    return contract;
}

function buildPostTurnEvidencePrompt({sourceStart,targetIndex,chat,sourceIndices=[]}){
    const physical=[...new Set((sourceIndices||[]).map(Number).filter(Number.isInteger))].sort((a,b)=>a-b);
    const authority=physical.length?physical.join(', '):'(none — return an empty evidence array)';
    return `Extract only durable roleplay evidence from this physical source fragment. Do NOT propose lore mutations and do not infer facts not stated or strongly entailed. Preserve the immutable source index/message ID for every evidence item.\n\nGLOBAL PASS RANGE\n${sourceStart}-${targetIndex}\n\nPHYSICAL SOURCE AUTHORITY\n${authority}\nOnly the source indices listed in PHYSICAL SOURCE AUTHORITY may be cited by this request. Do not cite another index merely because it exists elsewhere in the global pass.\n\nSOURCE FRAGMENT\n${chat}\n\nReturn ONLY JSON: {"evidence":[{"kind":"fact|character|arc|world","statement":"concise durable evidence","source_indices":[123],"source_message_ids":["exact id when shown"]}],"reasoning":"short summary"}. Keep each statement concise. An empty evidence array is valid.`;
}

function buildPostTurnPrompt({catalog,writableBooks,sourceStart,targetIndex,chat='',evidence=''}){
    const sourceSection=evidence
        ? `SOURCE EVIDENCE MAP\n${evidence}\n\nThe evidence map was derived from the exact source range ${sourceStart}-${targetIndex}. Use it as the only source of new durable facts.`
        : `RECENT EXCHANGE THROUGH SOURCE END\n${chat}`;
    return `Review durable roleplay evidence against canonical lore and produce proposals only. Prefer updating existing information over creating tiny duplicates. Tree organization is allowed when useful. Never assume a recurring role/routine from assistant narration alone. Do not generate, rewrite, or append lorebook keywords/keys; Nexus preserves existing keywords as-is.\n\nPROPOSAL DISCIPLINE\n- Produce the SMALLEST set of durable mutations needed to preserve genuinely reusable canon; this is not a recap and completeness is not the goal.\n- One durable fact should normally have ONE canonical home. If several visible entries could carry the same evidence, choose the strongest existing target instead of spraying the fact across multiple UIDs.\n- Do not both update an existing entry and create a new event/scene entry for substantially the same evidence unless each target has clearly distinct long-term authority.\n- Create a new entry only when no visible existing entry is an appropriate canonical home and the material is likely to matter across future scenes.\n- Treat one-off scene texture, route descriptions, clock times, ordinary meals, room furnishings, transient positioning, and other ephemeral logistics as non-durable unless they establish a persistent constraint, commitment, relationship/state change, or reusable world fact.\n- Prefer consolidating several related facts into one justified append to the best target over generating many tiny proposals.\n- Historical/catch-up source ranges require MORE selectivity, not less: preserve major state/relationship/world changes and open durable threads; do not manufacture a lore card for every past beat.\n- An empty operations array is a correct result when canonical lore already covers the durable evidence.\n\nAVAILABLE LOREBOOKS / TREE NODES / EXACT CANONICAL ENTRIES\n${catalog}\n\nWRITABLE TARGETS\n${writableBooks.map(b=>`- ${b}`).join('\n')}\nOnly these lorebooks may be targeted by operations. Read-only books above are reference-only.\n\nSOURCE WINDOW\nMessages ${sourceStart}-${targetIndex} are the accumulated post-turn work for this pass. Do not treat later messages as source material.\n\n${sourceSection}\n\nAUTHORITY RULES\n- An entry mutation may target only an exact UID visible in THIS request.\n- Whole-entry replace/delete/split requires that UID's complete canonical content in THIS request.\n- Merge requires both exact UIDs and their complete canonical content to be co-visible in THIS request.\n- Never infer or reconstruct omitted continuation content.\n- If the required canonical authority is not fully visible, omit that operation; a later focused pass may handle it.\n\nSTRICT OUTPUT CONTRACT\nEvery operation MUST include "book" with an exact lorebook name shown above.\nEntry mutations MUST target exact lore UIDs shown above. Never put a Tree node ID in uid or target_id.\nTree mutations MUST target exact NODE IDs shown above.\nDo not invent temporary refs/parent_ref links between operations; a newly proposed category does not exist until the user approves it.\nUse these exact shapes:\n- remember/create/create_entry: {"type":"remember","book":"...","node_id":"existing NODE id or null","title":"...","content":"..."}\n- update/add durable material: {"type":"update","book":"...","uid":123,"mode":"append","content":"new durable material only"}\n- update/replace entire entry only when necessary: {"type":"update","book":"...","uid":123,"mode":"replace","content":"complete replacement entry text"}\n- delete: {"type":"delete","book":"...","uid":123,"reason":"..."}\n- merge: {"type":"merge","book":"...","keep_uid":123,"remove_uid":456,"content":"complete merged entry text"}\n- split: {"type":"split","book":"...","uid":123,"keep_content":"...","new_title":"...","new_content":"...","new_node_id":"existing NODE id or null"}\n- move_entry: {"type":"move_entry","book":"...","uid":123,"node_id":"NODE id"}\n- create_category: {"type":"create_category","book":"...","parent_node_id":"existing NODE id","label":"...","summary":"..."}\n- rename_category/move_category/delete_category: always include book and node_id.\nIf a new category and a new memory are both desirable, do not invent a future node ID. Either stage the category alone this pass or place the memory in the nearest appropriate EXISTING node.\n\nReturn ONLY JSON: {"operations":[...],"reasoning":"short summary"}. An empty operations array is valid.`;
}

function renderAutomaticCanonicalHomeCatalog(resolution,catalogAuthority,writableBooks){
    const cluster=resolution?.cluster||{};
    if(resolution?.disposition==='EXISTING_HOME'){
        const book=String(resolution?.candidate?.book||'').trim();
        const uid=asUid(resolution?.candidate?.uid);
        const bookAuthority=catalogAuthority?.books?.[book];
        const entry=bookAuthority?.entries?.find(row=>Number(row?.uid)===uid);
        if(!book||uid===null||!writableBooks.includes(book)||!entry)return null;
        const nodes=(bookAuthority?.nodes||[]).filter(node=>(entry.nodeIds||[]).includes(String(node.id)));
        const lines=[`Lorebook: ${book}`,'TREE NODES'];
        if(nodes.length)for(const node of nodes)lines.push(`[NODE ${node.id}] ${cleanText(node.label)||'Unnamed'}${node.parentId?` | parent=${node.parentId}`:''}`);
        else lines.push('[NO TREE NODES REQUIRED]');
        lines.push('CANONICAL ENTRIES',`[ENTRY UID ${entry.uid} NODE ${(entry.nodeIds||[]).length?(entry.nodeIds||[]).join(','):'UNLINKED'}]`,`TITLE: ${entry.title}`,`CONSTANT: ${entry.constant?'true':'false'} | DISABLED: ${entry.disable?'true':'false'}`,'CONTENT:',entry.content,`[END ENTRY UID ${entry.uid}]`);
        return {catalog:lines.join('\n'),catalogRefs:[{book,uid,complete:true,nodeId:(entry.nodeIds||[]).join(',')}],allowedOperationTypes:['update'],book,uid,cluster};
    }
    if(resolution?.disposition==='NEW_ENTRY'){
        if(writableBooks.length!==1)return null;
        const book=String(writableBooks[0]);
        return {catalog:`Lorebook: ${book}\nTREE NODES\n[NO NODE REQUIRED — remember may use node_id null]\nCANONICAL ENTRIES\n[NO EXISTING HOME SELECTED]`,catalogRefs:[],allowedOperationTypes:['remember'],book,uid:null,cluster};
    }
    return null;
}

function buildAutomaticCanonicalDraftPrompt({home,evidence,sourceStart,targetIndex}){
    const clusterEvidence=renderPostTurnEvidence(Array.isArray(evidence)?evidence:[]);
    if(home.uid!==null){
        return `Nexus AUTOMATIC DURABLE LORE DRAFT\n\nThe semantic admission and canonical-home stages are already complete. Draft only for the ONE resolved canonical home below. Do not choose another home and do not perform maintenance.\n\nRESOLVED CANONICAL HOME\n${home.catalog}\n\nEVIDENCE CLUSTER\n${clusterEvidence}\n\nSOURCE RANGE\n${sourceStart}-${targetIndex}\n\nAUTOMATIC AUTHORITY\n- Return either an empty operations array or exactly ONE update operation targeting book ${JSON.stringify(home.book)} UID ${home.uid}.\n- Allowed operation type: update only.\n- Use append for new durable material unless complete replacement is genuinely necessary.\n- Do not merge, split, delete, move entries, create/move/rename/delete categories, or create another entry.\n- Do not add facts outside the supplied evidence cluster.\n- If the existing entry already covers the meaning, return an empty operations array.\n\nReturn ONLY JSON: {"operations":[]|[{"type":"update","book":${JSON.stringify(home.book)},"uid":${home.uid},"mode":"append|replace","content":"durable material"}],"reasoning":"short explanation"}.`;
    }
    return `Nexus AUTOMATIC DURABLE LORE DRAFT\n\nThe semantic admission and canonical-home stages are already complete. Jev found no appropriate existing canonical home for this ONE durable evidence cluster. Draft at most one new entry; do not perform maintenance.\n\nWRITABLE LOREBOOK\n${home.catalog}\n\nEVIDENCE CLUSTER\n${clusterEvidence}\n\nSOURCE RANGE\n${sourceStart}-${targetIndex}\n\nAUTOMATIC AUTHORITY\n- Return either an empty operations array or exactly ONE remember operation in book ${JSON.stringify(home.book)}.\n- Allowed operation type: remember only.\n- node_id must be null in this automatic pass; structural placement/cleanup remains Housekeeper/Merge/manual authority.\n- Do not update another UID, merge, split, delete, move entries, or alter categories.\n- Create only if this cluster is genuinely reusable persistent canon.\n\nReturn ONLY JSON: {"operations":[]|[{"type":"remember","book":${JSON.stringify(home.book)},"node_id":null,"title":"specific durable title","content":"durable canon"}],"reasoning":"short explanation"}.`;
}

function buildPostTurnRelationalMergePrompt({catalog,evidence,sourceStart,targetIndex,pair}){
    return `Perform a focused duplicate/overlap review for exactly TWO canonical lore entries that could not be co-visible in the ordinary physical catalog slices. This pass exists only to recover cross-slice relational authority safely.\n\nFOCUSED CANONICAL PAIR\n${catalog}\n\nSOURCE EVIDENCE MAP\n${evidence}\n\nSOURCE RANGE OF AUTHORITY\n${sourceStart}-${targetIndex}\n\nRULES\n- Return either an empty operations array or ONE merge operation.\n- Merge only if the two entries are genuinely duplicate/overlapping enough that one canonical entry should absorb the other.\n- Both UIDs and their complete canonical contents are visible above; do not target any other UID.\n- Preserve every unique fact from both entries in the merged content.\n- The evidence map may add only facts traceable to the stated source range.\n- Do not update, replace, delete, split, move, create, or alter Tree categories in this focused pass.\n- Do not generate or modify lorebook keywords/keys.\n- Candidate reason: ${String(pair?.reasons||[]).replace(/\n/g,' ')}.\n\nReturn ONLY JSON: {"operations":[]|[{"type":"merge","book":"${pair?.book||''}","keep_uid":${Number(pair?.leftUid)||0},"remove_uid":${Number(pair?.rightUid)||0},"content":"complete merged entry text"}],"reasoning":"short decision"}.`;
}

function inferBook(op,books){
    const explicit=String(op?.book||'').trim();
    if(explicit)return explicit;
    if(books.length===1)return books[0];
    throw new Error('Post-turn operation omitted book while multiple lorebooks are active.');
}

function resolveUid(book,op){
    const direct=asUid(op?.uid ?? op?.target_uid ?? op?.keep_uid ?? op?.remove_uid);
    if(direct!==null)return direct;
    const target=op?.target_id ?? op?.targetId;
    const numeric=asUid(target);
    if(numeric!==null)return numeric;
    if(target){
        const tree=getTree(book);
        const node=tree?.root?findNode(tree.root,String(target)):null;
        if(node){
            const directUids=(node.entryUids||[]).map(Number).filter(Number.isFinite);
            if(directUids.length===1)return directUids[0];
            throw new Error(`target_id ${target} is a Tree node with ${directUids.length} direct entries. Post-turn updates must name an exact lore UID.`);
        }
    }
    return null;
}

function buildLegacyRefMap(ops,books){
    const map=new Map();
    for(const op of ops||[]){
        if(op?.type!=='create_category'||!op?.ref)continue;
        try{
            map.set(String(op.ref),{
                book:inferBook(op,books),
                parentNodeId:op.parent_node_id||op.parent_id||null,
                label:op.label||op.name||'',
            });
        }catch{}
    }
    return map;
}

async function stage(op, reasoning, model, books, legacyRefs, sourceMeta={}){
    const book=inferBook(op,books);
    const meta={source:'post-turn',reasoning,model,...sourceMeta};
    switch(op.type){
        case'remember':
        case'create':
        case'create_entry':{
            // v0.3.2 sometimes produced parent_ref links to a category proposed in
            // the same batch. Proposal IDs are not Tree node IDs, so we safely
            // fall back to that category's existing parent rather than inventing a
            // hidden cross-proposal mutation dependency.
            let targetNodeId=op.node_id||op.target_node_id||null;
            if(!targetNodeId&&op.parent_ref&&legacyRefs?.has(String(op.parent_ref))){
                const ref=legacyRefs.get(String(op.parent_ref));
                if(ref.book===book){
                    targetNodeId=ref.parentNodeId||null;
                    meta.note=`Requested temporary parent_ref ${op.parent_ref}; staged under existing parent because proposed categories do not exist until approval.`;
                }
            }
            return proposeCreate(book,{title:op.title||op.comment||'',content:op.content||'',targetNodeId},meta);
        }
        case'update':{
            const uid=resolveUid(book,op);
            if(uid===null)throw new Error('update requires an exact lore UID.');
            const patch={};for(const k of ['title','constant','disable'])if(op[k]!==undefined)patch[k]=op[k];
            if(op.content!==undefined){
                const mode=String(op.mode||op.update_mode||'replace').toLowerCase();
                if(['append','add','additive','merge'].includes(mode)){
                    const data=await loadBook(book);
                    const existing=findEntryByUid(data.entries,uid);
                    if(!existing)throw new Error(`UID ${uid} not found in "${book}".`);
                    meta.expectedEntry=entryBaselineFromEntry(uid,existing);
                    patch.content=`${String(existing.content||'').trim()}

${String(op.content||'').trim()}`.trim();
                    meta.note=[meta.note,`Post-turn ${mode} update expanded deterministically against current UID ${uid} content.`].filter(Boolean).join(' ');
                }else patch.content=op.content;
            }
            if(op.node_id!==undefined||op.target_node_id!==undefined)patch.targetNodeId=op.node_id??op.target_node_id;
            const expectedEntry=meta.expectedEntry;delete meta.expectedEntry;return proposeUpdate(book,uid,patch,meta,expectedEntry?{expectedEntry}:{});
        }
        case'delete':{
            const uid=resolveUid(book,op);if(uid===null)throw new Error('delete requires an exact lore UID.');
            return proposeDelete(book,uid,{hardDelete:op.hard_delete===true,reason:op.reason||''},meta);
        }
        case'merge':{
            const keep=asUid(op.keep_uid),remove=asUid(op.remove_uid);if(keep===null||remove===null)throw new Error('merge requires keep_uid and remove_uid.');
            return proposeMerge(book,keep,remove,{title:op.title,content:op.content,hardDelete:op.hard_delete===true,treePolicy:op.tree_policy||'keep',targetNodeId:op.node_id||null},meta);
        }
        case'split':{
            const uid=asUid(op.uid);if(uid===null)throw new Error('split requires an exact lore UID.');
            return proposeSplit(book,uid,{keepTitle:op.keep_title,keepContent:op.keep_content,newTitle:op.new_title,newContent:op.new_content,newTargetNodeId:op.new_node_id||null},meta);
        }
        case'move_entry':{
            const uid=asUid(op.uid);if(uid===null)throw new Error('move_entry requires an exact lore UID.');
            return proposeMoveEntry(book,uid,op.node_id||op.target_node_id,meta);
        }
        case'create_category':return proposeCreateCategory(book,{label:op.label||op.name||'',summary:op.summary||'',parentNodeId:op.parent_node_id||op.parent_id||null},meta);
        case'rename_category':return proposeRenameCategory(book,op.node_id||op.target_id,{label:op.label||op.name,summary:op.summary},meta);
        case'move_category':return proposeMoveCategory(book,op.node_id||op.target_id,op.parent_node_id||op.parent_id,meta);
        case'delete_category':return proposeDeleteCategory(book,op.node_id||op.target_id,{mode:op.mode||'promote_children'},meta);
        default:return null;
    }
}


async function persistPrunedPostTurnBacklog(context,{reason='maintenance'}={}){
    if(!context?.chatMetadata)return backlogStore(context);
    return await mutateChatMetadataDurably(context,'Post-turn backlog maintenance',{keys:[POSTTURN_META_KEY]},()=>{
        const rebuilt=materializeRecoveredPendingMessageIds(backlogStore(context),{chat:context?.chat||[],chatId:context?.chatId||'',ensureMessageId});
        const next=JSON.parse(JSON.stringify(rebuilt.state));
        const identity=reconcilePendingMessageIds(next,context);
        const invalid=new Set([...identity.missing.map(String),...identity.ineligible.map(row=>String(row.id))]);
        if(invalid.size)next.pendingMessageIds=(next.pendingMessageIds||[]).filter(id=>!invalid.has(String(id)));
        const remaining=reconcilePendingMessageIds(next,context);
        next.pendingStart=remaining.start;next.pendingEnd=remaining.end;
        if(!next.pendingMessageIds.length)next.deferredCount=0;
        context.chatMetadata[POSTTURN_META_KEY]=next;
        logEvent('postturn','backlog-maintenance-committed',{reason,removedCount:invalid.size,missingCount:identity.missing.length,ineligibleCount:identity.ineligible.length,pendingMessageCount:next.pendingMessageIds.length},invalid.size?'warn':'debug');
        return JSON.parse(JSON.stringify(next));
    });
}


export async function reconcilePostTurnBacklogAuthority({context=getContext(),reason='director-admission'}={}){
    if(!context?.chatMetadata)return backlogStore(context);
    return await persistPrunedPostTurnBacklog(context,{reason});
}

async function drainPostTurnInternal({force=false,enqueueSidecar=null,directorMeta=null,evaluatedSourceRange=null,evaluatedSourceAuthority=null,automaticAuthority=null}={},drainLease=null){
    const context=getContext();
    const scope=captureNexusWorkScope(context);
    const evaluatedAuthorityRange=Array.isArray(evaluatedSourceRange)?evaluatedSourceRange.slice(0,2).map(Number):null;
    const hasEvaluatedSourceAuthority=!!(evaluatedSourceAuthority&&evaluatedAuthorityRange&&evaluatedAuthorityRange.length===2&&evaluatedAuthorityRange.every(Number.isInteger));
    const evaluatedSourceFresh=()=>{
        const live=getContext();
        // Automatic Lifecycle Intelligence owns an exact admitted source prefix.
        // A later generation is a new suffix, not a mutation of that source.
        // Keep chat/epoch invalidation fail-closed while deliberately ignoring
        // unrelated whole-chat revision growth after semantic admission.
        if(!isNexusWorkScopeFresh(scope,live,{checkRevision:false}))return false;
        const current=postTurnEvaluationAuthoritySnapshot({context:live,sourceStart:evaluatedAuthorityRange[0],targetIndex:evaluatedAuthorityRange[1]});
        return postTurnEvaluationAuthorityMatches(evaluatedSourceAuthority,current);
    };
    const stale=()=>hasEvaluatedSourceAuthority?!evaluatedSourceFresh():!isNexusWorkScopeFresh(scope,getContext());
    const staleResult=(stage='drain')=>({deferred:true,stale:true,reason:hasEvaluatedSourceAuthority?'evaluated-source-invalidated':'scope-invalidated',stage,scope,expectedAuthority:hasEvaluatedSourceAuthority?evaluatedSourceAuthority:null});
    const settings=getSettings();
    const recoveryResults=await reconcilePostTurnParentSagas(context).catch(error=>[{state:'recovery-required',reason:'parent-saga-reconcile-failed',error:error?.message||String(error)}]);
    const blockingRecovery=recoveryResults.filter(row=>row?.state==='recovery-required');
    if(blockingRecovery.length){
        const expectedFenceDeferral=blockingRecovery.every(row=>row?.reason==='backlog-state-diverged'&&row?.sourceProof?.reason==='current-fence-before-post');
        if(expectedFenceDeferral)logEvent('postturn','parent-recovery-deferred',{recoveryResults:blockingRecovery,reason:'historical-parent-fence-not-yet-caught-up'},'info');
        else logEvent('postturn','parent-recovery-failed',{recoveryResults:blockingRecovery},'error');
        return {deferred:true,reason:'parent-recovery-required',recoveryResults:blockingRecovery};
    }
    const newlyQuarantined=recoveryResults.filter(row=>row?.state==='quarantined'&&row?.newlyQuarantined===true);
    if(newlyQuarantined.length)logEvent('postturn','parent-recovery-quarantined',{count:newlyQuarantined.length,recoveryResults:newlyQuarantined},'warn');
    const rebuilt=materializeRecoveredPendingMessageIds(backlogStore(context),{chat:context?.chat||[],chatId:context?.chatId||'',ensureMessageId});
    if(rebuilt.reconstructed)logEvent('postturn','backlog-reconstructed',{recoveredIndices:rebuilt.recoveredIndices,pendingMessageCount:rebuilt.state.pendingMessageIds.length,processedThrough:rebuilt.state.processedThrough},'info');
    const pending=JSON.parse(JSON.stringify(rebuilt.state));
    const quarantinedIds=new Set(getQuarantinedPostTurnMessageIds({context}));
    if(quarantinedIds.size){
        const before=pending.pendingMessageIds.length;
        pending.pendingMessageIds=(pending.pendingMessageIds||[]).filter(id=>!quarantinedIds.has(String(id)));
        if(before!==pending.pendingMessageIds.length)logEvent('postturn','quarantined-source-skipped',{quarantinedCount:before-pending.pendingMessageIds.length,pendingPreserved:true},'debug');
    }
    if(!settings.enabled||!settings.postTurn.enabled){
        logEvent('postturn','skipped',{enabled:settings.enabled,postTurnEnabled:settings.postTurn.enabled,...pending,force},'debug');
        return {skipped:true,reason:'disabled'};
    }
    const chatNow=context?.chat||[];
    if(pending.pendingEnd===null&&!force){
        logEvent('postturn','skipped',{enabled:settings.enabled,postTurnEnabled:settings.postTurn.enabled,...pending,force,reason:'nothing-pending'},'debug');
        return {skipped:true,reason:'nothing-pending'};
    }
    if(!chatNow.length){
        logEvent('postturn','skipped',{force,reason:'no-chat'},'debug');
        return {skipped:true,reason:'no-chat'};
    }
    let pendingIdentity=reconcilePendingMessageIds(pending,context);
    let prunedPendingAuthority=false;
    if(pendingIdentity.missing.length){
        // Missing durable IDs do not permanently poison the queue. The modern
        // reconstructible range has already assigned IDs to visible eligible
        // messages. Orphans are pruned from this candidate backlog; if the chat
        // is only partially hydrated, the completion fence/fingerprints remain
        // durable and will reconstruct the omitted work when it becomes visible.
        pending.pendingMessageIds=(pending.pendingMessageIds||[]).filter(id=>!pendingIdentity.missing.includes(String(id)));
        prunedPendingAuthority=true;
        logEvent('postturn','backlog-orphan-ids-pruned',{missingMessageIds:pendingIdentity.missing,pendingPreserved:true},'warn');
        pendingIdentity=reconcilePendingMessageIds(pending,context);
    }
    if(pendingIdentity.ineligible.length){
        const skipped=new Set(pendingIdentity.ineligible.map(row=>String(row.id)));pending.pendingMessageIds=(pending.pendingMessageIds||[]).filter(id=>!skipped.has(String(id)));
        prunedPendingAuthority=true;
        pendingIdentity=reconcilePendingMessageIds(pending,context);
        logEvent('postturn','backlog-ineligible-pruned',{count:skipped.size,ids:[...skipped]},'info');
    }
    if(force&&!pendingIdentity.indices.length){
        let idx=-1;for(let i=chatNow.length-1;i>=0;i-=1){if(isPostTurnEligibleMessage(chatNow[i])){idx=i;break;}}
        if(idx<0)return {skipped:true,reason:'no-eligible-assistant-turn'};
        const id=ensureMessageId(chatNow[idx],idx);pendingIdentity={ids:id?[id]:[],eligibleIds:id?[id]:[],missing:[],ineligible:[],indices:[idx],start:idx,end:idx};
    }
    const softTargetTokens=Math.max(2000,Number(settings.postTurn.softPackingTargetTokens)||16000);
    const evaluatedRange=evaluatedAuthorityRange;
    const planningIndices=evaluatedRange&&evaluatedRange.length===2&&evaluatedRange.every(Number.isInteger)
        ? pendingIdentity.indices.filter(index=>index>=evaluatedRange[0]&&index<=evaluatedRange[1])
        : pendingIdentity.indices;
    const catchupPlan=planPostTurnCatchupWindow({
        pendingIndices:planningIndices,
        chat:chatNow,
        softTargetTokens,
        contextMessages:settings.postTurn.contextMessages||10,
        estimateTokens:text=>estimateContentTokens(text),
    });
    const targetIndex=catchupPlan.targetIndex;
    const sourceStart=catchupPlan.sourceStart;
    if(!Number.isInteger(targetIndex)||!Number.isInteger(sourceStart)){
        if(prunedPendingAuthority||(pendingIdentity.missing?.length||0)||(pendingIdentity.ineligible?.length||0)||(pending.pendingMessageIds||[]).length){
            try{await persistPrunedPostTurnBacklog(context,{reason:'no-eligible-pending-source'});}catch(error){logEvent('postturn','backlog-maintenance-failed',{error,pendingPreserved:true},'error');return {deferred:true,reason:'backlog-maintenance-durability-failed',error:error?.message||String(error)};}
        }
        return {skipped:true,reason:'nothing-pending'};
    }
    const sourceRange=[sourceStart,targetIndex];
    if(evaluatedRange&&evaluatedRange.length===2&&(sourceRange[0]!==evaluatedRange[0]||sourceRange[1]!==evaluatedRange[1])){
        const result={deferred:true,stale:true,reason:'evaluated-window-replanned',expectedSourceRange:evaluatedRange,currentSourceRange:sourceRange,pendingPreserved:true};
        logEvent('postturn','evaluated-worker-replan-stale',result,'info');
        return result;
    }
    const consumedIndexSet=new Set(catchupPlan.consumedPendingIndices||[]);
    const consumedPendingIds=[];
    for(const id of pendingIdentity.eligibleIds||pendingIdentity.ids||[]){
        const index=(chatNow||[]).findIndex(message=>String(message?.extra?.tv2_message_id||'')===String(id));
        if(consumedIndexSet.has(index))consumedPendingIds.push(String(id));
    }
    logEvent('postturn','catchup-window-planned',{targetIndex,sourceRange,pendingCount:pendingIdentity.indices.length,consumedPendingCount:catchupPlan.consumedPendingIndices.length,remainingPendingCount:catchupPlan.remainingPendingIndices.length,estimatedSourceTokens:catchupPlan.estimatedSourceTokens,softTargetTokens:catchupPlan.softTargetTokens,budgetLimited:catchupPlan.budgetLimited},catchupPlan.budgetLimited?'info':'debug');
    if(force&&pending.pendingEnd===null)logEvent('postturn','manual-force',{targetIndex,sourceRange,messageIds:consumedPendingIds},'info');
    const readableCorpus=captureLoreCorpus({purpose:'story',requireTree:false,access:'read',injection:'any',context});
    const writableCorpus=captureLoreCorpus({purpose:'story',requireTree:false,access:'write',injection:'any',context});
    const readableBooks=[...readableCorpus.books];
    const writableBooks=[...writableCorpus.books];
    logEvent('postturn','lore-corpus-captured',{readBooks:[...readableBooks],writeBooks:[...writableBooks],readFingerprint:readableCorpus.fingerprint,writeFingerprint:writableCorpus.fingerprint},'debug');
    if(!writableBooks.length){
        logEvent('postturn','skipped',{reason:'no-writable-books',targetIndex},'debug');
        return {skipped:true,reason:'no-writable-books'};
    }
    const catalogBooks=[...new Set([...readableBooks,...writableBooks])];
    const books=writableBooks;
    let catalogResult;
    try{catalogResult=await buildLoreCatalog(catalogBooks);}
    catch(error){
        logEvent('postturn','catalog-build-failed',{targetIndex,books,error,pendingPreserved:true},'error');
        return {failed:true,stage:'catalog',error:error?.message||String(error)};
    }
    if(stale())return staleResult('catalog');
    const catalog=catalogResult.catalog;
    const catalogFailures=catalogResult.failures||[];
    const failedCatalogBooks=new Set(catalogFailures.map(row=>String(row.book||'')));
    const effectiveWritableBooks=writableBooks.filter(book=>!failedCatalogBooks.has(String(book)));
    if(!effectiveWritableBooks.length){logEvent('postturn','catalog-no-writable-targets',{targetIndex,catalogFailures,pendingPreserved:true},'error');return {failed:true,stage:'catalog',error:'No writable lorebook has a usable catalog for this pass.'};}
    const chat=recentChatForRange(sourceStart,targetIndex,settings.postTurn.contextMessages||10,context);
    // Begin the parent transaction before physical reshaping/model work and bind
    // it to the exact canonical lore/Tree authority analyzed by this pass.
    const initialAssumptions=postTurnAssumptionsSnapshot(sourceRange,effectiveWritableBooks,context,catalogResult.authority);
    const transaction=beginPostTurnProposalTransaction({
        ...initialAssumptions,
        metadata:{source:'post-turn',director:directorMeta||null},
    });
    let reshape=null,logicalJob=null,response=null,parsed=null,logicalDegraded=false;
    let transactionId=transaction.id;
    let parentSagaStarted=false;
    const staged=[];
    const directWriteIds=[];
    const proposalStoreRef=captureProposalStore(true);
    const rollbackPostTurn=async(reason)=>{
        const rollbackFailures=[];
        const physicallySettledProposals=new Set();
        for(const writeId of [...directWriteIds].reverse()){
            try{const row=await rollbackDirectWrite(writeId,{context,expectedParentTransactionId:transactionId,idempotent:true,allowUnresolvedParent:true,source:'post-turn-parent-rollback',actor:'system-recovery'});if(row?.proposalId)physicallySettledProposals.add(String(row.proposalId));}
            catch(error){rollbackFailures.push({kind:'direct-write',writeId,message:error?.message||String(error),name:error?.name||'Error'});}
        }
        for(const proposalId of staged){
            try{const settlement=await settleProposalForParentRollback(proposalId,{parentTransactionId:transactionId,reason:reason||'Parent post-turn transaction did not commit atomically.',ref:proposalStoreRef,physicalRollbackProven:physicallySettledProposals.has(String(proposalId))});if(settlement?.recoveryRequired)rollbackFailures.push({kind:'proposal',proposalId,message:settlement.reason||'Proposal requires recovery.',status:settlement.status||null});}
            catch(error){rollbackFailures.push({kind:'proposal',proposalId,message:error?.message||String(error),name:error?.name||'Error'});}
        }
        if(transactionId){try{await resolvePostTurnParentSaga(transactionId,rollbackFailures.length?'recovery-required':'rolled-back',{context,error:rollbackFailures.length?JSON.stringify(rollbackFailures):''});}catch(error){rollbackFailures.push({kind:'parent-saga-settlement',message:error?.message||String(error)});}}
        return rollbackFailures;
    };
    const throwIfStale=(stage)=>{
        if(!stale())return;
        const error=new Error(`Post-turn scope invalidated during ${stage}.`);
        error.name='TV2ScopeInvalidated';error.tv2Stage=stage;throw error;
    };
    try{
        const baseBuildPrompt=(catalogSlice,chatSlice)=>buildPostTurnPrompt({catalog:catalogSlice,writableBooks:effectiveWritableBooks,sourceStart,targetIndex,chat:chatSlice});
        const buildSourcePrompt=(_catalogSlice,chatSlice)=>buildPostTurnEvidencePrompt({sourceStart,targetIndex,chat:chatSlice});
        const emptyEvidence=renderPostTurnEvidence([]);
        const buildCatalogSizingPrompt=(catalogSlice,_chatSlice)=>buildPostTurnPrompt({catalog:catalogSlice,writableBooks:effectiveWritableBooks,sourceStart,targetIndex,evidence:emptyEvidence});
        const sourceMapTargetTokens=Math.max(1200,Math.min(softTargetTokens,Math.floor(Number(settings.postTurn.sourceMapPackingTargetTokens)||softTargetTokens*0.35)));
        reshape=packPostTurnCatalogSlices({catalog,chat,buildPrompt:baseBuildPrompt,buildSourcePrompt,buildCatalogPrompt:buildCatalogSizingPrompt,softTargetTokens,sourceMapTargetTokens});
        logEvent('postturn','prompt-prepared',{targetIndex,sourceRange,books,writableBooks:effectiveWritableBooks,readableBooks,catalogChars:catalog.length,catalogBookFailures:catalogFailures,chatChars:chat.length,promptChars:baseBuildPrompt(catalog,chat).length,contextMessages:settings.postTurn.contextMessages||10,timeoutMs:settings.postTurn.timeoutMs||240000,reshapeMode:reshape.mode,reshapeStrategy:reshape.strategy||'direct',softTargetTokens,sourceMapTargetTokens:reshape.sourceMapTargetTokens||sourceMapTargetTokens,fullEstimatedInputTokens:reshape.fullEstimatedInputTokens,sliceCount:reshape.slices.length,sourceSliceCount:reshape.sourceSlices?.length||0,catalogSliceCount:reshape.catalogSlices?.length||1,requestUpperBound:reshape.requestUpperBound||reshape.slices.length,sliceEstimatedInputTokens:reshape.slices.map(slice=>slice.estimatedInputTokens),sourcePreserved:reshape.sourcePreserved===true,chatSliceCount:reshape.chatSliceCount||1},reshape.mode==='single'?'debug':'info');

        const mutationRequestForSlice=(slice,index,evidenceText='',{allowedOperationTypes=null,promptOverride=null,labelOverride=null,dedupSuffix='mutation'}={})=>{
            const catalogForPrompt=slice?.promptCatalog??slice?.catalog??'';
            const chatForPrompt=evidenceText?'':(slice?.promptChat??slice?.chat??'');
            const contract=catalogSemanticContract(catalogForPrompt,effectiveWritableBooks,slice?.catalogRefs||[],{allowedOperationTypes});
            const structuredValidator=value=>validateMutationEnvelope(value,contract);
            const prompt=typeof promptOverride==='function'?promptOverride({catalog:catalogForPrompt,chat:chatForPrompt,evidence:evidenceText,contract}):buildPostTurnPrompt({catalog:catalogForPrompt,writableBooks:effectiveWritableBooks,sourceStart,targetIndex,chat:chatForPrompt,evidence:evidenceText});
            const estimatedInputTokens=estimateContentTokens(prompt);
            if(estimatedInputTokens>softTargetTokens){const error=new Error(`Post-turn mutation slice exceeded physical packing target after evidence injection (${estimatedInputTokens}/${softTargetTokens}).`);error.name='NexusPhysicalPackingError';throw error;}
            return structuredSidecarOptions({
                prompt,
                systemPrompt:'You are the Nexus post-turn memory analyst. You may propose changes but cannot mutate lore. Follow the exact proposal schema and return JSON only.',
                reasoningEffort:'max',timeoutMs:Number(settings.postTurn.timeoutMs)||240000,priority:BUS_PRIORITY.POST_TURN,preemptible:true,maxAttempts:1,
                dedupKey:force?null:`postturn:${targetIndex}:${dedupSuffix}:${index}`,
                label:labelOverride||(reshape?.mode==='single'?'Post-turn extraction':`Post-turn mutation planning · slice ${index+1}`),
                structuredValidator,synthesisCandidateParser:text=>parse(text,structuredValidator),
                telemetry:{...(directorMeta||{}),nexusInternalWorker:!!directorMeta,postTurnLogicalJob:true,postTurnReshapeMode:reshape?.mode||'single',postTurnReshapeStrategy:reshape?.strategy||'direct',postTurnPhase:'mutation',postTurnSlice:index,postTurnSoftTargetTokens:softTargetTokens,estimatedInputTokens},
            });
        };


        const runAutomaticCanonicalPlanning=async()=>{
            let evidence=[];
            if(reshape.mode==='single'){
                const rows=sourceMessagesForRange(sourceStart,targetIndex,context);
                const contract={sourceIndices:new Set(rows.map(row=>Number(row.index)).filter(Number.isInteger)),sourceMessageIds:new Set(rows.map(row=>String(row.messageId||'')).filter(Boolean))};
                const structuredValidator=value=>validatePostTurnEvidenceEnvelope(value,contract);
                const request=structuredSidecarOptions({
                    prompt:buildPostTurnEvidencePrompt({sourceStart,targetIndex,chat,sourceIndices:[...contract.sourceIndices]}),
                    systemPrompt:'You are the Nexus Post-turn source-evidence mapper. Extract durable evidence only; never propose or mutate lore. Return JSON only.',
                    reasoningEffort:'max',timeoutMs:Number(settings.postTurn.timeoutMs)||240000,priority:BUS_PRIORITY.POST_TURN,preemptible:true,maxAttempts:1,
                    dedupKey:force?null:`postturn:${targetIndex}:automatic-source-map`,label:'Post-turn automatic source map',structuredValidator,synthesisCandidateParser:text=>parse(text,structuredValidator),
                    telemetry:{...(directorMeta||{}),nexusInternalWorker:!!directorMeta,postTurnLogicalJob:true,postTurnReshapeMode:'single',postTurnReshapeStrategy:'automatic-canonical-home',postTurnPhase:'source-map',postTurnSoftTargetTokens:softTargetTokens},
                });
                const rowsOut=await executePostTurnRequests([request],{enqueueSidecar,maxConcurrent:1,label:'Post-turn automatic source map'});
                const payload=parse(rowsOut[0]?.structuredPayload??rowsOut[0]?.text,structuredValidator);response=response||rowsOut[0];logicalDegraded=logicalDegraded||rowsOut[0]?.tv2?.multi?.degraded===true;evidence=mergePostTurnEvidence([payload]);
            }else{
                const allSourceSlices=reshape.sourceSlices||reshape.slices.filter(slice=>slice.phase==='source-map');
                const sourceSlices=allSourceSlices.filter(slice=>evidenceContractForSlice(slice,sourceStart,targetIndex).sourceIndices.size>0);
                const sourceRequests=sourceSlices.map((slice,index)=>{
                    const contract=evidenceContractForSlice(slice,sourceStart,targetIndex);
                    const structuredValidator=value=>validatePostTurnEvidenceEnvelope(value,contract);
                    return structuredSidecarOptions({prompt:buildPostTurnEvidencePrompt({sourceStart,targetIndex,chat:slice.promptChat||slice.chat||'',sourceIndices:[...contract.sourceIndices]}),systemPrompt:'You are the Nexus Post-turn source-evidence mapper. Extract evidence only; never propose or mutate lore. Return JSON only.',reasoningEffort:'max',timeoutMs:Number(settings.postTurn.timeoutMs)||240000,priority:BUS_PRIORITY.POST_TURN,preemptible:true,maxAttempts:1,dedupKey:force?null:`postturn:${targetIndex}:automatic-source-map:${index}`,label:`Post-turn automatic source map · ${index+1}/${sourceSlices.length}`,structuredValidator,synthesisCandidateParser:text=>parse(text,structuredValidator),telemetry:{...(directorMeta||{}),nexusInternalWorker:!!directorMeta,postTurnLogicalJob:true,postTurnReshapeMode:reshape.mode,postTurnReshapeStrategy:'automatic-canonical-home',postTurnPhase:'source-map',postTurnSlice:index,postTurnSliceCount:sourceSlices.length}});
                });
                const sourceResponses=await executePostTurnRequests(sourceRequests,{enqueueSidecar,maxConcurrent:6,label:'Post-turn automatic source map'});
                const payloads=sourceResponses.map((row,index)=>{response=response||row;logicalDegraded=logicalDegraded||row?.tv2?.multi?.degraded===true;return parse(row?.structuredPayload??row?.text,sourceRequests[index].structuredValidator);});
                evidence=mergePostTurnEvidence(payloads);
            }
            let evidenceText=renderPostTurnEvidence(evidence);
            const evidenceBudget=Math.max(1600,Math.floor(softTargetTokens*0.45));
            const reductionGroupTarget=Math.max(2200,Math.min(evidenceBudget,Math.floor(softTargetTokens*0.35)));
            let evidenceTokens=estimateContentTokens(evidenceText);
            for(let round=0;evidenceTokens>evidenceBudget&&round<2;round++){
                const groups=packEvidenceGroups(evidence,reductionGroupTarget);
                const reductionRequests=groups.map((group,index)=>{
                    const contract=reductionEvidenceContract(group);const structuredValidator=value=>validatePostTurnEvidenceEnvelope(value,contract);
                    return structuredSidecarOptions({prompt:buildEvidenceReductionPrompt(group),systemPrompt:'You are the Nexus Post-turn evidence reducer. Merge semantic duplicates without inventing or dropping distinct durable evidence. Preserve source attribution and return JSON only.',reasoningEffort:'max',timeoutMs:Number(settings.postTurn.timeoutMs)||240000,priority:BUS_PRIORITY.POST_TURN,preemptible:true,maxAttempts:1,dedupKey:force?null:`postturn:${targetIndex}:automatic-evidence-reduce:${round}:${index}`,label:`Post-turn automatic evidence reduce · round ${round+1} · ${index+1}/${groups.length}`,structuredValidator,synthesisCandidateParser:text=>parse(text,structuredValidator),telemetry:{...(directorMeta||{}),nexusInternalWorker:!!directorMeta,postTurnLogicalJob:true,postTurnReshapeStrategy:'automatic-canonical-home',postTurnPhase:'evidence-reduce',postTurnRound:round,postTurnSlice:index}});
                });
                const reduced=await executePostTurnRequests(reductionRequests,{enqueueSidecar,maxConcurrent:2,label:'Post-turn automatic evidence reduction'});
                const nextEvidence=mergePostTurnEvidence(reduced.map((row,index)=>parse(row?.structuredPayload??row?.text,reductionRequests[index].structuredValidator)));
                const nextText=renderPostTurnEvidence(nextEvidence),nextTokens=estimateContentTokens(nextText);
                if(nextTokens>=evidenceTokens&&nextEvidence.length>=evidence.length)break;
                evidence=nextEvidence;evidenceText=nextText;evidenceTokens=nextTokens;
            }
            if(evidenceTokens>evidenceBudget){const error=new Error(`Post-turn automatic evidence remains above bounded planning budget (${evidenceTokens}/${evidenceBudget}); source backlog preserved.`);error.name='NexusPostTurnEvidenceReductionError';throw error;}
            if(!evidence.length)return {operations:[],reasoning:'No durable post-turn evidence extracted from the authoritative source range.',evidence};

            const homePlan=await resolveCanonicalHomePlan({
                clusters:evidence,books:effectiveWritableBooks,chatId:scope.chatId,sourceKind:'post-turn',sourceRange:[...sourceRange],
                policy:{allowedOperationTypes:['remember','update'],structuralMaintenanceForbidden:true},
                readCurrentSourceFingerprint:()=>!stale(),
            });
            if(!homePlan?.handled){const error=new Error(`Post-turn canonical-home resolution unavailable: ${homePlan?.reason||'unknown'}.`);error.name='NexusCanonicalHomeDecisionError';throw error;}
            logEvent('postturn','canonical-home-resolved',{targetIndex,sourceRange,clusterCount:evidence.length,resolutions:homePlan.resolutions.map(row=>({clusterId:row.clusterId,disposition:row.disposition,book:row.candidate?.book||null,uid:row.candidate?.uid??null,confidence:row.confidence??null}))},'info');

            const groups=new Map();
            for(const resolution of homePlan.resolutions){
                if(resolution.disposition==='NO_MUTATION')continue;
                const key=resolution.disposition==='EXISTING_HOME'?`existing:${resolution.candidate?.book}:${resolution.candidate?.uid}`:`new:${resolution.clusterId}`;
                if(!groups.has(key))groups.set(key,[]);groups.get(key).push(resolution);
            }
            const draftRequests=[];
            for(const [key,resolutions] of groups){
                const first=resolutions[0];
                const home=renderAutomaticCanonicalHomeCatalog(first,catalogResult.authority,effectiveWritableBooks);
                if(!home){const error=new Error(`Automatic canonical home ${key} could not be materialized safely.`);error.name='NexusCanonicalHomeMaterializationError';throw error;}
                const clusterEvidence=resolutions.map(row=>row.cluster).filter(Boolean).map(row=>({id:row.id,kind:row.kind,statement:row.statement,source_indices:row.sourceIndices||row.source_indices||[],source_message_ids:row.sourceIds||row.source_message_ids||[]}));
                const syntheticSlice={promptCatalog:home.catalog,catalog:home.catalog,catalogRefs:home.catalogRefs,promptChat:'',chat:''};
                const promptOverride=()=>buildAutomaticCanonicalDraftPrompt({home,evidence:clusterEvidence,sourceStart,targetIndex});
                const request=mutationRequestForSlice(syntheticSlice,draftRequests.length,renderPostTurnEvidence(clusterEvidence),{allowedOperationTypes:home.allowedOperationTypes,promptOverride,labelOverride:`Post-turn automatic canonical draft · ${home.uid===null?'new entry':`${home.book} UID ${home.uid}`}`,dedupSuffix:`canonical:${key}`});
                draftRequests.push(request);
            }
            if(!draftRequests.length)return {operations:[],reasoning:'Canonical-home resolution found no lore mutation warranted for the durable evidence.',evidence};
            const draftResponses=await executePostTurnRequests(draftRequests,{enqueueSidecar,maxConcurrent:4,label:'Post-turn automatic canonical drafting'});
            for(const resolution of homePlan.resolutions){
                if(resolution.disposition!=='EXISTING_HOME')continue;
                const freshness=await verifyCanonicalHomeCandidateFresh(resolution.candidate);
                if(!freshness.fresh){const error=new Error(`Post-turn canonical home changed during drafting: ${resolution.candidate?.book||''} UID ${resolution.candidate?.uid??''}.`);error.name='NexusCanonicalHomeCandidateStale';throw error;}
            }
            const payloads=draftResponses.map((row,index)=>{response=response||row;logicalDegraded=logicalDegraded||row?.tv2?.multi?.degraded===true;const payload=parse(row?.structuredPayload??row?.text,draftRequests[index].structuredValidator);if((payload.operations||[]).length>1)throw new Error('Automatic canonical draft returned more than one operation for one resolved canonical home.');return payload;});
            return {operations:payloads.flatMap(payload=>payload.operations||[]),reasoning:payloads.map(payload=>String(payload.reasoning||'')).filter(Boolean).join(' | '),evidence};
        };

        if(automaticAuthority?.canonicalHomeResolution===true){
            parsed=await runAutomaticCanonicalPlanning();
        }else if(reshape.mode==='single'){
            const request=mutationRequestForSlice(reshape.slices[0],0,'');
            logicalJob=normalizePostTurnHandle(typeof enqueueSidecar==='function'?enqueueSidecar(BUS_STAGE.POST_TURN,request):enqueueBusJob(BUS_STAGE.POST_TURN,request));
            response=await logicalJob.promise;
            parsed=parse(response.structuredPayload??response.text,request.structuredValidator);
            logicalDegraded=response?.tv2?.multi?.degraded===true;
        }else{
            logicalJob={id:`postturn-hierarchical-${Date.now()}`,jobId:null};
            // Phase 1: map every source fragment exactly once. Each physical
            // continuation repeats immutable role/index/message identity.
            const allSourceSlices=reshape.sourceSlices||reshape.slices.filter(slice=>slice.phase==='source-map');
            const sourceSlices=allSourceSlices.filter(slice=>{
                const contract=evidenceContractForSlice(slice,sourceStart,targetIndex);
                return contract.sourceIndices.size>0;
            });
            if(sourceSlices.length!==allSourceSlices.length)logEvent('postturn','context-only-source-slices-skipped',{targetIndex,sourceRange,skippedCount:allSourceSlices.length-sourceSlices.length,authoritativeSliceCount:sourceSlices.length},'debug');
            const sourceRequests=sourceSlices.map((slice,index)=>{
                const contract=evidenceContractForSlice(slice,sourceStart,targetIndex);
                const structuredValidator=value=>validatePostTurnEvidenceEnvelope(value,contract);
                return structuredSidecarOptions({
                    prompt:buildPostTurnEvidencePrompt({sourceStart,targetIndex,chat:slice.promptChat||slice.chat||'',sourceIndices:[...contract.sourceIndices]}),
                    systemPrompt:'You are the Nexus Post-turn source-evidence mapper. Extract evidence only; never propose or mutate lore. Return JSON only.',
                    reasoningEffort:'max',timeoutMs:Number(settings.postTurn.timeoutMs)||240000,priority:BUS_PRIORITY.POST_TURN,preemptible:true,maxAttempts:1,
                    dedupKey:force?null:`postturn:${targetIndex}:source-map:${index}`,
                    label:`Post-turn source map · ${index+1}/${sourceSlices.length}`,
                    structuredValidator,synthesisCandidateParser:text=>parse(text,structuredValidator),
                    telemetry:{...(directorMeta||{}),nexusInternalWorker:!!directorMeta,postTurnLogicalJob:true,postTurnReshapeMode:reshape.mode,postTurnReshapeStrategy:'hierarchical',postTurnPhase:'source-map',postTurnSlice:index,postTurnSliceCount:sourceSlices.length,postTurnSoftTargetTokens:softTargetTokens,estimatedInputTokens:slice.estimatedInputTokens},
                });
            });
            const sourceResponses=await executePostTurnRequests(sourceRequests,{enqueueSidecar,maxConcurrent:6,label:'Post-turn source map'});
            const sourcePayloads=sourceResponses.map((row,index)=>{const payload=parse(row?.structuredPayload??row?.text,sourceRequests[index].structuredValidator);response=response||row;logicalDegraded=logicalDegraded||row?.tv2?.multi?.degraded===true;return payload;});
            let evidence=mergePostTurnEvidence(sourcePayloads);
            let evidenceText=renderPostTurnEvidence(evidence);
            // Mutation planning is repacked against the *actual* evidence map,
            // so evidence does not need to be crushed into the old 20% reserve.
            // Give durable facts a realistic share of the physical request and
            // bound semantic reduction to two progress-producing rounds.
            const evidenceBudget=Math.max(1600,Math.floor(softTargetTokens*0.45));
            const reductionGroupTarget=Math.max(2200,Math.min(evidenceBudget,Math.floor(softTargetTokens*0.35)));
            const maxReductionRounds=2;
            const minReductionProgress=0.12;
            let evidenceTokens=estimateContentTokens(evidenceText);
            for(let round=0;evidenceTokens>evidenceBudget&&round<maxReductionRounds;round++){
                const groups=packEvidenceGroups(evidence,reductionGroupTarget);
                const reductionRequests=groups.map((group,index)=>{
                    const contract=reductionEvidenceContract(group);
                    const structuredValidator=value=>validatePostTurnEvidenceEnvelope(value,contract);
                    return structuredSidecarOptions({prompt:buildEvidenceReductionPrompt(group),systemPrompt:'You are the Nexus Post-turn evidence reducer. Merge semantic duplicates without inventing or dropping distinct durable evidence. Preserve source attribution and return JSON only.',reasoningEffort:'max',timeoutMs:Number(settings.postTurn.timeoutMs)||240000,priority:BUS_PRIORITY.POST_TURN,preemptible:true,maxAttempts:1,dedupKey:force?null:`postturn:${targetIndex}:evidence-reduce:${round}:${index}`,label:`Post-turn evidence reduce · round ${round+1} · ${index+1}/${groups.length}`,structuredValidator,synthesisCandidateParser:text=>parse(text,structuredValidator),telemetry:{...(directorMeta||{}),nexusInternalWorker:!!directorMeta,postTurnLogicalJob:true,postTurnReshapeStrategy:'hierarchical',postTurnPhase:'evidence-reduce',postTurnRound:round,postTurnSlice:index}});
                });
                const reducedResponses=await executePostTurnRequests(reductionRequests,{enqueueSidecar,maxConcurrent:2,label:'Post-turn evidence reduction'});
                const reducedPayloads=reducedResponses.map((row,index)=>parse(row?.structuredPayload??row?.text,reductionRequests[index].structuredValidator));
                const nextEvidence=mergePostTurnEvidence(reducedPayloads);const nextText=renderPostTurnEvidence(nextEvidence);const nextTokens=estimateContentTokens(nextText);
                const tokenProgress=evidenceTokens>0?Math.max(0,(evidenceTokens-nextTokens)/evidenceTokens):0;
                const factProgress=evidence.length>0?Math.max(0,(evidence.length-nextEvidence.length)/evidence.length):0;
                const meaningfulProgress=Math.max(tokenProgress,factProgress);
                logEvent('postturn','evidence-reduction-progress',{targetIndex,round:round+1,groupCount:groups.length,beforeTokens:evidenceTokens,afterTokens:nextTokens,beforeFacts:evidence.length,afterFacts:nextEvidence.length,tokenProgress,factProgress,meaningfulProgress,evidenceBudget},'debug');
                if(nextTokens>=evidenceTokens&&nextEvidence.length>=evidence.length)break;
                evidence=nextEvidence;evidenceText=nextText;evidenceTokens=nextTokens;
                if(evidenceTokens>evidenceBudget&&meaningfulProgress<minReductionProgress){
                    logEvent('postturn','evidence-reduction-converged',{targetIndex,round:round+1,evidenceTokens,evidenceFacts:evidence.length,evidenceBudget,meaningfulProgress,minRequiredProgress:minReductionProgress,reason:'insufficient-progress'},'info');
                    break;
                }
            }
            if(evidenceTokens>evidenceBudget){const error=new Error(`Post-turn evidence map remains above its bounded planning budget after convergence (${evidenceTokens}/${evidenceBudget}); source backlog preserved.`);error.name='NexusPostTurnEvidenceReductionError';throw error;}

            if(!evidence.length){
                parsed={operations:[],reasoning:'No durable post-turn evidence extracted from the authoritative source range.'};
            }else{
                // Phase 2: repack the canonical catalog against the actual bounded
                // evidence map. This is linear in catalog size and each mutation
                // contract is scoped to the exact complete UIDs in that request.
                const mutationBuild=(catalogSlice,_chatSlice)=>buildPostTurnPrompt({catalog:catalogSlice,writableBooks:effectiveWritableBooks,sourceStart,targetIndex,evidence:evidenceText});
                const catalogReshape=packPostTurnCatalogSlices({catalog,chat:'',buildPrompt:mutationBuild,buildCatalogPrompt:mutationBuild,softTargetTokens});
                const catalogSlices=catalogReshape.mode==='single'?catalogReshape.slices:(catalogReshape.catalogSlices||catalogReshape.slices.filter(slice=>slice.phase==='catalog-plan'));
                const mutationRequests=catalogSlices.map((slice,index)=>mutationRequestForSlice(slice,index,evidenceText));
                const requests=mutationRequests;
                const mutationResponses=await executePostTurnRequests(requests,{enqueueSidecar,maxConcurrent:6,label:'Post-turn mutation planning'});
                const payloads=mutationResponses.map((row,index)=>{response=response||row;logicalDegraded=logicalDegraded||row?.tv2?.multi?.degraded===true;return parse(row?.structuredPayload??row?.text,requests[index].structuredValidator);});
                if(payloads.length!==requests.length)throw new Error(`Post-turn hierarchical mutation pass returned ${payloads.length}/${requests.length} required slices; backlog preserved.`);

                // C10-044: recover relational authority lost when two complete
                // canonical UIDs are packed into different physical slices. A
                // bounded deterministic nominator identifies plausible pairs;
                // only pairs whose TWO complete canonical entries can be
                // materialized together inside the physical target receive a
                // focused Sidecar pass. The focused semantic contract permits
                // only merge and therefore cannot broaden mutation authority.
                const relationalPairs=nominatePostTurnRelationalPairs({authority:catalogResult.authority,catalogSlices,writableBooks:effectiveWritableBooks,maxPairs:4});
                const relationalRequests=[];
                const relationalMeta=[];
                for(const pair of relationalPairs){
                    const focused=renderPostTurnRelationalPair(pair);
                    const syntheticSlice={promptCatalog:focused.catalog,catalog:focused.catalog,catalogRefs:focused.catalogRefs,promptChat:'',chat:''};
                    const relationPrompt=({catalog:focusedCatalog,evidence:focusedEvidence})=>buildPostTurnRelationalMergePrompt({catalog:focusedCatalog,evidence:focusedEvidence,sourceStart,targetIndex,pair});
                    const candidatePrompt=relationPrompt({catalog:focused.catalog,evidence:evidenceText});
                    if(estimateContentTokens(candidatePrompt)>softTargetTokens){
                        logEvent('postturn','relational-pair-deferred',{targetIndex,book:pair.book,leftUid:pair.leftUid,rightUid:pair.rightUid,score:pair.score,reason:'focused-pair-exceeds-physical-target'},'debug');
                        continue;
                    }
                    const request=mutationRequestForSlice(syntheticSlice,relationalRequests.length,evidenceText,{allowedOperationTypes:['merge'],promptOverride:relationPrompt,labelOverride:`Post-turn relational merge · ${pair.book} ${pair.leftUid}/${pair.rightUid}`,dedupSuffix:`relation:${pair.book}:${pair.leftUid}:${pair.rightUid}`});
                    relationalRequests.push(request);relationalMeta.push(pair);
                }
                let relationalPayloads=[];
                if(relationalRequests.length){
                    const relationalResponses=await executePostTurnRequests(relationalRequests,{enqueueSidecar,maxConcurrent:4,label:'Post-turn relational recovery'});
                    relationalPayloads=relationalResponses.map((row,index)=>{response=response||row;logicalDegraded=logicalDegraded||row?.tv2?.multi?.degraded===true;return parse(row?.structuredPayload??row?.text,relationalRequests[index].structuredValidator);});
                    if(relationalPayloads.length!==relationalRequests.length)throw new Error(`Post-turn relational recovery returned ${relationalPayloads.length}/${relationalRequests.length} required focused pairs; backlog preserved.`);
                    logEvent('postturn','relational-recovery-complete',{targetIndex,nominatedPairCount:relationalPairs.length,focusedPairCount:relationalRequests.length,mergeProposalCount:relationalPayloads.flatMap(payload=>payload.operations||[]).length,pairs:relationalMeta.map(pair=>({book:pair.book,leftUid:pair.leftUid,rightUid:pair.rightUid,score:pair.score}))},'info');
                }
                const primaryOperations=payloads.flatMap(payload=>payload.operations||[]);
                const relationalOperations=relationalPayloads.flatMap(payload=>payload.operations||[]);
                const layered=reconcilePostTurnOperationLayers(primaryOperations,relationalOperations);
                if(layered.deferred.length)logEvent('postturn','relational-operations-deferred',{targetIndex,sourceRange,deferredCount:layered.deferred.length,deferred:layered.deferred.map(row=>({type:row.operation?.type||null,book:row.operation?.book||null,uid:row.operation?.uid??null,keepUid:row.operation?.keep_uid??null,removeUid:row.operation?.remove_uid??null,error:row.error}))},'warn');
                const allPayloads=[...payloads,...relationalPayloads];
                parsed={operations:layered.operations,reasoning:allPayloads.map(payload=>String(payload.reasoning||'')).filter(Boolean).join(' | '),evidence};
            }
        }
    const rawOperationCount=Array.isArray(parsed.operations)?parsed.operations.length:0;
    parsed.operations=reconcilePostTurnOperations(parsed.operations||[]);
    if(parsed.operations.length<rawOperationCount)logEvent('postturn','operations-reconciled',{targetIndex,sourceRange,inputOperationCount:rawOperationCount,outputOperationCount:parsed.operations.length,coalescedCount:rawOperationCount-parsed.operations.length},'info');
    if(parsed.operations.length){
        const warrantContext={chatId:scope.chatId,chatRevision:scope.revision,sourceRange:[...sourceRange],operations:[...parsed.operations],evidence:Array.isArray(parsed.evidence)?parsed.evidence:[]};
        warrantContext.sourceFingerprint=postTurnProposalWarrantFingerprint(warrantContext);
        warrantContext.readCurrentSourceFingerprint=()=>isNexusWorkScopeFresh(scope,getContext())?warrantContext.sourceFingerprint:`stale:${warrantContext.sourceFingerprint}`;
        const warrant=await evaluatePostTurnProposalWarrants(warrantContext).catch(error=>({handled:false,operations:[...parsed.operations],reason:'decision-error',error}));
        const beforeWarrant=parsed.operations.length;
        if(warrant.handled){parsed.operations=warrant.operations;logEvent('postturn','proposal-warrant-complete',{targetIndex,sourceRange,inputOperationCount:beforeWarrant,outputOperationCount:parsed.operations.length,rejectedCount:beforeWarrant-parsed.operations.length,scores:warrant.scores||[],provider:warrant.result?.provider||null,latencyMs:warrant.result?.latencyMs||0},'info');}
        else if(beforeWarrant>6){
            // High-volume proposal sets are exactly the failure mode this gate
            // exists to prevent. If typed decision authority is unavailable,
            // preserve the source backlog and retry later instead of either
            // flooding operator review or silently consuming durable evidence.
            logEvent('postturn','proposal-warrant-deferred',{targetIndex,sourceRange,inputOperationCount:beforeWarrant,reason:warrant.reason||'decision-unavailable',pendingPreserved:true},'warn');
            if(transactionId){try{await failNexusTransaction(transactionId,new Error('Post-turn proposal warrant unavailable for high-volume mutation set.'),{stage:'proposal-warrant',pendingPreserved:true});}catch{}}
            return {deferred:true,reason:'proposal-warrant-unavailable',pendingPreserved:true,transactionId,targetIndex,sourceRange,candidateOperationCount:beforeWarrant};
        }else logEvent('postturn','proposal-warrant-fallback',{targetIndex,sourceRange,inputOperationCount:beforeWarrant,reason:warrant.reason||'decision-unavailable',suppressed:false},'debug');
    }
        const resolvedJobId=logicalJob?.jobId||logicalJob?.id||response?.tv2?.jobId||null;
        const ops=Array.isArray(parsed.operations)?parsed.operations:[];
        const failures=[];
        const legacyRefs=buildLegacyRefMap(ops,books);
        throwIfStale('sidecar-result');
        const finalized=finalizePostTurnProposalTransaction(transactionId,{parsed,metadata:{source:'post-turn',director:directorMeta||null,workerJobId:resolvedJobId}});
        if(finalized.state==='failed'){
            logEvent('postturn','transaction-validation-failed',{targetIndex,sourceRange,transactionId,error:finalized.error||finalized.validation?.reason||'validation failed',pendingPreserved:true},'error');
            return {failed:true,stage:'transaction-validation',error:finalized.error||'Post-turn transaction validation failed.',transactionId,targetIndex,sourceRange};
        }
        throwIfStale('transaction-freshness');
        const currentCatalogResult=await buildLoreCatalog(catalogBooks);
        const currentAssumptions=postTurnAssumptionsSnapshot(sourceRange,effectiveWritableBooks,context,currentCatalogResult.authority);
        const fresh=enforceNexusTransactionFreshBeforeStage(transactionId,currentAssumptions);
        if(fresh.state==='stale'){
            logEvent('postturn','transaction-stale',{targetIndex,sourceRange,transactionId,freshness:fresh.freshness,pendingPreserved:true},'warn');
            return {deferred:true,reason:'transaction-stale',transactionId,targetIndex,sourceRange,freshness:fresh.freshness};
        }
        const parentPreBacklog=backlogStore(context);
        const sourceRows=sourceMessagesForRange(sourceRange[0],sourceRange[1],context);
        const sourceMessageKeys=sourceRows.filter(row=>row.eligible).map(row=>row.authorityKey);
        await beginPostTurnParentSaga({context,transactionId,chatId:context?.chatId??null,sourceRange,sourceMessageKeys,sourceEligibility:sourceRows.map(row=>({index:row.index,messageId:row.messageId,eligible:row.eligible,eligibilityFlags:row.eligibilityFlags,authorityKey:row.authorityKey})),preBacklog:parentPreBacklog});
        parentSagaStarted=true;
        await renewPostTurnDrainLease(drainLease);
        logEvent('postturn','analysis-complete',{targetIndex,jobId:resolvedJobId,transactionId,slot:response?.tv2?.slot||null,operationCount:ops.length,operations:ops,reasoning:parsed.reasoning||''},'info');
        for(const op of ops){
            throwIfStale('proposal-loop');
            try{
                const actualSlot=response?.tv2?.slot||preferredBusSlot(BUS_STAGE.POST_TURN);
                const requestedBook=String(op?.book||op?.lorebook||'').trim();
                if(requestedBook&&writeValveMode(requestedBook)==='disabled'){logEvent('postturn','write-valve-disabled',{targetIndex,book:requestedBook,type:op?.type||'unknown',mutationSuppressed:true},'info');continue;}
                const p=await stage(op,parsed.reasoning||'',`Sidecar ${actualSlot}`,books,legacyRefs,{origin:{chatId:scope.chatId,messageId:sourceMessagesForRange(targetIndex,targetIndex,context)?.[0]?.messageId||String(targetIndex),sourceRevision:scope.revision},sourceRange:[...sourceRange],sourceMessageIndices:Array.from({length:targetIndex-sourceStart+1},(_,i)=>sourceStart+i),execution:{kind:'tv2-post-turn-child',parentTransactionId:transactionId}});
                throwIfStale('proposal-stage');
                if(p){
                    if(!p.resolvedDuplicate&&!staged.includes(p.id)){staged.push(p.id);await updatePostTurnParentSaga(transactionId,{proposalIds:[p.id]},{context});}
                    const routed=await routeOperation(p,{book:p.op.book,source:'post-turn',parentTransactionId:transactionId});
                    if(routed.mode==='direct'&&routed.write?.id){directWriteIds.push(routed.write.id);await updatePostTurnParentSaga(transactionId,{directWriteIds:[routed.write.id]},{context});}
                    throwIfStale('proposal-route');
                    const eventName=routed.mode==='direct'?'direct-write-applied':routed.mode==='deduplicated'||p.resolvedDuplicate?'proposal-deduplicated':'proposal-staged';
                    logEvent('postturn',eventName,{targetIndex,proposalId:p.id,proposalDisposition:p.enqueueDisposition||null,type:op.type,slot:actualSlot,writeId:routed.write?.id||null,routeMode:routed.mode,parentTransactionId:transactionId},routed.mode==='direct'?'warn':'info');
                }
            }catch(err){
                failures.push({type:op?.type||'unknown',message:err?.message||String(err)});
                // Keep exact failed operations in Diagnostics without flooding the compact Feed.
                logEvent('postturn','proposal-staging-detail',{targetIndex,operation:op,error:err},'debug');
            }
        }
        if(failures.length){
            const rollbackFailures=await rollbackPostTurn('Parent post-turn transaction rolled back after a sibling operation failed.');
            const error=new Error(`Post-turn atomic staging failed: ${failures[0]?.message||'operation failed'}`);
            await failNexusTransaction(transactionId,error,{stage:'postturn-atomic',failures,rollbackFailures});
            logEvent('postturn','proposal-staging-summary',{targetIndex,failedCount:failures.length,stagedCount:staged.length,failures,rollbackFailures,pendingPreserved:true},rollbackFailures.length?'error':'warn');
            return {failed:true,retryable:true,rolledBack:rollbackFailures.length===0,error:error.message,transactionId,targetIndex,sourceRange,failures,rollbackFailures,pendingPreserved:true};
        }
        throwIfStale('backlog-commit');
        const currentBacklog=JSON.parse(JSON.stringify(backlogStore(context))),nextBacklog=JSON.parse(JSON.stringify(pending)),consumedSet=new Set(consumedPendingIds);
        nextBacklog.pendingMessageIds=(nextBacklog.pendingMessageIds||[]).filter(id=>!consumedSet.has(String(id)));
        const shadowContext={...context,chatMetadata:{...(context?.chatMetadata||{}),[POSTTURN_META_KEY]:nextBacklog}};
        const remaining=reconcilePendingMessageIds(nextBacklog,shadowContext);nextBacklog.pendingStart=remaining.start;nextBacklog.pendingEnd=remaining.end;
        if(!nextBacklog.pendingMessageIds.length)nextBacklog.deferredCount=0;
        const fencedBacklog=consumePostTurnRange(nextBacklog,{chat:context?.chat||[],chatId:context?.chatId||'',sourceStart:sourceRange[0],targetIndex});
        Object.assign(nextBacklog,fencedBacklog);
        await updatePostTurnParentSaga(transactionId,{proposalIds:staged,directWriteIds,postBacklog:nextBacklog},{context});
        await renewPostTurnDrainLease(drainLease);
        const commitChatId=context?.chatId??null;
        const backlogCommitPreflight=()=>{
            const live=getContext(),liveChatId=live?.chatId??null;
            if(String(liveChatId??'')!==String(commitChatId??'')){const error=new Error('Post-turn backlog commit became stale because the active chat changed while waiting for mutation authority.');error.name='TV2MutationStale';error.tv2PreMutationStale=true;throw error;}
            const liveBacklog=JSON.parse(JSON.stringify(backlogStore(live)));
            if(JSON.stringify(liveBacklog)!==JSON.stringify(currentBacklog)){const error=new Error('Post-turn backlog commit became stale because the same-chat backlog changed while waiting for mutation authority.');error.name='TV2MutationStale';error.tv2PreMutationStale=true;throw error;}
        };
        assertDirectWritesActive(directWriteIds,transactionId);
        const committed=await commitCanonicalNexusMutation(transactionId,{type:'metadata.set',key:POSTTURN_META_KEY,value:nextBacklog,expected:currentBacklog,chatId:commitChatId},{preflight:backlogCommitPreflight,currentAssumptions:()=>currentAssumptions,context,metadata:{surface:'post-turn',operation:'backlog-metadata'},committed:result=>({proposalIds:[...staged],failures:[...failures],operationCount:ops.length,sourceRange:[...sourceRange],result})});
        if(committed?.state!=='committed')throw Object.assign(new Error(committed?.error||`Post-turn backlog parent transaction settled ${committed?.state||'unknown'} instead of committed.`),{name:'TV2PostTurnParentNotCommitted',parentState:committed?.state||null});
        let parentSagaSettlementDegraded=false,parentSagaSettlementError='';
        try{await resolvePostTurnParentSaga(transactionId,'committed',{context});}catch(error){parentSagaSettlementDegraded=true;parentSagaSettlementError=error?.message||String(error);logEvent('postturn','parent-committed-saga-settlement-degraded',{transactionId,error},'error');}
        const operationTypes=ops.reduce((acc,op)=>{const key=String(op?.type||'unknown');acc[key]=(acc[key]||0)+1;return acc;},{});
        const remainingPendingCount=Math.max(0,catchupPlan.remainingPendingIndices.length);
        logEvent('postturn','drain-complete',{targetIndex,sourceRange,jobId:resolvedJobId,transactionId,transactionState:committed.state,slot:response?.tv2?.slot||null,stagedCount:staged.length,failedCount:failures.length,operationCount:ops.length,operationTypes,remainingPendingCount,budgetLimited:catchupPlan.budgetLimited},failures.length?'warn':'info');
        console.log(`[Nexus] Post-turn staged ${staged.length} Lore Proposal(s)`);
        return {staged,operations:ops.length,failures,slot:response?.tv2?.slot||null,jobId:resolvedJobId,transactionId,targetIndex,sourceRange,degraded:logicalDegraded,reshapeMode:reshape.mode,sliceCount:reshape.slices.length,parentSagaSettlementDegraded,parentSagaSettlementError,remainingPendingCount,budgetLimited:catchupPlan.budgetLimited};
    }catch(err){
        const rollbackFailures=(parentSagaStarted||staged.length||directWriteIds.length)?await rollbackPostTurn(`Post-turn transaction aborted: ${err?.message||String(err)}`):[];
        if(isIntentionalCancellation(err)){
            let store=backlogStore(context);
            if(!stale()){
                try{store=await mutateChatMetadataDurably(context,'Post-turn deferred backlog',{keys:[POSTTURN_META_KEY]},()=>{const next=backlogStore(context);next.deferredCount=(Number(next.deferredCount)||0)+1;context.chatMetadata[POSTTURN_META_KEY]=next;return JSON.parse(JSON.stringify(next));});}
                catch(error){logEvent('postturn','deferred-backlog-durability-failed',{transactionId,error},'error');}
            }
            const resolvedJobId=logicalJob?.jobId||logicalJob?.id||null;
            if(transactionId){try{await failNexusTransaction(transactionId,err,{stage:'foreground-preempted'});}catch{}}
            logEvent('postturn','drain-deferred',{targetIndex,sourceRange,jobId:resolvedJobId,transactionId,error:err,pendingPreserved:true,deferredCount:store.deferredCount},'info');
            return {deferred:true,reason:'foreground-preempted',error:err?.message||String(err),jobId:resolvedJobId,transactionId,targetIndex,sourceRange};
        }
        const resolvedJobId=logicalJob?.jobId||logicalJob?.id||null;
        if(transactionId){try{await failNexusTransaction(transactionId,err,{stage:'drain'});}catch{}}
        logEvent('postturn','drain-failed',{targetIndex,sourceRange,jobId:resolvedJobId,transactionId,error:err,pendingPreserved:true},'error');
        console.warn('[Nexus] Post-turn failed; work remains pending until a later generation-end event:',err?.message||err);
        return {failed:true,error:err?.message||String(err),jobId:resolvedJobId,transactionId,targetIndex,sourceRange};
    }
}


export async function drainPostTurn(options={}){
    if(options?.force!==true)return {deferred:true,reason:'automatic-intelligence-authority-required'};
    const context=getContext(),chatId=context?.chatId??null;
    if(chatId==null)return {skipped:true,reason:'no-chat'};
    let lease;
    try{lease=await acquirePostTurnDrainLease(chatId);}catch(error){if(error?.name==='TV2PostTurnDrainBusy'){logEvent('postturn','drain-lease-busy',{chatId,error:error?.message||String(error)},'debug');return {deferred:true,reason:'drain-already-active'};}throw error;}
    try{return await drainPostTurnInternal(options,lease);}finally{try{await releasePostTurnDrainLease(lease);}catch(error){logEvent('postturn','drain-lease-release-failed',{chatId,error:error?.message||String(error)},'error');}}
}

/**
 * Automatic Lifecycle Intelligence dispatch fence. This wrapper proves that
 * the exact evidence window Jev admitted is still the current backlog prefix
 * and requires the narrow Automatic authority envelope before worker execution.
 */
export async function drainPostTurnEvaluatedWindow({expectedSourceRange=null,expectedAuthority=null,...options}={}){
    if(options?.automaticAuthority?.canonicalHomeResolution!==true)return {deferred:true,reason:'automatic-intelligence-authority-required',pendingPreserved:true};
    const context=getContext(),chatId=context?.chatId??null;
    if(chatId==null)return {deferred:true,stale:true,reason:'no-chat'};
    let lease;
    try{lease=await acquirePostTurnDrainLease(chatId);}catch(error){if(error?.name==='TV2PostTurnDrainBusy'){logEvent('postturn','drain-lease-busy',{chatId,error:error?.message||String(error)},'debug');return {deferred:true,reason:'drain-already-active'};}throw error;}
    try{
        const expected=Array.isArray(expectedSourceRange)?expectedSourceRange.slice(0,2).map(Number):[];
        const live=inspectPostTurnEvaluationWindow({context});
        const current=[Number(live?.sourceStart),Number(live?.targetIndex)];
        const authority=expected.length===2&&expected.every(Number.isInteger)?postTurnEvaluationAuthoritySnapshot({context,sourceStart:expected[0],targetIndex:expected[1]}):null;
        const authorityFresh=expectedAuthority?postTurnEvaluationAuthorityMatches(expectedAuthority,authority):(current[0]===expected[0]&&current[1]===expected[1]);
        if(expected.length!==2||!expected.every(Number.isInteger)||!authorityFresh){
            const result={deferred:true,stale:true,reason:'evaluated-window-changed',expectedSourceRange:expected,currentSourceRange:current,pendingPreserved:true};
            logEvent('postturn','evaluated-worker-fence-stale',result,'info');
            return result;
        }
        activeEvaluatedDrainByChat.set(String(chatId),{sourceStart:expected[0],targetIndex:expected[1],authority:expectedAuthority||null});
        let result;
        try{result=await drainPostTurnInternal({...options,evaluatedSourceRange:expected,evaluatedSourceAuthority:expectedAuthority||null},lease);}
        finally{activeEvaluatedDrainByChat.delete(String(chatId));}
        if(result&&!result.failed&&!result.deferred){
            const remaining=inspectPostTurnBacklogForAdmission({context});
            result.remainingPendingCount=Math.max(0,Number(remaining.pendingCount)||0);
        }
        return result;
    }finally{try{await releasePostTurnDrainLease(lease);}catch(error){logEvent('postturn','drain-lease-release-failed',{chatId,error:error?.message||String(error)},'error');}}
}
