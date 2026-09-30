import { RenderCost, WidgetCategory } from './constants.js';

const VALID_COST = new Set(Object.values(RenderCost));
const VALID_CATEGORY = new Set(Object.values(WidgetCategory));

function validateWidgetSpec(spec) {
  if (!spec?.widgetId || typeof spec.widgetId !== 'string') throw new TypeError('widgetId is required');
  if (!spec.version || typeof spec.version !== 'string') throw new TypeError(`${spec.widgetId}: version is required`);
  if (!VALID_CATEGORY.has(spec.category)) throw new TypeError(`${spec.widgetId}: invalid category`);
  if (!VALID_COST.has(spec.renderCostClass)) throw new TypeError(`${spec.widgetId}: invalid renderCostClass`);
  if (typeof spec.create !== 'function') throw new TypeError(`${spec.widgetId}: create() is required`);
  return Object.freeze({
    ...spec,
    propsSchema: Object.freeze({ ...(spec.propsSchema ?? {}) }),
    supportedActions: Object.freeze([...(spec.supportedActions ?? [])]),
    subscriptions: Object.freeze([...(spec.subscriptions ?? [])]),
    permissions: Object.freeze([...(spec.permissions ?? [])]),
  });
}

export class WidgetRegistry {
  #widgets = new Map();

  register(spec) {
    const normalized = validateWidgetSpec(spec);
    if (this.#widgets.has(normalized.widgetId)) throw new Error(`Widget already registered: ${normalized.widgetId}`);
    this.#widgets.set(normalized.widgetId, normalized);
    return normalized;
  }

  get(widgetId) {
    const spec = this.#widgets.get(widgetId);
    if (!spec) throw new Error(`Unknown widget: ${widgetId}`);
    return spec;
  }

  has(widgetId) { return this.#widgets.has(widgetId); }
  list({ category } = {}) {
    return [...this.#widgets.values()].filter((spec) => !category || spec.category === category);
  }
}

export class WorkspaceRegistry {
  #workspaces = new Map();
  #listeners = new Set();
  #sequence = 0;

  register(workspace) {
    if (!workspace?.id || !workspace?.title) throw new TypeError('workspace id/title required');
    if (this.#workspaces.has(workspace.id)) throw new Error(`Workspace already registered: ${workspace.id}`);
    const normalized = this.#normalize(workspace, ++this.#sequence);
    this.#workspaces.set(normalized.id, normalized);
    this.#notify({ type: 'registered', workspace: normalized });
    return normalized;
  }

  update(id, patch = {}) {
    const current = this.get(id);
    if (patch.id && patch.id !== id) throw new Error('Workspace id cannot change');
    const normalized = this.#normalize({ ...current, ...patch, id }, current.registrationSequence);
    this.#workspaces.set(id, normalized);
    this.#notify({ type: 'updated', workspace: normalized, previous: current });
    return normalized;
  }

  unregister(id) {
    const current = this.#workspaces.get(id);
    if (!current) return false;
    this.#workspaces.delete(id);
    this.#notify({ type: 'unregistered', workspace: current });
    return true;
  }

  get(id) {
    const workspace = this.#workspaces.get(id);
    if (!workspace) throw new Error(`Unknown workspace: ${id}`);
    return workspace;
  }

  has(id) { return this.#workspaces.has(id); }

  list({ category, navigationLevel } = {}) {
    return [...this.#workspaces.values()].filter((workspace) =>
      (!category || workspace.category === category)
      && (!navigationLevel || workspace.navigation?.level === navigationLevel));
  }

  subscribe(listener) {
    if (typeof listener !== 'function') throw new TypeError('WorkspaceRegistry listener must be a function');
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #normalize(workspace, registrationSequence) {
    return Object.freeze({
      ...workspace,
      id: workspace.id,
      title: workspace.title,
      icon: workspace.icon ?? '',
      category: workspace.category ?? 'Built-in',
      views: Object.freeze([...(workspace.views ?? [])]),
      supportedActions: Object.freeze([...(workspace.supportedActions ?? [])]),
      navigation: Object.freeze({
        ...(workspace.navigation ?? {}),
        level: workspace.navigation?.level ?? 'advanced',
        order: Number(workspace.navigation?.order ?? registrationSequence),
      }),
      render: workspace.render,
      registrationSequence,
    });
  }

  #notify(change) {
    for (const listener of [...this.#listeners]) {
      try { listener(change); } catch {}
    }
  }
}

export class InspectorRegistry {
  #renderers = new Map();
  #listeners = new Set();

  register(kind, renderer) {
    if (!kind || typeof renderer !== 'function') throw new TypeError('Inspector kind and renderer required');
    if (this.#renderers.has(kind)) throw new Error(`Inspector already registered: ${kind}`);
    this.#renderers.set(kind, renderer);
    this.#notify({ type: 'registered', kind });
    return () => this.unregister(kind, renderer);
  }

  unregister(kind, expectedRenderer = null) {
    const current = this.#renderers.get(kind);
    if (!current || (expectedRenderer && current !== expectedRenderer)) return false;
    this.#renderers.delete(kind);
    this.#notify({ type: 'unregistered', kind });
    return true;
  }

  has(kind) { return this.#renderers.has(kind); }
  list() { return [...this.#renderers.keys()]; }

  resolve(kind) { return this.#renderers.get(kind) ?? this.#renderers.get('*') ?? null; }

  subscribe(listener) {
    if (typeof listener !== 'function') throw new TypeError('InspectorRegistry listener must be a function');
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #notify(change) {
    for (const listener of [...this.#listeners]) {
      try { listener(change); } catch {}
    }
  }
}
