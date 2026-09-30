import { assertAdapterBundle, clone, page } from './wave2-adapters.js';

export const Wave3Signals = Object.freeze({
  RUNTIME_QUEUE_DEPTH_CHANGED: 'RUNTIME_QUEUE_DEPTH_CHANGED',
  RUNTIME_UTILIZATION_CHANGED: 'RUNTIME_UTILIZATION_CHANGED',
  RUNTIME_CAPACITY_CHANGED: 'RUNTIME_CAPACITY_CHANGED',
  RUNTIME_RECOVERY_EVENT: 'RUNTIME_RECOVERY_EVENT',
  WORK_LEDGER_TASK_CHANGED: 'WORK_LEDGER_TASK_CHANGED',
  COPROCESSOR_TELEMETRY_CHANGED: 'COPROCESSOR_TELEMETRY_CHANGED',
  COPROCESSOR_STALE_DROPPED: 'COPROCESSOR_STALE_DROPPED',
  COPROCESSOR_DEDUPE_EVENT: 'COPROCESSOR_DEDUPE_EVENT',
  CANDIDATE_FUNNEL_CHANGED: 'CANDIDATE_FUNNEL_CHANGED',
  RERANK_PROGRESS_CHANGED: 'RERANK_PROGRESS_CHANGED',
  PRECISION_FALLBACK_CHANGED: 'PRECISION_FALLBACK_CHANGED',
  SETTLEMENT_TRACE_CHANGED: 'SETTLEMENT_TRACE_CHANGED',
  REFLECTION_STATE_CHANGED: 'REFLECTION_STATE_CHANGED',
  MEMORY_STATE_CHANGED: 'MEMORY_STATE_CHANGED',
});

export const ResultDestination = Object.freeze({
  CURRENT_CONTEXT: 'CURRENT CONTEXT',
  NEXT_TURN: 'NEXT TURN',
  BACKGROUND: 'BACKGROUND',
  STALE_DROPPED: 'STALE / DROPPED',
  FALLBACK: 'FALLBACK',
});

export const TruthClass = Object.freeze({
  CURRENT: 'CURRENT',
  HISTORICAL: 'HISTORICAL',
  SUPERSEDED: 'SUPERSEDED',
  CONTRADICTED: 'CONTRADICTED',
  UNCERTAIN: 'UNCERTAIN',
  UNRESOLVED: 'UNRESOLVED',
  SOURCE_CANON: 'SOURCE_CANON',
  INFERRED: 'INFERRED',
});

const WAVE3_CONTRACTS = Object.freeze({
  RuntimeTelemetryUIAdapter: ['getTelemetrySummary','getWorkerTelemetry','getLedgerTaskDetail','getRecoveryPage'],
  CoprocessorTelemetryUIAdapter: ['getCoprocessorTelemetry','getWorkerTelemetryDetail','getDebugArtifact'],
  MemoryStateUIAdapter: ['getStateOverview','getMemoryRecord','getSettlementTrace','getReflections','getEpisodicChain','subscribeMemory'],
  PrecisionUIAdapter: ['getPipeline','getCandidateFunnel','getCandidatesPage','getCandidateDetail','getIntentOppositeFixtures','getRuntimeBenchmarks','getDeadlineState','subscribePrecision'],
});

export function assertWave3Contract(name, adapter) {
  const required = WAVE3_CONTRACTS[name];
  if (!required) throw new Error(`Unknown Wave 3 adapter contract: ${name}`);
  const missing = required.filter((method) => typeof adapter?.[method] !== 'function');
  if (missing.length) throw new TypeError(`${name} missing: ${missing.join(', ')}`);
  return adapter;
}

export function assertWave3AdapterBundle(bundle) {
  assertAdapterBundle(bundle);
  assertWave3Contract('RuntimeTelemetryUIAdapter', bundle.runtime);
  assertWave3Contract('CoprocessorTelemetryUIAdapter', bundle.coprocessor);
  assertWave3Contract('MemoryStateUIAdapter', bundle.memory);
  assertWave3Contract('PrecisionUIAdapter', bundle.precision);
  return bundle;
}

export function createWave3AdapterBundle({ scene, runtime, coprocessor, knowledge, memory, precision }) {
  return Object.freeze(assertWave3AdapterBundle({ scene, runtime, coprocessor, knowledge, memory, precision }));
}

export function paged(items, options) {
  return page(items, options);
}

export function lightweightEvent(type, payload, { source = 'wave3-adapter', revision = null } = {}) {
  const safe = {};
  for (const [key,value] of Object.entries(payload ?? {})) {
    if (key === 'rawPayload' || key === 'prompt' || key === 'fullResponse' || key === 'ledger' || key === 'workers') continue;
    safe[key] = clone(value);
  }
  return Object.freeze({ type, payload: Object.freeze(safe), source, revision });
}
