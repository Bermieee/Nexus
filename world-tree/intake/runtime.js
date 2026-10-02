import { getNexusWorldTreeOwner } from '../index.js';
import { createBudgetManager } from '../../core/budget.js';
import { logEvent } from '../../observability/telemetry.js';
import { TASK8_POSTTURN_SITE_IDS, runTask8ChoiceDecision } from '../../decision/task8-postturn-sites.js';
import {
  normalizeWorldTreeContribution,contributionFingerprint,contributionLedgerKey,contributionLineageKey,contributionNodeId,contributionEdgeId,contributionSourceRefStrings,
  nonStandardContributionEdges,stableHash,stableStringify,
} from './contribution.js';
import {
  readWorldTreeCandidateState,persistWorldTreeCandidateState,noteUnresolvedMention,queuePendingCandidateEdge,promoteCandidateInState,
  candidateApplicationFingerprint,markCandidateApplication,expireWorldTreeCandidates,
} from './candidates.js';
import { decideWorldTreeGrowth } from '../growth.js';
import { recordWorldTreeDecision, sourceRefsToDecisionEvidence } from '../decision-records.js';
import { resolveWorldTreeWatchMention } from '../watch-list.js';
import { canonicalWorldTreeEdgeMeaning,isStandardWorldTreeEdgeMeaning } from './edge-vocabulary.js';

export const WORLD_TREE_INTAKE_QUEUE_METADATA_KEY='nexus_world_tree_intake_queue_v1';
const intakeBudget=createBudgetManager({emit:logEvent});
const clone=value=>value==null?value:structuredClone(value);
const clean=value=>String(value??'').trim();
const normalized=value=>clean(value).toLocaleLowerCase().replace(/\s+/g,' ');
const DEFAULT_PROMOTION_THRESHOLD=3;

