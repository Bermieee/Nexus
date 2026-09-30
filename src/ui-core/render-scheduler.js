import { RenderCost } from './constants.js';

const COST_ORDER = Object.freeze({
  [RenderCost.CHEAP]: 0,
  [RenderCost.NORMAL]: 1,
  [RenderCost.EXPENSIVE]: 2,
});

/**
 * Central frame scheduler. Repeated invalidations for one key coalesce to the
 * newest callback. EXPENSIVE work may be marked lazy and is skipped when hidden.
 */
export class RenderScheduler {
  #queue = new Map();
  #frame = null;
  #requestFrame;
  #cancelFrame;
  #onError;
  #destroyed = false;

  constructor({ requestFrame, cancelFrame, onError } = {}) {
    this.#requestFrame = requestFrame ?? ((cb) => globalThis.requestAnimationFrame?.(cb) ?? setTimeout(() => cb(Date.now()), 0));
    this.#cancelFrame = cancelFrame ?? ((id) => globalThis.cancelAnimationFrame?.(id) ?? clearTimeout(id));
    this.#onError = onError ?? ((error) => console.error('[UI.Core render]', error));
  }

  invalidate(key, render, { cost = RenderCost.NORMAL, visible = true, lazy = false } = {}) {
    if (this.#destroyed) return false;
    if (typeof render !== 'function') throw new TypeError('render must be a function');
    this.#queue.set(key, { key, render, cost, visible, lazy });
    if (this.#frame == null) this.#frame = this.#requestFrame((ts) => this.flush(ts));
    return true;
  }

  cancel(key) {
    return this.#queue.delete(key);
  }

  cancelPrefix(prefix) {
    let removed = 0;
    for (const key of [...this.#queue.keys()]) {
      if (String(key).startsWith(prefix)) { this.#queue.delete(key); removed += 1; }
    }
    return removed;
  }

  flush(timestamp = Date.now()) {
    if (this.#destroyed) return 0;
    this.#frame = null;
    const work = [...this.#queue.values()]
      .filter((item) => item.visible || !(item.lazy && item.cost === RenderCost.EXPENSIVE))
      .sort((a, b) => (COST_ORDER[a.cost] ?? 1) - (COST_ORDER[b.cost] ?? 1));
    this.#queue.clear();
    for (const item of work) {
      try {
        item.render(timestamp);
      } catch (error) {
        this.#onError(error, item);
      }
    }
    return work.length;
  }

  get pendingCount() {
    return this.#queue.size;
  }

  destroy() {
    this.#destroyed = true;
    this.#queue.clear();
    if (this.#frame != null) this.#cancelFrame(this.#frame);
    this.#frame = null;
  }
}
