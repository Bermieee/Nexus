import { captureProposalStore, getProposalsFromStore, settleProposalForParentRollback } from '../proposals/store.js';
import { getLoreWriteLedger, getLoreWriteReceipts, rollbackDirectWrite } from '../lore/write-valve.js';
import { normalizePostTurnBacklog, postTurnMessageKeyMatches } from './reconstructible-backlog.js';
import { getPostTurnParentSagas, updatePostTurnParentSaga, resolvePostTurnParentSaga } from './parent-saga.js';
import { fingerprintValue } from '../nexus/integrity.js';

const BACKLOG_KEY='tv2_postturn_backlog';
const clone=v=>v==null?v:JSON.parse(JSON.stringify(v));
function same(a,b){try{return JSON.stringify(a)===JSON.stringify(b);}catch{return false;}}
function proposalParent(row){return String(row?.execution?.parentTransactionId||'');}
function normalizedBacklog(context,value){return normalizePostTurnBacklog(value,{chat:context?.chat||[],chatId:context?.chatId||''});}

function sourceRangeProof(context,saga,current,post){
    const range=Array.isArray(saga?.sourceRange)?saga.sourceRange.map(Number):[];
    if(range.length<2||!Number.isInteger(range[0])||!Number.isInteger(range[1])||range[0]<0||range[1]<range[0])return {ok:false,reason:'invalid-source-range'};
    const [start,end]=range,chat=context?.chat||[],chatId=context?.chatId||saga?.chatId||'';
    if(end>=chat.length)return {ok:false,reason:'source-range-not-loaded'};
    const rows=Array.isArray(saga?.sourceEligibility)?saga.sourceEligibility:[];
    if(!rows.length)return {ok:false,reason:'source-authority-missing'};
    for(const row of rows){
        const index=Number(row?.index);if(!Number.isInteger(index)||index<start||index>end)return {ok:false,reason:'source-authority-range-mismatch'};
        const message=chat[index],key=String(row?.authorityKey||'');if(!message||!key||!postTurnMessageKeyMatches(key,chatId,index,message))return {ok:false,reason:'source-authority-changed',index};
    }
    const postFence=Number(post?.processedThrough);if(!Number.isInteger(postFence)||postFence<end)return {ok:false,reason:'post-fence-incomplete'};
    const currentFence=Number(current?.processedThrough);if(!Number.isInteger(currentFence)||currentFence<postFence)return {ok:false,reason:'current-fence-before-post'};
    const pendingIds=new Set((current?.pendingMessageIds||[]).map(String));
    for(const row of rows){if(row?.eligible!==true)continue;const id=String(row?.messageId||'');if(id&&pendingIds.has(id))return {ok:false,reason:'source-message-still-pending',messageId:id};}
    const pendingStart=current?.pendingStart!=null&&Number.isInteger(Number(current.pendingStart))?Number(current.pendingStart):null,pendingEnd=current?.pendingEnd!=null&&Number.isInteger(Number(current.pendingEnd))?Number(current.pendingEnd):null;
    if(pendingStart!==null&&pendingEnd!==null&&pendingStart<=end&&pendingEnd>=start)return {ok:false,reason:'source-range-overlaps-pending'};
    return {ok:true,start,end,postFence,currentFence};
}


function sourceMessageIds(saga){
    return [...new Set((Array.isArray(saga?.sourceEligibility)?saga.sourceEligibility:[]).map(row=>String(row?.messageId||'').trim()).filter(Boolean))];
}
function recoveryEvidenceFingerprint({saga,current,pre,post,verification,sourceProof}){
    const ownedIds=new Set(sourceMessageIds(saga));
    const currentPending=(current?.pendingMessageIds||[]).map(String).filter(id=>ownedIds.has(id)).sort();
    return fingerprintValue({
        transactionId:String(saga?.transactionId||''),
        sourceRange:Array.isArray(saga?.sourceRange)?saga.sourceRange.map(Number):[],
        sourceAuthority:(saga?.sourceEligibility||[]).map(row=>({index:Number(row?.index),messageId:String(row?.messageId||''),eligible:row?.eligible===true,authorityKey:String(row?.authorityKey||'')})),
        preFence:Number(pre?.processedThrough??-1),
        postFence:Number(post?.processedThrough??-1),
        currentFence:Number(current?.processedThrough??-1),
        currentPendingOwnedIds:currentPending,
        childOk:verification?.ok===true,
        childProblems:verification?.problems||[],
        proposalIds:[...(verification?.proposalIds||[])].sort(),
        directWriteIds:[...(verification?.directWriteIds||[])].sort(),
        sourceProof:sourceProof||null,
    });
}
function quarantineResult(saga,{reason,sourceProof,evidenceFingerprint,newlyQuarantined=false}){
    return {
        transactionId:String(saga?.transactionId||''),
        state:'quarantined',
        reason,
        sourceProof:sourceProof||null,
        evidenceFingerprint,
        newlyQuarantined,
        sourceRange:Array.isArray(saga?.sourceRange)?saga.sourceRange.map(Number):[],
        sourceMessageIds:sourceMessageIds(saga),
    };
}