function sourceAuthority(source){return source==='card'?'CARD':source==='scene'?'OBSERVED':['memory','character-memory'].includes(source)?'REMEMBERED':source==='owner'?'CANON':'INFERRED';}
function sourceType(source){return 'NEXUS_WORLD_TREE_'+String(source).toUpperCase().replace(/-/g,'_');}
function sourceMessageRefs(contribution,sourceRefs=contribution.sourceRefs){
  if(contribution.scope.type!=='CHAT')return[];
  return sourceRefs.filter(ref=>ref&&typeof ref==='object'&&(ref.messageId??ref.message_id??null)!=null).map(ref=>({
    chatId:contribution.scope.chatId,messageId:String(ref.messageId??ref.message_id),messageRevision:ref.messageRevision??ref.revision??null,swipeId:ref.swipeId??ref.swipeIndex??null,sourceIndex:Number.isFinite(Number(ref.sourceIndex))?Number(ref.sourceIndex):null,
  }));
}
function provenance(contribution,sourceRefs=contribution.sourceRefs){
  return {sourceType:sourceType(contribution.source),sourceIds:[contribution.source,contribution.key],sourceRevisionIds:sourceRefs.map(stableStringify),messageRefs:sourceMessageRefs(contribution,sourceRefs)};
}
function aliasesFor(node){
  const data=node?.data??{};return [...new Set([data.label,data.name,data.title,data.cardName,...(data.aliases??[]),...(data.keys??[])].filter(Boolean).map(String))];
}
function visibleNodes(tree,contribution){
  const chatId=contribution.scope.type==='CHAT'?contribution.scope.chatId:null;
  return [...tree.iterateNodes({chatId})];
}
function kindForCandidate(kindHint){
  const hint=String(kindHint??'').toUpperCase();
  if(['LOCATION','PLACE'].includes(hint))return'LOCATION';
  if(['ITEM','OBJECT'].includes(hint))return'ITEM';
  if(hint==='SCENE')return'SCENE';
  return'ENTITY';
}
function dice(a,b){
  const left=normalized(a),right=normalized(b);if(!left||!right)return 0;if(left===right)return 1;
  const grams=value=>{const padded=' '+value+' ',out=[];for(let i=0;i<padded.length-1;i++)out.push(padded.slice(i,i+2));return out;};
  const x=grams(left),y=grams(right),counts=new Map();for(const gram of x)counts.set(gram,(counts.get(gram)||0)+1);
  let shared=0;for(const gram of y){const n=counts.get(gram)||0;if(n>0){shared++;counts.set(gram,n-1);}}
  return (2*shared)/(x.length+y.length);
}
function exactNodeMatches(nodes,text){
  const key=normalized(text);return nodes.filter(node=>aliasesFor(node).some(alias=>normalized(alias)===key));
}
function nodeSummary(node){return {id:node.id,kind:node.kind,label:String(node?.data?.label??node?.data?.name??node.id),aliases:aliasesFor(node).slice(0,12),scope:node.scope,revision:node.revision};}
async function defaultIdentityAdvisor({mention,candidates,chatId,worldRevision}={}){
  const same=[];
  for(const candidate of candidates.slice(0,3)){
    const run=await runTask8ChoiceDecision(TASK8_POSTTURN_SITE_IDS.WORLDTREE_IDENTITY,{
      revisions:{worldRevision},state:{left:{id:'mention:'+mention.mentionId,kind:mention.kindHint??'UNKNOWN',label:mention.text},right:nodeSummary(candidate)},
    },'REVIEW',{reasonCode:'INTAKE_IDENTITY_AMBIGUOUS',telemetrySelection:{chatId}});
    if(run.choice==='SAME_ENTITY')same.push(candidate);
  }
  return same.length===1?same[0]:null;
}
function resolutionBudgetAllows(nodes){
  const frame=intakeBudget.beginTurn({timeMs:5000,worldSize:Math.max(1,nodes.length)});
  const receipt=frame.compute('worldtree.intake.resolve',{total:nodes.length,defaultUnits:Math.max(1,nodes.length),defaultWorldSize:Math.max(1,nodes.length),msPerUnit:0.01,sanityCeiling:100000});
  return receipt.complete;
}
async function resolveMention({tree,contribution,mention,stagedAliasMap,identityAdvisor,similarityThreshold,similarityMargin,context=null}){
  const staged=stagedAliasMap.get(normalized(mention.text))??[];
  if(staged.length===1)return{path:'exact',nodeId:staged[0].id,node:staged[0],score:1};
  const chatId=contribution.scope.type==='CHAT'?contribution.scope.chatId:null;
  let watchEntry=null;
  if(chatId!=null&&contribution.source==='scene'){
    watchEntry=resolveWorldTreeWatchMention({tree,chatId,mention,currentTurn:Array.isArray(context?.chat)?Math.max(0,context.chat.length-1):0});
    if(watchEntry?.node)return{path:'watch',nodeId:watchEntry.node.id,node:watchEntry.node,score:1,watchDecisionRecordId:watchEntry.decisionRecordId};
  }
  const direct=tree.getNode(mention.text,{chatId});if(direct)return{path:'exact',nodeId:direct.id,node:direct,score:1,watchDecisionRecordId:watchEntry?.decisionRecordId??null};
  const nodes=visibleNodes(tree,contribution);if(!resolutionBudgetAllows(nodes))return{deferred:true,reason:'resolution-budget'};
  const exact=exactNodeMatches(nodes,mention.text);if(exact.length===1)return{path:'exact',nodeId:exact[0].id,node:exact[0],score:1};
  let ambiguous=exact.length>1?exact:[];
  const registry=tree.identityRegistry?.resolveMention?.({label:mention.text,entityType:mention.kindHint??'UNKNOWN',storyId:chatId})??null;
  if(registry?.entity){
    const node=tree.getNode(registry.entity.entityId,{chatId});if(node)return{path:'registry',nodeId:node.id,node,score:1};
  }
  if(!ambiguous.length&&Array.isArray(registry?.candidateEntityIds)&&registry.candidateEntityIds.length){
    ambiguous=registry.candidateEntityIds.map(id=>tree.getNode(id,{chatId})).filter(Boolean);
  }
  const scored=nodes.map(node=>({node,score:Math.max(0,...aliasesFor(node).map(alias=>dice(mention.text,alias)))})).filter(row=>row.score>0).sort((a,b)=>b.score-a.score||String(a.node.id).localeCompare(String(b.node.id)));
  const first=scored[0],second=scored[1];
  if(first&&first.score>=similarityThreshold&&(!second||first.score-second.score>=similarityMargin))return{path:'similarity',nodeId:first.node.id,node:first.node,score:first.score,margin:first.score-(second?.score??0)};
  if(!ambiguous.length&&first&&first.score>=similarityThreshold)ambiguous=scored.filter(row=>first.score-row.score<similarityMargin).slice(0,3).map(row=>row.node);
  if(ambiguous.length){
    const advised=await identityAdvisor({mention,candidates:ambiguous,chatId,worldRevision:tree.revision});
    if(advised)return{path:'jev',nodeId:advised.id,node:advised,score:null,candidateCount:ambiguous.length};
  }
  return{path:'unresolved',nodeId:null,node:null,score:first?.score??0,candidateCount:ambiguous.length,watchDecisionRecordId:watchEntry?.decisionRecordId??null};
}
function stableNodeAliasMap(nodePayloads){
  const map=new Map();for(const row of nodePayloads){const key=normalized(row.data?.label);if(!key)continue;if(!map.has(key))map.set(key,[]);map.get(key).push(row);}return map;
}
function stableContributionNodeId(contribution,row){
  if(contribution.source==='owner')return String(row.tempId);
  if(contribution.source==='card'&&contribution.scope.type==='GLOBAL'&&row.kind==='CHARACTER')return String(row.tempId);
  return null;
}
function nodePayload(tree,contribution,row){
  const authority=row.authority||sourceAuthority(contribution.source),stableId=stableContributionNodeId(contribution,row),chatId=contribution.scope.type==='CHAT'?contribution.scope.chatId:null;
  const existing=stableId?tree.getNode(stableId,{chatId}):null;
  if(existing&&stableId){
    if(existing.scope?.type!==contribution.scope.type||(existing.scope?.type==='CHAT'&&String(existing.scope.chatId)!==String(contribution.scope.chatId)))throw new Error('WORLD_TREE_STABLE_NODE_SCOPE_MISMATCH:'+existing.id);
    if(String(existing.kind)!==String(row.kind))throw new Error('WORLD_TREE_STABLE_NODE_KIND_MISMATCH:'+existing.id);
    const fields=clone(row.fields??{});delete fields.parentId;
    if(contribution.source==='card'&&existing.data?.trackingOwnerSetting===true){fields.trackedCharacter=existing.data?.trackedCharacter===true;fields.tracking=existing.data?.tracking??(fields.trackedCharacter?'active':'paused');fields.trackingOwnerSetting=true;}
    const patchForeignOwner=contribution.source==='owner'&&contribution.scope.type==='GLOBAL'&&existing.provenance?.sourceType!=='NEXUS_WORLD_TREE_OWNER';
    if(patchForeignOwner)return {...existing,parentId:existing.parentId??null,scope:existing.scope,provenance:existing.provenance,temporal:existing.temporal,
      data:{...clone(existing.data??{}),...fields,label:existing.data?.label??row.label}};
    return {id:stableId,kind:row.kind,parentId:row.fields?.parentId??existing.parentId??null,scope:contribution.scope,provenance:provenance(contribution),temporal:{status:row.temporalStatus||'CURRENT',reason:row.temporalReason??null},
      data:{...fields,label:row.label,authority,contributionSource:contribution.source,contributionKey:contribution.key}};
  }
  return {id:stableId??contributionNodeId(contribution,row.tempId),kind:row.kind,parentId:row.fields?.parentId??null,scope:contribution.scope,provenance:provenance(contribution),temporal:{status:row.temporalStatus||'CURRENT',reason:row.temporalReason??null},
    data:{...clone(row.fields),label:row.label,authority,contributionSource:contribution.source,contributionKey:contribution.key}};
}
function candidateNodePayload(contribution,candidate){
  const authority=sourceAuthority(contribution.source),id='discovery:'+stableHash([contribution.scope.chatId,candidate.candidateId]);
  return {id,kind:kindForCandidate(candidate.kindHint),scope:contribution.scope,provenance:provenance(contribution),temporal:{status:'CURRENT'},
    data:{label:candidate.label,aliases:[...candidate.aliasesSeen],authority,discoveredFromMentions:candidate.mentionCount,candidatePromotion:true}};
}
function edgePayload(contribution,{id,from,to,meaning,subtype=null,authority=null,validFrom=null,validTo=null,sourceField=null,sourceSnippetHash=null,weight=null,sourceSceneIds=[],sourceRefs=null}){
  return {id,from,to,relation:canonicalWorldTreeEdgeMeaning(meaning),scope:contribution.scope,provenance:provenance(contribution,sourceRefs??contribution.sourceRefs),
    temporal:{status:'CURRENT',validFrom,validUntil:validTo},data:{subtype,authority:authority||sourceAuthority(contribution.source),contributionSource:contribution.source,contributionKey:contribution.key,sourceField,sourceSnippetHash,weight,sourceSceneIds:[...(sourceSceneIds??[])]}};
}
function registerContributionIdentities(tree,contribution,nodes){
  for(const node of nodes){
    if(node?.kind!=='CHARACTER')continue;
    if(contribution.source==='card'){
      try{tree.registerIdentity({nodeId:node.id,canonicalLabel:String(node.data?.label??node.id),entityType:'CHARACTER',aliases:node.data?.aliases??[],providerId:'SILLYTAVERN_CHARACTER_CARD',sourceEntityId:String(node.data?.avatar??node.id),authorityOrigin:'SOURCE_EXPLICIT'});}catch(error){logEvent('worldtree.intake','identity-registration-failed',{source:'card',nodeId:node.id,error:error?.message||String(error)},'warn');}
    }else if(contribution.source==='owner'){
      try{tree.registerIdentity({nodeId:node.id,canonicalLabel:String(node.data?.label??node.id),entityType:'CHARACTER',aliases:node.data?.aliases??[],providerId:String(node.data?.identityProviderId??'NEXUS_WORLD_TREE_OWNER'),sourceEntityId:String(node.data?.identitySourceEntityId??node.id),authorityOrigin:'OWNER_EXPLICIT'});}catch(error){logEvent('worldtree.intake','identity-registration-failed',{source:'owner',nodeId:node.id,error:error?.message||String(error)},'warn');}
    }
  }
}
function endpointCrossChat(tree,id,chatId){
  const raw=tree?.nodes?.get?.(String(id));return raw?.scope?.type==='CHAT'&&String(raw.scope.chatId)!==String(chatId);
}

