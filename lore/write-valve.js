import { getContext } from '../../../../st-context.js';
import { getSettings, getAuthoritySettingsStatus } from '../core/settings.js';
import { clone } from './store.js';
import { approveProposal } from '../proposals/executor.js';
import { getProposalById, projectProposalRollback, rejectProposal, releaseProposalApprovalClaim } from '../proposals/store.js';
import { logEvent } from '../observability/telemetry.js';
import { inspectMutationRecoveryState } from '../nexus/mutation-recovery.js';
import { commitRecoveryInverse } from '../nexus/mutation-coordinator.js';
import { getNexusLedger, inspectNexusCommitRecovery, inspectNexusCommitJournal } from '../nexus/transaction-service.js';
import { flushChatMetadataPersistence } from '../nexus/host-durability.js';
import { registerNexusRecoveryProjector } from '../nexus/recovery-projections.js';
import { fingerprintValue } from '../nexus/integrity.js';

const KEY='tv2_lore_write_ledger_v1';const RECEIPT_KEY='tv2_lore_write_receipts_v1';const LIMIT=120;const RECEIPT_LIMIT=1000;
function directWriteCorrupt(message,value=null){const error=new Error(message);error.name='TV2DirectWriteStoreCorrupt';error.rawValue=clone(value);return error;}
function validateDirectWriteRows(value,{receipts=false}={}){if(!Array.isArray(value))throw directWriteCorrupt(`Nexus Direct Write ${receipts?'receipt archive':'audit ledger'} is present but is not an array.`,value);const ids=new Set();for(const row of value){if(!row||typeof row!=='object'||Array.isArray(row))throw directWriteCorrupt(`Nexus Direct Write ${receipts?'receipt archive':'audit ledger'} contains a malformed row.`,value);const id=String(row.id||'').trim();if(!id||ids.has(id))throw directWriteCorrupt(`Nexus Direct Write ${receipts?'receipt archive':'audit ledger'} contains a missing or duplicate identity.`,value);ids.add(id);if(!receipts&&(!row.operation||typeof row.operation!=='object'||Array.isArray(row.operation)))throw directWriteCorrupt(`Nexus Direct Write ${id} has a malformed operation.`,value);if(receipts&&String(row.state||'')!=='archived-applied')throw directWriteCorrupt(`Nexus Direct Write receipt ${id} has an unsupported state.`,value);}return value;}
function ledger(ctx=getContext()){if(!ctx?.chatMetadata)throw new Error('No active chat metadata is available.');for(const [key,receipts] of [[KEY,false],[RECEIPT_KEY,true]]){if(!Object.prototype.hasOwnProperty.call(ctx.chatMetadata,key))ctx.chatMetadata[key]=[];else validateDirectWriteRows(ctx.chatMetadata[key],{receipts});}return {ctx,rows:ctx.chatMetadata[KEY],receipts:ctx.chatMetadata[RECEIPT_KEY]};}
async function save(ctx,{flush=false,label='Nexus direct-write audit'}={}){if(flush)await flushChatMetadataPersistence(ctx,label,{keys:[KEY,RECEIPT_KEY]});else{try{ctx?.saveMetadataDebounced?.();}catch{}}try{window.dispatchEvent(new CustomEvent('tv2-lore-write-ledger-updated'));}catch{}}
function makeId(){return `tv2_write_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;}
function parentTerminal(parentTransactionId){if(!parentTransactionId)return true;const state=String(getNexusLedger().read(String(parentTransactionId))?.state||'');return ['committed','stale','aborted','failed','cancelled'].includes(state);}
function completeRecovery(row){return !!row?.recovery&&Number(row.recovery?.version)>=2&&!!String(row.transactionId||'');}
function compactReceipt(row){return {id:String(row.id),at:Number(row.at)||0,book:String(row.book||''),proposalId:row.proposalId||null,transactionId:row.transactionId||null,parentTransactionId:row.parentTransactionId||null,source:String(row.source||''),operationType:String(row.operation?.type||''),state:'archived-applied',originalState:String(row.state||'applied'),appliedAt:Number(row.appliedAt)||0,archivedAt:Date.now(),undone:false,auditDegraded:String(row.state||'')==='applied-audit-degraded',error:String(row.error||'').slice(0,1000),recoveryFingerprint:row.recovery?fingerprintValue(row.recovery):null,recoveryChars:Number(row.recovery?.serializedChars)||null};}
export function compactDirectWriteLedger(rows,receipts=[]){
    while(rows.length>LIMIT){
        let idx=rows.findIndex(r=>r.undone===true||['failed','reconciled-not-applied','rolled-back'].includes(String(r.state||'')));
        if(idx<0)idx=rows.findIndex(r=>['applied','applied-audit-degraded'].includes(String(r.state||''))&&!r.rollbackConflict&&completeRecovery(r)&&parentTerminal(r.parentTransactionId));
        if(idx<0)break;
        const candidate=rows[idx];
        const archivesApplied=candidate&&!candidate.undone&&['applied','applied-audit-degraded'].includes(String(candidate.state||''));
        if(archivesApplied&&receipts.length>=RECEIPT_LIMIT){
            const error=new Error(`Nexus Direct Write audit archive reached its ${RECEIPT_LIMIT}-receipt safety capacity. Export/retain the audit before compacting more applied writes; no receipt was deleted.`);
            error.name='TV2DirectWriteAuditCapacityExceeded';
            throw error;
        }
        const [removed]=rows.splice(idx,1);
        if(removed&&!removed.undone&&['applied','applied-audit-degraded'].includes(String(removed.state||'')))receipts.push(compactReceipt(removed));
    }
    if(receipts.length>RECEIPT_LIMIT){const error=new Error(`Nexus Direct Write audit archive exceeds its ${RECEIPT_LIMIT}-receipt safety capacity; automatic evidence deletion is forbidden.`);error.name='TV2DirectWriteAuditCapacityExceeded';throw error;}
}
function ensureCapacity(rows,receipts){compactDirectWriteLedger(rows,receipts);if(rows.length>=LIMIT){const error=new Error(`Nexus Direct Write ledger reached its ${LIMIT}-row unresolved/reversible safety bound. Resolve or export existing authority before admitting another direct mutation.`);error.name='TV2DirectWriteBackpressure';throw error;}}

export function writeValveMode(book=''){if(getAuthoritySettingsStatus().status!=='ready')return 'disabled';const cfg=getSettings().loreWriteValve||{};const raw=String(cfg.books?.[book]??cfg.mode??'review');return ['review','direct','disabled'].includes(raw)?raw:'disabled';}
export function directWritePolicySnapshot(book=''){return {book:String(book||''),mode:writeValveMode(book),capturedAt:Date.now()};}

export function getLoreWriteLedger(){return ledger().rows.map(clone).reverse();}
export function getLoreWriteReceipts(){return ledger().receipts.map(clone).reverse();}

/**
 * HOTFIX44: A pre-HOTFIX44 Summary->Lore parent can have physically committed
 * Direct Write children whose audit rows were later marked rollback-conflict
 * solely because terminal commit-journal compaction had already discarded the
 * large inverse descriptor.  That is not evidence that the child failed.
 *
 * Forward parent reconciliation is allowed to reclassify only that narrow
 * historical state after proving: exact parent ownership, an approved proposal,
 * and a terminal canonical child commit.  Canonical-conflict rollbacks remain
 * fenced (row.rollback.state === 'conflict'), and no recovery descriptor is
 * invented.  The result remains audit-degraded and non-reversible.
 */
export async function confirmDirectWriteParentForwardSettlement(writeIds=[],parentTransactionId=null,{context=null,note='Parent recovery forward-completed after canonical child commit was proven.'}={}){
    const ids=[...new Set((writeIds||[]).map(String).filter(Boolean))];
    if(!ids.length)return {ok:true,changed:0,proofs:[]};
    const parent=String(parentTransactionId||'');if(!parent)throw new Error('Forward Direct Write settlement requires an exact parent transaction.');
    const {ctx,rows,receipts}=ledger(context||getContext()),journal=inspectNexusCommitJournal();
    const proofs=[];let changed=0;
    const committedStates=new Set(['committed','applied','reconciled-confirmed-applied']);
    for(const id of ids){
        const row=rows.find(item=>String(item.id)===id);
        if(!row){
            const receipt=receipts.find(item=>String(item.id)===id);
            if(receipt&&String(receipt.parentTransactionId||'')===parent&&String(receipt.state||'')==='archived-applied'){proofs.push({id,kind:'receipt',state:'archived-applied',transactionId:receipt.transactionId||null});continue;}
            const error=new Error(`Direct Write ${id} cannot be forward-settled because its owned audit row/receipt is unavailable.`);error.name='TV2DirectWriteForwardSettlementUnproven';throw error;
        }
        if(String(row.parentTransactionId||'')!==parent){const error=new Error(`Direct Write ${id} is not owned by Summary-to-Lore parent ${parent}.`);error.name='TV2DirectWriteParentOwnershipMismatch';throw error;}
        if(row.undone===true||['rolled-back','reconciled-not-applied','failed'].includes(String(row.state||''))){const error=new Error(`Direct Write ${id} is ${row.state||'unknown'} and cannot prove a committed child effect.`);error.name='TV2DirectWriteForwardSettlementUnproven';throw error;}
        const txId=String(row.transactionId||'');const j=txId?journal.find(item=>String(item.id)===txId):null;
        if(!txId||!j||!committedStates.has(String(j.state||''))){const error=new Error(`Direct Write ${id} lacks terminal canonical commit proof.`);error.name='TV2DirectWriteForwardSettlementUnproven';throw error;}
        const proposal=row.proposalId?getProposalById(row.proposalId):null;
        if(row.proposalId&&(!proposal||String(proposal.status||'')!=='approved')){const error=new Error(`Direct Write ${id} proposal ${row.proposalId} is not durably approved.`);error.name='TV2DirectWriteForwardSettlementUnproven';throw error;}
        const state=String(row.state||'');
        if(state==='rollback-conflict'){
            // A real canonical divergence records rollback.state=conflict. Never
            // erase that evidence. The historical missing-descriptor bug did not.
            if(String(row.rollback?.state||'')==='conflict'){const error=new Error(`Direct Write ${id} has a canonical rollback conflict and cannot be auto-forward-settled.`);error.name='TV2RecoveryConflict';throw error;}
            row.state='applied-audit-degraded';row.rollbackConflict=false;row.rollbackConflictResolvedAt=Date.now();row.forwardSettlement={state:'canonical-child-proven',parentTransactionId:parent,resolvedAt:Date.now(),note:String(note||'')};row.error=[String(row.error||''),String(note||'')].filter(Boolean).join(' ').slice(0,2000);changed++;
        }else if(!['applied','applied-audit-degraded','applying','transaction-recovery'].includes(state)){const error=new Error(`Direct Write ${id} is ${state||'unknown'} and cannot be auto-forward-settled.`);error.name='TV2DirectWriteForwardSettlementUnproven';throw error;}
        else if(['applying','transaction-recovery'].includes(state)){row.state='applied-audit-degraded';row.forwardSettlement={state:'canonical-child-proven',parentTransactionId:parent,resolvedAt:Date.now(),note:String(note||'')};changed++;}
        proofs.push({id,kind:'row',state:row.state,transactionId:txId,journalState:String(j.state||''),proposalId:row.proposalId||null});
    }
    if(changed)await save(ctx,{flush:true,label:'Nexus direct-write forward settlement audit'});
    return {ok:true,changed,proofs};
}

/**
 * Direct mode changes review behavior only. It does not establish another
 * durable mutation owner: approveProposal() creates the single Ledger/journal
 * owner and this row is audit + optional inverse authority for Post-turn rollback.
 */
export async function routeOperation(proposal,{book,source='unknown',parentTransactionId=null}={}){
    if(proposal?.resolvedDuplicate===true)return {mode:'deduplicated',proposal,duplicateOf:proposal.duplicateOf||proposal.id};
    const mode=writeValveMode(book);
    if(mode==='review')return {mode:'review',proposal};
    if(mode==='disabled'){
        if(proposal?.id&&String(proposal.status||'pending')==='pending'){try{await rejectProposal(proposal.id,'Write Valve is disabled for this lorebook; no mutation was admitted.');}catch{}}
        return {mode:'disabled',proposal,skipped:true,reason:'Write Valve disabled'};
    }
    const {ctx,rows,receipts}=ledger();ensureCapacity(rows,receipts);
    const policyAtAdmission=directWritePolicySnapshot(book);
    const row={id:makeId(),at:Date.now(),book,proposalId:proposal.id,parentTransactionId:parentTransactionId?String(parentTransactionId):null,source,operation:clone(proposal.op),state:'applying',transactionId:null,recovery:null,result:null,error:'',undone:false,rollback:null,policyAtAdmission};
    rows.push(row);
    try{await save(ctx,{flush:true,label:'Nexus direct-write audit start'});}catch(error){const index=rows.indexOf(row);if(index>=0)rows.splice(index,1);throw error;}
    logEvent('lore','direct-write-audit-started',{writeId:row.id,book,proposalId:proposal.id,source,operation:proposal.op?.type,policyAtAdmission},'debug');

    let result;
    try{
        result=await approveProposal(proposal.id,{
            actor:'policy-direct',surface:'direct-write',actorMetadata:{source:String(source||'unknown'),writeId:row.id,parentTransactionId:row.parentTransactionId},
            preflight:()=>{const live=writeValveMode(book);if(live!=='direct'){const error=new Error(`Direct Write policy changed to ${live} before physical mutation.`);error.name='TV2MutationStale';error.tv2PreMutationStale=true;throw error;}},
            onTransactionStaged:async tx=>{row.transactionId=tx.id;row.state='applying';row.transactionLinkedAt=Date.now();await save(ctx,{flush:true,label:'Nexus direct-write transaction linkage'});},
        });
    }catch(error){row.state='failed';row.error=String(error?.message||error);row.failedAt=Date.now();try{await save(ctx,{flush:true,label:'Nexus direct-write failure audit'});}catch(flushError){logEvent('lore','direct-write-failure-audit-degraded',{writeId:row.id,proposalId:proposal.id,error:flushError,originalError:error},'error');}throw error;}
    row.transactionId=result?.transactionId||row.transactionId||null;
    if(!result?.ok){
        const unresolved=result?.recoveryRequired===true||(row.transactionId?inspectNexusCommitRecovery().some(item=>String(item.id)===String(row.transactionId)):false);
        row.state=unresolved?'transaction-recovery':'failed';row.error=String(result?.error||'Direct lore write failed.');row.failedAt=Date.now();
        try{await save(ctx,{flush:true,label:'Nexus direct-write failure audit'});}catch(flushError){logEvent('lore','direct-write-failure-audit-degraded',{writeId:row.id,proposalId:proposal.id,transactionId:row.transactionId,error:flushError},'error');}
        throw Object.assign(new Error(result?.error||'Direct lore write failed.'),{name:unresolved?'TV2DirectWriteRecoveryRequired':'TV2DirectWriteFailed',transactionId:row.transactionId});
    }

    const journalRow=row.transactionId?inspectNexusCommitJournal().find(item=>String(item.id)===String(row.transactionId)):null;
    row.recovery=clone(result?.recoveryDescriptor||journalRow?.recovery||null);row.result=result.result;row.appliedAt=Date.now();row.error='';row.policyAtCommit=directWritePolicySnapshot(book);
    let auditPersistenceError=String(result?.auditPersistenceError||'');
    if(!row.recovery){auditPersistenceError=[auditPersistenceError,'Canonical recovery descriptor was unavailable to the direct-write audit.'].filter(Boolean).join(' ');}
    row.state=auditPersistenceError?'applied-audit-degraded':'applied';
    if(auditPersistenceError)row.error=auditPersistenceError;
    compactDirectWriteLedger(rows,receipts);
    try{await save(ctx,{flush:true,label:'Nexus direct-write applied audit'});}catch(error){auditPersistenceError=[auditPersistenceError,error?.message||String(error)].filter(Boolean).join(' ');row.state='applied-audit-degraded';row.error=auditPersistenceError;logEvent('lore','direct-write-post-commit-audit-degraded',{writeId:row.id,book,proposalId:proposal.id,transactionId:row.transactionId,error},'error');}
    logEvent('lore','direct-write-applied',{writeId:row.id,book,proposalId:proposal.id,transactionId:row.transactionId,source,operation:proposal.op?.type,recoveryChars:row.recovery?.serializedChars??null,auditPersistenceDegraded:!!auditPersistenceError},auditPersistenceError?'warn':'info');
    return {mode:'direct',proposal,write:clone(row),auditPersistenceDegraded:!!auditPersistenceError,auditPersistenceError};
}

export async function projectDirectWriteRecoverySettlement(transactionId,{disposition='',note='',context=null}={}){
    const ctx=context||getContext();
    if(!ctx?.chatMetadata||!Object.prototype.hasOwnProperty.call(ctx.chatMetadata,KEY))return {changed:0};
    const state=ledger(ctx);const targets=state.rows.filter(row=>String(row?.transactionId||'')===String(transactionId)&&['applying','transaction-recovery','failed','rollback-conflict'].includes(String(row?.state||'')));
    if(!targets.length)return {changed:0};
    for(const row of targets){
        if(disposition==='confirmed-applied'){row.state='applied-audit-degraded';row.appliedAt=row.appliedAt||Date.now();row.error=String(note||'Canonical commit recovery confirmed this Direct Write was physically applied.');}
        else if(disposition==='superseded'){row.state='rolled-back';row.undone=true;row.undoneAt=row.undoneAt||Date.now();row.error=String(note||'Canonical recovery confirmed this Direct Write effect was superseded by a verified inverse.');}
        else{row.state='reconciled-not-applied';row.failedAt=row.failedAt||Date.now();row.error=String(note||`Canonical recovery disposition ${disposition} confirmed this Direct Write is not active.`);}
    }
    compactDirectWriteLedger(state.rows,state.receipts);await save(ctx,{flush:true,label:'Nexus direct-write canonical recovery projection'});return {changed:targets.length,disposition};
}
registerNexusRecoveryProjector('direct-write-audit',settlement=>projectDirectWriteRecoverySettlement(settlement.id,settlement));

function convertLegacyWholeBookRow(row){
    if(row?.recovery?.version===2)return row.recovery;
    if(row?.beforeBook===undefined||row?.beforeTree===undefined||row?.afterBook===undefined||row?.afterTree===undefined)return null;
    const recovery={version:2,kind:'legacy-whole-book',opType:'legacy.whole-book',book:String(row.book||''),capturedAt:Number(row.at)||Date.now(),preView:{book:clone(row.beforeBook),tree:clone(row.beforeTree)},postView:{book:clone(row.afterBook),tree:clone(row.afterTree)},convertedAt:Date.now()};
    row.recovery=recovery;
    delete row.beforeBook;delete row.beforeTree;delete row.afterBook;delete row.afterTree;
    row.legacyRecoveryConverted=true;
    return recovery;
}

export function isDirectWriteRollbackAvailable(row){return !!row&&!row.undone&&['applied','applied-audit-degraded'].includes(String(row.state||''))&&completeRecovery(row)&&!row.rollbackConflict&&parentTerminal(row.parentTransactionId);}
export function assertDirectWritesActive(writeIds=[],parentTransactionId=null){const {rows}=ledger();for(const id of writeIds||[]){const row=rows.find(x=>String(x.id)===String(id));if(!row||row.undone||!['applied','applied-audit-degraded'].includes(String(row.state||''))||String(row.parentTransactionId||'')!==String(parentTransactionId||'')){const error=new Error(`Direct Write ${id} is no longer an active child of transaction ${parentTransactionId||'none'}.`);error.name='TV2MutationStale';error.tv2PreMutationStale=true;throw error;}}return true;}

export async function reconcileDirectWriteLedgerOnStartup(context=null){
    const state=ledger(context||getContext()),journal=inspectNexusCommitJournal();let changed=0;
    for(const row of state.rows){
        if(!['applying','transaction-recovery','applied-audit-degraded','rollback-committing'].includes(String(row.state||'')))continue;
        const proposal=row.proposalId?getProposalById(row.proposalId):null;
        if(!row.transactionId&&proposal?.transactionId){row.transactionId=String(proposal.transactionId);changed++;}
        const j=row.transactionId?journal.find(item=>String(item.id)===String(row.transactionId)):null;
        const js=String(j?.state||'');
        if(['committed','applied','reconciled-confirmed-applied'].includes(js)){
            row.recovery=clone(j?.recovery||row.recovery||null);row.state='applied-audit-degraded';row.appliedAt=row.appliedAt||Number(j?.resolvedAt)||Date.now();row.error=String(row.error||'Startup reconciliation confirmed canonical mutation applied.');changed++;continue;
        }
        if(js==='recovery-required'){row.recovery=clone(j?.recovery||row.recovery||null);row.state='transaction-recovery';row.error=String(j?.error||'Canonical mutation requires recovery reconciliation.');changed++;continue;}
        if(['failed','reconciled-confirmed-not-applied','reconciled-abandoned'].includes(js)){row.state='reconciled-not-applied';row.failedAt=row.failedAt||Date.now();row.error=String(j?.error||'Startup reconciliation confirmed canonical mutation not active.');changed++;continue;}
        if(js==='reconciled-superseded'){row.state='rolled-back';row.undone=true;row.undoneAt=row.undoneAt||Date.now();row.error=String(j?.recoveryNote||'Startup reconciliation confirmed canonical mutation was superseded by inverse.');changed++;continue;}
        if(String(row.state||'')==='applying'&&!row.transactionId){
            // The audit start persisted before a canonical transaction was linked;
            // therefore no durable mutation intent can belong to this row.
            row.state='reconciled-not-applied';row.failedAt=row.failedAt||Date.now();row.error='Startup reconciliation found no linked canonical transaction; direct mutation was not admitted.';changed++;
            if(proposal?.approvalClaim?.token){try{await releaseProposalApprovalClaim(proposal.id,proposal.approvalClaim.token,{error:'Interrupted approval claim released during Direct Write startup reconciliation.'});}catch{}}
        }
    }
    if(changed){compactDirectWriteLedger(state.rows,state.receipts);await save(state.ctx,{flush:true,label:'Nexus direct-write startup reconciliation'});}
    return {changed};
}

export async function rollbackDirectWrite(writeId,{context=null,allowUnresolvedParent=false,source='operator',expectedParentTransactionId=null,idempotent=false,actor='operator-recovery'}={}){
    const {ctx,rows,receipts}=ledger(context||getContext()),row=rows.find(x=>x.id===String(writeId));
    if(!row){const receipt=receipts.find(x=>x.id===String(writeId));if(receipt){const error=new Error('This Direct Write has aged out of the hot rollback window and remains as an immutable audit receipt.');error.name='TV2DirectWriteReceiptArchived';throw error;}throw new Error('Direct-write ledger entry was not found.');}
    if(expectedParentTransactionId!=null&&String(row.parentTransactionId||'')!==String(expectedParentTransactionId||'')){const error=new Error(`Direct-write ${writeId} is not owned by parent ${expectedParentTransactionId}.`);error.name='TV2DirectWriteParentOwnershipMismatch';throw error;}
    if(row.undone){if(idempotent)return clone(row);throw new Error('This direct write was already rolled back.');}
    if(!['applied','applied-audit-degraded'].includes(String(row.state||''))){const error=new Error(`Direct Write ${writeId} is ${row.state||'unknown'} and is not presently reversible.`);error.name='TV2DirectWriteRollbackUnavailable';throw error;}
    if(row.parentTransactionId&&!allowUnresolvedParent&&!parentTerminal(row.parentTransactionId)){const error=new Error(`Direct Write ${writeId} belongs to unresolved parent transaction ${row.parentTransactionId}; rollback is fenced until the parent settles.`);error.name='TV2DirectWriteParentUnresolved';throw error;}
    let recovery=convertLegacyWholeBookRow(row);
    if(!recovery&&row.transactionId){const journalRow=inspectNexusCommitJournal().find(item=>String(item.id)===String(row.transactionId));if(journalRow?.recovery){recovery=clone(journalRow.recovery);row.recovery=clone(recovery);}}
    if(!recovery){row.state='rollback-conflict';row.rollbackConflict=true;row.rollbackConflictAt=Date.now();await save(ctx,{flush:true,label:'Nexus direct-write rollback audit'});throw new Error('Direct-write rollback requires manual reconciliation: no complete modern or convertible legacy recovery descriptor exists.');}
    row.state='rollback-committing';row.rollback={state:'committing',source:String(source||'operator'),startedAt:Date.now()};await save(ctx,{flush:true,label:'Nexus direct-write rollback claim'});

    const inspection=await inspectMutationRecoveryState(recovery,{context:ctx});
    if(inspection.state==='pre'){
        row.undone=true;row.undoneAt=Date.now();row.state='reconciled-not-applied';row.rollback={...(row.rollback||{}),state:'confirmed-pre',resolvedAt:Date.now()};row.rollbackConflict=false;compactDirectWriteLedger(rows,receipts);await save(ctx,{flush:true,label:'Nexus direct-write rollback audit'});
        return clone(row);
    }
    if(!inspection.compatible||inspection.state!=='post'){
        row.rollbackConflict=true;row.rollbackConflictAt=Date.now();row.state='rollback-conflict';row.rollback={...(row.rollback||{}),state:'conflict',resolvedAt:Date.now()};await save(ctx,{flush:true,label:'Nexus direct-write rollback audit'});
        const error=new Error('Direct-write rollback refused: canonical state diverged from the write\'s known post-state.');error.name='TV2RecoveryConflict';throw error;
    }
    let inverse;
    try{inverse=await commitRecoveryInverse(recovery,{by:String(actor||'operator-recovery'),sourceTransactionId:row.transactionId||null,sourceProposalId:row.proposalId||null,context:ctx});}
    catch(error){row.state='applied-audit-degraded';row.rollback={...(row.rollback||{}),state:'failed-before-inverse-commit',error:String(error?.message||error),resolvedAt:Date.now()};try{await save(ctx,{flush:true,label:'Nexus direct-write rollback failure audit'});}catch{}throw error;}
    if(inverse.state!=='committed'){row.state='applied-audit-degraded';throw new Error(`Recovery inverse transaction ${inverse.id} did not commit.`);}
    row.undone=true;row.undoneAt=Date.now();row.state='rolled-back';row.rollbackConflict=false;row.inverseTransactionId=inverse.id;row.rollback={...(row.rollback||{}),state:'committed',inverseTransactionId:inverse.id,resolvedAt:Date.now()};
    let projectionError='',auditPersistenceError='';
    if(row.proposalId){try{await projectProposalRollback(row.proposalId,{inverseTransactionId:inverse.id,writeId:row.id,note:`Direct Write reversed through canonical inverse ${inverse.id}.`});}catch(error){projectionError=String(error?.message||error);row.error=[row.error,`Proposal rollback projection degraded: ${projectionError}`].filter(Boolean).join(' ');}}
    compactDirectWriteLedger(rows,receipts);
    try{await save(ctx,{flush:true,label:'Nexus direct-write rollback audit'});}catch(error){auditPersistenceError=String(error?.message||error);row.error=[row.error,`Rollback audit persistence degraded: ${auditPersistenceError}`].filter(Boolean).join(' ');logEvent('lore','direct-write-rollback-audit-degraded',{writeId:row.id,inverseTransactionId:inverse.id,error},'error');}
    logEvent('lore','direct-write-rolled-back',{writeId:row.id,book:row.book,proposalId:row.proposalId,inverseTransactionId:inverse.id,actor:String(actor||'operator-recovery'),legacyConverted:row.legacyRecoveryConverted===true,projectionDegraded:!!projectionError,auditPersistenceDegraded:!!auditPersistenceError},projectionError||auditPersistenceError?'warn':'warn');
    return {...clone(row),rollbackCommitted:true,auditPersistenceDegraded:!!auditPersistenceError,auditPersistenceError,proposalProjectionDegraded:!!projectionError,proposalProjectionError:projectionError};
}

