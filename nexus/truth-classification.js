// Truth outcomes: how much a classified candidate may be used downstream.
// Pure functions only. Truth classifies; it does not rank or select.
//
// FULL         normal factual use and weight.
// SUPPORT_ONLY may supply context; it must not establish a current fact or settle a conflict.
// DROPPED      removed because Truth can show it invalid for this turn.
//
// Reason codes are fixed per outcome and never carry story text.
export const TRUTH_OUTCOME=Object.freeze({FULL:'FULL',SUPPORT_ONLY:'SUPPORT_ONLY',DROPPED:'DROPPED'});

export const TRUTH_REASON_CODES=Object.freeze({
  FULL:Object.freeze(['CANON_NO_CONFLICT','STATUS_CURRENT','STATUS_MATCHES_TEMPORAL_QUESTION','CHAT_FACT_WINS','CANON_REFERENCE_MATCHES_TIME_QUESTION']),
  SUPPORT_ONLY:Object.freeze(['CHAT_FACT_SUPERSEDES_CANON','CONFLICT_UNSETTLED','STATUS_HISTORICAL_CONTEXT','STATUS_UNCERTAIN','STATUS_DECLARED_UNRESOLVED','NO_STATUS_EVIDENCE','CANON_TIMING_NOT_ESTABLISHED','CANON_REFERENCE_NOT_CURRENT']),
  DROPPED:Object.freeze(['CHAT_FACT_SUPERSEDES_CANON','STATUS_SUPERSEDED','CANON_TIMING_NOT_ESTABLISHED','NOT_USABLE_FOR_INTENT','NO_NODE_EVIDENCE','UNSUPPORTED_STATUS']),
});

export function isKnownTruthReasonCode(outcome,code){
  return TRUTH_REASON_CODES[outcome]?.includes(code)===true;
}

const result=(outcome,reasonCode)=>Object.freeze({outcome,reasonCode});

// conflict: null | 'CHAT_WINS' | 'CHAT_LOSES' | 'UNSETTLED'
//   CHAT_LOSES  a verified canon fact contradicted by a current chat-established fact in this chat
//   CHAT_WINS   the candidate is that chat-established fact
//   UNSETTLED   a reported conflict with no chat-established winner
// timingUnspecified: verified source canon whose timeline was never declared. It keeps its
// UNRESOLVED status and is exempt from support-only only for ordinary (CURRENT) retrieval;
// it never answers "when", never answers a historical question and never settles a conflict.
// campaignApplicability is a third axis, separate from authority and from temporal status:
//   UNKNOWN         no verified evidence about this campaign (the default; nothing is inferred
//                   from absence, titles, or the canon text itself). Status and weight are unchanged.
//   DIFFERENT_TIME  verified story-scoped evidence that the canon description concerns a different
//                   time than the campaign's present. It stays authored canon and keeps its status,
//                   but it is reference, not a current campaign fact.
export const CAMPAIGN_APPLICABILITY=Object.freeze({UNKNOWN:'UNKNOWN',DIFFERENT_TIME:'DIFFERENT_TIME'});