export function applyDeterministicWorldTreeContribution(input,{tree=getNexusWorldTreeOwner(),context=null}={}){
  const contribution=normalizeWorldTreeContribution(input),chatId=contribution.scope.type==='CHAT'?contribution.scope.chatId:null;
  if(contribution.mentions.length)throw new Error('WORLD_TREE_DETERMINISTIC_CONTRIBUTION_MENTIONS_FORBIDDEN');
  if(chatId!=null&&context?.chatId!=null&&String(context.chatId)!==String(chatId))throw new Error('WORLD_TREE_CONTRIBUTION_CHAT_SCOPE_MISMATCH');
  const ledgerKey=contributionLedgerKey(contribution),lineageKey=contributionLineageKey(contribution),fingerprint=contributionFingerprint(contribution);
  const prior=tree.contributionRecord?.(ledgerKey),lineageHead=tree.latestContributionRecord?.(lineageKey);if(prior?.fingerprint===fingerprint&&lineageHead?.ledgerKey===ledgerKey)return{kind:'NexusWorldTreeIntakeReceipt',source:contribution.source,key:contribution.key,noOp:true,worldRevision:tree.revision,resolutions:[],unresolved:[],createdNodeIds:[],updatedNodeIds:[],createdEdgeIds:[],updatedEdgeIds:[],supersededNodeIds:[],supersededEdgeIds:[]};
  const nodePayloads=contribution.nodes.map(row=>nodePayload(tree,contribution,row)),tempMap=new Map(contribution.nodes.map((row,index)=>[row.tempId,nodePayloads[index].id]));
  const resolveEndpoint=value=>{
    if(tempMap.has(value))return tempMap.get(value);
    if(chatId!=null&&endpointCrossChat(tree,value,chatId))throw new Error('WORLD_TREE_EDGE_CHAT_SCOPE_MISMATCH');
    const node=tree.getNode(value,{chatId});if(node)return node.id;
    throw new Error('WORLD_TREE_CONTRIBUTION_EDGE_ENDPOINT_UNKNOWN:'+String(value));
  };
  const edgePayloads=contribution.edges.map((edge,index)=>edgePayload(contribution,{...edge,id:contributionEdgeId(contribution,index,edge),from:resolveEndpoint(edge.from),to:resolveEndpoint(edge.to)}));
  const applyDecision=recordWorldTreeDecision(tree,{generationId:context?.generationId??null,chatId,site:'worldtree.intake',subject:{type:'job',id:ledgerKey},options:['APPLY','NOOP','REJECT'],chosen:'APPLY',decidedBy:'RULE',reasonCodes:['CONTRIBUTION_VALIDATED'],evidence:sourceRefsToDecisionEvidence(contribution.source,contribution.sourceRefs)});
  const committed=tree.applyContributionRevision({ledgerKey,lineageKey,fingerprint,source:contribution.source,scope:contribution.scope,nodes:nodePayloads,edges:edgePayloads,decisionRecordIds:[applyDecision.id]});
  registerContributionIdentities(tree,contribution,nodePayloads);
  const receipt={kind:'NexusWorldTreeIntakeReceipt',source:contribution.source,key:contribution.key,noOp:committed.noOp,worldRevision:committed.worldRevision,nodeCount:nodePayloads.length,edgeCount:edgePayloads.length,resolutions:[],unresolved:[],
    createdNodeIds:[...committed.createdNodeIds],updatedNodeIds:[...committed.updatedNodeIds],createdEdgeIds:[...committed.createdEdgeIds],updatedEdgeIds:[...committed.updatedEdgeIds],supersededNodeIds:[...committed.supersededNodeIds],supersededEdgeIds:[...committed.supersededEdgeIds]};
  logEvent('worldtree.intake','applied-deterministic',{source:receipt.source,keyHash:stableHash(receipt.key),nodeCount:receipt.nodeCount,edgeCount:receipt.edgeCount,noOp:receipt.noOp},'info');
  return receipt;
}

