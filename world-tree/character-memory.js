import { createBudgetManager } from '../core/budget.js';
import { logEvent } from '../observability/telemetry.js';
import { enqueueNexusModelWorkerJob } from '../nexus/model-worker-bus.js';
import { parseStructuredJsonCandidate } from '../sidecar/normalize-response.js';
import { HotSegmentKind } from '../nexus/a52/hot-cognition-contracts.js';
import { createChannelNomination, createRetrievalChannelDescriptor, createRetrievalIntent, RetrievalChannelCapability, CandidateTruthStatus } from '../nexus/a52/candidate-bus-contracts.js';
import { RetrievalChannelRegistry } from '../nexus/a52/retrieval-channel-registry.js';
import { getNexusWorldTreeOwner } from './index.js';
import { isTrackedCharacterNode, resolveTrackedCharacterReference } from './tracking.js';
import { buildWorldTreeSceneContribution, sceneRecordToContributionView } from './scene-contribution.js';
import { candidateIdForMention } from './intake/candidates.js';
import { contributionLedgerKey, contributionNodeId, stableHash } from './intake/contribution.js';
import { applyWorldTreeContribution, enqueueWorldTreeContribution, readWorldTreeContributionQueue } from './intake/runtime.js';

export const CHARACTER_MEMORY_STATE_KEY='nexus_character_memory_state_v1';
const defaultBudget=createBudgetManager({emit:logEvent});
const CHARACTER_MEMORY_STAGE='character-memory';
const CHARACTER_MEMORY_PRIORITY=66;
const clone=value=>value==null?value:structuredClone(value);
const clean=value=>String(value??'').replace(/\s+/g,' ').trim();
const normalized=value=>clean(value).toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').replace(/\s+/g,' ').trim();
const uniq=values=>[...new Set((values??[]).filter(value=>value!=null&&clean(value)).map(value=>clean(value)))];
const STATUS=new Set(['open','closed','superseded','tracking-paused']);
const IMPORTANCE=new Set(['low','normal','high']);

