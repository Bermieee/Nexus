import {stableHash} from './lore-contracts.js';

const MAX_QUERIES = 6;
const MAX_QUERY_CHARS = 320;
const MAX_CANDIDATES = 32;
const MAX_REFS = 64;
const MAX_HINTS = 16;

const clone = (value) => value == null ? value : structuredClone(value);
const uniq = (values = [], limit = MAX_REFS) => [...new Set((values || []).filter(Boolean).map(String))].slice(0, limit);
const text = (value, limit = MAX_QUERY_CHARS) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit);

export const SceneLoreNeedReason = Object.freeze({
  CAST_CHANGED: 'CAST_CHANGED',
  PLACE_CHANGED: 'PLACE_CHANGED',
  TIME_CHANGED: 'TIME_CHANGED',
  RELATIONSHIP_CHANGED: 'RELATIONSHIP_CHANGED',
  UNRESOLVED_THREAD_CHANGED: 'UNRESOLVED_THREAD_CHANGED',
  CORRECTION: 'CORRECTION',
  SCENE_TRANSITION: 'SCENE_TRANSITION',
});

export const SceneLoreHandoffStatus = Object.freeze({
  NO_WORK: 'NO_WORK',
  SYNCED: 'SYNCED',
  EXCLUDED: 'EXCLUDED',
  DEGRADED: 'DEGRADED',
  STALE: 'STALE',
  LATE: 'LATE',
});

function required(value, code, label) {
  const out = String(value ?? '').trim();
  if (!out) throw Object.assign(new TypeError(label + ' is required'), {code});
  return out;
}

function changeValue(receipt, field, side = 'after') {
  const row = receipt?.delta?.changedFields?.[field];
  const state = row?.[side];
  return state && typeof state === 'object' && 'value' in state ? state.value : state ?? null;
}

function scalarLabels(value, limit = 12) {
  const out = [];
  const push = (item) => {
    const normalized = text(item, 120);
    if (normalized && !out.includes(normalized) && out.length < limit) out.push(normalized);
  };
  const visit = (row, depth = 0) => {
    if (out.length >= limit || row == null || depth > 2) return;
    if (typeof row === 'string' || typeof row === 'number' || typeof row === 'boolean') {
      push(row);
      return;
    }
    if (Array.isArray(row)) {
      for (const item of row) visit(item, depth + 1);
      return;
    }
    if (typeof row !== 'object') return;
    const preferred = [
      'characterId', 'entityId', 'name', 'label', 'location', 'anchor',
      'threadId', 'objective', 'subjectId', 'predicate', 'objectId', 'status',
      'relationship', 'relationshipType', 'type',
    ];
    let usedPreferred = false;
    for (const key of preferred) {
      if (row[key] == null) continue;
      usedPreferred = true;
      visit(row[key], depth + 1);
    }
    if (!usedPreferred) {
      for (const [key, item] of Object.entries(row).slice(0, 8)) {
        if (['confidence', 'revision', 'evidenceRefs', 'provenance', 'metadata'].includes(key)) continue;
        visit(item, depth + 1);
      }
    }
  };
  visit(value);
  return out;
}

function meaningfulReasons(receipt) {
  const changed = new Set(receipt?.changedFields || []);
  const eventTypes = new Set(receipt?.eventTypes || []);
  const reasons = [];
  const add = (value) => { if (!reasons.includes(value)) reasons.push(value); };

  if (changed.has('activeCast') || eventTypes.has('ACTIVE_CAST_CHANGED')) add(SceneLoreNeedReason.CAST_CHANGED);
  if (changed.has('location') || eventTypes.has('LOCATION_CHANGED')) add(SceneLoreNeedReason.PLACE_CHANGED);
  if (changed.has('narrativeTime') || eventTypes.has('TIME_SHIFT_DETECTED')) add(SceneLoreNeedReason.TIME_CHANGED);
  if (changed.has('activeRelationships') || eventTypes.has('RELATIONSHIP_SIGNAL')) add(SceneLoreNeedReason.RELATIONSHIP_CHANGED);
  if (changed.has('activeThreads')) add(SceneLoreNeedReason.UNRESOLVED_THREAD_CHANGED);
  if ((receipt?.signal?.uncertainFields || []).includes('activeThreads')
    || (receipt?.signal?.conflictSignals || []).includes('activeThreads')) {
    add(SceneLoreNeedReason.UNRESOLVED_THREAD_CHANGED);
  }
  if ((receipt?.invalidatedSourceRevisionRefs || []).length
    || receipt?.evidence?.replacesRevisionId
    || (receipt?.evidence?.invalidates || []).length) add(SceneLoreNeedReason.CORRECTION);
  if (receipt?.transition || eventTypes.has('SCENE_BOUNDARY_CONFIRMED')) add(SceneLoreNeedReason.SCENE_TRANSITION);
  return reasons;
}

