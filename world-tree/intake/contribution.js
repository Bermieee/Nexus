import { canonicalWorldTreeEdgeMeaning, isStandardWorldTreeEdgeMeaning } from './edge-vocabulary.js';

const SOURCES=new Set(['card','scene','memory','character-memory','owner','lore']);
const AUTHORITIES=new Set(['CANON','CARD','OBSERVED','REMEMBERED','INFERRED']);
const clone=value=>value==null?value:structuredClone(value);
const req=(value,name)=>{const text=String(value??'').trim();if(!text)throw new TypeError(name+' is required');return text;};
const stable=value=>Array.isArray(value)?value.map(stable):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])])):value;
export const stableStringify=value=>JSON.stringify(stable(value));
export function stableHash(value){
  const text=typeof value==='string'?value:stableStringify(value);let hash=2166136261;
  for(let i=0;i<text.length;i++){hash^=text.charCodeAt(i);hash=Math.imul(hash,16777619);}
  return (hash>>>0).toString(16).padStart(8,'0');
}
function scopeOf(scope){
  if(!scope||typeof scope!=='object')throw new TypeError('Contribution scope is required');
  const type=String(scope.type??'').toUpperCase();
  if(type==='GLOBAL')return Object.freeze({type:'GLOBAL'});
  if(type==='CHAT')return Object.freeze({type:'CHAT',chatId:req(scope.chatId,'Contribution CHAT chatId')});
  throw new TypeError('Unsupported Contribution scope: '+type);
}
function authority(value,name){
  const out=String(value??'INFERRED').toUpperCase();
  if(!AUTHORITIES.has(out))throw new TypeError('Unsupported '+name+' authority: '+out);
  return out;
}
function sourceRefIdentity(value){
  if(!value||typeof value!=='object')return value;
  return Object.fromEntries(Object.entries(value).filter(([key])=>!/^(revision|messageRevision|cardRevision|sceneRevision|swipeIndex|swipeId)$/i.test(key)).map(([key,row])=>[key,sourceRefIdentity(row)]));
}
export function normalizeWorldTreeContribution(input={}){
  if(String(input.kind??'Contribution')!=='Contribution')throw new TypeError('Contribution kind must be Contribution');
  const source=req(input.source,'Contribution source').toLowerCase();if(!SOURCES.has(source))throw new TypeError('Unsupported Contribution source: '+source);
  const scope=scopeOf(input.scope),key=req(input.key,'Contribution key'),sourceRefs=Object.freeze((input.sourceRefs??[]).map(clone));
  if(!sourceRefs.length)throw new TypeError('Contribution sourceRefs are required');
  const mentionIds=new Set(),tempIds=new Set();
  const mentions=Object.freeze((input.mentions??[]).map(row=>{
    const mentionId=req(row?.mentionId,'mentionId');if(mentionIds.has(mentionId))throw new Error('DUPLICATE_CONTRIBUTION_MENTION:'+mentionId);mentionIds.add(mentionId);
    return Object.freeze({mentionId,text:req(row?.text,'mention.text'),kindHint:row?.kindHint==null?null:String(row.kindHint),contextSnippetHash:row?.contextSnippetHash==null?null:String(row.contextSnippetHash)});
  }));
  const nodes=Object.freeze((input.nodes??[]).map(row=>{
    const tempId=req(row?.tempId,'node.tempId');if(tempIds.has(tempId))throw new Error('DUPLICATE_CONTRIBUTION_TEMP_ID:'+tempId);tempIds.add(tempId);
    return Object.freeze({tempId,kind:req(row?.kind,'node.kind').toUpperCase(),label:req(row?.label,'node.label'),fields:Object.freeze(clone(row?.fields??{})),authority:authority(row?.authority,'node'),temporalStatus:String(row?.temporalStatus??row?.temporal?.status??'CURRENT').toUpperCase(),temporalReason:row?.temporalReason==null?null:String(row.temporalReason),
      ...(row?.temporal?{temporal:Object.freeze(clone(row.temporal))}:{}),...(source==='lore'&&row?.sourceProvenance?{sourceProvenance:Object.freeze(clone(row.sourceProvenance))}:{}),
    });
  }));
  const edges=Object.freeze((input.edges??[]).map(row=>Object.freeze({
    edgeId:row?.edgeId==null?null:req(row.edgeId,'edge.edgeId'),
    from:req(row?.from,'edge.from'),to:req(row?.to,'edge.to'),meaning:canonicalWorldTreeEdgeMeaning(req(row?.meaning,'edge.meaning')),
    subtype:row?.subtype==null?null:String(row.subtype),validFrom:row?.validFrom??null,validTo:row?.validTo??null,authority:authority(row?.authority,'edge'),
    ...(row?.temporalStatus?{temporalStatus:String(row.temporalStatus).toUpperCase()}:{}),
    sourceField:row?.sourceField==null?null:String(row.sourceField),sourceSnippetHash:row?.sourceSnippetHash==null?null:String(row.sourceSnippetHash),
    weight:row?.weight==null?null:Math.max(1,Math.floor(Number(row.weight)||1)),
    sourceSceneIds:Object.freeze([...new Set((row?.sourceSceneIds??[]).map(value=>String(value)).filter(Boolean))].sort()),
  })));
  return Object.freeze({kind:'Contribution',source,scope,sourceRefs,key,mentions,nodes,edges});
}
export function contributionFingerprint(input){return stableHash(normalizeWorldTreeContribution(input));}
export function contributionLedgerKey(input){
  const row=normalizeWorldTreeContribution(input);return [row.scope.type,row.scope.chatId??'global',row.source,row.key].join('|');
}
export function contributionLineageKey(input){
  const row=normalizeWorldTreeContribution(input);
  if(row.source==='scene'){
    const sceneId=row.sourceRefs.find(ref=>ref&&typeof ref==='object'&&ref.sceneId)?.sceneId;
    if(sceneId)return [row.scope.type,row.scope.chatId??'global',row.source,stableHash([{sceneId:String(sceneId)}])].join('|');
  }
  if(row.source==='character-memory'){
    const explicit=row.sourceRefs.find(ref=>ref&&typeof ref==='object'&&ref.characterMemoryLineageId)?.characterMemoryLineageId;
    if(explicit)return [row.scope.type,row.scope.chatId??'global',row.source,stableHash(['character-memory',String(explicit)])].join('|');
  }
  if(row.source==='memory'){
    const explicit=row.sourceRefs.find(ref=>ref&&typeof ref==='object'&&ref.memoryLineageId)?.memoryLineageId;
    if(explicit)return [row.scope.type,row.scope.chatId??'global',row.source,stableHash(['memory',String(explicit)])].join('|');
  }
  if(row.source==='owner'){
    const legacyMemory=row.sourceRefs.find(ref=>ref&&typeof ref==='object'&&ref.legacyMemoryLineageId)?.legacyMemoryLineageId;
    if(legacyMemory)return [row.scope.type,row.scope.chatId??'global',row.source,stableHash(['legacy-memory',String(legacyMemory)])].join('|');
  }
  return [row.scope.type,row.scope.chatId??'global',row.source,stableHash(row.sourceRefs.map(sourceRefIdentity))].join('|');
}
export function contributionNodeId(input,tempId){
  const row=normalizeWorldTreeContribution(input);
  return 'contribution-node:'+row.source+':'+stableHash([contributionLineageKey(row),String(tempId)]);
}
export function contributionEdgeId(input,index,edge){
  const row=normalizeWorldTreeContribution(input);
  if(['owner','lore'].includes(row.source)&&edge?.edgeId)return String(edge.edgeId);
  return 'contribution-edge:'+row.source+':'+stableHash([row.key,index,edge?.from,edge?.to,edge?.meaning,edge?.subtype??null,edge?.sourceField??null,edge?.sourceSnippetHash??null,edge?.weight??null,edge?.sourceSceneIds??[]]);
}
export function contributionSourceRefStrings(input){return normalizeWorldTreeContribution(input).sourceRefs.map(stableStringify);}
export function nonStandardContributionEdges(input){
  const raw=Array.isArray(input?.edges)?input.edges:[];
  return raw.map((row,index)=>({index,input:String(row?.meaning??''),meaning:canonicalWorldTreeEdgeMeaning(row?.meaning),standard:isStandardWorldTreeEdgeMeaning(row?.meaning)})).filter(row=>!row.standard);
}