function chatIdOf(context){const value=context?.chatId??context?.chat_id;return value==null?null:String(value);}
function emptyState(chatId){return{version:1,chatId:String(chatId),pending:{},rebuildEpochs:{},updatedAt:0};}
function stateFor(context){
  const chatId=chatIdOf(context);if(!chatId)return null;
  const raw=context?.chatMetadata?.[CHARACTER_MEMORY_STATE_KEY];
  const state=raw?.version===1&&String(raw.chatId)===chatId?clone(raw):emptyState(chatId);
  state.pending=state.pending&&typeof state.pending==='object'?state.pending:{};
  state.rebuildEpochs=state.rebuildEpochs&&typeof state.rebuildEpochs==='object'?state.rebuildEpochs:{};
  return state;
}
function persistState(context,state){
  if(!state||!context?.chatMetadata)return false;state.updatedAt=Date.now();context.chatMetadata[CHARACTER_MEMORY_STATE_KEY]=state;try{context.saveMetadataDebounced?.();}catch{}return true;
}
export function readCharacterMemoryState({context}={}){return stateFor(context);}
function pairKey(characterId,sceneIdentity){return String(characterId)+'|'+String(sceneIdentity);}
function pendingKey(characterId,sceneIdentity,epoch){return pairKey(characterId,sceneIdentity)+'|e'+String(epoch);}
function lineageId(chatId,characterId,sceneIdentity,epoch){return ['character-memory',String(chatId),String(characterId),String(sceneIdentity),'e'+String(epoch)].join(':');}
function sourceIndexFromMessageId(value){const match=String(value??'').match(/(?:^|:)message:(\d+)$|^message:(\d+)$/);return match?Number(match[1]??match[2]):null;}
function labelsForNode(node){const data=node?.data??{};return uniq([data.label,data.name,data.title,data.cardName,...(data.aliases??[]),...(data.keys??[])]);}
function exactNode(tree,text,{chatId=null,kind=null}={}){
  const key=normalized(text);if(!tree||!key)return null;const matches=[];
  for(const node of tree.iterateNodes({chatId})){if(kind&&String(node.kind)!==String(kind).toUpperCase())continue;if(labelsForNode(node).some(label=>normalized(label)===key))matches.push(node);}
  return matches.length===1?matches[0]:null;
}
function sceneViewFromPublic(view,chatId){
  if(!view?.sceneId)return null;
  return{chatId:String(chatId??view.chatId??''),sceneId:String(view.sceneId),revision:Math.max(1,Number(view.revision)||1),lifecycle:String(view.lifecycle??'OPEN').toUpperCase(),
    participantRefs:[...(view.participantRefs??[])],participants:[...(view.participants??[])],location:clean(view.location)||null,objects:uniq(view.objects),threads:uniq(view.threads),objectives:uniq(view.objectives),
    activity:clean(view.activity)||null,focus:clean(view.focus)||null,narrativeTime:clean(view.narrativeTime)||null,relationshipFocus:view.relationshipFocus===true,sourceRevisionRefs:uniq(view.sourceRevisionRefs)};
}
function sceneMapFrom(state,view,chatId){
  const map=new Map();
  for(const record of [...(state?.history??[]),state?.current].filter(Boolean)){const scene=sceneRecordToContributionView(record,{chatId});if(scene)map.set(scene.sceneId,{scene,record});}
  const current=sceneViewFromPublic(view,chatId);if(current){const prior=map.get(current.sceneId);map.set(current.sceneId,{scene:current,record:prior?.record??state?.current??null});}
  return map;
}
function trackedRefsForScene(scene,{tree,chatId}={}){
  const values=scene?.participantRefs?.length?scene.participantRefs:scene?.participants??[],out=[],seen=new Set();
  for(const raw of values){
    const probe=typeof raw==='object'?(raw.canonicalEntityId??raw.id??raw.characterId??raw.label):raw;
    const ref=resolveTrackedCharacterReference(probe,{tree,chatId})??resolveTrackedCharacterReference(typeof raw==='object'?raw.label:raw,{tree,chatId});
    if(!ref||seen.has(ref.nodeId))continue;seen.add(ref.nodeId);out.push(ref);
  }
  return out;
}
function messageRevision(row,index){return stableHash([Number(index),row?.swipe_id??null,row?.is_user===true?'u':'a',String(row?.mes??'')]);}
function boundedNarrativeWindow({context,record}={}){
  const chat=Array.isArray(context?.chat)?context.chat:[];let start=Number(record?.sourceRange?.start),end=Number(record?.sourceRange?.end);
  if(!Number.isInteger(start)||start<0)start=Math.max(0,chat.length-6);if(!Number.isInteger(end)||end<start||end>=chat.length)end=Math.max(start,chat.length-1);
  const all=[];for(let i=start;i<=end&&i<chat.length;i++){const row=chat[i];if(row?.is_system===true||!clean(row?.mes))continue;all.push({index:i,row});}
  const selected=all.length<=6?all:[...all.slice(0,2),...all.slice(-4)].filter((row,index,array)=>array.findIndex(other=>other.index===row.index)===index);
  const refs=selected.map(({index,row})=>({messageId:'message:'+index,messageRevision:messageRevision(row,index),swipeId:row?.swipe_id??null,sourceIndex:index}));
  const fullFirst=all[0]?.index??start,fullLast=all[all.length-1]?.index??end;
  const narrative=selected.map(({index,row},position)=>{
    const raw=String(row?.mes??''),chars=[...raw],limit=position<2?1400:2200,text=chars.length>limit?(position<2?chars.slice(0,limit).join('')+'…':'…'+chars.slice(-limit).join('')):raw;
    return '['+(row?.is_user===true?'User':'Assistant')+' · message:'+index+']\n'+text;
  }).join('\n\n');
  return{narrative,messageRefs:refs,messageRange:['message:'+fullFirst,'message:'+fullLast],signature:stableHash(refs.map(ref=>[ref.messageId,ref.messageRevision])),firstIndex:fullFirst,lastIndex:fullLast};
}
function predictedSceneNodeId(scene,tree){try{return contributionNodeId(buildWorldTreeSceneContribution({scene,tree}),'scene');}catch{return null;}}
function predictedLocationNodeId(scene,tree,chatId){
  if(!clean(scene?.location))return null;const existing=exactNode(tree,scene.location,{chatId,kind:'LOCATION'});if(existing)return existing.id;
  const candidateId=candidateIdForMention({text:scene.location,kindHint:'LOCATION'});return'discovery:'+stableHash([String(chatId),candidateId]);
}
function temporalForStatus(status){return status==='open'?'CURRENT':status==='superseded'?'SUPERSEDED':'HISTORICAL';}
function memoryNodes(tree,chatId){return[...tree.iterateNodes({chatId,kind:'CHARACTER_MEMORY'})];}
function findMemory(tree,{chatId,characterId,sceneIdentity,epoch}={}){
  const id=lineageId(chatId,characterId,sceneIdentity,epoch);
  return memoryNodes(tree,chatId).filter(node=>String(node.data?.characterMemoryLineageId??'')===id).sort((a,b)=>Number(b.updatedRevision??b.revision??0)-Number(a.updatedRevision??a.revision??0))[0]??null;
}
function queuedContribution(context,key){return readWorldTreeContributionQueue({context}).some(item=>item?.contribution?.key===key);}
function expectedKey({lineage,sceneRevision,status,sourceSignature}){return'character-memory:'+stableHash(lineage)+':'+String(status)+':scene-r'+String(sceneRevision)+':src-'+String(sourceSignature);}

