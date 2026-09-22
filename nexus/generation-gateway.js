import { NEXUS_CALL_DIRECTION, NEXUS_CALL_TARGET, assertNexusCallTicket, deepCopy } from './contracts.js';

/**
 * Nexus -> Main boundary adapter.
 *
 * The gateway receives a typed Call Ticket only after Call Center policy and
 * logic checks. It translates that ticket to an injected SillyTavern/Main
 * generation adapter. It has no Sidecar imports and cannot join the worker bus.
 */
export class GenerationGateway {
    constructor({ generate = null, onConnected = null, readMainActivity = null } = {}) {
        if (generate !== null && typeof generate !== 'function') throw new Error('Generation Gateway generate adapter must be a function.');
        if (readMainActivity !== null && typeof readMainActivity !== 'function') throw new Error('Generation Gateway Main activity reader must be a function.');
        this.generate = generate;
        this.readMainActivity = readMainActivity;
        this.onConnected = typeof onConnected === 'function' ? onConnected : null;
        this.activeTicketId = null;
        this.activeController = null;
        this.activePhysicalPromise = null;
    }

    isConnected() { return typeof this.generate === 'function'; }

    connect(generate, reason = 'generation-gateway-connected') {
        if (typeof generate !== 'function') throw new Error('Generation Gateway connect requires a generation function.');
        this.generate = generate;
        this.onConnected?.(true, String(reason || 'generation-gateway-connected'));
        return this.snapshot();
    }

    disconnect(reason = 'generation-gateway-disconnected') {
        this.abortActive(String(reason || 'generation-gateway-disconnected'), { cancelPhysical: true });
        this.generate = null;
        this.onConnected?.(false, String(reason || 'generation-gateway-disconnected'));
        return this.snapshot();
    }

    abortActive(reason = 'Generation Gateway execution aborted.', { cancelPhysical = true } = {}) {
        if (!this.activeController || this.activeController.signal.aborted) return false;
        const error = Object.assign(new Error(String(reason || 'Generation Gateway execution aborted.')), { name: 'TV2GenerationGatewayAborted', deferred: true });
        error.cancelPhysical = cancelPhysical === true;
        this.activeController.abort(error);
        return true;
    }

    snapshot() {
        const activity = this.readMainActivity?.() || {};
        return Object.freeze({ connected: this.isConnected(), busy: this.activeTicketId != null || activity.lifecycleActive === true || activity.gatewayActive === true, activeTicketId: this.activeTicketId, foregroundMainActive: activity.lifecycleActive === true, gatewayActivityActive: activity.gatewayActive === true, physicalActive: this.activePhysicalPromise != null });
    }

    adapter() {
        return { dispatch: (ticket, options = {}) => this.dispatch(ticket, options) };
    }


