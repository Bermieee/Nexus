import { ResourceScope } from './lifecycle.js';
import { ResponsiveMode } from './constants.js';
import { trapFocus } from './accessibility.js';

export class OverlayManager {
  constructor({ document = globalThis.document, root, getResponsiveMode = () => ResponsiveMode.WIDE } = {}) {
    this.document = document;
    this.root = root ?? document?.body;
    this.getResponsiveMode = getResponsiveMode;
    this.stack = [];
    this.host = null;
  }

  ensureHost() {
    if (this.host) return this.host;
    this.host = this.document.createElement('div');
    this.host.className = 'a52-overlay-root';
    this.host.setAttribute('aria-live', 'polite');
    this.root.append(this.host);
    return this.host;
  }

  open({ id = `overlay-${Date.now()}`, type = 'modal', title = '', content, closeOnEscape = true, closeOnBackdrop = true } = {}) {
    const host = this.ensureHost();
    const scope = new ResourceScope();
    const previousFocus = this.document.activeElement;
    const layer = this.document.createElement('div');
    const effectiveType = type === 'modal' && this.getResponsiveMode() === ResponsiveMode.STACKED ? 'drawer' : type;
    layer.className = `a52-overlay a52-overlay--${effectiveType}`;
    layer.dataset.overlayId = id;
    layer.style.zIndex = String(1000 + this.stack.length * 10);
    layer.innerHTML = `<div class="a52-overlay__backdrop" data-backdrop></div><section class="a52-overlay__surface" role="dialog" aria-modal="true" tabindex="-1"><header><h2></h2><button type="button" data-close aria-label="Close">×</button></header><div class="a52-overlay__content"></div></section>`;
    layer.querySelector('h2').textContent = title;
    const contentHost = layer.querySelector('.a52-overlay__content');
    if (typeof content === 'string') contentHost.textContent = content;
    else if (content) contentHost.append(content);
    host.append(layer);

    const close = () => this.close(id);
    scope.listen(layer.querySelector('[data-close]'), 'click', close);
    scope.listen(layer, 'click', (event) => {
      if (closeOnBackdrop && event.target?.matches?.('[data-backdrop]')) close();
    });
    scope.listen(layer, 'keydown', (event) => {
      if (closeOnEscape && event.key === 'Escape') { event.preventDefault(); close(); return; }
      trapFocus(layer.querySelector('.a52-overlay__surface'), event);
    });
    layer.querySelector('.a52-overlay__surface').focus();
    const record = { id, layer, scope, previousFocus };
    this.stack.push(record);
    return { id, close };
  }

  close(id) {
    const index = this.stack.findIndex((record) => record.id === id);
    if (index < 0) return false;
    const [record] = this.stack.splice(index, 1);
    record.scope.cleanup();
    record.layer.remove();
    record.previousFocus?.focus?.();
    return true;
  }

  closeTop() { return this.stack.length ? this.close(this.stack.at(-1).id) : false; }
  destroy() { while (this.stack.length) this.closeTop(); this.host?.remove(); this.host = null; }
}
