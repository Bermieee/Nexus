import { Signals } from './constants.js';
import { Wave2Signals } from './wave2-adapters.js';
import { VirtualListController } from './virtualization.js';
import { createKeyValue, createProgressBar, element, makeCard } from './primitives.js';

export function renderCognitiveRuntimeWorkspace(host, ctx) {
  const { adapters, scope, scheduler, signals, mount } = ctx;
  const doc = host.ownerDocument;
  host.append(element(doc, 'h1', { text: 'Cognitive Runtime' }));
  const overview = adapters.runtime.getOverview();
  const overviewCard = makeCard(doc, { title: 'Runtime overview', body: createKeyValue(doc, [
    { key: 'Cognitive mode', value: overview.mode }, { key: 'Hot activity', value: `${overview.hotActivity}%` }, { key: 'Deep activity', value: `${overview.deepActivity}%` },
    { key: 'Reserved foreground', value: `${overview.reservedForegroundCapacity}%` }, { key: 'Borrowed background', value: `${overview.borrowedBackgroundCapacity}%` },
  ]) });
  const utilization = makeCard(doc, { title: 'L0–L4 utilization', body: renderUtilization(doc, overview.utilization) });
  const top = element(doc, 'div', { className: 'a52-grid' }); top.append(overviewCard, utilization); host.append(top);

  const workerHost = element(doc, 'div'); host.append(workerHost);
  mount('cognitive.WorkerPool', workerHost, { workers: adapters.runtime.getWorkers() });
  if (ctx.adapterSource === 'external') {
    scope.add(adapters.runtime.subscribeRuntime((event) => {
      if (event.type === Signals.WORKER_STATE_CHANGED) signals.publish(Signals.WORKER_STATE_CHANGED, event.payload, { source: 'runtime-ui-adapter' });
    }));
  }

  const obligations = adapters.runtime.getLifecyclePage({ offset: 0, limit: 1000 });
  const obligationCard = element(doc, 'section', { className: 'a52-card' });
  obligationCard.append(element(doc, 'h2', { text: `Lifecycle obligations · ${obligations.total}` }), element(doc, 'p', { className: 'a52-muted', text: 'Obligations are cognitive duties, not worker-presence indicators. QUEUED work remains visible while workers are PARKED.' }));
  const obligationHost = element(doc, 'div'); obligationCard.append(obligationHost); host.append(obligationCard);
  new VirtualListController({ host: obligationHost, items: obligations.items, itemSize: 46, overscan: 6, scope, keyForItem: (item) => item.id, renderItem: (item) => `${item.id} · ${item.kind} · ${item.cognitiveLayer} · ${item.state} · ${item.assignedWorker ?? 'unassigned'}` }).mount();

  const batchCard = element(doc, 'section', { className: 'a52-card' });
  const batchGrid = element(doc, 'div', { className: 'a52-grid' });
  const batches = adapters.runtime.getBatches();
  const renderBatch = (batch, target) => {
    target.replaceChildren(element(doc, 'strong', { text: batch.id }), createProgressBar(doc, { value: Math.round((batch.completedUnits / batch.totalUnits) * 100), label: `${batch.id} progress` }), createKeyValue(doc, [
      { key: 'Units', value: `${batch.completedUnits}/${batch.totalUnits}` }, { key: 'Active slice', value: batch.activeSlice }, { key: 'Next slice', value: batch.nextSlice }, { key: 'Checkpoint', value: batch.checkpoint }, { key: 'Adaptive size', value: batch.adaptiveBatchSize }, { key: 'Yield requested', value: batch.yieldRequested }, { key: 'Resume point', value: batch.resumePoint },
    ]));
  };
  const batchNodes = new Map();
  for (const batch of batches.slice(0, 12)) { const node = element(doc, 'article', { className: 'a52-card' }); renderBatch(batch, node); batchNodes.set(batch.id, node); batchGrid.append(node); }
  batchCard.append(element(doc, 'h2', { text: 'Batch Engine' }), batchGrid); host.append(batchCard);
  scope.add(adapters.runtime.subscribeRuntime((event) => { if (event.type === Wave2Signals.RUNTIME_BATCH_CHANGED) { const batch = event.payload.batch; const node = batchNodes.get(batch.id); if (node) scheduler.invalidate(`wave2:batch:${batch.id}`, () => renderBatch(batch, node)); } }));

  const ledger = adapters.runtime.getLedgerPage({ offset: 0, limit: 500 });
  const ledgerCard = element(doc, 'section', { className: 'a52-card' }); ledgerCard.append(element(doc, 'h2', { text: `Work Ledger · ${ledger.total} tasks` }), element(doc, 'p', { className: 'a52-muted', text: 'The live dashboard loads one page; complete history remains adapter-owned.' }));
  const ledgerHost = element(doc, 'div'); ledgerCard.append(ledgerHost); host.append(ledgerCard);
  new VirtualListController({ host: ledgerHost, items: ledger.items, itemSize: 44, overscan: 5, scope, keyForItem: (item) => item.id, renderItem(item) { const button = element(doc, 'button', { className: 'a52-nav-item', text: `${item.id} · ${item.type} · ${item.state}`, attrs: { type: 'button' } }); scope.listen(button, 'click', () => signals.publish(Signals.UI_INSPECT_SELECTION_CHANGED, { object: { kind: 'work-ledger-task', ...item } }, { source: 'runtime-ledger' })); return button; } }).mount();
}

function renderUtilization(doc, utilization = {}) { const root = element(doc, 'div', { className: 'a52-stack' }); for (const [level,value] of Object.entries(utilization)) { const row = element(doc, 'div'); row.append(element(doc, 'strong', { text: level }), createProgressBar(doc, { value, label: `${level} utilization` })); root.append(row); } return root; }
