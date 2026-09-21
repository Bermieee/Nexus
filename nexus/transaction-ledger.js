import {
    NEXUS_TRANSACTION_STATE,
    assertNexusTransactionState,
    createMutationProposal,
    createNexusTransaction,
    deepCopy,
} from './contracts.js';

const TERMINAL = new Set([
    NEXUS_TRANSACTION_STATE.COMMITTED,
    NEXUS_TRANSACTION_STATE.STALE,
    NEXUS_TRANSACTION_STATE.ABORTED,
    NEXUS_TRANSACTION_STATE.FAILED,
    NEXUS_TRANSACTION_STATE.CANCELLED,
]);

const TRANSITIONS = Object.freeze({
    [NEXUS_TRANSACTION_STATE.CREATED]: [NEXUS_TRANSACTION_STATE.EXECUTING, NEXUS_TRANSACTION_STATE.STALE, NEXUS_TRANSACTION_STATE.ABORTED, NEXUS_TRANSACTION_STATE.CANCELLED],
    [NEXUS_TRANSACTION_STATE.EXECUTING]: [NEXUS_TRANSACTION_STATE.PARSED, NEXUS_TRANSACTION_STATE.STALE, NEXUS_TRANSACTION_STATE.FAILED, NEXUS_TRANSACTION_STATE.ABORTED, NEXUS_TRANSACTION_STATE.CANCELLED],
    [NEXUS_TRANSACTION_STATE.PARSED]: [NEXUS_TRANSACTION_STATE.VALIDATED, NEXUS_TRANSACTION_STATE.STALE, NEXUS_TRANSACTION_STATE.FAILED, NEXUS_TRANSACTION_STATE.ABORTED],
    [NEXUS_TRANSACTION_STATE.VALIDATED]: [NEXUS_TRANSACTION_STATE.STAGED, NEXUS_TRANSACTION_STATE.STALE, NEXUS_TRANSACTION_STATE.FAILED, NEXUS_TRANSACTION_STATE.ABORTED],
    [NEXUS_TRANSACTION_STATE.STAGED]: [NEXUS_TRANSACTION_STATE.COMMITTING, NEXUS_TRANSACTION_STATE.STALE, NEXUS_TRANSACTION_STATE.FAILED, NEXUS_TRANSACTION_STATE.ABORTED, NEXUS_TRANSACTION_STATE.CANCELLED],
    // Once canonical commit begins, UI/session cancellation no longer owns the mutation.
    // Only the commit/recovery path may prove COMMITTED, STALE, or FAILED.
    [NEXUS_TRANSACTION_STATE.COMMITTING]: [NEXUS_TRANSACTION_STATE.COMMITTED, NEXUS_TRANSACTION_STATE.STALE, NEXUS_TRANSACTION_STATE.FAILED],
    [NEXUS_TRANSACTION_STATE.COMMITTED]: [],
    [NEXUS_TRANSACTION_STATE.STALE]: [],
    [NEXUS_TRANSACTION_STATE.ABORTED]: [],
    [NEXUS_TRANSACTION_STATE.FAILED]: [],
    [NEXUS_TRANSACTION_STATE.CANCELLED]: [],
});

function errorText(error) { return error ? String(error?.message || error) : ''; }
function isObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }

