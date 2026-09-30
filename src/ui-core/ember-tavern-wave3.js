import { RuntimeStatus, Signals } from './constants.js';
import { ContextSealState, ResultClass, SceneRelation, Wave2Signals, clone, page } from './wave2-adapters.js';
import { ResultDestination, TruthClass, Wave3Signals, createWave3AdapterBundle, lightweightEvent } from './wave3-adapters.js';

export class EmberTavernWave3Fixture {
  constructor({ signals, stress = false } = {}) {
    if (!signals) throw new Error('EmberTavernWave3Fixture requires SignalHub');
    this.signals = signals;
    this.clock = 0;
    this.detailReads = { worker: 0, ledger: 0, coprocessor: 0, debug: 0, memory: 0, precision: 0 };
    this.runtimeOverview = makeRuntimeOverview();
    this.workers = makeWorkers(stress ? 256 : 12);
    this.obligations = makeObligations(stress ? 8000 : 160);
    this.batches = makeBatches(stress ? 128 : 12);
    this.ledger = makeLedger(stress ? 12000 : 900);
    this.recoveryEvents = makeRecoveryEvents(stress ? 200 : 12);
    this.currentScene = makeRuinsScene();
    this.episodes = makeEpisodes(stress ? 10000 : 24);
    this.sceneRelations = makeRelations();
    this.boundary = { candidateId: null, sceneId: this.currentScene.id, state: 'IDLE', confidence: 0, supportingSignals: [], contradictoryEvidence: [], confirmationWindow: { state: 'CLOSED', observedTurns: 0, requiredTurns: 2 }, decision: 'NO CUT' };
    this.memoryRecords = makeMemoryRecords(stress ? 5000 : 24);
    this.reflections = makeReflections(stress ? 1500 : 8);
    this.settlementTraces = makeSettlementTraces(stress ? 3000 : 20);
    this.episodicChains = makeEpisodicChains();
    this.candidates = makeCandidates(stress ? 12000 : 48);
    this.pipeline = makePrecisionPipeline();
    this.funnel = makeCandidateFunnel(this.candidates.length);
    this.intentOpposites = makeIntentOpposites();
    this.runtimeBenchmarks = makeRuntimeBenchmarks();
    this.deadlineState = makeDeadlineState();
    this.turn = null;
    this.debugArtifacts = new Map();
  }

  tick(ms = 11) { this.clock += ms; return this.clock; }

  emit(type, payload, source = 'ember-tavern-wave3') {
    this.tick();
    return this.signals.publish(type, clone(payload), { source, timestamp: this.clock, revision: payload?.revision ?? null });
  }

  getCurrentScene() { return clone(this.currentScene); }
  getBoundaryState() { return clone(this.boundary); }
  getSceneEpisode(id) { return clone(this.episodes.find((item) => item.id === id) ?? null); }
  getRelatedScenes(id) {
    return clone(this.sceneRelations.filter((edge) => edge.from === id || edge.to === id).map((edge) => {
      const targetId = edge.from === id ? edge.to : edge.from;
      return { ...edge, direction: edge.from === id ? 'OUT' : 'IN', scene: this.getSceneEpisode(targetId) ?? (this.currentScene.id === targetId ? this.getCurrentScene() : null) };
    }));
  }

  transitionScene(field, value, type = Wave2Signals.SCENE_STATE_DELTA) {
    const previous = clone(this.currentScene[field]);
    this.currentScene[field] = clone(value);
    this.currentScene.revision += 1;
    this.emit(type, { sceneId: this.currentScene.id, sceneRevision: this.currentScene.revision, field, previous, value: clone(value) });
    if (type !== Wave2Signals.SCENE_STATE_DELTA) this.emit(Wave2Signals.SCENE_STATE_DELTA, { sceneId: this.currentScene.id, sceneRevision: this.currentScene.revision, field, previous, value: clone(value) });
  }

  getTelemetrySummary() {
    const active = this.workers.filter((w) => w.state === RuntimeStatus.ACTIVE).length;
    const parked = this.workers.filter((w) => w.state === RuntimeStatus.PARKED).length;
    const blockedRecovering = this.workers.filter((w) => [RuntimeStatus.BLOCKED, RuntimeStatus.RECOVERING].includes(w.state)).length;
    const queued = this.obligations.filter((o) => o.state === 'QUEUED').length;
    const activeBatches = this.batches.filter((b) => b.completedUnits < b.totalUnits).length;
    return clone({
      ...this.runtimeOverview,
      activeWorkerCount: active,
      parkedWorkerCount: parked,
      queuedObligations: queued,
      blockedRecoveringWork: blockedRecovering,
      activeBatches,
      foregroundDeadlineState: this.deadlineState.state,
      recentRecoveryFallback: this.recoveryEvents.slice(0, 4),
    });
  }

  getWorkerTelemetry(workerId) {
    this.detailReads.worker += 1;
    return clone(this.workers.find((worker) => worker.id === workerId) ?? null);
  }

  getLedgerTaskDetail(taskId) {
    this.detailReads.ledger += 1;
    return clone(this.ledger.find((task) => task.id === taskId) ?? null);
  }

  runtimeSignalStorm(count = 1000, workerId = 'worker-0') {
    const worker = this.workers.find((item) => item.id === workerId) ?? this.workers[0];
    for (let i = 0; i < count; i += 1) {
      worker.state = i % 5 === 0 ? RuntimeStatus.YIELDING : i % 5 === 1 ? RuntimeStatus.PARKED : i % 5 === 2 ? RuntimeStatus.ACTIVE : i % 5 === 3 ? RuntimeStatus.BLOCKED : RuntimeStatus.RECOVERING;
      this.emit(Signals.WORKER_STATE_CHANGED, { workerId: worker.id, state: worker.state, layer: worker.layer, taskId: worker.currentTask?.id ?? null });
    }
  }

  updateQueueDepth(depth) {
    this.runtimeOverview.queueDepth = depth;
    this.emit(Wave3Signals.RUNTIME_QUEUE_DEPTH_CHANGED, { depth });
  }

  updateUtilization(level, value) {
    this.runtimeOverview.utilization[level] = value;
    this.emit(Wave3Signals.RUNTIME_UTILIZATION_CHANGED, { level, value });
  }

  updateCapacity({ reservedForegroundCapacity, borrowedBackgroundCapacity }) {
    if (reservedForegroundCapacity != null) this.runtimeOverview.reservedForegroundCapacity = reservedForegroundCapacity;
    if (borrowedBackgroundCapacity != null) this.runtimeOverview.borrowedBackgroundCapacity = borrowedBackgroundCapacity;
    this.emit(Wave3Signals.RUNTIME_CAPACITY_CHANGED, { reservedForegroundCapacity: this.runtimeOverview.reservedForegroundCapacity, borrowedBackgroundCapacity: this.runtimeOverview.borrowedBackgroundCapacity });
  }

