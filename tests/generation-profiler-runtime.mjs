import test from 'node:test';
import assert from 'node:assert/strict';
import {
  setDetailedGenerationProfiling,
  detailedGenerationProfilingEnabled,
  beginNexusGenerationProfile,
  markNexusGenerationPreflightComplete,
  markNexusGenerationPromptBoundary,
  completeNexusGenerationProfile,
  readNativeGenerationPerformance,
  readSelectedGenerationPerformanceReceipt,
  loadGenerationProfilerDiagnostics,
  clearNexusGenerationProfiles,
} from '../nexus/generation-profiler.js';

test('generation profiler keeps cheap timings available while detailed profiling is off',()=>{
  clearNexusGenerationProfiles();
  setDetailedGenerationProfiling(false);
  assert.equal(detailedGenerationProfilingEnabled(),false);
  beginNexusGenerationProfile({generationId:'g-off',chatId:'chat-a'});
  markNexusGenerationPreflightComplete('g-off');
  markNexusGenerationPromptBoundary('g-off');
  completeNexusGenerationProfile('g-off');
  assert.equal(readNativeGenerationPerformance({generationId:'g-off'}),null);
  const receipt=readSelectedGenerationPerformanceReceipt({generationId:'g-off'});
  assert.ok(receipt);
  assert.deepEqual(receipt.performance.stages.map(row=>row.stage),[
    'NEXUS_PREGENERATION','HOST_PROMPT_BOUNDARY','PROVIDER_RESPONSE','GENERATION_TOTAL',
  ]);
  const diagnostics=loadGenerationProfilerDiagnostics();
  assert.equal(diagnostics.generationProfiling.detailedEnabled,false);
  assert.equal(diagnostics.generationProfiling.captureStates.find(row=>row.generationId==='g-off').status,'NOT_ARMED');
});

test('armed generation publishes detailed selected-generation performance',()=>{
  clearNexusGenerationProfiles();
  setDetailedGenerationProfiling(true);
  beginNexusGenerationProfile({generationId:'g-on',chatId:'chat-a'});
  markNexusGenerationPreflightComplete('g-on');
  markNexusGenerationPromptBoundary('g-on');
  completeNexusGenerationProfile('g-on');
  const detailed=readNativeGenerationPerformance({generationId:'g-on'});
  assert.equal(detailed.kind,'NexusGenerationPerformanceProfile');
  assert.equal(detailed.generationId,'g-on');
  assert.equal(detailed.detailedCaptured,true);
  assert.ok(Number.isFinite(detailed.providerLatencyMs));
  assert.equal(loadGenerationProfilerDiagnostics().generationProfiling.captureStates.find(row=>row.generationId==='g-on').status,'AVAILABLE');
  setDetailedGenerationProfiling(false);
  assert.ok(readNativeGenerationPerformance({generationId:'g-on'}),'turning profiler off must not erase retained detailed evidence');
});