function collectAssumptionChanges(expected, current, path = '', out = []) {
    if (Array.isArray(expected)) {
        if (!Array.isArray(current) || expected.length !== current.length) {
            out.push({ path: path || '$', expected: deepCopy(expected), current: deepCopy(current) });
            return out;
        }
        expected.forEach((value, index) => collectAssumptionChanges(value, current[index], `${path}[${index}]`, out));
        return out;
    }
    if (isObject(expected)) {
        if (!isObject(current)) {
            out.push({ path: path || '$', expected: deepCopy(expected), current: deepCopy(current) });
            return out;
        }
        const keys = new Set([...Object.keys(expected), ...Object.keys(current)]);
        for (const key of [...keys].sort()) {
            const childPath = path ? `${path}.${key}` : key;
            if (!Object.prototype.hasOwnProperty.call(expected, key)) { out.push({ path: childPath, expected: undefined, current: deepCopy(current[key]), reason: 'authority-key-added' }); continue; }
            if (!Object.prototype.hasOwnProperty.call(current, key)) { out.push({ path: childPath, expected: deepCopy(expected[key]), current: undefined, reason: 'authority-key-missing' }); continue; }
            collectAssumptionChanges(expected[key], current[key], childPath, out);
        }
        return out;
    }
    if (!Object.is(expected, current)) out.push({ path: path || '$', expected: deepCopy(expected), current: deepCopy(current) });
    return out;
}

export function compareTransactionAssumptions(expected = {}, current = {}) {
    const changes = collectAssumptionChanges(expected || {}, current || {});
    return { fresh: changes.length === 0, changes };
}

function normalizeTerminalProposal(record, state) {
    if (!record?.mutationProposal) return;
    record.mutationProposal.state = state;
    if (record.approval?.approved === true) {
        record.approval = { ...record.approval, approved: false, historicalApproval: true, invalidatedAt: Date.now(), invalidatedByState: state };
    }
}

export class TransactionLedger {
    constructor({ maxHistory = 200, maxRecordHistory = 160 } = {}) {
        this.maxHistory = maxHistory;
        this.maxRecordHistory = Math.max(20, Number(maxRecordHistory) || 160);
        this.records = new Map();
        this.listeners = new Set();
    }

    onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
    _emit(record) { for (const fn of this.listeners) { try { fn(this.read(record.id)); } catch {} } }

    begin({ type, input = {}, snapshot = null, assumptions = {}, mutationProposal = null, metadata = {} } = {}) {
        const base = createNexusTransaction({ type, input, snapshot, assumptions, mutationProposal, metadata });
        const record = {
            ...base,
            executor: null,
            raw: null,
            parsed: null,
            validation: null,
            staged: null,
            committed: null,
            freshness: null,
            error: null,
            execution: null,
            commitInvalidation: null,
            history: [],
        };
        this.records.set(record.id, record);
        this._trim(); this._record(record, 'created');
        return this.read(record.id);
    }

    _trim() {
        // Retention is allowed to evict history only after a transaction is
        // terminal. Active CREATED/EXECUTING/PARSED/VALIDATED/STAGED/COMMITTING
        // records are authoritative workflow state and must survive even when
        // the nominal history cap is temporarily exceeded.
        while (this.records.size > this.maxHistory) {
            const removable = [...this.records.entries()].find(([, record]) => TERMINAL.has(record?.state));
            if (!removable) break;
            this.records.delete(removable[0]);
        }
    }

    _record(record, event, details = {}) {
        record.updatedAt = Date.now();
        record.history.push({ at: record.updatedAt, event, state: record.state, details: deepCopy(details) });
        if (record.history.length > this.maxRecordHistory) {
            if (TERMINAL.has(record.state)) record.history.splice(0, record.history.length - this.maxRecordHistory);
            else {
                const head = Math.min(16, Math.floor(this.maxRecordHistory / 4));
                const tail = Math.max(1, this.maxRecordHistory - head);
                record.history = [...record.history.slice(0, head), ...record.history.slice(-tail)];
            }
        }
        this._emit(record);
    }

    _transition(id, next, details = {}) {
        assertNexusTransactionState(next);
        const record = this.records.get(id);
        if (!record) throw new Error(`Unknown Nexus transaction: ${id}`);
        if (!TRANSITIONS[record.state].includes(next)) throw new Error(`Cannot move Nexus transaction ${id} from ${record.state} to ${next}.`);
        record.state = next; this._record(record, next, details); return record;
    }

