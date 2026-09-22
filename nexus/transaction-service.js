import { TransactionLedger } from './transaction-ledger.js';
import { deepCopy } from './contracts.js';
import * as commitJournal from './commit-journal.js';
import { createOperatorReviewStore } from './operator-review-store.js';
import { currentOperatorReviewScope, lorebookOperatorReviewScope, normalizeOperatorReviewScope, operatorReviewScopeProjection } from './review-scope.js';
import { projectNexusRecoverySettlement } from './recovery-projections.js';

const {
    beginNexusCommitIntent, updateNexusCommitIntentRecovery, updateNexusCommitIntentPhase,
    markNexusCommitIntentApplied, completeNexusCommitIntent, failNexusCommitIntent,
    markNexusCommitRecoveryRequired, getNexusCommitJournal, resolveNexusCommitRecovery,
    findMatchingNexusCommitIntents, findNexusCommitResourceConflicts,
    markNexusCommitEffectSuperseded, markNexusDependentProjectionPending,
    clearNexusDependentProjectionPending,
} = commitJournal;
const beginNexusCommitIntentDurable = commitJournal.beginNexusCommitIntentDurable || (async (...args) => beginNexusCommitIntent(...args));
const updateNexusCommitIntentRecoveryDurable = commitJournal.updateNexusCommitIntentRecoveryDurable || (async (...args) => updateNexusCommitIntentRecovery(...args));
const updateNexusCommitIntentPhaseDurable = commitJournal.updateNexusCommitIntentPhaseDurable || (async (...args) => updateNexusCommitIntentPhase(...args));
const markNexusCommitIntentAppliedDurable = commitJournal.markNexusCommitIntentAppliedDurable || (async (...args) => markNexusCommitIntentApplied(...args));
const completeNexusCommitIntentDurable = commitJournal.completeNexusCommitIntentDurable || (async (...args) => completeNexusCommitIntent(...args));
const failNexusCommitIntentDurable = commitJournal.failNexusCommitIntentDurable || (async (...args) => failNexusCommitIntent(...args));
const markNexusCommitRecoveryRequiredDurable = commitJournal.markNexusCommitRecoveryRequiredDurable || (async (...args) => markNexusCommitRecoveryRequired(...args));
const resolveNexusCommitRecoveryDurable = commitJournal.resolveNexusCommitRecoveryDurable || (async (...args) => resolveNexusCommitRecovery(...args));
const markNexusCommitEffectSupersededDurable = commitJournal.markNexusCommitEffectSupersededDurable || (async (...args) => markNexusCommitEffectSuperseded(...args));
const markNexusDependentProjectionPendingDurable = commitJournal.markNexusDependentProjectionPendingDurable || (async (...args) => markNexusDependentProjectionPending(...args));
const clearNexusDependentProjectionPendingDurable = commitJournal.clearNexusDependentProjectionPendingDurable || (async (...args) => clearNexusDependentProjectionPending(...args));

const ledger = new TransactionLedger({ maxHistory: 300, maxRecordHistory: 160 });
export function getNexusLedger() { return ledger; }

function withOperatorReviewAssumptions(base = {}, { scope = null } = {}) {
    const resolved=scope ? normalizeOperatorReviewScope(scope) : currentOperatorReviewScope();
    return { ...deepCopy(base || {}), chatId: resolved.kind==='chat' ? (base?.chatId ?? resolved.chatId) : null, operatorReviewScope: resolved.identity };
}
function lorebookReviewScope(book){return lorebookOperatorReviewScope(String(book||''));}

function equivalentDurableReviewProjection(durable, expected) {
    if (!durable || !expected || String(durable.id || '') !== String(expected.id || '') || String(durable.state || '') !== String(expected.state || '')) return false;
    const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
    return same(durable.staged, expected.staged)
        && same(durable.committed, expected.committed)
        && same(durable.approval, expected.approval)
        && same(durable.error, expected.error)
        && same(durable.mutationProposal?.state ?? null, expected.mutationProposal?.state ?? null)
        && same(durable.mutationProposal?.draft ?? null, expected.mutationProposal?.draft ?? null);
}

async function persistReviewOverrides(targetLedger, transactions) {
    const rows=(Array.isArray(transactions)?transactions:[transactions]).filter(Boolean).map(deepCopy);
    if (!rows.length) throw new Error('Nexus Operator Review projection requires at least one transaction.');
    const projectedScopes=rows.map(row=>row?.metadata?.reviewScope).filter(Boolean).map(normalizeOperatorReviewScope);
    const scope=projectedScopes[0]||currentOperatorReviewScope();
    if(projectedScopes.some(candidate=>candidate.identity!==scope.identity))throw new Error('Nexus Operator Review projection mixes durable review scopes.');
    const store=createOperatorReviewStore({scope});
    try {
        store.load();
        try { return await store.persist(null, targetLedger, { transactionOverrides: rows }); }
        catch (error) {
            // A storage write can succeed and its acknowledgement/read-back can still
            // fail.  Before converting that into a false durability failure, prove
            // every exact projected row is now durable.  This is intentionally
            // projection-specific; merely finding the transaction ID is insufficient.
            let proven=true;
            for (const row of rows) {
                let durable=null;
                try { durable=store.inspectTransaction(row.id); } catch { proven=false; break; }
                if (!equivalentDurableReviewProjection(durable,row) && !store.provesTerminalTransactionProjection?.(row)) { proven=false; break; }
            }
            if (proven) return { durable:true, persistenceDegraded:true, persistenceError:String(error?.message||error) };
            throw error;
        }
    } finally { store.close(); }
}

async function persistReviewSupersession(targetLedger, priorProjection, replacementProjection) {
    const rows=[deepCopy(priorProjection),deepCopy(replacementProjection)];
    const projectedScopes=rows.map(row=>row?.metadata?.reviewScope).filter(Boolean).map(normalizeOperatorReviewScope);
    const scope=projectedScopes[0]||currentOperatorReviewScope();
    if(projectedScopes.some(candidate=>candidate.identity!==scope.identity))throw new Error('Nexus Operator Review supersession mixes durable review scopes.');
    const store=createOperatorReviewStore({scope});
    try {
        store.load();
        if(typeof store.persistSupersession!=='function'){const error=new Error('Operator Review durable supersession CAS is unavailable.');error.name='TV2OperatorReviewDurabilityUnavailable';throw error;}
        try{return await store.persistSupersession(null,targetLedger,rows[0],rows[1]);}
        catch(error){
            let proven=true;
            for(const row of rows){let durable=null;try{durable=store.inspectTransaction(row.id);}catch{proven=false;break;}if(!equivalentDurableReviewProjection(durable,row)&&!store.provesTerminalTransactionProjection?.(row)){proven=false;break;}}
            if(proven)return {durable:true,persistenceDegraded:true,persistenceError:String(error?.message||error)};
            throw error;
        }
    } finally { store.close(); }
}

export async function persistNexusReviewTransaction(transactionId, { targetLedger = ledger } = {}) {
    const tx=targetLedger.read(transactionId);
    if(!tx)throw new Error(`Unknown Nexus transaction: ${String(transactionId)}`);
    return await persistReviewOverrides(targetLedger, [tx]);
}

export async function persistNexusReviewTransactionProjections(transactions, { targetLedger = ledger } = {}) {
    return await persistReviewOverrides(targetLedger, transactions);
}

export async function transitionNexusReviewTransactionDurably(transactionId, transition, { targetLedger = ledger } = {}) {
    const current=targetLedger.read(transactionId);
    if(!current)throw new Error(`Unknown Nexus transaction: ${String(transactionId)}`);
    if(typeof transition!=='function')throw new Error('A durable Nexus review transition requires a transition function.');
    const shadow=new TransactionLedger({maxHistory:Math.max(8,targetLedger.maxHistory||200),maxRecordHistory:Math.max(20,targetLedger.maxRecordHistory||160)});
    shadow.restore([current],{replace:true});
    const projected=await transition(shadow,shadow.read(transactionId));
    const next=projected?.id?projected:shadow.read(transactionId);
    if(!next||String(next.id)!==String(transactionId))throw new Error('Durable Nexus review transition did not produce the expected transaction identity.');
    await persistReviewOverrides(targetLedger,[next]);
    // Only after the projected authority is durable do we expose the transition
    // through the live Ledger.  restore(replace) preserves the exact proposal IDs,
    // audit events and timestamps that were durably written.
    targetLedger.restore([next],{replace:true});
    return targetLedger.read(transactionId);
}

