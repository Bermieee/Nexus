import { DECISION_CONTRACT_API_VERSION, DECISION_ERROR } from './constants.js';
import { DecisionProviderError } from './errors.js';

const contracts = new Map();
function normalizeQuestionSpec(spec = {}) {
    const type = String(spec.type || '').toLowerCase();
    if (!['noul', 'choice', 'score'].includes(type)) throw new Error(`Unsupported Decision question type: ${type || '(missing)'}`);
    return Object.freeze({ type, required: spec.required !== false });
}

export function registerDecisionContract(contract) {
    const id = String(contract?.id || '').trim();
    const version = Number(contract?.version);
    if (!id || !Number.isInteger(version) || version < 1) throw new Error('Decision contract requires a stable id and positive integer version.');
    const key = `${id}@${version}`;
    const questions = Object.fromEntries(Object.entries(contract.questions || {}).map(([name, spec]) => [name, normalizeQuestionSpec(spec)]));
    const normalized = Object.freeze({ ...contract, id, version, questions, apiVersion: DECISION_CONTRACT_API_VERSION });
    contracts.set(key, normalized);
    return normalized;
}

export function getDecisionContract(id, version = null) {
    const name = String(id || '').trim();
    if (!name) return null;
    if (version != null) return contracts.get(`${name}@${Number(version)}`) || null;
    const matches = [...contracts.values()].filter(c => c.id === name).sort((a, b) => b.version - a.version);
    return matches[0] || null;
}

export function listDecisionContracts() { return [...contracts.values()]; }

function assertJsonish(value, label) {
    try { JSON.stringify(value); } catch { throw new DecisionProviderError(DECISION_ERROR.VALIDATION, `${label} must be serializable.`); }
}

export function validateDecisionRequest(request = {}) {
    const contract = getDecisionContract(request.contractId, request.contractVersion ?? null);
    if (!contract) throw new DecisionProviderError(DECISION_ERROR.UNKNOWN_CONTRACT, `Unknown Decision contract/version: ${request.contractId || '(missing)'}@${request.contractVersion ?? 'latest'}`);
    if (!request.sourceFingerprint || typeof request.sourceFingerprint !== 'string') throw new DecisionProviderError(DECISION_ERROR.VALIDATION, 'Decision requests require a destination-owned sourceFingerprint.');
    assertJsonish(request.state, 'Decision state');
    assertJsonish(request.questions, 'Decision questions');
    const questions = request.questions && typeof request.questions === 'object' && !Array.isArray(request.questions) ? request.questions : null;
    if (!questions) throw new DecisionProviderError(DECISION_ERROR.VALIDATION, 'Decision questions must be an object keyed by question id.');
    for (const [id, spec] of Object.entries(contract.questions)) {
        const question = questions[id];
        if (!question) {
            if (spec.required) throw new DecisionProviderError(DECISION_ERROR.VALIDATION, `Decision contract ${contract.id} requires question "${id}".`);
            continue;
        }
        if (String(question.type || '').toLowerCase() !== spec.type) throw new DecisionProviderError(DECISION_ERROR.VALIDATION, `Question "${id}" must be type ${spec.type}.`);
        if (question.instructions == null || (typeof question.instructions === 'string' && !question.instructions.trim())) throw new DecisionProviderError(DECISION_ERROR.VALIDATION, `Question "${id}" requires instructions.`);
        if (spec.type === 'choice') {
            const criteria = question.criteria && typeof question.criteria === 'object' && !Array.isArray(question.criteria) ? question.criteria : null;
            if (!criteria || Object.keys(criteria).length < 2) throw new DecisionProviderError(DECISION_ERROR.VALIDATION, `Choice question "${id}" requires at least two criteria.`);
        }
        if (spec.type === 'score') {
            if (!Array.isArray(question.criteria) || question.criteria.length < 2) throw new DecisionProviderError(DECISION_ERROR.VALIDATION, `Score question "${id}" requires at least two ordered criteria.`);
        }
    }
    for (const id of Object.keys(questions)) if (!contract.questions[id]) throw new DecisionProviderError(DECISION_ERROR.VALIDATION, `Question "${id}" is not defined by ${contract.id} v${contract.version}.`);
    return { contract, request: { ...request, contractVersion: contract.version } };
}

export const HOUSEKEEPER_ENTITY_ALIGNMENT_CONTRACT = registerDecisionContract({
    id: 'housekeeper.entity-alignment.v1',
    version: 1,
    subsystem: 'housekeeper',
    questions: {
        same_concept: { type: 'noul' },
        meaningful_overlap: { type: 'score' },
        left_has_unique_facts: { type: 'noul' },
        right_has_unique_facts: { type: 'noul' },
        contradiction: { type: 'noul' },
        safe_to_escalate_for_merge: { type: 'noul' },
    },
});

export const CONNECTIVITY_CONTRACT = registerDecisionContract({
    id: 'decision-core.connectivity.v1',
    version: 1,
    subsystem: 'decision-core',
    questions: { reachable: { type: 'noul' } },
});
