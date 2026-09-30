// Nexus-local compatibility contract for isolated Area-52 capability cores.
// Deliberately excludes Area-52 owner/runtime/publication/settlement orchestration.
const freeze=(value)=>Object.freeze(value);

export const KnowledgeStatus=freeze({
  CURRENT:'CURRENT',
  HISTORICAL:'HISTORICAL',
  SUPERSEDED:'SUPERSEDED',
  CONTRADICTED:'CONTRADICTED',
  UNRESOLVED:'UNRESOLVED',
  UNCERTAIN:'UNCERTAIN',
  SOURCE_CANON:'SOURCE_CANON',
  INFERRED:'INFERRED',
});
export const AuthorityClass=freeze({
  OPERATOR:'OPERATOR',
  SOURCE_CANON:'SOURCE_CANON',
  OBSERVED:'OBSERVED',
  SETTLED:'SETTLED',
  INFERRED:'INFERRED',
  UNRESOLVED:'UNRESOLVED',
});
export const MutationType=freeze({SET_CLAIM:'SET_CLAIM',CLOSE_SLOT:'CLOSE_SLOT'});
export const SettlementOutcome=freeze({SETTLED:'SETTLED',REJECTED:'REJECTED',STALE:'STALE',FAILED:'FAILED'});

const STATUS=new Set(Object.values(KnowledgeStatus));
const AUTHORITIES=new Set(Object.values(AuthorityClass));
const MUTATIONS=new Set(Object.values(MutationType));
const OUTCOMES=new Set(Object.values(SettlementOutcome));

function requiredString(value,name){
  if(typeof value!=='string'||!value.length) throw new TypeError(`${name} must be a non-empty string`);
  return value;
}
function stringArray(value,name){
  if(!Array.isArray(value)||value.some(x=>typeof x!=='string')) throw new TypeError(`${name} must be an array of strings`);
  return [...value];
}
function oneOf(value,set,name){
  if(!set.has(value)) throw new TypeError(`${name} has unsupported value: ${value}`);
  return value;
}
function serializable(value,name){
  try{JSON.stringify(value);return value;}catch{throw new TypeError(`${name} must be serializable`);}
}
function confidence(value,name){
  if(typeof value!=='number'||value<0||value>1) throw new TypeError(`${name} must be 0..1`);
  return value;
}

export function createProvenance({id,sourceRevisionIds=[],evidenceIds=[],derivedFromIds=[],activity,agent,invalidators=[]}={}){
  return {
    kind:'Provenance',
    id:requiredString(id,'Provenance.id'),
    sourceRevisionIds:stringArray(sourceRevisionIds,'Provenance.sourceRevisionIds'),
    evidenceIds:stringArray(evidenceIds,'Provenance.evidenceIds'),
    derivedFromIds:stringArray(derivedFromIds,'Provenance.derivedFromIds'),
    activity:requiredString(activity,'Provenance.activity'),
    agent:requiredString(agent,'Provenance.agent'),
    invalidators:stringArray(invalidators,'Provenance.invalidators'),
  };
}

export function createClaim({
  id,subjectId,predicate,value,temporal,authorityClass,confidence:cf=1,status=KnowledgeStatus.CURRENT,
  provenance,supersedes=[],contradictedBy=[],owner='WORLD_STATE',semanticKey=null,stableIdentity=null,
  identityRevisionRefs=[],claimType='FACT',slotPolicy='SINGLE',explicitness='EXPLICIT',evidenceTime=null,
}={}){
  if(!temporal||typeof temporal!=='object') throw new TypeError('Claim.temporal is required');
  return {
    kind:'Claim',
    id:requiredString(id,'Claim.id'),
    subjectId:requiredString(subjectId,'Claim.subjectId'),
    predicate:requiredString(predicate,'Claim.predicate'),
    value:serializable(structuredClone(value),'Claim.value'),
    temporal:serializable(structuredClone(temporal),'Claim.temporal'),
    authorityClass:oneOf(authorityClass,AUTHORITIES,'Claim.authorityClass'),
    confidence:confidence(cf,'Claim.confidence'),
    status:oneOf(status,STATUS,'Claim.status'),
    provenance:serializable(structuredClone(provenance),'Claim.provenance'),
    supersedes:stringArray(supersedes,'Claim.supersedes'),
    contradictedBy:stringArray(contradictedBy,'Claim.contradictedBy'),
    owner:requiredString(owner,'Claim.owner'),
    semanticKey:semanticKey===null?`${subjectId}|${predicate}|${JSON.stringify(value)}`:requiredString(semanticKey,'Claim.semanticKey'),
    stableIdentity:stableIdentity===null?null:requiredString(stableIdentity,'Claim.stableIdentity'),
    identityRevisionRefs:stringArray(identityRevisionRefs,'Claim.identityRevisionRefs'),
    claimType:requiredString(claimType,'Claim.claimType'),
    slotPolicy:requiredString(slotPolicy,'Claim.slotPolicy'),
    explicitness:requiredString(explicitness,'Claim.explicitness'),
    evidenceTime:evidenceTime===null?null:Number(evidenceTime),
  };
}

export function createMutationProposal({
  id,mutationType,owner,sourceRevisionIds=[],evidenceIds=[],freshnessRevisionIds=sourceRevisionIds,payload,status='PROPOSED',
}={}){
  return {
    kind:'MutationProposal',
    id:requiredString(id,'MutationProposal.id'),
    mutationType:oneOf(mutationType,MUTATIONS,'MutationProposal.mutationType'),
    owner:requiredString(owner,'MutationProposal.owner'),
    sourceRevisionIds:stringArray(sourceRevisionIds,'MutationProposal.sourceRevisionIds'),
    evidenceIds:stringArray(evidenceIds,'MutationProposal.evidenceIds'),
    freshnessRevisionIds:stringArray(freshnessRevisionIds,'MutationProposal.freshnessRevisionIds'),
    payload:serializable(structuredClone(payload),'MutationProposal.payload'),
    status:requiredString(status,'MutationProposal.status'),
  };
}

export function createSettlementReceipt({
  id,proposalId,owner,outcome,settledArtifactIds=[],supersededArtifactIds=[],revision,reason=null,
}={}){
  if(!Number.isInteger(revision)||revision<1) throw new TypeError('SettlementReceipt.revision must be a positive integer');
  return {
    kind:'SettlementReceipt',
    id:requiredString(id,'SettlementReceipt.id'),
    proposalId:requiredString(proposalId,'SettlementReceipt.proposalId'),
    owner:requiredString(owner,'SettlementReceipt.owner'),
    outcome:oneOf(outcome,OUTCOMES,'SettlementReceipt.outcome'),
    settledArtifactIds:stringArray(settledArtifactIds,'SettlementReceipt.settledArtifactIds'),
    supersededArtifactIds:stringArray(supersededArtifactIds,'SettlementReceipt.supersededArtifactIds'),
    revision,
    reason:reason===null?null:requiredString(reason,'SettlementReceipt.reason'),
  };
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
