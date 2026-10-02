import { stableHash, stableStringify } from './intake/contribution.js';
import { logEvent } from '../observability/telemetry.js';

export const WORLD_TREE_DECISION_REASON_TEXT=Object.freeze({
  CONTRIBUTION_VALIDATED:'Contribution passed World Tree scope and intake validation.',
  EXACT_UID_OR_ALIAS:'Matched an existing UID, title, or alias exactly.',
  IDENTITY_REGISTRY_MATCH:'Resolved through the entity identity registry.',
  SIMILARITY_CLEAR_MARGIN:'A similarity candidate cleared the acceptance margin.',
  JEV_IDENTITY_ADVICE:'Decision Core resolved an otherwise ambiguous identity.',
  UNRESOLVED_MENTION:'No safe identity match was available.',
  THREE_INDEPENDENT_TURNS:'Seen in at least three independent turns.',
  SCENE_PRESENCE:'Observed as current scene cast or location.',
  AUTHORITY_CLEAR:'Source authority clearly justifies growth.',
  GROWTH_BELOW_THRESHOLD:'Evidence is below the automatic growth threshold.',
  GROWTH_BORDERLINE:'Evidence is near the growth threshold and required advice.',
  GROWTH_REVIEW:'Growth needs owner review.',
  ENTERED_FROM_WATCHLIST:'A watched item entered the current scene or contribution.',
  WATCH_EXPIRED:'A watched item did not enter before its horizon expired.',
  CANDIDATE_GAINING_EVIDENCE:'An unresolved candidate is accumulating independent evidence.',
  MENTIONED_AS_DESTINATION:'Scene references identify this as a likely destination.',
  SUMMONED:'Scene references identify this as a likely incoming participant.',
  REFERENCED_OFFSTAGE:'Scene references identify this as relevant but not currently present.',
  THREAD_HORIZON:'An open Hot Cognition thread points toward this item.',
});
const DECIDERS=new Set(['RULE','JEV','FALLBACK','OWNER']);
const TYPES=new Set(['node','edge','candidate','job','memory']);
const EVIDENCE_TYPES=new Set(['turn','scene','lore','card','memory']);
const clean=value=>String(value??'').trim();
const uniq=values=>[...new Set((values??[]).map(clean).filter(Boolean))];
function evidenceRows(rows=[]){
  return (Array.isArray(rows)?rows:[]).slice(0,32).map(row=>({
    type:EVIDENCE_TYPES.has(String(row?.type))?String(row.type):'turn',
    ref:clean(row?.ref),
    weight:Number.isFinite(Number(row?.weight))?Math.max(-1,Math.min(1,Number(row.weight))):0,
  })).filter(row=>row.ref);
}
export function sourceRefsToDecisionEvidence(source,refs=[]){
  const type=source==='card'?'card':source==='scene'?'scene':['memory','character-memory'].includes(source)?'memory':source==='owner'?'lore':'turn';
  return (refs??[]).slice(0,24).map(ref=>({type,ref:stableStringify(ref),weight:1}));
}
export function recordWorldTreeDecision(tree,input={}){
  if(!tree?.recordDecision)throw new TypeError('World Tree decision storage is unavailable');
  const site=clean(input.site),chosen=clean(input.chosen),decidedBy=clean(input.decidedBy).toUpperCase();
  const subjectType=TYPES.has(String(input?.subject?.type))?String(input.subject.type):'job',subjectId=clean(input?.subject?.id);
  if(!site||!chosen||!subjectId||!DECIDERS.has(decidedBy))throw new TypeError('DecisionRecord requires site, subject, chosen and decidedBy');
  const ts=Number(input.ts)||Date.now(),reasons=uniq(input.reasonCodes).filter(code=>WORLD_TREE_DECISION_REASON_TEXT[code]).slice(0,12);
  const id=clean(input.id)||'decision:'+stableHash([site,subjectType,subjectId,chosen,decidedBy,ts,tree.revision,tree.sequence]);
  const record={
    kind:'DecisionRecord',id,ts,generationId:input.generationId==null?null:String(input.generationId),chatId:input.chatId==null?null:String(input.chatId),
    site,subject:{type:subjectType,id:subjectId},options:uniq(input.options).slice(0,16),chosen,decidedBy,reasonCodes:reasons,
    evidence:evidenceRows(input.evidence),score:Number.isFinite(Number(input.score))?Number(input.score):null,threshold:Number.isFinite(Number(input.threshold))?Number(input.threshold):null,
    latencyMs:Math.max(0,Number(input.latencyMs)||0),budget:{
      granted:Number.isFinite(Number(input?.budget?.granted))?Number(input.budget.granted):null,
      used:Number.isFinite(Number(input?.budget?.used))?Number(input.budget.used):null,
      deferred:Number.isFinite(Number(input?.budget?.deferred))?Number(input.budget.deferred):null,
    },
  };
  const saved=tree.recordDecision(record);
  logEvent('worldtree.decision','recorded',{id:saved.id,site:saved.site,subject:saved.subject,chosen:saved.chosen,decidedBy:saved.decidedBy,reasonCodes:saved.reasonCodes,score:saved.score,threshold:saved.threshold,latencyMs:saved.latencyMs},'debug');
  return saved;
}
export function readableDecisionReasons(record){
  return (record?.reasonCodes??[]).map(code=>WORLD_TREE_DECISION_REASON_TEXT[code]).filter(Boolean);
}
export function decisionHistoryForRow(tree,row,{limit=24}={}){
  const ids=uniq(row?.data?.decisionRecordIds).slice(-Math.max(1,Number(limit)||24));
  return ids.map(id=>tree.getDecisionRecord?.(id)).filter(Boolean).map(record=>({...record,why:readableDecisionReasons(record)}));
}
