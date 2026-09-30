/**
 * Lightweight typed signal hub. Payloads are intentionally small and frozen.
 * Detailed state is loaded explicitly by the view/inspector that needs it.
 */
export class SignalHub {
  #listeners = new Map();
  #sequence = 0;

  subscribe(type, handler, { filter } = {}) {
    if (typeof handler !== 'function') throw new TypeError('Signal handler must be a function');
    const record = { handler, filter };
    const set = this.#listeners.get(type) ?? new Set();
    set.add(record);
    this.#listeners.set(type, set);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      set.delete(record);
      if (!set.size) this.#listeners.delete(type);
    };
  }

  subscribeMany(types, handler, options) {
    const releases = types.map((type) => this.subscribe(type, handler, options));
    return () => releases.splice(0).forEach((release) => release());
  }

  publish(type, payload = {}, meta = {}) {
    const envelope = Object.freeze({
      type,
      payload: Object.freeze({ ...payload }),
      sequence: ++this.#sequence,
      timestamp: meta.timestamp ?? Date.now(),
      source: meta.source ?? 'unknown',
      revision: meta.revision ?? null,
    });
    const listeners = [...(this.#listeners.get(type) ?? []), ...(this.#listeners.get('*') ?? [])];
    for (const record of listeners) {
      if (!record.filter || record.filter(envelope)) record.handler(envelope);
    }
    return envelope;
  }

  listenerCount(type) {
    return this.#listeners.get(type)?.size ?? 0;
  }

  clear() {
    this.#listeners.clear();
  }
}
