import { DECISION_PROVIDER, DECISION_PROVIDER_CLASS } from './constants.js';
import { logEvent } from '../observability/telemetry.js';

const STORAGE_KEY='nexus:decision-records:v1',MAX_RECORDS=512;
let rows=[],loaded=false,sequence=0;
const clean=(value,max=160)=>String(value??'').trim().slice(0,max);
const uniq=values=>[...new Set((values??[]).map(value=>clean(value)).filter(Boolean))];
export const DECISION_RECORD_REASON_TEXT=Object.freeze({
  PROVIDER:'Decision Core provider supplied the accepted bounded choice.',
  RULE_FALLBACK:'Deterministic code supplied the bounded fallback choice.',
  DECISION_OFF:'Decision Core was off, so deterministic code supplied the choice.',
  STALE:'The provider result was stale before it could be consumed.',
  STALE_RESULT:'The provider result was stale before it could be consumed.',
  INVALID_OUTPUT:'The provider answer was outside the allowed bounded choices.',
  DECISION_ERROR:'Decision Core failed safely and deterministic code supplied the choice.',
  NO_FOREGROUND_DEADLINE:'No foreground Decision Core deadline was available.',
  FOREGROUND_DEADLINE_EXHAUSTED:'The foreground decision budget expired before a provider result was usable.',
  FOREGROUND_ABORTED:'The foreground decision was cancelled with the parent turn.',
  INFER_TRUTH_NEED:'Deterministic Truth intent classification was used.',
  NO_CORRECTIVE:'No corrective retrieval pass was justified.',
  AUTH:'The decision provider rejected authentication.',BILLING:'The decision provider reported a billing failure.',
  VALIDATION:'The decision request or response failed bounded validation.',RATE_LIMIT:'The decision provider was rate limited.',
  OVERLOADED:'The decision provider was overloaded.',TIMEOUT:'The decision provider timed out.',NETWORK:'The decision provider could not be reached.',
  MALFORMED_TYPED_OUTPUT:'The provider returned malformed typed output.',API_DRIFT:'The provider response did not match the expected API contract.',
  PROVIDER_DISABLED:'The Decision Core provider was disabled.',NOT_CONFIGURED:'No usable Decision Core provider was configured.',
  FALLBACK_FAILED:'The provider chain and fallback path both failed.',UNKNOWN_CONTRACT:'The requested Decision Core contract was unknown.',
  RETRIEVAL_CONTINUITY:'The retrieval plan emphasized continuity.',RETRIEVAL_BALANCED:'The retrieval plan kept source emphasis balanced.',
  RETRIEVAL_NEW_ANCHORS:'The retrieval plan expanded around new scene or entity anchors.',RETRIEVAL_HISTORICAL:'The retrieval plan emphasized historical evidence.',
  RETRIEVAL_TEMPORAL:'The retrieval plan emphasized time-sensitive evidence.',RETRIEVAL_CONTRADICTION:'The retrieval plan emphasized conflicting claims.',
  RETRIEVAL_OTHER:'The retrieval plan used its bounded fallback reason.',OTHER:'A bounded site-specific fallback reason was used.',
});
const KNOWN=new Set(Object.keys(DECISION_RECORD_REASON_TEXT));
function load(){if(loaded)return;loaded=true;try{const parsed=JSON.parse(globalThis.sessionStorage?.getItem?.(STORAGE_KEY)||'[]');rows=Array.isArray(parsed)?parsed.slice(-MAX_RECORDS):[];}catch{}}
function persist(){try{globalThis.sessionStorage?.setItem?.(STORAGE_KEY,JSON.stringify(rows.slice(-MAX_RECORDS)));}catch{}}
const reason=value=>{const code=clean(value,96).toUpperCase();return KNOWN.has(code)?code:'OTHER';};
function bySource({decidedBy=null,source='fallback',provider=null,providerClass=null}={}){
  const explicit=clean(decidedBy,24).toUpperCase();if(['RULE','JEV','FALLBACK','OWNER'].includes(explicit))return explicit;
  if(source!=='provider')return'RULE';
  if(provider===DECISION_PROVIDER.DETERMINISTIC||providerClass===DECISION_PROVIDER_CLASS.DETERMINISTIC)return'RULE';
  return provider===DECISION_PROVIDER.LLM_FALLBACK||providerClass===DECISION_PROVIDER_CLASS.LLM_FALLBACK?'FALLBACK':'JEV';
}
export function recordDecisionRecord(input={}){
  load();const site=clean(input.site),selection=input.selection??{},ts=Number(input.ts)||Date.now();
  if(!site)throw new TypeError('DecisionRecord site is required');
  const reasonCodes=uniq(input.reasonCodes?.length?input.reasonCodes:[input.reasonCode]).map(reason).slice(0,8);
  const subjectId=clean(input.subject?.id??selection.schedulerTaskId??selection.turnId??selection.generationId??site);
  const subjectType=['node','edge','candidate','job','memory'].includes(String(input.subject?.type??'').toLowerCase())?String(input.subject.type).toLowerCase():'job';
  const evidence=[];if(selection.turnId!=null)evidence.push(Object.freeze({type:'turn',ref:'turn:'+clean(selection.turnId),weight:1}));
  const row=Object.freeze({
    kind:'DecisionRecord',id:clean(input.id,220)||['decision',site,ts,++sequence].join(':'),ts,
    generationId:selection.generationId==null?null:clean(selection.generationId),chatId:selection.chatId==null?null:clean(selection.chatId),
    site,subsystem:clean(input.subsystem,80)||null,subject:Object.freeze({type:subjectType,id:subjectId}),
    options:Object.freeze(uniq(input.options).slice(0,32)),chosen:clean(input.chosen,320)||'EVALUATED',
    decidedBy:bySource(input),reasonCodes:Object.freeze(reasonCodes.length?reasonCodes:['OTHER']),evidence:Object.freeze(evidence),
    score:Number.isFinite(Number(input.score))?Number(input.score):null,threshold:Number.isFinite(Number(input.threshold))?Number(input.threshold):null,
    latencyMs:Math.max(0,Number(input.latencyMs)||0),budget:Object.freeze({granted:null,used:null,deferred:null}),
  });
  rows.push(row);if(rows.length>MAX_RECORDS)rows.splice(0,rows.length-MAX_RECORDS);persist();
  logEvent('decision-core','decision.record',{id:row.id,site:row.site,subsystem:row.subsystem,subject:row.subject,chosen:row.chosen,decidedBy:row.decidedBy,reasonCodes:row.reasonCodes,chatId:row.chatId,generationId:row.generationId,latencyMs:row.latencyMs},'debug');
  return Object.freeze({...row,why:Object.freeze(row.reasonCodes.map(code=>DECISION_RECORD_REASON_TEXT[code]).filter(Boolean))});
}
export function readDecisionRecords({chatId=null,generationId=null,site=null,limit=128}={}){
  load();return rows.filter(row=>(chatId==null||String(row.chatId??'')===String(chatId))&&(generationId==null||String(row.generationId??'')===String(generationId))&&(site==null||row.site===String(site))).slice(-Math.max(1,Math.min(MAX_RECORDS,Number(limit)||128))).map(row=>Object.freeze({...row,why:Object.freeze(row.reasonCodes.map(code=>DECISION_RECORD_REASON_TEXT[code]).filter(Boolean))}));
}
export function summarizeDecisionAnswers(answers={}){
  if(!answers||typeof answers!=='object')return'EVALUATED';const parts=[];
  for(const [key,row] of Object.entries(answers).slice(0,12)){const value=row?.choice??row?.value??row;if(['string','number','boolean'].includes(typeof value))parts.push(clean(key,32)+'='+clean(value,64));}
  return parts.length?parts.join('|').slice(0,320):'EVALUATED';
}
export function resetDecisionRecordsForTests(){rows=[];loaded=true;sequence=0;try{globalThis.sessionStorage?.removeItem?.(STORAGE_KEY);}catch{}}
