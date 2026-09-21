import { getSettings, assertAuthoritySettingsReady } from '../core/settings.js';
import { CallCenter, isMutationCapability } from './call-center.js';
import { CallCenterLogicGate } from './logic-gate.js';
import { CapabilityRegistry } from './capability-registry.js';
import { FunctionGateway } from './function-gateway.js';
import { getNexusLedger, reconcileRestoredNexusTransactionsFromCommitJournal } from './transaction-service.js';
import { createOperatorReviewStore } from './operator-review-store.js';

export const NEXUS_TOOL_GATEWAY_NAME = 'Nexus_Call';
const CAPABILITY_BY_FUNCTION = Object.freeze({
    search: 'search', remember: 'remember', update: 'update', delete: 'delete',
    merge: 'merge', split: 'split', organize: 'organize', summarize: 'summarize',
    'build-tree': 'lorebook-builder',
});
let activeOperatorGateway = null;
let retainedGatewayContinuity = null;

export function getActiveNexusToolGateway() { return activeOperatorGateway; }
export function clearActiveNexusToolGateway({ preserveContinuity = false } = {}) {
    if (preserveContinuity) {
        try { retainedGatewayContinuity = activeOperatorGateway?._exportContinuity?.() || retainedGatewayContinuity; } catch {}
    } else {
        retainedGatewayContinuity = null;
    }
    try { activeOperatorGateway?._close?.(); } catch {}
    activeOperatorGateway = null;
}

/** Restore durable external review rows before startup canonical recovery runs. */
export function restoreOperatorReviewTransactionsForStartup() {
    const ledger = getNexusLedger();
    const reviewStore = createOperatorReviewStore();
    try {
        const restored = reviewStore.load();
        const ids = restored.transactions?.length ? ledger.restore(restored.transactions, { replace: true }) : [];
        const reconciled = reconcileRestoredNexusTransactionsFromCommitJournal(null, ledger);
        return { ids, reconciled, durable: restored.durable === true, revision: restored.revision || 0 };
    } finally { try { reviewStore.close?.(); } catch {} }
}

function safeCopy(value) {
    if (value === undefined) return undefined;
    try { return typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value)); }
    catch { return null; }
}

const TOOL_DOMAIN_BY_FUNCTION = Object.freeze({
    search: 'lorebook', remember: 'memoryBank', summarize: 'summarizer',
    update: 'lorebook', delete: 'lorebook', merge: 'lorebook', split: 'lorebook', organize: 'lorebook',
    'build-tree': 'lorebook',
});


function mutationTargetForArgs(functionName, args = {}) {
    const target = { capability: String(CAPABILITY_BY_FUNCTION[String(functionName || '').trim().toLowerCase()] || functionName || 'mutation') };
    for (const key of ['book','bookName','uid','entryUid','nodeId','targetNodeId','newParentNodeId','proposalId','memoryId','summaryId','chatId','key','id','sourceUid','targetUid','mode']) {
        const value = args?.[key];
        if (value === undefined || value === null || value === '') continue;
        if (['string','number','boolean'].includes(typeof value)) target[key] = value;
    }
    return target;
}

function buildRegistry(services = {}) {
    const registry = new CapabilityRegistry();
    for (const [name, capability] of Object.entries(CAPABILITY_BY_FUNCTION)) {
        const service = services[name];
        if (!service?.action) continue;
        const mutation = isMutationCapability(capability);
        if (!mutation) {
            registry.register(name, {
                capability,
                mutation: false,
                handler: args => service.action(args),
                metadata: { toolDomain: TOOL_DOMAIN_BY_FUNCTION[name] || 'reasoning', argumentSchema: safeCopy(service.parameters || null) },
            });
            continue;
        }
        // Existing legacy mutation tools are intentionally NOT wrapped as a
        // generic handler. A Main-visible mutation is registered only after it
        // supplies a Ledger-safe staging adapter with explicit assumptions.
        const adapter = service.nexusMutation;
        if (!adapter || typeof adapter.stage !== 'function' || typeof adapter.assumptions !== 'function') continue;
        registry.register(name, {
            capability,
            mutation: true,
            execute: typeof adapter.execute === 'function' ? adapter.execute : null,
            parse: typeof adapter.parse === 'function' ? adapter.parse : null,
            stage: adapter.stage,
            operation: typeof adapter.operation === 'function' ? adapter.operation : null,
            snapshot: typeof adapter.snapshot === 'function' ? adapter.snapshot : null,
            assumptions: adapter.assumptions,
            validate: typeof adapter.validate === 'function' ? adapter.validate : null,
            metadata: { toolDomain: TOOL_DOMAIN_BY_FUNCTION[name] || 'reasoning', ledgerSafe: true, argumentSchema: safeCopy(service.parameters || null) },
        });
    }
    return registry;
}


