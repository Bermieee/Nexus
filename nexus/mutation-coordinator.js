import * as transactionService from './transaction-service.js';
const { getNexusLedger, prepareNexusTransactionCommitState, inspectNexusCommitResourceConflicts } = transactionService;
const beginPreparedNexusTransactionCommit = transactionService.beginPreparedNexusTransactionCommitDurable || transactionService.beginPreparedNexusTransactionCommit;
const updatePreparedNexusCommitRecovery = transactionService.updatePreparedNexusCommitRecoveryDurable || transactionService.updatePreparedNexusCommitRecovery;
const updatePreparedNexusCommitPhase = transactionService.updatePreparedNexusCommitPhaseDurable || transactionService.updatePreparedNexusCommitPhase;
const supersedeAppliedNexusCommitEffect = transactionService.supersedeAppliedNexusCommitEffectDurable || transactionService.supersedeAppliedNexusCommitEffect;
const failPreparedNexusCommitIntent = transactionService.failPreparedNexusCommitIntentDurable || transactionService.failPreparedNexusCommitIntent;
const completeNexusTransactionCommit = transactionService.completeNexusTransactionCommitDurable || transactionService.completeNexusTransactionCommit;
const failNexusTransaction = transactionService.failNexusTransactionDurable || transactionService.failNexusTransaction;
import { executeCanonicalMutation, resolveNexusMutationResources } from './mutation-engine.js';
import { captureMutationRecoveryState, checkpointMutationRecoveryState, finalizeMutationRecoveryState, buildRecoveryInverseOperation, inspectMutationRecoveryState } from './mutation-recovery.js';
import { createMutationProposal, deepCopy } from './contracts.js';
import { acquireNexusMutationResources, assertNexusMutationAuthority, updateNexusMutationAuthorityPhase } from './mutation-lock.js';
import { compactAllOperatorReviewStoragePressure } from './operator-review-store.js';

function terminal(state) { return ['committed', 'stale', 'aborted', 'failed', 'cancelled'].includes(String(state || '')); }
function cancellationError() {
    const error = new Error('Nexus mutation commit was cancelled before durable intent.');
    error.name = 'TV2MutationLeaseCancelled';
    error.cancelled = true;
    error.deferred = true;
    return error;
}
function throwIfCancelledBeforeIntent(signal) { if (signal?.aborted) throw cancellationError(); }
async function runPreflight(preflight, mutation, context, authority, resources) {
    if (typeof preflight !== 'function') return true;
    try { return await preflight({ op: mutation, mutation, context, authority, resources: [...resources] }); }
    catch (error) { error.tv2PreMutationStale = true; throw error; }
}
async function resolveAssumptions(currentAssumptions, mutation, context, authority, resources) {
    if (typeof currentAssumptions === 'function') {
        return await currentAssumptions({ op: mutation, mutation, context, authority, resources: [...resources] });
    }
    return currentAssumptions;
}
function observerError(onObserverError, source, error, event) {
    if (typeof onObserverError !== 'function') return;
    try { onObserverError({ source, error, event: { ...event } }); } catch {}
}
function reportPhase(phase, { transactionId, mutation, resources, authority, journalStarted = false, physicalPersistenceBegun = false, onPhase = null, onObserverError = null } = {}) {
    const event = {
        phase,
        transactionId,
        operation: mutation?.type || 'mutation',
        resources: [...(resources || [])],
        leaseId: authority?.id || null,
        authorityOwnerId: authority?.ownerId || null,
        journalStarted: journalStarted === true,
        physicalPersistenceBegun: physicalPersistenceBegun === true,
    };
    if (authority && phase !== 'released') {
        try {
            updateNexusMutationAuthorityPhase(authority, phase, {
                transactionId,
                journalStarted,
                physicalPersistenceBegun,
            });
        } catch (error) { observerError(onObserverError, 'authority-phase', error, event); }
    }
    if (typeof onPhase === 'function') {
        try { onPhase(event); } catch (error) { observerError(onObserverError, 'onPhase', error, event); }
    }
}

/**
 * Single durable owner for a physical Nexus mutation.
 *
 * The coordinator acquires every conflicting resource exactly once. After
 * admission, all freshness/preflight work is re-run locally while authority is
 * held, then the durable intent is recorded before the physical engine runs.
 * The engine verifies the authority and never re-acquires it.
 */
