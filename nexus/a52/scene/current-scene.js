import { ObservationClass, createSceneSnapshot, createFieldState } from './contracts.js';

const clone = (value) => structuredClone(value);

export function createCurrentScene(options) {
  return createSceneSnapshot(options);
}

export function scenePublicView(scene) {
  const fields = {};
  for (const [key, field] of Object.entries(scene.fields)) {
    fields[key] = {
      value: clone(field.value), confidence: field.confidence, evidenceRefs: [...field.evidenceRefs], observationClass: field.observationClass, revision: field.revision,
    };
  }
  return {
    sceneId: scene.sceneId,
    revision: scene.revision,
    lifecycle: scene.lifecycle,
    sourceRange: clone(scene.sourceRange),
    sourceRevisionRefs: [...scene.sourceRevisionRefs],
    fields,
    unresolvedFields: [...scene.unresolvedFields],
    warnings: clone(scene.warnings ?? []),
    health: clone(scene.health ?? { status: 'ready', reasons: [] }),
  };
}

export function replaceField(scene, fieldName, fieldState) {
  const next = clone(scene);
  next.fields[fieldName] = createFieldState({ ...fieldState, revision: scene.revision + 1 });
  next.revision = scene.revision + 1;
  next.updatedAt = Date.now();
  if (next.fields[fieldName].observationClass === ObservationClass.UNRESOLVED || next.fields[fieldName].observationClass === ObservationClass.UNKNOWN) {
    next.unresolvedFields = [...new Set([...next.unresolvedFields, fieldName])];
  } else {
    next.unresolvedFields = next.unresolvedFields.filter((name) => name !== fieldName);
  }
  return next;
}
