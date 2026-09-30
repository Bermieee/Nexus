import { AuthorityClass } from './contracts.js';

const freezeDeep=(value)=>{if(value&&typeof value==='object'&&!Object.isFrozen(value)){for(const child of Object.values(value))freezeDeep(child);Object.freeze(value);}return value;};
const clone=(value)=>value==null?value:structuredClone(value);
const uniq=(values)=>[...new Set((values??[]).filter(Boolean).map(String))].sort();
const req=(value,name)=>{if(typeof value!=='string'||!value.trim())throw new KnowledgeContractError('KNOWLEDGE_FIELD_REQUIRED',name+' must be a non-empty string',{field:name});return value.trim();};
const optionalString=(value,name)=>value==null?null:req(value,name);
const serial=(value,name)=>{try{JSON.stringify(value);}catch{throw new KnowledgeContractError('KNOWLEDGE_NOT_SERIALIZABLE',name+' must be JSON-serializable',{field:name});}return clone(value);};
const unit=(value,name)=>{if(value==null)return null;const n=Number(value);if(!Number.isFinite(n)||n<0||n>1)throw new KnowledgeContractError('KNOWLEDGE_CONFIDENCE_INVALID',name+' must be within 0..1',{field:name});return n;};

export const KNOWLEDGE_EVIDENCE_CONTRACT_VERSION='1.0.0';
export const KnowledgeSourceClass=Object.freeze({
  SOURCE_LORE:'SOURCE_LORE',
  OBSERVED_EXPERIENCE:'OBSERVED_EXPERIENCE',
  EPISODIC_MEMORY:'EPISODIC_MEMORY',
  REFLECTION:'REFLECTION',
  TEMPORAL_STATE:'TEMPORAL_STATE',
  SCENE_EPISODE:'SCENE_EPISODE',
  DERIVED_REPRESENTATION:'DERIVED_REPRESENTATION',
  RETRIEVAL_CANDIDATE:'RETRIEVAL_CANDIDATE',
});
export const KnowledgeTemporalStatus=Object.freeze({
  CURRENT:'CURRENT',HISTORICAL:'HISTORICAL',SUPERSEDED:'SUPERSEDED',
  CONTRADICTED:'CONTRADICTED',UNCERTAIN:'UNCERTAIN',UNRESOLVED:'UNRESOLVED',
});
export const KnowledgeAuthorityOrigin=Object.freeze({
  SOURCE:'SOURCE',OBSERVATION:'OBSERVATION',SETTLEMENT:'SETTLEMENT',INFERENCE:'INFERENCE',CARRIED:'CARRIED',
});
export const KnowledgeFreshness=Object.freeze({FRESH:'FRESH',STALE:'STALE',INVALID:'INVALID'});
export const KnowledgeMeasurementState=Object.freeze({MEASURED:'MEASURED',REPLAYED:'REPLAYED',NOT_MEASURED:'NOT_MEASURED',NOT_APPLICABLE:'NOT_APPLICABLE'});

const SOURCES=new Set(Object.values(KnowledgeSourceClass));
const TEMPORAL=new Set(Object.values(KnowledgeTemporalStatus));
const AUTHORITIES=new Set(Object.values(AuthorityClass));
const ORIGINS=new Set(Object.values(KnowledgeAuthorityOrigin));
const KNOWN_FIELDS=new Set([
  'kind','contractVersion','schemaVersion','evidenceId','evidenceIdentity','artifactRef','sourceClass','authorityClass','authorityOrigin','sourceAuthorityClass',
  'temporalStatus','sourceRevisionRefs','dependencyRevisionRefs','provenanceRefs','currentApplicability','confidence','retrievalMetadata',
  'candidateLineage','contradictionSetId','hypothesisSetId','sceneRef','memoryRef','loreRef','claimIds','semantic','hardRule','extensions',
  'authorityGranted','settlementAuthority','canonicalMutationAuthority','treePlacementAuthority','providerAuthority',
]);

export class KnowledgeContractError extends TypeError{
  constructor(code,message,details={}){super(message);this.name='KnowledgeContractError';this.code=code;this.details=clone(details);}
}

export function parseKnowledgeContractVersion(value){
  if(typeof value!=='string'||!/^\d+(?:\.\d+){0,2}$/.test(value))return null;
  const [major=0,minor=0,patch=0]=value.split('.').map(Number);
  return{raw:value,major,minor,patch};
}

