import { TruthGate } from '../truth-gate.js';
import { KnowledgeStatus } from '../contracts.js';
import { loreNodeId, memoryNodeId } from '../../../core/world-tree-api.js';

const HISTORICAL=new Set([KnowledgeStatus.HISTORICAL,KnowledgeStatus.SUPERSEDED]);
const DISPUTED=new Set([KnowledgeStatus.CONTRADICTED]);
const unresolved=new Set([KnowledgeStatus.UNRESOLVED,KnowledgeStatus.UNCERTAIN]);

export function inferTruthIntent(query=''){
  const text=String(query??'').toLocaleLowerCase();
  if(/\b(contradict|conflict|disputed|which version|which account|inconsistent)\b/.test(text))return'CONTRADICTION';
  if(/\b(history|historical|formerly|previously|used to|back then|in the past|past state|old state)\b/.test(text))return'HISTORICAL';
  if(/\b(when|before|after|during|timeline|changed|change over time|at the time)\b/.test(text))return'TEMPORAL';
  return'CURRENT';
}

function candidateId(candidate,kind){
  if(candidate?.candidateId)return String(candidate.candidateId);
  if(kind==='memory')return memoryNodeId(candidate?.id);
  return loreNodeId(candidate?.book,candidate?.uid);
}
function nodeForCandidate(worldTree,candidate,kind){
  return worldTree?.getNode(candidate?.evidenceIdentity)??worldTree?.getNode(candidate?.representationRef)??worldTree?.getNode(candidateId(candidate,kind))??null;
}
function labelFor(classification){
  if(classification===KnowledgeStatus.HISTORICAL||classification===KnowledgeStatus.SUPERSEDED)return'[Past]';
  if(classification===KnowledgeStatus.CONTRADICTED)return'[Disputed]';
  return'';
}
function shouldKeep(verdict){
  if(verdict.classification===KnowledgeStatus.HISTORICAL)return true;
  return verdict.usableForIntent===true;
}

export function assessWorldTreeCandidates(input,{
  worldTree,
  query=input?.query??'',
  intent=inferTruthIntent(query),
  kind='lore',
  sourceRevisionRefs=input?.sourceRevisionSet??[],
}={}){
  const envelope=input?.kind==='CandidateBusEnvelope'?input:null;
  const candidates=envelope?envelope.candidates:(input??[]);
  // Preserve fused candidate identities, references and provenance at the Truth boundary.
  const rows=envelope?candidates:candidates.map(candidate=>({
    candidateId:candidateId(candidate,kind),
    claimIds:[],
    sourceRevisionRefs:[...sourceRevisionRefs],
    evidenceRefs:[candidateId(candidate,kind)],
    authorityClass:'SOURCE_CANON',
  }));
  const byId=new Map((candidates??[]).map(candidate=>[candidateId(candidate,kind),candidate]));
  const gate=new TruthGate({
    graph:{getClaim(){return null;}},
    externalEvidenceResolver(candidate){
      const original=byId.get(candidate.candidateId);
      const node=nodeForCandidate(worldTree,original,kind);
      if(!node)return null;
      return{
        evidenceId:node.id,
        artifactRef:node.id,
        temporalStatus:node.temporalStatus??KnowledgeStatus.UNRESOLVED,
        authorityClass:'SOURCE_CANON',
        sourceClass:kind==='memory'?'NEXUS_MEMORY':'NEXUS_LORE',
        sourceRevisionRefs:[...(node.sourceRefs??sourceRevisionRefs)],
      };
    },
  });
  const verdicts=gate.classifyAll(rows,{intent});
  const assessed=(candidates??[]).map((candidate,index)=>{
    const verdict=verdicts[index];
    const presentationLabel=labelFor(verdict.classification);
    const keep=shouldKeep(verdict);
    return Object.freeze({
      candidate,
      candidateId:rows[index].candidateId,
      verdict,
      keep,
      presentationLabel,
      supportOnly:HISTORICAL.has(verdict.classification)&&verdict.usableForIntent!==true,
      unresolved:unresolved.has(verdict.classification),
      disputed:DISPUTED.has(verdict.classification),
    });
  });
  return Object.freeze({
    kind:'NexusA52TruthAssessment',
    inputEnvelope:envelope,
    candidateSetId:envelope?.candidateSetId??null,
    fusionReceipt:envelope?.fusionReceipt??null,
    intent,
    query:String(query??''),
    rows:Object.freeze(assessed),
    candidates:Object.freeze(assessed.filter(row=>row.keep).map(row=>Object.freeze({
      ...row.candidate,
      a52Truth:Object.freeze({
        classification:row.verdict.classification,
        usableForIntent:row.verdict.usableForIntent,
        presentationLabel:row.presentationLabel,
        supportOnly:row.supportOnly,
        reasons:[...(row.verdict.reasons??[])],
      }),
    }))),
    dropped:Object.freeze(assessed.filter(row=>!row.keep)),
  });
}

export function truthPresentationPrefix(candidate){
  return String(candidate?.a52Truth?.presentationLabel??'').trim();
}
