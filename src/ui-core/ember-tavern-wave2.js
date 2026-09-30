import { RuntimeStatus, Signals } from './constants.js';
import { clone, createAdapterBundle, ContextSealState, LateRoute, page, ResultClass, SceneRelation, Wave2Signals } from './wave2-adapters.js';

const now = (n) => `T+${String(n).padStart(4, '0')}ms`;

export class EmberTavernWave2Fixture {
  constructor({ signals, stress = false } = {}) {
    if (!signals) throw new Error('EmberTavernWave2Fixture requires SignalHub');
    this.signals = signals;
    this.clock = 0;
    this.trace = [];
    this.worldRevision = 41;
    this.currentScene = makeIntactScene();
    this.boundary = makeBoundaryState();
    this.episodes = makeSeedEpisodes();
    this.sceneRelations = makeSceneRelations();
    this.deltaLog = [];
    this.workers = makeWorkers(stress ? 128 : 8);
    this.lifecycle = makeObligations(stress ? 4000 : 80);
    this.batches = makeBatches(stress ? 64 : 8);
    this.ledger = makeLedger(stress ? 6000 : 400);
    this.runtimeOverview = makeRuntimeOverview();
    this.turns = new Map();
    this.knowledge = makeKnowledgeStore();
    if (stress) this.episodes.push(...makeStressEpisodes(5000));
  }

  tick(ms = 15) { this.clock += ms; return now(this.clock); }

  emit(type, payload, source = 'ember-tavern-fixture') {
    this.trace.push({ type, payload: clone(payload), at: this.tick() });
    return this.signals.publish(type, payload, { source, revision: payload?.revision ?? null, timestamp: this.clock });
  }

  getCurrentScene() { return clone(this.currentScene); }
  getBoundaryState() { return clone(this.boundary); }
  getEpisode(id) { return clone(this.episodes.find((scene) => scene.id === id) ?? null); }
  getRelated(id) {
    return clone(this.sceneRelations.filter((edge) => edge.from === id || edge.to === id).map((edge) => ({
      ...edge,
      direction: edge.from === id ? 'OUT' : 'IN',
      scene: this.getEpisode(edge.from === id ? edge.to : edge.from) ?? (this.currentScene.id === (edge.from === id ? edge.to : edge.from) ? clone(this.currentScene) : null),
    })));
  }

  applySceneField(field, value, type = Wave2Signals.SCENE_STATE_DELTA, evidence = []) {
    const previous = clone(this.currentScene[field]);
    this.currentScene[field] = clone(value);
    this.currentScene.revision += 1;
    const delta = Object.freeze({
      id: `delta-${this.deltaLog.length + 1}`,
      sceneId: this.currentScene.id,
      sceneRevision: this.currentScene.revision,
      field,
      previous,
      value: clone(value),
      evidence: clone(evidence),
      type,
    });
    this.deltaLog.push(delta);
    this.emit(type, delta);
    if (type !== Wave2Signals.SCENE_STATE_DELTA) this.emit(Wave2Signals.SCENE_STATE_DELTA, delta);
    this.emit(Wave2Signals.HOT_COGNITION_CHANGED, { sceneId: this.currentScene.id, field, revision: this.currentScene.revision });
    return delta;
  }

  erisLeavesSunBlade() {
    this.currentScene.activeThreads = [
      { id: 'thread-sun-blade', text: 'Sun Blade remains at Ember Tavern after Eris departs.', state: 'OPEN', epistemic: 'observed' },
      ...this.currentScene.activeThreads.filter((t) => t.id !== 'thread-sun-blade'),
    ];
    this.currentScene.immediateObjects = this.currentScene.immediateObjects.map((item) => item.id === 'sun-blade' ? { ...item, holder: null, location: 'Ember Tavern', epistemic: 'observed' } : item);
    return this.applySceneField('immediateObjects', this.currentScene.immediateObjects, Wave2Signals.SCENE_STATE_DELTA, ['turn-118', 'source-sun-blade']);
  }