export async function commitCanonicalNexusMutation(transactionId, mutation, {
    currentAssumptions = undefined,
    targetLedger = getNexusLedger(),
    context = null,
    metadata = {},
    committed = null,
    preflight = null,
    signal = null,
    priority = 0,
    foreground = false,
    waitTimeoutMs = 0,
    holderLeaseMs = undefined,
    beforeTerminalState = null,
    onPhase = null,
    onObserverError = null,
    afterIntent = null,
} = {}) {
    const ledger = targetLedger || getNexusLedger();
    const before = ledger.read(transactionId);
    if (!before) throw new Error(`Unknown Nexus transaction: ${transactionId}`);
    if (terminal(before.state)) return before;

    const resources = resolveNexusMutationResources(mutation, context);
    let authority = null;
    let prepared = null;
    let journalStarted = false;
    let physicalPersistenceBegun = false;
    let recovery = null;
    let executionResult = null;
    let leaseExpired = false;

    const commitInvalidationError = () => {
        const invalidation = typeof ledger.getCommitInvalidation === 'function' ? ledger.getCommitInvalidation(transactionId) : null;
        if (!invalidation) return null;
        const error = new Error(invalidation.reason || 'Nexus mutation scope was invalidated before physical persistence.');
        error.name = 'TV2MutationStale';
        error.tv2PreMutationStale = true;
        error.commitInvalidation = invalidation;
        return error;
    };
    const assertCommitStillValid = () => {
        throwIfCancelledBeforeIntent(signal);
        if (authority) assertNexusMutationAuthority(authority, resources);
        if (leaseExpired) {
            const error = new Error('Nexus mutation lease expired before the current commit phase completed.');
            error.name = 'TV2MutationLeaseExpired';
            error.recoveryRequired = journalStarted && physicalPersistenceBegun;
            throw error;
        }
        const error = commitInvalidationError();
        if (error) throw error;
        return true;
    };
    const markPhysicalPersistenceBegun = async details => {
        assertCommitStillValid();
        const firstPhysicalBoundary = !physicalPersistenceBegun;
        physicalPersistenceBegun = true;
        if (journalStarted) {
            await updatePreparedNexusCommitPhase(transactionId, 'persisting', {
                physicalPersistenceBegun: true,
                subwrite: details ? { ...deepCopy(details), status: 'started' } : null,
            }, ledger);
            assertCommitStillValid();
        }
        if (firstPhysicalBoundary) reportPhase('persisting', { transactionId, mutation, resources, authority, journalStarted, physicalPersistenceBegun, onPhase, onObserverError });
        if (details && authority) {
            try { updateNexusMutationAuthorityPhase(authority, 'persisting', { transactionId, journalStarted, physicalPersistenceBegun, persistence: { ...deepCopy(details), status: 'started' } }); } catch {}
        }
    };

    try {
        reportPhase('waiting', { transactionId, mutation, resources, authority: null, onPhase, onObserverError });
        authority = await acquireNexusMutationResources(resources, {
            ownerId: transactionId,
            operation: mutation?.type || 'mutation',
            signal,
            priority,
            foreground,
            waitTimeoutMs,
            ...(holderLeaseMs === undefined ? {} : { holderLeaseMs }),
            onLeaseExpired: details => {
                leaseExpired = true;
                if (!journalStarted) return;
                try {
                    void failNexusTransaction(transactionId, new Error('Nexus mutation authority lease expired.'), {
                        phase: physicalPersistenceBegun ? 'lease-expired-post-write' : 'lease-expired-pre-write',
                        recoveryRequired: physicalPersistenceBegun,
                        mutationType: mutation?.type || null,
                        lease: deepCopy(details),
                    }, ledger).catch(()=>{});
                } catch {}
            },
        });
        reportPhase('granted', { transactionId, mutation, resources, authority, onPhase, onObserverError });
        assertCommitStillValid();

        reportPhase('revalidating', { transactionId, mutation, resources, authority, onPhase, onObserverError });
        await runPreflight(preflight, mutation, context, authority, resources);
        assertCommitStillValid();

        const liveAssumptions = await resolveAssumptions(currentAssumptions, mutation, context, authority, resources);
        assertCommitStillValid();

        const freshness = ledger.checkFresh(transactionId, liveAssumptions);
        if (!freshness.fresh) {
            if (typeof beforeTerminalState === 'function') {
                await beforeTerminalState({
                    transactionId,
                    transaction: ledger.read(transactionId),
                    state: 'stale',
                    reason: 'Transaction became stale while waiting for mutation authority.',
                    freshness: deepCopy(freshness),
                });
                assertCommitStillValid();
            }
            const stale = ledger.stale(transactionId, 'Transaction became stale while waiting for mutation authority.', freshness);
            if (before.state === 'committing') {
                try { await failPreparedNexusCommitIntent(transactionId, new Error(stale.error || 'Transaction became stale before physical persistence.')); } catch {}
            }
            return stale;
        }
        if (before.state === 'committing') {
            // Compatibility for older callers that entered COMMITTING before the
            // coordinator. New canonical callers must remain STAGED while waiting.
            prepared = ledger.read(transactionId);
        } else {
            prepared = prepareNexusTransactionCommitState(transactionId, liveAssumptions, ledger);
            if (prepared.state === 'stale') return prepared;
        }
        if (prepared.state !== 'committing') throw new Error(`Nexus transaction ${transactionId} could not enter COMMITTING; current state is ${prepared.state}.`);
        reportPhase('committing', { transactionId, mutation, resources, authority, onPhase, onObserverError });
        assertCommitStillValid();

        // HOTFIX46.20: localStorage is shared by several durable Nexus stores.
        // Before a durability-critical journal intent, reclaim only terminal
        // Operator Review projections when the browser is under storage pressure.
        // Each review scope uses its own existing exclusive lock; active review
        // ownership is never compacted.
        await compactAllOperatorReviewStoragePressure();
        assertCommitStillValid();

        recovery = await captureMutationRecoveryState(mutation, { context });
        assertCommitStillValid();

        // Intent + pre-state recovery authority are one durable journal write.
        // No durable COMMITTING record exists while merely waiting for a lease.
        await beginPreparedNexusTransactionCommit(transactionId, {
            mutation: deepCopy(mutation),
            recovery: deepCopy(recovery),
            metadata: { ...deepCopy(metadata), resources: [...resources] },
        }, ledger);
        journalStarted = true;
        await updatePreparedNexusCommitPhase(transactionId, 'intent-durable', { physicalPersistenceBegun: false }, ledger);
        const conflicts = inspectNexusCommitResourceConflicts(resources, { excludeId: transactionId });
        if (conflicts.length) {
            const error = new Error(`Nexus durable recovery authority already owns overlapping resource(s): ${resources.join(', ')}.`);
            error.name = 'TV2CommitResourceRecoveryBlocked';
            error.conflicts = conflicts.map(row => ({ id: row.id, state: row.state, resources: row.resources || row?.commitMetadata?.resources || [] }));
            try { await failPreparedNexusCommitIntent(transactionId, error); } catch {}
            throw error;
        }
        reportPhase('intent-durable', { transactionId, mutation, resources, authority, journalStarted, physicalPersistenceBegun, onPhase, onObserverError });

        if (typeof afterIntent === 'function') {
            await afterIntent({ transactionId, mutation: deepCopy(mutation), recovery: deepCopy(recovery), resources: [...resources], authority });
            assertCommitStillValid();
        }

        const recordSubwriteCheckpoint = async details => {
            assertCommitStillValid();
            recovery = await checkpointMutationRecoveryState(recovery, { checkpoint: details, context });
            await updatePreparedNexusCommitRecovery(transactionId, recovery, ledger);
            await updatePreparedNexusCommitPhase(transactionId, 'persisting', {
                physicalPersistenceBegun: true,
                subwrite: {
                    domain: details?.domain || null,
                    book: details?.book || null,
                    key: details?.key || null,
                    operation: details?.operation || null,
                    createdUid: Number.isFinite(Number(details?.createdUid)) ? Number(details.createdUid) : null,
                    touchedUids: Array.isArray(details?.touchedUids) ? details.touchedUids.map(Number).filter(Number.isFinite) : [],
                    status: 'verified',
                },
            }, ledger);
            assertCommitStillValid();
        };
        executionResult = await executeCanonicalMutation(mutation, {
            context,
            authority,
            onPhysicalPersistenceBegin: markPhysicalPersistenceBegun,
            onSubwriteCheckpoint: recordSubwriteCheckpoint,
            assertCommitStillValid,
        });

        if (journalStarted) await updatePreparedNexusCommitPhase(transactionId, 'finalizing', { physicalPersistenceBegun }, ledger);
        reportPhase('finalizing', { transactionId, mutation, resources, authority, journalStarted, physicalPersistenceBegun, onPhase, onObserverError });
        recovery = await finalizeMutationRecoveryState(recovery, { context, executionResult });
        await updatePreparedNexusCommitRecovery(transactionId, recovery, ledger);

        const defaultCommitted = { mutation: deepCopy(mutation), result: deepCopy(executionResult) };
        let committedValue = defaultCommitted;
        let decorationError = null;
        if (committed != null) {
            if (typeof committed === 'function') {
                try { committedValue = committed(executionResult, mutation); }
                catch (error) { decorationError = error; committedValue = defaultCommitted; }
            } else committedValue = deepCopy(committed);
        }
        const completed = await completeNexusTransactionCommit(transactionId, committedValue, ledger);
        // HOTFIX44: terminal commit-journal compaction intentionally strips large
        // recovery descriptors.  The caller that just performed the canonical
        // mutation may still need that descriptor to establish its own bounded
        // inverse/recovery audit (for example Direct Write under a parent saga).
        // Return it ephemerally; do not duplicate it into the terminal journal.
        const recoveryDescriptor = deepCopy(recovery);
        reportPhase('committed', { transactionId, mutation, resources, authority, journalStarted, physicalPersistenceBegun, onPhase, onObserverError });
        if (decorationError) {
            return {
                ...completed,
                recoveryDescriptor,
                settlementDegraded: true,
                settlementError: `Post-commit result decoration failed after physical persistence: ${decorationError?.message || decorationError}`,
            };
        }
        return { ...completed, recoveryDescriptor };
    } catch (error) {
        const current = ledger.read(transactionId);
        if (current && !terminal(current.state) && (prepared?.state === 'committing' || before.state === 'committing')) {
            const definitelyNotApplied = !physicalPersistenceBegun
                || error?.tv2PreMutationStale === true
                || error?.tv2RollbackRestored === true
                || String(error?.name || '') === 'TV2MutationStale';
            try {
                await failNexusTransaction(transactionId, error, {
                    phase: journalStarted ? (physicalPersistenceBegun ? 'canonical-mutation' : 'canonical-pre-persistence') : 'canonical-pre-intent',
                    recoveryRequired: !definitelyNotApplied,
                    mutationType: mutation?.type || null,
                }, ledger);
            } catch {}
        }
        reportPhase('failed', { transactionId, mutation, resources, authority, journalStarted, physicalPersistenceBegun, onPhase, onObserverError });
        throw error;
    } finally {
        try { authority?.release?.(); }
        finally { reportPhase('released', { transactionId, mutation, resources, authority, journalStarted, physicalPersistenceBegun, onPhase, onObserverError }); }
    }

}

