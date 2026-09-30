import {AuthorityClass} from './contracts.js';
import {stableHash,stableJson,utf8ByteLength} from './browser-runtime-utils.js';

const clone=(v)=>v==null?v:structuredClone(v);
const uniq=(xs)=>[...new Set((xs??[]).filter(x=>typeof x==='string'&&x.trim()).map(x=>x.trim()))].sort();
const req=(v,n)=>{if(typeof v!=='string'||!v.trim())throw new CandidateBusContractError('CANDIDATE_FIELD_REQUIRED',n+' must be a non-empty string',{field:n});return v.trim();};
const obj=(v,n)=>{if(v==null)return{};if(typeof v!=='object'||Array.isArray(v))throw new CandidateBusContractError('CANDIDATE_FIELD_INVALID',n+' must be an object',{field:n});return clone(v);};
const arr=(v,n)=>{if(v==null)return[];if(!Array.isArray(v))throw new CandidateBusContractError('CANDIDATE_FIELD_INVALID',n+' must be an array',{field:n});return clone(v);};
const finite=(v,n)=>{const x=Number(v);if(!Number.isFinite(x))throw new CandidateBusContractError('CANDIDATE_FIELD_INVALID',n+' must be finite',{field:n});return x;};
const unit=(v,n)=>{if(v==null)return null;const x=finite(v,n);if(x<0||x>1)throw new CandidateBusContractError('CANDIDATE_FIELD_INVALID',n+' must be within 0..1',{field:n});return x;};
function freezeDeep(v){if(v&&typeof v==='object'&&!Object.isFrozen(v)){for(const x of Object.values(v))freezeDeep(x);Object.freeze(v);}return v;}
const frozen=(v)=>freezeDeep(clone(v));

export const CANDIDATE_BUS_CONTRACT_VERSION='1.0.0';
export const RETRIEVAL_CHANNEL_CONTRACT_VERSION='1.0.0';
export const FUSION_POLICY_VERSION='1.0.0';

export const CandidateFreshness=Object.freeze({
  FRESH:'FRESH',STALE:'STALE',INVALID:'INVALID',UNKNOWN:'UNKNOWN',
});
export const CandidateTruthStatus=Object.freeze({
  CURRENT:'CURRENT',HISTORICAL:'HISTORICAL',SUPERSEDED:'SUPERSEDED',CONTRADICTED:'CONTRADICTED',
  UNCERTAIN:'UNCERTAIN',UNRESOLVED:'UNRESOLVED',UNKNOWN:'UNKNOWN',
});
export const RetrievalChannelHealth=Object.freeze({
  HEALTHY:'HEALTHY',DEGRADED:'DEGRADED',UNAVAILABLE:'UNAVAILABLE',STALE:'STALE',ERROR:'ERROR',
});
export const RetrievalChannelCapability=Object.freeze({
  SPARSE:'SPARSE',DENSE:'DENSE',LATE_INTERACTION:'LATE_INTERACTION',GRAPH:'GRAPH',RAPTOR:'RAPTOR',
  GRAPHRAG_COMMUNITY:'GRAPHRAG_COMMUNITY',HISTORIAN:'HISTORIAN',REFLECTION:'REFLECTION',
  CHARACTER_MEMORY:'CHARACTER_MEMORY',WORLD_STATE:'WORLD_STATE',ACTIVE_CONTINUITY:'ACTIVE_CONTINUITY',
  SPECIALIZED_STORE:'SPECIALIZED_STORE',
});

const FRESHNESS=new Set(Object.values(CandidateFreshness));
const TRUTH=new Set(Object.values(CandidateTruthStatus));
const HEALTH=new Set(Object.values(RetrievalChannelHealth));
const AUTHORITIES=new Set([...Object.values(AuthorityClass),'UNKNOWN','DERIVED']);
const CAPABILITIES=new Set(Object.values(RetrievalChannelCapability));

export class CandidateBusContractError extends Error{
  constructor(code,message,details={}){super(message);this.name='CandidateBusContractError';this.code=code;this.details=clone(details);}
}

export function compatibleContractVersion(version,expected=CANDIDATE_BUS_CONTRACT_VERSION){
  const parse=(v)=>String(v??'').match(/^(\d+)\.(\d+)\.(\d+)$/)?.slice(1).map(Number);
  const a=parse(version),b=parse(expected);return Boolean(a&&b&&a[0]===b[0]);
}

