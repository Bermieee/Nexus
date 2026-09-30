const freeze = (value) => Object.freeze(value);
const clone = (value) => value == null ? value : structuredClone(value);
const requiredString = (value, name) => {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${name} must be a non-empty string`);
  return value;
};
const stringArray = (value, name) => {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) throw new TypeError(`${name} must be an array of strings`);
  return [...new Set(value)];
};
const confidence = (value, name) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 1) throw new TypeError(`${name} must be between 0 and 1`);
  return n;
};
const positiveRevision = (value, name) => {
  if (!Number.isInteger(value) || value < 1) throw new TypeError(`${name} must be a positive integer`);
  return value;
};
const json = (value, name) => {
  const next = clone(value);
  try { JSON.stringify(next); } catch { throw new TypeError(`${name} must be JSON-serializable`); }
  return next;
};

export const ObservationClass = freeze({
  OBSERVED: 'OBSERVED',
  INFERRED: 'INFERRED',
  UNRESOLVED: 'UNRESOLVED',
  UNKNOWN: 'UNKNOWN',
});

export const SceneLifecycle = freeze({ OPEN: 'OPEN', CLOSED: 'CLOSED', SUSPENDED: 'SUSPENDED' });
export const CastPresence = freeze({ PRESENT: 'PRESENT', DEPARTED: 'DEPARTED', OFFSCREEN_RELEVANT: 'OFFSCREEN_RELEVANT', UNCERTAIN: 'UNCERTAIN', MENTIONED_ONLY: 'MENTIONED_ONLY' });
export const ObjectPresence = freeze({ PRESENT: 'PRESENT', HELD: 'HELD', CARRIED: 'CARRIED', WORN: 'WORN', CONTAINED: 'CONTAINED', VISIBLE: 'VISIBLE', DEPARTED: 'DEPARTED', REMOVED: 'REMOVED', DAMAGED: 'DAMAGED', DESTROYED: 'DESTROYED', HIDDEN: 'HIDDEN', MENTIONED_ONLY: 'MENTIONED_ONLY', UNCERTAIN: 'UNCERTAIN' });
export const BoundaryStatus = freeze({ CANDIDATE: 'CANDIDATE', PENDING: 'PENDING', CONFIRMED: 'CONFIRMED', REJECTED: 'REJECTED', RECOVERED: 'RECOVERED' });
export const BoundaryType = freeze({ LOCATION: 'LOCATION', TIME_JUMP: 'TIME_JUMP', SLEEP_WAKE: 'SLEEP_WAKE', EXPLICIT_BREAK: 'EXPLICIT_BREAK', CAST_REPLACEMENT: 'CAST_REPLACEMENT', COMBAT: 'COMBAT', OBJECTIVE: 'OBJECTIVE', TRAVEL_COMPLETE: 'TRAVEL_COMPLETE', FLASHBACK: 'FLASHBACK', PARALLEL: 'PARALLEL', DISCONTINUITY: 'DISCONTINUITY', MIXED: 'MIXED' });
export const DeltaReason = freeze({ OBSERVATION: 'OBSERVATION', CORRECTION: 'CORRECTION', SOURCE_EDIT: 'SOURCE_EDIT', RECONCILIATION: 'RECONCILIATION', FULL_REFRESH: 'FULL_REFRESH' });
export const RefreshReason = freeze({ CONTRADICTORY_LOCATION: 'CONTRADICTORY_LOCATION', TEMPORAL_SEQUENCE_BROKEN: 'TEMPORAL_SEQUENCE_BROKEN', CAST_CHURN: 'CAST_CHURN', SOURCE_EDIT_FANOUT: 'SOURCE_EDIT_FANOUT', IMPOSSIBLE_TRANSITION: 'IMPOSSIBLE_TRANSITION', LOW_CONFIDENCE_CHAIN: 'LOW_CONFIDENCE_CHAIN' });

const oneOf = (value, object, name) => {
  if (!Object.values(object).includes(value)) throw new TypeError(`${name} has unsupported value: ${value}`);
  return value;
};

export function createEvidenceRef({ id, sourceRevisionId, sourcePosition = null, excerptHash = null, metadata = {} }) {
  return {
    id: requiredString(id, 'EvidenceRef.id'),
    sourceRevisionId: requiredString(sourceRevisionId, 'EvidenceRef.sourceRevisionId'),
    sourcePosition: sourcePosition == null ? null : json(sourcePosition, 'EvidenceRef.sourcePosition'),
    excerptHash: excerptHash == null ? null : requiredString(excerptHash, 'EvidenceRef.excerptHash'),
    metadata: json(metadata, 'EvidenceRef.metadata'),
  };
}

export function createFieldState({ value = null, confidence: cf = 0, evidenceRefs = [], observationClass = ObservationClass.UNKNOWN, revision = 1, provenance = [], metadata = {} }) {
  const refs = stringArray(evidenceRefs, 'FieldState.evidenceRefs');
  if (observationClass !== ObservationClass.UNKNOWN && refs.length === 0) throw new TypeError('FieldState evidenceRefs are required for non-UNKNOWN state');
  return {
    value: json(value, 'FieldState.value'),
    confidence: confidence(cf, 'FieldState.confidence'),
    evidenceRefs: refs,
    observationClass: oneOf(observationClass, ObservationClass, 'FieldState.observationClass'),
    revision: positiveRevision(revision, 'FieldState.revision'),
    provenance: stringArray(provenance, 'FieldState.provenance'),
    metadata: json(metadata, 'FieldState.metadata'),
  };
}

export function unknownField(revision = 1) {
  return createFieldState({ value: null, confidence: 0, evidenceRefs: [], observationClass: ObservationClass.UNKNOWN, revision });
}

export function createSceneObservationProposal({
  proposalId,
  sceneId,
  baseRevision,
  sourceRevisionRefs = [],
  evidenceRefs = [],
  fields = {},
  reason = DeltaReason.OBSERVATION,
  provider = null,
  createdAt = Date.now(),
}) {
  positiveRevision(baseRevision, 'SceneObservationProposal.baseRevision');
  const normalizedFields = {};
  for (const [key, value] of Object.entries(fields)) normalizedFields[key] = createFieldState({ ...value, revision: value.revision ?? (baseRevision + 1) });
  return {
    kind: 'SceneObservationProposal',
    proposalId: requiredString(proposalId, 'SceneObservationProposal.proposalId'),
    sceneId: requiredString(sceneId, 'SceneObservationProposal.sceneId'),
    baseRevision,
    sourceRevisionRefs: stringArray(sourceRevisionRefs, 'SceneObservationProposal.sourceRevisionRefs'),
    evidenceRefs: stringArray(evidenceRefs, 'SceneObservationProposal.evidenceRefs'),
    fields: normalizedFields,
    reason: oneOf(reason, DeltaReason, 'SceneObservationProposal.reason'),
    provider: provider == null ? null : requiredString(provider, 'SceneObservationProposal.provider'),
    createdAt: Number(createdAt),
  };
}

export function createSceneDelta({ sceneId, fromRevision, toRevision, changedFields = {}, evidenceRefs = [], confidence: cf = 1, reason = DeltaReason.OBSERVATION, fullRefreshRequired = false, refreshReasons = [], createdAt = Date.now() }) {
  positiveRevision(fromRevision, 'SceneDelta.fromRevision');
  positiveRevision(toRevision, 'SceneDelta.toRevision');
  if (toRevision !== fromRevision + 1) throw new TypeError('SceneDelta.toRevision must advance exactly one revision');
  const changes = {};
  for (const [key, value] of Object.entries(changedFields)) changes[key] = json(value, `SceneDelta.changedFields.${key}`);
  return {
    kind: 'SceneDelta', sceneId: requiredString(sceneId, 'SceneDelta.sceneId'), fromRevision, toRevision,
    changedFields: changes, evidenceRefs: stringArray(evidenceRefs, 'SceneDelta.evidenceRefs'), confidence: confidence(cf, 'SceneDelta.confidence'),
    reason: oneOf(reason, DeltaReason, 'SceneDelta.reason'), fullRefreshRequired: Boolean(fullRefreshRequired),
    refreshReasons: refreshReasons.map((item) => oneOf(item, RefreshReason, 'SceneDelta.refreshReason')), createdAt: Number(createdAt),
  };
}

export function createBoundaryCandidate({ candidateId, sceneId, signals = [], evidenceRefs = [], confidence: cf = 0, proposedBoundaryType = BoundaryType.MIXED, sourcePosition = null, explicitTransition = false, createdAt = Date.now() }) {
  return {
    kind: 'SceneBoundaryCandidate', candidateId: requiredString(candidateId, 'SceneBoundaryCandidate.candidateId'), sceneId: requiredString(sceneId, 'SceneBoundaryCandidate.sceneId'),
    signals: signals.map((signal) => json(signal, 'SceneBoundaryCandidate.signal')), evidenceRefs: stringArray(evidenceRefs, 'SceneBoundaryCandidate.evidenceRefs'),
    confidence: confidence(cf, 'SceneBoundaryCandidate.confidence'), proposedBoundaryType: oneOf(proposedBoundaryType, BoundaryType, 'SceneBoundaryCandidate.proposedBoundaryType'),
    sourcePosition: sourcePosition == null ? null : json(sourcePosition, 'SceneBoundaryCandidate.sourcePosition'), explicitTransition: Boolean(explicitTransition),
    status: BoundaryStatus.CANDIDATE, createdAt: Number(createdAt),
  };
}

export function createSceneSnapshot({
  sceneId,
  revision = 1,
  lifecycle = SceneLifecycle.OPEN,
  sourceRange = { start: null, end: null },
  sourceRevisionRefs = [],
  fields = {},
  fieldEvidence = {},
  unresolvedFields = [],
  provenance = [],
  createdAt = Date.now(),
  updatedAt = createdAt,
}) {
  const base = {
    location: unknownField(revision), narrativeTime: unknownField(revision), activeCast: unknownField(revision), immediateObjects: unknownField(revision),
    activeRelationships: unknownField(revision), activeThreads: unknownField(revision), activeObjectives: unknownField(revision), atmosphere: unknownField(revision), boundaryState: unknownField(revision),
  };
  for (const [key, value] of Object.entries(fields)) base[key] = createFieldState({ ...value, revision: value.revision ?? revision });
  return {
    kind: 'CurrentScene', sceneId: requiredString(sceneId, 'CurrentScene.sceneId'), revision: positiveRevision(revision, 'CurrentScene.revision'), lifecycle: oneOf(lifecycle, SceneLifecycle, 'CurrentScene.lifecycle'),
    sourceRange: json(sourceRange, 'CurrentScene.sourceRange'), sourceRevisionRefs: stringArray(sourceRevisionRefs, 'CurrentScene.sourceRevisionRefs'),
    fields: base, fieldEvidence: json(fieldEvidence, 'CurrentScene.fieldEvidence'), unresolvedFields: stringArray(unresolvedFields, 'CurrentScene.unresolvedFields'),
    provenance: stringArray(provenance, 'CurrentScene.provenance'), createdAt: Number(createdAt), updatedAt: Number(updatedAt),
  };
}

export function assertObservationDoesNotEscalate(fieldState) {
  if (!fieldState || typeof fieldState !== 'object') throw new TypeError('fieldState is required');
  if (!Object.values(ObservationClass).includes(fieldState.observationClass)) throw new TypeError('unsupported observation class');
  return true;
}
