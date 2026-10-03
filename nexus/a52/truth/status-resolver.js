import { TruthGate } from '../truth-gate.js';
import { KnowledgeStatus } from '../contracts.js';
import { loreNodeId, memoryNodeId } from '../../../core/world-tree-api.js';
import { TRUTH_OUTCOME, decideTruthOutcome, resolveNodeAuthority } from '../../truth-classification.js';
export { resolveNodeAuthority };

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
const CHAT_FACT_AUTHORITIES=new Set(['OBSERVED','REMEMBERED']);

// A chat-established fact: a current node scoped to this exact chat, written from
// observation or memory. Anything else is not allowed to win a conflict.
function isChatFact(node,chatId){
  return node!=null&&chatId!=null&&node.scope!=='global'&&String(node.scope)===String(chatId)
    &&CHAT_FACT_AUTHORITIES.has(String(node.authority??'').toUpperCase())&&node.temporalStatus===KnowledgeStatus.CURRENT;
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
    fullWeightCount:rows.filter(row=>row?.outcome===TRUTH_OUTCOME.FULL).length,
  });
}
export function truthNeedsCorrection(stats){
  return stats.keptCount===0||stats.droppedCount>0||stats.unresolvedCount>0||stats.disputedCount>0;
}


export function assessWorldTreeCandidates(input,{
  worldTree,
  query=input?.query??'',
  intent=inferTruthIntent(query),
  kind='lore',
  sourceRevisionRefs=input?.sourceRevisionSet??[],
  conflictAdvice=[],
  canonBooks=null,
  chatId=null,
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
  const conflictRows=(conflictAdvice??[]).filter(row=>row?.choice==='REAL_CONFLICT'&&row?.left&&row?.right);
  const conflictPartners=new Map();
  for(const row of conflictRows)for(const [self,other] of [[String(row.left),String(row.right)],[String(row.right),String(row.left)]]){
    if(!conflictPartners.has(self))conflictPartners.set(self,new Set());
    conflictPartners.get(self).add(other);
  }
  // Chat facts win only in their own chat. This reads the World Tree; it never writes it,
  // so the global lore node is unchanged and another chat still sees it as canon.
  const conflictRole=(node,authority)=>{
    const partners=[...(conflictPartners.get(String(node.id))??[])].map(id=>worldTree?.getNode(id)).filter(Boolean);
    // A partner this read cannot resolve (stale, deleted, or another chat's) is no conflict here.
    if(!partners.length)return null;
    const canonBeaten=authority==='CANON'&&partners.some(partner=>isChatFact(partner,chatId));
    if(canonBeaten)return'CHAT_LOSES';
    const wins=isChatFact(node,chatId)&&partners.length>0&&partners.every(partner=>resolveNodeAuthority(partner,{canonBooks}).authority==='CANON');
    return wins?'CHAT_WINS':'UNSETTLED';
  };
  const assessed=(candidates??[]).map((candidate,index)=>{
    let verdict=verdicts[index];
    const originalNode=nodeForCandidate(worldTree,candidate,kind);
    const {authority,authoritySource}=resolveNodeAuthority(originalNode,{canonBooks});
    const statusBeforeConflict=verdict.classification;
    const timingUnspecified=statusBeforeConflict===KnowledgeStatus.UNRESOLVED&&originalNode!=null
      &&authority==='CANON'&&originalNode.importDefaultedTiming===true;
    let conflict=null;
    if(originalNode&&conflictPartners.has(String(originalNode.id))){
      conflict=conflictRole(originalNode,authority);
      // Explicit historical, superseded and uncertain states are preserved, not overridden.
      const overridable=[KnowledgeStatus.CURRENT,KnowledgeStatus.UNRESOLVED,KnowledgeStatus.CONTRADICTED].includes(statusBeforeConflict);
      if(!overridable)conflict=null;
      else if(conflict!=null&&conflict!=='CHAT_WINS'){
        const usableForIntent=intent==='CURRENT'||intent==='TEMPORAL'||intent==='CONTRADICTION';
        verdict={...verdict,classification:KnowledgeStatus.CONTRADICTED,temporalStatus:KnowledgeStatus.CONTRADICTED,usableForIntent,reasons:[...(verdict?.reasons??[]),'decision-current-claim-conflict']};
      }
    }
    const decision=decideTruthOutcome({
      classification:verdict.classification,intent,usableForIntent:verdict.usableForIntent,
      hasEvidence:!(verdict.reasons??[]).includes('claim-missing-or-invalid'),
      authority,timingUnspecified:timingUnspecified&&conflict==null,conflict,
    });
    const presentationLabel=labelFor(verdict.classification);
    return Object.freeze({
      candidate,
      candidateId:rows[index].candidateId,
      verdict,
      authority,
      authoritySource,
      timingUnspecified:timingUnspecified&&conflict==null,
      conflict,
      outcome:decision.outcome,
      reasonCode:decision.reasonCode,
      keep:decision.outcome!==TRUTH_OUTCOME.DROPPED,
      presentationLabel,
      supportOnly:decision.outcome===TRUTH_OUTCOME.SUPPORT_ONLY,
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
        weight:row.outcome,
        reasonCode:row.reasonCode,
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
