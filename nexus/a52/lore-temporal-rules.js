// Lore temporal and conflict rules (audit D7), owner-approved shape:
//   R1 attribution: a source reporting X is not X being uncertain. Speaker/source is kept and the statement is classed as
//      OBSERVATION (direct perception), HEARSAY (relayed or asserted without an established basis) or SPECULATION (modal or
//      belief). Only HEARSAY and SPECULATION are unresolved; an observation is a source-attested claim.
//   R2 time: `at` and `claimAt` are validated coordinates {value, timeline, unit}. Missing, malformed or incompatible
//      (different timeline or unit) times are UNKNOWN and never compared.
//   R3 supersession: a later, non-hearsay claim replaces an earlier state only when entity identity, normalized property AND
//      temporal applicability all match (same timeline, comparable coordinates, the earlier claim as-of state). A reported
//      claim never settles anything.
//   R4 conflict: values conflict only for the same normalized single-valued property of the same entity while their
//      applicability provably overlaps AND the property's compatibility table says they cannot both hold. Compatible
//      values, change over time (superseded states) and unknown overlap are not conflicts; an overlap or event identity that
//      is merely unestablished yields a POSSIBLE conflict (shown, never an adjudication alternative).
//   E1 event identity: two event names are the same event only by equal normalized name or by alias evidence in the Lore
//      entity tables. A missing modifier is uncertainty (POSSIBLE), and different modifiers do not prove different events.
//   Scope: shared read access permits comparison; it does not establish shared continuity. Overlap is established only
//      inside one continuity (same timeline and version); across continuities it is POSSIBLE at most.
// Nothing here writes to a source, a seal or a Truth decision; the output is evidence for the Lore owner and Truth.
import { stableHash, stableStringify } from './lore-contracts.js';

export const TEMPORAL_RULES_REVISION = 'lore-temporal-rules-v2';
export const DEFAULT_TIME_UNIT = 'ORDER';

export const AttributionMode = Object.freeze({ OBSERVATION: 'OBSERVATION', HEARSAY: 'HEARSAY', SPECULATION: 'SPECULATION' });

// Properties with exactly one value at a time. A predicate not listed here has no conflict semantics (never invented).
const PROPERTY_TABLE = Object.freeze({
  state: { property: 'state', cardinality: 'ONE' },
  fate: { property: 'fate', cardinality: 'ONE' },
  location: { property: 'location', cardinality: 'ONE' },
  owner: { property: 'owner', cardinality: 'ONE' },
  possessor: { property: 'possessor', cardinality: 'ONE' },
});
export function normalizedProperty(predicate) {
  const row = PROPERTY_TABLE[String(predicate || '').toLowerCase()];
  return row ? { ...row } : { property: null, cardinality: null };
}

// ---------- R2 ----------
function asCoordinate(raw) {
  if (typeof raw === 'number') return Number.isSafeInteger(raw) ? raw : null;
  if (typeof raw === 'string' && /^-?\d{1,15}$/.test(raw.trim())) return Number(raw.trim());
  return null;
}
export function readSourceTime(metadata = {}, { lorebookId = null } = {}) {
  const problems = [];
  const timeline = String(metadata.timeline ?? lorebookId ?? '') || null;
  const rawUnit = metadata.timeUnit == null ? DEFAULT_TIME_UNIT : String(metadata.timeUnit);
  const unit = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(rawUnit) ? rawUnit.toUpperCase() : null;
  if (unit === null) problems.push('TIME_UNIT_INVALID');
  const coordinate = (key) => {
    if (metadata[key] == null) return null;
    const value = asCoordinate(metadata[key]);
    if (value === null) { problems.push(key.toUpperCase() + '_INVALID'); return null; }
    if (!timeline || unit === null) { problems.push(key.toUpperCase() + '_UNANCHORED'); return null; }
    return { value, timeline, unit };
  };
  const version = metadata.version == null ? null : String(metadata.version).slice(0, 64) || null;
  return { at: coordinate('at'), claimAt: coordinate('claimAt'), continuity: { timeline, version }, problems };
}
// -1, 0, 1, or 'UNKNOWN' when either time is missing or the two are not on the same timeline and unit.
export function compareTimes(a, b) {
  if (!a || !b || a.timeline !== b.timeline || a.unit !== b.unit) return 'UNKNOWN';
  return a.value < b.value ? -1 : a.value > b.value ? 1 : 0;
}

