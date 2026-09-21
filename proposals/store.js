import { getContext } from '../../../../st-context.js';
import { validateOp } from './types.js';
import { logEvent } from '../observability/telemetry.js';
import { estimateContentTokens } from '../observability/token-estimator.js';
import { getNexusCommitJournal } from '../nexus/commit-journal.js';
import { prepareNexusCommitRecoverySettlement, reconcileNexusCommitRecovery } from '../nexus/transaction-service.js';
import { getSettings, flushSettingsPersistence } from '../core/settings.js';
import { registerNexusRecoveryProjector } from '../nexus/recovery-projections.js';
import { fingerprintValue, stableStringify } from '../nexus/integrity.js';

// HOTFIX32: Proposal review is Nexus-global. The legacy chat-metadata keys are
// read only for one-way migration when an old chat is opened.
const LEGACY_KEY = 'tv2_lore_proposals_v1';
const LEGACY_RECEIPT_KEY = 'tv2_lore_proposal_receipts_v1';
const GLOBAL_KEY = 'loreProposalInbox';
const GLOBAL_VERSION = 1;
const LIMIT = 500;
const RECEIPT_LIMIT = 4096;
const MAX_UNRESOLVED = 1000; // explicit backpressure; unresolved authority is never silently evicted
const CHANGE_EVENT = 'tv2:lore-proposals-changed';
const UNRESOLVED = new Set(['pending', 'committing', 'recovery-required']);
const PROPOSAL_STATES = new Set(['pending','committing','recovery-required','approved','rejected','failed','reverted']);
function proposalStoreCorrupt(message, value = null) { const error = new Error(message); error.name = 'TV2ProposalStoreCorrupt'; error.rawValue = clone(value); return error; }
function validateProposalRows(value) {
    if (!Array.isArray(value)) throw proposalStoreCorrupt('Nexus Lore Proposal metadata is present but is not an array.', value);
    const ids = new Set();
    for (const row of value) {
        if (!row || typeof row !== 'object' || Array.isArray(row)) throw proposalStoreCorrupt('Nexus Lore Proposal metadata contains a malformed row.', value);
        const rid = String(row.id || '').trim();
        if (!rid || ids.has(rid)) throw proposalStoreCorrupt('Nexus Lore Proposal metadata contains a missing or duplicate proposal identity.', value);
        ids.add(rid);
        if (!PROPOSAL_STATES.has(String(row.status || ''))) throw proposalStoreCorrupt(`Nexus Lore Proposal ${rid} has an unsupported status.`, value);
        if (!row.op || typeof row.op !== 'object' || Array.isArray(row.op)) throw proposalStoreCorrupt(`Nexus Lore Proposal ${rid} has a malformed operation.`, value);
    }
    return value;
}


