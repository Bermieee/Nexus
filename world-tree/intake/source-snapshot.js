import {stableHash,contributionNodeId} from './contribution.js';

const signature=(message,index)=>message?stableHash([index,message.swipe_id??null,message.is_user?'u':'a',String(message.mes??'')]):null;
const transitionError=()=>new Error('WORLD_TREE_CHARACTER_MEMORY_TRANSITION_INVALID');
const transitionStatus={closed:'HISTORICAL',superseded:'SUPERSEDED','tracking-paused':'HISTORICAL'};
const transitionData=value=>Object.fromEntries(Object.entries(value??{}).filter(([key])=>!['status','tracking','updatedAt','closedAt','supersededAt','decisionRecordIds'].includes(key)));
function captureMemoryTransition(contribution,context,tree,proof){
  if(contribution.source!=='character-memory'||contribution.scope.type!=='CHAT'||!transitionStatus[proof?.status]||contribution.mentions?.length||!tree?.getNode)throw transitionError();
  const chatId=String(context?.chatId??context?.chat_id??'');if(chatId!==contribution.scope.chatId)throw transitionError();
  const targets=proof.targets??[],memory=tree.getNode(proof.targetId,{chatId});
  if(!memory||memory.kind!=='CHARACTER_MEMORY'||memory.scope.type!=='CHAT'||memory.scope.chatId!==chatId||Number(memory.revision)!==Number(proof.targetRevision)||memory.data?.status==='superseded'||targets.length!==contribution.nodes.length)throw transitionError();
  const ids=new Map(),snapshots=[];
  for(const target of targets){
    const node=tree.getNode(target.nodeId,{chatId}),row=contribution.nodes.find(item=>item.tempId===target.tempId);
    if(!node||!row||ids.has(row.tempId)||node.scope.type!=='CHAT'||node.scope.chatId!==chatId||Number(node.revision)!==Number(target.revision)||contributionNodeId(contribution,row.tempId)!==node.id||row.kind!==node.kind||row.label!==node.data.label||row.authority!=='REMEMBERED'||row.temporal||row.temporalStatus!==transitionStatus[proof.status]||stableHash(transitionData(row.fields))!==stableHash(transitionData(node.data)))throw transitionError();
    if(target.tempId==='memory'){
      if(node.id!==memory.id||row.fields.status!==proof.status||row.fields.characterMemoryLineageId!==memory.data.characterMemoryLineageId||row.fields.tracking!==(proof.status==='tracking-paused'?'paused':memory.data.tracking))throw transitionError();
    }else if(target.tempId!=='source-window'||node.data?.characterMemorySource!==true||node.data?.characterMemoryLineageId!==memory.data.characterMemoryLineageId||stableHash(row.fields)!==stableHash(node.data))throw transitionError();
    ids.set(row.tempId,node.id);snapshots.push({id:node.id,revision:node.revision,fingerprint:stableHash(node)});
  }
  if(!ids.has('memory'))throw transitionError();
  const incident=[...tree.edges.values()].filter(edge=>edge.scope?.type==='CHAT'&&edge.scope.chatId===chatId&&edge.temporal?.status!=='SUPERSEDED'&&(edge.from===memory.id||edge.to===memory.id));
  const signature=edge=>stableHash([edge.from,edge.to,edge.meaning??edge.relation,edge.subtype??edge.data?.subtype??null]);
  const actual=incident.map(signature).sort(),proposed=contribution.edges.map(edge=>signature({...edge,from:ids.get(edge.from)??edge.from,to:ids.get(edge.to)??edge.to})).sort();
  if(stableHash(actual)!==stableHash(proposed)||contribution.edges.some(edge=>edge.authority!=='REMEMBERED'||edge.temporalStatus!==transitionStatus[proof.status]||edge.weight!=null||edge.sourceField!=null||edge.sourceSnippetHash!=null||edge.sourceSceneIds?.length))throw transitionError();
  return{kind:'CharacterMemoryStateTransitionSources',chatId,targets:snapshots,status:proof.status,messages:[]};
}
export function captureContributionSources(contribution,context,tree=null){
  if(contribution.scope.type!=='CHAT')return null;
  const proof=contribution.sourceRefs?.find(ref=>ref?.characterMemoryStateTransition)?.characterMemoryStateTransition;
  if(proof)return captureMemoryTransition(contribution,context,tree,proof);
  if(!Array.isArray(context?.chat))return null;
  const indices=new Set();
  const declared=new Map();
  for(const ref of contribution.sourceRefs??[]){
    const match=/^message:(\d+)$/.exec(String(ref?.messageId??ref?.message_id??''));
    const index=match?Number(match[1]):ref?.sourceIndex;
    if(Number.isInteger(index)&&index>=0){
      if(context.chat[index])indices.add(index);
      if(['scene','character-memory'].includes(contribution.source)&&/^[\da-f]{8}$/i.test(String(ref?.messageRevision??''))){indices.add(index);declared.set(index,String(ref.messageRevision));}
    }
  }
  if(contribution.source==='scene'&&!indices.size&&context.chat.length)indices.add(context.chat.length-1);
  return {chatId:String(context.chatId??context.chat_id??''),messages:[...indices].sort((a,b)=>a-b).map(index=>({index,signature:declared.get(index)??signature(context.chat[index],index)}))};
}
export function contributionSourcesFresh(snapshot,context,tree=null){
  if(!snapshot)return true;
  if(snapshot.kind==='CharacterMemoryStateTransitionSources')return snapshot.chatId===String(context?.chatId??context?.chat_id??'')&&Boolean(tree?.getNode)&&(snapshot.targets??[]).every(target=>{const node=tree.getNode(target.id,{chatId:snapshot.chatId});return node&&node.scope?.type==='CHAT'&&node.scope.chatId===snapshot.chatId&&node.revision===target.revision&&stableHash(node)===target.fingerprint;});
  return snapshot.chatId===String(context?.chatId??context?.chat_id??'')&&(snapshot.messages??[]).every(row=>signature(context?.chat?.[row.index],row.index)===row.signature);
}
export function assertContributionSources(snapshot,context,tree=null){if(!contributionSourcesFresh(snapshot,context,tree))throw new Error('WORLD_TREE_CONTRIBUTION_SOURCE_CHANGED');}
