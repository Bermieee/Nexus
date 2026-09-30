import {
  CandidateFreshness,CandidateTruthStatus,FUSION_POLICY_VERSION,CANDIDATE_BUS_CONTRACT_VERSION,CandidateBusContractError,
  compatibleContractVersion,createChannelNomination,createCanonicalCandidate,createFusionReceipt,createCandidateBusEnvelope,
  candidatePayloadBytes,
} from './candidate-bus-contracts.js';
import {stableHash,stableJson,utf8ByteLength} from './browser-runtime-utils.js';

const clone=(v)=>v==null?v:structuredClone(v);
const uniq=(xs)=>[...new Set((xs??[]).filter(x=>typeof x==='string'&&x.trim()).map(x=>x.trim()))].sort();
const frozen=(v)=>{const c=clone(v);const f=(x)=>{if(x&&typeof x==='object'&&!Object.isFrozen(x)){for(const y of Object.values(x))f(y);Object.freeze(x);}return x;};return f(c);};
const byKey=(a,b)=>String(a.nominationId).localeCompare(String(b.nominationId));
const num=(v,d=0)=>Number.isFinite(Number(v))?Number(v):d;

export const DEFAULT_CANDIDATE_BUS_LIMITS=Object.freeze({
  maxPerIntent:64,maxPerChannel:128,maxPerChannelIntent:32,maxTotalCandidates:256,
  maxNominationRecordsPerCandidate:16,maxGraphPathsPerCandidate:8,maxProvenanceRefsPerCandidate:64,
  maxEvidenceRefsPerCandidate:64,maxMetadataBytesPerCandidate:4096,maxRepresentationChars:1600,maxReceiptHistory:128,
});

