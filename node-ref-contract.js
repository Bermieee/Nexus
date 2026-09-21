import { normalizePlacementPayload } from './validation.js';

function text(value){return String(value??'').trim();}

export function createBuilderNodeRefContract(treeInventory={}){
    const refs=(treeInventory?.nodes||[]).map((node,index)=>({
        ref:`T${index+1}`,
        nodeId:text(node?.id),
        label:text(node?.label),
        summary:text(node?.summary),
        path:Array.isArray(node?.path)?node.path.map(text).filter(Boolean):[],
        entryUids:Array.isArray(node?.entryUids)?node.entryUids.map(Number).filter(Number.isFinite):[],
    }));
    const byRef=new Map(refs.map(row=>[row.ref,row.nodeId]));
    return Object.freeze({refs:Object.freeze(refs.map(Object.freeze)),byRef});
}

export function builderNodeIndexForPrompt(contract){
    return (contract?.refs||[]).map(row=>({
        nodeRef:row.ref,
        label:row.label,
        summary:row.summary,
        path:[...row.path],
        entryUids:[...row.entryUids],
    }));
}

function resolveNodeRef(raw,contract,field,placementRef){
    const value=text(raw);
    if(!value)return null;
    const nodeId=contract?.byRef?.get(value);
    if(!nodeId)throw new Error(`Builder placement ${placementRef||'?'} contains unknown ${field} ${value}.`);
    return nodeId;
}

export function normalizePlacementPayloadWithNodeRefs(payload,contract){
    if(!payload||typeof payload!=='object'||Array.isArray(payload))throw new Error('Builder semantic output must be an object.');
    if(!Array.isArray(payload.placements))throw new Error('Builder semantic output requires placements[].');
    const mapped={...payload,placements:payload.placements.map(row=>{
        const ref=text(row?.ref);
        return {
            ...(row||{}),
            existingNodeId:resolveNodeRef(row?.existingNodeId,contract,'existingNodeRef',ref),
            parentNodeId:resolveNodeRef(row?.parentNodeId,contract,'parentNodeRef',ref),
        };
    })};
    return normalizePlacementPayload(mapped);
}

export function validateBuilderPlacementMode(payload,mode){
    const normalized=normalizePlacementPayload(payload);
    if(String(mode||'').toLowerCase()==='full'){
        for(const row of normalized.placements){
            if(row.existingNodeId||row.parentNodeId)throw new Error(`FULL Builder placement ${row.ref} cannot reference an existing Tree node.`);
            if(!row.path?.length&&!row.newNodeLabel)throw new Error(`FULL Builder placement ${row.ref} requires a new/reusable path.`);
        }
    }
    return normalized;
}
