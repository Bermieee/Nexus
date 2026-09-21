import {
    NEXUS_CALL_DIRECTION,
    NEXUS_CALL_TARGET,
    createCallTicket,
} from './contracts.js';
import { currentNexusChatEpoch } from './work-scope.js';

function clean(value) { return String(value ?? '').trim(); }

/**
 * Create the first production Nexus → Main proof ticket.
 *
 * This is deliberately narrow: manual, draft-only, cold-open generation. It is
 * not a generic worker adapter and cannot accept a Nexus Job/Job Plan.
 */
export function createManualMainDraftTicket({
    prompt,
    systemPrompt = '',
    contextPolicy = { mode: 'minimal' },
    responseLength = 320,
    correlationId = null,
    metadata = {},
} = {}) {
    const text = clean(prompt);
    if (!text) throw new Error('Manual Main draft requires a prompt.');
    return createCallTicket({
        direction: NEXUS_CALL_DIRECTION.NEXUS_TO_MAIN,
        source: 'operator-main-draft',
        capability: 'cold-open',
        preferredTarget: NEXUS_CALL_TARGET.ST_MAIN,
        automatic: false,
        correlationId: correlationId || undefined,
        arguments: {
            prompt: text,
            ...(clean(systemPrompt) ? { systemPrompt: clean(systemPrompt) } : {}),
        },
        contextPolicy,
        responsePolicy: {
            mode: 'return-draft-only',
            responseLength: Math.max(64, Math.min(4096, Math.floor(Number(responseLength) || 320))),
            trimNames: false,
        },
        metadata: { ...metadata, surface: 'manual-main-draft', nexusChatEpoch: currentNexusChatEpoch(), chatBound: true },
    });
}

/**
 * Operator-only explicit outbound proof. The button/action that invokes this
 * method is the human approval for an `ask` cold-open policy. `deny` still
 * blocks, and Logic Gate/runtime health still run before the ST adapter.
 */
export async function dispatchManualMainDraft(runtime, spec = {}) {
    if (!runtime?.callCenter || !runtime?.generationGateway) throw new Error('Nexus runtime is not available.');
    const ticket = createManualMainDraftTicket(spec);
    return runtime.callCenter.dispatch(ticket, {
        approved: true,
        logic: { targetHealth: runtime.generationGateway.isConnected() ? 'healthy' : 'unhealthy' },
    });
}