export async function applyWorldTreeContribution(input,{tree=getNexusWorldTreeOwner(),context=null,identityAdvisor=defaultIdentityAdvisor,promotionThreshold=DEFAULT_PROMOTION_THRESHOLD,promoteMentionIds=[],similarityThreshold=0.78,similarityMargin=0.12}={}){
  const contribution=normalizeWorldTreeContribution(input),chatId=contribution.scope.type==='CHAT'?contribution.scope.chatId:null,currentTurn=Array.isArray(context?.chat)?Math.max(0,context.chat.length-1):null;
  if(chatId!=null&&context?.chatId!=null&&String(context.chatId)!==String(chatId))throw new Error('WORLD_TREE_CONTRIBUTION_CHAT_SCOPE_MISMATCH');
  const ledgerKey=contributionLedgerKey(contribution),lineageKey=contributionLineageKey(contribution),fingerprint=contributionFingerprint(contribution);
  const prior=tree.contributionRecord?.(ledgerKey),lineageHead=tree.latestContributionRecord?.(lineageKey);if(prior?.fingerprint===fingerprint&&lineageHead?.ledgerKey===ledgerKey)return{kind:'NexusWorldTreeIntakeReceipt',source:contribution.source,key:contribution.key,noOp:true,worldRevision:tree.revision,resolutions:[],unresolved:[],createdNodeIds:[],createdEdgeIds:[]};
  const candidateState=chatId!=null?readWorldTreeCandidateState({context,chatId}):null;
  if(candidateState&&candidateApplicationFingerprint(candidateState,ledgerKey)===fingerprint)return{kind:'NexusWorldTreeIntakeReceipt',source:contribution.source,key:contribution.key,noOp:true,worldRevision:tree.revision,resolutions:[],unresolved:[],createdNodeIds:[],createdEdgeIds:[]};

  const warnings=nonStandardContributionEdges(input);for(const warning of warnings)logEvent('worldtree.intake','edge-meaning-nonstandard',{source:contribution.source,key:contribution.key,index:warning.index,input:warning.input,normalized:warning.meaning,enforcement:'WARN'},'warn');
  const nodePayloads=contribution.nodes.map(row=>nodePayload(tree,contribution,row)),tempMap=new Map(contribution.nodes.map((row,index)=>[row.tempId,nodePayloads[index].id])),stagedAliasMap=stableNodeAliasMap(nodePayloads);
  const resolutions=[],unresolved=[],mentionMap=new Map(),promotionNodes=[],readyPendingEdges=[],decisionIds=[];
  const promoteSet=new Set((promoteMentionIds??[]).map(String));
  if(contribution.source==='scene'){
    const mentionIds=new Set(contribution.mentions.map(row=>row.mentionId));
    for(const edge of contribution.edges){
      if(edge.meaning==='present-in'&&mentionIds.has(edge.from))promoteSet.add(edge.from);
      if(edge.meaning==='at'&&mentionIds.has(edge.to))promoteSet.add(edge.to);
    }
  }
  if(candidateState&&currentTurn!=null){
    for(const expired of expireWorldTreeCandidates(candidateState,{currentTurn,ttlTurns:Number(context?.worldTreeCandidateTtlTurns)||24})){
      const rec=recordWorldTreeDecision(tree,{generationId:context?.generationId??null,chatId,site:'worldtree.growth',subject:{type:'candidate',id:expired.candidateId},options:['KEEP','EXPIRE'],chosen:'EXPIRE',decidedBy:'RULE',reasonCodes:['CANDIDATE_EXPIRED'],evidence:sourceRefsToDecisionEvidence(contribution.source,expired.sourceRefs??[])});
      decisionIds.push(rec.id);logEvent('worldtree.growth','expired',{candidateId:expired.candidateId,decisionRecordId:rec.id},'debug');
    }
  }

  for(const mention of contribution.mentions){
    const result=await resolveMention({tree,contribution,mention,stagedAliasMap,identityAdvisor,similarityThreshold,similarityMargin,context});
    if(result.deferred)return{kind:'NexusWorldTreeIntakeReceipt',source:contribution.source,key:contribution.key,deferred:true,reason:result.reason,worldRevision:tree.revision};
    if(result.nodeId){
      mentionMap.set(mention.mentionId,{nodeId:result.nodeId});
      const reason=result.path==='watch'?'ENTERED_FROM_WATCHLIST':result.path==='registry'?'IDENTITY_REGISTRY_MATCH':result.path==='similarity'?'SIMILARITY_CLEAR_MARGIN':result.path==='jev'?'JEV_IDENTITY_ADVICE':'EXACT_UID_OR_ALIAS';
      const rec=recordWorldTreeDecision(tree,{generationId:context?.generationId??null,chatId,site:'intake.resolve',subject:{type:'node',id:result.nodeId},options:['EXACT','WATCH','REGISTRY','SIMILARITY','JEV','UNRESOLVED'],chosen:String(result.path).toUpperCase(),decidedBy:result.path==='jev'?'JEV':'RULE',reasonCodes:[reason],evidence:sourceRefsToDecisionEvidence(contribution.source,contribution.sourceRefs),score:result.score??null});
      decisionIds.push(rec.id,...(result.watchDecisionRecordId?[result.watchDecisionRecordId]:[]));resolutions.push({mentionId:mention.mentionId,path:result.path,nodeId:result.nodeId,score:result.score??null,decisionRecordId:rec.id});continue;
    }
    if(!candidateState){mentionMap.set(mention.mentionId,{nodeId:null,unresolved:true});unresolved.push({mentionId:mention.mentionId,candidateId:null});resolutions.push({mentionId:mention.mentionId,path:'unresolved',nodeId:null});continue;}
    const scenePresence=promoteSet.has(mention.mentionId),authority=sourceAuthority(contribution.source);
    const noted=noteUnresolvedMention(candidateState,{mention,sourceRefs:contribution.sourceRefs,occurrenceKey:contribution.key,promotionThreshold,promotionReason:scenePresence?'scene-presence':null,currentTurn,authority});
    const growth=await decideWorldTreeGrowth({tree,context,subject:{type:'candidate',id:noted.candidateId},authority,sourceRefs:contribution.sourceRefs,independentSources:noted.candidate.turnKeys?.length??noted.candidate.mentionCount,repetition:noted.candidate.mentionCount,scenePresence,knownEndpoints:false,contradiction:false});
    decisionIds.push(growth.record.id,...(result.watchDecisionRecordId?[result.watchDecisionRecordId]:[]));
    candidateState.candidates[noted.candidateId]={...candidateState.candidates[noted.candidateId],evidenceScore:growth.score,growthChoice:growth.chosen,growthDecisionRecordId:growth.record.id};
    if(growth.chosen==='GROW'){
      const promoted=candidateNodePayload(contribution,noted.candidate);promoted.data.decisionRecordIds=[...(promoted.data.decisionRecordIds??[]),growth.record.id];promotionNodes.push(promoted);mentionMap.set(mention.mentionId,{nodeId:promoted.id,candidateId:noted.candidateId});
      readyPendingEdges.push(...promoteCandidateInState(candidateState,{candidateId:noted.candidateId,nodeId:promoted.id}));
      const resolution=recordWorldTreeDecision(tree,{generationId:context?.generationId??null,chatId,site:'intake.resolve',subject:{type:'candidate',id:noted.candidateId},options:['PROMOTE','UNRESOLVED','REVIEW'],chosen:'PROMOTE',decidedBy:growth.decidedBy,reasonCodes:growth.reasonCodes,evidence:sourceRefsToDecisionEvidence(contribution.source,contribution.sourceRefs),score:growth.score,threshold:growth.threshold});
      decisionIds.push(resolution.id);resolutions.push({mentionId:mention.mentionId,path:'promoted',nodeId:promoted.id,candidateId:noted.candidateId,decisionRecordId:resolution.id});
    }else{
      mentionMap.set(mention.mentionId,{candidateId:noted.candidateId});unresolved.push({mentionId:mention.mentionId,candidateId:noted.candidateId});
      const resolution=recordWorldTreeDecision(tree,{generationId:context?.generationId??null,chatId,site:'intake.resolve',subject:{type:'candidate',id:noted.candidateId},options:['PROMOTE','UNRESOLVED','REVIEW'],chosen:growth.chosen==='REVIEW'?'REVIEW':'UNRESOLVED',decidedBy:growth.decidedBy,reasonCodes:growth.chosen==='REVIEW'?['GROWTH_REVIEW']:['UNRESOLVED_MENTION'],evidence:sourceRefsToDecisionEvidence(contribution.source,contribution.sourceRefs),score:growth.score,threshold:growth.threshold});
      decisionIds.push(resolution.id);resolutions.push({mentionId:mention.mentionId,path:growth.chosen==='REVIEW'?'review':'unresolved',nodeId:null,candidateId:noted.candidateId,decisionRecordId:resolution.id});
    }
  }

  const edgePayloads=[];
  const resolveEndpoint=value=>{
    if(tempMap.has(value))return{nodeId:tempMap.get(value)};
    if(mentionMap.has(value))return mentionMap.get(value);
    if(chatId!=null&&endpointCrossChat(tree,value,chatId))throw new Error('WORLD_TREE_EDGE_CHAT_SCOPE_MISMATCH');
    const node=tree.getNode(value,{chatId});if(node)return{nodeId:node.id};
    throw new Error('WORLD_TREE_CONTRIBUTION_EDGE_ENDPOINT_UNKNOWN:'+String(value));
  };
  for(const [index,edge] of contribution.edges.entries()){
    const from=resolveEndpoint(edge.from),to=resolveEndpoint(edge.to),id=contributionEdgeId(contribution,index,edge);
    if(from.nodeId&&to.nodeId){edgePayloads.push(edgePayload(contribution,{...edge,id,from:from.nodeId,to:to.nodeId}));continue;}
    if(!candidateState)continue;
    queuePendingCandidateEdge(candidateState,{id,fromNodeId:from.nodeId??null,toNodeId:to.nodeId??null,fromCandidateId:from.candidateId??null,toCandidateId:to.candidateId??null,
      meaning:edge.meaning,subtype:edge.subtype,authority:edge.authority,sourceRefs:contribution.sourceRefs,validFrom:edge.validFrom,validTo:edge.validTo,weight:edge.weight,sourceSceneIds:edge.sourceSceneIds});
  }
  for(const pending of readyPendingEdges){
    if(!isStandardWorldTreeEdgeMeaning(pending.meaning))logEvent('worldtree.intake','edge-meaning-nonstandard',{source:contribution.source,key:contribution.key,input:pending.meaning,normalized:canonicalWorldTreeEdgeMeaning(pending.meaning),enforcement:'WARN'},'warn');
    edgePayloads.push(edgePayload(contribution,{id:pending.id,from:pending.fromNodeId,to:pending.toNodeId,meaning:pending.meaning,subtype:pending.subtype,authority:pending.authority,validFrom:pending.validFrom,validTo:pending.validTo,weight:pending.weight,sourceSceneIds:pending.sourceSceneIds,sourceRefs:pending.sourceRefs}));
  }

  const allNodes=[...nodePayloads,...promotionNodes];
  const applyDecision=recordWorldTreeDecision(tree,{generationId:context?.generationId??null,chatId,site:'worldtree.intake',subject:{type:'job',id:ledgerKey},options:['APPLY','NOOP','REJECT'],chosen:'APPLY',decidedBy:'RULE',reasonCodes:['CONTRIBUTION_VALIDATED'],evidence:sourceRefsToDecisionEvidence(contribution.source,contribution.sourceRefs)});
  decisionIds.push(applyDecision.id);
  const committed=tree.applyContributionRevision({ledgerKey,lineageKey,fingerprint,source:contribution.source,scope:contribution.scope,nodes:allNodes,edges:edgePayloads,decisionRecordIds:decisionIds});
  if(candidateState){markCandidateApplication(candidateState,{ledgerKey,fingerprint});persistWorldTreeCandidateState(candidateState,{context,chatId});}
  for(const node of promotionNodes){try{tree.registerIdentity({nodeId:node.id,canonicalLabel:node.data.label,entityType:node.kind,aliases:node.data.aliases??[],providerId:'NEXUS_WORLD_TREE_INTAKE',sourceEntityId:node.id,authorityOrigin:'SOURCE_EXPLICIT'});}catch{}}
  registerContributionIdentities(tree,contribution,allNodes);
  const receipt={kind:'NexusWorldTreeIntakeReceipt',source:contribution.source,key:contribution.key,noOp:committed.noOp,worldRevision:committed.worldRevision,
    nodeCount:allNodes.length,edgeCount:edgePayloads.length,resolutions,unresolved,createdNodeIds:[...committed.createdNodeIds],updatedNodeIds:[...committed.updatedNodeIds],
    createdEdgeIds:[...committed.createdEdgeIds],updatedEdgeIds:[...committed.updatedEdgeIds],supersededNodeIds:[...committed.supersededNodeIds],supersededEdgeIds:[...committed.supersededEdgeIds]};
  logEvent('worldtree.intake','applied',{source:receipt.source,keyHash:stableHash(receipt.key),nodeCount:receipt.nodeCount,edgeCount:receipt.edgeCount,createdNodes:receipt.createdNodeIds.length,createdEdges:receipt.createdEdgeIds.length,
    supersededNodes:receipt.supersededNodeIds.length,supersededEdges:receipt.supersededEdgeIds.length,resolutions:resolutions.map(row=>({mentionId:row.mentionId,path:row.path,nodeId:row.nodeId??null,candidateId:row.candidateId??null})),unresolved:unresolved.map(row=>({mentionId:row.mentionId,candidateId:row.candidateId??null}))},'info');
  return receipt;
}

