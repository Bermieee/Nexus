import { getNexusWorldTreeOwner } from './index.js';
import { applyWorldTreeContribution } from './intake/runtime.js';
import { logEvent } from '../observability/telemetry.js';

export const WORLD_TREE_TRACK_SUGGESTIONS_KEY='nexus_world_tree_track_suggestions_v1';
const TRACKABLE=new Set(['LORE_FACT','ENTITY']);
const clone=value=>value==null?value:structuredClone(value);
const clean=value=>String(value??'').replace(/\s+/g,' ').trim();
const key=value=>clean(value).toLocaleLowerCase();
const uniq=values=>[...new Set((values??[]).filter(Boolean).map(String))];
function aliasesFor(node){const data=node?.data??{};return uniq([data.label,data.name,data.title,data.cardName,...(data.aliases??[]),...(data.keys??[])]);}
function isGlobal(node){return String(node?.scope?.type??'').toUpperCase()==='GLOBAL';}
export function isTrackedCharacterNode(node){
  if(!node||!isGlobal(node))return false;
  if(node.data?.trackedCharacter===true)return true;
  return node.kind==='CHARACTER'&&(node.data?.trackingSource==='bound-character-card'||node.provenance?.sourceType==='SILLYTAVERN_CHARACTER_CARD');
}
export function isTrackableCharacterNode(node){return Boolean(node&&isGlobal(node)&&TRACKABLE.has(String(node.kind??'').toUpperCase()));}
function trackedRef(node,matched=null){return node?Object.freeze({nodeId:String(node.id),label:String(node.data?.label??node.data?.name??node.id),kind:String(node.kind),aliases:Object.freeze(aliasesFor(node)),matched:matched??null}):null;}
export function resolveTrackedCharacterReference(value,{tree=getNexusWorldTreeOwner(),chatId=null}={}){
  const raw=typeof value==='object'?(value?.canonicalEntityId??value?.id??value?.characterId??value?.name):value;
  const text=clean(raw);if(!text)return null;
  const direct=tree.getNode(text,{chatId});if(isTrackedCharacterNode(direct))return trackedRef(direct,text);
  const resolved=tree.identityRegistry?.resolveMention?.({label:text,entityType:'CHARACTER',storyId:chatId})??null;
  if(resolved?.entity){const node=tree.getNode(resolved.entity.entityId,{chatId});if(isTrackedCharacterNode(node))return trackedRef(node,text);}
  const matches=[...tree.iterateNodes({chatId})].filter(isTrackedCharacterNode).filter(node=>aliasesFor(node).some(alias=>key(alias)===key(text)));
  return matches.length===1?trackedRef(matches[0],text):null;
}
export function trackedSceneCharacterNames(scene,{tree=getNexusWorldTreeOwner(),chatId=null}={}){
  const id=chatId??scene?.chatId??null,out=[];
  for(const name of scene?.participants??[]){
    if(resolveTrackedCharacterReference(name,{tree,chatId:id}))out.push(String(name));
  }
  return uniq(out);
}
// The names of the characters the operator tracks for this chat, straight from the World Tree.
export function trackedCharacterLabels({tree=getNexusWorldTreeOwner(),chatId=null,limit=16}={}){
  if(!tree?.iterateNodes)return[];
  const names=[];
  for(const node of tree.iterateNodes({chatId})){
    if(!isTrackedCharacterNode(node))continue;
    const label=clean(node.data?.label??node.data?.name??node.data?.title??'');
    if(label)names.push(label);
  }
  return uniq(names).sort((a,b)=>a.localeCompare(b)).slice(0,Math.max(1,Math.floor(Number(limit)||16)));
}
function resolveUntrackedTrackable(name,{tree=getNexusWorldTreeOwner(),chatId=null}={}){
  const text=clean(name);if(!text)return null;
  const direct=tree.getNode(text,{chatId});if(isTrackableCharacterNode(direct)&&!isTrackedCharacterNode(direct))return direct;
  const registry=tree.identityRegistry?.resolveMention?.({label:text,entityType:'UNKNOWN',storyId:chatId})??null;
  if(registry?.entity){const node=tree.getNode(registry.entity.entityId,{chatId});if(isTrackableCharacterNode(node)&&!isTrackedCharacterNode(node))return node;}
  const matches=[...tree.iterateNodes({chatId})].filter(node=>isTrackableCharacterNode(node)&&!isTrackedCharacterNode(node)).filter(node=>aliasesFor(node).some(alias=>key(alias)===key(text)));
  return matches.length===1?matches[0]:null;
}
function stateFor(context){
  const chatId=context?.chatId??context?.chat_id;if(chatId==null||!context?.chatMetadata)return null;
  const raw=context.chatMetadata[WORLD_TREE_TRACK_SUGGESTIONS_KEY];
  return raw?.version===1&&String(raw.chatId)===String(chatId)?clone(raw):{version:1,chatId:String(chatId),appearances:{},suggestions:{},updatedAt:0};
}
function persist(context,state){
  if(!state||!context?.chatMetadata)return false;state.updatedAt=Date.now();context.chatMetadata[WORLD_TREE_TRACK_SUGGESTIONS_KEY]=state;try{context.saveMetadataDebounced?.();}catch{}return true;
}
export async function setWorldTreeCharacterTracking({nodeId,tracked=true,context=null,tree=getNexusWorldTreeOwner()}={}){
  const id=String(nodeId??''),node=tree.getNode(id,{chatId:context?.chatId??null})??tree.nodes?.get?.(id)??null;if(!node)throw new Error('WORLD_TREE_TRACK_NODE_MISSING:'+id);
  if(!isTrackableCharacterNode(node))throw new Error('WORLD_TREE_TRACK_NODE_NOT_GLOBAL_UID:'+node.id);
  const existingIdentity=tree.identityRegistry?.get?.(node.id)??null;if(existingIdentity&&!['UNKNOWN','ENTITY','LORE_FACT','CHARACTER'].includes(String(existingIdentity.entityType??'UNKNOWN')))throw new Error('WORLD_TREE_TRACK_IDENTITY_TYPE_CONFLICT:'+node.id);
  const enabled=tracked===true,current=node.data?.trackedCharacter===true;
  if(current===enabled&&String(node.data?.tracking??(current?'active':'paused'))===(enabled?'active':'paused'))return{kind:'NexusWorldTreeTrackingReceipt',nodeId:node.id,tracked:enabled,noOp:true,worldRevision:tree.revision,node:clone(node)};
  const nextRevision=Math.max(1,Number(node.revision)||1)+1;
  const input={kind:'Contribution',source:'owner',scope:{type:'GLOBAL'},sourceRefs:[{ownerSetting:'tracked-character',nodeId:node.id,revision:nextRevision}],
    key:'tracked-character:'+node.id+':r'+nextRevision,mentions:[],edges:[],nodes:[{tempId:node.id,kind:node.kind,label:String(node.data?.label??node.id),
      fields:{trackedCharacter:enabled,tracking:enabled?'active':'paused',trackingOwnerSetting:true,trackingRevision:nextRevision},authority:'CANON'}]};
  const intake=await applyWorldTreeContribution(input,{tree,context});
  const updated=tree.getNode(node.id,{chatId:null});
  if(enabled){
    tree.registerIdentity({nodeId:updated.id,canonicalLabel:String(existingIdentity?.canonicalLabel??updated.data?.label??updated.id),entityType:'CHARACTER',aliases:aliasesFor(updated),
      providerId:'NEXUS_TRACKED_CHARACTER',sourceEntityId:updated.id,authorityOrigin:'OWNER_EXPLICIT'});
  }
  const state=stateFor(context);if(state){delete state.suggestions[node.id];persist(context,state);}
  let pausedMemories=null;
  if(!enabled&&context?.chatId!=null){
    try{
      const memory=await import('./character-memory.js');
      pausedMemories=await memory.pauseCharacterMemoriesForTracking?.({characterId:node.id,context,tree})??null;
    }catch(error){logEvent('character-memory','tracking-pause-failed',{characterId:node.id,error:error?.message||String(error)},'warn');}
  }
  logEvent('worldtree.track','owner-setting',{nodeId:node.id,kind:node.kind,tracked:enabled,worldRevision:tree.revision},'info');
  return{kind:'NexusWorldTreeTrackingReceipt',nodeId:node.id,tracked:enabled,noOp:Boolean(intake?.noOp),worldRevision:tree.revision,node:clone(updated),pausedMemories};
}
export function observeWorldTreeTrackAppearances({context,scene,tree=getNexusWorldTreeOwner()}={}){
  const state=stateFor(context),sceneId=clean(scene?.sceneId);if(!state||!sceneId)return[];
  const out=[];
  for(const name of uniq(scene?.participants??[]).slice(0,24)){
    const node=resolveUntrackedTrackable(name,{tree,chatId:state.chatId});if(!node)continue;
    const id=String(node.id),row=state.appearances[id]??{nodeId:id,label:String(node.data?.label??name),kind:String(node.kind),sceneIds:[],firstSeenAt:Date.now(),lastSeenAt:0};
    if(!row.sceneIds.includes(sceneId))row.sceneIds.push(sceneId);
    row.lastSeenAt=Date.now();row.lastSceneId=sceneId;row.sceneCount=row.sceneIds.length;state.appearances[id]=row;
    out.push({...clone(row),suggested:Boolean(state.suggestions[id])});
  }
  persist(context,state);return out.sort((a,b)=>b.sceneCount-a.sceneCount||a.nodeId.localeCompare(b.nodeId));
}
export function recordWorldTreeTrackSuggestion(candidate,{context,decisionSource='fallback'}={}){
  const state=stateFor(context);if(!state||!candidate?.nodeId)return null;
  const id=String(candidate.nodeId),row={nodeId:id,label:String(candidate.label??id),kind:String(candidate.kind??'ENTITY'),sceneCount:Number(candidate.sceneCount)||0,lastSceneId:candidate.lastSceneId??null,decisionSource:String(decisionSource),suggestedAt:Date.now()};
  state.suggestions[id]=row;persist(context,state);logEvent('worldtree.track','suggested',{chatId:state.chatId,nodeId:id,sceneCount:row.sceneCount,decisionSource:row.decisionSource},'info');return clone(row);
}
export function readWorldTreeTrackSuggestions({context,tree=getNexusWorldTreeOwner()}={}){
  const state=stateFor(context);if(!state)return[];
  return Object.values(state.suggestions).filter(row=>{const node=tree.getNode(row.nodeId,{chatId:state.chatId});return isTrackableCharacterNode(node)&&!isTrackedCharacterNode(node);}).sort((a,b)=>b.sceneCount-a.sceneCount||String(a.label).localeCompare(String(b.label))).map(clone);
}
