import { CastPresence, ObservationClass, createFieldState } from './contracts.js';

const clone = (value) => structuredClone(value);
const rank = { [CastPresence.PRESENT]: 5, [CastPresence.DEPARTED]: 4, [CastPresence.OFFSCREEN_RELEVANT]: 3, [CastPresence.UNCERTAIN]: 2, [CastPresence.MENTIONED_ONLY]: 1 };
const bounded = (items, limit = 32) => [...new Set(items)].slice(-limit);

export class ActiveCastResolver {
  constructor({ maxEntries = 64, maxMentionedOnly = 24 } = {}) { this.maxEntries = maxEntries; this.maxMentionedOnly = maxMentionedOnly; }
  resolve({ previous = [], observations = [], revision, evidenceRefs = [] }) {
    const byId = new Map(previous.map((item) => [item.characterId, clone(item)]));
    for (const obs of observations) {
      if (!obs.characterId) continue;
      const current = byId.get(obs.characterId);
      const next = {
        characterId: obs.characterId,
        state: obs.state ?? CastPresence.UNCERTAIN,
        confidence: Number(obs.confidence ?? .5),
        evidenceRefs: bounded([...(current?.evidenceRefs ?? []), ...(obs.evidenceRefs ?? [])]),
        reason: obs.reason ?? null,
        seenRevision: revision,
      };
      if (current && next.state === CastPresence.MENTIONED_ONLY && rank[current.state] > rank[next.state]) { current.evidenceRefs = bounded([...(current.evidenceRefs ?? []), ...(obs.evidenceRefs ?? [])]); byId.set(obs.characterId, current); continue; }
      if (!current || obs.explicit || rank[next.state] >= rank[current.state] || next.confidence >= current.confidence) byId.set(obs.characterId, next);
    }
    const all = [...byId.values()];
    const stronger = all.filter((x) => x.state !== CastPresence.MENTIONED_ONLY);
    const mentioned = all.filter((x) => x.state === CastPresence.MENTIONED_ONLY).sort((a,b)=>(b.seenRevision??0)-(a.seenRevision??0)).slice(0,this.maxMentionedOnly);
    const value = [...stronger, ...mentioned].sort((a,b)=>(b.seenRevision??0)-(a.seenRevision??0)).slice(0,this.maxEntries).sort((a, b) => a.characterId.localeCompare(b.characterId));
    const unresolved = value.some((item) => item.state === CastPresence.UNCERTAIN);
    return createFieldState({
      value,
      confidence: value.length ? Math.min(...value.map((item) => item.confidence)) : 1,
      evidenceRefs: bounded([...evidenceRefs, ...value.flatMap((item) => item.evidenceRefs)], 64),
      observationClass: unresolved ? ObservationClass.UNRESOLVED : ObservationClass.OBSERVED,
      revision,
    });
  }

  mention(characterId, evidenceRef, confidence = .95) { return { characterId, state: CastPresence.MENTIONED_ONLY, confidence, evidenceRefs: [evidenceRef], reason: 'mention-only', explicit: true }; }
  enter(characterId, evidenceRef) { return { characterId, state: CastPresence.PRESENT, confidence: 1, evidenceRefs: [evidenceRef], reason: 'explicit entrance', explicit: true }; }
  exit(characterId, evidenceRef) { return { characterId, state: CastPresence.DEPARTED, confidence: 1, evidenceRefs: [evidenceRef], reason: 'explicit exit', explicit: true }; }
}
