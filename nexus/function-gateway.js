import {
    NEXUS_CALL_DIRECTION,
    NEXUS_CALL_TARGET,
    NEXUS_TRANSACTION_STATE,
    createCallTicket,
    assertNexusCallTicket,
    createMutationProposal,
    deepCopy,
} from './contracts.js';
import { CapabilityRegistry } from './capability-registry.js';
import { currentNexusChatEpoch } from './work-scope.js';
import { getNexusLedger, failNexusTransactionDurable as failNexusTransaction } from './transaction-service.js';
import { descriptorImplementationFingerprint, fingerprintValue } from './integrity.js';

function externalTransactionError(tx, message) {
    return {
        state: 'blocked',
        transactionId: tx?.id || null,
        transactionState: tx?.state || null,
        error: String(message || 'External Nexus transaction is not eligible for this operation.'),
    };
}

function projectExternalTransaction(tx, state, { reason = '', freshness = null } = {}) {
    const out = deepCopy(tx);
    out.state = String(state);
    out.updatedAt = Date.now();
    if (reason) out.error = String(reason);
    if (freshness != null) out.freshness = deepCopy(freshness);
    if (out.mutationProposal) {
        if (state === NEXUS_TRANSACTION_STATE.ABORTED) out.mutationProposal.state = 'rejected';
        else if (state === NEXUS_TRANSACTION_STATE.STALE) out.mutationProposal.state = 'stale';
        else if (state === NEXUS_TRANSACTION_STATE.COMMITTED) out.mutationProposal.state = 'approved';
        else if ([NEXUS_TRANSACTION_STATE.FAILED, NEXUS_TRANSACTION_STATE.CANCELLED].includes(state)) out.mutationProposal.state = state;
    }
    return out;
}

function mutationTargetFromTicket(descriptor, args = {}, ticket = {}) {
    const explicit = ticket?.metadata?.target;
    if (explicit && typeof explicit === 'object' && !Array.isArray(explicit) && Object.keys(explicit).length) return deepCopy(explicit);
    const target = { capability: String(descriptor?.capability || descriptor?.name || 'mutation') };
    const keys = ['book','bookName','uid','entryUid','nodeId','targetNodeId','newParentNodeId','proposalId','memoryId','summaryId','chatId','key','id','sourceUid','targetUid','mode'];
    for (const key of keys) {
        const value = args?.[key];
        if (value === undefined || value === null || value === '') continue;
        if (['string','number','boolean'].includes(typeof value)) target[key] = value;
    }
    return target;
}

function isTerminalExternalState(state) {
    return [NEXUS_TRANSACTION_STATE.COMMITTED, NEXUS_TRANSACTION_STATE.STALE, NEXUS_TRANSACTION_STATE.ABORTED, NEXUS_TRANSACTION_STATE.FAILED, NEXUS_TRANSACTION_STATE.CANCELLED].includes(String(state || ''));
}

/**
 * Main -> Nexus boundary translation.
 *
 * Registry resolution happens first. Call Center then applies Policy Gate and
 * Logic Gate. Read-only capabilities may execute directly. Mutation
 * capabilities are executed inside a Ledger transaction and stop at STAGED;
 * the gateway never performs the final persistent-state commit during dispatch.
 *
 * A later explicit operator approval may call approveAndCommit(). That method
 * re-resolves the registered capability, recomputes the protected assumptions,
 * asks the canonical mutation coordinator to revalidate after resource admission,
 * and only then executes the descriptor's immutable operation. This keeps Main from approving its own mutation simply by making the original boundary call.
 */
export class FunctionGateway {
    constructor({ registry = new CapabilityRegistry(), callCenter, ledger = null, commitMutation = null, reviewStore = null, policyResolver = null, argumentValidator = null } = {}) {
        if (!callCenter || typeof callCenter.dispatch !== 'function' || typeof callCenter.registerAdapter !== 'function') throw new Error('Function Gateway requires a Call Center.');
        this.registry = registry;
        this.callCenter = callCenter;
        this.ledger = ledger || getNexusLedger();
        this.reviewStore = reviewStore || null;
        this.reviewError = null;
        this.policyResolver = typeof policyResolver === 'function' ? policyResolver : null;
        this.argumentValidator = typeof argumentValidator === 'function' ? argumentValidator : null;
        this.closed = false;
        this.authorityGeneration = 1;
        this.activeTransactions = new Set();
        this.abortController = new AbortController();
        this.commitMutation = typeof commitMutation === 'function' ? commitMutation : async (...args) => {
            const { commitCanonicalNexusMutation } = await import('./mutation-coordinator.js');
            return commitCanonicalNexusMutation(...args);
        };
        this.unregister = this.callCenter.registerAdapter(NEXUS_CALL_TARGET.NEXUS_SERVICE, {
            dispatch: ticket => this._dispatchResolved(ticket),
        });
    }