export function createRetrievalIntent({
  intentId,kind='GENERAL',query=null,entityRefs=[],relationshipRefs=[],eventRefs=[],artifactRefs=[],
  temporalConstraint=null,perspective=null,metadata={},
}={}){
  return frozen({
    kind:'RetrievalIntent',contractVersion:CANDIDATE_BUS_CONTRACT_VERSION,
    intentId:req(intentId,'RetrievalIntent.intentId'),intentKind:req(kind,'RetrievalIntent.kind'),
    query:query==null?null:String(query),entityRefs:uniq(entityRefs),relationshipRefs:uniq(relationshipRefs),
    eventRefs:uniq(eventRefs),artifactRefs:uniq(artifactRefs),temporalConstraint:clone(temporalConstraint),
    perspective:clone(perspective),metadata:obj(metadata,'RetrievalIntent.metadata'),
  });
}

export function deriveEvidenceIdentity(input={}){
  if(input.evidenceIdentity)return req(input.evidenceIdentity,'evidenceIdentity');
  const claimRefs=uniq(input.claimRefs??input.claimIds??[]);
  const eventRefs=uniq(input.eventRefs??[]);
  const relationshipRefs=uniq(input.relationshipRefs??[]);
  const representationRef=input.representationRef??input.representationId??null;
  const semanticKey=input.semanticKey??input.metadata?.semanticKey??null;
  const artifact=input.artifactRef;
  const artifactId=typeof artifact==='string'?artifact:artifact?.artifactId??artifact?.id??input.artifactId??null;
  const artifactRevision=typeof artifact==='object'?(artifact?.revision??input.artifactRevision??null):(input.artifactRevision??null);
  const sourceRevisionRefs=uniq(input.sourceRevisionRefs??input.sourceRevisionSet??[]);
  if(claimRefs.length)return 'claim:'+stableHash({claimRefs,artifactId,semanticKey},{length:32});
  if(eventRefs.length)return 'event:'+stableHash({eventRefs,artifactId,semanticKey},{length:32});
  if(relationshipRefs.length)return 'relationship:'+stableHash({relationshipRefs,artifactId,semanticKey},{length:32});
  if(semanticKey)return 'semantic:'+stableHash({semanticKey,artifactId,artifactRevision,representationRef},{length:32});
  if(representationRef)return 'representation:'+stableHash({representationRef,artifactId,artifactRevision,sourceRevisionRefs},{length:32});
  if(artifactId)return 'artifact:'+stableHash({artifactId,artifactRevision,sourceRevisionRefs},{length:32});
  if(sourceRevisionRefs.length)return 'source:'+stableHash({sourceRevisionRefs,metadataRef:input.metadata?.claimRef??input.metadata?.eventRef??null},{length:32});
  const fallback=input.candidateId??input.nominationId??input.ref;
  if(fallback)return 'candidate:'+stableHash(String(fallback),{length:32,alreadyString:true});
  throw new CandidateBusContractError('EVIDENCE_IDENTITY_UNRESOLVED','Cannot derive evidence identity without an artifact/claim/event/representation reference');
}

export function normalizeRankSignals(input={}){
  const raw=obj(input,'rankSignals'),out={};
  for(const key of Object.keys(raw).sort()){
    const value=raw[key];
    if(value==null)continue;
    if(typeof value==='number'){if(!Number.isFinite(value))throw new CandidateBusContractError('RANK_SIGNAL_INVALID','rank signal '+key+' must be finite');out[key]=value;continue;}
    if(typeof value==='boolean'||typeof value==='string'){out[key]=value;continue;}
    if(Array.isArray(value)){out[key]=clone(value).slice(0,32);continue;}
    if(typeof value==='object'){out[key]=clone(value);continue;}
    throw new CandidateBusContractError('RANK_SIGNAL_INVALID','unsupported rank signal '+key);
  }
  return frozen(out);
}

