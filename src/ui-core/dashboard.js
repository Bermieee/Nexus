import { SignalHub } from './signals.js';
import { RenderScheduler } from './render-scheduler.js';
import { WidgetRegistry, WorkspaceRegistry, InspectorRegistry } from './registry.js';
import { WidgetRuntime, ResourceScope } from './lifecycle.js';
import { ActionRouter } from './action-router.js';
import { UIStateStore } from './persistence.js';
import { OverlayManager } from './overlay.js';
import { NotificationCenter, ToastViewport } from './notifications.js';
import { registerPrimitiveWidgets, createButton, element } from './primitives.js';
import { registerCognitiveWidgets } from './cognitive-widgets.js';
import { InspectorController } from './inspector.js';
import { ApplicationShell } from './shell.js';
import { MockBrainRuntime } from './mock-brain.js';
import { Signals } from './constants.js';
import { assertWave3AdapterBundle } from './wave3-adapters.js';
import { createEmberTavernWave3AdapterBundle } from './ember-tavern-wave3.js';
import { registerKnowledgeInspectionActions } from './provenance-ui.js';
import { installHotCognitionStrip, registerWave2InspectorRenderers } from './wave2-workspaces.js';
import { registerWave3InspectorRenderers } from './wave3-inspector.js';
import { registerWave3Workspaces } from './wave3-workspaces.js';
import { UIExtensionRegistry } from './wave4-extension-registry.js';
import { renderGenericArtifactInspector, renderGenericEventInspector } from './wave4-generic-inspection.js';
import { FrontFaceUIAdapter, ProductActivityFeed, ProductPresentationState } from './wave5-product-model.js';
import { createWave5ProductFixture } from './wave5-fixtures.js';
import { registerWave5FrontFaceWorkspaces } from './wave5-front-face.js';

