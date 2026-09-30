import { Signals } from './constants.js';
import { ResourceScope } from './lifecycle.js';

export class InspectorController {
  constructor({ host, registry, signals, scheduler, services = {} }) {
    this.host = host;
    this.registry = registry;
    this.signals = signals;
    this.scheduler = scheduler;
    this.services = services;
    this.scope = new ResourceScope();
    this.renderScope = new ResourceScope();
    this.selection = null;
    this.focusPending = false;
  }

  mount() {
    this.host.setAttribute('aria-label', 'Inspector');
    this.scope.subscribe(this.signals, Signals.UI_INSPECT_SELECTION_CHANGED, ({ payload }) => this.select(payload.object ?? null));
    this.scope.add(this.registry.subscribe?.(() => {
      if (this.selection) this.scheduler.invalidate('inspector:registry', () => this.render(), { cost: 'NORMAL' });
    }));
    this.render();
  }

  select(object) {
    this.selection = object;
    this.focusPending = Boolean(object);
    this.scheduler.invalidate('inspector', () => this.render(), { cost: 'NORMAL' });
  }

  clear() { this.select(null); }

  render() {
    this.renderScope.cleanup();
    this.renderScope = new ResourceScope();
    const doc = this.host.ownerDocument;
    if (!this.selection) {
      const empty = doc.createElement('div');
      empty.className = 'a52-inspector-empty';
      empty.innerHTML = '<h2>Inspector</h2><p>Select an object to inspect provenance, history, dependencies, or runtime details.</p>';
      this.host.replaceChildren(empty);
      this.focusPending = false;
      return;
    }
    const renderer = this.registry.resolve(this.selection.kind);
    if (!renderer) {
      this.host.textContent = `No inspector renderer for ${this.selection.kind}`;
      return;
    }
    const rendered = renderer(this.selection, { document: doc, services: this.services, scope: this.renderScope });
    this.host.replaceChildren(rendered);
    if (this.focusPending) {
      if (!rendered.hasAttribute?.('tabindex')) rendered.setAttribute?.('tabindex', '-1');
      rendered.focus?.({ preventScroll: false });
      this.focusPending = false;
    }
  }

  destroy() { this.renderScope.cleanup(); this.scope.cleanup(); this.host.replaceChildren(); }
}
