import { TruthGate } from '../truth-gate.js';
import { KnowledgeStatus, createTruthGateResult } from '../contracts.js';
import { loreNodeId, memoryNodeId, normalizeWorldTreeAlias } from '../../../core/world-tree-api.js';
import { CAMPAIGN_APPLICABILITY, TRUTH_OUTCOME, decideTruthOutcome, resolveNodeAuthority } from '../../truth-classification.js';
export { resolveNodeAuthority };

const HISTORICAL=new Set([KnowledgeStatus.HISTORICAL,KnowledgeStatus.SUPERSEDED]);
const DISPUTED=new Set([KnowledgeStatus.CONTRADICTED]);
const unresolved=new Set([KnowledgeStatus.UNRESOLVED,KnowledgeStatus.UNCERTAIN]);

// Intent comes from what the player is asking or stating about the story, not from the story
// being told. Narrative prose uses "after", "before", "when", "previously" and "conflict"
// constantly, so cues count only in text the player addressed to the system:
//   - a question: a sentence ending in "?", outside quoted dialogue and *action* text;
//   - an out-of-character span: "(OOC: ...)", "[OOC ...]", or a line starting "OOC:" or "//";
//   - a request to recall: "recap ...", "remind me ...", "tell me ...", "explain ...";
//   - a stated contradiction of what is already established: "... contradicts canon / the lore /
//     what we know".
// Anything else is an ordinary turn (CURRENT). Callers must pass the player's own message,
// never scene objectives or assistant prose.
const NARRATIVE_SPANS=/"[^"]*"|\u201c[^\u201d]*\u201d|\u00ab[^\u00bb]*\u00bb|\*[^*\n]*\*/gu;
const QUESTION_END=/\?[)\]"'\u201d\u2019*_\s]*$/u;
const OOC_SPAN=/\((?:ooc|out of character)\b[^)]*\)|\[(?:ooc|out of character)\b[^\]]*\]/giu;
const OOC_LINE=/^[ \t]*(?:ooc\b[:\-]?|\/\/)[ \t]*(.+)$/gimu;
const REQUEST_OPENER=/^(?:please\s+)?(?:recap|remind me|tell me|explain|summari[sz]e|describe)\b/iu;
const CONTRADICTS=/\bcontradict(?:s|ed|ing|ion|ions)?\b/iu;
const ESTABLISHED_REFERENT=/\b(?:canon|lore(?:book)?|what we know|what is established|already established|established (?:facts?|canon|lore)|earlier|the book|the novel|the source)\b/iu;
export function playerQuestions(text=''){
  const raw=String(text??'');
  const stripped=raw.replace(NARRATIVE_SPANS,' ');
  const found=[];
  for(const part of stripped.split(/(?<=[.!?\u2026])\s+|\n+/u).map(row=>row.trim()).filter(Boolean)){
    if(QUESTION_END.test(part)||REQUEST_OPENER.test(part)||(CONTRADICTS.test(part)&&ESTABLISHED_REFERENT.test(part)))found.push(part);
  }
  for(const match of stripped.matchAll(OOC_SPAN))found.push(match[0]);
  for(const match of stripped.matchAll(OOC_LINE))found.push(match[1]);
  return [...new Set(found)];
}
export function hasPlayerQuestion(text=''){return playerQuestions(text).length>0;}
export function inferTruthNeed(query=''){
  const text=playerQuestions(query).join(' ').toLocaleLowerCase();
  if(!text)return'CURRENT';
  if(/\b(contradict(?:s|ed|ing|ion|ions)?|conflicts?|conflicting|disputed|which version|which account|inconsistent)\b/.test(text))return'CONTRADICTION';
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
// A chat-established fact: something the scene itself is currently showing, in this exact
// chat. It must be observed (not merely remembered, quoted or inferred), currently true by
// its own status, and not superseded. Support-only material is exactly what fails this test,
// so it can never beat canon or settle a conflict.
const REMEMBERED_KINDS=new Set(['memory','character-memory']);
export function isEstablishedChatFact(node,chatId){
  return node!=null&&chatId!=null&&node.scope!=='global'&&String(node.scope)===String(chatId)&&!REMEMBERED_KINDS.has(String(node.kind))
    &&String(node.authority??'').toUpperCase()==='OBSERVED'&&node.temporalStatus===KnowledgeStatus.CURRENT&&node.supersededBy==null;
}
const sharesSubject=(left,right)=>{
  const other=new Set((right?.aliases??[]).map(normalizeWorldTreeAlias).filter(Boolean));
  return (left?.aliases??[]).map(normalizeWorldTreeAlias).some(alias=>alias&&other.has(alias));
};

export function summarizeTruthAssessment(assessment){
  const rows=assessment?.rows??[];
  const unspecified=rows.filter(row=>row?.timingUnspecified===true);
  return Object.freeze({
    candidateCount:rows.length,
    keptCount:assessment?.candidates?.length??0,
    droppedCount:assessment?.dropped?.length??0,
    // Unspecified canon timing is not an open question; only genuine ones count here.
    unresolvedCount:rows.filter(row=>row?.unresolved===true&&row?.timingUnspecified!==true&&row?.deferred!==true).length,
    deferredCount:rows.filter(row=>row?.deferred===true).length,
    unspecifiedTimingCount:unspecified.length,
    canonReferenceCount:rows.filter(row=>row?.campaignApplicability===CAMPAIGN_APPLICABILITY.DIFFERENT_TIME).length,
    disputedCount:rows.filter(row=>row?.disputed===true).length,
    supportOnlyCount:rows.filter(row=>row?.supportOnly===true).length,
    fullWeightCount:rows.filter(row=>row?.outcome===TRUTH_OUTCOME.FULL).length,
  });
}
export function truthNeedsCorrection(stats){
  return stats.keptCount===0||stats.droppedCount>0||stats.unresolvedCount>0||stats.disputedCount>0;
}


// A candidate Truth did not classify (over budget, or Truth unavailable): kept as support-only
// context, so it can supply background but never establish a current fact or settle a conflict.
function deferredRow(candidate,candidateId,reasonCode,reason){
  const verdict=createTruthGateResult({candidateId:String(candidateId),classification:KnowledgeStatus.UNRESOLVED,usableForIntent:false,reasons:[reason],claimIds:[],provenance:null});
  return Object.freeze({
    candidate,candidateId:String(candidateId),verdict,authority:null,authoritySource:'NONE',timingUnspecified:false,conflict:null,
    campaignApplicability:'UNKNOWN',outcome:TRUTH_OUTCOME.SUPPORT_ONLY,reasonCode,keep:true,presentationLabel:'',supportOnly:true,
    unresolved:false,disputed:false,deferred:true,
  });
}
function candidateIdOrFallback(candidate,kind,index){
  try{return candidateId(candidate,kind);}catch{return'unassessed:'+index;}
}
const tagTruth=(row)=>Object.freeze({
  classification:row.verdict.classification,usableForIntent:false,presentationLabel:'',authority:null,authoritySource:'NONE',timingUnspecified:false,
  campaignApplicability:'UNKNOWN',weight:row.outcome,reasonCode:row.reasonCode,supportOnly:true,reasons:[...row.verdict.reasons],
});

// Foreground entry point: Truth never throws into generation. If assessment fails, every candidate
// continues as support-only context with reason TRUTH_UNAVAILABLE, and the failure is reported.
export function assessWorldTreeCandidatesSafely(input,options={}){
  try{return assessWorldTreeCandidates(input,options);}
  catch(error){
    const envelope=input?.kind==='CandidateBusEnvelope'?input:null;
    const candidates=Array.isArray(envelope?.candidates)?envelope.candidates:(Array.isArray(input)?input:[]);
    const kind=options?.kind??'lore';
    const rows=candidates.map((candidate,index)=>deferredRow(candidate,candidateIdOrFallback(candidate,kind,index),'TRUTH_UNAVAILABLE','truth-unavailable'));
    return Object.freeze({
      kind:'NexusA52TruthAssessment',inputEnvelope:envelope,candidateSetId:envelope?.candidateSetId??null,fusionReceipt:envelope?.fusionReceipt??null,
      coverage:Object.freeze({total:rows.length,assessed:0,deferred:rows.length,complete:false,continuation:null}),
      intent:options?.intent??'CURRENT',query:String(options?.query??''),rows:Object.freeze(rows),
      candidates:Object.freeze(rows.map((row,index)=>Object.freeze({...candidates[index],a52Truth:tagTruth(row)}))),
      dropped:Object.freeze([]),error:String(error?.message??error).slice(0,200),
    });
  }
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
  assessLimit=null,
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
  // Work over budget is deferred, never dropped: candidates past the limit are not classified
  // now, are kept as support-only context, and are counted in the coverage receipt.
  const limit=assessLimit==null?rows.length:Math.max(0,Math.min(rows.length,Math.floor(Number(assessLimit))||0));
  const verdicts=gate.classifyAll(rows.slice(0,limit),{intent});
  // Conflict evidence is applicable only when it is a REAL_CONFLICT verdict on exactly this pair,
  // no other verdict on the same pair disagrees, both nodes are readable here, they share a
  // subject, and any recorded revisions still match. A shared subject or a newer mention
  // alone is never a conflict. Evidence is read per call; nothing here is written anywhere.
  const pairKey=(left,right)=>[String(left),String(right)].sort().join('\u0000');
  const pairEvidence=new Map();
  for(const row of conflictAdvice??[]){
    if(!row?.left||!row?.right)continue;
    const key=pairKey(row.left,row.right),entry=pairEvidence.get(key)??{rows:[],choices:new Set()};
    entry.rows.push(row);entry.choices.add(String(row.choice));
    pairEvidence.set(key,entry);
  }
  const revisionMatches=(row,id,node)=>{
    const recorded=String(row.left)===String(id)?row.leftRevision:row.rightRevision;
    return recorded==null||Number(recorded)===Number(node.revision);
  };
  // Partners of `node` whose pair carries exactly one verdict, `choice`, and passes the checks above.
  const verifiedPartners=(node,choice='REAL_CONFLICT')=>{
    const out=[];
    for(const entry of pairEvidence.values()){
      if(entry.choices.size!==1||!entry.choices.has(choice))continue;
      for(const row of entry.rows){
        const ids=[String(row.left),String(row.right)];
        if(!ids.includes(String(node.id)))continue;
        const partner=worldTree?.getNode(ids[0]===String(node.id)?ids[1]:ids[0]);
        if(!partner||!sharesSubject(node,partner))continue;
        if(!revisionMatches(row,node.id,node)||!revisionMatches(row,partner.id,partner))continue;
        out.push(partner);
      }
    }
    return out;
  };
  // Campaign applicability comes only from verified story-scoped evidence: an established chat
  // fact of this exact chat judged (CHANGE_OVER_TIME) to describe a different time than the
  // canon description. No evidence leaves it UNKNOWN. Nothing is inferred from absence, titles,
  // or the canon text, and nothing is stored.
  const applicabilityOf=(node,authority)=>{
    if(node.scope!=='global'||authority!=='CANON')return CAMPAIGN_APPLICABILITY.UNKNOWN;
    return verifiedPartners(node,'CHANGE_OVER_TIME').some(partner=>isEstablishedChatFact(partner,chatId))
      ?CAMPAIGN_APPLICABILITY.DIFFERENT_TIME:CAMPAIGN_APPLICABILITY.UNKNOWN;
  };
  // Chat facts win only in their own chat, and only against canon. This reads the World Tree
  // and never writes it, so the global lore node is unchanged and another chat still reads it.
  const conflictRole=(node,authority)=>{
    const partners=verifiedPartners(node,'REAL_CONFLICT');
    if(!partners.length)return null;
    if(isEstablishedChatFact(node,chatId)){
      return partners.every(partner=>resolveNodeAuthority(partner,{canonBooks}).authority==='CANON')?'CHAT_WINS':null;
    }
    if(node.scope!=='global')return null;
    if(authority==='CANON'&&partners.some(partner=>isEstablishedChatFact(partner,chatId)))return'CHAT_LOSES';
    return partners.some(partner=>partner.scope==='global')?'UNSETTLED':null;
  };
  const assessed=(candidates??[]).map((candidate,index)=>{
    if(index>=limit)return deferredRow(candidate,rows[index].candidateId,'DEFERRED_OVER_BUDGET','deferred-over-budget');
    let verdict=verdicts[index];
    const originalNode=nodeForCandidate(worldTree,candidate,kind);
    const {authority,authoritySource}=resolveNodeAuthority(originalNode,{canonBooks});
    const statusBeforeConflict=verdict.classification;
    const timingUnspecified=statusBeforeConflict===KnowledgeStatus.UNRESOLVED&&originalNode!=null
      &&authority==='CANON'&&originalNode.importDefaultedTiming===true;
    let conflict=null;
    if(originalNode){
      conflict=conflictRole(originalNode,authority);
      // Explicit historical, superseded and uncertain states are preserved, not overridden.
      const overridable=[KnowledgeStatus.CURRENT,KnowledgeStatus.UNRESOLVED,KnowledgeStatus.CONTRADICTED].includes(statusBeforeConflict);
      if(!overridable)conflict=null;
      else if(conflict!=null&&conflict!=='CHAT_WINS'){
        const usableForIntent=intent==='CURRENT'||intent==='TEMPORAL'||intent==='CONTRADICTION';
        verdict={...verdict,classification:KnowledgeStatus.CONTRADICTED,temporalStatus:KnowledgeStatus.CONTRADICTED,usableForIntent,reasons:[...(verdict?.reasons??[]),'decision-current-claim-conflict']};
      }
    }
    // Explicit states (uncertain, historical, superseded, current, contradicted) are preserved:
    // applicability only qualifies canon whose timing is genuinely unresolved.
    const campaignApplicability=originalNode&&conflict==null&&statusBeforeConflict===KnowledgeStatus.UNRESOLVED
      ?applicabilityOf(originalNode,authority):CAMPAIGN_APPLICABILITY.UNKNOWN;
    const decision=decideTruthOutcome({
      classification:verdict.classification,intent,usableForIntent:verdict.usableForIntent,
      hasEvidence:!(verdict.reasons??[]).includes('claim-missing-or-invalid'),
      authority,timingUnspecified:timingUnspecified&&conflict==null,conflict,campaignApplicability,
    });
    const presentationLabel=campaignApplicability===CAMPAIGN_APPLICABILITY.DIFFERENT_TIME?'[Canon reference]':labelFor(verdict.classification);
    return Object.freeze({
      candidate,
      candidateId:rows[index].candidateId,
      verdict,
      authority,
      authoritySource,
      timingUnspecified:timingUnspecified&&conflict==null,
      conflict,
      campaignApplicability,
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
    coverage:Object.freeze({total:rows.length,assessed:limit,deferred:rows.length-limit,complete:limit===rows.length,continuation:limit<rows.length?Object.freeze({offset:limit,total:rows.length}):null}),
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
        campaignApplicability:row.campaignApplicability,
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