    _captureAuthority() {
        if (this.closed) { const error=new Error('Nexus Function Gateway authority has been revoked.'); error.name='TV2FunctionGatewayAuthorityRevoked'; throw error; }
        return this.authorityGeneration;
    }
    _assertAuthority(generation) {
        if (!this.closed && generation === this.authorityGeneration) return true;
        const error=new Error('Nexus Function Gateway operation outlived its controller authority.');
        error.name='TV2FunctionGatewayAuthorityRevoked';error.gatewayAuthorityRevoked=true;
        throw error;
    }
    close(reason = 'Function Gateway authority revoked.') {
        if (this.closed) return;
        this.closed = true;
        this.authorityGeneration += 1;
        try { this.abortController.abort(reason); } catch {}
        try { this.unregister?.(); } catch {}
        this.unregister = null;
        for (const id of [...this.activeTransactions]) {
            try { this.ledger.invalidateWhere?.(row => String(row?.id||'')===String(id), reason); } catch {}
        }
    }
    _reviewScope() {
        if (!this.reviewStore?.scopeProjection) { const error = new Error('Nexus Operator Review durable scope is unavailable.'); error.name = 'TV2OperatorReviewDurabilityUnavailable'; throw error; }
        return this.reviewStore.scopeProjection();
    }
    _protectedAssumptions(base = {}) {
        const scope = this._reviewScope();
        return { ...deepCopy(base || {}), chatId: scope.chatId, operatorReviewScope: scope.identity, operatorReviewGeneration: scope.generation };
    }
    _policySnapshot() {
        const raw=this.policyResolver?this.policyResolver():{enabled:true,mainModelAccess:true};
        return { enabled:raw?.enabled===true, mainModelAccess:raw?.mainModelAccess===true };
    }
    _assertBoundaryPolicy() {
        const policy=this._policySnapshot();
        if(!policy.enabled||!policy.mainModelAccess){const error=new Error('Nexus Main-model Function Gateway authority is currently disabled by policy.');error.name='TV2BoundaryPolicyRevoked';throw error;}
        return policy;
    }
    _descriptorBinding(descriptor) {
        const schema=deepCopy(descriptor?.metadata?.argumentSchema||null);
        return { registryName:String(descriptor?.name||''), capability:String(descriptor?.capability||''), descriptorFingerprint:descriptorImplementationFingerprint(descriptor), argumentSchemaFingerprint:fingerprintValue(schema), argumentSchema:schema };
    }
    _validateArguments(descriptor,args,label='Nexus boundary arguments') {
        const schema=descriptor?.metadata?.argumentSchema||null;
        if(this.argumentValidator)this.argumentValidator(args,schema,label);
        return true;
    }
    _assertDescriptorBinding(ticket,descriptor) {
        const binding=this._descriptorBinding(descriptor), meta=ticket?.metadata||{};
        if(String(ticket?.capability||'')!==binding.capability)throw new Error(`Call Ticket capability ${ticket?.capability||'(missing)'} no longer matches registry descriptor ${binding.capability||'(missing)'}.`);
        if(String(meta.registryName||'').trim().toLowerCase()!==binding.registryName)throw new Error('Call Ticket registry identity no longer matches the resolved capability.');
        if(!meta.descriptorFingerprint||String(meta.descriptorFingerprint)!==binding.descriptorFingerprint)throw new Error('Call Ticket was reviewed against a different capability implementation. Re-submit it.');
        if(!meta.argumentSchemaFingerprint||String(meta.argumentSchemaFingerprint)!==binding.argumentSchemaFingerprint)throw new Error('Call Ticket was reviewed against a different capability argument schema. Re-submit it.');
        return binding;
    }
    _assertTicketScope(ticket) {
        const current=this._reviewScope(), tagged=ticket?.metadata?.reviewScope;
        if(!tagged||String(tagged.identity||'')!==String(current.identity||'')||String(tagged.chatId??'')!==String(current.chatId??'')){const error=new Error('Call Ticket belongs to a different durable Operator Review scope.');error.name='TV2OperatorReviewScopeMismatch';throw error;}
        const generation=Number(ticket?.metadata?.reviewScopeGeneration);
        if(!Number.isInteger(generation)||generation!==Number(current.generation)){const error=new Error('Call Ticket belongs to a stale Operator Review generation.');error.name='TV2OperatorReviewGenerationStale';throw error;}
        return current;
    }
    _assertTicketScopeCurrent(ticket) {
        const expectedEpoch=Number(ticket?.metadata?.nexusChatEpoch);
        if(Number.isFinite(expectedEpoch)&&expectedEpoch>0&&expectedEpoch!==currentNexusChatEpoch()){
            const error=new Error('Main → Nexus Call Ticket became stale before transaction admission. Re-submit it from the current chat.');
            error.name='TV2StaleNexusCallTicket';
            throw error;
        }
        this._assertTicketScope(ticket);
        return true;
    }
    async _persistReview(options = {}) {
        try {
            if (!this.reviewStore?.persist) { const error = new Error('Nexus Operator Review durable storage is required for review authority.'); error.name='TV2OperatorReviewDurabilityUnavailable'; throw error; }
            const authorityGeneration=options?.authorityGeneration??null;
            if(authorityGeneration!=null)this._assertAuthority(authorityGeneration);
            const callCenter = options?.callCenterOverride || this.callCenter;
            const persistOptions = { ...(options || {}) }; delete persistOptions.callCenterOverride;delete persistOptions.authorityGeneration;
            if(authorityGeneration!=null)persistOptions.authorityGuard=()=>this._assertAuthority(authorityGeneration);
            const result = await this.reviewStore.persist(callCenter, this.ledger, persistOptions);
            if(authorityGeneration!=null)this._assertAuthority(authorityGeneration);
            if(result?.durable!==true){const error=new Error('Nexus Operator Review persistence did not confirm durable authority.');error.name='TV2OperatorReviewDurabilityUnavailable';throw error;}
            this.reviewError = null;
            return result;
        } catch (error) {
            this.reviewError = error;
            throw error;
        }
    }
    _durableReviewTransaction(id) {
        try { return this.reviewStore?.inspectTransaction?.(id) || null; }
        catch (error) { this.reviewError = error; return null; }
    }
    _durableCallTicket(id) {
        try { return this.reviewStore?.inspectCallTicket?.(id) || null; }
        catch (error) { this.reviewError = error; return null; }
    }
    _sameDurableCallTicket(durable, expected, states = null) {
        if (!durable || !expected || String(durable?.ticket?.id || '') !== String(expected?.ticket?.id || '')) return false;
        if (states && !states.includes(String(durable?.state || ''))) return false;
        return String(durable?.ticket?.capability || '') === String(expected?.ticket?.capability || '')
            && String(durable?.ticket?.correlationId || '') === String(expected?.ticket?.correlationId || '');
    }
    async _persistTransactionProjection(transaction,{authorityGeneration=null}={}) {
        try {
            if(authorityGeneration!=null)this._assertAuthority(authorityGeneration);
            const options=authorityGeneration==null?{}:{authorityGuard:()=>this._assertAuthority(authorityGeneration)};
            const result = this.reviewStore?.persistTransactionProjection
                ? await this.reviewStore.persistTransactionProjection(this.callCenter, this.ledger, transaction, options)
                : await this._persistReview({ transactionOverrides: [transaction], authorityGeneration });
            if(authorityGeneration!=null)this._assertAuthority(authorityGeneration);
            if(result?.durable!==true){const error=new Error('Nexus Operator Review transaction projection did not confirm durable authority.');error.name='TV2OperatorReviewDurabilityUnavailable';throw error;}
            this.reviewError = null;
            return result;
        } catch (error) {
            this.reviewError = error;
            error.reviewPersistenceBoundary = true;
            throw error;
        }
    }

