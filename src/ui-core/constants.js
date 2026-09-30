export const RenderCost = Object.freeze({
  CHEAP: 'CHEAP',
  NORMAL: 'NORMAL',
  EXPENSIVE: 'EXPENSIVE',
});

export const WidgetCategory = Object.freeze({
  PRIMITIVE: 'primitive',
  STRUCTURAL: 'structural',
  COGNITIVE: 'cognitive',
  DIAGNOSTIC: 'diagnostic',
});

export const ResponsiveMode = Object.freeze({
  WIDE: 'WIDE',
  COMPACT: 'COMPACT',
  STACKED: 'STACKED',
});

export const GeneralStatus = Object.freeze({
  LOADING: 'loading',
  READY: 'ready',
  EMPTY: 'empty',
  STALE: 'stale',
  WARNING: 'warning',
  ERROR: 'error',
  DISABLED: 'disabled',
  OFFLINE: 'offline',
});

export const RuntimeStatus = Object.freeze({
  ACTIVE: 'ACTIVE',
  YIELDING: 'YIELDING',
  PARKED: 'PARKED',
  BLOCKED: 'BLOCKED',
  RECOVERING: 'RECOVERING',
  COMPLETE: 'COMPLETE',
  STALE: 'STALE',
});

export const KnowledgeStatus = Object.freeze({
  CANONICAL: 'canonical',
  OBSERVED: 'observed',
  INFERRED: 'inferred',
  HISTORICAL: 'historical',
  CURRENT: 'CURRENT',
  SUPERSEDED: 'SUPERSEDED',
  CONTRADICTED: 'CONTRADICTED',
  UNCERTAIN: 'UNCERTAIN',
  UNRESOLVED: 'UNRESOLVED',
});

export const Signals = Object.freeze({
  WORKER_STATE_CHANGED: 'WORKER_STATE_CHANGED',
  BATCH_PROGRESS_CHANGED: 'BATCH_PROGRESS_CHANGED',
  QUEUE_COUNT_CHANGED: 'QUEUE_COUNT_CHANGED',
  COGNITIVE_MODE_CHANGED: 'COGNITIVE_MODE_CHANGED',
  CLAIM_STATE_CHANGED: 'CLAIM_STATE_CHANGED',
  REFLECTION_CHANGED: 'REFLECTION_CHANGED',
  UI_INSPECT_SELECTION_CHANGED: 'UI_INSPECT_SELECTION_CHANGED',
  UI_WORKSPACE_CHANGED: 'UI_WORKSPACE_CHANGED',
  UI_NOTIFICATION: 'UI_NOTIFICATION',
  UI_NOTIFICATION_CHANGED: 'UI_NOTIFICATION_CHANGED',
  UI_RUNTIME_ACTIVITY: 'UI_RUNTIME_ACTIVITY',
});

export const UIActionResult = Object.freeze({
  OK: 'OK',
  DENIED: 'DENIED',
  INVALID: 'INVALID',
  NOT_FOUND: 'NOT_FOUND',
  ERROR: 'ERROR',
});