export async function abortNexusReviewTransactionDurably(transactionId, reason = 'Aborted', options = {}) {
    return await transitionNexusReviewTransactionDurably(transactionId, shadow => shadow.abort(transactionId, reason), options);
}

export async function cancelNexusReviewTransactionDurably(transactionId, reason = 'Cancelled', options = {}) {
    return await transitionNexusReviewTransactionDurably(transactionId, shadow => shadow.cancel(transactionId, reason), options);
}

export async function staleNexusReviewTransactionDurably(transactionId, reason = 'Transaction assumptions changed before commit.', freshness = null, options = {}) {
    return await transitionNexusReviewTransactionDurably(transactionId, shadow => shadow.stale(transactionId, reason, freshness), options);
}

export async function supersedeNexusReviewTransactionDurably(priorTransactionId, replacementTransactionId, reason = 'Superseded', { targetLedger = ledger } = {}) {
    const prior=targetLedger.read(priorTransactionId);
    const replacement=targetLedger.read(replacementTransactionId);
    if(!prior)throw new Error(`Unknown Nexus transaction: ${String(priorTransactionId)}`);
    if(!replacement)throw new Error(`Unknown Nexus transaction: ${String(replacementTransactionId)}`);
    if(String(prior.state)!=='staged'||String(replacement.state)!=='staged'){const error=new Error('Durable review supersession requires both the prior and replacement transactions to be STAGED.');error.name='TV2OperatorReviewStateConflict';throw error;}
    const shadow=new TransactionLedger({maxHistory:Math.max(8,targetLedger.maxHistory||200),maxRecordHistory:Math.max(20,targetLedger.maxRecordHistory||160)});
    shadow.restore([prior,replacement],{replace:true});
    const cancelled=shadow.cancel(priorTransactionId,reason);
    const projectedReplacement=shadow.read(replacementTransactionId);
    try {
        await persistReviewSupersession(targetLedger,cancelled,projectedReplacement);
    } catch (error) {
        // The replacement has not become authoritative unless the two-row durable
        // projection succeeded (including exact read-back acknowledgement repair).
        // Remove the provisional live replacement so callers retain exactly the
        // original actionable owner on a true persistence failure.
        try { targetLedger.cancel(replacementTransactionId,`Replacement review was not durably admitted: ${String(error?.message||error)}`); } catch {}
        throw error;
    }
    targetLedger.restore([cancelled,projectedReplacement],{replace:true});
    return { prior:targetLedger.read(priorTransactionId), replacement:targetLedger.read(replacementTransactionId) };
}

export function invalidateNexusTransactionsForChat(chatId, reason = 'Chat scope changed.') { return ledger.invalidateChat(chatId, reason); }
export function invalidateNexusTransactionsForReviewScope(scopeIdentity, reason = 'Operator review scope changed.') {
    const target = String(scopeIdentity || '').trim();
    if (!target) return [];
    return ledger.invalidateWhere(record => String(record?.assumptions?.operatorReviewScope || record?.metadata?.reviewScope?.identity || '').trim() === target, reason);
}
export function initializeNexusTransactionExecution(id, execution = {}) { return ledger.initializeExecution(id, execution); }
export function updateNexusTransactionExecution(id, patch = {}, event = 'execution-updated') { return ledger.updateExecution(id, patch, event); }
export function recordNexusTransactionSlice(id, details = {}) { return ledger.recordSlice(id, details); }
export function markNexusTransactionAggregating(id, metadata = {}) { return ledger.aggregating(id, metadata); }
export function enforceNexusTransactionFreshBeforeStage(id, currentAssumptions) {
    const freshness = ledger.checkFresh(id, currentAssumptions);
    if (!freshness.fresh) return ledger.stale(id, 'Transaction became stale before staging final aggregation.', freshness);
    return ledger.read(id);
}

function entryAssumption(entry, fallbackUid = null) {
    if (entry && typeof entry === 'object') return {
        uid: Number(entry.uid ?? fallbackUid),
        content: String(entry.content ?? ''),
        comment: String(entry.comment ?? ''),
        key: deepCopy(entry.key || []),
        disable: entry.disable === true,
    };
    return { uid: Number(fallbackUid), content: String(entry ?? ''), comment: '', key: [], disable: false };
}

export function buildSummaryAssumptions({ book, uid, cap, optionId = null, sourceEntry = null, originalContent = '', relevantState = null } = {}) {
    return withOperatorReviewAssumptions({
        book: String(book || ''),
        uid: Number(uid),
        cap: Number(cap),
        optionId: optionId == null ? null : String(optionId),
        source: entryAssumption(sourceEntry || originalContent, uid),
        relevantState: deepCopy(relevantState),
    }, { scope: lorebookReviewScope(book) });
}

export function buildMergeAssumptions({ book, keepUid, removeUid, profile = 'balanced', targetNodeId = null, sourceA, sourceB, relevantState = null } = {}) {
    const normalizedProfile=['lean','balanced','heavy'].includes(String(profile||'').toLowerCase())?String(profile).toLowerCase():'balanced';
    return withOperatorReviewAssumptions({
        book: String(book || ''),
        keepUid: Number(keepUid),
        removeUid: Number(removeUid),
        profile: normalizedProfile,
        targetNodeId: targetNodeId == null ? null : String(targetNodeId),
        sourceA: entryAssumption(sourceA, keepUid),
        sourceB: entryAssumption(sourceB, removeUid),
        relevantState: deepCopy(relevantState),
    }, { scope: lorebookReviewScope(book) });
}


export function buildPostTurnProposalAssumptions({
    chatId = null,
    sourceRange = [],
    sourceMessages = [],
    writableBooks = [],
    writeModes = {},
    relevantState = null,
} = {}) {
    const range = Array.isArray(sourceRange) ? sourceRange.slice(0, 2).map(value => Number(value)) : [];
    const books = [...new Set((Array.isArray(writableBooks) ? writableBooks : []).map(value => String(value || '').trim()).filter(Boolean))].sort();
    const normalizedModes = {};
    for (const book of books) normalizedModes[book] = String(writeModes?.[book] || 'review');
    return {
        chatId: chatId == null ? null : String(chatId),
        sourceRange: range,
        sourceMessages: deepCopy(Array.isArray(sourceMessages) ? sourceMessages : []),
        writableBooks: books,
        writeModes: normalizedModes,
        relevantState: deepCopy(relevantState),
    };
}


export function buildMemorySummaryAssumptions({
    chatId = null,
    sourceRange = [],
    sourceMessages = [],
    summarizedUpTo = -1,
    priorMemoryFingerprint = '',
    passageFingerprint = '',
    relevantState = null,
} = {}) {
    return {
        chatId: chatId == null ? null : String(chatId),
        sourceRange: Array.isArray(sourceRange) ? sourceRange.slice(0, 2).map(value => Number(value)) : [],
        sourceMessages: deepCopy(Array.isArray(sourceMessages) ? sourceMessages : []),
        summarizedUpTo: Number.isFinite(Number(summarizedUpTo)) ? Number(summarizedUpTo) : -1,
        priorMemoryFingerprint: String(priorMemoryFingerprint || ''),
        passageFingerprint: String(passageFingerprint || ''),
        relevantState: deepCopy(relevantState),
    };
}


