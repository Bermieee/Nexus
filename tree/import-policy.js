import { semanticSnapshot } from './model.js';

function stable(value){
    if(Array.isArray(value))return value.map(stable);
    if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])]));
    return value;
}
function same(a,b){return JSON.stringify(stable(semanticSnapshot(a)))===JSON.stringify(stable(semanticSnapshot(b)));}

export function treeImportAlreadyCurrent(plans=[],getCurrentTree=()=>null){
    const rows=(plans||[]).map(plan=>({book:String(plan?.book||''),same:same(getCurrentTree(String(plan?.book||'')),plan?.tree)}));
    return {allCurrent:rows.length>0&&rows.every(row=>row.same),rows};
}

export function createTreeImportMutation({type='tree.import.bundle',plans=[],expectedTrees=[],operatorIntentId=''}={}){
    const intent=String(operatorIntentId||'').trim();
    if(!intent)throw new Error('Tree import canonical mutation requires an operator intent identity.');
    return {
        type,
        operatorIntentId:intent,
        plans:(plans||[]).map(plan=>({
            book:String(plan.book),
            tree:structuredClone(plan.tree),
            expectedTree:structuredClone((expectedTrees||[]).find(row=>row.book===String(plan.book))?.tree??null),
        })),
    };
}