export function knowledgeContractCompatibility(version=KNOWLEDGE_EVIDENCE_CONTRACT_VERSION){
  const incoming=parseKnowledgeContractVersion(version),current=parseKnowledgeContractVersion(KNOWLEDGE_EVIDENCE_CONTRACT_VERSION);
  if(!incoming)return{compatible:false,state:'INVALID_VERSION',version};
  if(incoming.major!==current.major)return{compatible:false,state:'INCOMPATIBLE_MAJOR',version,currentVersion:KNOWLEDGE_EVIDENCE_CONTRACT_VERSION};
  return{compatible:true,state:incoming.minor===current.minor&&incoming.patch===current.patch?'EXACT':'COMPATIBLE_MINOR',version,currentVersion:KNOWLEDGE_EVIDENCE_CONTRACT_VERSION};
}

export function normalizeKnowledgeAuthority(value){
  if(value==='DERIVED')return AuthorityClass.INFERRED;
  if(value==='UNKNOWN'||value==null)return AuthorityClass.UNRESOLVED;
  return value;
}

function validateAuthority({sourceClass,authorityClass,authorityOrigin,sourceAuthorityClass,input}){
  if(input.authorityGranted===true||input.settlementAuthority===true||input.canonicalMutationAuthority===true||input.treePlacementAuthority===true||input.providerAuthority===true){
    throw new KnowledgeContractError('KNOWLEDGE_AUTHORITY_ESCALATION','Knowledge evidence cannot grant authority',{sourceClass,authorityClass});
  }
  if(!AUTHORITIES.has(authorityClass))throw new KnowledgeContractError('KNOWLEDGE_AUTHORITY_UNSUPPORTED','Unsupported authorityClass: '+authorityClass,{authorityClass});
  if(!ORIGINS.has(authorityOrigin))throw new KnowledgeContractError('KNOWLEDGE_AUTHORITY_ORIGIN_UNSUPPORTED','Unsupported authorityOrigin: '+authorityOrigin,{authorityOrigin});

  if(sourceClass===KnowledgeSourceClass.SOURCE_LORE){
    if(authorityClass!==AuthorityClass.SOURCE_CANON||authorityOrigin!==KnowledgeAuthorityOrigin.SOURCE)
      throw new KnowledgeContractError('KNOWLEDGE_AUTHORITY_ESCALATION','Exact source lore must carry SOURCE_CANON from SOURCE origin');
  }
  if(sourceClass===KnowledgeSourceClass.OBSERVED_EXPERIENCE){
    if(authorityClass!==AuthorityClass.OBSERVED||authorityOrigin!==KnowledgeAuthorityOrigin.OBSERVATION)
      throw new KnowledgeContractError('KNOWLEDGE_AUTHORITY_ESCALATION','Observed experience must carry OBSERVED from OBSERVATION origin');
  }
  if(sourceClass===KnowledgeSourceClass.REFLECTION){
    if(![AuthorityClass.INFERRED,AuthorityClass.UNRESOLVED].includes(authorityClass)||authorityOrigin!==KnowledgeAuthorityOrigin.INFERENCE)
      throw new KnowledgeContractError('KNOWLEDGE_AUTHORITY_ESCALATION','Reflection cannot claim observed, source-canon, or settled authority');
  }
  if(sourceClass===KnowledgeSourceClass.DERIVED_REPRESENTATION){
    if([AuthorityClass.SOURCE_CANON,AuthorityClass.OBSERVED,AuthorityClass.SETTLED,AuthorityClass.OPERATOR].includes(authorityClass))
      throw new KnowledgeContractError('KNOWLEDGE_AUTHORITY_ESCALATION','Derived representation cannot manufacture source, observed, settled, or operator authority');
  }
  if(authorityOrigin===KnowledgeAuthorityOrigin.CARRIED){
    if(!sourceAuthorityClass)throw new KnowledgeContractError('KNOWLEDGE_SOURCE_AUTHORITY_REQUIRED','Carried authority requires sourceAuthorityClass');
    const normalized=normalizeKnowledgeAuthority(sourceAuthorityClass);
    if(normalized!==authorityClass)throw new KnowledgeContractError('KNOWLEDGE_AUTHORITY_ESCALATION','Carried authority must exactly match source authority',{sourceAuthorityClass:normalized,authorityClass});
  }
  if(authorityClass===AuthorityClass.SETTLED&&![
    KnowledgeAuthorityOrigin.SETTLEMENT,KnowledgeAuthorityOrigin.CARRIED,
  ].includes(authorityOrigin))throw new KnowledgeContractError('KNOWLEDGE_AUTHORITY_ESCALATION','SETTLED authority requires Settlement or a carried SETTLED source');
  if(authorityClass===AuthorityClass.SOURCE_CANON&&![
    KnowledgeAuthorityOrigin.SOURCE,KnowledgeAuthorityOrigin.CARRIED,
  ].includes(authorityOrigin))throw new KnowledgeContractError('KNOWLEDGE_AUTHORITY_ESCALATION','SOURCE_CANON authority requires exact source or carried source authority');
  if(authorityClass===AuthorityClass.OBSERVED&&![
    KnowledgeAuthorityOrigin.OBSERVATION,KnowledgeAuthorityOrigin.CARRIED,
  ].includes(authorityOrigin))throw new KnowledgeContractError('KNOWLEDGE_AUTHORITY_ESCALATION','OBSERVED authority requires observation or carried observed authority');
}

