import { clearWorkingState, readWorkingState, writeWorkingState } from '../core/ephemeral-state.js';

export const RETRIEVAL_SOURCE_PLAN_KIND='RETRIEVAL_SOURCE_PLAN';

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
    plan:Object.freeze({...plan}),
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
  const walker=({deep:1.5,normal:1,shallow:.55,skip:0}[plan.walker]??1)*watch,vector=({wide:1.5,normal:1,narrow:.6,skip:0}[plan.vector]??1)*watch;
  return Object.freeze({hot,walker,vector,watch});
}