function validateProposalReceipts(value) {
    if (!Array.isArray(value)) throw proposalStoreCorrupt('Nexus Lore Proposal receipt archive is present but is not an array.', value);
    const ids=new Set();
    for(const row of value){
        if(!row||typeof row!=='object'||Array.isArray(row)||!String(row.id||'').trim())throw proposalStoreCorrupt('Nexus Lore Proposal receipt archive contains a malformed row.',value);
        const key=`${row.id}:${row.revision||0}:${row.status||''}`;
        if(ids.has(key))throw proposalStoreCorrupt('Nexus Lore Proposal receipt archive contains duplicate receipt identity.',value);
        ids.add(key);
    }
    if(value.length>RECEIPT_LIMIT){const error=proposalStoreCorrupt('Nexus Lore Proposal receipt archive exceeds its supported capacity; audit evidence must be exported/rotated before more terminal proposals can settle.',value);error.name='TV2ProposalAuditCapacityExceeded';throw error;}
    return value;
}
function receiptForProposal(p){return {id:String(p?.id||''),revision:proposalRevision(p),status:String(p?.status||''),createdAt:Number(p?.createdAt)||0,resolvedAt:Number(p?.resolvedAt)||Date.now(),source:String(p?.source||''),operation:String(p?.op?.type||''),book:p?.op?.book==null?null:String(p.op.book),uid:Number.isFinite(Number(p?.op?.uid))?Number(p.op.uid):null,transactionId:p?.transactionId==null?null:String(p.transactionId),semanticKey:String(p?.semanticKey||proposalSemanticKey(p?.op)||''),opFingerprint:proposalOperationFingerprint(p?.op)};}
function validateGlobalInbox(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw proposalStoreCorrupt('Nexus global Lore Proposal inbox is malformed.', value);
    if (Number(value.version) !== GLOBAL_VERSION) throw proposalStoreCorrupt(`Nexus global Lore Proposal inbox has unsupported version ${String(value.version ?? '(missing)')}.`, value);
    validateProposalRows(value.proposals);
    validateProposalReceipts(value.receipts);
    return value;
}
function ensureGlobalInbox(create=true){
    const settings=getSettings();
    const exists=Object.prototype.hasOwnProperty.call(settings,GLOBAL_KEY);
    if(!exists){
        if(!create)return null;
        settings[GLOBAL_KEY]={version:GLOBAL_VERSION,proposals:[],receipts:[]};
    }
    return validateGlobalInbox(settings[GLOBAL_KEY]);
}
function migrateLegacyActiveChat(inbox,context){
    if(!inbox||!context?.chatMetadata)return {proposals:0,receipts:0};
    let movedProposals=0,movedReceipts=0;
    // HOTFIX34: legacy migration is strictly one-way.  Terminal proposal
    // receipts are durable tombstones for their historical chat-local rows.
    // Without consulting receipts here, Clear Resolved removes the global row
    // and the next store read immediately re-imports the stale legacy copy with
    // its old PENDING status / freshness baseline.
    let legacyReceipts=[];
    if(Object.prototype.hasOwnProperty.call(context.chatMetadata,LEGACY_RECEIPT_KEY)){
        legacyReceipts=validateProposalReceipts(context.chatMetadata[LEGACY_RECEIPT_KEY]);
        const keys=new Set(inbox.receipts.map(row=>`${row.id}:${row.revision||0}:${row.status||''}`));
        for(const raw of legacyReceipts){const row=clone(raw),key=`${row.id}:${row.revision||0}:${row.status||''}`;if(keys.has(key))continue;inbox.receipts.push(row);keys.add(key);movedReceipts++;}
        validateProposalReceipts(inbox.receipts);
    }
    const settledIds=new Set(inbox.receipts.map(row=>String(row?.id||'')).filter(Boolean));
    const settledSemanticKeys=new Set(inbox.receipts
        .filter(row=>['approved','reverted'].includes(String(row?.status||'')))
        .map(row=>String(row?.semanticKey||'')).filter(Boolean));
    if(Object.prototype.hasOwnProperty.call(context.chatMetadata,LEGACY_KEY)){
        const legacy=validateProposalRows(context.chatMetadata[LEGACY_KEY]);
        const byId=new Map(inbox.proposals.map(row=>[String(row.id),row]));
        for(const raw of legacy){
            const row=clone(raw),rid=String(row.id);
            if(row.origin?.chatId==null&&context.chatId!=null)row.origin={...(row.origin||{}),chatId:String(context.chatId)};
            // The global semantic identity intentionally excludes source chat.
            row.semanticKey=proposalSemanticKey(row.op);
            row.dedupKey=proposalDedupKey(row.op,row);
            // A terminal receipt proves this exact historical row already left
            // unresolved review.  Never resurrect it merely because the hot
            // global list was compacted/cleared.  Approved/reverted semantic
            // receipts also suppress a differently-id'd legacy duplicate of a
            // canon mutation that already settled.
            if(settledIds.has(rid)||settledSemanticKeys.has(row.semanticKey))continue;
            const existing=byId.get(rid);
            if(existing){
                // After one-way migration the chat-local row is an immutable
                // historical source copy while the global row continues through
                // review/recovery. Only a changed mutation identity is a real
                // conflict; status/revision/audit fields are expected to diverge.
                const sameOperation=proposalOperationFingerprint(existing.op)===proposalOperationFingerprint(row.op);
                const sameOrigin=String(existing?.origin?.chatId??'')===String(row?.origin?.chatId??'');
                if(!sameOperation||!sameOrigin)throw proposalStoreCorrupt(`Legacy Lore Proposal ${rid} conflicts with the global inbox mutation identity.`,{legacy:row,global:existing});
                continue;
            }
            inbox.proposals.push(row);byId.set(rid,row);movedProposals++;
        }
    }
    return {proposals:movedProposals,receipts:movedReceipts};
}
function proposalReceipts(_context=null,create=true){const inbox=ensureGlobalInbox(create);return inbox?.receipts||[];}
function archiveResolvedProposal(_context,p){
    if(!p||UNRESOLVED.has(String(p.status||'')))return;
    const receipts=proposalReceipts(null,true);
    const receipt=receiptForProposal(p),key=`${receipt.id}:${receipt.revision}:${receipt.status}`;
    if(receipts.some(row=>`${row.id}:${row.revision||0}:${row.status||''}`===key))return;
    if(receipts.length>=RECEIPT_LIMIT){const error=new Error(`Lore Proposal audit archive reached its ${RECEIPT_LIMIT}-receipt safety bound. Export/rotate proposal audit evidence before settling more proposals.`);error.name='TV2ProposalAuditCapacityExceeded';throw error;}
    receipts.push(receipt);
}
function proposalRevision(proposal) { const value = Number(proposal?.revision); return Number.isFinite(value) && value >= 0 ? value : 0; }
const FRESHNESS_KEYS = new Set(['expected','expectedTree','expectedNodeId','expectedKeep','expectedRemove']);
export function proposalSemanticOperation(op = {}) { const out={}; for(const [key,value] of Object.entries(op||{})){ if(FRESHNESS_KEYS.has(key)) continue; out[key]=clone(value); } return out; }
export function proposalOperationFingerprint(op = {}) { return fingerprintValue(op || {}); }
export function proposalSemanticKey(op = {}) { return stableStringify(proposalSemanticOperation(op)); }
export function proposalAuditToken(proposal) {
    if (!proposal) return 'missing';
    return stableStringify({ revision: proposalRevision(proposal), status: String(proposal.status || ''), transactionId: proposal.transactionId ?? null, transactionOwned: proposal.transactionOwned === true, approvalClaim: proposal.approvalClaim || null, opFingerprint: proposalOperationFingerprint(proposal.op), recoverySettlement: proposal.recoverySettlement || null, updatedAt: Number(proposal.updatedAt || 0) });
}
function journalAuditToken(row) {
    if (!row) return 'missing';
    return JSON.stringify({ id: String(row.id || ''), state: String(row.state || ''), updatedAt: Number(row.updatedAt || 0), resolvedAt: Number(row.resolvedAt || 0), recoveryDisposition: row.recoveryDisposition || null, resultFingerprint: row.resultFingerprint || null, error: String(row.error || '') });
}
function proposalPatchFromJournal(proposal, row) {
    if (!row) return null;
    const state = String(row.state || '');
    if (['committed', 'applied', 'reconciled-confirmed-applied'].includes(state)) {
        return { status: 'approved', error: '', result: proposal?.result || 'Recovered from authoritative committed transaction evidence.' };
    }
    if (['failed', 'reconciled-confirmed-not-applied', 'reconciled-superseded'].includes(state)) {
        return { status: 'failed', error: row.error || `Recovered from terminal commit journal state ${state}.` };
    }
    if (state === 'reconciled-abandoned' || state === 'reconciled-diverged') {
        return { status: 'failed', error: row.recoveryNote || row.error || (state === 'reconciled-diverged'
            ? 'Canonical mutation outcome diverged from both known PRE and POST; exact replay remains permanently fenced.'
            : 'Canonical mutation outcome was abandoned as unknown; exact replay remains permanently fenced.') };
    }
    if (state === 'recovery-required') {
        return { status: 'recovery-required', error: row.error || proposal?.error || 'Canonical transaction requires recovery reconciliation.' };
    }
    return null;
}

