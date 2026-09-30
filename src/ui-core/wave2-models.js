import { Wave2Signals } from './wave2-adapters.js';

export class SceneDeltaProjector {
  constructor({ adapter, scheduler, onFieldUpdate = () => {} }) {
    this.adapter = adapter;
    this.scheduler = scheduler;
    this.onFieldUpdate = onFieldUpdate;
    this.scene = adapter.getCurrentScene();
    this.renderCounts = new Map();
    this.release = null;
  }

  mount() {
    if (this.release) return this;
    this.release = this.adapter.subscribeSceneDeltas((event) => this.consume(event));
    return this;
  }

  consume(event) {
    const delta = event.payload ?? {};
    if (event.type === Wave2Signals.SCENE_BOUNDARY_CHANGED || event.type === Wave2Signals.SCENE_EPISODE_CLOSED || event.type === Wave2Signals.SCENE_NAVIGATION_CHANGED) return;
    const field = delta.field;
    if (!field) return;
    if (delta.sceneId && delta.sceneId !== this.scene.id && delta.field !== 'scene') {
      this.scene = this.adapter.getCurrentScene();
    } else if (delta.field === 'scene') {
      this.scene = this.adapter.getCurrentScene();
    } else {
      this.scene[field] = delta.value;
      if (delta.sceneRevision) this.scene.revision = delta.sceneRevision;
    }
    const key = `scene:${this.scene.id}:${field}`;
    this.scheduler.invalidate(key, () => {
      this.renderCounts.set(field, (this.renderCounts.get(field) ?? 0) + 1);
      this.onFieldUpdate(field, this.scene[field], delta);
    });
  }

  destroy() {
    this.release?.();
    this.release = null;
    this.scheduler.cancelPrefix?.('scene:');
  }
}

export class SceneNavigator {
  constructor({ adapter, sceneId }) {
    this.adapter = adapter;
    this.sceneId = sceneId;
  }

  related() { return this.adapter.getRelatedScenes(this.sceneId); }
  moveTo(sceneId) {
    const relation = this.related().find((edge) => edge.scene?.id === sceneId);
    if (!relation) throw new Error(`Scene ${sceneId} is not directly related to ${this.sceneId}`);
    this.sceneId = sceneId;
    return relation;
  }
}

export class TurnSwarmModel {
  constructor({ adapter, turnId }) {
    this.adapter = adapter;
    this.turnId = turnId;
    this.turn = adapter.getTurnSwarm(turnId);
    this.release = null;
  }

  mount(onChange = () => {}) {
    this.release = this.adapter.subscribeCoprocessor((event) => {
      if (event.payload?.turnId && event.payload.turnId !== this.turnId) return;
      this.turn = this.adapter.getTurnSwarm(this.turnId);
      onChange(event, this.turn);
    });
    return this;
  }

  get gather() { return this.turn?.gather ?? null; }
  get foregroundWorkers() { return (this.turn?.workers ?? []).filter((worker) => worker.contributedToCurrentContext); }
  get lateWorkers() { return (this.turn?.workers ?? []).filter((worker) => worker.lateRoute); }
  destroy() { this.release?.(); this.release = null; }
}

export class ProvenanceInspectorModel {
  constructor({ knowledgeAdapter }) { this.adapter = knowledgeAdapter; }
  inspect(action, ref) {
    const methods = {
      source: 'inspectSource', provenance: 'inspectProvenance', history: 'inspectHistory',
      dependencies: 'inspectDependencies', settlement: 'inspectSettlement', evidence: 'inspectEvidence',
    };
    const method = methods[action];
    if (!method) throw new Error(`Unknown knowledge inspection action: ${action}`);
    return this.adapter[method](ref);
  }
}