    async _dispatchResolved(ticket) {
        const authority=this._captureAuthority();
        assertNexusCallTicket(ticket, NEXUS_CALL_DIRECTION.MAIN_TO_NEXUS);
        this._assertTicketScopeCurrent(ticket);
        const name = String(ticket?.metadata?.registryName || '').trim().toLowerCase();
        const descriptor = this.registry.resolve(name);
        if (!descriptor) throw new Error(`Nexus capability is no longer registered: ${name}`);
        this._assertAuthority(authority);
        this._assertBoundaryPolicy();this._assertTicketScope(ticket);this._assertDescriptorBinding(ticket,descriptor);
        const args = deepCopy(ticket.arguments || {});this._validateArguments(descriptor,args,`Nexus_Call.${descriptor.name}`);
        if (!descriptor.mutation) { const result=await descriptor.handler(args, deepCopy(ticket)); this._assertAuthority(authority); return result; }

        const snapshot = descriptor.snapshot ? await descriptor.snapshot(args, deepCopy(ticket)) : null;
        this._assertAuthority(authority);
        this._assertTicketScopeCurrent(ticket);
        const assumptions = this._protectedAssumptions(descriptor.assumptions ? await descriptor.assumptions(args, deepCopy(ticket)) : {});
        this._assertAuthority(authority);
        // Snapshot/assumption hooks are asynchronous extension boundaries. Fence
        // the final ledger admission against a chat/review-scope change.
        this._assertTicketScopeCurrent(ticket);
        const tx = this.ledger.begin({
            type: `external:${descriptor.capability}`,
            input: { capability: descriptor.capability, registryName: descriptor.name, arguments: args },
            snapshot,
            assumptions,
            metadata: {
                source: 'main-function-gateway',
                ticketId: ticket.id,
                correlationId: ticket.correlationId,
                reviewScope: this._reviewScope(),
                reviewScopeGeneration: this._reviewScope().generation,
                // Preserve the exact bounded Call Ticket used to stage the
                // transaction. Freshness and canonical operation builders receive the same
                // boundary context during later operator approval.
                callTicket: deepCopy(ticket),
                descriptorBinding: this._descriptorBinding(descriptor),
                policyAtStage: this._policySnapshot(),
            },
        });
        this.activeTransactions.add(tx.id);
        let staged;
        try { staged = await this.ledger.run(tx, {
            // Mutation services may compute a draft, but they cannot perform the
            // protected final mutation here. The required stage hook is the
            // boundary between computation and persistent-state approval.
            execute: async () => { this._assertAuthority(authority); const value=descriptor.execute ? await descriptor.execute(args, deepCopy(ticket)) : deepCopy(args); this._assertAuthority(authority); return value; },
            parse: async (value) => { this._assertAuthority(authority); const parsed=descriptor.parse ? await descriptor.parse(value, args, deepCopy(ticket)) : value; this._assertAuthority(authority); return parsed; },
            validate: async value => { this._assertAuthority(authority); const verdict=descriptor.validate ? await descriptor.validate(value, args, deepCopy(ticket)) : { passed: true }; this._assertAuthority(authority); return verdict; },
            stage: async value => { this._assertAuthority(authority); const result=await descriptor.stage(value, args, deepCopy(ticket)); this._assertAuthority(authority); return { capability: descriptor.capability, result: deepCopy(result), ticketId: ticket.id }; },
            mutationProposal: async (value, stageTx) => {
                this._assertAuthority(authority);
                if(typeof descriptor.operation!=='function')throw new Error(`Mutation capability "${descriptor.name}" has no canonical mutation-operation builder.`);
                const reviewedOperation=await descriptor.operation(deepCopy(value?.result),deepCopy(assumptions),args,deepCopy(ticket),deepCopy(stageTx));
                this._assertAuthority(authority);
                return createMutationProposal({
                    transactionId: tx.id,
                    type: descriptor.capability,
                    target: mutationTargetFromTicket(descriptor, args, ticket),
                    draft: { ...deepCopy(value), reviewedOperation:deepCopy(reviewedOperation), reviewedOperationFingerprint:fingerprintValue(reviewedOperation) },
                    assumptions,
                    approvalRequired: true,
                    metadata: { registryName: descriptor.name, ticketId: ticket.id, correlationId: ticket.correlationId, descriptorBinding:this._descriptorBinding(descriptor) },
                });
            },
        });
        this._assertAuthority(authority);
        if(staged.state===NEXUS_TRANSACTION_STATE.FAILED)throw new Error(staged.error||`Nexus mutation capability ${descriptor.name} failed validation before staging.`);
        try { await this._persistReview({authorityGeneration:authority}); this._assertAuthority(authority); } catch (error) {
            // localStorage writes are atomic but verification/merge may fail after
            // the STAGED row actually became durable. Read back before deciding
            // whether this request is hidden or safely reviewable.
            const durable = this._durableReviewTransaction(staged.id);
            if (durable?.state === NEXUS_TRANSACTION_STATE.STAGED) {
                // inspectTransaction() validates the complete durable envelope. If
                // the exact STAGED row is present, the original write succeeded
                // and only its acknowledgement/merge verification degraded. Do
                // not leave a sticky gateway error that would make this proven
                // durable transaction impossible for the operator to review.
                this.reviewError = null;
                return { transactionId: staged.id, state: staged.state, result: deepCopy(staged.staged?.result), mutationProposal: deepCopy(staged.mutationProposal), reviewPersistenceDegraded: true, reviewPersistenceError: String(error?.message || error) };
            }
            try { this.ledger.cancel(staged.id, `Operator review durability failed before STAGED authority was established: ${String(error?.message || error)}`); } catch {}
            try { await this._persistReview({authorityGeneration:authority}); } catch (settlementError) {
                const terminal = this._durableReviewTransaction(staged.id);
                if (!terminal || terminal.state === NEXUS_TRANSACTION_STATE.STAGED) {
                    this.reviewError = settlementError;
                    const indeterminate = new Error(`Operator Review staging settlement is indeterminate after a second durability failure: ${String(settlementError?.message || settlementError)}`);
                    indeterminate.name = 'TV2OperatorReviewSettlementIndeterminate';
                    indeterminate.reviewPersistenceBoundary = true;
                    throw indeterminate;
                }
            }
            throw error;
        }
        return { transactionId: staged.id, state: staged.state, result: deepCopy(staged.staged?.result), mutationProposal: deepCopy(staged.mutationProposal) };
        } finally { if (staged?.id || tx?.id) this.activeTransactions.delete(staged?.id || tx.id); }
    }

