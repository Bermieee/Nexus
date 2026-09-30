import { KnowledgeStatus, RuntimeStatus, Signals } from './constants.js';

const WORKER_PATH = [RuntimeStatus.ACTIVE, RuntimeStatus.YIELDING, RuntimeStatus.PARKED, RuntimeStatus.ACTIVE, RuntimeStatus.COMPLETE];

export class MockBrainRuntime {
  constructor({ signals, scheduler } = {}) {
    this.signals = signals;
    this.scheduler = scheduler;
    this.workerIndex = 0;
    this.batchProgress = 0;
    this.claimStatus = KnowledgeStatus.CURRENT;
    this.workers = [
      { id: 'L0-historian', name: 'L0 Historian', state: RuntimeStatus.ACTIVE, layer: 'Hot' },
      { id: 'L1-graph', name: 'L1 Graph Walker', state: RuntimeStatus.PARKED, layer: 'Hot' },
      { id: 'L2-green-room', name: 'L2 Green Room', state: RuntimeStatus.PARKED, layer: 'Hot' },
      { id: 'L3-reflection', name: 'L3 Reflection', state: RuntimeStatus.YIELDING, layer: 'Deep' },
      { id: 'L4-consolidation', name: 'L4 Consolidation', state: RuntimeStatus.PARKED, layer: 'Deep' },
    ];
    this.claim = {
      id: 'claim-tavern-state', kind: 'claim', subject: 'Tavern state',
      text: 'The tavern is intact.', status: KnowledgeStatus.CURRENT,
      history: [
        { status: KnowledgeStatus.CURRENT, value: 'intact', validFrom: 'T0', validUntil: null },
      ],
      provenance: [
        { kind: 'source', label: 'World source UID 184' },
        { kind: 'claim', label: 'claim-tavern-state' },
      ],
    };
    this.reflection = { id: 'reflection-1', text: 'Active workers are yielding correctly to foreground demand.', evidenceCount: 3 };
  }

  snapshot() {
    return { workers: this.workers.map((worker) => ({ ...worker })), claim: structuredClone(this.claim), reflection: { ...this.reflection }, batchProgress: this.batchProgress };
  }

  advanceWorker() {
    const worker = this.workers[0];
    worker.state = WORKER_PATH[this.workerIndex % WORKER_PATH.length];
    this.workerIndex += 1;
    this.signals.publish(Signals.WORKER_STATE_CHANGED, { workerId: worker.id, name: worker.name, state: worker.state, layer: worker.layer }, { source: 'mock-brain' });
    this.signals.publish(Signals.UI_RUNTIME_ACTIVITY, { message: `${worker.name} → ${worker.state}` }, { source: 'mock-brain' });
    return worker.state;
  }

  advanceBatch(step = 17) {
    this.batchProgress = Math.min(100, this.batchProgress + step);
    this.signals.publish(Signals.BATCH_PROGRESS_CHANGED, { batchId: 'batch-42', progress: this.batchProgress }, { source: 'mock-brain' });
    return this.batchProgress;
  }

  supersedeClaim() {
    if (this.claim.status === KnowledgeStatus.SUPERSEDED) return this.claim;
    this.claim.history[0].validUntil = 'T492';
    this.claim.history.push({ status: KnowledgeStatus.CURRENT, value: 'destroyed', validFrom: 'T492', validUntil: null });
    this.claim.status = KnowledgeStatus.SUPERSEDED;
    this.claim.text = 'The tavern was intact before the fire; the old state is now historical.';
    this.claim.provenance.push({ kind: 'event', label: 'FireEvent492' });
    this.signals.publish(Signals.CLAIM_STATE_CHANGED, {
      claimId: this.claim.id,
      status: this.claim.status,
      text: this.claim.text,
      history: structuredClone(this.claim.history),
      provenance: structuredClone(this.claim.provenance),
    }, { source: 'mock-brain', revision: 492 });
    return this.claim;
  }

  updateReflection(text = 'Foreground work completed; deep cognition may resume.') {
    this.reflection.text = text;
    this.reflection.evidenceCount += 1;
    this.signals.publish(Signals.REFLECTION_CHANGED, { reflectionId: this.reflection.id, ...this.reflection }, { source: 'mock-brain' });
  }
}
