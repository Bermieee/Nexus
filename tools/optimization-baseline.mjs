// Offline measurement only. Never imported by the extension or allowed to
// infer unavailable metrics from bounded diagnostic rings.
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function measured(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}
function delta(end, start) {
  return measured(end) != null && measured(start) != null ? end - start : null;
}
function sum(...values) { return values.every(value => value != null) ? values.reduce((a, b) => a + b, 0) : null; }
function average(values) {
  const present = values.filter(value => value != null);
  return { samples: present.length, mean: present.length ? present.reduce((a, b) => a + b, 0) / present.length : null };
}
function sameGeneration(selection, identity) {
  if (!identity || identity.chatId !== selection.chatId || identity.generationId !== selection.generationId) return false;
  return ['turnId', 'correlationId'].every(key => selection[key] == null || identity[key] == null || selection[key] === identity[key]);
}

export function summarizeOptimizationCaptures(inputs) {
  const selected = new Map();
  let duplicateCaptures = 0;
  for (const input of inputs) {
    const data = input.capture;
    if (data?.kind !== 'NexusUnifiedDiagnosticsExport' || !data.selection?.chatId || !data.selection?.generationId) {
      throw new Error(`Not an exact-generation Nexus diagnostic export: ${input.source}`);
    }
    const key = JSON.stringify([data.selection.chatId, data.selection.generationId]);
    const prior = selected.get(key);
    if (prior) duplicateCaptures += 1;
    if (!prior || (measured(data.exportedAt) ?? 0) > (measured(prior.capture.exportedAt) ?? 0)) selected.set(key, input);
  }
  const turns = [...selected.values()].map(({ source, capture: data }) => {
    const publishedPerf = data.generationPerformance ?? {}, publishedRaw = data.rawOperationalSnapshot ?? {};
    const performanceMatches = sameGeneration(data.selection, publishedPerf.selection);
    const operationalMatches = sameGeneration(data.selection, publishedRaw.selection);
    const perf = performanceMatches ? publishedPerf : {}, raw = operationalMatches ? publishedRaw : {};
    const stages = new Map((perf.brainStages ?? []).map(row => [row.stage, measured(row.wallMs)]));
    const heapMatches = performanceMatches && sameGeneration(data.selection, perf.detailed);
    const detail = heapMatches ? perf.detailed : {}, nexus = raw.telemetry?.nexus ?? {};
    const frame = nexus.generationFrame;
    const sections = sameGeneration(data.selection, frame) ? frame.sections ?? [] : [];
    const pending = nexus.subsystems?.postturn;
    return {
      source, exportedAt: measured(data.exportedAt), chatId: data.selection.chatId,
      generationId: data.selection.generationId, installedRevision: null,
      attribution: { performanceMatches, operationalMatches, heapMatches, diagnosticsUiScope: 'retained export-time window' },
      worldRevision: data.selection.worldRevision ?? null, sceneRevision: data.selection.sceneRevision ?? null,
      preGenerationMs: stages.get('NEXUS_PREGENERATION') ?? null,
      hostBoundaryMs: stages.get('HOST_PROMPT_BOUNDARY') ?? null,
      waitBeforeModelMs: sum(stages.get('NEXUS_PREGENERATION'), stages.get('HOST_PROMPT_BOUNDARY')),
      providerMs: stages.get('PROVIDER_RESPONSE') ?? null,
      totalMs: stages.get('GENERATION_TOTAL') ?? null,
      heapBeforeInsertionDeltaBytes: delta(detail.afterInsertion?.heapBytes, detail.start?.heapBytes),
      heapOverallDeltaBytes: delta(detail.end?.heapBytes, detail.start?.heapBytes),
      physicalAttempts: measured(raw.pipeline?.physicalExecutionAttempts),
      physicalFailures: measured(raw.pipeline?.physicalExecutionFailed),
      learningReceiptPresent: typeof raw.pipeline?.learningReceipt === 'boolean' ? raw.pipeline.learningReceipt : null,
      promptSections: sections.map(row => ({ id: row.id, estimatedTokens: measured(row.tokens) })),
      retainedRawEvents: Array.isArray(nexus.observability?.events) ? nexus.observability.events.length : null,
      eventsEmitted: null, durableWrites: null, providerCacheTokens: null,
      startupMs: null, longTasksOver50Ms: null,
      worldNodes: measured(nexus.worldTree?.counts?.nodes), worldEdges: measured(nexus.worldTree?.counts?.edges),
      processedThrough: typeof pending?.processedThrough === 'number' ? pending.processedThrough : null,
      pendingPostturnRecords: Array.isArray(pending?.pendingMessageIds) ? pending.pendingMessageIds.length : null,
      diagnosticsUi: Object.entries(data.diagnosticsUi?.categories ?? {}).map(([category, row]) => ({
        category, samples: measured(row.count), meanMs: measured(row.avgMs), maxMs: measured(row.maxMs),
      })),
      readErrors: (data.errors ?? []).filter(row => row.event?.type === 'READ_ERROR').map(row => ({
        stage: row.event.subtype, code: row.event.metadata?.code ?? null,
        generationId: row.event.selection?.generationId ?? null,
      })),
    };
  }).sort((a, b) => (a.exportedAt ?? 0) - (b.exportedAt ?? 0));
  return {
    kind: 'NexusOptimizationCaptureMeasurements', version: 1,
    controlledBaselineVerified: false,
    qualification: 'Diagnostic captures are observations, not proof of the fixed ten-generation script, installed revision, settled post-turn state, or identical before/after settings.',
    turnCount: turns.length, chatCount: new Set(turns.map(row => row.chatId)).size, duplicateCaptures,
    means: Object.fromEntries(['waitBeforeModelMs', 'providerMs', 'totalMs', 'heapBeforeInsertionDeltaBytes'].map(key => [key, average(turns.map(row => row[key]))])),
    turns,
    unavailable: ['installed revision', 'total events emitted', 'confirmed durable writes per turn', 'provider cache tokens', 'startup timing', 'main-thread long tasks', 'exclusive foreground substage and settled post-turn timings'],
    safety: { readOnly: true, rawPrompts: false, storyBodies: false, credentials: false, mutationAuthority: false },
  };
}

async function main(args) {
  const outputIndex = args.indexOf('--output');
  const output = outputIndex >= 0 ? args[outputIndex + 1] : null;
  if (outputIndex >= 0 && (!output || output.startsWith('--'))) throw new Error('--output requires a file path');
  const files = args.filter((_, index) => outputIndex < 0 || (index !== outputIndex && index !== outputIndex + 1));
  if (!files.length) throw new Error('Usage: node tools/optimization-baseline.mjs [--output report.json] capture1.json capture2.json ...');
  const inputs = await Promise.all(files.map(async file => ({ source: path.basename(file), capture: JSON.parse(await fs.readFile(file, 'utf8')) })));
  const result = summarizeOptimizationCaptures(inputs);
  const text = JSON.stringify(result, null, 2) + '\n';
  if (output) await fs.writeFile(output, text, 'utf8');
  else process.stdout.write(text);
  if (output) console.log(`Measured ${result.turnCount} unique generations from ${inputs.length} captures; controlled baseline remains unverified. Saved ${output}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