    async _invalidateBoundaryTicketDurably(ticketId, reason) {
        const id=String(ticketId||'').trim();
        if(typeof this.callCenter.invalidatePending!=='function'||typeof this.callCenter.exportAuthority!=='function'||typeof this.callCenter.constructor!=='function'){const error=new Error('Call Center durable scope invalidation projection is unavailable.');error.name='TV2OperatorReviewDurabilityUnavailable';throw error;}
        const Shadow=this.callCenter.constructor, shadow=new Shadow({policy:deepCopy(this.callCenter.policy||{}),logicGate:this.callCenter.logicGate||null});
        shadow.restoreAuthority(this.callCenter.exportAuthority(),{normalizeInterrupted:false});
        const projected=shadow.invalidatePending(id,reason);
        try{await this._persistReview({callCenterOverride:shadow});}
        catch(error){const durable=this._durableCallTicket(id);if(!this._sameDurableCallTicket(durable,projected,['scope-invalidated']))throw error;this.reviewError=null;const live=this.callCenter.invalidatePending(id,reason);return {...live,reviewPersistenceDegraded:true,reviewPersistenceError:String(error?.message||error)};}
        return this.callCenter.invalidatePending(id,reason);
    }

    async approveBoundaryTicket(ticketId, { logic = { targetHealth: 'healthy' } } = {}) {
        const authority=this._captureAuthority();
        const id = String(ticketId || '').trim();
        const latest = this.callCenter.findTicket?.(id) || null;
        if (!latest || latest?.ticket?.direction !== NEXUS_CALL_DIRECTION.MAIN_TO_NEXUS) return { state: 'blocked', error: `Unknown pending Main → Nexus Call Ticket: ${id || '(missing)'}`, ticket: null };
        if (['running', 'completed'].includes(latest.state)) {
            return { state: 'blocked', error: `Main → Nexus Call Ticket ${id} was already dispatched after policy approval.`, ticket: deepCopy(latest.ticket || null) };
        }
        if (latest.state === 'rejected') return { state: 'blocked', error: `Main → Nexus Call Ticket ${id} was rejected by the operator.`, ticket: deepCopy(latest.ticket || null) };
        const pending = ['awaiting-approval', 'approved-deferred'].includes(String(latest.state || '')) ? latest : null;
        if (!pending) return { state: 'blocked', error: `Main → Nexus Call Ticket ${id} is not awaiting policy approval.`, ticket: deepCopy(latest.ticket || null) };
        const name = String(pending.ticket?.metadata?.registryName || '').trim().toLowerCase();
        const descriptor = this.registry.resolve(name);
        if (!descriptor) return { state: 'blocked', error: `Nexus capability is no longer registered: ${name}`, ticket: deepCopy(pending.ticket) };
        this._assertAuthority(authority);
        try{this._assertBoundaryPolicy();this._assertTicketScope(pending.ticket);this._assertDescriptorBinding(pending.ticket,descriptor);this._validateArguments(descriptor,deepCopy(pending.ticket.arguments||{}),`Nexus_Call.${descriptor.name}`);}catch(error){
            if(['TV2OperatorReviewScopeMismatch','TV2OperatorReviewGenerationStale'].includes(String(error?.name||''))){try{const settled=await this._invalidateBoundaryTicketDurably(id,String(error?.message||error));return {state:'blocked',error:String(error?.message||error),ticket:deepCopy(pending.ticket),reviewState:settled?.state||'scope-invalidated',reviewPersistenceDegraded:settled?.reviewPersistenceDegraded===true};}catch(persistError){return {state:'blocked',error:`${String(error?.message||error)} Durable invalidation failed: ${String(persistError?.message||persistError)}`,ticket:deepCopy(pending.ticket),reviewState:String(this.callCenter.findTicket?.(id)?.state||'unknown'),reviewPersistenceDegraded:true};}}
            return {state:'blocked',error:String(error?.message||error),ticket:deepCopy(pending.ticket)};
        }
        this._assertAuthority(authority);
        const result = await this.callCenter.dispatch(deepCopy(pending.ticket), { approved: true, logic, descriptor });
        this._assertAuthority(authority);
        await this._persistReview({authorityGeneration:authority});
        return result;
    }

