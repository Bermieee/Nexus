import { KnowledgeStatus, RuntimeStatus, Signals } from './constants.js';

export const ProductDetailLevel = Object.freeze({
  NORMAL: 'NORMAL',
  DETAIL: 'DETAIL',
  ADVANCED: 'ADVANCED',
});

export const ProductHealth = Object.freeze({
  READY: 'READY',
  LEARNING: 'LEARNING',
  STUDYING: 'STUDYING',
  CURRENT: 'CURRENT',
  INITIALIZING: 'INITIALIZING',
  DEGRADED: 'DEGRADED',
  BLOCKED: 'BLOCKED',
  UNAVAILABLE: 'UNAVAILABLE',
  IDLE: 'IDLE',
});

const DETAIL_LEVELS = new Set(Object.values(ProductDetailLevel));
const HEALTH = new Set(Object.values(ProductHealth));

export class ProductPresentationState {
  #listeners = new Set();

  constructor({ stateStore, defaultLevel = ProductDetailLevel.NORMAL } = {}) {
    if (!DETAIL_LEVELS.has(defaultLevel)) throw new TypeError(`Invalid default detail level: ${defaultLevel}`);
    this.stateStore = stateStore ?? null;
    const persisted = this.stateStore?.load?.().productDetailLevel;
    this.level = DETAIL_LEVELS.has(persisted) ? persisted : defaultLevel;
  }

  get() { return this.level; }

  set(level) {
    if (!DETAIL_LEVELS.has(level)) throw new TypeError(`Invalid product detail level: ${level}`);
    if (level === this.level) return this.level;
    this.level = level;
    this.stateStore?.save?.({ productDetailLevel: level });
    for (const listener of [...this.#listeners]) {
      try { listener(level); } catch {}
    }
    return level;
  }

  subscribe(listener) {
    if (typeof listener !== 'function') throw new TypeError('ProductPresentationState listener must be a function');
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}

export class FrontFaceUIAdapter {
  constructor({ snapshot, presentationState } = {}) {
    this.snapshot = normalizeProductSnapshot(snapshot);
    this.presentationState = presentationState ?? new ProductPresentationState();
  }

  getSnapshot() { return clone(this.snapshot); }
  getDetailLevel() { return this.presentationState.get(); }
  setDetailLevel(level) { return this.presentationState.set(level); }
  subscribeDetailLevel(listener) { return this.presentationState.subscribe(listener); }
  replaceSnapshot(snapshot) { this.snapshot = normalizeProductSnapshot(snapshot); return this.getSnapshot(); }
}

export class ProductActivityFeed {
  #pending = new Map();

  constructor({ scheduler, onUpdate = () => {}, max = 20 } = {}) {
    if (!scheduler?.invalidate) throw new TypeError('ProductActivityFeed requires a RenderScheduler-compatible scheduler');
    this.scheduler = scheduler;
    this.onUpdate = onUpdate;
    this.max = Math.max(1, Number(max) || 20);
    this.items = [];
  }

  push(activity) {
    const item = normalizeActivity(activity);
    this.#pending.set(item.key, item);
    this.scheduler.invalidate('wave5:product-activity', () => this.#flush(), { cost: 'CHEAP' });
    return item;
  }

  ingestSignal(event) {
    const translated = translateProductActivity(event);
    if (translated) this.push(translated);
    return translated;
  }

  list() { return this.items.map((item) => ({ ...item })); }
  get pendingCount() { return this.#pending.size; }

  #flush() {
    const updates = [...this.#pending.values()];
    this.#pending.clear();
    const updateKeys = new Set(updates.map((item) => item.key));
    this.items = [...updates.reverse(), ...this.items.filter((item) => !updateKeys.has(item.key))].slice(0, this.max);
    this.onUpdate(this.list());
  }
}

export function normalizeProductSnapshot(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('Front Face snapshot must be an object');
  if (!input.story?.title) throw new TypeError('Front Face snapshot requires story.title');
  if (!input.brain?.overall) throw new TypeError('Front Face snapshot requires brain.overall');
  if (!HEALTH.has(input.brain.overall)) throw new TypeError(`Unknown product health: ${input.brain.overall}`);
  if (input.scene && input.scene.atmosphere?.authority === KnowledgeStatus.CANONICAL && input.scene.atmosphere?.inferred === true) {
    throw new TypeError('Inferred atmosphere cannot be marked canonical');
  }
  const copy = clone(input);
  copy.source = copy.source ?? 'ADAPTER';
  return deepFreeze(copy);
}

export function translateProductActivity(event) {
  if (!event?.type) return null;
  const payload = event.payload ?? {};
  if (event.type === Signals.WORKER_STATE_CHANGED) {
    if ([RuntimeStatus.YIELDING, RuntimeStatus.PARKED].includes(payload.state)) {
      return { key: `worker:${payload.workerId ?? 'background'}`, status: 'paused', message: 'Background work paused while foreground work runs.', sourceType: event.type };
    }
    if (payload.state === RuntimeStatus.ACTIVE) {
      return { key: `worker:${payload.workerId ?? 'active'}`, status: 'active', message: payload.layer === 'L1' ? 'Foreground cognition is active.' : 'Background study is active.', sourceType: event.type };
    }
    if (payload.state === RuntimeStatus.COMPLETE) {
      return { key: `worker:${payload.workerId ?? 'complete'}`, status: 'complete', message: 'Background study completed.', sourceType: event.type };
    }
  }
  if (event.type === Signals.BATCH_PROGRESS_CHANGED) {
    return { key: `batch:${payload.batchId ?? 'background'}`, status: 'active', message: `Background study ${payload.progress ?? 0}% complete.`, sourceType: event.type };
  }
  if (event.type === Signals.CLAIM_STATE_CHANGED) {
    return { key: 'truth', status: 'complete', message: 'Current truth was checked.', sourceType: event.type };
  }
  if (event.type === Signals.REFLECTION_CHANGED) {
    return { key: 'memory', status: 'complete', message: 'Memory learning was updated.', sourceType: event.type };
  }
  return null;
}

function normalizeActivity(input) {
  if (!input || typeof input !== 'object') throw new TypeError('Product activity must be an object');
  const message = String(input.message ?? '').trim();
  if (!message) throw new TypeError('Product activity requires a message');
  const key = String(input.key ?? input.id ?? message).trim();
  return Object.freeze({
    key,
    message,
    status: input.status ?? 'active',
    sourceType: input.sourceType ?? null,
    at: input.at ?? null,
  });
}

function clone(value) {
  if (value == null) return value;
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