export function createChannelNomination({
  nominationId,channelId,channelVersion=RETRIEVAL_CHANNEL_CONTRACT_VERSION,candidateId=null,evidenceIdentity=null,
  artifactRef=null,artifactRevision=null,sourceRevisionRefs=[],identityRevisionRefs=[],claimRefs=[],eventRefs=[],entityRefs=[],relationshipRefs=[],
  retrievalIntentIds=[],rankSignals={},normalizedRank=null,graphMetadata=null,temporalHints=[],continuitySignals=[],
  authorityClass='UNKNOWN',truthStatusHint=CandidateTruthStatus.UNKNOWN,provenance=[],evidenceRefs=[],
  dependencyRevisions=[],freshness=CandidateFreshness.FRESH,representationRef=null,representationRevision=null,
  representationText=null,metadata={},worldRevision=null,sceneRevision=null,
}={}){
  if(!compatibleContractVersion(channelVersion,RETRIEVAL_CHANNEL_CONTRACT_VERSION))
    throw new CandidateBusContractError('CHANNEL_VERSION_INCOMPATIBLE','Unsupported retrieval channel contract version: '+channelVersion);
  if(!FRESHNESS.has(freshness))throw new CandidateBusContractError('CANDIDATE_FRESHNESS_INVALID','Unsupported freshness: '+freshness);
  if(!TRUTH.has(truthStatusHint))throw new CandidateBusContractError('CANDIDATE_TRUTH_STATUS_INVALID','Unsupported truth status: '+truthStatusHint);
  if(!AUTHORITIES.has(authorityClass))throw new CandidateBusContractError('CANDIDATE_AUTHORITY_INVALID','Unsupported authority: '+authorityClass);
  const base={candidateId,evidenceIdentity,artifactRef,artifactRevision,sourceRevisionRefs,identityRevisionRefs,claimRefs,eventRefs,entityRefs,relationshipRefs,representationRef,representationRevision,metadata};
  const identity=deriveEvidenceIdentity(base);
  return frozen({
    kind:'CandidateNomination',contractVersion:CANDIDATE_BUS_CONTRACT_VERSION,
    nominationId:req(nominationId??(String(channelId)+':'+identity),'CandidateNomination.nominationId'),
    channelId:req(channelId,'CandidateNomination.channelId'),channelVersion,
    candidateId:candidateId==null?null:String(candidateId),evidenceIdentity:identity,
    artifactRef:clone(artifactRef),artifactRevision:artifactRevision==null?null:Number(artifactRevision),
    sourceRevisionRefs:uniq(sourceRevisionRefs),identityRevisionRefs:uniq(identityRevisionRefs),claimRefs:uniq(claimRefs),eventRefs:uniq(eventRefs),
    entityRefs:uniq(entityRefs),relationshipRefs:uniq(relationshipRefs),retrievalIntentIds:uniq(retrievalIntentIds),
    rankSignals:normalizeRankSignals(rankSignals),normalizedRank:unit(normalizedRank,'CandidateNomination.normalizedRank'),
    graphMetadata:clone(graphMetadata),temporalHints:arr(temporalHints,'CandidateNomination.temporalHints'),
    continuitySignals:arr(continuitySignals,'CandidateNomination.continuitySignals'),
    authorityClass,truthStatusHint,provenance:arr(provenance,'CandidateNomination.provenance'),
    evidenceRefs:uniq(evidenceRefs),dependencyRevisions:uniq(dependencyRevisions),freshness,
    representationRef:representationRef==null?null:String(representationRef),
    representationRevision:representationRevision==null?null:Number(representationRevision),
    representationText:representationText==null?null:String(representationText),
    metadata:obj(metadata,'CandidateNomination.metadata'),
    worldRevision:worldRevision==null?null:finite(worldRevision,'CandidateNomination.worldRevision'),
    sceneRevision:sceneRevision==null?null:finite(sceneRevision,'CandidateNomination.sceneRevision'),
    authorityGranted:false,admissionAuthority:false,settlementAuthority:false,
  });
}

