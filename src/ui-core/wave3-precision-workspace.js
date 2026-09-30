import { Signals } from './constants.js';
import { VirtualListController } from './virtualization.js';
import { PrecisionFunnelProjector } from './wave3-models.js';
import { TruthClass } from './wave3-adapters.js';
import { createButton, createKeyValue, element, makeBadge } from './primitives.js';

export function renderPrecisionWorkspace(host, ctx) {
  const { adapters, fixture, scope, scheduler, signals } = ctx;
  const doc = host.ownerDocument;
  host.append(
    element(doc, 'h1', { text: 'Precision / Reranking Diagnostics' }),
    element(doc, 'p', { className: 'a52-quorum-ok', text: 'Relevance is not truth. High recall occurs before expensive precision.' }),
  );

  const pipeline = adapters.precision.getPipeline();
  const pipelineCard = ement(doc, 'section', { className: 'a52-card' });
  pipelineCard.append(element(doc, 'h2', { text: 'Precision pipeline' }));
  const pipe = element(doc, 'ol', { className: 'a52-precision-pipeline' });
  pipeline.stages.forEach((stage) => pipe.append(element(doc, 'li', { text: stage })));
  pipelineCard.append(pipe);
  host.append(pipelineCard);

  const funnelCard = element(doc, 'section', { className: 'a52-card' });
  const renderFunnel = () => {
    const funnel = adapters.precision.getCandidateFunnel();
    funnelCard.replaceChildren(element(doc, 'h2', { text: 'Candidate Bus funnel' }), element(doc, 'p', { className: 'a52-muted', text: `Adaptive candidate budget: ${funnel.adaptiveCandidateBudget} | ${funnel.budgetReason}` }));
    const stages = element(doc, 'div', { className: 'a52-funnel' });
    for (const [stage, count] of Object.entries(funnel.stages)) {
      const node = element(doc, 'div', { className: 'a52-funnel-stage' });
      node.append(element(doc, 'strong', { text: stage }), element(doc, 'span', { text: String(count) }));
      stages.append(node);
    }
    funnelCard.append(stages, createKeyValue(doc, [{ key: 'Token budget', value: funnel.tokenBudget }, { key: 'Architectural fixed cutoff', value: 'none' }]));
  };
  renderFunnel();
  host.append(funnelCard);

  const deadlineCard = element(doc, 'section', { className: 'a52-card' });
  const renderDeadline = () => {
    const d = adapters.precision.getDeadlineState();
    deadlineCard.replaceChildren(element(doc, 'h2', { text: 'Foreground deadline + fallback' }), createKeyValue(doc, [
      { key: 'Reranker', value: d.rerankerState },
      { key: 'Deadline', value: `${d.deadlineMs}ms` },
      { key: 'Fallback active', value: d.fallbackActive },
      { key: 'Fallback type', value: d.fallbackType ?? 'none' },
      { key: 'Gather quorum', value: d.gatherQuorum },
      { key: 'Context Seal', value: d.contextSeal },
      { key: 'Main proceeding', value: d.mainProceeding },
      { key: 'Late destination', value: d.lateDestination ?? 'none' },
    ]));
    if (d.fallbackActive) deadlineCard.append(element(doc, 'p', { className: 'a52-quorum-ok', text: `Foreground proceeds with ${d.fallbackType}; late reranker output is ${d.lateDestination} and did not alter sealed context.` }));
  };
  renderDeadline();
  const projector = new PrecisionFunnelProjector({ adapter: adapters.precision, scheduler, onUpdate: (key) => { if (key === 'funnel') renderFunnel(); else renderDeadline(); } }).mount();
  scope.add(() => projector.destroy());

  const candidatesPage = adapters.precision.getCandidatesPage({ offset: 0, limit: 500 });
  const candidatesCard = element(doc, 'section', { className: 'a52-card' });
  candidatesCard.append(element(doc, 'h2', { text: `Rerank candidates | ${candidatesPage.total}` }), element(doc, 'p', { className: 'a52-muted', text: 'Select a candidate to fetch the detailed rerank record on demand.' }));
  const candidatesHost = element(doc, 'div');
  candidatesCard.append(candidatesHost);
  host.append(candidatesCard);
  new VirtualListController({
    host: candidatesHost, items: candidatesPage.items, itemSize: 66, overscan: 6, scope, keyForItem: (item) => item.id,
    renderItem(candidate) {
      const button = element(doc, 'button', { className: 'a52-precision-row', attrs: { type: 'button' }, dataset: { truth: candidate.truthClass } });
      button.append(
        makeBadge(doc, candidate.truthClass, truthStatus(candidate.truthClass)),
        element(doc, 'strong', { text: `#${candidate.finalRank} | ${candidate.id}` }),
        element(doc, 'span', { text: `${candidate.sourceChannel} | fused ${candidate.preRerankFusedScore} -> normalized ${candidate.normalizedScore} | ${candidate.freshness}` }),
      );
      scope.listen(button, 'click', () => {
        const detail = adapters.precision.getCandidateDetail(candidate.id);
        signals.publish(Signals.UI_INSPECT_SELECTION_CHANGED, { object: { kind: 'rerank-candidate-detail', ...detail } }, { source: 'precision-workspace' });
      });
      return button;
    },
  }).mount();

  const oppositeCard = element(doc, 'section', { className: 'a52-card' });
  oppositeCard.append(element(doc, 'h2', { text: 'Intent-opposite diagnostic fixtures' }));
  const oppositeGrid = element(doc, 'div', { className: 'a52-grid' });
  adapters.precision.getIntentOppositeFixtures().forEach((item) => {
    const card = element(doc, 'article', { className: 'a52-card' });
    card.append(element(doc, 'strong', { text: item.query }), createKeyValue(doc, [
      { key: 'Semantic near-neighbor', value: item.semanticallySimilarWrong },
      { key: 'Fused scores', value: `${item.fusedScores.wanted} vs ${item.fusedScores.wrong}` },
      { key: 'Rerank scores', value: `${item.rerankScores.wanted} vs ${item.rerankScores.wrong}` },
      { key: 'Winner', value: item.winner },
      { key: 'Why wrong candidate lost', value: item.reason },
    ]));
    oppositeGrid.append(card);
  });
  oppositeCard.append(oppositeGrid);
  host.append(oppositeCard);

  const benchmarkCard = element(doc, 'section', { className: 'a52-card' });
  benchmarkCard.append(element(doc, 'h2', { text: 'Runtime / quantization evidence' }), element(doc, 'p', { className: 'a52-muted', text: 'UI.Core displays externally generated benchmark records; it does not benchmark models or depend on a specific runtime.' }));
  const benchmarkGrid = element(doc, 'div', { className: 'a52-grid' });
  adapters.precision.getRuntimeBenchmarks().forEach((record) => {
    const card = ement(doc, 'article', { className: 'a52-card' });
    card.append(element(doc, 'strong', { text: `${record.profileId} | ${record.precision}/${record.device}` }), createKeyValue(doc, [
      { key: 'Runtime', value: record.runtime },
      { key: 'Load / cold / warm', value: `${record.modelLoadMs}/${record.coldLatencyMs}/${record.warmLatencyMs}ms` },
      { key: 'p50 / p95', value: `${record.p50Ms}/${record.p95Ms}ms` },
      { key: 'Candidates/sec', value: record.candidatesPerSec },
      { key: 'RAM / VRAM', value: `${record.ramMb}/${record.vramMb} MB` },
      { key: 'Batch size', value: record.batchSize },
      { key: 'Rank stability', value: record.rankStability },
      { key: 'Fallback', value: record.fallbackBehavior },
    ]));
    benchmarkGrid.append(card);
  });
  benchmarkCard.append(benchmarkGrid);
  host.append(benchmarkCard);

  if (fixture?.simulateRerankTimeout) deadlineCard.append(createButton(doc, { label: 'Simulate reranker deadline miss', scope, onPress: () => fixture.simulateRerankTimeout() }));
  host.append(deadlineCard);
}

function truthStatus(truth) {
  if (truth === TruthClass.CURRENT) return 'canonical';
  if (truth === TruthClass.HISTORICAL || truth === TruthClass.SUPERSEDED) return 'historical';
  if (truth === TruthClass.CONTRADICTED) return 'error';
  if (truth === TruthClass.UNRESOLVED || truth === TruthClass.UNCERTAIN) return 'warning';
  return 'inferred';
}