function normalizeSemantic(value){
  if(value==null)return null;
  if(typeof value!=='object'||Array.isArray(value))throw new KnowledgeContractError('KNOWLEDGE_SEMANTIC_INVALID','semantic must be an object');
  return serial(value,'KnowledgeEvidence.semantic');
}
function evidenceIdentity(input,artifactRef,sourceRevisionRefs,semantic){
  if(input.evidenceIdentity)return req(input.evidenceIdentity,'KnowledgeEvidence.evidenceIdentity');
  const artifact=typeof artifactRef==='string'?artifactRef:JSON.stringify(artifactRef);
  const sem=semantic?JSON.stringify([semantic.subjectId??null,semantic.predicate??null,semantic.value??null,semantic.status??null]):'';
  return [artifact,sourceRevisionRefs.join('|'),sem].join('#');
}

export function createKnowledgeEvidence(input={}){
  if(!input||typeof input!=='object'||Array.isArray(input))throw new KnowledgeContractError('KNOWLEDGE_SCHEMA_INVALID','KnowledgeEvidence input must be an object');
  const version=String(input.contractVersion??input.schemaVersion??KNOWLEDGE_EVIDENCE_CONTRACT_VERSION);
  const compatibility=knowledgeContractCompatibility(version);
  if(!compatibility.compatible)throw new KnowledgeContractError(
    compatibility.state==='INCOMPATIBLE_MAJOR'?'KNOWLEDGE_CONTRACT_INCOMPATIBLE_MAJOR':'KNOWLEDGE_CONTRACT_VERSION_INVALID',
    'Unsupported KnowledgeEvidence contract version: '+version,compatibility,
  );
  const sourceClass=req(input.sourceClass,'KnowledgeEvidence.sourceClass');
  if(!SOURCES.has(sourceClass))throw new KnowledgeContractError('KNOWLEDGE_SOURCE_CLASS_UNSUPPORTED','Unsupported sourceClass: '+sourceClass);
  if(input.authorityClass==null)throw new KnowledgeContractError('KNOWLEDGE_AUTHORITY_REQUIRED','KnowledgeEvidence.authorityClass is required');
  const authorityClass=normalizeKnowledgeAuthority(input.authorityClass);
  const authorityOrigin=req(input.authorityOrigin??KnowledgeAuthorityOrigin.CARRIED,'KnowledgeEvidence.authorityOrigin');
  const sourceAuthorityClass=input.sourceAuthorityClass==null?null:normalizeKnowledgeAuthority(input.sourceAuthorityClass);
  const temporalStatus=req(input.temporalStatus,'KnowledgeEvidence.temporalStatus');
  if(!TEMPORAL.has(temporalStatus))throw new KnowledgeContractError('KNOWLEDGE_TEMPORAL_STATUS_UNSUPPORTED','Unsupported temporalStatus: '+temporalStatus,{temporalStatus});
  validateAuthority({sourceClass,authorityClass,authorityOrigin,sourceAuthorityClass,input});

  const sourceRevisionRefs=uniq(input.sourceRevisionRefs);
  const dependencyRevisionRefs=uniq(input.dependencyRevisionRefs);
  const provenanceRefs=uniq(input.provenanceRefs);
  const semantic=normalizeSemantic(input.semantic);
  const artifactRef=input.artifactRef==null?null:serial(input.artifactRef,'KnowledgeEvidence.artifactRef');
  if(artifactRef==null)throw new KnowledgeContractError('KNOWLEDGE_ARTIFACT_REQUIRED','KnowledgeEvidence.artifactRef is required');

  const extensions={...(serial(input.extensions??{},'KnowledgeEvidence.extensions')??{})};
  for(const [key,value] of Object.entries(input))if(!KNOWN_FIELDS.has(key))extensions[key]=serial(value,'KnowledgeEvidence.'+key);

  return freezeDeep({
    kind:'KnowledgeEvidence',
    contractVersion:KNOWLEDGE_EVIDENCE_CONTRACT_VERSION,
    receivedContractVersion:version,
    evidenceId:req(input.evidenceId,'KnowledgeEvidence.evidenceId'),
    evidenceIdentity:evidenceIdentity(input,artifactRef,sourceRevisionRefs,semantic),
    artifactRef,
    sourceClass,
    authorityClass,
    authorityOrigin,
    sourceAuthorityClass,
    temporalStatus,
    sourceRevisionRefs,
    dependencyRevisionRefs,
    provenanceRefs,
    currentApplicability:input.currentApplicability==null?null:Boolean(input.currentApplicability),
    confidence:unit(input.confidence,'KnowledgeEvidence.confidence'),
    retrievalMetadata:serial(input.retrievalMetadata??{},'KnowledgeEvidence.retrievalMetadata'),
    candidateLineage:serial(input.candidateLineage??{},'KnowledgeEvidence.candidateLineage'),
    contradictionSetId:optionalString(input.contradictionSetId,'KnowledgeEvidence.contradictionSetId'),
    hypothesisSetId:optionalString(input.hypothesisSetId,'KnowledgeEvidence.hypothesisSetId'),
    sceneRef:input.sceneRef==null?null:serial(input.sceneRef,'KnowledgeEvidence.sceneRef'),
    memoryRef:input.memoryRef==null?null:serial(input.memoryRef,'KnowledgeEvidence.memoryRef'),
    loreRef:input.loreRef==null?null:serial(input.loreRef,'KnowledgeEvidence.loreRef'),
    claimIds:uniq(input.claimIds),
    semantic,
    hardRule:Boolean(input.hardRule),
    extensions:freezeDeep(extensions),
    authorityGranted:false,
    settlementAuthority:false,
    canonicalMutationAuthority:false,
  });
}