export function buildNotebookAssumptions({
    chatId = null,
    sourceMessages = [],
    priorNotebook = null,
    contextMessages = 8,
    characterNames = [],
    relevantState = null,
} = {}) {
    const notebook = priorNotebook && typeof priorNotebook === 'object' ? priorNotebook : {};
    return {
        chatId: chatId == null ? null : String(chatId),
        sourceMessages: deepCopy(Array.isArray(sourceMessages) ? sourceMessages : []),
        priorNotebook: {
            text: String(notebook.text || ''),
            updatedAt: Number(notebook.updatedAt) || 0,
            updatedBy: String(notebook.updatedBy || 'none'),
            revisionCount: Array.isArray(notebook.revisions) ? notebook.revisions.length : Math.max(0, Number(notebook.revisionCount) || 0),
        },
        contextMessages: Math.max(1, Math.floor(Number(contextMessages) || 8)),
        characterNames: [...new Set((Array.isArray(characterNames) ? characterNames : []).map(value => String(value || '').trim()).filter(Boolean))],
        relevantState: deepCopy(relevantState),
    };
}

export function beginNotebookRefreshTransaction({ assumptions = {}, metadata = {} } = {}) {
    const normalized = buildNotebookAssumptions(assumptions);
    const tx = ledger.begin({
        type: 'notebook-refresh',
        input: { chatId: normalized.chatId, contextMessages: normalized.contextMessages },
        snapshot: {
            sourceMessages: normalized.sourceMessages,
            priorNotebook: normalized.priorNotebook,
            characterNames: normalized.characterNames,
            relevantState: deepCopy(normalized.relevantState),
        },
        assumptions: normalized,
        metadata: { source: 'notebook', ...deepCopy(metadata || {}) },
    });
    return ledger.executing(tx.id);
}

export function recordNotebookRefreshParsed(id, payload, raw = undefined) {
    return ledger.parsed(id, deepCopy(payload || {}), raw);
}

export function stageNotebookRefreshTransaction(id, { payload = {}, metadata = {} } = {}) {
    const changed = payload?.changed === true;
    const notebook = String(payload?.notebook || '').trim();
    const reason = String(payload?.reason || '').trim();
    const evidence = Array.isArray(payload?.evidence) ? payload.evidence : null;
    const valid = changed && !!notebook && !!reason && !!evidence;
    const checked = ledger.validated(id, {
        passed: valid,
        reason: valid ? null : 'Notebook mutation draft requires changed=true, non-empty complete Notebook text, reason, and evidence array.',
        checks: { changed, nonEmpty: !!notebook, reason: !!reason, evidenceArray: !!evidence },
    });
    if (checked.state !== 'validated') return checked;
    return ledger.staged(id, deepCopy(payload), {
        mutationProposal: {
            type: 'notebook-refresh',
            target: { chatId: ledger.read(id)?.assumptions?.chatId || null },
            draft: deepCopy(payload),
            assumptions: ledger.read(id)?.assumptions || {},
            approvalRequired: false,
            metadata: deepCopy(metadata || {}),
        },
    });
}

export function beginMemorySummaryTransaction({ assumptions = {}, metadata = {}, execution = {} } = {}) {
    const normalized = buildMemorySummaryAssumptions(assumptions);
    const tx = ledger.begin({
        type: 'memory-summary-create',
        input: { sourceRange: normalized.sourceRange, summarizedUpTo: normalized.summarizedUpTo },
        snapshot: {
            sourceMessages: normalized.sourceMessages,
            priorMemoryFingerprint: normalized.priorMemoryFingerprint,
            passageFingerprint: normalized.passageFingerprint,
            relevantState: deepCopy(normalized.relevantState),
        },
        assumptions: normalized,
        metadata: { source: 'memory-summary', ...deepCopy(metadata || {}) },
    });
    const running = ledger.executing(tx.id);
    ledger.initializeExecution(running.id, { workload: 'summary', sourceFingerprints: { priorMemory: normalized.priorMemoryFingerprint, passage: normalized.passageFingerprint }, identity: { chatId: normalized.chatId, sourceRange: normalized.sourceRange }, ...deepCopy(execution || {}) });
    return ledger.read(running.id);
}

export function finalizeMemorySummaryTransaction(id, { draft = {}, metadata = {} } = {}) {
    const text = String(draft?.text || draft?.summary || '').trim();
    ledger.parsed(id, deepCopy(draft), { kind: 'validated-final-aggregation' });
    const checked = ledger.validated(id, { passed: !!text, reason: text ? null : 'Memory summary draft is empty.', checks: { nonEmpty: !!text } });
    if (checked.state !== 'validated') return checked;
    const assumptions = ledger.read(id)?.assumptions || {};
    return ledger.staged(id, deepCopy(draft), { mutationProposal: { type: 'memory-summary-create', target: { sourceRange: assumptions.sourceRange || [] }, draft: deepCopy(draft), assumptions, approvalRequired: false, metadata: deepCopy(metadata || {}) } });
}

export function stageMemorySummaryTransaction({
    assumptions = {},
    draft = {},
    metadata = {},
} = {}) {
    const tx = beginMemorySummaryTransaction({ assumptions, metadata, execution: { status: 'aggregating', sliceManifest: [] } });
    return finalizeMemorySummaryTransaction(tx.id, { draft, metadata });
}

export function beginPostTurnProposalTransaction({
    chatId = null,
    sourceRange = [],
    sourceMessages = [],
    writableBooks = [],
    writeModes = {},
    relevantState = null,
    metadata = {},
} = {}) {
    const assumptions = buildPostTurnProposalAssumptions({ chatId, sourceRange, sourceMessages, writableBooks, writeModes, relevantState });
    const tx = ledger.begin({
        type: 'post-turn-proposal-stage',
        input: { sourceRange: assumptions.sourceRange, writableBooks: assumptions.writableBooks },
        snapshot: { sourceMessages: assumptions.sourceMessages, relevantState: deepCopy(relevantState) },
        assumptions,
        metadata: { source: 'post-turn', ...deepCopy(metadata || {}) },
    });
    return ledger.executing(tx.id);
}

export function finalizePostTurnProposalTransaction(id, { parsed = {}, metadata = {} } = {}) {
    const record = ledger.read(id);
    if (!record) throw new Error(`Unknown Nexus transaction: ${id}`);
    if (record.state !== 'executing') throw new Error(`Post-turn transaction ${id} is not executing.`);
    const assumptions = record.assumptions || {};
    const operations = Array.isArray(parsed?.operations) ? deepCopy(parsed.operations) : [];
    const structuralErrors = [];
    operations.forEach((op, index) => {
        if (!op || typeof op !== 'object' || Array.isArray(op)) structuralErrors.push(`operation ${index} is not an object`);
        else {
            if (!String(op.type || '').trim()) structuralErrors.push(`operation ${index} is missing type`);
            if (!String(op.book || '').trim() && assumptions.writableBooks.length > 1) structuralErrors.push(`operation ${index} is missing book`);
        }
    });
    const draft = { operations, reasoning: String(parsed?.reasoning || '') };
    ledger.parsed(id, draft, { kind: 'post-turn-final-output' });
    const checked = ledger.validated(id, {
        passed: structuralErrors.length === 0,
        reason: structuralErrors.length ? `Post-turn proposal validation failed: ${structuralErrors.join('; ')}` : null,
        checks: { structuralErrors },
    });
    if (checked.state !== 'validated') return checked;
    return ledger.staged(id, draft, {
        mutationProposal: {
            type: 'post-turn-proposal-stage',
            target: { books: assumptions.writableBooks },
            draft,
            assumptions,
            approvalRequired: false,
            metadata: deepCopy(metadata || {}),
        },
    });
}

export function stagePostTurnProposalTransaction(options = {}) {
    const tx = beginPostTurnProposalTransaction(options);
    return finalizePostTurnProposalTransaction(tx.id, { parsed: options.parsed || {}, metadata: options.metadata || {} });
}

function stage({ type, input, snapshot, assumptions, draft, validation, mutationProposal = null, metadata = {} }) {
    const tx = ledger.begin({ type, input, snapshot, assumptions, metadata: { source: 'interactive-review', ...deepCopy(metadata || {}) } });
    ledger.executing(tx.id);
    ledger.parsed(tx.id, draft, { kind: 'interactive-draft' });
    const checked = ledger.validated(tx.id, validation);
    return checked.state === 'validated' ? ledger.staged(tx.id, draft, { mutationProposal }) : checked;
}