  updateBatch(batchId, patch = {}) {
    const batch = this.batches.find((item) => item.id === batchId);
    if (!batch) return null;
    Object.assign(batch, patch);
    this.emit(Wave2Signals.RUNTIME_BATCH_CHANGED, { batch: clone(batch) });
    this.emit(Signals.BATCH_PROGRESS_CHANGED, { batchId, progress: Math.round((batch.completedUnits / batch.totalUnits) * 100) });
    return clone(batch);
  }

  recoverWorker(workerId = 'worker-3') {
    const worker = this.workers.find((item) => item.id === workerId);
    if (!worker) return null;
    worker.state = RuntimeStatus.RECOVERING;
    const event = { eventId: `recovery-${this.clock}`, workerId, reason: 'provider timeout', action: 'checkpoint-resume', fallback: 'deterministic', state: 'RECOVERING' };
    this.recoveryEvents.unshift(event);
    this.emit(Signals.WORKER_STATE_CHANGED, { workerId, state: worker.state, layer: worker.layer });
    this.emit(Wave3Signals.RUNTIME_RECOVERY_EVENT, event);
    return clone(event);
  }

  getMemoryRecord(id) {
    this.detailReads.memory += 1;
    return clone(this.memoryRecords.find((record) => record.id === id) ?? null);
  }

  getStateOverview() {
    return clone({
      records: this.memoryRecords.slice(0, 12),
      currentCount: this.memoryRecords.filter((r) => r.currentState?.status === TruthClass.CURRENT).length,
      historicalCount: this.memoryRecords.reduce((n, r) => n + (r.historicalStates?.length ?? 0), 0),
      unresolvedCount: this.memoryRecords.filter((r) => r.currentState?.status === TruthClass.UNRESOLVED || r.unresolvedEvidence?.length).length,
    });
  }

  getSettlementTrace(id) {
    return clone(this.settlementTraces.find((trace) => trace.id === id || trace.recordId === id) ?? null);
  }

  getReflections() { return clone(this.reflections); }

  weakenReflection(id = 'reflection-eris-mara') {
    const reflection = this.reflections.find((item) => item.id === id);
    if (!reflection) return null;
    const previous = reflection.confidence;
    reflection.confidence = Math.max(0, Number((previous - 0.16).toFixed(2)));
    reflection.status = 'WEAKENED';
    reflection.contradictingEvidence.push('journal-contradiction');
    reflection.history.push({ action: 'weaken', from: previous, to: reflection.confidence, reason: 'support removed / contradiction introduced', revision: 45 });
    this.emit(Wave3Signals.REFLECTION_STATE_CHANGED, { reflectionId: id, confidence: reflection.confidence, status: reflection.status, revision: 45 });
    return clone(reflection);
  }

  getEpisodicChain(id = 'episode-ember-intact') {
    return clone(this.episodicChains.find((chain) => chain.id === id) ?? null);
  }

  getPipeline() { return clone(this.pipeline); }
  getCandidateFunnel() { return clone(this.funnel); }

  getCandidatesPage(options) {
    return page(this.candidates, options);
  }

  getCandidateDetail(id) {
    this.detailReads.precision += 1;
    return clone(this.candidates.find((candidate) => candidate.id === id) ?? null);
  }

  getIntentOppositeFixtures() { return clone(this.intentOpposites); }
  getRuntimeBenchmarks() { return clone(this.runtimeBenchmarks); }
  getDeadlineState() { return clone(this.deadlineState); }

  updateFunnel(stage, count) {
    this.funnel.stages[stage] = count;
    this.emit(Wave3Signals.CANDIDATE_FUNNEL_CHANGED, { stage, count, adaptiveCandidateBudget: this.funnel.adaptiveCandidateBudget });
  }

  rerankStorm(count = 1000, candidateId = 'cand-current-destroyed') {
    for (let i = 0; i < count; i += 1) this.emit(Wave3Signals.RERANK_PROGRESS_CHANGED, { runId: 'rerank-ember-1', candidateId, progress: i + 1, total: count });
  }

  simulateRerankTimeout() {
    this.deadlineState = {
      ...this.deadlineState,
      state: 'SEALED_WITH_FALLBACK',
      rerankerState: 'LATE',
      fallbackActive: true,
      fallbackType: 'deterministic fused ranking',
      gatherQuorum: true,
      contextSeal: ContextSealState.SEALED,
      mainProceeding: true,
      lateDestination: ResultDestination.NEXT_TURN,
      sealedAt: this.tick(80),
    };
    this.emit(Wave3Signals.PRECISION_FALLBACK_CHANGED, clone(this.deadlineState));
    return clone(this.deadlineState);
  }

  createTurnEvent() {
    this.turn = makeTurn(this.clock);
    this.emit(Wave2Signals.TURN_EVENT_CREATED, { turnId: this.turn.turnId, correlationId: this.turn.correlationId, workerCount: this.turn.workers.length, deadline: this.turn.deadline });
    return clone(this.turn);
  }

  completeWorker(workerId, options = {}) {
    if (!this.turn) this.createTurnEvent();
    const worker = this.turn.workers.find((item) => item.id === workerId);
    if (!worker) throw new Error(`Unknown coprocessor worker: ${workerId}`);
    worker.state = RuntimeStatus.COMPLETE;
    worker.startedAt = worker.startedAt ?? this.tick(2);
    worker.queueDelayMs = options.queueDelayMs ?? worker.queueDelayMs;
    worker.executionLatencyMs = options.executionLatencyMs ?? worker.executionLatencyMs;
    worker.completedAt = this.tick(worker.executionLatencyMs);
    worker.retryCount = options.retryCount ?? worker.retryCount;
    worker.validationResult = options.validationResult ?? worker.validationResult;
    worker.freshness = options.stale ? 'STALE' : 'FRESH';
    worker.cacheWarmHit = options.cacheWarmHit ?? worker.cacheWarmHit;
    worker.fallbackUsed = options.fallbackUsed ?? worker.fallbackUsed;
    const sealed = this.turn.gather.contextSeal === ContextSealState.SEALED;
    if (options.stale) {
      worker.destination = ResultDestination.STALE_DROPPED;
      worker.contributedToSealedContext = false;
      this.turn.gather.staleRejected.push(worker.id);
      this.emit(Wave3Signals.COPROCESSOR_STALE_DROPPED, { turnId: this.turn.turnId, workerId: worker.id, reason: 'freshness fence' });
    } else if (sealed) {
      worker.destination = options.destination ?? ResultDestination.NEXT_TURN;
      worker.contributedToSealedContext = false;
      this.turn.gather.lateResults.push({ workerId: worker.id, destination: worker.destination });
    } else {
      worker.destination = worker.fallbackUsed ? ResultDestination.FALLBACK : ResultDestination.CURRENT_CONTEXT;
      worker.contributedToSealedContext = true;
      this.turn.gather.completedWorkers.push(worker.id);
    }
    this.recomputeGather();
    this.emit(Wave3Signals.COPROCESSOR_TELEMETRY_CHANGED, {
      turnId: this.turn.turnId,
      workerId: worker.id,
      state: worker.state,
      freshness: worker.freshness,
      retryCount: worker.retryCount,
      validationResult: worker.validationResult,
      cacheWarmHit: worker.cacheWarmHit,
      fallbackUsed: worker.fallbackUsed,
      destination: worker.destination,
      contributedToSealedContext: worker.contributedToSealedContext,
    });
    this.emit(Wave2Signals.GATHER_STATE_CHANGED, { turnId: this.turn.turnId, gather: clone(this.turn.gather) });
    return clone(worker);
  }

