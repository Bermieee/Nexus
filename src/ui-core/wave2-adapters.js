export const Wave2Signals = Object.freeze({
  SCENE_LOCATION_CHANGED: 'LOCATION_CHANGED',
  SCENE_ACTIVE_CAST_CHANGED: 'ACTIVE_CAST_CHANGED',
  SCENE_TIME_SHIFT_DETECTED: 'TIME_SHIFT_DETECTED',
  SCENE_VIBE_CHANGED: 'VIBE_CHANGED',
  SCENE_STATE_DELTA: 'SCENE_STATE_DELTA',
  SCENE_BOUNDARY_CHANGED: 'SCENE_BOUNDARY_CHANGED',
  SCENE_EPISODE_CLOSED: 'SCENE_EPISODE_CLOSED',
  SCENE_NAVIGATION_CHANGED: 'SCENE_NAVIGATION_CHANGED',
  RUNTIME_OVERVIEW_CHANGED: 'RUNTIME_OVERVIEW_CHANGED',
  LIFECYCLE_OBLIGATION_CHANGED: 'LIFECYCLE_OBLIGATION_CHANGED',
  RUNTIME_BATCH_CHANGED: 'RUNTIME_BATCH_CHANGED',
  TURN_EVENT_CREATED: 'TURN_EVENT_CREATED',
  COPROCESSOR_RESULT_CHANGED: 'COPROCESSOR_RESULT_CHANGED',
  GATHER_STATE_CHANGED: 'GATHER_STATE_CHANGED',
  CONTEXT_SEAL_CHANGED: 'CONTEXT_SEAL_CHANGED',
  HOT_COGNITION_CHANGED: 'HOT_COGNITION_CHANGED',
  KNOWLEDGE_INSPECTION_READY: 'KNOWLEDGE_INSPECTION_READY',
});

export const SceneRelation = Object.freeze({
  PRECEDES: 'PRECEDES',
  CONTINUES: 'CONTINUES',
  PARALLEL_TO: 'PARALLEL_TO',
  FLASHBACK_OF: 'FLASHBACK_OF',
  INTERRUPTS: 'INTERRUPTS',
  RESUMES: 'RESUMES',
});

export const ResultClass = Object.freeze({ REQUIRED: 'REQUIRED', OPPORTUNISTIC: 'OPPORTUNISTIC', DEFERRED: 'DEFERRED' });
export const LateRoute = Object.freeze({ NEXT_TURN: 'NEXT TURN', BACKGROUND: 'BACKGROUND' });
export const ContextSealState = Object.freeze({ OPEN: 'OPEN', QUORUM: 'QUORUM', COMPILING: 'COMPILING', SEALED: 'SEALED' });

const CONTRACTS = Object.freeze({
  SceneUIAdapter: ['getCurrentScene','getBoundaryState','getSceneEpisode','getSceneHistoryPage','getRelatedScenes','subscribeSceneDeltas'],
  RuntimeUIAdapter: ['getOverview','getLifecyclePage','getWorkers','getBatches','getLedgerPage','subscribeRuntime'],
  CoprocessorUIAdapter: ['getTurnSwarm','getGather','getContextSealTimeline','subscribeCoprocessor'],
  KnowledgeUIAdapter: ['inspectSource','inspectProvenance','inspectHistory','inspectDependencies','inspectSettlement','inspectEvidence'],
});

export function assertUIAdapterContract(name, adapter) {
  const required = CONTRACTS[name];
  if (!required) throw new Error(`Unknown UI adapter contract: ${name}`);
  const missing = required.filter((method) => typeof adapter?.[method] !== 'function');
  if (missing.length) throw new TypeError(`${name} missing: ${missing.join(', ')}`);
  return adapter;
}

export function assertAdapterBundle(bundle) {
  assertUIAdapterContract('SceneUIAdapter', bundle.scene);
  assertUIAdapterContract('RuntimeUIAdapter', bundle.runtime);
  assertUIAdapterContract('CoprocessorUIAdapter', bundle.coprocessor);
  assertUIAdapterContract('KnowledgeUIAdapter', bundle.knowledge);
  return bundle;
}

export function createAdapterBundle({ scene, runtime, coprocessor, knowledge }) {
  return Object.freeze(assertAdapterBundle({ scene, runtime, coprocessor, knowledge }));
}

export function page(items, { offset = 0, limit = 50 } = {}) {
  const start = Math.max(0, Number(offset) || 0);
  const size = Math.max(1, Number(limit) || 50);
  return Object.freeze({
    items: clone(items.slice(start, start + size)),
    offset: start,
    limit: size,
    total: items.length,
    nextOffset: start + size < items.length ? start + size : null,
  });
}

export function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}
