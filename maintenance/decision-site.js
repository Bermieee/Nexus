import { DECISION_MODE } from '../decision/constants.js';
import { registerDecisionSite, evaluateDecisionSite } from '../decision/site-registry.js';
import { clipDecisionText, stableDecisionFingerprint, resolveDecisionFingerprint } from '../decision/site-utils.js';

export const MAINTENANCE_FINDING_TRIAGE_SITE_ID='maintenance.finding-triage.v1';
export const MAINTENANCE_DECISION_MAX=8;
function finding(row={},index=0){return{id:String(row.id||`F${index+1}`),kind:String(row.kind||row.type||''),title:String(row.title||''),evidence:clipDecisionText(row.evidence||row.reason||row.summary||'',5000),deterministicSeverity:String(row.severity||''),refs:Array.isArray(row.refs)?row.refs.slice(0,12):[]};}
function state(context={}){return{maintenanceScope:context.maintenanceScope||null,pressure:context.pressure||null,findings:(context.findings||[]).slice(0,MAINTENANCE_DECISION_MAX).map(finding)};}
function contractQuestions(){const out={};for(let i=1;i<=MAINTENANCE_DECISION_MAX;i+=1){out[`finding_${i}_priority`]={type:'score',required:false};out[`finding_${i}_semantic_review`]={type:'noul',required:false};out[`finding_${i}_route`]={type:'choice',required:false};}return out;}
function questions(context={}){const out={};(context.findings||[]).slice(0,MAINTENANCE_DECISION_MAX).forEach((_,i)=>{const n=i+1;out[`finding_${n}_priority`]={type:'score',instructions:`Evaluate only state.findings[${i}]. How important is this finding for semantic maintenance attention, independent of queue pressure and mutation mechanics?`,criteria:['No meaningful attention','Low','Routine','High','Critical review attention']};out[`finding_${n}_semantic_review`]={type:'noul',instructions:`Evaluate only state.findings[${i}]. Does resolving this finding require semantic judgment beyond deterministic validation/counting?`};out[`finding_${n}_route`]={type:'choice',instructions:`Evaluate only state.findings[${i}]. Which review route best matches the semantic nature of this finding? This is shadow advisory routing only.`,criteria:{DETERMINISTIC:'Exact code/policy can resolve it.',OPERATOR:'Human semantic review is appropriate.',SIDECAR:'Generative synthesis/rewrite may be required after review admission.',DEFER:'Evidence is too weak or incomplete to route.'}};});return out;}
export function maintenanceFindingTriageFingerprint(context={}){return String(context.sourceFingerprint||stableDecisionFingerprint('maintenance-finding-triage',state(context)));}

export const MAINTENANCE_FINDING_TRIAGE_SITE=registerDecisionSite({
  id:MAINTENANCE_FINDING_TRIAGE_SITE_ID,subsystem:'maintenance',mode:DECISION_MODE.SHADOW,priority:20,
  contract:{id:MAINTENANCE_FINDING_TRIAGE_SITE_ID,version:1,subsystem:'maintenance',questions:contractQuestions()},
  buildState:state,buildQuestions:questions,
  getSourceFingerprint:maintenanceFindingTriageFingerprint,
  getCurrentSourceFingerprint(context){return resolveDecisionFingerprint(context,'maintenance-finding-triage',state(context));},
  metadata:{shadowOnly:true,boundary:'after-deterministic-maintenance-scan-before-expensive-review',authority:'none',candidateLimit:MAINTENANCE_DECISION_MAX},
});
export function evaluateMaintenanceFindingTriageShadow(context,options={}){return evaluateDecisionSite(MAINTENANCE_FINDING_TRIAGE_SITE_ID,context,{mode:DECISION_MODE.SHADOW,...options});}