export function validateCharacterMemoryOutput(input){
  const value=input&&typeof input==='object'&&!Array.isArray(input)?input:null;if(!value)return{valid:false,score:0,reason:'Character memory output must be an object.'};
  const summary=clean(value.summary),importance=String(value.importance??'normal').toLowerCase(),knownBy=uniq(value.knownBy).slice(0,16),about=uniq(value.about).slice(0,16),mentions=uniq(value.mentions).slice(0,16);
  const punctuation=(summary.match(/[.!?](?=\s|$)/g)||[]).length,sentences=summary?(punctuation||1):0,errors=[];
  if(!summary)errors.push('summary is required');if(summary.length>900)errors.push('summary exceeds 900 characters');if(sentences<1||sentences>3)errors.push('summary must contain 1-3 sentences');
  if(!IMPORTANCE.has(importance))errors.push('importance must be low, normal or high');
  for(const [name,rows] of [['knownBy',value.knownBy],['about',value.about],['mentions',value.mentions]])if(rows!=null&&!Array.isArray(rows))errors.push(name+' must be an array');
  return{valid:errors.length===0,score:errors.length?0:20,reason:errors.join('; ')||null,value:{summary,importance,knownBy,about,mentions}};
}
function writerPrompt({character,scene,window,currentMemory,presentRefs}={}){
  return`Nexus CHARACTER MEMORY WRITER

Write one short memory for exactly one tracked character.

PERSPECTIVE RULES
- Write only story facts that ${character.label} personally witnessed in the supplied on-screen narrative or was explicitly told there.
- Do not add off-screen events, private knowledge they could not know, motives, or guesses.
- Keep the summary to 1-3 sentences from ${character.label}'s perspective.
- If CURRENT OPEN MEMORY exists, update that same memory with new on-screen facts; do not restart or recap unrelated history.
- knownBy may contain only names from PRESENT TRACKED CHARACTERS.
- about may name only supplied present characters or scene topics.
- mentions may name only supplied scene objects/topics.
- Never copy long message text. Summarize.

CHARACTER
${character.label} [${character.nodeId}]

SCENE
id=${scene.sceneId}
location=${scene.location??'(unknown)'}
time=${scene.narrativeTime??'(unknown)'}
participants=${scene.participants.join(', ')||'(none)'}
objects=${scene.objects.join(', ')||'(none)'}
threads=${scene.threads.join(' | ')||'(none)'}

PRESENT TRACKED CHARACTERS
${presentRefs.map(ref=>ref.label+' ['+ref.nodeId+']').join('\n')||'(none)'}

CURRENT OPEN MEMORY
${currentMemory?.data?.summary??'(none)'}

BOUNDED ON-SCREEN NARRATIVE
${window.narrative||'(none)'}

Return ONLY JSON:
{"summary":"1-3 sentences","importance":"low|normal|high","knownBy":["present character name"],"about":["present character or scene topic"],"mentions":["scene object or topic"]}`;
}
async function writeMemory({character,scene,window,currentMemory,presentRefs,enqueueSidecar}={}){
  const options={prompt:writerPrompt({character,scene,window,currentMemory,presentRefs}),systemPrompt:'You are Nexus Character Memory. Write only witnessed or explicitly told story facts. Return exact JSON only.',
    responseFormat:'json_object',excludeReasoning:true,structuredValidator:validateCharacterMemoryOutput,reasoningEffort:'low',priority:CHARACTER_MEMORY_PRIORITY,foregroundAdjacent:false,preemptible:true,maxAttempts:1,
    mainPreferred:false,mainEligible:false,dedupKey:'character-memory:'+character.nodeId+':'+scene.sceneId+':'+scene.revision+':'+window.signature,label:'Character Memory · '+character.label,
    telemetry:{characterMemory:true,sceneId:scene.sceneId,sceneRevision:scene.revision,characterId:character.nodeId}};
  const job=typeof enqueueSidecar==='function'?enqueueSidecar(CHARACTER_MEMORY_STAGE,options):enqueueNexusModelWorkerJob('character-memory',CHARACTER_MEMORY_STAGE,{...options,role:'summaries',schedulerLane:'postTurn'});
  const response=await job.promise;const raw=response?.structuredPayload??response?.text??'';let parsed;
  if(raw&&typeof raw==='object'&&!Array.isArray(raw)){const verdict=validateCharacterMemoryOutput(raw);if(!verdict.valid)throw new Error(verdict.reason||'CHARACTER_MEMORY_INVALID');parsed=verdict.value;}
  else parsed=parseStructuredJsonCandidate(String(raw),{validator:validateCharacterMemoryOutput,label:'Character Memory'});
  return{...parsed,slot:response?.tv2?.slot??null};
}
function resolvePresentName(name,presentRefs,tree,chatId){
  const key=normalized(name);if(!key)return null;
  const direct=presentRefs.find(ref=>normalized(ref.label)===key||String(ref.nodeId)===String(name));if(direct)return direct.nodeId;
  const resolved=resolveTrackedCharacterReference(name,{tree,chatId});return resolved&&presentRefs.some(ref=>ref.nodeId===resolved.nodeId)?resolved.nodeId:null;
}
function existingNamedNode(name,scene,tree,chatId){
  const tracked=resolveTrackedCharacterReference(name,{tree,chatId});if(tracked)return tracked.nodeId;
  const exact=exactNode(tree,name,{chatId});if(exact)return exact.id;
  if(normalized(name)===normalized(scene?.sceneId))return predictedSceneNodeId(scene,tree);
  return null;
}
function buildMemoryContribution({context,tree,character,scene,record,output,currentMemory,epoch,status='open'}={}){
  const chatId=chatIdOf(context),window=boundedNarrativeWindow({context,record}),lineage=lineageId(chatId,character.nodeId,scene.sceneId,epoch),sceneNodeId=predictedSceneNodeId(scene,tree),locationId=predictedLocationNodeId(scene,tree,chatId);
  const presentRefs=trackedRefsForScene(scene,{tree,chatId}),presentIds=presentRefs.map(ref=>ref.nodeId),presentSet=new Set(presentIds);
  const knownBy=uniq([character.nodeId,...output.knownBy.map(name=>resolvePresentName(name,presentRefs,tree,chatId)).filter(Boolean)]).filter(id=>presentSet.has(id)||id===character.nodeId);
  const aboutIds=uniq([sceneNodeId,...presentIds.filter(id=>id!==character.nodeId),...output.about.map(name=>existingNamedNode(name,scene,tree,chatId)).filter(Boolean)]);
  const mentionIds=uniq([...scene.objects,...output.mentions].map(name=>exactNode(tree,name,{chatId})?.id).filter(Boolean));
  const key=expectedKey({lineage,sceneRevision:scene.revision,status,sourceSignature:window.signature}),temporalStatus=temporalForStatus(status),now=Date.now();
  const sourceRefs=[{characterMemoryLineageId:lineage,revision:scene.revision,rebuildEpoch:epoch,status},...window.messageRefs];
  const memoryFields={character:character.nodeId,characterLabel:character.label,summary:output.summary,location:locationId,time:{storyTime:scene.narrativeTime??null,messageRange:[...window.messageRange]},sceneId:sceneNodeId,sceneIdentity:scene.sceneId,sceneRevision:scene.revision,
    participants:presentIds,importance:output.importance,knownBy,sourceRefs:window.messageRefs,status,tracking:status==='tracking-paused'?'paused':'active',characterMemoryLineageId:lineage,rebuildEpoch:epoch,sourceSignature:window.signature,
    createdAt:Number(currentMemory?.data?.createdAt)||now,updatedAt:now};
  const sourceFields={characterMemorySource:true,characterMemoryLineageId:lineage,messageRange:[...window.messageRange],messageIds:window.messageRefs.map(ref=>ref.messageId),sourceRefs:window.messageRefs,sceneIdentity:scene.sceneId,updatedAt:now};
  const edges=[{from:character.nodeId,to:'memory',meaning:'remembers',authority:'REMEMBERED'},{from:'memory',to:'source-window',meaning:'derived-from',authority:'REMEMBERED'}];
  if(sceneNodeId)edges.push({from:'memory',to:sceneNodeId,meaning:'about',authority:'REMEMBERED'});
  if(locationId)edges.push({from:'memory',to:locationId,meaning:'at',authority:'REMEMBERED'});
  for(const id of aboutIds)if(id&&id!==sceneNodeId)edges.push({from:'memory',to:id,meaning:'about',authority:'REMEMBERED'});
  for(const id of mentionIds)edges.push({from:'memory',to:id,meaning:'mentions',authority:'REMEMBERED'});
  return{kind:'Contribution',source:'character-memory',scope:{type:'CHAT',chatId},sourceRefs,key,mentions:[],nodes:[
    {tempId:'memory',kind:'CHARACTER_MEMORY',label:character.label+' memory · '+scene.sceneId,fields:memoryFields,authority:'REMEMBERED',temporalStatus},
    {tempId:'source-window',kind:'EVENT',label:'Messages '+window.messageRange[0]+'–'+window.messageRange[1],fields:sourceFields,authority:'REMEMBERED',temporalStatus},
  ],edges};
}
function currentIncidentEdges(tree,nodeId,chatId){
  return tree.read({chatId,includeOverlays:false,limit:5000}).edges.filter(edge=>edge.temporal?.status!=='SUPERSEDED'&&(String(edge.from)===String(nodeId)||String(edge.to)===String(nodeId)));
}
function reissueExistingMemory(node,{tree,context,status,reason}={}){
  const chatId=chatIdOf(context),lineage=String(node.data?.characterMemoryLineageId??'');if(!chatId||!lineage)return null;
  const incident=currentIncidentEdges(tree,node.id,chatId),sourceEdge=incident.find(edge=>edge.relation==='derived-from'&&String(edge.from)===String(node.id)),sourceNode=sourceEdge?tree.getNode(sourceEdge.to,{chatId}):null;
  const idMap=new Map([[String(node.id),'memory']]);if(sourceNode?.data?.characterMemorySource)idMap.set(String(sourceNode.id),'source-window');
  const now=Date.now(),temporalStatus=temporalForStatus(status),fields={...clone(node.data),status,tracking:status==='tracking-paused'?'paused':node.data?.tracking??'active',updatedAt:now};
  if(status==='closed')fields.closedAt=now;if(status==='superseded')fields.supersededAt=now;
  const refs=Array.isArray(node.data?.sourceRefs)?clone(node.data.sourceRefs):[];
  const sourceRefs=[{characterMemoryLineageId:lineage,revision:Number(node.revision??1)+1,status,reason:String(reason??status)},...refs];
  const nodes=[{tempId:'memory',kind:'CHARACTER_MEMORY',label:String(node.data?.label??node.data?.characterLabel??'Character memory'),fields,authority:'REMEMBERED',temporalStatus}];
  if(sourceNode?.data?.characterMemorySource)nodes.push({tempId:'source-window',kind:sourceNode.kind,label:String(sourceNode.data?.label??'Messages'),fields:clone(sourceNode.data),authority:'REMEMBERED',temporalStatus});
  const edges=incident.map(edge=>({from:idMap.get(String(edge.from))??String(edge.from),to:idMap.get(String(edge.to))??String(edge.to),meaning:edge.relation,subtype:edge.data?.subtype??null,authority:'REMEMBERED'}));
  return{kind:'Contribution',source:'character-memory',scope:{type:'CHAT',chatId},sourceRefs,key:'character-memory:'+stableHash(lineage)+':'+status+':node-r'+String(Number(node.revision??1)+1)+':'+stableHash(String(reason??status)),mentions:[],nodes,edges};
}
function memoryMatchesMessage(node,messageIndex){
  const index=Number(messageIndex);if(!Number.isInteger(index)||index<0)return false;
  for(const ref of node.data?.sourceRefs??[]){if(Number(ref?.sourceIndex)===index)return true;const parsed=sourceIndexFromMessageId(ref?.messageId);if(parsed===index)return true;}
  const range=node.data?.time?.messageRange??[];const first=sourceIndexFromMessageId(range[0]),last=sourceIndexFromMessageId(range[1]);
  return Number.isInteger(first)&&Number.isInteger(last)&&index>=Math.min(first,last)&&index<=Math.max(first,last);
}
function addPending(state,{characterId,characterLabel,sceneIdentity,sceneRevision,epoch,reason}={}){
  const key=pendingKey(characterId,sceneIdentity,epoch),prior=state.pending[key]??{};
  state.pending[key]={...prior,characterId:String(characterId),characterLabel:String(characterLabel??characterId),sceneIdentity:String(sceneIdentity),sceneRevision:Number(sceneRevision)||1,rebuildEpoch:Number(epoch)||0,reason:String(reason??prior.reason??'scene-change'),queuedAt:prior.queuedAt??Date.now(),updatedAt:Date.now()};
  return key;
}
function hasPendingFor(state,characterId,sceneIdentity){return Object.values(state?.pending??{}).some(row=>String(row.characterId)===String(characterId)&&String(row.sceneIdentity)===String(sceneIdentity));}

