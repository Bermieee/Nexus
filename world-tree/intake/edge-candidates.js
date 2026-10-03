import {stableHash,stableStringify} from './contribution.js';
import {contributionSourcesFresh} from './source-snapshot.js';
const clone=value=>structuredClone(value);
export function edgeCandidateId(edge){return 'edge-candidate:'+stableHash([edge.fromNodeId,edge.toNodeId,edge.meaning,edge.subtype??null]);}
function summarize(row){
 const observations=Object.values(row.observations);
 row.turnKeys=[...new Set(observations.map(value=>value.turnKey))];
 row.sourceRefs=[...new Map(observations.flatMap(value=>value.sourceRefs).map(value=>[stableStringify(value),clone(value)])).values()];
 row.lastTurn=Math.max(...observations.map(value=>value.currentTurn??0));
 return row;
}
export function noteDeferredEdge(state,edge){
 state.edgeCandidates??={};const candidateId=edgeCandidateId(edge),row=state.edgeCandidates[candidateId]??{candidateId,observations:{}};
 const message=edge.sourceRefs.find(ref=>ref&&typeof ref==='object'&&(ref.messageId??ref.message_id)!=null);
 row.observations[edge.ledgerKey+'|'+edge.id]={...clone(edge),turnKey:message?'message:'+String(message.messageId??message.message_id):'contribution:'+edge.ledgerKey};
 state.edgeCandidates[candidateId]=summarize(row);return clone(row);
}
export function retireDeferredEdges(state,{context,tree,lineageKey=null,ledgerKey=null,retainedIds=null,currentTurn=null,ttlTurns=24}={}){
 for(const [id,row] of Object.entries(state.edgeCandidates??{})){
  for(const [key,observation] of Object.entries(row.observations)){
   const sourceFresh=contributionSourcesFresh(observation.sourceSnapshot,context,tree);
   const originsFresh=(observation.originSnapshots??[]).every(snapshot=>{const node=tree?.getNode(snapshot.nodeId,{chatId:state.chatId});return node&&node.temporal?.status!=='SUPERSEDED'&&stableHash(node.data?.sourceRecord??node.data?.sourceRefs??null)===snapshot.fingerprint;});
   const revised=lineageKey&&observation.lineageKey===lineageKey&&observation.ledgerKey!==ledgerKey&&!(retainedIds??new Set()).has(id);
   const expired=currentTurn!=null&&observation.currentTurn!=null&&currentTurn-observation.currentTurn>=ttlTurns;
   if(!sourceFresh||!originsFresh||revised||expired)delete row.observations[key];
  }
  if(!Object.keys(row.observations).length)delete state.edgeCandidates[id];else summarize(row);
 }
}
