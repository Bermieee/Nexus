import { getContext } from '../../../../st-context.js';
import { captureProposalStore, getProposalsFromStore, getProposalById, updateProposalInStore, flushProposalStorePersistence, claimProposalApproval, releaseProposalApprovalClaim, proposalOperationFingerprint } from './store.js';
import { logEvent } from '../observability/telemetry.js';
import { revisionFromMessages } from '../nexus/message-settle-barrier.js';
import { getNexusLedger, inspectNexusCommitJournal } from '../nexus/transaction-service.js';
import { createMutationProposal, deepCopy } from '../nexus/contracts.js';
import { commitCanonicalNexusMutation, commitRecoveryInverse } from '../nexus/mutation-coordinator.js';
import { inspectMutationRecoveryState } from '../nexus/mutation-recovery.js';
import { settleDigestedSummaryAfterLoreChildren } from '../memory/lore-digest-settlement.js';

function isChatBoundProposal(proposal){return String(proposal?.op?.type||'')==='metadata.set';}

function proposalAssumptions(proposal, context) {
    const originChatId = proposal?.origin?.chatId ?? null;
    const chatBound=isChatBoundProposal(proposal);
    return {
        proposalId: String(proposal?.id || ''),
        // HOTFIX32: the source chat is provenance for durable lore/Tree review,
        // not mutation authority after staging. metadata.set remains chat-owned.
        chatId: chatBound ? (originChatId ?? context?.chatId ?? null) : null,
        originChatId,
        sourceRevision: chatBound ? (proposal?.origin?.sourceRevision || null) : null,
        proposalRevision: Number(proposal?.revision)||0,
        proposalStatus: String(proposal?.status||''),
        proposalOpFingerprint: proposalOperationFingerprint(proposal?.op),
        approvalClaimToken: proposal?.approvalClaim?.token || null,
        targetBook: proposal?.op?.book == null ? null : String(proposal.op.book),
    };
}

function currentProposalAssumptions(proposalId, context) {
    const proposal=getProposalById(proposalId);
    if(!proposal)return { proposalId:String(proposalId||''), missing:true };
    const out = proposalAssumptions(proposal, context);
    if (isChatBoundProposal(proposal) && out.sourceRevision) out.sourceRevision = revisionFromMessages(context?.chat || [], { chatId: context?.chatId ?? null }, { includeAll: true });
    return out;
}

function assertProposalScope(proposal, context, claimToken=null) {
    const currentChatId = context?.chatId ?? null;
    // Only operations whose physical target is chat metadata retain active-chat
    // authority. Lore/Tree proposals already crossed producer-time freshness and
    // are globally reviewable against their captured canonical PRE conditions.
    if (isChatBoundProposal(proposal)) {
        if (proposal.origin?.chatId != null && String(proposal.origin.chatId) !== String(currentChatId ?? '')) {
            const error=new Error(`Proposal ${proposal.id} targets chat ${proposal.origin.chatId}, not ${currentChatId ?? 'none'}.`); error.name='TV2MutationStale'; error.tv2PreMutationStale=true; throw error;
        }
        if (proposal.origin?.sourceRevision) {
            const currentRevision = revisionFromMessages(context?.chat || [], { chatId: currentChatId }, { includeAll: true });
            if (String(currentRevision) !== String(proposal.origin.sourceRevision)) {
                const error = new Error(`Proposal ${proposal.id} became stale because its target chat changed after staging.`);
                error.name = 'TV2MutationStale'; error.tv2PreMutationStale = true; throw error;
            }
        }
    }
    const live=getProposalById(proposal.id);
    if(!live||String(live.status||'')!=='pending'){const error=new Error(`Proposal ${proposal.id} is no longer pending review.`);error.name='TV2ProposalCASMismatch';throw error;}
    if(claimToken&&live.approvalClaim?.token!==claimToken){const error=new Error(`Proposal ${proposal.id} approval ownership changed before commit.`);error.name='TV2ProposalCASMismatch';throw error;}
    if(proposalOperationFingerprint(live.op)!==proposalOperationFingerprint(proposal.op)){const error=new Error(`Proposal ${proposal.id} operation changed after approval admission.`);error.name='TV2ProposalCASMismatch';throw error;}
}

