import { createKeyValue, element, makeBadge } from './primitives.js';
import { createKnowledgeActionBar } from './provenance-ui.js';

export function registerWave3InspectorRenderers(registry, { actionRouter, permissions = ['knowledge:inspect'] }) {
  registry.register('runtime-worker-detail', (worker, { document: doc }) => detailCard(doc, 'Runtime worker telemetry', worker, [
    ['Worker', worker.id], ['Capability', worker.capabilityProfile?.join(', ')], ['Layer', `${worker.layer}/${worker.cognitiveLayer}`], ['Task', worker.currentTask?.label ?? worker.currentTask?.id], ['State', worker.state], ['Provider/model', `${worker.provider}/${worker.model}`], ['Queue time', `${worker.queueTimeMs}ms`], ['Execution latency', `${worker.executionLatencyMs}ms`], ['Recovery history', JSON.stringify(worker.recoveryHistory ?? [])],
  ]));

  registry.register('work-ledger-detail', (task, { document: doc }) => detailCard(doc, 'Work Ledger task', task, [
    ['Task', task.id], ['Layer', task.cognitiveLayer], ['Source/world/scene fences', `${task.sourceRevisionFence}/${task.worldRevisionFence}/${task.sceneRevisionFence}`], ['Capabilities', task.capabilityRequirements?.join(', ')], ['Dependencies', task.dependencies?.join(', ') || 'none'], ['Completed slices', task.completedSlices?.join(', ') || 'none'], ['Pending slices', task.pendingSlices?.join(', ') || 'none'], ['Dedupe / conflict', `${task.dedupeKey} / ${task.conflictKey}`], ['Checkpoint', task.checkpoint], ['Last result receipt', task.lastResultReceipt ?? 'none'], ['Recovery', task.recoveryState], ['Stale/superseded', task.staleState],
  ]));

  registry.register('coprocessor-telemetry-detail', (worker, { document: doc }) => {
    const root = detailCard(doc, 'Coprocessor worker telemetry', worker, [
      ['Worker/capabilities', `${worker.name} / ${worker.capabilities?.join(', ')}`], ['Layer', worker.cognitiveLayer], ['Result class', worker.resultClass], ['Task', worker.currentTask], ['Queue / execution', `${worker.queueDelayMs}/${worker.executionLatencyMs}ms`], ['Freshness', worker.freshness], ['Retries', worker.retryCount], ['Validation', worker.validationResult], ['Dedupe key', worker.dedupeKey], ['Warm/cache hit', worker.cacheWarmHit], ['Fallback', worker.fallbackUsed], ['Destination', worker.destination ?? 'pending'], ['Context Seal contribution', worker.contributedToSealedContext],
    ]);
    root.append(element(doc, 'p', { className: 'a52-muted', text: 'Raw model prompt/response payloads are not continuously replicated. Debug payloads require an explicit adapter request.' }));
    return root;
  });

  registry.register('memory-state-detail', (record, { document: doc }) => {
    const root = detailCard(doc, record.label ?? 'Memory state', record, [
      ['Authority', record.authorityClass], ['Source revision', record.sourceRevision], ['World revision', record.worldRevision], ['Current', `${record.currentState?.status} | ${record.currentState?.text}`], ['Historical', JSON.stringify(record.historicalStates ?? [])], ['Unresolved', JSON.stringify(record.unresolvedEvidence ?? [])], ['Dependencies', record.dependencies?.join(', ') || 'none'], ['Invalidators', record.invalidators?.join(', ') || 'none'], ['Settlement', `${record.settlement?.owner ?? 'none'} | ${record.settlement?.outcome ?? 'none'}`],
    ]);
    root.append(createKnowledgeActionBar(doc, { ref: { id: record.id, kind: 'memory-state', provenance: record.provenance }, actionRouter, permissions }));
    return root;
  });

  registry.register('reflection-detail', (reflection, { document: doc }) => {
    const root = detailCard(doc, 'Reflection', reflection, [
      ['ID / subject', `${reflection.id} / ${reflection.subject}`], ['Authority', reflection.authority], ['Pattern', reflection.pattern], ['Confidence', reflection.confidence], ['Supporting evidence', reflection.supportingEvidence?.join(', ')], ['Contradicting evidence', reflection.contradictingEvidence?.join(', ') || 'none'], ['Source/world revisions', `${reflection.sourceRevision}/${reflection.worldRevision}`], ['Status', reflection.status], ['History', JSON.stringify(reflection.history ?? [])], ['Supersedes', reflection.supersedes?.join(', ') || 'none'], ['Invalidators', reflection.invalidators?.join(', ') || 'none'],
    ]);
    root.append(element(doc, 'p', { className: 'a52-muted', text: 'Reflection is INFERRED. UI.Core exposes no direct canon-promotion control.' }));
    return root;
  });

  registry.register('rerank-candidate-detail', (candidate, { document: doc }) => {
    const root = detailCard(doc, 'Rerank result', candidate, [
      ['Candidate', candidate.id], ['Source/channel', candidate.sourceChannel], ['Truth Gate', candidate.truthClass], ['Pre-rerank fused score', candidate.preRerankFusedScore], ['Raw reranker score', candidate.rawRerankerScore], ['Normalized score', candidate.normalizedScore], ['Final rank', candidate.finalRank], ['Model/profile', candidate.modelProfileId], ['Runtime', candidate.runtime], ['Precision mode', candidate.precisionMode], ['Candidate budget', candidate.candidateBudget], ['Token budget', candidate.tokenBudget], ['Truncation', candidate.truncationApplied], ['Latency', `${candidate.latencyMs}ms`], ['Freshness', candidate.freshness], ['Fallback', candidate.fallbackState],
    ]);
    root.append(createKnowledgeActionBar(doc, { ref: { id: candidate.id, kind: 'candidate', provenance: candidate.provenance }, actionRouter, permissions }));
    return root;
  });
}

function detailCard(doc, title, object, rows) {
  const root = element(doc, 'div', { className: 'a52-stack' });
  root.append(element(doc, 'h2', { text: title }), makeBadge(doc, object.state ?? object.status ?? object.kind ?? 'detail', object.authority === 'INFERRED' ? 'inferred' : 'ready'), createKeyValue(doc, rows.map(([key, value]) => ({ key, value: value ?? 'none' }))));
  return root;
}
