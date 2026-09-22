import { getMemoryRecord, deleteMemoryRecord, restoreMemoryCoverageFromRecord } from './store.js';
import { unlinkCharacterMemoryEverywhere } from './character-banks.js';
import { getLoreRoutingSaga, getLoreRoutingSagas } from './lore-routing-saga.js';
import { getProposalById } from '../proposals/store.js';
import { logEvent } from '../observability/telemetry.js';
import { evaluateLoreDigestCleanup } from './lore-digest-policy.js';

function digestVerdictForSaga(saga){
    if(!saga)return {allowed:false,reason:'missing-parent-saga',proposals:[]};
    const proposalIds=[...new Set((saga.proposalIds||[]).map(String).filter(Boolean))];
    const proposals=proposalIds.map(id=>getProposalById(id)).filter(Boolean);
    return {...evaluateLoreDigestCleanup({saga,proposals}),proposals};
}
function sagaCoverageRecord(saga,liveRecord=null){
    return liveRecord||saga?.postMemoryRecord||saga?.preMemoryRecord||null;
}
export function isMemoryLoreDigestSettled(memoryId,{chatId=undefined}={}){
    const id=String(memoryId||'');
    if(!id)return false;
    return getLoreRoutingSagas({unresolvedOnly:false,chatId}).some(saga=>saga.memoryId===id&&digestVerdictForSaga(saga).allowed===true);
}
export async function reconcileDigestedSummaryCoverage({chatId=undefined}={}){
    const results=[];
    for(const saga of getLoreRoutingSagas({unresolvedOnly:false,chatId})){
        const verdict=digestVerdictForSaga(saga);
        if(!verdict.allowed)continue;
        const live=getMemoryRecord(saga.memoryId);
        const sourceRecord=sagaCoverageRecord(saga,live);
        if(!sourceRecord)continue;
        const coverage=await restoreMemoryCoverageFromRecord(sourceRecord,{source:'committed-lore-digest-recovery'});
        if(coverage?.restored||coverage?.reason==='already-covered')results.push({transactionId:saga.transactionId,memoryId:saga.memoryId,...coverage});
    }
    if(results.some(row=>row.restored))logEvent('memory','digested-summary-coverage-reconciled',{chatId:chatId??null,restored:results.filter(row=>row.restored).length,checked:results.length},'warn');
    return results;
}

/**
 * Delete a Summary after Lore digestion only when the durable parent saga says
 * the operator requested deletion and every Lore proposal child has reached the
 * canonical approved state. Direct-write children are proposals too, so mixed
 * direct + review-mode routing cannot delete the Summary while siblings remain
 * pending.
 *
 * This cleanup is intentionally best-effort and post-commit. Failure to clean up
 * the staging Summary must never roll back already-committed canonical Lore.
 */
export async function settleDigestedSummaryAfterLoreChildren(parentTransactionId,{reason='digested-to-lore'}={}){
    const parent=String(parentTransactionId||'').trim();
    if(!parent)return {deleted:false,reason:'missing-parent-transaction'};
    const saga=getLoreRoutingSaga(parent);
    const proposalIds=[...new Set((saga?.proposalIds||[]).map(String).filter(Boolean))];
    const verdict=digestVerdictForSaga(saga);
    if(!verdict.allowed)return {deleted:false,...verdict};
    const memoryId=String(saga.memoryId||'');
    const record=getMemoryRecord(memoryId);
    const coverageSource=sagaCoverageRecord(saga,record);
    const coverage=coverageSource?await restoreMemoryCoverageFromRecord(coverageSource,{source:'committed-lore-digest'}):{restored:false,reason:'missing-coverage-evidence'};
    if(!record)return {deleted:false,reason:'already-absent',memoryId,proposalIds,coverage};
    if(record.permanent===true||record.locked===true)return {deleted:false,reason:'protected',memoryId,proposalIds,coverage};
    try{
        await deleteMemoryRecord(memoryId,{reason,preserveCoverage:true});
        unlinkCharacterMemoryEverywhere(memoryId);
        logEvent('memory','digested-summary-cleaned-after-lore',{memoryId,parentTransactionId:parent,proposalIds,preserveCoverage:true,coverageRestored:coverage?.restored===true},'info');
        return {deleted:true,memoryId,proposalIds,coverage};
    }catch(error){
        logEvent('memory','digested-summary-cleanup-failed',{memoryId,parentTransactionId:parent,proposalIds,error:error?.message||String(error)},'warn');
        return {deleted:false,reason:'delete-failed',memoryId,proposalIds,error:error?.message||String(error)};
    }
}