    async rejectBoundaryTicket(ticketId, reason = 'Rejected by operator.') {
        const authority=this._captureAuthority();
        const id = String(ticketId || '').trim();
        const latest = this.callCenter.findTicket?.(id) || null;
        if (!latest || latest?.ticket?.direction !== NEXUS_CALL_DIRECTION.MAIN_TO_NEXUS) return { state: 'blocked', error: `Unknown pending Main → Nexus Call Ticket: ${id || '(missing)'}`, ticket: null };
        if (!['awaiting-approval', 'approved-deferred'].includes(String(latest.state || ''))) return { state: 'blocked', error: `Main → Nexus Call Ticket ${id} is not awaiting policy approval; current state is ${latest.state}.`, ticket: deepCopy(latest.ticket || null) };
        // Rejection is a durable authority transition. Project it through an
        // isolated Call Center first; the live pending approval is not consumed
        // until the rejected projection is durable (or exact read-back proves a
        // write landed despite an acknowledgement failure).
        if (typeof this.callCenter.exportAuthority !== 'function' || typeof this.callCenter.constructor !== 'function') {
            const error=new Error('Call Center durable rejection projection is unavailable.'); error.name='TV2OperatorReviewDurabilityUnavailable'; throw error;
        }
        const Shadow=this.callCenter.constructor;
        const shadow=new Shadow({ policy: deepCopy(this.callCenter.policy || {}), logicGate: this.callCenter.logicGate || null });
        shadow.restoreAuthority(this.callCenter.exportAuthority(), { normalizeInterrupted: false });
        const projected=shadow.rejectPending(id, reason);
        try { await this._persistReview({ callCenterOverride: shadow,authorityGeneration:authority }); }
        catch (error) {
            const durable=this._durableCallTicket(id);
            if (!this._sameDurableCallTicket(durable, projected, ['rejected'])) throw error;
            this.reviewError=null;
            this._assertAuthority(authority);
            const result=this.callCenter.rejectPending(id, reason);
            return { ...result, reviewPersistenceDegraded:true, reviewPersistenceError:String(error?.message||error) };
        }
        this._assertAuthority(authority);
        return this.callCenter.rejectPending(id, reason);
    }

