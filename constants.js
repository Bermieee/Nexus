export const DECISION_MODE = Object.freeze({ OFF: 'off', SHADOW: 'shadow', ASSIST: 'assist' });
export const DECISION_PROVIDER = Object.freeze({
    AUTO: 'auto',
    OPENROUTER_JEV: 'openrouter-jev',
    TYPESAFE_DIRECT: 'typesafe-direct',
    LLM_FALLBACK: 'llm-fallback',
    LLM_FALLBACK_ONLY: 'llm-fallback-only',
    DISABLED: 'disabled',
    DETERMINISTIC: 'deterministic',
});
export const DECISION_PROVIDER_CLASS = Object.freeze({
    TYPED_DECISION: 'typed-decision',
    LLM_FALLBACK: 'llm-fallback',
    DETERMINISTIC: 'deterministic',
});
export const DECISION_ERROR = Object.freeze({
    AUTH: 'AUTH', BILLING: 'BILLING', VALIDATION: 'VALIDATION', RATE_LIMIT: 'RATE_LIMIT', OVERLOADED: 'OVERLOADED',
    TIMEOUT: 'TIMEOUT', NETWORK: 'NETWORK', MALFORMED_TYPED_OUTPUT: 'MALFORMED_TYPED_OUTPUT',
    API_DRIFT: 'API_DRIFT', PROVIDER_DISABLED: 'PROVIDER_DISABLED', NOT_CONFIGURED: 'NOT_CONFIGURED',
    STALE_RESULT: 'STALE_RESULT', FALLBACK_FAILED: 'FALLBACK_FAILED', UNKNOWN_CONTRACT: 'UNKNOWN_CONTRACT',
});
export const TYPESAFE_SYSTEMONE_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
export const OPENROUTER_DECISIONS_ENDPOINT = 'https://openrouter.ai/api/alpha/decisions';
export const DEFAULT_TYPESAFE_MODEL = 'jev-latest';
export const DEFAULT_OPENROUTER_JEV_MODEL = 'typesafe/jev-1.13';
export const DECISION_CONTRACT_API_VERSION = 1;
