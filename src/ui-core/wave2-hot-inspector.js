import { Wave2Signals } from './wave2-adapters.js';
import { createKeyValue, element, makeBadge, makeCard } from './primitives.js';
import { createKnowledgeActionBar } from './provenance-ui.js';

export function renderHotCognitionWorkspace(host, ctx) {
  const { adapters, scope, signals, scheduler, actionRouter, permissions } = ctx;
  const doc = host.ownerDocument;
  host.append(element(doc, 'h1', { text: 'Hot Cognition' }));
  const card = element(doc, 'section', { className: 'a52-card a52-hot-cognition' }); host.append(card);
  const render = () => {
    const scene = adapters.scene.getCurrentScene();
    const tail = adapters.scene.getSceneHistoryPage({ offset: 0, limit: 3 }).items;
    const graph = adapters.scene.getRelatedScenes(scene.id === 'scene-ember-ruins' ? 'scene-ember-intact' : scene.id);
    card.replaceChildren(element(doc, 'h2', { text: 'Generation-adjacent state' }), createKeyValue(doc, [
      { key: 'CurrentScene', value: `${scene.id} · r${scene.revision}` }, { key: 'Active characters', value: scene.activeCast.map((x)=>x.name).join(', ') }, { key: 'Location', value: scene.location.name }, { key: 'Graph neighborhood', value: `${graph.length} related scenes` }, { key: 'Unresolved threads', value: scene.unresolved.map((x)=>x.text).join('; ') || 'none' }, { key: 'Episode tail', value: tail.map((x)=>x.title ?? x.id).join(' → ') || 'none' }, { key: 'Warm candidate packet', value: 'Ember Tavern / Sun Blade / Mara / Eris' }, { key: 'World revision', value: scene.worldRevision },
    ]), createKnowledgeActionBar(doc, { ref: { id: scene.id, kind: 'scene', provenance: scene.sourceEvidence }, actionRouter, permissions, scope }));
  };
  render();
  const rerender = () => scheduler.invalidate('wave2:hot-cognition', render);
  scope.add(adapters.scene.subscribeSceneDeltas(rerender));
  scope.add(signals.subscribe(Wave2Signals.HOT_COGNITION_CHANGED, rerender));
}

export function installHotCognitionStrip({ shell, adapters, signals, scope }) {
  const render = () => {
    const scene = adapters.scene.getCurrentScene();
    shell.nodes.strip.textContent = `HOT · ${scene.location.name} · ${scene.activeCast.map((x)=>x.name).join(', ')} · ${scene.activeThreads.length} threads · world R${scene.worldRevision}`;
  };
  render();
  scope.add(signals.subscribe(Wave2Signals.HOT_COGNITION_CHANGED, render));
}

