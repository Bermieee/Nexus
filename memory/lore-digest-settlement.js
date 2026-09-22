import { getMemoryRecord, deleteMemoryRecord } from './store.js';
import { unlinkCharacterMemoryEverywhere } from './character-banks.js';
import { getLoreRoutingSaga } from './lore-routing-saga.js';
import { getProposalById } from '../proposals/store.js';
import { logEvent } from '../observability/telemetry.js';
import { evaluateLoreDigestCleanup } from './lore-digest-policy.js';

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
    const proposals=proposalIds.map(id=>getProposalById(id)).filter(Boolean);
    const verdict=evaluateLoreDigestCleanup({saga,proposals});
    if(!verdict.allowed)return {deleted:false,...verdict};
    const memoryId=String(saga.memoryId||'');
    const record=getMemoryRecord(memoryId);
    if(!record)return {deleted:false,reason:'already-absent',memoryId,proposalIds};
    if(record.permanent===true||record.locked===true)return {deleted:false,reason:'protected',memoryId,proposalIds};
    try{
        await deleteMemoryRecord(memoryId,{reason,preserveCoverage:true});
        unlinkCharacterMemoryEverywhere(memoryId);
        logEvent('memory','digested-summary-cleaned-after-lore',{memoryId,parentTransactionId:parent,proposalIds,preserveCoverage:true},'info');
        return {deleted:true,memoryId,proposalIds};
    }catch(error){
        logEvent('memory','digested-summary-cleanup-failed',{memoryId,parentTransactionId:parent,proposalIds,error:error?.message||String(error)},'warn');
        return {deleted:false,reason:'delete-failed',memoryId,proposalIds,error:error?.message||String(error)};
    }
}