export function createCanonicalCandidate({
  candidateId,evidenceIdentity,artifactRef=null,artifactRevision=null,sourceRevisionRefs=[],identityRevisionRefs=[],
  claimRefs=[],eventRefs=[],entityRefs=[],relationshipRefs=[],retrievalIntentIds=[],channelNominations=[],
  rankSignals={},graphMetadata=[],temporalHints=[],continuitySignals=[],authorityClass='UNKNOWN',
  truthStatusHint=CandidateTruthStatus.UNKNOWN,provenance=[],evidenceRefs=[],dependencyRevisions=[],
  freshness=CandidateFreshness.UNKNOWN,representationRef=null,representationRevision=null,representationText=null,
  metadata={},worldRevision=null,sceneRevision=null,fusionScore=null,legacyRetrievalIntents=[],
}={}){
  if(!FRESHNESS.has(freshness))throw new CandidateBusContractError('CANDIDATE_FRESHNESS_INVALID','Unsupported freshness: '+freshness);
  if(!TRUTH.has(truthStatusHint))throw new CandidateBusContractError('CANDIDATE_TRUTH_STATUS_INVALID','Unsupported truth status: '+truthStatusHint);
  if(!AUTHORITIES.has(authorityClass))throw new CandidateBusContractError('CANDIDATE_AUTHORITY_INVALID','Unsupported authority: '+authorityClass);
  const id=req(candidateId??('candidate:'+stableHash(evidenceIdentity,{length:24,alreadyString:true})),'CanonicalCandidate.candidateId');
  const claims=uniq(claimRefs),intents=uniq(retrievalIntentIds);
  const legacyProvenance={
    id:'candidate-prov:'+id,
    sourceRevisionIds:uniq(sourceRevisionRefs),evidenceIds:uniq(evidenceRefs),derivedFromIds:uniq([typeof artifactRef==='string'?artifactRef:artifactRef?.artifactId??artifactRef?.id,representationRef].filter(Boolean)),
    activity:'CANDIDATE_BUS_FUSION',agent:'candidate-bus',invalidators:uniq([...sourceRevisionRefs,...identityRevisionRefs,...dependencyRevisions]),
  };
  return frozen({
    kind:'CanonicalRetrievalCandidate',contractVersion:CANDIDATE_BUS_CONTRACT_VERSION,candidateId:id,
    evidenceIdentity:req(evidenceIdentity,'CanonicalCandidate.evidenceIdentity'),artifactRef:clone(artifactRef),
    artifactRevision:artifactRevision==null?null:Number(artifactRevision),sourceRevisionRefs:uniq(sourceRevisionRefs),identityRevisionRefs:uniq(identityRevisionRefs),
    claimRefs:claims,eventRefs:uniq(eventRefs),entityRefs:uniq(entityRefs),relationshipRefs:uniq(relationshipRefs),
    retrievalIntentIds:intents,channelNominations:arr(channelNominations,'CanonicalCandidate.channelNominations'),
    rankSignals:normalizeRankSignals(rankSignals),graphMetadata:arr(graphMetadata,'CanonicalCandidate.graphMetadata'),
    temporalHints:arr(temporalHints,'CanonicalCandidate.temporalHints'),continuitySignals:arr(continuitySignals,'CanonicalCandidate.continuitySignals'),
    authorityClass,truthStatusHint,truthStatus:truthStatusHint,provenance:arr(provenance,'CanonicalCandidate.provenance'),
    evidenceRefs:uniq(evidenceRefs),dependencyRevisions:uniq(dependencyRevisions),freshness,
    representationRef:representationRef==null?null:String(representationRef),
    representationRevision:representationRevision==null?null:Number(representationRevision),
    representationText:representationText==null?null:String(representationText),metadata:obj(metadata,'CanonicalCandidate.metadata'),
    worldRevision:worldRevision==null?null:Number(worldRevision),sceneRevision:sceneRevision==null?null:Number(sceneRevision),
    fusionScore:fusionScore==null?null:Number(fusionScore),
    sourceType:'RETRIEVAL_CANDIDATE',sourceId:id,entityIds:uniq(entityRefs),claimIds:claims,
    scoreSignals:normalizeRankSignals(rankSignals),retrievalIntents:uniq([...intents,...legacyRetrievalIntents]),temporalStatus:truthStatusHint,
    legacyProvenance,
    authorityGranted:false,admissionAuthority:false,settlementAuthority:false,canonicalMutationAuthority:false,
  });
}

export function createFusionReceipt({
  candidateSetId,retrievalIntentIds=[],inputNominationCount=0,inputChannelCount=0,deduplicatedCandidateCount=0,
  duplicateNominationCount=0,perChannelCounts={},perIntentCounts={},boundedOutCount=0,unavailableChannels=[],
  degradedChannels=[],staleNominationCount=0,invalidNominationCount=0,revisionSet={},freshness=CandidateFreshness.UNKNOWN,
  coverageByIntent={},candidateIdsByIntent={},uncoveredIntentIds=[],prunedCandidateIds=[],fusionPolicyVersion=FUSION_POLICY_VERSION,
  diagnostics={},
}={}){
  return frozen({
    kind:'CandidateFusionReceipt',contractVersion:CANDIDATE_BUS_CONTRACT_VERSION,
    candidateSetId:req(candidateSetId,'CandidateFusionReceipt.candidateSetId'),retrievalIntentIds:uniq(retrievalIntentIds),
    inputNominationCount:Number(inputNominationCount)||0,inputChannelCount:Number(inputChannelCount)||0,
    deduplicatedCandidateCount:Number(deduplicatedCandidateCount)||0,duplicateNominationCount:Number(duplicateNominationCount)||0,
    perChannelCounts:obj(perChannelCounts,'CandidateFusionReceipt.perChannelCounts'),
    perIntentCounts:obj(perIntentCounts,'CandidateFusionReceipt.perIntentCounts'),boundedOutCount:Number(boundedOutCount)||0,
    unavailableChannels:uniq(unavailableChannels),degradedChannels:uniq(degradedChannels),
    staleNominationCount:Number(staleNominationCount)||0,invalidNominationCount:Number(invalidNominationCount)||0,
    revisionSet:obj(revisionSet,'CandidateFusionReceipt.revisionSet'),freshness,
    coverageByIntent:obj(coverageByIntent,'CandidateFusionReceipt.coverageByIntent'),
    candidateIdsByIntent:obj(candidateIdsByIntent,'CandidateFusionReceipt.candidateIdsByIntent'),
    uncoveredIntentIds:uniq(uncoveredIntentIds),prunedCandidateIds:uniq(prunedCandidateIds),
    fusionPolicyVersion:req(fusionPolicyVersion,'CandidateFusionReceipt.fusionPolicyVersion'),diagnostics:obj(diagnostics,'CandidateFusionReceipt.diagnostics'),
    authorityGranted:false,admissionAuthority:false,settlementAuthority:false,
  });
}

