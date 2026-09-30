// Nexus-local compatibility contract for the Area-52 cores.
// Intentionally small: do not import Area-52 owner/runtime/publication plumbing.
const freeze = (value) => Object.freeze(value);
export const KnowledgeStatus = freeze({
  CURRENT:'CURRENT',
  HISTORICAL:'HISTORICAL',
  SUPERSEDED:'SUPERSEDED',
  CONTRADICTED:'CONTRADICTED',
  UNRESOLVED:'UNRESOLVED',
  UNCERTAIN:'UNCERTAIN',
  INFERRED:'INFERRED',
});
export const AuthorityClass = freeze({
  OPERATOR:'OPERATOR',
  SOURCE_CANON:'SOURCE_CANON',
  OBSERVED:'OBSERVED',
  SETTLED:'SETTLED',
  INFERRED:'INFERRED',
  UNRESOLVED:'UNRESOLVED',
});
const STATUS = new Set(Object.values(KnowledgeStatus));
function requiredString(value,name){
  if(typeof value!=='string'||!value.length) throw new TypeError(`${name} must be a non-empty string`);
  return value;
}
function stringArray(value,name){
  if(!Array.isArray(value)||value.some(x=>typeof x!=='string')) throw new TypeError(`${name} must be an array of strings`);
  return [...value];
}
function serializable(value,name){
  try { JSON.stringify(value); return value; }
  catch { throw new TypeError(`${name} must be serializable`); }
}
export function createTruthGateResult({candidateId,classification,usableForIntent,reasons=[],claimIds=[],provenance=null}={}){
  requiredString(candidateId,'TruthGateResult.candidateId');
  if(!STATUS.has(classification)) throw new TypeError('TruthGateResult.classification is invalid');
  return Object.freeze({
    kind:'TruthGateResult',
    candidateId,
    classification,
    usableForIntent:Boolean(usableForIntent),
    reasons:stringArray(reasons,'TruthGateResult.reasons'),
    claimIds:stringArray(claimIds,'TruthGateResult.claimIds'),
    provenance:serializable(structuredClone(provenance),'TruthGateResult.provenance'),
  });
}
