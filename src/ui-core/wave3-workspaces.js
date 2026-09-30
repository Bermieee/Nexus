import { renderSceneIntelligenceWorkspace } from './wave2-scene-workspace.js';
import { renderHotCognitionWorkspace } from './wave2-hot-inspector.js';
import { renderWave3RuntimeWorkspace } from './wave3-runtime-workspace.js';
import { renderWave3CoprocessorWorkspace } from './wave3-coprocessor-workspace.js';
import { renderAdvancedMemoryWorkspace } from './wave3-memory-workspace.js';
import { renderPrecisionWorkspace } from './wave3-precision-workspace.js';

export function registerWave3Workspaces(registry) {
  registry.register({ id: 'scene-intelligence', title: 'Scene', icon: 'SC', views: ['current','deltas','boundary','episodes','graph'], supportedActions: ['inspect'], render: renderSceneIntelligenceWorkspace });
  registry.register({ id: 'runtime', title: 'Runtime', icon: 'RT', views: ['overview','workers','lifecycle','batches','ledger'], supportedActions: ['inspect'], render: renderWave3RuntimeWorkspace });
  registry.register({ id: 'coprocessors', title: 'Coprocessors', icon: 'CP', views: ['swarm','gather','seal','telemetry'], supportedActions: ['inspect'], render: renderWave3CoprocessorWorkspace });
  registry.register({ id: 'advanced-memory', title: 'Memory State', icon: 'MS', views: ['state','settlement','reflection','episodes'], supportedActions: ['inspect'], render: renderAdvancedMemoryWorkspace });
  registry.register({ id: 'precision', title: 'Precision', icon: 'PX', views: ['pipeline','funnel','rerank','benchmark','fallback'], supportedActions: ['inspect'], render: renderPrecisionWorkspace });
  registry.register({ id: 'hot-cognition', title: 'Hot', icon: 'HOT', views: ['compact'], supportedActions: ['inspect'], render: renderHotCognitionWorkspace });
}
