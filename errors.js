import { DECISION_ERROR } from './constants.js';

export class DecisionProviderError extends Error {
    constructor(category, message, details = {}) {
        super(String(message || category || 'Decision provider failure'));
        this.name = 'NexusDecisionProviderError';
        this.category = category || DECISION_ERROR.NETWORK;
        this.httpStatus = Number(details.httpStatus) || null;
        this.provider = details.provider || null;
        this.retryable = details.retryable === true;
        this.details = details.details && typeof details.details === 'object' ? details.details : null;
    }
}

export function decisionErrorEnvelope(error, fallbackCategory = DECISION_ERROR.NETWORK) {
    return {
        category: error?.category || fallbackCategory,
        message: String(error?.message || fallbackCategory),
        httpStatus: Number(error?.httpStatus) || null,
        provider: error?.provider || null,
        retryable: error?.retryable === true,
    };
}

export function mapHttpDecisionError(status, { provider = null, body = null } = {}) {
    const code = Number(status) || 0;
    let category = DECISION_ERROR.NETWORK;
    if (code === 401 || code === 403) category = DECISION_ERROR.AUTH;
    else if (code === 402) category = DECISION_ERROR.BILLING;
    else if ([400, 413, 422].includes(code)) category = DECISION_ERROR.VALIDATION;
    else if (code === 429) category = DECISION_ERROR.RATE_LIMIT;
    else if (code === 524 || code === 408) category = DECISION_ERROR.TIMEOUT;
    else if (code === 529 || code === 502 || code === 503) category = DECISION_ERROR.OVERLOADED;
    else if (code === 404) category = DECISION_ERROR.API_DRIFT;
    else if (code >= 500) category = DECISION_ERROR.OVERLOADED;
    const safeMessage = body?.error?.message || body?.message || `Decision provider HTTP ${code || 'failure'}`;
    return new DecisionProviderError(category, safeMessage, {
        provider, httpStatus: code || null,
        retryable: [DECISION_ERROR.RATE_LIMIT, DECISION_ERROR.OVERLOADED, DECISION_ERROR.TIMEOUT, DECISION_ERROR.NETWORK].includes(category),
    });
}