export function registerWave2InspectorRenderers(registry, { actionRouter, permissions = ['knowledge:inspect'] }) {
  registry.register('current-scene', (scene, { document: doc }) => {
    const root = element(doc, 'div', { className: 'a52-stack' });
    root.append(element(doc, 'h2', { text: 'CurrentScene' }), makeBadge(doc, `${scene.id} · r${scene.revision}`, 'canonical'));
    root.append(createKeyValue(doc, [
      { key: 'Location', value: formatSceneField(scene.location) }, { key: 'Narrative time', value: scene.narrativeTime },
      { key: 'Active cast', value: formatSceneField(scene.activeCast) }, { key: 'Immediate objects', value: formatSceneField(scene.immediateObjects) },
      { key: 'Threads', value: formatSceneField(scene.activeThreads) }, { key: 'Objectives', value: formatSceneField(scene.objectives) },
      { key: 'Atmosphere', value: formatSceneField(scene.atmosphere) }, { key: 'World revision', value: scene.worldRevision },
    ]));
    root.append(renderEpistemicBuckets(doc, scene), renderList(doc, 'Source evidence', scene.sourceEvidence));
    root.append(createKnowledgeActionBar(doc, { ref: { id: scene.id, kind: 'scene', provenance: scene.sourceEvidence }, actionRouter, permissions }));
    return root;
  });

  registry.register('scene-boundary', (boundary, { document: doc }) => {
    const root = element(doc, 'div', { className: 'a52-stack' });
    root.append(element(doc, 'h2', { text: 'Boundary candidate' }), makeBadge(doc, boundary.decision ?? 'PENDING', boundary.decision === 'CUT' ? 'canonical' : 'warning'));
    root.append(createKeyValue(doc, [
      { key: 'Candidate', value: boundary.candidateId ?? 'none' }, { key: 'Scene', value: boundary.sceneId }, { key: 'Confidence', value: `${Math.round((boundary.confidence ?? 0) * 100)}%` },
      { key: 'Confirmation window', value: `${boundary.confirmationWindow?.state ?? '—'} · ${boundary.confirmationWindow?.observedTurns ?? 0}/${boundary.confirmationWindow?.requiredTurns ?? 0}` }, { key: 'Final decision', value: boundary.decision },
    ]));
    root.append(renderList(doc, 'Supporting signals', boundary.supportingSignals), renderList(doc, 'Contradictory evidence', boundary.contradictoryEvidence));
    return root;
  });

  registry.register('scene-episode', (episode, { document: doc }) => {
    const root = element(doc, 'div', { className: 'a52-stack' });
    root.append(element(doc, 'h2', { text: episode.title ?? episode.id }), makeBadge(doc, episode.status ?? 'CLOSED', 'historical'));
    root.append(createKeyValue(doc, [
      { key: 'Source turns', value: episode.sourceTurnRange ? `${episode.sourceTurnRange.start}–${episode.sourceTurnRange.end}` : '—' }, { key: 'Participants', value: formatSceneField(episode.participants) },
      { key: 'Location / time', value: `${episode.location ?? 'unknown'} · ${episode.narrativeTime ?? 'time unknown'}` }, { key: 'Atmosphere trajectory', value: formatSceneField(episode.atmosphereTrajectory) },
    ]));
    root.append(renderList(doc, 'Events', episode.events), renderList(doc, 'Claims', episode.claims), renderList(doc, 'Relationship changes', episode.relationshipChanges), renderList(doc, 'State changes', episode.stateChanges), renderList(doc, 'Threads opened', episode.threadsOpened), renderList(doc, 'Threads resolved', episode.threadsResolved), renderList(doc, 'Provenance', episode.provenance));
    root.append(createKnowledgeActionBar(doc, { ref: { id: episode.id, kind: 'scene', provenance: episode.provenance }, actionRouter, permissions }));
    return root;
  });

  const generic = (object, { document: doc }) => {
    const root = element(doc, 'div', { className: 'a52-stack' });
    root.append(element(doc, 'h2', { text: object.title ?? object.name ?? object.id ?? object.kind }), makeBadge(doc, object.kind ?? 'object', object.epistemic ?? 'ready'));
    const rows = Object.entries(object).filter(([key]) => !['kind','title','name'].includes(key)).slice(0, 24).map(([key,value]) => ({ key, value: typeof value === 'object' ? JSON.stringify(value) : value }));
    root.append(createKeyValue(doc, rows));
    if (object.id) root.append(createKnowledgeActionBar(doc, { ref: { id: object.id, kind: object.kind, provenance: object.provenance ?? object.sourceEvidence }, actionRouter, permissions }));
    return root;
  };
  registry.register('*', generic);
  for (const kind of ['coprocessor-worker','work-ledger-task','knowledge-inspection']) registry.register(kind, generic);
}

function renderEpistemicBuckets(doc, scene) {
  const root = element(doc, 'div', { className: 'a52-epistemic-grid' });
  const buckets = { observed: [], inferred: [], unresolved: [] };
  const collect = (value) => {
    if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === 'object') {
      if (value.epistemic && buckets[value.epistemic]) buckets[value.epistemic].push(value.name ?? value.text ?? value.label ?? value.id);
      for (const nested of Object.values(value)) if (nested && typeof nested === 'object') collect(nested);
    }
  };
  collect(scene);
  for (const [kind,items] of Object.entries(buckets)) root.append(makeCard(doc, { title: kind.toUpperCase(), body: items.join(', ') || 'none', status: kind }));
  return root;
}

function renderList(doc, title, items = []) { const wrap = element(doc, 'div', { className: 'a52-mini-list' }); wrap.append(element(doc, 'strong', { text: title })); const ul = element(doc, 'ul'); (items ?? []).forEach((item)=>ul.append(element(doc, 'li', { text: typeof item === 'string' ? item : JSON.stringify(item) }))); wrap.append(ul); return wrap; }
function formatSceneField(value) { if (value == null) return '—'; if (typeof value === 'string' || typeof value === 'number') return String(value); if (Array.isArray(value)) return value.map((item)=>item.name ?? item.text ?? item.id ?? String(item)).join(', ') || 'none'; if (value.name) return `${value.name}${value.epistemic ? ` · ${value.epistemic}` : ''}`; if (value.label) return `${value.label}${value.epistemic ? ` · ${value.epistemic}` : ''}`; return JSON.stringify(value); }
