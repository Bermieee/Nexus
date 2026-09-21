import {
    NEXUS_CALL_TARGET,
    NEXUS_CALL_DIRECTION,
    createCallTicket,
    assertNexusCallTicket,
    deepCopy,
    isCallCenterBoundaryTarget,
} from './contracts.js';
import { CapabilityPolicyGate, DEFAULT_CAPABILITY_POLICY } from './policy-gate.js';
import { currentNexusChatEpoch } from './work-scope.js';
import { currentOperatorReviewScope, normalizeOperatorReviewScope } from './review-scope.js';

export { createCallTicket, DEFAULT_CAPABILITY_POLICY };

export const NEXUS_CAPABILITY = Object.freeze({
    SEARCH: 'search',
    READ_MEMORY: 'read-memory',
    COLD_OPEN: 'cold-open',
    LOREBOOK_BUILDER: 'lorebook-builder',
    REMEMBER: 'remember',
    UPDATE: 'update',
    SUMMARIZE: 'summarize',
    ORGANIZE: 'organize',
    MERGE: 'merge',
    SPLIT: 'split',
    DELETE: 'delete',
});

const MUTATIONS = new Set([
    NEXUS_CAPABILITY.REMEMBER,
    NEXUS_CAPABILITY.UPDATE,
    NEXUS_CAPABILITY.SUMMARIZE,
    NEXUS_CAPABILITY.ORGANIZE,
    NEXUS_CAPABILITY.MERGE,
    NEXUS_CAPABILITY.SPLIT,
    NEXUS_CAPABILITY.DELETE,
]);

export function isMutationCapability(capability) { return MUTATIONS.has(String(capability)); }

export function evaluateCallPolicy(ticket, policy = {}, descriptor = null) {
    const gate = new CapabilityPolicyGate({ policy, mutationCapabilities: [...MUTATIONS] });
    return gate.inspect(ticket, { descriptor });
}

/**
 * Boundary turnout only. Internal Sidecar jobs never enter this class.
 *
 * Policy answers whether the caller may use a capability; Logic Gate answers
 * whether that permitted boundary call may run now; the selected adapter then
 * translates the ticket across the boundary.
 */
export class CallCenter {
    constructor({ policy = {}, policyGate = null, logicGate = null } = {}) {
        this.policy = { ...DEFAULT_CAPABILITY_POLICY, ...deepCopy(policy) };
        this.policyGate = policyGate || new CapabilityPolicyGate({ policy: this.policy, mutationCapabilities: [...MUTATIONS] });
        this.logicGate = logicGate;
        this.adapters = new Map();
        this.history = [];
        this.historyLimit = 100;
        this.terminalArchive = [];
        this.terminalArchiveLimit = 4096;
        this.maxPendingApprovals = 256;
        this.maxPendingAuthorityChars = 1_500_000;
        this.pendingApprovals = new Map();
        this.auditBackpressure = false;
    }

    _isActiveAuthorityState(state) {
        return ['created', 'awaiting-approval', 'approved-deferred', 'running'].includes(String(state || ''));
    }

    _terminalReceipt(record) {
        return {
            id: String(record?.ticket?.id || ''),
            kind: 'call-ticket',
            state: String(record?.state || ''),
            capability: String(record?.ticket?.capability || ''),
            direction: String(record?.ticket?.direction || ''),
            at: Number(record?.at || 0),
            resolvedAt: Number(record?.resolvedAt || record?.completedAt || 0) || null,
            error: record?.error ? String(record.error).slice(0, 500) : '',
            reviewScope: deepCopy(record?.ticket?.metadata?.reviewScope || null),
        };
    }

    _trimHistory() {
        this.auditBackpressure = false;
        while (this.history.length > this.historyLimit) {
            const index = this.history.findIndex(row => !this._isActiveAuthorityState(row?.state));
            if (index < 0) break; // active authority is never retention-evicted
            if (this.terminalArchive.length >= this.terminalArchiveLimit) {
                this.auditBackpressure = true;
                break;
            }
            const [removed] = this.history.splice(index, 1);
            this.terminalArchive.push(this._terminalReceipt(removed));
        }
    }