    _resolveExternalTransaction(transactionId) {
        const id = String(transactionId || '').trim();
        const tx = id ? this.ledger.read(id) : null;
        if (!tx) return { tx: null, descriptor: null, ticket: null, error: `Unknown Nexus transaction: ${id || '(missing)'}` };
        if (tx.metadata?.source !== 'main-function-gateway' || !String(tx.type || '').startsWith('external:')) {
            return { tx, descriptor: null, ticket: null, error: 'Transaction was not staged by the Main -> Nexus Function Gateway.' };
        }
        let reviewScope;
        try { reviewScope = this._reviewScope(); }
        catch (error) { return { tx, descriptor: null, ticket: null, error: String(error?.message || error) }; }
        const txScope = String(tx?.assumptions?.operatorReviewScope || tx?.metadata?.reviewScope?.identity || '');
        const txChat = tx?.assumptions?.chatId ?? tx?.metadata?.reviewScope?.chatId ?? null;
        if (!txScope || txScope !== String(reviewScope.identity || '') || String(txChat ?? '') !== String(reviewScope.chatId ?? '')) {
            return { tx, descriptor: null, ticket: null, error: 'Transaction belongs to a different or invalidated Operator Review scope.' };
        }
        const name = String(tx.input?.registryName || tx.mutationProposal?.metadata?.registryName || '').trim().toLowerCase();
        const descriptor = this.registry.resolve(name);
        if (!descriptor || descriptor.mutation !== true) {
            return { tx, descriptor: null, ticket: null, error: `Mutation capability is no longer registered: ${name || '(missing)'}` };
        }
        const ticket = deepCopy(tx.metadata?.callTicket || null);
        try {
            assertNexusCallTicket(ticket, NEXUS_CALL_DIRECTION.MAIN_TO_NEXUS);
            this._assertBoundaryPolicy();this._assertTicketScope(ticket);this._assertDescriptorBinding(ticket,descriptor);
            const capability=String(descriptor.capability||''), identities=[String(tx.type||''),String(tx.input?.capability||''),String(tx.mutationProposal?.type||''),String(ticket.capability||'')];
            if(identities[0]!==`external:${capability}`||identities.slice(1).some(value=>value!==capability))throw new Error('External transaction capability identities disagree; approval is blocked.');
            const storedBinding=tx.metadata?.descriptorBinding||tx.mutationProposal?.metadata?.descriptorBinding;
            const currentBinding=this._descriptorBinding(descriptor);
            if(!storedBinding||String(storedBinding.descriptorFingerprint||'')!==currentBinding.descriptorFingerprint||String(storedBinding.argumentSchemaFingerprint||'')!==currentBinding.argumentSchemaFingerprint)throw new Error('External transaction was staged by a different capability implementation/schema. Re-stage it.');
            this._validateArguments(descriptor,deepCopy(tx.input?.arguments||{}),`Nexus_Call.${descriptor.name}`);
        } catch (error) {
            return { tx, descriptor, ticket: null, error: `Stored external review authority is invalid: ${String(error?.message || error)}` };
        }
        return { tx, descriptor, ticket, error: null };
    }

