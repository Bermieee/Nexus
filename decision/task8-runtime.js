import { createCanonicalWorldTreeReadApi, normalizeWorldTreeAlias } from '../core/world-tree-api.js';
import { readWorkingState } from '../core/ephemeral-state.js';
import { currentNexusHotSnapshot } from '../nexus/hot-cognition.js';
import { getNexusSceneIntelligenceView } from '../nexus/scene-intelligence.js';
import { getRetrievalDiagnosticsSnapshot } from '../retrieval/diagnostics.js';
import { fallbackRetrievalSourcePlan, writeRetrievalSourcePlan } from '../retrieval/source-plan.js';
import { TASK8_POSTTURN_SITE_IDS, runRetrievalSourcePlanDecision, runTask8ChoiceDecision } from './task8-postturn-sites.js';
import { logEvent } from '../observability/telemetry.js';
import { writeTask8PostTurnAdvice } from './task8-advice.js';
import { observeWorldTreeTrackAppearances, recordWorldTreeTrackSuggestion } from '../world-tree/tracking.js';
import { getNexusWorldTreeOwner, readWorldTreeStoryBinding } from '../world-tree/index.js';
import { chatCanonConflictPairs } from './truth-conflict-pairs.js';
import { listWorldTreeCandidates } from '../world-tree/intake/candidates.js';
import { syncWorldTreeWatchList, worldTreeWatchRetrievalBoost } from '../world-tree/watch-list.js';
import { getSceneScannerSnapshot } from '../scene/scanner.js';
import { enqueueProposal } from '../proposals/store.js';
import { compatibleReflectionReadings, stageTask8Review } from './task8-review-proposals.js';
import { captureNexusWorkScope, isNexusWorkScopeFresh } from '../nexus/work-scope.js';
import { getGenerationFrameIdentity } from '../nexus/generation-frame-bus.js';

const MAX_DECISIONS_PER_FAMILY=4;
const MIXED_CONFIDENCE=0.5;

function chatIdOf(context){return context?.chatId??context?.chat_id??null;}
function uniq(values=[]){return[...new Set(values.filter(Boolean).map(String))];}
function safeText(value,max=700){const text=String(value??'').replace(/\s+/g,' ').trim();return text.length<=max?text:text.slice(0,max)+'…';}
function aliases(node){return uniq(node?.aliases??[]).map(normalizeWorldTreeAlias).filter(Boolean);}
function overlap(a,b){const right=new Set(aliases(b));return aliases(a).some(value=>right.has(value));}
function nodeSummary(node){return{id:String(node?.id??''),kind:String(node?.kind??''),scope:String(node?.scope??''),revision:Number(node?.revision??0),temporalStatus:String(node?.temporalStatus??''),aliases:(node?.aliases??[]).slice(0,8),summary:safeText(node?.payload?.title??node?.payload?.text??node?.payload?.content??node?.payload?.label??'',900)};}
function sourceCounts(candidates=[]){
  const out={};
  for(const row of candidates??[])for(const source of row?.discoverySources??[])out[source]=(out[source]??0)+1;
  return out;
}
function sceneReferenceNames(scene={}){
  return uniq([...(scene?.participants??[]),scene?.location,...(scene?.threads??[]).map(row=>typeof row==='string'?row:row?.label??row?.title??row?.name)]);
}
function hotThreads(snapshot){
  const rows=snapshot?.segments?.ACTIVE_THREADS?.value??snapshot?.segments?.activeThreads?.value??[];
  return rows.map((row,index)=>typeof row==='string'?{id:row,label:row}:{id:String(row?.id??row?.threadId??row?.label??row?.title??'thread-'+index),label:String(row?.objective??row?.unresolvedQuestion??row?.summary??row?.label??row?.title??row?.name??row?.threadId??row?.id??'thread'),state:row?.state??row?.status??null}).slice(0,MAX_DECISIONS_PER_FAMILY);
}
function greenRows(chatId){
  const state=readWorkingState('GREEN_ROOM',String(chatId))??{};
  const active=(state.states??[]).map(row=>Array.isArray(row)?row[1]:row).filter(Boolean);
  return{active,history:Array.isArray(state.history)?state.history:[]};
}
function compatibleHistory(history,characterRef){
  return compatibleReflectionReadings(history,characterRef);
}
function worldPairs(nodes,predicate=()=>true){
  const result=[];
  for(let i=0;i<nodes.length;i+=1)for(let j=i+1;j<nodes.length;j+=1){
    if(!overlap(nodes[i],nodes[j])||!predicate(nodes[i],nodes[j]))continue;
    result.push([nodes[i],nodes[j]]);
    if(result.length>=MAX_DECISIONS_PER_FAMILY)return result;
  }
  return result;
}


