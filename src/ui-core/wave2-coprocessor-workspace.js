import { Signals } from './constants.js';
import { ContextSealState, Wave2Signals } from './wave2-adapters.js';
import { createButton, createKeyValue, element, makeBadge, makeStatusDot } from './primitives.js';

export function renderCoprocessorWorkspace(host, ctx) {
  const { adapters, fixture, scope, scheduler, signals } = ctx;
  const doc = host.ownerDocument;
  host.append(element(doc, 'h1', { text: 'Cognitive Coprocessors' }), element(doc, 'p', { className: 'a52-muted', text: 'One key may wake many sidecars; Main waits only for the bounded foreground quorum.' }));
  const controls = element(doc, 'div', { className: 'a52-toolbar' });
  if (fixture) controls.append(createButton(doc, { label: 'Create Turn Event', scope, onPress: () => { if (!adapters.coprocessor.getTurnSwarm()) fixture.createTurnEvent(); renderAll(); } }), createButton(doc, { label: 'Run full acceptance swarm', scope, onPress: () => { if (!adapters.coprocessor.getTurnSwarm()) fixture.createTurnEvent(); const turn = adapters.coprocessor.getTurnSwarm(); for (const id of ['historian','graph','truth']) if (turn.workers.find((w)=>w.id===id)?.state !== 'COMPLETE') fixture.completeTurnWorker(id); if (adapters.coprocessor.getGather()?.contextSeal !== ContextSealState.SEALED) fixture.closeGatherAndSeal(); if (!adapters.coprocessor.getTurnSwarm().workers.find((w)=>w.id==='green-room')?.lateRoute) fixture.completeTurnWorker('green-room',{latency:180}); renderAll(); } }));
  host.append(controls);
  const swarmCard = element(doc, 'section', { className: 'a52-card' });
  const gatherCard = element(doc, 'section', { className: 'a52-card' });
  const timelineCard = element(doc, 'section', { className: 'a52-card' });
  host.append(swarmCard, gatherCard, timelineCard);

  const renderSwarm = () => {
    const turn = adapters.coprocessor.getTurnSwarm();
    swarmCard.replaceChildren(element(doc, 'h2', { text: 'Turn Swarm' }));
    if (!turn) { swarmCard.append(element(doc, 'p', { text: 'No Turn Event yet.' })); return; }
    swarmCard.append(makeBadge(doc, turn.turnId, 'canonical'));
    const fanout = element(doc, 'div', { className: 'a52-swarm' });
    fanout.append(element(doc, 'div', { className: 'a52-swarm__turn', text: 'TURN_EVENT' }));
    for (const worker of turn.workers) {
      const card = element(doc, 'button', { className: 'a52-swarm-worker', attrs: { type: 'button' }, dataset: { resultClass: worker.resultClass, late: worker.lateRoute ? 'true' : 'false' } });
      card.append(makeStatusDot(doc, worker.freshness === 'STALE' ? 'STALE' : worker.state === 'COMPLETE' ? 'ready' : 'ACTIVE', `${worker.name} ${worker.state}`), element(doc, 'strong', { text: worker.name }), makeBadge(doc, worker.resultClass, worker.resultClass === 'REQUIRED' ? 'canonical' : 'inferred'), createKeyValue(doc, [
        { key: 'Start', value: worker.startedAt ?? 'pending' }, { key: 'Complete', value: worker.completedAt ?? 'pending' }, { key: 'Freshness', value: worker.freshness }, { key: 'Fallback', value: worker.fallbackUsed ? 'used' : 'no' }, { key: 'Current context', value: worker.contributedToCurrentContext ? 'YES' : worker.lateRoute ? `NO · ${worker.lateRoute}` : 'pending' },
      ]));
      scope.listen(card, 'click', () => signals.publish(Signals.UI_INSPECT_SELECTION_CHANGED, { object: { kind: 'coprocessor-worker', turnId: turn.turnId, ...worker } }, { source: 'turn-swarm' }));
      fanout.append(card);
    }
    swarmCard.append(fanout);
  };

  const renderGather = () => {
    const gather = adapters.coprocessor.getGather();
    gatherCard.replaceChildren(element(doc, 'h2', { text: 'Gather Coordinator' }));
    if (!gather) { gatherCard.append(element(doc, 'p', { text: 'No active gather.' })); return; }
    const status = gather.foregroundQuorum ? 'Foreground quorum satisfied — Gather does not wait for every sidecar.' : 'Waiting for required foreground work.';
    gatherCard.append(element(doc, 'p', { className: gather.foregroundQuorum ? 'a52-quorum-ok' : 'a52-muted', text: status }), createKeyValue(doc, [
      { key: 'Expected workers', value: gather.expectedWorkers }, { key: 'Completed', value: gather.completedWorkers.join(', ') || 'none' }, { key: 'Required missing', value: gather.requiredMissing.join(', ') || 'none' }, { key: 'Deadline', value: gather.deadline }, { key: 'Context Seal', value: gather.contextSeal }, { key: 'Late results', value: gather.lateResults.map((x)=>`${x.workerId} → ${x.route}`).join(', ') || 'none' },
    ]));
  };

  const renderTimeline = () => {
    const timeline = adapters.coprocessor.getContextSealTimeline();
    timelineCard.replaceChildren(element(doc, 'h2', { text: 'Context Seal timeline' }));
    if (!timeline.length) { timelineCard.append(element(doc, 'p', { text: 'TURN_EVENT → fan-out → results → quorum → compiler → CONTEXT SEALED → Main' })); return; }
    const list = element(doc, 'ol', { className: 'a52-seal-timeline' });
    for (const entry of timeline) {
      const row = element(doc, 'li', { dataset: { lane: entry.lane ?? 'FOREGROUND' } });
      row.append(makeBadge(doc, entry.lane ?? 'FOREGROUND', entry.lane === 'NEXT TURN' || entry.lane === 'BACKGROUND' ? 'historical' : 'canonical'), element(doc, 'strong', { text: entry.stage }), element(doc, 'span', { text: entry.at ?? '' }));
      list.append(row);
    }
    timelineCard.append(list);
  };
  const renderAll = () => { renderSwarm(); renderGather(); renderTimeline(); };
  renderAll();
  scope.add(adapters.coprocessor.subscribeCoprocessor((event) => {
    const key = event.type === Wave2Signals.COPROCESSOR_RESULT_CHANGED ? `wave2:swarm:${event.payload.worker?.id}` : `wave2:coprocessor:${event.type}`;
    scheduler.invalidate(key, renderAll);
  }));
}