    _assertApprovalCapacity(ticket) {
        if (this.auditBackpressure) {
            const error = new Error('Nexus Call Center terminal audit archive reached its supported capacity. Export/rotate audit evidence before admitting more review work.');
            error.name = 'TV2CallCenterAuditCapacityExceeded';
            throw error;
        }
        if (this.pendingApprovals.size >= this.maxPendingApprovals && !this.pendingApprovals.has(String(ticket?.id || ''))) {
            const error = new Error(`Nexus Call Center reached its ${this.maxPendingApprovals}-approval unresolved safety bound. Resolve existing approvals before staging more.`);
            error.name = 'TV2CallCenterBackpressure';
            throw error;
        }
        const projected = { history: this.history, pendingApprovals: [...this.pendingApprovals.values(), { ticket, state: 'awaiting-approval', at: Date.now() }] };
        let chars = 0;
        try { chars = JSON.stringify(projected).length; } catch { chars = this.maxPendingAuthorityChars + 1; }
        if (chars > this.maxPendingAuthorityChars) {
            const error = new Error('Nexus Call Center pending approval authority reached its durable serialized-size safety bound. Resolve existing approvals before staging more.');
            error.name = 'TV2CallCenterBackpressure';
            error.authorityChars = chars;
            error.maxAuthorityChars = this.maxPendingAuthorityChars;
            throw error;
        }
    }

    _syncPending(record) {
        const id = String(record?.ticket?.id || '').trim();
        if (!id) return;
        if (['awaiting-approval', 'approved-deferred'].includes(String(record?.state || ''))) this.pendingApprovals.set(id, record);
        else if (this.pendingApprovals.get(id) === record) this.pendingApprovals.delete(id);
    }

    _setState(record, state, patch = {}) {
        if (!record) return record;
        record.state = String(state);
        Object.assign(record, patch || {});
        this._syncPending(record);
        this._trimHistory();
        return record;
    }

    _appendHistory(record) {
        this.history.push(record);
        this._syncPending(record);
        this._trimHistory();
        return record;
    }

    findTicket(ticketId) {
        const id = String(ticketId || '').trim();
        if (!id) return null;
        const pending = this.pendingApprovals.get(id);
        if (pending) return deepCopy(pending);
        const latest = [...this.history].reverse().find(record => record?.ticket?.id === id);
        return deepCopy(latest || null);
    }

    pendingApprovalPage({ offset = 0, limit = 100 } = {}) {
        const rows = [...this.pendingApprovals.values()].sort((a, b) => Number(a?.at || 0) - Number(b?.at || 0));
        const start = Math.max(0, Math.floor(Number(offset) || 0));
        const cap = Math.max(1, Math.min(250, Math.floor(Number(limit) || 100)));
        return { total: rows.length, offset: start, limit: cap, rows: rows.slice(start, start + cap).map(deepCopy) };
    }

    exportAuthority() {
        return {
            history: this.history.map(deepCopy),
            pendingApprovals: [...this.pendingApprovals.values()].map(deepCopy),
            terminalArchive: this.terminalArchive.map(deepCopy),
        };
    }

