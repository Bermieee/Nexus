import { TASK8_POSTTURN_SITE_IDS, runTask8ChoiceDecision } from '../decision/task8-postturn-sites.js';
import { recordWorldTreeDecision, sourceRefsToDecisionEvidence } from './decision-records.js';
import { logEvent } from '../observability/telemetry.js';

export const WORLD_TREE_GROWTH_THRESHOLD=0.75;
export const WORLD_TREE_GROWTH_REVIEW_FLOOR=0.55;
const AUTHORITY=Object.freeze({CANON:.8,CARD:.8,OBSERVED:.4,REMEMBERED:.3,INFERRED:.15});
const clamp=value=>Math.max(0,Math.min(1,Number(value)||0));
export function scoreWorldTreeGrowth({authority='INFERRED',independentSources=1,repetition=1,scenePresence=false,knownEndpoints=false,sourceSupported=false,contradiction=false}={}){
  const authorityScore=AUTHORITY[String(authority).toUpperCase()]??AUTHORITY.INFERRED;
  const independent=Math.min(.3,Math.max(0,Number(independentSources)-1)*.15);
  const repeat=Math.min(.2,Math.max(0,Number(repetition))*.05);
  return clamp(authorityScore+independent+repeat+(scenePresence?.35:0)+(knownEndpoints?.22:0)+(sourceSupported?.25:0)+(contradiction?-.35:0));
}
function reasons({authority,independentSources,scenePresence,sourceSupported,score}){
  const rows=[];if(['CANON','CARD'].includes(String(authority).toUpperCase()))rows.push('AUTHORITY_CLEAR');
  if(Number(independentSources)>=3)rows.push('THREE_INDEPENDENT_TURNS');if(scenePresence)rows.push('SCENE_PRESENCE');
  if(sourceSupported)rows.push('SOURCE_SUPPORTED_EDGE');
  if(score<WORLD_TREE_GROWTH_REVIEW_FLOOR)rows.push('GROWTH_BELOW_THRESHOLD');else if(score<WORLD_TREE_GROWTH_THRESHOLD)rows.push('GROWTH_BORDERLINE');
  return rows;
}
export async function decideWorldTreeGrowth({tree,context=null,subject,authority='INFERRED',source=null,sourceRefs=[],independentSources=1,repetition=1,scenePresence=false,knownEndpoints=false,sourceSupported=false,edgeProposal=false,globalProposal=false,contradiction=false,advisor=runTask8ChoiceDecision}={}){
  const score=scoreWorldTreeGrowth({authority,independentSources,repetition,scenePresence,knownEndpoints,sourceSupported,contradiction}),reasonCodes=reasons({authority,independentSources,scenePresence,sourceSupported,score});
  let chosen='WAIT',decidedBy='RULE',latencyMs=0;
  const authorityName=String(authority).toUpperCase(),minimumEvidenceMet=scenePresence||sourceSupported||['CANON','CARD'].includes(authorityName)||Number(independentSources)>=3||(edgeProposal&&knownEndpoints&&Number(independentSources)>=2);
  if(globalProposal&&authorityName==='INFERRED'){chosen='REVIEW';reasonCodes.push('GROWTH_REVIEW');}
  else if(score>=WORLD_TREE_GROWTH_THRESHOLD&&minimumEvidenceMet)chosen='GROW';
  else if(score>=WORLD_TREE_GROWTH_REVIEW_FLOOR&&minimumEvidenceMet){
    const started=Date.now(),run=await advisor(TASK8_POSTTURN_SITE_IDS.WORLDTREE_GROWTH,{state:{subject,authority:String(authority),independentSources:Number(independentSources),repetition:Number(repetition),scenePresence:Boolean(scenePresence),knownEndpoints:Boolean(knownEndpoints),sourceSupported:Boolean(sourceSupported),contradiction:Boolean(contradiction),score,threshold:WORLD_TREE_GROWTH_THRESHOLD}},'WAIT',{reasonCode:'GROWTH_BORDERLINE',telemetrySelection:{chatId:context?.chatId??context?.chat_id??null},recordTrace:false});
    latencyMs=Date.now()-started;chosen=['GROW','WAIT','REVIEW'].includes(run.choice)?run.choice:'WAIT';decidedBy=run.source==='provider'?'JEV':'FALLBACK';if(chosen==='REVIEW')reasonCodes.push('GROWTH_REVIEW');
  }
  const record=recordWorldTreeDecision(tree,{generationId:context?.generationId??null,chatId:context?.chatId??context?.chat_id??null,site:'worldtree.growth',subject,options:['GROW','WAIT','REVIEW'],chosen,decidedBy,reasonCodes,evidence:sourceRefsToDecisionEvidence(source??String(authority).toLowerCase(),sourceRefs),score,threshold:WORLD_TREE_GROWTH_THRESHOLD,latencyMs});
  logEvent('worldtree.growth',chosen.toLowerCase(),{subject,authority:String(authority),score,threshold:WORLD_TREE_GROWTH_THRESHOLD,decidedBy,reasonCodes,decisionRecordId:record.id},chosen==='REVIEW'?'info':'debug');
  return{chosen,score,threshold:WORLD_TREE_GROWTH_THRESHOLD,decidedBy,reasonCodes,record};
}