  satisfyTruthWithFallback() {
    if (!this.turn) this.createTurnEvent();
    const truth = this.turn.workers.find((worker) => worker.id === 'truth-precision');
    truth.state = RuntimeStatus.YIELDING;
    truth.fallbackUsed = true;
    truth.validationResult = 'DEADLINE_MISS_FALLBACK';
    truth.destination = ResultDestination.FALLBACK;
    truth.contributedToSealedContext = true;
    this.turn.gather.fallbackSatisfied.push(truth.id);
    this.turn.gather.completedWorkers.push(truth.id);
    this.recomputeGather();
    this.emit(Wave3Signals.PRECISION_FALLBACK_CHANGED, { turnId: this.turn.turnId, workerId: truth.id, fallbackType: 'deterministic fused ranking', destination: ResultDestination.FALLBACK });
    this.emit(Wave2Signals.GATHER_STATE_CHANGED, { turnId: this.turn.turnId, gather: clone(this.turn.gather) });
    return clone(truth);
  }

  dedupeWorkerResult(workerId = 'historian') {
    if (!this.turn) return null;
    this.turn.gather.duplicateResults += 1;
    this.emit(Wave3Signals.COPROCESSOR_DEDUPE_EVENT, { turnId: this.turn.turnId, workerId, dedupeKey: `${this.turn.turnId}:${workerId}`, action: 'ignored-duplicate' });
    return this.turn.gather.duplicateResults;
  }

  sealTurn() {
    if (!this.turn?.gather.foregroundQuorum) throw new Error('foreground quorum not satisfied');
    this.turn.gather.state = 'CLOSED';
    this.turn.gather.contextSeal = ContextSealState.SEALED;
    this.turn.timeline.push({ stage: 'quorum', at: this.tick(), lane: ResultDestination.CURRENT_CONTEXT });
    this.turn.timeline.push({ stage: 'compiler', at: this.tick(), lane: ResultDestination.CURRENT_CONTEXT });
    this.turn.timeline.push({ stage: 'CONTEXT SEALED', at: this.tick(), lane: ResultDestination.CURRENT_CONTEXT });
    this.turn.timeline.push({ stage: 'Main', at: this.tick(), lane: ResultDestination.CURRENT_CONTEXT });
    this.emit(Wave2Signals.CONTEXT_SEAL_CHANGED, { turnId: this.turn.turnId, state: ContextSealState.SEALED });
    return clone(this.turn.gather);
  }

  getCoprocessorTelemetry(turnId = this.turn?.turnId) {
    if (!this.turn || this.turn.turnId !== turnId) return null;
    return clone({
      turnId: this.turn.turnId,
      correlationId: this.turn.correlationId,
      workers: this.turn.workers.map(({ rawPayload, ...worker }) => worker),
      gather: this.turn.gather,
      timeline: this.turn.timeline,
    });
  }

  getWorkerTelemetryDetail(workerId) {
    this.detailReads.coprocessor += 1;
    const worker = this.turn?.workers.find((item) => item.id === workerId);
    return clone(worker ?? null);
  }

  getDebugArtifact(ref) {
    this.detailReads.debug += 1;
    return clone(this.debugArtifacts.get(ref) ?? { ref, explicit: true, payload: 'debug payload intentionally loaded on demand' });
  }

  recomputeGather() {
    const gather = this.turn.gather;
    gather.completedWorkers = [...new Set(gather.completedWorkers)];
    gather.requiredMissing = gather.requiredWorkers.filter((id) => !gather.completedWorkers.includes(id));
    gather.foregroundQuorum = gather.requiredMissing.length === 0;
    if (gather.foregroundQuorum && gather.contextSeal === ContextSealState.OPEN) gather.contextSeal = ContextSealState.QUORUM;
  }

  runAcceptanceScenario() {
    const result = [];
    result.push({ step: 1, scene: this.getCurrentScene() });
    result.push({ step: 2, query: 'Eris asks where the Sun Blade is.' });
    result.push({ step: 3, retrieved: this.getCandidatesPage({ offset: 0, limit: 4 }).items });
    result.push({ step: 4, truth: this.getCandidatesPage({ offset: 0, limit: 4 }).items.map((c) => ({ id: c.id, truth: c.truthClass })) });
    result.push({ step: 5, reranked: this.getCandidatesPage({ offset: 0, limit: 4 }).items.map((c) => ({ id: c.id, finalRank: c.finalRank })) });
    result.push({ step: 6, journal: this.getCandidateDetail('cand-journal-unresolved') });
    result.push({ step: 7, settlement: this.getSettlementTrace('sun-blade-state') });
    result.push({ step: 8, reflection: this.getReflections().find((r) => r.id === 'reflection-eris-mara') });
    result.push({ step: 9, turn: this.createTurnEvent() });
    result.push({ step: 10, runtime: this.getTelemetrySummary() });
    result.push({ step: 11, required: [this.completeWorker('historian'), this.completeWorker('graph')] });
    result.push({ step: 12, fallback: this.satisfyTruthWithFallback() });
    result.push({ step: 13, deadline: this.simulateRerankTimeout() });
    result.push({ step: 14, seal: this.sealTurn() });
    result.push({ step: 15, main: true });
    result.push({ step: 16, late: this.completeWorker('green-room', { destination: ResultDestination.BACKGROUND, executionLatencyMs: 190 }) });
    result.push({ step: 17, provenance: this.getMemoryRecord('sun-blade-state') });
    result.push({ step: 18, historical: this.getMemoryRecord('sun-blade-state').historicalStates });
    return result;
  }
}

