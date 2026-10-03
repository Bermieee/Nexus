import { createBudgetManager } from '../core/budget.js';
import { logEvent } from '../observability/telemetry.js';
import { getNexusWorldTreeOwner } from './index.js';
import { contributionFingerprint, contributionLedgerKey, contributionLineageKey, stableHash } from './intake/contribution.js';
import { enqueueWorldTreeContribution, readWorldTreeContributionQueue } from './intake/runtime.js';
import {contributionStoryScope} from './intake/story-scope.js';

const budget=createBudgetManager({emit:logEvent});
const clean=value=>String(value??'').replace(/\s+/g,' ').trim();
const normalized=value=>clean(value).toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').replace(/\s+/g,' ').trim();
const uniq=values=>[...new Set((values??[]).filter(value=>value!=null&&clean(value)).map(value=>clean(value)))];
const lifecycleOf=value=>String(value??'OPEN').toUpperCase();
const present=row=>!row||(!row.state&&!row.presence)||['PRESENT','ACTIVE'].includes(String(row?.state??row?.presence??'PRESENT').toUpperCase());

function fieldValue(record,name){const field=record?.fields?.[name];return['UNKNOWN','UNRESOLVED'].includes(String(field?.observationClass??'').toUpperCase())||field?.metadata?.retractedBy?null:field?.value??null;}
function rows(value){return Array.isArray(value)?value:[];}
function labelsForNode(node){const data=node?.data??{};return uniq([data.label,data.name,data.title,data.cardName,...(data.aliases??[]),...(data.keys??[])]);}
function existingNodeByLabel(tree,text,{chatId=null,kind=null}={}){
  if(!tree||!clean(text))return null;const key=normalized(text),matches=[];
  for(const node of tree.iterateNodes({chatId})){if(kind&&String(node.kind)!==String(kind).toUpperCase())continue;if(labelsForNode(node).some(label=>normalized(label)===key))matches.push(node);}
  return matches.length===1?matches[0]:null;
}
function nearestExplicitParentLocation(tree,location,{chatId=null}={}){
  const child=normalized(location);if(!tree||!child)return null;const hay=' '+child+' ';let best=null,bestLength=0;
  for(const node of tree.iterateNodes({chatId}))if(['LOCATION','LORE_FACT'].includes(node.kind))for(const alias of labelsForNode(node)){
    const key=normalized(alias);if(!key||key===child||key.length<3||!hay.includes(' '+key+' '))continue;
    if(key.length>bestLength){best=node;bestLength=key.length;}
  }
  return best;
}
function participantRef(row){
  if(typeof row==='string')return{id:clean(row),label:clean(row),canonicalEntityId:null,trackedCharacter:false};
  const id=clean(row?.characterId??row?.id??row?.label),label=clean(row?.label??row?.characterId??row?.id);
  return{id,label:label||id,canonicalEntityId:row?.canonicalEntityId==null?null:String(row.canonicalEntityId),trackedCharacter:row?.trackedCharacter===true};
}
function valueLabel(row,keys){if(typeof row==='string')return clean(row);for(const key of keys){const value=clean(row?.[key]);if(value)return value;}return'';}

