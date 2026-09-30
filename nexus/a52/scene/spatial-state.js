import { ObservationClass, createFieldState } from './contracts.js';

export class SpatialStateTracker {
  update({ previous, revision, evidenceRefs = [], proposal = {} }) {
    const classification = proposal.observationClass ?? ObservationClass.UNKNOWN;
    const location = proposal.location ?? previous?.value?.location ?? null;
    const value = {
      location,
      subLocation: proposal.subLocation ?? previous?.value?.subLocation ?? null,
      relation: proposal.relation ?? null,
      transition: proposal.transition ?? null,
      containment: proposal.containment ?? null,
      proximity: proposal.proximity ?? null,
    };
    return createFieldState({
      value,
      confidence: proposal.confidence ?? (classification === ObservationClass.UNKNOWN ? 0 : .5),
      evidenceRefs,
      observationClass: classification,
      revision,
      metadata: { viewedOnly: Boolean(proposal.viewedOnly), impossibleTransition: Boolean(proposal.impossibleTransition), contradictsAccumulatedLocation: Boolean(proposal.contradictsAccumulatedLocation) },
    });
  }

  viewedLocation({ previous, viewedLocation, revision, evidenceRefs = [] }) {
    return this.update({ previous, revision, evidenceRefs, proposal: { location: previous?.value?.location ?? null, relation: { viewedLocation }, viewedOnly: true, observationClass: previous?.observationClass ?? ObservationClass.UNKNOWN, confidence: previous?.confidence ?? 0 } });
  }
}