export function createBrainDashboard({ root, stateStore = new UIStateStore(), adapters: suppliedAdapters = null, productSnapshot = null } = {}) {
  if (!root) throw new Error('Nexus Brain Dashboard requires a root element');
  const signals = new SignalHub();
  const scheduler = new RenderScheduler();
  const widgetRegistry = new WidgetRegistry();
  const workspaceRegistry = new WorkspaceRegistry();
  const inspectorRegistry = new InspectorRegistry();
  const actionRouter = new ActionRouter();
  const extensionRegistry = new UIExtensionRegistry({ workspaceRegistry, inspectorRegistry, actionRouter, scheduler });
  const presentationState = new ProductPresentationState({ stateStore });
  const productAdapter = new FrontFaceUIAdapter({ snapshot: productSnapshot ?? createWave5ProductFixture(), presentationState });
  const productActivityScope = new ResourceScope();
  let shell;
  const productActivity = new ProductActivityFeed({
    scheduler,
    onUpdate() { if (shell?.currentWorkspace === 'home') shell.refreshCurrentWorkspace(); },
  });
  const overlays = new OverlayManager({ document: root.ownerDocument, root: root.ownerDocument.body, getResponsiveMode: () => shell?.mode });
  const notifications = new NotificationCenter({ signals });
  const runtime = new MockBrainRuntime({ signals, scheduler });
  const wave3 = suppliedAdapters ? { fixture: null, adapters: assertWave3AdapterBundle(suppliedAdapters) } : createEmberTavernWave3AdapterBundle({ signals });
  const { fixture, adapters } = wave3;
  const mounted = new Set();
  let workspaceScope = new ResourceScope();

  registerPrimitiveWidgets(widgetRegistry);
  registerCognitiveWidgets(widgetRegistry);
  registerKnowledgeInspectionActions(actionRouter, { adapter: adapters.knowledge, signals });
  registerWave2InspectorRenderers(inspectorRegistry, { adapters, actionRouter });
  registerWave3InspectorRenderers(inspectorRegistry, { adapters, actionRouter });
  inspectorRegistry.register('framework-artifact', renderGenericArtifactInspector);
  inspectorRegistry.register('framework-event', (object, context) => renderGenericEventInspector(object, context));

  const widgetRuntime = new WidgetRuntime({ registry: widgetRegistry, services: { signals, scheduler, actionRouter, overlays, notifications, mockBrain: runtime, adapters } });

  actionRouter.registerSubsystem('mock-brain', async (action) => {
    if (action.type === 'mock.worker.advance') return runtime.advanceWorker();
    if (action.type === 'mock.claim.supersede') return runtime.supersedeClaim();
    if (action.type === 'mock.batch.advance') return runtime.advanceBatch();
    throw new Error(`Unsupported mock action: ${action.type}`);
  });
  actionRouter.registerAction('mock.worker.advance', { subsystem: 'mock-brain', permissions: ['demo:operate'] });
  actionRouter.registerAction('mock.claim.supersede', { subsystem: 'mock-brain', permissions: ['demo:operate'], allowedStates: ['CURRENT'] });
  actionRouter.registerAction('mock.batch.advance', { subsystem: 'mock-brain', permissions: ['demo:operate'] });

  const inspector = new InspectorController({ host: root, registry: inspectorRegistry, signals, scheduler, services: { signals, actionRouter, adapters, extensionRegistry } });
  const renderWorkspace = (entry, host) => {
    for (const instance of mounted) widgetRuntime.destroy(instance);
    mounted.clear();
    workspaceScope.cleanup();
    workspaceScope = new ResourceScope();
    host.replaceChildren();
    entry.render?.(host, {
      mount(widgetId, node, props) { const instance = widgetRuntime.mount(widgetId, node, props); mounted.add(instance); return instance; },
      signals, scheduler, runtime, actionRouter, permissions: ['demo:operate','knowledge:inspect'], overlays, notifications, adapters, fixture, extensionRegistry,
      productAdapter, productActivity, workspaceRegistry, adapterSource: suppliedAdapters ? 'external' : 'fixture', scope: workspaceScope,
      inspect(object) { signals.publish(Signals.UI_INSPECT_SELECTION_CHANGED, { object }, { source: 'front-face' }); },
      navigate(id) { shell?.selectWorkspace(id); },
      refresh() { shell?.refreshCurrentWorkspace(); },
    });
  };

  registerWorkspaces(workspaceRegistry, root.ownerDocument);
  registerWave3Workspaces(workspaceRegistry);
  registerWave5FrontFaceWorkspaces(workspaceRegistry, { adapter: productAdapter, extensionRegistry });
  shell = new ApplicationShell({ root, workspaceRegistry, inspector, signals, stateStore, renderWorkspace });
  shell.mount();

  const toastScope = new ResourceScope();
  const toastViewport = new ToastViewport({ host: shell.nodes.toastHost, signals, scope: toastScope });
  toastViewport.mount();
  installHotCognitionStrip({ shell, adapters, signals, scope: toastScope });
  for (const type of [Signals.WORKER_STATE_CHANGED, Signals.BATCH_PROGRESS_CHANGED, Signals.CLAIM_STATE_CHANGED, Signals.REFLECTION_CHANGED]) {
    productActivityScope.subscribe(signals, type, (event) => productActivity.ingestSignal(event));
  }
  for (const type of [Signals.UI_NOTIFICATION, Signals.UI_NOTIFICATION_CHANGED]) {
    productActivityScope.subscribe(signals, type, () => { if (shell?.currentWorkspace === 'home') shell.refreshCurrentWorkspace(); });
  }
  signals.publish(Signals.COGNITIVE_MODE_CHANGED, { mode: suppliedAdapters ? 'READY' : 'READY' }, { source: 'ui-core' });

  return {
    shell, signals, scheduler, widgetRegistry, workspaceRegistry, inspectorRegistry, actionRouter, extensionRegistry, runtime, adapters, fixture, overlays, notifications, productAdapter, productActivity,
    registerUIExtension(descriptor, binding) { return extensionRegistry.register(descriptor, binding); },
    updateUIExtension(extensionId, patch) { return extensionRegistry.update(extensionId, patch); },
    unregisterUIExtension(extensionId) { return extensionRegistry.unregister(extensionId); },
    destroy() { for (const instance of mounted) widgetRuntime.destroy(instance); mounted.clear(); workspaceScope.cleanup(); toastScope.cleanup(); productActivityScope.cleanup(); overlays.destroy(); shell.destroy(); extensionRegistry.destroy(); scheduler.destroy(); signals.clear(); },
  };
}

function registerWorkspaces(registry, doc) {
  registry.register({ id: 'memory', title: 'Memory', icon: '◉', views: ['overview'], supportedActions: ['inspect'], render(host, ctx) { renderBrainWorkspace(doc, host, ctx); } });
  registry.register({ id: 'world', title: 'World', icon: '◇', views: ['temporal'], supportedActions: ['inspect'], render(host, ctx) { renderWorldWorkspace(doc, host, ctx); } });
  registry.register({ id: 'study', title: 'Study', icon: '▦', views: ['provenance'], supportedActions: ['inspect'], render(host, ctx) { renderStudyWorkspace(doc, host, ctx); } });
  registry.register({ id: 'retrieval', title: 'Retrieval', icon: '⌕', views: ['candidates'], supportedActions: ['inspect'], render(host, ctx) { renderRetrievalWorkspace(doc, host, ctx); } });
  registry.register({ id: 'evaluation', title: 'Evaluation', icon: '✓', views: ['shadow'], supportedActions: ['inspect'], render(host, ctx) { renderEvaluationWorkspace(doc, host, ctx); } });
}

