import { stableHash } from '../browser-runtime-utils.js';

export function captureSensorySource(worldTree,nodeIds=[],edgeRefs=[]){
  const nodes=[...new Set(nodeIds.filter(Boolean).map(String))].map(id=>worldTree?.getNode(id)).filter(Boolean);
  if(!nodes.length||nodes.length!==new Set(nodeIds.filter(Boolean).map(String)).size)return null;
  return {nodes:nodes.map(node=>({id:node.id,revision:node.revision,sourceRefs:[...(node.sourceRefs??[])]})),edges:edgeRefs.map(ref=>({from:ref.from,id:ref.id,revision:ref.revision,sourceRefs:[...(worldTree.edgesFrom(ref.from).find(edge=>edge.id===ref.id)?.sourceRefs??[])]}))};
}
export function sensorySourceCurrent(source,worldTree){
  if(!source?.nodes?.length||!worldTree)return false;
  for(const ref of source.nodes){const node=worldTree.getNode(ref.id);if(!node||Number(node.revision)!==Number(ref.revision))return false;}
  for(const ref of source.edges??[]){const edge=worldTree.edgesFrom(ref.from).find(edge=>edge.id===ref.id);if(!edge||Number(edge.revision)!==Number(ref.revision))return false;}
  return true;
}
export function sensoryNominationSourceKey(row){
  return stableHash({id:row.nominationId,source:row.metadata?.sourceValidation??null,refs:row.metadata?.sourceValidation?null:row.sourceRevisionRefs,text:row.representationText,revision:row.representationRevision},{length:32});
}
export function refreshSensoryNomination(row,{worldTree,query='',intentId='nexus-turn',sourceRevisionSet=[],worldRevision=0,sceneRevision=0}={}){
  if(!sensorySourceCurrent(row.metadata?.sourceValidation,worldTree))return null;
  const terms=[...new Set(String(query).toLocaleLowerCase().match(/[\p{L}\p{N}]{2,}/gu)??[])];
  const text=String(row.representationText??'').toLocaleLowerCase(),hits=terms.filter(term=>text.includes(term)).length;
  // Old query ranks are advisory only. Current source text is evaluated against
  // the new question; nomination identity remains tied to its original source.
  const localRefs=[...(row.metadata.sourceValidation.nodes??[]),...(row.metadata.sourceValidation.edges??[])].flatMap(ref=>ref.sourceRefs??[]);
  return {...row,retrievalIntentIds:[intentId],sourceRevisionRefs:[...new Set([...sourceRevisionSet,...localRefs])],worldRevision:null,sceneRevision:null,
    normalizedRank:terms.length?hits/terms.length:0,rankSignals:{...(row.rankSignals??{}),continuationRelevance:terms.length?hits/terms.length:0},
    metadata:{...(row.metadata??{}),continuationRevalidated:true,validatedWorldRevision:worldRevision,validatedSceneRevision:sceneRevision}};
}
