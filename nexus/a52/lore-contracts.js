export const AuthorityClass = Object.freeze({
  SOURCE_CANON: 'SOURCE_CANON',
  DERIVED: 'DERIVED',
  INFERRED: 'INFERRED',
  UNRESOLVED: 'UNRESOLVED',
});

export const TemporalClass = Object.freeze({
  TIMELESS: 'TIMELESS',
  CURRENT: 'CURRENT',
  HISTORICAL: 'HISTORICAL',
  DATED: 'DATED',
  SEQUENCE: 'SEQUENCE',
  UNCERTAIN: 'UNCERTAIN',
  CONFLICTING: 'CONFLICTING',
});

export const ArtifactType = Object.freeze({
  STRUCTURE: 'STRUCTURE',
  CONTEXT_CHUNK: 'CONTEXT_CHUNK',
  ENTITY: 'ENTITY',
  ALIAS: 'ALIAS',
  CLAIM: 'CLAIM',
  PROPERTY: 'PROPERTY',
  RELATIONSHIP: 'RELATIONSHIP',
  RULE: 'RULE',
  CAPABILITY: 'CAPABILITY',
  RESTRICTION: 'RESTRICTION',
  EVENT: 'EVENT',
  CONCEPT: 'CONCEPT',
  COMMUNITY: 'COMMUNITY',
  RETRIEVAL: 'RETRIEVAL',
  COMPACT: 'COMPACT',
});

export const StudyState = Object.freeze({
  DUE: 'DUE',
  PENDING: 'PENDING',
  ACTIVE: 'ACTIVE',
  CHECKPOINTED: 'CHECKPOINTED',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  SUPERSEDED: 'SUPERSEDED',
  STALE: 'STALE',
  INVALID: 'INVALID',
});

export const RetrievalForm = Object.freeze({
  EXACT_SOURCE: 'EXACT_SOURCE',
  CONTEXTUAL_SPARSE: 'CONTEXTUAL_SPARSE',
  DENSE_READY: 'DENSE_READY',
  PRECISION_READY: 'PRECISION_READY',
  COMPACT_LEARNED: 'COMPACT_LEARNED',
});

export const deepClone = (value) => {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
};

export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((key) => JSON.stringify(key) + ':' + stableStringify(value[key])).join(',') + '}';
}

export function stableHash(value) {
  const text = typeof value === 'string' ? value : stableStringify(value);
  let a = 0x811c9dc5;
  let b = 0x9e3779b9;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    a ^= code;
    a = Math.imul(a, 0x01000193) >>> 0;
    b ^= code + ((i + 1) * 131);
    b = Math.imul(b, 0x85ebca6b) >>> 0;
  }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}

export function slug(value) {
  return String(value || '')
    .trim()
    .replace(/^the\s+/i, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'unnamed';
}

export function boundedUnique(values, limit = 64) {
  return [...new Set((values || []).filter((value) => value !== null && value !== undefined && value !== ''))].slice(0, limit);
}

export function makeProvenance({sourceId, sourceRevisionId, span = null, derivation, dependencies = []}) {
  return {
    kind: 'LoreProvenance',
    sourceId,
    sourceRevisionId,
    span: span ? deepClone(span) : null,
    derivation,
    dependencies: boundedUnique(dependencies, 128),
  };
}

export function makeArtifact({
  type,
  sourceId,
  sourceRevisionId,
  logicalKey,
  payload,
  span = null,
  derivation,
  dependencies = [],
  authorityClass = AuthorityClass.DERIVED,
  temporalClass = TemporalClass.TIMELESS,
  confidence = 1,
  unresolved = false,
}) {
  if (!Object.values(ArtifactType).includes(type)) throw new TypeError('Unknown Lore artifact type: ' + type);
  if (!sourceId || !sourceRevisionId || !logicalKey) throw new TypeError('Lore artifact identity is incomplete');
  const semanticId = 'sem:' + type.toLowerCase() + ':' + stableHash(logicalKey);
  return {
    kind: 'LoreLearnedArtifact',
    artifactType: type,
    id: 'artifact:' + stableHash(sourceRevisionId + '|' + type + '|' + logicalKey),
    semanticId,
    logicalKey,
    sourceId,
    sourceRevisionId,
    payload: deepClone(payload),
    authorityClass,
    temporalClass,
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0,
    unresolved: Boolean(unresolved),
    freshness: 'CURRENT',
    provenance: makeProvenance({sourceId, sourceRevisionId, span, derivation, dependencies}),
  };
}

export function createStudyObligation({id, sourceId, sourceRevisionId, trigger, sequence}) {
  return {
    kind: 'LoreStudyObligation',
    id,
    sourceId,
    sourceRevisionId,
    trigger,
    sequence,
    state: StudyState.DUE,
    checkpoint: null,
    supersededBy: null,
    attempts: 0,
    runtimeSchedulingAuthority: false,
    physicalWorkerAuthority: false,
  };
}
