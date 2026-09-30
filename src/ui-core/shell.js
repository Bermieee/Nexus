import { ResourceScope } from './lifecycle.js';
import { ResponsiveController } from './responsive.js';
import { installRovingFocus } from './accessibility.js';
import { Signals } from './constants.js';
import { element } from './primitives.js';

export class ApplicationShell {
  constructor({ root, workspaceRegistry, inspector, signals, stateStore, renderWorkspace, productName = 'Nexus', productTagline = 'Cognitive Story System' }) {
    this.root = root;
    this.productName = productName;
    this.productTagline = productTagline;
    this.workspaceRegistry = workspaceRegistry;
    this.inspector = inspector;
    this.signals = signals;
    this.stateStore = stateStore;
    this.renderWorkspace = renderWorkspace;
    this.scope = new ResourceScope();
    this.navScope = new ResourceScope();
    this.currentWorkspace = null;
    this.mode = null;
    this.nodes = {};
  }

  mount() {
    const doc = this.root.ownerDocument;
    this.root.classList.add('nexus-app');
    const header = element(doc, 'header', { className: 'nexus-shell__header' });
    const brand = element(doc, 'div', { className: 'nexus-brand', attrs: { 'aria-label': this.productTagline ? `${this.productName} — ${this.productTagline}` : this.productName } });
    brand.append(element(doc, 'span', { className: 'nexus-brand__name', text: this.productName }));
    if (this.productTagline) brand.append(element(doc, 'span', { className: 'nexus-brand__tagline', text: this.productTagline }));
    const search = element(doc, 'input', { className: 'nexus-search', attrs: { type: 'search', placeholder: 'Search UI…', 'aria-label': 'Search' } });
    header.append(brand, search);

    const nav = element(doc, 'nav', { className: 'nexus-shell__nav', attrs: { 'aria-label': 'Workspaces' } });
    const workspace = element(doc, 'main', { className: 'nexus-shell__workspace', attrs: { id: 'nexus-workspace', tabindex: '-1' } });
    // Keep a detached inspector host for legacy inspection data/rendering contracts.
    // It is intentionally never mounted into the visible shell.
    const inspectorHost = element(doc, 'div', { className: 'nexus-shell__inspector nexus-shell__inspector--detached', attrs: { 'aria-hidden': 'true' } });
    const strip = element(doc, 'footer', { className: 'nexus-shell__activity', attrs: { 'aria-live': 'polite' }, text: 'Runtime idle' });
    const toastHost = element(doc, 'div', { className: 'nexus-shell__toasts' });
    this.root.replaceChildren(header, nav, workspace, strip, toastHost);
    this.nodes = { header, brand, search, nav, workspace, inspectorHost, strip, toastHost };

    this.scope.add(this.workspaceRegistry.subscribe?.((change) => this.syncWorkspaceNav(change)));
    this.syncWorkspaceNav();

    this.scope.listen(search, 'keydown', (event) => {
      if (event.key === 'Escape') { search.value = ''; workspace.focus(); }
    });
    this.scope.listen(doc, 'keydown', (event) => {
      if (event.key === '/' && !['INPUT', 'TEXTAREA'].includes(doc.activeElement?.tagName)) { event.preventDefault(); search.focus(); }
    });
    this.scope.subscribe(this.signals, Signals.UI_RUNTIME_ACTIVITY, ({ payload }) => { strip.textContent = payload.message ?? 'Runtime activity'; });

    const responsive = new ResponsiveController({ root: this.root, scope: this.scope, onChange: (mode) => { this.mode = mode; } });
    responsive.mount();

    this.inspector.host = inspectorHost;
    this.inspector.mount();
    const persisted = this.stateStore.load();
    const entries = this.#navigationEntries();
    const initial = entries.some((w) => w.id === persisted.selectedWorkspace)
      ? persisted.selectedWorkspace
      : (entries.some((w) => w.id === 'home') ? 'home' : entries[0]?.id);
    if (initial) this.selectWorkspace(initial);
    return this;
  }

  syncWorkspaceNav(change = null) {
    const nav = this.nodes.nav;
    if (!nav) return;
    this.navScope.cleanup();
    this.navScope = new ResourceScope();
    nav.replaceChildren();
    const entries = this.#navigationEntries();
    for (const entry of entries) {
      const badges = [entry.lifecycle, entry.availability].filter(Boolean).map((value) => `[${value}]`).join(' ');
      const button = element(nav.ownerDocument, 'button', {
        className: 'nexus-nav-item',
        text: `${entry.icon ? `${entry.icon} ` : ''}${badges ? `${badges} ` : ''}${entry.title}`,
        attrs: { type: 'button' },
        dataset: { workspaceId: entry.id, rovingItem: '', category: entry.category ?? 'Built-in' },
      });
      this.navScope.listen(button, 'click', () => this.selectWorkspace(entry.id));
      nav.append(button);
    }
    installRovingFocus(nav, this.navScope);

    if (this.currentWorkspace && !this.workspaceRegistry.has(this.currentWorkspace)) {
      this.currentWorkspace = null;
      const fallback = entries[0]?.id;
      if (fallback) this.selectWorkspace(fallback);
      else this.nodes.workspace?.replaceChildren();
      return;
    }
    this.#syncSelectedNav();
    if (change?.type === 'updated' && change.workspace?.id === this.currentWorkspace) {
      this.renderWorkspace(change.workspace, this.nodes.workspace);
    }
  }

  selectWorkspace(id) {
    const entry = this.workspaceRegistry.get(id);
    if (this.currentWorkspace === id) {
      this.#syncSelectedNav();
      return;
    }
    this.currentWorkspace = id;
    this.stateStore.save({ selectedWorkspace: id });
    this.#syncSelectedNav();
    this.renderWorkspace(entry, this.nodes.workspace);
    this.signals.publish(Signals.UI_WORKSPACE_CHANGED, { workspaceId: id }, { source: 'ui-core' });
  }

  refreshCurrentWorkspace() {
    if (!this.currentWorkspace || !this.workspaceRegistry.has(this.currentWorkspace)) return false;
    this.renderWorkspace(this.workspaceRegistry.get(this.currentWorkspace), this.nodes.workspace);
    return true;
  }

  #navigationEntries() {
    const all = this.workspaceRegistry.list();
    const product = all
      .filter((entry) => entry.navigation?.level === 'product')
      .sort((a, b) => (a.navigation?.order ?? 0) - (b.navigation?.order ?? 0)
        || a.registrationSequence - b.registrationSequence);
    return product.length ? product : all;
  }

  #syncSelectedNav() {
    for (const button of this.nodes.nav?.querySelectorAll?.('[data-workspace-id]') ?? []) {
      const selected = button.dataset.workspaceId === this.currentWorkspace;
      button.classList.toggle('is-selected', selected);
      button.setAttribute('aria-current', selected ? 'page' : 'false');
    }
  }

  destroy() {
    this.navScope.cleanup();
    this.scope.cleanup();
    this.inspector.destroy();
    this.root.replaceChildren();
  }
}