    /**
     * Internal Nexus model-worker lease. This deliberately does not create or
     * accept a Call Center ticket: worker prompts can be larger than the bounded
     * operator/tool-call contract, while still sharing the exact same physical
     * Main busy/abort/timeout authority as boundary calls.
     */
    async dispatchWorker({ prompt = '', systemPrompt = '', responseLength = 3072, jsonSchema = null, prefill = '', workerControls = null, metadata = {} } = {}, { signal = null, timeoutMs = null, workerId = null } = {}) {
        if (!this.isConnected()) throw new Error('Main/ST Generation Gateway is not connected.');
        const bridge = this.readMainActivity?.() || {};
        if (this.activeTicketId != null || bridge.lifecycleActive === true || bridge.gatewayActive === true) {
            const error = new Error(this.activeTicketId ? `Main execution is already leased by Nexus ticket ${this.activeTicketId}.` : 'Foreground SillyTavern Main generation is active; Nexus Main work is deferred.');
            error.name = 'TV2MainExecutionBusy'; error.deferred = true;
            error.busySource = bridge.lifecycleActive === true ? 'foreground-main' : 'generation-gateway';
            error.activeTicketId = this.activeTicketId;
            throw error;
        }
        const ticketId = String(workerId || `nexus-main-worker-${Date.now()}`);
        const controller = new AbortController();
        const externalAbort = () => {
            if (!controller.signal.aborted) controller.abort(signal?.reason || Object.assign(new Error('Nexus Main worker request cancelled.'), { name: 'AbortError' }));
        };
        if (signal?.aborted) externalAbort();
        else signal?.addEventListener?.('abort', externalAbort, { once: true });
        this.activeTicketId = ticketId;
        this.activeController = controller;
        const generate = this.generate;
        try { this.onConnected?.(true, 'generation-gateway-worker-dispatch'); }
        catch (error) {
            if (this.activeTicketId === ticketId) this.activeTicketId = null;
            if (this.activeController === controller) this.activeController = null;
            signal?.removeEventListener?.('abort', externalAbort);
            throw error;
        }
        const request = {
            arguments: { prompt: String(prompt ?? ''), ...(String(systemPrompt ?? '').trim() ? { systemPrompt: String(systemPrompt) } : {}) },
            contextPolicy: { mode: 'minimal' },
            responsePolicy: { mode: 'return-draft-only', responseLength: Math.max(64, Math.min(131072, Math.floor(Number(responseLength) || 3072))), trimNames: false, jsonSchema: jsonSchema && typeof jsonSchema === 'object' && !Array.isArray(jsonSchema) ? deepCopy(jsonSchema) : null, prefill: String(prefill || ''), workerControls: workerControls && typeof workerControls === 'object' ? deepCopy(workerControls) : null },
            metadata: { ...(metadata || {}), internalModelWorker: true },
            ticketId,
        };
        const syntheticTicket = { id: ticketId, direction: NEXUS_CALL_DIRECTION.NEXUS_TO_MAIN, capability: 'internal-model-worker', preferredTarget: NEXUS_CALL_TARGET.ST_MAIN, metadata: request.metadata };
        const physical = Promise.resolve().then(() => generate(request, syntheticTicket, { signal: controller.signal }));
        this.activePhysicalPromise = physical;
        const cleanup = () => {
            if (this.activeTicketId === ticketId) this.activeTicketId = null;
            if (this.activeController === controller) this.activeController = null;
            if (this.activePhysicalPromise === physical) this.activePhysicalPromise = null;
            signal?.removeEventListener?.('abort', externalAbort);
        };
        void physical.then(cleanup, cleanup);
        const cap = Number(timeoutMs);
        let timer = null;
        const terminal = new Promise((_, reject) => {
            const onAbort = () => reject(controller.signal.reason || Object.assign(new Error('Nexus Main worker request cancelled.'), { name: 'AbortError' }));
            if (controller.signal.aborted) return onAbort();
            controller.signal.addEventListener('abort', onAbort, { once: true });
            if (Number.isFinite(cap) && cap > 0) timer = setTimeout(() => {
                const error = Object.assign(new Error(`Nexus Main worker request exceeded ${Math.floor(cap)}ms.`), { name: 'TV2GenerationGatewayTimeout', deferred: true, timeoutMs: Math.floor(cap), cancelPhysical: true });
                if (!controller.signal.aborted) controller.abort(error);
            }, Math.max(1, Math.floor(cap)));
        });
        try { return await Promise.race([physical, terminal]); }
        finally { if (timer !== null) clearTimeout(timer); }
    }

