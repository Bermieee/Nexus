import test from 'node:test';
import assert from 'node:assert/strict';
import { Wave13OperationalStatusAdapter } from '../src/ui-core/wave13-operator-adapters.js';

function setup() {
  let selection = { chatId: 'story-a', turnId: 'g1', generationId: 'g1' };
  const calls = { scene: 0, runtime: 0, coprocessor: 0, promptPlan: 0 };
  const errors = new Set();
  const productionAdapters = Object.fromEntries(Object.keys(calls).map(name => [name, { read(query) {
    calls[name] += 1;
    if (errors.has(name)) throw new Error(name + ' unavailable');
    return { source: { mode: 'LIVE', health: 'READY', operationalState: 'LIVE' }, data: {
      ...query, label: name,
      ...(name === 'coprocessor' ? { physicalExecution: { attempts: 2, succeeded: 1, failed: 1 } } : {}),
    } };
  } }]));
  const adapter = new Wave13OperationalStatusAdapter({
    liveReceiptBinding: { selection: () => ({ ...selection }) }, productionAdapters,
    hostBindings: { readSceneUiReadModel() {}, readRuntimeStatus() {}, readCognitionUiState() {}, readPromptPlan() {} },
  });
  return { adapter, calls, errors, select: value => { selection = value; } };
}

test('one operational snapshot shares fresh owner reads between status, counts and inspection', () => {
  const { adapter, calls } = setup();
  const value = adapter.read();
  assert.equal(value.pipeline.physicalExecutionAttempts, 2);
  assert.equal(value.pipeline.physicalExecutionSucceeded, 1);
  assert.equal(value.pipeline.physicalExecutionFailed, 1);
  assert.equal(value.stages.find(row => row.id === 'scene').state, 'LIVE');
  assert.equal(value.inspections.scene.payload.chatId, 'story-a');
  assert.deepEqual(calls, { scene: 1, runtime: 1, coprocessor: 1, promptPlan: 1 });
});

test('a new read after a story switch never reuses previous owner values', () => {
  const { adapter, calls, select } = setup();
  adapter.read();
  select({ chatId: 'story-b', turnId: 'g2', generationId: 'g2' });
  const value = adapter.read();
  assert.equal(value.inspections.scene.payload.chatId, 'story-b');
  assert.equal(value.inspections.coprocessor.payload.generationId, 'g2');
  assert.deepEqual(calls, { scene: 2, runtime: 2, coprocessor: 2, promptPlan: 2 });
});

test('a failed owner read degrades its row while other owner evidence survives', () => {
  const { adapter, calls, errors } = setup();
  errors.add('scene');
  const value = adapter.read();
  assert.equal(value.stages.find(row => row.id === 'scene').state, 'DEGRADED');
  assert.equal(value.inspections.scene.payload.status, 'PRODUCER_ERROR');
  assert.equal(value.pipeline.physicalExecutionAttempts, 2);
  assert.equal(value.inspections.promptPlan.payload.generationId, 'g1');
  assert.equal(calls.scene, 1);
  errors.delete('scene');
  assert.equal(adapter.read().stages.find(row => row.id === 'scene').state, 'LIVE');
  assert.equal(calls.scene, 2);
});

test('waiting for a turn still reads runtime inspection and physical execution evidence', () => {
  const { adapter, calls, select } = setup();
  select({ chatId: 'story-a', turnId: null, generationId: null });
  const value = adapter.read();
  assert.equal(value.stages.find(row => row.id === 'runtime').state, 'WAITING_FOR_TURN');
  assert.equal(value.pipeline.physicalExecutionAttempts, 2);
  assert.equal(value.inspections.runtime.payload.chatId, 'story-a');
  assert.deepEqual(calls, { scene: 1, runtime: 1, coprocessor: 1, promptPlan: 1 });
});