export function beginUidSummaryTransaction({ book, uid, originalContent = '', originalEntry = null, cap, relevantState = null, metadata = {}, execution = {} } = {}) {
    const assumptions = buildSummaryAssumptions({ book, uid, cap, optionId: null, sourceEntry: originalEntry, originalContent, relevantState });
    const tx = ledger.begin({ type: 'uid-summary', input: { book, uid: Number(uid), cap: Number(cap), optionId: null }, snapshot: { book, uid: Number(uid), entry: deepCopy(originalEntry), content: originalContent }, assumptions, metadata: { source: 'uid-summary', reviewScope: operatorReviewScopeProjection(lorebookReviewScope(book),0), ...deepCopy(metadata || {}) } });
    const running = ledger.executing(tx.id);
    ledger.initializeExecution(running.id, { workload: 'uid-summary', identity: { book: String(book || ''), uid: Number(uid) }, outputCap: Number(cap), ...deepCopy(execution || {}) });
    return ledger.read(running.id);
}

export function validateUidSummaryTransactionResult(id, { result = {}, validation = {} } = {}) {
    ledger.parsed(id, deepCopy(result), { kind: 'validated-final-aggregation' });
    return ledger.validated(id, validation);
}

export function stageUidSummarySelectionTransaction(id, { draft = {}, cap, estimatedTokens, optionId = null, metadata = {} } = {}) {
    const record = ledger.read(id);
    if (!record) throw new Error(`Unknown Nexus transaction: ${id}`);
    if (record.state !== 'validated') throw new Error(`UID summary transaction ${id} must be validated before a reviewed option can be staged.`);
    const content = String(draft?.content || '').trim();
    const valid = !!content && Number(estimatedTokens) <= Number(cap);
    if (!valid) return ledger.fail(id, `Summary exceeds its ${cap}-token ceiling or is empty.`, { cap, estimatedTokens });
    const assumptions = record.assumptions || {};
    return ledger.staged(id, { ...deepCopy(draft), estimatedTokens, cap, optionId }, { mutationProposal: { type: 'uid-summary', target: { book: assumptions.book, uid: Number(assumptions.uid) }, draft: deepCopy(draft), assumptions, approvalRequired: true, metadata: { optionId, selectedCap: Number(cap), ...deepCopy(metadata || {}) } } });
}

export function beginMergeTransaction({ book, keepUid, removeUid, sourceA, sourceB, profile = 'balanced', targetNodeId = null, relevantState = null, metadata = {}, execution = {} } = {}) {
    const assumptions = buildMergeAssumptions({ book, keepUid, removeUid, sourceA, sourceB, profile, targetNodeId, relevantState });
    const tx = ledger.begin({ type: 'merge', input: { book, keepUid: Number(keepUid), removeUid: Number(removeUid), profile: assumptions.profile, targetNodeId }, snapshot: { book, sources: [deepCopy(sourceA), deepCopy(sourceB)], relevantState: deepCopy(relevantState) }, assumptions, metadata: { source: 'merge', reviewScope: operatorReviewScopeProjection(lorebookReviewScope(book),0), ...deepCopy(metadata || {}) } });
    const running = ledger.executing(tx.id);
    ledger.initializeExecution(running.id, { workload: 'merge', identity: { book: String(book || ''), keepUid: Number(keepUid), removeUid: Number(removeUid) }, draftProfile: assumptions.profile, ...deepCopy(execution || {}) });
    return ledger.read(running.id);
}

export function finalizeMergeTransaction(id, { draft = {}, profile = null, estimatedTokens, metadata = {} } = {}) {
    const record = ledger.read(id);
    if (!record) throw new Error(`Unknown Nexus transaction: ${id}`);
    const content = String(draft?.content || '').trim();
    const distinct = Number(record.assumptions?.keepUid) !== Number(record.assumptions?.removeUid);
    const selectedProfile = profile || record.assumptions?.profile || 'balanced';
    ledger.parsed(id, { ...deepCopy(draft), estimatedTokens, profile: selectedProfile }, { kind: 'validated-final-aggregation' });
    const checked = ledger.validated(id, { passed: !!content && distinct, reason: content && distinct ? null : 'Merge draft is empty or references the same UID twice.', checks: { nonEmpty: !!content, distinctUids: distinct, hardTokenCap: false } });
    if (checked.state !== 'validated') return checked;
    const assumptions = ledger.read(id)?.assumptions || {};
    return ledger.staged(id, { ...deepCopy(draft), estimatedTokens, profile: selectedProfile, targetNodeId: assumptions.targetNodeId ?? null }, { mutationProposal: { type: 'merge', target: { book: assumptions.book, keepUid: Number(assumptions.keepUid), removeUid: Number(assumptions.removeUid), targetNodeId: assumptions.targetNodeId ?? null }, draft: deepCopy(draft), assumptions, approvalRequired: true, metadata: { draftProfile: selectedProfile, ...deepCopy(metadata || {}) } } });
}

export function stageSummaryTransaction({ book, uid, originalContent, originalEntry = null, draft, cap, estimatedTokens, optionId = null, relevantState = null } = {}) {
    const valid = String(draft?.content || '').trim() && Number(estimatedTokens) <= Number(cap);
    const assumptions = buildSummaryAssumptions({ book, uid, cap, optionId, sourceEntry: originalEntry, originalContent, relevantState });
    return stage({
        type: 'uid-summary',
        input: { book, uid, cap, optionId },
        snapshot: { book, uid, entry: deepCopy(originalEntry), content: originalContent },
        assumptions,
        draft: { ...deepCopy(draft), estimatedTokens, cap },
        validation: {
            passed: valid,
            reason: valid ? null : `Summary exceeds its ${cap}-token ceiling or is empty.`,
            checks: { nonEmpty: !!String(draft?.content || '').trim(), cap: Number(estimatedTokens) <= Number(cap) },
        },
        mutationProposal: { type: 'uid-summary', target: { book, uid: Number(uid) }, draft, assumptions, approvalRequired: true },
    });
}

export function stageMergeTransaction({ book, keepUid, removeUid, sourceA, sourceB, draft, profile = 'balanced', estimatedTokens, targetNodeId = null, relevantState = null } = {}) {
    const valid = !!String(draft?.content || '').trim() && Number(keepUid) !== Number(removeUid);
    const assumptions = buildMergeAssumptions({ book, keepUid, removeUid, sourceA, sourceB, profile, targetNodeId, relevantState });
    return stage({
        type: 'merge',
        input: { book, keepUid, removeUid, profile: assumptions.profile, targetNodeId },
        snapshot: { book, sources: [deepCopy(sourceA), deepCopy(sourceB)], relevantState: deepCopy(relevantState) },
        assumptions,
        draft: { ...deepCopy(draft), estimatedTokens, profile: assumptions.profile, targetNodeId },
        validation: {
            passed: valid,
            reason: valid ? null : 'Merge draft is empty or references the same UID twice.',
            checks: { nonEmpty: !!String(draft?.content || '').trim(), distinctUids: Number(keepUid) !== Number(removeUid), hardTokenCap: false },
        },
        mutationProposal: { type: 'merge', target: { book, keepUid: Number(keepUid), removeUid: Number(removeUid), targetNodeId }, draft, assumptions, approvalRequired: true, metadata: { draftProfile: assumptions.profile } },
    });
}