function termsForReason(receipt, reason) {
  const signal = receipt?.signal || {};
  const beforeAfter = (field) => uniq([
    ...scalarLabels(changeValue(receipt, field, 'before')),
    ...scalarLabels(changeValue(receipt, field, 'after')),
  ], 18);

  if (reason === SceneLoreNeedReason.CAST_CHANGED) {
    return uniq([
      ...beforeAfter('activeCast'),
      ...scalarLabels((signal.activeCast || []).filter((row) => typeof row === 'string' || row?.state === 'PRESENT' || row?.presence === 'PRESENT')),
    ], 18);
  }
  if (reason === SceneLoreNeedReason.PLACE_CHANGED) {
    return uniq([...beforeAfter('location'), ...scalarLabels(signal.location)], 18);
  }
  if (reason === SceneLoreNeedReason.TIME_CHANGED) {
    return uniq([...beforeAfter('narrativeTime'), ...scalarLabels(signal.narrativeTime)], 18);
  }
  if (reason === SceneLoreNeedReason.RELATIONSHIP_CHANGED) {
    return beforeAfter('activeRelationships');
  }
  if (reason === SceneLoreNeedReason.UNRESOLVED_THREAD_CHANGED) {
    return uniq([...beforeAfter('activeThreads'), ...scalarLabels(signal.activeThreads)], 18);
  }
  if ([SceneLoreNeedReason.CORRECTION, SceneLoreNeedReason.SCENE_TRANSITION].includes(reason)) {
    return uniq([
      ...scalarLabels(signal.location),
      ...scalarLabels(signal.narrativeTime),
      ...scalarLabels(signal.activeCast),
      ...scalarLabels(signal.activeThreads),
      ...beforeAfter('location'),
      ...beforeAfter('activeCast'),
      ...beforeAfter('narrativeTime'),
      ...beforeAfter('activeRelationships'),
      ...beforeAfter('activeThreads'),
    ], 24);
  }
  return [];
}

function queryForReason(reason, terms) {
  if (!terms.length) return null;
  const prefix = {
    CAST_CHANGED: 'scene cast context',
    PLACE_CHANGED: 'scene place context',
    TIME_CHANGED: 'scene time context',
    RELATIONSHIP_CHANGED: 'scene relationship context',
    UNRESOLVED_THREAD_CHANGED: 'scene unresolved thread',
    CORRECTION: 'scene corrected context',
    SCENE_TRANSITION: 'scene transition context',
  }[reason] || 'scene context';
  return text(prefix + ': ' + terms.join(' '));
}