  showBoundaryCandidate() {
    this.boundary = {
      candidateId: 'boundary-ember-01',
      sceneId: this.currentScene.id,
      state: 'CONFIRMING',
      confidence: 0.68,
      supportingSignals: ['Eris departure', 'objective discontinuity'],
      contradictoryEvidence: ['Mara still present', 'location unchanged'],
      confirmationWindow: { state: 'OPEN', observedTurns: 1, requiredTurns: 2 },
      decision: 'PENDING',
    };
    this.emit(Wave2Signals.SCENE_BOUNDARY_CHANGED, this.boundary);
    return clone(this.boundary);
  }

  confirmSceneBoundary() {
    this.applySceneField('narrativeTime', 'Day 14 · Late Evening', Wave2Signals.SCENE_TIME_SHIFT_DETECTED, ['turn-119']);
    this.applySceneField('location', { id: 'ember-road', name: 'Road outside Ember Tavern', epistemic: 'observed' }, Wave2Signals.SCENE_LOCATION_CHANGED, ['turn-119']);
    this.boundary = {
      ...this.boundary,
      state: 'CONFIRMED',
      confidence: 0.96,
      supportingSignals: [...this.boundary.supportingSignals, 'time shift', 'location transition'],
      contradictoryEvidence: [],
      confirmationWindow: { state: 'SATISFIED', observedTurns: 2, requiredTurns: 2 },
      decision: 'CUT',
    };
    this.emit(Wave2Signals.SCENE_BOUNDARY_CHANGED, this.boundary);
    return clone(this.boundary);
  }

  compileClosedEpisode() {
    const episode = {
      id: 'scene-ember-intact',
      revision: this.currentScene.revision,
      status: 'CLOSED',
      title: 'Ember Tavern — intact evening',
      sourceTurnRange: { start: 112, end: 119 },
      participants: ['Eris', 'Mara'],
      location: 'Ember Tavern',
      narrativeTime: 'Day 14 · Evening → Late Evening',
      events: ['Eris and Mara speak in the intact tavern.', 'Eris leaves the Sun Blade behind.', 'Eris departs.'],
      claims: [
        { id: 'claim-tavern-intact', text: 'Ember Tavern is intact.', state: 'HISTORICAL', epistemic: 'observed' },
        { id: 'claim-blade-left', text: 'Sun Blade remains in Ember Tavern.', state: 'HISTORICAL', epistemic: 'observed' },
      ],
      relationshipChanges: [{ subject: 'Eris', relation: 'carries', object: 'Sun Blade', from: true, to: false }],
      stateChanges: [{ subject: 'Sun Blade', field: 'holder', from: 'Eris', to: null }],
      threadsOpened: ['Where will Eris return for the Sun Blade?'],
      threadsResolved: ['Conversation with Mara at the tavern'],
      atmosphereTrajectory: ['warm', 'uneasy', 'departing'],
      provenance: ['turn-112..119', 'source-ember-tavern', 'source-sun-blade'],
    };
    this.episodes.unshift(episode);
    this.emit(Wave2Signals.SCENE_EPISODE_CLOSED, { episodeId: episode.id, episode: clone(episode) });
    return clone(episode);
  }

  applyFireEvent() {
    this.worldRevision += 1;
    this.knowledge['ember-tavern'] = { id: 'ember-tavern', kind: 'place', state: 'destroyed', revision: this.worldRevision, history: ['intact@R41', `destroyed@R${this.worldRevision}`], provenance: ['FireEvent492'] };
    this.knowledge['sun-blade'] = { id: 'sun-blade', kind: 'object', state: 'destroyed', revision: this.worldRevision, history: ['left-behind@R41', `destroyed@R${this.worldRevision}`], provenance: ['FireEvent492'] };
    this.emit(Wave2Signals.SCENE_STATE_DELTA, { type: 'WORLD_STATE_CHANGED', field: 'worldRevision', value: this.worldRevision, evidence: ['FireEvent492'] });
    return this.worldRevision;
  }