export function buildMemoryPromotionAssumptions({
    chatId = null,
    sourceLayer = 0,
    targetLayer = 1,
    childRecords = [],
    activeSourceLayerIds = [],
    activeTargetLayerIds = [],
    snippetsPerLayer = 20,
    snippetsPerPromotion = 3,
    maxLayers = 5,
    priorDestinationFingerprint = '',
    relevantState = null,
} = {}) {
    return {
        chatId: chatId == null ? null : String(chatId),
        sourceLayer: Math.max(0, Math.floor(Number(sourceLayer) || 0)),
        targetLayer: Math.max(0, Math.floor(Number(targetLayer) || 0)),
        childRecords: deepCopy(Array.isArray(childRecords) ? childRecords : []),
        activeSourceLayerIds: (Array.isArray(activeSourceLayerIds) ? activeSourceLayerIds : []).map(String),
        activeTargetLayerIds: (Array.isArray(activeTargetLayerIds) ? activeTargetLayerIds : []).map(String),
        snippetsPerLayer: Math.max(2, Math.floor(Number(snippetsPerLayer) || 20)),
        snippetsPerPromotion: Math.max(2, Math.floor(Number(snippetsPerPromotion) || 3)),
        maxLayers: Math.max(1, Math.floor(Number(maxLayers) || 5)),
        priorDestinationFingerprint: String(priorDestinationFingerprint || ''),
        relevantState: deepCopy(relevantState),
    };
}

export function beginMemoryPromotionTransaction({ assumptions = {}, metadata = {} } = {}) {
    const normalized = buildMemoryPromotionAssumptions(assumptions);
    const tx = ledger.begin({
        type: 'memory-summary-promotion',
        input: {
            sourceLayer: normalized.sourceLayer,
            targetLayer: normalized.targetLayer,
            childIds: normalized.childRecords.map(record => String(record.id)),
        },
        snapshot: {
            childRecords: normalized.childRecords,
            activeSourceLayerIds: normalized.activeSourceLayerIds,
            activeTargetLayerIds: normalized.activeTargetLayerIds,
            relevantState: deepCopy(normalized.relevantState),
        },
        assumptions: normalized,
        metadata: { source: 'memory-promotion', ...deepCopy(metadata || {}) },
    });
    return ledger.executing(tx.id);
}

export function finalizeMemoryPromotionTransaction(id, { draft = {}, metadata = {} } = {}) {
    const record = ledger.read(id);
    if (!record) throw new Error(`Unknown Nexus transaction: ${id}`);
    if (record.state !== 'executing') throw new Error(`Memory promotion transaction ${id} is not executing.`);
    const normalized = record.assumptions || {};
    const text = String(draft?.text || draft?.summary || '').trim();
    const validChildren = Array.isArray(normalized.childRecords) && normalized.childRecords.length >= 2
        && normalized.childRecords.every(record => String(record?.id || '').trim());
    ledger.parsed(id, deepCopy(draft), { kind: 'memory-promotion-final-output' });
    const checked = ledger.validated(id, {
        passed: !!text && validChildren,
        reason: !text ? 'Memory promotion draft is empty.' : (!validChildren ? 'Memory promotion requires at least two valid source memories.' : null),
        checks: { nonEmpty: !!text, validChildren },
    });
    if (checked.state !== 'validated') return checked;
    return ledger.staged(id, deepCopy(draft), {
        mutationProposal: {
            type: 'memory-summary-promotion',
            target: { layer: normalized.targetLayer, childIds: normalized.childRecords.map(record => String(record.id)) },
            draft: deepCopy(draft),
            assumptions: normalized,
            approvalRequired: false,
            metadata: deepCopy(metadata || {}),
        },
    });
}

export function stageMemoryPromotionTransaction(options = {}) {
    const tx = beginMemoryPromotionTransaction(options);
    return finalizeMemoryPromotionTransaction(tx.id, { draft: options.draft || {}, metadata: options.metadata || {} });
}

export function buildLoreRoutingAssumptions({
    chatId = null,
    memory = null,
    readableBooks = [],
    writableBooks = [],
    writeModes = {},
    routeMode = 'balanced',
    candidateSnapshot = [],
    treeFingerprint = '',
    routingConfig = null,
    relevantState = null,
} = {}) {
    const readable = [...new Set((Array.isArray(readableBooks) ? readableBooks : []).map(value => String(value || '').trim()).filter(Boolean))].sort();
    const writable = [...new Set((Array.isArray(writableBooks) ? writableBooks : []).map(value => String(value || '').trim()).filter(Boolean))].sort();
    const modes = {};
    for (const book of writable) modes[book] = String(writeModes?.[book] || 'review');
    return {
        chatId: chatId == null ? null : String(chatId),
        memory: deepCopy(memory && typeof memory === 'object' ? memory : null),
        readableBooks: readable,
        writableBooks: writable,
        writeModes: modes,
        routeMode: String(routeMode || 'balanced'),
        candidateSnapshot: deepCopy(Array.isArray(candidateSnapshot) ? candidateSnapshot : []),
        treeFingerprint: String(treeFingerprint || ''),
        routingConfig: deepCopy(routingConfig),
        relevantState: deepCopy(relevantState),
    };
}

export function beginLoreRoutingTransaction({ assumptions = {}, metadata = {} } = {}) {
    const normalized = buildLoreRoutingAssumptions(assumptions);
    const tx = ledger.begin({
        type: 'summary-lore-route',
        input: {
            memoryId: normalized.memory?.id == null ? null : String(normalized.memory.id),
            writableBooks: normalized.writableBooks,
        },
        snapshot: {
            memory: normalized.memory,
            candidateSnapshot: normalized.candidateSnapshot,
            treeFingerprint: normalized.treeFingerprint,
            relevantState: deepCopy(normalized.relevantState),
        },
        assumptions: normalized,
        metadata: { source: 'summary-lore-router', ...deepCopy(metadata || {}) },
    });
    return ledger.executing(tx.id);
}

export function finalizeLoreRoutingTransaction(id, { parsed = {}, metadata = {} } = {}) {
    const record = ledger.read(id);
    if (!record) throw new Error(`Unknown Nexus transaction: ${id}`);
    if (record.state !== 'executing') throw new Error(`Summary-to-Lore transaction ${id} is not executing.`);
    const normalized = record.assumptions || {};
    const operations = Array.isArray(parsed?.operations) ? deepCopy(parsed.operations) : [];
    const structuralErrors = [];
    operations.forEach((op, index) => {
        if (!op || typeof op !== 'object' || Array.isArray(op)) {
            structuralErrors.push(`operation ${index} is not an object`);
            return;
        }
        if (!String(op.type || '').trim()) structuralErrors.push(`operation ${index} is missing type`);
        const book = String(op.book || '').trim();
        if (!book) structuralErrors.push(`operation ${index} is missing book`);
        else if (!normalized.writableBooks.includes(book)) structuralErrors.push(`operation ${index} targets non-writable book ${book}`);
        if (String(op.type || '').trim().toLowerCase() === 'update') {
            const mode = String(op.mode || '').trim().toLowerCase();
            if (!['append', 'replace'].includes(mode)) structuralErrors.push(`operation ${index} update mode must be append or replace`);
        }
    });
    const draft = { operations, reasoning: String(parsed?.reasoning || '') };
    ledger.parsed(id, draft, { kind: 'summary-lore-final-output' });
    const checked = ledger.validated(id, {
        passed: structuralErrors.length === 0,
        reason: structuralErrors.length ? `Summary-to-Lore routing validation failed: ${structuralErrors.join('; ')}` : null,
        checks: { structuralErrors },
    });
    if (checked.state !== 'validated') return checked;
    return ledger.staged(id, draft, {
        mutationProposal: {
            type: 'summary-lore-route',
            target: { memoryId: normalized.memory?.id || null, books: normalized.writableBooks },
            draft,
            assumptions: normalized,
            approvalRequired: false,
            metadata: deepCopy(metadata || {}),
        },
    });
}

export function stageLoreRoutingTransaction(options = {}) {
    const tx = beginLoreRoutingTransaction(options);
    return finalizeLoreRoutingTransaction(tx.id, { parsed: options.parsed || {}, metadata: options.metadata || {} });
}

export function inspectNexusTransactionFreshness(id, currentAssumptions) { return ledger.checkFresh(id, currentAssumptions); }
export function approveNexusTransaction(id, options = {}) { return ledger.approve(id, options); }
export function rejectNexusTransaction(id, reason) { return ledger.reject(id, reason); }
export function prepareNexusTransactionCommitState(id, currentAssumptions, targetLedger = ledger) {
    const owner = targetLedger || ledger;
    return owner.prepareCommit(id, { currentAssumptions });
}

