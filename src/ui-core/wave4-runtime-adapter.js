import { Signals } from './constants.js';
import { page } from './wave2-adapters.js';
import { Wave3Signals } from './wave3-adapters.js';
import { presentEventEnvelope } from './wave4-generic-inspection.js';

const KNOWN_RUNTIME_EVENTS = Object.freeze([
  'TURN_RECEIVED','GENERATION_STARTED','GENERATION_COMPLETED','SOURCE_CHANGED','SCENE_CHANGED','STATE_SETTLED','REFLECTION_CHANGED','CACHE_INVALIDATED',
  'WORK_ELIGIBLE','WORK_STARTED','WORK_YIELD_REQUESTED','WORK_YIELDING','WORK_BLOCKED','WORK_PARKED','WORK_RESUMED','WORK_COMPLETED','WORK_RECOVERING',
]);

export class RuntimeWave1UIAdapter {
  constructor(bridge = {}) {
    for (const method of ['snapshot','listLedger','listTelemetry']) {
      if (typeof bridge[method] !== 'function') throw new TypeError(`Runtime Wave 1 bridge requires ${method}()`);
    }
    this.bridge = bridge;
    this.kind = 'RuntimeUIAdapter';
  }

  getOverview() { return this.getTelemetrySummary(); }

  getTelemetrySummary() {
    const snapshot = this.bridge.snapshot();
    const lifecycle = snapshot.lifecycle ?? this.bridge.listLedger().map((record) => ({
      taskId: record.taskId,
      lifecycleStatus: record.lifecycleStatus,
      executionStatus: record.executionStatus,
      layer: record.obligation?.layer,
    }));
    const activeByLayer = { L0: 0, L1: 0, L2: 0, L3: 0, L4: 0 };
    for (const record of lifecycle) {
      if (['ACTIVE','YIELDING'].includes(record.executionStatus) && record.layer in activeByLayer) activeByLayer[record.layer] += 1;
    }
    const hot = activeByLayer.L0 + activeByLayer.L1;
    const deep = activeByLayer.L2 + activeByLayer.L3 + activeByLayer.L4;
    return {
      mode: snapshot.resources?.generationActive ? 'FOREGROUND GENERATION' : 'BACKGROUND / IDLE',
      hotActivity: hot,
      deepActivity: deep,
      utilization: activeByLayer,
      queueDepth: clone(snapshot.queueDepth ?? {}),
      reservedForegroundCapacity: clone(snapshot.resources?.foregroundReserve ?? {}),
      borrowedBackgroundCapacity: snapshot.resources?.borrowedBackgroundLeases ?? 0,
      borrowedBackgroundLeases: snapshot.resources?.borrowedBackgroundLeases ?? 0,
      resourceUsage: clone(snapshot.resources?.usage ?? {}),
      resourceCapacity: clone(snapshot.resources?.capacity ?? {}),
      activeWorkerCount: (snapshot.workers ?? []).filter((worker) => (worker.currentLoad ?? 0) > 0).length,
      parkedWorkerCount: lifecycle.filter((record) => record.executionStatus === 'PARKED').length,
      queuedObligations: lifecycle.filter((record) => ['PENDING','ELIGIBLE'].includes(record.lifecycleStatus) && ['QUEUED','BLOCKED','PARKED','RECOVERING'].includes(record.executionStatus)).length,
      blockedRecoveringWork: lifecycle.filter((record) => ['BLOCKED','RECOVERING'].includes(record.executionStatus)).length,
      activeBatches: this.bridge.listLedger().filter((record) => record.batch && record.lifecycleStatus === 'ELIGIBLE').length,
      foregroundDeadlineState: deriveDeadlineState(this.bridge.listLedger()),
      telemetry: clone(snapshot.telemetry ?? {}),
    };
  }

