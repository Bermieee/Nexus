import { element, makeBadge } from './primitives.js';

export const UI_EXTENSION_SCHEMA_MAJOR = 1;

export const UIExtensionLifecycle = Object.freeze({
  EXPERIMENTAL: 'EXPERIMENTAL',
  SHADOW: 'SHADOW',
  ACTIVE: 'ACTIVE',
  DEPRECATED: 'DEPRECATED',
});

export const UIExtensionAvailability = Object.freeze({
  AVAILABLE: 'AVAILABLE',
  DEGRADED: 'DEGRADED',
  UNAVAILABLE: 'UNAVAILABLE',
  SHADOW: 'SHADOW',
});

const LIFECYCLE = new Set(Object.values(UIExtensionLifecycle));
const AVAILABILITY = new Set(Object.values(UIExtensionAvailability));

export class UIExtensionCompatibilityError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'UIExtensionCompatibilityError';
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

export function validateUIExtensionDescriptor(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('invalid-descriptor', 'UI extension descriptor must be an object');
  assertNoFunctions(input);
  const extensionId = requiredString(input.extensionId, 'extensionId');
  const subsystemId = requiredString(input.subsystemId, 'subsystemId');
  const schemaVersion = requiredString(input.schemaVersion, 'schemaVersion');
  const major = parseMajor(schemaVersion);
  if (major !== UI_EXTENSION_SCHEMA_MAJOR) fail('unsupported-schema-version', `Unsupported UI extension schema major: ${schemaVersion}`, { supportedMajor: UI_EXTENSION_SCHEMA_MAJOR });
  const display = input.display && typeof input.display === 'object' ? input.display : {};
  const title = requiredString(display.title ?? input.title, 'display.title');
  const lifecycle = input.lifecycle ?? UIExtensionLifecycle.ACTIVE;
  const availability = input.availability ?? (lifecycle === UIExtensionLifecycle.SHADOW ? UIExtensionAvailability.SHADOW : UIExtensionAvailability.AVAILABLE);
  if (!LIFECYCLE.has(lifecycle)) fail('invalid-lifecycle', `Invalid extension lifecycle: ${lifecycle}`);
  if (!AVAILABILITY.has(availability)) fail('invalid-availability', `Invalid extension availability: ${availability}`);

  const workspaces = freezeArray(input.workspaces, (surface, index) => normalizeWorkspace(surface, index, extensionId));
  const inspectors = freezeArray(input.inspectors, (surface, index) => normalizeInspector(surface, index, extensionId));
  const telemetry = freezeArray(input.telemetry ?? input.telemetrySurfaces, (surface, index) => normalizeTelemetry(surface, index, extensionId));
  const actions = freezeArray(input.actions, (action, index) => normalizeAction(action, index, extensionId));
  const frontFaceInput = input.frontFace && typeof input.frontFace === 'object' && !Array.isArray(input.frontFace) ? input.frontFace : {};
  const frontFace = Object.freeze({
    summaries: freezeArray(frontFaceInput.summaries, (surface, index) => normalizeFrontFaceContribution(surface, index, 'summaries', extensionId)),
    health: freezeArray(frontFaceInput.health, (surface, index) => normalizeFrontFaceContribution(surface, index, 'health', extensionId)),
    activity: freezeArray(frontFaceInput.activity, (surface, index) => normalizeFrontFaceContribution(surface, index, 'activity', extensionId)),
    notifications: freezeArray(frontFaceInput.notifications, (surface, index) => normalizeFrontFaceContribution(surface, index, 'notifications', extensionId)),
  });
  assertUnique(workspaces, 'id', 'workspace');
  assertUnique(inspectors, 'kind', 'inspector');
  assertUnique(telemetry, 'id', 'telemetry');
  assertUnique(actions, 'type', 'action');
  for (const [kind, contributions] of Object.entries(frontFace)) assertUnique(contributions, 'id', `front-face-${kind}`);

  const dependencies = freezeArray(input.dependencies, (dependency, index) => {
    if (!dependency || typeof dependency !== 'object') fail('invalid-descriptor', `dependencies[${index}] must be an object`);
    return Object.freeze({
      ...dependency,
      id: requiredString(dependency.id, `dependencies[${index}].id`),
      required: Boolean(dependency.required),
      status: dependency.status ?? UIExtensionAvailability.AVAILABLE,
    });
  });

  return Object.freeze({
    ...input,
    extensionId,
    subsystemId,
    schemaVersion,
    display: Object.freeze({ ...display, title, category: display.category ?? 'Cognitive Services', icon: display.icon ?? '', order: Number(display.order ?? 0) }),
    workspaces,
    inspectors,
    telemetry,
    actions,
    frontFace,
    lifecycle,
    availability,
    requiredCapabilities: Object.freeze(normalizeStrings(input.requiredCapabilities)),
    optionalCapabilities: Object.freeze(normalizeStrings(input.optionalCapabilities)),
    dependencies,
    permissions: Object.freeze(normalizeStrings(input.permissions)),
    authorityHints: Object.freeze(normalizeStrings(input.authorityHints)),
  });
}

