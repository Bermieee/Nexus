import { getContext } from '../../../../st-context.js';
import { DECISION_MODE } from '../decision/constants.js';
import { decisionAssistEnabled } from '../decision/mode.js';
import { registerDecisionSite, evaluateDecisionSite } from '../decision/site-registry.js';
import { hashLogicalSource } from '../nexus/large-input-reshape.js';
import { getSceneScannerSnapshot } from './scanner.js';

export const SCENE_SCAN_PREFLIGHT_SITE_ID='scene.scan-preflight.v1';

function clean(value){return String(value??'').replace(/\s+/g,' ').trim();}
function bounded(value,max=12000){const text=String(value??'');return text.length<=max?text:`${text.slice(-max)}\n[older evidence omitted]`;}
function recentEvidenceFromContext(context=getContext()){
  const rows=(Array.isArray(context?.chat)?context.chat:[]).filter(row=>!row?.is_system&&clean(row?.mes));
  return rows.slice(-4).map(row=>`[${row?.is_user===true?'User':'Assistant'}] ${String(row.mes||'').trim()}`).join('\n\n');
}
export function scenePreflightFingerprint({chatId=null,previousScene=null,recentEvidence=''}={}){
  return `scene-preflight-${hashLogicalSource(JSON.stringify({chatId:chatId==null?null:String(chatId),previousScene:previousScene||null,recentEvidence:String(recentEvidence||'')}))}`;
}

export const SCENE_SCAN_PREFLIGHT_SITE=registerDecisionSite({
  id:SCENE_SCAN_PREFLIGHT_SITE_ID,
  subsystem:'scene-scanner',
  mode:DECISION_MODE.ASSIST,
  priority:98,
  contract:{
    id:SCENE_SCAN_PREFLIGHT_SITE_ID,version:1,subsystem:'scene-scanner',questions:{
      scan_required:{type:'noul'},
      change_hint:{type:'choice'},
    },
  },
  buildState(context){return{previousScene:context.previousScene||null,recentEvidence:bounded(context.recentEvidence,12000)};},
  buildQuestions(){return{
    scan_required:{type:'noul',instructions:'Does the newest narrative evidence require refreshing the structured Scene Scanner observation? Say no only when the accepted participants, location, activity, objective, focus, time context, and material references can safely be reused unchanged. Say yes when any of those may have materially changed or the evidence is ambiguous.'},
    change_hint:{type:'choice',instructions:'Before any Scene Scanner worker runs, classify the likely semantic change from the previous accepted scene using only the supplied recent evidence. This is a routing hint, not scene observation.',criteria:{NO_CHANGE:'Stable continuation; prior structured scene can be reused.',MINOR_CHANGE:'Material focus/state/reference change within substantially the same scene topology.',MAJOR_CHANGE:'Likely participant arrival/departure, location move, time jump, or objective/activity topology transition.'}},
  };},
  getSourceFingerprint(context){return context.sourceFingerprint||scenePreflightFingerprint(context);},
  getCurrentSourceFingerprint(context){
    const live=context.readCurrentEvidence?.()??recentEvidenceFromContext();
    const currentScene=getSceneScannerSnapshot({chatId:context.chatId})?.acceptedScene||context.previousScene;
    return scenePreflightFingerprint({chatId:context.chatId,previousScene:currentScene,recentEvidence:live});
  },
  metadata:{decisionClass:'scene-scan-admission',shadowOnly:false,assist:true,direct:true,boundary:'before-scene-scanner-worker'},
});

export async function evaluateSceneScanPreflightAssist({chatId=null,previousScene=null,recentEvidence='',sourceFingerprint=null,readCurrentEvidence=null}={},options={}){
  if(!decisionAssistEnabled())return{ok:false,skipped:true,reason:'assist-off',contractId:SCENE_SCAN_PREFLIGHT_SITE_ID};
  if(!previousScene)return{ok:false,skipped:true,reason:'no-scene-baseline',contractId:SCENE_SCAN_PREFLIGHT_SITE_ID};
  const context={chatId,previousScene,recentEvidence,sourceFingerprint:sourceFingerprint||scenePreflightFingerprint({chatId,previousScene,recentEvidence}),readCurrentEvidence};
  return evaluateDecisionSite(SCENE_SCAN_PREFLIGHT_SITE_ID,context,{mode:DECISION_MODE.ASSIST,...options});
}

export function currentScenePreflightEvidence(){return recentEvidenceFromContext();}