function clone(v) { return v == null ? v : JSON.parse(JSON.stringify(v)); }
function id() { return globalThis.crypto?.randomUUID ? `tv2_prop_${crypto.randomUUID()}` : `tv2_prop_${Date.now()}_${Math.random().toString(36).slice(2)}`; }

export function proposalResourceKeys(op={}) {
    const type=String(op?.type||''),book=String(op?.book||'').trim();
    if(!book)return type==='metadata.set'?[`metadata:${String(op?.key||'')}`]:[];
    const keys=new Set();const entry=uid=>{const n=Number(uid);if(Number.isFinite(n))keys.add(`${book}:entry:${n}`);};
    const tree=()=>keys.add(`${book}:tree`);
    if(type==='entry.create'){keys.add(`${book}:entry:create`);tree();}
    else if(type==='entry.update'){entry(op.uid);if(op.targetNodeId!==undefined)tree();}
    else if(type==='entry.delete'){entry(op.uid);tree();}
    else if(type==='entry.merge'){entry(op.keepUid);entry(op.removeUid);tree();}
    else if(type==='entry.split'){entry(op.uid);keys.add(`${book}:entry:create`);tree();}
    else if(type==='entry.move'){entry(op.uid);tree();}
    else if(type.startsWith('tree.'))tree();
    else keys.add(`${book}:${type||'mutation'}`);
    return [...keys].sort();
}
function resourcesOverlap(a=[],b=[]){const right=new Set(b);return a.some(key=>right.has(key));}

function proposalParentTransactionId(value){return String(value?.execution?.parentTransactionId??value?.parentTransactionId??'').trim();}
function proposalDedupKey(op,meta={}){
    const parent=proposalParentTransactionId(meta);
    return `${proposalSemanticKey(op)}|parent:${parent||'none'}`;
}
function proposalCountsFrom(proposals=[]){const counts={all:proposals.length,pending:0,committing:0,recoveryRequired:0,unresolved:0};for(const p of proposals){const status=String(p?.status||'');if(status==='pending')counts.pending++;if(status==='committing')counts.committing++;if(status==='recovery-required')counts.recoveryRequired++;if(UNRESOLVED.has(status))counts.unresolved++;}return counts;}

function storeForContext(context, create = true) {
    const inbox=ensureGlobalInbox(create);
    if(!inbox)return {context:context||getContext(),proposals:[],receipts:[],inbox:null};
    const liveContext=context||getContext();
    migrateLegacyActiveChat(inbox,liveContext);
    return {context:liveContext,proposals:inbox.proposals,receipts:inbox.receipts,inbox};
}
function store(create = true) { return storeForContext(getContext(), create); }

let proposalDurabilityTail=Promise.resolve();
function restoreArray(target,before){target.splice(0,target.length,...before.map(clone));}
function sameValue(a,b){return stableStringify(a)===stableStringify(b);}
async function withProposalStoreDurability(label,mutator){
    const run=proposalDurabilityTail.catch(()=>{}).then(async()=>{
        // Rebind only after earlier durability/rollback work settled. This avoids
        // queued writers retaining stale array references after a failed flush.
        const ref=store(true),inbox=ref.inbox;
        const before=clone(inbox),value=mutator(ref);
        if(value&&typeof value.then==='function')throw new TypeError(`${label} proposal-store mutator must complete synchronously.`);
        const post=clone(inbox);
        try{
            await flushSettingsPersistence(label,{expected:[{path:[GLOBAL_KEY],exists:true,value:post}]});
            return value;
        }catch(error){
            const live=ensureGlobalInbox(true);
            if(!sameValue(live,post)){const indeterminate=new Error(`${label} failed after the global Proposal inbox diverged; rollback was refused to preserve newer data.`);indeterminate.name='TV2RollbackIndeterminate';indeterminate.cause=error;throw indeterminate;}
            live.version=before.version;restoreArray(live.proposals,before.proposals||[]);restoreArray(live.receipts,before.receipts||[]);
            try{await flushSettingsPersistence(`${label} rollback`,{expected:[{path:[GLOBAL_KEY],exists:true,value:clone(live)}]});}
            catch(rollbackError){const indeterminate=new Error(`${label} failed and global Proposal inbox rollback durability could not be proven.`);indeterminate.name='TV2RollbackIndeterminate';indeterminate.cause=error;indeterminate.rollbackError=rollbackError;throw indeterminate;}
            throw error;
        }
    });
    proposalDurabilityTail=run.catch(()=>{});
    return await run;
}
export async function flushProposalStorePersistence(_refOrContext = null) {
    const inbox=ensureGlobalInbox(true);
    return await flushSettingsPersistence('Nexus Lore Proposal inbox',{expected:[{path:[GLOBAL_KEY],exists:true,value:clone(inbox)}]});
}
function emit(ref=null) { try { const proposals=Array.isArray(ref?.proposals)?ref.proposals:store(false).proposals; window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: proposalCountsFrom(proposals) })); } catch {} }
export function initProposalStore() { store(true); }
export function captureProposalStore(create = true) {
    const ref = store(create);
    return { context: ref.context, proposals: ref.proposals, receipts: ref.receipts, inbox: ref.inbox, chatId: ref.context?.chatId ?? null };
}
export function getProposalsFromStore(ref, status = 'all') {
    const proposals = Array.isArray(ref?.proposals) ? ref.proposals : [];
    const copy = proposals.map(clone);
    return status === 'all' ? copy : copy.filter(p => p.status === status);
}
export function getProposalChangeEventName() { return CHANGE_EVENT; }

