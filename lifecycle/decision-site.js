import { DECISION_MODE } from '../decision/constants.js';
import { decisionAssistEnabled } from '../decision/mode.js';
import { registerDecisionSite, evaluateDecisionSite } from '../decision/site-registry.js';
import { hashLogicalSource } from '../nexus/large-input-reshape.js';

export const LIFECYCLE_WORK_ADMISSION_SITE_ID='lifecycle.work-admission.v1';
export const LIFECYCLE_EVIDENCE_ROUTE_SITE_ID='lifecycle.evidence-route.v1';
export const LIFECYCLE_CANONICAL_HOME_SITE_ID='lifecycle.canonical-home.v1';
export const MAX_LIFECYCLE_CANONICAL_CLUSTERS=8;
export const MAX_LIFECYCLE_CANONICAL_CANDIDATES=6;

export const LIFECYCLE_DESTINATION=Object.freeze({
  NONE:'NONE',
  NARRATIVE_MEMORY:'NARRATIVE_MEMORY',
  CHARACTER_STATE:'CHARACTER_STATE',
  DURABLE_LORE:'DURABLE_LORE',
});

// False-positive lore/Character State work is expensive and noisy. Narrative
// memory is intentionally easier to admit because it cannot mutate canonical
// lore and exists to preserve continuity after verbatim history ages out.
export const LIFECYCLE_ROUTE_THRESHOLD=Object.freeze({
  narrativeMemory:0.55,
  characterState:0.78,
  durableLore:0.82,
  reviewFloor:0.45,
});


export function classifyLifecycleEvidenceScores(scores={}){
  const normalized={
    narrativeMemory:Number(scores.narrativeMemory),
    characterState:Number(scores.characterState),
    durableLore:Number(scores.durableLore),
    primarilyTransient:Number(scores.primarilyTransient),
  };
  if(!Number.isFinite(normalized.narrativeMemory)||!Number.isFinite(normalized.characterState)||!Number.isFinite(normalized.durableLore)){
    return {valid:false,destinations:[],primary:null,scores:normalized};
  }
  const uncertain={
    characterState:normalized.characterState>=LIFECYCLE_ROUTE_THRESHOLD.reviewFloor&&normalized.characterState<LIFECYCLE_ROUTE_THRESHOLD.characterState,
    durableLore:normalized.durableLore>=LIFECYCLE_ROUTE_THRESHOLD.reviewFloor&&normalized.durableLore<LIFECYCLE_ROUTE_THRESHOLD.durableLore,
  };
  const destinations=[];
  // Borderline persistent-state judgments are preserved as Narrative Memory
  // rather than treated as confident NONE. Summary can re-evaluate them later
  // with broader chronological context without spending a mutation worker now.
  if(normalized.narrativeMemory>=LIFECYCLE_ROUTE_THRESHOLD.narrativeMemory||uncertain.characterState||uncertain.durableLore)destinations.push(LIFECYCLE_DESTINATION.NARRATIVE_MEMORY);
  if(normalized.characterState>=LIFECYCLE_ROUTE_THRESHOLD.characterState)destinations.push(LIFECYCLE_DESTINATION.CHARACTER_STATE);
  if(normalized.durableLore>=LIFECYCLE_ROUTE_THRESHOLD.durableLore)destinations.push(LIFECYCLE_DESTINATION.DURABLE_LORE);
  const primary=destinations.includes(LIFECYCLE_DESTINATION.DURABLE_LORE)?LIFECYCLE_DESTINATION.DURABLE_LORE
    :destinations.includes(LIFECYCLE_DESTINATION.CHARACTER_STATE)?LIFECYCLE_DESTINATION.CHARACTER_STATE
    :destinations.includes(LIFECYCLE_DESTINATION.NARRATIVE_MEMORY)?LIFECYCLE_DESTINATION.NARRATIVE_MEMORY
    :LIFECYCLE_DESTINATION.NONE;
  return {valid:true,destinations,primary,scores:normalized,uncertain};
}

