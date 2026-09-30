import { RenderCost, RuntimeStatus, Signals, WidgetCategory } from './constants.js';
import { VirtualListController } from './virtualization.js';
import { element, makeBadge, makeCard, makeStatusDot, createProgressBar } from './primitives.js';

function cognitiveSpec(widgetId, { subscriptions = [], cost = RenderCost.NORMAL, create }) {
  return {
    widgetId,
    version: '1.0.0',
    category: WidgetCategory.COGNITIVE,
    propsSchema: { type: 'object' },
    supportedActions: ['inspect'],
    subscriptions,
    permissions: [],
    renderCostClass: cost,
    create,
  };
}

export function registerCognitiveWidgets(registry) {
  registry.register(cognitiveSpec('cognitive.BrainStatus', {
    subscriptions: [Signals.COGNITIVE_MODE_CHANGED, Signals.QUEUE_COUNT_CHANGED],
    cost: RenderCost.CHEAP,
    create({ host, props, scope, services, requestRender }) {
      let state = { mode: props.mode ?? 'HOT', queueCount: props.queueCount ?? 0, status: props.status ?? 'ready' };
      const render = () => {
        const doc = host.ownerDocument;
        const body = element(doc, 'div', { className: 'a52-stack' });
        body.append(makeBadge(doc, state.mode, state.status), element(doc, 'span', { text: `Queue ${state.queueCount}` }));
        host.replaceChildren(makeCard(doc, { title: 'Brain Status', body, status: state.status }));
      };
      return {
        mount: render,
        subscribe() {
          scope.subscribe(services.signals, Signals.COGNITIVE_MODE_CHANGED, ({ payload }) => { state.mode = payload.mode ?? state.mode; requestRender('mode', render); });
          scope.subscribe(services.signals, Signals.QUEUE_COUNT_CHANGED, ({ payload }) => { state.queueCount = payload.count ?? state.queueCount; requestRender('queue', render); });
        },
      };
    },
  }));

  registry.register(cognitiveSpec('cognitive.WorkerPool', {
    subscriptions: [Signals.WORKER_STATE_CHANGED],
    create({ host, props, scope, services, requestRender }) {
      const workers = new Map((props.workers ?? []).map((worker) => [worker.id, { ...worker }]));
      const render = () => {
        const doc = host.ownerDocument;
        const body = element(doc, 'div', { className: 'a52-stack' });
        for (const worker of workers.values()) {
          const row = element(doc, 'button', { className: 'a52-card', attrs: { type: 'button' } });
          row.append(makeStatusDot(doc, worker.state, `${worker.name} ${worker.state}`), element(doc, 'strong', { text: ` ${worker.name}` }), makeBadge(doc, worker.state, worker.state));
          scope.listen(row, 'click', () => services.signals.publish(Signals.UI_INSPECT_SELECTION_CHANGED, { object: { kind: 'worker', ...worker } }, { source: 'worker-pool' }));
          body.append(row);
        }
        host.replaceChildren(makeCard(doc, { title: 'Worker Pool', body }));
      };
      return {
        mount: render,
        subscribe() {
          scope.subscribe(services.signals, Signals.WORKER_STATE_CHANGED, ({ payload }) => {
            const current = workers.get(payload.workerId) ?? { id: payload.workerId, name: payload.name ?? payload.workerId };
            workers.set(payload.workerId, { ...current, ...payload });
            requestRender('workers', render);
          });
        },
      };
    },
  }));

  registry.register(cognitiveSpec('cognitive.LifecycleLane', {
    subscriptions: [Signals.WORKER_STATE_CHANGED],
    cost: RenderCost.CHEAP,
    create({ host, props, scope, services, requestRender }) {
      let current = props.current ?? RuntimeStatus.ACTIVE;
      const steps = [RuntimeStatus.ACTIVE, RuntimeStatus.YIELDING, RuntimeStatus.PARKED, RuntimeStatus.ACTIVE, RuntimeStatus.COMPLETE];
      const render = () => {
        const doc = host.ownerDocument;
        const body = element(doc, 'div', { className: 'a52-lifecycle-lane', attrs: { 'aria-label': 'Worker lifecycle' } });
        steps.forEach((step, index) => {
          const node = element(doc, 'span', { className: `a52-lifecycle-step${step === current ? ' is-current' : ''}`, text: `${index + 1}. ${step}` });
          node.setAttribute('aria-current', step === current ? 'step' : 'false');
          body.append(node);
        });
        host.replaceChildren(makeCard(doc, { title: 'Lifecycle Lane', body }));
      };
      return {
        mount: render,
        subscribe() {
          scope.subscribe(services.signals, Signals.WORKER_STATE_CHANGED, ({ payload }) => {
            if (!props.workerId || payload.workerId === props.workerId) { current = payload.state; requestRender('lifecycle', render); }
          });
        },
      };
    },
  }));

  registry.register(cognitiveSpec('cognitive.BatchProgress', {
    subscriptions: [Signals.BATCH_PROGRESS_CHANGED],
    cost: RenderCost.CHEAP,
    create({ host, props, scope, services, requestRender }) {
      let progress = props.progress ?? 0;
      const render = () => host.replaceChildren(makeCard(host.ownerDocument, { title: `Batch ${props.batchId ?? ''}`, body: createProgressBar(host.ownerDocument, { value: progress, label: 'Batch progress' }) }));
      return {
        mount: render,
        subscribe() {
          scope.subscribe(services.signals, Signals.BATCH_PROGRESS_CHANGED, ({ payload }) => {
            if (!props.batchId || payload.batchId === props.batchId) { progress = payload.progress ?? progress; requestRender('progress', render); }
          });
        },
      };
    },
  }));

  registry.register(cognitiveSpec('cognitive.SourceCard', {
    create({ host, props, services }) {
      const render = () => {
        const source = props.source ?? {};
        const card = makeCard(host.ownerDocument, { title: source.title ?? source.id ?? 'Source', body: `Revision ${source.revision ?? '—'}`, status: source.status ?? 'canonical', interactive: true });
        card.addEventListener('click', () => services.signals.publish(Signals.UI_INSPECT_SELECTION_CHANGED, { object: { kind: 'source', ...source } }, { source: 'source-card' }));
        host.replaceChildren(card);
      };
      return { mount: render };
    },
  }));

  registry.register(cognitiveSpec('cognitive.ClaimCard', {
    subscriptions: [Signals.CLAIM_STATE_CHANGED],
    create({ host, props, scope, services, requestRender }) {
      let claim = { ...(props.claim ?? {}) };
      const render = () => {
        const card = makeCard(host.ownerDocument, { title: claim.subject ?? claim.id ?? 'Claim', body: claim.text ?? '', status: claim.status ?? 'uncertain', interactive: true });
        card.append(makeBadge(host.ownerDocument, claim.status ?? 'uncertain', claim.status ?? 'uncertain'));
        scope.listen(card, 'click', () => services.signals.publish(Signals.UI_INSPECT_SELECTION_CHANGED, { object: { kind: 'claim', ...claim } }, { source: 'claim-card' }));
        host.replaceChildren(card);
      };
      return {
        mount: render,
        subscribe() { scope.subscribe(services.signals, Signals.CLAIM_STATE_CHANGED, ({ payload }) => { if (!claim.id || payload.claimId === claim.id) { claim = { ...claim, ...payload, id: payload.claimId ?? claim.id }; requestRender('claim', render); } }); },
      };
    },
  }));

  registry.register(cognitiveSpec('cognitive.TemporalStateCard', {
    subscriptions: [Signals.CLAIM_STATE_CHANGED],
    create({ host, props, scope, services, requestRender }) {
      let claim = { ...(props.claim ?? {}) };
      const render = () => {
        const doc = host.ownerDocument;
        const body = element(doc, 'div', { className: 'a52-stack' });
        body.append(element(doc, 'p', { text: claim.text ?? '' }), makeBadge(doc, claim.status ?? 'UNCERTAIN', claim.status ?? 'UNCERTAIN'));
        if (claim.history?.length) {
          const history = element(doc, 'ol', { className: 'a52-timeline' });
          claim.history.forEach((item) => history.append(element(doc, 'li', { text: `${item.value}: ${item.validFrom ?? '?'} → ${item.validUntil ?? 'current'}` })));
          body.append(history);
        }
        const card = makeCard(doc, { title: 'Temporal State', body, status: claim.status, interactive: true });
        scope.listen(card, 'click', () => services.signals.publish(Signals.UI_INSPECT_SELECTION_CHANGED, { object: { kind: 'claim', ...claim } }, { source: 'temporal-state-card' }));
        host.replaceChildren(card);
      };
      return {
        mount: render,
        subscribe() {
          scope.subscribe(services.signals, Signals.CLAIM_STATE_CHANGED, ({ payload }) => {
            if (!claim.id || payload.claimId === claim.id) { claim = { ...claim, ...payload, id: payload.claimId ?? claim.id }; requestRender('temporal', render); }
          });
        },
      };
    },
  }));

  registry.register(cognitiveSpec('cognitive.ReflectionCard', {
    subscriptions: [Signals.REFLECTION_CHANGED],
    create({ host, props, scope, services, requestRender }) {
      let reflection = { ...(props.reflection ?? {}) };
      const render = () => {
        const card = makeCard(host.ownerDocument, { title: 'Reflection', body: reflection.text ?? '', status: 'inferred', interactive: true });
        card.append(makeBadge(host.ownerDocument, `${reflection.evidenceCount ?? 0} evidence`, 'inferred'));
        scope.listen(card, 'click', () => services.signals.publish(Signals.UI_INSPECT_SELECTION_CHANGED, { object: { kind: 'reflection', ...reflection } }, { source: 'reflection-card' }));
        host.replaceChildren(card);
      };
      return {
        mount: render,
        subscribe() { scope.subscribe(services.signals, Signals.REFLECTION_CHANGED, ({ payload }) => { if (!reflection.id || payload.reflectionId === reflection.id) { reflection = { ...reflection, ...payload, id: payload.reflectionId ?? reflection.id }; requestRender('reflection', render); } }); },
      };
    },
  }));

  registry.register(cognitiveSpec('cognitive.ProvenanceChain', {
    cost: RenderCost.CHEAP,
    create({ host, props }) {
      return { mount() { const list = element(host.ownerDocument, 'ol', { className: 'a52-provenance' }); (props.chain ?? []).forEach((item) => list.append(element(host.ownerDocument, 'li', { text: `${item.kind ?? 'evidence'} · ${item.label ?? item.id ?? ''}` }))); host.replaceChildren(makeCard(host.ownerDocument, { title: 'Provenance', body: list })); } };
    },
  }));

  registry.register(cognitiveSpec('cognitive.CandidateCard', {
    create({ host, props, services }) {
      return { mount() { const candidate = props.candidate ?? {}; const card = makeCard(host.ownerDocument, { title: candidate.title ?? candidate.id ?? 'Candidate', body: `Score ${candidate.score ?? '—'}`, status: candidate.status ?? 'ready', interactive: true }); card.addEventListener('click', () => services.signals.publish(Signals.UI_INSPECT_SELECTION_CHANGED, { object: { kind: 'candidate', ...candidate } }, { source: 'candidate-card' })); host.replaceChildren(card); } };
    },
  }));

  registry.register(simpleCard('cognitive.TruthDecision', 'Truth Decision', (p) => `${p.decision ?? 'UNRESOLVED'} · ${p.confidence ?? '—'}\n${p.reason ?? ''}`));
  registry.register(simpleCard('cognitive.RerankResult', 'Rerank Result', (p) => `${p.before ?? '—'} → ${p.after ?? '—'} candidates · ${p.model ?? 'deterministic'}`));
  registry.register(simpleCard('cognitive.ContextPacketViewer', 'Context Packet', (p) => JSON.stringify(p.packet ?? {}, null, 2), RenderCost.EXPENSIVE, 'a52-context-packet'));
  registry.register(simpleCard('cognitive.GraphExplorer', 'Graph Explorer', (p) => `${p.nodes ?? 0} nodes · ${p.edges ?? 0} edges · selected: ${p.selected ?? 'none'}`, RenderCost.EXPENSIVE));
  registry.register(simpleCard('cognitive.ShadowComparison', 'Shadow Comparison', (p) => `${p.left ?? 'A'} vs ${p.right ?? 'B'} · agreement ${p.agreement ?? '—'}`, RenderCost.EXPENSIVE));

  registry.register(cognitiveSpec('cognitive.VirtualCandidateList', {
    cost: RenderCost.NORMAL,
    create({ host, props, scope, services }) {
      const controller = new VirtualListController({
        host,
        items: props.items ?? [],
        itemSize: 44,
        overscan: 6,
        scope,
        keyForItem: (item) => item.id,
        renderItem(item, index, doc) {
          const button = element(doc, 'button', { className: 'a52-nav-item', text: `#${index + 1} · ${item.title} · ${item.score}`, attrs: { type: 'button' } });
          scope.listen(button, 'click', () => services.signals.publish(Signals.UI_INSPECT_SELECTION_CHANGED, { object: { kind: 'candidate', ...item } }, { source: 'virtual-candidate-list' }));
          return button;
        },
      });
      return { mount: () => controller.mount(), update(next) { controller.setItems(next.items ?? []); } };
    },
  }));
}

function simpleCard(widgetId, title, formatter, cost = RenderCost.NORMAL, bodyClass = '') {
  return cognitiveSpec(widgetId, {
    cost,
    create({ host, props }) {
      return {
        mount() {
          const doc = host.ownerDocument;
          const body = element(doc, 'pre', { className: bodyClass, text: formatter(props) });
          host.replaceChildren(makeCard(doc, { title, body }));
        },
      };
    },
  });
}
