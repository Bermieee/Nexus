import { DECISION_MODE } from '../decision/constants.js';
import { decisionAssistEnabled } from '../decision/mode.js';
import { registerDecisionSite, evaluateDecisionSite } from '../decision/site-registry.js';
import { hashLogicalSource } from '../nexus/large-input-reshape.js';

export const POSTTURN_PROPOSAL_WARRANT_SITE_ID='postturn.proposal-warrant.v1';
export const MAX_POSTTURN_WARRANT_CANDIDATES=32;

function clean(value){return String(value??'').replace(/\s+/g,' ').trim();}
function bounded(value,max=1800){const text=String(value??'');return text.length<=max?text:`${text.slice(0,max)}…`;}
function operationRow(op,index){
  return{slot:index+1,type:clean(op?.type),book:clean(op?.book),uid:Number.isInteger(Number(op?.uid))?Number(op.uid):null,keepUid:Number.isInteger(Number(op?.keep_uid))?Number(op.keep_uid):null,removeUid:Number.isInteger(Number(op?.remove_uid))?Number(op.remove_uid):null,nodeId:clean(op?.node_id||op?.target_node_id||op?.parent_node_id||'' )||null,title:bounded(op?.title||op?.new_title||op?.label||'',400),content:bounded(op?.content||op?.new_content||op?.keep_content||op?.reason||'',1800)};
}
function evidenceRows(evidence=[]){return(evidence||[]).slice(0,48).map((row,index)=>({slot:index+1,kind:clean(row?.kind),statement:bounded(row?.statement,900),sourceIndices:[...(row?.source_indices||[])].map(Number).filter(Number.isInteger).slice(0,8)}));}
function contractQuestions(){return Object.fromEntries(Array.from({length:MAX_POSTTURN_WARRANT_CANDIDATES},(_,i)=>[`candidate_${i+1}_warranted`,{type:'noul',required:false}]));}
function questions(context={}){
  const out={};
  (context.operations||[]).slice(0,MAX_POSTTURN_WARRANT_CANDIDATES).forEach((_op,index)=>{
    const path=`candidates[${index}]`;
    out[`candidate_${index+1}_warranted`]={type:'noul',instructions:`Evaluate only \`${path}\` as a proposed durable lore mutation, while comparing it with the other supplied candidates for overlap. Is this exact mutation genuinely warranted now? Say yes only if it preserves durable reusable canon, is materially supported by the source evidence, and represents the best canonical home rather than duplicating/spraying the same fact across several UIDs or creating a tiny event card where an existing target is better. Treat transient scene texture, ordinary logistics, clock times, meals, movement, and already-covered facts as no. Historical catch-up requires especially strong novelty.`};
  });
  return out;
}
export function postTurnProposalWarrantFingerprint(context={}){
  const text=JSON.stringify({chatId:clean(context.chatId),chatRevision:clean(context.chatRevision),sourceRange:context.sourceRange||null,candidates:(context.operations||[]).map(operationRow),evidence:evidenceRows(context.evidence||[])});
  return `postturn-warrant-${hashLogicalSource(text)}-${text.length}`;
}

export const POSTTURN_PROPOSAL_WARRANT_SITE=registerDecisionSite({
  id:POSTTURN_PROPOSAL_WARRANT_SITE_ID,subsystem:'postturn',
  contract:{id:POSTTURN_PROPOSAL_WARRANT_SITE_ID,version:1,subsystem:'postturn',questions:contractQuestions()},
  mode:DECISION_MODE.ASSIST,priority:87,
  buildState(context){return{sourceRange:context.sourceRange||null,candidates:(context.operations||[]).slice(0,MAX_POSTTURN_WARRANT_CANDIDATES).map(operationRow),evidence:evidenceRows(context.evidence||[]),policy:{oneDurableFactOneCanonicalHome:true,newEntryRequiresNoBetterExistingHome:true,historicalCatchupRequiresStrongerNovelty:true}};},
  buildQuestions(context){return questions(context);},
  getSourceFingerprint(context){return context.sourceFingerprint||postTurnProposalWarrantFingerprint(context);},
  getCurrentSourceFingerprint(context){return typeof context.readCurrentSourceFingerprint==='function'?context.readCurrentSourceFingerprint():context.sourceFingerprint||postTurnProposalWarrantFingerprint(context);},
  metadata:{decisionClass:'postturn-proposal-warrant',shadowOnly:false,assist:true,boundary:'before-proposal-staging',maxCandidates:MAX_POSTTURN_WARRANT_CANDIDATES,route:'direct'},
});

export async function evaluatePostTurnProposalWarrants(context={},options={}){
  const operations=Array.isArray(context.operations)?context.operations:[];
  if(!operations.length)return{handled:true,operations:[],scores:[],reason:'empty'};
  if(operations.length>MAX_POSTTURN_WARRANT_CANDIDATES)return{handled:false,operations,reason:'candidate-bound-exceeded'};
  if(!decisionAssistEnabled())return{handled:false,operations,reason:'assist-off'};
  const sourceFingerprint=context.sourceFingerprint||postTurnProposalWarrantFingerprint(context);
  const result=await evaluateDecisionSite(POSTTURN_PROPOSAL_WARRANT_SITE_ID,{...context,sourceFingerprint},{mode:DECISION_MODE.ASSIST,...options});
  if(!result?.ok||result?.stale)return{handled:false,operations,reason:result?.stale?'stale':'decision-failed',result};
  const scored=operations.map((operation,index)=>({operation,index,score:Number(result.answers?.[`candidate_${index+1}_warranted`]?.value)}));
  const kept=scored.filter(row=>Number.isFinite(row.score)&&row.score>=0.65);
  return{handled:true,operations:kept.map(row=>row.operation),scores:scored.map(row=>({index:row.index,score:Number.isFinite(row.score)?row.score:null,type:row.operation?.type||null,book:row.operation?.book||null,uid:row.operation?.uid??null})),reason:'assist-success',result};
}