export function createSceneLoreRetrievalNeed({
  sceneReceipt,
  chatId = null,
  turnId = null,
  generationId,
} = {}) {
  if (!sceneReceipt || sceneReceipt.kind !== 'DeploymentSceneOwnerReceipt' || Number(sceneReceipt.contractVersion) !== 1) {
    throw Object.assign(new TypeError('DeploymentSceneOwnerReceipt@1 is required'), {code: 'SCENE_LORE_OWNER_RECEIPT_REQUIRED'});
  }
  const resolvedChatId = required(chatId ?? sceneReceipt.chatId ?? sceneReceipt.evidence?.chatId, 'SCENE_LORE_CHAT_REQUIRED', 'chatId');
  const resolvedTurnId = required(turnId ?? sceneReceipt.evidence?.turnId, 'SCENE_LORE_TURN_REQUIRED', 'turnId');
  const resolvedGenerationId = required(generationId, 'SCENE_LORE_GENERATION_REQUIRED', 'generationId');
  const sceneId = required(sceneReceipt.sceneId, 'SCENE_LORE_SCENE_REQUIRED', 'sceneId');
  const sceneRevision = Number(sceneReceipt.sceneRevision);
  if (!Number.isInteger(sceneRevision) || sceneRevision < 1) {
    throw Object.assign(new TypeError('sceneRevision must be a positive integer'), {code: 'SCENE_LORE_SCENE_REVISION_REQUIRED'});
  }

  if (sceneReceipt.status === 'NO_WORK') return null;
  const reasons = meaningfulReasons(sceneReceipt);
  const queries = [];
  for (const reason of reasons) {
    const query = queryForReason(reason, termsForReason(sceneReceipt, reason));
    if (!query || queries.some((row) => row.query === query)) continue;
    queries.push({
      queryId: 'scene-lore-query:' + stableHash({sceneId, sceneRevision, reason, query}, {length: 20}),
      reason,
      query,
      intent: 'NARROW',
    });
    if (queries.length >= MAX_QUERIES) break;
  }
  if (!queries.length) return null;

  const sceneSourceRevisionRefs = uniq([
    ...(sceneReceipt.sourceRevisionRefs || []),
    sceneReceipt.evidence?.sourceRevisionId,
  ]);

  const needCore = {
    chatId: resolvedChatId,
    turnId: resolvedTurnId,
    generationId: resolvedGenerationId,
    sceneId,
    sceneRevision,
    sceneSourceRevisionRefs,
    receiptSourceRevisionRef: sceneReceipt.evidence?.sourceRevisionId ?? null,
    reasons,
    queries,
  };
  return Object.freeze({
    kind: 'SceneLoreRetrievalNeed',
    contractVersion: 1,
    needId: 'scene-lore-need:' + stableHash(needCore, {length: 24}),
    ...clone(needCore),
    evidenceRefs: uniq([
      ...(sceneReceipt.eventIds || []),
      ...(sceneReceipt.signal?.provenance || []),
      sceneReceipt.evidence?.sourceRevisionId,
    ]),
    correctionInvalidatedSourceRevisionRefs: uniq(sceneReceipt.invalidatedSourceRevisionRefs || []),
    uncertainFields: uniq(sceneReceipt.signal?.uncertainFields || []),
    conflictSignals: uniq(sceneReceipt.signal?.conflictSignals || []),
    bounded: true,
    retrievalAuthority: false,
    truthAuthority: false,
    gatherAuthority: false,
    contextSealAuthority: false,
    promptInjectionAuthority: false,
  });
}

function refOf(value) {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return null;
  return value.ref ?? value.sourceRevisionId ?? value.evidenceId ?? value.artifactId ?? value.sourceId ?? null;
}

function temporalStatus(nomination = {}) {
  const hints = nomination.temporalHints || [];
  const unresolved = nomination.truthStatusHint === 'UNRESOLVED'
    || hints.some((row) => row?.unresolved === true || ['UNCERTAIN', 'CONFLICTING', 'UNRESOLVED'].includes(String(row?.temporalClass ?? row?.status ?? '').toUpperCase()));
  if (unresolved) return 'UNRESOLVED';
  if (nomination.truthStatusHint === 'HISTORICAL'
    || hints.some((row) => String(row?.temporalClass ?? row?.status ?? '').toUpperCase() === 'HISTORICAL')) return 'HISTORICAL';
  if (nomination.truthStatusHint === 'CURRENT'
    || hints.some((row) => String(row?.temporalClass ?? row?.status ?? '').toUpperCase() === 'CURRENT')) return 'CURRENT';
  return 'UNKNOWN';
}

function publicHints(nomination = {}) {
  return (nomination.temporalHints || []).slice(0, MAX_HINTS).map((row) => ({
    artifactId: row?.artifactId ?? null,
    evidenceId: row?.evidenceId ?? null,
    temporalClass: row?.temporalClass ?? row?.status ?? null,
    unresolved: Boolean(row?.unresolved),
  }));
}