export function beginPreparedNexusTransactionCommit(id, { mutation = null, recovery = null, metadata = null } = {}, targetLedger = ledger) {
    const owner = targetLedger || ledger;
    const prepared = owner.read(id);
    if (!prepared) throw new Error(`Unknown Nexus transaction: ${id}`);
    if (prepared.state !== 'committing') return prepared;
    beginNexusCommitIntent(prepared, { mutation, recovery, metadata });
    return owner.read(id);
}

export function failPreparedNexusCommitIntent(id, error) { return failNexusCommitIntent(id, error, { recoveryRequired: false }); }

export function updatePreparedNexusCommitRecovery(id, recovery, targetLedger = ledger) {
    const owner = targetLedger || ledger;
    if (!owner.read(id)) throw new Error(`Unknown Nexus transaction: ${id}`);
    updateNexusCommitIntentRecovery(id, recovery);
    return owner.read(id);
}

export function updatePreparedNexusCommitPhase(id, phase, details = {}, targetLedger = ledger) {
    const owner = targetLedger || ledger;
    if (!owner.read(id)) throw new Error(`Unknown Nexus transaction: ${id}`);
    return updateNexusCommitIntentPhase(id, phase, details);
}
export function inspectNexusCommitResourceConflicts(resources, options = {}) { return findNexusCommitResourceConflicts(resources, options); }
export function supersedeAppliedNexusCommitEffect(id, options = {}) { return markNexusCommitEffectSuperseded(id, options); }

export function prepareNexusTransactionCommit(id, currentAssumptions, targetLedger = ledger) {
    const owner = targetLedger || ledger;
    const prepared = prepareNexusTransactionCommitState(id, currentAssumptions, owner);
    if (prepared.state !== 'committing') return prepared;
    try { beginNexusCommitIntent(prepared); }
    catch (error) {
        // Same-session recovery must not depend on a page reload.  If the
        // durable journal already reached APPLIED for this exact identity,
        // settle that older row as confirmed-applied now while preserving its
        // replay fence.  The new transaction still fails rather than replaying
        // a mutation whose physical persistence is already known to have run.
        if (error?.name === 'TV2CommitAlreadyApplied' && String(error?.commitIntent?.state || '') === 'applied') {
            try { resolveNexusCommitRecovery(error.commitIntent.id, {
                disposition: 'confirmed-applied',
                note: 'Auto-reconciled during same-session retry: durable journal already recorded physical persistence as APPLIED.',
            }); } catch {}
        }
        try { owner.fail(id, error, { stage: error?.name === 'TV2CommitAlreadyApplied' ? 'commit-already-applied' : 'commit-intent' }); } catch {}
        throw error;
    }
    return owner.read(id);
}
export function completeNexusTransactionCommit(id, committed, targetLedger = ledger) {
    const owner = targetLedger || ledger;
    // Physical persistence has already occurred when callers enter here. Mark the
    // durable intent APPLIED before the in-memory Ledger is finalized so a crash
    // or thrown finalization cannot silently turn the operation back into pending.
    markNexusCommitIntentApplied(id, committed);
    try {
        const result = owner.completeCommit(id, committed);
        completeNexusCommitIntent(id, committed);
        return result;
    } catch (error) {
        // APPLIED is authoritative: never downgrade a physically-applied mutation
        // to FAILED merely because in-memory Ledger finalization threw. Reconcile
        // the Ledger immediately and resolve the durable row as committed.
        const reconciled = owner.reconcileCommit(id, {
            applied: true,
            committed,
            note: `Ledger finalization failed after durable APPLIED; reconciled automatically: ${error?.message || error}`,
        });
        try {
            completeNexusCommitIntent(id, committed);
            return reconciled;
        } catch (settlementError) {
            // APPLIED + reconciled COMMITTED is stronger truth than a later
            // journal-terminalization failure. Leave the journal at APPLIED so
            // startup reconciliation can retry settlement, but never report the
            // already-applied physical mutation as failed to the caller.
            return {
                ...reconciled,
                settlementDegraded: true,
                settlementError: String(settlementError?.message || settlementError || 'Commit journal terminalization failed.'),
            };
        }
    }
}
export function failNexusTransaction(id, error, details = {}, targetLedger = ledger) {
    const owner = targetLedger || ledger;
    const current = owner.read(id);
    const recoveryRequired = details?.recoveryRequired !== false;
    if (current?.state === 'committing' && recoveryRequired) markNexusCommitRecoveryRequired(id, error);
    else {
        // Callers that can prove physical mutation never started (or that a
        // failed executor fully restored pre-state) may terminalize the durable
        // intent instead of manufacturing a false recovery-required record.
        // Unknown commit-phase failures remain fail-closed by default.
        failNexusCommitIntent(id, error, { recoveryRequired: false });
    }
    return owner.fail(id, error, details);
}

// HOTFIX46.29 browser/runtime durability surface. Legacy synchronous exports
// remain intact for Node tests and compatibility; canonical runtime mutation
// paths use these awaited variants so IndexedDB commits before acknowledgement.
export async function beginPreparedNexusTransactionCommitDurable(id, { mutation = null, recovery = null, metadata = null } = {}, targetLedger = ledger) {
    const owner = targetLedger || ledger;
    const prepared = owner.read(id);
    if (!prepared) throw new Error(`Unknown Nexus transaction: ${id}`);
    if (prepared.state !== 'committing') return prepared;
    await beginNexusCommitIntentDurable(prepared, { mutation, recovery, metadata });
    return owner.read(id);
}
export async function failPreparedNexusCommitIntentDurable(id, error) { return await failNexusCommitIntentDurable(id, error, { recoveryRequired: false }); }
export async function updatePreparedNexusCommitRecoveryDurable(id, recovery, targetLedger = ledger) {
    const owner = targetLedger || ledger;
    if (!owner.read(id)) throw new Error(`Unknown Nexus transaction: ${id}`);
    await updateNexusCommitIntentRecoveryDurable(id, recovery);
    return owner.read(id);
}
export async function updatePreparedNexusCommitPhaseDurable(id, phase, details = {}, targetLedger = ledger) {
    const owner = targetLedger || ledger;
    if (!owner.read(id)) throw new Error(`Unknown Nexus transaction: ${id}`);
    return await updateNexusCommitIntentPhaseDurable(id, phase, details);
}
export async function supersedeAppliedNexusCommitEffectDurable(id, options = {}) { return await markNexusCommitEffectSupersededDurable(id, options); }
export async function completeNexusTransactionCommitDurable(id, committed, targetLedger = ledger) {
    const owner = targetLedger || ledger;
    await markNexusCommitIntentAppliedDurable(id, committed);
    try {
        const result = owner.completeCommit(id, committed);
        await completeNexusCommitIntentDurable(id, committed);
        return result;
    } catch (error) {
        const reconciled = owner.reconcileCommit(id, { applied: true, committed, note: `Ledger finalization failed after durable APPLIED; reconciled automatically: ${error?.message || error}` });
        try { await completeNexusCommitIntentDurable(id, committed); return reconciled; }
        catch (settlementError) { return { ...reconciled, settlementDegraded: true, settlementError: String(settlementError?.message || settlementError || 'Commit journal terminalization failed.') }; }
    }
}
export async function failNexusTransactionDurable(id, error, details = {}, targetLedger = ledger) {
    const owner = targetLedger || ledger;
    const current = owner.read(id);
    const recoveryRequired = details?.recoveryRequired !== false;
    if (current?.state === 'committing' && recoveryRequired) await markNexusCommitRecoveryRequiredDurable(id, error);
    else await failNexusCommitIntentDurable(id, error, { recoveryRequired: false });
    return owner.fail(id, error, details);
}
export function inspectNexusCommitRecovery() { return getNexusCommitJournal({ unresolvedOnly: true }); }
export function inspectNexusCommitJournal() { return getNexusCommitJournal({ unresolvedOnly: false }); }