export function createEmberTavernWave3AdapterBundle({ signals, stress = false } = {}) {
  const fixture = new EmberTavernWave3Fixture({ signals, stress });

  const scene = {
    kind: 'SceneUIAdapter',
    getCurrentScene: () => fixture.getCurrentScene(),
    getBoundaryState: () => fixture.getBoundaryState(),
    getSceneEpisode: (id) => fixture.getSceneEpisode(id),
    getSceneHistoryPage: (options) => page(fixture.episodes, options),
    getRelatedScenes: (id) => fixture.getRelatedScenes(id),
    subscribeSceneDeltas: (handler) => subscribeMany(signals, [Wave2Signals.SCENE_LOCATION_CHANGED, Wave2Signals.SCENE_ACTIVE_CAST_CHANGED, Wave2Signals.SCENE_TIME_SHIFT_DETECTED, Wave2Signals.SCENE_VIBE_CHANGED, Wave2Signals.SCENE_STATE_DELTA, Wave2Signals.SCENE_BOUNDARY_CHANGED, Wave2Signals.SCENE_EPISODE_CLOSED, Wave2Signals.SCENE_NAVIGATION_CHANGED], handler),
  };

  const runtime = {
    kind: 'RuntimeUIAdapter',
    getOverview: () => clone(fixture.runtimeOverview),
    getLifecyclePage: (options) => page(fixture.obligations, options),
    getWorkers: () => clone(fixture.workers.map(({ recoveryHistory, ...worker }) => worker)),
    getBatches: () => clone(fixture.batches),
    getLedgerPage: (options) => page(fixture.ledger.map(({ completedSlices, pendingSlices, dependencies, ...summary }) => summary), options),
    subscribeRuntime: (handler) => subscribeMany(signals, [Signals.WORKER_STATE_CHANGED, Signals.BATCH_PROGRESS_CHANGED, Wave2Signals.RUNTIME_BATCH_CHANGED, Wave3Signals.RUNTIME_QUEUE_DEPTH_CHANGED, Wave3Signals.RUNTIME_UTILIZATION_CHANGED, Wave3Signals.RUNTIME_CAPACITY_CHANGED, Wave3Signals.RUNTIME_RECOVERY_EVENT, Wave3Signals.WORK_LEDGER_TASK_CHANGED], handler),
    getTelemetrySummary: () => fixture.getTelemetrySummary(),
    getWorkerTelemetry: (id) => fixture.getWorkerTelemetry(id),
    getLedgerTaskDetail: (id) => fixture.getLedgerTaskDetail(id),
    getRecoveryPage: (options) => page(fixture.recoveryEvents, options),
  };

  const coprocessor = {
    kind: 'CoprocessorUIAdapter',
    getTurnSwarm: (turnId = fixture.turn?.turnId) => fixture.turn && (!turnId || turnId === fixture.turn.turnId) ? clone(fixture.turn) : null,
    getGather: (turnId = fixture.turn?.turnId) => fixture.turn && (!turnId || turnId === fixture.turn.turnId) ? clone(fixture.turn.gather) : null,
    getContextSealTimeline: (turnId = fixture.turn?.turnId) => fixture.turn && (!turnId || turnId === fixture.turn.turnId) ? clone(fixture.turn.timeline) : [],
    subscribeCoprocessor: (handler) => subscribeMany(signals, [Wave2Signals.TURN_EVENT_CREATED, Wave2Signals.GATHER_STATE_CHANGED, Wave2Signals.CONTEXT_SEAL_CHANGED, Wave3Signals.COPROCESSOR_TELEMETRY_CHANGED, Wave3Signals.COPROCESSOR_STALE_DROPPED, Wave3Signals.COPROCESSOR_DEDUPE_EVENT, Wave3Signals.PRECISION_FALLBACK_CHANGED], handler),
    getCoprocessorTelemetry: (turnId) => fixture.getCoprocessorTelemetry(turnId),
    getWorkerTelemetryDetail: (workerId) => fixture.getWorkerTelemetryDetail(workerId),
    getDebugArtifact: (ref) => fixture.getDebugArtifact(ref),
  };

  const knowledge = {
    kind: 'KnowledgeUIAdapter',
    inspectSource: (ref) => inspectKnowledge(fixture, ref, 'source'),
    inspectProvenance: (ref) => inspectKnowledge(fixture, ref, 'provenance'),
    inspectHistory: (ref) => inspectKnowledge(fixture, ref, 'history'),
    inspectDependencies: (ref) => inspectKnowledge(fixture, ref, 'dependencies'),
    inspectSettlement: (ref) => inspectKnowledge(fixture, ref, 'settlement'),
    inspectEvidence: (ref) => inspectKnowledge(fixture, ref, 'evidence'),
  };

  const memory = {
    kind: 'MemoryStateUIAdapter',
    getStateOverview: () => fixture.getStateOverview(),
    getMemoryRecord: (id) => fixture.getMemoryRecord(id),
    getSettlementTrace: (id) => fixture.getSettlementTrace(id),
    getReflections: () => fixture.getReflections(),
    getEpisodicChain: (id) => fixture.getEpisodicChain(id),
    subscribeMemory: (handler) => subscribeMany(signals, [Wave3Signals.MEMORY_STATE_CHANGED, Wave3Signals.SETTLEMENT_TRACE_CHANGED, Wave3Signals.REFLECTION_STATE_CHANGED], handler),
  };

  const precision = {
    kind: 'PrecisionUIAdapter',
    getPipeline: () => fixture.getPipeline(),
    getCandidateFunnel: () => fixture.getCandidateFunnel(),
    getCandidatesPage: (options) => fixture.getCandidatesPage(options),
    getCandidateDetail: (id) => fixture.getCandidateDetail(id),
    getIntentOppositeFixtures: () => fixture.getIntentOppositeFixtures(),
    getRuntimeBenchmarks: () => fixture.getRuntimeBenchmarks(),
    getDeadlineState: () => fixture.getDeadlineState(),
    subscribePrecision: (handler) => subscribeMany(signals, [Wave3Signals.CANDIDATE_FUNNEL_CHANGED, Wave3Signals.RERANK_PROGRESS_CHANGED, Wave3Signals.PRECISION_FALLBACK_CHANGED], handler),
  };

  return { fixture, adapters: createWave3AdapterBundle({ scene, runtime, coprocessor, knowledge, memory, precision }) };
}

