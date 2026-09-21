import { NEXUS_CALL_TARGET } from './contracts.js';
import { CallCenter, createCallTicket } from './call-center.js';
import { CallCenterLogicGate } from './logic-gate.js';

/** Safe functional test route. It never opens SillyTavern generation, calls a
 * provider, or reads a chat. It verifies the exact Call Center chain locally. */
export function createCallCenterTestHarness(settings = {}) {
    const logicGate = new CallCenterLogicGate(settings);
    const callCenter = new CallCenter({ policy: settings.policy || {}, logicGate });
    callCenter.registerAdapter(NEXUS_CALL_TARGET.DIRECT, {
        async dispatch(ticket) {
            return { adapter: 'nexus-loopback', accepted: true, ticketId: ticket.id, capability: ticket.capability, responseMode: ticket.responsePolicy?.mode || 'return-draft-only' };
        },
    });
    return {
        logicGate,
        callCenter,
        test({ capability = 'search', approved = false } = {}) {
            return callCenter.dispatch(createCallTicket({ source: 'call-center-test-ui', capability, preferredTarget: NEXUS_CALL_TARGET.DIRECT, automatic: false }), { approved, logic: { isTest: true, targetHealth: 'healthy' } });
        },
    };
}