  getLifecyclePage(options) {
    return page(this.bridge.listLedger().map((record) => ({
      id: record.taskId,
      taskId: record.taskId,
      taskType: record.obligation?.taskType,
      cognitiveLayer: record.obligation?.layer,
      lifecycleStatus: record.lifecycleStatus,
      executionStatus: record.executionStatus,
      state: record.lifecycleStatus,
      assignedWorker: null,
      sourceRevisions: clone(record.obligation?.sourceRevisions ?? {}),
      worldRevision: record.obligation?.worldRevision ?? null,
      sceneRevision: record.obligation?.sceneRevision ?? null,
      yieldRequested: Boolean(record.yieldRequested),
      recoveryState: record.recoveryState ?? null,
    })), options);
  }

  getWorkers() {
    return clone((this.bridge.snapshot().workers ?? []).map((worker) => ({
      id: worker.workerId,
      workerId: worker.workerId,
      name: worker.workerId,
      capabilityProfile: [...(worker.capabilities ?? [])],
      capabilities: [...(worker.capabilities ?? [])],
      supportedLayers: [...(worker.supportedLayers ?? [])],
      layer: (worker.supportedLayers ?? []).join('/'),
      cognitiveLayer: (worker.supportedLayers ?? []).join('/'),
      currentTask: null,
      state: worker.available === false ? 'UNAVAILABLE' : worker.health === 'healthy' ? 'AVAILABLE' : 'DEGRADED',
      provider: worker.provider ?? null,
      model: worker.model ?? null,
      queueTimeMs: null,
      executionLatencyMs: worker.latencyScore ?? null,
      currentLoad: worker.currentLoad ?? 0,
      concurrencyCapacity: worker.concurrencyCapacity ?? 1,
      health: worker.health ?? null,
      available: worker.available ?? true,
      resourceProfile: clone(worker.resourceProfile ?? {}),
    })));
  }

  getBatches() {
    return clone(this.bridge.listLedger().filter((record) => record.batch).map((record) => mapBatch(record)));
  }

  getLedgerPage(options) {
    return page(this.bridge.listLedger().map((record) => ({
      id: record.taskId,
      taskId: record.taskId,
      taskType: record.obligation?.taskType,
      cognitiveLayer: record.obligation?.layer,
      lifecycleStatus: record.lifecycleStatus,
      executionStatus: record.executionStatus,
      state: record.executionStatus,
      staleState: record.supersession?.requested ? 'SUPERSEDED_REQUESTED' : 'CURRENT',
      checkpoint: record.checkpoint ? { afterSliceId: record.checkpoint.afterSliceId, sequence: record.checkpoint.sequence } : null,
      retryAttempts: record.retryState?.attempts ?? 0,
      recoveryState: record.recoveryState ?? null,
      updatedSequence: record.updatedSequence ?? null,
    })), options);
  }

  getLedgerTaskDetail(taskId) {
    const record = this.bridge.listLedger().find((item) => item.taskId === taskId);
    if (!record) return null;
    const completedSliceIds = record.batch?.completedSliceIds ?? [];
    const allUnitIds = record.batch?.units?.map((unit) => unit.id) ?? [];
    const completedUnitIds = record.batch?.completedUnitIds ?? [];
    const completedSet = new Set(completedUnitIds);
    return clone({
      id: record.taskId,
      taskId: record.taskId,
      taskType: record.obligation?.taskType,
      layer: record.obligation?.layer,
      owner: record.obligation?.owner,
      lifecycleStatus: record.lifecycleStatus,
      executionStatus: record.executionStatus,
      sourceRevisions: record.obligation?.sourceRevisions ?? {},
      worldRevision: record.obligation?.worldRevision ?? null,
      sceneRevision: record.obligation?.sceneRevision ?? null,
      dependencies: record.dependencies ?? record.obligation?.dependencies ?? [],
      requiredCapabilities: record.obligation?.requiredCapabilities ?? [],
      resourceClass: record.obligation?.resourceClass ?? null,
      completedSlices: completedSliceIds,
      pendingSlices: record.batch?.activeSlice ? [record.batch.activeSlice] : [],
      completedUnitIds,
      pendingUnitIds: allUnitIds.filter((id) => !completedSet.has(id)),
      activeSlice: record.batch?.activeSlice ?? null,
      validationState: record.batch?.validationState ?? null,
      adaptiveBatchSize: record.batch?.adaptiveBatchSize ?? null,
      checkpoint: record.checkpoint ?? null,
      retryState: record.retryState ?? { attempts: 0, failures: [] },
      recoveryState: record.recoveryState ?? null,
      yieldRequested: Boolean(record.yieldRequested),
      dedupeKey: record.obligation?.dedupeKey ?? null,
      conflictKey: record.obligation?.conflictKey ?? null,
      supersession: record.supersession ?? null,
      receipts: record.resultReceipts ?? [],
      createdSequence: record.createdSequence ?? null,
      updatedSequence: record.updatedSequence ?? null,
    });
  }

