import { Wave3Signals } from './wave3-adapters.js';

export class RuntimeTelemetryProjector {
  constructor({ adapter, scheduler, onMetric = () => {} }) {
    this.adapter = adapter;
    this.scheduler = scheduler;
    this.onMetric = onMetric;
    this.release = null;
  }

  mount() {
    if (this.release) return this;
    this.release = this.adapter.subscribeRuntime((event) => {
      const key = telemetryKey(event);
      if (!key) return;
      this.scheduler.invalidate(`wave3:runtime:${key}`, () => this.onMetric(key, event.payload, event));
    });
    return this;
  }

  destroy() {
    this.release?.();
    this.release = null;
    this.scheduler.cancelPrefix?.('wave3:runtime:');
  }
}

export class PrecisionFunnelProjector {
  constructor({ adapter, scheduler, onUpdate = () => {} }) {
    this.adapter = adapter;
    this.scheduler = scheduler;
    this.onUpdate = onUpdate;
    this.release = null;
  }

  mount() {
    this.release = this.adapter.subscribePrecision((event) => {
      if (![Wave3Signals.CANDIDATE_FUNNEL_CHANGED, Wave3Signals.RERANK_PROGRESS_CHANGED, Wave3Signals.PRECISION_FALLBACK_CHANGED].includes(event.type)) return;
      const key = event.type === Wave3Signals.CANDIDATE_FUNNEL_CHANGED ? 'funnel' : event.payload?.candidateId ?? event.payload?.runId ?? event.type;
      this.scheduler.invalidate(`wave3:precision:${key}`, () => this.onUpdate(key, event.payload, event));
    });
    return this;
  }

  destroy() {
    this.release?.();
    this.release = null;
    this.scheduler.cancelPrefix?.('wave3:precision:');
  }
}

export class MemoryTraceModel {
  constructor({ adapter }) { this.adapter = adapter; }
  lineage(id) {
    const record = this.adapter.getMemoryRecord(id);
    if (!record) return [];
    return [
      { stage: 'SOURCE', value: record.source },
      { stage: 'DERIVED UNDERSTANDING', value: record.derivedClaim },
      { stage: 'PROPOSAL', value: record.proposal },
      { stage: 'SETTLEMENT', value: record.settlement },
      { stage: record.currentState?.status ?? 'STATE', value: record.currentState },
    ];
  }
}

export function telemetryKey(event) {
  if (!event) return null;
  if (event.payload?.workerId) return `worker:${event.payload.workerId}`;
  if (event.payload?.batchId) return `batch:${event.payload.batchId}`;
  if (event.type === Wave3Signals.RUNTIME_QUEUE_DEPTH_CHANGED) return 'queue-depth';
  if (event.type === Wave3Signals.RUNTIME_UTILIZATION_CHANGED) return 'utilization';
  if (event.type === Wave3Signals.RUNTIME_CAPACITY_CHANGED) return 'capacity';
  if (event.type === Wave3Signals.RUNTIME_RECOVERY_EVENT) return `recovery:${event.payload?.eventId ?? 'latest'}`;
  return event.type;
}