  openRuinsScene() {
    const previousId = 'scene-ember-intact';
    this.currentScene = makeRuinsScene(this.worldRevision);
    this.sceneRelations.push({ from: previousId, to: this.currentScene.id, relation: SceneRelation.PRECEDES });
    this.sceneRelations.push({ from: 'scene-market-parallel', to: this.currentScene.id, relation: SceneRelation.RESUMES });
    this.emit(Wave2Signals.SCENE_NAVIGATION_CHANGED, { sceneId: this.currentScene.id, relationCount: this.sceneRelations.length });
    this.emit(Wave2Signals.SCENE_STATE_DELTA, { sceneId: this.currentScene.id, sceneRevision: 1, field: 'scene', previous: previousId, value: clone(this.currentScene), type: 'SCENE_OPENED' });
    this.emit(Wave2Signals.HOT_COGNITION_CHANGED, { sceneId: this.currentScene.id, revision: 1, worldRevision: this.worldRevision });
    return clone(this.currentScene);
  }

  createTurnEvent() {
    const turn = {
      turnId: 'TURN-EMBER-001',
      eventId: 'evt-turn-001',
      correlationId: 'corr-ember-001',
      sceneRevision: this.currentScene.revision,
      worldRevision: this.worldRevision,
      createdAt: this.tick(),
      deadline: now(this.clock + 220),
      workers: [
        makeTurnWorker('historian', 'Historian', ResultClass.REQUIRED, ['retrieval','episode-recall']),
        makeTurnWorker('graph', 'Graph Walker', ResultClass.REQUIRED, ['graph','current-state']),
        makeTurnWorker('green-room', 'Green Room', ResultClass.OPPORTUNISTIC, ['affect','intent']),
        makeTurnWorker('truth', 'Truth Worker', ResultClass.REQUIRED, ['truth','precision']),
      ],
      gather: { expectedWorkers: 4, requiredWorkers: ['historian','graph','truth'], completedWorkers: [], foregroundQuorum: false, requiredMissing: ['historian','graph','truth'], deadline: now(this.clock + 220), state: 'OPEN', contextSeal: ContextSealState.OPEN, lateResults: [] },
      timeline: [{ stage: 'TURN_EVENT', at: now(this.clock), lane: 'FOREGROUND' }, { stage: 'fan-out', at: now(this.clock + 1), lane: 'FOREGROUND' }],
    };
    this.turns.set(turn.turnId, turn);
    this.emit(Wave2Signals.TURN_EVENT_CREATED, { turnId: turn.turnId, workerCount: turn.workers.length, deadline: turn.deadline });
    return clone(turn);
  }

  completeTurnWorker(workerId, { stale = false, fallback = false, latency = 40 } = {}) {
    const turn = this.turns.get('TURN-EMBER-001');
    if (!turn) throw new Error('Turn Event not created');
    const worker = turn.workers.find((item) => item.id === workerId);
    if (!worker) throw new Error(`Unknown turn worker: ${workerId}`);
    worker.state = 'COMPLETE';
    worker.startedAt = worker.startedAt ?? now(this.clock);
    this.tick(latency);
    worker.completedAt = now(this.clock);
    worker.latencyMs = latency;
    worker.freshness = stale ? 'STALE' : 'FRESH';
    worker.fallbackUsed = fallback;
    const sealed = turn.gather.contextSeal === ContextSealState.SEALED;
    worker.contributedToCurrentContext = !sealed && !stale && worker.resultClass !== ResultClass.DEFERRED;
    if (sealed) {
      worker.lateRoute = workerId === 'green-room' ? LateRoute.NEXT_TURN : LateRoute.BACKGROUND;
      turn.gather.lateResults.push({ workerId, route: worker.lateRoute, completedAt: worker.completedAt });
      turn.timeline.push({ stage: `${worker.name} late`, at: worker.completedAt, lane: worker.lateRoute, workerId });
    } else {
      turn.gather.completedWorkers.push(workerId);
      turn.timeline.push({ stage: `${worker.name} result`, at: worker.completedAt, lane: 'FOREGROUND', workerId });
    }
    turn.gather.completedWorkers = [...new Set(turn.gather.completedWorkers)];
    turn.gather.requiredMissing = turn.gather.requiredWorkers.filter((id) => !turn.gather.completedWorkers.includes(id));
    turn.gather.foregroundQuorum = turn.gather.requiredMissing.length === 0;
    if (turn.gather.foregroundQuorum && turn.gather.contextSeal === ContextSealState.OPEN) turn.gather.contextSeal = ContextSealState.QUORUM;
    this.emit(Wave2Signals.COPROCESSOR_RESULT_CHANGED, { turnId: turn.turnId, worker: clone(worker) });
    this.emit(Wave2Signals.GATHER_STATE_CHANGED, { turnId: turn.turnId, gather: clone(turn.gather) });
    return clone(worker);
  }