function stageProposalTransaction(proposal, context, ledger = getNexusLedger(), { actor = 'operator', surface = 'lore-proposals', actorMetadata = {} } = {}) {
    const assumptions = proposalAssumptions(proposal, context);
    let tx = ledger.begin({
        type: 'lore-proposal-apply',
        input: { proposalId: proposal.id, operation: deepCopy(proposal.op) },
        snapshot: { proposal: deepCopy({ id: proposal.id, op: proposal.op, origin: proposal.origin, source: proposal.source }) },
        assumptions,
        metadata: { source: 'lore-proposal', proposalId: proposal.id, proposalSource: proposal.source || 'unknown' },
    });
    ledger.executing(tx.id);
    ledger.parsed(tx.id, { operation: deepCopy(proposal.op) }, { kind: 'reviewed-lore-proposal' });
    ledger.validated(tx.id, { passed: true, checks: { proposalPending: true, operationPresent: !!proposal.op?.type } });
    tx = ledger.staged(tx.id, { operation: deepCopy(proposal.op), proposalId: proposal.id }, {
        mutationProposal: createMutationProposal({
            transactionId: tx.id,
            type: 'lore-proposal-apply',
            target: { proposalId: proposal.id, book: proposal.op?.book || null },
            draft: { operation: deepCopy(proposal.op) },
            assumptions,
            approvalRequired: true,
            metadata: { proposalId: proposal.id, proposalSource: proposal.source || 'unknown' },
        }),
    });
    return ledger.read(tx.id);
}

/**
 * Approving a Lore Proposal no longer creates a second durable commit state.
 * The proposal is a review/audit record; one Nexus transaction/journal owns the
 * physical mutation and all recovery authority.
 */
