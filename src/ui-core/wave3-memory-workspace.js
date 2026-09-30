import { Signals } from './constants.js';
import { createKeyValue, element, makeBadge, makeCard } from './primitives.js';
import { createKnowledgeActionBar } from './provenance-ui.js';

export function renderAdvancedMemoryWorkspace(host, ctx) {
  const { adapters, scope, scheduler, signals, actionRouter, permissions, fixture } = ctx;
  const doc = host.ownerDocument;
  host.append(
    element(doc, 'h1', { text: 'Advanced Memory / State-Aware Retrieval' }),
    element(doc, 'p', { className: 'a52-muted', text: 'Observe SOURCE -> DERIVED UNDERSTANDING -> PROPOSAL -> SETTLEMENT -> CURRENT / HISTORICAL / UNRESOLVED STATE without granting UI mutation authority.' }),
  );

  const overview = adapters.memory.getStateOverview();
  const summary = element(doc, 'div', { className: 'a52-grid' });
  summary.append(
    makeCard(doc, { title: 'CURRENT records', body: String(overview.currentCount), status: 'canonical' }),
    makeCard(doc, { title: 'HISTORICAL states', body: String(overview.historicalCount), status: 'historical' }),
    makeCard(doc, { title: 'UNRESOLVED records', body: String(overview.unresolvedCount), status: 'unresolved' }),
  );
  host.append(summary);

  const recordId = 'sun-blade-state';
  const recordCard = element(doc, 'section', { className: 'a52-card' });
  const renderRecord = () => {
    const record = adapters.memory.getMemoryRecord(recordId);
    recordCard.replaceChildren(element(doc, 'h2', { text: record.label }), createLineage(doc, record));
    recordCard.append(createKeyValue(doc, [
      { key: 'Authority class', value: record.authorityClass },
      { key: 'Source revision', value: record.sourceRevision },
      { key: 'World revision', value: record.worldRevision },
      { key: 'Current state', value: `${record.currentState.status} | ${record.currentState.text}` },
      { key: 'Historical state', value: record.historicalStates.map((x) => `${x.status}: ${x.text}`).join(' | ') },
      { key: 'Unresolved evidence', value: record.unresolvedEvidence.map((x) => x.text ?? x.id).join(' | ') || 'none' },
      { key: 'Dependencies / invalidators', value: [...record.dependencies, ...record.invalidators].join(', ') },
    ]));
    recordCard.append(createKnowledgeActionBar(doc, { ref: { id: record.id, kind: 'memory-state', provenance: record.provenance }, actionRouter, permissions, scope }));
    const inspect = element(doc, 'button', { className: 'a52-button', text: 'Inspect complete memory record', attrs: { type: 'button' } });
    scope.listen(inspect, 'click', () => signals.publish(Signals.UI_INSPECT_SELECTION_CHANGED, { object: { kind: 'memory-state-detail', ...record } }, { source: 'memory-workspace' }));
    recordCard.append(inspect);
  };
  renderRecord();
  host.append(recordCard);

  const settlementCard = element(doc, 'section', { className: 'a52-card' });
  const trace = adapters.memory.getSettlementTrace(recordId);
  settlementCard.append(element(doc, 'h2', { text: 'Write-back / Settlement trace' }), element(doc, 'p', { className: 'a52-muted', text: 'Read-only authority trace. There is intentionally no direct model-output apply control.' }));
  const stages = element(doc, 'ol', { className: 'a52-memory-lineage' });
  trace.stages.forEach((stage) => stages.append(element(doc, 'li', { dataset: { status: stage.status }, text: `${stage.name} | ${stage.status}` })));
  settlementCard.append(stages, createKeyValue(doc, [
    { key: 'Proposal', value: `${trace.proposalId} | ${trace.proposalType}` },
    { key: 'Proposer', value: trace.proposer },
    { key: 'Requested mutation', value: trace.requestedMutation },
    { key: 'Evidence', value: trace.evidenceReferences.join(', ') },
    { key: 'Revision fences', value: JSON.stringify(trace.revisionFences) },
    { key: 'Authority', value: trace.authorityClass },
    { key: 'Settlement owner', value: trace.settlementOwner },
    { key: 'Outcome', value: trace.settlementOutcome },
    { key: 'Resulting current', value: trace.resultingClaims.current.join(', ') },
    { key: 'Resulting historical', value: trace.resultingClaims.historical.join(', ') },
    { key: 'Unresolved', value: trace.resultingClaims.unresolved.join(', ') },
  ]));
  host.append(settlementCard);

  const reflectionCard = element(doc, 'section', { className: 'a52-card' });
  const renderReflections = () => {
    reflectionCard.replaceChildren(element(doc, 'h2', { text: 'Reflection observability' }), element(doc, 'p', { className: 'a52-muted', text: 'Reflections remain INFERRED and evidence-backed; contradiction or support removal may weaken them.' }));
    for (const reflection of adapters.memory.getReflections().slice(0, 6)) {
      const card = element(doc, 'button', { className: 'a52-card', attrs: { type: 'button' } });
      card.append(
        element(doc, 'strong', { text: `${reflection.id} | ${reflection.subject}` }),
        makeBadge(doc, reflection.authority, 'inferred'),
        createKeyValue(doc, [
          { key: 'Pattern', value: reflection.pattern },
          { key: 'Confidence', value: reflection.confidence },
          { key: 'Status', value: reflection.status },
          { key: 'Support', value: reflection.supportingEvidence.join(', ') },
          { key: 'Contradiction', value: reflection.contradictingEvidence.join(', ') || 'none' },
          { key: 'Revisions', value: `${reflection.sourceRevision}/${reflection.worldRevision}` },
          { key: 'Invalidators', value: reflection.invalidators.join(', ') || 'none' },
        ]),
      );
      scope.listen(card, 'click', () => signals.publish(Signals.UI_INSPECT_SELECTION_CHANGED, { object: { kind: 'reflection-detail', ...reflection } }, { source: 'reflection-workspace' }));
      reflectionCard.append(card);
    }
    if (fixture?.weakenReflection) {
      const button = element(doc, 'button', { className: 'a52-button', text: 'Simulate contradictory evidence weakening Reflection', attrs: { type: 'button' } });
      scope.listen(button, 'click', () => fixture.weakenReflection());
      reflectionCard.append(button);
    }
  };
  renderReflections();
  host.append(reflectionCard);
  scope.add(adapters.memory.subscribeMemory(() => scheduler.invalidate('wave3:reflection-state', renderReflections)));

  const episodeCard = element(doc, 'section', { className: 'a52-card' });
  const chain = adapters.memory.getEpisodicChain('episode-ember-intact');
  episodeCard.append(element(doc, 'h2', { text: 'Episodic provenance chain' }), element(doc, 'p', { className: 'a52-muted', text: 'Raw narrative remains recoverable; SceneEpisode is a derived representation, not a destructive replacement.' }));
  const chainList = element(doc, 'ol', { className: 'a52-memory-lineage' });
  [
    ['raw narrative evidence', chain.rawEvidence.join(', ')],
    ['SceneEpisode', chain.episode],
    ['claims / state transitions', [...chain.claims, ...chain.stateTransitions].join(', ')],
    ['Reflection', chain.reflection],
    ['retrieval candidate', chain.retrievalCandidate],
  ].forEach(([stage, value]) => chainList.append(element(doc, 'li', { text: `${stage} -> ${value}` })));
  episodeCard.append(chainList, createKnowledgeActionBar(doc, { ref: { id: chain.id, kind: 'scene', provenance: chain.provenance }, actionRouter, permissions, scope }));
  host.append(episodeCard);
}

function createLineage(doc, record) {
  const list = element(doc, 'ol', { className: 'a52-memory-lineage' });
  [
    ['SOURCE', record.source?.id],
    ['DERIVED UNDERSTANDING', record.derivedClaim?.id],
    ['PROPOSAL', record.proposal?.id],
    ['SETTLEMENT', record.settlement?.receiptId],
    [record.currentState?.status ?? 'STATE', record.currentState?.id],
  ].forEach(([stage, value]) => {
    const item = element(doc, 'li');
    item.append(makeBadge(doc, stage, stage === 'CURRENT' ? 'canonical' : stage === 'HISTORICAL' ? 'historical' : 'inferred'), element(doc, 'span', { text: value ?? 'none' }));
    list.append(item);
  });
  return list;
}