export async function runTask8PostTurnAdvisoryPass({context=null,gate=null,sceneReason=null,generationId=null,isFresh=()=>true}={}){
  const chatId=chatIdOf(context);if(chatId==null)return{skipped:true,reason:'no-chat'};
  const scene=getNexusSceneIntelligenceView({chatId})??{},tree=getNexusWorldTreeOwner(),hot=currentNexusHotSnapshot({context});
  const frame=getGenerationFrameIdentity(),scope=captureNexusWorkScope(context);
  const selection={chatId,generationId:generationId??context?.generationId??(String(frame?.chatId??'')===String(chatId)?frame?.generationId:null)??null};
  const fresh=()=>isFresh()!==false&&isNexusWorkScopeFresh(scope,context)&&getNexusSceneIntelligenceView({chatId})?.revision===scene.revision;
  const assertFresh=()=>{if(!fresh()){const error=new Error('Post-turn advisory origin is stale');error.name='TV2ScopeInvalidated';throw error;}};
  const choose=async(...args)=>{assertFresh();const result=await runTask8ChoiceDecision(...args);assertFresh();return result;};
  const stageReview=async(site,subjects,choice,evidenceRefs=[])=>{assertFresh();return stageTask8Review({...selection,site,subjects,choice,evidenceRefs},{enqueue:enqueueProposal,isFresh:fresh});};
  const watchEntries=syncWorldTreeWatchList({tree,chatId,generationId:selection.generationId,sceneScan:getSceneScannerSnapshot({chatId}),hotSnapshot:hot,candidates:listWorldTreeCandidates({context,chatId}),currentTurn:Array.isArray(context?.chat)?Math.max(0,context.chat.length-1):0});
  const watchBoost=worldTreeWatchRetrievalBoost({tree,chatId}),retrieval=getRetrievalDiagnosticsSnapshot({chatId});
  const fallbackPlan={...fallbackRetrievalSourcePlan({gate:gate?.mode??gate??retrieval?.gateMode??'MINOR',truthIntent:retrieval?.truthIntent??'CURRENT'}),watchNodeIds:watchBoost.nodeIds};
  const contributionCounts=sourceCounts(retrieval?.candidates??[]);
  const planRun=await runRetrievalSourcePlanDecision({
    state:{
      gate:String(gate?.mode??gate??'MINOR'),
      scene:{sceneId:scene.sceneId??null,revision:scene.revision??null,participants:(scene.participants??[]).slice(0,12),location:scene.location??null,threads:(scene.threads??[]).slice(0,8)},
      truthIntent:retrieval?.truthIntent??'CURRENT',
      channelContributionCounts:contributionCounts,
      publication:retrieval?.publication?{selectedCount:retrieval.publication.selectedCount,publishedCount:retrieval.publication.publishedCount,degraded:retrieval.publication.degraded}:null,
      watch:{highLikelihoodCount:watchBoost.highLikelihoodCount,nodeIds:watchBoost.nodeIds},
    },
  },fallbackPlan,{telemetrySelection:selection});
  assertFresh();
  writeRetrievalSourcePlan({...planRun.plan,watchNodeIds:watchBoost.nodeIds},{context,sceneRevision:scene.revision??null,source:planRun.source});

  const advice={version:1,chatId:String(chatId),sceneRevision:scene.revision??null,storedAt:Date.now(),sourcePlan:{...planRun.plan,source:planRun.source},walkerAnchors:{},hotThreads:{},greenRoomSurface:{},greenRoomReflection:{},worldTreeIdentity:[],worldTreeSupersede:[],worldTreeTrackSuggestions:[],truthConflicts:[]};
  const api=createCanonicalWorldTreeReadApi({chatId});
  const nodes=api.allNodes().slice(-160);
  const trackAppearances=observeWorldTreeTrackAppearances({context,scene});
  for(const candidate of trackAppearances.filter(row=>!row.suggested).slice(0,MAX_DECISIONS_PER_FAMILY)){
    const fallback=candidate.sceneCount>=5?'SUGGEST':'SKIP';
    const run=await choose(TASK8_POSTTURN_SITE_IDS.WORLDTREE_SUGGEST_TRACK,{state:{nodeId:candidate.nodeId,label:candidate.label,kind:candidate.kind,sceneCount:candidate.sceneCount,lastSceneId:candidate.lastSceneId}},fallback,{reasonCode:candidate.sceneCount>=5?'FIVE_SCENES_AS_CAST':'BELOW_FALLBACK_THRESHOLD',telemetrySelection:selection});
    advice.worldTreeTrackSuggestions.push({nodeId:candidate.nodeId,label:candidate.label,sceneCount:candidate.sceneCount,choice:run.choice,source:run.source});
    if(run.choice==='SUGGEST')recordWorldTreeTrackSuggestion(candidate,{context,decisionSource:run.source});
  }

  for(const name of sceneReferenceNames(scene).slice(0,MAX_DECISIONS_PER_FAMILY)){
    const matches=api.findByAlias(name,chatId);
    if(matches.length<=1)continue;
    const fallback='SKIP';
    const run=await choose(TASK8_POSTTURN_SITE_IDS.WALKER_ANCHOR,{state:{name,candidates:matches.slice(0,12).map(nodeSummary),scene:{sceneId:scene.sceneId??null,revision:scene.revision??null}}},fallback,{reasonCode:'ALIAS_AMBIGUOUS',telemetrySelection:selection});
    advice.walkerAnchors[normalizeWorldTreeAlias(name)]={choice:run.choice,source:run.source,candidates:matches.map(row=>row.id).slice(0,12)};
  }

  for(const thread of hotThreads(hot)){
    const run=await choose(TASK8_POSTTURN_SITE_IDS.HOT_THREAD_STATE,{state:{thread,scene:{sceneId:scene.sceneId??null,revision:scene.revision??null},recentTail:safeText(hot?.segments?.RECENT_EPISODE_TAIL?.value?.text??hot?.segments?.recentEpisodeTail?.value?.text??'',1200)}},'ACTIVE',{reasonCode:'SCENE_OPEN',telemetrySelection:selection});
    advice.hotThreads[thread.id]={choice:run.choice,source:run.source};
  }

  const green=greenRows(chatId);
  for(const row of green.active.slice(0,MAX_DECISIONS_PER_FAMILY)){
    const confidence=Number(row?.confidence??0);
    if(confidence>=MIXED_CONFIDENCE){advice.greenRoomSurface[String(row.characterRef)]={choice:'INCLUDE',source:'fallback',reasonCode:'MIXED_OR_HIGHER'};continue;}
    const run=await choose(TASK8_POSTTURN_SITE_IDS.GREENROOM_SURFACE,{state:{characterRef:row.characterRef,confidence,dimensions:row.dimensions,sceneRevision:row.sceneRevision,evidenceCount:row.directEvidenceRefs?.length??0}},'SKIP',{reasonCode:'BELOW_MIXED',telemetrySelection:selection});
    advice.greenRoomSurface[String(row.characterRef)]={choice:run.choice,source:run.source,reasonCode:run.reasonCode};
  }
  for(const ref of uniq(green.history.map(row=>row?.characterRef)).slice(0,MAX_DECISIONS_PER_FAMILY)){
    const readings=compatibleHistory(green.history,ref);
    if(readings.length<3)continue;
    const run=await choose(TASK8_POSTTURN_SITE_IDS.GREENROOM_REFLECT,{state:{characterRef:ref,readingCount:readings.length,readings:readings.map(row=>({sceneRevision:row.sceneRevision,confidence:row.confidence,dimensions:row.dimensions,supportIdentity:row.supportIdentity}))}},'PROPOSE',{reasonCode:'THREE_COMPATIBLE_READINGS',telemetrySelection:selection});
    advice.greenRoomReflection[ref]={choice:run.choice,source:run.source,readingCount:readings.length};
    if(run.choice==='PROPOSE')advice.greenRoomReflection[ref].review=await stageReview('greenroom.reflect',[ref],run.choice,readings.flatMap(row=>row.directEvidenceRefs??[]));
  }

  for(const [left,right] of worldPairs(nodes,(a,b)=>String(a?.kind)===String(b?.kind))){
    const run=await choose(TASK8_POSTTURN_SITE_IDS.WORLDTREE_IDENTITY,{state:{left:nodeSummary(left),right:nodeSummary(right),sharedAliases:aliases(left).filter(value=>new Set(aliases(right)).has(value))}},'REVIEW',{reasonCode:'KEEP_SEPARATE_REVIEW',telemetrySelection:selection});
    advice.worldTreeIdentity.push({left:left.id,right:right.id,choice:run.choice,source:run.source});
    if(['SAME_ENTITY','REVIEW'].includes(run.choice))advice.worldTreeIdentity.at(-1).review=await stageReview('worldtree.identity',[left.id,right.id],run.choice);
  }
  for(const [older,newer] of worldPairs(nodes,(a,b)=>String(a?.kind)===String(b?.kind)&&Number(a?.revision)!==Number(b?.revision))){
    const a=Number(older.revision)<=Number(newer.revision)?older:newer,b=a===older?newer:older;
    const run=await choose(TASK8_POSTTURN_SITE_IDS.WORLDTREE_SUPERSEDE,{state:{older:nodeSummary(a),newer:nodeSummary(b)}},'REVIEW',{reasonCode:'NO_AUTO_SUPERSESSION',telemetrySelection:selection});
    advice.worldTreeSupersede.push({older:a.id,newer:b.id,choice:run.choice,source:run.source});
    if(['SUPERSEDES','REVIEW'].includes(run.choice))advice.worldTreeSupersede.at(-1).review=await stageReview('worldtree.supersede',[a.id,b.id],run.choice);
  }
  for(const [left,right] of worldPairs(nodes,(a,b)=>String(a?.kind)==='lore'&&String(b?.kind)==='lore'&&String(a?.temporalStatus).toUpperCase()==='CURRENT'&&String(b?.temporalStatus).toUpperCase()==='CURRENT')){
    if(safeText(left?.payload?.content,900)===safeText(right?.payload?.content,900))continue;
    const run=await choose(TASK8_POSTTURN_SITE_IDS.TRUTH_CONFLICT,{state:{left:nodeSummary(left),right:nodeSummary(right)}},'UNRESOLVED',{reasonCode:'RULE_UNRESOLVED',telemetrySelection:selection});
    advice.truthConflicts.push({left:left.id,right:right.id,choice:run.choice,source:run.source});
  }
  // A fact this chat established against verified canon of the bound book. Advice is
  // per chat; the global lore node is never written, so other chats still read canon.
  const storyBinding=readWorldTreeStoryBinding();
  for(const {chatNode,canonNode} of chatCanonConflictPairs({api,nodes,chatId,canonBooks:storyBinding?[storyBinding.book]:null,limit:MAX_DECISIONS_PER_FAMILY})){
    const run=await choose(TASK8_POSTTURN_SITE_IDS.TRUTH_CONFLICT,{state:{left:nodeSummary(canonNode),right:nodeSummary(chatNode)}},'UNRESOLVED',{reasonCode:'RULE_UNRESOLVED',telemetrySelection:selection});
    advice.truthConflicts.push({left:canonNode.id,right:chatNode.id,choice:run.choice,source:run.source});
  }

  assertFresh();
  writeTask8PostTurnAdvice(advice,{context,chatId});
  logEvent('decision-core','task8-postturn-pass',{chatId:String(chatId),sceneRevision:scene.revision??null,sceneReason,sourcePlan:advice.sourcePlan,watchCount:watchEntries.length,counts:{walkerAnchors:Object.keys(advice.walkerAnchors).length,hotThreads:Object.keys(advice.hotThreads).length,greenRoomSurface:Object.keys(advice.greenRoomSurface).length,greenRoomReflection:Object.keys(advice.greenRoomReflection).length,worldTreeIdentity:advice.worldTreeIdentity.length,worldTreeSupersede:advice.worldTreeSupersede.length,worldTreeTrackSuggestions:advice.worldTreeTrackSuggestions.length,truthConflicts:advice.truthConflicts.length}},'info');
  return advice;
}