function clean(value){return String(value??'').replace(/\s+/g,' ').trim();}
function compact(value,max=2400){const text=String(value??'');return text.length<=max?text:`${text.slice(0,max)}…`;}
function stable(value){
  if(Array.isArray(value))return value.map(stable);
  if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])]));
  return value;
}
function probability(result,id){const n=Number(result?.answers?.[id]?.value);return Number.isFinite(n)?n:null;}

export function lifecycleAdmissionFingerprint(context={}){
  const payload={task:clean(context.task),chatId:clean(context.chatId),chatRevision:clean(context.chatRevision),metrics:stable(context.metrics||{}),evidence:compact(context.evidence,3000)};
  const text=JSON.stringify(payload);return `lifecycle-admission-${hashLogicalSource(text)}-${text.length}`;
}

export function lifecycleEvidenceRouteFingerprint(context={}){
  const payload={
    sourceKind:clean(context.sourceKind||'post-turn'),
    chatId:clean(context.chatId),
    chatRevision:clean(context.chatRevision),
    sourceRange:Array.isArray(context.sourceRange)?context.sourceRange.slice(0,2):null,
    sourceIds:Array.isArray(context.sourceIds)?context.sourceIds.map(String):[],
    scene:stable(context.scene||{}),
    previousScene:stable(context.previousScene||{}),
    sceneMeta:stable({scanRevision:context.sceneMeta?.scanRevision||null,scannerSource:context.sceneMeta?.scannerSource||null,scannerReasoning:context.sceneMeta?.scannerReasoning||'',degraded:context.sceneMeta?.degraded===true}),
    change:stable(context.change||{}),
    participants:Array.isArray(context.participants)?context.participants.map(String):[],
    references:stable(context.references||{}),
    evidence:compact(context.evidence,24000),
    narrativeState:compact(context.narrativeState,2600),
    characterState:compact(context.characterState,3200),
    characterStateOwners:stable(context.characterStateOwners||{}),
    canonicalHints:stable(context.canonicalHints||{}),
    pending:stable(context.pending||{}),
  };
  const text=JSON.stringify(payload);return `lifecycle-evidence-route-${hashLogicalSource(text)}-${text.length}`;
}

export const LIFECYCLE_WORK_ADMISSION_SITE=registerDecisionSite({
  id:LIFECYCLE_WORK_ADMISSION_SITE_ID,
  subsystem:'lifecycle',
  contract:{id:LIFECYCLE_WORK_ADMISSION_SITE_ID,version:1,subsystem:'lifecycle',questions:{work_action:{type:'choice'}}},
  mode:DECISION_MODE.ASSIST,
  priority:88,
  buildState(context){return{task:clean(context.task),metrics:stable(context.metrics||{}),recentEvidence:compact(context.evidence,3000),policy:context.policy||null};},
  buildQuestions(context){
    const task=clean(context.task)||'background lifecycle task';
    return{work_action:{type:'choice',instructions:`Decide whether this exact Nexus ${task} lifecycle workload should execute now. Cadence only made the task eligible; it is not execution authority. Prefer SKIP when there is no material new work. Use DROP_STALE only when the supplied queued historical work is old enough that processing it now is more likely to create obsolete/duplicative state than useful current state. Use RUN only when the work is materially useful now.`,criteria:{RUN:'Execute the eligible lifecycle work now because it is materially useful and current.',SKIP:'Do not execute now; there is no material work worth spending a worker call on.',DROP_STALE:'Discard the queued historical workload and advance its processing fence; stale catch-up would be harmful or obsolete.'}}};
  },
  getSourceFingerprint(context){return context.sourceFingerprint||lifecycleAdmissionFingerprint(context);},
  getCurrentSourceFingerprint(context){return typeof context.readCurrentSourceFingerprint==='function'?context.readCurrentSourceFingerprint():context.sourceFingerprint||lifecycleAdmissionFingerprint(context);},
  metadata:{decisionClass:'lifecycle-work-admission',shadowOnly:false,assist:true,boundary:'before-lifecycle-worker',route:'direct'},
});