function queueState(context){
  const chatId=context?.chatId??context?.chat_id;if(chatId==null||!context?.chatMetadata)return null;
  const raw=context.chatMetadata[WORLD_TREE_INTAKE_QUEUE_METADATA_KEY];
  return raw?.version===1&&String(raw.chatId)===String(chatId)?clone(raw):{version:1,chatId:String(chatId),items:[],updatedAt:0};
}
function persistQueue(context,state){
  if(!state||!context?.chatMetadata)return false;state.updatedAt=Date.now();context.chatMetadata[WORLD_TREE_INTAKE_QUEUE_METADATA_KEY]=state;try{context.saveMetadataDebounced?.();}catch{}return true;
}
export function enqueueWorldTreeContribution(input,{context}={}){
  const contribution=normalizeWorldTreeContribution(input),state=queueState(context);if(!state)throw new Error('WORLD_TREE_INTAKE_QUEUE_REQUIRES_CHAT_CONTEXT');
  if(contribution.scope.type==='CHAT'&&String(contribution.scope.chatId)!==String(state.chatId))throw new Error('WORLD_TREE_CONTRIBUTION_CHAT_SCOPE_MISMATCH');
  const id=contributionLedgerKey(contribution);if(!state.items.some(row=>row.id===id))state.items.push({id,contribution:clone(contribution),queuedAt:Date.now()});persistQueue(context,state);return{id,queued:true};
}
export function readWorldTreeContributionQueue({context}={}){return queueState(context)?.items??[];}
export async function drainWorldTreeContributions({context,isFresh=()=>true,tree=getNexusWorldTreeOwner()}={}){
  const state=queueState(context);if(!state||!state.items.length)return{skipped:true,reason:'empty',appliedCount:0,noOpCount:0,rejectedCount:0,pendingCount:0};
  const frame=intakeBudget.beginTurn({timeMs:5000,worldSize:state.items.length}),allowance=frame.compute('worldtree.intake.queue',{total:state.items.length,defaultUnits:4,defaultWorldSize:4,msPerUnit:1});
  if(!allowance.allowed)return{deferred:true,reason:'budget',appliedCount:0,noOpCount:0,rejectedCount:0,pendingCount:state.items.length};
  let appliedCount=0,noOpCount=0,rejectedCount=0,index=0;const keep=[];
  for(;index<state.items.length&&index<allowance.allowed;index++){
    const item=state.items[index];if(isFresh()===false){keep.push(...state.items.slice(index));index=state.items.length;break;}
    try{
      const receipt=await applyWorldTreeContribution(item.contribution,{context,tree});
      if(receipt?.deferred){keep.push(item);continue;}
      if(receipt?.noOp)noOpCount++;else appliedCount++;
    }catch(error){
      rejectedCount++;logEvent('worldtree.intake','rejected',{keyHash:stableHash(item.id),reason:error?.name||'ERROR',message:String(error?.message||error).slice(0,240)},'error');
    }
  }
  if(index<state.items.length)keep.push(...state.items.slice(index));
  state.items=keep;persistQueue(context,state);
  return{kind:'NexusWorldTreeIntakeDrain',appliedCount,noOpCount,rejectedCount,pendingCount:keep.length,deferred:keep.length>0,continuation:keep.length?{pending:keep.length}:null};
}