    restoreAuthority(authority = {}, { normalizeInterrupted = true } = {}) {
        const sourceHistory = Array.isArray(authority?.history) ? authority.history : [];
        const sourcePending = Array.isArray(authority?.pendingApprovals) ? authority.pendingApprovals : [];
        const sourceArchive = Array.isArray(authority?.terminalArchive) ? authority.terminalArchive : [];
        const historyIds = new Set();
        const history = sourceHistory.map(raw => {
            const row = deepCopy(raw);
            try { assertNexusCallTicket(row?.ticket); }
            catch (cause) { const error = new Error(`Durable Call Center history contains an invalid typed Call Ticket: ${cause?.message || cause}`); error.name = 'TV2CallCenterAuthorityCorrupt'; throw error; }
            const historyId=String(row?.ticket?.id||'').trim();
            if (!historyId || historyIds.has(historyId)) { const error=new Error(`Durable Call Center history contains duplicate Call Ticket identity ${historyId||'(missing)'}.`); error.name='TV2CallCenterAuthorityCorrupt'; throw error; }
            historyIds.add(historyId);
            if (normalizeInterrupted && String(row.state || '') === 'running') {
                row.state = 'interrupted';
                row.error = 'Call Ticket execution was interrupted by reload; no live executor owns this restored record.';
                row.interruptedAt = Date.now();
            }
            return row;
        });
        const pendingIds = new Set();
        const pending = new Map();
        for (const raw of sourcePending) {
            const candidate = deepCopy(raw);
            try { assertNexusCallTicket(candidate?.ticket); }
            catch (cause) { const error = new Error(`Durable Call Center pending approval contains an invalid typed Call Ticket: ${cause?.message || cause}`); error.name = 'TV2CallCenterAuthorityCorrupt'; throw error; }
            const id = String(candidate?.ticket?.id || '').trim();
            if (!id || pendingIds.has(id)) { const error = new Error(`Durable Call Center authority contains duplicate pending Call Ticket identity ${id || '(missing)'}.`); error.name = 'TV2CallCenterAuthorityCorrupt'; throw error; }
            pendingIds.add(id);
            if (!['awaiting-approval', 'approved-deferred'].includes(String(candidate.state || ''))) { const error = new Error(`Durable pending Call Ticket ${id} has unsupported state ${String(candidate.state)}.`); error.name = 'TV2CallCenterAuthorityCorrupt'; throw error; }
            // One logical approval has one mutable record identity. Reuse the
            // matching unresolved history object rather than restoring a detached
            // clone that can later disagree with history after rejection/approval.
            const matches = history.filter(row => String(row?.ticket?.id || '') === id && ['awaiting-approval','approved-deferred'].includes(String(row?.state || '')));
            if (matches.length > 1) { const error = new Error(`Durable Call Center authority contains duplicate unresolved history records for ${id}.`); error.name='TV2CallCenterAuthorityCorrupt'; throw error; }
            let canonical = matches[0] || null;
            if (canonical && JSON.stringify(canonical) !== JSON.stringify(candidate)) { const error = new Error(`Durable Call Center pending/history projections disagree for ${id}.`); error.name='TV2CallCenterAuthorityCorrupt'; throw error; }
            if (!canonical) { canonical = candidate; history.push(canonical); }
            pending.set(id, canonical);
        }
        this.history = history;
        this.pendingApprovals = pending;
        this.terminalArchive = sourceArchive.map(deepCopy);
        if (this.terminalArchive.length > this.terminalArchiveLimit) { const error=new Error('Durable Call Center terminal audit archive exceeds supported capacity.'); error.name='TV2CallCenterAuthorityCorrupt'; throw error; }
        this._trimHistory();
        return this.snapshot();
    }

    _ticketScopeFresh(ticket) {
        const chatBound = ticket?.metadata?.chatBound === true;
        const epoch = Number(ticket?.metadata?.nexusChatEpoch);
        const inbound = String(ticket?.direction||'') === NEXUS_CALL_DIRECTION.MAIN_TO_NEXUS;
        // Chat-bound calls must prove a live session epoch. Durable Main->Nexus
        // review authority additionally proves its Operator Review scope.
        if (!Number.isFinite(epoch) || epoch <= 0) return !chatBound && !inbound;
        if (chatBound && epoch !== currentNexusChatEpoch()) return false;
        if (!inbound) return true;
        const tagged=ticket?.metadata?.reviewScope;
        if(!tagged)return false;
        let expected,current;
        try{expected=normalizeOperatorReviewScope(tagged);current=currentOperatorReviewScope();}catch{return false;}
        if(!expected.chatId||expected.identity!==current.identity||String(expected.chatId)!==String(current.chatId))return false;
        const generation=Number(ticket?.metadata?.reviewScopeGeneration);
        return Number.isInteger(generation)&&generation>=0;
    }

    configure({ policy = null, logic = null } = {}) {
        if (policy && typeof policy === 'object') {
            this.policy = { ...DEFAULT_CAPABILITY_POLICY, ...deepCopy(policy) };
            this.policyGate?.configure?.({ policy: this.policy, mutationCapabilities: [...MUTATIONS] });
        }
        if (logic && typeof logic === 'object') this.logicGate?.configure?.(logic);
        return {
            policy: deepCopy(this.policy),
            logic: this.logicGate?.snapshot?.() || null,
        };
    }