// ---------- R1 ----------
const SPEAKER = '(.{1,60}?)';
const HEARSAY_VERBS = 'claims?|claimed|says?|said|reports?|reported|states?|stated|writes|wrote|alleges?|alleged|heard|told|whispers?|whispered|rumou?rs?|rumou?red';
const OBSERVE_VERBS = 'saw|witnessed|observed|watched|noticed';
const SPECULATE_VERBS = 'suspects?|suspected|believes?|believed|guesses|guessed|speculates?|speculated|supposes?|supposed|thinks?|thought|fears?|feared|hopes?|hoped';
const cleanSpeaker = (text) => String(text || '').replace(/^(?:the|a|an)\s+/i, '').replace(/\s+/g, ' ').trim() || null;
export function parseAttribution(sentence) {
  const s = String(sentence || '').replace(/\s+/g, ' ').trim().replace(/[.!?]+$/, '');
  let m;
  if ((m = s.match(/^according to (.+?),\s*(.+)$/i))) return { mode: AttributionMode.HEARSAY, speaker: cleanSpeaker(m[1]), marker: 'according to', clause: m[2] };
  if ((m = s.match(/^(?:rumou?r has it that|it is (?:said|rumou?red) that|people say(?: that)?|they say(?: that)?)\s+(.+)$/i))) return { mode: AttributionMode.HEARSAY, speaker: null, marker: 'rumour', clause: m[1] };
  if ((m = s.match(new RegExp('^' + SPEAKER + '\\s+(' + OBSERVE_VERBS + ')\\s+(?:that\\s+)?(.+)$', 'i')))) return { mode: AttributionMode.OBSERVATION, speaker: cleanSpeaker(m[1]), marker: m[2].toLowerCase(), clause: m[3] };
  if ((m = s.match(new RegExp('^' + SPEAKER + '\\s+(' + SPECULATE_VERBS + ')\\s+(?:that\\s+)?(.+)$', 'i')))) return { mode: AttributionMode.SPECULATION, speaker: cleanSpeaker(m[1]), marker: m[2].toLowerCase(), clause: m[3] };
  if ((m = s.match(new RegExp('^' + SPEAKER + '\\s+(' + HEARSAY_VERBS + ')\\s+(?:that\\s+)?(.+)$', 'i')))) return { mode: AttributionMode.HEARSAY, speaker: cleanSpeaker(m[1]), marker: m[2].toLowerCase(), clause: m[3] };
  if ((m = s.match(/^(.+?)\b(?:may|might|could|possibly|perhaps|probably)\b(.+)$/i))) return { mode: AttributionMode.SPECULATION, speaker: null, marker: 'modal', clause: (m[1] + m[2]).replace(/\s+/g, ' ').trim() };
  return null;
}
export const isUnresolvedAttribution = (attribution) => attribution?.mode === AttributionMode.HEARSAY || attribution?.mode === AttributionMode.SPECULATION;