function slot(doc, parent, className = '') { const node = element(doc, 'div', { className }); parent.append(node); return node; }

function renderBrainWorkspace(doc, host, ctx) {
  host.append(element(doc, 'h1', { text: 'Brain Dashboard' }));
  const controls = element(doc, 'div', { className: 'nexus-stack' });
  controls.append(
    createButton(doc, { label: 'Advance worker lifecycle', scope: ctx.scope, onPress: () => ctx.actionRouter.route({ type: 'mock.worker.advance' }, { permissions: ctx.permissions }) }),
    createButton(doc, { label: 'Advance batch', scope: ctx.scope, onPress: () => ctx.actionRouter.route({ type: 'mock.batch.advance' }, { permissions: ctx.permissions }) }),
    createButton(doc, { label: 'Supersede temporal claim', scope: ctx.scope, onPress: () => ctx.actionRouter.route({ type: 'mock.claim.supersede', target: { state: ctx.runtime.claim.status } }, { permissions: ctx.permissions }) }),
  );
  host.append(controls);
  const grid = element(doc, 'div', { className: 'nexus-grid' }); host.append(grid);
  ctx.mount('cognitive.BrainStatus', slot(doc, grid), { mode: 'HOT', queueCount: 3, status: 'ready' });
  ctx.mount('cognitive.WorkerPool', slot(doc, grid), { workers: ctx.adapters.runtime.getWorkers().slice(0, 8) });
  ctx.mount('cognitive.BatchProgress', slot(doc, grid), { batchId: 'batch-42', progress: ctx.runtime.batchProgress });
  ctx.mount('cognitive.TemporalStateCard', slot(doc, grid), { claim: ctx.runtime.claim });
  ctx.mount('cognitive.ReflectionCard', slot(doc, grid), { reflection: ctx.runtime.reflection });
  ctx.mount('cognitive.ContextPacketViewer', slot(doc, grid), { packet: { turnId: 'TURN-001', lanes: ['lore', 'graph', 'green-room'], sealed: true } });
}

function renderWorldWorkspace(doc, host, ctx) {
  host.append(element(doc, 'h1', { text: 'World Model' }));
  ctx.mount('cognitive.TemporalStateCard', slot(doc, host), { claim: ctx.runtime.claim });
  ctx.mount('cognitive.GraphExplorer', slot(doc, host), { nodes: 42, edges: 71, selected: 'Tavern' });
}

function renderStudyWorkspace(doc, host, ctx) {
  host.append(element(doc, 'h1', { text: 'Lore Study' }));
  ctx.mount('cognitive.SourceCard', slot(doc, host), { source: { id: 'UID-184', title: 'Tavern State', revision: 3, status: 'canonical' } });
  ctx.mount('cognitive.ProvenanceChain', slot(doc, host), { chain: ctx.runtime.claim.provenance });
}

function renderRetrievalWorkspace(doc, host, ctx) {
  host.append(element(doc, 'h1', { text: 'Retrieval' }), element(doc, 'p', { text: '10,000 logical candidates; only the visible window is mounted.' }));
  const candidates = Array.from({ length: 10000 }, (_, i) => ({ id: `candidate-${i + 1}`, title: `Candidate ${i + 1}`, score: (1 - (i % 97) / 100).toFixed(2) }));
  ctx.mount('cognitive.VirtualCandidateList', slot(doc, host), { items: candidates });
}

function renderEvaluationWorkspace(doc, host, ctx) {
  host.append(element(doc, 'h1', { text: 'Evaluation' }));
  const grid = element(doc, 'div', { className: 'nexus-grid' }); host.append(grid);
  ctx.mount('cognitive.TruthDecision', slot(doc, grid), { decision: 'CURRENT', confidence: 0.96, reason: 'Temporal graph agrees with source revision.' });
  ctx.mount('cognitive.RerankResult', slot(doc, grid), { before: 50, after: 8, model: 'mock-cross-encoder' });
  ctx.mount('cognitive.ShadowComparison', slot(doc, grid), { left: 'Nexus', right: 'Nexus', agreement: '87%' });
}

function registerInspectorRenderers(registry) {
  registry.register('*', (object, { document: doc }) => {
    const root = element(doc, 'div', { className: 'nexus-stack' });
    root.append(element(doc, 'h2', { text: object.title ?? object.name ?? object.id ?? object.kind }), element(doc, 'pre', { className: 'nexus-context-packet', text: JSON.stringify(object, null, 2) }));
    return root;
  });
}