/**
 * Unified Automatic-mode semantic router.
 *
 * The questions are deliberately independent Nouls: one evidence window may be
 * useful narrative memory and also contain a Character State change, while
 * durable generic lore remains false. Code owns all destination/mutation policy.
 */
export const LIFECYCLE_EVIDENCE_ROUTE_SITE=registerDecisionSite({
  id:LIFECYCLE_EVIDENCE_ROUTE_SITE_ID,
  subsystem:'lifecycle',
  contract:{id:LIFECYCLE_EVIDENCE_ROUTE_SITE_ID,version:1,subsystem:'lifecycle',questions:{
    narrative_memory_worthy:{type:'noul'},
    character_state_change:{type:'noul'},
    durable_lore_change:{type:'noul'},
    primarily_transient:{type:'noul'},
  }},
  mode:DECISION_MODE.ASSIST,
  priority:92,
  buildState(context={}){return{
    sourceKind:clean(context.sourceKind||'post-turn'),
    sourceRange:Array.isArray(context.sourceRange)?context.sourceRange.slice(0,2):null,
    sourceIds:Array.isArray(context.sourceIds)?context.sourceIds.map(String):[],
    scene:stable(context.scene||{}),
    previousScene:stable(context.previousScene||{}),
    sceneMeta:stable(context.sceneMeta||{}),
    change:stable(context.change||{}),
    participants:Array.isArray(context.participants)?context.participants.map(String):[],
    references:stable(context.references||{}),
    newEvidence:compact(context.evidence,24000),
    narrativeState:compact(context.narrativeState,2600),
    characterState:compact(context.characterState,3200),
    characterStateOwners:stable(context.characterStateOwners||{}),
    canonicalHints:stable(context.canonicalHints||{}),
    pending:stable(context.pending||{}),
    policy:{
      cadenceIsEligibilityOnly:true,
      ordinaryConversationIsNotLore:true,
      loreIsNotDiary:true,
      characterStateOwnsCharacterSpecificPersistentState:true,
      structuralMaintenanceIsNotAutomaticPostTurn:true,
      ...(context.policy||{}),
    },
  };},
  buildQuestions(){return{
    narrative_memory_worthy:{type:'noul',instructions:'Judge the exact source window in `newEvidence` in light of the accepted current `scene`, `previousScene`, `change`, `participants`, `references`, and existing `narrativeState`. Does this evidence add story continuity worth remembering after verbatim chat ages out — meaningful conversation, emotional/relationship texture, decisions, scene progression, commitments, unresolved threads, or another later-useful beat? Do not answer yes merely because known lore entities are mentioned. Repetition already covered by `narrativeState` is not new memory.',criteria:{true:'The exact evidence window adds later-useful narrative continuity that Summary/Notebook should preserve.',false:'The window is disposable filler, redundant with existing narrative memory, or contains no later-useful continuity.'}},
    character_state_change:{type:'noul',instructions:'Compare `newEvidence` with `characterState`, using `characterStateOwners`, `scene`, `previousScene`, `change`, `participants`, and `references` only as context. Does the evidence establish a materially new or changed character-specific state that should be handled by Character State review — such as a persistent relationship/role/allegiance, condition, equipment/capability state, goal, title/status, lasting physical change, or tracked current condition? Answer yes only when `characterStateOwners.relevant` identifies a configured Character Bank capable of owning the affected character. A fleeting reaction, temporary mood, ordinary dialogue, demonstrated already-known trait, or fact already present/pending in `characterState` is no.',criteria:{true:'A persistent/current tracked character state materially changed and a configured Character Bank is the proper owner.',false:'No owned Character State change is established; the evidence is temporary, already known/pending, has no configured Character Bank owner, or belongs elsewhere.'}},
    durable_lore_change:{type:'noul',instructions:'Judge whether the exact `newEvidence`, after comparing it with `scene`, `previousScene`, `change`, `references`, `characterState`, `characterStateOwners`, `narrativeState`, and `canonicalHints`, establishes genuinely NEW persistent generic canon that future scenes should retrieve from the lorebook. Yes examples: a lasting world rule, permanent/reusable location or organization fact, durable item/ability/world fact, institutional rule, or major persistent arc/world-state fact with no better configured Character State owner. A durable character-specific fact with no configured Character Bank owner may still be generic lore when it clearly needs persistent canonical storage. No examples: ordinary conversation, meals, classroom exchanges, jokes, transient emotions, scene logistics, a known fact merely being mentioned or demonstrated, or character-specific state with an appropriate configured Character Bank owner. `canonicalHints` are comparison context, not permission to mutate.',criteria:{true:'The source window contains novel durable canon worthy of the existing Lore proposal worker and no better configured Character State owner covers that fact.',false:'No novel durable lore is established; retain it as Narrative Memory/owned Character State or nowhere.'}},
    primarily_transient:{type:'noul',instructions:'Using `newEvidence` together with the accepted `scene` and `change`, is the source window primarily immediate-scene/conversational texture rather than persistent canon? This may be yes at the same time as `narrative_memory_worthy`; it must not override a separately supported durable fact.',criteria:{true:'Most value is temporary scene/conversation continuity.',false:'A substantial part of the evidence is persistent beyond the immediate scene.'}},
  };},
  getSourceFingerprint(context){return context.sourceFingerprint||lifecycleEvidenceRouteFingerprint(context);},
  getCurrentSourceFingerprint(context){return typeof context.readCurrentSourceFingerprint==='function'?context.readCurrentSourceFingerprint():context.sourceFingerprint||lifecycleEvidenceRouteFingerprint(context);},
  metadata:{decisionClass:'lifecycle-evidence-route',shadowOnly:false,assist:true,boundary:'before-automatic-lifecycle-worker',canonicalMutation:false,route:'direct'},
});