  closeGatherAndSeal() {
    const turn = this.turns.get('TURN-EMBER-001');
    if (!turn?.gather.foregroundQuorum) throw new Error('Foreground quorum not satisfied');
    turn.gather.state = 'CLOSED';
    turn.gather.contextSeal = ContextSealState.COMPILING;
    turn.timeline.push({ stage: 'quorum', at: this.tick(), lane: 'FOREGROUND' });
    turn.timeline.push({ stage: 'compiler', at: this.tick(), lane: 'FOREGROUND' });
    this.emit(Wave2Signals.GATHER_STATE_CHANGED, { turnId: turn.turnId, gather: clone(turn.gather) });
    turn.gather.contextSeal = ContextSealState.SEALED;
    turn.timeline.push({ stage: 'CONTEXT SEALED', at: this.tick(), lane: 'FOREGROUND' });
    turn.timeline.push({ stage: 'Main', at: this.tick(), lane: 'FOREGROUND' });
    this.emit(Wave2Signals.CONTEXT_SEAL_CHANGED, { turnId: turn.turnId, state: ContextSealState.SEALED, sealedAt: now(this.clock) });
    return clone(turn.gather);
  }

  parkWorker(workerId = 'worker-deep-reflection') {
    const worker = this.workers.find((item) => item.id === workerId);
    if (!worker) return null;
    worker.state = RuntimeStatus.PARKED;
    worker.currentTask = null;
    this.emit(Signals.WORKER_STATE_CHANGED, { workerId: worker.id, name: worker.name, state: worker.state, layer: worker.layer });
    return clone(worker);
  }

  resumeWorker(workerId = 'worker-deep-reflection') {
    const worker = this.workers.find((item) => item.id === workerId);
    if (!worker) return null;
    worker.state = RuntimeStatus.ACTIVE;
    worker.currentTask = 'resume lifecycle obligation';
    this.emit(Signals.WORKER_STATE_CHANGED, { workerId: worker.id, name: worker.name, state: worker.state, layer: worker.layer });
    return clone(worker);
  }

  updateBatch(batchId = 'batch-0', progress = {}) {
    const batch = this.batches.find((item) => item.id === batchId);
    if (!batch) return null;
    Object.assign(batch, progress);
    this.emit(Wave2Signals.RUNTIME_BATCH_CHANGED, { batch: clone(batch) });
    this.emit(Signals.BATCH_PROGRESS_CHANGED, { batchId, progress: Math.round((batch.completedUnits / batch.totalUnits) * 100) });
    return clone(batch);
  }

