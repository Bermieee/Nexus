import { createKeyValue, element, makeBadge } from './primitives.js';

export const GENERIC_INSPECTION_SCHEMA_MAJOR = 1;

export function normalizeGenericArtifact(artifact = {}) {
  return Object.freeze({
    artifactId: artifact.artifactId ?? artifact.id ?? 'unknown',
    artifactType: artifact.artifactType ?? artifact.kind ?? 'unknown',
    schemaVersion: artifact.schemaVersion ?? '1.0.0',
    owner: artifact.owner ?? 'unknown',
    authority: artifact.authority ?? artifact.authorityClass ?? 'unknown',
    revision: artifact.revision ?? artifact.worldRevision ?? artifact.sourceRevision ?? null,
    status: artifact.status ?? 'unknown',
    provenance: Object.freeze([...(artifact.provenance ?? artifact.sourceEvidence ?? [])]),
    dependencies: Object.freeze([...(artifact.dependencies ?? [])]),
    invalidators: Object.freeze([...(artifact.invalidators ?? [])]),
    payloadSummary: summarizePayload(artifact.payload ?? artifact.data ?? artifact),
  });
}

export function presentEventEnvelope(event = {}, { schemaVersion = event.schemaVersion ?? '1.0.0', knownTypes = [] } = {}) {
  const major = parseMajor(schemaVersion);
  if (major !== GENERIC_INSPECTION_SCHEMA_MAJOR) {
    return Object.freeze({
      compatible: false,
      presentation: 'INCOMPATIBLE',
      schemaVersion,
      error: `Unsupported event schema major: ${schemaVersion}`,
      eventId: event.eventId ?? event.id ?? null,
      eventType: event.eventType ?? event.type ?? 'unknown',
    });
  }
  const eventType = event.eventType ?? event.type ?? 'unknown';
  return Object.freeze({
    compatible: true,
    presentation: knownTypes.includes(eventType) ? 'RICH' : 'GENERIC',
    schemaVersion,
    eventId: event.eventId ?? event.id ?? null,
    eventType,
    causationId: event.causationId ?? null,
    correlationId: event.correlationId ?? null,
    turnId: event.turnId ?? null,
    taskId: event.taskId ?? null,
    sourceRevisions: Object.freeze({ ...(event.sourceRevisions ?? {}) }),
    worldRevision: event.worldRevision ?? null,
    sceneRevision: event.sceneRevision ?? null,
    sequence: event.createdSequence ?? event.sequence ?? null,
    createdAt: event.createdAt ?? null,
    dedupeKey: event.dedupeKey ?? null,
    payloadSummary: summarizePayload(event.payload ?? {}),
  });
}

export function renderGenericArtifactInspector(object, { document: doc }) {
  const artifact = normalizeGenericArtifact(object);
  const root = element(doc, 'div', { className: 'a52-stack' });
  root.append(
    element(doc, 'h2', { text: `Artifact · ${artifact.artifactType}` }),
    makeBadge(doc, artifact.status, artifact.status === 'CURRENT' ? 'canonical' : 'inferred'),
    createKeyValue(doc, [
      { key: 'Artifact ID', value: artifact.artifactId },
      { key: 'Schema version', value: artifact.schemaVersion },
      { key: 'Owner', value: artifact.owner },
      { key: 'Authority', value: artifact.authority },
      { key: 'Revision', value: artifact.revision ?? 'none' },
      { key: 'Status', value: artifact.status },
      { key: 'Provenance', value: artifact.provenance.join(', ') || 'none' },
      { key: 'Dependencies', value: artifact.dependencies.join(', ') || 'none' },
      { key: 'Invalidators', value: artifact.invalidators.join(', ') || 'none' },
      { key: 'Payload summary', value: artifact.payloadSummary },
    ]),
  );
  return root;
}

export function renderGenericEventInspector(object, { document: doc, knownTypes = [] } = {}) {
  const event = presentEventEnvelope(object, { knownTypes });
  const root = element(doc, 'div', { className: 'a52-stack' });
  root.append(
    element(doc, 'h2', { text: `Event · ${event.eventType}` }),
    makeBadge(doc, event.presentation, event.compatible ? 'inferred' : 'error'),
  );
  if (!event.compatible) {
    root.append(element(doc, 'p', { className: 'a52-error', text: event.error }));
    return root;
  }
  root.append(createKeyValue(doc, [
    { key: 'Event ID', value: event.eventId ?? 'none' },
    { key: 'Schema version', value: event.schemaVersion },
    { key: 'Causation / correlation', value: `${event.causationId ?? 'none'} / ${event.correlationId ?? 'none'}` },
    { key: 'Turn / task', value: `${event.turnId ?? 'none'} / ${event.taskId ?? 'none'}` },
    { key: 'World / scene', value: `${event.worldRevision ?? 'none'} / ${event.sceneRevision ?? 'none'}` },
    { key: 'Sequence / time', value: `${event.sequence ?? 'none'} / ${event.createdAt ?? 'none'}` },
    { key: 'Dedupe', value: event.dedupeKey ?? 'none' },
    { key: 'Payload summary', value: event.payloadSummary },
  ]));
  return root;
}

export function summarizePayload(value, { maxKeys = 8, maxText = 160 } = {}) {
  if (value == null) return 'none';
  if (typeof value === 'string') return value.length > maxText ? `${value.slice(0, maxText)}…` : value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `Array(${value.length})`;
  if (typeof value === 'object') {
    const keys = Object.keys(value);
    const shown = keys.slice(0, maxKeys).map((key) => {
      const child = value[key];
      if (child == null || ['string','number','boolean'].includes(typeof child)) return `${key}=${String(child).slice(0, 40)}`;
      if (Array.isArray(child)) return `${key}=Array(${child.length})`;
      return `${key}=Object(${Object.keys(child).length})`;
    });
    return `${shown.join(' · ')}${keys.length > maxKeys ? ` · +${keys.length - maxKeys} fields` : ''}`;
  }
  return typeof value;
}

function parseMajor(version) {
  const match = String(version).match(/^(\d+)(?:\.|$)/);
  return match ? Number(match[1]) : Number.NaN;
}