    setExecutor(id, executor) {
        const record = this.records.get(id); if (!record) throw new Error(`Unknown Nexus transaction: ${id}`);
        record.executor = deepCopy(executor || null); this._record(record, 'executor-selected', { executor: record.executor }); return this.read(id);
    }

    executing(id) { return this.read(this._transition(id, NEXUS_TRANSACTION_STATE.EXECUTING).id); }

    initializeExecution(id, execution = {}) {
        const record = this.records.get(id);
        if (!record) throw new Error(`Unknown Nexus transaction: ${id}`);
        if (record.state !== NEXUS_TRANSACTION_STATE.EXECUTING) throw new Error(`Nexus transaction ${id} must be executing before execution metadata can be initialized.`);
        const manifest = Array.isArray(execution.sliceManifest) ? execution.sliceManifest : [];
        record.execution = {
            logicalJobId: String(execution.logicalJobId || id),
            workload: String(execution.workload || record.type || 'unknown'),
            sourceFingerprints: deepCopy(execution.sourceFingerprints || {}),
            identity: deepCopy(execution.identity || {}),
            settings: deepCopy(execution.settings || {}),
            outputCap: execution.outputCap == null ? null : Number(execution.outputCap),
            sliceManifest: deepCopy(manifest),
            status: String(execution.status || 'executing'),
            completedSliceIds: [],
            recoveredSliceIds: [],
            failedSliceIds: [],
            aggregation: null,
            resumable: false,
            startedAt: Date.now(),
            ...deepCopy(execution.extra || {}),
        };
        this._record(record, 'execution-initialized', { logicalJobId: record.execution.logicalJobId, workload: record.execution.workload, sliceCount: manifest.length });
        return this.read(id);
    }

    updateExecution(id, patch = {}, event = 'execution-updated') {
        const record = this.records.get(id);
        if (!record) throw new Error(`Unknown Nexus transaction: ${id}`);
        if (record.state !== NEXUS_TRANSACTION_STATE.EXECUTING) throw new Error(`Nexus transaction ${id} is not executing; execution metadata is immutable after aggregation begins to transition.`);
        const current = record.execution || { logicalJobId: id, workload: record.type, status: 'executing', completedSliceIds: [], recoveredSliceIds: [], failedSliceIds: [], sliceManifest: [], resumable: false };
        record.execution = { ...current, ...deepCopy(patch || {}) };
        this._record(record, event, patch);
        return this.read(id);
    }

    recordSlice(id, { sliceId, recovered = false, failed = false, details = {} } = {}) {
        const record = this.records.get(id);
        if (!record) throw new Error(`Unknown Nexus transaction: ${id}`);
        if (record.state !== NEXUS_TRANSACTION_STATE.EXECUTING) throw new Error(`Nexus transaction ${id} is not executing; slice progress cannot be recorded.`);
        const current = record.execution || { logicalJobId: id, workload: record.type, status: 'executing', completedSliceIds: [], recoveredSliceIds: [], failedSliceIds: [], sliceManifest: [], resumable: false };
        const value = String(sliceId || '').trim();
        const completed = new Set(current.completedSliceIds || []);
        const recoveredSet = new Set(current.recoveredSliceIds || []);
        const failedSet = new Set(current.failedSliceIds || []);
        if (value) {
            if (failed) failedSet.add(value);
            else { completed.add(value); failedSet.delete(value); }
            if (recovered && !failed) recoveredSet.add(value);
        }
        record.execution = { ...current, status: failed ? 'recovering' : 'executing', completedSliceIds: [...completed], recoveredSliceIds: [...recoveredSet], failedSliceIds: [...failedSet] };
        this._record(record, failed ? 'slice-failed' : (recovered ? 'slice-recovered' : 'slice-completed'), { sliceId: value, ...deepCopy(details || {}) });
        return this.read(id);
    }

    aggregating(id, metadata = {}) {
        return this.updateExecution(id, { status: 'aggregating', aggregation: { ...(this.records.get(id)?.execution?.aggregation || {}), ...deepCopy(metadata || {}), startedAt: Date.now() } }, 'aggregation-started');
    }

