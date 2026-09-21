/**
 * Nexus 0.6.2 typed runtime contracts.
 *
 * These constructors are deliberately dependency-free. They describe work and
 * boundary traffic without executing it. Adapters may translate legacy Nexus
 * state into these contracts, but the contracts never import SillyTavern,
 * Sidecar, lore, or UI modules.
 */

export const NEXUS_EVENT_TYPE = Object.freeze({
    LIFECYCLE: 'lifecycle',
    POST_TURN: 'post-turn',
    MESSAGE_SETTLED: 'message-settled',
    MANUAL: 'manual',
    EXTERNAL: 'external',
});

export const NEXUS_JOB_KIND = Object.freeze({
    INSPECT: 'inspect',
    TRANSFORM: 'transform',
    ADD: 'add',
    ROUTE: 'route',
});

/** Where a planned job belongs. This is not a physical worker selection. */
export const NEXUS_JOB_ROUTE = Object.freeze({
    SIDECAR: 'sidecar',
    MODEL_WORKER: 'model-worker',
    LOCAL: 'local',
    TREE_BATCH_FIRE: 'tree-batch-fire',
});

export const NEXUS_JOB_STATE = Object.freeze({
    PLANNED: 'planned',
    QUEUED: 'queued',
    RUNNING: 'running',
    SUCCEEDED: 'succeeded',
    FAILED: 'failed',
    SKIPPED: 'skipped',
    BLOCKED: 'blocked',
    CANCELLED: 'cancelled',
    STALE: 'stale',
});

export const NEXUS_RESULT_STATE = Object.freeze({
    SUCCEEDED: 'succeeded',
    FAILED: 'failed',
    SKIPPED: 'skipped',
    BLOCKED: 'blocked',
    CANCELLED: 'cancelled',
    STALE: 'stale',
});

export const NEXUS_MUTATION_PROPOSAL_STATE = Object.freeze({
    CREATED: 'created',
    STAGED: 'staged',
    APPROVED: 'approved',
    REJECTED: 'rejected',
    STALE: 'stale',
    ABORTED: 'aborted',
    FAILED: 'failed',
    CANCELLED: 'cancelled',
});

export const NEXUS_TRANSACTION_STATE = Object.freeze({
    CREATED: 'created',
    EXECUTING: 'executing',
    PARSED: 'parsed',
    VALIDATED: 'validated',
    STAGED: 'staged',
    COMMITTING: 'committing',
    COMMITTED: 'committed',
    STALE: 'stale',
    ABORTED: 'aborted',
    FAILED: 'failed',
    CANCELLED: 'cancelled',
});

export const NEXUS_CALL_DIRECTION = Object.freeze({
    NEXUS_TO_MAIN: 'nexus-to-main',
    MAIN_TO_NEXUS: 'main-to-nexus',
});

export const NEXUS_CALL_TARGET = Object.freeze({
    ST_MAIN: 'st-main',
    ST_RAW: 'st-raw',
    NEXUS_SERVICE: 'nexus-service',
    DIRECT: 'direct',
    // Kept only as migration-safe legacy enum members. Call Center rejects
    // these as boundary targets; internal Sidecar work uses the Batch Layer.
    SIDE_CAR_A: 'sidecar-a',
    SIDE_CAR_B: 'sidecar-b',
});

export const NEXUS_CALL_TICKET_CONTRACT = 'nexus-call-ticket/v1';

/**
 * Boundary payload ceilings are character-count guards, not model token caps.
 * They exist only to keep Call Center tickets bounded and serializable before
 * they cross the Main/ST boundary. Internal Sidecar jobs never use them.
 */
export const NEXUS_CALL_LIMITS = Object.freeze({
    capabilityChars: 128,
    idChars: 256,
    argumentsJsonChars: 48_000,
    contextPolicyJsonChars: 8_000,
    responsePolicyJsonChars: 8_000,
    metadataJsonChars: 16_000,
    totalJsonChars: 80_000,
});

const WORK_KINDS = new Set(Object.values(NEXUS_JOB_KIND));
const JOB_ROUTES = new Set(Object.values(NEXUS_JOB_ROUTE));
const JOB_STATES = new Set(Object.values(NEXUS_JOB_STATE));
const RESULT_STATES = new Set(Object.values(NEXUS_RESULT_STATE));
const TX_STATES = new Set(Object.values(NEXUS_TRANSACTION_STATE));
const MUTATION_STATES = new Set(Object.values(NEXUS_MUTATION_PROPOSAL_STATE));
const EVENT_TYPES = new Set(Object.values(NEXUS_EVENT_TYPE));
const CALL_DIRECTIONS = new Set(Object.values(NEXUS_CALL_DIRECTION));
const OUTBOUND_TARGETS = new Set([NEXUS_CALL_TARGET.ST_MAIN, NEXUS_CALL_TARGET.ST_RAW, NEXUS_CALL_TARGET.DIRECT]);
const INBOUND_TARGETS = new Set([NEXUS_CALL_TARGET.NEXUS_SERVICE, NEXUS_CALL_TARGET.DIRECT]);
let sequence = 0;

