export const A52Mode=Object.freeze({OFF:'OFF',SHADOW:'SHADOW',ON:'ON'});
export const A52_SYSTEMS=Object.freeze([
  'truthGate','sensoryNet','graphWalker','hotCognition','sceneIntelligence','greenRoom','scatterGather',
  'loreTemporalRules','entityIdentity','temporalStateGraph','loreOntology','loreStudy','sceneLoreHandoff','structuredValidation','promptIntegrity',
]);
export function normalizeA52Mode(value,fallback=A52Mode.OFF){
  const text=String(value??fallback).trim().toUpperCase();
  return Object.values(A52Mode).includes(text)?text:fallback;
}
export function resolveA52Modes(settings={}){
  const source=settings?.a52??settings?.area52??{};
  return Object.freeze(Object.fromEntries(A52_SYSTEMS.map(key=>[
    key,
    normalizeA52Mode(source?.[key]?.mode??source?.[key]??A52Mode.OFF),
  ])));
}
export function a52Runs(mode){return normalizeA52Mode(mode)!==A52Mode.OFF;}
export function a52Publishes(mode){return normalizeA52Mode(mode)===A52Mode.ON;}