export function createWave3StressFixtures() {
  const signals = { publish() { return null; }, subscribe() { return () => {}; } };
  const fixture = new EmberTavernWave3Fixture({ signals, stress: true });
  return Object.freeze({
    workers: fixture.workers,
    obligations: fixture.obligations,
    ledger: fixture.ledger,
    batches: fixture.batches,
    memory: fixture.memoryRecords,
    reflections: fixture.reflections,
    episodes: fixture.episodes,
    candidates: fixture.candidates,
    provenanceEdges: Array.from({ length: 16000 }, (_, i) => ({ from: `source-${i}`, to: `claim-${i % 311}`, relation: i % 3 === 0 ? 'CONTRADICTS' : 'SUPPORTS' })),
    staleResults: Array.from({ length: 600 }, (_, i) => ({ id: `stale-${i}`, destination: ResultDestination.STALE_DROPPED, freshness: 'STALE' })),
  });
}

function subscribeMany(signals, types, handler) {
  const releases = types.map((type) => signals.subscribe(type, handler));
  return () => releases.splice(0).forEach((release) => release());
}

function inspectKnowledge(fixture, ref, view) {
  const id = typeof ref === 'string' ? ref : ref?.id;
  const record = fixture.memoryRecords.find((item) => item.id === id) ?? fixture.episodes.find((item) => item.id === id) ?? { id, source: ref?.source, provenance: ref?.provenance ?? [], history: ref?.history ?? [], dependencies: ref?.dependencies ?? [] };
  const common = { kind: 'knowledge-inspection', view, id, label: record.label ?? record.title ?? id, readOnly: true };
  if (view === 'source') return { ...common, source: clone(record.source ?? record.rawEvidence ?? null) };
  if (view === 'provenance') return { ...common, provenance: clone(record.provenance ?? record.sourceEvidence ?? []) };
  if (view === 'history') return { ...common, history: clone(record.historicalStates ?? record.history ?? []) };
  if (view === 'dependencies') return { ...common, dependencies: clone(record.dependencies ?? record.invalidators ?? []) };
  if (view === 'settlement') return { ...common, settlement: clone(record.settlement ?? fixture.getSettlementTrace(id)), authority: 'owning-subsystem' };
  return { ...common, evidence: clone(record.evidence ?? record.provenance ?? []) };
}

function makeRuntimeOverview() {
  return { mode: 'HOT', hotActivity: 78, deepActivity: 42, utilization: { L0: 92, L1: 81, L2: 63, L3: 38, L4: 24 }, reservedForegroundCapacity: 35, borrowedBackgroundCapacity: 21, queueDepth: 17 };
}

function makeWorkers(count) {
  const roles = ['Historian','Graph Walker','Green Room','Truth/Precision','Reflection','Consolidation','Embedding','Study'];
  const states = [RuntimeStatus.ACTIVE, RuntimeStatus.YIELDING, RuntimeStatus.PARKED, RuntimeStatus.BLOCKED, RuntimeStatus.RECOVERING, RuntimeStatus.COMPLETE];
  return Array.from({ length: count }, (_, i) => ({
    id: `worker-${i}`,
    name: roles[i % roles.length],
    capabilityProfile: [roles[i % roles.length].toLowerCase().replaceAll('/','-').replaceAll(' ','-')],
    layer: `L${i % 5}`,
    cognitiveLayer: i < Math.ceil(count / 3) ? 'Hot' : 'Deep',
    currentTask: { id: `task-${i}`, label: i % 2 ? 'foreground assistance' : 'background obligation' },
    state: states[i % states.length],
    provider: i % 3 === 0 ? 'local' : i % 3 === 1 ? 'sidecar' : 'remote',
    model: i % 4 === 0 ? 'deterministic' : `profile-${i % 4}`,
    queueTimeMs: 3 + (i % 17) * 4,
    executionLatencyMs: 14 + (i % 29) * 7,
    recoveryHistory: i % 13 === 0 ? [{ reason: 'timeout', action: 'checkpoint-resume' }] : [],
  }));
}

function makeObligations(count) {
  return Array.from({ length: count }, (_, i) => ({
    id: `obligation-${i}`,
    kind: i % 4 === 0 ? 'CONSOLIDATE' : i % 4 === 1 ? 'REFLECT' : i % 4 === 2 ? 'INDEX' : 'RECONCILE',
    cognitiveLayer: `L${i % 5}`,
    state: i % 6 === 0 ? 'QUEUED' : i % 9 === 0 ? 'BLOCKED' : 'READY',
    assignedWorker: i % 6 === 0 ? null : `worker-${i % Math.min(count, 24)}`,
    sourceRevision: `S${40 + (i % 5)}`,
    worldRevision: `W${42 + (i % 3)}`,
    sceneRevision: `SC${10 + (i % 7)}`,
  }));
}

function makeBatches(count) {
  return Array.from({ length: count }, (_, i) => ({
    id: `batch-${i}`, totalUnits: 120 + i * 4, completedUnits: (i * 9) % (120 + i * 4), activeSlice: i * 3, nextSlice: i * 3 + 1, checkpoint: `cp-${i}-${i*3}`, adaptiveBatchSize: 8 + (i % 6) * 4, yieldRequested: i % 7 === 0, resumePoint: i * 3, deadlineState: i % 8 === 0 ? 'TIGHT' : 'NORMAL',
  }));
}

function makeLedger(count) {
  return Array.from({ length: count }, (_, i) => ({
    id: `task-${i}`,
    cognitiveLayer: `L${i % 5}`,
    sourceRevisionFence: `S${100 + (i % 11)}`,
    worldRevisionFence: `W${42 + (i % 4)}`,
    sceneRevisionFence: `SC${18 + (i % 5)}`,
    capabilityRequirements: [i % 2 ? 'retrieval' : 'reflection'],
    dependencies: i % 5 === 0 ? ['task-prior'] : [],
    completedSlices: Array.from({ length: i % 4 }, (_, s) => s),
    pendingSlices: Array.from({ length: (i % 5) + 1 }, (_, s) => s + (i % 4)),
    dedupeKey: `ledger:${i % 250}`,
    conflictKey: `entity:${i % 120}`,
    checkpoint: `ledger-cp-${i}`,
    lastResultReceipt: i % 3 === 0 ? `result-${i}` : null,
    recoveryState: i % 17 === 0 ? 'RECOVERING' : 'NONE',
    staleState: i % 23 === 0 ? 'SUPERSEDED' : 'CURRENT',
    state: i % 9 === 0 ? 'COMPLETE' : i % 11 === 0 ? 'BLOCKED' : 'QUEUED',
  }));
}

