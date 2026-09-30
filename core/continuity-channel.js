export function hotContinuityCandidates(worldTree,snapshot,{chatId=null}={}){
    if(!worldTree||!snapshot?.segments)return[];
    const refs=[];
    const cast=snapshot.segments.ACTIVE_CAST?.value??[];
    for(const row of cast){
        const name=typeof row==='string'?row:(row?.id??row?.characterRef??row?.name);
        if(!name)continue;
        refs.push(...worldTree.findByAlias(name,chatId));
    }
    const continuity=snapshot.segments.CONTINUITY?.value??{};
    for(const pin of continuity.pins??[]){
        const node=worldTree.getNode(typeof pin==='string'?pin:(pin?.id??pin?.ref));
        if(node)refs.push(node);
    }
    const unique=new Map();
    for(const node of refs){
        if(node?.kind!=='lore'||!node?.payload?.book||!Number.isFinite(Number(node?.payload?.uid)))continue;
        unique.set(JSON.stringify([node.payload.book,Number(node.payload.uid)]),{
            book:String(node.payload.book),uid:Number(node.payload.uid),title:String(node.payload.title||''),
            content:String(node.payload.content||''),nodeId:node.payload.nodeId??null,nodeLabel:node.payload.nodeLabel??null,
            path:Array.isArray(node.payload.path)?node.payload.path:[],hotContinuity:true,
        });
    }
    return [...unique.values()].slice(0,24);
}