// ---------- clause grammar (structured, not keyword flags) ----------
const REMOVE = '(?:removed|taken|took|moved|carried off|carried away)';
const STEAL = '(?:stolen|stole)';
const DESTROY = '(?:destroyed|burned|burnt|ruined)';
const lemma = (verb) => (new RegExp('^' + STEAL + '$', 'i').test(verb) ? 'stolen' : new RegExp('^' + REMOVE + '$', 'i').test(verb) ? 'removed' : 'destroyed');
const eventSlug = (text) => String(text || '').toLowerCase().replace(/^(?:the|a|an)\s+/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || null;
const ADV = '(?:shortly |just |long |right )?';
const AUX = '(was|were|had been|(?:may|might|could|must) have been)';
const isModal = (aux) => /^(?:may|might|could|must)\b/i.test(aux || '');
// Returns {subject, predicate, value, applicability, qualifier} or null. `subject` is a raw name for the caller to resolve.
export function analyzeClause(clause) {
  const s = String(clause || '').replace(/\s+/g, ' ').trim().replace(/[.!?]+$/, '');
  let m;
  const eventFate = (subject, value, event, relation, agent = null) => ({ subject, predicate: 'fate', value, applicability: { kind: 'FROM_EVENT', event, relation }, qualifier: agent ? { agent } : null });
  // "<actor> removed the X shortly before the <event>" / "someone took the X after the <event>"
  if ((m = s.match(new RegExp('^(?:(.+?)\\s+)?(' + REMOVE + '|' + STEAL + ')\\s+(?:the\\s+)?(.+?)\\s+' + ADV + '(before|after|during)\\s+(?:the\\s+)?(.+)$', 'i')))) {
    const event = eventSlug(m[5]);
    if (event) return eventFate(m[3], lemma(m[2]) + '-' + m[4].toLowerCase() + '-' + event, event, m[4].toLowerCase(), /^(?:someone|somebody|a\s+\w+)$/i.test(m[1] || '') || !m[1] ? null : m[1]);
  }
  // "the X was removed shortly before the <event>"
  if ((m = s.match(new RegExp('^(?:the\\s+)?(.+?)\\s+' + AUX + '\\s+(' + REMOVE + '|' + STEAL + ')\\s+' + ADV + '(before|after|during)\\s+(?:the\\s+)?(.+)$', 'i')))) {
    const event = eventSlug(m[5]);
    if (event) return { ...eventFate(m[1], lemma(m[3]) + '-' + m[4].toLowerCase() + '-' + event, event, m[4].toLowerCase()), modal: isModal(m[2]) };
  }
  // "the X is/was destroyed in the <event>"
  if ((m = s.match(new RegExp('^(?:the\\s+)?(.+?)\\s+(?:(is|was|were|had been|(?:may|might|could|must) have been)\\s+)?' + DESTROY + '\\s+(in|during|by)\\s+(?:the\\s+)?(.+)$', 'i')))) {
    const event = eventSlug(m[4]);
    if (event) return { ...eventFate(m[1], 'destroyed-' + m[3].toLowerCase() + '-' + event, event, m[3].toLowerCase()), modal: isModal(m[2]) };
  }
  // "the X survived the <event>"
  if ((m = s.match(/^(?:the\s+)?(.+?)\s+survived\s+(?:the\s+)?(.+)$/i))) {
    const event = eventSlug(m[2]);
    if (event) return eventFate(m[1], 'survived-' + event, event, 'through');
  }
  // "the X burns down" / "burned down": a state change of X at the source's own time
  if ((m = s.match(/^(?:the\s+)?(.+?)\s+(?:burns|burned|burnt)\s+down$/i))) return { subject: m[1], predicate: 'state', value: 'destroyed', applicability: { kind: 'AS_OF' }, qualifier: null };
  return null;
}

// ---------- R3 / R4: cross-source resolution ----------
const isReported = (claim) => isUnresolvedAttribution(claim.payload?.attribution);
const coordOf = (claim) => claim.payload?.sourceTime?.at ?? null;
const continuityOf = (claim) => claim.payload?.sourceTime?.continuity ?? null;
const normText = (value) => String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// Unambiguous alias identity: entity E is the same as E' when E's canonical name is an alias of exactly one other entity.
export function buildIdentityMap(entities = []) {
  const byAlias = new Map(), canonicalName = new Map();
  for (const e of entities) {
    const id = e.payload?.entityId; if (!id) continue;
    canonicalName.set(id, String(e.payload.canonicalName || '').toLowerCase());
    for (const alias of e.payload.aliases || []) { const k = String(alias).toLowerCase(); if (!byAlias.has(k)) byAlias.set(k, new Set()); byAlias.get(k).add(id); }
  }
  const map = new Map();
  for (const [id, name] of canonicalName) {
    const owners = [...(byAlias.get(name) || [])].filter((other) => other !== id);
    if (owners.length === 1 && (byAlias.get(name)?.size ?? 0) === 2) map.set(id, owners[0]);
  }
  return map;
}

// E1: 'SAME' by equal normalized name or by alias evidence (both names belong to exactly one entity's name table);
// 'POSSIBLE' when the names share a head noun (a missing or different modifier is uncertainty, not a proof either way);
// 'NONE' otherwise.
export function buildEventIdentity(entities = []) {
  const owners = new Map();
  for (const e of entities) {
    const names = new Set([e.payload?.canonicalName, ...(e.payload?.aliases || [])].map((n) => normText(n).replace(/^(?:the|a|an)-/, '')).filter(Boolean));
    for (const name of names) { if (!owners.has(name)) owners.set(name, new Set()); owners.get(name).add(e.payload?.entityId); }
  }
  return (a, b) => {
    if (!a || !b) return 'NONE';
    if (a === b) return 'SAME';
    const oa = owners.get(a), ob = owners.get(b);
    if (oa && ob && oa.size === 1 && ob.size === 1 && [...oa][0] === [...ob][0]) return 'SAME';
    return a.split('-').pop() === b.split('-').pop() ? 'POSSIBLE' : 'NONE';
  };
}
// Kept for callers that only have names: equality only (no evidence available).
export function sameEvent(a, b) { return Boolean(a && b && a === b); }

// Per-property value normalization and compatibility. `incompatible` is true (cannot both hold), false (can both hold) or
// null (the table says nothing: no conflict is asserted). Only listed pairs are ever declared incompatible.
const STATE_INTACT_EXCLUDES = new Set(['damaged', 'destroyed', 'lost', 'missing']);
const fateOutcome = (value) => String(value ?? '').split('-')[0];
const FATE_RELATION = (claim) => claim.payload?.applicability?.relation ?? null;
const PROPERTY_RULES = Object.freeze({
  state: {
    normalize: (v) => normText(v),
    incompatible: (a, b) => (a === b ? false : (a === 'intact' && STATE_INTACT_EXCLUDES.has(b)) || (b === 'intact' && STATE_INTACT_EXCLUDES.has(a)) ? true : null),
  },
  fate: {
    normalize: (v) => normText(v),
    incompatible: (a, b, ca, cb) => {
      if (a === b) return false;
      const [oa, ob] = [fateOutcome(a), fateOutcome(b)];
      const pair = (x, y) => (oa === x && ob === y) || (oa === y && ob === x);
      const removal = (o) => o === 'removed' || o === 'stolen';
      const rel = (claim) => FATE_RELATION(claim);
      if (pair('destroyed', 'survived')) return true;
      if ((oa === 'destroyed' && removal(ob)) || (ob === 'destroyed' && removal(oa))) {
        const relation = removal(oa) ? rel(ca) : rel(cb);
        return relation === 'before' || relation === 'after' ? true : null;
      }
      if ((oa === 'survived' && removal(ob)) || (ob === 'survived' && removal(oa))) return false;
      return null;
    },
  },
  location: { normalize: (v, canonical) => canonical.get(String(v)) ?? String(v), incompatible: (a, b) => a !== b },
  owner: { normalize: (v, canonical) => canonical.get(String(v)) ?? String(v), incompatible: (a, b) => a !== b },
  possessor: { normalize: (v, canonical) => canonical.get(String(v)) ?? String(v), incompatible: (a, b) => a !== b },
});
const normalizedValueOf = (claim, property, canonical) => (PROPERTY_RULES[property]?.normalize ?? normText)(claim.payload?.value, canonical);

function sameContinuity(a, b) {
  const ca = continuityOf(a), cb = continuityOf(b);
  if (!ca?.timeline || !cb?.timeline) return false;
  return ca.timeline === cb.timeline && (ca.version ?? null) === (cb.version ?? null);
}

// -> {overlap: 'YES'|'POSSIBLE'|'NO'|'NONE', basis}
function applicabilityOverlap(a, b, supersededIds, eventRelation) {
  const pa = a.payload?.applicability, pb = b.payload?.applicability;
  if (!pa || !pb) return { overlap: 'NONE', basis: 'NO_APPLICABILITY' };
  if (pa.kind === 'FROM_EVENT' && pb.kind === 'FROM_EVENT') {
    const identity = eventRelation(pa.event, pb.event);
    if (identity === 'NONE') return { overlap: 'NONE', basis: 'UNRELATED_EVENTS' };
    if (identity === 'POSSIBLE') return { overlap: 'POSSIBLE', basis: 'EVENT_IDENTITY_UNSUPPORTED' };
    return sameContinuity(a, b) ? { overlap: 'YES', basis: 'SAME_EVENT_SAME_CONTINUITY' } : { overlap: 'POSSIBLE', basis: 'CONTINUITY_UNESTABLISHED' };
  }
  if (pa.kind === 'AS_OF' && pb.kind === 'AS_OF') {
    if (isReported(a) || isReported(b)) return { overlap: 'NONE', basis: 'REPORTED_STATE_TIME_UNKNOWN' };
    if (!sameContinuity(a, b)) return { overlap: 'POSSIBLE', basis: 'CONTINUITY_UNESTABLISHED' };
    if (supersededIds.has(a.id) || supersededIds.has(b.id)) return { overlap: 'NO', basis: 'SUPERSEDED' };
    return compareTimes(coordOf(a), coordOf(b)) === 0 ? { overlap: 'YES', basis: 'SAME_INSTANT_SAME_CONTINUITY' } : { overlap: 'NONE', basis: 'TIME_UNKNOWN' };
  }
  return { overlap: 'NONE', basis: 'INCOMPARABLE_APPLICABILITY' };
}

// claims: current CLAIM artifacts. entities: current ENTITY artifacts (identity and event alias evidence).
// -> { superseded, conflicts (ESTABLISHED and POSSIBLE), conflictMembership, counts, revision }
export function resolveLoreTemporal({ claims = [], entities = [], scopeOf = (claim) => claim.sourceId, coScoped = (a, b) => a === b } = {}) {
  const canonical = buildIdentityMap(entities);
  const eventRelation = buildEventIdentity(entities);
  const groups = new Map();
  for (const claim of claims) {
    const p = claim.payload || {};
    const prop = p.property ? { property: p.property, cardinality: p.cardinality } : normalizedProperty(p.predicate);
    if (!prop.property || prop.cardinality !== 'ONE' || !PROPERTY_RULES[prop.property] || !p.applicability) continue;
    const key = (canonical.get(p.subjectId) ?? p.subjectId) + '|' + prop.property;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(claim);
  }
  const superseded = new Map(), conflicts = [];
  let compatiblePairs = 0, unknownCompatibility = 0;
  const membership = new Map();
  const note = (artifactId, entry) => { if (!membership.has(artifactId)) membership.set(artifactId, []); membership.get(artifactId).push(entry); };
  for (const [key, rows] of [...groups.entries()].sort((x, y) => x[0].localeCompare(y[0]))) {
    const property = key.split('|').pop();
    const rules = PROPERTY_RULES[property];
    // R3: as-of state claims, non-reported, same continuity and comparable time, differing normalized value.
    const states = rows.filter((c) => c.payload.applicability.kind === 'AS_OF' && !isReported(c) && coordOf(c));
    for (const earlier of states) {
      const later = states.filter((c) => c.id !== earlier.id && coScoped(scopeOf(earlier), scopeOf(c)) && sameContinuity(earlier, c)
        && compareTimes(coordOf(earlier), coordOf(c)) === -1 && normalizedValueOf(c, property, canonical) !== normalizedValueOf(earlier, property, canonical));
      if (later.length) {
        later.sort((x, y) => coordOf(x).value - coordOf(y).value);
        superseded.set(earlier.id, { by: later[0].id, property, reason: 'LATER_SAME_ENTITY_PROPERTY_CONTINUITY' });
      }
    }
    // R4: classify every pair; components of ESTABLISHED and POSSIBLE incompatibilities become conflict sets.
    const supersededIds = new Set(superseded.keys());
    const edges = { ESTABLISHED: [], POSSIBLE: [] }, compat = [];
    const bases = new Map();
    for (let i = 0; i < rows.length; i += 1) for (let j = i + 1; j < rows.length; j += 1) {
      const a = rows[i], b = rows[j];
      if (!coScoped(scopeOf(a), scopeOf(b))) continue;
      const va = normalizedValueOf(a, property, canonical), vb = normalizedValueOf(b, property, canonical);
      if (va === vb) { compat.push([a, b]); continue; }
      const { overlap, basis } = applicabilityOverlap(a, b, supersededIds, eventRelation);
      if (overlap === 'NONE' || overlap === 'NO') continue;
      const incompatible = rules.incompatible(va, vb, a, b);
      if (incompatible === false) { compatiblePairs += 1; compat.push([a, b]); continue; }
      if (incompatible === null) { unknownCompatibility += 1; continue; }
      const kind = overlap === 'YES' ? 'ESTABLISHED' : 'POSSIBLE';
      edges[kind].push([a, b]); bases.set(a.id + '|' + b.id, basis);
    }
    for (const kind of ['ESTABLISHED', 'POSSIBLE']) {
      if (!edges[kind].length) continue;
      const parent = new Map();
      const find = (x) => { if (!parent.has(x)) parent.set(x, x); while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
      const byId = new Map();
      for (const [a, b] of edges[kind]) { byId.set(a.id, a); byId.set(b.id, b); parent.set(find(a.id), find(b.id)); }
      const comps = new Map();
      for (const c of byId.values()) { const r = find(c.id); if (!comps.has(r)) comps.set(r, []); comps.get(r).push(c); }
      for (const members of comps.values()) {
        const ids = new Set(members.map((c) => c.id));
        const pairs = edges[kind].filter(([a]) => ids.has(a.id)).map(([a, b]) => ({ a: a.id, b: b.id, basis: bases.get(a.id + '|' + b.id) })).sort((x, y) => (x.a + x.b).localeCompare(y.a + y.b));
        // Alternatives: members that can hold together (same value or declared compatible) form one alternative.
        const cp = new Map(members.map((c) => [c.id, c.id]));
        const cf = (x) => { while (cp.get(x) !== x) { cp.set(x, cp.get(cp.get(x))); x = cp.get(x); } return x; };
        for (const [a, b] of compat) if (ids.has(a.id) && ids.has(b.id)) cp.set(cf(a.id), cf(b.id));
        const altMap = new Map();
        for (const c of members) { const r = cf(c.id); if (!altMap.has(r)) altMap.set(r, []); altMap.get(r).push(c.id); }
        const alternatives = [...altMap.values()].map((list) => list.sort()).sort((x, y) => x[0].localeCompare(y[0]));
        const values = [...new Set(members.map((c) => normalizedValueOf(c, property, canonical)))].sort();
        const id = 'conflict:' + stableHash(kind + '|' + key + '|' + values.join('|'));
        conflicts.push({
          kind: 'LoreConflictSet', id, certainty: kind, slotKey: key, property,
          artifactIds: members.map((c) => c.id).sort(), semanticIds: members.map((c) => c.semanticId).sort(),
          values: members.map((c) => ({ artifactId: c.id, value: c.payload.value, normalizedValue: normalizedValueOf(c, property, canonical), attribution: c.payload.attribution?.mode ?? 'ASSERTED', speaker: c.payload.attribution?.speaker ?? null })).sort((x, y) => x.artifactId.localeCompare(y.artifactId)),
          incompatiblePairs: pairs, alternatives,
          status: 'UNRESOLVED', authorityClass: 'UNRESOLVED',
          basis: kind === 'ESTABLISHED' ? 'INCOMPATIBLE_VALUES_OVERLAPPING_APPLICABILITY' : [...new Set(pairs.map((p) => p.basis))].sort().join('+'),
        });
        for (const c of members) note(c.id, { conflictSetId: id, certainty: kind, property });
      }
    }
  }
  conflicts.sort((a, b) => a.id.localeCompare(b.id));
  const conflictedIds = new Set(conflicts.flatMap((row) => row.artifactIds));
  return { kind: 'LoreTemporalResolution', revision: TEMPORAL_RULES_REVISION, superseded, conflicts, conflictedIds, conflictMembership: membership, compatiblePairs, unknownCompatibility, groupCount: groups.size };
}