function makeRecoveryEvents(count) {
  return Array.from({ length: count }, (_, i) => ({ eventId: `recovery-${i}`, workerId: `worker-${i % 12}`, reason: i % 2 ? 'timeout' : 'provider-error', action: i % 3 ? 'resume-checkpoint' : 'fallback', fallback: i % 3 === 0 ? 'deterministic' : null, state: i % 3 === 0 ? 'RECOVERING' : 'COMPLETE' }));
}

function makeRuinsScene() {
  return {
    id: 'scene-ember-ruins', revision: 7, status: 'OPEN',
    location: { id: 'ember-tavern-ruins', name: 'Ruined Ember Tavern', epistemic: 'observed' },
    narrativeTime: 'Day 15 · Dawn',
    activeCast: [{ id: 'eris', name: 'Eris', epistemic: 'observed' }, { id: 'mara', name: 'Mara', epistemic: 'observed' }],
    immediateObjects: [{ id: 'sun-blade-remains', name: 'Destroyed Sun Blade remains', epistemic: 'observed' }],
    activeThreads: [{ id: 'sun-blade-question', text: 'Eris asks where the Sun Blade is.', state: 'ACTIVE', epistemic: 'observed' }],
    objectives: [{ id: 'search-ruins', text: 'Determine the Sun Blade state and history.', epistemic: 'observed' }],
    atmosphere: { label: 'ash, urgency, uncertainty', epistemic: 'inferred', confidence: 0.89 },
    unresolved: [{ id: 'journal-claim', text: 'A recovered journal suggests the blade may have been removed before the fire.', epistemic: 'unresolved' }],
    sourceEvidence: ['turn-120','FireEvent492','journal-17'],
    worldRevision: 44,
  };
}

function makeEpisodes(count) {
  const core = [
    { id:'episode-ember-intact', title:'Ember Tavern before the fire', status:'CLOSED', sourceTurnRange:{start:112,end:119}, participants:['Eris','Mara'], location:'Ember Tavern', narrativeTime:'Day 14 · Evening', events:['Eris leaves Sun Blade at tavern'], claims:['claim-blade-at-tavern'], stateChanges:['Eris carries Sun Blade -> false'], atmosphereTrajectory:['warm','uneasy','departing'], provenance:['turn-112..119','source-ember-tavern','source-sun-blade'] },
    { id:'episode-fire', title:'FireEvent492', status:'CLOSED', sourceTurnRange:{start:119,end:120}, participants:[], location:'Ember Tavern', narrativeTime:'Night', events:['Tavern destroyed','Sun Blade destroyed'], claims:['claim-tavern-destroyed','claim-blade-destroyed'], stateChanges:['Tavern intact -> destroyed','Sun Blade intact -> destroyed'], atmosphereTrajectory:['calm','catastrophic'], provenance:['FireEvent492'] },
  ];
  return core.concat(Array.from({ length: Math.max(0, count - core.length) }, (_, i) => ({ id:`episode-${i+3}`, title:`Historical episode ${i+3}`, status:'CLOSED', sourceTurnRange:{start:i*2,end:i*2+1}, participants:[i%2?'Eris':'Mara'], location:`Location ${i%25}`, narrativeTime:`T-${i}`, events:[`event-${i}`], claims:[], stateChanges:[], atmosphereTrajectory:['neutral'], provenance:[`turn-${i*2}..${i*2+1}`] })));
}

function makeRelations() {
  return [
    { from:'episode-ember-intact',to:'episode-fire',relation:SceneRelation.PRECEDES },
    { from:'episode-ember-intact',to:'scene-ember-ruins',relation:SceneRelation.CONTINUES },
    { from:'episode-fire',to:'scene-ember-ruins',relation:SceneRelation.PRECEDES },
  ];
}

function makeMemoryRecords(count) {
  const core = [
    {
      id:'sun-blade-state', label:'Sun Blade state', authorityClass:'SETTLED', sourceRevision:'S19', worldRevision:'W44',
      source:{ id:'source-sun-blade', text:'The Sun Blade was carried by Eris before being left at Ember Tavern.', immutable:true },
      derivedClaim:{ id:'claim-blade-at-tavern', text:'Sun Blade was located at Ember Tavern before the fire.', authority:'OBSERVED' },
      proposal:{ id:'proposal-blade-destroyed', type:'SET_STATE', proposer:'Graph/Truth worker', requestedMutation:'SunBlade.state = destroyed', evidence:['FireEvent492'], revisionFences:{world:'W43',scene:'SC19'} },
      settlement:{ receiptId:'settlement-204', owner:'Settlement Engine / Temporal State owner', outcome:'ACCEPTED', authorityClass:'SETTLED', revision:'W44' },
      currentState:{ id:'claim-blade-destroyed', text:'Sun Blade is destroyed.', status:TruthClass.CURRENT, validFrom:'FireEvent492', validUntil:null },
      historicalStates:[{ id:'claim-blade-carried', text:'Eris carried the Sun Blade.', status:TruthClass.HISTORICAL, validUntil:'turn-118' },{ id:'claim-blade-at-tavern', text:'Sun Blade was at Ember Tavern.', status:TruthClass.HISTORICAL, validUntil:'FireEvent492' }],
      unresolvedEvidence:[{ id:'journal-17', text:'Recovered journal suggests pre-fire removal.', status:TruthClass.UNRESOLVED }],
      provenance:['source-sun-blade','turn-112..119','FireEvent492','settlement-204'],
      dependencies:['source-sun-blade','FireEvent492'],
      invalidators:['source revision change','settlement supersession'],
    },
    {
      id:'ember-tavern-state', label:'Ember Tavern structural state', authorityClass:'SETTLED', sourceRevision:'S8', worldRevision:'W44',
      source:{ id:'source-ember-tavern', text:'A warm intact tavern with a central hearth.', immutable:true },
      derivedClaim:{ id:'claim-tavern-intact', text:'Ember Tavern was intact.', authority:'SOURCE_CANON' },
      proposal:{ id:'proposal-fire-492', type:'SET_STATE', proposer:'Narrative extractor', requestedMutation:'EmberTavern.structural_state = destroyed', evidence:['FireEvent492'], revisionFences:{world:'W43',scene:'SC19'} },
      settlement:{ receiptId:'settlement-203', owner:'Settlement Engine / Temporal State owner', outcome:'ACCEPTED', authorityClass:'OBSERVED', revision:'W44' },
      currentState:{ id:'claim-tavern-destroyed', text:'Ember Tavern is destroyed.', status:TruthClass.CURRENT, validFrom:'FireEvent492', validUntil:null },
      historicalStates:[{ id:'claim-tavern-intact', text:'Ember Tavern was intact.', status:TruthClass.HISTORICAL, validFrom:'T0', validUntil:'FireEvent492' }],
      unresolvedEvidence:[],
      provenance:['source-ember-tavern','FireEvent492','settlement-203'],
      dependencies:['source-ember-tavern','FireEvent492'],
      invalidators:['source revision change','fire event correction'],
    },
  ];
  return core.concat(Array.from({ length: Math.max(0, count - core.length) }, (_, i) => ({ id:`memory-${i}`, label:`Memory record ${i}`, authorityClass:i%4===0?'INFERRED':'OBSERVED', sourceRevision:`S${i}`, worldRevision:`W${40+i%5}`, source:{id:`source-${i}`,text:`Source ${i}`,immutable:true}, derivedClaim:{id:`claim-${i}`,text:`Derived claim ${i}`}, proposal:null, settlement:null, currentState:{id:`state-${i}`,text:`Current state ${i}`,status:i%9===0?TruthClass.UNRESOLVED:TruthClass.CURRENT}, historicalStates:i%3===0?[{id:`history-${i}`,text:`Historical state ${i}`,status:TruthClass.HISTORICAL}]:[], unresolvedEvidence:i%9===0?[{id:`uncertain-${i}`,status:TruthClass.UNRESOLVED}]:[], provenance:[`source-${i}`], dependencies:[], invalidators:[] })));
}

