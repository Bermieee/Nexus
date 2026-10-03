import { TruthGate } from '../truth-gate.js';
import { KnowledgeStatus } from '../contracts.js';
import { loreNodeId, memoryNodeId } from '../../../core/world-tree-api.js';

const HISTORICAL=new Set([KnowledgeStatus.HISTORICAL,KnowledgeStatus.SUPERSEDED]);
const DISPUTED=new Set([KnowledgeStatus.CONTRADICTED]);
const unresolved=new Set([KnowledgeStatus.UNRESOLVED,KnowledgeStatus.UNCERTAIN]);

export function inferTruthNeed(query=''){
  const text=String(query??'').toLocaleLowerCase();
  if(/\b(contradict|conflict|disputed|which version|which account|inconsistent)\b/.test(text))return'CONTRADICTION';
  if(/\b(history|historical|formerly|previously|used to|back then|in the past|past state|old state)\b/.test(text))return'HISTORICAL';
  if(/\b(when|before|after|during|timeline|changed|change over time|at the time)\b/.test(text))return'TEMPORAL';
  return'CURRENT';
}
export function inferTruthIntent(query=''){return inferTruthNeed(query);}

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
const LORE_IMPORT_SOURCE_TYPE='SILLYTAVERN_WORLD_INFO';
const LORE_IMPORT_ORIGIN='legacy-lorebook';

// Source authority is independent of temporal status. A stored authority is honored
// as written. Otherwise CANON is derived only for a global lore node whose import
// provenance names the bound book and entry exactly; no binding, no derivation.
export function resolveNodeAuthority(node,{canonBooks=null}={}){
  if(!node)return Object.freeze({authority:null,authoritySource:'NONE'});
  if(node.authority)return Object.freeze({authority:String(node.authority),authoritySource:'STORED'});
  const books=new Set((canonBooks??[]).map(String));
  const book=node.payload?.book==null?'':String(node.payload.book);
  const uid=node.payload?.uid;
  const ids=new Set((node.provenance?.sourceIds??[]).map(String));
  const verified=node.kind==='lore'&&node.scope==='global'
    &&node.provenance?.sourceType===LORE_IMPORT_SOURCE_TYPE&&node.provenance?.importedFrom===LORE_IMPORT_ORIGIN
    &&book!==''&&books.has(book)&&Number.isFinite(Number(uid))&&ids.has(book)&&ids.has(String(Number(uid)));
  return verified?Object.freeze({authority:'CANON',authoritySource:'IMPORT_PROVENANCE'}):Object.freeze({authority:null,authoritySource:'NONE'});
}

export function summarizeTruthAssessment(assessment){
  const rows=assessment?.rows??[];
  const unspecified=rows.filter(row=>row?.timingUnspecified===true);
  return Object.freeze({
    candidateCount:rows.length,
    keptCount:assessment?.candidates?.length??0,
    droppedCount:assessment?.dropped?.length??0,
    // Unspecified canon timing is not an open question; only genuine ones count here.
    unresolvedCount:rows.filter(row=>row?.unresolved===true&&row?.timingUnspecified!==true).length,
    unspecifiedTimingCount:unspecified.length,
    disputedCount:rows.filter(row=>row?.disputed===true).length,
    supportOnlyCount:rows.filter(row=>row?.supportOnly===true).length,
  });
}
export function truthNeedsCorrection(stats){
  return stats.keptCount===0||stats.droppedCount>0||stats.unresolvedCount>0||stats.disputedCount>0;
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
  conflictAdvice=[],
  canonBooks=null,
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
  const conflictIds=new Set((conflictAdvice??[]).filter(row=>row?.choice==='REAL_CONFLICT').flatMap(row=>[row?.left,row?.right]).filter(Boolean).map(String));
  const assessed=(candidates??[]).map((candidate,index)=>{
    let verdict=verdicts[index];
    const originalNode=nodeForCandidate(worldTree,candidate,kind);
    if(originalNode&&conflictIds.has(String(originalNode.id))){
      const usableForIntent=intent==='CURRENT'||intent==='TEMPORAL'||intent==='CONTRADICTION';
      verdict={...verdict,classification:KnowledgeStatus.CONTRADICTED,temporalStatus:KnowledgeStatus.CONTRADICTED,usableForIntent,reasons:[...(verdict?.reasons??[]),'decision-current-claim-conflict']};
    }
    const presentationLabel=labelFor(verdict.classification);
    const keep=shouldKeep(verdict);
    const {authority,authoritySource}=resolveNodeAuthority(originalNode,{canonBooks});
    const timingUnspecified=verdict.classification===KnowledgeStatus.UNRESOLVED&&originalNode!=null
      &&authority==='CANON'&&originalNode.importDefaultedTiming===true;
    return Object.freeze({
      candidate,
      candidateId:rows[index].candidateId,
      verdict,
      authority,
      authoritySource,
      timingUnspecified,
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
        authority:row.authority,
        authoritySource:row.authoritySource,
        timingUnspecified:row.timingUnspecified,
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