function schemaTypeError(label, message) {
    const error = new TypeError(`${label} ${message}`);
    error.name = 'TV2NexusArgumentValidationError';
    return error;
}

function assertValueMatchesSchema(value, schema, label = 'value') {
    if (!schema || typeof schema !== 'object') return value;
    if (Array.isArray(schema.oneOf)) {
        let matches = 0;
        for (const candidate of schema.oneOf) {
            try { assertValueMatchesSchema(value, candidate, label); matches += 1; } catch {}
        }
        if (matches !== 1) throw schemaTypeError(label, `must match exactly one allowed schema (matched ${matches}).`);
        return value;
    }
    if (Object.prototype.hasOwnProperty.call(schema, 'const') && value !== schema.const) {
        throw schemaTypeError(label, `must equal ${JSON.stringify(schema.const)}.`);
    }
    if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
        throw schemaTypeError(label, `must be one of: ${schema.enum.join(', ')}.`);
    }

    switch (schema.type) {
        case 'object': {
            if (!value || typeof value !== 'object' || Array.isArray(value)) throw schemaTypeError(label, 'must be an object.');
            const properties = schema.properties || {};
            for (const key of schema.required || []) {
                if (value[key] === undefined) throw schemaTypeError(`${label}.${key}`, 'is required.');
            }
            for (const [key, item] of Object.entries(value)) {
                const rule = properties[key];
                if (rule) {
                    assertValueMatchesSchema(item, rule, `${label}.${key}`);
                    continue;
                }
                // Nexus_Call is a closed boundary: properties absent from the
                // capability contract are unsupported unless the schema opts
                // into them explicitly.
                if (schema.additionalProperties === true) continue;
                if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
                    assertValueMatchesSchema(item, schema.additionalProperties, `${label}.${key}`);
                    continue;
                }
                throw schemaTypeError(`${label}.${key}`, 'is not supported by this capability contract.');
            }
            return value;
        }
        case 'array': {
            if (!Array.isArray(value)) throw schemaTypeError(label, 'must be an array.');
            if (Number.isInteger(schema.minItems) && value.length < schema.minItems) throw schemaTypeError(label, `must contain at least ${schema.minItems} item(s).`);
            if (Number.isInteger(schema.maxItems) && value.length > schema.maxItems) throw schemaTypeError(label, `must contain at most ${schema.maxItems} item(s).`);
            if (schema.uniqueItems === true && new Set(value.map(item => JSON.stringify(item))).size !== value.length) throw schemaTypeError(label, 'must not contain duplicate items.');
            if (schema.items) value.forEach((item, index) => assertValueMatchesSchema(item, schema.items, `${label}[${index}]`));
            return value;
        }
        case 'string':
            if (typeof value !== 'string') throw schemaTypeError(label, 'must be a string.');
            if (Number.isInteger(schema.minLength) && value.length < schema.minLength) throw schemaTypeError(label, `must be at least ${schema.minLength} character(s).`);
            if (Number.isInteger(schema.maxLength) && value.length > schema.maxLength) throw schemaTypeError(label, `must be at most ${schema.maxLength} character(s).`);
            if (schema.pattern) { let re; try { re = new RegExp(schema.pattern); } catch { re = null; } if (re && !re.test(value)) throw schemaTypeError(label, 'does not match the required pattern.'); }
            return value;
        case 'boolean':
            if (typeof value !== 'boolean') throw schemaTypeError(label, 'must be a boolean.');
            return value;
        case 'number':
            if (typeof value !== 'number' || !Number.isFinite(value)) throw schemaTypeError(label, 'must be a finite number.');
            break;
        case 'integer':
            if (!Number.isInteger(value)) throw schemaTypeError(label, 'must be an integer.');
            break;
        case 'null':
            if (value !== null) throw schemaTypeError(label, 'must be null.');
            return value;
        default:
            break;
    }
    if (typeof value === 'number') {
        if (Number.isFinite(schema.minimum) && value < schema.minimum) throw schemaTypeError(label, `is below minimum ${schema.minimum}.`);
        if (Number.isFinite(schema.maximum) && value > schema.maximum) throw schemaTypeError(label, `exceeds maximum ${schema.maximum}.`);
    }
    return value;
}