export async function invalidateCharacterMemoriesForMessage({context,messageIndex,eventName='MESSAGE_EDITED',tree=getNexusWorldTreeOwner()}={}){
  const chatId=chatIdOf(context);if(!chatId||!Number.isInteger(Number(messageIndex)))return{skipped:true,reason:'invalid-message',supersededCount:0};
  const state=stateFor(context);let supersededCount=0,queuedCount=0;
  for(const node of memoryNodes(tree,chatId).filter(node=>node.temporal?.status!=='SUPERSEDED'&&node.data?.status!=='superseded'&&memoryMatchesMessage(node,Number(messageIndex)))){
    const characterId=String(node.data?.character??''),sceneIdentity=String(node.data?.sceneIdentity??'');if(!characterId||!sceneIdentity)continue;
    const pair=pairKey(characterId,sceneIdentity),epoch=Math.max(Number(state.rebuildEpochs[pair]??0),Number(node.data?.rebuildEpoch??0))+1;state.rebuildEpochs[pair]=epoch;
    addPending(state,{characterId,characterLabel:node.data?.characterLabel,sceneIdentity,sceneRevision:node.data?.sceneRevision,rebuildEpoch:epoch,epoch,reason:eventName});
    const contribution=reissueExistingMemory(node,{tree,context,status:'superseded',reason:eventName+':message:'+messageIndex});
    if(contribution){enqueueWorldTreeContribution(contribution,{context});queuedCount++;supersededCount++;logEvent('character-memory','superseded',{chatId,characterId,sceneId:sceneIdentity,messageIndex:Number(messageIndex),eventName,rebuildEpoch:epoch},'info');}
  }
  persistState(context,state);return{kind:'NexusCharacterMemoryInvalidation',supersededCount,queuedCount,rebuildPending:Object.keys(state.pending).length};
}