    /**
     * Explicit operator path for a previously staged Main -> Nexus mutation.
     * This is deliberately separate from dispatch(): policy approval grants
     * permission to *stage* the request, while Ledger approval grants permission
     * to commit the reviewed staged mutation.
     */
    async approveAndCommit(transactionId, { by = 'operator', metadata = {} } = {}) {
        const authority=this._captureAuthority();
        const resolved = this._resolveExternalTransaction(transactionId);
        if (resolved.error) return externalTransactionError(resolved.tx, resolved.error);
        const { tx, descriptor, ticket } = resolved;
        if (tx.state !== NEXUS_TRANSACTION_STATE.STAGED) return externalTransactionError(tx, `Nexus transaction ${tx.id} must be staged before approval; current state is ${tx.state}.`);
        if (typeof descriptor.operation !== 'function') return externalTransactionError(tx, `Mutation capability "${descriptor.name}" has no canonical mutation-operation builder.`);

        const args = deepCopy(tx.input?.arguments || {});
        this.activeTransactions.add(tx.id);
        try {
            this._assertAuthority(authority);
            this._assertBoundaryPolicy();this._assertTicketScope(ticket);this._assertDescriptorBinding(ticket,descriptor);this._validateArguments(descriptor,args,`Nexus_Call.${descriptor.name}`);
            // Construct and bind the exact canonical operation BEFORE approval is
            // consumed. If mutable state would produce a different operation than
            // the one staged for review, the transaction must be restaged.
            const operationAssumptions = this._protectedAssumptions(descriptor.assumptions ? await descriptor.assumptions(args, deepCopy(ticket)) : {});
            this._assertAuthority(authority);
            const currentTx = this.ledger.read(tx.id);
            const stagedResult = deepCopy(currentTx?.staged?.result);
            const operation = await descriptor.operation(stagedResult, deepCopy(operationAssumptions), args, deepCopy(ticket), deepCopy(currentTx));
            this._assertAuthority(authority);
            const reviewedOperation=deepCopy(currentTx?.mutationProposal?.draft?.reviewedOperation);
            const reviewedFingerprint=String(currentTx?.mutationProposal?.draft?.reviewedOperationFingerprint||'');
            if(!reviewedOperation||!reviewedFingerprint||reviewedFingerprint!==fingerprintValue(reviewedOperation)||fingerprintValue(operation)!==reviewedFingerprint){
                const stale=this.ledger.stale(tx.id,'Canonical operation changed after operator review; re-stage from current state.',{fresh:false,required:true,changes:[{path:'reviewedOperation',reason:'operation-fingerprint-changed'}]});
                try{await this._persistReview({authorityGeneration:authority});}catch{}
                return {state:'stale',transactionId:tx.id,transactionState:stale.state,error:stale.error,freshness:deepCopy(stale.freshness)};
            }
            this._assertAuthority(authority);
            this.ledger.approve(tx.id, { by, metadata: { surface: 'function-gateway', reviewedOperationFingerprint:reviewedFingerprint, ...deepCopy(metadata || {}) } });
            this._assertAuthority(authority);
            const committed = await this.commitMutation(tx.id, operation, {
                preflight:()=>{this._assertAuthority(authority);this._assertBoundaryPolicy();this._assertTicketScope(ticket);this._assertDescriptorBinding(ticket,descriptor);this._validateArguments(descriptor,args,`Nexus_Call.${descriptor.name}`);},
                currentAssumptions: async () => {this._assertAuthority(authority);const value=this._protectedAssumptions(descriptor.assumptions ? await descriptor.assumptions(args, deepCopy(ticket)) : {});this._assertAuthority(authority);return value;},
                targetLedger: this.ledger,
                signal: this.abortController.signal,
                metadata: { surface: 'function-gateway', registryName: descriptor.name, capability: descriptor.capability },
                beforeTerminalState: async transition => {
                    this._assertAuthority(authority);
                    if (transition?.state !== 'stale') return;
                    const current = this.ledger.read(tx.id);
                    const projected = projectExternalTransaction(current, NEXUS_TRANSACTION_STATE.STALE, { reason: transition.reason, freshness: transition.freshness });
                    try { await this._persistTransactionProjection(projected,{authorityGeneration:authority}); }
                    catch (error) {
                        const durable = this._durableReviewTransaction(tx.id);
                        if (durable?.state !== NEXUS_TRANSACTION_STATE.STALE) throw error;
                    }
                },
                committed: result => ({ capability: descriptor.capability, registryName: descriptor.name, result }),
            });
            this._assertAuthority(authority);
            if (committed.state === NEXUS_TRANSACTION_STATE.STALE) {
                let reviewPersistenceError = '';
                try { await this._persistReview({authorityGeneration:authority}); } catch (error) { reviewPersistenceError = String(error?.message || error); }
                return {
                    state: 'stale',
                    transactionId: committed.id,
                    transactionState: committed.state,
                    freshness: deepCopy(committed.freshness),
                    error: committed.error,
                    reviewPersistenceDegraded: !!reviewPersistenceError,
                    reviewPersistenceError,
                };
            }
            let reviewPersistenceError = '';
            try { await this._persistReview({authorityGeneration:authority}); }
            catch (error) { reviewPersistenceError = String(error?.message || error); }
            return {
                state: 'committed',
                transactionId: committed.id,
                transactionState: committed.state,
                result: deepCopy(committed.committed),
                mutationProposal: deepCopy(committed.mutationProposal),
                reviewPersistenceDegraded: !!reviewPersistenceError,
                reviewPersistenceError,
            };
        } catch (error) {
            const current = this.ledger.read(tx.id);
            if (current?.state === NEXUS_TRANSACTION_STATE.COMMITTED) {
                if(!error?.gatewayAuthorityRevoked){try { await this._persistReview({authorityGeneration:authority}); } catch {}}
                return { state: 'committed', transactionId: tx.id, transactionState: current.state, result: deepCopy(current.committed), mutationProposal: deepCopy(current.mutationProposal), reviewPersistenceDegraded: true, reviewPersistenceError: String(error?.message || error),gatewayAuthorityRevoked:error?.gatewayAuthorityRevoked===true };
            }
            if(error?.gatewayAuthorityRevoked===true)return {state:'blocked',transactionId:tx.id,transactionState:current?.state||null,error:String(error?.message||error),gatewayAuthorityRevoked:true};
            if (error?.reviewPersistenceBoundary === true && current?.state === NEXUS_TRANSACTION_STATE.STAGED) {
                return { state: 'blocked', transactionId: tx.id, transactionState: current.state, error: String(error?.message || error), reviewPersistenceDegraded: true };
            }
            if (current && !isTerminalExternalState(current.state)) {
                try { await failNexusTransaction(tx.id, error, { phase: 'external-approved-commit' }, this.ledger); } catch {}
            }
            try { await this._persistReview({authorityGeneration:authority}); } catch {}
            return {
                state: 'failed',
                transactionId: tx.id,
                transactionState: this.ledger.read(tx.id)?.state || null,
                error: String(error?.message || error),
            };
        } finally {this.activeTransactions.delete(tx.id);}
    }