function makeSettlementTraces(count) {
  const core = [
    { id:'settlement-sun-blade', recordId:'sun-blade-state', proposalId:'proposal-blade-destroyed', proposalType:'SET_STATE', proposer:'Graph/Truth worker', requestedMutation:'SunBlade.state = destroyed', evidenceReferences:['FireEvent492'], revisionFences:{source:'S19',world:'W43',scene:'SC19'}, authorityClass:'OBSERVED', stages:[{name:'evidence',status:'PASS'},{name:'worker proposal',status:'PASS'},{name:'schema validation',status:'PASS'},{name:'evidence validation',status:'PASS'},{name:'freshness validation',status:'PASS'},{name:'Settlement',status:'ACCEPTED'},{name:'Temporal State',status:'CURRENT'}], settlementOwner:'Settlement Engine / Temporal State owner', settlementOutcome:'ACCEPTED', resultingClaims:{current:['claim-blade-destroyed'],historical:['claim-blade-carried','claim-blade-at-tavern'],unresolved:['journal-17']} },
  ];
  return core.concat(Array.from({ length: Math.max(0, count - core.length) }, (_, i) => ({ id:`settlement-${i}`, recordId:`memory-${i}`, proposalId:`proposal-${i}`, proposalType:'SET_STATE', proposer:'fixture-worker', requestedMutation:`state-${i}`, evidenceReferences:[`source-${i}`], revisionFences:{source:`S${i}`,world:`W${i}`}, authorityClass:'OBSERVED', stages:[{name:'schema validation',status:'PASS'},{name:'Settlement',status:i%10===0?'REJECTED':'ACCEPTED'}], settlementOwner:'owner', settlementOutcome:i%10===0?'REJECTED':'ACCEPTED', resultingClaims:{} })));
}

function makeReflections(count) {
  const core = [{ id:'reflection-eris-mara', subject:'Eris ↔ Mara', pattern:'Mara appears increasingly cautious about Eris after the Sun Blade dispute.', authority:'INFERRED', confidence:0.74, supportingEvidence:['episode-ember-intact','turn-117','turn-118'], contradictingEvidence:[], sourceRevision:'S21', worldRevision:'W44', status:'SUPPORTED', history:[{action:'strengthen',from:0.58,to:0.74,revision:44}], supersedes:[], invalidators:['support removal','contradictory episode','source revision'] }];
  return core.concat(Array.from({ length: Math.max(0, count - 1) }, (_, i) => ({ id:`reflection-${i}`, subject:`Subject ${i}`, pattern:`Pattern ${i}`, authority:'INFERRED', confidence:Number((0.4+(i%50)/100).toFixed(2)), supportingEvidence:[`episode-${i%20}`], contradictingEvidence:[], sourceRevision:`S${i}`, worldRevision:`W${40+i%5}`, status:'SUPPORTED', history:[], supersedes:[], invalidators:[] })));
}

function makeEpisodicChains() {
  return [{ id:'episode-ember-intact', rawEvidence:['turn-112','turn-113','turn-118','turn-119'], episode:'episode-ember-intact', claims:['claim-blade-at-tavern','claim-tavern-intact'], stateTransitions:['Eris carries Sun Blade -> false'], reflection:'reflection-eris-mara', retrievalCandidate:'cand-historical-tavern', provenance:['turn-112..119','episode-ember-intact','reflection-eris-mara','cand-historical-tavern'] }];
}

function makePrecisionPipeline() {
  return { stages:['Scene Query','broad retrieval','Candidate Bus','Truth Gate','cheap pruning','Precision Reranker','optional semantic judge','Context Compiler'], principle:'relevance is not truth; high recall occurs before expensive precision' };
}

function makeCandidateFunnel(total) {
  const retrieved = Math.min(total, 120);
  return { adaptiveCandidateBudget: Math.min(12, Math.max(5, Math.ceil(retrieved / 6))), budgetReason:'ambiguous state-aware query', tokenBudget:4096, stages:{retrieved,'truth-valid':Math.max(4,Math.floor(retrieved*0.66)),'cheap-pruned':Math.max(4,Math.floor(retrieved*0.34)),reranked:Math.max(4,Math.floor(retrieved*0.18)),admitted:4} };
}

