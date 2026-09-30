import { Signals } from './constants.js';
import { ContextSealState } from './wave2-adapters.js';
import { ResultDestination } from './wave3-adapters.js';
import { createButton, createKeyValue, element, makeBadge, makeStatusDot } from './primitives.js';

export function renderWave3CoprocessorWorkspace(host, ctx) {
  const { adapters, fixture, scope, scheduler, signals } = ctx;
  const doc = host.ownerDocument;
  host.append(
    element(doc, 'h1', { text: 'Cognitive Coprocessor Telemetry' }),
    element(doc, 'p', { className: 'a52-muted', text: 'One Turn Event fans out into capability workers. Gather closes on required foreground quorum; late, stale and fallback paths stay visibly distinct.' }),
  );

  const toolbar = element(doc, 'div', { className: 'a52-toolbar' });
  if (fixture?.createTurnEvent) {
    toolbar.append(
      createButton(doc, { label: 'Create Wave 3 Turn Event', scope, onPress: () => { if (!adapters.coprocessor.getTurnSwarm()) fixture.createTurnEvent(); renderAll(); } }),
      createButton(doc, { label: 'Run quorum + fallback + late path', scope, onPress: () => {
        if (!adapters.coprocessor.getTurnSwarm()) fixture.createTurnEvent();
        const turn = adapters.coprocessor.getTurnSwarm();
        for (const id of ['historian', 'graph']) if (turn.workers.find((w) => w.id === id)?.state !== 'COMPLETE') fixture.completeWorker(id);
        if (!turn.gather?.fallbackSatisfied?.includes('truth-precision')) fixture.satisfyTruthWithFallback();
        if (adapters.coprocessor.getGather()?.contextSeal !== ContextSealState.SEALED) fixture.sealTurn();
        const green = adapters.coprocessor.getTurnSwarm().workers.find((w) => w.id === 'green-room');
        if (!green?.destination) fixture.completeWorker('green-room', { destination: ResultDestination.BACKGROUND, executionLatencyMs: 190 });
        renderAll();
      } }),
    );
  }
  host.append(toolbar);

  const swarmCard = element(doc, 'section', { className: 'a52-card' });
  const gatherCard = element(doc, 'section', { className: 'a52-card' });
  const timelineCard = element(doc, 'section', { className: 'a52-card' });
  host.append(swarmCard, gatherCard, timelineCard);

  const renderSwarm = () => {
    const turn = adapters.coprocessor.getTurnSwarm();
    swarmCard.replaceChildren(element(doc, 'h2', { text: 'Turn Swarm' }));
    if (!turn) { swarmCard.append(element(doc, 'p', { text: 'No active Turn Event.' })); return; }
    swarmCard.append(makeBadge(doc, `${turn.turnId} | ${turn.correlationId}`, 'canonical'));
    const grid = element(doc, 'div', { className: 'a52-swarm' });
    grid.append(element(doc, 'div', { className: 'a52-swarm__turn', text: 'TURN_EVENT' }));
    for (const worker of turn.workers) {
      const destination = worker.destination ?? 'PENDING';
      const card = element(doc, 'button', { className: 'a52-swarm-worker', attrs: { type: 'button' }, dataset: { resultClass: worker.resultClass, destination } });
      card.append(
        makeStatusDot(doc, worker.state, `${worker.name} ${worker.state}`),
        element(doc, 'strong', { text: `${worker.name} | ${worker.capabilities.join('/')}` }),
        makeBadge(doc, worker.resultClass, worker.resultClass === 'REQUIRED' ? 'canonical' : 'inferred'),
        makeBadge(doc, destination, destination === ResultDestination.CURRENT_CONTEXT ? 'canonical' : destination === ResultDestination.STALE_DROPPED ? 'error' : destination === ResultDestination.FALLBACK ? 'warning' : 'historical'),
        createKeyValue(doc, [
          { key: 'Layer / task', value: `${worker.cognitiveLayer} | ${worker.currentTask}` },
          { key: 'Start / queue', value: `${worker.startedAt ?? 'pending'} | ${worker.queueDelayMs}ms` },
          { key: 'Complete / execution', value: `${worker.completedAt ?? 'pending'} | ${worker.executionLatencyMs}ms` },
          { key: 'Deadline', value: worker.deadline },
          { key: 'Freshness', value: worker.freshness },
          { key: 'Retries', value: worker.retryCount },
          { key: 'Validation', value: worker.validationResult },
          { key: 'Warm/cache hit', value: worker.cacheWarmHit },
          { key: 'Fallback', value: worker.fallbackUsed },
          { key: 'Sealed contribution', value: worker.contributedToSealedContext },
        ]),
      );
      scope.listen(card, 'click', () => {
        const detail = adapters.coprocessor.getWorkerTelemetryDetail(worker.id);
        signals.publish(Signals.UI_INSPECT_SELECTION_CHANGED, { object: { kind: 'coprocessor-telemetry-detail', turnId: turn.turnId, ...detail } }, { source: 'coprocessor-workspace' });
      });
      grid.append(card);
    }
    swarmCard.append(grid);
  };

  const renderGather = () => {
    const turn = adapters.coprocessor.getCoprocessorTelemetry();
    gatherCard.replaceChildren(element(doc, 'h2', { text: 'Gather Coordinator' }));
    if (!turn) { gatherCard.append(element(doc, 'p', { text: 'No Gather state yet.' })); return; }
    const g = turn.gather;
    gatherCard.append(
      element(doc, 'p', { className: g.foregroundQuorum ? 'a52-quorum-ok' : 'a52-muted', text: g.foregroundQuorum ? 'Foreground quorum satisfied. Gather does not wait for every sidecar.' : 'Waiting only for required foreground work or deterministic fallback.' }),
      createKeyValue(doc, [
        { key: 'Turn / correlation', value: `${turn.turnId} / ${turn.correlationId}` },
        { key: 'Expected workers', value: g.expectedWorkers },
        { key: 'Completed workers', value: g.completedWorkers.join(', ') || 'none' },
        { key: 'REQUIRED workers', value: g.requiredWorkers.join(', ') },
        { key: 'Missing REQUIRED', value: g.requiredMissing.join(', ') || 'none' },
        { key: 'Foreground quorum', value: g.foregroundQuorum },
        { key: 'Deadline', value: g.deadline },
        { key: 'Fallback satisfaction', value: g.fallbackSatisfied.join(', ') || 'none' },
        { key: 'Stale/rejected', value: g.staleRejected.join(', ') || 'none' },
        { key: 'Duplicate results', value: g.duplicateResults },
        { key: 'Context Seal', value: g.contextSeal },
        { key: 'Post-seal late', value: g.lateResults.map((x) => `${x.workerId} -> ${x.destination}`).join(', ') || 'none' },
      ]),
    );
  };

  const renderTimeline = () => {
    const timeline = adapters.coprocessor.getContextSealTimeline();
    timelineCard.replaceChildren(element(doc, 'h2', { text: 'Context Seal timeline' }));
    const list = element(doc, 'ol', { className: 'a52-seal-timeline' });
    const entries = timeline.length ? timeline : [
      { stage: 'TURN_EVENT', lane: ResultDestination.CURRENT_CONTEXT },
      { stage: 'fan-out', lane: ResultDestination.CURRENT_CONTEXT },
      { stage: 'worker results', lane: ResultDestination.CURRENT_CONTEXT },
      { stage: 'quorum', lane: ResultDestination.CURRENT_CONTEXT },
      { stage: 'compiler', lane: ResultDestination.CURRENT_CONTEXT },
      { stage: 'CONTEXT SEALED', lane: ResultDestination.CURRENT_CONTEXT },
      { stage: 'Main', lane: ResultDestination.CURRENT_CONTEXT },
    ];
    entries.forEach((entry) => {
      const row = element(doc, 'li', { dataset: { lane: entry.lane ?? ResultDestination.CURRENT_CONTEXT } });
      row.append(makeBadge(doc, entry.lane ?? ResultDestination.CURRENT_CONTEXT, entry.lane === ResultDestination.CURRENT_CONTEXT ? 'canonical' : 'historical'), element(doc, 'strong', { text: entry.stage }), element(doc, 'span', { text: entry.at ?? '' }));
      list.append(row);
    });
    timelineCard.append(list);
  };

  const renderAll = () => { renderSwarm(); renderGather(); renderTimeline(); };
  renderAll();
  scope.add(adapters.coprocessor.subscribeCoprocessor((event) => scheduler.invalidate(`wave3:coprocessor:${event.payload?.workerId ?? event.type}`, renderAll)));
}