    parsed(id, parsed, raw = undefined) {
        const record = this._transition(id, NEXUS_TRANSACTION_STATE.PARSED);
        if (raw !== undefined) record.raw = deepCopy(raw);
        record.parsed = deepCopy(parsed);
        this._record(record, 'parsed-result');
        return this.read(id);
    }

    validated(id, validation = {}) {
        const passed = validation?.passed !== false;
        if (!passed) return this.fail(id, validation?.reason || 'Validator rejected result.', { validation });
        const record = this._transition(id, NEXUS_TRANSACTION_STATE.VALIDATED);
        record.validation = deepCopy({ passed: true, ...validation }); this._record(record, 'validated'); return this.read(id);
    }

    staged(id, staged, { mutationProposal = null } = {}) {
        const record = this._transition(id, NEXUS_TRANSACTION_STATE.STAGED);
        record.staged = deepCopy(staged);
        if (mutationProposal) record.mutationProposal = createMutationProposal({ ...mutationProposal, transactionId: id, state: 'staged' });
        this._record(record, 'staged');
        return this.read(id);
    }

    approve(id, { by = 'operator', metadata = {} } = {}) {
        const record = this.records.get(id);
        if (!record) throw new Error(`Unknown Nexus transaction: ${id}`);
        if (record.state !== NEXUS_TRANSACTION_STATE.STAGED) throw new Error(`Nexus transaction ${id} must be staged before approval; current state is ${record.state}.`);
        record.approval = { approved: true, by: String(by || 'operator'), at: Date.now(), metadata: deepCopy(metadata || {}) };
        if (record.mutationProposal) record.mutationProposal.state = 'approved';
        this._record(record, 'approved', { by: record.approval.by, metadata: record.approval.metadata });
        return this.read(id);
    }

    reject(id, reason = 'Rejected by operator.') {
        const record = this.records.get(id);
        if (!record) throw new Error(`Unknown Nexus transaction: ${id}`);
        if (record.state !== NEXUS_TRANSACTION_STATE.STAGED) throw new Error(`Nexus transaction ${id} must be staged before rejection; current state is ${record.state}.`);
        this.abort(id, reason);
        const terminal = this.records.get(id);
        // Operator rejection is a semantically stronger terminal proposal state
        // than the transaction container's generic ABORTED state. Preserve it.
        if (terminal?.mutationProposal) terminal.mutationProposal.state = 'rejected';
        this._record(terminal, 'proposal-rejected', { reason: String(reason) });
        return this.read(id);
    }

    checkFresh(id, currentAssumptions = undefined) {
        const record = this.records.get(id);
        if (!record) throw new Error(`Unknown Nexus transaction: ${id}`);
        const expected = record.assumptions || {};
        const protectedKeys = Object.keys(expected);
        if (!protectedKeys.length) {
            const protectedType = !!record.mutationProposal || String(record.type || '').startsWith('external:') || ['uid-summary','merge','lorebook-builder','lorebook-builder2','lore-proposal-apply'].includes(String(record.type || ''));
            if (protectedType) return { fresh: false, required: true, changes: [{ path: 'assumptions', reason: 'protected-assumptions-missing' }] };
            return { fresh: true, changes: [], required: false };
        }
        if (currentAssumptions === undefined) {
            return { fresh: false, required: true, changes: [{ path: '$', expected: deepCopy(expected), current: undefined, reason: 'current assumptions were not supplied' }] };
        }
        return { ...compareTransactionAssumptions(expected, currentAssumptions), required: true };
    }

    stale(id, reason = 'Transaction assumptions changed before commit.', freshness = null) {
        const record = this._transition(id, NEXUS_TRANSACTION_STATE.STALE, { reason, freshness });
        record.error = String(reason);
        record.freshness = deepCopy(freshness);
        normalizeTerminalProposal(record, 'stale');
        return this.read(id);
    }