export async function approveProposal(proposalId, { preflight = null, onTransactionStaged = null, actor = 'operator', surface = 'lore-proposals', actorMetadata = {} } = {}) {
    // A durable claim is the review-state admission fence. It is acquired before
    // any resource wait/model-independent async commit work so edit/reject or a
    // second approval cannot race the operation the operator actually reviewed.
    const claim=await claimProposalApproval(proposalId);
    const proposal=claim.proposal, claimToken=claim.token;
    const storeRef=captureProposalStore(true), context=storeRef.context||getContext();
    try { assertProposalScope(proposal,context,claimToken); }
    catch(error){ try{await releaseProposalApprovalClaim(proposalId,claimToken,{error:String(error?.message||error)});}catch{} throw error; }

    const ledger=getNexusLedger();
    const tx=stageProposalTransaction(proposal,context,ledger);
    try {
        if(typeof onTransactionStaged==='function') await onTransactionStaged(deepCopy(tx),deepCopy(proposal));
        ledger.approve(tx.id,{by:String(actor||'operator'),metadata:{surface:String(surface||'lore-proposals'),proposalId:proposal.id,approvalClaim:claimToken,...deepCopy(actorMetadata||{})}});
    } catch(error) {
        try{await releaseProposalApprovalClaim(proposalId,claimToken,{error:String(error?.message||error)});}catch{}
        try{ if(!['failed','cancelled','aborted','stale','committed'].includes(String(ledger.read(tx.id)?.state||''))) ledger.cancel(tx.id,'Proposal approval admission failed before canonical commit.'); }catch{}
        throw error;
    }

    let auditProjectionDurable=false, committed;
    try {
        committed=await commitCanonicalNexusMutation(tx.id,proposal.op,{
            preflight:async()=>{assertProposalScope(proposal,getContext(),claimToken);if(typeof preflight==='function')await preflight(deepCopy(proposal),deepCopy(tx));},
            currentAssumptions:()=>currentProposalAssumptions(proposal.id,getContext()),
            targetLedger:ledger,context,
            metadata:{proposalId:proposal.id,proposalSource:proposal.source||'unknown',approvalClaim:claimToken},
            afterIntent:async()=>{
                updateProposalInStore(storeRef,proposalId,{claimToken,approvalClaim:null,status:'committing',error:'',transactionId:tx.id,transactionOwned:true,recovery:null});
                try{await flushProposalStorePersistence(storeRef);auditProjectionDurable=true;}
                catch(error){
                    updateProposalInStore(storeRef,proposalId,{claimToken,status:'pending',transactionId:null,transactionOwned:false,approvalClaim:null,error:'Approval was not admitted because the committing audit state was not durable.',recovery:null});
                    error.tv2ProposalAuditProjectionFailed=true;throw error;
                }
            },
            committed:result=>({proposalId:proposal.id,operation:proposal.op?.type||null,result}),
        });
    } catch(error) {
        const txState=ledger.read(tx.id)?.state||null;
        const journal=inspectNexusCommitJournal().find(row=>String(row.id)===String(tx.id))||null;
        const recoveryRequired=String(journal?.state||'')==='recovery-required'||journal?.recoveryDisposition==='recovery-required'||error?.recoveryRequired===true;
        try {
            const live=getProposalById(proposalId);
            if(error?.tv2ProposalAuditProjectionFailed===true||!auditProjectionDurable){
                if(live?.approvalClaim?.token===claimToken) await releaseProposalApprovalClaim(proposalId,claimToken,{status:'pending',error:error?.message||String(error),transactionId:null,transactionOwned:false,recovery:null});
            } else if(live?.transactionId===tx.id&&String(live?.status||'')==='committing') {
                updateProposalInStore(storeRef,proposalId,{approvalClaim:null,status:recoveryRequired?'recovery-required':'failed',error:`${error?.message||error}${recoveryRequired?` (recovery owned by Nexus transaction ${tx.id})`:''}`,transactionId:tx.id,transactionOwned:true,recovery:null});
                await flushProposalStorePersistence(storeRef);
            }
        } catch(flushError){logEvent('proposals','failure-state-flush-failed',{proposalId,transactionId:tx.id,error:flushError,originalError:error},'error');}
        logEvent('proposals','execution-failed',{proposalId,transactionId:tx.id,op:proposal.op,error,recoveryRequired,txState},'error');
        return {ok:false,transactionId:tx.id,recoveryRequired,error:error?.message||String(error),proposal:getProposalById(proposalId)};
    }

    if(committed.state==='stale'){
        try{updateProposalInStore(storeRef,proposalId,{claimToken,approvalClaim:null,status:'failed',error:committed.error||'Proposal became stale before mutation.',transactionId:tx.id,transactionOwned:true,recovery:null});await flushProposalStorePersistence(storeRef);}catch(flushError){logEvent('proposals','stale-state-flush-failed',{proposalId,transactionId:tx.id,error:flushError},'error');}
        return {ok:false,stale:true,transactionId:tx.id,proposal:getProposalById(proposalId),error:committed.error||'Proposal became stale.'};
    }

    const resultText=committed?.committed?.result?.message||committed?.committed?.result?.result?.message||`${proposal.op?.type||'Mutation'} committed.`;
    let auditPersistenceError='';
    try{updateProposalInStore(storeRef,proposalId,{claimToken,approvalClaim:null,status:'approved',result:String(resultText),error:'',transactionId:tx.id,transactionOwned:true,recovery:null});await flushProposalStorePersistence(storeRef);}
    catch(error){auditPersistenceError=error?.message||String(error);logEvent('proposals','post-commit-audit-persistence-degraded',{proposalId,transactionId:tx.id,error},'error');}
    logEvent('proposals','execution-approved',{proposalId,transactionId:tx.id,op:proposal.op,chatId:context?.chatId??null,auditPersistenceDegraded:!!auditPersistenceError},auditPersistenceError?'warn':'info');
    let summaryDigestCleanup=null;
    const parentTransactionId=String(proposal?.execution?.parentTransactionId||'').trim();
    if(parentTransactionId&&!auditPersistenceError){
        try{summaryDigestCleanup=await settleDigestedSummaryAfterLoreChildren(parentTransactionId,{reason:'digested-to-lore-proposals'});}
        catch(error){logEvent('proposals','summary-digest-cleanup-degraded',{proposalId,parentTransactionId,error:error?.message||String(error)},'warn');}
    }
    return {ok:true,transactionId:tx.id,result:resultText,recoveryDescriptor:deepCopy(committed?.recoveryDescriptor||null),auditPersistenceDegraded:!!auditPersistenceError,auditPersistenceError,summaryDigestCleanup,proposal:getProposalById(proposalId)};
}

