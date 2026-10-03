import { clearWorkingState, readWorkingState, writeWorkingState } from '../core/ephemeral-state.js';

export const RETRIEVAL_SOURCE_PLAN_KIND='RETRIEVAL_SOURCE_PLAN';
const SENSORY_CONTINUATION_KIND='SENSORY_CONTINUATION';

function chatIdOf(context){return context?.chatId??context?.chat_id??null;}
function gateName(value){
  const text=String(value??'MINOR').toUpperCase();
  if(text.includes('NO_CHANGE')||text==='NO')return'NO_CHANGE';
  if(text.includes('MAJOR'))return'MAJOR';
  return'MINOR';
}
function truthName(value){return String(value??'CURRENT').toUpperCase();}

export function fallbackRetrievalSourcePlan({gate='MINOR',truthIntent='CURRENT'}={}){
  const mode=gateName(gate);
  let plan=mode==='NO_CHANGE'
    ?{hot:'lead',walker:'shallow',vector:'narrow',reasonCode:'CONTINUITY'}
    :mode==='MAJOR'
      ?{hot:'light',walker:'deep',vector:'wide',reasonCode:'NEW_ANCHORS'}
      :{hot:'normal',walker:'normal',vector:'normal',reasonCode:'BALANCED'};
  const intent=truthName(truthIntent);
  if(intent==='HISTORICAL'||intent==='TEMPORAL')plan={...plan,vector:'wide',reasonCode:intent};
  if(intent==='CONTRADICTION')plan={...plan,walker:'deep',reasonCode:'CONTRADICTION'};
  return Object.freeze(plan);
}

export function writeRetrievalSourcePlan(plan,{context=null,sceneRevision=null,sourceFingerprint=null,source='fallback'}={}){
  const chatId=chatIdOf(context);if(chatId==null)return null;
  const value=Object.freeze({
    plan:Object.freeze({...plan,watchNodeIds:[...new Set((plan?.watchNodeIds??[]).filter(Boolean).map(String))].slice(0,64)}),
    sceneRevision:sceneRevision==null?null:Number(sceneRevision),
    sourceFingerprint:sourceFingerprint==null?null:String(sourceFingerprint),
    source:String(source||'fallback'),
    storedAt:Date.now(),
  });
  writeWorkingState(RETRIEVAL_SOURCE_PLAN_KIND,String(chatId),value);
  return value;
}

export function readRetrievalSourcePlan({context=null,sceneRevision=null}={}){
  const chatId=chatIdOf(context);if(chatId==null)return null;
  const row=readWorkingState(RETRIEVAL_SOURCE_PLAN_KIND,String(chatId));if(!row?.plan)return null;
  if(sceneRevision!=null&&row.sceneRevision!=null&&Number(row.sceneRevision)!==Number(sceneRevision))return null;
  return row;
}

export function clearRetrievalSourcePlan({context=null,chatId=chatIdOf(context)}={}){
  if(chatId==null)return false;
  clearWorkingState(RETRIEVAL_SOURCE_PLAN_KIND,String(chatId));
  return true;
}

export function retrievalSourcePlanMultipliers(plan={}){
  const hot={lead:1.35,normal:1,light:.7}[plan.hot]??1,watch=Math.max(1,Math.min(1.2,Number(plan.watchBoost)||1));
  const walker=({deep:1.5,normal:1,shallow:.55,skip:0}[plan.walker]??1),vector=({wide:1.5,normal:1,narrow:.6,skip:0}[plan.vector]??1);
  return Object.freeze({hot,walker,vector,watch});
}

export function readSensoryContinuation({context=null}={}){
  const chatId=chatIdOf(context);return chatId==null?null:readWorkingState(SENSORY_CONTINUATION_KIND,String(chatId));
}
export function writeSensoryContinuation(value,{context=null}={}){
  const chatId=chatIdOf(context);if(chatId==null)return null;
  return value?writeWorkingState(SENSORY_CONTINUATION_KIND,String(chatId),value):clearWorkingState(SENSORY_CONTINUATION_KIND,String(chatId));
}

// Every production count is computed in this shared frame; receipts retain the
// driver values and next offsets rather than turning defaults into fixed caps.
export function createSensoryTurnPlan({budgetManager,timeMs=15,worldSize=1,sourcePlan={},promptTokens=4096,tokenShare=1,tokensPerCandidate=1,channelTotals={},reservations=[]}={}){
  const frame=budgetManager.beginTurn({timeMs,worldSize,promptTokens});
  for(const reservation of reservations)frame.reserve(reservation.id,reservation.ms);
  const receipts=[],multipliers=retrievalSourcePlanMultipliers(sourcePlan);
  const grant=(id,defaults,total,multiplier,ceiling,tokenCost=0)=>{
    const receipt=frame.compute(id,{total:Math.max(0,Math.floor(total)),defaultUnits:defaults,defaultWorldSize:defaults,multiplier,sanityCeiling:ceiling,tokensPerUnit:tokenCost,tokenShare,msPerUnit:1});
    receipts.push(receipt);return receipt.allowed;
  };
  const walker=(prefix,multiplier)=>({
    maxDepth:grant(prefix+'.depth',3,12,multiplier,12),
    maxNodes:grant(prefix+'.nodes',96,worldSize,multiplier,4096),
    maxEdges:grant(prefix+'.edges',192,Math.max(192,worldSize*4),multiplier,8192),
    maxCandidates:grant(prefix+'.candidates',64,Math.max(64,worldSize),multiplier,2048,tokensPerCandidate),
    latencyBudgetMs:grant(prefix+'.milliseconds',15,Math.min(250,timeMs),multiplier,250),
  });
  const minimumSourceMs=Object.entries(channelTotals).filter(([channel,total])=>total>0&&!(channel==='paging'&&sourcePlan.vector==='skip')).reduce((sum,[channel])=>sum+budgetManager.estimate('sensory.channel.'+channel),0);
  frame.reserve('sensory.minimum-source-coverage',minimumSourceMs);
  const walkerLimits=walker('walker',multipliers.walker);
  const correctiveWalkerLimits=walker('truth.corrective.walker',Math.max(1,multipliers.walker));
  frame.release('sensory.minimum-source-coverage');
  // Hold the Walker's time allocation while computing the competing sources.
  frame.reserve('walker.foreground',walkerLimits.latencyBudgetMs);
  const channelCandidateLimits={};
  for(const [channel,total] of Object.entries(channelTotals)){
    const multiplier=channel==='paging'?multipliers.vector:channel==='hot-continuity'?multipliers.hot:1;
    channelCandidateLimits[channel]=grant('sensory.channel.'+channel,128,total,multiplier,4096,tokensPerCandidate);
  }
  frame.release('walker.foreground');
  const total=Object.values(channelTotals).reduce((sum,value)=>sum+value,0)+walkerLimits.maxCandidates;
  const fusedCandidateLimit=grant('sensory.fused',256,Math.max(256,total),1,4096,tokensPerCandidate);
  return {frame,receipts,multipliers,walkerLimits,correctiveWalkerLimits,channelCandidateLimits,fusedCandidateLimit,latencyBudgetMs:Math.max(0,timeMs)};
}