export function nexusId(prefix = 'nexus') {
    sequence += 1;
    const random = globalThis.crypto?.randomUUID?.()
        || globalThis.crypto?.getRandomValues?.(new Uint32Array(2))?.join?.('')
        || Math.random().toString(36).slice(2, 14);
    return `${prefix}_${Date.now()}_${sequence}_${String(random).replace(/[^a-zA-Z0-9_-]/g, '')}`;
}

export function deepCopy(value) {
    if (value === undefined) return undefined;
    if (typeof structuredClone === 'function') return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
}

export function assertNexusEventType(type) {
    if (!EVENT_TYPES.has(type)) throw new Error(`Unknown Nexus event type: ${String(type)}`);
    return type;
}

export function assertNexusJobKind(kind) {
    if (!WORK_KINDS.has(kind)) throw new Error(`Unknown Nexus job kind: ${String(kind)}`);
    return kind;
}

export function assertNexusJobRoute(route) {
    if (!JOB_ROUTES.has(route)) throw new Error(`Unknown Nexus job route: ${String(route)}`);
    return route;
}

export function assertNexusJobState(state) {
    if (!JOB_STATES.has(state)) throw new Error(`Unknown Nexus job state: ${String(state)}`);
    return state;
}

export function assertNexusResultState(state) {
    if (!RESULT_STATES.has(state)) throw new Error(`Unknown Nexus result state: ${String(state)}`);
    return state;
}

export function assertNexusTransactionState(state) {
    if (!TX_STATES.has(state)) throw new Error(`Unknown Nexus transaction state: ${String(state)}`);
    return state;
}

export function assertNexusMutationProposalState(state) {
    if (!MUTATION_STATES.has(state)) throw new Error(`Unknown Nexus mutation proposal state: ${String(state)}`);
    return state;
}

export function createNexusEvent(spec = {}) {
    const type = assertNexusEventType(spec.type || NEXUS_EVENT_TYPE.LIFECYCLE);
    return {
        id: spec.id || nexusId('nexus_event'),
        type,
        source: String(spec.source || 'runtime'),
        createdAt: Number.isFinite(Number(spec.createdAt)) ? Number(spec.createdAt) : Date.now(),
        revision: spec.revision == null ? null : String(spec.revision),
        previous: deepCopy(spec.previous || {}),
        current: deepCopy(spec.current || {}),
        payload: deepCopy(spec.payload || {}),
        metadata: deepCopy(spec.metadata || {}),
    };
}

export function createNexusJob(spec = {}) {
    const kind = assertNexusJobKind(spec.kind || NEXUS_JOB_KIND.INSPECT);
    const route = assertNexusJobRoute(spec.route || NEXUS_JOB_ROUTE.SIDECAR);
    return {
        id: spec.id || nexusId('nexus_job'),
        name: String(spec.name || spec.type || 'unnamed-work'),
        type: String(spec.type || 'generic'),
        kind,
        route,
        priority: Number.isFinite(Number(spec.priority)) ? Number(spec.priority) : 50,
        dependencies: [...new Set((spec.dependencies || []).filter(Boolean).map(String))],
        transactionRequired: spec.transactionRequired === true,
        state: NEXUS_JOB_STATE.PLANNED,
        metadata: deepCopy(spec.metadata || {}),
        // Planning data may carry a legacy lane hint for migration diagnostics,
        // but never an executable callback. Physical A/B selection belongs to
        // Sidecar Bus, not the Job contract.
        lane: ['A', 'B', null].includes(spec.lane) ? spec.lane : null,
    };
}

export function createNexusJobPlan(spec = {}) {
    const jobs = (spec.jobs || []).map(createNexusJob);
    const typeToId = new Map(jobs.map(job => [job.type, job.id]));
    for (const job of jobs) job.dependencies = job.dependencies.map(dep => typeToId.get(dep) || dep);
    return {
        id: spec.id || nexusId('nexus_plan'),
        eventId: spec.eventId || null,
        source: String(spec.source || 'unknown'),
        createdAt: Number.isFinite(Number(spec.createdAt)) ? Number(spec.createdAt) : Date.now(),
        classification: deepCopy(spec.classification || {}),
        decisions: deepCopy(spec.decisions || []),
        jobs,
        metadata: deepCopy(spec.metadata || {}),
    };
}