export async function pauseCharacterMemoriesForTracking({characterId,context,tree=getNexusWorldTreeOwner()}={}){
  const chatId=chatIdOf(context);if(!chatId)return{skipped:true,reason:'no-chat',pausedCount:0};const state=stateFor(context);let pausedCount=0;
  for(const node of memoryNodes(tree,chatId).filter(node=>String(node.data?.character)===String(characterId)&&!['tracking-paused','superseded'].includes(String(node.data?.status)))){
    const contribution=reissueExistingMemory(node,{tree,context,status:'tracking-paused',reason:'tracking-disabled'});if(!contribution)continue;
    await applyWorldTreeContribution(contribution,{tree,context});pausedCount++;logEvent('character-memory','tracking-paused',{chatId,characterId:String(characterId),sceneId:node.data?.sceneIdentity??null},'info');
  }
  for(const [key,row] of Object.entries(state.pending))if(String(row.characterId)===String(characterId))delete state.pending[key];persistState(context,state);
  return{kind:'NexusCharacterMemoryTrackingPause',pausedCount};
}

function shouldTrigger(gate,eventType){const mode=String(gate?.mode??'').toUpperCase();return mode.includes('MINOR')||mode.includes('MAJOR')||['MESSAGE_EDITED','MESSAGE_SWIPED','MESSAGE_DELETED','EDIT','SWIPE','DELETE'].includes(String(eventType??'').toUpperCase());}
function rawSceneFor(map,sceneIdentity){return map.get(String(sceneIdentity))??null;}