export function getProposals(status = 'all') {
    const { proposals } = store(false);
    const selected=status === 'all' ? proposals : proposals.filter(p => p.status === status);
    return selected.map(clone);
}
export function getProposalCounts(){return proposalCountsFrom(store(false).proposals);}
export function getProposalById(proposalId){const p=store(false).proposals.find(row=>row.id===String(proposalId));return clone(p||null);}
export function getProposalAuditReceipts(){const context=getContext();return proposalReceipts(null,false).map(clone);}
export function getProposalBackpressureStatus(){const counts=getProposalCounts();return {maxUnresolved:MAX_UNRESOLVED,unresolved:counts.unresolved,blocked:counts.unresolved>=MAX_UNRESOLVED};}
export function getProposalPage(status='all',{offset=0,limit=100}={}){
    const proposals=store(false).proposals,selected=status==='all'?proposals:proposals.filter(p=>p.status===status);
    const start=Math.max(0,Math.floor(Number(offset)||0)),cap=Math.max(1,Math.min(250,Math.floor(Number(limit)||100)));
    return {total:selected.length,offset:start,limit:cap,rows:selected.slice(start,start+cap).map(clone)};
}

function enqueueProposalLocal(op, meta = {}) {
    validateOp(op);
    const { context, proposals } = store(true);
    if (!context) throw new Error('No active chat is available for Lore Proposals.');
    const originChatId = meta.origin?.chatId ?? null;
    if (originChatId != null && String(originChatId) !== String(context.chatId ?? '')) {
        const err = new Error(`Proposal origin chat ${originChatId} is no longer active.`); err.name = 'TV2ScopeInvalidated'; throw err;
    }
    const semanticKey = proposalSemanticKey(op);
    const dedupKey = proposalDedupKey(op,meta);
    const resources = proposalResourceKeys(op);

    // Idempotency owns admission before backpressure. Parent ownership is part of
    // unresolved dedup identity, while resolved replay remains semantic so a
    // canonical mutation that already settled is never re-applied by a new saga.
    const existing = proposals.find(p => UNRESOLVED.has(String(p.status || '')) && String(p.dedupKey || proposalDedupKey(p.op,p)) === dedupKey);
    if (existing) { logEvent('proposals','deduplicated',{proposalId:existing.id,op:existing.op,source:meta.source||'unknown',status:existing.status,parentTransactionId:proposalParentTransactionId(existing)||null},'debug'); return {...clone(existing),enqueueDisposition:'deduplicated'}; }
    const resolved = proposalReceipts(null, false).find(row => String(row.semanticKey || '') === semanticKey && ['approved','reverted'].includes(String(row.status || '')));
    if (resolved) {
        logEvent('proposals','resolved-replay-suppressed',{proposalId:resolved.id,status:resolved.status,semanticKey,source:meta.source||'unknown'},'info');
        return { id:String(resolved.id), status:String(resolved.status), resolvedDuplicate:true, duplicateOf:String(resolved.id), semanticKey, dedupKey, op:clone(op), source:String(meta.source||'unknown'), origin:clone(meta.origin||null), execution:clone(meta.execution||null), revision:Number(resolved.revision)||0, enqueueDisposition:'deduplicated-resolved' };
    }

    const recoveryOwner=proposals.find(p=>String(p.status||'')==='recovery-required'&&p.transactionOwned!==true&&!p.transactionId&&resourcesOverlap(resources,Array.isArray(p.resourceKeys)?p.resourceKeys:proposalResourceKeys(p.op)));
    if(recoveryOwner){const error=new Error(`Lore mutation is fenced by unresolved recovery ${recoveryOwner.id}. Reconcile that operation before overlapping work can stage.`);error.name='TV2ProposalRecoveryFence';error.recoveryProposalId=recoveryOwner.id;error.resourceKeys=resources;throw error;}
    const unresolvedCount=proposalCountsFrom(proposals).unresolved;
    if(unresolvedCount>=MAX_UNRESOLVED){
        const error=new Error(`Lore Proposal queue reached its ${MAX_UNRESOLVED}-operation unresolved safety bound. Reconcile existing pending/recovery work before staging more.`);
        error.name='TV2ProposalBackpressure';error.maxUnresolved=MAX_UNRESOLVED;error.unresolved=unresolvedCount;
        logEvent('proposals','backpressure',{unresolved:unresolvedCount,maxUnresolved:MAX_UNRESOLVED,source:meta.source||'unknown'},'warn');
        throw error;
    }
    const now = Date.now();
    const proposal = {
        id: id(), status: 'pending', createdAt: now, updatedAt: now, resolvedAt: null,
        op: clone(op), source: String(meta.source || 'unknown').slice(0, 100),
        reasoning: String(meta.reasoning || '').slice(0, 6000),
        sourceExcerpt: String(meta.sourceExcerpt || '').slice(0, 3000),
        model: String(meta.model || '').slice(0, 200),
        origin: clone(meta.origin || null), execution: clone(meta.execution || { kind: 'tv2-universal-mutation' }),
        result: '', error: '', recovery: null, semanticKey, dedupKey, resourceKeys:resources, revision: 1, approvalClaim:null,
    };
    proposals.push(proposal);
    while (proposals.length > LIMIT) {
        const idx = proposals.findIndex(p => !UNRESOLVED.has(String(p.status || '')));
        if (idx < 0) break;
        archiveResolvedProposal(context, proposals[idx]);
        proposals.splice(idx, 1);
    }
    emit({context,proposals}); logEvent('proposals','enqueued',{proposalId:proposal.id,op:proposal.op,source:proposal.source,model:proposal.model,origin:proposal.origin,semanticKey,parentTransactionId:proposalParentTransactionId(proposal)||null,estimatedOpTokens:estimateContentTokens(JSON.stringify(proposal.op||{}))},'info'); return {...clone(proposal),enqueueDisposition:'created'};
}

