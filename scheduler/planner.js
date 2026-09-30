import { NEXUS_JOB_ROUTE, createNexusJobPlan } from '../nexus/contracts.js';
import { LIFECYCLE_JOBS } from './jobs.js';

// Pure deterministic planner; physical execution and publication stay outside.
export function planLifecycleJobs({gates,classification,source,eventId,eventType,revision,normalizeJob,now=()=>Date.now()}){
  const jobs=[],decisions=[];
  for(const row of LIFECYCLE_JOBS){
    if(gates[row.policy]&&row.due(classification)){
      const {route=NEXUS_JOB_ROUTE.MODEL_WORKER,...extra}=row.extra(classification,gates);
      jobs.push(normalizeJob({type:row.type,name:row.name,kind:row.kind,priority:row.priority,...extra},route));
      decisions.push({action:'run',job:row.type,route,reason:row.reason(classification)});
    }else decisions.push({action:'skip',job:row.type,reason:gates[row.policy]?row.skipReason(classification):'disabled by policy'});
  }
  // Boundary crossing still requires an explicit external ticket.
  if(gates.coldOpen&&classification.coldStart)decisions.push({action:'offer',capability:'cold-open',external:true,reason:'cold start detected; explicit external ticket may be created by the caller'});
  else decisions.push({action:'skip',job:'cold-open',reason:gates.coldOpen?'not a cold start':'disabled by policy'});
  return createNexusJobPlan({eventId,source,classification,decisions,jobs,metadata:{plannedAt:now(),eventType,revision,planner:'deterministic'}});
}