export function classifyKnowledgeEvidenceFreshness(evidence,{activeSourceRevisionRefs=null,activeDependencyRevisionRefs=null}={}){
  if(!evidence||evidence.kind!=='KnowledgeEvidence')return KnowledgeFreshness.INVALID;
  if(activeSourceRevisionRefs!==null){
    const active=new Set(activeSourceRevisionRefs);
    if(evidence.sourceRevisionRefs.some(ref=>!active.has(ref)))return KnowledgeFreshness.STALE;
  }
  if(activeDependencyRevisionRefs!==null){
    const active=new Set(activeDependencyRevisionRefs);
    if(evidence.dependencyRevisionRefs.some(ref=>!active.has(ref)))return KnowledgeFreshness.STALE;
  }
  return KnowledgeFreshness.FRESH;
}

function mergeArrays(a,b){return uniq([...(a??[]),...(b??[])]);}
function mergeLineage(a={},b={}){
  return{
    ...clone(a),...clone(b),
    nominationChannels:mergeArrays(a.nominationChannels,b.nominationChannels),
    candidateRefs:mergeArrays(a.candidateRefs,b.candidateRefs),
    evidenceRefs:mergeArrays(a.evidenceRefs,b.evidenceRefs),
  };
}
export function dedupeKnowledgeEvidence(values=[]){
  const byIdentity=new Map();let duplicateNominations=0;
  for(const raw of values){
    const item=raw?.kind==='KnowledgeEvidence'?raw:createKnowledgeEvidence(raw);
    const prior=byIdentity.get(item.evidenceIdentity);
    if(!prior){byIdentity.set(item.evidenceIdentity,clone(item));continue;}
    if(prior.authorityClass!==item.authorityClass||prior.temporalStatus!==item.temporalStatus)
      throw new KnowledgeContractError('KNOWLEDGE_DUPLICATE_CONFLICT','Duplicate evidence identity disagrees on authority or temporal status',{evidenceIdentity:item.evidenceIdentity});
    duplicateNominations++;
    prior.sourceRevisionRefs=mergeArrays(prior.sourceRevisionRefs,item.sourceRevisionRefs);
    prior.dependencyRevisionRefs=mergeArrays(prior.dependencyRevisionRefs,item.dependencyRevisionRefs);
    prior.provenanceRefs=mergeArrays(prior.provenanceRefs,item.provenanceRefs);
    prior.claimIds=mergeArrays(prior.claimIds,item.claimIds);
    prior.candidateLineage=mergeLineage(prior.candidateLineage,item.candidateLineage);
    prior.retrievalMetadata={...prior.retrievalMetadata,...clone(item.retrievalMetadata)};
    prior.confidence=prior.confidence==null?item.confidence:item.confidence==null?prior.confidence:Math.max(prior.confidence,item.confidence);
  }
  return freezeDeep({kind:'KnowledgeEvidenceDeduplication',evidence:[...byIdentity.values()].map(freezeDeep),duplicateNominations});
}