    prepareCommit(id, { currentAssumptions = undefined } = {}) {
        const record = this.records.get(id);
        if (!record) throw new Error(`Unknown Nexus transaction: ${id}`);
        if (record.state !== NEXUS_TRANSACTION_STATE.STAGED) throw new Error(`Nexus transaction ${id} must be staged before commit; current state is ${record.state}.`);
        if (record.mutationProposal && record.mutationProposal.approvalRequired !== false && record.approval?.approved !== true) {
            throw new Error(`Nexus transaction ${id} requires explicit approval before commit.`);
        }
        const freshness = this.checkFresh(id, currentAssumptions);
        record.freshness = deepCopy(freshness);
        record.commitInvalidation = null;
        this._record(record, 'freshness-check', freshness);
        if (!freshness.fresh) return this.stale(id, 'Transaction became stale before commit. Restage it from current state.', freshness);
        return this.read(this._transition(id, NEXUS_TRANSACTION_STATE.COMMITTING).id);
    }

    completeCommit(id, committed = undefined) {
        const record = this.records.get(id);
        if (!record) throw new Error(`Unknown Nexus transaction: ${id}`);
        if (record.state !== NEXUS_TRANSACTION_STATE.COMMITTING) throw new Error(`Nexus transaction ${id} is not in committing state.`);
        this._transition(id, NEXUS_TRANSACTION_STATE.COMMITTED);
        record.committed = deepCopy(committed === undefined ? record.staged : committed);
        if (record.mutationProposal) record.mutationProposal.state = 'approved';
        this._record(record, 'committed');
        return this.read(id);
    }

    /**
     * Recovery-only reconciliation for a mutation whose durable commit journal
     * is authoritative after an interrupted finalization. This intentionally
     * bypasses the normal forward-only transition table because a ledger row
     * may already have been marked FAILED even though physical persistence was
     * durably recorded as APPLIED.
     */
    reconcileCommit(id, { applied = false, committed = undefined, note = '', terminalNotApplied = false, outcomeUnknown = false } = {}) {
        const record = this.records.get(id);
        if (!record) return null;
        if (applied) {
            record.state = NEXUS_TRANSACTION_STATE.COMMITTED;
            record.committed = deepCopy(committed === undefined ? record.staged : committed);
            record.error = null;
            if (record.mutationProposal) record.mutationProposal.state = 'approved';
            this._record(record, 'commit-reconciled-applied', { note: String(note || '') });
        } else if (outcomeUnknown && (record.state === NEXUS_TRANSACTION_STATE.COMMITTING || record.state === NEXUS_TRANSACTION_STATE.STAGED || record.state === NEXUS_TRANSACTION_STATE.FAILED)) {
            record.state = NEXUS_TRANSACTION_STATE.FAILED;
            record.commitOutcomeUnknown = true;
            record.error = String(note || 'Durable recovery proved canonical state diverged from both PRE and POST; the old mutation outcome remains unknown and its replay identity is fenced.');
            normalizeTerminalProposal(record, 'failed');
            this._record(record, 'commit-reconciled-diverged', { note: record.error, outcomeUnknown: true });
        } else if (record.state === NEXUS_TRANSACTION_STATE.COMMITTING || (terminalNotApplied && record.state === NEXUS_TRANSACTION_STATE.STAGED)) {
            record.state = NEXUS_TRANSACTION_STATE.FAILED;
            record.error = String(note || 'Durable recovery confirmed the physical mutation was not applied.');
            normalizeTerminalProposal(record, 'failed');
            this._record(record, 'commit-reconciled-not-applied', { note: record.error });
        } else {
            this._record(record, 'commit-reconciliation-observed', { applied: false, note: String(note || '') });
        }
        this._trim();
        return this.read(id);
    }

    committed(id, committed = undefined, options = {}) {
        const prepared = this.prepareCommit(id, options);
        if (prepared.state === NEXUS_TRANSACTION_STATE.STALE) return prepared;
        return this.completeCommit(id, committed);
    }

