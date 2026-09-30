import {
  ArtifactType,
  AuthorityClass,
  RetrievalForm,
  TemporalClass,
  boundedUnique,
  deepClone,
  makeArtifact,
  slug,
  stableHash,
  stableStringify,
} from './lore-contracts.js';
import {
  TEMPORAL_RULES_REVISION,
  analyzeClause,
  isUnresolvedAttribution,
  normalizedProperty,
  parseAttribution,
  readSourceTime,
} from './lore-temporal-rules.js';

// Study engine revision: a learned revision made by an older engine is re-studied (see LoreStudyRuntime).
// v3: work is sliced and resumed instead of capped; every sentence of a source is studied (coverage receipt).
export const STUDY_ENGINE_REVISION = 'lore-study-engine-v3+' + TEMPORAL_RULES_REVISION;

export const STUDY_UNITS = Object.freeze([
  'STRUCTURE_CONTEXT',
  'ENTITY_ALIAS',
  'CLAIM_RELATIONSHIP',
  'TEMPORAL_ONTOLOGY',
  'RETRIEVAL',
  'COMPILE',
  'VALIDATE',
]);

// Work per step, not knowledge per source (cap ledger rows 1-5): a unit processes at most this much and repeats, with a
// cursor in the session, until the whole source is covered. The Runtime checkpoints between steps and fences each one on
// the source revision; publication stays atomic at the end (LoreStudyRuntime.run).
export const STUDY_SLICE_LIMITS = Object.freeze({
  sentencesPerSlice: 96,
  chunksPerSlice: 24,
  entitiesPerSlice: 96,
  claimRowsPerSlice: 192,
  relationshipRowsPerSlice: 128,
});
// Physical sanity bound: the number of retrieval form types is small by construction; exceeding it fails the study.
const MAX_RETRIEVAL_FORMS = 32;
// Transient per-step index of artifact ids (the session is cloned between steps, so it is rebuilt once per step).
const artifactIdIndex = new WeakMap();
function artifactIds(workspace) {
  let ids = artifactIdIndex.get(workspace);
  if (!ids || ids.size !== workspace.artifacts.length) {
    ids = new Set(workspace.artifacts.map((row) => row.id));
    artifactIdIndex.set(workspace, ids);
  }
  return ids;
}

