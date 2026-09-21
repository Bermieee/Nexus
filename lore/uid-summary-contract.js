import { validateUidContributionPayload, validateUidSummaryPayload } from '../sidecar/semantic-validation.js';

function text(value){return String(value??'').trim();}
function unique(values=[]){return [...new Set((Array.isArray(values)?values:[]).map(text).filter(Boolean))];}
function object(value){return !!value&&typeof value==='object'&&!Array.isArray(value);}

export function bindUidContributionPayload(value,contract={}){
    if(!object(value))throw new Error('UID contribution payload must be a top-level object.');
    if(!Array.isArray(value.contributions)||!value.contributions.length)throw new Error('UID contribution requires contributions array.');
    if(!Array.isArray(value.keywordCandidates))throw new Error('UID contribution requires keywordCandidates array.');
    return {
        uid:Number(contract.uid),
        sourceHash:text(contract.sourceHash),
        sourceRevision:text(contract.sourceRevision),
        title:text(contract.title),
        sourceKeys:(contract.sourceKeys||[]).map(String),
        sliceId:text(contract.sliceId),
        contributions:unique(value.contributions),
        keywordCandidates:unique(value.keywordCandidates),
    };
}

export function validateUidContributionLocalPayload(value,contract={}){
    try{
        const mapped=bindUidContributionPayload(value,contract);
        return validateUidContributionPayload(mapped,contract);
    }catch(error){return {valid:false,score:0,reason:error?.message||String(error),value:null};}
}

export function bindUidSummaryPayload(value,contract={}){
    if(!object(value))throw new Error('UID summary payload must be a top-level object.');
    if(!Array.isArray(value.options))throw new Error('UID summary requires options array.');
    return {
        uid:Number(contract.uid),
        sourceHash:text(contract.sourceHash),
        sourceRevision:text(contract.sourceRevision),
        title:text(contract.title),
        sourceKeys:(contract.sourceKeys||[]).map(String),
        options:value.options,
    };
}

export function validateUidSummaryLocalPayload(value,contract={}){
    try{
        const mapped=bindUidSummaryPayload(value,contract);
        const verdict=validateUidSummaryPayload(mapped,contract);
        if(!verdict.valid)return verdict;
        const required=[...new Set((contract.allowedContributionRefs||[]).map(text).filter(Boolean))].sort();
        if(required.length){
            for(let index=0;index<(verdict.value?.options||[]).length;index+=1){
                const seen=[...new Set((verdict.value.options[index]?.sourceContributionRefs||[]).map(text).filter(Boolean))].sort();
                if(seen.length!==required.length||seen.some((ref,i)=>ref!==required[i]))return {valid:false,score:0,reason:`UID summary option ${index} must cite every validated source contribution ref exactly once.`,value:null};
            }
        }
        return verdict;
    }catch(error){return {valid:false,score:0,reason:error?.message||String(error),value:null};}
}