    registerAdapter(target, adapter) {
        if (!isCallCenterBoundaryTarget(target) || [NEXUS_CALL_TARGET.SIDE_CAR_A, NEXUS_CALL_TARGET.SIDE_CAR_B].includes(target)) {
            throw new Error(`Call Center target is not a boundary adapter: ${target}`);
        }
        if (!adapter || typeof adapter.dispatch !== 'function') throw new Error('Call Center adapter must expose dispatch(ticket).');
        this.adapters.set(target, adapter);
        return () => this.adapters.delete(target);
    }

    inspect(ticket, descriptor = null) { return this.policyGate.inspect(ticket, { descriptor }); }

    async dispatch(ticketLike, { approved = false, logic = {}, descriptor = null, signal = null, timeoutMs = null } = {}) {
        // Call Center accepts typed boundary tickets only. Raw Nexus Jobs/Plans
        // are intentionally rejected here instead of being normalized into a
        // boundary call by accident.
        const ticket = assertNexusCallTicket(ticketLike);
        // Approval is policy authority, not execution admission. Keep the
        // original review row retryable until the Logic Gate admits the replay.
        const priorApproval = approved ? this.pendingApprovals.get(String(ticket.id)) || null : null;
        const decision = this.inspect(ticket, descriptor);
        if (decision.requiresApproval && !approved) this._assertApprovalCapacity(ticket);
        const record = { ticket: deepCopy(ticket), decision, gate: null, state: 'created', result: null, error: null, at: Date.now() };
        this._appendHistory(record);

        // Pending Main -> Nexus requests are stamped with the chat epoch at the
        // Function Gateway. CHAT_CHANGED increments that epoch, so approval can
        // never silently rebind an old request to the newly current chat.
        if (!this._ticketScopeFresh(ticket)) {
            this._setState(record, 'blocked');
            record.error = 'Call Ticket belongs to a stale or untyped durable Nexus review scope. Re-submit it from the current chat.';
            if(priorApproval)this._setState(priorApproval,'scope-invalidated',{error:record.error,resolvedAt:Date.now()});
            this._trimHistory();
            return deepCopy(record);
        }

        // The gates are deliberately sequential: Registry resolution happens
        // before this method (for inbound functions), then Policy decides
        // whether the caller may use the capability, then explicit approval if
        // required, then Logic decides whether an allowed call may run now.
        if (!decision.allowed) { this._setState(record, 'blocked'); record.error = decision.reason; return deepCopy(record); }
        if (decision.requiresApproval && !approved) { this._setState(record, 'awaiting-approval'); return deepCopy(record); }
        const gate = this.logicGate?.inspect(ticket, logic) || { allowed: true, checks: [] };
        record.gate = deepCopy(gate);
        if (!gate.allowed) { this._setState(record, 'blocked'); record.error = gate.reason; if (priorApproval) this._setState(priorApproval, 'approved-deferred', { error: gate.reason, deferredAt: Date.now() }); return deepCopy(record); }

        const adapter = this.adapters.get(ticket.preferredTarget);
        if (!adapter) { this._setState(record, 'unavailable'); record.error = `No adapter is registered for ${ticket.preferredTarget}.`; if (priorApproval) this._setState(priorApproval, 'approved-deferred', { error: record.error, deferredAt: Date.now() }); return deepCopy(record); }
        // Execution admission succeeded. Only now is the operator approval consumed.
        if (priorApproval) this._setState(priorApproval, 'approval-consumed', { error: null, resolvedAt: Date.now() });
        // Cooldown is an admission lease. Reserve it before dispatch so concurrent
        // same-capability calls and immediate retries after failure cannot stampede.
        const cooldownLease=this.logicGate?.recordRun(ticket);
        try {
            this._setState(record, 'running');
            record.result = await adapter.dispatch(deepCopy(ticket), { descriptor: descriptor ? { ...descriptor, handler: undefined, execute: undefined, parse: undefined, stage: undefined, commit: undefined, snapshot: undefined, assumptions: undefined, validate: undefined } : null, signal, timeoutMs });
            if (!this._ticketScopeFresh(ticket)) {
                this._setState(record, 'stale');
                record.error = 'Call Ticket completed physically after its Nexus chat scope became stale; result was discarded.';
                record.result = null;
            } else this._setState(record, 'completed');
        } catch (error) {
            this._setState(record, error?.deferred === true ? 'deferred' : 'failed');
            record.error = String(error?.message || error);
            if (error?.deferred === true) {
                this.logicGate?.rollbackRun?.(ticket,cooldownLease);
                record.deferReason = String(error?.name || 'deferred');
                record.busySource = error?.busySource || null;
            }
            if (error?.deferred === true && priorApproval) {
                this._setState(priorApproval, 'approved-deferred', { error: record.error, deferredAt: Date.now(), resolvedAt: null });
            }
        }
        return deepCopy(record);
    }