export async function enqueueProposal(op, meta = {}) {
    const ref = store(true);
    if (!ref.context) throw new Error('No active chat is available for Lore Proposals.');
    const proposal = await withProposalStoreDurability('Lore Proposal enqueue', () => enqueueProposalLocal(op, meta));
    return { ...proposal, durability: 'durable' };
}

export function updateProposalInStore(ref, proposalId, patch = {}) {
    const context = ref?.context || null;
    const proposals = Array.isArray(ref?.proposals) ? ref.proposals : [];
    const p = proposals.find(v => v.id === proposalId);
    if (!p) return false;
    if (patch.expectedRevision !== undefined && proposalRevision(p) !== Number(patch.expectedRevision)) { const error=new Error(`Proposal ${proposalId} changed before this operation could settle.`); error.name='TV2ProposalCASMismatch'; throw error; }
    if (patch.expectedAuditToken !== undefined && proposalAuditToken(p) !== String(patch.expectedAuditToken)) { const error=new Error(`Proposal ${proposalId} audit identity changed before this operation could settle.`); error.name='TV2ProposalCASMismatch'; throw error; }
    if (p.approvalClaim && patch.claimToken !== p.approvalClaim.token) { const error=new Error(`Proposal ${proposalId} is owned by an active approval claim.`); error.name='TV2ProposalApprovalClaimed'; throw error; }
    const priorStatus=String(p.status||'');
    if (patch.op) {
        validateOp(patch.op);
        const semanticKey=proposalSemanticKey(patch.op), resources=proposalResourceKeys(patch.op);
        const dedupKey=proposalDedupKey(patch.op,p);
        const collision=proposals.find(other=>other!==p&&UNRESOLVED.has(String(other.status||''))&&String(other.dedupKey||proposalDedupKey(other.op,other))===dedupKey);
        if(collision){const error=new Error(`Proposal rewrite collides with unresolved proposal ${collision.id}.`);error.name='TV2ProposalDedupCollision';error.proposalId=collision.id;throw error;}
        const recoveryOwner=proposals.find(other=>other!==p&&String(other.status||'')==='recovery-required'&&other.transactionOwned!==true&&!other.transactionId&&resourcesOverlap(resources,Array.isArray(other.resourceKeys)?other.resourceKeys:proposalResourceKeys(other.op)));
        if(recoveryOwner){const error=new Error(`Proposal rewrite is fenced by unresolved recovery ${recoveryOwner.id}.`);error.name='TV2ProposalRecoveryFence';error.recoveryProposalId=recoveryOwner.id;throw error;}
        p.op=clone(patch.op);p.semanticKey=semanticKey;p.dedupKey=dedupKey;p.resourceKeys=resources;
    }
    for (const key of ['status','reasoning','result','error','transactionId','transactionOwned']) if (patch[key] !== undefined) p[key] = patch[key];
    if (Object.prototype.hasOwnProperty.call(patch, 'approvalClaim')) p.approvalClaim=clone(patch.approvalClaim);
    if (Object.prototype.hasOwnProperty.call(patch, 'rollback')) p.rollback=clone(patch.rollback);
    if (Object.prototype.hasOwnProperty.call(patch, 'recovery')) p.recovery = clone(patch.recovery);
    if (Object.prototype.hasOwnProperty.call(patch, 'recoverySettlement')) p.recoverySettlement = clone(patch.recoverySettlement);
    p.revision = proposalRevision(p) + 1;
    p.updatedAt = Date.now();
    p.resolvedAt = UNRESOLVED.has(String(p.status || '')) ? null : (p.resolvedAt || Date.now());
    if(UNRESOLVED.has(priorStatus)&&!UNRESOLVED.has(String(p.status||'')))archiveResolvedProposal(context,p);
    emit({context,proposals}); logEvent('proposals','updated',{proposalId,status:p.status,op:p.op,result:p.result,error:p.error},p.status==='failed'?'error':'info'); return true;
}

export async function claimProposalApproval(proposalId) {
    const ref=store(true), p=ref.proposals.find(row=>row.id===String(proposalId));
    if(!p||String(p.status||'')!=='pending')throw new Error(`Pending proposal ${proposalId} not found.`);
    if(p.approvalClaim){const error=new Error(`Proposal ${proposalId} already has an active approval owner.`);error.name='TV2ProposalApprovalClaimed';throw error;}
    const token=`tv2_claim_${Date.now()}_${Math.random().toString(36).slice(2,10)}`, expectedRevision=proposalRevision(p), expectedAuditToken=proposalAuditToken(p);
    await withProposalStoreDurability('Lore Proposal approval claim',live=>updateProposalInStore(live,proposalId,{expectedRevision,expectedAuditToken,error:'',approvalClaim:{token,claimedAt:Date.now(),reviewRevision:expectedRevision,opFingerprint:proposalOperationFingerprint(p.op)}}));
    const claimed=ref.proposals.find(row=>row.id===String(proposalId));
    return { proposal:clone(claimed), token, revision:proposalRevision(claimed), auditToken:proposalAuditToken(claimed) };
}

export async function releaseProposalApprovalClaim(proposalId, token, patch = {}) {
    const ref=store(true), p=ref.proposals.find(row=>row.id===String(proposalId));
    if(!p||!p.approvalClaim||p.approvalClaim.token!==String(token))return false;
    return await withProposalStoreDurability('Lore Proposal approval claim release',live=>updateProposalInStore(live,proposalId,{...patch,claimToken:String(token),approvalClaim:null}));
}

export async function projectProposalRollback(proposalId,{inverseTransactionId=null,writeId=null,note='Mutation was later reversed.'}={}){
    const ref=store(true),p=ref.proposals.find(row=>row.id===String(proposalId));if(!p)return false;
    if(String(p.status||'')==='reverted')return true;
    if(String(p.status||'')!=='approved'){const error=new Error(`Proposal ${proposalId} cannot be marked reverted from ${p.status||'unknown'}.`);error.name='TV2ProposalRollbackStateConflict';throw error;}
    return await withProposalStoreDurability('Lore Proposal rollback projection',live=>updateProposalInStore(live,proposalId,{status:'reverted',rollback:{inverseTransactionId,writeId,note,at:Date.now()},error:String(note||'Mutation was later reversed.')}));
}

