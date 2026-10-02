import { stableStringify } from './intake/contribution.js';
import { candidateIdForMention } from './intake/candidates.js';
import { recordWorldTreeDecision } from './decision-records.js';
import { logEvent } from '../observability/telemetry.js';

export const WORLD_TREE_WATCH_REASON=Object.freeze({DESTINATION:'MENTIONED_AS_DESTINATION',SUMMONED:'SUMMONED',OFFSTAGE:'REFERENCED_OFFSTAGE',CANDIDATE:'CANDIDATE_GAINING_EVIDENCE',THREAD:'THREAD_HORIZON'});
const clean=value=>String(value??'').replace(/\s+/g,' ').trim(),norm=value=>clean(value).toLocaleLowerCase(),uniq=values=>[...new Set((values??[]).map(clean).filter(Boolean))];
const overlayId=chatId=>'worldtree-watch:'+String(chatId);
function currentOverlay(tree,chatId){return tree.read({chatId,includeOverlays:true,limit:5000}).overlays.find(row=>row.id===overlayId(chatId))??null;}
function aliases(node){const data=node?.data??{};return uniq([data.label,data.name,data.title,data.cardName,...(data.aliases??[]),...(data.keys??[])]);}
function resolveNode(tree,chatId,label,kindHint=null){
  const key=norm(label),matches=[...tree.iterateNodes({chatId})].filter(node=>node.temporal?.status!=='SUPERSEDED'&&aliases(node).some(alias=>norm(alias)===key));
  const hint=String(kindHint??'').toUpperCase(),preferred=matches.filter(node=>hint==='CHARACTER'?node.kind==='CHARACTER':hint==='LOCATION'?node.kind==='LOCATION':hint==='ITEM'?node.kind==='ITEM':true);
  const rows=preferred.length?preferred:matches;return rows.length===1?rows[0]:null;
}
function reasonFor(relation){const value=norm(relation);if(value.includes('destination'))return WORLD_TREE_WATCH_REASON.DESTINATION;if(value.includes('planned-participant')||value.includes('summon'))return WORLD_TREE_WATCH_REASON.SUMMONED;return WORLD_TREE_WATCH_REASON.OFFSTAGE;}
function likelihoodFor(relation){const value=norm(relation);if(value.includes('planned')||value.includes('summon')||value.includes('destination'))return .9;if(value.includes('discussed'))return .68;if(value.includes('historical'))return .4;return .58;}
function entryKey(row){return row.nodeId?'node:'+row.nodeId:row.candidateId?'candidate:'+row.candidateId:'label:'+norm(row.label);}
function sourceRefs(rows=[]){return uniq(rows.map(stableStringify)).slice(0,24);}
export function readWorldTreeWatchList({tree,chatId}={}){if(!tree||chatId==null)return[];return structuredClone(currentOverlay(tree,String(chatId))?.data?.entries??[]);}
export function syncWorldTreeWatchList({tree,chatId,sceneScan=null,hotSnapshot=null,candidates=[],currentTurn=0,ttlTurns=8}={}){
  const id=String(chatId??'');if(!tree||!id)return[];
  const prior=readWorldTreeWatchList({tree,chatId:id}),byKey=new Map(prior.map(row=>[entryKey(row),row]));
  const add=row=>{const key=entryKey(row),old=byKey.get(key),next={...old,...row,firstNoticedTurn:old?.firstNoticedTurn??(Number(currentTurn)||0),lastNoticedTurn:Number(currentTurn)||0};next.sourceRefs=sourceRefs([...(old?.sourceRefs??[]),...(row.sourceRefs??[])]);byKey.set(key,next);};
  const refs=sceneScan?.references??{},buckets=[['characters','CHARACTER'],['locations','LOCATION'],['organizations','ENTITY'],['concepts','ENTITY'],['items','ITEM']];
  for(const [bucket,kindHint] of buckets)for(const raw of refs?.[bucket]??[]){const label=clean(typeof raw==='string'?raw:raw?.name),relation=clean(typeof raw==='string'?'mentioned':raw?.relation);if(!label)continue;const node=resolveNode(tree,id,label,kindHint);add({label,kindHint,nodeId:node?.id??null,candidateId:node?null:candidateIdForMention({text:label,kindHint}),reasonCode:reasonFor(relation),likelihood:likelihoodFor(relation),sourceRefs:[{sceneReference:bucket,relation}]});}
  const threads=hotSnapshot?.segments?.ACTIVE_THREADS?.value??hotSnapshot?.segments?.activeThreads?.value??[];
  for(const raw of threads??[]){const label=clean(typeof raw==='string'?raw:(raw?.summary??raw?.label??raw?.title??raw?.name??raw?.id));if(!label)continue;const node=resolveNode(tree,id,label,'ENTITY');add({label,kindHint:'ENTITY',nodeId:node?.id??null,candidateId:node?null:candidateIdForMention({text:label,kindHint:'ENTITY'}),reasonCode:WORLD_TREE_WATCH_REASON.THREAD,likelihood:.55,sourceRefs:[{hotThread:clean(raw?.id??label)}]});}
  for(const candidate of candidates??[]){if(Number(candidate?.mentionCount??0)<2)continue;add({label:clean(candidate.label),kindHint:candidate.kindHint??'ENTITY',nodeId:null,candidateId:String(candidate.candidateId),reasonCode:WORLD_TREE_WATCH_REASON.CANDIDATE,likelihood:Math.min(.9,.4+Number(candidate.mentionCount)*.15),sourceRefs:candidate.sourceRefs??[]});}
  const active=[],expired=[];for(const row of byKey.values()){if(Number(currentTurn)-Number(row.lastNoticedTurn??0)>=Math.max(1,Number(ttlTurns)||8))expired.push(row);else active.push(row);}
  for(const row of expired){const rec=recordWorldTreeDecision(tree,{chatId:id,site:'worldtree.watch',subject:{type:row.nodeId?'node':'candidate',id:row.nodeId??row.candidateId},options:['KEEP','EXPIRE'],chosen:'EXPIRE',decidedBy:'RULE',reasonCodes:['WATCH_EXPIRED'],evidence:(row.sourceRefs??[]).map(ref=>({type:'turn',ref:stableStringify(ref),weight:1}))});logEvent('worldtree.watch','expired',{chatId:id,nodeId:row.nodeId??null,candidateId:row.candidateId??null,reasonCode:'WATCH_EXPIRED',decisionRecordId:rec.id},'debug');}
  tree.addEphemeralOverlay({id:overlayId(id),kind:'RUNTIME',chatId:id,turnId:String(currentTurn),nodeIds:uniq(active.map(row=>row.nodeId).filter(Boolean)),expiresAtTurn:Number(currentTurn)+Math.max(1,Number(ttlTurns)||8),data:{watchList:true,entries:active}});
  return structuredClone(active);
}
export function resolveWorldTreeWatchMention({tree,chatId,mention,currentTurn=0}={}){
  const label=norm(mention?.text??mention?.label),kind=String(mention?.kindHint??'').toUpperCase();if(!label)return null;
  const rows=readWorldTreeWatchList({tree,chatId}).filter(row=>norm(row.label)===label&&(!kind||!row.kindHint||String(row.kindHint).toUpperCase()===kind));if(rows.length!==1)return null;
  const row=rows[0],node=row.nodeId?tree.getNode(row.nodeId,{chatId}):null,subjectId=node?.id??row.candidateId;
  if(!subjectId)return{...row,node:null};
  const rec=recordWorldTreeDecision(tree,{chatId:String(chatId),site:'worldtree.watch',subject:{type:node?'node':'candidate',id:subjectId},options:['KEEP_WATCHING','ENTER'],chosen:'ENTER',decidedBy:'RULE',reasonCodes:['ENTERED_FROM_WATCHLIST'],evidence:(row.sourceRefs??[]).map(ref=>({type:'turn',ref:stableStringify(ref),weight:1}))});
  const overlay=currentOverlay(tree,String(chatId)),remaining=(overlay?.data?.entries??[]).filter(other=>entryKey(other)!==entryKey(row));
  if(overlay)tree.addEphemeralOverlay({id:overlay.id,kind:'RUNTIME',chatId:String(chatId),turnId:String(currentTurn),nodeIds:uniq(remaining.map(entry=>entry.nodeId).filter(Boolean)),expiresAtTurn:overlay.expiresAtTurn,data:{watchList:true,entries:remaining}});
  logEvent('worldtree.watch','entered',{chatId:String(chatId),nodeId:node?.id??null,candidateId:node?null:row.candidateId,currentTurn:Number(currentTurn)||0,reasonCode:'ENTERED_FROM_WATCHLIST',decisionRecordId:rec.id},'info');return{...row,node:node??null,decisionRecordId:rec.id};
}
export function worldTreeWatchRetrievalBoost({tree,chatId}={}){const rows=readWorldTreeWatchList({tree,chatId}),high=rows.filter(row=>Number(row.likelihood)>=.75);return Object.freeze({multiplier:high.length?1.12:1,highLikelihoodCount:high.length,nodeIds:Object.freeze(uniq(high.map(row=>row.nodeId).filter(Boolean)).slice(0,12))});}