    abort(id, reason = 'Aborted') {
        const record = this._transition(id, NEXUS_TRANSACTION_STATE.ABORTED, { reason });
        record.error = String(reason); normalizeTerminalProposal(record, 'aborted'); return this.read(id);
    }

    cancel(id, reason = 'Cancelled') {
        const record = this._transition(id, NEXUS_TRANSACTION_STATE.CANCELLED, { reason }); record.error = String(reason); normalizeTerminalProposal(record, 'cancelled'); return this.read(id);
    }

    fail(id, error, details = {}) {
        const record = this._transition(id, NEXUS_TRANSACTION_STATE.FAILED, { error: errorText(error), ...details }); record.error = errorText(error); normalizeTerminalProposal(record, 'failed'); return this.read(id);
    }

    async run(transaction, handlers = {}) {
        const id = typeof transaction === 'string' ? transaction : transaction?.id;
        if (!id) throw new Error('Transaction ID is required.');
        try {
            this.executing(id);
            const raw = await handlers.execute?.(this.read(id));
            const parsed = handlers.parse ? await handlers.parse(raw, this.read(id)) : raw;
            this.parsed(id, parsed, raw);
            const validation = handlers.validate ? await handlers.validate(parsed, this.read(id)) : { passed: true };
            const checked = this.validated(id, validation);
            if (checked.state === NEXUS_TRANSACTION_STATE.FAILED) return checked;
            const staged = handlers.stage ? await handlers.stage(parsed, this.read(id)) : parsed;
            this.staged(id, staged, { mutationProposal: handlers.mutationProposal ? await handlers.mutationProposal(staged, this.read(id)) : null });
            if (handlers.commit) {
                const current = this.records.get(id);
                if (current?.mutationProposal && current.mutationProposal.approvalRequired !== false && current.approval?.approved !== true) {
                    // Mutation workflows stop at STAGED. A later explicit approval
                    // must re-check assumptions before any commit callback runs.
                    return this.read(id);
                }
                const currentAssumptions = handlers.currentAssumptions ? await handlers.currentAssumptions(this.read(id)) : undefined;
                const prepared = this.prepareCommit(id, { currentAssumptions });
                if (prepared.state === NEXUS_TRANSACTION_STATE.STALE) return prepared;
                return this.completeCommit(id, await handlers.commit(staged, this.read(id)));
            }
            return this.read(id);
        } catch (error) {
            const record = this.records.get(id);
            if (record && !TERMINAL.has(record.state)) this.fail(id, error);
            throw error;
        }
    }

    getCommitInvalidation(id) {
        const record = this.records.get(id);
        return deepCopy(record?.commitInvalidation || null);
    }

    invalidateWhere(predicate, reason = 'Transaction scope invalidated.') {
        if (typeof predicate !== 'function') return [];
        const changed = [];
        for (const record of this.records.values()) {
            if (TERMINAL.has(record.state) || !predicate(record)) continue;
            if (record.state === NEXUS_TRANSACTION_STATE.COMMITTING) {
                // Once a transaction has entered the coordinator-owned commit
                // section, invalidation becomes a cancellation request rather than
                // a competing terminal state transition. The coordinator checks
                // this request again immediately before first physical persistence.
                // If persistence already began, physical truth is settled normally
                // and the invalidation remains audit evidence instead of rewriting
                // an APPLIED mutation back to STALE.
                record.commitInvalidation = { reason: String(reason), requestedAt: Date.now() };
                this._record(record, 'commit-invalidation-requested', { reason: String(reason) });
                changed.push(record.id);
                continue;
            }
            const next = TRANSITIONS[record.state]?.includes(NEXUS_TRANSACTION_STATE.STALE) ? NEXUS_TRANSACTION_STATE.STALE : (TRANSITIONS[record.state]?.includes(NEXUS_TRANSACTION_STATE.CANCELLED) ? NEXUS_TRANSACTION_STATE.CANCELLED : null);
            if (!next) continue;
            if (next === NEXUS_TRANSACTION_STATE.STALE) this.stale(record.id, reason, { fresh: false, required: true, changes: [{ path: 'scope', reason }] });
            else this.cancel(record.id, reason);
            changed.push(record.id);
        }
        return changed;
    }