  getWorkerTelemetry(workerId) {
    return this.getWorkers().find((worker) => worker.id === workerId) ?? null;
  }

  getRecoveryPage(options) {
    const signals = this.bridge.listTelemetry().filter((signal) => ['WORK_RECOVERING','WORK_BLOCKED','BACKPRESSURE_REJECTED'].includes(signal.type));
    return page(signals.map((signal) => ({
      eventId: signal.id,
      workerId: signal.workerId ?? null,
      taskId: signal.taskId ?? null,
      reason: signal.reason ?? signal.recoveryState ?? signal.type,
      action: signal.type,
      fallback: null,
      state: signal.type.replace('WORK_', ''),
      sequence: signal.sequence,
      checkpoint: clone(signal.checkpoint ?? null),
    })), options);
  }

  getEventPage(options) {
    return page(clone(this.bridge.listEvents?.() ?? []), options);
  }

  presentEvent(event) {
    return presentEventEnvelope({ schemaVersion: '1.0.0', ...event }, { knownTypes: KNOWN_RUNTIME_EVENTS });
  }

  subscribeEvents(handler) {
    if (typeof this.bridge.subscribeEvent !== 'function') return () => {};
    return this.bridge.subscribeEvent('*', (event) => handler(this.presentEvent(event), event));
  }

  subscribeRuntime(handler) {
    const releases = [];
    if (typeof this.bridge.subscribeTelemetry === 'function') {
      releases.push(this.bridge.subscribeTelemetry((signal) => handler(translateTelemetry(signal))));
    }
    if (typeof this.bridge.subscribeEvent === 'function') {
      releases.push(this.bridge.subscribeEvent('*', (event) => handler({
        type: event.eventType,
        runtimeType: event.eventType,
        payload: clone(event),
        source: 'runtime-event-spine',
      })));
    }
    return () => releases.splice(0).forEach((release) => release?.());
  }
}

export class RuntimeWave1ContractFixture {
  constructor() {
    this.sequence = 0;
    this.telemetrySubscribers = new Set();
    this.eventSubscribers = new Map();
    this.telemetry = [];
    this.events = [];
    this.workers = [
      { workerId:'worker-lore', capabilities:['STRUCTURED_LLM'], supportedLayers:['L2','L3','L4'], resourceProfile:{CPU:1,STRUCTURED_LLM:1}, provider:'fixture', model:'runtime-wave1-contract', concurrencyCapacity:1, currentLoad:1, latencyScore:20, health:'healthy', available:true },
      { workerId:'worker-foreground', capabilities:['SEMANTIC_JUDGMENT'], supportedLayers:['L0','L1'], resourceProfile:{CPU:1}, provider:'fixture', model:'runtime-wave1-contract', concurrencyCapacity:1, currentLoad:0, latencyScore:8, health:'healthy', available:true },
    ];
    this.resources = { generationActive:false, capacity:{CPU:4,STRUCTURED_LLM:1}, foregroundReserve:{CPU:1}, usage:{CPU:1,STRUCTURED_LLM:1}, borrowedBackgroundLeases:1, activeLeases:1 };
    this.queueDepth = { L0:0,L1:0,L2:0,L3:0,L4:0 };
    this.records = [makeLoreStudyRecord(), makeForegroundRecord()];
  }