export async function runCharacterMemoryJob({context,tree=getNexusWorldTreeOwner(),gate=null,eventType='generation-end',sceneState=null,sceneView=null,isFresh=()=>true,enqueueSidecar=null,budgetManager=defaultBudget}={}){
  const chatId=chatIdOf(context);if(!chatId)return{kind:'NexusCharacterMemoryJob',skipped:true,reason:'no-chat',queuedCount:0,deferredCount:0,failedCount:0};
  let stateSnapshot=sceneState,view=sceneView;
  if(!stateSnapshot||!view){
    try{
      const sceneRuntime=await import('../nexus/scene-intelligence.js');
      if(!stateSnapshot)stateSnapshot=sceneRuntime.exportNexusSceneIntelligence?.()??null;
      if(!view)view=sceneRuntime.getNexusSceneIntelligenceView?.({chatId})??null;
    }catch{}
  }
  const scenes=sceneMapFrom(stateSnapshot,view,chatId);if(!scenes.size)return{kind:'NexusCharacterMemoryJob',skipped:true,reason:'no-scene',queuedCount:0,deferredCount:0,failedCount:0};
  const workState=stateFor(context),currentIdentity=String(stateSnapshot?.current?.sceneId??view?.sceneId??''),current=scenes.get(currentIdentity);
  if(current&&shouldTrigger(gate,eventType)){
    for(const character of trackedRefsForScene(current.scene,{tree,chatId})){
      const pair=pairKey(character.nodeId,current.scene.sceneId),epoch=Math.max(0,Number(workState.rebuildEpochs[pair]??0));addPending(workState,{characterId:character.nodeId,characterLabel:character.label,sceneIdentity:current.scene.sceneId,sceneRevision:current.scene.revision,epoch,reason:String(eventType||gate?.mode||'scene-change')});
    }
  }
  let queuedCount=0,closedCount=0;
  for(const node of memoryNodes(tree,chatId).filter(node=>node.data?.status==='open'&&node.temporal?.status==='CURRENT')){
    const sceneIdentity=String(node.data?.sceneIdentity??''),sceneRow=scenes.get(sceneIdentity);if(!sceneRow||String(sceneRow.scene.lifecycle).toUpperCase()!=='CLOSED'||hasPendingFor(workState,node.data?.character,sceneIdentity))continue;
    const contribution=reissueExistingMemory(node,{tree,context,status:'closed',reason:'scene-closed'});if(contribution&&!queuedContribution(context,contribution.key)){enqueueWorldTreeContribution(contribution,{context});queuedCount++;closedCount++;logEvent('character-memory','closed',{chatId,characterId:node.data?.character??null,sceneId:sceneIdentity},'info');}
  }
  persistState(context,workState);
  const pendingEntries=Object.entries(workState.pending).sort((a,b)=>Number(a[1].queuedAt??0)-Number(b[1].queuedAt??0)||a[0].localeCompare(b[0]));
  if(!pendingEntries.length){return{kind:'NexusCharacterMemoryJob',skipped:queuedCount===0,reason:queuedCount?'closures-only':'no-work',queuedCount,createdCount:0,updatedCount:0,closedCount,deferredCount:0,failedCount:0,pendingCount:0};}
  const frame=budgetManager.beginTurn({timeMs:5000,worldSize:pendingEntries.length}),allowance=frame.compute('character.memory',{total:pendingEntries.length,defaultUnits:2,defaultWorldSize:2,msPerUnit:1});
  let createdCount=0,updatedCount=0,failedCount=0,lastError=null,processed=0;
  for(const [key,pending] of pendingEntries.slice(0,allowance.allowed)){
    if(isFresh()===false)break;
    const row=rawSceneFor(scenes,pending.sceneIdentity);if(!row){delete workState.pending[key];continue;}
    const character=resolveTrackedCharacterReference(pending.characterId,{tree,chatId});if(!character||!isTrackedCharacterNode(tree.getNode(character.nodeId,{chatId}))){delete workState.pending[key];continue;}
    const present=trackedRefsForScene(row.scene,{tree,chatId});if(!present.some(ref=>ref.nodeId===character.nodeId)){delete workState.pending[key];continue;}
    const pair=pairKey(character.nodeId,row.scene.sceneId),epoch=Math.max(Number(workState.rebuildEpochs[pair]??0),Number(pending.rebuildEpoch??0)),lineage=lineageId(chatId,character.nodeId,row.scene.sceneId,epoch),window=boundedNarrativeWindow({context,record:row.record}),status=String(row.scene.lifecycle).toUpperCase()==='CLOSED'?'closed':'open';
    const keyExpected=expectedKey({lineage,sceneRevision:row.scene.revision,status,sourceSignature:window.signature}),existing=findMemory(tree,{chatId,characterId:character.nodeId,sceneIdentity:row.scene.sceneId,epoch});
    if(queuedContribution(context,keyExpected)||(existing&&existing.data?.sourceSignature===window.signature&&Number(existing.data?.sceneRevision)===Number(row.scene.revision)&&String(existing.data?.status)===status)){delete workState.pending[key];processed++;continue;}
    try{
      const output=await writeMemory({character,scene:row.scene,window,currentMemory:existing,presentRefs:present,enqueueSidecar});
      if(isFresh()===false)break;
      const contribution=buildMemoryContribution({context,tree,character,scene:row.scene,record:row.record,output,currentMemory:existing,epoch,status});enqueueWorldTreeContribution(contribution,{context});
      queuedCount++;processed++;if(existing)updatedCount++;else createdCount++;if(status==='closed')closedCount++;
      delete workState.pending[key];logEvent('character-memory',existing?'updated':'created',{chatId,characterId:character.nodeId,sceneId:row.scene.sceneId,status,importance:output.importance,slot:output.slot??null},'info');
    }catch(error){
      failedCount++;lastError=error?.message||String(error);logEvent('character-memory','writer-deferred',{chatId,characterId:character.nodeId,sceneId:row.scene.sceneId,error:lastError},'warn');
    }
  }
  persistState(context,workState);const pendingCount=Object.keys(workState.pending).length,deferredCount=pendingCount;
  if(deferredCount)logEvent('character-memory','budget-deferred',{chatId,deferredCount,pendingCount,allowed:allowance.allowed,total:pendingEntries.length},'info');
  return{kind:'NexusCharacterMemoryJob',queuedCount,createdCount,updatedCount,closedCount,supersededCount:0,deferredCount,failedCount,pendingCount,processed,deferred:deferredCount>0,failed:failedCount>0&&queuedCount===0,error:lastError,reason:deferredCount?'background-pending':null};
}

