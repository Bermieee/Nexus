import { BoundaryType, createBoundaryCandidate } from './contracts.js';

const DEFAULT_WEIGHTS = Object.freeze({ locationTransition:.8, majorTimeJump:.85, sleepWake:.9, explicitBreak:1, castReplacement:.55, combatTransition:.45, objectiveResolution:.4, travelComplete:.8, flashback:.95, parallel:.95, discontinuity:.75, doorway:.12 });
const TYPE_BY_SIGNAL = Object.freeze({ locationTransition:BoundaryType.LOCATION, majorTimeJump:BoundaryType.TIME_JUMP, sleepWake:BoundaryType.SLEEP_WAKE, explicitBreak:BoundaryType.EXPLICIT_BREAK, castReplacement:BoundaryType.CAST_REPLACEMENT, combatTransition:BoundaryType.COMBAT, objectiveResolution:BoundaryType.OBJECTIVE, travelComplete:BoundaryType.TRAVEL_COMPLETE, flashback:BoundaryType.FLASHBACK, parallel:BoundaryType.PARALLEL, discontinuity:BoundaryType.DISCONTINUITY });

export class SemanticBoundaryDetector {
  constructor({ weights = DEFAULT_WEIGHTS, emitThreshold = .25 } = {}) { this.weights = { ...DEFAULT_WEIGHTS, ...weights }; this.emitThreshold = emitThreshold; this.counter = 0; }

  detect({ sceneId, evidenceRefs = [], sourcePosition = null, signals = {} }) {
    const normalized = [];
    let complement = 1;
    let strongest = null;
    for (const [name, raw] of Object.entries(signals)) {
      if (!raw) continue;
      const strength = typeof raw === 'number' ? raw : Number(raw.strength ?? 1);
      const weight = (this.weights[name] ?? .25) * Math.max(0, Math.min(1, strength));
      normalized.push({ name, strength, weight, evidenceRefs: raw?.evidenceRefs ?? evidenceRefs });
      complement *= (1 - Math.max(0, Math.min(1, weight)));
      if (!strongest || weight > strongest.weight) strongest = { name, weight };
    }
    const confidence = 1 - complement;
    if (confidence < this.emitThreshold) return null;
    const explicitTransition = Boolean(signals.explicitBreak || signals.flashback || signals.parallel || signals.sleepWake || signals.majorTimeJump?.explicit);
    const type = normalized.filter((x) => x.weight >= .4).length > 1 ? BoundaryType.MIXED : (TYPE_BY_SIGNAL[strongest?.name] ?? BoundaryType.MIXED);
    this.counter += 1;
    return createBoundaryCandidate({ candidateId:`boundary:${sceneId}:${this.counter}`, sceneId, signals:normalized, evidenceRefs:[...new Set([...evidenceRefs, ...normalized.flatMap((x) => x.evidenceRefs ?? [])])], confidence, proposedBoundaryType:type, sourcePosition, explicitTransition });
  }
}