  bridge() {
    return {
      snapshot: () => this.snapshot(),
      listLedger: () => clone(this.records),
      listTelemetry: () => clone(this.telemetry),
      listEvents: () => clone(this.events),
      subscribeTelemetry: (handler) => {
        this.telemetrySubscribers.add(handler);
        return () => this.telemetrySubscribers.delete(handler);
      },
      subscribeEvent: (type, handler) => {
        if (!this.eventSubscribers.has(type)) this.eventSubscribers.set(type, new Set());
        this.eventSubscribers.get(type).add(handler);
        return () => this.eventSubscribers.get(type)?.delete(handler);
      },
    };
  }

  snapshot() {
    return clone({
      lifecycle: this.records.map((record) => ({ taskId: record.taskId, lifecycleStatus: record.lifecycleStatus, executionStatus: record.executionStatus, layer: record.obligation.layer })),
      queueDepth: this.queueDepth,
      resources: this.resources,
      workers: this.workers,
      telemetry: { retainedSignals: this.telemetry.length, sinkFailures:0, latestSequence:this.sequence },
    });
  }

  runAcceptanceScenario() {
    const states = [];
    const lore = this.records.find((record) => record.taskId === 'task-lore-study');
    const foreground = this.records.find((record) => record.taskId === 'task-foreground');
    states.push(this.#state('L3 ACTIVE'));
    this.resources.generationActive = true;
    this.#event('GENERATION_STARTED', {}, { correlationId:'generation-1' });
    lore.yieldRequested = true;
    lore.executionStatus = 'YIELDING';
    this.#telemetry('WORK_YIELD_REQUESTED', { taskId:lore.taskId, reason:'foreground-demand' });
    this.#telemetry('WORK_YIELDING', { taskId:lore.taskId, reason:'foreground-demand' });
    this.#event('WORK_YIELD_REQUESTED', { reason:'foreground-demand' }, { taskId:lore.taskId });
    states.push(this.#state('yield requested / YIELDING'));
    lore.batch.completedUnitIds.push('lore-unit-2');
    lore.batch.completedSliceIds.push('batch:task-lore-study:lore-unit-2');
    lore.batch.activeSlice = null;
    lore.checkpoint = { afterSliceId:'batch:task-lore-study:lore-unit-2', completedUnitIds:[...lore.batch.completedUnitIds], sequence:++this.sequence };
    this.#telemetry('BATCH_CHECKPOINT', { taskId:lore.taskId, sliceId:lore.checkpoint.afterSliceId, completedUnits:2, totalUnits:3, durationMs:18, adaptiveBatchSize:1 });
    states.push(this.#state('checkpoint committed'));
    lore.executionStatus = 'PARKED';
    this.workers[0].currentLoad = 0;
    this.resources.usage = {};
    this.resources.borrowedBackgroundLeases = 0;
    this.resources.activeLeases = 0;
    this.#telemetry('WORK_PARKED', { taskId:lore.taskId, checkpoint:lore.checkpoint });
    this.#event('WORK_PARKED', { checkpoint:lore.checkpoint }, { taskId:lore.taskId });
    states.push(this.#state('L3 PARKED lifecycle persists'));
    foreground.lifecycleStatus = 'ELIGIBLE';
    foreground.obligation.lifecycleStatus = 'ELIGIBLE';
    foreground.executionStatus = 'ACTIVE';
    this.workers[1].currentLoad = 1;
    this.resources.usage = { CPU:1 };
    this.resources.activeLeases = 1;
    this.#telemetry('WORK_STARTED', { taskId:foreground.taskId, workerId:'worker-foreground', layer:'L1' });
    this.#event('WORK_STARTED', { workerId:'worker-foreground' }, { taskId:foreground.taskId });
    states.push(this.#state('L1 foreground ACTIVE'));
    foreground.executionStatus = 'COMPLETE';
    foreground.lifecycleStatus = 'SATISFIED';
    foreground.obligation.lifecycleStatus = 'SATISFIED';
    this.workers[1].currentLoad = 0;
    this.resources.usage = {};
    this.resources.activeLeases = 0;
    this.#telemetry('WORK_COMPLETED', { taskId:foreground.taskId });
    this.#event('WORK_COMPLETED', {}, { taskId:foreground.taskId });
    this.resources.generationActive = false;
    this.#event('GENERATION_COMPLETED', {}, { correlationId:'generation-1' });
    states.push(this.#state('generation complete'));
    lore.yieldRequested = false;
    lore.executionStatus = 'ACTIVE';
    lore.resumeCount += 1;
    this.workers[0].currentLoad = 1;
    this.resources.usage = { CPU:1, STRUCTURED_LLM:1 };
    this.resources.borrowedBackgroundLeases = 1;
    this.resources.activeLeases = 1;
    this.#telemetry('WORK_RESUMED', { taskId:lore.taskId, workerId:'worker-lore', layer:'L3' });
    this.#event('WORK_RESUMED', { workerId:'worker-lore' }, { taskId:lore.taskId });
    states.push(this.#state('L3 ACTIVE resumed next slice'));
    lore.batch.completedUnitIds.push('lore-unit-3');
    lore.batch.completedSliceIds.push('batch:task-lore-study:lore-unit-3');
    lore.checkpoint = { afterSliceId:'batch:task-lore-study:lore-unit-3', completedUnitIds:[...lore.batch.completedUnitIds], sequence:++this.sequence };
    this.#telemetry('BATCH_CHECKPOINT', { taskId:lore.taskId, sliceId:lore.checkpoint.afterSliceId, completedUnits:3, totalUnits:3, durationMs:16, adaptiveBatchSize:1 });
    lore.executionStatus = 'COMPLETE';
    lore.lifecycleStatus = 'SATISFIED';
    lore.obligation.lifecycleStatus = 'SATISFIED';
    this.workers[0].currentLoad = 0;
    this.resources.usage = {};
    this.resources.borrowedBackgroundLeases = 0;
    this.resources.activeLeases = 0;
    this.#telemetry('WORK_COMPLETED', { taskId:lore.taskId });
    this.#event('WORK_COMPLETED', {}, { taskId:lore.taskId });
    states.push(this.#state('COMPLETE'));
    return states;
  }

  emitUnknownEvent() {
    return this.#event('FUTURE_EXTENSION_EVENT', { subsystem:'future', detail:'safe generic envelope' }, { correlationId:'future-1', worldRevision:'W99' });
  }

  listenerCount() {
    let count = this.telemetrySubscribers.size;
    for (const set of this.eventSubscribers.values()) count += set.size;
    return count;
  }

  #state(label) {
    return { label, snapshot:this.snapshot(), ledger:clone(this.records) };
  }

  #telemetry(type, data) {
    const signal = Object.freeze({ id:`sig-${++this.sequence}`, type, sequence:this.sequence, ...clone(data) });
    this.telemetry.push(signal);
    for (const handler of [...this.telemetrySubscribers]) handler(signal);
    return signal;
  }

  #event(eventType, payload = {}, meta = {}) {
    const event = Object.freeze({
      eventId:`evt-${++this.sequence}`,
      eventType,
      causationId:meta.causationId ?? null,
      correlationId:meta.correlationId ?? null,
      turnId:meta.turnId ?? null,
      taskId:meta.taskId ?? null,
      sourceRevisions:clone(meta.sourceRevisions ?? {}),
      worldRevision:meta.worldRevision ?? null,
      sceneRevision:meta.sceneRevision ?? null,
      createdSequence:this.sequence,
      createdAt:this.sequence,
      dedupeKey:meta.dedupeKey ?? null,
      payload:clone(payload),
    });
    this.events.push(event);
    const handlers = [...(this.eventSubscribers.get(eventType) ?? []), ...(this.eventSubscribers.get('*') ?? [])];
    for (const handler of handlers) handler(event);
    return event;
  }
}

export function createRuntimeWave1AdapterFromFixture(fixture = new RuntimeWave1ContractFixture()) {
  return { fixture, adapter:new RuntimeWave1UIAdapter(fixture.bridge()) };
}

export function translateRuntimeTelemetry(signal) {
  if (!signal) return { type:'UNKNOWN_RUNTIME_SIGNAL', runtimeType:null, payload:{} };
  if (signal.type === 'QUEUE_DEPTH') return { type:Wave3Signals.RUNTIME_QUEUE_DEPTH_CHANGED, runtimeType:signal.type, payload:{ depthByLayer:clone(signal.depthByLayer ?? {}), depth:Object.values(signal.depthByLayer ?? {}).reduce((a,b)=>a+b,0) }, source:'runtime-telemetry' };
  if (signal.type === 'LAYER_UTILIZATION') return { type:Wave3Signals.RUNTIME_UTILIZATION_CHANGED, runtimeType:signal.type, payload:{ activeByLayer:clone(signal.activeByLayer ?? {}), queuedByLayer:clone(signal.queuedByLayer ?? {}) }, source:'runtime-telemetry' };
  if (signal.type === 'RESOURCE_UTILIZATION') return { type:Wave3Signals.RUNTIME_CAPACITY_CHANGED, runtimeType:signal.type, payload:{ usage:clone(signal.usage ?? {}), reservedForegroundCapacity:clone(signal.reservedForegroundCapacity ?? {}), borrowedBackgroundLeases:signal.borrowedBackgroundLeases ?? 0 }, source:'runtime-telemetry' };
  if (signal.type === 'BATCH_CHECKPOINT') return { type:Signals.BATCH_PROGRESS_CHANGED, runtimeType:signal.type, payload:{ taskId:signal.taskId, sliceId:signal.sliceId, completedUnits:signal.completedUnits, totalUnits:signal.totalUnits, durationMs:signal.durationMs, adaptiveBatchSize:signal.adaptiveBatchSize }, source:'runtime-telemetry' };
  if (['WORK_STARTED','WORK_RESUMED','WORK_YIELDING','WORK_PARKED','WORK_BLOCKED','WORK_RECOVERING','WORK_COMPLETED'].includes(signal.type)) {
    const state = signal.type.replace('WORK_', '').replace('STARTED','ACTIVE').replace('RESUMED','ACTIVE').replace('COMPLETED','COMPLETE');
    return { type:Signals.WORKER_STATE_CHANGED, runtimeType:signal.type, payload:{ taskId:signal.taskId ?? null, workerId:signal.workerId ?? null, layer:signal.layer ?? null, state, checkpoint:clone(signal.checkpoint ?? null), reason:signal.reason ?? null }, source:'runtime-telemetry' };
  }
  return { type:signal.type, runtimeType:signal.type, payload:clone(signal), source:'runtime-telemetry' };
}

function makeLoreStudyRecord() {
  return {
    taskId:'task-lore-study',
    obligation:{
      taskId:'task-lore-study', taskType:'LORE_STUDY', layer:'L3', owner:'Lore Study Engine',
      requiredCapabilities:['STRUCTURED_LLM'], resourceClass:'STRUCTURED_LLM',
      sourceRevisions:{ lore:'S44' }, worldRevision:'W44', sceneRevision:'SC21', revision:44,
      dependencies:[], priority:60, deadline:null, foreground:false, speculative:false,
      dedupeKey:'lore-study:S44', conflictKey:'lore-study', coalesceKey:'lore-study', coalescible:true,
      lifecycleStatus:'ELIGIBLE', payload:{ correlationId:'study-44' },
    },
    lifecycleStatus:'ELIGIBLE', executionStatus:'ACTIVE', executionReason:'started', dependencies:[],
    batch:{ batchId:'batch:task-lore-study', units:[{id:'lore-unit-1'},{id:'lore-unit-2'},{id:'lore-unit-3'}], completedUnitIds:['lore-unit-1'], completedSliceIds:['batch:task-lore-study:lore-unit-1'], activeSlice:{sliceId:'batch:task-lore-study:lore-unit-2',unitIds:['lore-unit-2'],size:1,phase:'EXECUTING'}, adaptiveBatchSize:1, batchPolicy:{}, retryState:{}, validationState:null },
    checkpoint:{ afterSliceId:'batch:task-lore-study:lore-unit-1', completedUnitIds:['lore-unit-1'], sequence:4 },
    resultReceipts:[{idempotencyKey:'task-lore-study:batch:task-lore-study:lore-unit-1',committed:true}],
    retryState:{attempts:0,failures:[]}, recoveryState:null, supersession:null, yieldRequested:false, startedCount:1, resumeCount:0, createdSequence:1, updatedSequence:4,
  };
}

function makeForegroundRecord() {
  return {
    taskId:'task-foreground',
    obligation:{
      taskId:'task-foreground', taskType:'FOREGROUND_JUDGMENT', layer:'L1', owner:'Foreground Cognition',
      requiredCapabilities:['SEMANTIC_JUDGMENT'], resourceClass:'CPU',
      sourceRevisions:{}, worldRevision:'W44', sceneRevision:'SC21', revision:44,
      dependencies:[], priority:10, deadline:100, foreground:true, speculative:false,
      dedupeKey:'foreground:1', conflictKey:null, coalesceKey:null, coalescible:false,
      lifecycleStatus:'PENDING', payload:{ correlationId:'generation-1' },
    },
    lifecycleStatus:'PENDING', executionStatus:'QUEUED', executionReason:null, dependencies:[],
    batch:{ batchId:'batch:task-foreground', units:[{id:'fg-unit-1'}], completedUnitIds:[], completedSliceIds:[], activeSlice:null, adaptiveBatchSize:1, batchPolicy:{}, retryState:{}, validationState:null },
    checkpoint:null, resultReceipts:[], retryState:{attempts:0,failures:[]}, recoveryState:null, supersession:null, yieldRequested:false, startedCount:0, resumeCount:0, createdSequence:2, updatedSequence:2,
  };
}

function mapBatch(record) {
  const batch = record.batch;
  return {
    id:batch.batchId,
    taskId:record.taskId,
    totalUnits:batch.units?.length ?? 0,
    completedUnits:batch.completedUnitIds?.length ?? 0,
    activeSlice:batch.activeSlice?.sliceId ?? null,
    nextSlice:nextPendingUnit(batch),
    checkpoint:record.checkpoint?.afterSliceId ?? null,
    adaptiveBatchSize:batch.adaptiveBatchSize ?? null,
    yieldRequested:Boolean(record.yieldRequested),
    resumePoint:record.checkpoint?.afterSliceId ?? null,
    validationState:clone(batch.validationState ?? null),
    retryState:clone(batch.retryState ?? {}),
  };
}

function nextPendingUnit(batch) {
  const completed = new Set(batch.completedUnitIds ?? []);
  return batch.units?.find((unit) => !completed.has(unit.id))?.id ?? null;
}

function deriveDeadlineState(records) {
  const foreground = records.filter((record) => record.obligation?.foreground && record.lifecycleStatus === 'ELIGIBLE');
  if (!foreground.length) return 'CLEAR';
  return foreground.some((record) => record.obligation?.deadline != null) ? 'ACTIVE' : 'OPEN';
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}