/**
 * Legacy pre-unification Proposal recovery only. New transaction-owned proposals
 * never carry their own recovery authority. Restoring legacy state is itself a
 * new Ledger-owned inverse mutation rather than a privileged direct write.
 */
export async function restoreProposalPreMutationState(proposalId, { actor = 'operator-recovery', surface = 'lore-proposals-recovery' } = {}) {
    const storeRef = captureProposalStore(true);
    const proposal = getProposalsFromStore(storeRef, 'all').find(p => p.id === proposalId);
    if (!proposal) throw new Error(`Proposal ${proposalId} was not found.`);
    if (proposal.transactionOwned === true || proposal.transactionId) {
        throw new Error(`Proposal ${proposalId} recovery is owned by Nexus transaction ${proposal.transactionId || 'unknown'}. Use Diagnostics → Commit recovery.`);
    }
    if (String(proposal.status || '') !== 'recovery-required') throw new Error(`Proposal ${proposalId} is ${proposal.status || 'unknown'}; legacy recovery is allowed only after it enters recovery-required.`);
    const snapshot = proposal.recovery;
    if (!snapshot) throw new Error(`Proposal ${proposalId} has no durable pre-mutation recovery state.`);

    const inspection = await inspectMutationRecoveryState(snapshot, { context: storeRef.context });
    if (inspection.state === 'pre') {
        updateProposalInStore(storeRef, proposalId, { status: 'failed', result: '', error: 'Legacy proposal recovery reconciled: canonical state already matches the known pre-mutation state.', recovery: null });
        await flushProposalStorePersistence(storeRef);
        return { ok: true, restored: false, alreadyPre: true };
    }
    if (!inspection.compatible || inspection.state !== 'post') {
        const error = new Error('Legacy proposal recovery cannot be restored automatically because canonical state no longer matches its known post-state.');
        error.name = 'TV2RecoveryConflict';
        throw error;
    }

    const inverse = await commitRecoveryInverse(snapshot, { by: String(actor || 'operator-recovery'), sourceProposalId: proposalId, context: storeRef.context });
    const physicallyRestored = inverse.state === 'committed';
    if (!physicallyRestored) throw new Error(`Legacy recovery inverse transaction ${inverse.id} did not commit.`);
    updateProposalInStore(storeRef, proposalId, { status: 'failed', result: '', error: `Legacy proposal recovery restored through inverse transaction ${inverse.id}.`, recovery: null });
    let auditPersistenceError = '';
    try { await flushProposalStorePersistence(storeRef); }
    catch (error) {
        // The inverse canonical mutation already committed. Proposal audit
        // persistence is secondary and may degrade, but it cannot make callers
        // retry the physical inverse or report that the restore failed.
        auditPersistenceError = String(error?.message || error);
        logEvent('proposals', 'recovery-audit-persistence-degraded', { proposalId, inverseTransactionId: inverse.id, error }, 'error');
    }
    logEvent('proposals', 'recovery-restored', { proposalId, inverseTransactionId: inverse.id, op: proposal.op, actor, surface, auditPersistenceDegraded: !!auditPersistenceError }, auditPersistenceError ? 'warn' : 'info');
    return { ok: true, restored: true, transactionId: inverse.id, auditPersistenceDegraded: !!auditPersistenceError, auditPersistenceError };
}