function boundedInt(value,min,max,name){const n=Number(value);if(!Number.isInteger(n)||n<min||n>max)throw new CandidateBusContractError('CANDIDATE_LIMIT_INVALID',name+' must be '+min+'..'+max);return n;}
function limits(input={}){
  const d=DEFAULT_CANDIDATE_BUS_LIMITS;
  return Object.freeze({
    maxPerIntent:boundedInt(input.maxPerIntent??d.maxPerIntent,1,4096,'maxPerIntent'),
    maxPerChannel:boundedInt(input.maxPerChannel??d.maxPerChannel,1,8192,'maxPerChannel'),
    maxPerChannelIntent:boundedInt(input.maxPerChannelIntent??d.maxPerChannelIntent,1,4096,'maxPerChannelIntent'),
    maxTotalCandidates:boundedInt(input.maxTotalCandidates??d.maxTotalCandidates,1,4096,'maxTotalCandidates'),
    maxNominationRecordsPerCandidate:boundedInt(input.maxNominationRecordsPerCandidate??d.maxNominationRecordsPerCandidate,1,128,'maxNominationRecordsPerCandidate'),
    maxGraphPathsPerCandidate:boundedInt(input.maxGraphPathsPerCandidate??d.maxGraphPathsPerCandidate,0,128,'maxGraphPathsPerCandidate'),
    maxProvenanceRefsPerCandidate:boundedInt(input.maxProvenanceRefsPerCandidate??d.maxProvenanceRefsPerCandidate,1,1024,'maxProvenanceRefsPerCandidate'),
    maxEvidenceRefsPerCandidate:boundedInt(input.maxEvidenceRefsPerCandidate??d.maxEvidenceRefsPerCandidate,1,1024,'maxEvidenceRefsPerCandidate'),
    maxMetadataBytesPerCandidate:boundedInt(input.maxMetadataBytesPerCandidate??d.maxMetadataBytesPerCandidate,64,65536,'maxMetadataBytesPerCandidate'),
    maxRepresentationChars:boundedInt(input.maxRepresentationChars??d.maxRepresentationChars,0,8192,'maxRepresentationChars'),
    maxReceiptHistory:boundedInt(input.maxReceiptHistory??d.maxReceiptHistory,0,4096,'maxReceiptHistory'),
  });
}
function uniqueObjects(values=[],max=64){const map=new Map();for(const value of values){const key=stableJson(value);if(!map.has(key))map.set(key,clone(value));}return [...map.values()].sort((a,b)=>stableJson(a).localeCompare(stableJson(b))).slice(0,max);}
function nominationSignature(n){return stableHash({
  channelId:n.channelId,evidenceIdentity:n.evidenceIdentity,artifactRef:n.artifactRef,artifactRevision:n.artifactRevision,
  sourceRevisionRefs:n.sourceRevisionRefs,identityRevisionRefs:n.identityRevisionRefs,claimRefs:n.claimRefs,eventRefs:n.eventRefs,entityRefs:n.entityRefs,relationshipRefs:n.relationshipRefs,
  retrievalIntentIds:n.retrievalIntentIds,rankSignals:n.rankSignals,normalizedRank:n.normalizedRank,graphMetadata:n.graphMetadata,
  temporalHints:n.temporalHints,continuitySignals:n.continuitySignals,authorityClass:n.authorityClass,truthStatusHint:n.truthStatusHint,
  provenance:n.provenance,evidenceRefs:n.evidenceRefs,dependencyRevisions:n.dependencyRevisions,freshness:n.freshness,
  representationRef:n.representationRef,representationRevision:n.representationRevision,representationText:n.representationText,metadata:n.metadata,
  worldRevision:n.worldRevision,sceneRevision:n.sceneRevision,
},{length:32});}
function recordPriority(n){return [-(n.normalizedRank??0),n.channelId,n.evidenceIdentity,n.nominationId];}
function cmpTuple(a,b){for(let i=0;i<Math.max(a.length,b.length);i++){const x=a[i],y=b[i];if(x===y)continue;if(typeof x==='number'&&typeof y==='number')return x-y;return String(x??'').localeCompare(String(y??''));}return 0;}
function currentFreshness(n,current={}){
  if(n.freshness===CandidateFreshness.INVALID)return CandidateFreshness.INVALID;
  if(n.freshness===CandidateFreshness.STALE)return CandidateFreshness.STALE;
  const sourceSet=current.sourceRevisionSet?.length?new Set(current.sourceRevisionSet):null;
  if(sourceSet&&n.sourceRevisionRefs.some(ref=>!sourceSet.has(ref)))return CandidateFreshness.STALE;
  const depSet=current.dependencyRevisionSet?.length?new Set(current.dependencyRevisionSet):null;
  if(depSet&&n.dependencyRevisions.some(ref=>!depSet.has(ref)))return CandidateFreshness.STALE;
  if(n.worldRevision!=null&&current.worldRevision!=null&&Number(n.worldRevision)!==Number(current.worldRevision))return CandidateFreshness.STALE;
  if(n.sceneRevision!=null&&current.sceneRevision!=null&&Number(n.sceneRevision)!==Number(current.sceneRevision))return CandidateFreshness.STALE;
  return CandidateFreshness.FRESH;
}
function flattenProvenance(nominations,max){
  const out=[],seen=new Set();
  for(const nomination of nominations)for(const item of nomination.provenance??[]){const key=stableJson(item);if(seen.has(key))continue;seen.add(key);out.push(clone(item));if(out.length>=max)return out;}
  return out;
}
function graphMetadata(nominations,maxPaths){
  const rows=[];
  for(const nomination of nominations){
    if(nomination.graphMetadata==null)continue;
    const raw=Array.isArray(nomination.graphMetadata)?nomination.graphMetadata:[nomination.graphMetadata];
    for(const value of raw){rows.push({channelId:nomination.channelId,...clone(value)});}
  }
  return uniqueObjects(rows,maxPaths);
}
function mergeRankSignals(nominations){
  const out={};
  for(const n of nominations){
    for(const [key,value] of Object.entries(n.rankSignals??{})){
      if(typeof value!=='number'||!Number.isFinite(value))continue;
      const scoped=n.channelId+'.'+key;out[scoped]=Math.max(out[scoped]??-Infinity,value);
      // Compatibility aliases for the current deterministic Precision stub.
      if(['sparse','dense','graphDistance','temporal','conflict'].includes(key))out[key]=Math.max(out[key]??-Infinity,value);
    }
  }
  for(const key of Object.keys(out))if(out[key]===-Infinity)delete out[key];
  return out;
}
function boundedMetadata(nominations,maxBytes){
  const base={};
  for(const n of nominations){
    for(const key of Object.keys(n.metadata??{}).sort()){
      if(!(key in base))base[key]=clone(n.metadata[key]);
      else if(stableJson(base[key])!==stableJson(n.metadata[key]))base[key]=uniqueObjects([base[key],n.metadata[key]],4);
      if(utf8ByteLength(stableJson(base))>maxBytes){delete base[key];base.__truncated=true;break;}
    }
  }
  return base;
}
function candidatePriority(c){
  const ranks=c.channelNominations.map(n=>n.normalizedRank).filter(Number.isFinite);
  const best=ranks.length?Math.max(...ranks):0;
  return [-c.retrievalIntentIds.length,-best,-c.channelNominations.length,c.candidateId];
}
function candidateFusionScore(nominations,intentCount){
  const ranks=nominations.map(n=>n.normalizedRank).filter(Number.isFinite);
  const best=ranks.length?Math.max(...ranks):0;
  const support=Math.min(1,nominations.length/8),coverage=Math.min(1,intentCount/8);
  return Number((best*.8+support*.1+coverage*.1).toFixed(6));
}
function compatibleOwnerValue(values,fallback){const unique=uniq(values.filter(Boolean));return unique.length===1?unique[0]:fallback;}
function boundedPresentationText(text,max){
  if(text==null)return{text:null,coverage:{complete:true,policy:'NONE',sourceCharacters:0,includedCharacters:0,omittedCharacters:0}};
  const raw=String(text),cap=Math.max(0,Number(max)||0);
  if(raw.length<=cap)return{text:raw,coverage:{complete:true,policy:'FULL',sourceCharacters:raw.length,includedCharacters:raw.length,omittedCharacters:0}};
  if(cap===0)return{text:'',coverage:{complete:false,policy:'BOUNDED_TRANSPORT_WITH_SOURCE_DRILLBACK',sourceCharacters:raw.length,includedCharacters:0,omittedCharacters:raw.length,headCharacters:0,tailCharacters:0}};
  const marker=' … ',usable=Math.max(1,cap-marker.length),head=Math.ceil(usable/2),tail=Math.max(0,usable-head);
  const bounded=(raw.slice(0,head).trimEnd()+marker+raw.slice(Math.max(head,raw.length-tail)).trimStart()).slice(0,cap);
  return{text:bounded,coverage:{complete:false,policy:'HEAD_TAIL_BOUNDED_TRANSPORT',sourceCharacters:raw.length,includedCharacters:Math.min(raw.length,head+tail),omittedCharacters:Math.max(0,raw.length-head-tail),headCharacters:head,tailCharacters:tail}};
}
function trimText(text,max){return boundedPresentationText(text,max).text;}
function nominationView(n,lim){return {
  nominationId:n.nominationId,channelId:n.channelId,channelVersion:n.channelVersion,retrievalIntentIds:[...n.retrievalIntentIds],
  artifactRef:clone(n.artifactRef??null),artifactRevision:n.artifactRevision??null,
  sourceRevisionRefs:[...(n.sourceRevisionRefs??[])].slice(0,Math.min(32,lim.maxEvidenceRefsPerCandidate)),
  dependencyRevisions:[...(n.dependencyRevisions??[])].slice(0,32),
  representationRef:n.representationRef??null,representationRevision:n.representationRevision??null,
  rankSignals:clone(n.rankSignals),normalizedRank:n.normalizedRank,graphMetadata:clone(n.graphMetadata),
  temporalHints:clone(n.temporalHints).slice(0,16),continuitySignals:clone(n.continuitySignals).slice(0,16),freshness:n.freshness,
  provenance:uniqueObjects(n.provenance??[],Math.min(16,lim.maxProvenanceRefsPerCandidate)),
  evidenceRefs:[...n.evidenceRefs].slice(0,Math.min(16,lim.maxEvidenceRefsPerCandidate)),
  identityRevisionRefs:[...(n.identityRevisionRefs??[])],
  metadata:boundedMetadata([n],Math.max(64,Math.floor(lim.maxMetadataBytesPerCandidate/Math.max(1,lim.maxNominationRecordsPerCandidate)))),
};}