function canonicalHomeQuestionContract(){
  return Object.fromEntries(Array.from({length:MAX_LIFECYCLE_CANONICAL_CLUSTERS},(_,index)=>[`cluster_${index+1}_home`,{type:'choice',required:false}]));
}
function canonicalClusterState(row,index){
  return {
    slot:index+1,
    id:clean(row?.id||`cluster-${index+1}`),
    kind:clean(row?.kind||'fact'),
    statement:compact(row?.statement,2200),
    sourceIndices:Array.isArray(row?.sourceIndices)?row.sourceIndices.map(Number).filter(Number.isInteger).slice(0,12):[],
    sourceIds:Array.isArray(row?.sourceIds)?row.sourceIds.map(String).slice(0,12):[],
    candidates:(row?.candidates||[]).slice(0,MAX_LIFECYCLE_CANONICAL_CANDIDATES).map((candidate,candidateIndex)=>({
      slot:candidateIndex+1,
      book:clean(candidate?.book),
      uid:Number.isInteger(Number(candidate?.uid))?Number(candidate.uid):null,
      nodeId:clean(candidate?.nodeId)||null,
      title:compact(candidate?.title,500),
      path:Array.isArray(candidate?.path)?candidate.path.map(String).slice(0,8):[],
      content:compact(candidate?.content,1800),
      score:Number(candidate?.score)||0,
    })),
  };
}
export function lifecycleCanonicalHomeFingerprint(context={}){
  const payload={
    chatId:clean(context.chatId),
    sourceKind:clean(context.sourceKind),
    sourceRange:Array.isArray(context.sourceRange)?context.sourceRange.slice(0,2):null,
    sourceVersion:clean(context.sourceVersion),
    clusters:(context.clusters||[]).slice(0,MAX_LIFECYCLE_CANONICAL_CLUSTERS).map(canonicalClusterState),
    policy:stable(context.policy||{}),
  };
  const text=JSON.stringify(payload);return `lifecycle-canonical-home-${hashLogicalSource(text)}-${text.length}`;
}

