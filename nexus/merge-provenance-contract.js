import { validateMergeFinalPayload } from '../sidecar/semantic-validation.js';

function text(value){return String(value??'').trim();}
function unique(values=[]){return [...new Set((values||[]).map(text).filter(Boolean))];}

export function createMergeProvenanceRefContract({sourceAContributions=[],sourceBContributions=[]}={}){
    const make=(prefix,values)=>unique(values).map((contribution,index)=>({ref:`${prefix}${index+1}`,contribution}));
    const sourceA=make('A',sourceAContributions),sourceB=make('B',sourceBContributions);
    return Object.freeze({
        sourceA:Object.freeze(sourceA.map(Object.freeze)),
        sourceB:Object.freeze(sourceB.map(Object.freeze)),
        byA:new Map(sourceA.map(row=>[row.ref,row.contribution])),
        byB:new Map(sourceB.map(row=>[row.ref,row.contribution])),
    });
}

function mapRefs(values,lookup,label,errors){
    if(!Array.isArray(values)||!values.length){errors.push(`Merge final payload requires ${label} array.`);return [];}
    const seen=new Set(),mapped=[];
    for(const raw of values){
        const ref=text(raw);
        if(!ref||!lookup.has(ref)){errors.push(`Merge final payload contains unknown ${label} ${ref||'(empty)'}.`);continue;}
        if(seen.has(ref)){errors.push(`Merge final payload contains duplicate ${label} ${ref}.`);continue;}
        seen.add(ref);mapped.push(lookup.get(ref));
    }
    for(const ref of lookup.keys())if(!seen.has(ref))errors.push(`Merge final payload is missing required ${label} ${ref}.`);
    return mapped;
}

export function mapMergeFinalProvenanceRefs(value,provenanceContract,semanticContract={}){
    if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Merge final payload must be a top-level object.');
    const errors=[];
    const sourceAContributions=mapRefs(value.sourceARefs,provenanceContract?.byA||new Map(),'sourceARefs',errors);
    const sourceBContributions=mapRefs(value.sourceBRefs,provenanceContract?.byB||new Map(),'sourceBRefs',errors);
    if(errors.length)throw new Error(errors.join('; '));
    const mapped={...value,sourceAContributions,sourceBContributions,
        sourceAUid:Number(semanticContract.sourceAUid),sourceBUid:Number(semanticContract.sourceBUid),
        sourceAHash:text(semanticContract.sourceAHash),sourceBHash:text(semanticContract.sourceBHash)};
    delete mapped.sourceARefs;delete mapped.sourceBRefs;
    return mapped;
}

export function validateMergeFinalRefPayload(value,{provenanceContract,semanticContract}={}){
    try{
        const mapped=mapMergeFinalProvenanceRefs(value,provenanceContract,semanticContract||{});
        return validateMergeFinalPayload(mapped,semanticContract||{});
    }catch(error){return {valid:false,score:0,reason:error?.message||String(error),value:null};}
}

export function bindMergeContributionPayload(value,contract={}){
    if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Merge contribution payload must be a top-level object.');
    if(!Array.isArray(value.contributions)||!value.contributions.length)throw new Error('Merge contribution requires at least one contribution.');
    const contributions=unique(value.contributions);
    if(!contributions.length)throw new Error('Merge contribution requires at least one non-empty contribution.');
    return {
        sourceTag:text(contract.sourceTag),
        sourceUid:Number(contract.sourceUid),
        sourceHash:text(contract.sourceHash),
        sliceId:text(contract.sliceId),
        contributions,
    };
}

export function validateMergeContributionRefPayload(value,contract={}){
    try{
        const mapped=bindMergeContributionPayload(value,contract);
        return {valid:true,score:100,value:mapped};
    }catch(error){return {valid:false,score:0,reason:error?.message||String(error),value:null};}
}