  runAcceptanceScenario() {
    const steps = [];
    steps.push({ step: 1, currentScene: this.getCurrentScene() });
    steps.push({ step: 2, activeCast: clone(this.currentScene.activeCast) });
    steps.push({ step: 3, result: this.erisLeavesSunBlade() });
    steps.push({ step: 4, result: this.showBoundaryCandidate() });
    steps.push({ step: 5, result: this.confirmSceneBoundary() });
    steps.push({ step: 6, result: this.compileClosedEpisode() });
    steps.push({ step: 7, worldRevision: this.applyFireEvent() });
    steps.push({ step: 8, result: this.openRuinsScene() });
    steps.push({ step: 9, result: this.createTurnEvent() });
    steps.push({ step: 10, fanout: clone(this.turns.get('TURN-EMBER-001').workers) });
    steps.push({ step: 11, results: [this.completeTurnWorker('historian'), this.completeTurnWorker('graph'), this.completeTurnWorker('truth')] });
    steps.push({ step: 12, gather: clone(this.turns.get('TURN-EMBER-001').gather) });
    steps.push({ step: 13, seal: this.closeGatherAndSeal() });
    steps.push({ step: 14, timeline: clone(this.turns.get('TURN-EMBER-001').timeline) });
    steps.push({ step: 15, late: this.completeTurnWorker('green-room', { latency: 180 }) });
    steps.push({ step: 16, historical: this.getEpisode('scene-ember-intact') });
    return steps;
  }
}

