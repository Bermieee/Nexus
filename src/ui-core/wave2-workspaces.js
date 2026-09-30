import { renderSceneIntelligenceWorkspace } from './wave2-scene-workspace.js';
import { renderCognitiveRuntimeWorkspace } from './wave2-runtime-workspace.js';
import { renderCoprocessorWorkspace } from './wave2-coprocessor-workspace.js';
import { installHotCognitionStrip, registerWave2InspectorRenderers, renderHotCognitionWorkspace } from './wave2-hot-inspector.js';

export { renderSceneIntelligenceWorkspace, renderCognitiveRuntimeWorkspace, renderCoprocessorWorkspace, renderHotCognitionWorkspace, installHotCognitionStrip, registerWave2InspectorRenderers };

export function registerWave2Workspaces(registry) {
  registry.register({ id: 'scene-intelligence', title: 'Scene', icon: '◈', views: ['current','deltas','boundary','episodes','graph'], supportedActions: ['inspect'], render: renderSceneIntelligenceWorkspace });
  registry.register({ id: 'coprocessors', title: 'Coprocessors', icon: '⋈', views: ['swarm','gather','seal'], supportedActions: ['inspect'], render: renderCoprocessorWorkspace });
  registry.register({ id: 'hot-cognition', title: 'Hot', icon: '◉', views: ['compact'], supportedActions: ['inspect'], render: renderHotCognitionWorkspace });
}