    async dispatch(ticket, { signal = null, timeoutMs = null } = {}) {
        assertNexusCallTicket(ticket, NEXUS_CALL_DIRECTION.NEXUS_TO_MAIN);
        if (ticket?.direction !== NEXUS_CALL_DIRECTION.NEXUS_TO_MAIN) throw new Error('Generation Gateway accepts Nexus → Main tickets only.');
        if (![NEXUS_CALL_TARGET.ST_MAIN, NEXUS_CALL_TARGET.ST_RAW, NEXUS_CALL_TARGET.DIRECT].includes(ticket?.preferredTarget)) throw new Error(`Generation Gateway cannot target ${String(ticket?.preferredTarget)}.`);
        if (!this.isConnected()) throw new Error('Main/ST Generation Gateway is not connected.');
        const bridge = this.readMainActivity?.() || {};
        if (this.activeTicketId != null || bridge.lifecycleActive === true || bridge.gatewayActive === true) {
            const error = new Error(this.activeTicketId ? `Main execution is already leased by Nexus ticket ${this.activeTicketId}.` : 'Foreground SillyTavern Main generation is active; Nexus Main work is deferred.');
            error.name = 'TV2MainExecutionBusy'; error.deferred = true;
            error.busySource = bridge.lifecycleActive === true ? 'foreground-main' : 'generation-gateway';
            error.activeTicketId = this.activeTicketId;
            throw error;
        }
        const ticketId = String(ticket.id || 'nexus-main-ticket');
        const controller = new AbortController();
        const externalAbort = () => {
            if (!controller.signal.aborted) controller.abort(signal?.reason || Object.assign(new Error('Nexus Main request cancelled.'), { name: 'AbortError' }));
        };
        if (signal?.aborted) externalAbort();
        else signal?.addEventListener?.('abort', externalAbort, { once: true });
        this.activeTicketId = ticketId;
        this.activeController = controller;
        const generate = this.generate;
        try { this.onConnected?.(true, 'generation-gateway-dispatch'); }
        catch (error) {
            // Observer/telemetry hooks are outside physical Main authority. If
            // one throws during admission, retire the just-created lease before
            // propagating the observer failure or every later Main request is
            // falsely blocked behind work that never started.
            if (this.activeTicketId === ticketId) this.activeTicketId = null;
            if (this.activeController === controller) this.activeController = null;
            signal?.removeEventListener?.('abort', externalAbort);
            throw error;
        }
        const physical = Promise.resolve().then(() => generate({
            capability: ticket.capability,
            arguments: deepCopy(ticket.arguments || {}),
            contextPolicy: deepCopy(ticket.contextPolicy || {}),
            responsePolicy: deepCopy(ticket.responsePolicy || {}),
            metadata: deepCopy(ticket.metadata || {}),
            ticketId: ticket.id,
        }, deepCopy(ticket), { signal: controller.signal }));
        this.activePhysicalPromise = physical;
        const cleanup = () => {
            if (this.activeTicketId === ticketId) this.activeTicketId = null;
            if (this.activeController === controller) this.activeController = null;
            if (this.activePhysicalPromise === physical) this.activePhysicalPromise = null;
            signal?.removeEventListener?.('abort', externalAbort);
        };
        void physical.then(cleanup, cleanup);

        const cap = Number(timeoutMs);
        let timer = null;
        const terminal = new Promise((_, reject) => {
            const onAbort = () => reject(controller.signal.reason || Object.assign(new Error('Nexus Main request cancelled.'), { name: 'AbortError' }));
            if (controller.signal.aborted) return onAbort();
            controller.signal.addEventListener('abort', onAbort, { once: true });
            if (Number.isFinite(cap) && cap > 0) timer = setTimeout(() => {
                const error = Object.assign(new Error(`Nexus Main request exceeded ${Math.floor(cap)}ms.`), { name: 'TV2GenerationGatewayTimeout', deferred: true, timeoutMs: Math.floor(cap), cancelPhysical: true });
                if (!controller.signal.aborted) controller.abort(error);
            }, Math.max(1, Math.floor(cap)));
        });
        try { return await Promise.race([physical, terminal]); }
        finally { if (timer !== null) clearTimeout(timer); }
    }
}

export function createGenerationGatewayAdapter(options = {}) {
    return new GenerationGateway(options).adapter();
}
