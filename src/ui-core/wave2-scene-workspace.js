import { Signals } from './constants.js';
import { Wave2Signals } from './wave2-adapters.js';
import { SceneDeltaProjector } from './wave2-models.js';
import { VirtualListController } from './virtualization.js';
import { createButton, createKeyValue, element, makeBadge } from './primitives.js';
import { createKnowledgeActionBar } from './provenance-ui.js';

export function renderSceneIntelligenceWorkspace(host, ctx) {
  const { adapters, scheduler, scope, actionRouter, permissions, signals, fixture } = ctx;
  const doc = host.ownerDocument;
  const current = adapters.scene.getCurrentScene();
  host.append(element(doc, 'h1', { text: 'Scene Intelligence' }), element(doc, 'p', { className: 'a52-muted', text: 'CurrentScene is signal-driven; field deltas update independently without redrawing the workspace.' }));
  const controls = element(doc, 'div', { className: 'a52-toolbar' });
  if (fixture) controls.append(createButton(doc, { label: 'Run Ember Tavern acceptance scenario', scope, onPress: () => { fixture.runAcceptanceScenario(); renderEpisodeHistory(); renderGraph(); } }));
  controls.append(createButton(doc, { label: 'Inspect CurrentScene', scope, onPress: () => signals.publish(Signals.UI_INSPECT_SELECTION_CHANGED, { object: { kind: 'current-scene', ...adapters.scene.getCurrentScene() } }, { source: 'scene-workspace' }) }));
  host.append(controls);

  const layout = element(doc, 'div', { className: 'a52-wave2-grid' });
  const sceneCard = element(doc, 'section', { className: 'a52-card a52-scene-current' });
  const deltaCard = element(doc, 'section', { className: 'a52-card' });
  const boundaryCard = element(doc, 'section', { className: 'a52-card' });
  const historyCard = element(doc, 'section', { className: 'a52-card a52-span-2' });
  const graphCard = element(doc, 'section', { className: 'a52-card a52-span-2' });
  layout.append(sceneCard, deltaCard, boundaryCard, historyCard, graphCard);
  host.append(layout);

  const fieldNodes = new Map();
  const sceneHeader = element(doc, 'div', { className: 'a52-card__header' });
  sceneHeader.append(element(doc, 'h2', { text: 'CurrentScene' }), makeBadge(doc, `${current.id} · r${current.revision}`, 'canonical'));
  sceneCard.append(sceneHeader);
  const fields = element(doc, 'div', { className: 'a52-scene-fields' });
  sceneCard.append(fields);
  const definitions = [
    ['location','Location'],['narrativeTime','Narrative time'],['activeCast','Active cast'],['immediateObjects','Immediate objects'],['activeThreads','Threads / objectives'],['atmosphere','Atmosphere'],['sourceEvidence','Source evidence'],['unresolved','Unresolved'],
  ];
  for (const [field,label] of definitions) {
    const row = element(doc, 'div', { className: 'a52-scene-field', dataset: { sceneField: field } });
    row.append(element(doc, 'strong', { text: label }), element(doc, 'div', { className: 'a52-scene-field__value', text: formatSceneField(current[field]) }));
    fieldNodes.set(field, row.querySelector('.a52-scene-field__value'));
    fields.append(row);
  }
  sceneCard.append(createKnowledgeActionBar(doc, { ref: { id: current.id, kind: 'scene', provenance: current.sourceEvidence }, actionRouter, permissions, scope }));

  deltaCard.append(element(doc, 'h2', { text: 'Scene Delta stream' }));
  const deltaList = element(doc, 'ol', { className: 'a52-event-stream', attrs: { 'aria-live': 'polite' } });
  deltaCard.append(deltaList);
  const recentDeltas = [];
  const pushDelta = (event) => {
    if (![Wave2Signals.SCENE_LOCATION_CHANGED, Wave2Signals.SCENE_ACTIVE_CAST_CHANGED, Wave2Signals.SCENE_TIME_SHIFT_DETECTED, Wave2Signals.SCENE_VIBE_CHANGED, Wave2Signals.SCENE_STATE_DELTA].includes(event.type)) return;
    recentDeltas.unshift({ type: event.type, field: event.payload?.field, revision: event.payload?.sceneRevision });
    recentDeltas.length = Math.min(30, recentDeltas.length);
    scheduler.invalidate('wave2:scene-delta-stream', () => {
      deltaList.replaceChildren(...recentDeltas.map((item) => element(doc, 'li', { text: `${item.type} · ${item.field ?? 'scene'} · r${item.revision ?? '—'}` })));
    });
  };
  scope.add(adapters.scene.subscribeSceneDeltas(pushDelta));

  const refreshCurrentSceneHeader = () => {
    const scene = adapters.scene.getCurrentScene();
    sceneHeader.querySelector('.a52-badge').textContent = `${scene.id} · r${scene.revision}`;
    for (const [field,node] of fieldNodes) node.textContent = formatSceneField(scene[field]);
  };

  const projector = new SceneDeltaProjector({
    adapter: adapters.scene,
    scheduler,
    onFieldUpdate(field, value) {
      const node = fieldNodes.get(field);
      if (node) node.textContent = formatSceneField(value);
      if (field === 'scene') refreshCurrentSceneHeader();
    },
  }).mount();
  scope.add(() => projector.destroy());

  const renderBoundary = () => {
    const boundary = adapters.scene.getBoundaryState();
    boundaryCard.replaceChildren(element(doc, 'h2', { text: 'Boundary Inspector' }));
    boundaryCard.append(createKeyValue(doc, [
      { key: 'Candidate', value: boundary.candidateId ?? 'none' }, { key: 'State', value: boundary.state }, { key: 'Confidence', value: `${Math.round((boundary.confidence ?? 0) * 100)}%` },
      { key: 'Confirmation', value: `${boundary.confirmationWindow?.state ?? '—'} · ${boundary.confirmationWindow?.observedTurns ?? 0}/${boundary.confirmationWindow?.requiredTurns ?? 0}` }, { key: 'Decision', value: boundary.decision },
    ]));
    boundaryCard.append(renderList(doc, 'Supporting signals', boundary.supportingSignals), renderList(doc, 'Contradictory evidence', boundary.contradictoryEvidence));
    boundaryCard.append(createButton(doc, { label: 'Inspect boundary', scope, onPress: () => signals.publish(Signals.UI_INSPECT_SELECTION_CHANGED, { object: { kind: 'scene-boundary', ...boundary } }, { source: 'scene-boundary' }) }));
  };
  renderBoundary();
  scope.add(adapters.scene.subscribeSceneDeltas((event) => { if (event.type === Wave2Signals.SCENE_BOUNDARY_CHANGED) scheduler.invalidate('wave2:boundary', renderBoundary); }));

  let historyController = null;
  const renderEpisodeHistory = () => {
    historyController?.host?.replaceChildren?.();
    const history = adapters.scene.getSceneHistoryPage({ offset: 0, limit: 2000 });
    historyCard.replaceChildren(element(doc, 'h2', { text: `Scene Episodes · ${history.total}` }), element(doc, 'p', { className: 'a52-muted', text: 'Paged adapter + virtualized rows; closed scenes retain historical truth and provenance.' }));
    const virtualHost = element(doc, 'div'); historyCard.append(virtualHost);
    historyController = new VirtualListController({
      host: virtualHost, items: history.items, itemSize: 64, overscan: 6, scope,
      keyForItem: (item) => item.id,
      renderItem(item) {
        const button = element(doc, 'button', { className: 'a52-scene-history-row', attrs: { type: 'button' } });
        button.append(element(doc, 'strong', { text: item.title ?? item.id }), element(doc, 'span', { text: `${item.location ?? 'unknown'} · ${item.narrativeTime ?? 'time unknown'}` }));
        scope.listen(button, 'click', () => signals.publish(Signals.UI_INSPECT_SELECTION_CHANGED, { object: { kind: 'scene-episode', ...item } }, { source: 'scene-history' }));
        return button;
      },
    });
    historyController.mount();
  };
  renderEpisodeHistory();
  scope.add(adapters.scene.subscribeSceneDeltas((event) => { if (event.type === Wave2Signals.SCENE_EPISODE_CLOSED) scheduler.invalidate('wave2:scene-history', renderEpisodeHistory); }));

  const renderGraph = () => {
    const sceneId = 'scene-ember-intact';
    const relations = adapters.scene.getRelatedScenes(sceneId);
    graphCard.replaceChildren(element(doc, 'h2', { text: 'Scene graph / navigation' }), element(doc, 'p', { className: 'a52-muted', text: 'Scene relations are navigable as a graph, not flattened into a strict timeline.' }));
    const graph = element(doc, 'div', { className: 'a52-scene-graph' });
    for (const edge of relations) {
      const target = edge.scene;
      const button = element(doc, 'button', { className: 'a52-graph-edge', attrs: { type: 'button' } });
      button.append(makeBadge(doc, edge.relation, 'inferred'), element(doc, 'strong', { text: target?.title ?? target?.id ?? 'related scene' }), element(doc, 'span', { text: edge.direction }));
      scope.listen(button, 'click', () => target && signals.publish(Signals.UI_INSPECT_SELECTION_CHANGED, { object: { kind: 'scene-episode', ...target, relation: edge.relation } }, { source: 'scene-graph' }));
      graph.append(button);
    }
    graphCard.append(graph);
  };
  renderGraph();
}

function renderList(doc, title, items = []) { const wrap = element(doc, 'div', { className: 'a52-mini-list' }); wrap.append(element(doc, 'strong', { text: title })); const ul = element(doc, 'ul'); (items ?? []).forEach((item)=>ul.append(element(doc, 'li', { text: typeof item === 'string' ? item : JSON.stringify(item) }))); wrap.append(ul); return wrap; }
function formatSceneField(value) { if (value == null) return '—'; if (typeof value === 'string' || typeof value === 'number') return String(value); if (Array.isArray(value)) return value.map((item)=>item.name ?? item.text ?? item.id ?? String(item)).join(', ') || 'none'; if (value.name) return `${value.name}${value.epistemic ? ` · ${value.epistemic}` : ''}`; if (value.label) return `${value.label}${value.epistemic ? ` · ${value.epistemic}` : ''}`; return JSON.stringify(value); }
