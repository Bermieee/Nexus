class MemoryStorage {
  #data = new Map();
  getItem(key) { return this.#data.has(key) ? this.#data.get(key) : null; }
  setItem(key, value) { this.#data.set(key, String(value)); }
  removeItem(key) { this.#data.delete(key); }
}

export class UIStateStore {
  constructor({ storage, namespace = 'area52.ui.v1', defaults = {} } = {}) {
    this.storage = storage ?? globalThis.localStorage ?? new MemoryStorage();
    this.namespace = namespace;
    this.defaults = structuredCloneSafe(defaults);
    this.lastError = null;
  }

  load() {
    try {
      const raw = this.storage.getItem(this.namespace);
      if (!raw) return structuredCloneSafe(this.defaults);
      return { ...structuredCloneSafe(this.defaults), ...JSON.parse(raw) };
    } catch (error) {
      this.lastError = error;
      return structuredCloneSafe(this.defaults);
    }
  }

  save(patch) {
    try {
      const next = { ...this.load(), ...patch };
      this.storage.setItem(this.namespace, JSON.stringify(next));
      return next;
    } catch (error) {
      this.lastError = error;
      return { ...this.load(), ...patch };
    }
  }

  clear() {
    try { this.storage.removeItem(this.namespace); } catch (error) { this.lastError = error; }
  }
}

function structuredCloneSafe(value) {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}
