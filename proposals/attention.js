const STORAGE_KEY='tv2_proposal_attention_v2';
const CHANGE_EVENT='tv2:proposal-attention-changed';

function tokenFor(row){
    if(!row||row.id==null)return null;
    const revision=Number(row.revision);
    return `${String(row.id)}@${Number.isFinite(revision)&&revision>=0?revision:0}`;
}
function currentPendingTokens(proposals=[]){
    return new Set((Array.isArray(proposals)?proposals:[])
        .filter(row=>String(row?.status||'')==='pending')
        .map(tokenFor).filter(Boolean));
}
function loadAcknowledged(){
    try{
        const raw=globalThis.sessionStorage?.getItem?.(STORAGE_KEY);
        const rows=raw?JSON.parse(raw):[];
        return new Set(Array.isArray(rows)?rows.map(String).filter(Boolean):[]);
    }catch{return new Set();}
}
function saveAcknowledged(set){
    try{globalThis.sessionStorage?.setItem?.(STORAGE_KEY,JSON.stringify([...set]));}catch{}
}
let acknowledgedPendingTokens=loadAcknowledged();
function emit(){try{globalThis.window?.dispatchEvent?.(new CustomEvent(CHANGE_EVENT));}catch{}}
function pruneAcknowledged(acknowledged,currentTokens){
    let changed=false;
    for(const token of acknowledged){if(!currentTokens.has(token)){acknowledged.delete(token);changed=true;}}
    if(changed)saveAcknowledged(acknowledged);
}

export function getProposalAttentionChangeEventName(){return CHANGE_EVENT;}

export function getUnseenPendingProposalCount(proposals=[]){
    const currentTokens=currentPendingTokens(proposals),acknowledged=acknowledgedPendingTokens;
    pruneAcknowledged(acknowledged,currentTokens);
    let unseen=0;for(const token of currentTokens)if(!acknowledged.has(token))unseen++;
    return unseen;
}

export function acknowledgePendingProposals(proposals=[]){
    const currentTokens=currentPendingTokens(proposals),acknowledged=acknowledgedPendingTokens;
    pruneAcknowledged(acknowledged,currentTokens);
    for(const token of currentTokens)acknowledged.add(token);
    saveAcknowledged(acknowledged);emit();return currentTokens.size;
}

export function resetProposalAttention(){
    acknowledgedPendingTokens.clear();
    try{globalThis.sessionStorage?.removeItem?.(STORAGE_KEY);}catch{}
    emit();
}