function verifyCommittedChildren(saga,proposals,writes,receipts){
    const parent=String(saga.transactionId),proposalMap=new Map(proposals.map(p=>[String(p.id),p])),writeMap=new Map(writes.map(w=>[String(w.id),w])),receiptMap=new Map(receipts.map(w=>[String(w.id),w]));
    const proposalIds=[...new Set([...(saga.proposalIds||[]),...proposals.filter(p=>proposalParent(p)===parent).map(p=>String(p.id))])];
    const directWriteIds=[...new Set([...(saga.directWriteIds||[]),...writes.filter(w=>String(w?.parentTransactionId||'')===parent).map(w=>String(w.id)),...receipts.filter(w=>String(w?.parentTransactionId||'')===parent).map(w=>String(w.id))])];
    const problems=[];
    for(const id of proposalIds){const p=proposalMap.get(id);if(!p)problems.push({kind:'proposal',id,reason:'missing'});else if(proposalParent(p)!==parent)problems.push({kind:'proposal',id,reason:'ownership-mismatch'});else if(!['pending','approved'].includes(String(p.status||'')))problems.push({kind:'proposal',id,reason:'incomplete',status:p.status});}
    for(const id of directWriteIds){const w=writeMap.get(id),r=receiptMap.get(id);if(w){if(String(w.parentTransactionId||'')!==parent)problems.push({kind:'direct-write',id,reason:'ownership-mismatch'});else if(!['applied','applied-audit-degraded'].includes(String(w.state||'')))problems.push({kind:'direct-write',id,reason:'not-applied',state:w.state});}else if(r){if(String(r.parentTransactionId||'')!==parent||String(r.state||'')!=='archived-applied')problems.push({kind:'direct-write',id,reason:'invalid-receipt'});}else problems.push({kind:'direct-write',id,reason:'missing'});}
    return {ok:!problems.length,proposalIds,directWriteIds,problems};
}
export async function reconcilePostTurnParentSagas(context){
    const sagas=getPostTurnParentSagas({context,unresolvedOnly:true});if(!sagas.length)return[];
    let ref,proposals,writes,receipts;
    try{ref=captureProposalStore(true);proposals=getProposalsFromStore(ref,'all');}
    catch(error){
        const results=[];
        for(const saga of sagas){
            try{await resolvePostTurnParentSaga(saga.transactionId,'recovery-required',{context,error:`Proposal audit unavailable: ${error?.message||error}`});}
            catch(settleError){results.push({transactionId:saga.transactionId,state:'recovery-required',reason:'proposal-audit-unavailable-and-settlement-failed',error:settleError?.message||String(settleError)});continue;}
            results.push({transactionId:saga.transactionId,state:'recovery-required',reason:'proposal-audit-unavailable',error:error?.message||String(error)});
        }
        return results;
    }
    try{writes=getLoreWriteLedger();receipts=getLoreWriteReceipts();}
    catch(error){for(const saga of sagas)try{await resolvePostTurnParentSaga(saga.transactionId,'recovery-required',{context,error:`Direct Write audit unavailable: ${error?.message||error}`});}catch{}return sagas.map(s=>({transactionId:s.transactionId,state:'recovery-required',reason:'direct-write-audit-unavailable'}));}
    const current=normalizedBacklog(context,clone(context?.chatMetadata?.[BACKLOG_KEY]));const results=[];
    for(const saga of sagas){
        const parent=String(saga.transactionId),verification=verifyCommittedChildren(saga,proposals,writes,receipts);
        const knownProposalIds=new Set((saga.proposalIds||[]).map(String)),knownDirectWriteIds=new Set((saga.directWriteIds||[]).map(String));
        const childDiscoveryChanged=verification.proposalIds.some(id=>!knownProposalIds.has(String(id)))||verification.directWriteIds.some(id=>!knownDirectWriteIds.has(String(id)));
        if(childDiscoveryChanged){try{await updatePostTurnParentSaga(parent,{proposalIds:verification.proposalIds,directWriteIds:verification.directWriteIds},{context});}catch(error){results.push({transactionId:parent,state:'recovery-required',reason:'child-discovery-persistence-failed',error:error?.message||String(error)});continue;}}
        const pre=normalizedBacklog(context,saga.preBacklog),post=saga.postBacklog?normalizedBacklog(context,saga.postBacklog):null;
        if(post&&same(current,post)){
            if(!verification.ok){await resolvePostTurnParentSaga(parent,'recovery-required',{context,error:`Committed parent child settlement incomplete: ${JSON.stringify(verification.problems)}`});results.push({transactionId:parent,state:'recovery-required',reason:'child-settlement-incomplete',problems:verification.problems});continue;}
            try{await resolvePostTurnParentSaga(parent,'committed',{context});results.push({transactionId:parent,state:'committed-reconciled'});}catch(error){results.push({transactionId:parent,state:'committed-audit-degraded',error:error?.message||String(error)});}continue;
        }
        if(post&&!same(current,pre)){
            // HOTFIX44: the global backlog is a moving aggregate. A later valid
            // Post-turn drain may advance it beyond this parent's exact POST
            // snapshot. Resolve the old parent only when its exact source range
            // still matches captured message authority, its children are proven
            // settled, and the current backlog proves that range remains consumed.
            const proof=sourceRangeProof(context,saga,current,post);
            if(proof.ok){
                if(!verification.ok){await resolvePostTurnParentSaga(parent,'recovery-required',{context,error:`Advanced backlog proves the source range consumed but child settlement is incomplete: ${JSON.stringify(verification.problems)}`});results.push({transactionId:parent,state:'recovery-required',reason:'child-settlement-incomplete',problems:verification.problems,sourceProof:proof});continue;}
                try{await resolvePostTurnParentSaga(parent,'committed',{context});results.push({transactionId:parent,state:'committed-reconciled-advanced-backlog',sourceProof:proof});}catch(error){results.push({transactionId:parent,state:'committed-audit-degraded',reason:'advanced-backlog',sourceProof:proof,error:error?.message||String(error)});}continue;
            }
        }
        if(same(current,pre)){
            const failures=[];
            const physicallySettledProposals=new Set();
            for(const id of [...verification.directWriteIds].reverse())try{const row=await rollbackDirectWrite(id,{context,expectedParentTransactionId:parent,idempotent:true});if(row?.proposalId)physicallySettledProposals.add(String(row.proposalId));}catch(error){failures.push({kind:'direct-write',id,message:error?.message||String(error),name:error?.name||'Error'});}
            for(const id of verification.proposalIds)try{const settled=await settleProposalForParentRollback(id,{parentTransactionId:parent,reason:'Recovered interrupted Post-turn parent before backlog commit.',ref,physicalRollbackProven:physicallySettledProposals.has(String(id))});if(settled?.recoveryRequired)failures.push({kind:'proposal',id,message:settled.reason||'proposal recovery required',status:settled.status||null});}catch(error){failures.push({kind:'proposal',id,message:error?.message||String(error),name:error?.name||'Error'});}
            try{await resolvePostTurnParentSaga(parent,failures.length?'recovery-required':'rolled-back',{context,error:failures.length?JSON.stringify(failures):''});}catch(error){failures.push({kind:'saga-settlement',message:error?.message||String(error)});}
            results.push({transactionId:parent,state:failures.length?'recovery-required':'rolled-back',rollbackFailures:failures});continue;
        }
        const divergenceProof=post?sourceRangeProof(context,saga,current,post):{ok:false,reason:'post-backlog-missing'};
        const canQuarantine=Array.isArray(saga?.sourceRange)&&saga.sourceRange.length>=2&&sourceMessageIds(saga).length>0&&verification.ok===true;
        if(canQuarantine){
            const evidenceFingerprint=recoveryEvidenceFingerprint({saga,current,pre,post,verification,sourceProof:divergenceProof});
            const priorFingerprint=String(saga?.recoveryQuarantine?.evidenceFingerprint||'');
            if(String(saga?.state||'')==='recovery-required'&&priorFingerprint===evidenceFingerprint){
                results.push(quarantineResult(saga,{reason:'recovery-evidence-unchanged',sourceProof:divergenceProof,evidenceFingerprint,newlyQuarantined:false}));
                continue;
            }
            const recoveryQuarantine={
                version:1,
                evidenceFingerprint,
                reason:'backlog-state-diverged',
                sourceProof:clone(divergenceProof),
                sourceRange:Array.isArray(saga.sourceRange)?saga.sourceRange.map(Number):[],
                sourceMessageIds:sourceMessageIds(saga),
                quarantinedAt:Number(saga?.recoveryQuarantine?.quarantinedAt)||Date.now(),
                evidenceChangedAt:Date.now(),
            };
            await updatePostTurnParentSaga(parent,{state:'recovery-required',recoveryQuarantine,error:`Post-turn parent is quarantined to its exact source range because the backlog matches neither parent pre-state nor a provably advanced post-state (${divergenceProof.reason||'unproven'}).`},{context});
            results.push(quarantineResult({...saga,recoveryQuarantine},{reason:'backlog-state-diverged',sourceProof:divergenceProof,evidenceFingerprint,newlyQuarantined:true}));
            continue;
        }
        await resolvePostTurnParentSaga(parent,'recovery-required',{context,error:`Post-turn backlog matches neither parent pre-state nor a provably advanced post-state (${divergenceProof.reason||'unproven'}).`});results.push({transactionId:parent,state:'recovery-required',reason:'backlog-state-diverged',sourceProof:divergenceProof,sourceRange:Array.isArray(saga?.sourceRange)?saga.sourceRange.map(Number):[],sourceMessageIds:sourceMessageIds(saga)});
    }
    return results;
}