function assertArgumentsMatchSchema(args, schema, label = 'arguments') {
    const value = args == null ? {} : args;
    return assertValueMatchesSchema(value, schema, label);
}

function exposedFunctions(services = {}) {
    const registry = buildRegistry(services);
    return registry.list().map(row => row.name);
}

/**
 * Compact Main -> Nexus Function Gateway. Main sees one stable schema. Registry
 * resolves the requested capability, Call Center applies Policy/Logic Gates,
 * and mutation capabilities enter the Transaction Ledger before any final
 * persistent-state commit can occur.
 */
export function createToolGateway(services = {}) {
    let controller = null;
    let lastSignature = '';
    let revoked = false;
    const assertGatewayLive = () => {
        if (!revoked) return;
        const error = new Error('This Nexus Tool Gateway authority was revoked by reconfiguration or shutdown.');
        error.name = 'TV2ToolGatewayAuthorityRevoked';
        throw error;
    };
    const getController = () => {
        assertGatewayLive();
        const settings = getSettings().nexus?.callCenter || {};
        const signature = JSON.stringify(settings);
        if (controller) {
            if (signature !== lastSignature) {
                controller.callCenter.configure({ policy: settings.policy || {}, logic: settings });
                lastSignature = signature;
            }
            return controller;
        }
        const logicGate = new CallCenterLogicGate(settings);
        const callCenter = new CallCenter({ policy: settings.policy || {}, logicGate });
        const ledger = getNexusLedger();
        const reviewStore = createOperatorReviewStore();
        const restored = reviewStore.load();
        if (restored.callAuthority || restored.terminalArchive?.length) callCenter.restoreAuthority({ ...(restored.callAuthority || {history:[],pendingApprovals:[]}), terminalArchive: restored.terminalArchive || [] });
        const restoredIds = restored.transactions?.length ? ledger.restore?.(restored.transactions, { replace: true }) : [];
        reconcileRestoredNexusTransactionsFromCommitJournal(null, ledger);
        const continuity = retainedGatewayContinuity;
        retainedGatewayContinuity = null;
        if (continuity) {
            try { if (continuity.authority) callCenter.restoreAuthority(continuity.authority); else callCenter.restoreHistory(continuity.history || []); } catch {}
            try { logicGate.restoreState(continuity.logicGate || {}); } catch {}
            callCenter.configure({ policy: settings.policy || {}, logic: settings });
        }
        const registry = buildRegistry(services);
        const reviewScope = reviewStore.scopeProjection();
        const transactionInCurrentReviewScope = tx => String(tx?.assumptions?.operatorReviewScope || tx?.metadata?.reviewScope?.identity || '') === String(reviewScope.identity || '')
            && String(tx?.assumptions?.chatId ?? tx?.metadata?.reviewScope?.chatId ?? '') === String(reviewScope.chatId ?? '');
        const reconcileReviewSnapshot = snapshot => {
            if (!snapshot) return;
            if (snapshot.callAuthority || snapshot.terminalArchive?.length) callCenter.restoreAuthority({ ...(snapshot.callAuthority || {history:[],pendingApprovals:[]}), terminalArchive: snapshot.terminalArchive || [] });
            else callCenter.restoreAuthority({ history: [], pendingApprovals: [], terminalArchive: [] });
            const durableIds = new Set((snapshot.transactions || []).filter(transactionInCurrentReviewScope).map(row => String(row?.id || '')).filter(Boolean));
            if (snapshot.durable) {
                for (const tx of ledger.list?.({ state: 'staged' }) || []) {
                    if (tx?.metadata?.source !== 'main-function-gateway' || !String(tx?.type || '').startsWith('external:') || !transactionInCurrentReviewScope(tx)) continue;
                    if (!durableIds.has(String(tx.id))) {
                        try { ledger.cancel(tx.id, 'Durable Operator Review authority was removed or resolved in another tab.'); } catch {}
                    }
                }
            }
            if (snapshot.transactions?.length) {
                const replaced = [];
                for (const row of snapshot.transactions) {
                    const local = ledger.read?.(row.id);
                    const durableTerminal = ['committed','stale','aborted','failed','cancelled'].includes(String(row?.state || ''));
                    const unresolvedLocal = ['staged','committing'].includes(String(local?.state || ''));
                    if (!local || durableTerminal || unresolvedLocal) replaced.push(...(ledger.restore?.([row], { replace: !!local }) || []));
                }
                reconcileRestoredNexusTransactionsFromCommitJournal(replaced, ledger);
            }
        };
        controller = { logicGate, callCenter, registry, reviewStore, reviewError: null, gateway: new FunctionGateway({ registry, callCenter, ledger, reviewStore, argumentValidator:assertArgumentsMatchSchema, policyResolver:()=>{assertAuthoritySettingsReady('Nexus Main-model Function Gateway authority');const live=getSettings().nexus?.callCenter||{};return {enabled:live.enabled===true,mainModelAccess:live.mainModelAccess===true};} }) };
        controller.stopReviewWatch = reviewStore.watch?.((snapshot, error) => {
            if (error) { controller.reviewError = error; logEvent('call-center','operator-review-reconciliation-failed',{error},'error'); return; }
            try { reconcileReviewSnapshot(snapshot); controller.reviewError = null; }
            catch (reconcileError) { controller.reviewError = reconcileError; logEvent('call-center','operator-review-reconciliation-failed',{error:reconcileError},'error'); }
        }) || null;
        lastSignature = signature;
        return controller;
    };

    const assertReviewAvailable = current => {
        if (current?.reviewError) throw current.reviewError;
        if (current?.gateway?.reviewError) throw current.gateway.reviewError;
        return current;
    };

    const api = {
        async dispatch(functionName, args = {}) {
            assertAuthoritySettingsReady('Nexus Main-model Function Gateway authority');
            const fn = String(functionName || '').trim().toLowerCase();
            const capability = CAPABILITY_BY_FUNCTION[fn];
            if (!capability) throw new Error(`Nexus_Call does not expose "${functionName}".`);
            const service = services[fn];
            assertArgumentsMatchSchema(args, service?.parameters, `Nexus_Call.${fn}`);
            const rootSettings = getSettings();
            if (rootSettings.enabled !== true) return 'Nexus is disabled by the global master setting.';
            const settings = rootSettings.nexus?.callCenter || {};
            if (settings.enabled !== true || settings.mainModelAccess !== true) return 'Nexus Main-model Function Gateway is disabled by policy.';
            const domain = TOOL_DOMAIN_BY_FUNCTION[fn] || 'reasoning';
            const current = assertReviewAvailable(getController());
            const result = await current.gateway.dispatch(fn, args, {
                approved: false,
                automatic: true,
                logic: { targetHealth: 'healthy' },
                metadata: { function: fn, toolDomain: domain, executionRail: 'nexus-service', target: mutationTargetForArgs(fn, args), actor: 'main-model' },
            });
            if (result.state === 'completed') {
                if (result.result?.transactionId) {
                    if(String(result.result?.state||'')!=='staged')return `Nexus request failed before staging: ${result.result?.error||result.result?.state||'unknown transaction state'}.`;
                    return `Nexus request staged in Transaction ${result.result.transactionId}; final persistent-state commit still requires approval.`;
                }
                return String(result.result ?? 'Nexus service completed.');
            }
            if (result.state === 'awaiting-approval') return `Nexus request ${result.ticket?.id || ''} requires operator policy approval before it can be staged for mutation review.`;
            return `Nexus request blocked: ${result.error || result.gate?.reason || result.decision?.reason || result.state}.`;
        },
        // Operator-facing methods are intentionally not part of the Main tool
        // schema. Main may request/stage a capability, but it cannot approve its
        // own persistent-state mutation through Nexus_Call.
        pendingReviews({ boundaryOffset = 0, boundaryLimit = 100 } = {}) {
            const { callCenter, gateway } = assertReviewAvailable(getController());
            const cap = Math.max(1, Math.min(250, Math.floor(Number(boundaryLimit) || 100)));
            const offset = Math.max(0, Math.floor(Number(boundaryOffset) || 0));
            const allBoundary = (callCenter.exportAuthority?.().pendingApprovals || [])
                .filter(record => record?.ticket?.direction === 'main-to-nexus')
                .sort((a, b) => Number(a?.at || 0) - Number(b?.at || 0));
            const boundaryRequests = allBoundary.slice(offset, offset + cap).map(record => ({
                ticketId: record.ticket.id,
                correlationId: record.ticket.correlationId,
                capability: record.ticket.capability,
                arguments: safeCopy(record.ticket.arguments || {}),
                target: safeCopy(record.ticket.metadata?.target || {}),
                createdAt: record.ticket.createdAt,
                state: record.state,
                automatic: record.ticket.automatic === true,
                source: record.ticket.source || null,
            }));
            const reviewScope = gateway.reviewStore?.scopeProjection?.();
            const transactions = gateway.ledger.list({ state: 'staged' })
                .filter(tx => tx.metadata?.source === 'main-function-gateway' && String(tx.type || '').startsWith('external:'))
                .filter(tx => reviewScope && String(tx?.assumptions?.operatorReviewScope || tx?.metadata?.reviewScope?.identity || '') === String(reviewScope.identity || '')
                    && String(tx?.assumptions?.chatId ?? tx?.metadata?.reviewScope?.chatId ?? '') === String(reviewScope.chatId ?? ''))
                .map(tx => ({
                    transactionId: tx.id,
                    ticketId: tx.metadata?.ticketId || null,
                    correlationId: tx.metadata?.correlationId || null,
                    capability: tx.input?.capability || tx.mutationProposal?.type || tx.type,
                    arguments: safeCopy(tx.input?.arguments || {}),
                    createdAt: tx.createdAt,
                    state: tx.state,
                    mutationProposal: safeCopy(tx.mutationProposal),
                    assumptions: safeCopy(tx.assumptions || {}),
                }));
            return {
                boundaryRequests,
                boundaryPage: { total: allBoundary.length, offset, limit: cap, hasPrevious: offset > 0, hasNext: offset + boundaryRequests.length < allBoundary.length },
                transactions,
                transactionTotal: transactions.length,
                total: allBoundary.length + transactions.length,
            };
        },
        approveBoundaryRequest(ticketId, options = {}) {
            return assertReviewAvailable(getController()).gateway.approveBoundaryTicket(ticketId, options);
        },
        rejectBoundaryRequest(ticketId, reason = 'Rejected by operator.') {
            return assertReviewAvailable(getController()).gateway.rejectBoundaryTicket(ticketId, reason);
        },
        approveTransaction(transactionId, options = {}) {
            return assertReviewAvailable(getController()).gateway.approveAndCommit(transactionId, options);
        },
        rejectTransaction(transactionId, reason = 'Rejected by operator.') {
            return assertReviewAvailable(getController()).gateway.rejectTransaction(transactionId, reason);
        },
        diagnosticSnapshot() {
            const { callCenter, registry, gateway } = assertReviewAvailable(getController());
            return { calls: safeCopy(callCenter.snapshot()), capabilities: safeCopy(registry.list()), transactions: safeCopy(gateway.ledger.list()) };
        },
        _exportContinuity() {
            assertGatewayLive();
            if (!controller) return retainedGatewayContinuity ? safeCopy(retainedGatewayContinuity) : null;
            return {
                history: controller.callCenter.snapshot(),
                authority: controller.callCenter.exportAuthority?.() || null,
                logicGate: controller.logicGate.exportState?.() || null,
            };
        },
        _close() {
            if (revoked) return;
            revoked = true;
            try { controller?.stopReviewWatch?.(); } catch {}
            try { controller?.reviewStore?.close?.(); } catch {}
            try { controller?.gateway?.close?.(); } catch {}
            controller = null;
            lastSignature = '';
        },
    };
    activeOperatorGateway = api;
    return api;
}

export function createToolGatewayDefinition(services) {
    const gateway = createToolGateway(services);
    const availableFunctions = exposedFunctions(services);
    return {
        name: NEXUS_TOOL_GATEWAY_NAME,
        displayName: 'Nexus Call',
        description: 'Request one individually registered, policy-controlled Nexus service. Mutation capabilities appear only after a Ledger-safe staging adapter is installed.',
        parameters: {
            oneOf: availableFunctions.map(fn => ({
                type: 'object',
                properties: {
                    function: { type: 'string', const: fn },
                    arguments: safeCopy(services?.[fn]?.parameters || { type: 'object' }),
                },
                required: ['function', 'arguments'],
                additionalProperties: false,
            })),
        },
        action: input => gateway.dispatch(input?.function, input?.arguments || {}),
    };
}
