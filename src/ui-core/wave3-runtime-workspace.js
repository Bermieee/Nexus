import { Signals } from './constants.js';
import { VirtualListController } from './virtualization.js';
import { RuntimeTelemetryProjector } from './wave3-models.js';
import { createKeyValue, createProgressBar, element, makeBadge, makeStatusDot } from './primitives.js';

export function renderWave3RuntimeWorkspace(host, ctx) {
  const { adapters, scope, scheduler, signals } = ctx;
  const doc = host.ownerDocument;
  host.append(
    element(doc, 'h1', { text: 'Cognitive Runtime' }),
    element(doc, 'p', { className: 'a52-muted', text: 'Lightweight telemetry shows what work exists separately from what a worker is executing. Detailed worker and ledger snapshots load only on inspection.' }),
  );

  const overviewCard = element(doc, 'section', { className: 'a52-card a52-span-2' });
  const utilizationCard = element(doc, 'section', { className: 'a52-card' });
  const recoveryCard = element(doc, 'section', { className: 'a52-card' });
  const layout = element(doc, 'div', { className: 'a52-wave2-grid' });
  layout.append(overviewCard, utilizationCard, recoveryCard);
  host.append(layout);

  const renderOverview = () => {
    const o = adapters.runtime.getTelemetrySummary();
    overviewCard.replaceChildren(element(doc, 'h2', { text: 'Living runtime overview' }), createKeyValue(doc, [
      { key: 'Cognitive mode', value: o.mode },
      { key: 'Hot / Deep', value: `${o.hotActivity}% / ${o.deepActivity}%` },
      { key: 'Reserved foreground', value: `${o.reservedForegroundCapacity}%` },
      { key: 'Borrowed background', value: `${o.borrowedBackgroundCapacity}%` },
      { key: 'Active workers', value: o.activeWorkerCount },
      { key: 'Parked workers', value: o.parkedWorkerCount },
      { key: 'Queued obligations', value: o.queuedObligations },
      { key: 'Blocked / recovering', value: o.blockedRecoveringWork },
      { key: 'Active batches', value: o.activeBatches },
      { key: 'Foreground deadline', value: o.foregroundDeadlineState },
      { key: 'Queue depth', value: o.queueDepth },
    ]));
  };

  const renderUtilization = () => {
    const o = adapters.runtime.getTelemetrySummary();
    utilizationCard.replaceChildren(element(doc, 'h2', { text: 'L0-L4 utilization' }));
    const stack = element(doc, 'div', { className: 'a52-stack' });
    for (const [level,value] of Object.entries(o.utilization ?? {})) {
      const row = element(doc, 'div', { className: 'a52-util-row' });
      row.append(element(doc, 'strong', { text: level }), createProgressBar(doc, { value, label: `${level} utilization` }));
      stack.append(row);
    }
    utilizationCard.append(stack);
  };

  const renderRecovery = () => {
    const page = adapters.runtime.getRecoveryPage({ offset: 0, limit: 6 });
    recoveryCard.replaceChildren(element(doc, 'h2', { text: 'Recent recovery / fallback' }));
    const list = element(doc, 'ul', { className: 'a52-mini-list' });
    page.items.forEach((event) => list.append(element(doc, 'li', { text: `${event.workerId} | ${event.reason} -> ${event.action}${event.fallback ? ` | ${event.fallback}` : ''}` })));
    recoveryCard.append(list);
  };
  renderOverview(); renderUtilization(); renderRecovery();

  const projector = new RuntimeTelemetryProjector({
    adapter: adapters.runtime,
    scheduler,
    onMetric(key) {
      if (key === 'utilization') renderUtilization();
      else if (key.startsWith('recovery:')) renderRecovery();
      else if (key === 'queue-depth' || key === 'capacity' || key.startsWith('worker:') || key.startsWith('batch:')) renderOverview();
    },
  }).mount();
  scope.add(() => projector.destroy());

  const workers = adapters.runtime.getWorkers();
  const workersCard = element(doc, 'section', { className: 'a52-card' });
  workersCard.append(element(doc, 'h2', { text: `Worker view | ${workers.length}` }), element(doc, 'p', { className: 'a52-muted', text: 'Rows carry lightweight state. Select a worker to request its detailed telemetry contract.' }));
  const workersHost = element(doc, 'div'); workersCard.append(workersHost); host.append(workersCard);
  new VirtualListController({
    host: workersHost, items: workers, itemSize: 58, overscan: 6, scope, keyForItem: (item) => item.id,
    renderItem(worker) {
      const button = element(doc, 'button', { className: 'a52-runtime-row', attrs: { type: 'button' } });
      button.append(
        makeStatusDot(doc, worker.state, `${worker.name} ${worker.state}`),
        element(doc, 'strong', { text: `${worker.id} | ${worker.name}` }),
        makeBadge(doc, `${worker.layer}/${worker.cognitiveLayer}`, worker.cognitiveLayer === 'Hot' ? 'canonical' : 'inferred'),
        element(doc, 'span', { text: `${worker.currentTask?.label ?? 'idle'} | ${worker.provider}/${worker.model} | ${worker.executionLatencyMs}ms` }),
      );
      scope.listen(button, 'click', () => {
        const detail = adapters.runtime.getWorkerTelemetry(worker.id);
        signals.publish(Signals.UI_INSPECT_SELECTION_CHANGED, { object: { kind: 'runtime-worker-detail', ...detail } }, { source: 'runtime-workspace' });
      });
      return button;
    },
  }).mount();

  const obligations = adapters.runtime.getLifecyclePage({ offset: 0, limit: 1500 });
  const obligationsCard = element(doc, 'section', { className: 'a52-card' });
  obligationsCard.append(element(doc, 'h2', { text: `Lifecycle obligations | ${obligations.total}` }), element(doc, 'p', { className: 'a52-quorum-ok', text: 'Work exists independently of worker availability: a queued obligation remains visible while its worker yields or parks.' }));
  const obligationsHost = element(doc, 'div'); obligationsCard.append(obligationsHost); host.append(obligationsCard);
  new VirtualListController({
    host: obligationsHost, items: obligations.items, itemSize: 46, overscan: 6, scope, keyForItem: (item) => item.id,
    renderItem: (item) => `${item.id} | ${item.kind} | ${item.cognitiveLayer} | ${item.state} | worker=${item.assignedWorker ?? 'none'} | ${item.worldRevision}/${item.sceneRevision}`,
  }).mount();

  const batches = adapters.runtime.getBatches();
  const batchesCard = element(doc, 'section', { className: 'a52-card' });
  batchesCard.append(element(doc, 'h2', { text: 'Batch / yield / checkpoint' }));
  const batchGrid = element(doc, 'div', { className: 'a52-grid' });
  for (const batch of batches.slice(0, 10)) {
    const card = element(doc, 'article', { className: 'a52-card' });
    card.append(element(doc, 'strong', { text: batch.id }), createProgressBar(doc, { value: Math.round((batch.completedUnits / batch.totalUnits) * 100), label: `${batch.id} progress` }), createKeyValue(doc, [
      { key: 'Units', value: `${batch.completedUnits}/${batch.totalUnits}` },
      { key: 'Active / next', value: `${batch.activeSlice} / ${batch.nextSlice}` },
      { key: 'Checkpoint', value: batch.checkpoint },
      { key: 'Adaptive size', value: batch.adaptiveBatchSize },
      { key: 'Yield requested', value: batch.yieldRequested },
      { key: 'Resume point', value: batch.resumePoint },
      { key: 'Deadline', value: batch.deadlineState },
    ]));
    batchGrid.append(card);
  }
  batchesCard.append(batchGrid); host.append(batchesCard);

  const ledger = adapters.runtime.getLedgerPage({ offset: 0, limit: 600 });
  const ledgerCard = element(doc, 'section', { className: 'a52-card' });
  ledgerCard.append(element(doc, 'h2', { text: `Work Ledger | page 1 / ${ledger.total}` }), element(doc, 'p', { className: 'a52-muted', text: 'The dashboard holds summaries only. Selecting a row fetches revision fences, capabilities, dependencies, slices, dedupe/conflict keys, checkpoint, recovery and stale/superseded state on demand.' }));
  const ledgerHost = element(doc, 'div'); ledgerCard.append(ledgerHost); host.append(ledgerCard);
  new VirtualListController({
    host: ledgerHost, items: ledger.items, itemSize: 46, overscan: 5, scope, keyForItem: (item) => item.id,
    renderItem(item) {
      const button = element(doc, 'button', { className: 'a52-nav-item', text: `${item.id} | ${item.cognitiveLayer} | ${item.state} | ${item.staleState}`, attrs: { type: 'button' } });
      scope.listen(button, 'click', () => {
        const detail = adapters.runtime.getLedgerTaskDetail(item.id);
        signals.publish(Signals.UI_INSPECT_SELECTION_CHANGED, { object: { kind: 'work-ledger-detail', ...detail } }, { source: 'work-ledger' });
      });
      return button;
    },
  }).mount();
}