export function createDependencyInvalidationReceipt({
  receiptId,changedSourceRevisionRef,directlyStaleArtifactRefs=[],transitivelyStaleArtifactRefs=[],preservedArtifactRefs=[],
  reason='SOURCE_REVISION_CHANGED',dependencyGraphRevision=null,
}={}){
  const direct=uniq(directlyStaleArtifactRefs),directSet=new Set(direct);
  const transitive=uniq(transitivelyStaleArtifactRefs).filter(x=>!directSet.has(x));
  const stale=new Set([...direct,...transitive]);
  const preserved=uniq(preservedArtifactRefs).filter(x=>!stale.has(x));
  return freezeDeep({
    kind:'DependencyInvalidationReceipt',contractVersion:'1.0.0',
    receiptId:req(receiptId,'DependencyInvalidationReceipt.receiptId'),
    changedSourceRevisionRef:req(changedSourceRevisionRef,'DependencyInvalidationReceipt.changedSourceRevisionRef'),
    directlyStaleArtifactRefs:direct,transitivelyStaleArtifactRefs:transitive,preservedArtifactRefs:preserved,
    reason:req(reason,'DependencyInvalidationReceipt.reason'),dependencyGraphRevision:dependencyGraphRevision==null?null:Number(dependencyGraphRevision),
    invalidatedCount:direct.length+transitive.length,preservedCount:preserved.length,wholeWorldInvalidation:false,
  });
}

export function createKnowledgeDisagreementSet({setId,evidence=[]}={}){
  const rows=evidence.map(x=>x?.kind==='KnowledgeEvidence'?x:createKnowledgeEvidence(x));
  const values=new Set(rows.map(x=>JSON.stringify(x.semantic?.value??x.artifactRef)));
  const statuses=new Set(rows.map(x=>x.temporalStatus));
  const temporalOnly=values.size>1&&rows.some(x=>x.temporalStatus===KnowledgeTemporalStatus.CURRENT)&&rows.some(x=>[KnowledgeTemporalStatus.HISTORICAL,KnowledgeTemporalStatus.SUPERSEDED].includes(x.temporalStatus));
  const hasExplicitUnresolved=rows.some(x=>[KnowledgeTemporalStatus.CONTRADICTED,KnowledgeTemporalStatus.UNCERTAIN,KnowledgeTemporalStatus.UNRESOLVED].includes(x.temporalStatus));
  const resolutionStatus=values.size<=1?'COMPATIBLE':temporalOnly&&!hasExplicitUnresolved?'PRESERVE_TEMPORAL_DISTINCTION':'UNRESOLVED';
  return freezeDeep({kind:'KnowledgeDisagreementSet',setId:req(setId,'KnowledgeDisagreementSet.setId'),evidenceIds:rows.map(x=>x.evidenceId).sort(),statuses:[...statuses].sort(),resolutionStatus,winner:null,automaticAuthorityPromotion:false});
}

export function createKnowledgePerformanceFixture({
  fixtureId,candidateCount=0,derivedArtifactCount=0,invalidatedArtifactCount=0,unaffectedReuse=0,provenanceDepth=0,
  contextAdmissionCount=0,sealedByteCount=0,knowledgeTraceSize=0,state=KnowledgeMeasurementState.NOT_MEASURED,evidenceRefs=[],
}={}){
  if(!Object.values(KnowledgeMeasurementState).includes(state))throw new KnowledgeContractError('KNOWLEDGE_MEASUREMENT_STATE_INVALID','Unsupported measurement state: '+state);
  const measured=![
    KnowledgeMeasurementState.NOT_MEASURED,KnowledgeMeasurementState.NOT_APPLICABLE,
  ].includes(state);
  const metric=(value)=>({state,value:measured?Number(value):null,evidenceRefs:uniq(evidenceRefs)});
  return freezeDeep({kind:'KnowledgePerformanceFixture',fixtureId:req(fixtureId,'KnowledgePerformanceFixture.fixtureId'),candidateCount:metric(candidateCount),derivedArtifactCount:metric(derivedArtifactCount),invalidatedArtifactCount:metric(invalidatedArtifactCount),unaffectedReuse:metric(unaffectedReuse),provenanceDepth:metric(provenanceDepth),contextAdmissionCount:metric(contextAdmissionCount),sealedByteCount:metric(sealedByteCount),knowledgeTraceSize:metric(knowledgeTraceSize)});
}