export function createEmberTavernAdapterBundle({ signals, stress = false } = {}) {
  const fixture = new EmberTavernWave2Fixture({ signals, stress });
  const scene = {
    kind: 'SceneUIAdapter',
    getCurrentScene: () => fixture.getCurrentScene(),
    getBoundaryState: () => fixture.getBoundaryState(),
    getSceneEpisode: (id) => fixture.getEpisode(id),
    getSceneHistoryPage: (options) => page(fixture.episodes, options),
    getRelatedScenes: (id) => fixture.getRelated(id),
    subscribeSceneDeltas: (handler) => {
      const types = [Wave2Signals.SCENE_LOCATION_CHANGED, Wave2Signals.SCENE_ACTIVE_CAST_CHANGED, Wave2Signals.SCENE_TIME_SHIFT_DETECTED, Wave2Signals.SCENE_VIBE_CHANGED, Wave2Signals.SCENE_STATE_DELTA, Wave2Signals.SCENE_BOUNDARY_CHANGED, Wave2Signals.SCENE_EPISODE_CLOSED, Wave2Signals.SCENE_NAVIGATION_CHANGED];
      const releases = types.map((type) => signals.subscribe(type, handler));
      return () => releases.splice(0).forEach((release) => release());
    },
  };
  const runtime = {
    kind: 'RuntimeUIAdapter',
    getOverview: () => clone(fixture.runtimeOverview),
    getLifecyclePage: (options) => page(fixture.lifecycle, options),
    getWorkers: () => clone(fixture.workers),
    getBatches: () => clone(fixture.batches),
    getLedgerPage: (options) => page(fixture.ledger, options),
    subscribeRuntime: (handler) => {
      const types = [Wave2Signals.RUNTIME_OVERVIEW_CHANGED, Wave2Signals.LIFECYCLE_OBLIGATION_CHANGED, Wave2Signals.RUNTIME_BATCH_CHANGED, Signals.WORKER_STATE_CHANGED, Signals.BATCH_PROGRESS_CHANGED];
      const releases = types.map((type) => signals.subscribe(type, handler));
      return () => releases.splice(0).forEach((release) => release());
    },
  };
  const coprocessor = {
    kind: 'CoprocessorUIAdapter',
    getTurnSwarm: (turnId = 'TURN-EMBER-001') => clone(fixture.turns.get(turnId) ?? null),
    getGather: (turnId = 'TURN-EMBER-001') => clone(fixture.turns.get(turnId)?.gather ?? null),
    getContextSealTimeline: (turnId = 'TURN-EMBER-001') => clone(fixture.turns.get(turnId)?.timeline ?? []),
    subscribeCoprocessor: (handler) => {
      const types = [Wave2Signals.TURN_EVENT_CREATED, Wave2Signals.COPROCESSOR_RESULT_CHANGED, Wave2Signals.GATHER_STATE_CHANGED, Wave2Signals.CONTEXT_SEAL_CHANGED];
      const releases = types.map((type) => signals.subscribe(type, handler));
      return () => releases.splice(0).forEach((release) => release());
    },
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
  return { fixture, adapters: createAdapterBundle({ scene, runtime, coprocessor, knowledge }) };
}

export function createWave2StressFixtures({ workerCount = 256, obligationCount = 8000, batchCount = 128, historyCount = 10000, provenanceCount = 12000, swarmWorkerCount = 192 } = {}) {
  const swarm = Array.from({ length: swarmWorkerCount }, (_, i) => ({
    id: `stress-sidecar-${i}`,
    name: `Capability Worker ${i}`,
    resultClass: i < 12 ? ResultClass.REQUIRED : i % 3 === 0 ? ResultClass.DEFERRED : ResultClass.OPPORTUNISTIC,
    state: 'COMPLETE',
    freshness: i % 17 === 0 ? 'STALE' : 'FRESH',
    contributedToCurrentContext: i < 12 && i % 17 !== 0,
    lateRoute: i >= 12 && i % 11 === 0 ? (i % 22 === 0 ? LateRoute.BACKGROUND : LateRoute.NEXT_TURN) : null,
    latencyMs: 10 + (i % 41) * 6,
  }));
  return Object.freeze({
    workers: makeWorkers(workerCount),
    obligations: makeObligations(obligationCount),
    batches: makeBatches(batchCount),
    history: makeStressEpisodes(historyCount),
    provenance: Array.from({ length: provenanceCount }, (_, i) => ({ from: `evidence-${i}`, to: `claim-${i % 127}`, relation: i % 2 ? 'SUPPORTS' : 'DERIVED_FROM' })),
    swarm,
  });
}

function inspectKnowledge(fixture, ref, view) {
  const id = typeof ref === 'string' ? ref : ref?.id;
  const scene = fixture.getEpisode(id) ?? (fixture.currentScene.id === id ? fixture.getCurrentScene() : null);
  const record = fixture.knowledge[id] ?? scene ?? { id, kind: ref?.kind ?? 'knowledge', provenance: ref?.provenance ?? [], history: ref?.history ?? [] };
  const provenance = record.provenance ?? record.sourceEvidence ?? ref?.provenance ?? [];
  const common = { kind: 'knowledge-inspection', view, id, label: record.title ?? record.name ?? id, readOnly: true };
  if (view === 'source') return { ...common, source: record.source ?? record.sourceTurnRange ?? provenance[0] ?? null };
  if (view === 'provenance') return { ...common, provenance: clone(provenance) };
  if (view === 'history') return { ...common, history: clone(record.history ?? record.stateChanges ?? []) };
  if (view === 'dependencies') return { ...common, dependencies: clone(record.dependencies ?? []) };
  if (view === 'settlement') return { ...common, settlement: { authority: 'owning-subsystem', state: record.settlement ?? 'READ_ONLY_UI', revision: record.revision ?? null } };
  return { ...common, evidence: clone(record.evidence ?? provenance) };
}

function makeIntactScene() {
  return {
    id: 'scene-ember-intact-live', revision: 1, status: 'OPEN',
    location: { id: 'ember-tavern', name: 'Ember Tavern', epistemic: 'observed' },
    narrativeTime: 'Day 14 · Evening',
    activeCast: [{ id: 'eris', name: 'Eris', epistemic: 'observed' }, { id: 'mara', name: 'Mara', epistemic: 'observed' }],
    immediateObjects: [{ id: 'sun-blade', name: 'Sun Blade', holder: 'Eris', epistemic: 'observed' }, { id: 'hearth', name: 'Tavern hearth', epistemic: 'observed' }],
    activeThreads: [{ id: 'thread-sun-blade', text: 'Eris is carrying the Sun Blade.', state: 'ACTIVE', epistemic: 'observed' }, { id: 'thread-mara', text: 'Mara watches Eris carefully.', state: 'ACTIVE', epistemic: 'inferred' }],
    objectives: [{ id: 'objective-conversation', text: 'Finish the conversation before departure.', epistemic: 'observed' }],
    atmosphere: { label: 'warm but uneasy', epistemic: 'inferred', confidence: 0.74 },
    unresolved: [{ id: 'unknown-fire', text: 'Future damage to the tavern is unresolved.', epistemic: 'unresolved' }],
    sourceEvidence: ['turn-112', 'turn-113', 'source-ember-tavern', 'source-sun-blade'],
    worldRevision: 41,
  };
}

function makeRuinsScene(worldRevision) {
  return {
    id: 'scene-ember-ruins', revision: 1, status: 'OPEN',
    location: { id: 'ember-tavern-ruins', name: 'Ruins of Ember Tavern', epistemic: 'observed' },
    narrativeTime: 'Day 15 · Dawn',
    activeCast: [{ id: 'eris', name: 'Eris', epistemic: 'observed' }, { id: 'mara', name: 'Mara', epistemic: 'observed' }],
    immediateObjects: [{ id: 'sun-blade-remains', name: 'Destroyed Sun Blade', epistemic: 'observed' }, { id: 'tavern-ruins', name: 'Burned tavern structure', epistemic: 'observed' }],
    activeThreads: [{ id: 'thread-fire-cause', text: 'What caused the Ember Tavern fire?', state: 'OPEN', epistemic: 'unresolved' }],
    objectives: [{ id: 'objective-search', text: 'Search the ruins for the Sun Blade.', epistemic: 'observed' }],
    atmosphere: { label: 'ash, shock, urgency', epistemic: 'inferred', confidence: 0.91 },
    unresolved: [{ id: 'fire-cause', text: 'Cause of fire not yet settled.', epistemic: 'unresolved' }],
    sourceEvidence: ['FireEvent492', 'turn-120'],
    worldRevision,
  };
}

function makeBoundaryState() { return { candidateId: null, sceneId: 'scene-ember-intact-live', state: 'IDLE', confidence: 0, supportingSignals: [], contradictoryEvidence: [], confirmationWindow: { state: 'CLOSED', observedTurns: 0, requiredTurns: 2 }, decision: 'NO CUT' }; }
function makeSeedEpisodes() {
  return [
    { id:'scene-market-parallel', revision:2, status:'CLOSED', title:'Mara at the night market', sourceTurnRange:{start:108,end:111}, participants:['Mara'], location:'Night Market', narrativeTime:'Day 14 · Evening', events:['Mara purchases lamp oil.'], claims:[], relationshipChanges:[], stateChanges:[], threadsOpened:[], threadsResolved:[], atmosphereTrajectory:['busy','watchful'], provenance:['turn-108..111'] },
    { id:'scene-sunblade-flashback', revision:1, status:'CLOSED', title:'Sun Blade memory', sourceTurnRange:{start:51,end:55}, participants:['Eris'], location:'Old Forge', narrativeTime:'Three years earlier', events:['Eris first receives the Sun Blade.'], claims:[], relationshipChanges:[], stateChanges:[], threadsOpened:[], threadsResolved:[], atmosphereTrajectory:['solemn'], provenance:['turn-51..55'] },
  ];
}
function makeSceneRelations(){return [
  {from:'scene-sunblade-flashback',to:'scene-ember-intact',relation:SceneRelation.FLASHBACK_OF},
  {from:'scene-market-parallel',to:'scene-ember-intact',relation:SceneRelation.PARALLEL_TO},
  {from:'scene-sunblade-flashback',to:'scene-market-parallel',relation:SceneRelation.PRECEDES},
  {from:'scene-market-parallel',to:'scene-sunblade-flashback',relation:SceneRelation.CONTINUES},
  {from:'scene-ember-intact',to:'scene-market-parallel',relation:SceneRelation.INTERRUPTS},
];}
function makeRuntimeOverview(){return {mode:'HOT',hotActivity:72,deepActivity:38,utilization:{L0:88,L1:73,L2:61,L3:34,L4:18},reservedForegroundCapacity:35,borrowedBackgroundCapacity:22,worldRevision:41};}
function makeWorkers(count){const roles=['Historian','Graph Walker','Green Room','Truth Worker','Reflection','Consolidation','Embedder','Reranker'];return Array.from({length:count},(_,i)=>({id:i===4?'worker-deep-reflection':`worker-${i}`,name:roles[i%roles.length],capabilityProfile:[roles[i%roles.length].toLowerCase().replaceAll(' ','-')],layer:i<4?'Hot':'Deep',currentTask:i===4?'reflection sweep':i<4?'foreground-ready':'background maintenance',state:i===4?RuntimeStatus.ACTIVE:(i%5===0?RuntimeStatus.YIELDING:RuntimeStatus.PARKED),provider:i%3===0?'local':i%3===1?'sidecar':'remote',model:i%3===0?'deterministic':i%3===1?'mock-small':'mock-large',executionLatencyMs:12+(i%17)*7}));}
function makeObligations(count){return Array.from({length:count},(_,i)=>({id:`obligation-${i}`,kind:i%3===0?'CONSOLIDATE':i%3===1?'REFLECT':'INDEX',cognitiveLayer:i%5===0?'L4':i%4===0?'L3':'L2',state:i%7===0?'QUEUED':'READY',assignedWorker:i%7===0?null:`worker-${i%8}`,createdRevision:40+(i%2),priority:i%9,reason:'durable cognitive obligation'}));}
function makeBatches(count){return Array.from({length:count},(_,i)=>({id:`batch-${i}`,totalUnits:100+(i*3),completedUnits:i*7,nextSlice:i*7+1,activeSlice:i*7,checkpoint:`cp-${i}-${i*7}`,adaptiveBatchSize:8+(i%5)*4,yieldRequested:i%6===0,resumePoint:i*7}));}
function makeLedger(count){return Array.from({length:count},(_,i)=>({id:`task-${i}`,type:i%2?'DEEP':'HOT',state:i%11===0?'FAILED':i%5===0?'COMPLETE':'QUEUED',workerId:`worker-${i%8}`,createdAt:`R${i}`,completedAt:i%5===0?`R${i+1}`:null,resultRef:i%5===0?`artifact-${i}`:null}));}
function makeKnowledgeStore(){return {
  'ember-tavern':{id:'ember-tavern',kind:'place',state:'intact',revision:41,history:['intact@R41'],provenance:['source-ember-tavern','turn-112..119'],dependencies:['scene-ember-intact']},
  'sun-blade':{id:'sun-blade',kind:'object',state:'carried-by-Eris',revision:41,history:['carried@R41'],provenance:['source-sun-blade','turn-112..118'],dependencies:['Eris','Ember Tavern']},
  'scene-ember-intact':{id:'scene-ember-intact',kind:'scene',revision:5,history:['OPEN','CLOSED'],provenance:['turn-112..119','source-ember-tavern','source-sun-blade'],dependencies:['ember-tavern','sun-blade','eris','mara'],settlement:'EPISODE_COMPILED'},
};}
function makeTurnWorker(id,name,resultClass,capabilities){return {id,name,resultClass,capabilities,state:'RUNNING',startedAt:null,completedAt:null,deadline:null,freshness:'PENDING',fallbackUsed:false,contributedToCurrentContext:false,lateRoute:null};}
function makeStressEpisodes(count){return Array.from({length:count},(_,i)=>({id:`stress-scene-${i}`,revision:1,status:'CLOSED',title:`Stress scene ${i}`,sourceTurnRange:{start:i*2,end:i*2+1},participants:[`P${i%12}`],location:`Location ${i%40}`,narrativeTime:`T${i}`,events:[`Event ${i}`],claims:[],relationshipChanges:[],stateChanges:[],threadsOpened:[],threadsResolved:[],atmosphereTrajectory:['neutral'],provenance:[`turn-${i*2}..${i*2+1}`]}));}
