import { Signals } from './constants.js';

export class NotificationCenter {
  constructor({ signals, max = 50 } = {}) {
    this.signals = signals;
    this.max = max;
    this.items = [];
  }

  push(notification) {
    const item = Object.freeze({
      id: notification.id ?? `notice-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      status: notification.status ?? 'ready',
      title: notification.title ?? '',
      message: notification.message ?? '',
      createdAt: notification.createdAt ?? Date.now(),
      acknowledged: Boolean(notification.acknowledged),
    });
    this.items.unshift(item);
    if (this.items.length > this.max) this.items.length = this.max;
    this.signals?.publish(Signals.UI_NOTIFICATION, { id: item.id, status: item.status, title: item.title, message: item.message }, { source: 'ui-core' });
    return item;
  }

  list({ includeAcknowledged = true } = {}) {
    return this.items.filter((item) => includeAcknowledged || !item.acknowledged).map((item) => ({ ...item }));
  }

  acknowledge(id) {
    const index = this.items.findIndex((item) => item.id === id);
    if (index < 0) return false;
    if (!this.items[index].acknowledged) this.items[index] = Object.freeze({ ...this.items[index], acknowledged: true });
    this.#changed('acknowledged', id);
    return true;
  }

  dismiss(id) {
    const index = this.items.findIndex((item) => item.id === id);
    if (index < 0) return false;
    this.items.splice(index, 1);
    this.#changed('dismissed', id);
    return true;
  }

  clear() {
    if (!this.items.length) return 0;
    const count = this.items.length;
    this.items.length = 0;
    this.#changed('cleared', null);
    return count;
  }

  #changed(action, id) {
    this.signals?.publish(Signals.UI_NOTIFICATION_CHANGED, { action, id, count: this.items.length }, { source: 'ui-core' });
  }
}

export class ToastViewport {
  constructor({ host, signals, scope, limit = 4 } = {}) {
    this.host = host;
    this.signals = signals;
    this.scope = scope;
    this.limit = limit;
    this.items = [];
    this.root = null;
  }

  mount() {
    this.host.classList.add('a52-toast-viewport');
    this.host.setAttribute('aria-live', 'polite');
    const doc = this.host.ownerDocument;
    this.root = doc.createElement('div');
    this.root.className = 'a52-toast-stack';
    this.host.append(this.root);
    this.scope.subscribe(this.signals, Signals.UI_NOTIFICATION, ({ payload }) => {
      this.items.unshift(payload);
      this.items.length = Math.min(this.items.length, this.limit);
      this.render();
    });
  }

  render() {
    const doc = this.host.ownerDocument;
    if (!this.root) return;
    this.root.replaceChildren(...this.items.map((item) => {
      const node = doc.createElement('div');
      node.className = 'a52-toast';
      node.dataset.status = item.status;
      node.innerHTML = '<strong></strong><span></span>';
      node.querySelector('strong').textContent = item.title;
      node.querySelector('span').textContent = item.message;
      return node;
    }));
  }
}