export const LIFECYCLE_CANONICAL_HOME_SITE=registerDecisionSite({
  id:LIFECYCLE_CANONICAL_HOME_SITE_ID,
  subsystem:'lifecycle',
  contract:{id:LIFECYCLE_CANONICAL_HOME_SITE_ID,version:1,subsystem:'lifecycle',questions:canonicalHomeQuestionContract()},
  mode:DECISION_MODE.ASSIST,priority:93,
  buildState(context={}){return{
    sourceKind:clean(context.sourceKind),
    sourceRange:Array.isArray(context.sourceRange)?context.sourceRange.slice(0,2):null,
    sourceVersion:clean(context.sourceVersion),
    clusters:(context.clusters||[]).slice(0,MAX_LIFECYCLE_CANONICAL_CLUSTERS).map(canonicalClusterState),
    policy:{oneEvidenceClusterOneCanonicalHome:true,automaticAuthorityOnly:true,structuralMaintenanceForbidden:true,...(context.policy||{})},
  };},
  buildQuestions(context={}){
    const out={};
    (context.clusters||[]).slice(0,MAX_LIFECYCLE_CANONICAL_CLUSTERS).forEach((cluster,index)=>{
      const statePath=`clusters[${index}]`;
      const criteria={};
      (cluster?.candidates||[]).slice(0,MAX_LIFECYCLE_CANONICAL_CANDIDATES).forEach((_candidate,candidateIndex)=>{
        criteria[`HOME_${candidateIndex+1}`]=`Use only \`${statePath}.candidates[${candidateIndex}]\` as the single canonical home for this evidence cluster.`;
      });
      criteria.NEW_ENTRY='No supplied existing candidate cleanly owns this genuinely new durable cluster; allow one new lore entry proposal.';
      criteria.NO_MUTATION='The supplied candidates already cover the cluster, the cluster is not novel/durable enough to mutate canon, or no safe canonical home can be chosen.';
      out[`cluster_${index+1}_home`]={type:'choice',instructions:`Evaluate only \`${statePath}\`. Choose exactly ONE canonical disposition for this exact evidence cluster before any drafting occurs. Prefer the strongest existing candidate that naturally owns the whole cluster. Do not spread the same cluster across multiple UIDs. Choose NEW_ENTRY only when the cluster is genuinely new durable canon and none of the supplied candidates is an appropriate home. Choose NO_MUTATION when canon already covers the meaning, the evidence is not sufficiently durable/novel, or the supplied evidence/candidates are insufficient. This is routing only; do not draft lore or propose structural maintenance.`,criteria};
    });
    return out;
  },
  getSourceFingerprint(context){return context.sourceFingerprint||lifecycleCanonicalHomeFingerprint(context);},
  getCurrentSourceFingerprint(context){return typeof context.readCurrentSourceFingerprint==='function'?context.readCurrentSourceFingerprint():context.sourceFingerprint||lifecycleCanonicalHomeFingerprint(context);},
  metadata:{decisionClass:'lifecycle-canonical-home',shadowOnly:false,assist:true,boundary:'after-durable-evidence-before-drafting',canonicalMutation:false,route:'direct'},
});

