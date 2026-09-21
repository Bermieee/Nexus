import { deepCopy } from './contracts.js';

const VALID_POLICY_RULES = new Set(['allow','ask','deny']);

export const DEFAULT_CAPABILITY_POLICY = Object.freeze({
    search: 'allow',
    'read-memory': 'allow',
    'cold-open': 'ask',
    'lorebook-builder': 'ask',
    remember: 'ask',
    update: 'ask',
    summarize: 'ask',
    organize: 'ask',
    merge: 'ask',
    split: 'ask',
    delete: 'deny',
});

export class CapabilityPolicyGate {
    constructor({ policy = {}, mutationCapabilities = [] } = {}) {
        this.configure({ policy, mutationCapabilities });
    }

    configure({ policy = {}, mutationCapabilities = [] } = {}) {
        this.policy = { ...DEFAULT_CAPABILITY_POLICY, ...deepCopy(policy) };
        this.mutationCapabilities = new Set((mutationCapabilities || []).map(String));
        return this.snapshot();
    }

    inspect(ticket, { descriptor = null } = {}) {
        const capability = String(ticket?.capability || '');
        const rawRule = String(this.policy?.[capability] || DEFAULT_CAPABILITY_POLICY[capability] || 'deny').toLowerCase();
        const rule = VALID_POLICY_RULES.has(rawRule) ? rawRule : 'deny';
        const mutation = descriptor?.mutation === true || this.mutationCapabilities.has(capability);
        if (rule === 'deny') return { allowed: false, requiresApproval: false, mutation, rule, reason: rawRule === 'deny' ? 'blocked by capability policy' : `invalid capability policy rule: ${rawRule}` };
        // `automatic` records caller lineage; it must never masquerade as manual,
        // but it also must not bypass an ASK boundary. ASK remains allowed only
        // through the normal explicit approval state machine. DENY was handled
        // above and still blocks both manual and automatic callers.
        return {
            allowed: true,
            // Capability-policy approval and canonical mutation approval are
            // deliberately separate gates. `allow` means the boundary call may
            // execute/stage without an additional Call Center prompt; mutation
            // transactions still stop at STAGED and require Ledger approval
            // before canonical persistence.
            requiresApproval: rule === 'ask',
            mutation,
            rule,
            reason: rule === 'ask' ? 'approval required by capability policy' : null,
        };
    }

    snapshot() { return { policy: deepCopy(this.policy), mutationCapabilities: [...this.mutationCapabilities] }; }
}
