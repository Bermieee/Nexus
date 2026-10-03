import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeOptimizationCaptures } from '../tools/optimization-baseline.mjs';

const capture = (generationId, exportedAt = 100) => ({
  kind: 'NexusUnifiedDiagnosticsExport', exportedAt,
  selection: { chatId: 'test-story', generationId, worldRevision: 9 },
  generationPerformance: {
    selection: { chatId: 'test-story', generationId },
    brainStages: [{ stage: 'NEXUS_PREGENERATION', wallMs: 120 }, { stage: 'HOST_PROMPT_BOUNDARY', wallMs: 20 }],
    detailed: { chatId: 'test-story', generationId, start: { heapBytes: 1000 }, afterInsertion: { heapBytes: 1400 }, end: { heapBytes: 1100 } },
  },
  rawOperationalSnapshot: {
    selection: { chatId: 'test-story', generationId },
    pipeline: { physicalExecutionAttempts: 3, physicalExecutionFailed: 0, learningReceipt: false },
    telemetry: { nexus: {
      generationFrame: { chatId: 'test-story', generationId, sections: [{ id: 'scene', tokens: 80, content: 'PRIVATE STORY' }] },
      observability: { events: [{ name: 'internal', data: { prompt: 'PRIVATE PROMPT' } }] },
      worldTree: { counts: { nodes: 5, edges: 4 } },
      subsystems: { postturn: { processedThrough: 2, pendingMessageIds: ['m3'] } },
    } },
  },
});

test('baseline preserves unavailable metrics rather than reporting zero or a complete ten-turn run', () => {
  const result = summarizeOptimizationCaptures([{ source: 'one.json', capture: capture('g1') }]);
  const row = result.turns[0];
  assert.equal(row.waitBeforeModelMs, 140);
  assert.equal(row.providerMs, null);
  assert.equal(row.eventsEmitted, null);
  assert.equal(row.durableWrites, null);
  assert.equal(row.retainedRawEvents, 1);
  assert.equal(row.heapBeforeInsertionDeltaBytes, 400);
  assert.equal(row.pendingPostturnRecords, 1);
  assert.equal(result.controlledBaselineVerified, false);
  assert.equal(result.turnCount, 1);
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
});

test('repeated exports of one generation are counted once and use the newest capture', () => {
  const old = capture('g1', 100), newer = capture('g1', 200);
  newer.generationPerformance.brainStages[0].wallMs = 90;
  const input = [{ source: 'new.json', capture: newer }, { source: 'old.json', capture: old }];
  const before = structuredClone(input);
  const result = summarizeOptimizationCaptures(input);
  assert.equal(result.turnCount, 1);
  assert.equal(result.turns[0].source, 'new.json');
  assert.equal(result.turns[0].waitBeforeModelMs, 110);
  assert.equal(result.duplicateCaptures, 1);
  assert.deepEqual(input, before);
});

test('same generation name in different chats cannot combine measurements', () => {
  const first = capture('g1'), second = capture('g1');
  second.selection.chatId = 'other-story';
  const result = summarizeOptimizationCaptures([{ source: 'a', capture: first }, { source: 'b', capture: second }]);
  assert.equal(result.turnCount, 2);
  assert.equal(result.chatCount, 2);
  assert.equal(result.controlledBaselineVerified, false);
});

test('historical selection never borrows live generation timing, heap, or execution counts', () => {
  const data = capture('live-generation');
  data.selection.generationId = 'historical-generation';
  const row = summarizeOptimizationCaptures([{ source: 'historical.json', capture: data }]).turns[0];
  assert.equal(row.generationId, 'historical-generation');
  assert.equal(row.waitBeforeModelMs, null);
  assert.equal(row.heapBeforeInsertionDeltaBytes, null);
  assert.equal(row.physicalAttempts, null);
  assert.deepEqual(row.promptSections, []);
});

test('a foreign heap profile cannot borrow the matching performance selection', () => {
  const data = capture('g1');
  data.generationPerformance.detailed.chatId = 'another-story';
  const row = summarizeOptimizationCaptures([{ source: 'a', capture: data }]).turns[0];
  assert.equal(row.waitBeforeModelMs, 140);
  assert.equal(row.heapBeforeInsertionDeltaBytes, null);
});

test('missing or conflicting performance identity leaves timings unavailable', () => {
  for (const identity of [undefined, { chatId: 'test-story', generationId: 'g1', turnId: 'wrong-turn' }, { chatId: 'test-story', generationId: 'g1', correlationId: 'wrong-correlation' }]) {
    const data = capture('g1');
    Object.assign(data.selection, { turnId: 'turn', correlationId: 'correlation' });
    data.generationPerformance.selection = identity;
    const row = summarizeOptimizationCaptures([{ source: 'a', capture: data }]).turns[0];
    assert.equal(row.waitBeforeModelMs, null);
  }
});

test('zero is measured only when published; null, negative, or absent timings stay unavailable', () => {
  const data = capture('g1');
  data.generationPerformance.brainStages = [
    { stage: 'NEXUS_PREGENERATION', wallMs: null },
    { stage: 'HOST_PROMPT_BOUNDARY', wallMs: 0 },
    { stage: 'PROVIDER_RESPONSE', wallMs: -1 },
  ];
  data.generationPerformance.detailed.start.heapBytes = null;
  const row = summarizeOptimizationCaptures([{ source: 'a', capture: data }]).turns[0];
  assert.equal(row.preGenerationMs, null);
  assert.equal(row.hostBoundaryMs, 0);
  assert.equal(row.waitBeforeModelMs, null);
  assert.equal(row.providerMs, null);
  assert.equal(row.heapBeforeInsertionDeltaBytes, null);
});

test('a count of ten captures alone does not certify the controlled script or installed revision', () => {
  const result = summarizeOptimizationCaptures(Array.from({ length: 10 }, (_, i) => ({ source: String(i), capture: capture(`g${i}`, i) })));
  assert.equal(result.turnCount, 10);
  assert.equal(result.controlledBaselineVerified, false);
});

test('actual UI metric dictionaries preserve measured category averages and samples', () => {
  const data = capture('g1');
  data.diagnosticsUi = { categories: { UI_WORKSPACE_REFRESH: { count: 9, avgMs: 618.956, maxMs: 673 } } };
  const row = summarizeOptimizationCaptures([{ source: 'a', capture: data }]).turns[0];
  assert.deepEqual(row.diagnosticsUi, [{ category: 'UI_WORKSPACE_REFRESH', samples: 9, meanMs: 618.956, maxMs: 673 }]);
});
