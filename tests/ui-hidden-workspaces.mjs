import test from 'node:test';
import assert from 'node:assert/strict';
import { ApplicationShell } from '../src/ui-core/shell.js';
import { HostAdjacentFrontFaceController } from '../src/ui-core/wave6-front-face.js';

function harness(visible = false) {
  const state = { visible, revision: 1, rendered: [], saves: [], signals: [] };
  const entries = new Map(['brain', 'world-tree'].map(id => [id, { id }]));
  const shell = new ApplicationShell({
    root: {}, workspaceRegistry: { has: id => entries.has(id), get: id => entries.get(id) },
    inspector: {}, signals: { publish: (...args) => state.signals.push(args) },
    stateStore: { save: value => state.saves.push(value) },
    workspaceVisible: () => state.visible,
    renderWorkspace: entry => state.rendered.push({ id: entry.id, revision: state.revision }),
  });
  shell.nodes = { workspace: {}, nav: { querySelectorAll: () => [] } };
  shell.currentWorkspace = 'brain';
  return { state, shell };
}

test('closed panels coalesce host updates and reopen with the latest owner state', () => {
  const { state, shell } = harness();
  for (let revision = 2; revision <= 101; revision++) {
    state.revision = revision;
    assert.equal(shell.refreshCurrentWorkspace(), false);
  }
  assert.deepEqual(state.rendered, []);
  assert.equal(shell.flushPendingWorkspaceRefresh(), false);
  state.visible = true;
  assert.equal(shell.flushPendingWorkspaceRefresh(), true);
  assert.deepEqual(state.rendered, [{ id: 'brain', revision: 101 }]);
  assert.equal(shell.flushPendingWorkspaceRefresh(), false);
});

test('switching workspaces while closed cannot reopen the old workspace', () => {
  const { state, shell } = harness();
  shell.refreshCurrentWorkspace();
  shell.selectWorkspace('world-tree');
  state.revision = 22;
  assert.deepEqual(state.rendered, []);
  assert.equal(shell.currentWorkspace, 'world-tree');
  assert.equal(state.signals.length, 1);
  state.visible = true;
  shell.flushPendingWorkspaceRefresh();
  assert.deepEqual(state.rendered, [{ id: 'world-tree', revision: 22 }]);
});

test('visible panels still refresh immediately and deleted workspaces never replay', () => {
  const { state, shell } = harness(true);
  assert.equal(shell.refreshCurrentWorkspace(), true);
  state.visible = false;
  shell.refreshCurrentWorkspace();
  shell.workspaceRegistry.has = () => false;
  state.visible = true;
  assert.equal(shell.flushPendingWorkspaceRefresh(), false);
  assert.equal(state.rendered.length, 1);
});

test('floating navigation disables detached Quick Dash work without disabling other UI work', () => {
  let reads = 0, scheduled = 0;
  const controller = new HostAdjacentFrontFaceController({
    host: {}, shell: {}, adapter: { getSnapshot() { reads++; throw Error('Detached Quick Dash read'); } },
    presentation: {}, scheduler: { invalidate() { scheduled++; } }, signals: {}, quickDashEnabled: false,
  });
  controller.nodes.quick = {};
  controller.scheduleQuickDash();
  controller.renderQuickDash();
  assert.equal(reads, 0);
  assert.equal(scheduled, 0);
});

test('ordinary host-adjacent navigation retains its Quick Dash by default', () => {
  let scheduled = 0;
  const controller = new HostAdjacentFrontFaceController({
    host: {}, shell: {}, adapter: {}, presentation: {}, scheduler: { invalidate() { scheduled++; } }, signals: {},
  });
  controller.scheduleQuickDash();
  assert.equal(scheduled, 1);
});
