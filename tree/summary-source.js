function stable(value){
    if(Array.isArray(value))return value.map(stable);
    if(value&&typeof value==='object'){
        const out={};
        for(const key of Object.keys(value).sort())out[key]=stable(value[key]);
        return out;
    }
    return value;
}

export function compactTreeSummaryFingerprint(value){
    const source=typeof value==='string'?value:JSON.stringify(stable(value));
    let h=0x811c9dc5;
    for(let i=0;i<source.length;i+=1){h^=source.charCodeAt(i);h=Math.imul(h,0x01000193)>>>0;}
    return `fnv1a32:${h.toString(16).padStart(8,'0')}:${source.length}`;
}

function entrySnapshot(entry,uid){
    return {
        uid:Number(uid),
        exists:!!entry,
        title:String(entry?.comment||entry?.key?.[0]||`UID ${uid}`),
        content:String(entry?.content||''),
        disable:entry?.disable===true,
    };
}

function entryLookup(data){
    const out=new Map();
    for(const entry of Object.values(data?.entries||{})){
        const uid=Number(entry?.uid);
        if(Number.isFinite(uid))out.set(uid,entry);
    }
    return out;
}

export function createTreeSummarySourceSnapshot(tree,data){
    const lookup=entryLookup(data),byNode=new Map();
    const walk=node=>{
        const uids=new Set((node?.entryUids||[]).map(Number).filter(Number.isFinite));
        for(const child of node?.children||[])for(const uid of walk(child))uids.add(uid);
        const source=[...uids].sort((a,b)=>a-b).map(uid=>entrySnapshot(lookup.get(uid),uid));
        byNode.set(String(node?.id||''),compactTreeSummaryFingerprint(source));
        return uids;
    };
    if(tree?.root)walk(tree.root);
    return Object.freeze({byNode});
}

export function treeSummarySourceKey(snapshot,nodeIds=[]){
    return compactTreeSummaryFingerprint((nodeIds||[]).map(id=>[String(id),snapshot?.byNode?.get(String(id))||'missing']));
}

export function assertTreeSummarySourceFresh(expected,current,nodeIds=[]){
    const stale=[];
    for(const rawId of nodeIds||[]){
        const id=String(rawId);
        if((expected?.byNode?.get(id)||'missing')!==(current?.byNode?.get(id)||'missing'))stale.push(id);
    }
    if(stale.length){
        const error=new Error(`Lorebook source changed while Tree summaries were being generated for ${stale.length} node(s). No stale summary snapshot was written.`);
        error.name='TV2TreeSummarySourceStale';
        error.nodeIds=stale;
        throw error;
    }
    return true;
}