export async function updateProposal(proposalId, patch = {}) {
    const ref = store(true);
    const proposal = ref.proposals.find(p => p.id === proposalId);
    if (!proposal) return false;
    if (String(proposal.status || '') !== 'pending') throw new Error(`Proposal ${proposalId} is ${proposal.status || 'unknown'} and cannot be edited through the public proposal API.`);
    if (proposal.approvalClaim) { const error=new Error(`Proposal ${proposalId} is currently owned by an approval attempt and cannot be edited.`); error.name='TV2ProposalApprovalClaimed'; throw error; }
    if (patch.status !== undefined && String(patch.status) !== 'pending' && String(patch.status) !== 'rejected') throw new Error(`Public proposal status transition to ${patch.status} is not allowed.`);
    return await withProposalStoreDurability('Lore Proposal update',live=>updateProposalInStore(live,proposalId,{...patch,expectedRevision:proposalRevision(proposal),expectedAuditToken:proposalAuditToken(proposal)}));
}


export async function settleProposalForParentRollback(proposalId,{parentTransactionId,reason='Parent transaction rolled back.',ref=null,physicalRollbackProven=false}={}){
    const storeRef=ref||store(true),context=storeRef?.context;
    if(!context)return {settled:false,recoveryRequired:true,reason:'proposal-context-unavailable',proposalId:String(proposalId)};
    return await withProposalStoreDurability('Nexus parent Proposal rollback settlement',storeRef=>{
        const proposal=storeRef.proposals.find(row=>String(row?.id||'')===String(proposalId));
        if(!proposal)return {settled:false,recoveryRequired:true,reason:'proposal-missing',proposalId:String(proposalId)};
        const expectedParent=String(parentTransactionId||''),actualParent=proposalParentTransactionId(proposal);
        if(!expectedParent||actualParent!==expectedParent)return {settled:false,recoveryRequired:true,reason:'proposal-parent-ownership-mismatch',proposalId:String(proposalId),expectedParentTransactionId:expectedParent||null,actualParentTransactionId:actualParent||null,status:String(proposal.status||'')};
        const status=String(proposal.status||'');
        if(status==='pending'){
            updateProposalInStore(storeRef,proposal.id,{status:'rejected',error:String(reason||'Parent transaction rolled back.')});
            return {settled:true,recoveryRequired:false,proposalId:String(proposal.id),status:'rejected',durability:'durable'};
        }
        if(status==='rejected')return {settled:true,recoveryRequired:false,proposalId:String(proposal.id),status,alreadySettled:true,durability:'durable'};
        // Direct-write mode approves the Proposal through the canonical mutation
        // coordinator before the parent transaction commits its own state. If the
        // exact Direct Write owned by this parent has subsequently been proven
        // absent or durably inverted, APPROVED is truthful historical audit state:
        // the operation was approved and applied, then its physical effect was
        // reversed. Do not rewrite that history to REJECTED, but do allow the
        // parent rollback to settle when the inverse proof is explicit.
        if(status==='approved'&&physicalRollbackProven===true)return {settled:true,recoveryRequired:false,proposalId:String(proposal.id),status,settlement:'physical-rollback-proven',durability:'durable'};
        // COMMITTING / RECOVERY-REQUIRED / APPROVED may already own or have
        // applied physical canon. FAILED can also represent a transaction whose
        // recovery truth lives in the commit journal. Never falsify that audit
        // state merely to make a parent rollback appear atomic.
        return {settled:false,recoveryRequired:true,proposalId:String(proposal.id),status,reason:`proposal-${status}-cannot-be-parent-rejected`};
    });
}