export function sceneRecordToContributionView(record,{chatId=null}={}){
  if(!record?.sceneId)return null;
  const cast=rows(fieldValue(record,'activeCast')).filter(present).map(participantRef).filter(row=>row.label),atmosphere=fieldValue(record,'atmosphere')??{};
  return Object.freeze({
    chatId:String(chatId??record.chatId??''),sceneId:String(record.sceneId),revision:Math.max(1,Number(record.revision)||1),lifecycle:lifecycleOf(record.lifecycle),
    participantRefs:Object.freeze(cast),participants:Object.freeze(cast.map(row=>row.label)),
    location:clean(fieldValue(record,'location')?.location??fieldValue(record,'location'))||null,
    parentLocation:clean(fieldValue(record,'location')?.parentLocation??fieldValue(record,'location')?.containment?.parentLocation)||null,
    sourceRange:record.sourceRange?structuredClone(record.sourceRange):null,sourceMessageRefs:Object.freeze(structuredClone(record.sourceMessageRefs??[])),
    objects:Object.freeze(uniq(rows(fieldValue(record,'immediateObjects')).map(row=>valueLabel(row,['objectId','id','name'])))),
    threads:Object.freeze(uniq(rows(fieldValue(record,'activeThreads')).map(row=>valueLabel(row,['threadId','id','summary'])))),
    objectives:Object.freeze(uniq(rows(fieldValue(record,'activeObjectives')).map(row=>valueLabel(row,['objective','id'])))),
    activity:clean(atmosphere?.activity)||null,focus:clean(atmosphere?.focus)||null,narrativeTime:clean(fieldValue(record,'narrativeTime'))||null,
    relationshipFocus:atmosphere?.relationshipFocus===true,sourceRevisionRefs:Object.freeze(uniq(record.sourceRevisionRefs)),
  });
}
function normalizeSceneView(scene,{chatId=null}={}){
  if(!scene?.sceneId)return null;
  const refs=(scene.participantRefs?.length?scene.participantRefs:(scene.participants??[]).map(participantRef)).map(participantRef).filter(row=>row.label);
  return Object.freeze({
    chatId:String(chatId??scene.chatId??''),sceneId:String(scene.sceneId),revision:Math.max(1,Number(scene.revision)||1),lifecycle:lifecycleOf(scene.lifecycle),
    participantRefs:Object.freeze(refs),participants:Object.freeze(refs.map(row=>row.label)),location:clean(scene.location)||null,
    parentLocation:clean(scene.parentLocation??scene.containment?.parentLocation)||null,sourceRange:scene.sourceRange?structuredClone(scene.sourceRange):null,sourceMessageRefs:Object.freeze(structuredClone(scene.sourceMessageRefs??[])),
    objects:Object.freeze(uniq(scene.objects)),threads:Object.freeze(uniq(scene.threads)),objectives:Object.freeze(uniq(scene.objectives)),
    activity:clean(scene.activity)||null,focus:clean(scene.focus)||null,narrativeTime:clean(scene.narrativeTime)||null,relationshipFocus:scene.relationshipFocus===true,
    sourceRevisionRefs:Object.freeze(uniq(scene.sourceRevisionRefs)),
  });
}
const sourceRefs=(scene,context)=>{
  const refs=[{sceneId:String(scene.sceneId),sceneRevision:Number(scene.revision)||1},...(scene.sourceMessageRefs??[])];
  if(!scene.sourceMessageRefs?.length&&scene.sourceRange&&Array.isArray(context?.chat))for(let index=Math.max(0,Number(scene.sourceRange.start)||0);index<=Math.min(context.chat.length-1,Number(scene.sourceRange.end)||0);index++){
    const message=context.chat[index];if(message)refs.push({messageId:'message:'+index,sourceIndex:index,swipeId:message.swipe_id??null,messageRevision:stableHash([index,message.swipe_id??null,message.is_user?'u':'a',String(message.mes??'')])});
  }
  return refs;
};
const contributionKey=scene=>'scene:'+encodeURIComponent(String(scene.sceneId))+':'+String(scene.revision)+':'+lifecycleOf(scene.lifecycle);