function makeCandidates(count) {
  const core = [
    { id:'cand-current-destroyed', sourceChannel:'temporal-graph', text:'Sun Blade is destroyed after FireEvent492.', truthClass:TruthClass.CURRENT, preRerankFusedScore:0.82, rawRerankerScore:7.8, normalizedScore:0.97, finalRank:1, modelProfileId:'precision-local-v1', runtime:'implementation-neutral/local', precisionMode:'cross-encoder-compatible', candidateBudget:8, tokenBudget:4096, truncationApplied:false, latencyMs:21, freshness:'FRESH', fallbackState:'NONE', admitted:true, provenance:['FireEvent492','settlement-204'] },
    { id:'cand-journal-unresolved', sourceChannel:'episode/journal', text:'Recovered journal suggests the Sun Blade may have been removed before the fire.', truthClass:TruthClass.UNRESOLVED, preRerankFusedScore:0.77, rawRerankerScore:6.5, normalizedScore:0.79, finalRank:2, modelProfileId:'precision-local-v1', runtime:'implementation-neutral/local', precisionMode:'cross-encoder-compatible', candidateBudget:8, tokenBudget:4096, truncationApplied:false, latencyMs:22, freshness:'FRESH', fallbackState:'NONE', admitted:true, provenance:['journal-17'] },
    { id:'cand-historical-tavern', sourceChannel:'episode', text:'Sun Blade was left at Ember Tavern before the fire.', truthClass:TruthClass.HISTORICAL, preRerankFusedScore:0.93, rawRerankerScore:4.1, normalizedScore:0.48, finalRank:3, modelProfileId:'precision-local-v1', runtime:'implementation-neutral/local', precisionMode:'cross-encoder-compatible', candidateBudget:8, tokenBudget:4096, truncationApplied:false, latencyMs:18, freshness:'FRESH', fallbackState:'NONE', admitted:true, provenance:['episode-ember-intact'] },
    { id:'cand-historical-carried', sourceChannel:'raw-experience', text:'Eris carried the Sun Blade.', truthClass:TruthClass.HISTORICAL, preRerankFusedScore:0.91, rawRerankerScore:2.7, normalizedScore:0.31, finalRank:4, modelProfileId:'precision-local-v1', runtime:'implementation-neutral/local', precisionMode:'cross-encoder-compatible', candidateBudget:8, tokenBudget:4096, truncationApplied:false, latencyMs:17, freshness:'FRESH', fallbackState:'NONE', admitted:false, provenance:['turn-112'] },
  ];
  return core.concat(Array.from({ length: Math.max(0, count - core.length) }, (_, i) => ({ id:`cand-${i+5}`, sourceChannel:i%3===0?'dense':i%3===1?'sparse':'graph', text:`Candidate evidence ${i+5}`, truthClass:i%17===0?TruthClass.CONTRADICTED:i%11===0?TruthClass.SUPERSEDED:TruthClass.CURRENT, preRerankFusedScore:Number((0.3+(i%60)/100).toFixed(2)), rawRerankerScore:Number((1+(i%80)/10).toFixed(2)), normalizedScore:Number(((i%100)/100).toFixed(2)), finalRank:i+5, modelProfileId:'precision-local-v1', runtime:'implementation-neutral/local', precisionMode:'rerank', candidateBudget:12, tokenBudget:4096, truncationApplied:i%13===0, latencyMs:10+(i%45), freshness:i%29===0?'STALE':'FRESH', fallbackState:'NONE', admitted:false, provenance:[`source-${i}`] })));
}

function makeIntentOpposites() {
  return [
    ['kill dragon','heal dragon'],['enter dungeon','leave dungeon'],['trust Mara','distrust Mara'],['weapon intact','weapon destroyed'],['character present','character departed'],['current Tavern description','historical Tavern description'],
  ].map(([wanted,opposite],i)=>({ id:`opposite-${i}`, query:wanted, semanticallySimilarWrong:opposite, fusedScores:{wanted:0.84,wrong:0.82}, rerankScores:{wanted:0.95,wrong:0.18}, winner:wanted, reason:'joint intent/temporal precision separates semantic near-neighbor' }));
}

function makeRuntimeBenchmarks() {
  return [
    { profileId:'cpu-int8-a', precision:'INT8', device:'CPU', runtime:'implementation-neutral', modelLoadMs:180, coldLatencyMs:52, warmLatencyMs:19, p50Ms:20, p95Ms:31, candidatesPerSec:430, ramMb:220, vramMb:0, batchSize:16, rankStability:0.98, fallbackBehavior:'deterministic fused ranking' },
    { profileId:'cpu-fp32-b', precision:'FP32', device:'CPU', runtime:'implementation-neutral', modelLoadMs:360, coldLatencyMs:88, warmLatencyMs:37, p50Ms:39, p95Ms:58, candidatesPerSec:210, ramMb:610, vramMb:0, batchSize:12, rankStability:1.0, fallbackBehavior:'deterministic fused ranking' },
    { profileId:'gpu-fp16-c', precision:'FP16', device:'GPU', runtime:'implementation-neutral', modelLoadMs:410, coldLatencyMs:41, warmLatencyMs:11, p50Ms:12, p95Ms:19, candidatesPerSec:760, ramMb:240, vramMb:680, batchSize:32, rankStability:0.99, fallbackBehavior:'CPU or fused ranking' },
  ];
}

function makeDeadlineState() {
  return { runId:'rerank-ember-1', state:'OPEN', deadlineMs:120, rerankerState:'RUNNING', fallbackActive:false, fallbackType:null, gatherQuorum:false, contextSeal:ContextSealState.OPEN, mainProceeding:false, lateDestination:null };
}

function makeTurn(clock) {
  const workers = [
    makeCoprocessorWorker('historian','Historian',ResultClass.REQUIRED,'L1',['retrieval','episodes']),
    makeCoprocessorWorker('graph','Graph Walker',ResultClass.REQUIRED,'L1',['graph','state']),
    makeCoprocessorWorker('green-room','Green Room',ResultClass.OPPORTUNISTIC,'L1',['affect','intent']),
    makeCoprocessorWorker('truth-precision','Truth/Precision',ResultClass.REQUIRED,'L1',['truth','rerank']),
  ];
  return {
    turnId:'TURN-W3-EMBER-001', correlationId:'corr-w3-ember-001', deadline:clock+120,
    workers,
    gather:{ expectedWorkers:4, completedWorkers:[], requiredWorkers:['historian','graph','truth-precision'], requiredMissing:['historian','graph','truth-precision'], foregroundQuorum:false, deadline:clock+120, fallbackSatisfied:[], staleRejected:[], duplicateResults:0, contextSeal:ContextSealState.OPEN, lateResults:[], state:'OPEN' },
    timeline:[{stage:'TURN_EVENT',at:clock,lane:ResultDestination.CURRENT_CONTEXT},{stage:'fan-out',at:clock+1,lane:ResultDestination.CURRENT_CONTEXT}],
  };
}

function makeCoprocessorWorker(id,name,resultClass,layer,capabilities) {
  return { id,name,capabilities,cognitiveLayer:layer,resultClass,currentTask:'turn cognition',state:RuntimeStatus.ACTIVE,queueDelayMs:4,executionLatencyMs:28,startedAt:null,completedAt:null,deadline:120,freshness:'PENDING',retryCount:0,validationResult:'PENDING',staleDrop:false,dedupeKey:`turn:${id}`,cacheWarmHit:id==='historian',fallbackUsed:false,destination:null,contributedToSealedContext:false,provider:'replaceable',modelProfile:'capability-routed',rawPayload:{hidden:'loaded only in explicit debug view'} };
}
