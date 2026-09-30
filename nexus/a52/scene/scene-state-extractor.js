import { ObservationClass, createSceneObservationProposal } from './contracts.js';

export class SceneStateExtractor {
  constructor({ agent = 'scene-extractor' } = {}) { this.agent = agent; this.sequence = 0; }

  propose({ scene, evidence, fields = {}, reason, provider = null }) {
    if (!scene?.sceneId || !Number.isInteger(scene?.revision)) throw new TypeError('scene with sceneId/revision is required');
    if (!evidence?.id || !evidence?.sourceRevisionId) throw new TypeError('evidence id/sourceRevisionId are required');
    const normalized = {};
    for (const [name, field] of Object.entries(fields)) {
      const observationClass = field.observationClass ?? ObservationClass.UNKNOWN;
      normalized[name] = {
        ...field,
        observationClass,
        evidenceRefs: observationClass === ObservationClass.UNKNOWN ? [...(field.evidenceRefs ?? [])] : [...new Set([...(field.evidenceRefs ?? []), evidence.id])],
        provenance: [...new Set([...(field.provenance ?? []), `${this.agent}:${evidence.id}`])],
      };
    }
    this.sequence += 1;
    return createSceneObservationProposal({
      proposalId: `scene-proposal:${scene.sceneId}:${scene.revision}:${this.sequence}`,
      sceneId: scene.sceneId,
      baseRevision: scene.revision,
      sourceRevisionRefs: [evidence.sourceRevisionId],
      evidenceRefs: [evidence.id],
      fields: normalized,
      reason,
      provider,
    });
  }
}