export function buildWorldTreeSceneContribution({scene,tree=getNexusWorldTreeOwner(),context=null}={}){
  const view=normalizeSceneView(scene);if(!view?.chatId||!view.sceneId)throw new Error('WORLD_TREE_SCENE_IDENTITY_INCOMPLETE');
  const owner=tree,storyScope=contributionStoryScope(owner,context,{chatId:view.chatId});
  tree={getNode:storyScope.getNode,iterateNodes:({kind=null}={})=>storyScope.iterateNodes().filter(row=>!kind||row.kind===kind)};
  const mentions=[],edges=[],mentionByKey=new Map(),chatId=view.chatId;
  const mention=(prefix,text,kindHint)=>{
    const label=clean(text);if(!label)return null;const key=String(kindHint)+':'+normalized(label);if(mentionByKey.has(key))return mentionByKey.get(key);
    const mentionId=prefix+':'+stableHash([kindHint,normalized(label)]);mentionByKey.set(key,mentionId);
    mentions.push({mentionId,text:label,kindHint,contextSnippetHash:stableHash([view.sceneId,view.revision,prefix,label])});return mentionId;
  };
  for(const ref of view.participantRefs){
    const canonical=clean(ref?.canonicalEntityId),exact=canonical&&tree?.getNode(canonical,{chatId})?tree.getNode(canonical,{chatId}):existingNodeByLabel(tree,ref?.label,{chatId});
    const endpoint=exact?.id??mention('cast',ref?.label,'CHARACTER');if(endpoint)edges.push({from:endpoint,to:'scene',meaning:'present-in',authority:'OBSERVED'});
  }
  let locationEndpoint=null;
  if(view.location){
    const existing=existingNodeByLabel(tree,view.location,{chatId,kind:'LOCATION'});locationEndpoint=existing?.id??mention('location',view.location,'LOCATION');
    edges.push({from:'scene',to:locationEndpoint,meaning:'at',authority:'OBSERVED'});
    if(!existing){
      const parent=view.parentLocation?existingNodeByLabel(tree,view.parentLocation,{chatId}):nearestExplicitParentLocation(tree,view.location,{chatId});
      if(parent)edges.push({from:locationEndpoint,to:parent.id,meaning:'part-of',authority:'OBSERVED'});
    }
  }
  for(const name of view.threads){const existing=existingNodeByLabel(tree,name,{chatId}),endpoint=existing?.id??mention('thread',name,'ENTITY');if(endpoint)edges.push({from:'scene',to:endpoint,meaning:'about',authority:'OBSERVED'});}
  for(const name of view.objects){
    const existing=existingNodeByLabel(tree,name,{chatId,kind:'ITEM'}),endpoint=existing?.id??mention('object',name,'ITEM');if(!endpoint)continue;
    edges.push({from:'scene',to:endpoint,meaning:'about',authority:'OBSERVED'});if(locationEndpoint)edges.push({from:endpoint,to:locationEndpoint,meaning:'located-in',authority:'OBSERVED'});
  }
  return{kind:'Contribution',source:'scene',scope:{type:'CHAT',chatId},sourceRefs:sourceRefs(view,context),key:contributionKey(view),mentions,
    nodes:[{tempId:'scene',kind:'SCENE',label:'Scene '+view.sceneId,authority:'OBSERVED',temporalStatus:view.lifecycle==='CLOSED'?'HISTORICAL':'CURRENT',fields:{
      sceneId:view.sceneId,sceneRevision:view.revision,lifecycle:view.lifecycle,participants:[...view.participants],location:view.location,parentLocation:view.parentLocation,sourceRange:view.sourceRange,objects:[...view.objects],threads:[...view.threads],
      objectives:[...view.objectives],activity:view.activity,focus:view.focus,narrativeTime:view.narrativeTime,relationshipFocus:view.relationshipFocus,sourceRevisionRefs:[...view.sourceRevisionRefs],
    }}],edges};
}
function canonicalByLabel(scenes){
  const map=new Map();for(const scene of scenes)for(const ref of scene.participantRefs??[]){const label=normalized(ref.label),id=clean(ref.canonicalEntityId);if(!label||!id)continue;if(!map.has(label))map.set(label,new Set());map.get(label).add(id);}return map;
}
function aggregateMember(ref,canonicalMap){
  const label=clean(ref?.label);if(!label)return null;const labelKey=normalized(label),known=canonicalMap.get(labelKey),explicit=clean(ref?.canonicalEntityId),canonical=explicit||(known?.size===1?[...known][0]:null);
  return{key:canonical?'uid:'+canonical:'label:'+labelKey,canonicalId:canonical||null,label};
}
export function buildWorldTreeSceneCoPresenceContribution({chatId,scenes=[]}={}){
  const id=clean(chatId);if(!id)throw new Error('WORLD_TREE_SCENE_CHAT_ID_REQUIRED');
  const normalizedScenes=scenes.map(scene=>normalizeSceneView(scene,{chatId:id})).filter(Boolean),canonicalMap=canonicalByLabel(normalizedScenes),pairs=new Map(),sceneSignatures=[];
  for(const scene of normalizedScenes){
    const members=[],seen=new Set();for(const ref of scene.participantRefs){const member=aggregateMember(ref,canonicalMap);if(!member||seen.has(member.key))continue;seen.add(member.key);members.push(member);}members.sort((a,b)=>a.key.localeCompare(b.key));
    sceneSignatures.push([scene.sceneId,members.map(row=>row.key)]);
    for(let i=0;i<members.length;i++)for(let j=i+1;j<members.length;j++){const a=members[i],b=members[j],key=a.key+'|'+b.key;if(!pairs.has(key))pairs.set(key,{a,b,sceneIds:new Set()});pairs.get(key).sceneIds.add(scene.sceneId);}
  }
  sceneSignatures.sort((a,b)=>String(a[0]).localeCompare(String(b[0])));const revision=stableHash(sceneSignatures),mentions=[],mentionByKey=new Map(),edges=[];
  const endpoint=member=>{if(member.canonicalId)return member.canonicalId;if(mentionByKey.has(member.key))return mentionByKey.get(member.key);const mentionId='copresent:'+stableHash(member.key);mentionByKey.set(member.key,mentionId);mentions.push({mentionId,text:member.label,kindHint:'CHARACTER',contextSnippetHash:stableHash(['co-presence',member.label])});return mentionId;};
  for(const key of [...pairs.keys()].sort()){const pair=pairs.get(key),sceneIds=[...pair.sceneIds].sort();edges.push({from:endpoint(pair.a),to:endpoint(pair.b),meaning:'relationship',subtype:'co-present',authority:'OBSERVED',weight:sceneIds.length,sourceSceneIds:sceneIds});}
  return{kind:'Contribution',source:'scene',scope:{type:'CHAT',chatId:id},sourceRefs:[{sceneSet:'co-presence',revision}],key:'scene-co-presence:'+revision,mentions,nodes:[],edges};
}
function contributionCurrent(tree,contribution,queuedKeys){
  const ledgerKey=contributionLedgerKey(contribution);if(queuedKeys.has(ledgerKey))return true;const record=tree.contributionRecord?.(ledgerKey),head=tree.latestContributionRecord?.(contributionLineageKey(contribution));
  return Boolean(record&&head?.ledgerKey===ledgerKey&&record.fingerprint===contributionFingerprint(contribution));
}
export async function runWorldTreeSceneContributionJob({context=null,tree=getNexusWorldTreeOwner(),sceneView=null,sceneState=null,isFresh=()=>true,generationId=context?.generationId??null}={}){
  const chatId=clean(context?.chatId??context?.chat_id??sceneView?.chatId??sceneState?.chatId);if(!chatId)return{kind:'NexusWorldTreeSceneContributionJob',skipped:true,reason:'no-chat',queuedCount:0,noOpCount:0,deferredCount:0,failedCount:0,sceneCount:0};
  const storyScope=contributionStoryScope(tree,context,{chatId});
  let state=sceneState,view=sceneView;
  if(!state||!view){try{const scene=await import('../nexus/scene-intelligence.js');if(!state)state=scene.exportNexusSceneIntelligence?.()??null;if(!view)view=scene.getNexusSceneIntelligenceView?.({chatId})??null;}catch{}}
  storyScope.assertFresh();
  const byId=new Map();for(const record of [...(state?.history??[]),state?.current].filter(Boolean)){const row=sceneRecordToContributionView(record,{chatId});if(row)byId.set(row.sceneId,row);}
  const current=normalizeSceneView(view,{chatId});if(current)byId.set(current.sceneId,current);const scenes=[...byId.values()];
  if(!scenes.length)return{kind:'NexusWorldTreeSceneContributionJob',skipped:true,reason:'no-scene',queuedCount:0,noOpCount:0,deferredCount:0,failedCount:0,sceneCount:0};
  const contributions=scenes.map(scene=>buildWorldTreeSceneContribution({scene,tree,context}));contributions.push(buildWorldTreeSceneCoPresenceContribution({chatId,scenes}));
  const queuedKeys=new Set(readWorldTreeContributionQueue({context}).map(row=>row.id)),changed=[];let noOpCount=0;
  for(const row of contributions){if(contributionCurrent(tree,row,queuedKeys))noOpCount++;else changed.push(row);}
  if(!changed.length)return{kind:'NexusWorldTreeSceneContributionJob',skipped:true,reason:'no-scene-revision',queuedCount:0,noOpCount,deferredCount:0,failedCount:0,sceneCount:scenes.length};
  const frame=budget.beginTurn({timeMs:5000,worldSize:changed.length}),allowance=frame.compute('worldtree.contribute.scene',{total:changed.length,defaultUnits:4,defaultWorldSize:4,msPerUnit:1});
  if(!allowance.allowed)return{kind:'NexusWorldTreeSceneContributionJob',deferred:true,reason:'budget',queuedCount:0,noOpCount,deferredCount:changed.length,failedCount:0,sceneCount:scenes.length};
  let queuedCount=0,failedCount=0,deferredCount=Math.max(0,changed.length-allowance.allowed),lastError=null;
  for(const row of changed.slice(0,allowance.allowed)){if(isFresh()===false){deferredCount+=1;continue;}try{enqueueWorldTreeContribution(row,{context,generationId});queuedCount+=1;}catch(error){failedCount+=1;lastError=error?.message||String(error);logEvent('worldtree.scene','contribution-dropped',{chatIdHash:stableHash(chatId),keyHash:stableHash(row.key),error:lastError},'warn');}}
  const result={kind:'NexusWorldTreeSceneContributionJob',queuedCount,noOpCount,deferredCount,failedCount,sceneCount:scenes.length,deferred:deferredCount>0,failed:failedCount>0&&queuedCount===0,error:lastError};
  logEvent('worldtree.scene','contribution-job',{chatIdHash:stableHash(chatId),sceneCount:scenes.length,queuedCount,noOpCount,deferredCount,failedCount},failedCount?'warn':'info');return result;
}