/** Backward-compatible alias used by the 0.6 framework checkpoint. */
export const createNexusPlan = createNexusJobPlan;

export function createNexusResult(spec = {}) {
    const state = assertNexusResultState(spec.state || NEXUS_RESULT_STATE.SUCCEEDED);
    return {
        id: spec.id || nexusId('nexus_result'),
        jobId: spec.jobId == null ? null : String(spec.jobId),
        planId: spec.planId == null ? null : String(spec.planId),
        state,
        value: deepCopy(spec.value),
        error: spec.error ? String(spec.error?.message || spec.error) : null,
        startedAt: spec.startedAt == null ? null : Number(spec.startedAt),
        completedAt: spec.completedAt == null ? Date.now() : Number(spec.completedAt),
        metadata: deepCopy(spec.metadata || {}),
    };
}

export function createMutationProposal(spec = {}) {
    const state = assertNexusMutationProposalState(spec.state || NEXUS_MUTATION_PROPOSAL_STATE.CREATED);
    return {
        id: spec.id || nexusId('nexus_mutation'),
        transactionId: spec.transactionId == null ? null : String(spec.transactionId),
        type: String(spec.type || 'mutation'),
        state,
        target: deepCopy(spec.target || {}),
        draft: deepCopy(spec.draft),
        assumptions: deepCopy(spec.assumptions || {}),
        approvalRequired: spec.approvalRequired !== false,
        createdAt: Number.isFinite(Number(spec.createdAt)) ? Number(spec.createdAt) : Date.now(),
        metadata: deepCopy(spec.metadata || {}),
    };
}

export function createNexusTransaction(spec = {}) {
    if (!String(spec.type || '').trim()) throw new Error('A Nexus transaction requires a type.');
    const state = assertNexusTransactionState(spec.state || NEXUS_TRANSACTION_STATE.CREATED);
    return {
        id: spec.id || nexusId('nexus_tx'),
        type: String(spec.type),
        state,
        createdAt: Number.isFinite(Number(spec.createdAt)) ? Number(spec.createdAt) : Date.now(),
        updatedAt: Number.isFinite(Number(spec.updatedAt)) ? Number(spec.updatedAt) : Date.now(),
        input: deepCopy(spec.input || {}),
        snapshot: deepCopy(spec.snapshot ?? null),
        assumptions: deepCopy(spec.assumptions || {}),
        mutationProposal: spec.mutationProposal ? createMutationProposal(spec.mutationProposal) : null,
        metadata: deepCopy(spec.metadata || {}),
    };
}

function jsonChars(value) {
    try { return JSON.stringify(value ?? null).length; }
    catch (error) { throw new Error(`Nexus Call Ticket payload must be JSON-serializable: ${String(error?.message || error)}`); }
}

function assertBoundedSection(name, value, limit) {
    const size = jsonChars(value);
    if (size > limit) throw new Error(`Nexus Call Ticket ${name} payload is ${size} chars; limit is ${limit}.`);
    return size;
}