// Recovery authority is durable across chats, but startup/operator attention is
// scoped. Chat-bound rows from another story must remain in the journal for
// their owning chat without masquerading as recovery work for the active one.
// Unscoped rows remain globally actionable because no chat identity owns them.
export function partitionNexusCommitRecoveryForChat(rows = [], { chatId = null } = {}) {
    const active = chatId == null || String(chatId).trim() === '' ? null : String(chatId);
    const current = [];
    const deferred = [];
    for (const row of Array.isArray(rows) ? rows : []) {
        const owner = row?.chatId == null || String(row.chatId).trim() === '' ? null : String(row.chatId);
        if (owner == null || (active != null && owner === active)) current.push(row);
        else deferred.push(row);
    }
    return { current, deferred, chatId: active };
}

/**
 * HOTFIX28: settle interrupted COMMITTING rows that the durable journal itself
 * proves never crossed the physical-persistence boundary. These are not
 * ambiguous recovery cases: no recovery descriptor was armed, no subwrite was
 * recorded, and physicalPersistenceBegun is false. Leaving them unresolved
 * forever creates a permanent startup warning after an approval was interrupted
 * before any host mutation could occur.
 *
 * Rows with any evidence that persistence might have started remain untouched
 * and continue through the operator recovery path.
 */
export async function reconcileProvablyUnstartedNexusCommitRecovery({ context = null } = {}) {
    const candidates = inspectNexusCommitRecovery().filter(row =>
        String(row?.state || '') === 'committing'
        && row?.physicalPersistenceBegun !== true
        && !row?.recovery
        && (!Array.isArray(row?.subwrites) || row.subwrites.length === 0)
    );
    const reconciled = [];
    const skipped = [];
    for (const row of candidates) {
        try {
            const resolved = await reconcileNexusCommitRecovery(row.id, {
                disposition: 'confirmed-not-applied',
                note: 'Startup reconciliation: durable journal proves physical persistence never began.',
                context,
                projectDependents: false,
            });
            reconciled.push(resolved);
        } catch (error) {
            skipped.push({ id: String(row?.id || ''), error: String(error?.message || error || 'unknown') });
        }
    }
    return { reconciled, skipped };
}

export function inspectMatchingNexusCommitRecovery(transaction, options = {}) { return findMatchingNexusCommitIntents(transaction, options); }
function committedValueFromJournal(row, transaction = null) {
    if (row && Object.prototype.hasOwnProperty.call(row, 'settlementResult')) return deepCopy(row.settlementResult);
    if (transaction && transaction.committed !== undefined && transaction.committed !== null) return deepCopy(transaction.committed);
    // State/replay truth is still authoritative even for legacy rows that only
    // retained a result fingerprint. Never mislabel the older STAGED payload as
    // the physical commit result merely to fill this field.
    return { recoveredFromCommitJournal: true, resultUnavailable: true, resultFingerprint: row?.resultFingerprint || null };
}
export function reconcileKnownAppliedNexusCommitRecovery() {
    const applied = inspectNexusCommitRecovery().filter(row => String(row?.state || '') === 'applied');
    return applied.map(row => {
        let resolved = resolveNexusCommitRecovery(row.id, {
            disposition: 'confirmed-applied',
            note: 'Auto-reconciled at startup: durable journal reached APPLIED after physical persistence.',
        });
        ledger.reconcileCommit(row.id, { applied: true, committed: committedValueFromJournal(resolved, ledger.read(row.id)), note: 'Durable APPLIED journal authority reconciled at startup.' });
        // Canonical truth is settled synchronously; dependent audit projections
        // are explicitly left as durable startup work instead of being forgotten.
        resolved = markNexusDependentProjectionPending(row.id, 'Startup canonical APPLIED settlement requires dependent audit projection reconciliation.');
        return { ...resolved, ledger: ledger.read(row.id) };
    });
}
export async function reconcileKnownAppliedNexusCommitRecoveryDurable() {
    const applied = inspectNexusCommitRecovery().filter(row => String(row?.state || '') === 'applied');
    const out=[];
    for (const row of applied) {
        let resolved = await resolveNexusCommitRecoveryDurable(row.id, { disposition: 'confirmed-applied', note: 'Auto-reconciled at startup: durable journal reached APPLIED after physical persistence.' });
        ledger.reconcileCommit(row.id, { applied: true, committed: committedValueFromJournal(resolved, ledger.read(row.id)), note: 'Durable APPLIED journal authority reconciled at startup.' });
        resolved = await markNexusDependentProjectionPendingDurable(row.id, 'Startup canonical APPLIED settlement requires dependent audit projection reconciliation.');
        out.push({ ...resolved, ledger: ledger.read(row.id) });
    }
    return out;
}
async function recoveryVerificationForRow(row, { context = null } = {}) {
    if (!row) return null;
    if (String(row.state || '') === 'applied') return { state: 'post', compatible: true, recoveryFingerprint: row.recoveryFingerprint || '' };
    if (!row.recovery) {
        if (row.physicalPersistenceBegun !== true && (!Array.isArray(row.subwrites) || row.subwrites.length === 0)) {
            return { state: 'pre', compatible: true, recoveryFingerprint: '' , evidence: 'durable-pre-persistence-phase' };
        }
        return { state: 'unknown', compatible: false, recoveryFingerprint: '', evidence: 'recovery-descriptor-unavailable-after-persistence' };
    }
    const recoveryModule = await import('./mutation-recovery.js');
    const recovery = typeof recoveryModule.upgradeLegacyCreateRecoveryExpectation === 'function'
        ? recoveryModule.upgradeLegacyCreateRecoveryExpectation(row.recovery, row.canonicalMutation || null)
        : row.recovery;
    const compatibleRecovery = recoveryModule.upgradeTreelessCreateRecoveryExpectation(recovery, row.canonicalMutation || null, row);
    const inspection = await recoveryModule.inspectMutationRecoveryState(compatibleRecovery, { context });
    return {
        state: String(inspection?.state || 'unknown'),
        compatible: inspection?.compatible === true,
        reason: inspection?.reason || '',
        recoveryFingerprint: String(row.recoveryFingerprint || ''),
        inspectedAt: Date.now(),
    };
}
export async function reconcileProvableNexusCommitRecovery({ context = null } = {}) {
    const candidates = inspectNexusCommitRecovery().filter(row => ['committing','recovery-required'].includes(String(row?.state || '')));
    const reconciled = [];
    const skipped = [];
    for (const row of candidates) {
        try {
            const verification = await recoveryVerificationForRow(row, { context });
            let disposition = null;
            if (verification?.compatible === true && verification?.state === 'post') disposition = 'confirmed-applied';
            else if (verification?.compatible === true && verification?.state === 'pre') disposition = 'confirmed-not-applied';
            else if (verification?.state === 'conflict' && row?.recovery && !['metadata-context-unavailable','metadata-chat-changed','tree-import-bundle-descriptor-incomplete'].includes(String(verification?.reason || ''))) disposition = 'diverged';
            else if (verification?.state === 'unknown' && !row?.recovery && row?.physicalPersistenceBegun === true) disposition = 'abandoned';
            if (!disposition) {
                skipped.push({ id: String(row?.id || ''), state: String(verification?.state || 'unknown'), reason: String(verification?.reason || verification?.evidence || 'canonical-pre-post-not-provable') });
                continue;
            }
            const resolved = await reconcileNexusCommitRecovery(row.id, {
                disposition,
                note: disposition === 'confirmed-applied'
                    ? 'Startup reconciliation: canonical mutation footprint proves intended POST state.'
                    : disposition === 'confirmed-not-applied'
                        ? 'Startup reconciliation: canonical mutation footprint proves original PRE state.'
                        : disposition === 'diverged'
                            ? 'Startup reconciliation: canonical state provably matches neither PRE nor POST; archive unknown/diverged outcome and permanently fence exact replay.'
                            : 'Startup reconciliation: physical persistence began but durable PRE/POST recovery evidence is unavailable; archive unknown outcome and permanently fence exact replay.',
                context,
            });
            reconciled.push(resolved);
        } catch (error) {
            skipped.push({ id: String(row?.id || ''), state: 'error', reason: String(error?.message || error || 'unknown'), name: String(error?.name || 'Error') });
        }
    }
    return { reconciled, skipped };
}

