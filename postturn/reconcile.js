function cleanText(value){return String(value??'').replace(/\s+/g,' ').trim();}
function asUid(value){const n=Number(value);return Number.isInteger(n)&&n>=0?n:null;}
function stableValue(value){
    if(Array.isArray(value))return value.map(stableValue);
    if(value&&typeof value==='object'){
        const out={};
        for(const key of Object.keys(value).sort())out[key]=stableValue(value[key]);
        return out;
    }
    return value;
}
function stableSignature(value){return JSON.stringify(stableValue(value));}

function operationKeys(op={}){
    const type=String(op?.type||'').toLowerCase();
    const book=String(op?.book||'');
    const keys=[];
    const claimUid=value=>{const id=asUid(value);if(id!==null)keys.push(`${book}:uid:${id}`);};
    if(['update','delete','split','move_entry'].includes(type))claimUid(op.uid??op.target_uid);
    else if(type==='merge'){claimUid(op.keep_uid);claimUid(op.remove_uid);}
    else if(['remember','create','create_entry'].includes(type))keys.push(`${book}:create:${cleanText(op.title||'').toLowerCase()}`);
    else if(['rename_category','move_category','delete_category'].includes(type))keys.push(`${book}:node:${String(op.node_id??op.target_id??'')}`);
    else if(type==='create_category')keys.push(`${book}:category:${String(op.parent_node_id??op.parent_id??'root')}:${cleanText(op.label||op.name||'').toLowerCase()}`);
    return keys.filter(key=>!key.endsWith(':'));
}

function normalizedNodeTarget(op={}){
    const value=op.node_id??op.target_node_id??null;
    return value===null||value===undefined||value===''?null:String(value);
}

function isCompatibleAppendUpdate(a={},b={}){
    if(String(a.type||'').toLowerCase()!=='update'||String(b.type||'').toLowerCase()!=='update')return false;
    if(String(a.mode||'').toLowerCase()!=='append'||String(b.mode||'').toLowerCase()!=='append')return false;
    if(String(a.book||'')!==String(b.book||''))return false;
    if(asUid(a.uid??a.target_uid)!==asUid(b.uid??b.target_uid))return false;
    if(normalizedNodeTarget(a)!==normalizedNodeTarget(b))return false;
    const allowed=new Set(['type','book','uid','target_uid','mode','content','node_id','target_node_id']);
    if(Object.keys(a).some(key=>!allowed.has(key))||Object.keys(b).some(key=>!allowed.has(key)))return false;
    return true;
}

function normalizeAppendBlock(value){return String(value??'').replace(/\r\n?/g,'\n').trim();}
function normalizedForContainment(value){return cleanText(value).toLowerCase();}

function mergeAppendContent(a,b){
    const blocks=[];
    for(const value of [a,b]){
        const block=normalizeAppendBlock(value);
        if(!block)continue;
        const normalized=normalizedForContainment(block);
        let redundant=false;
        for(let i=0;i<blocks.length;i++){
            const existingNorm=normalizedForContainment(blocks[i]);
            if(existingNorm===normalized||existingNorm.includes(normalized)){redundant=true;break;}
            if(normalized.includes(existingNorm)){blocks[i]=block;redundant=true;break;}
        }
        if(!redundant)blocks.push(block);
    }
    return blocks.join('\n\n');
}

function mergeAppendUpdate(existing,incoming){
    const merged={...existing,content:mergeAppendContent(existing.content,incoming.content)};
    if('uid' in existing||'uid' in incoming)merged.uid=asUid(existing.uid??existing.target_uid??incoming.uid??incoming.target_uid);
    delete merged.target_uid;
    if(normalizedNodeTarget(existing)===null){delete merged.node_id;delete merged.target_node_id;}
    return merged;
}

export function reconcilePostTurnOperations(operations=[]){
    const exactDeduped=[...new Map((operations||[]).map(op=>[stableSignature(op),op])).values()];
    const result=[];
    const claims=new Map();
    for(const op of exactDeduped){
        const keys=operationKeys(op);
        const conflictingIndexes=[...new Set(keys.map(key=>claims.get(key)).filter(index=>index!==undefined))];
        if(conflictingIndexes.length===0){
            const index=result.push(op)-1;
            for(const key of keys)claims.set(key,index);
            continue;
        }
        if(conflictingIndexes.length===1){
            const index=conflictingIndexes[0];
            const prior=result[index];
            if(isCompatibleAppendUpdate(prior,op)){
                result[index]=mergeAppendUpdate(prior,op);
                continue;
            }
        }
        const key=keys.find(item=>claims.has(item))||keys[0]||'(unknown target)';
        const error=new Error(`Post-turn semantic conflict: multiple non-identical operations claim ${key}.`);
        error.name='TV2PostTurnSemanticConflict';
        throw error;
    }
    return result;
}

export function reconcilePostTurnOperationLayers(primaryOperations=[],optionalOperations=[]){
    let operations=reconcilePostTurnOperations(primaryOperations||[]);
    const deferred=[];
    for(const op of optionalOperations||[]){
        try{
            operations=reconcilePostTurnOperations([...operations,op]);
        }catch(error){
            if(error?.name!=='TV2PostTurnSemanticConflict')throw error;
            deferred.push({operation:op,error:error.message||String(error)});
        }
    }
    return {operations,deferred};
}

