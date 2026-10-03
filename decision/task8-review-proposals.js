import { stableHash } from '../world-tree/intake/contribution.js';

// Independent support alone is insufficient: opposed dimensional readings
// remain separate observations rather than becoming a durable reflection.
export function compatibleReflectionReadings(history=[],characterRef){
  const independent=new Map();
  for(const row of history)if(String(row?.characterRef??'')===String(characterRef)&&row?.directEvidenceRefs?.length&&row.supportIdentity)independent.set(row.supportIdentity,row);
  const rows=[...independent.values()].slice(-8);
  const keys=new Set(rows.flatMap(row=>Object.keys(row.dimensions??{})));
  let hasSharedReading=false;
  for(const key of keys){
    const values=rows.map(row=>row.dimensions?.[key]).filter(value=>value!=null);
    if(values.length===rows.length&&values.length>0)hasSharedReading=true;
    const categories=new Set(values.map(value=>typeof value==='number'?(value<.5?'LOW':value>.5?'HIGH':'NEUTRAL'):String(value).toUpperCase()));
    if(categories.size>1)return[];
  }
  return hasSharedReading?rows:[];
}

export function task8ReviewProposal({chatId,generationId=null,site,subjects=[],choice,evidenceRefs=[]}={}){
  if(!chatId||!site||!subjects.length||!choice)throw new TypeError('World Tree review requires origin and subjects');
  const refs=[...new Set(evidenceRefs.map(String))].slice(0,32);
  const review={kind:'WorldTreeReview',version:1,chatId:String(chatId),generationId,site:String(site),subjects:subjects.map(String),choice:String(choice),evidenceRefs:refs,authority:'OWNER_REVIEW_REQUIRED',canonicalMutation:false};
  const key='nexus_world_tree_review:'+stableHash([review.chatId,review.site,review.subjects,review.choice,refs]);
  // Existing owner proposal admission, persistence and approval remain the
  // authority. Accepting this stores reviewed advice; it cannot merge nodes,
  // supersede facts, or settle an inference as canon by itself.
  return{op:{type:'metadata.set',key,value:review},meta:{source:'worldtree-review',reasoning:'Review '+review.site+' advice for '+review.subjects.join(', ')+'. Canonical changes require a separate owner-approved operation.',origin:{chatId:review.chatId,generationId},execution:{kind:'worldtree-advisory-review',canonicalMutation:false}}};
}

export async function stageTask8Review(input,{enqueue,isFresh=()=>true}={}){
  if(typeof enqueue!=='function')throw new TypeError('Existing proposal admission is required');
  if(isFresh()===false)return{stale:true,staged:false};
  const proposal=task8ReviewProposal(input);
  const saved=await enqueue(proposal.op,proposal.meta);
  return{staged:true,proposalId:saved.id,disposition:saved.enqueueDisposition??'created'};
}