export function validateNexusCallTicket(ticket, { expectedDirection = null } = {}) {
    const errors = [];
    if (!ticket || typeof ticket !== 'object' || Array.isArray(ticket)) errors.push('ticket must be an object');
    if (ticket?.contract !== NEXUS_CALL_TICKET_CONTRACT) errors.push(`contract must be ${NEXUS_CALL_TICKET_CONTRACT}`);
    if (Number(ticket?.schemaVersion) !== 1) errors.push(`unsupported schemaVersion ${String(ticket?.schemaVersion)}`);
    if (!CALL_DIRECTIONS.has(ticket?.direction)) errors.push(`unknown direction ${String(ticket?.direction)}`);
    if (expectedDirection && ticket?.direction !== expectedDirection) errors.push(`expected direction ${expectedDirection}, received ${String(ticket?.direction)}`);
    const capability = String(ticket?.capability || '').trim();
    if (!capability) errors.push('capability is required');
    if (capability.length > NEXUS_CALL_LIMITS.capabilityChars) errors.push(`capability exceeds ${NEXUS_CALL_LIMITS.capabilityChars} chars`);
    for (const [name, value] of [['id', ticket?.id], ['correlationId', ticket?.correlationId], ['parentTicketId', ticket?.parentTicketId]]) {
        if (value != null && String(value).length > NEXUS_CALL_LIMITS.idChars) errors.push(`${name} exceeds ${NEXUS_CALL_LIMITS.idChars} chars`);
    }
    if (!String(ticket?.id || '').trim()) errors.push('id is required');
    if (!String(ticket?.correlationId || '').trim()) errors.push('correlationId is required');
    const allowedTargets = ticket?.direction === NEXUS_CALL_DIRECTION.MAIN_TO_NEXUS ? INBOUND_TARGETS : OUTBOUND_TARGETS;
    if (!allowedTargets.has(ticket?.preferredTarget)) errors.push(`target ${String(ticket?.preferredTarget)} is invalid for ${String(ticket?.direction)}`);
    if (ticket?.arguments === null || typeof ticket?.arguments !== 'object' || Array.isArray(ticket?.arguments)) errors.push('arguments must be an object');
    if (ticket?.contextPolicy === null || typeof ticket?.contextPolicy !== 'object' || Array.isArray(ticket?.contextPolicy)) errors.push('contextPolicy must be an object');
    if (ticket?.responsePolicy === null || typeof ticket?.responsePolicy !== 'object' || Array.isArray(ticket?.responsePolicy)) errors.push('responsePolicy must be an object');
    if (ticket?.metadata === null || typeof ticket?.metadata !== 'object' || Array.isArray(ticket?.metadata)) errors.push('metadata must be an object');
    if (errors.length) return { valid: false, errors, sizes: null };
    try {
        const sizes = {
            arguments: assertBoundedSection('arguments', ticket.arguments, NEXUS_CALL_LIMITS.argumentsJsonChars),
            contextPolicy: assertBoundedSection('contextPolicy', ticket.contextPolicy, NEXUS_CALL_LIMITS.contextPolicyJsonChars),
            responsePolicy: assertBoundedSection('responsePolicy', ticket.responsePolicy, NEXUS_CALL_LIMITS.responsePolicyJsonChars),
            metadata: assertBoundedSection('metadata', ticket.metadata, NEXUS_CALL_LIMITS.metadataJsonChars),
        };
        sizes.total = jsonChars(ticket);
        if (sizes.total > NEXUS_CALL_LIMITS.totalJsonChars) return { valid: false, errors: [`ticket exceeds ${NEXUS_CALL_LIMITS.totalJsonChars} total JSON chars`], sizes };
        return { valid: true, errors: [], sizes };
    } catch (error) {
        return { valid: false, errors: [String(error?.message || error)], sizes: null };
    }
}

export function assertNexusCallTicket(ticket, expectedDirection = null) {
    const validation = validateNexusCallTicket(ticket, { expectedDirection });
    if (!validation.valid) throw new Error(`Invalid Nexus Call Ticket: ${validation.errors.join('; ')}`);
    return ticket;
}

export function createCallTicket(spec = {}) {
    const capability = String(spec.capability || '').trim();
    if (!capability) throw new Error('A Nexus Call Center ticket requires a capability.');
    if (spec.direction != null && !CALL_DIRECTIONS.has(spec.direction)) throw new Error(`Invalid Nexus Call Ticket direction: ${String(spec.direction)}`);
    const direction = spec.direction ?? (spec.source === 'st-main-function' ? NEXUS_CALL_DIRECTION.MAIN_TO_NEXUS : NEXUS_CALL_DIRECTION.NEXUS_TO_MAIN);
    const allowedTargets = direction === NEXUS_CALL_DIRECTION.MAIN_TO_NEXUS ? INBOUND_TARGETS : OUTBOUND_TARGETS;
    const defaultTarget = direction === NEXUS_CALL_DIRECTION.MAIN_TO_NEXUS ? NEXUS_CALL_TARGET.NEXUS_SERVICE : NEXUS_CALL_TARGET.ST_MAIN;
    if (spec.preferredTarget != null && !allowedTargets.has(spec.preferredTarget)) throw new Error(`Invalid Nexus Call Ticket target ${String(spec.preferredTarget)} for ${String(direction)}`);
    const preferredTarget = spec.preferredTarget ?? defaultTarget;
    const id = String(spec.id || nexusId('nexus_call'));
    const ticket = {
        contract: NEXUS_CALL_TICKET_CONTRACT,
        schemaVersion: 1,
        id,
        correlationId: String(spec.correlationId || nexusId('nexus_corr')),
        parentTicketId: spec.parentTicketId == null ? null : String(spec.parentTicketId),
        createdAt: Number.isFinite(Number(spec.createdAt)) ? Number(spec.createdAt) : Date.now(),
        direction,
        source: String(spec.source || 'user'),
        capability,
        preferredTarget,
        contextPolicy: deepCopy(spec.contextPolicy || { mode: 'minimal' }),
        responsePolicy: deepCopy(spec.responsePolicy || { mode: 'return-draft-only' }),
        automatic: spec.automatic === true,
        arguments: deepCopy(spec.arguments || {}),
        metadata: deepCopy(spec.metadata || {}),
    };
    assertNexusCallTicket(ticket, direction);
    return ticket;
}

export function isCallCenterBoundaryTarget(target) {
    return OUTBOUND_TARGETS.has(target) || INBOUND_TARGETS.has(target);
}