export function decideTruthOutcome({classification,intent,usableForIntent,hasEvidence=true,authority=null,timingUnspecified=false,conflict=null,campaignApplicability='UNKNOWN'}={}){
  const {FULL,SUPPORT_ONLY,DROPPED}=TRUTH_OUTCOME;
  const usable=usableForIntent===true;
  if(!hasEvidence)return result(DROPPED,'NO_NODE_EVIDENCE');
  if(conflict==='CHAT_WINS')return result(FULL,'CHAT_FACT_WINS');
  if(conflict==='CHAT_LOSES')return usable?result(SUPPORT_ONLY,'CHAT_FACT_SUPERSEDES_CANON'):result(DROPPED,'CHAT_FACT_SUPERSEDES_CANON');
  if(conflict==='UNSETTLED')return usable?result(SUPPORT_ONLY,'CONFLICT_UNSETTLED'):result(DROPPED,'NOT_USABLE_FOR_INTENT');
  if(campaignApplicability===CAMPAIGN_APPLICABILITY.DIFFERENT_TIME){
    // Reference answers questions about other times; it never stands as a current campaign fact.
    return intent==='HISTORICAL'||intent==='TEMPORAL'?result(FULL,'CANON_REFERENCE_MATCHES_TIME_QUESTION'):result(SUPPORT_ONLY,'CANON_REFERENCE_NOT_CURRENT');
  }
  switch(classification){
    case'CURRENT':
      return usable?result(FULL,authority==='CANON'?'CANON_NO_CONFLICT':'STATUS_CURRENT'):result(DROPPED,'NOT_USABLE_FOR_INTENT');
    case'HISTORICAL':
      return usable?result(FULL,'STATUS_MATCHES_TEMPORAL_QUESTION'):result(SUPPORT_ONLY,'STATUS_HISTORICAL_CONTEXT');
    case'SUPERSEDED':
      return usable?result(FULL,'STATUS_MATCHES_TEMPORAL_QUESTION'):result(DROPPED,'STATUS_SUPERSEDED');
    case'CONTRADICTED':
      return usable?result(SUPPORT_ONLY,'CONFLICT_UNSETTLED'):result(DROPPED,'NOT_USABLE_FOR_INTENT');
    case'UNCERTAIN':
      return usable?result(SUPPORT_ONLY,'STATUS_UNCERTAIN'):result(DROPPED,'NOT_USABLE_FOR_INTENT');
    case'UNRESOLVED':
      if(timingUnspecified){
        if(!usable)return result(DROPPED,'CANON_TIMING_NOT_ESTABLISHED');
        return intent==='CURRENT'?result(FULL,'CANON_NO_CONFLICT'):result(SUPPORT_ONLY,'CANON_TIMING_NOT_ESTABLISHED');
      }
      if(!usable)return result(DROPPED,'NOT_USABLE_FOR_INTENT');
      return result(SUPPORT_ONLY,authority==='CANON'?'STATUS_DECLARED_UNRESOLVED':'NO_STATUS_EVIDENCE');
    default:
      return result(DROPPED,'UNSUPPORTED_STATUS');
  }
}

const LORE_IMPORT_SOURCE_TYPE='SILLYTAVERN_WORLD_INFO';
const LORE_IMPORT_ORIGIN='legacy-lorebook';

// Source authority is independent of temporal status.
// Global lore supplies authority only through the active story's single bound
// Lorebook: canonBooks must name exactly that one book, and the node must belong to it.
// Globally enabled books, other stories and unbound reads never supply authority.
// Within the bound book a stored authority is honored as written; otherwise CANON is
// derived only from verified import provenance naming the book and entry exactly.
// Chat-scoped and non-lore nodes keep their own stored authority.
export function resolveNodeAuthority(node,{canonBooks=null}={}){
  const none=Object.freeze({authority:null,authoritySource:'NONE'});
  if(!node)return none;
  const globalLore=node.kind==='lore'&&node.scope==='global';
  if(!globalLore)return node.authority?Object.freeze({authority:String(node.authority),authoritySource:'STORED'}):none;
  const books=[...new Set((canonBooks??[]).map(String))];
  const book=node.payload?.book==null?'':String(node.payload.book);
  if(books.length!==1||book===''||books[0]!==book)return Object.freeze({authority:null,authoritySource:node.authority||node.provenance?.importedFrom?'OUT_OF_BINDING':'NONE'});
  if(node.authority)return Object.freeze({authority:String(node.authority),authoritySource:'STORED'});
  const uid=node.payload?.uid;
  const ids=new Set((node.provenance?.sourceIds??[]).map(String));
  const verified=node.provenance?.sourceType===LORE_IMPORT_SOURCE_TYPE&&node.provenance?.importedFrom===LORE_IMPORT_ORIGIN
    &&Number.isFinite(Number(uid))&&ids.has(book)&&ids.has(String(Number(uid)));
  return verified?Object.freeze({authority:'CANON',authoritySource:'IMPORT_PROVENANCE'}):none;
}

// Delivery: support-only text is labelled as context and sorts after full-weight text.
export const CONTEXT_ONLY_MARKER='[Context only: not an established current fact]';
export const isSupportOnlyTruth=truth=>truth?.weight===TRUTH_OUTCOME.SUPPORT_ONLY;

export function truthChunkPrefix(truth){
  const label=String(truth?.presentationLabel??'').trim();
  return [label,isSupportOnlyTruth(truth)?CONTEXT_ONLY_MARKER:''].filter(Boolean).join(' ');
}

// Stable partition: relative order inside each group is preserved.
export function fullWeightFirst(items,truthOf=item=>item?.a52Truth){
  const list=[...(items??[])];
  return [...list.filter(item=>!isSupportOnlyTruth(truthOf(item))),...list.filter(item=>isSupportOnlyTruth(truthOf(item)))];
}