    invalidateChat(chatId, reason = 'Chat scope changed.') {
        const target = chatId == null ? null : String(chatId);
        return this.invalidateWhere(record => (record.assumptions?.chatId ?? null) === target, reason);
    }

    restore(records = [], { replace = false } = {}) {
        const input = Array.isArray(records) ? records : [];
        const ids = new Set();
        const prepared = input.map(raw => {
            if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { const error=new Error('Durable Nexus Transaction Ledger contains a malformed row.'); error.name='TV2TransactionLedgerCorrupt'; throw error; }
            const id=String(raw.id||'').trim(), type=String(raw.type||'').trim();
            if (!id || !type || ids.has(id)) { const error=new Error(`Durable Nexus Transaction Ledger contains a missing or duplicate transaction identity ${id||'(missing)'}.`); error.name='TV2TransactionLedgerCorrupt'; throw error; }
            ids.add(id);
            try { assertNexusTransactionState(raw.state); } catch (cause) { const error=new Error(`Durable Nexus transaction ${id} has invalid state ${String(raw.state)}.`); error.name='TV2TransactionLedgerCorrupt'; error.cause=cause; throw error; }
            for (const [name,value] of [['input',raw.input],['assumptions',raw.assumptions],['metadata',raw.metadata]]) {
                if (!isObject(value)) { const error=new Error(`Durable Nexus transaction ${id} is missing its ${name} object.`); error.name='TV2TransactionLedgerCorrupt'; throw error; }
            }
            if (!Array.isArray(raw.history)) { const error=new Error(`Durable Nexus transaction ${id} is missing its audit history.`); error.name='TV2TransactionLedgerCorrupt'; throw error; }
            if (!Number.isFinite(Number(raw.createdAt)) || !Number.isFinite(Number(raw.updatedAt))) { const error=new Error(`Durable Nexus transaction ${id} is missing valid timestamps.`); error.name='TV2TransactionLedgerCorrupt'; throw error; }
            const protectedType = !!raw.mutationProposal || type.startsWith('external:') || ['uid-summary','merge','lorebook-builder','lorebook-builder2','lore-proposal-apply'].includes(type);
            if (protectedType && Object.keys(raw.assumptions).length === 0) { const error=new Error(`Durable protected Nexus transaction ${id} has empty freshness assumptions.`); error.name='TV2TransactionLedgerCorrupt'; throw error; }
            let normalized;
            try { normalized=createNexusTransaction(raw); }
            catch (cause) { const error=new Error(`Durable Nexus transaction ${id} fails the typed transaction contract: ${cause?.message||cause}`); error.name='TV2TransactionLedgerCorrupt'; error.cause=cause; throw error; }
            return {...normalized,...deepCopy(raw),id,type,state:raw.state,input:deepCopy(raw.input),assumptions:deepCopy(raw.assumptions),metadata:deepCopy(raw.metadata),history:deepCopy(raw.history)};
        });
        const restored=[];
        for (const record of prepared) {
            if (!replace && this.records.has(String(record.id))) continue;
            this.records.set(String(record.id), record); restored.push(String(record.id));
        }
        this._trim();
        for (const id of restored) { const record=this.records.get(id); if(record)this._emit(record); }
        return restored;
    }

    read(id) { const record = this.records.get(id); return record ? deepCopy(record) : null; }
    list({ state = null, type = null } = {}) { return [...this.records.values()].filter(row => (!state || row.state === state) && (!type || row.type === type)).map(deepCopy); }
}
