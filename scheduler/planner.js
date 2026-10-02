import { NEXUS_JOB_ROUTE, createNexusJobPlan } from '../nexus/contracts.js';
import { LIFECYCLE_JOBS, SCENE_POST_TURN_JOBS } from './jobs.js';

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

export function selectSceneJobs({gate=null,eventType='generation-end',messageIndex=null,greenRoomDue=false}={}){
  const event=String(eventType).toUpperCase();
  if(['CHAT_CHANGED','CHAT_CHANGE'].includes(event))return {jobIds:[],messageIndex:null,invalidateFirst:false,reasonCode:'CHAT_CHANGED'};
  const edit=['MESSAGE_EDITED','MESSAGE_SWIPED','MESSAGE_DELETED','EDIT','SWIPE','DELETE'].includes(event);
  if(edit&&!Number.isInteger(messageIndex))return {jobIds:[],messageIndex:null,invalidateFirst:false,reasonCode:'AFFECTED_MESSAGE_REQUIRED'};
  const rawMode=String(gate?.mode??'MAJOR').toUpperCase().replace('_CHANGE','');
  const mode=['NO','NO_CHANGE','MINOR','MAJOR'].includes(rawMode)?rawMode:'MAJOR';
  const jobIds=SCENE_POST_TURN_JOBS.filter(row=>edit?row.trigger.onEdit:row.trigger.gate.includes(mode)||(row.id==='greenroom.infer'&&greenRoomDue)).map(row=>row.id);
  return {jobIds,messageIndex:edit?messageIndex:null,invalidateFirst:edit,reasonCode:edit?'SOURCE_EDIT':mode==='NO'?(greenRoomDue?'GREEN_ROOM_TTL':'NO_CHANGE'):mode};
}