    async rejectTransaction(transactionId, reason = 'Rejected by operator.') {
        const authority=this._captureAuthority();
        const resolved = this._resolveExternalTransaction(transactionId);
        if (resolved.error) return externalTransactionError(resolved.tx, resolved.error);
        const { tx } = resolved;
        if (tx.state !== NEXUS_TRANSACTION_STATE.STAGED) return externalTransactionError(tx, `Nexus transaction ${tx.id} must be staged before rejection; current state is ${tx.state}.`);
        const projected = projectExternalTransaction(tx, NEXUS_TRANSACTION_STATE.ABORTED, { reason });
        this.activeTransactions.add(tx.id);
        try {
            try { await this._persistTransactionProjection(projected,{authorityGeneration:authority}); }
            catch (error) {
                const durable = this._durableReviewTransaction(tx.id);
                if (durable?.state !== NEXUS_TRANSACTION_STATE.ABORTED) return externalTransactionError(this.ledger.read(tx.id), error?.message || error);
            }
            this._assertAuthority(authority);
            const rejected = this.ledger.reject(tx.id, reason);
            let reviewPersistenceError = '';
            try { await this._persistReview({authorityGeneration:authority}); } catch (error) { reviewPersistenceError = String(error?.message || error); }
            return {
                state: 'rejected',
                transactionId: rejected.id,
                transactionState: rejected.state,
                error: rejected.error,
                mutationProposal: deepCopy(rejected.mutationProposal),
                reviewPersistenceDegraded: !!reviewPersistenceError,
                reviewPersistenceError,
            };
        } catch (error) {
            return externalTransactionError(this.ledger.read(tx.id), error?.message || error);
        } finally {this.activeTransactions.delete(tx.id);}
    }

    async dispatch(name, args = {}, { approved = false, logic = {}, source = 'st-main-function', metadata = {}, correlationId = null, parentTicketId = null, automatic = true } = {}) {
        const authority=this._captureAuthority();
        const descriptor = this.registry.resolve(name);
        if (!descriptor) return { state: 'blocked', error: `Nexus capability is not registered: ${String(name)}`, ticket: null };
        try{this._assertBoundaryPolicy();this._validateArguments(descriptor,deepCopy(args||{}),`Nexus_Call.${descriptor.name}`);}catch(error){return {state:'blocked',error:String(error?.message||error),ticket:null};}
        let ticket;
        try {
            ticket = createCallTicket({
                direction: NEXUS_CALL_DIRECTION.MAIN_TO_NEXUS,
                source,
                capability: descriptor.capability,
                preferredTarget: NEXUS_CALL_TARGET.NEXUS_SERVICE,
                automatic: automatic === true,
                arguments: args,
                correlationId,
                parentTicketId,
                metadata: { ...deepCopy(metadata), registryName: descriptor.name, nexusChatEpoch: currentNexusChatEpoch(), reviewScope: this._reviewScope(), reviewScopeGeneration: this._reviewScope().generation, descriptorFingerprint:this._descriptorBinding(descriptor).descriptorFingerprint, argumentSchemaFingerprint:this._descriptorBinding(descriptor).argumentSchemaFingerprint },
            });
        } catch (error) {
            return { state: 'blocked', error: String(error?.message || error), ticket: null };
        }
        const result = await this.callCenter.dispatch(ticket, { approved, logic, descriptor });
        this._assertAuthority(authority);
        try { await this._persistReview({authorityGeneration:authority}); this._assertAuthority(authority); }
        catch (error) {
            if (result?.state === 'awaiting-approval') {
                const durable=this._durableCallTicket(ticket.id);
                if (this._sameDurableCallTicket(durable,result,['awaiting-approval','approved-deferred'])) {
                    this.reviewError=null;
                    return { ...result, reviewPersistenceDegraded:true, reviewPersistenceError:String(error?.message||error) };
                }
                this.callCenter.discardUndurablePending?.(ticket.id, `Operator Review durability failed: ${String(error?.message || error)}`);
            }
            if(result?.state==='completed'&&!descriptor.mutation){this.reviewError=null;return {...result,reviewPersistenceDegraded:true,reviewPersistenceError:String(error?.message||error)};}
            throw error;
        }
        return result;
    }
}