/** Create a normal Ledger-owned inverse transaction for recovery/undo. */
export async function commitRecoveryInverse(snapshot, {
    by = 'operator-recovery',
    sourceTransactionId = null,
    sourceProposalId = null,
    targetLedger = getNexusLedger(),
    context = null,
} = {}) {
    const ledger = targetLedger || getNexusLedger();
    const mutation = buildRecoveryInverseOperation(snapshot);
    const assumptions = { recovery: deepCopy(snapshot?.postView ?? null), sourceTransactionId, sourceProposalId };
    let tx = ledger.begin({
        type: 'recovery-inverse',
        input: { sourceTransactionId, sourceProposalId, mutationType: snapshot?.opType || null, book: snapshot?.book || null, chatId: snapshot?.chatId ?? null },
        snapshot: { recovery: deepCopy(snapshot) },
        assumptions,
        metadata: { source: 'commit-recovery', sourceTransactionId, sourceProposalId },
    });
    ledger.executing(tx.id);
    ledger.parsed(tx.id, { inverse: mutation.type }, { local: true });
    ledger.validated(tx.id, { passed: true, checks: { recoveryDescriptorVersion: snapshot?.version || null } });
    tx = ledger.staged(tx.id, { mutation: deepCopy(mutation) }, {
        mutationProposal: createMutationProposal({
            transactionId: tx.id,
            type: 'recovery-inverse',
            target: { book: snapshot?.book || null, chatId: snapshot?.chatId ?? null },
            draft: { inverse: mutation.type },
            assumptions,
            approvalRequired: true,
            metadata: { sourceTransactionId, sourceProposalId },
        }),
    });
    ledger.approve(tx.id, { by, metadata: { surface: 'commit-recovery' } });
    const preflight = async () => {
        const inspection = await inspectMutationRecoveryState(snapshot, { context });
        if (!inspection.compatible || inspection.state !== 'post') {
            const error = new Error('Recovery inverse became stale because canonical state no longer matches the recorded post-state.');
            error.name = 'TV2MutationStale';
            throw error;
        }
    };
    const result = await commitCanonicalNexusMutation(tx.id, mutation, {
        currentAssumptions: () => deepCopy(assumptions),
        targetLedger: ledger,
        context,
        preflight,
        committed: result => ({ sourceTransactionId, sourceProposalId, restored: true, result }),
    });
    if (sourceTransactionId && result?.state === 'committed') {
        try {
            await supersedeAppliedNexusCommitEffect(sourceTransactionId, {
                byTransactionId: result.id,
                note: 'A fully verified recovery inverse restored the original mutation PRE state.',
                inverseVerified: true,
            });
        } catch (error) {
            return { ...result, supersessionDegraded: true, supersessionError: String(error?.message || error) };
        }
    }
    return result;
}