function emptyResult({status, reason, need = null, queried = false, extras = {}}) {
  return Object.freeze({
    kind: 'SceneLoreRetrievalResult',
    contractVersion: 1,
    status,
    reason,
    queried,
    need: clone(need),
    candidates: [],
    candidateCount: 0,
    exclusions: [],
    sceneSourceRevisionFence: [...(need?.sceneSourceRevisionRefs || [])],
    queriedLoreSourceRevisionFence: [],
    loreSourceRevisionFence: [],
    ownerIndexRevisions: [],
    ownerOntologyRevisions: [],
    rawLoreIncluded: false,
    retrievalAuthority: false,
    truthAuthority: false,
    gatherAuthority: false,
    contextSealAuthority: false,
    promptInjectionAuthority: false,
    ...clone(extras),
  });
}

export class SceneLoreHandoffAdapter {
  constructor({
    getLoreInterface,
    getCurrentContext = null,
    isTurnSealed = null,
    maxCandidates = MAX_CANDIDATES,
  } = {}) {
    this.getLoreInterface = typeof getLoreInterface === 'function' ? getLoreInterface : () => null;
    this.getCurrentContext = typeof getCurrentContext === 'function' ? getCurrentContext : () => null;
    this.isTurnSealed = typeof isTurnSealed === 'function' ? isTurnSealed : () => false;
    this.maxCandidates = Math.max(1, Math.min(MAX_CANDIDATES, Number(maxCandidates) || MAX_CANDIDATES));
  }

  async _disposition(need) {
    if (await this.isTurnSealed(need.turnId)) {
      return {ok: false, status: SceneLoreHandoffStatus.LATE, reason: 'TURN_ALREADY_SEALED'};
    }
    const current = await this.getCurrentContext(need);
    if (!current) return {ok: true};
    if (current.activeChatId != null && String(current.activeChatId) !== need.chatId) {
      return {ok: false, status: SceneLoreHandoffStatus.LATE, reason: 'CHAT_SWITCHED'};
    }
    if (current.sceneId != null && String(current.sceneId) !== need.sceneId) {
      return {ok: false, status: SceneLoreHandoffStatus.STALE, reason: 'SCENE_ID_STALE'};
    }
    if (current.sceneRevision != null && Number(current.sceneRevision) !== need.sceneRevision) {
      return {ok: false, status: SceneLoreHandoffStatus.STALE, reason: 'SCENE_REVISION_STALE'};
    }
    if (current.turnId != null && String(current.turnId) === need.turnId
      && current.generationId != null && String(current.generationId) !== need.generationId) {
      return {ok: false, status: SceneLoreHandoffStatus.LATE, reason: 'GENERATION_SUPERSEDED'};
    }
    return {ok: true};
  }

