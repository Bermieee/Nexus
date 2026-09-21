import { DECISION_ERROR } from './constants.js';
import { DecisionProviderError } from './errors.js';

function finiteProbability(value, label) {
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0 || number > 1) throw new DecisionProviderError(DECISION_ERROR.MALFORMED_TYPED_OUTPUT, `${label} must be a probability from 0 to 1.`);
    return number;
}
function normalizeProbabilities(value, label) {
    if (value == null) return null;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DecisionProviderError(DECISION_ERROR.MALFORMED_TYPED_OUTPUT, `${label} probabilities must be an object.`);
    return Object.fromEntries(Object.entries(value).map(([key, probability]) => [key, finiteProbability(probability, `${label}.${key}`)]));
}
export function normalizeDecisionAnswer(answer, question, id = 'answer') {
    if (!answer || typeof answer !== 'object') throw new DecisionProviderError(DECISION_ERROR.MALFORMED_TYPED_OUTPUT, `Missing typed answer for ${id}.`);
    const expected = String(question?.type || '').toLowerCase();
    const type = String(answer.type || '').toLowerCase();
    if (type !== expected) throw new DecisionProviderError(DECISION_ERROR.MALFORMED_TYPED_OUTPUT, `Answer ${id} returned ${type || '(missing)'} but contract requires ${expected}.`);
    if (type === 'noul') {
        const value = finiteProbability(answer.noul ?? answer.value ?? answer.probability, `${id}.noul`);
        return { type: 'noul', value, probability: value };
    }
    if (type === 'choice') {
        const value = String(answer.choice ?? answer.value ?? '');
        if (!value) throw new DecisionProviderError(DECISION_ERROR.MALFORMED_TYPED_OUTPUT, `Choice answer ${id} is missing a selected choice.`);
        const criteria = question?.criteria;
        if (criteria && typeof criteria === 'object' && !Array.isArray(criteria) && !Object.prototype.hasOwnProperty.call(criteria, value)) throw new DecisionProviderError(DECISION_ERROR.MALFORMED_TYPED_OUTPUT, `Choice answer ${id} selected unknown criterion "${value}".`);
        const probabilities = normalizeProbabilities(answer.probabilities, id);
        const confidence = answer.confidence == null ? null : finiteProbability(answer.confidence, `${id}.confidence`);
        return { type: 'choice', value, choice: value, probabilities, confidence };
    }
    if (type === 'score') {
        const value = Number(answer.score ?? answer.value);
        if (!Number.isFinite(value)) throw new DecisionProviderError(DECISION_ERROR.MALFORMED_TYPED_OUTPUT, `Score answer ${id} is not finite.`);
        const probabilities = normalizeProbabilities(answer.probabilities, id);
        const confidence = answer.confidence == null ? null : finiteProbability(answer.confidence, `${id}.confidence`);
        const legend = answer.legend && typeof answer.legend === 'object' && !Array.isArray(answer.legend) ? answer.legend : null;
        return { type: 'score', value, score: value, probabilities, confidence, legend };
    }
    throw new DecisionProviderError(DECISION_ERROR.MALFORMED_TYPED_OUTPUT, `Unsupported typed answer ${type || '(missing)'}.`);
}
export function normalizeDecisionAnswers(rawAnswers, questions) {
    if (!rawAnswers || typeof rawAnswers !== 'object' || Array.isArray(rawAnswers)) throw new DecisionProviderError(DECISION_ERROR.MALFORMED_TYPED_OUTPUT, 'Decision provider response is missing the answers object.');
    const answers = {};
    for (const [id, question] of Object.entries(questions || {})) answers[id] = normalizeDecisionAnswer(rawAnswers[id], question, id);
    for (const id of Object.keys(rawAnswers)) if (!questions?.[id]) throw new DecisionProviderError(DECISION_ERROR.MALFORMED_TYPED_OUTPUT, `Decision provider returned unexpected answer "${id}".`);
    return answers;
}