function hotActiveRows(snapshot){
  const value=snapshot?.segments?.[HotSegmentKind.ACTIVE_CAST]?.value;return Array.isArray(value)?value:[];
}
function activeCharacterIds({context,tree,hotSnapshot=null,sceneView=null}={}){
  const chatId=chatIdOf(context),out=[],seen=new Set();
  for(const row of hotActiveRows(hotSnapshot)){const probe=typeof row==='string'?row:(row?.canonicalEntityId??row?.id??row?.characterId??row?.label);const ref=resolveTrackedCharacterReference(probe,{tree,chatId});if(ref&&!seen.has(ref.nodeId)){seen.add(ref.nodeId);out.push(ref.nodeId);}}
  if(!out.length&&sceneView){for(const ref of trackedRefsForScene(sceneViewFromPublic(sceneView,chatId),{tree,chatId}))if(!seen.has(ref.nodeId)){seen.add(ref.nodeId);out.push(ref.nodeId);}}
  return out;
}
function importanceWeight(value){return value==='high'?2:value==='low'?0.5:1;}
function memoryRelevance(node,{activeIds,locationId,participantIds,now}={}){
  const data=node.data??{},participants=new Set(data.participants??[]),overlap=participantIds.filter(id=>participants.has(id)).length,age=Math.max(0,Number(now)-Number(data.updatedAt??0)),recency=Number(data.updatedAt)>0?Math.max(0,1-Math.min(1,age/(1000*60*60*24*30))):0;
  const location=locationId&&String(data.location??'')===String(locationId)?3:0,current=data.status==='open'?1:0,importance=importanceWeight(data.importance),score=location+Math.min(3,overlap*1.5)+recency+current+importance;
  return{score,locationMatch:location>0,participantOverlap:overlap,recency,importance};
}
export function createCharacterMemoryRetrievalChannel({tree=getNexusWorldTreeOwner(),chatId,activeCharacterIds=[],locationId=null,participantIds=[],now=Date.now()}={}){
  const active=new Set(activeCharacterIds.map(String)),id=String(chatId??'');
  return{descriptor:createRetrievalChannelDescriptor({channelId:'character-memory',capabilities:[RetrievalChannelCapability.CHARACTER_MEMORY,RetrievalChannelCapability.ACTIVE_CONTINUITY],supportedIntentKinds:['*'],maxCandidates:48,metadata:{source:'NEXUS_WORLD_TREE',store:'CHARACTER_MEMORY'}}),
    retrieve(intent){
      const rows=memoryNodes(tree,id).filter(node=>active.has(String(node.data?.character))&&!['superseded','tracking-paused'].includes(String(node.data?.status))&&node.temporal?.status!=='SUPERSEDED')
        .map(node=>({node,relevance:memoryRelevance(node,{activeIds:[...active],locationId,participantIds,now})})).sort((a,b)=>b.relevance.score-a.relevance.score||Number(b.node.data?.updatedAt??0)-Number(a.node.data?.updatedAt??0)||String(a.node.id).localeCompare(String(b.node.id))).slice(0,48);
      return rows.map(({node,relevance})=>createChannelNomination({nominationId:'character-memory:'+node.id,channelId:'character-memory',candidateId:node.id,evidenceIdentity:node.id,artifactRef:{artifactId:node.id,artifactType:'CharacterMemory'},artifactRevision:node.revision,
        sourceRevisionRefs:node.provenance?.sourceRevisionIds??[],entityRefs:uniq([node.data?.character,...(node.data?.participants??[])]),retrievalIntentIds:[intent.intentId],rankSignals:relevance,normalizedRank:Math.max(0,Math.min(1,relevance.score/10)),
        authorityClass:'DERIVED',truthStatusHint:node.temporal?.status==='CURRENT'?CandidateTruthStatus.CURRENT:CandidateTruthStatus.HISTORICAL,representationRef:node.id,representationRevision:node.revision,representationText:String(node.data?.summary??''),
        metadata:{characterId:node.data?.character,characterLabel:node.data?.characterLabel,locationId:node.data?.location,participants:node.data?.participants??[],importance:node.data?.importance,status:node.data?.status,updatedAt:node.data?.updatedAt},worldRevision:tree.revision,sceneRevision:Number(node.data?.sceneRevision??0)||0}));
    }};
}
export function retrieveCharacterMemoriesForPrompt({context,tree=getNexusWorldTreeOwner(),query='',hotSnapshot=null,sceneView=null}={}){
  const chatId=chatIdOf(context);if(!chatId)return{memories:[],fingerprint:'none',channelReceipt:null,activeCharacterIds:[]};
  const scene=sceneView??null,sceneLike=scene?sceneViewFromPublic(scene,chatId):null,activeIds=activeCharacterIds({context,tree,hotSnapshot,sceneView:scene}),locationId=sceneLike?predictedLocationNodeId(sceneLike,tree,chatId):null,participantIds=sceneLike?trackedRefsForScene(sceneLike,{tree,chatId}).map(ref=>ref.nodeId):[];
  if(!activeIds.length)return{memories:[],fingerprint:'none',channelReceipt:{channelId:'character-memory',status:'NO_ACTIVE_CAST',nominationCount:0},activeCharacterIds:[]};
  const registry=new RetrievalChannelRegistry(),provider=createCharacterMemoryRetrievalChannel({tree,chatId,activeCharacterIds:activeIds,locationId,participantIds});registry.register(provider);
  const intent=createRetrievalIntent({intentId:'character-memory-recall',kind:'CURRENT',query,entityRefs:activeIds,metadata:{origin:'MEMORY_OUTLET'}});
  const result=registry.retrieveAllSync({intents:[intent],context:{query,sceneRevision:Number(scene?.revision??0)||0,worldRevision:tree.revision},channelIds:['character-memory']});
  const memories=result.nominations.map(row=>tree.getNode(row.candidateId,{chatId})).filter(Boolean).map(node=>({id:node.id,revision:node.revision,temporalStatus:node.temporal?.status,...clone(node.data)}));
  return{memories,fingerprint:stableHash(memories.map(row=>[row.id,row.revision,row.temporalStatus,row.status])),channelReceipt:result.channelReceipts?.[0]??null,activeCharacterIds:activeIds};
}
export function characterMemoryRenderBlocks(memories=[]){
  const rows=[...(memories??[])].filter(row=>clean(row?.summary)).sort((a,b)=>String(a.characterLabel??a.character).localeCompare(String(b.characterLabel??b.character))||Number(b.updatedAt??0)-Number(a.updatedAt??0));
  return rows.map(row=>({id:String(row.id),characterId:String(row.character??''),text:String(row.characterLabel??row.character??'Character')+' remembers'+(row.status==='open'?' [current]':'')+': '+clean(row.summary)}));
}