export async function rejectProposal(id, reason = '') {
    const ref = store(true);
    const proposal = ref.proposals.find(p => p.id === id);
    if (!proposal) return false;
    if (String(proposal.status || '') !== 'pending') throw new Error(`Only pending proposals can be rejected; ${id} is ${proposal.status || 'unknown'}.`);
    if (proposal.approvalClaim) { const error=new Error(`Proposal ${id} is currently owned by an approval attempt and cannot be rejected.`); error.name='TV2ProposalApprovalClaimed'; throw error; }
    return await withProposalStoreDurability('Lore Proposal reject',live=>updateProposalInStore(live,id,{status:'rejected',error:reason,expectedRevision:proposalRevision(proposal),expectedAuditToken:proposalAuditToken(proposal)}));
}
export function getProposalRecoveryRows() {
    return getProposals('all').filter(p => ['committing', 'recovery-required'].includes(String(p.status || '')));
}
export function getProposalRecoveryPage({offset=0,limit=100}={}){
    const proposals=store(false).proposals.filter(p=>['committing','recovery-required'].includes(String(p.status||'')));
    const start=Math.max(0,Math.floor(Number(offset)||0)),cap=Math.max(1,Math.min(250,Math.floor(Number(limit)||100)));
    return {total:proposals.length,offset:start,limit:cap,rows:proposals.slice(start,start+cap).map(clone)};
}
export async function reconcileProposal(proposalId, { disposition = 'confirmed-not-applied', note = '' } = {}) {
    const allowed = new Set(['confirmed-applied', 'confirmed-not-applied', 'abandoned']);
    const normalized = String(disposition || '');
    if (!allowed.has(normalized)) throw new Error(`Unsupported proposal recovery disposition: ${normalized}`);
    const ref = store(true);
    let proposal = ref.proposals.find(p => p.id === proposalId);
    if (!proposal) throw new Error(`Proposal ${proposalId} was not found.`);
    if (String(proposal.status || '') !== 'recovery-required') {
        throw new Error(`Proposal ${proposalId} is ${proposal.status || 'unknown'}; recovery disposition is allowed only after the canonical transaction enters recovery-required.`);
    }

    const suffix = String(note || '').trim();
    const txId = String(proposal.transactionId || '').trim();
    let authoritativePatch = null;

    if (txId) {
        let row = getNexusCommitJournal({ unresolvedOnly: false }).find(item => String(item.id) === txId) || null;
        if (!row) {
            const error = new Error(`Proposal ${proposalId} references canonical transaction ${txId}, but its commit-journal authority is unavailable. Recovery must remain unresolved.`);
            error.name = 'TV2ProposalRecoveryAuthorityMissing';
            throw error;
        }
        const terminalPatch = proposalPatchFromJournal(proposal, row);
        if (terminalPatch && !UNRESOLVED.has(String(row.state || ''))) {
            authoritativePatch = terminalPatch;
        } else {
            // Verify physical PRE/POST first, but do not consume canonical journal
            // authority until the Proposal has durably recorded that a settlement
            // is in progress. A crash at either boundary therefore leaves one of
            // the two durable stores able to drive startup reconciliation.
            const prepared = await prepareNexusCommitRecoverySettlement(txId, {
                disposition: normalized,
                context: ref.context,
            });
            const initialToken = proposalAuditToken(proposal);
            const marker = {
                transactionId: txId,
                disposition: normalized,
                verification: clone(prepared.verification),
                preparedAt: Date.now(),
            };
            await withProposalStoreDurability('Lore Proposal recovery settlement prepare', live => {
                const current = live.proposals.find(p => p.id === proposalId);
                if (!current || proposalAuditToken(current) !== initialToken) {
                    const error = new Error(`Proposal ${proposalId} changed before its recovery settlement marker became durable.`);
                    error.name = 'TV2ProposalReconciliationStale';
                    throw error;
                }
                return updateProposalInStore(live, proposalId, { recoverySettlement: marker });
            });
            proposal = ref.proposals.find(p => p.id === proposalId);
            row = await reconcileNexusCommitRecovery(txId, {
                disposition: normalized,
                note: suffix || `Proposal recovery operator disposition: ${normalized}`,
                context: ref.context,
            });
            authoritativePatch = proposalPatchFromJournal(proposal, row);
        }
        if (!authoritativePatch || authoritativePatch.status === 'recovery-required') {
            const error = new Error(`Canonical transaction ${txId} did not reach a terminal recovery disposition; Proposal state remains recovery-required.`);
            error.name = 'TV2ProposalRecoveryStillUnresolved';
            throw error;
        }
    } else if (proposal.transactionOwned === true) {
        const error = new Error(`Proposal ${proposalId} is transaction-owned but has no canonical transaction identity. Recovery must remain unresolved.`);
        error.name = 'TV2ProposalRecoveryAuthorityMissing';
        throw error;
    } else {
        if (normalized === 'confirmed-applied') authoritativePatch = { status: 'approved', result: suffix || proposal.result || 'Operator confirmed canonical mutation was applied.', error: '' };
        else if (normalized === 'confirmed-not-applied') authoritativePatch = { status: 'failed', error: suffix || 'Operator confirmed canonical mutation was not applied.' };
        else authoritativePatch = { status: 'rejected', error: suffix || 'Operator abandoned unresolved proposal recovery.' };
    }

    const projectionToken = proposalAuditToken(ref.proposals.find(p => p.id === proposalId));
    return await withProposalStoreDurability('Lore Proposal recovery disposition', live => {
        const current = live.proposals.find(p => p.id === proposalId);
        if (!current || proposalAuditToken(current) !== projectionToken) {
            const error = new Error(`Proposal ${proposalId} changed while canonical recovery was being reconciled; the authoritative journal disposition will be projected by reconciliation instead of overwriting newer Proposal state.`);
            error.name = 'TV2ProposalReconciliationStale';
            throw error;
        }
        return updateProposalInStore(live, proposalId, { ...authoritativePatch, recoverySettlement: null });
    });
}
export async function projectProposalRecoverySettlement(transactionId, { disposition = '', row = null, context = null } = {}) {
    const ref = storeForContext(context || getContext(), true);
    if (!Array.isArray(ref.proposals)) return { changed: 0 };
    const targets = ref.proposals.filter(p => String(p?.transactionId || '') === String(transactionId) && UNRESOLVED.has(String(p?.status || '')));
    if (!targets.length) return { changed: 0 };
    const authoritativeRow = row || getNexusCommitJournal({ unresolvedOnly: false }).find(item => String(item.id) === String(transactionId)) || null;
    if (!authoritativeRow) throw Object.assign(new Error(`Canonical recovery projection ${transactionId} has no commit-journal row.`), { name: 'TV2ProposalRecoveryAuthorityMissing' });
    const patches = targets.map(proposal => [proposal.id, proposalPatchFromJournal(proposal, authoritativeRow)]);
    if (patches.some(([,patch]) => !patch || UNRESOLVED.has(String(patch.status || '')))) throw Object.assign(new Error(`Canonical recovery projection ${transactionId} is not terminal enough to settle Proposal audit state.`), { name: 'TV2ProposalRecoveryStillUnresolved' });
    await withProposalStoreDurability('Lore Proposal canonical recovery projection', live => {
        for (const [proposalId, patch] of patches) updateProposalInStore(live, proposalId, { ...patch, recoverySettlement: null });
        return true;
    });
    return { changed: patches.length, disposition };
}
registerNexusRecoveryProjector('lore-proposals', settlement => projectProposalRecoverySettlement(settlement.id, settlement));

