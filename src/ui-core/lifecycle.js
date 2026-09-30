import { RenderCost } from './constants.js';

let instanceSequence = 0;

export class ResourceScope {
  #cleanups = [];
  #closed = false;

  add(cleanup) {
    if (this.#closed) {
      try { cleanup?.(); } catch {}
      return cleanup;
    }
    if (typeof cleanup === 'function') this.#cleanups.push(cleanup);
    return cleanup;
  }

  listen(target, type, handler, options) {
    target?.addEventListener?.(type, handler, options);
    return this.add(() => target?.removeEventListener?.(type, handler, options));
  }

  subscribe(signalHub, type, handler, options) {
    return this.add(signalHub.subscribe(type, handler, options));
  }

  timeout(callback, delay) {
    const id = setTimeout(callback, delay);
    return this.add(() => clearTimeout(id));
  }

  interval(callback, delay) {
    const id = setInterval(callback, delay);
    return this.add(() => clearInterval(id));
  }

  observer(observer, target, options) {
    observer.observe(target, options);
    return this.add(() => observer.disconnect());
  }

  asyncResource(resource, disposer = (value) => value?.abort?.()) {
    return this.add(() => disposer(resource));
  }

  cleanup() {
    if (this.#closed) return;
    this.#closed = true;
    const cleanups = this.#cleanups.splice(0).reverse();
    for (const cleanup of cleanups) {
      try { cleanup(); } catch (error) { console.error('[UI.Core cleanup]', error); }
    }
  }

  get closed() { return this.#closed; }
  get size() { return this.#cleanups.length; }
}

export class WidgetInstance {
  constructor({ spec, host, props, services = {} }) {
    this.spec = spec;
    this.host = host;
    this.props = Object.freeze({ ...(props ?? {}) });
    this.services = services;
    this.instanceId = `${spec.widgetId}:${++instanceSequence}`;
    this.scope = new ResourceScope();
    this.state = 'registered';
    this.visible = true;
    this.impl = null;
  }

  mount() {
    if (this.state !== 'registered') throw new Error(`Cannot mount widget from ${this.state}`);
    const scheduler = this.services.scheduler;
    const requestRender = (key, render, options = {}) => scheduler?.invalidate(
      `${this.instanceId}:${key}`,
      render,
      { cost: this.spec.renderCostClass ?? RenderCost.NORMAL, visible: this.visible, ...options },
    );
    this.impl = this.spec.create?.({
      host: this.host,
      props: this.props,
      scope: this.scope,
      services: this.services,
      requestRender,
      instanceId: this.instanceId,
    }) ?? {};
    this.impl.mount?.();
    this.state = 'mounted';
    this.impl.subscribe?.();
    this.state = 'subscribed';
    return this;
  }

  update(nextProps = {}) {
    if (this.state === 'destroyed') return;
    const previous = this.props;
    this.props = Object.freeze({ ...this.props, ...nextProps });
    this.impl?.update?.(this.props, previous);
  }

  resize(rect) {
    if (this.state !== 'destroyed') this.impl?.resize?.(rect);
  }

  show() {
    this.visible = true;
    this.impl?.show?.();
  }

  hide() {
    this.visible = false;
    this.impl?.hide?.();
  }

  destroy() {
    if (this.state === 'destroyed') return;
    this.impl?.destroy?.();
    this.scope.cleanup();
    this.services.scheduler?.cancelPrefix?.(`${this.instanceId}:`);
    if (this.host?.replaceChildren) this.host.replaceChildren();
    this.state = 'destroyed';
  }
}

export class WidgetRuntime {
  constructor({ registry, services = {} }) {
    this.registry = registry;
    this.services = services;
    this.instances = new Map();
  }

  mount(widgetId, host, props) {
    const spec = this.registry.get(widgetId);
    const instance = new WidgetInstance({ spec, host, props, services: this.services }).mount();
    this.instances.set(instance.instanceId, instance);
    return instance;
  }

  destroy(instanceOrId) {
    const id = typeof instanceOrId === 'string' ? instanceOrId : instanceOrId?.instanceId;
    const instance = this.instances.get(id);
    instance?.destroy();
    this.instances.delete(id);
  }

  destroyAll() {
    [...this.instances.values()].forEach((instance) => instance.destroy());
    this.instances.clear();
  }
}