export async function evaluateLifecycleCanonicalHomes(context={},options={}){
  const clusters=Array.isArray(context.clusters)?context.clusters.slice(0,MAX_LIFECYCLE_CANONICAL_CLUSTERS):[];
  if(!clusters.length)return{handled:true,resolutions:[],reason:'empty'};
  if(!decisionAssistEnabled())return{handled:false,resolutions:[],reason:'assist-off'};
  const sourceFingerprint=context.sourceFingerprint||lifecycleCanonicalHomeFingerprint(context);
  const result=await evaluateDecisionSite(LIFECYCLE_CANONICAL_HOME_SITE_ID,{...context,sourceFingerprint},{mode:DECISION_MODE.ASSIST,...options});
  if(!result?.ok||result?.stale)return{handled:false,resolutions:[],reason:result?.stale?'stale':'decision-failed',result};
  const resolutions=[];
  for(let index=0;index<clusters.length;index+=1){
    const cluster=clusters[index];
    const answer=result.answers?.[`cluster_${index+1}_home`];
    const choice=clean(answer?.value).toUpperCase();
    const confidence=Number.isFinite(Number(answer?.confidence))?Number(answer.confidence):null;
    if(!choice)return{handled:false,resolutions:[],reason:'missing-choice',result};
    if(choice==='NO_MUTATION'){resolutions.push({clusterId:clean(cluster?.id||`cluster-${index+1}`),disposition:'NO_MUTATION',confidence,candidate:null});continue;}
    if(choice==='NEW_ENTRY'){resolutions.push({clusterId:clean(cluster?.id||`cluster-${index+1}`),disposition:'NEW_ENTRY',confidence,candidate:null});continue;}
    const match=choice.match(/^HOME_(\d+)$/);
    const candidateIndex=match?Number(match[1])-1:-1;
    const candidate=(cluster?.candidates||[])[candidateIndex]||null;
    if(!candidate)return{handled:false,resolutions:[],reason:'invalid-home-choice',result};
    resolutions.push({clusterId:clean(cluster?.id||`cluster-${index+1}`),disposition:'EXISTING_HOME',confidence,candidate:{...candidate}});
  }
  return{handled:true,resolutions,reason:'assist-success',result};
}

export async function evaluateLifecycleWorkAdmission(context={},options={}){
  if(!decisionAssistEnabled())return{handled:false,reason:'assist-off',action:null,result:null};
  const sourceFingerprint=context.sourceFingerprint||lifecycleAdmissionFingerprint(context);
  const result=await evaluateDecisionSite(LIFECYCLE_WORK_ADMISSION_SITE_ID,{...context,sourceFingerprint},{mode:DECISION_MODE.ASSIST,...options});
  if(!result?.ok||result?.stale)return{handled:false,reason:result?.stale?'stale':'decision-failed',action:null,result};
  const action=clean(result.answers?.work_action?.value).toUpperCase();
  if(!['RUN','SKIP','DROP_STALE'].includes(action))return{handled:false,reason:'invalid-action',action:null,result};
  return{handled:true,reason:'assist-success',action,result};
}

export async function evaluateLifecycleEvidenceRoute(context={},options={}){
  if(!decisionAssistEnabled())return{handled:false,reason:'assist-off',destinations:[],primary:null,result:null};
  const sourceFingerprint=context.sourceFingerprint||lifecycleEvidenceRouteFingerprint(context);
  const result=await evaluateDecisionSite(LIFECYCLE_EVIDENCE_ROUTE_SITE_ID,{...context,sourceFingerprint},{mode:DECISION_MODE.ASSIST,...options});
  if(!result?.ok||result?.stale)return{handled:false,reason:result?.stale?'stale':'decision-failed',destinations:[],primary:null,result};
  const scores={
    narrativeMemory:probability(result,'narrative_memory_worthy'),
    characterState:probability(result,'character_state_change'),
    durableLore:probability(result,'durable_lore_change'),
    primarilyTransient:probability(result,'primarily_transient'),
  };
  const classified=classifyLifecycleEvidenceScores(scores);
  if(!classified.valid)return{handled:false,reason:'invalid-probabilities',destinations:[],primary:null,scores:classified.scores,result};
  return{handled:true,reason:'assist-success',destinations:classified.destinations,primary:classified.primary,scores:classified.scores,uncertain:classified.uncertain,result};
}