    discardUndurablePending(ticketId, reason = 'Operator Review durability was not established.') {
        const id = String(ticketId || '').trim();
        const row = this.pendingApprovals.get(id);
        if (!row) return null;
        this._setState(row, 'durability-blocked', { error: String(reason), resolvedAt: Date.now() });
        return deepCopy(row);
    }

    rejectPending(ticketId, reason = 'Rejected by operator.') {
        const id = String(ticketId || '').trim();
        const latest = this.pendingApprovals.get(id) || [...this.history].reverse().find(record => record?.ticket?.id === id);
        if (!latest) return { state: 'blocked', error: `Unknown Call Center ticket: ${id || '(missing)'}`, ticket: null };
        if (!['awaiting-approval', 'approved-deferred'].includes(String(latest.state || ''))) return { state: 'blocked', error: `Call Center ticket ${id} is not awaiting approval; current state is ${latest.state}.`, ticket: deepCopy(latest.ticket) };
        this._setState(latest, 'rejected');
        latest.result = null;
        latest.error = String(reason || 'Rejected by operator.');
        latest.resolvedAt = Date.now();
        this._trimHistory();
        return deepCopy(latest);
    }

    invalidatePending(ticketId, reason = 'Call Ticket review scope is no longer current.') {
        const id = String(ticketId || '').trim();
        const latest = this.pendingApprovals.get(id) || [...this.history].reverse().find(record => record?.ticket?.id === id);
        if (!latest) return { state: 'blocked', error: `Unknown Call Center ticket: ${id || '(missing)'}`, ticket: null };
        if (!['awaiting-approval', 'approved-deferred'].includes(String(latest.state || ''))) return { state: 'blocked', error: `Call Center ticket ${id} is not awaiting approval; current state is ${latest.state}.`, ticket: deepCopy(latest.ticket) };
        this._setState(latest, 'scope-invalidated');
        latest.result = null;
        latest.error = String(reason || 'Call Ticket review scope is no longer current.');
        latest.resolvedAt = Date.now();
        this._trimHistory();
        return deepCopy(latest);
    }

    restoreHistory(records = []) {
        const rows = Array.isArray(records) ? deepCopy(records) : [];
        const pending = rows.filter(row => ['awaiting-approval','approved-deferred'].includes(String(row?.state || '')));
        return this.restoreAuthority({ history: rows, pendingApprovals: pending, terminalArchive: [] });
    }

    snapshot({ includePending = true, limit = this.historyLimit } = {}) {
        const cap = Math.max(1, Math.min(500, Math.floor(Number(limit) || this.historyLimit)));
        const rows = [...this.history];
        if (includePending) {
            const seen = new Set(rows.map(row => `${row?.ticket?.id || ''}|${row?.state || ''}|${row?.at || 0}`));
            for (const row of this.pendingApprovals.values()) {
                const key = `${row?.ticket?.id || ''}|${row?.state || ''}|${row?.at || 0}`;
                if (!seen.has(key)) rows.push(row);
            }
        }
        rows.sort((a, b) => Number(a?.at || 0) - Number(b?.at || 0));
        return rows.slice(-cap).map(deepCopy);
    }
}
