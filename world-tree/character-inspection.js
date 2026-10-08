const clone=value=>value==null?value:structuredClone(value);
const normalized=value=>String(value??'').normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim().replace(/\s+/g,' ');
const live=row=>row?.temporal?.status!=='SUPERSEDED'&&row?.data?.sourcePresent!==false;
const labels=node=>[node.data?.label,node.data?.name,node.data?.cardName,...(node.data?.aliases??[]),...(node.data?.keys??[])].map(normalized).filter(Boolean);

// Read through the story facade. Names may join a Lore UID to a card/local
// character only when the match is unique; linked Lore is evidence, not identity.
export function readWorldTreeCharacterInspection({tree,binding,nodeId}={}){
  if(!tree||!binding?.chatId||!binding?.book)return null;
  const chatId=String(binding.chatId),book=String(binding.book),selected=tree.getNode(nodeId,{chatId});
  if(!selected||!live(selected)||(selected.data?.book&&selected.data.book!==book))return null;
  if(selected.scope?.type==='CHAT'&&selected.scope.chatId!==chatId)return null;
  const nodes=[...tree.iterateNodes({chatId})].filter(live),byId=new Map(nodes.map(node=>[node.id,node]));
  const local=node=>node.scope?.type==='CHAT'&&node.scope.chatId===chatId;
  const edges=[...tree.iterateEdges({chatId})].filter(edge=>live(edge)&&byId.has(edge.from)&&byId.has(edge.to));
  const stateNodes=nodes.filter(node=>node.kind==='CHARACTER_STATE'&&local(node));
  const identity=selected.kind==='CHARACTER_STATE'?byId.get(selected.data?.characterNodeId)??selected:selected;
  const names=new Set(labels(identity));
  const candidates=nodes.filter(node=>node.kind==='CHARACTER'&&labels(node).some(name=>names.has(name)));
  const competingLore=nodes.some(node=>node.id!==selected.id&&node.kind==='LORE_FACT'&&node.data?.trackedCharacter===true&&labels(node).includes(normalized(identity.data?.label)));
  const ids=new Set([selected.id]);
  let status='READY';
  if(selected.kind==='CHARACTER_STATE'){
    if(byId.has(selected.data?.characterNodeId))ids.add(selected.data.characterNodeId);
  }else if(selected.kind!=='CHARACTER'){
    if(candidates.length===1&&!competingLore)ids.add(candidates[0].id);
    else if(candidates.length>1||competingLore)status='AMBIGUOUS';
  }
  if(candidates.length===1&&ids.has(candidates[0].id)){
    const loreMatches=nodes.filter(node=>node.kind==='LORE_FACT'&&node.data?.book===book&&labels(node).some(name=>names.has(name)));
    if(loreMatches.length===1)ids.add(loreMatches[0].id);
  }
  const states=stateNodes.filter(node=>ids.has(node.id)||ids.has(node.data?.characterNodeId)||edges.some(edge=>edge.from===node.id&&ids.has(edge.to)&&edge.relation==='state-of'));
  for(const state of states)ids.add(state.id);
  const isCharacter=selected.kind==='CHARACTER'||selected.kind==='CHARACTER_STATE'||selected.data?.trackedCharacter===true||states.length>0||candidates.length>0;
  if(!isCharacter)return null;
  const memoryIds=new Set(edges.filter(edge=>local(edge)&&(
    ids.has(edge.from)&&edge.relation==='has-memory'||ids.has(edge.to)&&edge.relation==='about'
  )).map(edge=>edge.relation==='about'?edge.from:edge.to));
  const characterNames=new Set([...ids].flatMap(id=>labels(byId.get(id)??{})));
  const ambiguousNames=new Set(nodes.filter(node=>!ids.has(node.id)&&(node.kind==='CHARACTER'||node.data?.trackedCharacter===true)).flatMap(labels));
  const taggedMemory=node=>status!=='AMBIGUOUS'&&candidates.length<=1&&(node.data?.characters??[]).some(name=>characterNames.has(normalized(name))&&!ambiguousNames.has(normalized(name)));
  const memories=nodes.filter(node=>local(node)&&(
    node.kind==='CHARACTER_MEMORY'&&ids.has(node.data?.character)||
    node.kind==='MEMORY'&&(memoryIds.has(node.id)||taggedMemory(node))
  )).sort((a,b)=>Number(b.updatedRevision??b.revision)-Number(a.updatedRevision??a.revision)).map(node=>({
    id:node.id,kind:node.kind,text:String(node.data?.summary??node.data?.text??''),
    status:node.data?.status??node.temporal?.status??null,
    scene:byId.get(node.data?.sceneId)?.data?.label??null,
    time:node.data?.time?.storyTime??null,
  }));
  const relationships=edges.filter(edge=>edge.relation==='relationship'&&(ids.has(edge.from)||ids.has(edge.to))).map(edge=>{
    const other=byId.get(ids.has(edge.from)?edge.to:edge.from);
    return{id:edge.id,label:other?.data?.label??other?.id??''};
  });
  const loreProfile=[...ids].map(id=>byId.get(id)).find(node=>node?.kind==='LORE_FACT');
  return {nodeId:selected.id,chatId,book,worldRevision:tree.revision,isCharacter,status,
    authoredProfile:String(loreProfile?.data?.content??''),
    states:states.map(node=>({id:node.id,label:node.data?.label??'',state:clone(node.data?.state??{}),profile:clone(node.data?.profile??{})})),
    relationships,memories};
}
