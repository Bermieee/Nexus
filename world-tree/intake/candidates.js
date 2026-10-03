import { stableHash, stableStringify } from './contribution.js';
import {contributionSourcesFresh} from './source-snapshot.js';

export const WORLD_TREE_CANDIDATE_METADATA_KEY='nexus_world_tree_unresolved_mentions_v1';
const clone=value=>value==null?value:structuredClone(value);
const empty=chatId=>({version:1,chatId:String(chatId),candidates:{},pendingEdges:{},applications:{},updatedAt:0});
function chatIdOf(context,chatId){const value=chatId??context?.chatId??context?.chat_id;return value==null?null:String(value);}
function turnKey(sourceRefs,occurrenceKey){
  for(const ref of sourceRefs??[]){
    if(ref&&typeof ref==='object'&&(ref.messageId??ref.message_id??ref.id)!=null)return 'message:'+String(ref.messageId??ref.message_id??ref.id);
  }
  return 'contribution:'+String(occurrenceKey);
}
export function readWorldTreeCandidateState({context,chatId=null}={}){
  const id=chatIdOf(context,chatId);if(!id)return null;
  const raw=context?.chatMetadata?.[WORLD_TREE_CANDIDATE_METADATA_KEY];
  if(!raw||raw.version!==1||String(raw.chatId)!==id)return empty(id);
  return clone(raw);
}
export function persistWorldTreeCandidateState(state,{context,chatId=null}={}){
  const id=chatIdOf(context,chatId);if(!id||!context?.chatMetadata)return false;
  const next=clone(state??empty(id));next.version=1;next.chatId=id;next.updatedAt=Date.now();
  context.chatMetadata[WORLD_TREE_CANDIDATE_METADATA_KEY]=next;try{context.saveMetadataDebounced?.();}catch{}
  return true;
}
export function clearWorldTreeCandidateState({context}={}){
  if(!context?.chatMetadata)return false;delete context.chatMetadata[WORLD_TREE_CANDIDATE_METADATA_KEY];try{context.saveMetadataDebounced?.();}catch{}return true;
}
export function candidateIdForMention({text,kindHint=null}={}){
  return 'mention-candidate:'+stableHash([String(kindHint??'UNKNOWN').toUpperCase(),String(text??'').trim().toLocaleLowerCase().replace(/\s+/g,' ')]);
}
export function noteUnresolvedMention(state,{mention,sourceRefs=[],occurrenceKey,lineageKey=null,ledgerKey=null,sourceSnapshot=null,originSnapshots=[],promotionThreshold=3,promotionReason=null,currentTurn=null,authority=null}={}){
  const candidateId=candidateIdForMention(mention),prior=state.candidates[candidateId]??{candidateId,label:String(mention.text),kindHint:mention.kindHint??null,aliasesSeen:[],turnKeys:[],sourceRefs:[],mentionCount:0,createdAt:Date.now(),updatedAt:0};
  const alias=String(mention.text).trim();if(alias&&!prior.aliasesSeen.includes(alias))prior.aliasesSeen.push(alias);
  const key=turnKey(sourceRefs,occurrenceKey);if(!prior.turnKeys.includes(key))prior.turnKeys.push(key);
  if(lineageKey){prior.observations??={};prior.observations[String(ledgerKey)]={lineageKey,ledgerKey,turnKey:key,sourceRefs:clone(sourceRefs),authority,currentTurn,sourceSnapshot:clone(sourceSnapshot),originSnapshots:clone(originSnapshots)};}
  const seen=new Set(prior.sourceRefs.map(stableStringify));for(const ref of sourceRefs){const encoded=stableStringify(ref);if(!seen.has(encoded)){prior.sourceRefs.push(clone(ref));seen.add(encoded);}}
  prior.mentionCount=prior.turnKeys.length;prior.updatedAt=Date.now();
  if(currentTurn!=null&&Number.isFinite(Number(currentTurn))){prior.firstTurn=prior.firstTurn??Number(currentTurn);prior.lastTurn=Number(currentTurn);}
  if(authority)prior.authorities=[...new Set([...(prior.authorities??[]),String(authority).toUpperCase()])];
  state.candidates[candidateId]=prior;
  return {candidate:clone(prior),candidateId,shouldPromote:Boolean(promotionReason)||prior.mentionCount>=Math.max(1,Number(promotionThreshold)||3),promotionReason:promotionReason??(prior.mentionCount>=Math.max(1,Number(promotionThreshold)||3)?'mention-threshold':null)};
}
export function expireWorldTreeCandidates(state,{currentTurn,ttlTurns=24}={}){
  if(!state||!Number.isFinite(Number(currentTurn)))return[];
  const expired=[];for(const [id,row] of Object.entries(state.candidates??{})){if(row.lastTurn==null||Number(currentTurn)-Number(row.lastTurn)<Math.max(1,Number(ttlTurns)||24))continue;expired.push(clone(row));delete state.candidates[id];for(const [edgeId,edge] of Object.entries(state.pendingEdges??{}))if(edge.fromCandidateId===id||edge.toCandidateId===id)delete state.pendingEdges[edgeId];}
  return expired;
}
export function queuePendingCandidateEdge(state,{id,fromNodeId=null,toNodeId=null,fromCandidateId=null,toCandidateId=null,meaning,subtype=null,authority,sourceRefs=[],validFrom=null,validTo=null,weight=null,sourceSceneIds=[],contribution=null,ledgerKey=null,lineageKey=null,decisionRecordIds=[],sourceField=null,sourceSnippetHash=null,sourceSnapshot=null,originSnapshots=[]}={}){
  const edgeId=String(id);state.pendingEdges[edgeId]={id:edgeId,fromNodeId,toNodeId,fromCandidateId,toCandidateId,meaning,subtype,authority,sourceRefs:clone(sourceRefs),validFrom,validTo,weight,sourceSceneIds:clone(sourceSceneIds),contribution:clone(contribution),ledgerKey,lineageKey,decisionRecordIds:clone(decisionRecordIds),sourceField,sourceSnippetHash,sourceSnapshot:clone(sourceSnapshot),originSnapshots:clone(originSnapshots),updatedAt:Date.now()};return clone(state.pendingEdges[edgeId]);
}
export function retireStaleCandidateSources(state,context,tree){
  const originsFresh=row=>(row.originSnapshots??[]).every(snapshot=>{const node=tree?.getNode(snapshot.nodeId,{chatId:state.chatId});return node&&node.temporal?.status!=='SUPERSEDED'&&stableHash(node.data?.sourceRecord??node.data?.sourceRefs??null)===snapshot.fingerprint;});
  for(const [id,edge] of Object.entries(state.pendingEdges??{}))if(!contributionSourcesFresh(edge.sourceSnapshot,context)||!originsFresh(edge))delete state.pendingEdges[id];
  for(const [id,candidate] of Object.entries(state.candidates??{})){
    const observations=Object.entries(candidate.observations??{}),stale=observations.filter(([,row])=>!contributionSourcesFresh(row.sourceSnapshot,context)||!originsFresh(row));if(!stale.length)continue;
    for(const [key] of stale)delete candidate.observations[key];const remaining=Object.values(candidate.observations);
    candidate.turnKeys=[...new Set(remaining.map(row=>row.turnKey))];candidate.mentionCount=candidate.turnKeys.length;candidate.sourceRefs=remaining.flatMap(row=>clone(row.sourceRefs));
    if(!remaining.length)delete state.candidates[id];
  }
}
export function retireCandidateContribution(state,{lineageKey,ledgerKey,mentions=[]}={}){
  const retained=new Set(mentions.map(candidateIdForMention));
  for(const [id,edge] of Object.entries(state.pendingEdges??{}))if(edge.lineageKey===lineageKey&&edge.ledgerKey!==ledgerKey)delete state.pendingEdges[id];
  for(const [id,candidate] of Object.entries(state.candidates??{})){
    if(retained.has(id))continue;
    const stale=Object.entries(candidate.observations??{}).filter(([,row])=>row.lineageKey===lineageKey&&row.ledgerKey!==ledgerKey);if(!stale.length)continue;
    for(const [key] of stale)delete candidate.observations[key];const observations=Object.values(candidate.observations);
    candidate.turnKeys=[...new Set(observations.map(row=>row.turnKey))];candidate.mentionCount=candidate.turnKeys.length;
    candidate.sourceRefs=observations.flatMap(row=>clone(row.sourceRefs));candidate.authorities=[...new Set(observations.map(row=>row.authority).filter(Boolean))];
    if(!observations.length)delete state.candidates[id];
  }
  return state;
}
export function promoteCandidateInState(state,{candidateId,nodeId}={}){
  const id=String(candidateId),ready=[];
  delete state.candidates[id];
  for(const edge of Object.values(state.pendingEdges)){
    if(edge.fromCandidateId===id){edge.fromCandidateId=null;edge.fromNodeId=String(nodeId);}
    if(edge.toCandidateId===id){edge.toCandidateId=null;edge.toNodeId=String(nodeId);}
    if(edge.fromNodeId&&edge.toNodeId&&!edge.fromCandidateId&&!edge.toCandidateId){ready.push(clone(edge));delete state.pendingEdges[edge.id];}
  }
  return ready;
}
export function candidateApplicationFingerprint(state,ledgerKey){return state?.applications?.[String(ledgerKey)]?.fingerprint??null;}
export function markCandidateApplication(state,{ledgerKey,fingerprint}={}){
  state.applications[String(ledgerKey)]={fingerprint:String(fingerprint),appliedAt:Date.now()};return state;
}
export function listWorldTreeCandidates({context,chatId=null}={}){
  const state=readWorldTreeCandidateState({context,chatId});return state?Object.values(state.candidates).map(clone):[];
}