export async function prepareNexusCommitRecoverySettlement(id, options = {}) {
    const row = inspectNexusCommitJournal().find(item => String(item.id) === String(id)) || null;
    if (!row) throw new Error(`Nexus commit intent ${id} was not found.`);
    const disposition = String(options?.disposition || 'confirmed-not-applied');
    // Recovery proof is deliberately captured from canonical state here. Never
    // trust a caller-supplied verification object: it can become stale while a
    // durable Proposal/review settlement marker is being written.
    const verification = await recoveryVerificationForRow(row, { context: options?.context || null });
    if (disposition === 'confirmed-applied' && !(String(row.state || '') === 'applied' || (verification?.compatible && verification?.state === 'post'))) {
        const error = new Error(`Commit recovery ${id} cannot be confirmed applied because current canonical POST state was not proven.`);
        error.name = 'TV2CommitRecoveryUnverified'; error.verification = deepCopy(verification); throw error;
    }
    if (['confirmed-not-applied','superseded'].includes(disposition) && !(verification?.compatible && verification?.state === 'pre')) {
        const error = new Error(`Commit recovery ${id} cannot clear unresolved ownership because current canonical PRE state was not proven.`);
        error.name = 'TV2CommitRecoveryUnverified'; error.verification = deepCopy(verification); throw error;
    }
    if (disposition === 'abandoned' && (verification?.compatible === true || String(verification?.state || '') !== 'unknown')) {
        const error = new Error(`Commit recovery ${id} can only be abandoned when canonical PRE/POST truth is genuinely unavailable. Use the proven recovery disposition instead.`);
        error.name = 'TV2CommitRecoveryUnverified'; error.verification = deepCopy(verification); throw error;
    }
    if (disposition === 'diverged' && !(row.recovery && verification?.state === 'conflict')) {
        const error = new Error(`Commit recovery ${id} cannot be archived as diverged because current canonical state was not proven to differ from both PRE and POST.`);
        error.name = 'TV2CommitRecoveryUnverified'; error.verification = deepCopy(verification); throw error;
    }
    return { row: deepCopy(row), disposition, verification: deepCopy(verification) };
}
export async function reconcileNexusCommitRecovery(id, options = {}) {
    // Re-inspect at the settlement boundary even if a caller already prepared a
    // marker. That closes the check -> durable-marker -> journal-write TOCTOU:
    // only the canonical state observed immediately before journal resolution
    // may release unresolved physical ownership.
    const prepared = await prepareNexusCommitRecoverySettlement(id, {
        ...options,
        verification: undefined,
    });
    const { disposition, verification } = prepared;
    let resolved = await resolveNexusCommitRecoveryDurable(id, { ...options, disposition, verification });
    if (disposition === 'confirmed-applied') {
        ledger.reconcileCommit(id, { applied: true, committed: committedValueFromJournal(resolved, ledger.read(id)), note: options?.note || 'Durable commit journal confirmed physical persistence.' });
    } else if (disposition === 'diverged') {
        ledger.reconcileCommit(id, { applied: false, outcomeUnknown: true, note: options?.note || 'Durable recovery proved canonical state diverged from both PRE and POST; exact replay has been fenced.' });
    } else if (disposition === 'abandoned') {
        ledger.reconcileCommit(id, { applied: false, outcomeUnknown: true, note: options?.note || 'Durable recovery outcome is unknown; exact mutation replay has been permanently fenced.' });
    } else if (disposition === 'confirmed-not-applied' || disposition === 'superseded') {
        ledger.reconcileCommit(id, { applied: false, terminalNotApplied: true, note: options?.note || `Durable recovery disposition: ${disposition}` });
    }
    if (options?.projectDependents !== false) {
        try {
            await projectNexusRecoverySettlement({ id: String(id), disposition, note: options?.note || '', row: deepCopy(resolved), ledger: ledger.read(id), context: options?.context || null });
            if (resolved.dependentProjectionPending === true) resolved = await clearNexusDependentProjectionPendingDurable(id);
        } catch (projectionError) {
            resolved = await markNexusDependentProjectionPendingDurable(id, projectionError);
            return { ...resolved, ledger: ledger.read(id), verification: deepCopy(verification), settlementDegraded: true, settlementError: String(projectionError?.message || projectionError), projectionErrors: deepCopy(projectionError?.projectionErrors || []) };
        }
    }
    return { ...resolved, ledger: ledger.read(id), verification: deepCopy(verification) };
}

export function reconcileRestoredNexusTransactionsFromCommitJournal(ids = null, targetLedger = ledger) {
    const owner = targetLedger || ledger;
    const wanted = ids == null ? null : new Set((Array.isArray(ids) ? ids : [ids]).map(String));
    const rows = inspectNexusCommitJournal();
    const results = [];
    for (const row of rows) {
        if (wanted && !wanted.has(String(row.id))) continue;
        let tx = owner.read(row.id);
        // Batch 03: the durable commit journal carries enough typed Ledger state
        // to reconstruct an unresolved/settled transaction even if its review
        // projection was lost. The journal is canonical recovery authority.
        if (!tx && row.transactionRecord) {
            const restored = deepCopy(row.transactionRecord);
            if (['committing','applied','recovery-required'].includes(String(row.state || ''))) restored.state = 'committing';
            owner.restore([restored], { replace: false });
            tx = owner.read(row.id);
        }
        if (!tx) continue;
        const state = String(row.state || '');
        if (['applied','committed','reconciled-confirmed-applied'].includes(state)) {
            owner.reconcileCommit(row.id, { applied: true, committed: committedValueFromJournal(row, tx), note: `Startup reconciliation follows durable commit journal state ${state}.` });
        } else if (state === 'reconciled-diverged' || state === 'reconciled-abandoned') {
            owner.reconcileCommit(row.id, { applied: false, outcomeUnknown: true, note: `Startup reconciliation follows durable commit journal state ${state}; exact replay remains fenced.` });
        } else if (['failed','reconciled-confirmed-not-applied','reconciled-superseded'].includes(state)) {
            owner.reconcileCommit(row.id, { applied: false, terminalNotApplied: true, note: `Startup reconciliation follows durable commit journal state ${state}.` });
        } else if (['committing','recovery-required'].includes(state) && tx.state === 'staged') {
            const fenced = deepCopy(tx);
            fenced.state = 'committing';
            fenced.error = `Durable canonical commit journal is ${state}; review remains fenced until recovery reconciliation completes.`;
            if (fenced.mutationProposal) fenced.mutationProposal.state = 'approved';
            owner.restore([fenced], { replace: true });
        }
        results.push({ id: row.id, journalState: state, transaction: owner.read(row.id), reconstructed: !!row.transactionRecord });
    }
    return results;
}

export async function reconcilePendingNexusRecoveryProjections() {
    const rows = inspectNexusCommitJournal().filter(row => row?.dependentProjectionPending === true && String(row?.recoveryDisposition || '').trim());
    const results = [];
    for (const row of rows) {
        try {
            const disposition = String(row.recoveryDisposition);
            await projectNexusRecoverySettlement({ id: String(row.id), disposition, note: row.recoveryNote || '', row: deepCopy(row), ledger: ledger.read(row.id), context: null });
            results.push({ id: row.id, ok: true, row: await clearNexusDependentProjectionPendingDurable(row.id) });
        } catch (error) {
            await markNexusDependentProjectionPendingDurable(row.id, error);
            results.push({ id: row.id, ok: false, error: String(error?.message || error) });
        }
    }
    return results;
}

/** Backward-compatible one-call commit. 0.6.2 mutation UIs should use prepare -> mutate -> complete. */
export function commitNexusTransaction(id, committed, { currentAssumptions = undefined } = {}) { return ledger.committed(id, committed, { currentAssumptions }); }
export function abortNexusTransaction(id, reason) { return ledger.abort(id, reason); }