function cleanName(value) {
  return String(value || '').trim().replace(/^[\s"'“”‘’]+|[\s"'“”‘’.,!?;:]+$/g, '').replace(/^the\s+/i, '');
}

function splitSentences(content) {
  return String(content || '')
    .split(/(?<=[.!?])\s+|\n+/)
    .map((text) => text.trim())
    .filter(Boolean);
}

function spanFor(sentence, sentenceIndex) {
  return {sentenceIndex, textHash: stableHash(sentence), length: sentence.length};
}

function inferEntityType(name) {
  const value = String(name);
  if (/\b(tavern|inn|house|hall|tower|city|kingdom|forest|temple|shrine|forge|shop|market)\b/i.test(value)) return 'LOCATION';
  if (/\b(blade|sword|dagger|spear|shield|ring|amulet|book|key|orb|staff)\b/i.test(value)) return 'OBJECT';
  if (/\b(guild|familia|order|company|clan|faction|council)\b/i.test(value)) return 'ORGANIZATION';
  if (/\b(fire|war|incident|festival|battle)\b/i.test(value)) return 'EVENT';
  return 'PERSON';
}

function temporalFor(sentence) {
  if (/\b(unclear|unknown|rumou?r|report(?:s|ed)?|claims?|may|might|possibly|perhaps|either)\b/i.test(sentence)) return TemporalClass.UNCERTAIN;
  if (/\b(formerly|once|used to|previously|before|had|was|were|carried)\b/i.test(sentence)) return TemporalClass.HISTORICAL;
  if (/\b(later|after|then|subsequently)\b/i.test(sentence)) return TemporalClass.SEQUENCE;
  if (/\b(currently|now|today|remains|is|owns|knows|carries)\b/i.test(sentence)) return TemporalClass.CURRENT;
  return TemporalClass.TIMELESS;
}

function authorityFor(sentence) {
  return /\b(unclear|unknown|rumou?r|report(?:s|ed)?|claims?|may|might|possibly|perhaps|either)\b/i.test(sentence)
    ? AuthorityClass.UNRESOLVED
    : AuthorityClass.SOURCE_CANON;
}

function confidenceFor(sentence) {
  if (/\b(rumou?r|possibly|perhaps|might|may)\b/i.test(sentence)) return 0.45;
  if (/\b(report(?:s|ed)?|claims?|witness)\b/i.test(sentence)) return 0.6;
  return 1;
}

function normalizedTokens(text) {
  return boundedUnique(
    String(text || '').toLowerCase().match(/[a-z0-9][a-z0-9'-]{1,}/g) || [],
    96,
  );
}

function createWorkspace(source, revision) {
  return {
    source: deepClone(source),
    revision: deepClone(revision),
    sentences: splitSentences(revision.exactContent || ''),
    artifacts: [],
    entities: {},
    aliasRows: [],
    claimRows: [],
    relationshipRows: [],
    conceptRows: [],
    warnings: [],
    unitReceipts: [],
    validation: null,
    // Coverage receipt: how much of the source each sliced unit has processed (validated before publication).
    coverage: {sentenceCount: 0, sentencesChunked: 0, sentencesAnalyzed: 0, entitiesFinalized: 0, claimRowsFinalized: 0, relationshipRowsFinalized: 0},
    // The registry keeps unknown metadata keys (at, claimAt, timeline, timeUnit) under `extra`.
    time: readSourceTime({...(revision.metadata?.extra || {}), ...(revision.metadata || {})}, {lorebookId: source.lorebookId}),
  };
}

function addArtifact(workspace, artifact) {
  const ids = artifactIds(workspace);
  if (!ids.has(artifact.id)) { workspace.artifacts.push(artifact); ids.add(artifact.id); }
  return artifact;
}

function ensureEntity(workspace, rawName, type = null, sentenceIndex = null) {
  const name = cleanName(rawName);
  if (!name) return null;
  const entityId = 'entity:' + slug(name);
  const existing = workspace.entities[entityId];
  const entityType = type || existing?.entityType || inferEntityType(name);
  const aliases = boundedUnique([...(existing?.aliases || []), name], 16);
  workspace.entities[entityId] = {
    entityId,
    canonicalName: existing?.canonicalName || name,
    entityType,
    aliases,
    evidenceSentenceIndexes: boundedUnique([...(existing?.evidenceSentenceIndexes || []), sentenceIndex].filter(Number.isInteger), 32),
  };
  return entityId;
}

function recordAlias(workspace, entityId, rawAlias, sentenceIndex = null) {
  const alias = cleanName(rawAlias);
  const entity = workspace.entities[entityId];
  if (!entity || !alias) return;
  entity.aliases = boundedUnique([...(entity.aliases || []), alias], 16);
  const key = entityId + '|' + alias.toLowerCase();
  if (!workspace.aliasRows.some((row) => row.key === key)) {
    workspace.aliasRows.push({key, entityId, alias, sentenceIndex});
  }
}

function relationKey(subjectId, predicate, objectId) {
  return subjectId + '|' + predicate + '|' + objectId;
}

function claimKey(subjectId, predicate, value) {
  return subjectId + '|' + predicate + '|' + stableStringify(value);
}

function pushClaim(workspace, sentence, sentenceIndex, subjectId, predicate, value, extra = {}) {
  const temporalClass = extra.temporalClass || temporalFor(sentence);
  const authorityClass = extra.authorityClass || authorityFor(sentence);
  const unresolved = extra.unresolved ?? (authorityClass === AuthorityClass.UNRESOLVED || temporalClass === TemporalClass.UNCERTAIN);
  workspace.claimRows.push({
    logicalKey: claimKey(subjectId, predicate, value),
    subjectId,
    predicate,
    value,
    temporalClass,
    authorityClass,
    confidence: extra.confidence ?? confidenceFor(sentence),
    unresolved,
    sentenceIndex,
    qualifier: extra.qualifier || null,
    applicability: extra.applicability || null,
    attribution: extra.attribution || null,
    qualifierDetail: extra.qualifierDetail || null,
  });
}

function pushRelationship(workspace, sentence, sentenceIndex, subjectId, predicate, objectId, extra = {}) {
  const temporalClass = extra.temporalClass || temporalFor(sentence);
  const authorityClass = extra.authorityClass || authorityFor(sentence);
  workspace.relationshipRows.push({
    logicalKey: relationKey(subjectId, predicate, objectId),
    subjectId,
    predicate,
    objectId,
    temporalClass,
    authorityClass,
    confidence: extra.confidence ?? confidenceFor(sentence),
    unresolved: extra.unresolved ?? (authorityClass === AuthorityClass.UNRESOLVED),
    sentenceIndex,
  });
}

function pushConstraintArtifact(workspace, {
  artifactType,
  sentence,
  sentenceIndex,
  subjectId,
  predicate,
  value,
  ruleKind,
  modality = null,
}) {
  const normalizedValue = String(value || '').trim().replace(/[.!?]+$/g, '').trim();
  const logicalKey = [
    subjectId,
    String(predicate || '').toLowerCase(),
    String(modality || '').toLowerCase(),
    normalizedValue.toLowerCase(),
  ].join('|');
  addArtifact(workspace, makeArtifact({
    type: artifactType,
    sourceId: workspace.source.sourceId,
    sourceRevisionId: workspace.revision.id,
    logicalKey,
    payload: {
      subjectId,
      predicate,
      value: normalizedValue,
      modality,
      ruleKind,
      evidenceBacked: true,
      sourceMutationAuthority: false,
      truthAuthority: false,
    },
    span: spanFor(sentence, sentenceIndex),
    derivation: ruleKind === 'SENSORY_ANCHOR' ? 'EXPLICIT_SENSORY_ANCHOR' : 'EXPLICIT_SOURCE_CONSTRAINT',
    dependencies: [],
    authorityClass: AuthorityClass.DERIVED,
    temporalClass: TemporalClass.TIMELESS,
    confidence: 1,
    unresolved: false,
  }));
}

function analyzeSentence(workspace, sentence, index) {
  let match;
  const s = sentence.replace(/\s+/g, ' ').trim();

  if ((match = s.match(/^(.+?)\s+must\s+(never|not|always)\s+(.+?)[.!?]?$/i))) {
    const subjectId = ensureEntity(workspace, match[1], 'PERSON', index);
    const modality = String(match[2]).toUpperCase();
    pushConstraintArtifact(workspace, {
      artifactType: modality === 'ALWAYS' ? ArtifactType.RULE : ArtifactType.RESTRICTION,
      sentence: s,
      sentenceIndex: index,
      subjectId,
      predicate: 'must',
      value: match[3],
      ruleKind: 'BEHAVIORAL_CONSTRAINT',
      modality,
    });
    return;
  }

  if ((match = s.match(/^(.+?)\s+(can|cannot|can't)\s+(.+?)[.!?]?$/i))) {
    const subjectId = ensureEntity(workspace, match[1], 'PERSON', index);
    const modality = /^can$/i.test(match[2]) ? 'CAN' : 'CANNOT';
    pushConstraintArtifact(workspace, {
      artifactType: modality === 'CAN' ? ArtifactType.CAPABILITY : ArtifactType.RESTRICTION,
      sentence: s,
      sentenceIndex: index,
      subjectId,
      predicate: 'capability',
      value: match[3],
      ruleKind: modality === 'CAN' ? 'CAPABILITY' : 'BEHAVIORAL_CONSTRAINT',
      modality,
    });
    return;
  }

  if ((match = s.match(/^(.+?)\s+always\s+(.+?)[.!?]?$/i))) {
    const subjectId = ensureEntity(workspace, match[1], 'PERSON', index);
    pushConstraintArtifact(workspace, {
      artifactType: ArtifactType.RULE,
      sentence: s,
      sentenceIndex: index,
      subjectId,
      predicate: 'always',
      value: match[2],
      ruleKind: 'BEHAVIORAL_ANCHOR',
      modality: 'ALWAYS',
    });
    return;
  }

  if ((match = s.match(/^(.+?)\s+(smells|sounds|looks|feels|tastes)\s+(?:of\s+|like\s+)?(.+?)[.!?]?$/i))) {
    const subjectId = ensureEntity(workspace, match[1], null, index);
    pushConstraintArtifact(workspace, {
      artifactType: ArtifactType.PROPERTY,
      sentence: s,
      sentenceIndex: index,
      subjectId,
      predicate: 'sensory:' + String(match[2]).toLowerCase(),
      value: match[3],
      ruleKind: 'SENSORY_ANCHOR',
      modality: null,
    });
    return;
  }

  if ((match = s.match(/^(.+?),\s+also\s+(?:called|known as)\s+(.+?),\s+owns\s+(?:the\s+)?(.+?)[.!?]?$/i))) {
    const owner = ensureEntity(workspace, match[1], 'PERSON', index);
    const alias = cleanName(match[2]);
    const target = ensureEntity(workspace, match[3], null, index);
    recordAlias(workspace, owner, alias, index);
    pushClaim(workspace, s, index, target, 'owner', owner, {temporalClass: TemporalClass.CURRENT});
    pushRelationship(workspace, s, index, owner, 'owns', target, {temporalClass: TemporalClass.CURRENT});
    return;
  }

  if ((match = s.match(/^(.+?)\s+(?:is\s+)?also\s+(?:called|known as)\s+(.+?)[.!?]?$/i))) {
    const entity = ensureEntity(workspace, match[1], null, index);
    recordAlias(workspace, entity, match[2], index);
    return;
  }

  if ((match = s.match(/^(.+?)\s+formerly\s+owned\s+(?:the\s+)?(.+?)[.!?]?$/i))) {
    const owner = ensureEntity(workspace, match[1], 'PERSON', index);
    const target = ensureEntity(workspace, match[2], null, index);
    pushClaim(workspace, s, index, target, 'owner', owner, {temporalClass: TemporalClass.HISTORICAL});
    pushRelationship(workspace, s, index, owner, 'owns', target, {temporalClass: TemporalClass.HISTORICAL});
    return;
  }

  if ((match = s.match(/^(.+?)\s+owns\s+(?:the\s+)?(.+?)[.!?]?$/i))) {
    const owner = ensureEntity(workspace, match[1], 'PERSON', index);
    const target = ensureEntity(workspace, match[2], null, index);
    pushClaim(workspace, s, index, target, 'owner', owner, {temporalClass: TemporalClass.CURRENT});
    pushRelationship(workspace, s, index, owner, 'owns', target, {temporalClass: TemporalClass.CURRENT});
    return;
  }

  if ((match = s.match(/^(.+?)\s+knows\s+(.+?)[.!?]?$/i))) {
    const a = ensureEntity(workspace, match[1], 'PERSON', index);
    const b = ensureEntity(workspace, match[2], 'PERSON', index);
    pushClaim(workspace, s, index, a, 'knows', b, {temporalClass: TemporalClass.TIMELESS});
    pushRelationship(workspace, s, index, a, 'knows', b, {temporalClass: TemporalClass.TIMELESS});
    return;
  }

  if ((match = s.match(/^(.+?)\s+(?:carried|carries)\s+(?:the\s+)?(.+?)[.!?]?$/i))) {
    const actor = ensureEntity(workspace, match[1], 'PERSON', index);
    const object = ensureEntity(workspace, match[2], 'OBJECT', index);
    const temporalClass = /\bcarried\b/i.test(s) ? TemporalClass.HISTORICAL : TemporalClass.CURRENT;
    pushClaim(workspace, s, index, object, 'possessor', actor, {temporalClass});
    pushRelationship(workspace, s, index, actor, 'carried', object, {temporalClass});
    return;
  }

  if ((match = s.match(/^(.+?)\s+(?:later\s+)?left\s+(?:the\s+)?(.+?)\s+at\s+(?:the\s+)?(.+?)[.!?]?$/i))) {
    const actor = ensureEntity(workspace, match[1], 'PERSON', index);
    const object = ensureEntity(workspace, match[2], 'OBJECT', index);
    const location = ensureEntity(workspace, match[3], 'LOCATION', index);
    pushClaim(workspace, s, index, object, 'location', location, {temporalClass: TemporalClass.SEQUENCE});
    pushRelationship(workspace, s, index, actor, 'leftAt', object, {temporalClass: TemporalClass.HISTORICAL});
    pushRelationship(workspace, s, index, object, 'locatedAt', location, {temporalClass: TemporalClass.SEQUENCE});
    return;
  }

  if ((match = s.match(/^(?:The\s+)?(.+?)\s+(?:later\s+)?(?:burned|burned down|was destroyed in (?:the\s+)?fire)[.!?]?$/i))) {
    const entity = ensureEntity(workspace, match[1], null, index);
    pushClaim(workspace, s, index, entity, 'state', 'destroyed', {temporalClass: TemporalClass.CURRENT, applicability: {kind: 'AS_OF'}});
    return;
  }

  if ((match = s.match(/^(?:The\s+)?(.+?)\s+was\s+destroyed\s+in\s+(?:the\s+)?((.+?)\s+fire)[.!?]?$/i))) {
    const object = ensureEntity(workspace, match[1], 'OBJECT', index);
    const place = ensureEntity(workspace, match[3], 'LOCATION', index);
    pushClaim(workspace, s, index, object, 'fate', 'destroyed-in-fire', {temporalClass: TemporalClass.HISTORICAL, applicability: {kind: 'FROM_EVENT', event: slug(match[2]), relation: 'in'}});
    pushRelationship(workspace, s, index, object, 'destroyedAt', place, {temporalClass: TemporalClass.HISTORICAL});
    return;
  }

  if ((match = s.match(/^(?:The\s+)?(.+?),?\s+(?:(?:is|was)\s+)?also\s+(?:called|known as)\s+(?:the\s+)?(.+?)[.!?]?$/i))) {
    // Alias evidence ("X, also called Y"): both names belong to one entity. This is the only evidence that lets two
    // differently worded names (of a person, place or event) be treated as the same identity.
    const canonicalId = ensureEntity(workspace, match[1], null, index);
    const alias = cleanName(match[2]);
    if (canonicalId && alias && slug(alias) !== slug(match[1])) {
      workspace.entities[canonicalId].aliases = boundedUnique([...workspace.entities[canonicalId].aliases, alias], 16);
      return;
    }
  }

  {
    // Attribution (R1) and event/state clauses. The attributed clause goes through the same structured clause grammar as a
    // plain sentence; a sentence whose clause is not understood falls through (no claim is invented).
    const attributed = parseAttribution(s);
    const spec = analyzeClause(attributed ? attributed.clause : s);
    if (spec) {
      const isFate = spec.predicate === 'fate';
      const subjectId = ensureEntity(workspace, spec.subject, isFate ? 'OBJECT' : null, index);
      if (subjectId) {
        // A modal clause ('may have been') with no explicit speaker is the source speculating; with a speaker it stays that
        // speaker's mode and records the modality.
        const speaking = attributed ?? (spec.modal ? {mode: 'SPECULATION', speaker: null, marker: 'modal'} : null);
        const attribution = speaking ? {
          mode: speaking.mode,
          speaker: speaking.speaker,
          marker: speaking.marker,
          modal: Boolean(spec.modal),
          reportedBy: workspace.source.sourceId,
          claimAt: workspace.time.claimAt,
        } : null;
        const reported = isUnresolvedAttribution(attribution);
        pushClaim(workspace, s, index, subjectId, spec.predicate, spec.value, {
          temporalClass: reported ? TemporalClass.UNCERTAIN : (spec.applicability.kind === 'FROM_EVENT' ? TemporalClass.HISTORICAL : TemporalClass.CURRENT),
          authorityClass: reported ? AuthorityClass.UNRESOLVED : AuthorityClass.SOURCE_CANON,
          confidence: attribution?.mode === 'SPECULATION' ? 0.45 : reported ? 0.6 : 1,
          unresolved: reported,
          qualifier: attribution ? 'attributed:' + attribution.mode.toLowerCase() : null,
          qualifierDetail: spec.qualifier,
          applicability: reported && spec.applicability.kind === 'AS_OF' ? {kind: 'UNKNOWN'} : spec.applicability,
          attribution,
        });
        return;
      }
    }
  }

  if ((match = s.match(/^(?:The\s+)?(.+?)\s+is\s+(?:an?\s+)?(.+?)[.!?]?$/i))) {
    if (/^(her|his|their|its|our|my|your)\b/i.test(match[1])) {
      workspace.warnings.push({
        kind: 'UnresolvedSourceFragment',
        sentenceIndex: index,
        textHash: stableHash(s),
        status: 'PRONOUN_CONTEXT_REQUIRES_GROUNDED_CONTEXTUALIZATION',
      });
      return;
    }
    const subject = ensureEntity(workspace, match[1], null, index);
    const value = cleanName(match[2]).toLowerCase();
    if (['destroyed', 'damaged', 'intact', 'lost', 'missing'].includes(value)) {
      pushClaim(workspace, s, index, subject, 'state', value, {temporalClass: TemporalClass.CURRENT, applicability: {kind: 'AS_OF'}});
    } else {
      pushClaim(workspace, s, index, subject, 'type', value, {temporalClass: TemporalClass.TIMELESS});
    }
    return;
  }

  const candidates = s.match(/\b[A-Z][A-Za-z'’-]*(?:\s+[A-Z][A-Za-z'’-]*){0,3}\b/g) || [];
  const leadingNoise = /^(The|A|An|Later|Before|After|Because|Except|Around|During|When|While|Although|However|Her|His|Their|Its|Our|My|Your|Blue|Silver|Gold|Golden|Black|White|Red)\b/i;
  for (const candidate of candidates) {
    if (leadingNoise.test(candidate)) {
      const remainder = candidate.replace(leadingNoise, '').trim();
      if (remainder && /^[A-Z]/.test(remainder)) ensureEntity(workspace, remainder, null, index);
      continue;
    }
    ensureEntity(workspace, candidate, null, index);
  }
  workspace.warnings.push({
    kind: 'UnresolvedSourceFragment',
    sentenceIndex: index,
    textHash: stableHash(s),
    status: 'INSUFFICIENT_STRUCTURED_EVIDENCE',
  });
}

function finalizeEntities(workspace, offset, limit) {
  const rows = Object.values(workspace.entities).slice(offset, offset + limit);
  for (const row of rows) {
    const seen = new Set();
    const allAliases = [row.canonicalName, ...(row.aliases || []), ...workspace.aliasRows
      .filter((aliasRow) => aliasRow.entityId === row.entityId)
      .map((aliasRow) => aliasRow.alias)]
      .filter((alias) => {
        const key = String(alias || '').toLowerCase();
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    const primaryAliases = boundedUnique(allAliases, 16);
    const explicitAliases = allAliases.filter((alias) => String(alias).toLowerCase() !== String(row.canonicalName).toLowerCase());
    const artifact = makeArtifact({
      type: ArtifactType.ENTITY,
      sourceId: workspace.source.sourceId,
      sourceRevisionId: workspace.revision.id,
      logicalKey: row.entityId,
      payload: {
        entityId: row.entityId,
        canonicalName: row.canonicalName,
        entityType: row.entityType,
        aliases: primaryAliases,
        aliasCoverage: {
          total: allAliases.length,
          retainedInline: primaryAliases.length,
          legacyAliasArtifacts: Math.min(7, explicitAliases.length),
          continuationPages: Math.max(0, Math.ceil(Math.max(0, explicitAliases.length - 7) / 7)),
          complete: true,
        },
      },
      derivation: 'ENTITY_EXTRACTION',
      dependencies: [],
      authorityClass: AuthorityClass.DERIVED,
      temporalClass: TemporalClass.TIMELESS,
    });
    addArtifact(workspace, artifact);

    for (const alias of explicitAliases.slice(0, 7)) {
      addArtifact(workspace, makeArtifact({
        type: ArtifactType.ALIAS,
        sourceId: workspace.source.sourceId,
        sourceRevisionId: workspace.revision.id,
        logicalKey: row.entityId + '|alias|' + alias.toLowerCase(),
        payload: {entityId: row.entityId, alias, certainty: 'SUPPORTED', continuation: false},
        derivation: 'ALIAS_EXTRACTION',
        dependencies: [artifact.id],
        authorityClass: AuthorityClass.DERIVED,
      }));
    }

    const overflow = explicitAliases.slice(7);
    for (let index = 0; index < overflow.length; index += 7) {
      const aliases = overflow.slice(index, index + 7);
      addArtifact(workspace, makeArtifact({
        type: ArtifactType.ALIAS,
        sourceId: workspace.source.sourceId,
        sourceRevisionId: workspace.revision.id,
        logicalKey: row.entityId + '|alias-page|' + (index / 7),
        payload: {
          entityId: row.entityId,
          aliases,
          certainty: 'SUPPORTED',
          continuation: true,
          pageIndex: index / 7,
          pageSize: 7,
          complete: index + aliases.length >= overflow.length,
        },
        derivation: 'ALIAS_EXTRACTION_CONTINUATION',
        dependencies: [artifact.id],
        authorityClass: AuthorityClass.DERIVED,
      }));
    }
  }
}

// R1/R2/R3/R4 evidence carried on the claim: normalized property, applicability, attribution and validated source time.
function temporalPayload(workspace, row) {
  const prop = normalizedProperty(row.predicate);
  const out = {
    property: prop.property,
    cardinality: prop.cardinality,
    applicability: row.applicability,
    attribution: row.attribution,
    sourceTime: {at: workspace.time.at, claimAt: workspace.time.claimAt, continuity: workspace.time.continuity, problems: workspace.time.problems},
  };
  if (row.qualifierDetail) out.qualifierDetail = row.qualifierDetail;
  return out;
}

// Claim rows [offset, offset+limit). A repeated logicalKey yields the same artifact id, so addArtifact keeps the first
// occurrence across slices exactly as a single pass did.
function finalizeClaimRows(workspace, offset, limit) {
  const seen = new Set();
  for (const row of workspace.claimRows.slice(offset, offset + limit)) {
    if (seen.has(row.logicalKey)) continue;
    seen.add(row.logicalKey);
    const artifact = makeArtifact({
      type: ArtifactType.CLAIM,
      sourceId: workspace.source.sourceId,
      sourceRevisionId: workspace.revision.id,
      logicalKey: row.logicalKey,
      payload: {
        claimId: 'claim:' + stableHash(row.logicalKey),
        subjectId: row.subjectId,
        predicate: row.predicate,
        value: row.value,
        qualifier: row.qualifier,
        ...temporalPayload(workspace, row),
      },
      span: spanFor(workspace.sentences[row.sentenceIndex] || '', row.sentenceIndex),
      derivation: 'ATOMIC_CLAIM_EXTRACTION',
      authorityClass: row.authorityClass,
      temporalClass: row.temporalClass,
      confidence: row.confidence,
      unresolved: row.unresolved,
    });
    addArtifact(workspace, artifact);
  }
}

// Relationship rows [offset, offset+limit); runs after every claim row is finalized.
function finalizeRelationshipRows(workspace, offset, limit) {
  const claimsBySentence = new Map();
  for (const artifact of workspace.artifacts) {
    if (artifact.artifactType !== ArtifactType.CLAIM) continue;
    const index = artifact.provenance.span?.sentenceIndex;
    const ids = claimsBySentence.get(index) || [];
    ids.push(artifact.id);
    claimsBySentence.set(index, ids);
  }
  const relationSeen = new Set();
  for (const row of workspace.relationshipRows.slice(offset, offset + limit)) {
    if (relationSeen.has(row.logicalKey)) continue;
    relationSeen.add(row.logicalKey);
    const supporting = [...(claimsBySentence.get(row.sentenceIndex) || [])];
    addArtifact(workspace, makeArtifact({
      type: ArtifactType.RELATIONSHIP,
      sourceId: workspace.source.sourceId,
      sourceRevisionId: workspace.revision.id,
      logicalKey: row.logicalKey,
      payload: {
        relationshipId: 'relationship:' + stableHash(row.logicalKey),
        subjectId: row.subjectId,
        predicate: row.predicate,
        objectId: row.objectId,
        supportingClaimIds: supporting,
        sourceAuthorityClass: row.authorityClass,
      },
      span: spanFor(workspace.sentences[row.sentenceIndex] || '', row.sentenceIndex),
      derivation: 'RELATIONSHIP_EXTRACTION',
      dependencies: supporting,
      authorityClass: row.authorityClass === AuthorityClass.UNRESOLVED ? AuthorityClass.UNRESOLVED : AuthorityClass.DERIVED,
      temporalClass: row.temporalClass,
      confidence: row.confidence,
      unresolved: row.unresolved,
    }));
  }
}

function deriveOntology(workspace) {
  const concepts = [];
  const entities = workspace.artifacts.filter((artifact) => artifact.artifactType === ArtifactType.ENTITY);
  const claims = workspace.artifacts.filter((artifact) => artifact.artifactType === ArtifactType.CLAIM);
  const relationships = workspace.artifacts.filter((artifact) => artifact.artifactType === ArtifactType.RELATIONSHIP);

  const addConcept = ({entityId, concept, parent, authority = AuthorityClass.DERIVED, evidence}) => {
    if (!entityId || !concept || !parent || !evidence) return;
    concepts.push({entityId, concept, parent, authority, evidence});
  };

  for (const entity of entities) {
    const type = slug(entity.payload.entityType || 'world-entity');
    addConcept({
      entityId: entity.payload.entityId,
      concept: 'entity-type:' + type,
      parent: 'entity-type',
      authority: AuthorityClass.DERIVED,
      evidence: entity.id,
    });
  }

  for (const claim of claims) {
    const predicate = slug(claim.payload.predicate || 'claim');
    addConcept({
      entityId: claim.payload.subjectId,
      concept: 'claim-subject:' + predicate,
      parent: 'claim-role',
      authority: claim.unresolved ? AuthorityClass.UNRESOLVED : AuthorityClass.INFERRED,
      evidence: claim.id,
    });
    if (typeof claim.payload.value === 'string' && claim.payload.value.startsWith('entity:')) {
      addConcept({
        entityId: claim.payload.value,
        concept: 'claim-object:' + predicate,
        parent: 'claim-role',
        authority: claim.unresolved ? AuthorityClass.UNRESOLVED : AuthorityClass.INFERRED,
        evidence: claim.id,
      });
    }
  }

  for (const relationship of relationships) {
    const predicate = slug(relationship.payload.predicate || 'relationship');
    addConcept({
      entityId: relationship.payload.subjectId,
      concept: 'relation-subject:' + predicate,
      parent: 'relationship-role',
      authority: relationship.unresolved ? AuthorityClass.UNRESOLVED : AuthorityClass.INFERRED,
      evidence: relationship.id,
    });
    addConcept({
      entityId: relationship.payload.objectId,
      concept: 'relation-object:' + predicate,
      parent: 'relationship-role',
      authority: relationship.unresolved ? AuthorityClass.UNRESOLVED : AuthorityClass.INFERRED,
      evidence: relationship.id,
    });
  }

  const seen = new Set();
  for (const row of concepts) {
    const key = row.entityId + '|' + row.concept + '|' + row.parent;
    if (seen.has(key)) continue;
    seen.add(key);
    addArtifact(workspace, makeArtifact({
      type: ArtifactType.CONCEPT,
      sourceId: workspace.source.sourceId,
      sourceRevisionId: workspace.revision.id,
      logicalKey: key,
      payload: {
        entityId: row.entityId,
        concept: row.concept,
        parentConcept: row.parent,
        membership: 'EVIDENCE_DERIVED',
        learnedFromWorldLore: true,
      },
      derivation: 'ONTOLOGY_EVIDENCE_LEARNING',
      dependencies: [row.evidence],
      authorityClass: row.authority,
      temporalClass: TemporalClass.TIMELESS,
      unresolved: row.authority === AuthorityClass.UNRESOLVED,
    }));
  }

  const groups = new Map();
  for (const concept of workspace.artifacts.filter((artifact) => artifact.artifactType === ArtifactType.CONCEPT)) {
    const key = concept.payload.concept;
    const ids = groups.get(key) || [];
    ids.push(concept.payload.entityId);
    groups.set(key, ids);
  }
  for (const [conceptKey, entityIds] of groups.entries()) {
    const uniqueIds = boundedUnique(entityIds, Infinity);
    addArtifact(workspace, makeArtifact({
      type: ArtifactType.COMMUNITY,
      sourceId: workspace.source.sourceId,
      sourceRevisionId: workspace.revision.id,
      logicalKey: 'community|' + conceptKey,
      payload: {
        communityId: 'community:' + slug(conceptKey),
        label: conceptKey,
        entityIds: uniqueIds,
        learnedFromWorldLore: true,
      },
      derivation: 'ONTOLOGY_EVIDENCE_COMMUNITY',
      dependencies: workspace.artifacts
        .filter((artifact) => artifact.artifactType === ArtifactType.CONCEPT && artifact.payload.concept === conceptKey)
        .map((artifact) => artifact.id),
      authorityClass: AuthorityClass.DERIVED,
    }));
  }
}

function retrievalArtifacts(workspace) {
  const title = workspace.revision.metadata?.title || workspace.source.uid;
  const entityNames = Object.values(workspace.entities).map((row) => row.canonicalName);
  const aliases = Object.values(workspace.entities).flatMap((row) => row.aliases);
  const claimTokens = workspace.artifacts
    .filter((artifact) => artifact.artifactType === ArtifactType.CLAIM)
    .flatMap((artifact) => [artifact.payload.subjectId, artifact.payload.predicate, String(artifact.payload.value)]);
  const sparseTerms = boundedUnique(normalizedTokens([title, ...entityNames, ...aliases, ...claimTokens, workspace.revision.exactContent].join(' ')), 96);
  const contextPrefix = [
    'Lorebook=' + workspace.source.lorebookId,
    'UID=' + workspace.source.uid,
    'Title=' + String(title),
    workspace.revision.metadata?.treePath?.length ? 'Path=' + workspace.revision.metadata.treePath.join(' > ') : null,
    entityNames.length ? 'Entities=' + entityNames.join(', ') : null,
  ].filter(Boolean).join(' | ');

  const forms = [
    {
      form: RetrievalForm.CONTEXTUAL_SPARSE,
      payload: {form: RetrievalForm.CONTEXTUAL_SPARSE, terms: sparseTerms, context: contextPrefix},
    },
    {
      form: RetrievalForm.DENSE_READY,
      payload: {
        form: RetrievalForm.DENSE_READY,
        text: contextPrefix + '\n' + workspace.revision.exactContent,
        embedding: null,
        embeddingAuthority: false,
      },
    },
    {
      form: RetrievalForm.PRECISION_READY,
      payload: {
        form: RetrievalForm.PRECISION_READY,
        tokenTerms: sparseTerms,
        entityIds: Object.keys(workspace.entities).sort(),
        claimSemanticIds: workspace.artifacts.filter((artifact) => artifact.artifactType === ArtifactType.CLAIM).map((artifact) => artifact.semanticId).sort(),
        scoreAuthority: false,
      },
    },
  ];

  if (forms.length > MAX_RETRIEVAL_FORMS) {
    const error = new Error('Lore study produced ' + forms.length + ' retrieval forms; the bound is ' + MAX_RETRIEVAL_FORMS);
    error.code = 'LORE_RETRIEVAL_FORM_BOUND_EXCEEDED';
    throw error;
  }
  for (const row of forms) {
    addArtifact(workspace, makeArtifact({
      type: ArtifactType.RETRIEVAL,
      sourceId: workspace.source.sourceId,
      sourceRevisionId: workspace.revision.id,
      logicalKey: 'retrieval|' + row.form,
      payload: row.payload,
      derivation: 'RETRIEVAL_REPRESENTATION',
      dependencies: workspace.artifacts.filter((artifact) => [ArtifactType.ENTITY, ArtifactType.CLAIM, ArtifactType.RELATIONSHIP].includes(artifact.artifactType)).map((artifact) => artifact.id),
      authorityClass: AuthorityClass.DERIVED,
    }));
  }
}

function compileArtifact(workspace) {
  const claims = workspace.artifacts.filter((artifact) => artifact.artifactType === ArtifactType.CLAIM);
  const relationships = workspace.artifacts.filter((artifact) => artifact.artifactType === ArtifactType.RELATIONSHIP);
  const concepts = workspace.artifacts.filter((artifact) => artifact.artifactType === ArtifactType.CONCEPT);
  const compact = {
    sourceRef: workspace.revision.id,
    entities: Object.values(workspace.entities).map((row) => [row.entityId, row.entityType]).sort(),
    claims: claims.map((row) => [row.payload.subjectId, row.payload.predicate, row.payload.value, row.temporalClass, row.unresolved]).sort((a, b) => stableStringify(a).localeCompare(stableStringify(b))),
    relationships: relationships.map((row) => [row.payload.subjectId, row.payload.predicate, row.payload.objectId, row.temporalClass]).sort((a, b) => stableStringify(a).localeCompare(stableStringify(b))),
    concepts: concepts.map((row) => [row.payload.entityId, row.payload.concept, row.payload.parentConcept]).sort((a, b) => stableStringify(a).localeCompare(stableStringify(b))),
    unresolvedCount: claims.filter((row) => row.unresolved).length,
  };
  addArtifact(workspace, makeArtifact({
    type: ArtifactType.COMPACT,
    sourceId: workspace.source.sourceId,
    sourceRevisionId: workspace.revision.id,
    logicalKey: 'compact|' + workspace.source.sourceId,
    payload: {
      form: RetrievalForm.COMPACT_LEARNED,
      representation: compact,
    },
    derivation: 'COMPILED_LEARNED_REPRESENTATION',
    dependencies: [...claims, ...relationships, ...concepts].map((artifact) => artifact.id),
    authorityClass: AuthorityClass.DERIVED,
  }));
}

export function semanticDiff(previousArtifacts, nextArtifacts) {
  const before = new Map((previousArtifacts || []).map((row) => [row.semanticId, row]));
  const after = new Map((nextArtifacts || []).map((row) => [row.semanticId, row]));
  const added = [...after.keys()].filter((key) => !before.has(key)).sort();
  const removed = [...before.keys()].filter((key) => !after.has(key)).sort();
  const preserved = [...after.keys()].filter((key) => before.has(key)).sort();

  const claimSlot = (artifact) => artifact.artifactType === ArtifactType.CLAIM
    ? artifact.payload.subjectId + '|' + artifact.payload.predicate
    : null;
  const beforeSlots = new Map();
  const afterSlots = new Map();
  for (const artifact of before.values()) {
    const key = claimSlot(artifact);
    if (key) beforeSlots.set(key, artifact);
  }
  for (const artifact of after.values()) {
    const key = claimSlot(artifact);
    if (key) afterSlots.set(key, artifact);
  }
  const changed = [];
  for (const [slot, oldArtifact] of beforeSlots.entries()) {
    const nextArtifact = afterSlots.get(slot);
    if (!nextArtifact) continue;
    const valueChanged = stableStringify(oldArtifact.payload.value) !== stableStringify(nextArtifact.payload.value);
    const temporalChanged = oldArtifact.temporalClass !== nextArtifact.temporalClass;
    const authorityChanged = oldArtifact.authorityClass !== nextArtifact.authorityClass || oldArtifact.unresolved !== nextArtifact.unresolved;
    if (valueChanged || temporalChanged || authorityChanged) {
      changed.push({
        slot,
        from: deepClone(oldArtifact.payload.value),
        to: deepClone(nextArtifact.payload.value),
        oldSemanticId: oldArtifact.semanticId,
        newSemanticId: nextArtifact.semanticId,
        valueChanged,
        temporalChanged,
        authorityChanged,
        oldTemporalClass: oldArtifact.temporalClass,
        newTemporalClass: nextArtifact.temporalClass,
      });
    }
  }
  const typeCounts = (ids, map) => {
    const counts = {};
    for (const id of ids) {
      const artifact = map.get(id);
      const type = artifact?.artifactType || 'UNKNOWN';
      counts[type] = (counts[type] || 0) + 1;
    }
    return counts;
  };
  return {
    kind: 'LoreSemanticDiff',
    addedSemanticIds: added,
    removedSemanticIds: removed,
    preservedSemanticIds: preserved,
    changed,
    addedByType: typeCounts(added, after),
    removedByType: typeCounts(removed, before),
    temporalMeaningChanged: changed.some((row) => row.temporalChanged),
    authorityMeaningChanged: changed.some((row) => row.authorityChanged),
    claimAdded: added.filter((id) => id.includes(':claim:')).length,
    claimRemoved: removed.filter((id) => id.includes(':claim:')).length,
    meaningChanged: added.length > 0 || removed.length > 0 || changed.length > 0,
    lineDiffAuthority: false,
  };
}

export class LoreStudyEngine {
  createSession({source, revision}) {
    if (!source || !revision) throw new TypeError('Source and revision are required');
    return {
      kind: 'LoreStudySession',
      id: 'study:' + stableHash(source.sourceId + '|' + revision.id),
      sourceId: source.sourceId,
      sourceRevisionId: revision.id,
      engineRevision: STUDY_ENGINE_REVISION,
      unitIndex: 0,
      units: [...STUDY_UNITS],
      // Position inside the current unit; a unit repeats (one bounded slice per step) until it reports done.
      cursor: {phase: null, offset: 0},
      workspace: (() => { const workspace = createWorkspace(source, revision); workspace.coverage.sentenceCount = workspace.sentences.length; return workspace; })(),
      complete: false,
      valid: null,
    };
  }

  step(session) {
    if (session.complete) return deepClone(session);
    const unit = session.units[session.unitIndex];
    const workspace = session.workspace;
    if (!unit) throw new Error('Study session has no remaining unit');

    const cursor = session.cursor || (session.cursor = {phase: null, offset: 0});
    const limits = STUDY_SLICE_LIMITS;
    let unitDone = true;
    let slice = null;
    if (unit === 'STRUCTURE_CONTEXT' && cursor.offset === 0) {
      addArtifact(workspace, makeArtifact({
        type: ArtifactType.STRUCTURE,
        sourceId: workspace.source.sourceId,
        sourceRevisionId: workspace.revision.id,
        logicalKey: 'structure|' + workspace.source.sourceId,
        payload: {
          lorebookId: workspace.source.lorebookId,
          uid: workspace.source.uid,
          title: workspace.revision.metadata?.title || null,
          treePath: workspace.revision.metadata?.treePath || [],
          tags: workspace.revision.metadata?.tags || [],
          scope: workspace.revision.metadata?.scope || null,
          sourceOrder: workspace.revision.metadata?.order ?? null,
          truthAuthority: false,
        },
        derivation: 'STRUCTURAL_READING',
        authorityClass: AuthorityClass.DERIVED,
      }));
    }
    if (unit === 'STRUCTURE_CONTEXT') {
      // Two-sentence context chunks, chunksPerSlice per step, until every sentence is in a chunk.
      const sentences = workspace.sentences;
      let i = cursor.offset;
      for (let made = 0; i < sentences.length && made < limits.chunksPerSlice; i += 2, made += 1) {
        const chunk = sentences.slice(i, i + 2);
        addArtifact(workspace, makeArtifact({
          type: ArtifactType.CONTEXT_CHUNK,
          sourceId: workspace.source.sourceId,
          sourceRevisionId: workspace.revision.id,
          logicalKey: 'chunk|' + i + '|' + chunk.map(stableHash).join('|'),
          payload: {
            chunkIndex: i / 2,
            sentenceIndexes: chunk.map((_, offset) => i + offset),
            text: chunk.join(' '),
            context: {
              lorebookId: workspace.source.lorebookId,
              uid: workspace.source.uid,
              title: workspace.revision.metadata?.title || null,
              treePath: workspace.revision.metadata?.treePath || [],
            },
          },
          derivation: 'CONTEXTUALIZATION',
          authorityClass: AuthorityClass.DERIVED,
        }));
      }
      slice = {phase: 'CHUNK', from: cursor.offset, to: Math.min(i, sentences.length)};
      workspace.coverage.sentencesChunked = Math.min(i, sentences.length);
      cursor.offset = i;
      unitDone = i >= sentences.length;
    } else if (unit === 'ENTITY_ALIAS') {
      if ((cursor.phase || 'ANALYZE') === 'ANALYZE') {
        const end = Math.min(workspace.sentences.length, cursor.offset + limits.sentencesPerSlice);
        for (let index = cursor.offset; index < end; index += 1) analyzeSentence(workspace, workspace.sentences[index], index);
        slice = {phase: 'ANALYZE', from: cursor.offset, to: end};
        workspace.coverage.sentencesAnalyzed = end;
        cursor.phase = end >= workspace.sentences.length ? 'FINALIZE' : 'ANALYZE';
        cursor.offset = end >= workspace.sentences.length ? 0 : end;
        unitDone = false;
      } else {
        const total = Object.keys(workspace.entities).length;
        const end = Math.min(total, cursor.offset + limits.entitiesPerSlice);
        finalizeEntities(workspace, cursor.offset, end - cursor.offset);
        slice = {phase: 'FINALIZE', from: cursor.offset, to: end};
        workspace.coverage.entitiesFinalized = end;
        cursor.offset = end;
        unitDone = end >= total;
      }
    } else if (unit === 'CLAIM_RELATIONSHIP') {
      if ((cursor.phase || 'CLAIMS') === 'CLAIMS') {
        const total = workspace.claimRows.length;
        const end = Math.min(total, cursor.offset + limits.claimRowsPerSlice);
        finalizeClaimRows(workspace, cursor.offset, end - cursor.offset);
        slice = {phase: 'CLAIMS', from: cursor.offset, to: end};
        workspace.coverage.claimRowsFinalized = end;
        cursor.phase = end >= total ? 'RELATIONSHIPS' : 'CLAIMS';
        cursor.offset = end >= total ? 0 : end;
        unitDone = false;
      } else {
        const total = workspace.relationshipRows.length;
        const end = Math.min(total, cursor.offset + limits.relationshipRowsPerSlice);
        finalizeRelationshipRows(workspace, cursor.offset, end - cursor.offset);
        slice = {phase: 'RELATIONSHIPS', from: cursor.offset, to: end};
        workspace.coverage.relationshipRowsFinalized = end;
        cursor.offset = end;
        unitDone = end >= total;
      }
    } else if (unit === 'TEMPORAL_ONTOLOGY') {
      deriveOntology(workspace);
    } else if (unit === 'RETRIEVAL') {
      retrievalArtifacts(workspace);
    } else if (unit === 'COMPILE') {
      compileArtifact(workspace);
    } else if (unit === 'VALIDATE') {
      workspace.validation = this.validateWorkspace(workspace);
      session.valid = workspace.validation.ok;
    }

    workspace.unitReceipts.push({
      kind: 'LoreStudyUnitReceipt',
      unit,
      index: session.unitIndex,
      ...(slice ? {slice} : {}),
      unitComplete: unitDone,
      artifactCount: workspace.artifacts.length,
      checksum: stableHash(workspace.artifacts.map((artifact) => artifact.id)),
    });
    if (unitDone) {
      session.unitIndex += 1;
      session.cursor = {phase: null, offset: 0};
    }
    session.complete = session.unitIndex >= session.units.length;
    return deepClone(session);
  }

  runToCompletion(session) {
    let current = deepClone(session);
    while (!current.complete) current = this.step(current);
    return current;
  }

  validateWorkspace(workspace) {
    const failures = [];
    const ids = new Set();
    for (const artifact of workspace.artifacts) {
      if (ids.has(artifact.id)) failures.push('duplicate-artifact:' + artifact.id);
      ids.add(artifact.id);
      if (artifact.sourceId !== workspace.source.sourceId) failures.push('source-id:' + artifact.id);
      if (artifact.sourceRevisionId !== workspace.revision.id) failures.push('source-revision:' + artifact.id);
      if (artifact.provenance?.sourceRevisionId !== workspace.revision.id) failures.push('provenance:' + artifact.id);
      if (artifact.authorityClass === AuthorityClass.SOURCE_CANON && artifact.artifactType !== ArtifactType.CLAIM) {
        failures.push('authority-promotion:' + artifact.id);
      }
      if ([ArtifactType.CONCEPT, ArtifactType.COMMUNITY, ArtifactType.RETRIEVAL, ArtifactType.COMPACT, ArtifactType.STRUCTURE, ArtifactType.CONTEXT_CHUNK].includes(artifact.artifactType)
        && artifact.authorityClass === AuthorityClass.SOURCE_CANON) {
        failures.push('derived-became-source:' + artifact.id);
      }
    }
    // Coverage replaces the old per-source ceilings: a study is valid only when every sentence was chunked and analyzed and
    // every extracted entity, claim and relationship row was finalized.
    const c = workspace.coverage || {};
    const sentenceCount = workspace.sentences.length;
    const coverage = {
      kind: 'LoreStudyCoverageReceipt',
      sentenceCount,
      sentencesChunked: c.sentencesChunked ?? 0,
      sentencesAnalyzed: c.sentencesAnalyzed ?? 0,
      entityCount: Object.keys(workspace.entities).length,
      entitiesFinalized: c.entitiesFinalized ?? 0,
      claimRowCount: workspace.claimRows.length,
      claimRowsFinalized: c.claimRowsFinalized ?? 0,
      relationshipRowCount: workspace.relationshipRows.length,
      relationshipRowsFinalized: c.relationshipRowsFinalized ?? 0,
      canonicalKnowledgeDropped: false,
    };
    coverage.coverageComplete = coverage.sentencesChunked === sentenceCount && coverage.sentencesAnalyzed === sentenceCount
      && coverage.entitiesFinalized === coverage.entityCount && coverage.claimRowsFinalized === coverage.claimRowCount
      && coverage.relationshipRowsFinalized === coverage.relationshipRowCount;
    if (!coverage.coverageComplete) failures.push('incomplete-coverage');
    const bounds = {
      retrieval: workspace.artifacts.filter((row) => row.artifactType === ArtifactType.RETRIEVAL).length <= MAX_RETRIEVAL_FORMS,
    };
    if (Object.values(bounds).some((value) => !value)) failures.push('artifact-bounds');
    return {
      kind: 'LoreStudyValidation',
      ok: failures.length === 0,
      failures,
      bounds,
      coverage,
      artifactCount: workspace.artifacts.length,
      sourcePreservedExternally: true,
      sourceAuthorityPromotions: failures.filter((failure) => failure.startsWith('authority-promotion') || failure.startsWith('derived-became-source')).length,
    };
  }
}