export function createCandidateBusEnvelope({
  candidateSetId,query=null,retrievalIntentIds=[],sourceRevisionSet=[],identityRevisionSet=[],worldRevision=0,sceneRevision=0,
  candidates=[],unavailableChannels=[],degradedChannels=[],fusionReceipt,freshness=CandidateFreshness.UNKNOWN,metadata={},
}={}){
  if(!FRESHNESS.has(freshness))throw new CandidateBusContractError('CANDIDATE_FRESHNESS_INVALID','Unsupported envelope freshness: '+freshness);
  const ids=uniq(retrievalIntentIds);
  return frozen({
    kind:'CandidateBusEnvelope',contractVersion:CANDIDATE_BUS_CONTRACT_VERSION,candidateSetId:req(candidateSetId,'CandidateBusEnvelope.candidateSetId'),
    query:query==null?null:String(query),retrievalIntentIds:ids,intentFingerprint:'intent:'+stableHash(ids,{length:24}),
    sourceRevisionSet:uniq(sourceRevisionSet),identityRevisionSet:uniq(identityRevisionSet),worldRevision:Number(worldRevision)||0,sceneRevision:Number(sceneRevision)||0,
    candidates:arr(candidates,'CandidateBusEnvelope.candidates'),candidateCount:candidates.length,
    unavailableChannels:uniq(unavailableChannels),degradedChannels:uniq(degradedChannels),fusionReceipt:clone(fusionReceipt),
    freshness,metadata:obj(metadata,'CandidateBusEnvelope.metadata'),
    authorityGranted:false,admissionAuthority:false,settlementAuthority:false,canonicalMutationAuthority:false,
  });
}

export function createRetrievalChannelDescriptor({
  channelId,channelVersion=RETRIEVAL_CHANNEL_CONTRACT_VERSION,capabilities=[],supportedIntentKinds=['GENERAL'],
  maxCandidates=64,revisionRequirements=[],health=RetrievalChannelHealth.HEALTHY,available=true,metadata={},
}={}){
  if(!compatibleContractVersion(channelVersion,RETRIEVAL_CHANNEL_CONTRACT_VERSION))
    throw new CandidateBusContractError('CHANNEL_VERSION_INCOMPATIBLE','Unsupported retrieval channel version: '+channelVersion);
  if(!HEALTH.has(health))throw new CandidateBusContractError('CHANNEL_HEALTH_INVALID','Unsupported channel health: '+health);
  const caps=uniq(capabilities);for(const cap of caps)if(!CAPABILITIES.has(cap))throw new CandidateBusContractError('CHANNEL_CAPABILITY_INVALID','Unsupported channel capability: '+cap);
  const limit=Number(maxCandidates);if(!Number.isInteger(limit)||limit<0||limit>4096)throw new CandidateBusContractError('CHANNEL_LIMIT_INVALID','maxCandidates must be 0..4096');
  return frozen({
    kind:'RetrievalChannelDescriptor',contractVersion:RETRIEVAL_CHANNEL_CONTRACT_VERSION,
    channelId:req(channelId,'RetrievalChannelDescriptor.channelId'),channelVersion,capabilities:caps,
    supportedIntentKinds:uniq(supportedIntentKinds),maxCandidates:limit,revisionRequirements:uniq(revisionRequirements),
    health,available:Boolean(available),metadata:obj(metadata,'RetrievalChannelDescriptor.metadata'),
  });
}

export function candidatePayloadBytes(candidate){return utf8ByteLength(stableJson(candidate));}