  async retrieve({sceneReceipt, chatId = null, turnId = null, generationId} = {}) {
    const need = createSceneLoreRetrievalNeed({sceneReceipt, chatId, turnId, generationId});
    if (!need) {
      return emptyResult({
        status: SceneLoreHandoffStatus.NO_WORK,
        reason: sceneReceipt?.status === 'NO_WORK' ? (sceneReceipt.noWorkReason || 'SCENE_NO_WORK') : 'NO_BOUNDED_RETRIEVAL_TERMS',
      });
    }

    const before = await this._disposition(need);
    if (!before.ok) return emptyResult({status: before.status, reason: before.reason, need});

    const owner = await this.getLoreInterface();
    if (!owner || owner.kind !== 'LoreBrainRetrievalInterface' || Number(owner.contractVersion) !== 1 || typeof owner.queryScoped !== 'function') {
      return emptyResult({status: SceneLoreHandoffStatus.DEGRADED, reason: 'LORE_RETRIEVAL_INTERFACE_UNAVAILABLE', need});
    }

    const candidates = [];
    const exclusions = [];
    const packets = [];
    const queriedFence = new Set();
    const indexRevisions = new Set();
    const ontologyRevisions = new Set();

    try {
      for (const request of need.queries) {
        const packet = await owner.queryScoped({
          chatId: need.chatId,
          query: request.query,
          intent: request.intent,
          intentId: request.queryId,
        });
        if (!packet || packet.kind !== 'LoreBrainRetrievalPacket' || Number(packet.contractVersion) !== 1) {
          return emptyResult({status: SceneLoreHandoffStatus.DEGRADED, reason: 'LORE_RETRIEVAL_PACKET_CONTRACT_MISMATCH', need, queried: true});
        }
        packets.push(packet);
        for (const ref of packet.sourceRevisionFence || []) queriedFence.add(String(ref));
        if (packet.indexRevision) indexRevisions.add(String(packet.indexRevision));
        if (packet.ontologyRevision) ontologyRevisions.add(String(packet.ontologyRevision));

        const afterQuery = await this._disposition(need);
        if (!afterQuery.ok) {
          return emptyResult({
            status: afterQuery.status,
            reason: afterQuery.reason,
            need,
            queried: true,
            extras: {
              discardedCandidateCount: (packet.nominations || []).reduce((sum, row) => sum + (row?.drillback?.length || 0), 0),
              queriedLoreSourceRevisionFence: [...queriedFence].sort(),
              ownerIndexRevisions: [...indexRevisions].sort(),
              ownerOntologyRevisions: [...ontologyRevisions].sort(),
            },
          });
        }

        for (const row of packet.exclusionReceipts || []) {
          if (exclusions.length >= MAX_REFS) break;
          exclusions.push({
            queryId: request.queryId,
            sourceId: row.sourceId ?? null,
            lorebookId: row.lorebookId ?? null,
            uid: row.uid ?? null,
            sourceRevisionId: row.sourceRevisionId ?? null,
            decision: row.decision ?? 'EXCLUDED',
            reason: row.reason ?? null,
            authorityScope: clone(row.authorityScope ?? null),
          });
        }

        const receiptByCandidate = new Map((packet.candidateReceipts || []).map((row) => [row.candidateId, row]));
        for (const group of packet.nominations || []) {
          const nomination = group?.nomination || {};
          const receipt = receiptByCandidate.get(nomination.candidateId) || null;
          for (const source of group?.drillback || []) {
            if (candidates.length >= this.maxCandidates) break;
            const sourceId = source?.sourceId == null ? null : String(source.sourceId);
            const sourceRevisionId = source?.sourceRevisionId == null ? null : String(source.sourceRevisionId);
            if (!sourceId || !sourceRevisionId || !queriedFence.has(sourceRevisionId)) {
              if (exclusions.length < MAX_REFS) exclusions.push({
                queryId: request.queryId,
                sourceId,
                lorebookId: source?.lorebookId ?? null,
                uid: source?.uid ?? null,
                sourceRevisionId,
                decision: 'EXCLUDED',
                reason: 'LORE_SOURCE_REVISION_NOT_PACKET_FENCED',
                authorityScope: clone(packet.storyScope ?? null),
              });
              continue;
            }

            if (typeof owner.sourceRevision === 'function') {
              const current = await owner.sourceRevision(sourceId);
              if (!current || String(current.id ?? '') !== sourceRevisionId || current.state === 'REMOVED') {
                if (exclusions.length < MAX_REFS) exclusions.push({
                  queryId: request.queryId,
                  sourceId,
                  lorebookId: source?.lorebookId ?? null,
                  uid: source?.uid ?? null,
                  sourceRevisionId,
                  decision: 'EXCLUDED',
                  reason: current?.state === 'REMOVED' ? 'LORE_SOURCE_REMOVED_AFTER_QUERY' : 'LORE_SOURCE_REVISION_STALE_AFTER_QUERY',
                  authorityScope: clone(packet.storyScope ?? null),
                });
                continue;
              }
            }

            const candidateKey = [nomination.candidateId, sourceId, sourceRevisionId].join('|');
            if (candidates.some((candidate) => candidate._key === candidateKey)) continue;
            candidates.push({
              _key: candidateKey,
              kind: 'SceneLoreCandidateReference',
              contractVersion: 1,
              candidateId: nomination.candidateId ?? receipt?.candidateId ?? null,
              queryId: request.queryId,
              reason: request.reason,
              sourceId,
              lorebookId: source?.lorebookId ?? receipt?.sourceEntries?.find((entry) => entry.sourceId === sourceId)?.lorebookId ?? null,
              uid: source?.uid ?? receipt?.sourceEntries?.find((entry) => entry.sourceId === sourceId)?.uid ?? null,
              sourceRevisionId,
              representationRef: source?.representationRef ?? nomination.representationRef ?? null,
              retrievalRecordRef: nomination.metadata?.retrievalRecordRef ?? receipt?.retrievalRecordRef ?? null,
              evidenceRefs: uniq([...(nomination.evidenceRefs || []), ...(receipt?.evidenceRefs || [])], 32),
              provenanceRefs: uniq([
                ...(nomination.provenance || []).map(refOf),
                ...(receipt?.provenanceRefs || []),
                sourceRevisionId,
              ], 32),
              temporalStatus: temporalStatus(nomination),
              truthStatusHint: nomination.truthStatusHint ?? 'UNKNOWN',
              temporalHints: publicHints(nomination),
              scope: packet.storyScope ? {
                chatId: packet.storyScope.chatId ?? need.chatId,
                state: packet.storyScope.state ?? null,
                readLorebookIds: uniq(packet.storyScope.readLorebookIds || [], 32),
              } : {chatId: need.chatId, state: null, readLorebookIds: []},
              readiness: 'RETRIEVAL_READY_CURRENT_REVISION',
              ownerIndexRevision: packet.indexRevision ?? null,
              ownerOntologyRevision: packet.ontologyRevision ?? null,
              sceneNeedId: need.needId,
              sceneId: need.sceneId,
              sceneRevision: need.sceneRevision,
              sceneSourceRevisionRefs: [...need.sceneSourceRevisionRefs],
              authorityClass: nomination.authorityClass ?? receipt?.authorityClass ?? null,
              retrievalAuthority: false,
              truthAuthority: false,
              gatherAuthority: false,
              contextSealAuthority: false,
              promptInjectionAuthority: false,
              rawLoreIncluded: false,
            });
          }
          if (candidates.length >= this.maxCandidates) break;
        }
        if (candidates.length >= this.maxCandidates) break;
      }
    } catch (error) {
      return emptyResult({
        status: SceneLoreHandoffStatus.DEGRADED,
        reason: String(error?.code || error?.message || error || 'LORE_RETRIEVAL_FAILED'),
        need,
        queried: true,
        extras: {
          queriedLoreSourceRevisionFence: [...queriedFence].sort(),
          ownerIndexRevisions: [...indexRevisions].sort(),
          ownerOntologyRevisions: [...ontologyRevisions].sort(),
        },
      });
    }

    const finalDisposition = await this._disposition(need);
    if (!finalDisposition.ok) {
      return emptyResult({
        status: finalDisposition.status,
        reason: finalDisposition.reason,
        need,
        queried: true,
        extras: {
          discardedCandidateCount: candidates.length,
          queriedLoreSourceRevisionFence: [...queriedFence].sort(),
          ownerIndexRevisions: [...indexRevisions].sort(),
          ownerOntologyRevisions: [...ontologyRevisions].sort(),
        },
      });
    }

    const publicCandidates = candidates.map(({_key, ...row}) => Object.freeze(row));
    const loreFence = uniq(publicCandidates.map((row) => row.sourceRevisionId)).sort();
    const allExcluded = packets.length > 0 && packets.every((packet) => packet.status === 'EXCLUDED');
    return Object.freeze({
      kind: 'SceneLoreRetrievalResult',
      contractVersion: 1,
      status: publicCandidates.length ? SceneLoreHandoffStatus.SYNCED : (allExcluded ? SceneLoreHandoffStatus.EXCLUDED : SceneLoreHandoffStatus.SYNCED),
      reason: publicCandidates.length ? 'LORE_CANDIDATES_READY_FOR_BRAIN_CONSIDERATION'
        : (allExcluded ? (packets.find((packet) => packet.reason)?.reason || 'LORE_SCOPE_EXCLUDED') : 'NO_LORE_MATCH'),
      queried: true,
      need: clone(need),
      candidates: publicCandidates,
      candidateCount: publicCandidates.length,
      exclusions: exclusions.slice(0, MAX_REFS).map((row) => Object.freeze(row)),
      sceneSourceRevisionFence: [...need.sceneSourceRevisionRefs],
      queriedLoreSourceRevisionFence: [...queriedFence].sort(),
      loreSourceRevisionFence: loreFence,
      ownerIndexRevisions: [...indexRevisions].sort(),
      ownerOntologyRevisions: [...ontologyRevisions].sort(),
      rawLoreIncluded: false,
      retrievalAuthority: false,
      truthAuthority: false,
      gatherAuthority: false,
      contextSealAuthority: false,
      promptInjectionAuthority: false,
    });
  }
}