export class UIExtensionRegistry {
  #extensions = new Map();
  #listeners = new Set();

  constructor({ workspaceRegistry, inspectorRegistry, actionRouter, scheduler = null } = {}) {
    if (!workspaceRegistry || !inspectorRegistry || !actionRouter) throw new TypeError('UIExtensionRegistry requires workspaceRegistry, inspectorRegistry and actionRouter');
    this.workspaceRegistry = workspaceRegistry;
    this.inspectorRegistry = inspectorRegistry;
    this.actionRouter = actionRouter;
    this.scheduler = scheduler;
  }

  register(descriptorInput, binding = {}) {
    const descriptor = validateUIExtensionDescriptor(descriptorInput);
    if (this.#extensions.has(descriptor.extensionId)) fail('duplicate-extension', `Extension already registered: ${descriptor.extensionId}`);
    this.#preflight(descriptor, binding);

    const state = {
      lifecycle: descriptor.lifecycle,
      availability: descriptor.availability,
      dependencies: descriptor.dependencies.map((item) => ({ ...item })),
      degradedReason: descriptor.degradedReason ?? null,
      revision: 1,
    };
    const record = {
      descriptor,
      binding,
      state,
      releases: [],
      telemetrySubscriptions: new Set(),
      mounts: 0,
    };

    try {
      const subsystemRouteId = `ui-extension:${descriptor.extensionId}`;
      if (descriptor.actions.length) {
        const releaseSubsystem = this.actionRouter.registerSubsystem(subsystemRouteId, async (action, context) => {
          const definition = descriptor.actions.find((item) => item.type === action.type);
          if (!definition) throw new Error(`Unregistered extension action: ${action.type}`);
          const handler = binding.actionHandlers?.[definition.operation];
          if (typeof handler !== 'function') throw new Error(`Extension action handler unavailable: ${definition.operation}`);
          return handler(action, context, this.#context(record));
        });
        record.releases.push(releaseSubsystem);
        for (const action of descriptor.actions) {
          record.releases.push(this.actionRouter.registerAction(action.type, {
            subsystem: subsystemRouteId,
            permissions: action.permissions,
            allowedStates: action.allowedStates,
            validate: action.validateToken ? ((request, context) => binding.validators?.[action.validateToken]?.(request, context, this.#context(record)) ?? true) : null,
            readOnly: action.readOnly,
          }));
        }
      }

      for (const inspector of descriptor.inspectors) {
        const renderer = (object, context) => this.#renderInspector(record, inspector, object, context);
        record.releases.push(this.inspectorRegistry.register(inspector.kind, renderer));
      }

      for (const workspace of descriptor.workspaces) {
        const entry = this.workspaceRegistry.register({
          id: workspace.id,
          title: workspace.title,
          icon: workspace.icon ?? descriptor.display.icon,
          category: workspace.category ?? descriptor.display.category,
          views: workspace.views,
          supportedActions: workspace.actions,
          extensionId: descriptor.extensionId,
          lifecycle: state.lifecycle,
          availability: state.availability,
          render: (host, ctx) => this.#renderWorkspace(record, workspace, host, ctx),
        });
        record.releases.push(() => this.workspaceRegistry.unregister(entry.id));
      }

      this.#extensions.set(descriptor.extensionId, record);
      this.#notify({ type: 'registered', extension: this.#snapshot(record) });
      return this.#snapshot(record);
    } catch (error) {
      for (const release of record.releases.splice(0).reverse()) {
        try { release(); } catch {}
      }
      throw error;
    }
  }

  tryRegister(descriptor, binding = {}) {
    try {
      return { ok: true, extension: this.register(descriptor, binding) };
    } catch (error) {
      return { ok: false, error: this.#diagnostic(error) };
    }
  }

  update(extensionId, patch = {}) {
    const record = this.#required(extensionId);
    if (patch.lifecycle != null && !LIFECYCLE.has(patch.lifecycle)) fail('invalid-lifecycle', `Invalid extension lifecycle: ${patch.lifecycle}`);
    if (patch.availability != null && !AVAILABILITY.has(patch.availability)) fail('invalid-availability', `Invalid extension availability: ${patch.availability}`);
    if (patch.lifecycle != null) record.state.lifecycle = patch.lifecycle;
    if (patch.availability != null) record.state.availability = patch.availability;
    if (patch.dependencies != null) record.state.dependencies = patch.dependencies.map((item) => ({ ...item }));
    if ('degradedReason' in patch) record.state.degradedReason = patch.degradedReason;
    record.state.revision += 1;
    for (const workspace of record.descriptor.workspaces) {
      if (this.workspaceRegistry.has(workspace.id)) {
        this.workspaceRegistry.update(workspace.id, {
          lifecycle: record.state.lifecycle,
          availability: record.state.availability,
        });
      }
    }
    this.#notify({ type: 'updated', extension: this.#snapshot(record) });
    return this.#snapshot(record);
  }

  listFrontFaceContributions(kind = 'summaries') {
    if (!['summaries','health','activity','notifications'].includes(kind)) fail('unknown-front-face-kind', `Unknown Front Face contribution kind: ${kind}`);
    const items = [];
    for (const record of this.#extensions.values()) {
      for (const contribution of record.descriptor.frontFace?.[kind] ?? []) {
        items.push(Object.freeze({
          extensionId: record.descriptor.extensionId,
          subsystemId: record.descriptor.subsystemId,
          extensionTitle: record.descriptor.display.title,
          lifecycle: record.state.lifecycle,
          availability: record.state.availability,
          contribution,
        }));
      }
    }
    return items.sort((a, b) => (a.contribution.order ?? 0) - (b.contribution.order ?? 0)
      || a.extensionTitle.localeCompare(b.extensionTitle)
      || a.contribution.id.localeCompare(b.contribution.id));
  }

  readFrontFaceContribution(extensionId, kind, contributionId) {
    const record = this.#required(extensionId);
    if (!['summaries','health','activity','notifications'].includes(kind)) fail('unknown-front-face-kind', `Unknown Front Face contribution kind: ${kind}`);
    const contribution = record.descriptor.frontFace?.[kind]?.find((item) => item.id === contributionId);
    if (!contribution) fail('unknown-front-face-contribution', `Unknown Front Face contribution: ${contributionId}`);
    if (record.state.availability === UIExtensionAvailability.UNAVAILABLE) return null;
    const provider = record.binding.frontFaceProviders?.[contribution.surfaceId];
    if (typeof provider !== 'function') fail('missing-front-face-binding', `Front Face provider unavailable: ${contribution.surfaceId}`);
    const adapter = contribution.adapter ? record.binding.adapters?.[contribution.adapter] : null;
    const value = provider({ contribution, adapter, extension: this.#snapshot(record) });
    if (value && typeof value.then === 'function') fail('invalid-front-face-result', 'Front Face summaries must be synchronous lightweight data');
    assertNoFunctions(value, 'frontFace-result');
    return value == null ? null : deepFreezeClone(value);
  }

  subscribeTelemetry(extensionId, telemetryId, handler) {
    const record = this.#required(extensionId);
    const surface = record.descriptor.telemetry.find((item) => item.id === telemetryId);
    if (!surface) fail('unknown-telemetry-surface', `Unknown telemetry surface: ${telemetryId}`);
    if (record.state.availability === UIExtensionAvailability.UNAVAILABLE) return () => {};
    const subscriber = record.binding.telemetrySubscribers?.[surface.surfaceId];
    if (typeof subscriber !== 'function') fail('missing-telemetry-binding', `Telemetry binding unavailable: ${surface.surfaceId}`);
    const adapter = surface.adapter ? record.binding.adapters?.[surface.adapter] : null;
    const releaseInner = subscriber({ surface, adapter, extension: this.#snapshot(record), handler });
    const release = once(() => {
      try { releaseInner?.(); } finally { record.telemetrySubscriptions.delete(release); }
    });
    record.telemetrySubscriptions.add(release);
    return release;
  }

  unregister(extensionId) {
    const record = this.#extensions.get(extensionId);
    if (!record) return false;
    for (const release of [...record.telemetrySubscriptions]) release();
    record.telemetrySubscriptions.clear();
    this.#extensions.delete(extensionId);
    for (const release of record.releases.splice(0).reverse()) {
      try { release(); } catch {}
    }
    this.scheduler?.cancelPrefix?.(`extension:${extensionId}:`);
    this.#notify({ type: 'unregistered', extension: this.#snapshot(record) });
    return true;
  }

  get(extensionId) { return this.#snapshot(this.#required(extensionId)); }
  has(extensionId) { return this.#extensions.has(extensionId); }

  list() {
    return [...this.#extensions.values()]
      .map((record) => this.#snapshot(record))
      .sort((a, b) => a.descriptor.display.category.localeCompare(b.descriptor.display.category)
        || a.descriptor.display.order - b.descriptor.display.order
        || a.descriptor.display.title.localeCompare(b.descriptor.display.title)
        || a.descriptor.extensionId.localeCompare(b.descriptor.extensionId));
  }

  subscribe(listener) {
    if (typeof listener !== 'function') throw new TypeError('UIExtensionRegistry listener must be a function');
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  destroy() {
    for (const id of [...this.#extensions.keys()]) this.unregister(id);
    this.#listeners.clear();
  }

  #preflight(descriptor, binding) {
    const adapters = binding.adapters ?? {};
    for (const workspace of descriptor.workspaces) {
      if (this.workspaceRegistry.has(workspace.id)) fail('duplicate-workspace', `Workspace already registered: ${workspace.id}`);
      if (!adapters[workspace.adapter]) fail('missing-required-adapter', `Workspace ${workspace.id} requires adapter ${workspace.adapter}`);
      if (typeof binding.workspaceRenderers?.[workspace.surfaceId] !== 'function') fail('missing-workspace-renderer', `Workspace renderer unavailable: ${workspace.surfaceId}`);
    }
    for (const inspector of descriptor.inspectors) {
      if (this.inspectorRegistry.has(inspector.kind)) fail('duplicate-inspector', `Inspector already registered: ${inspector.kind}`);
      if (inspector.adapter && !adapters[inspector.adapter]) fail('missing-required-adapter', `Inspector ${inspector.kind} requires adapter ${inspector.adapter}`);
      if (inspector.fallback && typeof binding.fallbackInspectors?.[inspector.fallback] !== 'function') fail('missing-inspector-renderer', `Fallback inspector unavailable: ${inspector.fallback}`);
      if (!inspector.fallback && typeof binding.inspectorRenderers?.[inspector.surfaceId] !== 'function') fail('missing-inspector-renderer', `Inspector renderer unavailable: ${inspector.surfaceId}`);
    }
    const telemetryIds = new Set();
    for (const surface of descriptor.telemetry) {
      if (telemetryIds.has(surface.id)) fail('duplicate-telemetry', `Duplicate telemetry surface: ${surface.id}`);
      telemetryIds.add(surface.id);
      if (surface.adapter && !adapters[surface.adapter]) fail('missing-required-adapter', `Telemetry ${surface.id} requires adapter ${surface.adapter}`);
      if (typeof binding.telemetrySubscribers?.[surface.surfaceId] !== 'function') fail('missing-telemetry-binding', `Telemetry binding unavailable: ${surface.surfaceId}`);
    }
    for (const action of descriptor.actions) {
      if (this.actionRouter.hasAction?.(action.type)) fail('duplicate-action', `Action already registered: ${action.type}`);
      if (action.adapter && !adapters[action.adapter]) fail('missing-required-adapter', `Action ${action.type} requires adapter ${action.adapter}`);
      if (typeof binding.actionHandlers?.[action.operation] !== 'function') fail('invalid-action', `Action handler unavailable: ${action.operation}`);
    }
    for (const contributions of Object.values(descriptor.frontFace ?? {})) {
      for (const contribution of contributions) {
        if (contribution.adapter && !adapters[contribution.adapter]) fail('missing-required-adapter', `Front Face ${contribution.id} requires adapter ${contribution.adapter}`);
        if (typeof binding.frontFaceProviders?.[contribution.surfaceId] !== 'function') fail('missing-front-face-binding', `Front Face provider unavailable: ${contribution.surfaceId}`);
      }
    }
  }

  #renderWorkspace(record, surface, host, ctx) {
    const doc = host.ownerDocument;
    const header = element(doc, 'section', { className: 'a52-extension-status' });
    header.append(
      makeBadge(doc, record.state.lifecycle, lifecycleBadge(record.state.lifecycle)),
      makeBadge(doc, record.state.availability, availabilityBadge(record.state.availability)),
      element(doc, 'strong', { text: record.descriptor.display.title }),
    );
    if (record.state.degradedReason) header.append(element(doc, 'span', { className: 'a52-muted', text: record.state.degradedReason }));
    if (record.state.dependencies.length) {
      const deps = element(doc, 'span', { className: 'a52-extension-deps', text: record.state.dependencies.map((dep) => `${dep.id}=${dep.status}`).join(' · ') });
      header.append(deps);
    }
    host.append(header);
    if (record.state.availability === UIExtensionAvailability.UNAVAILABLE) {
      host.append(element(doc, 'div', { className: 'a52-empty', text: 'This UI surface is currently unavailable. The shell remains operational.' }));
      return;
    }
    record.mounts += 1;
    ctx.scope?.add?.(() => { record.mounts = Math.max(0, record.mounts - 1); });
    const renderer = record.binding.workspaceRenderers[surface.surfaceId];
    const adapter = record.binding.adapters[surface.adapter];
    renderer(host, {
      ...ctx,
      adapter,
      surface,
      extension: this.#snapshot(record),
      subscribeTelemetry: (telemetryId, handler) => {
        const release = this.subscribeTelemetry(record.descriptor.extensionId, telemetryId, handler);
        ctx.scope?.add?.(release);
        return release;
      },
      routeAction: (type, payload = {}, context = {}) => this.actionRouter.route({ type, ...payload }, context),
    });
  }

  #renderInspector(record, surface, object, context) {
    if (record.state.availability === UIExtensionAvailability.UNAVAILABLE) {
      const root = element(context.document, 'div', { className: 'a52-stack' });
      root.append(element(context.document, 'h2', { text: record.descriptor.display.title }), makeBadge(context.document, 'UNAVAILABLE', 'error'), element(context.document, 'p', { text: 'Inspector surface unavailable; no backend authority was changed.' }));
      return root;
    }
    if (surface.fallback) {
      const fallback = record.binding.fallbackInspectors?.[surface.fallback];
      if (typeof fallback !== 'function') throw new Error(`Missing fallback inspector: ${surface.fallback}`);
      return fallback(object, context, this.#context(record));
    }
    const renderer = record.binding.inspectorRenderers[surface.surfaceId];
    const adapter = surface.adapter ? record.binding.adapters[surface.adapter] : null;
    return renderer(object, { ...context, adapter, extension: this.#snapshot(record) });
  }

  #context(record) {
    return Object.freeze({
      descriptor: record.descriptor,
      state: Object.freeze({
        lifecycle: record.state.lifecycle,
        availability: record.state.availability,
        dependencies: Object.freeze(record.state.dependencies.map((item) => Object.freeze({ ...item }))),
        degradedReason: record.state.degradedReason,
        revision: record.state.revision,
      }),
      adapters: record.binding.adapters ?? {},
    });
  }

  #snapshot(record) {
    return Object.freeze({
      descriptor: record.descriptor,
      state: Object.freeze({
        lifecycle: record.state.lifecycle,
        availability: record.state.availability,
        dependencies: Object.freeze(record.state.dependencies.map((item) => Object.freeze({ ...item }))),
        degradedReason: record.state.degradedReason,
        revision: record.state.revision,
      }),
      activeMounts: record.mounts,
      telemetrySubscriptions: record.telemetrySubscriptions.size,
    });
  }

  #required(id) {
    const record = this.#extensions.get(id);
    if (!record) fail('unknown-extension', `Unknown UI extension: ${id}`);
    return record;
  }

  #diagnostic(error) {
    return Object.freeze({
      name: error?.name ?? 'Error',
      code: error?.code ?? 'registration-failed',
      message: error?.message ?? String(error),
      details: error?.details ?? {},
    });
  }

  #notify(change) {
    for (const listener of [...this.#listeners]) {
      try { listener(change); } catch {}
    }
  }
}

function normalizeWorkspace(surface, index, extensionId) {
  if (!surface || typeof surface !== 'object') fail('invalid-descriptor', `workspaces[${index}] must be an object`);
  return Object.freeze({
    ...surface,
    id: requiredString(surface.id, `workspaces[${index}].id`),
    title: requiredString(surface.title, `workspaces[${index}].title`),
    adapter: requiredString(surface.adapter, `workspaces[${index}].adapter`),
    surfaceId: requiredString(surface.surfaceId, `workspaces[${index}].surfaceId`),
    category: surface.category ?? null,
    icon: surface.icon ?? '',
    views: Object.freeze(normalizeStrings(surface.views)),
    actions: Object.freeze(normalizeStrings(surface.actions)),
    extensionId,
  });
}

function normalizeInspector(surface, index, extensionId) {
  if (!surface || typeof surface !== 'object') fail('invalid-descriptor', `inspectors[${index}] must be an object`);
  const fallback = surface.fallback ?? null;
  if (!fallback && !surface.surfaceId) fail('invalid-descriptor', `inspectors[${index}] requires surfaceId or fallback`);
  return Object.freeze({
    ...surface,
    id: surface.id ?? surface.kind,
    kind: requiredString(surface.kind, `inspectors[${index}].kind`),
    adapter: surface.adapter ?? null,
    surfaceId: surface.surfaceId ?? null,
    fallback,
    extensionId,
  });
}

function normalizeTelemetry(surface, index, extensionId) {
  if (!surface || typeof surface !== 'object') fail('invalid-descriptor', `telemetry[${index}] must be an object`);
  return Object.freeze({
    ...surface,
    id: requiredString(surface.id, `telemetry[${index}].id`),
    signalType: requiredString(surface.signalType, `telemetry[${index}].signalType`),
    adapter: surface.adapter ?? null,
    surfaceId: requiredString(surface.surfaceId, `telemetry[${index}].surfaceId`),
    lightweight: surface.lightweight !== false,
    extensionId,
  });
}

function normalizeFrontFaceContribution(surface, index, kind, extensionId) {
  if (!surface || typeof surface !== 'object') fail('invalid-descriptor', `frontFace.${kind}[${index}] must be an object`);
  return Object.freeze({
    ...surface,
    id: requiredString(surface.id, `frontFace.${kind}[${index}].id`),
    title: requiredString(surface.title, `frontFace.${kind}[${index}].title`),
    surfaceId: requiredString(surface.surfaceId, `frontFace.${kind}[${index}].surfaceId`),
    adapter: surface.adapter ?? null,
    order: Number(surface.order ?? index),
    lightweight: surface.lightweight !== false,
    kind,
    extensionId,
  });
}

function normalizeAction(action, index, extensionId) {
  if (!action || typeof action !== 'object') fail('invalid-action', `actions[${index}] must be an object`);
  if ('handler' in action || 'invoke' in action || 'execute' in action) fail('invalid-action', `actions[${index}] may not contain executable handlers`);
  return Object.freeze({
    ...action,
    type: requiredString(action.type, `actions[${index}].type`),
    operation: requiredString(action.operation, `actions[${index}].operation`),
    adapter: action.adapter ?? null,
    permissions: Object.freeze(normalizeStrings(action.permissions)),
    allowedStates: action.allowedStates ? Object.freeze(normalizeStrings(action.allowedStates)) : null,
    validateToken: action.validateToken ?? null,
    readOnly: action.readOnly !== false,
    extensionId,
  });
}

function freezeArray(value, mapper) {
  return Object.freeze((value ?? []).map(mapper));
}

function normalizeStrings(value) {
  return [...new Set((value ?? []).map((item) => String(item)).filter(Boolean))];
}

function assertUnique(items, key, label) {
  const seen = new Set();
  for (const item of items) {
    const value = item[key];
    if (seen.has(value)) fail(`duplicate-${label}`, `Duplicate ${label}: ${value}`);
    seen.add(value);
  }
}

function requiredString(value, field) {
  if (typeof value !== 'string' || !value.trim()) fail('invalid-descriptor', `${field} is required`);
  return value.trim();
}

function parseMajor(version) {
  const match = String(version).match(/^(\d+)(?:\.|$)/);
  if (!match) fail('unsupported-schema-version', `Invalid schema version: ${version}`);
  return Number(match[1]);
}

function assertNoFunctions(value, path = 'descriptor', seen = new Set()) {
  if (typeof value === 'function') fail('executable-descriptor', `Executable function is not allowed at ${path}`);
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  for (const [key, child] of Object.entries(value)) assertNoFunctions(child, `${path}.${key}`, seen);
}

function lifecycleBadge(value) {
  if (value === UIExtensionLifecycle.ACTIVE) return 'canonical';
  if (value === UIExtensionLifecycle.DEPRECATED) return 'historical';
  return 'inferred';
}

function availabilityBadge(value) {
  if (value === UIExtensionAvailability.AVAILABLE) return 'canonical';
  if (value === UIExtensionAvailability.UNAVAILABLE) return 'error';
  if (value === UIExtensionAvailability.DEGRADED) return 'warning';
  return 'inferred';
}

function once(fn) {
  let done = false;
  return () => {
    if (done) return;
    done = true;
    fn?.();
  };
}

function deepFreezeClone(value) {
  const clone = JSON.parse(JSON.stringify(value));
  const freeze = (item) => {
    if (!item || typeof item !== 'object' || Object.isFrozen(item)) return item;
    Object.freeze(item);
    for (const child of Object.values(item)) freeze(child);
    return item;
  };
  return freeze(clone);
}

function fail(code, message, details) {
  throw new UIExtensionCompatibilityError(code, message, details);
}