export class CandidateBus{
  constructor({limits:inputLimits={},isSourceRevisionCurrent=null,isIdentityRevisionCurrent=null,isDependencyRevisionCurrent=null,isArtifactKnown=null}={}){
    this.limits=limits(inputLimits);this.isSourceRevisionCurrent=isSourceRevisionCurrent;this.isIdentityRevisionCurrent=isIdentityRevisionCurrent;this.isDependencyRevisionCurrent=isDependencyRevisionCurrent;this.isArtifactKnown=isArtifactKnown;
    this.receipts=[];this.counters={fusions:0,inputNominations:0,duplicates:0,boundedOut:0,stale:0,invalid:0};
  }

  fuse({
    nominations=[],retrievalIntents=[],query=null,currentRevisionSet={},unavailableChannels=[],degradedChannels=[],
    candidateSetId=null,metadata={},candidateLimit=null,
  }={}){
    const intentIds=uniq(retrievalIntents.map(x=>typeof x==='string'?x:x?.intentId).filter(Boolean));
    const invalid=[],normalized=[];
    for(const raw of nominations??[]){
      try{
        if(raw?.contractVersion&&!compatibleContractVersion(raw.contractVersion,CANDIDATE_BUS_CONTRACT_VERSION))
          throw new CandidateBusContractError('CANDIDATE_VERSION_INCOMPATIBLE','Unsupported Candidate nomination contract version: '+raw.contractVersion);
        const n=raw?.kind==='CandidateNomination'?raw:createChannelNomination(raw);
        const artifactId=typeof n.artifactRef==='string'?n.artifactRef:n.artifactRef?.artifactId??n.artifactRef?.id??null;
        if(artifactId&&typeof this.isArtifactKnown==='function'&&!this.isArtifactKnown(artifactId,n.artifactRef))
          throw new CandidateBusContractError('UNKNOWN_ARTIFACT_REF','Unknown artifact reference: '+artifactId,{artifactId});
        let freshness=currentFreshness(n,currentRevisionSet);
        if(freshness===CandidateFreshness.FRESH&&typeof this.isSourceRevisionCurrent==='function'&&n.sourceRevisionRefs.some(ref=>!this.isSourceRevisionCurrent(ref)))freshness=CandidateFreshness.STALE;
        if(freshness===CandidateFreshness.FRESH&&typeof this.isIdentityRevisionCurrent==='function'&&(n.identityRevisionRefs??[]).some(ref=>!this.isIdentityRevisionCurrent(ref)))freshness=CandidateFreshness.STALE;
        if(freshness===CandidateFreshness.FRESH&&typeof this.isDependencyRevisionCurrent==='function'&&n.dependencyRevisions.some(ref=>!this.isDependencyRevisionCurrent(ref)))freshness=CandidateFreshness.STALE;
        normalized.push({...clone(n),freshness});
      }catch(error){invalid.push({code:error?.code??'NOMINATION_INVALID',message:String(error?.message??error),nominationId:raw?.nominationId??null,channelId:raw?.channelId??null});}
    }
    normalized.sort((a,b)=>cmpTuple(recordPriority(a),recordPriority(b)));

    const replaySeen=new Set(),uniqueNominations=[];let duplicateNominationCount=0;
    for(const n of normalized){const key=nominationSignature(n);if(replaySeen.has(key)){duplicateNominationCount++;continue;}replaySeen.add(key);uniqueNominations.push(n);}

    const pairCounts=new Map(),channelCounts=new Map(),boundedNominationIds=[],eligible=[];
    for(const n of uniqueNominations){
      const intents=n.retrievalIntentIds.length?n.retrievalIntentIds:['__NO_INTENT__'];
      const channelCount=channelCounts.get(n.channelId)??0;
      const overChannel=channelCount>=this.limits.maxPerChannel;
      const overPair=intents.some(id=>(pairCounts.get(n.channelId+'|'+id)??0)>=this.limits.maxPerChannelIntent);
      if(overChannel||overPair){boundedNominationIds.push(n.nominationId);continue;}
      eligible.push(n);channelCounts.set(n.channelId,channelCount+1);
      for(const id of intents)pairCounts.set(n.channelId+'|'+id,(pairCounts.get(n.channelId+'|'+id)??0)+1);
    }

    const groups=new Map();
    for(const n of eligible){const rows=groups.get(n.evidenceIdentity)??[];rows.push(n);groups.set(n.evidenceIdentity,rows);}
    const candidates=[];
    for(const [identity,rowsRaw] of [...groups.entries()].sort((a,b)=>a[0].localeCompare(b[0]))){
      const rows=rowsRaw.sort(byKey);
      const keptRows=rows.slice(0,this.limits.maxNominationRecordsPerCandidate);
      if(rows.length>keptRows.length)boundedNominationIds.push(...rows.slice(keptRows.length).map(x=>x.nominationId));
      const freshRows=keptRows.filter(x=>x.freshness===CandidateFreshness.FRESH);
      const candidateFreshness=freshRows.length?CandidateFreshness.FRESH:keptRows.some(x=>x.freshness===CandidateFreshness.STALE)?CandidateFreshness.STALE:CandidateFreshness.INVALID;
      const intentSet=uniq(keptRows.flatMap(x=>x.retrievalIntentIds));
      const authorityClass=compatibleOwnerValue(keptRows.map(x=>x.authorityClass),'UNKNOWN');
      const truthStatusHint=compatibleOwnerValue(keptRows.map(x=>x.truthStatusHint),CandidateTruthStatus.UNKNOWN);
      const authorityConflict=uniq(keptRows.map(x=>x.authorityClass)).length>1,truthConflict=uniq(keptRows.map(x=>x.truthStatusHint)).length>1;
      const artifactRef=keptRows.map(x=>x.artifactRef).find(x=>x!=null)??null;
      const artifactRevision=keptRows.map(x=>x.artifactRevision).find(x=>x!=null)??null;
      const representationRef=keptRows.map(x=>x.representationRef).find(Boolean)??null;
      const representationRevision=keptRows.map(x=>x.representationRevision).find(x=>x!=null)??null;
      const representationSource=keptRows.map(x=>x.representationText).find(Boolean)??null;
      const boundedRepresentation=boundedPresentationText(representationSource,this.limits.maxRepresentationChars),representationText=boundedRepresentation.text;
      const baseMetadata=boundedMetadata(keptRows,this.limits.maxMetadataBytesPerCandidate);
      const metadataOut={...baseMetadata};
      if(boundedRepresentation.coverage.complete===false)metadataOut.representationCoverage={...boundedRepresentation.coverage,sourceDrillbackAvailable:Boolean(representationRef||artifactRef||(keptRows.flatMap(x=>x.sourceRevisionRefs??[]).length))};
      if(authorityConflict)metadataOut.authorityMetadataConflict=uniq(keptRows.map(x=>x.authorityClass));
      if(truthConflict)metadataOut.truthStatusMetadataConflict=uniq(keptRows.map(x=>x.truthStatusHint));
      const nominatedCandidateId=compatibleOwnerValue(keptRows.map(x=>x.candidateId).filter(Boolean),null);
      const candidate=createCanonicalCandidate({
        candidateId:nominatedCandidateId??('candidate:'+stableHash(identity,{length:24,alreadyString:true})),evidenceIdentity:identity,
        artifactRef,artifactRevision,sourceRevisionRefs:uniq(keptRows.flatMap(x=>x.sourceRevisionRefs)),
        identityRevisionRefs:uniq(keptRows.flatMap(x=>x.identityRevisionRefs??[])),
        claimRefs:uniq(keptRows.flatMap(x=>x.claimRefs)),eventRefs:uniq(keptRows.flatMap(x=>x.eventRefs)),
        entityRefs:uniq(keptRows.flatMap(x=>x.entityRefs)),relationshipRefs:uniq(keptRows.flatMap(x=>x.relationshipRefs)),
        retrievalIntentIds:intentSet,channelNominations:keptRows.map(n=>nominationView(n,this.limits)),rankSignals:mergeRankSignals(keptRows),
        graphMetadata:graphMetadata(keptRows,this.limits.maxGraphPathsPerCandidate),
        temporalHints:uniqueObjects(keptRows.flatMap(x=>x.temporalHints),32),continuitySignals:uniqueObjects(keptRows.flatMap(x=>x.continuitySignals),32),
        authorityClass,truthStatusHint,provenance:flattenProvenance(keptRows,this.limits.maxProvenanceRefsPerCandidate),
        evidenceRefs:uniq(keptRows.flatMap(x=>x.evidenceRefs)).slice(0,this.limits.maxEvidenceRefsPerCandidate),
        dependencyRevisions:uniq(keptRows.flatMap(x=>x.dependencyRevisions)),freshness:candidateFreshness,
        representationRef,representationRevision,representationText,metadata:metadataOut,
        worldRevision:currentRevisionSet.worldRevision??keptRows.map(x=>x.worldRevision).find(x=>x!=null)??null,
        legacyRetrievalIntents:uniq(keptRows.map(x=>x.metadata?.legacyRetrievalIntent).filter(Boolean)),
        sceneRevision:currentRevisionSet.sceneRevision??keptRows.map(x=>x.sceneRevision).find(x=>x!=null)??null,
        fusionScore:candidateFusionScore(keptRows,intentSet.length),
      });
      candidates.push(candidate);
    }

    candidates.sort((a,b)=>cmpTuple(candidatePriority(a),candidatePriority(b)));
    const requestedCandidateLimit=candidateLimit!=null&&Number.isFinite(Number(candidateLimit))?Math.max(1,Math.floor(Number(candidateLimit))):this.limits.maxTotalCandidates;
    const effectiveCandidateLimit=Math.min(this.limits.maxTotalCandidates,requestedCandidateLimit);
    const selected=[],intentCounts=new Map(),prunedCandidateIds=[];
    for(const candidate of candidates){
      const ids=candidate.retrievalIntentIds.length?candidate.retrievalIntentIds:['__NO_INTENT__'];
      if(selected.length>=effectiveCandidateLimit||ids.some(id=>(intentCounts.get(id)??0)>=this.limits.maxPerIntent)){prunedCandidateIds.push(candidate.candidateId);continue;}
      selected.push(candidate);for(const id of ids)intentCounts.set(id,(intentCounts.get(id)??0)+1);
    }
    selected.sort((a,b)=>a.candidateId.localeCompare(b.candidateId));

    const candidateIdsByIntent={},coverageByIntent={};
    for(const id of intentIds){const ids=selected.filter(c=>c.retrievalIntentIds.includes(id)).map(c=>c.candidateId).sort();candidateIdsByIntent[id]=ids;coverageByIntent[id]={candidateCount:ids.length,covered:ids.length>0};}
    const uncoveredIntentIds=intentIds.filter(id=>!candidateIdsByIntent[id]?.length);
    const perChannelCounts=Object.fromEntries([...channelCounts.entries()].sort((a,b)=>a[0].localeCompare(b[0])));
    const perIntentCounts=Object.fromEntries([...intentCounts.entries()].filter(([id])=>id!=='__NO_INTENT__').sort((a,b)=>a[0].localeCompare(b[0])));
    const sourceRevisionSet=uniq(currentRevisionSet.sourceRevisionSet??selected.flatMap(c=>c.sourceRevisionRefs));
    const identityRevisionSet=uniq(currentRevisionSet.identityRevisionSet??selected.flatMap(c=>c.identityRevisionRefs??[]));
    const staleNominationCount=normalized.filter(x=>x.freshness===CandidateFreshness.STALE).length;
    const invalidNominationCount=invalid.length+normalized.filter(x=>x.freshness===CandidateFreshness.INVALID).length;
    const envelopeFreshness=selected.some(c=>c.freshness===CandidateFreshness.FRESH)?CandidateFreshness.FRESH:(selected.some(c=>c.freshness===CandidateFreshness.STALE)?CandidateFreshness.STALE:CandidateFreshness.UNKNOWN);
    const setId=candidateSetId??'candidate-set:'+stableHash({
      retrievalIntentIds:intentIds,candidates:selected.map(c=>[c.candidateId,c.freshness,c.channelNominations.map(n=>n.channelId)]),
      sourceRevisionSet,identityRevisionSet,worldRevision:currentRevisionSet.worldRevision??0,sceneRevision:currentRevisionSet.sceneRevision??0,
    },{length:24});
    const receipt=createFusionReceipt({
      candidateSetId:setId,retrievalIntentIds:intentIds,inputNominationCount:nominations.length,
      inputChannelCount:uniq(normalized.map(x=>x.channelId)).length,deduplicatedCandidateCount:candidates.length,
      duplicateNominationCount,perChannelCounts,perIntentCounts,
      boundedOutCount:boundedNominationIds.length+prunedCandidateIds.length,unavailableChannels,degradedChannels,
      staleNominationCount,invalidNominationCount,revisionSet:{
        sourceRevisionSet,identityRevisionSet,worldRevision:currentRevisionSet.worldRevision??0,sceneRevision:currentRevisionSet.sceneRevision??0,
        dependencyRevisionSet:uniq(currentRevisionSet.dependencyRevisionSet??[]),
      },freshness:envelopeFreshness,coverageByIntent,candidateIdsByIntent,uncoveredIntentIds,prunedCandidateIds,
      fusionPolicyVersion:FUSION_POLICY_VERSION,diagnostics:{
        invalidNominations:invalid.slice(0,32),boundedNominationIds:uniq(boundedNominationIds).slice(0,64),
        candidatePayloadBytes:selected.reduce((sum,c)=>sum+candidatePayloadBytes(c),0),
        requestedCandidateLimit,effectiveCandidateLimit,
      },
    });
    const envelope=createCandidateBusEnvelope({
      candidateSetId:setId,query,retrievalIntentIds:intentIds,sourceRevisionSet,identityRevisionSet,
      worldRevision:currentRevisionSet.worldRevision??0,sceneRevision:currentRevisionSet.sceneRevision??0,
      candidates:selected,unavailableChannels,degradedChannels,fusionReceipt:receipt,freshness:envelopeFreshness,metadata,
    });
    this.#remember(receipt);
    this.counters.fusions++;this.counters.inputNominations+=nominations.length;this.counters.duplicates+=duplicateNominationCount;
    this.counters.boundedOut+=receipt.boundedOutCount;this.counters.stale+=staleNominationCount;this.counters.invalid+=invalidNominationCount;
    return envelope;
  }

  diagnostics(){
    return frozen({kind:'CandidateBusDiagnostics',contractVersion:'1.0.0',counters:clone(this.counters),recentReceipts:clone(this.receipts),limits:clone(this.limits),retainsCandidatePayloadHistory:false,readOnly:true,mutationAuthority:false});
  }

  #remember(receipt){
    if(!this.limits.maxReceiptHistory)return;this.receipts.push(clone(receipt));
    while(this.receipts.length>this.limits.maxReceiptHistory)this.receipts.shift();
  }
}