export async function clearResolved() {
    const result=await withProposalStoreDurability('Lore Proposal clear resolved', live => {
        const unresolved=live.proposals.filter(p=>UNRESOLVED.has(String(p.status||''))).map(clone);
        const removed=live.proposals.length-unresolved.length;
        for(const p of live.proposals)if(!UNRESOLVED.has(String(p.status||'')))archiveResolvedProposal(null,p);
        live.proposals.splice(0,live.proposals.length,...unresolved);emit(live);
        return {removed,counts:proposalCountsFrom(live.proposals)};
    });
    logEvent('proposals','cleared-resolved',{removed:result.removed,pending:result.counts.pending,committing:result.counts.committing,recoveryRequired:result.counts.recoveryRequired},'info');
    return result.removed;
}
export async function reconcileProposalAuditFromCommitJournal() {
    const ref = store(true);
    if (!ref.context) return { changed: 0, skipped: 0, rows: [] };
    const applied = [];
    const skipped = [];

    // A pending approval claim cannot survive a page reload: its JavaScript
    // executor and any pre-intent in-memory Ledger row are gone. Clear that
    // orphaned claim durably before normal journal reconciliation so the review
    // remains retryable instead of becoming permanently locked.
    for (const snapshot of ref.proposals.map(clone)) {
        if (String(snapshot?.status || '') !== 'pending' || !snapshot?.approvalClaim?.token) continue;
        const token=String(snapshot.approvalClaim.token), expected=proposalAuditToken(ref.proposals.find(p=>p.id===snapshot.id));
        try {
            await withProposalStoreDurability('Lore Proposal startup approval-claim recovery', live => {
                const current=live.proposals.find(p=>p.id===snapshot.id);
                if(!current||proposalAuditToken(current)!==expected||current?.approvalClaim?.token!==token)throw Object.assign(new Error('Proposal approval claim changed before startup recovery.'),{name:'TV2ProposalReconciliationStale'});
                return updateProposalInStore(live,snapshot.id,{claimToken:token,approvalClaim:null,error:'Interrupted approval claim released during startup; no durable canonical intent owned it.'});
            });
            applied.push({proposalId:snapshot.id,transactionId:null,reason:'interrupted-pending-approval-claim'});
        } catch(error) { skipped.push({proposalId:snapshot.id,transactionId:null,reason:`claim-release-failed:${error?.name||'error'}`}); }
    }

    // Work row-by-row so every canonical recovery transition is separated by a
    // durable Proposal marker. Startup may be slower by a few metadata writes,
    // but never consumes recovery authority inside an unpersisted metadata mutator.
    for (const snapshot of ref.proposals.map(clone)) {
        const status = String(snapshot?.status || '');
        if (!['committing', 'recovery-required'].includes(status) || !snapshot?.transactionId) continue;
        const txId = String(snapshot.transactionId);
        let row = getNexusCommitJournal({ unresolvedOnly: false }).find(item => String(item.id) === txId) || null;
        let patch = null;
        let reason = row ? String(row.state || '') : 'missing-journal';

        if (!row) {
            // Absence of journal evidence is not proof that a COMMITTING
            // physical mutation never started. Preserve the Proposal as an
            // unresolved recovery owner until canonical PRE/POST can be proved.
            patch = { status: 'recovery-required', transactionId: txId, transactionOwned: true, recoverySettlement: null, error: snapshot.error || `Canonical recovery journal ${txId} is unavailable; COMMITTING authority cannot be reopened from absence of evidence.` };
        } else {
            patch = proposalPatchFromJournal(snapshot, row);
            if (!patch && String(row.state || '') === 'committing' && !row.recovery && row.physicalPersistenceBegun !== true && (!Array.isArray(row.subwrites) || row.subwrites.length === 0) && status === 'committing') {
                try {
                    const prepared = await prepareNexusCommitRecoverySettlement(txId, { disposition: 'confirmed-not-applied', context: ref.context });
                    const markerToken = proposalAuditToken(ref.proposals.find(p => p.id === snapshot.id));
                    await withProposalStoreDurability('Lore Proposal startup recovery settlement prepare', live => {
                        const current = live.proposals.find(p => p.id === snapshot.id);
                        if (!current || proposalAuditToken(current) !== markerToken) throw Object.assign(new Error('Proposal changed before startup recovery marker persistence.'), { name: 'TV2ProposalReconciliationStale' });
                        return updateProposalInStore(live, snapshot.id, { recoverySettlement: { transactionId: txId, disposition: 'confirmed-not-applied', verification: clone(prepared.verification), preparedAt: Date.now() } });
                    });
                    row = await reconcileNexusCommitRecovery(txId, { disposition: 'confirmed-not-applied', note: 'Startup reconciliation: durable journal proves physical persistence had not begun.', context: ref.context });
                    patch = { status: 'pending', transactionId: null, transactionOwned: false, recoverySettlement: null, error: 'Recovered interrupted approval before physical persistence; safe retry is allowed.' };
                    reason = 'pre-intent-not-started';
                } catch (error) {
                    skipped.push({ proposalId: snapshot.id, transactionId: txId, reason: `journal-resolution-failed:${error?.name || 'error'}` });
                    continue;
                }
            }
        }
        if (!patch) continue;
        const expected = proposalAuditToken(ref.proposals.find(p => p.id === snapshot.id));
        try {
            await withProposalStoreDurability('Lore Proposal startup audit reconciliation', live => {
                const current = live.proposals.find(p => p.id === snapshot.id);
                if (!current || proposalAuditToken(current) !== expected) throw Object.assign(new Error('Proposal changed before startup audit projection.'), { name: 'TV2ProposalReconciliationStale' });
                return updateProposalInStore(live, snapshot.id, patch);
            });
            applied.push({ proposalId: snapshot.id, transactionId: txId, reason });
        } catch (error) {
            skipped.push({ proposalId: snapshot.id, transactionId: txId, reason: `projection-failed:${error?.name || 'error'}` });
        }
    }
    if (applied.length) logEvent('proposals','startup-audit-reconciled',{count:applied.length,rows:applied},'warn');
    if (skipped.length) logEvent('proposals','startup-audit-stale-skipped',{count:skipped.length,rows:skipped},'warn');
    return { changed: applied.length, skipped: skipped.length, rows: applied.map(clone), staleRows: skipped.map(clone) };
}
